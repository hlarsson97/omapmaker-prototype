import assert from 'node:assert/strict';
import {installRotationRendering, rotationRendererRadius} from '../js/rotation_rendering.mjs';

for (const [width, height] of [[390, 844], [844, 390], [320, 568], [1280, 900]]) {
  const radius = rotationRendererRadius({x: width, y: height});
  for (let angle = 0; angle < 360; angle++) {
    const radians = angle * Math.PI / 180;
    for (const x of [-width * 0.6, width * 0.6]) {
      for (const y of [-height * 0.6, height * 0.6]) {
        const rx = x * Math.cos(radians) - y * Math.sin(radians);
        const ry = x * Math.sin(radians) + y * Math.cos(radians);
        assert(Math.abs(rx) <= radius && Math.abs(ry) <= radius, `Clipped padded corner at ${width}x${height}, ${angle} degrees`);
      }
    }
  }
  const vendorRadius = Math.ceil(Math.hypot(width, height) * 2);
  assert((radius / vendorRadius) ** 2 < 0.1, 'Default renderer surface should use less than one tenth of vendor area');
}
assert.equal(rotationRendererRadius({x: 300, y: 400}, 0), 250);
assert.equal(rotationRendererRadius({x: 300, y: 400}, 0.2), 350);
assert.equal(rotationRendererRadius({x: 300, y: 400}, NaN), 300);

let originalCalls = 0;
function Renderer() {}
Renderer.prototype._update = function () { originalCalls++; };
const Leaflet = {Renderer};
installRotationRendering(Leaflet);
const installed = Renderer.prototype._update;
installRotationRendering(Leaflet);
assert.equal(Renderer.prototype._update, installed, 'Installation must be idempotent');
const renderer = new Renderer();
renderer._update();
renderer._map = {_rotate: false, _bearing: 15}; renderer._update();
renderer._map = {_rotate: true, _bearing: 0}; renderer._update();
assert.equal(originalCalls, 3, 'Unrotated renderers retain Leaflet/plugin behavior');
console.log('Rotation renderer: all-angle padded coverage, bounded surface area and installation checks passed');
