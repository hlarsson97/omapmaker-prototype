import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {applyGenerationProfile, generationSummary, readGenerationSettings} from '../js/generation_settings.mjs';
import {createIndexedDbStore} from '../js/indexeddb_store.mjs';
import {createFieldMap} from '../js/map_setup.mjs';
import {BUILDING_ATTRIBUTION, LANTMATERIET_BUILDING_ATTRIBUTION, buildingAttribution, buildingMetaText, createGeneratedBuildingLayer} from '../js/generated_buildings.mjs';
import {PAVED_AREA_ATTRIBUTION, createGeneratedPavedAreaLayer, pavedAreaMetaText} from '../js/generated_paved_areas.mjs';
import {ROAD_ATTRIBUTION, ROAD_TYPES, createGeneratedRoadLayer, roadMetaText} from '../js/generated_roads.mjs';
import {INFRASTRUCTURE_ATTRIBUTION, INFRASTRUCTURE_TYPES, createGeneratedInfrastructureLayer, infrastructureMetaText} from '../js/generated_infrastructure.mjs';
import {bridgeTunnelGeometryFromRoads, ensureBridgeTunnelMinimum, generateBridgeTunnelFeatures, isRoadLikeFeature} from '../js/bridge_tunnel.mjs';
import {LAND_COVER_ATTRIBUTION, WATER_SYMBOL_CLASSES, applyLandCoverPattern, createGeneratedLandCoverLayer, isCurrentLandCoverData, isWaterFeature, landCoverMetaText} from '../js/generated_land_cover.mjs';
import {CENTRAL_LAYER_TYPES, centralLayerParameters, createCentralLayerRestorer, createMapLayerApi} from '../js/map_layer_api.mjs';
import {cloneJson, escapeHtml, formatBytes, uuidPattern} from '../js/utils.mjs';
import {magneticNorthRequestUrl, magneticNorthSummary} from '../js/magnetic_north.mjs';
import {isAppleTouchDevice, mapOrientationBearing, mapOrientationLabel, nextMapOrientation, nextSupportedMapOrientation} from '../js/map_orientation.mjs';
import {anchoredMapCenter, anchoredRotationTranslation, createSmoothMapMarkerFactory} from '../js/smooth_rotation.mjs';
import {changeLocalObjectType, localObjectPopup, localObjectSourceLabel} from '../js/local_map_objects.mjs';
import {MAP_OBJECT_CAPABILITIES, ensureLocalOriginal, generatedMapObject, localMapObject, localObjectLifecycle, mapObjectActionHtml, mapObjectPopup, mapObjectSource, mergeGeneratedFeatureOverrides, restoreLocalFromTrash, restoreLocalOriginal} from '../js/map_objects.mjs';
import {popupLayersFromElements, popupStackContent} from '../js/popup_stack.mjs';
import {applyDefaultSymbolSettings, bridgeTunnelCurveSegments, cliffTagSegments, closeLineCoordinates, courseCrossSegments, fenceTagSegments, groupedFenceTagSegments, groupedProminentLineChevronSegments, groupedWallDotCoordinates, isBarrierLineSymbol, isCliffSymbol, isClosedLineCoordinates, isDecoratedBarrierSymbol, isDecoratedLineSymbol, isImpassableBarrierSymbol, lineCoordinatesWithoutGaps, nearestBarrierAttachment, nearestPointOnLine, parallelLineCoordinates, powerSupportFeatures, prominentLineChevronSegments, retainingWallHalfDotPolygons, snapPowerSupports, stairwayStepSegments, symbolObjectControlsHtml, wallDotCoordinates} from '../js/symbol_object_settings.mjs';
import {FIELD_SURVEY_SEGMENTS, appendSurveyCoordinate, distanceMetres, fieldSurveyFix, formatFieldSurveyDuration, headingUpBearing, movementHeading, usableSurveyFix} from '../js/field_survey.mjs';
import {AccountApiError, createAccountApi, userMapCacheKey, workspaceCacheKey} from '../js/account_api.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
const accountRequests = [], accountResponses = [
  {authenticated:true,user:{id:'user-1',username:'anna',displayName:'Anna',role:'user'},csrfToken:'csrf-1'},
  {workspaces:[]},
  {id:'11111111-1111-4111-8111-111111111111',name:'Skogen',revision:1},
  {error:'Arbetsområdet har ändrats',code:'revision_conflict',current:{id:'11111111-1111-4111-8111-111111111111',revision:2}}
];
const accountStorage = new MemoryStorage();
const accountFetch = async (url, options={}) => {
  accountRequests.push({url,options}); const body=accountResponses.shift(),status=body.error?409:(url==='/api/workspaces'&&options.method==='POST'?201:200);
  return {ok:status<400,status,json:async()=>body};
};
const accountApi = createAccountApi({fetchImpl:accountFetch,storage:accountStorage});
const accountSession = await accountApi.session();
assert.equal(accountSession.user.id,'user-1');
assert.equal(accountApi.cachedUser().username,'anna');
assert.deepEqual(await accountApi.listWorkspaces('user-1'),[]);
const cachedWorkspace = await accountApi.createWorkspace('user-1',{name:'Skogen'});
assert.equal(cachedWorkspace.revision,1);
assert.equal(JSON.parse(accountStorage.getItem(workspaceCacheKey('user-1')))[0].name,'Skogen');
assert.equal(accountRequests[2].options.headers['X-OMapMaker-CSRF'],'csrf-1');
await assert.rejects(accountApi.updateWorkspace('user-1',cachedWorkspace.id,{name:'Ny'},1),error=>error instanceof AccountApiError&&error.status===409&&error.current.revision===2);
assert.equal(userMapCacheKey('user-1'),'omapmaker.user-map.user-1');
const syncRequests=[];
const syncResponses=[
  {cursor:4,objects:[{id:'object-1',category:'point',payload:{id:'object-1'},revision:1,deleted:false}],fieldSurveys:[],layerOverrides:[]},
  {authenticated:true,user:{id:'user-1',username:'anna'},csrfToken:'csrf-sync'},
  {mutationId:'22222222-2222-4222-8222-222222222222',cursor:5,objects:[{id:'object-1',revision:2}],fieldSurveys:[],layerOverrides:[]},
  {migrationId:'33333333-3333-4333-8333-333333333333',objectsImported:1,fieldSurveysImported:0,layerOverridesImported:1}
];
const syncApi=createAccountApi({storage:new MemoryStorage(),fetchImpl:async(url,options={})=>{syncRequests.push({url,options});return{ok:true,status:200,json:async()=>syncResponses.shift()}}});
const syncedData=await syncApi.userData(0);assert.equal(syncedData.cursor,4);assert.equal(syncRequests[0].url,'/api/user-data?since=0');
const layerChange={scopeId:'global',layerType:'roads',featureId:'way/42',payload:{properties:{status:'locally-edited'}}};
await syncApi.syncUserData([{id:'object-1'}],[],[layerChange],'22222222-2222-4222-8222-222222222222');assert.equal(JSON.parse(syncRequests[2].options.body).mutationId,'22222222-2222-4222-8222-222222222222');assert.equal(JSON.parse(syncRequests[2].options.body).layerOverrides[0].featureId,'way/42');
await syncApi.importUserData([{id:'object-1'}],[],[layerChange],'33333333-3333-4333-8333-333333333333');assert.equal(syncRequests[3].options.headers['X-OMapMaker-CSRF'],'csrf-sync');
const lmRequests=[],lmResponses=[{authenticated:true,user:{id:'user-1'},csrfToken:'csrf-lm'},{connected:false,manifest:null},{connected:true,manifest:{product:'Topografi 10 Nedladdning, vektor'}},{id:'download-1',status:'queued'},{job:{id:'download-1',status:'running'}},{connected:false,manifest:null}];
const lmApi=createAccountApi({storage:new MemoryStorage(),fetchImpl:async(url,options={})=>{lmRequests.push({url,options});return{ok:true,status:200,json:async()=>lmResponses.shift()}}});
await lmApi.session();await lmApi.lantmaterietSession();await lmApi.connectLantmateriet('user','secret','cc4cbb38-d8c6-4859-b271-592a7477e374',true);await lmApi.startLantmaterietDownload(['communication','utilities']);await lmApi.lantmaterietDownloadStatus();await lmApi.disconnectLantmateriet();
assert.equal(lmRequests[2].options.headers['X-OMapMaker-CSRF'],'csrf-lm');assert.equal(JSON.parse(lmRequests[2].options.body).password,'secret');assert.equal(JSON.parse(lmRequests[2].options.body).persist,true);assert.deepEqual(JSON.parse(lmRequests[3].options.body).themes,['communication','utilities']);assert.equal(lmRequests[3].options.headers['X-OMapMaker-CSRF'],'csrf-lm');assert.equal(lmRequests[4].url,'/api/lantmateriet-downloads/latest');assert.equal(lmRequests[5].options.method,'DELETE');

assert.equal(escapeHtml('<sten & "stig">'), '&lt;sten &amp; &quot;stig&quot;&gt;');
assert.deepEqual(cloneJson({coordinates: [18.1, 59.2]}), {coordinates: [18.1, 59.2]});
assert.equal(formatBytes(205 * 1024 * 1024), '205 MB');
assert(uuidPattern.test('5eda656c-ddba-43d3-b124-72184e7f91fc'));
assert.equal(magneticNorthRequestUrl({lat:59.3,lng:18.1},'2026-08-28'),'/api/magnetic-north?lat=59.3&lng=18.1&date=2026-08-28');
assert.match(magneticNorthSummary({model:'WMM2025',date:'2026-08-28',declinationDegrees:7.73,meridianConvergenceDegrees:1.59,gridToMagneticDegrees:6.14}),/nordlinjer \+7,73°/);
assert.equal(nextMapOrientation('map-north'),'magnetic-north');
assert.equal(nextMapOrientation('magnetic-north'),'heading-up');
assert.equal(nextMapOrientation('heading-up'),'free');
assert.equal(nextMapOrientation('free'),'map-north');
assert.equal(nextSupportedMapOrientation('magnetic-north',false),'heading-up');
assert.equal(nextSupportedMapOrientation('heading-up',false),'map-north');
assert.equal(nextSupportedMapOrientation('magnetic-north',true),'heading-up');
assert.equal(isAppleTouchDevice({userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'}),true);
assert.equal(isAppleTouchDevice({userAgent:'Mozilla/5.0',platform:'MacIntel',maxTouchPoints:5}),true);
assert.equal(isAppleTouchDevice({userAgent:'Mozilla/5.0 (Windows NT 10.0)',platform:'Win32',maxTouchPoints:0}),false);
assert.equal(mapOrientationBearing('map-north',7.7,23),0);
assert.equal(mapOrientationBearing('magnetic-north',7.7,23),-7.7);
assert.equal(mapOrientationBearing('heading-up',7.7,-82),-82);
assert.equal(mapOrientationBearing('free',7.7,23),23);
assert.equal(mapOrientationLabel('heading-up'),'Färdriktning upp');
assert.equal(mapOrientationLabel('free'),'Fri rotation');
assert.equal(FIELD_SURVEY_SEGMENTS.terrain.objectType,null);
assert.equal(FIELD_SURVEY_SEGMENTS.wide_path.objectType,'wide_path');
const surveyFix=fieldSurveyFix({timestamp:1234,coords:{longitude:18.1,latitude:59.2,accuracy:4.5,altitude:31,altitudeAccuracy:2,heading:82,speed:1.4}});
assert.equal(surveyFix.heading,82);
assert.equal(usableSurveyFix(surveyFix),true);
assert.equal(usableSurveyFix({...surveyFix,accuracy:70}),false);
const surveyCoordinates=[];
assert.equal(appendSurveyCoordinate(surveyCoordinates,surveyFix),true);
assert.equal(appendSurveyCoordinate(surveyCoordinates,{...surveyFix,timestamp:1300}),false);
assert.equal(appendSurveyCoordinate(surveyCoordinates,{...surveyFix,longitude:18.1001,timestamp:2300}),true);
assert(distanceMetres(surveyCoordinates[0],surveyCoordinates[1])>5);
assert.equal(headingUpBearing(82),-82);
assert.equal(headingUpBearing(370),-10);
assert(Math.abs(movementHeading({longitude:18,latitude:59},{longitude:18.001,latitude:59})-90)<0.1);
assert.equal(formatFieldSurveyDuration(65*60000),'1 h 05 min');
class TestPoint {
  constructor(x, y) { this.x = x; this.y = y; }
  divideBy(value) { return new TestPoint(this.x / value, this.y / value); }
  subtract(point) { return new TestPoint(this.x - point.x, this.y - point.y); }
  rotate(radians) { return new TestPoint(this.x * Math.cos(radians) - this.y * Math.sin(radians), this.x * Math.sin(radians) + this.y * Math.cos(radians)); }
}
const anchoredCenter = anchoredMapCenter({
  getSize: () => new TestPoint(1000, 800),
  getZoom: () => 15,
  project: () => new TestPoint(700, 500),
  unproject: point => point
}, {lat: 59, lng: 18}, new TestPoint(600, 400), Math.PI / 2);
assert(Math.abs(anchoredCenter.x - 700) < 1e-8);
assert(Math.abs(anchoredCenter.y - 600) < 1e-8);
const pivotTranslation = anchoredRotationTranslation(new TestPoint(600, 400), new TestPoint(500, 400), Math.PI / 2);
assert(Math.abs(pivotTranslation.x - 100) < 1e-8);
assert(Math.abs(pivotTranslation.y + 100) < 1e-8);
class FakeMarker {
  static extend(methods) { class ExtendedMarker extends FakeMarker {} Object.assign(ExtendedMarker.prototype, methods); return ExtendedMarker; }
  constructor(latlng, options) { this.latlng = latlng; this.options = options; }
  getEvents() { return {zoom: 'update', rotate: '_rotateReposition', rotateend: '_rotateEnd'}; }
  _setPos(position) { this.position = position; return position; }
  _initInteraction() {}
}
const smoothMarker = createSmoothMapMarkerFactory({Marker: FakeMarker, DomEvent: {on() {}}, point: (x, y) => new TestPoint(x, y)})([59, 18], {pane: 'fieldMarkerPane'});
assert.equal(smoothMarker.options.rotateWithView, false);
assert.deepEqual(smoothMarker.getEvents(), {zoom: 'update'});
smoothMarker._map = {_rotate: true, _bearing: 30, mapPanePointToRotatedPoint: position => new TestPoint(position.x - 10, position.y - 20)};
smoothMarker._setPos(new TestPoint(50, 60));
assert.deepEqual(smoothMarker.position, new TestPoint(40, 40));
assert.equal(localObjectSourceLabel('gps'), 'GPS-inmätt');
assert.equal(localObjectSourceLabel('manual'), 'Manuellt skapad');
const localPopup = localObjectPopup('point', {id: 'local-1', objectType: 'boulder', symbol: '204', source: 'gps', syncStatus: 'local', accuracy: 3.6}, {name: () => 'Sten', isomClaim: () => 'ISOM 204', escapeHtml});
assert.match(localPopup, /Sten/);
assert.match(localPopup, /GPS-inmätt/);
assert.match(localPopup, /Noggrannhet ±4 m/);
assert.match(localPopup, /data-object-kind="local"/);
assert.match(localPopup, /data-object-id="local-1"/);
for (const action of ['edit', 'exclude', 'delete', 'reset']) assert.match(localPopup, new RegExp(`data-object-action="${action}"`));
const typedPopup = localObjectPopup('area', {id: 'area-1', objectType: 'open_land', symbol: '401', source: 'manual'}, {name: () => 'Öppen mark', isomClaim: symbol => `ISOM ${symbol}`, escapeHtml, typeOptions: [{id: 'open_land', symbol: '401', name: 'Öppen mark'}, {id: 'forbidden', symbol: '520', name: 'Område som inte får beträdas'}]});
assert.match(typedPopup, /data-local-object-type="area-1"/);
assert.match(typedPopup, /value="forbidden"[^>]*>520/);
const retypedArea = {objectType: 'open_land', symbol: '401', boundary: 'old', supports: [{id: 1}]};
assert.equal(changeLocalObjectType('area', retypedArea, 'forbidden', {forbidden: {category: 'area', symbol: '520'}}, object => { object.boundary = 'clear'; }), true);
assert.equal(retypedArea.objectType, 'forbidden');
assert.equal(retypedArea.symbol, '520');
assert.equal(retypedArea.boundary, 'clear');
assert.equal(retypedArea.supports, undefined);
assert.equal(changeLocalObjectType('line', retypedArea, 'forbidden', {forbidden: {category: 'area', symbol: '520'}}), false);
const cliffObject = applyDefaultSymbolSettings({id: 'cliff-1', symbol: '201', coordinates: [[18, 59], [18.001, 59]]}, '201');
assert.equal(cliffObject.downhillSide, 'right');
assert.match(symbolObjectControlsHtml(cliffObject, escapeHtml), /data-symbol-object-action="cliff-side"/);
const rightSideTags = cliffTagSegments(cliffObject.coordinates, {tagSpacingMm: 0.5, tagLengthMm: 0.4}, 'right');
assert(rightSideTags.length > 1);
assert(rightSideTags[0][1][1] < rightSideTags[0][0][1], 'Höger sida om en östgående linje ska ligga söderut');
const snapped = nearestPointOnLine([[18, 59], [18.001, 59]], [18.0004, 59.0002]);
assert(Math.abs(snapped.coordinate[1] - 59) < 1e-10);
assert(Math.abs(snapped.angleDegrees) < 1e-8);
const parallelPowerLines = parallelLineCoordinates([[18, 59], [18.001, 59]], 0.4, 15000);
assert(Math.abs((parallelPowerLines(1)[0][1] - parallelPowerLines(-1)[0][1]) * 111320 - 6) < 0.02, 'ISOM 511 ska ritas som två parallella linjer med 0,4 mm centrumavstånd');
const powerObject = applyDefaultSymbolSettings({id: 'power-1', symbol: '511', source: 'manual', coordinates: [[18, 59], [18.001, 59]]}, '511');
powerObject.supports.push({id: 'mast-1', coordinates: [18.0004, 59.0002], supportType: 'tower', largeMast: true});
snapPowerSupports(powerObject);
const supportFeatures = powerSupportFeatures(powerObject, '511');
assert.equal(supportFeatures.length, 1);
assert.equal(supportFeatures[0].properties.parentObjectId, 'power-1');
assert.equal(supportFeatures[0].properties.largeMast, true);
assert(Math.abs(supportFeatures[0].geometry.coordinates[1] - 59) < 1e-10);
const powerControls = symbolObjectControlsHtml(powerObject, escapeHtml);
assert.match(powerControls, /Placera stor kraftledningsmast/);
assert.match(powerControls, /data-support-large="true"/);
assert(powerControls.indexOf('data-support-large="true"') < powerControls.indexOf('data-support-large="false"'), 'Stor mast ska vara förstahandsvalet för ISOM 511');
const fenceObject = applyDefaultSymbolSettings({id: 'fence-1', symbol: '516', coordinates: [[18, 59], [18.001, 59]]}, '516');
assert.equal(fenceObject.tagSide, 'right');
assert.equal(isDecoratedBarrierSymbol('516'), true);
assert.match(symbolObjectControlsHtml(fenceObject, escapeHtml), /data-symbol-object-action="fence-side"/);
const fenceTags = fenceTagSegments(fenceObject.coordinates, {styleSpacingMm: 2, tagLengthMm: 0.4, tagAngleDeg: 60}, 'right');
assert(fenceTags.length >= 1);
assert(fenceTags[0][1][1] < fenceTags[0][0][1], 'Högertaggar på ett östgående staket ska ligga söderut');
const wallDots = wallDotCoordinates(fenceObject.coordinates, {styleSpacingMm: 2});
assert.equal(wallDots.length, 2);
const retainingObject = applyDefaultSymbolSettings({id: 'retaining-1', symbol: '513.2', coordinates: [[18, 59], [18.001, 59]]}, '513.2');
assert.equal(retainingObject.lowerSide, 'right');
assert.match(symbolObjectControlsHtml(retainingObject, escapeHtml), /data-symbol-object-action="retaining-wall-side"/);
const halfDots = retainingWallHalfDotPolygons(retainingObject.coordinates, {styleSpacingMm: 1, styleOffsetMm: 0.8, styleDiameterMm: 0.4, sideOffsetMm: 0.05}, 'right');
assert(halfDots.length >= 2);
assert(halfDots[0].some(coordinate => coordinate[1] < 59), 'Stödmurens högersida ska bukta söderut för en östgående linje');
const groupedDots = groupedWallDotCoordinates(retainingObject.coordinates, {groupSpacingMm: 3, groupOffsetMm: 1.5, withinGroupSpacingMm: 0.8});
assert(groupedDots.length >= 2 && groupedDots.length % 2 === 0);
const groupedTags = groupedFenceTagSegments(retainingObject.coordinates, {groupSpacingMm: 2.5, groupOffsetMm: 1, withinGroupSpacingMm: 0.6, tagLengthMm: 0.4, tagAngleDeg: 60}, 'right');
assert(groupedTags.length >= 2 && groupedTags.length % 2 === 0);
assert.equal(isBarrierLineSymbol('514'), true);
assert.equal(isImpassableBarrierSymbol('515'), true);
assert.equal(isImpassableBarrierSymbol('516'), false);
const prominentChevrons = prominentLineChevronSegments(fenceObject.coordinates, {styleSpacingMm: 2, styleOffsetMm: 1, tagLengthMm: 0.4, tagAngleDeg: 45});
assert(prominentChevrons.length >= 2 && prominentChevrons.length % 2 === 0);
assert(prominentChevrons[0][1][0] < prominentChevrons[0][0][0], 'ISOM 528-markeringen ska peka bakåt längs en östgående linje');
const groupedProminentChevrons = groupedProminentLineChevronSegments(fenceObject.coordinates, {groupSpacingMm: 2, groupOffsetMm: 1, withinGroupSpacingMm: 0.6, tagLengthMm: 0.4, tagAngleDeg: 45});
assert(groupedProminentChevrons.length >= 4 && groupedProminentChevrons.length % 4 === 0);
assert.equal(isDecoratedBarrierSymbol('528'), false);
assert.equal(isDecoratedLineSymbol('528'), true);
assert.equal(isBarrierLineSymbol('528'), false);
assert.equal(isBarrierLineSymbol('529'), true);
assert.equal(isImpassableBarrierSymbol('529'), true);
const stairSteps = stairwayStepSegments(fenceObject.coordinates, {stepSpacingMm: 0.4, innerWidthMm: 0.4});
assert(stairSteps.length >= 3);
assert(stairSteps[0][0][1] < stairSteps[0][1][1], 'Trappsteg ska ligga tvärs över linjens ritningsriktning');
assert.equal(isDecoratedLineSymbol('532'), true);
assert.equal(isCliffSymbol('104'), true);
assert.equal(isDecoratedLineSymbol('105.1'), true);
assert.equal(isDecoratedLineSymbol('105.2'), true);
assert.equal(isDecoratedLineSymbol('106'), true);
assert.equal(isDecoratedLineSymbol('512'), true);
assert.equal(isDecoratedLineSymbol('711'), true);
assert.equal(courseCrossSegments([[18,59],[18.01,59]], {styleSpacingMm:5,styleWidthMm:3,styleHeightMm:3}, 15000).length >= 2, true);
const bridgeWings = bridgeTunnelCurveSegments([[18,59],[18.001,59]], {tagLengthMm:.5,tagAngleDeg:60}, 15000);
assert.equal(bridgeWings.length, 1, 'ISOM 512 ska renderas som en sammanhängande linje utan fula hörnskarvar');
assert.equal(bridgeWings[0].length, 4, 'Den sammanhängande 512-linjen ska innehålla två ändvingar och baslinjen');
assert(bridgeWings.flat().every(point => point[1] >= 59), 'Båda ändvingarna ska ligga på samma sida om baslinjen');
assert.match(symbolObjectControlsHtml({id:'vineyard-1',symbol:'414',orientationDegrees:30,background:'yellow50'}, escapeHtml), /data-symbol-value-property="orientationDegrees"/);
assert.match(symbolObjectControlsHtml({id:'vineyard-1',symbol:'414',orientationDegrees:30,background:'yellow50'}, escapeHtml), /data-symbol-setting-property="background"/);
assert.match(symbolObjectControlsHtml({id:'boundary-1',symbol:'416',variant:'black-dots'}, escapeHtml), /data-symbol-setting-property="variant"/);
assert.match(symbolObjectControlsHtml({id:'ride-1',symbol:'508',runnability:'walk'}, escapeHtml), /data-symbol-setting-property="runnability"/);
assert.match(symbolObjectControlsHtml({id:'height-1',symbol:'603',elevation:219}, escapeHtml), /value="219"/);
assert.match(symbolObjectControlsHtml({id:'number-1',symbol:'704',controlNumber:'8'}, escapeHtml), /value="8"/);
assert.match(symbolObjectControlsHtml({id:'landform-1',symbol:'115',legendDefinition:'Kolbotten'}, escapeHtml), /data-symbol-value-property="legendDefinition"/);
const attachment = nearestBarrierAttachment([{id: 'path', symbol: '506', coordinates: [[18, 59], [18.001, 59]]}, {id: 'wall', symbol: '515', coordinates: [[18, 59.0001], [18.001, 59.0001]]}], [18.0004, 59.00011], 25);
assert.equal(attachment.barrier.id, 'wall');
assert(Math.abs(attachment.snapped.coordinate[1] - 59.0001) < 1e-10);
const crossingControls = symbolObjectControlsHtml({id: 'crossing-1', symbol: '519', parentObjectId: 'wall-1', parentSymbol: '515', breakBarrier: true}, escapeHtml);
assert.match(crossingControls, /Kopplad till ISOM 515/);
assert.match(crossingControls, /data-symbol-object-action="crossing-break"/);
const closedFenceCoordinates = [[18, 59], [18.001, 59], [18.001, 59.001], [18.00001, 59.00001]];
const closedFence = closeLineCoordinates(closedFenceCoordinates, 3);
assert.equal(closedFence.closed, true);
assert.deepEqual(closedFence.coordinates.at(-1), closedFence.coordinates[0]);
assert.equal(isClosedLineCoordinates(closedFence.coordinates), true);
assert.match(symbolObjectControlsHtml({id: 'enclosure-1', symbol: '516', coordinates: closedFence.coordinates}, escapeHtml), /create-enclosed-area/);
const lineParts = lineCoordinatesWithoutGaps([[18, 59], [18.002, 59]], [[18.001, 59]], 9);
assert.equal(lineParts.length, 2);
const gapWest = lineParts[0].at(-1), gapEast = lineParts[1][0];
assert(gapWest[0] < 18.001 && gapEast[0] > 18.001, 'Passagen ska dela barriärlinjen i två synliga delar');
assert.deepEqual(mapObjectSource('osm', 'way/42'), {type: 'osm', label: 'OpenStreetMap', id: 'way/42'});
const adaptedLocal = localMapObject('point', {id: 'local-2', objectType: 'boulder', source: 'gps', syncStatus: 'local', modifiedBy: 'manual'}, '204');
assert.equal(adaptedLocal.geometryType, 'Point');
assert.equal(adaptedLocal.source.type, 'gps');
assert.equal(adaptedLocal.modifiedBy, 'manual');
assert.deepEqual(adaptedLocal.capabilities, MAP_OBJECT_CAPABILITIES);
assert.equal(adaptedLocal.status.type, 'edited');
assert.equal(localMapObject('area', {id: 'deleted-area', objectType: 'open_land', source: 'manual', status: 'locally-deleted'}, '401').status.label, 'Raderad lokalt');
assert.equal(localObjectLifecycle({status: 'locally-excluded'}), 'excluded');
assert.equal(localObjectLifecycle({status: 'locally-deleted'}), 'deleted');
const trashedWork = {objectType: 'forbidden', symbol: '520', coordinates: [[18, 59], [18.1, 59], [18, 59.1]], source: 'gps', status: 'locally-deleted', deletedAt: '2026-08-30T12:00:00Z'};
restoreLocalFromTrash(trashedWork);
assert.equal(trashedWork.status, undefined);
assert.equal(trashedWork.deletedAt, undefined);
assert.equal(trashedWork.symbol, '520');
assert.equal(trashedWork.source, 'gps');
const restorableLocal = {objectType: 'boulder', symbol: '204', coordinates: [18.1, 59.2], source: 'gps'};
ensureLocalOriginal(restorableLocal);
restorableLocal.coordinates = [19, 60];
restorableLocal.status = 'locally-deleted';
restorableLocal.modifiedBy = 'manual';
restoreLocalOriginal(restorableLocal);
assert.deepEqual(restorableLocal.coordinates, [18.1, 59.2]);
assert.equal(restorableLocal.source, 'gps');
assert.equal(restorableLocal.status, undefined);
assert.equal(restorableLocal.modifiedBy, undefined);
const legacyRestorable = {objectType: 'cliff', symbol: '201', coordinates: [[18, 59], [18.001, 59]], originalObject: {objectType: 'cliff', symbol: '201', coordinates: [[18, 59], [18.001, 59]]}, downhillSide: 'right', tagSide: 'left', lowerSide: 'right', supports: [], angleDegrees: 20, parentObjectId: 'wall-1', parentSymbol: '515', breakBarrier: true, breakBarrierMode: 'manual'};
restoreLocalOriginal(legacyRestorable);
assert.equal(legacyRestorable.downhillSide, undefined);
assert.equal(legacyRestorable.tagSide, undefined);
assert.equal(legacyRestorable.lowerSide, undefined);
assert.equal(legacyRestorable.supports, undefined);
assert.equal(legacyRestorable.parentObjectId, undefined);
assert.equal(legacyRestorable.breakBarrier, undefined);
const adaptedGenerated = generatedMapObject('buildings', {id: 'building/2', properties: {sourceId: 'way/2'}, geometry: {type: 'Polygon'}}, {symbol: '521', statusLabel: 'Automatiskt kartunderlag'});
assert.equal(adaptedGenerated.source.type, 'osm');
assert.deepEqual(adaptedGenerated.capabilities, MAP_OBJECT_CAPABILITIES);
const adaptedGlobal = generatedMapObject('global-objects', {id: 'global/1', properties: {}, geometry: {type: 'Point'}}, {symbol: '204', source: 'omapmaker', statusLabel: 'Bekräftad'});
assert.equal(adaptedGlobal.source.label, 'OMapMaker-observationer');
assert.deepEqual(adaptedGlobal.capabilities, MAP_OBJECT_CAPABILITIES);
const generatedActions = mapObjectActionHtml(adaptedGenerated, {kind: 'generated', layerType: 'buildings', escapeHtml});
for (const action of ['edit', 'exclude', 'delete', 'reset']) assert.match(generatedActions, new RegExp(`data-object-action="${action}"`));
assert.match(generatedActions, /data-object-layer="buildings"/);
const sharedPopup = mapObjectPopup(adaptedGenerated, {title: '<Byggnad>', isomClaim: () => 'ISOM 521', escapeHtml});
assert.match(sharedPopup, /&lt;Byggnad&gt;/);
assert.match(sharedPopup, /OpenStreetMap · way\/2/);
assert.match(sharedPopup, /map-object-popup/);
assert.match(sharedPopup, /object-popup-info-label">ID och detaljer/);
assert.match(sharedPopup, /Objekt-ID/);
assert.match(sharedPopup, /building\/2/);
const refreshedGenerated = {features: [{id: 'new-id', properties: {sourceId: 'way/2', isomSymbol: '503'}, geometry: {type: 'LineString', coordinates: [[18, 59], [18.1, 59.1]]}}]};
const previousGenerated = {features: [{id: 'old-id', properties: {sourceId: 'way/2', isomSymbol: '506', status: 'locally-edited'}, geometry: {type: 'LineString', coordinates: [[18, 59], [18.2, 59.2]]}}, {id: 'missing', properties: {sourceId: 'way/missing', status: 'locally-edited'}, geometry: {type: 'Point', coordinates: [18, 59]}}]};
mergeGeneratedFeatureOverrides(refreshedGenerated, previousGenerated, {status: feature => feature.properties.status === 'locally-edited' ? 'edited' : 'source', propertyNames: ['isomSymbol']});
assert.deepEqual(refreshedGenerated.features[0].geometry.coordinates, [[18, 59], [18.2, 59.2]]);
assert.equal(refreshedGenerated.features[0].properties.isomSymbol, '506');
assert.deepEqual(refreshedGenerated.features[0].properties.latestSourceGeometry.coordinates, [[18, 59], [18.1, 59.1]]);
assert.equal(refreshedGenerated.features[1].properties.sourceMissing, true);
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
assert.equal(buildingAttribution({properties: {sourceType: 'lantmateriet'}}), LANTMATERIET_BUILDING_ATTRIBUTION);
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
assert.equal(INFRASTRUCTURE_TYPES['512'][1], 'Bro/tunnel');
assert.equal(infrastructureMetaText({features: [{properties: {featureKind: 'line', isomSymbol: '509'}}, {properties: {featureKind: 'line', isomSymbol: '510'}}, {properties: {featureKind: 'line', isomSymbol: '512'}}, {properties: {featureKind: 'support'}}]}, () => 'source', () => ''), '1 järnvägar · 1 ledningar · 1 bro/tunnel · 1 stolpar/master');

const bridgeRoad={type:'Feature',id:'bridge-road',properties:{sourceId:'way/1',isomSymbol:'503',highway:'primary',bridge:'yes',renderWidthMetres:7},geometry:{type:'LineString',coordinates:[[18,59],[18.002,59]]}};
const crossedRoad={type:'Feature',id:'crossed-road',properties:{sourceId:'way/2',isomSymbol:'504',highway:'service',renderWidthMetres:4},geometry:{type:'LineString',coordinates:[[18.001,58.9995],[18.001,59.0005]]}};
const assistedBridge=bridgeTunnelGeometryFromRoads(bridgeRoad,crossedRoad,{minimumLengthMetres:6});
assert(assistedBridge);
assert.equal(assistedBridge.coordinates.length,2);
assert(assistedBridge.lengthMetres>=8);
assert(Math.abs(assistedBridge.coordinates[0][0]-assistedBridge.coordinates[1][0])<1e-10,'Tvåvägsplaceringens baslinje ska vara vinkelrät mot den först valda vägen');
const assistedRightPortal=bridgeTunnelGeometryFromRoads(bridgeRoad,crossedRoad,{minimumLengthMetres:6,anchor:[18.0011,59]});
assert(assistedRightPortal.centre[0]>18.001,'Första vägklicket ska välja närmaste sida av den korsade konstruktionen');
assert.equal(isRoadLikeFeature(bridgeRoad),true);
assert.equal(generateBridgeTunnelFeatures({features:[bridgeRoad,crossedRoad]}).length,2,'En OSM-taggad sträcka ska ge en portal vid vardera änden');
assert.equal(generateBridgeTunnelFeatures({features:[bridgeRoad,crossedRoad]})[0].properties.classificationReason,'mapped-bridge');
const inferredStructure={...bridgeRoad,id:'upper',properties:{...bridgeRoad.properties,sourceId:'way/3',bridge:null}};
const inferred=generateBridgeTunnelFeatures({features:[inferredStructure,crossedRoad]},{includeInferred:true});
assert.equal(inferred.length,2,'En riskvilligt tolkad korsning ska ge två portaler vid konstruktionens ytterkanter');
assert.equal(inferred[0].properties.generationMethod,'road-overlap');
assert.equal(inferred[0].properties.reviewRequired,true);
assert(Math.abs(inferred[0].geometry.coordinates[0][1]-inferred[0].geometry.coordinates[1][1])<1e-10,'Automatiska portaler ska vara 90 grader mot den undergående vägen');
const parallelCrossing={...crossedRoad,id:'crossed-road-2',properties:{...crossedRoad.properties,sourceId:'way/4'},geometry:{type:'LineString',coordinates:[[18.00135,58.9995],[18.00135,59.0005]]}};
const grouped=generateBridgeTunnelFeatures({features:[inferredStructure,crossedRoad,parallelCrossing]},{includeInferred:true});
assert.equal(grouped.length,2,'När flera parallella vägar går under samma viadukt ska två sammanhängande portalmarkeringar skapas');
assert(Math.abs(grouped[0].geometry.coordinates[1][0]-grouped[0].geometry.coordinates[0][0])>.00035);
const verticalStructure1={...inferredStructure,id:'vertical-upper-1',properties:{...inferredStructure.properties,sourceId:'way/6'},geometry:{type:'LineString',coordinates:[[18.001,58.9995],[18.001,59.0005]]}};
const verticalStructure2={...inferredStructure,id:'vertical-upper-2',properties:{...inferredStructure.properties,sourceId:'way/7'},geometry:{type:'LineString',coordinates:[[18.00135,58.9995],[18.00135,59.0005]]}};
const horizontalPassage={...crossedRoad,id:'horizontal-passage',properties:{...crossedRoad.properties,sourceId:'way/8'},geometry:{type:'LineString',coordinates:[[18.0005,59],[18.0018,59]]}};
const dividedViaduct=generateBridgeTunnelFeatures({features:[verticalStructure1,verticalStructure2,horizontalPassage]},{includeInferred:true});
assert.equal(dividedViaduct.length,2,'Parallella körbanor i samma viadukt ska få endast två yttre portaler');
const portalLongitudes=dividedViaduct.map(feature=>(feature.geometry.coordinates[0][0]+feature.geometry.coordinates[1][0])/2).sort();
assert(portalLongitudes[0]<18.001&&portalLongitudes[1]>18.00135,'Portalerna ska hamna vid viaduktens ytterkanter, inte där vägarnas mittlinjer möts');
assert(dividedViaduct.every(feature=>Math.abs(feature.geometry.coordinates[0][0]-feature.geometry.coordinates[1][0])<1e-10),'Portalernas baslinjer ska vara 90 grader mot den undergående vägen');
const orderedViaductPortals=[...dividedViaduct].sort((left,right)=>left.geometry.coordinates[0][0]-right.geometry.coordinates[0][0]);
const leftPortalShape=bridgeTunnelCurveSegments(orderedViaductPortals[0].geometry.coordinates,{tagLengthMm:.5,tagAngleDeg:60},15000)[0],rightPortalShape=bridgeTunnelCurveSegments(orderedViaductPortals[1].geometry.coordinates,{tagLengthMm:.5,tagAngleDeg:60},15000)[0];
assert(leftPortalShape[0][0]<orderedViaductPortals[0].geometry.coordinates[0][0]&&rightPortalShape[0][0]>orderedViaductPortals[1].geometry.coordinates[0][0],'Portalernas vingar ska peka ut från konstruktionen');
const atGrade={...crossedRoad,id:'at-grade',properties:{...crossedRoad.properties,sourceId:'way/5'},geometry:{type:'LineString',coordinates:[[18.001,58.9995],[18.001,59],[18.001,59.0005]]}};
const joinedStructure={...inferredStructure,geometry:{type:'LineString',coordinates:[[18,59],[18.001,59],[18.002,59]]}};
assert.equal(generateBridgeTunnelFeatures({features:[joinedStructure,atGrade]},{includeInferred:true}).length,0,'En vanlig OSM-korsning med gemensam nod ska inte bli broförslag');
assert.equal(ensureBridgeTunnelMinimum([[18,59],[18.00001,59]],6).length,2);

const infrastructureEvents = [];
const infrastructureOptions = [];
let majorPowerLineData = null;
let infrastructureSupportRenderProperties = null;
const infrastructureMap = {
  removeLayer: layer => infrastructureEvents.push(['remove', layer]),
  attributionControl: {
    addAttribution: text => infrastructureEvents.push(['addAttribution', text]),
    removeAttribution: text => infrastructureEvents.push(['removeAttribution', text])
  }
};
const infrastructureView = createGeneratedInfrastructureLayer({
  Leaflet: {
    geoJSON: (data, options) => { if (infrastructureOptions.length === 1) majorPowerLineData = data; infrastructureOptions.push(options); return {options}; },
    layerGroup: layers => ({addTo: target => { infrastructureEvents.push(['addLayerGroup', layers.length, target]); return 'infrastructure-layer'; }}),
    divIcon: options => options,
    marker: (latlng, options) => ({latlng, options})
  },
  map: infrastructureMap,
  renderer: {
    lineStyles: () => ({outer: {color: '#000'}, inner: {color: '#fff'}}),
    definition: () => ({lineCentreGapMm: 0.4, supportWidthMm: 1, supportStrokeMm: 0.2}),
    pointMarkup: (_symbol, _context, properties) => { infrastructureSupportRenderProperties = properties; return {sizePx: 18, mapHtml: `<svg class="map-symbol-svg" data-angle="${properties.angleDegrees}"></svg>`}; },
    pixelsPerPaperMm: () => 4,
    paperMm: value => value
  },
  getData: () => ({features: [{type: 'Feature', id: 'power-511', properties: {featureKind: 'line', isomSymbol: '511'}, geometry: {type: 'LineString', coordinates: [[18, 59], [18.001, 59]]}}]}),
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
assert.equal(infrastructureOptions.length, 4);
assert(infrastructureOptions.every(options => options.pane === 'infrastructurePane'));
assert.equal(infrastructureOptions[2].interactive, false);
assert.equal(infrastructureOptions[2].filter({properties: {featureKind: 'line', isomSymbol: '509'}}), true);
assert.equal(majorPowerLineData.features.length, 2, 'ISOM 511 ska skapa två separata Leaflet-linjer');
assert.notEqual(majorPowerLineData.features[0].geometry.coordinates[0][1], majorPowerLineData.features[1].geometry.coordinates[0][1]);
const supportMarker = infrastructureOptions[3].pointToLayer({properties: {featureKind: 'support', isomSymbol: '511', angleDegrees: 30}}, [59, 18]);
assert.equal(supportMarker.options.pane, 'infrastructureMarkerPane');
assert.equal(supportMarker.options.rotateWithView, undefined);
assert(supportMarker.options.icon.html.includes('map-symbol-svg'));
assert(supportMarker.options.icon.className.includes('omap-symbol'));
assert.equal(infrastructureSupportRenderProperties.largeMast, true, 'OSM-stöd på ISOM 511 ska bli stor mast om inte liten pylon uttryckligen valts');
assert.deepEqual(infrastructureEvents.at(-1), ['addAttribution', INFRASTRUCTURE_ATTRIBUTION]);
assert.equal(WATER_SYMBOL_CLASSES['308'], 'marsh_308');
assert.equal(isWaterFeature({properties: {isomSymbol: '301'}}), true);
assert.equal(isWaterFeature({properties: {isomSymbol: '401'}}), false);
assert.equal(isCurrentLandCoverData({properties: {importVersion: 9}}), false);
assert.equal(isCurrentLandCoverData({properties: {importVersion: 10}}), true);
assert.equal(landCoverMetaText({properties: {importVersion: 10}, features: [{properties: {isomSymbol: '301'}}, {properties: {isomSymbol: '520'}}]}, () => 'source', () => ''), '1 vatten · 1 st 520');
const marshPath = {style: {fillOpacity: '0'}};
applyLandCoverPattern(marshPath, 'marsh-pattern');
assert.equal(marshPath.style.fill, 'url(#marsh-pattern)');
assert.equal(marshPath.style.fillOpacity, '1', 'mönsterytor utan grundfärg måste göras synliga');

const landCoverEvents = [];
const landCoverOptions = [];
let scheduledPatternInstall;
const landCoverData = {properties: {importVersion: 10}, features: []};
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
assert.equal(waterMarker.options.pane, 'landCoverMarkerPane');
assert.equal(waterMarker.options.rotateWithView, undefined);
assert.equal(typeof scheduledPatternInstall, 'function');
assert.deepEqual(landCoverEvents.at(-1), ['addAttribution', LAND_COVER_ATTRIBUTION]);
assert.deepEqual(centralLayerParameters('land-cover', {workspace: {scale: 15000}, symbolRegistryVersion: 6}), {importVersion: 12, source: 'automatic', printScale: 15000, symbolRegistryVersion: 6});
assert.deepEqual(centralLayerParameters('roads', {workspace: {scale: 15000}, symbolRegistryVersion: 13}), {importVersion: 5, source: 'automatic', symbolRegistryVersion: 13});
assert.deepEqual(centralLayerParameters('infrastructure', {symbolRegistryVersion: 13}), {importVersion: 3, source: 'automatic', symbolRegistryVersion: 13});
assert.deepEqual(centralLayerParameters('buildings', {symbolRegistryVersion: 13, sources: {buildings: 'lantmateriet'}}), {importVersion: 5, source: 'lantmateriet', symbolRegistryVersion: 13});
assert.deepEqual(centralLayerParameters('property-boundaries', {symbolRegistryVersion: 13}), {importVersion: 1});
assert(CENTRAL_LAYER_TYPES.includes('property-boundaries'));
assert(CENTRAL_LAYER_TYPES.includes('facility-references'));
assert.deepEqual(centralLayerParameters('map-labels', {symbolRegistryVersion: 13}), {importVersion: 1});
assert(CENTRAL_LAYER_TYPES.includes('map-labels'));
assert.deepEqual(centralLayerParameters('nature-references', {symbolRegistryVersion: 13}), {importVersion: 1});
assert.deepEqual(centralLayerParameters('military-references', {symbolRegistryVersion: 13}), {importVersion: 1});
assert(CENTRAL_LAYER_TYPES.includes('nature-references'));
assert(CENTRAL_LAYER_TYPES.includes('military-references'));

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
assert.deepEqual(JSON.parse(apiCalls[1].options.body), {bbox: [18, 59, 19, 60], source: 'automatic', printScale: 15000});
apiCalls.length = 0;
await mapLayerApi.centralOrSource('buildings', '/api/buildings', {bbox: [18, 59, 19, 60], symbolRegistryVersion: 6, sources: {buildings: 'lantmateriet'}});
assert.equal(JSON.parse(apiCalls[0].options.body).parameters.source, 'lantmateriet');
assert.deepEqual(JSON.parse(apiCalls[1].options.body), {bbox: [18, 59, 19, 60], source: 'lantmateriet'});
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
assert.deepEqual(generation.sources, {buildings: 'automatic', roads: 'automatic'});
applyGenerationProfile(generation, 'line', 'detailed');
assert.equal(generation.line.aerialways, true);
assert.equal(generation.line.bridges, true);
assert.equal(generation.line.inferredBridges, true);
assert.equal(generation.sources.buildings, 'automatic');
assert.equal(generationSummary(generation, 'line'), 'Detaljerad · 10 kategorier');

const panes = new Map();
const rotatingPane = {className: 'leaflet-rotate-pane'};
const nonRotatingPane = {className: 'leaflet-norotate-pane'};
const paneParents = new Map();
const fakeMap = {
  touchGestures: {disable() { this.disabled = true; }},
  touchZoom: {enable() { this.enabled = true; }},
  shiftKeyRotate: {disable() { this.disabled = true; }},
  setView() { return this; },
  createPane(name, parent) { panes.set(name, {style: {}}); paneParents.set(name,parent); },
  getPane(name) {
    if (name === 'overlayPane') return {parentElement: rotatingPane};
    if (name === 'markerPane') return {parentElement: nonRotatingPane};
    return panes.get(name);
  }
};
const fakeLeaflet = {
  map: () => fakeMap,
  control: {zoom: () => ({addTo() {}})},
  tileLayer: (url, options) => ({url, options})
};
const mapSetup = createFieldMap({Leaflet: fakeLeaflet, initialCenter: {lat: 59.2, lng: 18.1}, hasWorkspace: true});
assert.equal(mapSetup.map, fakeMap);
assert.equal(fakeMap.touchGestures.disabled, true);
assert.equal(fakeMap.touchZoom.enabled, true);
assert.equal(panes.get('contourPane').style.zIndex, 340);
assert.equal(panes.get('northLinePane').style.zIndex, 360);
assert.equal(panes.get('propertyBoundaryPane').style.zIndex, 350);
assert.equal(panes.get('mapLabelPane').style.zIndex, 395);
assert.equal(panes.get('mapLabelPane').style.pointerEvents, 'none');
assert.equal(panes.get('gpsPane').style.zIndex, 650);
assert.equal(panes.get('gpsPane').style.pointerEvents, 'none');
assert.equal(paneParents.get('buildingPane'),rotatingPane);
assert.equal(paneParents.get('contourPane'),rotatingPane);
assert.equal(paneParents.get('fieldPane'),rotatingPane);
assert.equal(paneParents.get('landCoverMarkerPane'),rotatingPane);
assert.equal(paneParents.get('infrastructureMarkerPane'),rotatingPane);
assert.equal(paneParents.get('globalMarkerPane'),rotatingPane);
assert.equal(paneParents.get('fieldMarkerPane'),rotatingPane);
assert.equal(paneParents.get('editMarkerPane'),nonRotatingPane);

const fieldHtml = fs.readFileSync(path.join(root, 'field.html'), 'utf8');
assert(fieldHtml.includes('styles.css?v=17'));
assert(fieldHtml.includes('isom_symbols.js?v=16'));
assert(fieldHtml.includes('isom_renderer.js?v=21'));
assert(fieldHtml.includes('@tomickigrzegorz/leaflet-rotate@0.2.4'));
assert(fieldHtml.includes('type="module" src="app.mjs?v=56"'));
for (const fieldControl of ['fieldSurveyToggle','fieldSurveyPanel','fieldPointManual','fieldAreaManual','fieldPowerSupport','fieldHeading','fieldSurveyLogs','pointOpacity','lineOpacity','areaOpacity','trashButton','trashSheet','trashList','lineBridges','lineInferredBridges','bridgeTunnelSheet','bridgeSelectRoads','bridgeDrawFree','propertyBoundariesVisible','fetchPropertyBoundariesButton','mapLabelsVisible','fetchMapLabelsButton','natureReferencesVisible','fetchNatureReferencesButton','militaryReferencesVisible','fetchMilitaryReferencesButton','openLantmaterietLogin','lantmaterietLoginSheet','lantmaterietUsername','lantmaterietPassword','lantmaterietOrderId','persistLantmaterietCredentials','disconnectLantmateriet']) assert(fieldHtml.includes(`id="${fieldControl}"`));
for (const oldAsset of ['field.css', 'overlay.css', 'v6.css', 'v14.css', 'v6.js']) {
  assert(!fieldHtml.includes(oldAsset), `${oldAsset} ska inte längre laddas`);
}

const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
assert(styles.includes('/* ===== field.css ===== */'));
assert(styles.includes('/* ===== v14.css ===== */'));
for (const category of ['point','line','area']) assert(styles.includes(`.map-${category}-object{opacity:var(--${category}-object-opacity,1)!important}`), `${category}-objekt ska styras av sitt globala opacitetsreglage`);
const appSource = fs.readFileSync(path.join(root, 'app.mjs'), 'utf8');
assert(appSource.includes('map-${geometryCategory(feature)}-object'), 'Genererade objekt ska få opacitetsklass efter geometri');
assert(appSource.includes("workspace?.symbolDisplayMode||'print'"), 'Globalkartan ska använda skalenliga symboler när inget arbetsområde anger digitalt läge');
assert(appSource.includes("if(symbolDisplayMode()==='print')refreshSymbolPresentation()"), 'Skalenliga punktsymboler ska renderas om efter zoom');
assert(appSource.includes('local-map-object map-point-object'), 'Lokala punkter ska behålla sin geometri- och opacitetsklass när ikonen renderas om');
assert(appSource.includes("function pointNormContext(){return{...normContext(),mode:'print'}}"), 'Punktobjekt ska alltid använda skalenlig zoomrendering');
assert(appSource.includes('refreshPointPresentation();renderRoads()'), 'Punktobjekt ska renderas om även när arbetsområdet använder digitalt läge');
assert(appSource.includes("map.on('zoom zoomanim'"), 'Punktobjekt ska skalas även under en pågående zoomgest');
assert(styles.includes('scale(var(--point-zoom-scale,1))'), 'Punktsymbolernas visuella storlek ska följa zoomens mellanlägen');
assert(styles.includes('.infrastructure-support-icon .symbol-svg{filter:none}'), 'Kraftledningsmaster ska inte få vit läsbarhetsskugga');
assert(appSource.includes('return pointIconFromSymbol(symbol,`infrastructure-support-icon'), 'Lokala kraftledningsmaster ska använda samma SVG-rendering som punktsymboler');
assert(appSource.includes("supportPlacement.largeMast==null&&String(object.symbol)==='511'"), 'Generisk placering ska välja stor mast som standard för ISOM 511');
assert(styles.includes('.local-map-object .symbol-svg{filter:none}'), 'Manuellt placerade punktsymboler ska inte ha vit skugga');
assert(styles.includes('grid-template-columns:repeat(3,minmax(0,1fr))'), 'Ritverktygen ska ligga i en kompakt horisontell rad');
assert(appSource.includes('tool-symbol-preview'), 'Ritverktygen ska visa vald symbol i stället för ett långt objektnamn');
assert(appSource.includes("map.on('popupopen'"), 'Popupen ska bygga en växlare för överlappande objekt');
assert(appSource.includes('keepPopupClearOfControls(popup)'), 'Popupen ska hållas fri från de fasta mobilkontrollerna');
assert(appSource.includes('function clearGeotorgetForm()'), 'Geotorget-formuläret ska tömmas utan en förgänglig eventreferens');
assert(appSource.includes('sourceDeliveryUpdated')&&appSource.includes('sourceDownloadedAt'), 'Lagren ska visa både leveransdatum och serverns nedladdningsdatum');
assert(!appSource.includes("$('#lantmaterietLoginForm').reset()"), 'Geotorget-flödet får inte förlita sig på en formulärreferens efter await');
assert(styles.includes('.object-popup-info'), 'Popupen ska kunna visa unikt ID och tekniska detaljer på begäran');
const popupLayerA={getPopup:()=>({getContent:()=>'<div>A</div>'})},popupLayerB={getPopup:()=>({getContent:()=>'<div>B</div>'})},popupContainer={},popupElement={_leaflet_id:12,parentElement:popupContainer},popupMap={_targets:{12:popupLayerB},getContainer:()=>popupContainer};
assert.deepEqual(popupLayersFromElements([popupElement],popupMap,popupLayerA),[popupLayerA,popupLayerB]);
assert.match(popupStackContent('<div>A</div>',1,2),/Objekt 2\/2/);
assert.match(popupStackContent('<div>A</div>',1,2),/data-popup-stack-step="-1"/);
for (const versionedModule of ['map_layer_api.mjs?v=7','map_setup.mjs?v=6','account_api.mjs?v=3','generated_buildings.mjs?v=2','generated_roads.mjs?v=2','generated_infrastructure.mjs?v=16','bridge_tunnel.mjs?v=2','generated_land_cover.mjs?v=9','local_map_objects.mjs?v=3','map_objects.mjs?v=4','popup_stack.mjs?v=1','symbol_object_settings.mjs?v=9']) assert(appSource.includes(versionedModule), `${versionedModule} ska cachebrytas`);

console.log('Frontendmoduler: alla kontroller godkända');
