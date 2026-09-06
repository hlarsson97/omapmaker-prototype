const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const assets = path.resolve(process.argv[2] || '.');
const baseline = process.argv[3];
const sizeKm = Number(process.env.MAP_SIZE_KM || 10);
const displayMode = process.env.SYMBOL_DISPLAY_MODE || 'print';
const count = value => Math.round(value * (sizeKm / 10) ** 2);
const columns = Math.round(100 * sizeKm / 10);
const root = path.resolve(__dirname, '..');
const feature = (id, geometry, properties) => ({type:'Feature', id, geometry, properties});
const collection = features => ({type:'FeatureCollection', properties:{importVersion:16}, features});
const datasets = {};
const coords = i => [18 + (i % columns) * .0017, 59 + Math.floor(i / columns) * .00085];
datasets.contours = collection(Array.from({length:count(5000)},(_,i)=> {
  const [x,y]=coords(i);
  return feature(`c${i}`,{type:'LineString',coordinates:Array.from({length:80},(_,j)=>[x+j*.000025,y+Math.sin(j*.2)*.0002])},{indexContour:i%5===0,elevation:i});
}));
for (const [type,symbol,total] of [['buildings','521',3000],['paved-areas','501',500],['land-cover','308',1200]]) {
  datasets[type]=collection(Array.from({length:count(total)},(_,i)=>{const [x,y]=coords(i);return feature(`${type}${i}`,{type:'Polygon',coordinates:[[[x,y],[x+.0005,y],[x+.0005,y+.0004],[x,y+.0004],[x,y]]]},{isomSymbol:symbol,mapClass:type==='land-cover'?'marsh_308':'',areaSquareMetres:500});}));
}
datasets.roads=collection(Array.from({length:count(2000)},(_,i)=>{const [x,y]=coords(i);return feature(`r${i}`,{type:'LineString',coordinates:[[x,y],[x+.001,y+.0005]]},{isomSymbol:i%3?'506':'502',widthMetres:6});}));
datasets.infrastructure=collection(Array.from({length:count(300)},(_,i)=>{const [x,y]=coords(i);return feature(`i${i}`,{type:'LineString',coordinates:[[x,y],[x+.001,y+.0005]]},{isomSymbol:i%3?'509':'511',featureKind:'line',railway:i%3?'rail':undefined,power:i%3?undefined:'line'});}));

datasets['land-cover'].features.push(feature('water-test',{type:'Point',coordinates:coords(900)},{isomSymbol:'311'}));
datasets.infrastructure.features.push(feature('support-test',{type:'Point',coordinates:coords(901)},{isomSymbol:'511',featureKind:'support',largeMast:true,power:'tower'}));
datasets.infrastructure.features.push(feature('bridge-test',{type:'LineString',coordinates:[coords(902),coords(903)]},{isomSymbol:'512',featureKind:'line',generationMethod:'osm-tag'}));

(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL ? {channel:process.env.BROWSER_CHANNEL} : {})});
 const results=[];
 for(const variant of (baseline ? ['before','after'] : ['after'])) {
  const context=await browser.newContext({viewport:{width:Number(process.env.VIEWPORT_WIDTH||1280),height:Number(process.env.VIEWPORT_HEIGHT||900)}});
  const page=await context.newPage(); const errors=[];
  page.on('pageerror',e=>{errors.push(e.message);console.log(variant,'ERROR',e.stack)});
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url()); let content, type='application/javascript';
   if(url.pathname.includes('/api/')) {
    let data={type:"FeatureCollection",features:[]};
    if(url.pathname.endsWith('/resolve')) {const key=route.request().postDataJSON().layerType;data=datasets[key]?{found:true,layer:datasets[key]}:{found:false};}
    else if(url.pathname.includes('session')) data={authenticated:false};
    return route.fulfill({json:data});
   }
   if(url.hostname==='unpkg.com') {
    const file=url.pathname.includes('leaflet-rotate')?'rotate.js':url.pathname.endsWith('.css')?'leaflet.css':'leaflet.js';
    content=fs.readFileSync(path.join(assets,file),'utf8');
    if(file==='leaflet.js')content+='\nconst makeMap=L.map;L.map=(...args)=>(window.testMap=makeMap(...args));';
    if(file.endsWith('.css'))type='text/css';
   } else if(url.hostname==='omap.test') {
    const file=url.pathname.slice(1)||'field.html';
    try {content=variant==='before'?cp.execFileSync('git',['-c',`safe.directory=${root.replaceAll('\\','/')}`,'show',`${baseline}:${file}`],{cwd:root,maxBuffer:10e6}):fs.readFileSync(path.join(root,file));}catch {return route.fulfill({status:404,body:''});}
    if(file.endsWith('.html'))type='text/html';else if(file.endsWith('.css'))type='text/css';
   } else return route.fulfill({status:204,body:''});
   return route.fulfill({body:content,contentType:type});
  });
  await page.addInitScript(({sizeKm,displayMode})=>{
   localStorage.setItem('omapmaker.workspaces',JSON.stringify([{id:'benchmark',name:`Prestandatest ${sizeKm} x ${sizeKm} km`,sizeKm,center:{lat:59.022,lng:18.085},scale:10000,contourInterval:5,magneticDeclination:7,symbolDisplayMode:displayMode}]));
   localStorage.setItem('omapmaker.layers',JSON.stringify({basemap:'orientation'}));
  },{sizeKm,displayMode});
  await page.goto('https://omap.test/field.html?workspace=benchmark');
  await page.waitForFunction(expected=>document.querySelectorAll('.osm-building').length===expected,count(3000),{timeout:60000});
  await page.waitForTimeout(1000);
  const result=await page.evaluate(async()=>{
   const settle=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   const zoom=[],pan=[],zoomScript=[],panScript=[],patterns=[],created=[];
   let additions=0;testMap.on('layeradd',()=>additions++);
   const roadBefore=Object.values(testMap._layers).find(l=>l.feature?.id==='r0'&&l.getPopup?.());
   const geometryBefore=roadBefore.getLatLngs();
   const count=()=>({paths:document.querySelectorAll('#map path').length,patterns:document.querySelectorAll('#map pattern').length,layers:Object.keys(testMap._layers).length});
   const signature=()=>Object.values(testMap._layers).filter(l=>['r0','r1','i0','i1','water-test','support-test','bridge-test'].includes(l.feature?.id)).map(l=>({id:l.feature.id,weight:l.options.weight,color:l.options.color,size:l.options.icon?.options.iconSize})).sort((a,b)=>`${a.id}:${a.color}`.localeCompare(`${b.id}:${b.color}`));
   const signatures=[];let retainedAcrossZoom=true;
   const start=count();
   for(let i=0;i<8;i++){
    const previous=new Map(Object.values(testMap._layers).filter(g=>g._viewportData).map(g=>[g,new Map(g.getLayers().map(l=>[l.feature,l]))]));
    additions=0;let t=performance.now();testMap.setZoom(i%2?13:14,{animate:false});zoomScript.push(performance.now()-t);await settle();zoom.push(performance.now()-t);created.push(additions);patterns.push(count().patterns);signatures.push(signature());
    for(const [g,children] of previous)for(const l of g.getLayers())if(children.has(l.feature)&&children.get(l.feature)!==l)retainedAcrossZoom=false;
    await new Promise(resolve=>setTimeout(resolve,300));
    t=performance.now();testMap.panBy([i%2?-100:100,30],{animate:false});panScript.push(performance.now()-t);await settle();pan.push(performance.now()-t);
    await new Promise(resolve=>setTimeout(resolve,300));
   }
   testMap.setBearing(35);await settle();
   const rotation={bearing:testMap.getBearing(),visibleContours:[...document.querySelectorAll('.project-contour')].some(p=>p.getAttribute('d').length>10)};
   const road=Object.values(testMap._layers).find(l=>l.feature?.id==='r0'&&l.getPopup?.());
   road.openPopup();await settle();
   return {retainedAcrossZoom,retainedRoad:road===roadBefore,retainedGeometry:road.getLatLngs()===geometryBefore,start,end:count(),signatures,zoom,pan,zoomScript,panScript,created,patterns,rotation,popup:document.querySelector('.leaflet-popup-content')?.textContent};
  });
  const focused = await page.evaluate(async()=>{
   const settle=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   const map=testMap, zoom=[], pan=[];
   map.closePopup();map.setBearing(0);map.setView([59.008,18.07],17,{animate:false});await settle();
   const startLayers=Object.keys(map._layers).length;
   for(let i=0;i<8;i++){
    let t=performance.now();map.setZoom(i%2?17:16,{animate:false});await settle();zoom.push(performance.now()-t);
    await new Promise(r=>setTimeout(r,300));
    t=performance.now();map.panBy([i%2?-100:100,0],{animate:false});await settle();pan.push(performance.now()-t);
    await new Promise(r=>setTimeout(r,300));
   }
   return {startLayers,zoom,pan};
  });
  await page.screenshot({path:path.join(assets,`${variant}-${sizeKm}-${displayMode}-focused.png`)});
  if(variant==='after') assert(focused.startLayers<result.start.layers/2,'Detailed view should render fewer than half the overview layers');
  const viewportChecks = variant==='after' ? await page.evaluate(async({sizeKm})=>{
   const {geometryBounds,intersects}=await import('/js/viewport_layers.mjs?v=1');
   const map=testMap, settle=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   const groups=()=>Object.values(map._layers).filter(layer=>layer._viewportData);
   const original=groups().map(group=>JSON.stringify(group._viewportData));
   const missing=[],badPatterns=[],counts=[],east=18+.14*sizeKm/10;
   for(const [lat,lng,bearing] of [[59.008,18.01,0],[59.008,east,35],[59+.033*sizeKm/10,east,90],[59.008,18.01,180],[59.008,east,0]]){
    map.setView([lat,lng],17,{animate:false});map.setBearing(bearing);await settle();
    const size=map.getSize(),corners=[[0,0],[size.x,0],[size.x,size.y],[0,size.y]].map(p=>map.containerPointToLatLng(p));
    const box=[Math.min(...corners.map(p=>p.lng)),Math.min(...corners.map(p=>p.lat)),Math.max(...corners.map(p=>p.lng)),Math.max(...corners.map(p=>p.lat))];
    for(const group of groups()){
     const present=new Set(group.getLayers().map(layer=>layer.feature));
     for(const feature of group._viewportData.features||[]){
      const bounds=geometryBounds(feature.geometry);
      if(bounds&&intersects(bounds,box)&&(!group.options.filter||group.options.filter(feature))&&!present.has(feature)) missing.push(feature.id||'contour');
     }
    }
    for(const p of document.querySelectorAll('.isom-pattern-308')){
     const match=p.style.fill.match(/#([^)"]+)/);
     if(!match||!document.getElementById(match[1]))badPatterns.push(p.style.fill);
    }
    counts.push(Object.keys(map._layers).length);
   }
   const sameData=groups().every((group,i)=>JSON.stringify(group._viewportData)===original[i]);
   const group=groups().find(g=>g.options.pane==='buildingPane'),child=group.getLayers()[0];
   const retainedBefore=new Map(groups().map(g=>[g,new Map(g.getLayers().map(l=>[l.feature,l]))]));
   map.panBy([10,0],{animate:false});await settle();
   const retained=groups().every(g=>g.getLayers().every(l=>!retainedBefore.get(g).has(l.feature)||retainedBefore.get(g).get(l.feature)===l));
   child.openPopup();await settle();
   map.setView([60,19],17,{animate:false});await settle();
   const pinned=map.hasLayer(child)&&child.isPopupOpen();
   map.closePopup();map.setZoom(16,{animate:false});await settle();
   const unpinned=!map.hasLayer(child);
   map.setView([59.008,east],17,{animate:false});map.setBearing(35);await settle();
   // Exercise the real export path; it must still use the complete source data.
   const renderer=window.OMAPMAKER_ISOM_RENDERER,preflight=renderer.preflight,exportCounts=[];
   renderer.preflight=(features,...args)=>{exportCounts.push(features.length);return preflight(features,...args)};
   document.getElementById('export').click();document.getElementById('exportSheet').close();
   map.setView([59.022,18.085],13,{animate:false});await settle();
   document.getElementById('export').click();document.getElementById('exportSheet').close();
   renderer.preflight=preflight;
   return {missing,badPatterns,sameData,retained,pinned,unpinned,counts,exportCounts};
  },{sizeKm}) : null;
  if(viewportChecks){
   assert.deepEqual(viewportChecks.missing,[],'Objects intersecting every rotated viewport must be present');
   assert.deepEqual(viewportChecks.badPatterns,[],'Entering marsh polygons must have valid fill patterns');
   for(const key of ['sameData','retained','pinned','unpinned'])assert.equal(viewportChecks[key],true,key);
   assert.equal(viewportChecks.exportCounts.length,2);assert.equal(viewportChecks.exportCounts[0],viewportChecks.exportCounts[1]);
  }
  const toggles = await page.evaluate(async()=>{
   const settle=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   const counts=[];
   for(const [id,selector] of [['projectContoursVisible','.project-contour'],['osmBuildingsVisible','.osm-building'],['osmLandCoverVisible','.osm-land-cover']]){
    const checkbox=document.getElementById(id),before=document.querySelectorAll(selector).length;
    checkbox.checked=false;checkbox.dispatchEvent(new Event('change'));await settle();
    const hidden=document.querySelectorAll(selector).length;
    checkbox.checked=true;checkbox.dispatchEvent(new Event('change'));await settle();
    counts.push({before,hidden,after:document.querySelectorAll(selector).length});
   }
   return counts;
  });
  for(const toggle of toggles){assert.equal(toggle.hidden,0);assert.equal(toggle.after,toggle.before);}
  await page.waitForTimeout(400);
  await page.screenshot({path:path.join(assets,`${variant}-${sizeKm}-${displayMode}.png`)});
  assert.deepEqual(errors,[]);
  assert.equal(result.rotation.visibleContours,true);
  assert.match(result.popup,/Bred väg/);
  if(variant==='after'){
   assert.equal(result.retainedAcrossZoom,true,'Zoom must retain the objects common to both viewports');
   assert(result.created.every(count=>count<result.start.layers*.8),'Zoom must retain layers that remain in the buffered view');
   assert(result.patterns.every(count=>count===result.start.patterns),'Pattern definitions must remain bounded');
  }
  results.push({variant,sizeKm,displayMode,...result,focused,viewportChecks,errors});console.log(JSON.stringify({...results.at(-1),signatures:undefined,popup:Boolean(result.popup)}));
  await context.close();
 }
 fs.writeFileSync(path.join(assets,`results-${sizeKm}-${displayMode}.json`),JSON.stringify(results,null,2));
 if(baseline) results[1].signatures.forEach((items,i)=>items.forEach(item=>assert.deepEqual(item,results[0].signatures[i].find(original=>original.id===item.id&&original.color===item.color),'Visible symbol sizes/styles must match the original at every zoom')));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
