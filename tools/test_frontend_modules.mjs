import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {applyGenerationProfile, generationSummary, readGenerationSettings} from '../js/generation_settings.mjs';
import {createIndexedDbStore} from '../js/indexeddb_store.mjs';
import {createFieldMap} from '../js/map_setup.mjs';
import {cloneJson, escapeHtml, formatBytes, uuidPattern} from '../js/utils.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

assert.equal(escapeHtml('<sten & "stig">'), '&lt;sten &amp; &quot;stig&quot;&gt;');
assert.deepEqual(cloneJson({coordinates: [18.1, 59.2]}), {coordinates: [18.1, 59.2]});
assert.equal(formatBytes(205 * 1024 * 1024), '205 MB');
assert(uuidPattern.test('5eda656c-ddba-43d3-b124-72184e7f91fc'));
assert.equal(typeof createIndexedDbStore, 'function');

const memoryStorage = {
  getItem: key => key === 'settings' ? JSON.stringify({surface: {profile: 'quick'}}) : null
};
const generation = readGenerationSettings(memoryStorage, 'settings');
assert.equal(generation.surface.profile, 'quick');
assert.equal(generation.surface.paved, false);
applyGenerationProfile(generation, 'line', 'detailed');
assert.equal(generation.line.aerialways, true);
assert.equal(generationSummary(generation, 'line'), 'Detaljerad · 8 kategorier');

const panes = new Map();
const fakeMap = {
  setView() { return this; },
  createPane(name) { panes.set(name, {style: {}}); },
  getPane(name) { return panes.get(name); }
};
const fakeLeaflet = {
  map: () => fakeMap,
  control: {zoom: () => ({addTo() {}})},
  tileLayer: (url, options) => ({url, options})
};
const mapSetup = createFieldMap({Leaflet: fakeLeaflet, initialCenter: {lat: 59.2, lng: 18.1}, hasWorkspace: true});
assert.equal(mapSetup.map, fakeMap);
assert.equal(panes.get('contourPane').style.zIndex, 340);
assert.equal(panes.get('northLinePane').style.zIndex, 360);
assert.equal(panes.get('gpsPane').style.zIndex, 650);
assert.equal(panes.get('gpsPane').style.pointerEvents, 'none');

const fieldHtml = fs.readFileSync(path.join(root, 'field.html'), 'utf8');
assert(fieldHtml.includes('styles.css?v=1'));
assert(fieldHtml.includes('type="module" src="app.mjs?v=1"'));
for (const oldAsset of ['field.css', 'overlay.css', 'v6.css', 'v14.css', 'v6.js']) {
  assert(!fieldHtml.includes(oldAsset), `${oldAsset} ska inte längre laddas`);
}

const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
assert(styles.includes('/* ===== field.css ===== */'));
assert(styles.includes('/* ===== v14.css ===== */'));

console.log('Frontendmoduler: alla kontroller godkända');
