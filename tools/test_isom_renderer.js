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
assert.strictEqual(registry.registryVersion, 13);
assert.strictEqual(registry.renderingRevision, 13);
const expectedSymbols = [
  '101','102','103','104','105.1','105.2','106','107','108','109','110','111','112','113','114','115',
  '201','202','203.1','203.2','204','205','206','207','208','209','210','211','212','213','214','215',
  '301','302','303','304','305','306','307','308','309','310','311','312','313',
  '401','402','403','404','405','406','407','408','409','410','412','413','414','415','416','417','418','419',
  '501','502','503','504','505','506','507','508','509','510','511','512','513.1','513.2','514','515','516','517','518','519','520','521','522','523','524','525','526','527','528','529','530','531','532',
  '601','602','603','701','702','703','704','705','706','707','708','709','710','711','712','713','715'
];
const expectedSwedishNames = [
  'Höjdkurva','Stödkurva','Hjälpkurva','Skärning','Jordvall','Stödmur av jord','Otydlig jordvall','Erosionsfåra','Liten fåra eller torrt dike','Punkthöjd','Avlång punkthöjd','Liten grop','Liten grop med branta sidor','Småkuperad terräng','Mycket småkuperad terräng','Tydligt terrängföremål',
  'Opasserbar brant','Passerbar brant','Stenig grop eller grotta','Farlig grop','Sten','Stor sten','Gigantisk sten eller stenpelare','Grupp av stenar','Blockterräng','Tät blockterräng','Stenig mark, löphindrande','Stenig mark, svårlöpt','Stenig mark, svårframkomlig','Sandområde','Berg i dagen','Värn',
  'Opasserbar vattenyta','Grund vattenyta','Vattenhål','Passerbart vattendrag','Passerbart litet vattendrag','Mindre vattendrag','Opasserbar sankmark','Sankmark','Smal sankmark','Otydlig sankmark','Brunn, fontän eller vattentank','Källa','Tydligt vattenföremål',
  'Öppen lättlöpt mark','Öppen lättlöpt mark med spridda träd','Öppen mark med normal löpbarhet','Öppen mark med normal löpbarhet och spridda träd','Skog','Skog, löphindrande','Undervegetation, löphindrande, god sikt','Skog, svårlöpt','Undervegetation, svårlöpt, god sikt','Skog, svårframkomlig','Odlad mark','Fruktodling','Vingård eller liknande','Exakt begränsningslinje','Tydlig beståndsgräns','Tydligt stort träd','Tydligt träd eller buske','Tydligt vegetationsföremål',
  'Belagd yta','Bred väg','Väg','Körväg','Stor stig','Liten stig','Liten otydlig stig','Rågång, drivningsväg eller annan smal öppning','Järnväg','Kraftledning, linbana eller skidlift','Större kraftledning','Bro/tunnel','Mur','Stödmur/terrass','Otydlig mur','Opasserbar mur','Stängsel','Raserat stängsel','Opasserbart stängsel','Genomgång','Förbjudet område','Byggnad','Skärmtak','Ruin','Högt torn','Litet torn','Röse','Foderhäck','Tydligt linjeföremål','Tydligt opasserbart linjeföremål','Tydligt människoframställt föremål – ring','Tydligt människoframställt föremål – x','Trappa',
  'Magnetisk nordlinje','Passmärken','Höjdangivelse','Start','Kartutdelningsplats','Kontroller','Kontrollsiffror','Sammanbindningslinjer','Mål','Snitslade delar','Gräns förbjuden att passera','Förbjudet område','Passeringspunkt','Förbjuden väg','Första hjälpen-plats','Vätskeplats','Startpunkt efter kartbyte'
];
assert.strictEqual(expectedSwedishNames.length, expectedSymbols.length);
expectedSymbols.forEach((symbol,index)=>assert.strictEqual(registry.symbols[symbol].nameSv,expectedSwedishNames[index],`Fel svenskt normnamn för ISOM ${symbol}`));
assert.deepStrictEqual(Object.keys(registry.symbols).sort((a,b) => a.localeCompare(b, undefined, {numeric: true})), expectedSymbols.slice().sort((a,b) => a.localeCompare(b, undefined, {numeric: true})), 'Symbolregistret ska täcka hela ISOM 2017-2 rev. 6');
for (const symbol of expectedSymbols) assert(renderer.definition(symbol), `ISOM ${symbol} saknar renderer`);
const selectableSymbols = new Set(Object.values(registry.manualTypes).filter(item=>item.selectable).map(item=>String(item.symbol)));
for(const symbol of expectedSymbols.filter(symbol=>!['101','102','601'].includes(symbol)))assert(selectableSymbols.has(symbol),`ISOM ${symbol} saknas i den manuella symbolväljaren`);
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
assert(renderer.pointMarkup('511', screenContext, {}).html.includes('<rect'), 'Stor mast ska vara standard när äldre 511-data saknar explicit masttyp');
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

assert.deepStrictEqual(registry.renderers['103'].dashMm, [2, 0.2]);
assert.strictEqual(registry.renderers['104'].lineWidthMm, 0.25);
assert.strictEqual(registry.renderers['107'].minimumLengthMm, 1.15);
assert.strictEqual(registry.renderers['113'].dotDiameterMm, 0.2);
assert.strictEqual(registry.renderers['208'].minimumSymbols, 2);
assert.strictEqual(registry.renderers['213'].patternAngleDeg, 45);
assert.strictEqual(registry.renderers['214'].fill, 'black35');
assert.strictEqual(registry.renderers['215'].lineCentreGapMm, 0.2);
assert.deepStrictEqual(registry.renderers['416'].dashMm, [0.3, 0.2]);
assert.deepStrictEqual(registry.renderers['508'].dashMm, [2, 0.25]);
assert.strictEqual(registry.renderers['512'].minimumLengthMm, 0.4);
assert.strictEqual(registry.renderers['602'].widthMm, 4);
assert.strictEqual(registry.renderers['603'].textHeightMm, 1.5);
assert.strictEqual(registry.renderers['701'].widthMm, 6);
assert.strictEqual(registry.renderers['703'].diameterMm, 5);
assert.strictEqual(registry.renderers['704'].textHeightMm, 4);
assert.strictEqual(registry.renderers['706'].innerDiameterMm, 4);
assert.deepStrictEqual(registry.renderers['707'].dashMm, [2, 0.5]);
assert.deepStrictEqual(registry.renderers['709'].minimumBoxMm, [3, 3]);
assert.strictEqual(registry.renderers['712'].barWidthMm, 1.33);
assert.strictEqual(registry.renderers['713'].baseWidthMm, 2.1);
assert.strictEqual(registry.renderers['715'].diameterMm, 6);
assert((renderer.pointMarkup('115', screenContext).html.match(/M/g) || []).length >= 3, 'ISOM 115 ska vara en brun stjärna');
assert(renderer.pointMarkup('701', screenContext, {orientationDegrees: 90}).html.includes('<polygon'), 'Starten ska vara en riktad triangel');
assert.strictEqual((renderer.pointMarkup('706', screenContext).html.match(/<circle/g) || []).length, 2, 'Målet ska vara en dubbelring');
assert(renderer.pointMarkup('712', screenContext).html.includes('<path'), 'Första hjälpen ska vara ett fyllt kors');
assert(renderer.pointMarkup('713', screenContext).html.includes('<path'), 'Vätskeplatsen ska vara en bägare');
assert(renderer.pointMarkup('715', screenContext).html.includes('<polygon'), 'Start efter kartbyte ska innehålla en triangel');
assert.strictEqual(renderer.lineStyles('215', {}, screenContext).parallelSeparationMm, 0.2, 'Värnet ska vara en dubbel 0,10 mm-linje med 0,10 mm mellanrum');
assert(renderer.lineStyles('416', {variant: 'black-dots'}, screenContext).outer.dashArray, 'Svart punktvariant för beståndsgräns saknas');
assert(renderer.lineStyles('508', {runnability: 'slow'}, screenContext).background, 'Rågångens löpbarhetsbakgrund saknas');

const remainingAreaSymbols = ['113','114','208','209','210','211','212','213','214','413','414','709'];
const remainingLineSymbols = ['103','104','105.1','105.2','106','107','215','416','508','512','705','707','708','711'];
const remainingPointSymbols = ['115','602','603','701','702','703','704','706','710','712','713','715'];
const remainingFeatures = [
  ...remainingAreaSymbols.map((symbol, index) => ({...building, id: `area-${symbol}`, properties: {isomSymbol: symbol, background: index % 2 ? 'yellow50' : 'yellow'}})),
  ...remainingLineSymbols.map(symbol => ({...wall, id: `line-${symbol}`, properties: {isomSymbol: symbol, downhillSide: 'right', lowerSide: 'right', variant: symbol === '416' ? 'black-dots' : undefined, runnability: symbol === '508' ? 'slow' : undefined}, geometry: {type: 'LineString', coordinates: [[18.099,59.2],[18.101,59.2]]}})),
  ...remainingPointSymbols.map((symbol, index) => ({type: 'Feature', id: `point-${symbol}`, properties: {isomSymbol: symbol, orientationDegrees: 25, elevation: 123, controlNumber: 8}, geometry: {type: 'Point', coordinates: [18.1001 + index * .00001, 59.2002]}}))
];
const remainingSvg = renderer.buildVectorSvg(remainingFeatures, {scale: 15000, declination: 5, center, widthMm: 277, heightMm: 190});
for (const pattern of ['random-dots-brown','boulders','sand','orchard-yellow50','vineyard-yellow','forbidden-crosshatch']) assert(remainingSvg.includes(`url(#p-${pattern})`), `Ytmönster ${pattern} saknas`);
for (const symbol of ['105.1','105.2','106','512','711']) assert(remainingSvg.includes(`data-decoration-symbol="${symbol}"`), `Dekoration saknas för nytillagd ISOM ${symbol}`);
assert(remainingSvg.includes('data-composite-symbol="215"'), 'Värnets dubbellinje saknas');
assert(remainingSvg.includes('data-composite-symbol="508"'), 'Rågångens bakgrundslinje saknas');
assert(remainingSvg.includes('data-colour="purpleLower"') && remainingSvg.includes('data-colour="purpleUpper"'), 'Banpåtryckets lila över- och underlager ska vara separata');
const orientedVineyard = {...building, id:'oriented-vineyard', properties:{isomSymbol:'414',orientationDegrees:37,background:'yellow50'}};
const orientedSvg = renderer.buildVectorSvg([orientedVineyard], {scale:15000,declination:5,center,widthMm:277,heightMm:190});
assert(orientedSvg.includes('patternTransform="rotate(37)"'), 'Vingårdens rader ska kunna riktas efter planteringsriktningen');
check = renderer.preflight([{...orientedVineyard, properties:{isomSymbol:'414'}}], {scale:15000,declination:5,center,widthMm:277,heightMm:190});
assert(check.issues.some(issue=>issue.code==='orientation-missing'), 'Vingård utan planteringsriktning ska ge preflightvarning');
check = renderer.preflight([{type:'Feature',id:'undefined-special',properties:{isomSymbol:'115'},geometry:{type:'Point',coordinates:[18.1,59.2]}}], {scale:15000,declination:5,center,widthMm:277,heightMm:190});
assert(check.issues.some(issue=>issue.code==='definition-missing'&&issue.severity==='error'), 'Särskilt objekt utan teckenförklaring ska blockera preflight');

console.log('ISOM renderer: alla kontroller godkända');
