import assert from 'node:assert/strict';
import {contourDisplayData} from '../js/contour_presentation.mjs';
import {refreshGeoJsonPresentation} from '../js/layer_presentation.mjs';

const coordinates = [[18, 59], [18.1, 59.1]];
const data = {type: 'FeatureCollection', features: [
  {properties: {indexContour: false, elevation: 5}, geometry: {type: 'LineString', coordinates}},
  {properties: {indexContour: true, elevation: 25}, geometry: {type: 'MultiLineString', coordinates: [coordinates, coordinates]}},
  {properties: {}, geometry: null},
  {geometry: {type: 'LineString', coordinates: []}}
]};
const original = JSON.stringify(data);
const display = contourDisplayData(data, 1);
assert.equal(display.features.length, 3);
assert.deepEqual(display.features.map(f => f.properties.indexContour), [false, true, true]);
for (const feature of display.features) {
  assert.equal(feature.geometry.type, 'MultiLineString');
  assert.equal(feature.geometry.coordinates[0], coordinates, 'Reuse original coordinates without copying or simplifying');
}
assert.equal(JSON.stringify(data), original, 'Keep original contour properties/geometry for export and storage');
assert.equal(contourDisplayData({features: Array.from({length: 5000}, () => data.features[0])}).features.length, 157);

// A zoom must update sizes while retaining marker/geometry identity and popup bindings.
let scale = 1;
const point = {feature: {id: 'point'}, popup: {}, setIcon(icon) { this.icon = icon; }};
const line = {feature: {id: 'line'}, coordinates, popup: {}, setStyle(style) { this.style = style; }};
const pointPopup = point.popup, linePopup = line.popup;
const group = {
  options: {style: () => ({weight: 2 * scale})},
  setStyle(style) { line.setStyle(style(line.feature)); },
  eachLayer(visit) { visit(line); visit({eachLayer(visitChild) { visitChild(point); }}); }
};
const pointIcon = feature => ({id: feature.id, size: 8 * scale});
refreshGeoJsonPresentation(null, pointIcon);
refreshGeoJsonPresentation(group, pointIcon);
scale = 2;
refreshGeoJsonPresentation(group, pointIcon);
assert.equal(line.style.weight, 4);
assert.equal(point.icon.size, 16);
assert.equal(line.coordinates, coordinates);
assert.equal(line.popup, linePopup);
assert.equal(point.popup, pointPopup);
console.log('Layer presentation: all checks passed');
