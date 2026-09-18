// Run team_browser_server.py first. Uses only disposable accounts and data.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');

(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  const errors=[],teamName='Browserlaget '+Date.now();
  try {
    async function login(username) {
      const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1280,height:900}});
      await context.addInitScript(()=>localStorage.setItem('omapmaker.layers',JSON.stringify({basemap:'orientation'})));
      const page=await context.newPage();page.on('requestfailed',req=>console.error('NETWORK:',req.url(),req.failure()?.errorText));page.on('pageerror',error=>(errors.push(error.message),console.error('PAGE ERROR:',error.message)));
      await page.goto('http://127.0.0.1:8876/index.html');
      await page.locator('#accountButton').click();await page.locator('#loginUsername').fill(username);await page.locator('#loginPassword').fill('browser-test-password');await page.locator('#loginSubmit').click();
      await page.waitForFunction(()=>document.querySelector('#accountName').textContent!=='Inte inloggad');
      const session=await (await context.request.get('http://127.0.0.1:8876/api/auth/session')).json();
      const post=async(path,body)=>{const response=await context.request.post('http://127.0.0.1:8876/api/'+path,{headers:{'X-OMapMaker-CSRF':session.csrfToken},data:body});assert.equal(response.ok(),true,await response.text());return response.json();};
      return {context,page,post};
    }
    fs.mkdirSync('.test-artifacts',{recursive:true});
    const owner=await login('owner');
    await owner.page.locator('#createTeamButton').click();await owner.page.locator('#createTeamForm input').fill(teamName);await owner.page.locator('#createTeamForm button').click();
    await owner.page.getByRole('button',{name:teamName+' · Ägare →'}).click();
    await owner.page.setViewportSize({width:390,height:844});await owner.page.screenshot({path:'.test-artifacts/team-members-mobile.png'});
    await owner.page.locator('#teamMemberForm input').fill('editor');await owner.page.locator('#teamMemberForm button').click();await owner.page.locator('.team-member[data-username=editor]').waitFor();await owner.page.waitForFunction(()=>!document.querySelector('#teamMemberForm button').disabled);
    await owner.page.locator('#teamMemberForm input').fill('viewer');await owner.page.locator('#teamMemberForm select').selectOption('viewer');await owner.page.locator('#teamMemberForm button').click();await owner.page.locator('.team-member[data-username=viewer]').waitFor();
    await owner.page.waitForFunction(()=>!document.querySelector('#teamMemberForm button').disabled);
    await owner.page.getByRole('button',{name:'Ändra roll för editor',exact:true}).click();assert.equal(await owner.page.locator('#teamMemberForm input').inputValue(),'editor');await owner.page.locator('#teamMemberForm button').click();await owner.page.waitForFunction(()=>!document.querySelector('#teamMemberForm button').disabled);
    await owner.page.screenshot({path:'.test-artifacts/team-members-filled-mobile.png'});await owner.page.setViewportSize({width:1280,height:900});await owner.page.screenshot({path:'.test-artifacts/team-members-desktop.png'});
    const team=(await (await owner.context.request.get('http://127.0.0.1:8876/api/teams')).json()).teams.find(t=>t.name===teamName);
    const workspace=await owner.post('team-workspaces',{teamId:team.id,workspace:{id:randomUUID(),name:'Testskogen',center:{lat:59,lng:18},sizeKm:2,scale:10000,contourInterval:5}});
    const url=`http://127.0.0.1:8876/field.html?workspace=${workspace.id}&team=1`;
    await owner.page.goto(url);await owner.page.locator('#teamSyncButton').waitFor();
    await owner.page.locator('#manualMode').click();await owner.page.locator('#pointAction').click();await owner.page.locator('#map').click({position:{x:600,y:340}});
    await owner.page.waitForFunction(()=>document.querySelector('#teamSyncButton').textContent.includes('1'));
    await owner.page.evaluate(()=>navigator.serviceWorker.ready);
    await owner.context.setOffline(true);await owner.page.reload();await owner.page.locator('#teamSyncButton').waitFor();
    assert.match(await owner.page.locator('#teamSyncButton').textContent(),/1/);
    await owner.context.setOffline(false);
    await owner.page.locator('#teamSyncButton').click();await owner.page.locator('[data-team-sync]').click();await owner.page.getByText('Synkningen är klar.',{exact:true}).waitFor();
    let data=await (await owner.context.request.get(`http://127.0.0.1:8876/api/team-workspaces/${workspace.id}/data`)).json();
    const object=data.entities.find(e=>e.kind==='object');assert(object,'Drawn point must reach server');
    const editor=await login('editor');await editor.page.goto(url);await editor.page.locator('#teamSyncButton').waitFor();
    // Change locally through the UI, then create a concurrent edit from the owner.
    await editor.page.locator('#manualMode').click();
    // Stable object actions are exposed in the point's popup.
    await editor.page.locator('.map-point-object').first().click({force:true});
    await editor.page.locator('[data-object-kind="local"][data-object-action="exclude"]').click();
    await owner.post(`team-workspaces/${workspace.id}/sync`,{mutationId:randomUUID(),changes:[{...object,expectedRevision:object.revision,payload:{...object.payload,coordinates:[18.0001,59]}}]});
    await editor.page.locator('#teamSyncButton').click();await editor.page.locator('[data-team-sync]').click();await editor.page.locator('.team-conflict').waitFor();
    fs.mkdirSync('.test-artifacts',{recursive:true});await editor.page.screenshot({path:'.test-artifacts/team-conflict.png'});
    assert.equal(await editor.page.locator('.team-geometry').count(),3);
    await editor.page.getByRole('button',{name:'Använd arbetslagets version'}).click();await editor.page.locator('[data-team-sync]').click();await editor.page.getByText('Synkningen är klar.',{exact:true}).waitFor();
    await editor.page.locator('[data-team-history]').click();await editor.page.getByRole('button',{name:'Förbered återställning'}).first().waitFor();
    await editor.page.getByRole('button',{name:'Förbered återställning'}).nth(1).click();
    await editor.page.locator('[data-team-sync]').click();await editor.page.getByText('Synkningen är klar.',{exact:true}).waitFor();
    data=await (await owner.context.request.get(`http://127.0.0.1:8876/api/team-workspaces/${workspace.id}/data`)).json();
    assert.equal(data.entities.find(e=>e.kind==='object').revision,3);
    const viewer=await login('viewer');await viewer.page.goto(url);await viewer.page.locator('#teamSyncButton').waitFor();assert.equal(await viewer.page.locator('#toolbar').isVisible(),false);
    await viewer.page.setViewportSize({width:390,height:844});await viewer.page.screenshot({path:'.test-artifacts/team-map-mobile.png'});await viewer.page.locator('#teamSyncButton').click();await viewer.page.screenshot({path:'.test-artifacts/team-mobile.png'});
    await owner.post(`teams/${team.id}/members`,{username:'viewer',role:'remove'});
    await viewer.page.reload();await viewer.page.locator('#teamSyncButton').click();await viewer.page.locator('[data-team-sync]').click();
    await viewer.page.getByText('Behörigheten har ändrats.',{exact:false}).waitFor();
    await viewer.page.locator('.team-utilities summary').click();await viewer.page.locator('[data-team-rescue]').click();await viewer.page.getByText('1 kartobjekt kopierades',{exact:false}).waitFor();
    assert.deepEqual(errors,[]);
    console.log('Team browser: create team, memberships, local drawing, reload, sync, geometry conflicts, history and viewer mobile passed.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
