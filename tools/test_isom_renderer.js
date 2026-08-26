const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;
const root = path.resolve(__dirname, '..');
for (const file of ['isom_symbols.js', 'isom_renderer.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, file), 'utf8'), {filename: file});
}

const registry = global.OMAPMAKER_ISOM_REGISTRY;
const renderer = global.OMAPMAKER_ISOM_RENDERER;
assert.strictEqual(registry.registryVersion, 2);
for (const [objectType, item] of Object.entries(registry.manualTypes)) {
  if (item.publishable) assert(renderer.definition(item.symbol), `${objectType} saknar renderer för ${item.symbol}`);
}
assert.strictEqual(renderer.paperMm(0.14, 15000), 0.14);
assert(Math.abs(renderer.paperMm(0.14, 10000) - 0.21) < 1e-9);
assert.strictEqual(registry.technical['601'].spacingGroundMetres * 1000 / 10000, 30);

const center = {lat: 59.2, lng: 18.1};
const shortPath = {
  type: 'Feature', id: 'short', properties: {isomSymbol: '506', name: 'Kort stig'},
  geometry: {type: 'LineString', coordinates: [[18.1, 59.2], [18.10001, 59.2]]}
};
let check = renderer.preflight([shortPath], {scale: 10000, declination: null, center, widthMm: 277, heightMm: 190});
assert(check.issues.some(issue => issue.code === 'declination-missing'));
assert(check.issues.some(issue => issue.code === 'minimum-length'));

const building = {
  type: 'Feature', id: 'building', properties: {isomSymbol: '521', name: 'Byggnad'},
  geometry: {type: 'Polygon', coordinates: [[[18.0999,59.1999],[18.1001,59.1999],[18.1001,59.2001],[18.0999,59.2001],[18.0999,59.1999]]]}
};
check = renderer.preflight([building], {scale: 10000, declination: 8.5, center, widthMm: 277, heightMm: 190});
assert.strictEqual(check.errors, 0);
const tinyArea = {
  type: 'Feature', id: 'tiny', properties: {isomSymbol: '520', name: 'För liten tomtmark'},
  geometry: {type: 'Polygon', coordinates: [[[18.1,59.2],[18.100001,59.2],[18.100001,59.200001],[18.1,59.200001],[18.1,59.2]]]}
};
check = renderer.preflight([tinyArea], {scale: 10000, declination: 8.5, center, widthMm: 277, heightMm: 190});
assert(check.issues.some(issue => issue.code === 'minimum-area'));
check = renderer.preflight([{...shortPath, properties: {isomSymbol: '999'}}], {scale: 10000, declination: 8.5, center, widthMm: 277, heightMm: 190});
assert(check.issues.some(issue => issue.code === 'renderer-missing'));

const road = {...shortPath, id: 'road', properties: {isomSymbol: '502', widthMetres: 6}};
const gully = {...shortPath, id: 'gully', properties: {isomSymbol: '108'}};
const cliff = {...shortPath, id: 'cliff', properties: {isomSymbol: '201', downhillSide: 'right'}, geometry: {type: 'LineString', coordinates: [[18.0999, 59.2], [18.1001, 59.2]]}};
const label = {...shortPath, id: 'label', properties: {isomSymbol: '101', mapText: '42,5', labelCoordinate: [center.lng, center.lat], textHeightMm: 1.5}};
const svg = renderer.buildVectorSvg([building, road, gully, cliff, label], {scale: 10000, declination: 8.5, center, widthMm: 277, heightMm: 190});
assert(svg.startsWith('<svg'));
assert(svg.includes('symbolRegistryVersion'));
assert(svg.includes('data-colour="blue"'));
assert(svg.includes('stroke-width="0.18"'));
assert(svg.includes('<path'));
assert(svg.includes('data-composite-symbol="502"'));
assert(svg.includes('stroke-dasharray="0 '));
assert(svg.includes('data-orientation="magnetic-north"'));
assert((svg.match(/stroke-linecap="round"/g) || []).length >= 2, 'Branttaggar eller punktlinje saknas');

console.log('ISOM renderer: alla kontroller godkända');
