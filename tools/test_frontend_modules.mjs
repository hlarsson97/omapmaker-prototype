import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {applyGenerationProfile, generationSummary, readGenerationSettings} from '../js/generation_settings.mjs';
import {createIndexedDbStore} from '../js/indexeddb_store.mjs';
import {createFieldMap} from '../js/map_setup.mjs';
import {BUILDING_ATTRIBUTION, buildingMetaText, createGeneratedBuildingLayer} from '../js/generated_buildings.mjs';
import {CENTRAL_LAYER_TYPES, centralLayerParameters, createCentralLayerRestorer, createMapLayerApi} from '../js/map_layer_api.mjs';
import {cloneJson, escapeHtml, formatBytes, uuidPattern} from '../js/utils.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

assert.equal(escapeHtml('<sten & "stig">'), '&lt;sten &amp; &quot;stig&quot;&gt;');
assert.deepEqual(cloneJson({coordinates: [18.1, 59.2]}), {coordinates: [18.1, 59.2]});
assert.equal(formatBytes(205 * 1024 * 1024), '205 MB');
assert(uuidPattern.test('5eda656c-ddba-43d3-b124-72184e7f91fc'));
assert.equal(typeof createIndexedDbStore, 'function');
assert.equal(buildingMetaText({features: [{properties: {}}, {properties: {status: 'locally-edited'}}, {properties: {status: 'locally-excluded'}}]}, feature => feature.properties.status === 'locally-edited' ? 'edited' : feature.properties.status === 'locally-excluded' ? 'excluded' : 'source', () => ' · server v2'), '3 automatiska · 1 ändrade · 1 uteslutna · server v2');

const buildingData = {features: [{id: 'building/1', properties: {name: 'Klubbhus', sourceId: 'way/1'}, geometry: {type: 'Polygon'}}]};
const buildingEvents = [];
let buildingsVisible = true;
let buildingOptions;
const buildingMap = {
  removeLayer: layer => buildingEvents.push(['remove', layer]),
  attributionControl: {
    addAttribution: text => buildingEvents.push(['addAttribution', text]),
    removeAttribution: text => buildingEvents.push(['removeAttribution', text])
  }
};
const buildingView = createGeneratedBuildingLayer({
  Leaflet: {geoJSON: (data, options) => { buildingOptions = options; return {addTo: target => { buildingEvents.push(['addLayer', target]); return 'building-layer'; }}; }},
  map: buildingMap,
  getData: () => buildingData,
  isVisible: () => buildingsVisible,
  generatedStatus: () => 'source',
  generatedStatusLabel: () => 'Automatiskt kartunderlag',
  generatedClass: (_feature, base) => `${base} generated-object source`,
  generatedActionHtml: () => '<div class="generated-actions"></div>',
  excludedStyle: () => ({}),
  symbolScale: () => 1,
  isomAreaStyle: () => ({fillColor: '#000'}),
  isomClaim: () => 'ISOM 521',
  escapeHtml,
  centralLayerLabel: () => '',
  metaElement: () => ({textContent: ''})
});
buildingView.render();
assert.equal(buildingOptions.pane, 'buildingPane');
assert.deepEqual(buildingEvents.at(-1), ['addAttribution', BUILDING_ATTRIBUTION]);
buildingsVisible = false;
buildingView.render();
assert.deepEqual(buildingEvents.slice(-2), [['remove', 'building-layer'], ['removeAttribution', BUILDING_ATTRIBUTION]]);
assert.deepEqual(centralLayerParameters('land-cover', {workspace: {scale: 15000}, symbolRegistryVersion: 6}), {importVersion: 8, printScale: 15000, symbolRegistryVersion: 6});

const apiCalls = [];
const mapLayerApi = createMapLayerApi({
  hostname: 'labserver1.tailnet.test',
  fetchImpl: async (endpoint, options) => {
    apiCalls.push({endpoint, options});
    return {ok: true, json: async () => endpoint.includes('resolve') ? {found: false} : {type: 'FeatureCollection', features: []}};
  },
  jsonResponse: async response => response.json()
});
const sourceLayer = await mapLayerApi.centralOrSource('land-cover', '/api/land-cover', {bbox: [18, 59, 19, 60], workspace: {id: 'test', scale: 15000}, symbolRegistryVersion: 6});
assert.equal(sourceLayer.reused, false);
assert.equal(apiCalls[0].endpoint, '/api/map-layers/resolve');
assert.equal(JSON.parse(apiCalls[0].options.body).maxAgeSeconds, 86400);
assert.deepEqual(JSON.parse(apiCalls[1].options.body), {bbox: [18, 59, 19, 60], printScale: 15000});
const staticApi = createMapLayerApi({hostname: 'hlarsson97.github.io', fetchImpl: () => { throw new Error('fetch ska inte anropas'); }, jsonResponse: async response => response.json()});
assert.equal(await staticApi.resolveCentralLayer('roads', {bbox: [18, 59, 19, 60], symbolRegistryVersion: 6}), null);

const restoredLayers = [];
const clearedLayers = [];
const restoreMessages = [];
const restoreCentralLayers = createCentralLayerRestorer({
  hostname: 'labserver1.tailnet.test',
  hasWorkspace: () => false,
  resolveCentralLayer: async layerType => layerType === 'roads' ? {layer: {type: 'FeatureCollection'}} : null,
  applyCentralLayer: async (layerType, data) => restoredLayers.push([layerType, data.layer.type]),
  clearCentralLayer: layerType => clearedLayers.push(layerType),
  log: message => restoreMessages.push(message)
});
await restoreCentralLayers();
assert.deepEqual(restoredLayers, [['roads', 'FeatureCollection']]);
assert.deepEqual(clearedLayers, CENTRAL_LAYER_TYPES.filter(layerType => layerType !== 'roads'));
assert.deepEqual(restoreMessages, []);

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
