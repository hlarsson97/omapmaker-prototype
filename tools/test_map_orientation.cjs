// Disposable browser storage and mocked sensors; never touches server or user data.
// Usage: NODE_PATH=<runtime node_modules> node tools/test_map_orientation.cjs <Leaflet asset directory>
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const assets = path.resolve(process.argv[2] || '../performance-work');
const latitude = 59.3293, longitude = 18.0686;
const metresPerLongitude = 111320 * Math.cos(latitude * Math.PI / 180);
const mapProbe = `
L.Map.addInitHook(function () {
  window.orientationMap = this;
  window.bearingCalls = [];
  const original = this.setBearing;
  this.setBearing = function (bearing) {
    if (!Number.isFinite(bearing)) throw new Error('Invalid map bearing: ' + bearing);
    window.bearingCalls.push(bearing);
    return original.call(this, bearing);
  };
});`;

async function fixture(browser, {ios = false, gps = true, permission = 'granted', permissionApi = true} = {}) {
  const context = await browser.newContext({
    viewport: {width: 390, height: 740}, hasTouch: true, serviceWorkers: 'block',
    ...(ios ? {userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'} : {})
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/api/')) return route.fulfill({json: url.pathname.includes('session')
      ? {authenticated: false}
      : {found: false, type: 'FeatureCollection', features: [], declinationDegrees: 8}});
    let file;
    if (url.hostname === 'unpkg.com') file = path.join(assets, url.pathname.includes('leaflet-rotate') ? 'rotate.js' : url.pathname.endsWith('.css') ? 'leaflet.css' : 'leaflet.js');
    else if (url.hostname === 'omap.test') file = path.join(root, url.pathname.slice(1));
    else return route.fulfill({status: 204, body: ''});
    if (!fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    const body = path.basename(file) === 'leaflet.js' ? fs.readFileSync(file, 'utf8') + '\n' + mapProbe : fs.readFileSync(file);
    return route.fulfill({body, contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/javascript'});
  });
  await page.addInitScript(({gps, permission, permissionApi}) => {
    localStorage.setItem('omapmaker.layers', JSON.stringify({basemap: 'orientation'}));
    localStorage.setItem('omapmaker.toolbarCollapsed.v2', 'false');
    localStorage.setItem('omapmaker.gpsEnabled', String(gps));
    window.gpsWatchCount = 0;
    navigator.geolocation.watchPosition = callback => { window.sendFix = callback; return ++window.gpsWatchCount; };
    navigator.geolocation.clearWatch = () => {};
    window.sensorPermission = permission;
    window.sensorPermissionRequests = 0;
    window.DeviceOrientationEvent = class MockDeviceOrientationEvent extends Event {};
    if (permissionApi) window.DeviceOrientationEvent.requestPermission = async () => {
      window.sensorPermissionRequests++; return window.sensorPermission;
    };
    window.sendOrientation = (properties, type = 'deviceorientation') => {
      const event = new Event(type);
      for (const [name, value] of Object.entries(properties)) Object.defineProperty(event, name, {value});
      window.dispatchEvent(event);
    };
  }, {gps, permission, permissionApi});
  await page.goto('https://omap.test/field.html');
  await page.waitForFunction(() => window.orientationMap && document.querySelector('#fieldSurveyToggle').onclick);
  let fixIndex = 0;
  return {
    page, errors,
    async sendFix(x, y, overrides = {}) {
      await page.evaluate(position => window.sendFix(position), {
        timestamp: Date.now() + fixIndex++ * 1000,
        coords: {longitude: longitude + x / metresPerLongitude, latitude: latitude + y / 111320,
          accuracy: 5, altitude: 0, altitudeAccuracy: 2, heading: 90, speed: 1.2, ...overrides}
      });
    },
    async startField() {
      await page.locator('#fieldSurveyToggle').click();
      await page.locator('#startFieldSurvey').click();
      await page.locator('#fieldSurveyPanel').waitFor();
      await modeIs(page, 'heading-up');
      assert.equal(await page.locator('#fieldHeading').getAttribute('aria-pressed'), 'true');
    },
    async close() { assert.deepEqual(errors, [], 'Sensor updates must not throw browser errors'); await context.close(); }
  };
}

async function modeIs(page, expected) {
  await page.waitForFunction(mode => localStorage.getItem('omapmaker.orientation.global') === mode, expected);
}

async function bearingIs(page, expected, tolerance = .1) {
  await page.waitForFunction(({expected, tolerance}) => {
    const actual = window.orientationMap.getBearing();
    return Math.abs(((actual - expected + 540) % 360) - 180) <= tolerance;
  }, {expected, tolerance});
}

const snapshot = page => page.evaluate(() => ({
  bearing: window.orientationMap.getBearing(),
  calls: window.bearingCalls.length,
  layers: Object.keys(window.orientationMap._layers).length,
  paths: document.querySelectorAll('#map svg path').length
}));

async function gpsDirection(browser) {
  const test = await fixture(browser), {page} = test;
  await test.startField();
  await test.sendFix(0, 0);
  await bearingIs(page, 270);
  const moving = await snapshot(page);
  for (let index = 0; index < 12; index++) await test.sendFix(0, 0, {heading: index % 2 ? 180 : 0, speed: 0});
  await page.waitForTimeout(250);
  assert.equal((await snapshot(page)).bearing, moving.bearing, 'Standing still must retain the last travel direction');
  const recorded = await page.locator('#fieldSurveyElapsed').textContent();
  for (const overrides of [{latitude: NaN}, {longitude: Infinity}, {latitude: 95}, {accuracy: -5}]) await test.sendFix(0, 0, overrides);
  assert.equal(await page.locator('#fieldSurveyElapsed').textContent(), recorded, 'Invalid GPS fixes must not enter the survey log');
  assert.equal((await snapshot(page)).layers, moving.layers, 'GPS updates must reuse the marker and accuracy circle');
  await page.locator('#fieldHeading').click();
  await modeIs(page, 'map-north');
  await bearingIs(page, 0);
  await test.sendFix(15, 0, {heading: 180});
  await page.waitForTimeout(250);
  await bearingIs(page, 0);
  await test.close();
  console.log('Map orientation: field mode follows GPS, retains direction at rest, rejects invalid fixes, and switches off.');
}

async function walkingWithoutHeading(browser) {
  const test = await fixture(browser), {page} = test;
  await test.startField();
  await test.sendFix(0, 0, {heading: null, speed: null});
  for (let step = 1; step <= 14; step++) await test.sendFix(step * 2, 0, {heading: null, speed: null});
  await bearingIs(page, 270);
  assert.match(await page.locator('#fieldSurveyElapsed').textContent(), /15 GPS-punkter/);
  await test.close();
  console.log('Map orientation: several short walking steps establish travel direction without a GPS heading.');
}

async function compassWithoutGps(browser) {
  const test = await fixture(browser, {ios: true, gps: false}), {page} = test;
  await page.locator('#mapOrientationButton').click();
  await modeIs(page, 'magnetic-north');
  await page.locator('#mapOrientationButton').click();
  await modeIs(page, 'compass');
  assert.equal(await page.evaluate(() => window.sensorPermissionRequests), 1);
  assert.equal(await page.evaluate(() => window.gpsWatchCount), 0, 'Compass use must not require GPS');
  await page.evaluate(() => window.sendOrientation({webkitCompassHeading: 90, webkitCompassAccuracy: 5}));
  await bearingIs(page, 262);
  const before = await snapshot(page);
  // A sustained 100 Hz stream catches per-event redraws and accumulating map layers.
  await page.evaluate(async () => {
    for (let frame = 0; frame < 240; frame++) {
      window.sendOrientation({webkitCompassHeading: (90 + frame) % 360, webkitCompassAccuracy: 5});
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  });
  await page.waitForTimeout(300);
  const after = await snapshot(page);
  assert(after.calls - before.calls < 90, `Sensor updates need a bounded render rate, got ${after.calls - before.calls} rotations`);
  assert(after.calls > before.calls, 'The compass must continue updating throughout a sensor stream');
  assert.equal(after.layers, before.layers, 'Compass rotation must not accumulate Leaflet layers');
  assert.equal(after.paths, before.paths, 'Compass rotation must not accumulate SVG paths');
  await page.reload();
  await modeIs(page, 'map-north');
  assert.equal(await page.evaluate(() => window.sensorPermissionRequests), 0, 'Reload must not request sensor access without a gesture');
  assert.match(await page.locator('#toast').textContent(), /tryck.*kompass/i);
  const reloaded = await snapshot(page);
  await page.evaluate(() => window.sendOrientation({webkitCompassHeading: 180, webkitCompassAccuracy: 5}));
  await page.waitForTimeout(250);
  assert.equal((await snapshot(page)).calls, reloaded.calls, 'Reloaded compass must wait for a deliberate activation');
  const correction = page.waitForResponse('**/api/magnetic-north?*');
  await page.locator('#mapOrientationButton').click();
  await modeIs(page, 'compass');
  await (await correction).finished();
  assert.equal(await page.evaluate(() => window.sensorPermissionRequests), 1, 'One tap must reactivate the saved compass mode');
  await page.evaluate(() => window.sendOrientation({webkitCompassHeading: 90, webkitCompassAccuracy: 5}));
  await bearingIs(page, 262);
  await page.locator('#mapOrientationButton').click();
  await modeIs(page, 'heading-up');
  await page.locator('#mapOrientationButton').click();
  await modeIs(page, 'map-north');
  await bearingIs(page, 0);
  const stopped = await snapshot(page);
  await page.evaluate(() => { for (let i = 0; i < 100; i++) window.sendOrientation({webkitCompassHeading: 180, webkitCompassAccuracy: 5}); });
  await page.waitForTimeout(250);
  assert.deepEqual(await snapshot(page), stopped, 'Leaving compass mode must stop sensor-driven rendering');
  await test.close();
  console.log('Map orientation: iPhone compass works without GPS, throttles sustained events, handles reload, and stops after mode change.');
}

async function absoluteCompass(browser) {
  const test = await fixture(browser, {gps: false, permissionApi: false}), {page} = test;
  await page.locator('#mapOrientationButton').click();
  await modeIs(page, 'magnetic-north');
  await page.locator('#mapOrientationButton').click();
  await modeIs(page, 'compass');
  const before = await snapshot(page);
  await page.evaluate(() => window.sendOrientation({alpha: 270, beta: 0, gamma: 0, absolute: false}));
  await page.waitForTimeout(250);
  assert.equal((await snapshot(page)).calls, before.calls, 'Relative orientation cannot establish north');
  await page.evaluate(() => window.sendOrientation({alpha: 270, beta: 0, gamma: 0, absolute: true}, 'deviceorientationabsolute'));
  await bearingIs(page, 262);
  await page.evaluate(() => {
    Object.defineProperty(window.screen.orientation, 'angle', {value: 90, configurable: true});
    window.sendOrientation({alpha: 270, beta: 0, gamma: 0, absolute: true}, 'deviceorientationabsolute');
  });
  await bearingIs(page, 172);
  assert.equal(await page.evaluate(() => window.sensorPermissionRequests), 0);
  await page.locator('#mapOrientationButton').click();
  await modeIs(page, 'heading-up');
  await page.locator('#mapOrientationButton').click();
  await modeIs(page, 'free');
  await page.locator('#mapOrientationButton').click();
  await modeIs(page, 'map-north');
  await test.close();
  console.log('Map orientation: absolute Android sensor, landscape correction, relative-event rejection, and full mode cycle passed.');
}

async function compassPermission(browser) {
  const test = await fixture(browser, {ios: true, permission: 'denied'}), {page} = test;
  await test.startField();
  await page.locator('#fieldCompass').click();
  await page.waitForFunction(() => /kompass|rörelse|sensor/i.test(document.querySelector('#toast').textContent));
  assert.match(await page.locator('#toast').textContent(), /tillåt|tillstånd|behörighet|nekad/i, 'Permission denial needs an actionable explanation');
  assert.notEqual(await page.evaluate(() => localStorage.getItem('omapmaker.orientation.global')), 'compass');
  assert.equal(await page.locator('#fieldCompass').isEnabled(), true, 'Denied permission must not leave the button stuck');
  await page.evaluate(() => { window.sensorPermission = 'granted'; });
  const correction = page.waitForResponse('**/api/magnetic-north?*');
  await page.locator('#fieldCompass').click();
  await modeIs(page, 'compass');
  await (await correction).finished();
  assert.equal(await page.locator('#fieldCompass').getAttribute('aria-pressed'), 'true');
  await page.evaluate(() => window.sendOrientation({webkitCompassHeading: 45, webkitCompassAccuracy: 5}));
  await bearingIs(page, 307);
  await page.locator('#fieldCompass').click();
  await modeIs(page, 'map-north');
  await bearingIs(page, 0);
  await test.close();
  console.log('Map orientation: denied compass permission is explained, retry works, and the field button toggles off.');
}

async function compassWhileSurveying(browser) {
  const test = await fixture(browser, {ios: true}), {page} = test;
  await test.startField();
  await page.locator('#fieldCompass').click();
  await modeIs(page, 'compass');
  await test.sendFix(0, 0);
  const before = await snapshot(page);
  for (let step = 1; step <= 20; step++) {
    await test.sendFix(step * 2, step);
    await page.evaluate(step => {
      for (let event = 0; event < 50; event++) window.sendOrientation({webkitCompassHeading: (step * 25 + event) % 360, webkitCompassAccuracy: 5});
    }, step);
    await page.waitForTimeout(80);
  }
  assert.match(await page.locator('#fieldSurveyElapsed').textContent(), /21 GPS-punkter/);
  const after = await snapshot(page);
  assert.equal(after.layers, before.layers, 'Following GPS and compass together must reuse renderers and markers');
  assert(after.calls - before.calls < 50, 'Compass bursts must not cause a redraw for every sensor event');
  assert(await page.evaluate(() => {
    const maximum = Math.ceil(Math.hypot(innerWidth, innerHeight) * 1.2) + 2;
    return [...document.querySelectorAll('#map svg')].every(svg => Number(svg.getAttribute('width')) <= maximum && Number(svg.getAttribute('height')) <= maximum);
  }), 'Rotating during GPS follow must keep SVG surfaces bounded');
  await page.locator('#fieldHeading').click();
  await modeIs(page, 'heading-up');
  await page.locator('#stopFieldSurvey').click();
  await modeIs(page, 'map-north');
  await page.waitForFunction(() => document.querySelector('#fieldSurveyPanel').hidden);
  await test.close();
  console.log('Map orientation: compass bursts during GPS follow preserve survey logging, bounded surfaces, and clean field exit.');
}

(async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    await gpsDirection(browser);
    await walkingWithoutHeading(browser);
    await compassWithoutGps(browser);
    await absoluteCompass(browser);
    await compassPermission(browser);
    await compassWhileSurveying(browser);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
