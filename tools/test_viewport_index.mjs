import assert from 'node:assert/strict';
import {createFeatureIndex, geometryBounds, intersects} from '../js/viewport_layers.mjs';
import {contourDisplayData} from '../js/contour_presentation.mjs';

const feature = (type, coordinates) => ({type: 'Feature', geometry: {type, coordinates}});
const crossing = feature('LineString', [[-10, 0], [10, 0]]);
const surrounding = feature('Polygon', [[[-10,-10],[10,-10],[10,10],[-10,10],[-10,-10]]]);
const features = [crossing, surrounding, feature('Point', [0,0]), feature('Point', [2,2]),
  {geometry: {type: 'GeometryCollection', geometries: [{type:'Point',coordinates:[0,0]}, {type:'Point',coordinates:[4,4]}]}},
  ...Array.from({length: 10000}, (_, i) => feature('Point', [i % 100, Math.floor(i/100)]))];
const snapshot = JSON.stringify(features);
const index = createFeatureIndex(features);
for (let x=-3; x<100; x+=7) {
  const box = [x, x/2, x+3, x/2+4];
  const expected = features.filter(item => intersects(geometryBounds(item.geometry), box));
  assert.deepEqual(index.search(box).map(entry=>entry.feature), expected);
}
assert.deepEqual(index.search([-.1,-.1,.1,.1]).slice(0,3).map(entry=>entry.feature), features.slice(0,3));
assert.equal(JSON.stringify(features), snapshot);
assert.equal(geometryBounds(null), null);
assert.equal(createFeatureIndex([]).search([0,0,1,1]).length, 0);
const distant = [crossing, feature('LineString', [[30,30],[31,31]])];
assert.equal(contourDisplayData({features:distant}).features.length, 2, 'Distant contours must remain independently cullable');
console.log('Viewport index: all checks passed');
