import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {applyGenerationProfile, generationSummary, readGenerationSettings} from '../js/generation_settings.mjs';
import {createIndexedDbStore} from '../js/indexeddb_store.mjs';
import {createFieldMap} from '../js/map_setup.mjs';
import {BUILDING_ATTRIBUTION, buildingMetaText, createGeneratedBuildingLayer} from '../js/generated_buildings.mjs';
import {PAVED_AREA_ATTRIBUTION, createGeneratedPavedAreaLayer, pavedAreaMetaText} from '../js/generated_paved_areas.mjs';
import {ROAD_ATTRIBUTION, ROAD_TYPES, createGeneratedRoadLayer, roadMetaText} from '../js/generated_roads.mjs';
import {INFRASTRUCTURE_ATTRIBUTION, INFRASTRUCTURE_TYPES, createGeneratedInfrastructureLayer, infrastructureMetaText} from '../js/generated_infrastructure.mjs';
import {LAND_COVER_ATTRIBUTION, WATER_SYMBOL_CLASSES, createGeneratedLandCoverLayer, isCurrentLandCoverData, isWaterFeature, landCoverMetaText} from '../js/generated_land_cover.mjs';
import {CENTRAL_LAYER_TYPES, centralLayerParameters, createCentralLayerRestorer, createMapLayerApi} from '../js/map_layer_api.mjs';
import {cloneJson, escapeHtml, formatBytes, uuidPattern} from '../js/utils.mjs';
import {localObjectPopup, localObjectSourceLabel} from '../js/local_map_objects.mjs';
import {generatedMapObject, localMapObject, mapObjectPopup, mapObjectSource} from '../js/map_objects.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

assert.equal(escapeHtml('<sten & "stig">'), '&lt;sten &amp; &quot;stig&quot;&gt;');
assert.deepEqual(cloneJson({coordinates: [18.1, 59.2]}), {coordinates: [18.1, 59.2]});
assert.equal(formatBytes(205 * 1024 * 1024), '205 MB');
assert(uuidPattern.test('5eda656c-ddba-43d3-b124-72184e7f91fc'));
assert.equal(localObjectSourceLabel('gps'), 'GPS-inmätt');
assert.equal(localObjectSourceLabel('manual'), 'Manuellt skapad');
const localPopup = localObjectPopup('point', {id: 'local-1', objectType: 'boulder', symbol: '204', source: 'gps', syncStatus: 'local', accuracy: 3.6}, {name: () => 'Sten', isomClaim: () => 'ISOM 204', escapeHtml});
assert.match(localPopup, /Sten/);
assert.match(localPopup, /GPS-inmätt/);
assert.match(localPopup, /Noggrannhet ±4 m/);
assert.match(localPopup, /data-local-edit="local-1"/);
assert.deepEqual(mapObjectSource('osm', 'way/42'), {type: 'osm', label: 'OpenStreetMap', id: 'way/42'});
const adaptedLocal = localMapObject('point', {id: 'local-2', objectType: 'boulder', source: 'gps', syncStatus: 'local', modifiedBy: 'manual'}, '204');
assert.equal(adaptedLocal.geometryType, 'Point');
assert.equal(adaptedLocal.source.type, 'gps');
assert.equal(adaptedLocal.modifiedBy, 'manual');
const adaptedGenerated = generatedMapObject('buildings', {id: 'building/2', properties: {sourceId: 'way/2'}, geometry: {type: 'Polygon'}}, {symbol: '521', statusLabel: 'Automatiskt kartunderlag'});
assert.equal(adaptedGenerated.source.type, 'osm');
assert.equal(adaptedGenerated.editable, true);
const sharedPopup = mapObjectPopup(adaptedGenerated, {title: '<Byggnad>', isomClaim: () => 'ISOM 521', escapeHtml});
assert.match(sharedPopup, /&lt;Byggnad&gt;/);
assert.match(sharedPopup, /OpenStreetMap · way\/2/);
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
assert.equal(pavedAreaMetaText({features: [{properties: {}}, {properties: {status: 'locally-excluded'}}]}, feature => feature.properties.status === 'locally-excluded' ? 'excluded' : 'source', () => ''), '2 automatiska · 1 uteslutna');

const pavedEvents = [];
let pavedVisible = true;
let pavedOptions;
const pavedMap = {
  removeLayer: layer => pavedEvents.push(['remove', layer]),
  attributionControl: {
    addAttribution: text => pavedEvents.push(['addAttribution', text]),
    removeAttribution: text => pavedEvents.push(['removeAttribution', text])
  }
};
const pavedView = createGeneratedPavedAreaLayer({
  Leaflet: {geoJSON: (_data, options) => { pavedOptions = options; return {addTo: target => { pavedEvents.push(['addLayer', target]); return 'paved-layer'; }}; }},
  map: pavedMap,
  getData: () => ({features: []}),
  isVisible: () => pavedVisible,
  generatedStatus: () => 'source',
  generatedStatusLabel: () => 'Automatiskt kartunderlag',
  generatedClass: (_feature, base) => `${base} generated-object source`,
  generatedActionHtml: () => '<div class="generated-actions"></div>',
  excludedStyle: () => ({}),
  symbolScale: () => 1,
  isomAreaStyle: () => ({fillColor: '#d9b36c'}),
  isomClaim: () => 'ISOM 501',
  escapeHtml,
  centralLayerLabel: () => '',
  metaElement: () => ({textContent: ''})
});
pavedView.render();
assert.equal(pavedOptions.pane, 'pavedAreaPane');
assert.deepEqual(pavedEvents.at(-1), ['addAttribution', PAVED_AREA_ATTRIBUTION]);
pavedVisible = false;
pavedView.render();
assert.deepEqual(pavedEvents.slice(-2), [['remove', 'paved-layer'], ['removeAttribution', PAVED_AREA_ATTRIBUTION]]);
assert.equal(ROAD_TYPES['502'][1], 'Bred väg');
assert.equal(roadMetaText({features: [{properties: {isomSymbol: '502'}}, {properties: {isomSymbol: '506', status: 'locally-edited'}}]}, feature => feature.properties.status === 'locally-edited' ? 'edited' : 'source', () => ''), '2 automatiska · 1 st 502 · 1 ändrade');

const roadEvents = [];
const roadGeoJsonOptions = [];
const roadMap = {
  removeLayer: layer => roadEvents.push(['remove', layer]),
  attributionControl: {
    addAttribution: text => roadEvents.push(['addAttribution', text]),
    removeAttribution: text => roadEvents.push(['removeAttribution', text])
  }
};
const roadView = createGeneratedRoadLayer({
  Leaflet: {
    geoJSON: (_data, options) => { roadGeoJsonOptions.push(options); return {options}; },
    layerGroup: layers => ({addTo: target => { roadEvents.push(['addLayerGroup', layers.length, target]); return 'road-layer'; }})
  },
  map: roadMap,
  getData: () => ({features: []}),
  isVisible: () => true,
  featureIsVisible: () => true,
  generatedStatus: () => 'source',
  generatedStatusLabel: () => 'Automatiskt kartunderlag',
  generatedClass: (_feature, base) => `${base} generated-object source`,
  generatedActionHtml: () => '<div class="generated-actions"></div>',
  excludedStyle: () => ({}),
  symbolScale: () => 1,
  isomLineStyle: () => ({color: '#000'}),
  lineStyles: () => ({inner: {color: '#fff'}}),
  normContext: () => ({}),
  isomClaim: () => 'ISOM 502',
  escapeHtml,
  centralLayerLabel: () => '',
  metaElement: () => ({textContent: ''})
});
roadView.render();
assert.equal(roadGeoJsonOptions.length, 2);
assert.equal(roadGeoJsonOptions[0].pane, 'foundationPane');
assert.equal(roadGeoJsonOptions[1].pane, 'foundationPane');
assert.equal(roadGeoJsonOptions[1].interactive, false);
assert.equal(roadGeoJsonOptions[1].filter({properties: {isomSymbol: '502'}}), true);
assert.deepEqual(roadEvents.at(-1), ['addAttribution', ROAD_ATTRIBUTION]);
assert.equal(INFRASTRUCTURE_TYPES['509'][1], 'Järnväg');
assert.equal(infrastructureMetaText({features: [{properties: {featureKind: 'line', isomSymbol: '509'}}, {properties: {featureKind: 'line', isomSymbol: '510'}}, {properties: {featureKind: 'support'}}]}, () => 'source', () => ''), '1 järnvägar · 1 ledningar · 1 stolpar/master');

const infrastructureEvents = [];
const infrastructureOptions = [];
const infrastructureMap = {
  removeLayer: layer => infrastructureEvents.push(['remove', layer]),
  attributionControl: {
    addAttribution: text => infrastructureEvents.push(['addAttribution', text]),
    removeAttribution: text => infrastructureEvents.push(['removeAttribution', text])
  }
};
const infrastructureView = createGeneratedInfrastructureLayer({
  Leaflet: {
    geoJSON: (_data, options) => { infrastructureOptions.push(options); return {options}; },
    layerGroup: layers => ({addTo: target => { infrastructureEvents.push(['addLayerGroup', layers.length, target]); return 'infrastructure-layer'; }}),
    divIcon: options => options,
    marker: (latlng, options) => ({latlng, options})
  },
  map: infrastructureMap,
  renderer: {
    lineStyles: () => ({outer: {color: '#000'}, inner: {color: '#fff'}}),
    definition: () => ({supportWidthMm: 1, supportStrokeMm: 0.2}),
    pixelsPerPaperMm: () => 4,
    paperMm: value => value
  },
  getData: () => ({features: []}),
  isVisible: () => true,
  featureIsSelected: () => true,
  generatedStatus: () => 'source',
  generatedStatusLabel: () => 'Automatiskt kartunderlag',
  generatedClass: (_feature, base) => `${base} generated-object source`,
  generatedActionHtml: () => '<div class="generated-actions"></div>',
  excludedStyle: () => ({}),
  symbolScale: () => 1,
  normContext: () => ({scale: 10000, mode: 'print'}),
  isomClaim: () => 'ISOM 509',
  escapeHtml,
  centralLayerLabel: () => '',
  metaElement: () => ({textContent: ''})
});
infrastructureView.render();
assert.equal(infrastructureOptions.length, 3);
assert(infrastructureOptions.every(options => options.pane === 'infrastructurePane'));
assert.equal(infrastructureOptions[1].interactive, false);
assert.equal(infrastructureOptions[1].filter({properties: {featureKind: 'line', isomSymbol: '509'}}), true);
const supportMarker = infrastructureOptions[2].pointToLayer({properties: {featureKind: 'support', isomSymbol: '511', angleDegrees: 30}}, [59, 18]);
assert.equal(supportMarker.options.pane, 'infrastructurePane');
assert(supportMarker.options.icon.html.includes('rotate(60deg)'));
assert.deepEqual(infrastructureEvents.at(-1), ['addAttribution', INFRASTRUCTURE_ATTRIBUTION]);
assert.equal(WATER_SYMBOL_CLASSES['308'], 'marsh_308');
assert.equal(isWaterFeature({properties: {isomSymbol: '301'}}), true);
assert.equal(isWaterFeature({properties: {isomSymbol: '401'}}), false);
assert.equal(isCurrentLandCoverData({properties: {importVersion: 8}}), true);
assert.equal(landCoverMetaText({properties: {importVersion: 8}, features: [{properties: {isomSymbol: '301'}}, {properties: {isomSymbol: '520'}}]}, () => 'source', () => ''), '1 vatten · 1 st 520');

const landCoverEvents = [];
const landCoverOptions = [];
let scheduledPatternInstall;
const landCoverData = {properties: {importVersion: 8}, features: []};
const landCoverMap = {
  removeLayer: layer => landCoverEvents.push(['remove', layer]),
  attributionControl: {
    addAttribution: text => landCoverEvents.push(['addAttribution', text]),
    removeAttribution: text => landCoverEvents.push(['removeAttribution', text])
  }
};
const landCoverView = createGeneratedLandCoverLayer({
  Leaflet: {
    geoJSON: (_data, options) => { landCoverOptions.push(options); return {options}; },
    layerGroup: layers => ({addTo: target => { landCoverEvents.push(['addLayerGroup', layers.length, target]); return 'land-cover-layer'; }}),
    divIcon: options => options,
    marker: (latlng, options) => ({latlng, options})
  },
  map: landCoverMap,
  renderer: {pointMarkup: () => ({sizePx: 12, html: '<svg></svg>'}), pixelsPerPaperMm: () => 4},
  getData: () => landCoverData,
  isVisible: () => true,
  featureIsSelected: () => true,
  generatedStatus: () => 'source',
  generatedStatusLabel: () => 'Automatiskt kartunderlag',
  generatedClass: (_feature, base) => `${base} generated-object source`,
  generatedActionHtml: () => '<div class="generated-actions"></div>',
  excludedStyle: () => ({}),
  symbolScale: () => 1,
  isomLineStyle: () => ({color: '#00f'}),
  isomAreaStyle: () => ({fillColor: '#00f'}),
  normContext: () => ({scale: 10000, mode: 'print'}),
  isomClaim: () => 'ISOM 301',
  escapeHtml,
  centralLayerLabel: () => '',
  metaElement: () => ({textContent: ''}),
  getDeclination: () => 4,
  documentObject: {querySelectorAll: () => []},
  schedule: callback => { scheduledPatternInstall = callback; }
});
landCoverView.render();
assert.equal(landCoverOptions.length, 2);
assert.equal(landCoverOptions[0].pane, 'landCoverPane');
assert.equal(landCoverOptions[1].pane, 'restrictedAreaPane');
assert.equal(landCoverOptions[0].filter({properties: {isomSymbol: '301'}}), true);
assert.equal(landCoverOptions[1].filter({properties: {isomSymbol: '520'}}), true);
const waterMarker = landCoverOptions[0].pointToLayer({properties: {isomSymbol: '303'}}, [59, 18]);
assert.equal(waterMarker.options.pane, 'landCoverPane');
assert.equal(typeof scheduledPatternInstall, 'function');
assert.deepEqual(landCoverEvents.at(-1), ['addAttribution', LAND_COVER_ATTRIBUTION]);
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
