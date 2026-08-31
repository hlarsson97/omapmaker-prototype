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
assert.strictEqual(registry.registryVersion, 12);
assert.strictEqual(registry.renderingRevision, 12);
for (const [objectType, item] of Object.entries(registry.manualTypes)) {
  if (item.publishable) assert(renderer.definition(item.symbol), `${objectType} saknar renderer för ${item.symbol}`);
}
assert.strictEqual(renderer.paperMm(0.14, 15000), 0.14);
assert(Math.abs(renderer.paperMm(0.14, 10000) - 0.21) < 1e-9);
assert.strictEqual(registry.technical['601'].spacingGroundMetres * 1000 / 10000, 30);
assert.strictEqual(registry.technical['601'].preferredColour, 'black');
assert.deepStrictEqual(registry.renderers['509'].dashMm, [1, 0.5]);
assert.strictEqual(registry.renderers['511'].supportOverhangMm, 0.3);
assert.strictEqual(registry.renderers['511'].supportWidthMm, 1.14);
assert.strictEqual(registry.renderers['511'].supportStrokeMm, 0.2);
assert.strictEqual(registry.renderers['511'].largeSupportSizeMm, 0.8);
assert.strictEqual(registry.renderers['511'].largeSupportStrokeMm, 0.2);
assert.strictEqual(registry.renderers['511'].minimumLengthMm, undefined);
assert.deepStrictEqual(registry.renderers['201'].settings.downhillSide.values, ['left', 'right']);
assert.strictEqual(registry.renderers['513.1'].styleDiameterMm, 0.4);
assert.strictEqual(registry.renderers['513.1'].styleSpacingMm, 2);
assert.strictEqual(registry.renderers['516'].tagAngleDeg, 60);
assert.deepStrictEqual(registry.renderers['516'].settings.tagSide.values, ['left', 'right']);
assert.strictEqual(registry.renderers['513.2'].style, 'half-dots');
assert.deepStrictEqual(registry.renderers['514'].dashMm, [1.65, 0.35]);
assert.strictEqual(registry.renderers['515'].withinGroupSpacingMm, 0.8);
assert.strictEqual(registry.renderers['517'].minimumLengthMm, 3.65);
assert.strictEqual(registry.renderers['518'].groupSpacingMm, 2.5);
assert.strictEqual(registry.renderers['519'].barSpacingMm, 0.6);
assert.strictEqual(registry.renderers['519'].settings.breakBarrier.default, true);
assert.deepStrictEqual(registry.renderers['522'].minimumBoxMm, [0.6, 0.6]);
assert.deepStrictEqual(registry.renderers['523'].dashMm, [0.5, 0.25]);
assert.strictEqual(registry.renderers['524'].innerDiameterMm, 0.3);
assert.strictEqual(registry.renderers['525'].widthMm, 1);
assert.strictEqual(registry.renderers['526'].innerDiameterMm, 0.14);
assert.strictEqual(registry.renderers['527'].roofRiseMm, 0.354);
assert.strictEqual(registry.renderers['528'].styleSpacingMm, 2);
assert.strictEqual(registry.renderers['528'].tagAngleDeg, 45);
assert.strictEqual(registry.renderers['529'].withinGroupSpacingMm, 0.6);
assert.strictEqual(registry.renderers['529'].minimumLengthMm, 2);
assert.strictEqual(registry.renderers['530'].diameterMm, 0.8);
assert.strictEqual(registry.renderers['531'].widthMm, 0.8);
assert.deepStrictEqual(registry.renderers['407'].minimumBoxMm, [1.5, 1]);
assert.strictEqual(registry.renderers['409'].patternSpacingMm, 0.42);
assert.strictEqual(registry.renderers['415'].minimumLengthMm, 2);
assert.strictEqual(registry.renderers['417'].maskDiameterMm, 1.1);
assert.strictEqual(registry.renderers['418'].strokeWidthMm, 0.2);
assert.strictEqual(registry.renderers['419'].maskStrokeWidthMm, 0.36);
assert.strictEqual(registry.renderers['532'].minimumSteps, 3);
assert.strictEqual(registry.renderers['110'].widthMm, 0.8);
assert.strictEqual(registry.renderers['111'].strokeWidthMm, 0.18);
assert.strictEqual(registry.renderers['203.2'].innerDiameterMm, 0.35);
assert.strictEqual(registry.renderers['206'].minimumAreaMm2, 0.3);
assert.strictEqual(registry.renderers['207'].settings.sizePercent.values[1], 120);

const screenContext = {scale: 15000, mode: 'digital', map: {getCenter: () => ({lat: 59.2}), getZoom: () => 15}};
const powerStyle = renderer.lineStyles('511', {}, screenContext);
assert.strictEqual(powerStyle.inner, undefined);
assert.strictEqual(powerStyle.parallelSeparationMm, 0.4);
const largePowerMastMarkup = renderer.pointMarkup('511', screenContext, {largeMast: true}).html;
assert(largePowerMastMarkup.includes('M-0.57,0H0.57') && largePowerMastMarkup.includes('<rect') && largePowerMastMarkup.includes('width="0.8"') && largePowerMastMarkup.includes('stroke-width="0.2"'), 'Stor mast på 511 ska ha tvärlinje genom en 0,8 × 0,8 mm kontur');
const smallPowerMastMarkup = renderer.pointMarkup('511', screenContext, {largeMast: false}).html;
assert(smallPowerMastMarkup.includes('M-0.57,0H0.57') && smallPowerMastMarkup.includes('stroke-width="0.2"'), 'Liten pylon på 511 ska sticka ut 0,3 mm på vardera sida om dubbelledningens yttermått');
const printContextAtZoom = zoom => ({scale: 15000, mode: 'print', map: {getCenter: () => ({lat: 59.2}), getZoom: () => zoom}});
const zoomedOutBoulder = renderer.pointMarkup('204', printContextAtZoom(13));
const zoomedInBoulder = renderer.pointMarkup('204', printContextAtZoom(17));
assert(zoomedOutBoulder.sizePx >= 8, 'Punktsymbolens klickyta ska förbli användbar vid utzoomning');
assert(zoomedOutBoulder.visualWidthPx < zoomedInBoulder.visualWidthPx, 'Själva stenen ska följa kartans zoom även när klickytan har nått sin minimistorlek');
assert(zoomedOutBoulder.mapHtml.includes(`width:${zoomedOutBoulder.visualWidthPx}px`), 'Kartsymbolen ska använda den normberäknade visuella bredden');
const pitMarkup = renderer.pointMarkup('112', screenContext).html;
assert(pitMarkup.includes('M-0.35,-0.4 L0,0.4 L0.35,-0.4'), 'Grop 112 ska vara ett enkelt V utan lodräta ändar');
assert.strictEqual((renderer.pointMarkup('110', screenContext).html.match(/<ellipse/g) || []).length, 3, 'Långsträckt kulle ska ha tre bruna ovaler');
assert(renderer.pointMarkup('111', screenContext).html.includes('<path'), 'Liten sänka ska vara en brun båge');
assert(renderer.pointMarkup('203.1', screenContext, {orientationDegrees: 90}).html.includes('rotate(90)'), 'Grottans öppning ska kunna riktas');
const dangerousPitMarkup = renderer.pointMarkup('203.2', screenContext).html;
assert(dangerousPitMarkup.includes('r="0.45"') && dangerousPitMarkup.includes('r="0.175"'), 'Farlig grop ska ha 0,9 mm ytterdiameter och 0,35 mm vitt centrum');
assert(renderer.pointMarkup('207', screenContext).html.includes('L0.4,0.3465'), 'Stenklustret ska vara en fylld triangel med 0,8 mm sida');
assert(Math.abs(renderer.pointMarkup('207', screenContext, {sizePercent: 120}).widthMm - 0.96) < 1e-9, 'Stenklustret ska kunna förstoras till tillåtna 120 % utan klippning');
const railwayStyle = renderer.lineStyles('509', {}, screenContext);
assert.strictEqual(railwayStyle.outer.dashArray, null, 'Järnvägens svarta grundlinje måste vara heldragen');
assert(railwayStyle.inner.dashArray, 'Järnvägens vita mittlinje ska vara streckad');
const canopyStyle = renderer.areaStyle('522', {}, screenContext);
assert.strictEqual(canopyStyle.fillColor, '#cccccc');
assert.strictEqual(canopyStyle.color, '#111111');
const ruinStyle = renderer.areaStyle('523', {}, screenContext);
assert(ruinStyle.dashArray, 'Ruinens kontur ska vara streckad');
assert.strictEqual(ruinStyle.fillOpacity, 0);
assert.strictEqual(renderer.areaStyle('407', {}, screenContext).fillColor, '#b6d9a5');
assert.strictEqual(renderer.areaStyle('409', {}, screenContext).fillColor, '#72b96f');
const stairStyle = renderer.lineStyles('532', {}, screenContext);
assert(stairStyle.inner, 'Trappan ska ha två räcken med vitt mellanrum');
const highTowerMarkup = renderer.pointMarkup('524', screenContext).html;
assert(highTowerMarkup.includes('H0.4') && highTowerMarkup.includes('V0.4'), 'Högt torn ska ha räta armar');
assert(highTowerMarkup.includes('r="0.15"'), 'Högt torn ska ha en fylld mittpunkt på 0,3 mm');
const smallTowerMarkup = renderer.pointMarkup('525', screenContext).html;
assert(smallTowerMarkup.includes('H0.5') && smallTowerMarkup.includes('V0.5'), 'Litet torn ska vara en 1,0 × 1,0 mm T-symbol');
const cairnMarkup = renderer.pointMarkup('526', screenContext).html;
assert.strictEqual((cairnMarkup.match(/<circle/g) || []).length, 2, 'Röse ska ha ring och mittpunkt');
const fodderRackMarkup = renderer.pointMarkup('527', screenContext).html;
assert(fodderRackMarkup.includes('L0,-0.096') && fodderRackMarkup.includes('V0.45'), 'Foderhäcken ska ha 0,354 mm takhöjd och 0,9 mm totalhöjd');
const prominentRingMarkup = renderer.pointMarkup('530', screenContext).html;
assert(prominentRingMarkup.includes('<circle') && prominentRingMarkup.includes('r="0.32"'), 'ISOM 530 ska vara en 0,8 mm ring med 0,16 mm linje');
const prominentXMarkup = renderer.pointMarkup('531', screenContext).html;
assert(prominentXMarkup.includes('M-0.4,-0.4 L0.4,0.4'), 'ISOM 531 ska vara ett 0,8 × 0,8 mm kryss');
const largeTreeMarkup = renderer.pointMarkup('417', screenContext).html;
assert.strictEqual((largeTreeMarkup.match(/<circle/g) || []).length, 2, 'Stort träd ska ha vit mask och grön ring');
const bushTreeMarkup = renderer.pointMarkup('418', screenContext).html;
assert(bushTreeMarkup.includes('fill="#ffffff"'), 'Buske eller träd ska ha vit mitt');
const vegetationFeatureMarkup = renderer.pointMarkup('419', screenContext).html;
assert.strictEqual((vegetationFeatureMarkup.match(/<path/g) || []).length, 2, 'Vegetationsobjektet ska ha vit mask under grönt kryss');

const center = {lat: 59.2, lng: 18.1};
const shortPath = {
  type: 'Feature', id: 'short', properties: {isomSymbol: '506', name: 'Kort stig'},
  geometry: {type: 'LineString', coordinates: [[18.1, 59.2], [18.10001, 59.2]]}
};
let check = renderer.preflight([shortPath], {scale: 10000, declination: null, center, widthMm: 277, heightMm: 190});
assert(check.issues.some(issue => issue.code === 'declination-missing'));
assert(check.issues.some(issue => issue.code === 'minimum-length'));
for (const symbol of ['528', '529']) {
  check = renderer.preflight([{...shortPath, properties: {isomSymbol: symbol, name: `Kort ISOM ${symbol}`}}], {scale: 10000, declination: 8.5, center, widthMm: 277, heightMm: 190});
  assert(check.issues.some(issue => issue.code === 'minimum-length'), `ISOM ${symbol} ska kontrolleras mot sin minimilängd`);
}

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
for (const symbol of ['522', '523']) {
  check = renderer.preflight([{...tinyArea, properties: {isomSymbol: symbol, name: `För liten ISOM ${symbol}`}}], {scale: 10000, declination: 8.5, center, widthMm: 277, heightMm: 190});
  assert(check.issues.some(issue => issue.code === 'minimum-area'), `ISOM ${symbol} ska kontrolleras mot sitt minsta yttermått`);
}
check = renderer.preflight([{...tinyArea, properties: {isomSymbol: '206', name: 'För liten jättesten'}}], {scale: 10000, declination: 8.5, center, widthMm: 277, heightMm: 190});
assert(check.issues.some(issue => issue.code === 'minimum-area' && Math.abs(issue.requiredMm2 - 0.675) < 1e-9), 'ISOM 206 ska skala minsta area proportionellt vid 1:10 000');
check = renderer.preflight([{...shortPath, properties: {isomSymbol: '999'}}], {scale: 10000, declination: 8.5, center, widthMm: 277, heightMm: 190});
assert(check.issues.some(issue => issue.code === 'renderer-missing'));

const road = {...shortPath, id: 'road', properties: {isomSymbol: '502', widthMetres: 6}};
const railway = {...shortPath, id: 'railway', properties: {isomSymbol: '509'}};
const gully = {...shortPath, id: 'gully', properties: {isomSymbol: '108'}};
const cliff = {...shortPath, id: 'cliff', properties: {isomSymbol: '201', downhillSide: 'right'}, geometry: {type: 'LineString', coordinates: [[18.0999, 59.2], [18.1001, 59.2]]}};
const powerLine = {...shortPath, id: 'power', properties: {isomSymbol: '511', source: 'manual', supportCount: 1}, geometry: {type: 'LineString', coordinates: [[18.0999, 59.2], [18.1001, 59.2]]}};
const powerSupport = {type: 'Feature', id: 'power:support:1', properties: {isomSymbol: '511', featureKind: 'support', angleDegrees: 0, largeMast: false}, geometry: {type: 'Point', coordinates: [18.1, 59.2]}};
const wall = {...shortPath, id: 'wall', properties: {isomSymbol: '513.1'}, geometry: {type: 'LineString', coordinates: [[18.0998, 59.1999], [18.1002, 59.1999]]}};
const fence = {...shortPath, id: 'fence', properties: {isomSymbol: '516', tagSide: 'right'}, geometry: {type: 'LineString', coordinates: [[18.0998, 59.2001], [18.1002, 59.2001]]}};
const retainingWall = {...wall, id: 'retaining-wall', properties: {isomSymbol: '513.2', lowerSide: 'right'}};
const ruinedWall = {...wall, id: 'ruined-wall', properties: {isomSymbol: '514'}};
const impassableWall = {...wall, id: 'impassable-wall', properties: {isomSymbol: '515'}};
const ruinedFence = {...fence, id: 'ruined-fence', properties: {isomSymbol: '517', tagSide: 'right'}};
const impassableFence = {...fence, id: 'impassable-fence', properties: {isomSymbol: '518', tagSide: 'right'}};
const crossing = {type: 'Feature', id: 'crossing', properties: {isomSymbol: '519', parentObjectId: 'impassable-wall', parentSymbol: '515', angleDegrees: 0, breakBarrier: true}, geometry: {type: 'Point', coordinates: [18.1, 59.1999]}};
const canopy = {...building, id: 'canopy', properties: {isomSymbol: '522'}};
const ruin = {...building, id: 'ruin', properties: {isomSymbol: '523'}};
const smallTower = {type: 'Feature', id: 'small-tower', properties: {isomSymbol: '525'}, geometry: {type: 'Point', coordinates: [18.1002, 59.2]}};
const cairn = {type: 'Feature', id: 'cairn', properties: {isomSymbol: '526'}, geometry: {type: 'Point', coordinates: [18.1003, 59.2]}};
const fodderRack = {type: 'Feature', id: 'fodder-rack', properties: {isomSymbol: '527'}, geometry: {type: 'Point', coordinates: [18.1004, 59.2]}};
const prominentLine = {...wall, id: 'prominent-line', properties: {isomSymbol: '528'}};
const prominentUncrossableLine = {...wall, id: 'prominent-uncrossable-line', properties: {isomSymbol: '529'}};
const prominentRing = {type: 'Feature', id: 'prominent-ring', properties: {isomSymbol: '530'}, geometry: {type: 'Point', coordinates: [18.1005, 59.2]}};
const prominentX = {type: 'Feature', id: 'prominent-x', properties: {isomSymbol: '531'}, geometry: {type: 'Point', coordinates: [18.1006, 59.2]}};
const slowVisibleVegetation = {...building, id: 'slow-visible-vegetation', properties: {isomSymbol: '407'}};
const walkVisibleVegetation = {...building, id: 'walk-visible-vegetation', properties: {isomSymbol: '409'}};
const largeTree = {type: 'Feature', id: 'large-tree', properties: {isomSymbol: '417'}, geometry: {type: 'Point', coordinates: [18.1007, 59.2]}};
const bushTree = {type: 'Feature', id: 'bush-tree', properties: {isomSymbol: '418'}, geometry: {type: 'Point', coordinates: [18.1008, 59.2]}};
const vegetationFeature = {type: 'Feature', id: 'vegetation-feature', properties: {isomSymbol: '419'}, geometry: {type: 'Point', coordinates: [18.1009, 59.2]}};
const stairway = {...wall, id: 'stairway', properties: {isomSymbol: '532'}};
const label = {...shortPath, id: 'label', properties: {isomSymbol: '101', mapText: '42,5', labelCoordinate: [center.lng, center.lat], textHeightMm: 1.5}};
const svg = renderer.buildVectorSvg([building, canopy, ruin, slowVisibleVegetation, walkVisibleVegetation, smallTower, cairn, fodderRack, prominentLine, prominentUncrossableLine, prominentRing, prominentX, largeTree, bushTree, vegetationFeature, stairway, road, railway, gully, cliff, powerLine, powerSupport, wall, fence, retainingWall, ruinedWall, impassableWall, ruinedFence, impassableFence, crossing, label], {scale: 10000, declination: 8.5, center, widthMm: 277, heightMm: 190});
assert(svg.startsWith('<svg'));
assert(svg.includes('symbolRegistryVersion'));
assert(svg.includes('data-colour="black"'));
assert(svg.includes('data-colour="white"'), 'Vita läsbarhetsmasker ska ligga i eget färglager');
assert(Math.abs(renderer.paperMm(registry.technical['601'].lineWidthBlackMm, 10000) - 0.15) < 1e-9);
assert(svg.includes('<path'));
assert(svg.includes('data-composite-symbol="502"'));
assert(svg.includes('data-composite-symbol="509"'));
assert(svg.includes('stroke-dasharray="1.5 0.75"'));
assert(svg.includes('stroke-dasharray="0 '));
assert(svg.includes('data-orientation="magnetic-north"'));
assert((svg.match(/stroke-linecap="round"/g) || []).length >= 2, 'Branttaggar eller punktlinje saknas');
assert(svg.includes('rotate(81.5)'), 'Stödmarkeringen ska roteras vinkelrätt mot ledningen och kartrotationen');
assert(svg.includes('data-decoration-symbol="513.1"'), 'Murens punkter saknas i vektorutskriften');
assert(svg.includes('data-decoration-symbol="516"'), 'Staketets ensidiga taggar saknas i vektorutskriften');
for (const symbol of ['513.2', '514', '515', '517', '518']) assert(svg.includes(`data-decoration-symbol="${symbol}"`), `Dekoration saknas för ISOM ${symbol}`);
for (const symbol of ['528', '529']) assert(svg.includes(`data-decoration-symbol="${symbol}"`), `45-gradersmarkeringar saknas för ISOM ${symbol}`);
assert(svg.includes('url(#p-vertical-green-407)'), 'ISOM 407-skärmen saknas');
assert(svg.includes('url(#p-vertical-green-409)'), 'ISOM 409-skärmen saknas');
assert(svg.includes('data-decoration-symbol="532"'), 'Trappstegen saknas');
assert(svg.includes('stroke-dasharray="2.4749999999999996 0.5249999999999999"') || svg.includes('stroke-dasharray="2.475 0.525"'), 'Raserad barriär ska ha 1,65/0,35 mm-mönster');
assert(svg.includes('rotate(-8.5)'), 'Passage 519 ska följa barriärens och kartans riktning');
assert(svg.includes('<rect'), 'Linjemask för passage 519 saknas');
assert(svg.includes('data-colour="black20"'), 'Skärmtakets svarta 20 %-fyllning saknas');
assert(svg.includes('stroke-dasharray="0.75 0.375"'), 'Ruinens 0,5/0,25 mm-kontur saknas');
check = renderer.preflight([{...powerLine, properties: {...powerLine.properties, supportCount: 0}}], {scale: 10000, declination: 8.5, center, widthMm: 277, heightMm: 190});
assert(check.issues.some(issue => issue.code === 'support-missing'));
check = renderer.preflight([{...fence, properties: {isomSymbol: '516'}}], {scale: 10000, declination: 8.5, center, widthMm: 277, heightMm: 190});
assert(check.issues.some(issue => issue.code === 'direction-missing'));
check = renderer.preflight([{...retainingWall, properties: {isomSymbol: '513.2'}}, {...crossing, properties: {isomSymbol: '519'}}], {scale: 10000, declination: 8.5, center, widthMm: 277, heightMm: 190});
assert(check.issues.some(issue => issue.code === 'direction-missing'));
assert(check.issues.some(issue => issue.code === 'crossing-unlinked'));

console.log('ISOM renderer: alla kontroller godkända');
