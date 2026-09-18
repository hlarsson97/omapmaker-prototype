// Usage: NODE_PATH=<runtime node_modules> node tools/test_field_panel.cjs <Leaflet asset directory>
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const assets = path.resolve(process.argv[2] || '../performance-work');

(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    for (const [width,height] of [[390,664],[320,568],[844,390],[1280,900]]) {
      const context = await browser.newContext({viewport:{width,height},hasTouch:true,serviceWorkers:'block'});
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname.includes('/api/')) return route.fulfill({json:url.pathname.includes('session') ? {authenticated:false} : {found:false,type:'FeatureCollection',features:[]}});
        let file;
        if (url.hostname === 'unpkg.com') file = path.join(assets,url.pathname.includes('leaflet-rotate')?'rotate.js':url.pathname.endsWith('.css')?'leaflet.css':'leaflet.js');
        else if (url.hostname === 'omap.test') file = path.join(root,url.pathname.slice(1));
        else return route.fulfill({status:204,body:''});
        if (!fs.existsSync(file)) return route.fulfill({status:404,body:''});
        return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/javascript'});
      });
      await page.addInitScript(() => {
        localStorage.setItem('omapmaker.layers',JSON.stringify({basemap:'orientation'}));
        localStorage.setItem('omapmaker.toolbarCollapsed.v2','false');
        navigator.geolocation.watchPosition = callback => { window.sendFix = callback; return 1; };
        navigator.geolocation.clearWatch = () => {};
      });
      await page.goto('https://omap.test/field.html');
      await page.locator('#fieldSurveyToggle').click();
      await page.locator('#startFieldSurvey').click();
      await page.locator('#fieldSurveyPanel').waitFor();
      const fix = () => page.evaluate(() => window.sendFix({timestamp:Date.now(),coords:{latitude:59.2,longitude:18.1,accuracy:5,altitude:0,heading:0,speed:1}}));
      await fix();
      assert.match(await page.locator('#fieldSurveyElapsed').textContent(),/1 GPS-punkter/);
      async function checkLayout() {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const boxes = await page.evaluate(() => ['#fieldSurveyPanel','#mapNavControls','#layersButton','#modeSwitch'].map(selector => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return {selector,x:r.x,y:r.y,right:r.right,bottom:r.bottom};
        }));
        for (const a of boxes) {
          assert(a.x >= 0 && a.y >= 0 && a.right <= width && a.bottom <= height,JSON.stringify(a));
          for (const b of boxes) if (a !== b) assert(!(a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y),`${a.selector} overlaps ${b.selector} at ${width}x${height}`);
        }
      }
      await checkLayout();
      await page.screenshot({path:path.join(root,`.test-artifacts/field-expanded-${width}.png`)});
      const expanded = (await page.locator('#fieldSurveyPanel').boundingBox()).height;
      // Real pointer movement exercises pointer capture and click suppression.
      async function swipe(delta) {
        const r = await page.locator('#fieldSurveyHandle').boundingBox();
        await page.mouse.move(r.x+r.width/2,r.y+r.height/2);
        await page.mouse.down();await page.mouse.move(r.x+r.width/2,r.y+r.height/2+delta,{steps:8});await page.mouse.up();
      }
      await swipe(65);
      assert.equal(await page.locator('#fieldSurveyHandle').getAttribute('aria-expanded'),'false');
      assert((await page.locator('#fieldSurveyPanel').boundingBox()).height < expanded);
      await fix();assert.match(await page.locator('#fieldSurveyElapsed').textContent(),/2 GPS-punkter/);
      await checkLayout();
      fs.mkdirSync(path.join(root,'.test-artifacts'),{recursive:true});
      await page.screenshot({path:path.join(root,`.test-artifacts/field-collapsed-${width}.png`)});
      await swipe(-65);
      assert.equal(await page.locator('#fieldSurveyHandle').getAttribute('aria-expanded'),'true');
      if (width === 390) {
        const touch = await context.newCDPSession(page);
        async function touchSwipe(delta, cancel = false) {
          const r = await page.locator('#fieldSurveyHandle').boundingBox();
          const x = r.x+r.width/2, y = r.y+r.height/2;
          await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
          await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+delta}]});
          await touch.send('Input.dispatchTouchEvent',{type:cancel?'touchCancel':'touchEnd',touchPoints:[]});
        }
        await touchSwipe(65,true);
        assert.equal(await page.locator('#fieldSurveyHandle').getAttribute('aria-expanded'),'true');
        await touchSwipe(65);
        assert.equal(await page.locator('#fieldSurveyHandle').getAttribute('aria-expanded'),'false');
        await touchSwipe(-65);
        assert.equal(await page.locator('#fieldSurveyHandle').getAttribute('aria-expanded'),'true');
        await touch.detach();
      }
      await page.locator('#fieldMoreTools').click();
      assert.equal(await page.locator('#fieldSurveyPrimary').isVisible(),false);
      assert.equal(await page.locator('#fieldSurveyExtra #toolbar').isVisible(),true);
      await checkLayout();
      await page.screenshot({path:path.join(root,`.test-artifacts/field-tools-${width}.png`)});
      await page.locator('#fieldSurveyHandle').focus();await page.keyboard.press('Enter');
      assert.equal(await page.locator('#toolbar').isVisible(),false);
      await page.keyboard.press('Enter');
      await page.locator('#collapseToolbar').click();
      assert.equal(await page.locator('#fieldSurveyPrimary').isVisible(),true);
      assert.equal(await page.locator('#toolbar').isVisible(),false);
      await page.locator('#fieldPointManual').click();
      await page.locator('#fieldSurveyHandle').click();
      await page.locator('#map').click({position:{x:35,y:height/2}});
      await fix();assert.match(await page.locator('#fieldSurveyElapsed').textContent(),/3 GPS-punkter/);
      await page.locator('#fieldSurveyToggle').click();
      await page.locator('#fieldAreaManual').click();
      await checkLayout();
      const edit = await page.locator('#editBar').boundingBox(), panel = await page.locator('#fieldSurveyPanel').boundingBox();
      assert(edit.y + edit.height <= panel.y,'Drawing controls must stay above panel');
      await page.locator('#cancelEdit').click();
      await page.locator('#stopFieldSurvey').click();
      await page.waitForFunction(() => document.querySelector('#fieldSurveyPanel').hidden);
      assert.equal(await page.locator('body > #toolbar').isVisible(),true);
      await page.locator('#fieldSurveyToggle').click();await page.locator('#startFieldSurvey').click();
      assert.equal(await page.locator('#fieldSurveyHandle').getAttribute('aria-expanded'),'true');
      assert.equal(await page.locator('#fieldSurveyPrimary').isVisible(),true);
      assert.deepEqual(errors,[]);
      console.log(`Field panel ${width}x${height}: gestures, keyboard, tools, GPS continuity, drawing and restart passed`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
