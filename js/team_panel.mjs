import {entityKey} from './team_sync.mjs?v=1';
import {prepareOffline} from './offline.mjs?v=1';

function geometry(value) {
  if (!value) return null;
  if (value.payload?.geometry) return value.payload.geometry;
  const coordinates = value.payload?.coordinates;
  if (!coordinates) return null;
  return {type: {point: 'Point', line: 'LineString', area: 'Polygon'}[value.category], coordinates: value.category === 'area' ? [coordinates] : coordinates};
}
const title = value => value.kind === 'workspace' ? 'Kartinställningar' : globalThis.OMAPMAKER_ISOM_REGISTRY?.manualTypes?.[value.payload?.objectType]?.nameSv || ({roads:'Väg',buildings:'Byggnad','land-cover':'Markyta',infrastructure:'Linjeobjekt','paved-areas':'Hårdgjord yta','global-objects':'Globalt underlagsobjekt'})[value.layerType] || value.payload?.objectType || 'Kartobjekt';
const describe = value => !value ? 'Ingen tidigare version' : `${title(value)} · ${value.deleted ? 'Raderad' : ['locally-excluded','locally-rejected'].includes(value.payload?.status || value.payload?.properties?.status) ? 'Utesluten' : 'Aktiv'} · revision ${value.revision ?? 'lokal'}`;

export function mountTeamPanel({sync, request, workspace, canEdit, beforeSync, apply, onAccessDenied, exportPrivate}) {
  const open = document.createElement('button'); open.type = 'button'; open.id = 'teamSyncButton';
  document.querySelector('.header-actions').prepend(open);
  const dialog = document.createElement('dialog'); dialog.className = 'team-sheet'; dialog.setAttribute('aria-labelledby','teamPanelTitle');
  dialog.innerHTML = `<div class="sheet-head"><div><small>ARBETSLAG</small><h2 id="teamPanelTitle"></h2></div><button type="button" data-team-close aria-label="Stäng">×</button></div><p class="team-intro">Dina ändringar delas med arbetslaget när du synkar.</p><div class="team-status-card"><span class="team-status-heading"></span><p data-team-status role="status"></p></div><div class="team-actions"><button type="button" class="team-primary" data-team-sync>Synka med arbetslaget</button><button type="button" data-team-history>Visa historik</button></div><div data-team-conflicts></div><div data-team-history-list></div><details class="team-utilities"><summary>Offline och säkerhetskopiering</summary><p>Råa GPS-loggar delas inte med arbetslaget. Här kan du förbereda enheten eller rädda en lokal kopia av ditt arbete.</p><div class="team-utility-actions"><button type="button" data-team-backup>Spara lokal säkerhetskopia</button><button type="button" data-team-rescue>Kopiera kartobjekt till personligt konto</button></div></details>`;
  dialog.querySelector('h2').textContent = workspace.teamName || workspace.name;
  document.body.append(dialog);
  const offline = document.createElement('button'); offline.type = 'button'; offline.textContent = 'Förbered offline';
  dialog.querySelector('.team-utility-actions').prepend(offline);
  offline.onclick = async () => {offline.disabled=true;try {await prepareOffline();message='Appen är förberedd för offlineöppning. Kartobjekt och redan hämtade underlag finns lokalt. Bakgrundskartans bildrutor laddas inte ned för offlinebruk.';}catch(error){message=error.message;}finally{offline.disabled=false;refresh();}};
  const status = dialog.querySelector('[data-team-status]'), conflicts = dialog.querySelector('[data-team-conflicts]'), historyList = dialog.querySelector('[data-team-history-list]');
  let message = '', maps = [], busy = false;
  const action = (label, callback) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.disabled = !canEdit() || busy;
    button.onclick = async () => {
      button.disabled = true;
      try { await callback(); } catch (error) { message = error.message; } finally { refresh(); }
    };
    return button;
  };
  function comparison(container, versions) {
    const grid = document.createElement('div'); grid.className = 'team-versions';
    const localMaps = [], bounds = globalThis.L.latLngBounds([]);
    for (const [label, value, colour] of versions) {
      const card = document.createElement('section'), heading = document.createElement('h4'), description = document.createElement('p');
      heading.textContent = label; description.textContent = describe(value); card.append(heading, description);
      const shape = geometry(value);
      if (shape) {
        const canvas = document.createElement('div'); canvas.className = 'team-geometry'; card.append(canvas);
        localMaps.push({canvas, shape, colour});
      }
      const details = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre');
      summary.textContent = 'Visa egenskaper';
      const props = {...value?.payload}; delete props.coordinates; delete props.geometry; delete props.originalObject;
      pre.textContent = JSON.stringify(props, null, 2); details.append(summary, pre); card.append(details); grid.append(card);
    }
    container.append(grid);
    requestAnimationFrame(() => {
      if (!dialog.open || !grid.isConnected) return;
      for (const entry of localMaps) {
        const map = globalThis.L.map(entry.canvas, {attributionControl: false, zoomControl: true});
        const layer = globalThis.L.geoJSON(entry.shape, {style: {color: entry.colour, weight: 3}, pointToLayer: (_, latlng) => globalThis.L.circleMarker(latlng, {color: entry.colour, radius: 6})}).addTo(map);
        bounds.extend(layer.getBounds()); entry.map = map; maps.push(map);
      }
      if (bounds.isValid()) for (const entry of localMaps) entry.map.fitBounds(bounds, {padding: [18, 18], maxZoom: 19});
    });
  }
  function renderConflicts() {
    maps.forEach(map => map.remove()); maps = []; conflicts.replaceChildren();
    for (const entry of sync.conflicts()) {
      const article = document.createElement('article'); article.className = 'team-conflict';
      const heading = document.createElement('h3'); heading.textContent = `Konflikt: ${title(entry.local)}`; article.append(heading);
      comparison(article, [['Ursprung', entry.base, '#6b7280'], ['Min version', entry.local, '#2563eb'], ['Arbetslagets version', entry.conflict, '#15803d']]);
      const note = document.createElement('p'); note.textContent = 'Valet sparas lokalt. Nästa synkning kontrollerar att ingen hunnit ändra objektet igen.'; article.append(note);
      article.append(action('Behåll min version', async () => {sync.resolve(entityKey(entry.local), 'local'); await apply();}), action('Använd arbetslagets version', async () => {sync.resolve(entityKey(entry.local), 'remote'); await apply();}));
      conflicts.append(article);
    }
  }
  function refresh() {
    const count = sync.pendingCount(), conflictCount = sync.conflicts().length;
    open.textContent = `Arbetslag${count ? ` · ${count}` : ''}`;
    open.dataset.attention = String(conflictCount > 0);
    open.title = conflictCount ? `${conflictCount} konflikter behöver granskas` : count ? `${count} ändringar att synka` : 'Öppna arbetslagets synkning och historik';
    open.setAttribute('aria-label',open.title);
    dialog.classList.toggle('has-conflicts',conflictCount > 0);
    dialog.querySelector('.team-status-heading').textContent = conflictCount ? `${conflictCount} ${conflictCount === 1 ? 'konflikt behöver' : 'konflikter behöver'} granskas` : count ? `${count} ${count === 1 ? 'ändring att synka' : 'ändringar att synka'}` : canEdit() ? 'Allt sparat på enheten' : 'Du har läsbehörighet';
    status.textContent = message || (count ? 'Synka för att dela ditt arbete och hämta andras ändringar.' : 'Synka för att hämta arbetslagets senaste ändringar.');
    dialog.querySelector('[data-team-sync]').disabled = busy;
    if (dialog.open) renderConflicts();
  }
  open.onclick = () => {dialog.showModal(); refresh();};
  dialog.querySelector('[data-team-close]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => {maps.forEach(map => map.remove()); maps = [];});
  dialog.querySelector('[data-team-sync]').onclick = async () => {
    if (busy) return;
    try {
      beforeSync(); busy = true; message = 'Synkar…'; refresh();
      await sync.sync(); await apply(); message = sync.conflicts().length ? 'Övriga ändringar har synkats. Jämför konflikterna nedan.' : 'Synkningen är klar.';
    } catch (error) {
      if (error.status === 403) {onAccessDenied(); message = 'Behörigheten har ändrats. Lokala ändringar är kvar och kan sparas som säkerhetskopia eller kopieras till ditt personliga konto.';}
      else message = error.status ? error.message : `Kunde inte synka: ${error.message}. Ändringarna finns kvar på enheten.`;
    } finally {busy = false; refresh();}
  };
  async function history(before = 0) {
    const result = await request(`team-workspaces/${workspace.id}/history?before=${before}`);
    if (!before) historyList.replaceChildren();
    for (const change of result.changes) {
      const row = document.createElement('article'), label = document.createElement('p');
      label.textContent = `${change.author} · ${new Date(change.createdAt).toLocaleString('sv-SE')} · ${describe(change.entity)}`; row.append(label);
      const preview = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre');
      summary.textContent = 'Visa sparad version'; pre.textContent = JSON.stringify(change.entity.payload, null, 2); preview.append(summary, pre); row.append(preview);
      row.append(action('Förbered återställning', async () => {
        beforeSync();
        const id = entityKey(change.entity), entry = sync.state.entries[id];
        if (entry?.pending || entry?.conflict || (entry && JSON.stringify(entry.local) !== JSON.stringify((({revision,modifiedBy,modifiedAt,...value})=>value)(entry.base || {})))) throw new Error('Synka eller lös dina väntande ändringar för objektet före återställning');
        sync.set(change.entity); await apply(); message = 'Versionen är återställd lokalt. Granska kartan och synka för att dela återställningen.';
      })); historyList.append(row);
    }
    if (result.nextBefore) {
      const more = document.createElement('button'); more.type = 'button'; more.textContent = 'Visa äldre ändringar';
      more.onclick = async () => {more.disabled = true;try {await history(result.nextBefore);more.remove();}catch(error){message=error.message;more.disabled=false;refresh();}};historyList.append(more);
    }
  }
  dialog.querySelector('[data-team-history]').onclick = async () => {try {await history();} catch (error) {message = error.message;refresh();}};
  dialog.querySelector('[data-team-rescue]').onclick = async event => {
    event.currentTarget.disabled = true;
    try {message = `${await exportPrivate()} kartobjekt kopierades till personliga lokala utkast. Öppna din personliga karta för att fortsätta.`;} catch (error) {message = error.message;event.currentTarget.disabled=false;}refresh();
  };
  dialog.querySelector('[data-team-backup]').onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({workspace, sync: sync.state}, null, 2)], {type: 'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = `omapmaker-arbetslag-${workspace.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  window.addEventListener('offline', () => {message = 'Offline · ändringarna sparas på enheten';refresh();});
  window.addEventListener('online', () => {message = 'Anslutningen är tillbaka. Tryck Synka för att fortsätta.';refresh();});
  refresh(); return {refresh};
}
