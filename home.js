import {createAccountApi, readJsonStorage} from './js/account_api.mjs';
import {createIndexedDbStore} from './js/indexeddb_store.mjs';

const L = globalThis.L;
const accountApi = createAccountApi();
const mapDataStore = createIndexedDbStore({databaseName: 'omapmaker-mapdata', version: 1, storeName: 'contours'});
const legacyWorkspaces = readJsonStorage(localStorage, 'omapmaker.workspaces', []);
let workspaces = [...legacyWorkspaces], accountUser = null, accountOnline = false;
let pendingPrivateMigration = {objects: [], fieldSurveys: [], layerOverrides: [], fingerprint: ''};
const list = document.querySelector('#workspaceList');
let chosenCenter = null, areaMap = null, areaRectangle = null, areaBaseLayer = null;
const areaBaseMaps = {
  osm: () => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 20, attribution: '© OpenStreetMap contributors'}),
  aerial: () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {maxZoom: 19, attribution: 'Imagery © Esri'}),
  terrain: () => L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {maxZoom: 17, attribution: '© OpenStreetMap · SRTM | OpenTopoMap'}),
  orientation: () => null
};

function previewBounds(center, sizeKm) {
  const half = sizeKm / 2, latDelta = half / 111.32, lngDelta = half / (111.32 * Math.cos(center.lat * Math.PI / 180));
  return L.latLngBounds([center.lat - latDelta, center.lng - lngDelta], [center.lat + latDelta, center.lng + lngDelta]);
}

function refreshAreaPreview() {
  if (!areaMap) return;
  const center = areaMap.getCenter(), size = Number(document.querySelector('#workspaceSize').value), bounds = previewBounds(center, size);
  if (areaRectangle) areaRectangle.setBounds(bounds);
  else areaRectangle = L.rectangle(bounds, {color: '#075b3a', weight: 3, fillColor: '#ddef68', fillOpacity: .18, interactive: false}).addTo(areaMap);
  document.querySelector('#workspaceAreaStatus').textContent = `${size} × ${size} km · ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`;
}

function setAreaBasemap(id) {
  const selected = areaBaseMaps[id] ? id : 'osm';
  if (areaBaseLayer) areaMap.removeLayer(areaBaseLayer);
  areaBaseLayer = areaBaseMaps[selected]();
  if (areaBaseLayer) areaBaseLayer.addTo(areaMap);
  areaMap.getContainer().classList.toggle('orientation-background', selected === 'orientation');
  localStorage.setItem('omapmaker.areaBasemap', selected);
  document.querySelector('#workspaceAreaBasemap').value = selected;
}

function openAreaPicker() {
  const dialog = document.querySelector('#workspaceAreaDialog');
  const last = chosenCenter || readJsonStorage(localStorage, 'omapmaker.lastCenter.global', readJsonStorage(localStorage, 'omapmaker.lastCenter', {lat: 59.3293, lng: 18.0686}));
  const size = Number(document.querySelector('#workspaceSize').value);
  dialog.showModal();
  if (!areaMap) {
    areaMap = L.map('workspaceAreaMap', {zoomControl: true}).setView([last.lat, last.lng], 13);
    setAreaBasemap(localStorage.getItem('omapmaker.areaBasemap') || 'osm');
    areaMap.on('move zoom', refreshAreaPreview);
  }
  setTimeout(() => { areaMap.invalidateSize(); areaMap.fitBounds(previewBounds(last, size), {padding: [35, 35]}); refreshAreaPreview(); }, 80);
}

function renderAccount() {
  const panel = document.querySelector('#accountPanel');
  panel.classList.toggle('authenticated', Boolean(accountUser && accountOnline));
  panel.classList.toggle('offline', Boolean(accountUser && !accountOnline));
  document.querySelector('#accountName').textContent = accountUser?.displayName || accountUser?.username || 'Inte inloggad';
  document.querySelector('#accountStatus').textContent = accountUser ? (accountOnline ? 'Arbetsområden synkroniseras med servern' : 'Offline · visar senast sparade serverkopia') : 'Lokala data visas bara på denna enhet';
  document.querySelector('#accountButton').textContent = accountUser ? 'Logga ut' : 'Logga in';
  document.querySelector('#storageSummary').textContent = accountUser ? (accountOnline ? 'Privat serverlagring · lokal cache' : 'Offline · lokal cache') : 'Fältprototyp · data sparas lokalt på enheten';
}

function render() {
  document.querySelector('#workspaceCount').textContent = `${workspaces.length} sparade`;
  list.replaceChildren();
  if (!workspaces.length) {
    const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'Inga arbetsområden ännu. Den globala kartan är alltid tillgänglig.'; list.append(empty); return;
  }
  [...workspaces].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).forEach(workspace => {
    const anchor = document.createElement('a'); anchor.className = 'workspace'; anchor.href = `field.html?workspace=${encodeURIComponent(workspace.id)}`;
    const content = document.createElement('div'), name = document.createElement('b'), meta = document.createElement('span'), arrow = document.createElement('i');
    name.textContent = workspace.name;
    const mode = (workspace.symbolDisplayMode || 'print') === 'print' ? 'Utskriftsläge' : 'Digitalt läge';
    meta.textContent = `1:${Number(workspace.scale).toLocaleString('sv-SE')} · ${workspace.contourInterval} m · ${workspace.sizeKm} × ${workspace.sizeKm} km · ${mode}`;
    arrow.textContent = '→'; content.append(name, meta); anchor.append(content, arrow); list.append(anchor);
  });
}

function migrationCandidates() {
  const serverIds = new Set(workspaces.map(item => item.id));
  return legacyWorkspaces.filter(item => item?.id && !serverIds.has(item.id));
}

async function legacyPrivateData() {
  const saved = readJsonStorage(localStorage, 'omapmaker.global', readJsonStorage(localStorage, 'omapmaker.live', {}));
  const objects = [['point', saved.observations], ['line', saved.tracks], ['area', saved.areas]].flatMap(([category, values]) => (values || []).filter(value => value?.id || value?.observationId).map(value => ({id: value.observationId || value.id, category, payload: value})));
  const keys = ['global', ...legacyWorkspaces.map(item => item.id)], fieldSurveys = [], layerOverrides = [], seen = new Set();
  const generatedLayers = [['buildings', 'omapmaker.buildings'], ['land-cover', 'omapmaker.land-cover.v2'], ['paved-areas', 'omapmaker.paved-areas.v1'], ['roads', 'omapmaker.roads.v2'], ['infrastructure', 'omapmaker.infrastructure.v1']];
  const overridePayload = feature => {
    const properties = {}, source = feature.properties || {};
    for (const name of ['status', 'mapStatus', 'originalGeometry', 'editedAt', 'deletedAt', 'reviewedAt', 'isomSymbol', 'mapClass', 'omapType']) if (source[name] !== undefined) properties[name] = source[name];
    return {geometry: feature.geometry, properties};
  };
  for (const key of keys) {
    try {
      const sessions = await mapDataStore.get(`omapmaker.field-surveys.${key}`) || [];
      for (const session of sessions) if (session?.id && !seen.has(session.id)) { seen.add(session.id); fieldSurveys.push({id: session.id, payload: session}); }
    } catch {}
    for (const [layerType, prefix] of generatedLayers) {
      try {
        const data = await mapDataStore.get(`${prefix}.${key}`);
        for (const feature of data?.features || []) {
          const status = feature.properties?.mapStatus || feature.properties?.status;
          if (!['locally-edited', 'locally-excluded', 'locally-rejected', 'locally-deleted'].includes(status) || feature.id === undefined) continue;
          layerOverrides.push({scopeId: key, layerType, featureId: String(feature.id), payload: overridePayload(feature)});
        }
      } catch {}
    }
    try {
      const overrides = await mapDataStore.get(`omapmaker.global-object-overrides.${key}`) || {};
      for (const [featureId, payload] of Object.entries(overrides)) layerOverrides.push({scopeId: key, layerType: 'global-objects', featureId, payload});
    } catch {}
  }
  const fingerprint = [...objects.map(item => `o:${item.id}`), ...fieldSurveys.map(item => `s:${item.id}`), ...layerOverrides.map(item => `l:${item.scopeId}:${item.layerType}:${item.featureId}`)].sort().join('|');
  return {objects, fieldSurveys, layerOverrides, fingerprint};
}

async function offerMigration() {
  const candidates = migrationCandidates();
  if (!accountOnline) return;
  pendingPrivateMigration = await legacyPrivateData();
  const privateMarker = localStorage.getItem(`omapmaker.privateMigration.${accountUser.id}`), privatePending = pendingPrivateMigration.fingerprint && pendingPrivateMigration.fingerprint !== privateMarker;
  if (!candidates.length && !privatePending) return;
  document.querySelector('#migrationSummary').className = '';
  const parts = [];
  if (candidates.length) parts.push(`${candidates.length} ${candidates.length === 1 ? 'arbetsområde' : 'arbetsområden'}`);
  if (privatePending && pendingPrivateMigration.objects.length) parts.push(`${pendingPrivateMigration.objects.length} ritade objekt`);
  if (privatePending && pendingPrivateMigration.fieldSurveys.length) parts.push(`${pendingPrivateMigration.fieldSurveys.length} GPS-loggar`);
  if (privatePending && pendingPrivateMigration.layerOverrides.length) parts.push(`${pendingPrivateMigration.layerOverrides.length} lokala lagerändringar`);
  document.querySelector('#migrationSummary').textContent = `${parts.join(', ')} finns lokalt på den här enheten och kan flyttas till ditt privata konto.`;
  if (!document.querySelector('#migrationDialog').open) document.querySelector('#migrationDialog').showModal();
}

async function refreshServerWorkspaces() {
  workspaces = await accountApi.listWorkspaces(accountUser.id);
  render(); offerMigration();
}

async function initializeAccount() {
  const cached = accountApi.cachedUser();
  if (cached) {
    accountUser = cached; accountOnline = false; workspaces = accountApi.cachedWorkspaces(cached.id); renderAccount(); render();
  }
  try {
    const session = await accountApi.session();
    if (!session.authenticated) {
      accountUser = null; accountOnline = false; workspaces = [...legacyWorkspaces]; renderAccount(); render(); return;
    }
    accountUser = session.user; accountOnline = true; renderAccount(); await refreshServerWorkspaces();
  } catch {
    if (!cached) { accountUser = null; workspaces = [...legacyWorkspaces]; }
    accountOnline = false; renderAccount(); render();
  }
}

document.querySelector('#newWorkspace').onclick = () => {
  if (!accountUser || !accountOnline) {
    document.querySelector('#loginStatus').className = accountUser ? 'error' : '';
    document.querySelector('#loginStatus').textContent = accountUser ? 'Anslut till servern innan du skapar ett arbetsområde.' : 'Logga in för att skapa ett serverlagrat arbetsområde.';
    document.querySelector('#loginDialog').showModal(); return;
  }
  document.querySelector('#workspaceDialog').showModal();
};
document.querySelector('#aboutButton').onclick = document.querySelector('#aboutFooter').onclick = () => document.querySelector('#aboutDialog').showModal();
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => document.querySelector(`#${button.dataset.close}`).close());
document.querySelector('#chooseWorkspaceArea').onclick = openAreaPicker;
document.querySelector('#cancelWorkspaceArea').onclick = () => document.querySelector('#workspaceAreaDialog').close();
document.querySelector('#workspaceAreaBasemap').onchange = event => setAreaBasemap(event.target.value);
document.querySelector('#locateWorkspaceArea').onclick = () => {
  const button = document.querySelector('#locateWorkspaceArea'), status = document.querySelector('#workspaceAreaStatus');
  if (!navigator.geolocation) { status.textContent = 'Positionering stöds inte av webbläsaren'; return; }
  button.disabled = true; button.textContent = 'Söker position…';
  navigator.geolocation.getCurrentPosition(position => {
    const center = {lat: position.coords.latitude, lng: position.coords.longitude}, size = Number(document.querySelector('#workspaceSize').value);
    areaMap.fitBounds(previewBounds(center, size), {padding: [35, 35], animate: true}); button.disabled = false; button.textContent = '◎ Min position'; status.textContent = `GPS ± ${Math.round(position.coords.accuracy)} m`;
  }, error => {
    button.disabled = false; button.textContent = '◎ Min position'; status.textContent = error.code === 1 ? 'Positionering saknar tillstånd' : 'Positionen kunde inte hämtas';
  }, {enableHighAccuracy: true, maximumAge: 5000, timeout: 15000});
};
document.querySelector('#workspaceSize').onchange = () => {
  if (areaMap) { const center = areaMap.getCenter(), size = Number(document.querySelector('#workspaceSize').value); areaMap.fitBounds(previewBounds(center, size), {padding: [35, 35]}); refreshAreaPreview(); }
  if (chosenCenter) { chosenCenter = null; document.querySelector('#chosenAreaSummary').textContent = 'Storleken ändrades · välj området på kartan igen.'; }
};
document.querySelector('#confirmWorkspaceArea').onclick = () => {
  const center = areaMap.getCenter(), size = Number(document.querySelector('#workspaceSize').value); chosenCenter = {lat: center.lat, lng: center.lng};
  document.querySelector('#chosenAreaSummary').textContent = `Valt område: ${size} × ${size} km runt ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`;
  document.querySelector('#chooseWorkspaceArea span').textContent = 'Ändra plats och område'; document.querySelector('#workspaceAreaDialog').close();
};
document.querySelector('#workspaceForm').onsubmit = async event => {
  event.preventDefault();
  if (!chosenCenter) { openAreaPicker(); return; }
  const button = event.currentTarget.querySelector('[type=submit]'), now = new Date().toISOString();
  const workspace = {id: crypto.randomUUID(), name: document.querySelector('#workspaceName').value.trim(), scale: Number(document.querySelector('#workspaceScale').value), contourInterval: Number(document.querySelector('#workspaceContour').value), symbolDisplayMode: document.querySelector('#workspaceSymbolMode').value, sizeKm: Number(document.querySelector('#workspaceSize').value), center: chosenCenter, createdAt: now, updatedAt: now, standard: 'ISOM 2017-2 v6'};
  button.disabled = true; button.textContent = 'Sparar…';
  try {
    const saved = await accountApi.createWorkspace(accountUser.id, workspace); workspaces = [saved, ...workspaces.filter(item => item.id !== saved.id)]; location.href = `field.html?workspace=${encodeURIComponent(saved.id)}`;
  } catch (error) {
    document.querySelector('#chosenAreaSummary').textContent = `Kunde inte spara: ${error.message}`; button.disabled = false; button.textContent = 'Skapa och öppna';
  }
};
document.querySelector('#accountButton').onclick = async () => {
  if (!accountUser) { document.querySelector('#loginStatus').className = ''; document.querySelector('#loginStatus').textContent = 'Dina arbetsområden lagras privat på OMapMaker-servern.'; document.querySelector('#loginDialog').showModal(); return; }
  if (!accountOnline) { document.querySelector('#loginStatus').className = 'error'; document.querySelector('#loginStatus').textContent = 'Anslut till servern för att logga ut säkert.'; document.querySelector('#loginDialog').showModal(); return; }
  try { await accountApi.logout(); accountUser = null; accountOnline = false; workspaces = [...legacyWorkspaces]; renderAccount(); render(); }
  catch (error) { document.querySelector('#accountStatus').textContent = error.message; }
};
document.querySelector('#loginForm').onsubmit = async event => {
  event.preventDefault(); const button = document.querySelector('#loginSubmit'), status = document.querySelector('#loginStatus'); button.disabled = true; button.textContent = 'Loggar in…'; status.className = '';
  try {
    const result = await accountApi.login(document.querySelector('#loginUsername').value, document.querySelector('#loginPassword').value); accountUser = result.user; accountOnline = true; document.querySelector('#loginPassword').value = ''; document.querySelector('#loginDialog').close(); renderAccount(); await refreshServerWorkspaces();
  } catch (error) { status.className = 'error'; status.textContent = error.message; }
  finally { button.disabled = false; button.textContent = 'Logga in'; }
};
document.querySelector('#migrationForm').onsubmit = async event => {
  event.preventDefault(); const candidates = migrationCandidates(), button = document.querySelector('#migrationSubmit'), summary = document.querySelector('#migrationSummary'); button.disabled = true; button.textContent = 'Flyttar…'; summary.className = '';
  try {
    const migrationId = crypto.randomUUID();
    const workspaceResult = candidates.length ? await accountApi.importWorkspaces(accountUser.id, candidates, migrationId) : {imported: 0};
    const privateResult = pendingPrivateMigration.fingerprint ? await accountApi.importUserData(pendingPrivateMigration.objects, pendingPrivateMigration.fieldSurveys, pendingPrivateMigration.layerOverrides, migrationId) : {objectsImported: 0, fieldSurveysImported: 0, layerOverridesImported: 0};
    if (pendingPrivateMigration.fingerprint) localStorage.setItem(`omapmaker.privateMigration.${accountUser.id}`, pendingPrivateMigration.fingerprint);
    await refreshServerWorkspaces(); document.querySelector('#migrationDialog').close(); document.querySelector('#accountStatus').textContent = `${workspaceResult.imported + privateResult.objectsImported + privateResult.fieldSurveysImported + privateResult.layerOverridesImported} poster flyttades till servern`;
  } catch (error) { summary.className = 'error'; summary.textContent = error.message; }
  finally { button.disabled = false; button.textContent = 'Flytta till mitt konto'; }
};

renderAccount(); render(); initializeAccount();
