// Disposable browser storage and mocked GPS; never touches server or user data.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),assets=path.resolve(process.argv[2]||'../performance-work');
const latitude=59.3293,longitude=18.0686,mx=111320*Math.cos(latitude*Math.PI/180),coordinate=(x,y)=>[longitude+x/mx,latitude+y/111320];

(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:390,height:700},hasTouch:true,serviceWorkers:'block'}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname.includes('/api/'))return route.fulfill({json:url.pathname.includes('session')?{authenticated:false}:{found:false,type:'FeatureCollection',features:[]}});
      let file;if(url.hostname==='unpkg.com')file=path.join(assets,url.pathname.includes('leaflet-rotate')?'rotate.js':url.pathname.endsWith('.css')?'leaflet.css':'leaflet.js');else if(url.hostname==='omap.test')file=path.join(root,url.pathname.slice(1));else return route.fulfill({status:204,body:''});
      if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
      return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/javascript'});
    });
    await page.addInitScript(()=>{
      localStorage.setItem('omapmaker.layers',JSON.stringify({basemap:'orientation'}));localStorage.setItem('omapmaker.prefs',JSON.stringify({line:'path'}));localStorage.setItem('omapmaker.toolbarCollapsed.v2','false');
      navigator.geolocation.watchPosition=callback=>{window.sendFix=callback;return 1};navigator.geolocation.clearWatch=()=>{};
    });
    await page.goto('https://omap.test/field.html');
    const send=async(x,y,index)=>{const [longitude,latitude]=coordinate(x,y);await page.evaluate(({longitude,latitude,index})=>window.sendFix({timestamp:1000+index*1000,coords:{longitude,latitude,accuracy:5,altitude:0,altitudeAccuracy:2,heading:90,speed:1.2}}),{longitude,latitude,index})};
    await send(0,0,0);await page.locator('#lineAction').click();
    const offsets=[0,4,-4,4,-4,4,-4,4,0];for(let index=0;index<offsets.length;index++)await send(index*3,offsets[index],index+1);
    const preview=page.locator('path.gps-recording-line');await preview.waitFor({state:'attached'});
    const previewStyle=await preview.evaluate(element=>({fill:getComputedStyle(element).fill,strokeWidth:parseFloat(getComputedStyle(element).strokeWidth),className:element.getAttribute('class')}));
    assert.equal(previewStyle.fill,'none','An open GPS line must not create a filled start-to-end shadow');assert(previewStyle.strokeWidth>=6,JSON.stringify(previewStyle));
    fs.mkdirSync(path.join(root,'.test-artifacts'),{recursive:true});await page.screenshot({path:path.join(root,'.test-artifacts/gps-line-recording-mobile.png')});
    await page.locator('#finishEdit').click();
    const track=await page.evaluate(()=>JSON.parse(localStorage.getItem('omapmaker.global')).tracks[0]);
    assert.equal(track.symbol,'506');assert.equal(track.gpsSmoothing,'accuracy-aware-v1');assert.equal(track.rawCoordinates.length,offsets.length);assert(track.coordinates.length<track.rawCoordinates.length);
    const deviation=coordinates=>Math.max(...coordinates.slice(1,-1).map(item=>Math.abs((item[1]-latitude)*111320)));
    assert(deviation(track.coordinates)<deviation(track.rawCoordinates),'Saved trail should be less zigzagged than its raw GPS trace');
    assert.deepEqual(track.coordinates[0].slice(0,2),track.rawCoordinates[0].slice(0,2));assert.deepEqual(track.coordinates.at(-1).slice(0,2),track.rawCoordinates.at(-1).slice(0,2));
    assert.deepEqual(errors,[]);console.log('GPS line recording: proportional blue preview, no fill shadow, smoothed trail and preserved raw coordinates passed.');
    await context.close();
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
