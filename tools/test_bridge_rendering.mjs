import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {bridgeTunnelCurveSegments} from '../js/symbol_object_settings.mjs';

const sandbox = {window: {}};
vm.createContext(sandbox);
for (const file of ['isom_symbols.js', 'isom_renderer.js']) {
  vm.runInContext(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), sandbox);
}
const renderer = sandbox.window.OMAPMAKER_ISOM_RENDERER;
const definition = renderer.definition('512');
assert.equal(definition.tagLengthMm, .4);
for (const scale of [7500, 10000, 15000]) for (const declination of [0, 17, 90]) {
  for (const coordinates of [
    [[18, 59], [18.001, 59]],
    [[18.001, 59], [18, 59]],
    [[18, 58.9995], [18, 59.0005]],
    [[17.999, 58.9995], [18, 59], [18.001, 59.0005]]
  ]) {
    const context = {scale, declination, center: {lat: 59, lng: 18}, widthMm: 100, heightMm: 100};
    const feature = {type: 'Feature', properties: {isomSymbol: '512'}, geometry: {type: 'LineString', coordinates}};
    const svg = renderer.buildVectorSvg([feature], context);
    const path = svg.match(/data-decoration-symbol="512" d="([^"]+)"/)[1];
    const actual = [...path.matchAll(/[ML]([^, ]+),([^ ]+)/g)].map(match => ({x: Number(match[1]), y: Number(match[2])}));
    const expected = bridgeTunnelCurveSegments(coordinates, definition)[0].map(point => renderer.paperProject(point, context));
    assert.equal(actual.length, expected.length);
    expected.forEach((point, index) => {
      assert(Math.hypot(point.x - actual[index].x, point.y - actual[index].y) < 1e-7,
        `Bridge wings differ between map and export at scale ${scale}, rotation ${declination}`);
    });
  }
}
console.log('Bridge map/export geometry tests passed');
