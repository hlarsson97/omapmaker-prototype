// Usage: NODE_PATH=<runtime node_modules> node tools/test_rotation_rendering.cjs <Leaflet asset directory>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const assets = path.resolve(process.argv[2] || '../performance-work');
const root = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch({headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge'});
  try {
    for (const [width, height] of [[390, 844], [844, 390], [1280, 900]]) {
      const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor: 3});
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://rotation.test/**', route => {
        const file = new URL(route.request().url()).pathname;
        if (file === '/rotation_rendering.mjs') return route.fulfill({body: fs.readFileSync(path.join(root, 'js/rotation_rendering.mjs')), contentType: 'application/javascript'});
        return route.fulfill({body: '<!doctype html><html><head></head><body style="margin:0"><div id="map" style="height:100vh;width:100vw"></div></body></html>', contentType: 'text/html'});
      });
      await page.goto('https://rotation.test/');
      await page.addStyleTag({path: path.join(assets, 'leaflet.css')});
      await page.addScriptTag({path: path.join(assets, 'leaflet.js')});
      await page.addScriptTag({path: path.join(assets, 'rotate.js')});
      const result = await page.evaluate(async () => {
        const {installRotationRendering} = await import('/rotation_rendering.mjs');
        installRotationRendering(L);
        const map = L.map('map', {rotate: true, zoomAnimation: false}).setView([59, 18], 16);
        // The app uses SVG: the current rotate plugin is incompatible with
        // Leaflet Canvas.onAdd, which calls Renderer.onAdd without a map argument.
        const svg = L.svg({padding: 0.1}).addTo(map);
        L.polyline([[58.99, 17.99], [59.01, 18.01]], {renderer: svg}).addTo(map);
        const errors = [];
        const checkCoverage = () => {
          const size = map.getSize();
          for (const renderer of [svg]) {
            for (const x of [-0.1 * size.x, 1.1 * size.x]) {
              for (const y of [-0.1 * size.y, 1.1 * size.y]) {
                const corner = map.containerPointToLayerPoint([x, y]);
                // Renderer bounds round fractional layer coordinates to pixels.
                if (corner.x < renderer._bounds.min.x - 1 || corner.x > renderer._bounds.max.x + 1 || corner.y < renderer._bounds.min.y - 1 || corner.y > renderer._bounds.max.y + 1) errors.push(`Clipped padded corner at bearing ${map.getBearing()}`);
              }
            }
            if (!Number.isFinite(renderer._boundsMinLatLng?.lat)) errors.push('Missing zoom transform anchor');
          }
        };
        for (const bearing of [1, 15, 45, 90, 135, 180, 225, 270, 315, 359, 0]) {
          map.setBearing(bearing);
          checkCoverage();
          map.panBy([12, -18], {animate: false});
          map.setBearing(bearing + 0.5);
          checkCoverage();
        }
        for (const zoom of [17, 15, 16]) {
          map.setView([59.001, 18.001], zoom, {animate: false});
          map.setBearing(40);
          checkCoverage();
        }
        const size = map.getSize(), side = svg._bounds.getSize().x;
        const vendorSide = 2 * Math.ceil(Math.hypot(size.x, size.y) * 2);
        const result = {errors, side, ratio: (side / vendorSide) ** 2, svgWidth: Number(svg._container.getAttribute('width'))};
        map.remove();
        return result;
      });
      assert.deepEqual(errors, []);
      assert.deepEqual(result.errors, []);
      assert(result.ratio < 0.1, JSON.stringify(result));
      assert.equal(result.svgWidth, result.side);
      console.log(`Rotation renderer ${width}x${height}: SVG corners, pan, zoom passed; ${result.side}px side, ${(100 * result.ratio).toFixed(1)}% of vendor surface`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
