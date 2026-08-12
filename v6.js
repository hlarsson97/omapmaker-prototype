const $ = s => document.querySelector(s);
const catalog = {
  point: [
    ['boulder','206','Sten'],['boulder_large','204','Stor sten'],['knoll','109','Punkthöjd'],
    ['pit','202','Grop'],['tower','524','Torn'],['well','311','Brunn'],['rootstock','115','Rotvälta']
  ],
  line: [
    ['paved_road','502','Asfalterad väg'],['road','503','Väg'],['gravel_road','504','Grusväg'],
    ['wide_path','505','Bred stig'],['path','506','Stig'],['faint_path','507','Svag stig'],
    ['ditch','307','Dike'],['stream','304','Mindre vattendrag'],['fence','516','Staket'],
    ['wall','513.1','Mur'],['cliff','201','Brant']
  ],
  area: [
    ['building','521','Byggnad'],['dense','408','Tät skog'],['very_dense','410','Mycket tät skog'],
    ['open_land','401','Öppen mark'],['field','402','Öppen mark med spridda träd'],['clearcut','404','Hygge'],
    ['marsh','310','Myr'],['hard_marsh','309','Fast mark i myr'],['lake','301','Sjö'],['forbidden','520','Förbjudet område']
  ]
};
const defaults = {point:'boulder',line:'path',area:'dense'};
const legacy = JSON.parse(localStorage.getItem('omapmaker.live') || '{}');
const saved = JSON.parse(localStorage.getItem('omapmaker.global') || JSON.stringify(legacy));
const state = {observations:saved.observations||[],tracks:saved.tracks||[],areas:saved.areas||[]};
const prefs = {...defaults,...JSON.parse(localStorage.getItem('omapmaker.prefs')||'{}')};
const aliases = {stone:'boulder',large_boulder:'boulder_large',point_height:'knoll',dense_forest:'dense',very_dense_forest:'very_dense',open:'open_land'};
for(const cat of ['point','line','area']){
  prefs[cat]=aliases[prefs[cat]]||prefs[cat];
  if(!catalog[cat].some(x=>x[0]===prefs[cat]))prefs[cat]=defaults[cat];
}
for(const [cat,list] of [['point',state.observations],['line',state.tracks],['area',state.areas]])for(const object of list){
  object.objectType=aliases[object.objectType||object.type]||object.objectType||object.type;
  if(!catalog[cat].some(x=>x[0]===object.objectType))object.objectType=defaults[cat];
  object.observationId=object.observationId||object.id||crypto.randomUUID();object.id=object.id||object.observationId;object.contributorId=object.contributorId||'legacy-local';object.syncStatus=object.syncStatus||'local';object.version=object.version||1;
}
let mode = localStorage.getItem('omapmaker.mode') === 'manual' ? 'manual' : 'gps';
let recording = null, currentCoords = [], tempLayer = null, selected = null, handles = [];
let lastPosition = null, watchId = null, gpsMarker = null, gpsCircle = null;
const layers = new Map();
const deviceId=localStorage.getItem('omapmaker.deviceId')||crypto.randomUUID();localStorage.setItem('omapmaker.deviceId',deviceId);
const workspaceId=new URLSearchParams(location.search).get('workspace');
const workspaces=JSON.parse(localStorage.getItem('omapmaker.workspaces')||'[]');
const workspace=workspaces.find(w=>w.id===workspaceId)||null;
const initialCenter=workspace?.center||JSON.parse(localStorage.getItem('omapmaker.lastCenter')||'{"lat":59.3293,"lng":18.0686}');
const map = L.map('map',{zoomControl:false}).setView([initialCenter.lat,initialCenter.lng],workspace?14:15);
L.control.zoom({position:'bottomright'}).addTo(map);
map.createPane('basemapPane');map.getPane('basemapPane').style.zIndex=200;
map.createPane('contourPane');map.getPane('contourPane').style.zIndex=350;map.getPane('contourPane').style.pointerEvents='none';
map.createPane('fieldPane');map.getPane('fieldPane').style.zIndex=450;
const baseMaps={osm:L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{pane:'basemapPane',maxZoom:20,attribution:'© OpenStreetMap'}),aerial:L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{pane:'basemapPane',maxZoom:19,attribution:'Imagery © Esri'}),terrain:L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',{pane:'basemapPane',maxZoom:17,attribution:'© OpenStreetMap · SRTM | OpenTopoMap'}),orientation:L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{pane:'basemapPane',className:'orientation-base',maxZoom:20,attribution:'© OpenStreetMap'})};
const contourReference=L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',{pane:'contourPane',className:'contour-reference',opacity:.42,maxZoom:17,attribution:'Höjdkurvor © OpenTopoMap · SRTM'});
let activeBase=null;
const layerPrefs={basemap:'osm',objects:true,contours:false,projectContours:true,opacity:100,...JSON.parse(localStorage.getItem('omapmaker.layers')||'{}')};
function saveLayerPrefs(){localStorage.setItem('omapmaker.layers',JSON.stringify(layerPrefs))}
function setBase(id){if(activeBase)map.removeLayer(activeBase);activeBase=baseMaps[id]||null;if(activeBase)activeBase.addTo(map);layerPrefs.basemap=id;saveLayerPrefs()}
setBase(layerPrefs.basemap);
if(workspace){
  $('#mapContext').textContent=`ARBETSYTA · 1:${Number(workspace.scale).toLocaleString('sv-SE')} · ${workspace.contourInterval} M`;
  $('#mapTitle').textContent=workspace.name;
  document.title=`${workspace.name} · OMapMaker`;
  const half=workspace.sizeKm/2,latDelta=half/111.32,lngDelta=half/(111.32*Math.cos(workspace.center.lat*Math.PI/180));
  const bounds=L.latLngBounds([workspace.center.lat-latDelta,workspace.center.lng-lngDelta],[workspace.center.lat+latDelta,workspace.center.lng+lngDelta]);
  L.rectangle(bounds,{pane:'contourPane',className:'workspace-boundary',interactive:false}).addTo(map);map.fitBounds(bounds,{padding:[28,28]});
  workspace.updatedAt=new Date().toISOString();localStorage.setItem('omapmaker.workspaces',JSON.stringify(workspaces));
}
map.on('moveend',()=>{const c=map.getCenter();localStorage.setItem('omapmaker.lastCenter',JSON.stringify({lat:c.lat,lng:c.lng}))});
const contourStorageKey=`omapmaker.contours.${workspace?.id||'global'}`;
let projectContourData=JSON.parse(localStorage.getItem(contourStorageKey)||'null'),projectContourLayer=null;
function renderProjectContours(){if(projectContourLayer)map.removeLayer(projectContourLayer);projectContourLayer=null;if(!projectContourData||!layerPrefs.projectContours)return;projectContourLayer=L.geoJSON(projectContourData,{pane:'contourPane',style:f=>({color:'#9a5b35',weight:f.properties?.indexContour?2.2:1.25,opacity:.9,className:`project-contour ${f.properties?.indexContour?'index':'normal'}`}),onEachFeature:(f,l)=>l.bindTooltip(`${f.properties?.elevation} m`,{sticky:true})}).addTo(map)}
function refreshContourMeta(){const n=projectContourData?.features?.length||0;const interval=workspace?.contourInterval||projectContourData?.properties?.interval||5;$('#contourIntervalText').textContent=`${interval} m`;$('#projectContoursMeta').textContent=n?`${n} linjer · ${interval} m`:'Inte importerade';$('#clearContoursButton').hidden=!n}
renderProjectContours();

function item(cat,id){return catalog[cat].find(x=>x[0]===id)||[id,'',id]}
function name(cat,id){return item(cat,id)[2]}
function save(){localStorage.setItem('omapmaker.global',JSON.stringify(state));localStorage.setItem('omapmaker.live',JSON.stringify(state));localStorage.setItem('omapmaker.prefs',JSON.stringify(prefs));$('#objectCount').textContent=`${state.observations.length+state.tracks.length+state.areas.length} objekt`}
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');setTimeout(()=>$('#toast').classList.remove('show'),1900)}
function pointSvg(id){
  const black='#181b19', brown='#9b5b35', green='#19834a', blue='#168cab';
  if(id==='boulder')return `<svg class="symbol-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2" fill="${black}"/></svg>`;
  if(id==='boulder_large')return `<svg class="symbol-svg" viewBox="0 0 24 24"><path d="M7 18 5 10l5-6 7 3 2 8-5 5z" fill="${black}"/></svg>`;
  if(id==='knoll')return `<svg class="symbol-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="none" stroke="${brown}" stroke-width="2.2"/></svg>`;
  if(id==='pit')return `<svg class="symbol-svg" viewBox="0 0 24 24"><path d="M7 7v7l5 4 5-4V7" fill="none" stroke="${brown}" stroke-width="2.2"/></svg>`;
  if(id==='tower')return `<svg class="symbol-svg" viewBox="0 0 24 24"><path d="m6 18 6-12 6 12M8 14h8" fill="none" stroke="${black}" stroke-width="2"/></svg>`;
  if(id==='well')return `<svg class="symbol-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="none" stroke="${blue}" stroke-width="2.2"/></svg>`;
  return `<svg class="symbol-svg" viewBox="0 0 24 24"><path d="M6 7l12 10M18 7 6 17" stroke="${green}" stroke-width="2.2"/></svg>`;
}
function pointIcon(id){return L.divIcon({className:'omap-symbol',html:pointSvg(id),iconSize:[25,25],iconAnchor:[12,12]})}
function lineStyle(id){if(id==='stream')return{color:'#168cab',weight:4};if(id==='ditch')return{color:'#8d5b36',weight:3,dashArray:'8 5'};if(id==='cliff')return{color:'#181b19',weight:5};if(id==='fence')return{color:'#181b19',weight:3,dashArray:'3 5'};if(id.includes('path'))return{color:'#181b19',weight:id==='wide_path'?5:3,dashArray:id==='faint_path'?'3 7':'9 5'};return{color:'#181b19',weight:id==='paved_road'?7:5,dashArray:id==='gravel_road'?'12 4':null}}
function areaStyle(id){if(id==='building')return{color:'#181b19',fillColor:'#181b19',fillOpacity:.82};if(id==='lake')return{color:'#168cab',fillColor:'#7bcfe1',fillOpacity:.55};if(id.includes('marsh'))return{color:'#168cab',fillColor:'#bce2df',fillOpacity:.5,dashArray:'5 4'};if(id==='field'||id==='open_land')return{color:'#d2a82f',fillColor:'#ffe270',fillOpacity:.55};if(id==='forbidden')return{color:'#9b3d83',fillColor:'#d995ca',fillOpacity:.45};return{color:'#1d874e',fillColor:id==='very_dense'?'#228847':'#60aa63',fillOpacity:.52}}
function latlngs(coords){return coords.map(c=>[c[1],c[0]])}
function clearSelection(){handles.forEach(h=>map.removeLayer(h));handles=[];selected=null;$('#editBar').classList.add('hidden')}
function selectFeature(cat,obj,layer){if(mode!=='manual'||recording)return;clearSelection();selected={cat,obj,layer};if(cat!=='point')obj.coordinates.forEach((c,i)=>{const h=L.marker([c[1],c[0]],{icon:L.divIcon({className:'',html:'<span style="display:block;width:18px;height:18px;border-radius:50%;background:#286fc0;border:3px solid white"></span>',iconSize:[18,18],iconAnchor:[9,9]}),draggable:true}).addTo(map);h.on('drag',e=>{const p=e.target.getLatLng();obj.coordinates[i]=[p.lng,p.lat,...obj.coordinates[i].slice(2)];layer.setLatLngs(latlngs(obj.coordinates))});h.on('dragend',save);handles.push(h)});$('#undoVertex').classList.add('hidden');$('#cancelEdit').classList.add('hidden');$('#finishEdit').classList.remove('hidden');$('#finishEdit').textContent='Klar';$('#deleteFeature').classList.remove('hidden');$('#editBar').classList.remove('hidden')}
function applyFieldPresentation(layer){const el=layer.getElement?.();if(el){el.classList.toggle('foreground-hidden',!layerPrefs.objects);el.style.opacity=String(layerPrefs.opacity/100)}}
function renderPoint(o){const m=L.marker([o.coordinates[1],o.coordinates[0]],{pane:'fieldPane',icon:pointIcon(o.objectType||o.type),draggable:mode==='manual'}).addTo(map);m.on('add',()=>applyFieldPresentation(m));m.on('dragend',e=>{const p=e.target.getLatLng();o.coordinates=[p.lng,p.lat];o.source='manual-adjustment';save()});m.on('click',()=>selectFeature('point',o,m));layers.set(o.id,m);applyFieldPresentation(m)}
function renderLine(o){const l=L.polyline(latlngs(o.coordinates),{pane:'fieldPane',...lineStyle(o.objectType||o.type)}).addTo(map);l.on('add',()=>applyFieldPresentation(l));l.on('click',()=>selectFeature('line',o,l));layers.set(o.id,l);applyFieldPresentation(l)}
function renderArea(o){const p=L.polygon(latlngs(o.coordinates),{pane:'fieldPane',...areaStyle(o.objectType||o.type)}).addTo(map);p.on('add',()=>applyFieldPresentation(p));p.on('click',()=>selectFeature('area',o,p));layers.set(o.id,p);applyFieldPresentation(p)}
state.observations.forEach(renderPoint);state.tracks.forEach(renderLine);state.areas.forEach(renderArea);

function labels(){
  $('#pointLabel').textContent=name('point',prefs.point);
  for(const cat of ['line','area']){
    const button=$(`#${cat}Action`), active=recording?.cat===cat, noun=name(cat,active?recording.type:prefs[cat]);
    button.classList.toggle('recording',active);
    button.querySelector('span').textContent=active?(recording.mode==='gps'?'MÄTER':'RITAR'):(mode==='gps'?'SPELA IN':'RITA');
    button.querySelector('b').textContent=active?`■ ${noun}`:noun;
  }
}
function setMode(next){
  if(recording?.mode==='gps'&&next!=='gps')return toast('Avsluta eller avbryt GPS-inspelningen först');
  if(recording){cancelDrawing(false)}
  clearSelection();mode=next;localStorage.setItem('omapmaker.mode',mode);
  document.body.className=mode==='manual'?'manual-mode':'gps-mode';
  $('#gpsMode').classList.toggle('active',mode==='gps');$('#manualMode').classList.toggle('active',mode==='manual');
  $('#modeHint').textContent=mode==='gps'?'GPS-LÄGE · Mät med telefonens position':'MANUELLT LÄGE · Rita och redigera på kartan';
  state.observations.forEach(o=>{const m=layers.get(o.id);mode==='manual'?m.dragging.enable():m.dragging.disable()});labels();
}
$('#gpsMode').onclick=()=>setMode('gps');$('#manualMode').onclick=()=>setMode('manual');

function identity(){const id=crypto.randomUUID();return{id,observationId:id,contributorId:deviceId,syncStatus:'local',version:1}}
function addPoint(ll,accuracy,source){if(source==='gps'&&accuracy>50)return toast(`GPS ±${Math.round(accuracy)} m · för osäkert`);const o={...identity(),objectType:prefs.point,symbol:item('point',prefs.point)[1],coordinates:[ll.lng,ll.lat],accuracy,source,quality:'unverified',createdAt:new Date().toISOString()};state.observations.push(o);renderPoint(o);save();toast(`${name('point',prefs.point)} sparad`)}
function showDrawingBar(){clearSelection();$('#undoVertex').classList.remove('hidden');$('#cancelEdit').classList.remove('hidden');$('#finishEdit').classList.remove('hidden');$('#finishEdit').textContent='Slutför';$('#deleteFeature').classList.add('hidden');$('#editBar').classList.remove('hidden')}
function updateTemp(){if(tempLayer)map.removeLayer(tempLayer);if(!currentCoords.length)return;tempLayer=recording.cat==='area'?L.polygon(latlngs(currentCoords),{...areaStyle(recording.type),className:'temp-shape'}).addTo(map):L.polyline(latlngs(currentCoords),{...lineStyle(recording.type),className:'temp-shape'}).addTo(map)}
function beginShape(cat){recording={mode,cat,type:prefs[cat]};currentCoords=[];showDrawingBar();labels();toast(mode==='gps'?`${name(cat,prefs[cat])} spelas in`:`Tryck ut ${cat==='line'?'linjen':'områdets hörn'}`)}
function finishDrawing(){if(!recording)return;const min=recording.cat==='area'?3:2;if(currentCoords.length<min)return toast(`Minst ${min} punkter behövs`);const obj={...identity(),objectType:recording.type,symbol:item(recording.cat,recording.type)[1],coordinates:[...currentCoords],source:recording.mode,quality:'unverified',createdAt:new Date().toISOString()};if(recording.cat==='line'){state.tracks.push(obj);renderLine(obj)}else{state.areas.push(obj);renderArea(obj)}cancelDrawing(false);save();toast('Objekt sparat')}
function cancelDrawing(message=true){if(tempLayer)map.removeLayer(tempLayer);tempLayer=null;recording=null;currentCoords=[];$('#editBar').classList.add('hidden');labels();if(message)toast('Ritningen avbröts')}
function action(cat){
  if(cat==='point'){if(mode==='manual'){recording={mode:'manual',cat:'point',type:prefs.point};toast(`${name('point',prefs.point)} vald · tryck på kartan`)}else if(lastPosition)addPoint(lastPosition.latlng,lastPosition.accuracy,'gps');else toast('GPS söker position · försök igen strax');return}
  if(recording?.cat===cat)return finishDrawing();
  if(recording)return toast('Slutför eller avbryt pågående objekt först');
  if(mode==='gps'&&!lastPosition)return toast('GPS söker position · försök igen strax');
  if(mode==='gps'&&lastPosition.accuracy>50)return toast('GPS-kvaliteten är för låg');
  beginShape(cat);
}
$('#pointAction').onclick=()=>action('point');$('#lineAction').onclick=()=>action('line');$('#areaAction').onclick=()=>action('area');
map.on('click',e=>{if(mode!=='manual')return;if(recording?.cat==='point'){addPoint(e.latlng,0,'manual');recording=null}else if(recording?.mode==='manual'){currentCoords.push([e.latlng.lng,e.latlng.lat,0,Date.now(),null,null]);updateTemp()}});
$('#undoVertex').onclick=()=>{currentCoords.pop();updateTemp()};$('#cancelEdit').onclick=()=>cancelDrawing();$('#finishEdit').onclick=()=>selected?clearSelection():finishDrawing();
$('#deleteFeature').onclick=()=>{if(!selected||!confirm('Radera detta objekt?'))return;const {cat,obj,layer}=selected;map.removeLayer(layer);const list=cat==='point'?state.observations:cat==='line'?state.tracks:state.areas;list.splice(list.indexOf(obj),1);layers.delete(obj.id);clearSelection();save();toast('Objekt raderat')};

function openSheet(cat){if(recording)return toast('Slutför eller avbryt pågående objekt först');$('#sheetCategory').textContent=cat==='point'?'PLACERA':cat==='line'?'LINJE':'OMRÅDE';$('#sheetTitle').textContent=`Välj ${cat==='point'?'punktobjekt':cat==='line'?'linjeobjekt':'områdestyp'}`;$('#sheetOptions').innerHTML='';catalog[cat].forEach(d=>{const b=document.createElement('button');b.type='button';b.className=d[0]===prefs[cat]?'selected':'';b.innerHTML=`<span class="symbol">${cat==='point'?pointSvg(d[0]):d[1]}</span><span>${d[2]}<small style="display:block;color:#748078">ISOM ${d[1]}</small></span>`;b.onclick=()=>{prefs[cat]=d[0];save();labels();$('#objectSheet').close();toast(`${d[2]} vald`)};$('#sheetOptions').append(b)});$('#objectSheet').showModal()}
document.querySelectorAll('.tool-menu').forEach(b=>b.onclick=()=>openSheet(b.dataset.category));

function quality(a){return a<=3?['excellent',`★ GPS ± ${Math.round(a)} m · Utmärkt`]:a<=10?['good',`GPS ± ${Math.round(a)} m · Bra`]:a<=50?['warn',`GPS ± ${Math.round(a)} m · Osäkert`]:['bad',`GPS ± ${Math.round(a)} m · Otillräckligt`]}
function startGps(){if(watchId!==null||!navigator.geolocation)return;$('#gpsQuality span').textContent='GPS söker position…';watchId=navigator.geolocation.watchPosition(p=>{const ll=L.latLng(p.coords.latitude,p.coords.longitude);lastPosition={latlng:ll,accuracy:p.coords.accuracy};if(!gpsMarker){gpsMarker=L.circleMarker(ll,{radius:7,color:'#fff',weight:3,fillColor:'#2677c7',fillOpacity:1}).addTo(map);gpsCircle=L.circle(ll,{radius:p.coords.accuracy,className:'accuracy'}).addTo(map);map.setView(ll,18)}else{gpsMarker.setLatLng(ll);gpsCircle.setLatLng(ll).setRadius(p.coords.accuracy)}const [cls,label]=quality(p.coords.accuracy);$('#gpsQuality').className=cls;$('#gpsQuality span').textContent=label;if(recording?.mode==='gps'&&p.coords.accuracy<=50){currentCoords.push([p.coords.longitude,p.coords.latitude,p.coords.accuracy,Date.now(),p.coords.altitude,p.coords.altitudeAccuracy]);updateTemp()}},e=>{$('#gpsQuality').className='bad';$('#gpsQuality span').textContent=e.code===1?'GPS saknar tillstånd':'GPS kunde inte hämtas'},{enableHighAccuracy:true,maximumAge:0,timeout:15000})}
startGps();
function refreshFieldPresentation(){layers.forEach(applyFieldPresentation)}
$('#layersButton').onclick=()=>$('#layersSheet').showModal();
document.querySelectorAll('input[name=basemap]').forEach(input=>{input.checked=input.value===layerPrefs.basemap;input.onchange=()=>setBase(input.value)});
$('#objectsVisible').checked=layerPrefs.objects;$('#objectsVisible').onchange=e=>{layerPrefs.objects=e.target.checked;saveLayerPrefs();refreshFieldPresentation()};
$('#contoursVisible').checked=layerPrefs.contours;if(layerPrefs.contours)contourReference.addTo(map);$('#contoursVisible').onchange=e=>{layerPrefs.contours=e.target.checked;e.target.checked?contourReference.addTo(map):map.removeLayer(contourReference);saveLayerPrefs()};
$('#projectContoursVisible').checked=layerPrefs.projectContours;$('#projectContoursVisible').onchange=e=>{layerPrefs.projectContours=e.target.checked;saveLayerPrefs();renderProjectContours()};
$('#importContoursButton').onclick=()=>$('#contourFile').click();$('#contourFile').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{const data=JSON.parse(await file.text());if(data.type!=='FeatureCollection'||!data.features?.every(f=>f.geometry?.type==='LineString'))throw new Error();const expected=Number(workspace?.contourInterval||data.properties?.interval||5),actual=Number(data.properties?.interval||data.features[0]?.properties?.interval||expected);if(actual!==expected&&!confirm(`Filen har ${actual} m ekvidistans men arbetsområdet använder ${expected} m. Importera ändå?`))return;projectContourData=data;localStorage.setItem(contourStorageKey,JSON.stringify(data));layerPrefs.projectContours=true;$('#projectContoursVisible').checked=true;saveLayerPrefs();renderProjectContours();refreshContourMeta();map.fitBounds(projectContourLayer.getBounds(),{padding:[25,25]});toast(`${data.features.length} höjdkurvor importerade`)}catch{toast('Filen innehåller inte giltiga höjdkurvor')}finally{e.target.value=''}};
$('#clearContoursButton').onclick=()=>{if(!confirm('Ta bort kartans importerade höjdkurvor?'))return;localStorage.removeItem(contourStorageKey);projectContourData=null;renderProjectContours();refreshContourMeta();toast('Höjdkurvor borttagna')};refreshContourMeta();
$('#foregroundOpacity').value=layerPrefs.opacity;$('#foregroundOpacityValue').textContent=`${layerPrefs.opacity} %`;$('#foregroundOpacity').oninput=e=>{layerPrefs.opacity=Number(e.target.value);$('#foregroundOpacityValue').textContent=`${layerPrefs.opacity} %`;saveLayerPrefs();refreshFieldPresentation()};
$('#export').onclick=()=>{const features=[...state.observations.map(o=>({type:'Feature',id:o.id,properties:{...o,coordinates:undefined},geometry:{type:'Point',coordinates:o.coordinates}})),...state.tracks.map(o=>({type:'Feature',id:o.id,properties:{objectType:o.objectType,symbol:o.symbol,category:'line',source:o.source,quality:o.quality,createdAt:o.createdAt,samples:o.coordinates.map(c=>({accuracy:c[2],time:c[3],altitude:c[4],altitudeAccuracy:c[5]}))},geometry:{type:'LineString',coordinates:o.coordinates.map(c=>c[4]==null?c.slice(0,2):[c[0],c[1],c[4]])}})),...state.areas.map(o=>({type:'Feature',id:o.id,properties:{objectType:o.objectType,symbol:o.symbol,category:'area',source:o.source,quality:o.quality,createdAt:o.createdAt},geometry:{type:'Polygon',coordinates:[[...o.coordinates.map(c=>c.slice(0,2)),o.coordinates[0].slice(0,2)]]}}))];const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({type:'FeatureCollection',properties:{app:'OMapMaker',version:6,standard:'ISOM 2017-2 v6'},features},null,2)],{type:'application/geo+json'}));a.download='omapmaker-field-v6.geojson';a.click()};
setMode(mode);labels();save();
