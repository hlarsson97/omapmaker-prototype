// Uses disposable browser storage and local Leaflet assets, never server/user data.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),assets=path.resolve(process.argv[2]||'../performance-work');
const mx=111320*Math.cos(59*Math.PI/180),coordinate=(x,y)=>[18+x/mx,59+y/111320];
const original=coordinate(0,1),globalCoordinate=coordinate(20,-1);
const state={observations:[{id:'11111111-1111-4111-8111-111111111111',observationId:'11111111-1111-4111-8111-111111111111',symbol:'204',objectType:'boulder',source:'gps',accuracy:2,coordinates:original,createdAt:'2026-09-18T12:00:00Z'}],tracks:[{id:'22222222-2222-4222-8222-222222222222',symbol:'506',objectType:'path',source:'manual',coordinates:[coordinate(-200,0),coordinate(200,0)]}],areas:[]};
const globalFeature={type:'Feature',id:'global-stone',properties:{symbol:'204',isomSymbol:'204',objectType:'boulder',qualityScore:80},geometry:{type:'Point',coordinates:globalCoordinate}};
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    for(const mobile of [true,false]){
      const context=await browser.newContext({viewport:mobile?{width:390,height:700}:{width:1280,height:900},hasTouch:mobile,serviceWorkers:'block'});
      const page=await context.newPage(),errors=[];
      page.on('pageerror',error=>{errors.push(error.message);console.error(error.stack);});
      await page.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(url.pathname.includes('/api/'))return route.fulfill({json:url.pathname.includes('session')?{authenticated:false}:url.pathname.includes('global-objects')?{type:'FeatureCollection',features:[globalFeature]}:{found:false,type:'FeatureCollection',features:[]}});
        let file;
        if(url.hostname==='unpkg.com')file=path.join(assets,url.pathname.includes('leaflet-rotate')?'rotate.js':url.pathname.endsWith('.css')?'leaflet.css':'leaflet.js');
        else if(url.hostname==='omap.test')file=path.join(root,url.pathname.slice(1));
        else return route.fulfill({status:204,body:''});
        if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
        let body=fs.readFileSync(file);
        if(file.endsWith('leaflet.js'))body+='\nconst originalMap=L.map;L.map=(...args)=>(window.testMap=originalMap(...args));';
        return route.fulfill({body,contentType:file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/javascript'});
      });
      await page.addInitScript(({state})=>{
        if(!localStorage.getItem('omapmaker.global'))localStorage.setItem('omapmaker.global',JSON.stringify(state));
        localStorage.setItem('omapmaker.layers',JSON.stringify({basemap:'orientation'}));
        localStorage.setItem('omapmaker.mode','manual');
        localStorage.setItem('omapmaker.toolbarCollapsed.v2','true');
        localStorage.setItem('omapmaker.workspaces',JSON.stringify([{id:'test',name:'Stenar vid stig',center:{lat:59,lng:18},sizeKm:2,scale:15000,contourInterval:5,magneticDeclination:7,showNorthLines:false}]));
        navigator.geolocation.watchPosition=callback=>{window.sendFix=callback;return 1;};
        navigator.geolocation.clearWatch=()=>{};
      },{state});
      await page.goto('https://omap.test/field.html?workspace=test');
      await page.waitForFunction(()=>Object.values(testMap._layers).some(l=>l._omapObjectId==='11111111-1111-4111-8111-111111111111'));
      await page.evaluate(()=>testMap.setView([59,18],19,{animate:false}));
      await page.waitForFunction(()=>{const m=Object.values(testMap._layers).find(l=>l._omapObjectId==='11111111-1111-4111-8111-111111111111');return m?.getLatLng().lat>59+6/111320;});
      await page.waitForFunction(()=>Object.values(testMap._layers).some(l=>l.feature?.id==='global-stone'&&l.getLatLng?.().lat<59-6/111320));
      const stored=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('omapmaker.global')).observations.find(o=>o.id==='11111111-1111-4111-8111-111111111111'));
      const markerInfo=()=>page.evaluate(()=>{const m=Object.values(testMap._layers).find(l=>l._omapObjectId==='11111111-1111-4111-8111-111111111111'),ll=m.getLatLng(),p=testMap.latLngToContainerPoint(ll);return{lat:ll.lat,lng:ll.lng,x:p.x,y:p.y,draggable:m.dragging?.enabled()||false};});
      const before=await markerInfo();assert(!before.draggable);assert.deepEqual((await stored()).coordinates,original);
      async function dragAt(p,dx,dy){await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+dx,p.y+dy,{steps:10});await page.mouse.up();}
      await dragAt(before,45,30);
      assert.deepEqual((await stored()).coordinates,original,'Panning from the symbol must not move the surveyed point');
      let info=await markerInfo();assert.equal(info.lat,before.lat);assert.equal(info.lng,before.lng);
      if(mobile){
        const touch=await context.newCDPSession(page),p=await markerInfo();
        await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});
        await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:p.x+40,y:p.y+25}]});
        await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        await touch.detach();assert.deepEqual((await stored()).coordinates,original,'Touch panning must not move the stone');
      }
      await page.locator('#gpsMode').click();await page.locator('#manualMode').click();assert(!(await markerInfo()).draggable,'Switching modes must never unlock a point');
      async function openEdit(){
        await page.evaluate(()=>{testMap.closePopup();testMap.setView([59,18],19,{animate:false});});
        await page.waitForFunction(()=>Object.values(testMap._layers).find(l=>l._omapObjectId==='11111111-1111-4111-8111-111111111111')?.getLatLng().lat>59+6/111320);
        const p=await markerInfo();await page.mouse.click(p.x,p.y);
        await page.locator('[data-object-kind="local"][data-object-action="edit"][data-object-id="11111111-1111-4111-8111-111111111111"]').click();
        await page.locator('.geometry-handle').waitFor();
      }
      await openEdit();
      async function moveHandle(){const b=await page.locator('.geometry-handle').boundingBox();await dragAt({x:b.x+b.width/2,y:b.y+b.height/2},40,-35);}
      await moveHandle();assert.deepEqual((await stored()).coordinates,original,'Dragging preview must not save implicitly');
      await page.locator('#cancelEdit').click();assert.deepEqual((await stored()).coordinates,original);assert(!(await markerInfo()).draggable);
      await openEdit();await moveHandle();await page.locator('#finishEdit').click();
      const edited=await stored();assert.notDeepEqual(edited.coordinates,original);assert.deepEqual(edited.originalObject.coordinates,original);assert(!(await markerInfo()).draggable);
      await page.reload();await page.waitForFunction(()=>Object.values(testMap._layers).some(l=>l._omapObjectId==='11111111-1111-4111-8111-111111111111'));
      assert.deepEqual((await stored()).coordinates,edited.coordinates);assert(!(await markerInfo()).draggable);
      // Restore through the actual object action, then verify zoom/rotation stability.
      await page.evaluate(()=>{const m=Object.values(testMap._layers).find(l=>l._omapObjectId==='11111111-1111-4111-8111-111111111111');testMap.setView(m.getLatLng(),19,{animate:false});m.openPopup();});
      await page.locator('[data-object-kind="local"][data-object-action="reset"][data-object-id="11111111-1111-4111-8111-111111111111"]').click();
      assert.deepEqual((await stored()).coordinates,original);
      await page.waitForFunction(()=>Object.values(testMap._layers).find(l=>l._omapObjectId==='11111111-1111-4111-8111-111111111111')?.getLatLng().lat>59+6/111320);
      await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
      const restored=await markerInfo();
      for(const zoom of [18,20,19]){await page.evaluate(zoom=>testMap.setZoom(zoom,{animate:false}),zoom);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));info=await markerInfo();assert(Math.abs(info.lat-restored.lat)<1e-10,JSON.stringify({zoom,info,restored}));assert(Math.abs(info.lng-restored.lng)<1e-10);}
      await page.evaluate(()=>{testMap.setBearing(45);testMap.setView([59,18],19,{animate:false});});
      assert.deepEqual((await stored()).coordinates,original);
      // Raw GeoJSON preserves survey coordinates even though print/screen are displaced.
      await page.locator('#export').click();
      const exportButton=page.locator('#exportSheet button').filter({hasText:/GeoJSON/}).first();
      const downloadEvent=page.waitForEvent('download');await exportButton.click();
      const download=await downloadEvent,downloadPath=await download.path();
      const geojson=JSON.parse(fs.readFileSync(downloadPath,'utf8'));
      assert.deepEqual(geojson.features.find(f=>f.id==='11111111-1111-4111-8111-111111111111').geometry.coordinates,original);
      await page.evaluate(()=>document.querySelector('#exportSheet').close());
      fs.mkdirSync(path.join(root,'.test-artifacts'),{recursive:true});
      await page.screenshot({path:path.join(root,`.test-artifacts/boulder-spacing-${mobile?'mobile':'desktop'}.png`)});
      assert.deepEqual(errors,[]);
      console.log(`Point editing ${mobile?'mobile':'desktop'}: locked pan/mode switch, explicit edit/save/cancel, reload, restore, display spacing, global marker, zoom/rotation and raw export passed.`);
      await context.close();
    }
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
