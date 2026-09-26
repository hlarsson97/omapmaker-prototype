// Real IndexedDB, disposable browser profile and deterministic GPS. No user data.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),assets=path.resolve(__dirname,'../../performance-work');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:390,height:700},serviceWorkers:'block'}),errors=[];
  let authenticated=false,failUpload=false,loseReceipt=false;const uploaded=new Map(),attempts=new Map();
  const routeHandler=async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/journal-test.html')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Journal test</title>'});
   if(url.pathname.includes('/api/')){
    if(url.pathname==='/api/auth/session')return route.fulfill({json:authenticated?{authenticated:true,csrfToken:'test-token',user:{id:'11111111-1111-4111-8111-111111111111',username:'test',displayName:'Test',capabilities:[]}}:{authenticated:false}});
    if(url.pathname==='/api/workspaces'||url.pathname==='/api/team-workspaces')return route.fulfill({json:{workspaces:[]}});
    if(url.pathname==='/api/user-data')return route.fulfill({json:{objects:[],fieldSurveys:[],layerOverrides:[],cursor:0}});
    if(url.pathname==='/api/field-journal'){
     if(route.request().method()==='POST'){
      if(failUpload)return route.abort('internetdisconnected');
      const block=route.request().postDataJSON(),key=block.meta.id+':'+block.sequence;
      attempts.set(key,(attempts.get(key)||0)+1);if(uploaded.has(key))assert.deepEqual(uploaded.get(key),block);uploaded.set(key,block);
      if(loseReceipt){loseReceipt=false;return route.abort('failed')}
      return route.fulfill({json:{id:block.meta.id,sequence:block.sequence}});
     }
     if(url.searchParams.has('id'))return route.fulfill({json:uploaded.get(url.searchParams.get('id')+':'+url.searchParams.get('sequence'))});
     const heads=new Map();for(const block of uploaded.values())heads.set(block.meta.id,block.meta);return route.fulfill({json:{sessions:[...heads.values()]}});
    }
    return route.fulfill({json:{found:false,type:'FeatureCollection',features:[]}});
   }
   const file=url.hostname==='unpkg.com'?path.join(assets,url.pathname.includes('leaflet-rotate')?'rotate.js':url.pathname.endsWith('.css')?'leaflet.css':'leaflet.js'):url.hostname==='omap.test'?path.join(root,url.pathname.slice(1)):null;
   if(!file||!fs.existsSync(file))return route.fulfill({status:204,body:''});
   return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/javascript'});
  };
  await context.route('**/*',routeHandler);
  await context.addInitScript(()=>{
   localStorage.setItem('omapmaker.layers',JSON.stringify({basemap:'orientation'}));
   navigator.geolocation.watchPosition=callback=>{window.sendFix=callback;return 1};navigator.geolocation.clearWatch=()=>{};
  });
  let page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://omap.test/field.html');
  await page.waitForFunction(()=>typeof window.sendFix==='function');
  // Exercise journal throughput, bounded blocks, atomic failures and concurrent flushes independently of rendering.
  const result=await page.evaluate(async()=>{
   const {createFieldJournal,createJournalWriter}=await import('/js/field_journal.mjs');
   const journal=createFieldJournal('stress-test'),meta={id:crypto.randomUUID(),pointCount:0,sequence:0,segments:[]};
   const writer=createJournalWriter(journal,meta);const start=performance.now();let maxBuffer=0;
   for(let i=0;i<30000;i++){writer.append({fix:{longitude:18+i/100000,latitude:59,accuracy:4,timestamp:i}});meta.pointCount++;maxBuffer=Math.max(maxBuffer,writer.buffered);if(writer.buffered===128)await writer.flush()}
   await Promise.all([writer.flush(),writer.flush()]);
   const saved=await journal.get(meta.id);let count=0,maxBlock=0;for await(const block of journal.blocks(saved)){count+=block.points.length;maxBlock=Math.max(maxBlock,block.points.length)}
   let fail=true;const faultMeta={id:crypto.randomUUID(),pointCount:1,sequence:0};
   const faultWriter=createJournalWriter({...journal,commit:async(...args)=>{if(fail)throw new DOMException('Fullt','QuotaExceededError');return journal.commit(...args)}},faultMeta);
   faultWriter.append({fix:{latitude:59,longitude:18}});await faultWriter.flush().catch(()=>{});
   const retained=faultWriter.buffered,absent=!(await journal.get(faultMeta.id));fail=false;await faultWriter.flush();
   // add() duplicate aborts the entire transaction, including the metadata put.
   const before=await journal.get(meta.id);await journal.commit({...before,sequence:0,pointCount:999},[]).catch(()=>{});const after=await journal.get(meta.id);
   return {count,maxBlock,maxBuffer,savedCount:saved.pointCount,retained,absent,retried:faultWriter.buffered,atomic:after.pointCount===before.pointCount,ms:Math.round(performance.now()-start)};
  });
  assert.equal(result.count,30000);assert.equal(result.savedCount,30000);assert.equal(result.maxBlock,128);assert.equal(result.maxBuffer,128);assert.equal(result.retained,1);assert(result.absent);assert.equal(result.retried,0);assert(result.atomic);console.log('Journal stress and quota/transaction recovery:',result);
  await page.locator('#fieldSurveyToggle').click();await page.locator('#startFieldSurvey').click();await page.locator('#fieldSurveyPanel').waitFor({state:'visible'});
  await page.locator('[data-field-segment="path"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-field-segment="path"]').classList.contains('active'));
  await page.evaluate(()=>{for(let i=0;i<1300;i++)window.sendFix({timestamp:1000+i*1000,coords:{longitude:18.0686+i*.00004,latitude:59.3293+Math.sin(i/30)*.0001,accuracy:4,heading:90,speed:1.2}})});
  await page.locator('#fieldRetrySave').click();
  let checkpoint;
  for(let attempt=0;attempt<100;attempt++){
   checkpoint=await page.evaluate(async()=>{const {createFieldJournal}=await import('/js/field_journal.mjs');return (await createFieldJournal('omapmaker.field-surveys.global').list())[0]});
   if(checkpoint?.pointCount===1300)break;await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(checkpoint.pointCount,1300);
  // Simulate loss after committed checkpoint: these extra points must not corrupt the saved prefix.
  await page.evaluate(()=>{for(let i=1300;i<1310;i++)window.sendFix({timestamp:1000+i*1000,coords:{longitude:18.0686+i*.00004,latitude:59.3293,accuracy:4}})});
  const crashSession=await context.newCDPSession(page);const crashed=page.waitForEvent('crash');void crashSession.send('Page.crash').catch(()=>{});await crashed;await page.close();page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://omap.test/field.html');
  await page.locator('#fieldSurveyRecoverySheet').waitFor({state:'visible'});assert.match(await page.locator('#fieldRecoveryText').textContent(),/1300 GPS/);
  await page.locator('#fieldRecoverFinish').click();await page.locator('#fieldSurveyRecoverySheet').waitFor({state:'hidden'});
  const tracks=await page.evaluate(()=>JSON.parse(localStorage.getItem('omapmaker.global')).tracks);
  assert.equal(tracks.length,3);assert(tracks.every(t=>t.symbol==='506'&&t.rawJournal&&!t.rawCoordinates));
  for(let i=1;i<tracks.length;i++)assert.deepEqual(tracks[i-1].coordinates.at(-1),tracks[i].coordinates[0]);
  await page.reload();await page.waitForFunction(()=>typeof window.sendFix==='function');assert.equal(await page.locator('#fieldSurveyRecoverySheet').isVisible(),false);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('omapmaker.global')).tracks.length),3);
  await page.evaluate(()=>{const state=JSON.parse(localStorage.getItem('omapmaker.global'));state.tracks=[];localStorage.setItem('omapmaker.global',JSON.stringify(state))});
  await page.reload();await page.locator('#fieldSurveyToggle').click();await page.locator('#browseFieldSurveyLogs').click();
  await page.getByRole('button',{name:'Återskapa stigar'}).click();await page.locator('#fieldSurveyLogSheet').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('omapmaker.global')).tracks.length),3);
  assert.deepEqual(errors,[]);console.log('1300-point crash recovery, preserved endpoints, stable IDs and completed restart passed.');
  // Offline recording followed by upload with a deliberately lost acknowledgement.
  await page.close();authenticated=true;failUpload=true;page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://omap.test/field.html');
  await page.locator('#fieldSurveyToggle').click();await page.locator('#startFieldSurvey').click();await page.locator('#fieldSurveyPanel').waitFor({state:'visible'});
  await page.locator('[data-field-segment="path"]').click();await page.waitForFunction(()=>document.querySelector('[data-field-segment="path"]').classList.contains('active'));
  await page.evaluate(()=>{for(let i=0;i<50;i++)window.sendFix({timestamp:1000+i*1000,coords:{longitude:18+i*.0001,latitude:59,accuracy:4}})});
  await page.locator('#fieldRetrySave').click();
  const userScope='omapmaker.field-surveys.user.11111111-1111-4111-8111-111111111111.global';
  let userSession;
  for(let i=0;i<100;i++){userSession=await page.evaluate(async scope=>{const {createFieldJournal}=await import('/js/field_journal.mjs');return (await createFieldJournal(scope).list())[0]},userScope);if(userSession?.pointCount===50)break;await new Promise(r=>setTimeout(r,50))}
  assert.equal(userSession.pointCount,50);assert.equal(uploaded.size,0);
  failUpload=false;loseReceipt=true;await page.evaluate(()=>dispatchEvent(new Event('online')));
  for(let i=0;i<100&&!uploaded.size;i++)await new Promise(r=>setTimeout(r,50));assert(uploaded.size>0);
  await page.evaluate(()=>dispatchEvent(new Event('online')));
  for(let i=0;i<100;i++){if([...uploaded.values()].some(b=>b.meta.pointCount===50))break;await new Promise(r=>setTimeout(r,50))}
  assert([...attempts.values()].some(n=>n>=2),'Lost acknowledgement must retry exactly the same block');
  assert.equal([...uploaded.values()].reduce((n,b)=>n+b.points.length,0),50);
  await page.close();
  // A fresh device downloads saved blocks and offers recovery, then starts across a gap.
  const fresh=await browser.newContext({serviceWorkers:'block'});await fresh.route('**/*',routeHandler);
  await fresh.addInitScript(()=>{localStorage.setItem('omapmaker.layers',JSON.stringify({basemap:'orientation'}));navigator.geolocation.watchPosition=callback=>{window.sendFix=callback;return 1}});
  const restored=await fresh.newPage();restored.on('pageerror',e=>errors.push(e.message));await restored.goto('https://omap.test/field.html');
  await restored.locator('#fieldSurveyRecoverySheet').waitFor({state:'visible'});assert.match(await restored.locator('#fieldRecoveryText').textContent(),/50 GPS/);
  await restored.locator('#fieldRecoverContinue').click();await restored.locator('#fieldSurveyPanel').waitFor({state:'visible'});
  await restored.waitForFunction(()=>document.querySelector('[data-field-segment="path"]').classList.contains('active'));
  await restored.evaluate(()=>{for(let i=0;i<3;i++)window.sendFix({timestamp:100000+i*1000,coords:{longitude:19+i*.0001,latitude:60,accuracy:4}})});
  await restored.locator('#stopFieldSurvey').click();await restored.locator('#fieldSurveyPanel').waitFor({state:'hidden'});
  const recoveredTracks=await restored.evaluate(()=>JSON.parse(localStorage.getItem('omapmaker.user-map.11111111-1111-4111-8111-111111111111')).tracks);
  assert.equal(recoveredTracks.length,2);assert(recoveredTracks[0].coordinates.every(p=>p[1]===59));assert(recoveredTracks[1].coordinates.every(p=>p[1]===60));
  assert.deepEqual(errors,[]);console.log('Offline upload, lost-response retry, fresh-device recovery and resume without bridging a gap passed.');
  await fresh.close();await context.close();
  authenticated=false;const legacyContext=await browser.newContext({serviceWorkers:'block',acceptDownloads:true});await legacyContext.route('**/*',routeHandler);
  await legacyContext.addInitScript(()=>{localStorage.setItem('omapmaker.layers',JSON.stringify({basemap:'orientation'}));navigator.geolocation.watchPosition=()=>1});
  const legacyPage=await legacyContext.newPage();await legacyPage.goto('https://omap.test/journal-test.html');
  await legacyPage.evaluate(async()=>{
   const {createIndexedDbStore}=await import('/js/indexeddb_store.mjs');const {createFieldJournal,createJournalWriter}=await import('/js/field_journal.mjs');
   const id=crypto.randomUUID(),segmentId=crypto.randomUUID(),startedAt=new Date().toISOString();
   const raw=Array.from({length:50},(_,i)=>({longitude:18+i*.0001,latitude:59,accuracy:4,timestamp:i*1000}));
   const old={id,startedAt,status:'active',raw,segments:[],transitions:[{type:'path',rawIndex:0,at:startedAt}]};
   await createIndexedDbStore({databaseName:'omapmaker-mapdata',version:1,storeName:'contours'}).put('omapmaker.field-surveys.global',[old]);
   // Simulate interruption halfway through migration. Original data must remain usable.
   const meta={id,startedAt,status:'interrupted',sequence:0,pointCount:10,segments:[{id:segmentId,type:'path',startedAt,endedAt:null}]};
   const writer=createJournalWriter(createFieldJournal('omapmaker.field-surveys.global'),meta);
   raw.slice(0,10).forEach(fix=>writer.append({fix,segmentId,type:'path'}));await writer.flush();
  });
  await legacyPage.goto('https://omap.test/field.html');await legacyPage.locator('#fieldSurveyRecoverySheet').waitFor({state:'visible'});assert.match(await legacyPage.locator('#fieldRecoveryText').textContent(),/50 GPS/);
  await legacyPage.locator('#fieldRecoverFinish').click();await legacyPage.locator('#fieldSurveyRecoverySheet').waitFor({state:'hidden'});
  await legacyPage.locator('#fieldSurveyToggle').click();await legacyPage.locator('#browseFieldSurveyLogs').click();
  const downloaded=legacyPage.waitForEvent('download');await legacyPage.getByRole('button',{name:'Exportera',exact:true}).last().click();const file=await downloaded;
  const exportPath=path.join(root,'.test-artifacts/field-journal-export.geojson');await file.saveAs(exportPath);const exported=JSON.parse(fs.readFileSync(exportPath,'utf8'));
  assert.equal(exported.features.length,50);assert(exported.features.every(f=>f.properties.segmentType==='path'));
  assert.equal(await legacyPage.evaluate(()=>JSON.parse(localStorage.getItem('omapmaker.global')).tracks.length),1);
  await legacyContext.close();console.log('Interrupted legacy migration, recovered active trail and complete raw export passed.');
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
