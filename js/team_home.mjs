import {createTeamApi} from './team_sync.mjs?v=1';

export function mountTeamHome({accountApi, getUser, refresh}) {
  const request = createTeamApi(accountApi);
  const section = document.createElement('section');
  section.className = 'team-home-section';
  section.innerHTML = `<div class="section-title"><div><small>GEMENSAM KARTERING</small><h2>Arbetslag</h2></div><button id="createTeamButton" type="button">Nytt arbetslag ＋</button></div><p id="teamHomeStatus" role="status"></p><div id="teamList" class="workspace-list"></div>`;
  document.querySelector('main.home footer').before(section);
  const dialog = document.createElement('dialog');
  dialog.className = 'team-home-dialog'; dialog.setAttribute('aria-labelledby', 'teamDialogTitle');
  dialog.innerHTML = `<section class="team-dialog-body"><div class="dialog-head"><div><small>GEMENSAM KARTERING</small><h2 id="teamDialogTitle">Arbetslag</h2></div><button type="button" aria-label="Stäng">×</button></div><form id="createTeamForm"><p class="team-intro">Samla medlemmar och kartera i gemensamma arbetsområden.</p><label>Namn på arbetslaget<input name="name" required maxlength="80" placeholder="Exempelvis Norrskogens kartlag"></label><button type="submit" class="primary">Skapa arbetslag</button></form><div id="teamMembers"></div><form id="teamMemberForm"><h3>Lägg till en medlem</h3><p class="team-intro">Användaren behöver redan ha ett OMapMaker-konto. Ange ett befintligt medlemsnamn för att ändra rollen.</p><div class="team-member-fields"><label>Användarnamn<input name="username" required autocomplete="off" placeholder="Användarnamn"></label><label>Roll<select name="role"><option value="editor">Redigerare</option><option value="viewer">Läsare</option></select></label></div><button type="submit" class="primary">Spara medlem</button></form><p id="teamDialogStatus" role="status"></p></section>`;
  document.body.append(dialog);
  dialog.querySelector('.dialog-head button').onclick = () => dialog.close();
  const create = dialog.querySelector('#createTeamForm'), memberForm = dialog.querySelector('#teamMemberForm'), members = dialog.querySelector('#teamMembers'), status = dialog.querySelector('#teamDialogStatus');
  const label = document.createElement('label');
  label.textContent = 'Tillhör';
  const select = document.createElement('select'); select.id = 'workspaceTeam'; label.append(select);
  document.querySelector('#workspaceName').parentElement.after(label);
  let teams = [], activeTeam;
  const roleName = role => ({owner: 'Ägare', editor: 'Redigerare', viewer: 'Läsare'})[role];
  function render() {
    section.hidden = !getUser();
    const selected = select.value;
    select.replaceChildren(new Option('Mitt personliga konto', ''));
    const list = section.querySelector('#teamList'); list.replaceChildren();
    for (const team of teams) {
      if (team.role !== 'viewer') select.add(new Option(team.name, team.id));
      const button = document.createElement('button'); button.className = 'workspace'; button.type = 'button';
      button.setAttribute('aria-label', `${team.name} · ${roleName(team.role)} →`);
      const content = document.createElement('div'), name = document.createElement('b'), role = document.createElement('span'), arrow = document.createElement('i');
      name.textContent = team.name; role.textContent = `${roleName(team.role)} · Visa medlemmar`; arrow.textContent = '→'; arrow.setAttribute('aria-hidden','true');
      content.append(name,role);button.append(content,arrow);
      button.onclick = () => openMembers(team); list.append(button);
    }
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
  }
  async function load() {
    const user = getUser();
    if (!user) { teams = []; render(); return; }
    teams = JSON.parse(localStorage.getItem(`omapmaker.teams.${user.id}`) || '[]'); render();
    try {
      teams = (await request('teams')).teams;
      localStorage.setItem(`omapmaker.teams.${user.id}`, JSON.stringify(teams));
      section.querySelector('#teamHomeStatus').textContent = teams.length ? 'Öppna ett arbetslag för att se medlemmar. Välj arbetslag när du skapar ett arbetsområde.' : 'Skapa ett arbetslag och lägg till andra användare för att kartera tillsammans.';
      render();
    } catch { section.querySelector('#teamHomeStatus').textContent = 'Offline · sparade arbetslag visas'; }
  }
  async function showMembers() {
    members.replaceChildren();
    const result = await request(`teams/${activeTeam.id}/members`);
    for (const member of result.members) {
      const row = document.createElement('div'), text = document.createElement('span'); row.className = 'team-member';
      row.dataset.username = member.username;
      const name = document.createElement('b'), meta = document.createElement('small');
      name.textContent = member.displayName || member.username;
      meta.textContent = `${member.displayName && member.displayName !== member.username ? '@'+member.username+' · ' : ''}${roleName(member.role)}`;
      text.append(name, meta); row.append(text);
      if (activeTeam.role === 'owner' && member.role !== 'owner') {
        const controls = document.createElement('div'); controls.className = 'team-member-controls';
        const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Ändra roll'; edit.className = 'team-edit-member';
        edit.setAttribute('aria-label', `Ändra roll för ${member.username}`);
        edit.onclick = () => {
          memberForm.elements.username.value = member.username; memberForm.elements.role.value = member.role;
          memberForm.querySelector('h3').textContent = `Ändra roll för ${member.displayName || member.username}`;
          status.textContent = ''; memberForm.elements.role.focus();
        };
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'team-remove-member'; remove.textContent = 'Ta bort'; remove.setAttribute('aria-label', `Ta bort ${member.username} från arbetslaget`);
        remove.onclick = async () => {
          remove.disabled = true;
          try { await request(`teams/${activeTeam.id}/members`, {username: member.username, role: 'remove'}); await showMembers(); }
          catch (error) { status.textContent = error.message; remove.disabled = false; }
        }; controls.append(edit, remove); row.append(controls);
      }
      members.append(row);
    }
  }
  async function openMembers(team) {
    activeTeam = team; create.hidden = true; members.hidden = false; memberForm.hidden = team.role !== 'owner';
    memberForm.reset(); memberForm.querySelector('h3').textContent = 'Lägg till en medlem';
    dialog.querySelector('#teamDialogTitle').textContent = team.name; status.textContent = ''; dialog.showModal();
    try { await showMembers(); } catch (error) { status.textContent = error.message; }
  }
  section.querySelector('#createTeamButton').onclick = () => {
    create.hidden = false; members.hidden = true; memberForm.hidden = true;
    dialog.querySelector('#teamDialogTitle').textContent = 'Nytt arbetslag'; status.textContent = ''; dialog.showModal();
  };
  create.onsubmit = async event => {
    event.preventDefault(); const button = create.querySelector('button'); button.disabled = true;
    try { await request('teams', {name: create.elements.name.value}); create.reset(); dialog.close(); await load(); }
    catch (error) { status.textContent = error.message; } finally { button.disabled = false; }
  };
  memberForm.onsubmit = async event => {
    event.preventDefault(); const button = memberForm.querySelector('button'); button.disabled = true;
    try { await request(`teams/${activeTeam.id}/members`, {username: memberForm.elements.username.value, role: memberForm.elements.role.value}); memberForm.reset(); memberForm.querySelector('h3').textContent = 'Lägg till en medlem'; await showMembers(); await refresh(); status.textContent = 'Medlemskapet sparades'; }
    catch (error) { status.textContent = error.message; } finally { button.disabled = false; }
  };
  return {load, render};
}
