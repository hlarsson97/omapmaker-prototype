const CLIFF_SYMBOLS = new Set(['201', '202']);
const POWER_LINE_SYMBOLS = new Set(['510', '511']);
const DECORATED_BARRIER_SYMBOLS = new Set(['513.1', '513.2', '514', '515', '516', '517', '518']);
const IMPASSABLE_BARRIER_SYMBOLS = new Set(['515', '518']);
const METRES_PER_DEGREE = 111320;

export function isCliffSymbol(symbol) {
  return CLIFF_SYMBOLS.has(String(symbol || ''));
}

export function isPowerLineSymbol(symbol) {
  return POWER_LINE_SYMBOLS.has(String(symbol || ''));
}

export function isDecoratedBarrierSymbol(symbol) {
  return DECORATED_BARRIER_SYMBOLS.has(String(symbol || ''));
}

export function isBarrierLineSymbol(symbol) {
  return DECORATED_BARRIER_SYMBOLS.has(String(symbol || ''));
}

export function isImpassableBarrierSymbol(symbol) {
  return IMPASSABLE_BARRIER_SYMBOLS.has(String(symbol || ''));
}

export function applyDefaultSymbolSettings(object, symbol) {
  const value = String(symbol || object.symbol || '');
  if (isCliffSymbol(value) && !['left', 'right'].includes(object.downhillSide)) object.downhillSide = 'right';
  if (isPowerLineSymbol(value) && !Array.isArray(object.supports)) object.supports = [];
  if (value === '513.2' && !['left', 'right'].includes(object.lowerSide)) object.lowerSide = 'right';
  if (['516', '517', '518'].includes(value) && !['left', 'right'].includes(object.tagSide)) object.tagSide = 'right';
  return object;
}

export function symbolObjectControlsHtml(object, escapeHtml) {
  const symbol = String(object.symbol || '');
  const id = escapeHtml(object.id);
  if (isCliffSymbol(symbol)) {
    const selected = object.downhillSide;
    const button = (side, label) => `<button type="button" class="${selected === side ? 'selected' : ''}" data-symbol-object-action="cliff-side" data-object-id="${id}" data-symbol-setting-value="${side}">${label}</button>`;
    return `<div class="symbol-object-settings"><small>Taggarna pekar nedför, räknat i linjens ritningsriktning</small><div class="symbol-setting-options">${button('left', 'Vänster sida')}${button('right', 'Höger sida')}</div></div>`;
  }
  if (isPowerLineSymbol(symbol)) {
    const supports = Array.isArray(object.supports) ? object.supports : [];
    const normalLabel = symbol === '511' ? 'Placera mast' : 'Placera stolpe';
    const large = symbol === '511' ? `<button type="button" data-symbol-object-action="add-support" data-object-id="${id}" data-support-large="true">Placera stor mast</button>` : '';
    return `<div class="symbol-object-settings"><small>${supports.length} ${supports.length === 1 ? 'stöd' : 'stöd'} placerade exakt på linjen</small><div class="symbol-setting-options"><button type="button" data-symbol-object-action="add-support" data-object-id="${id}">${normalLabel}</button>${large}</div></div>`;
  }
  if (['516', '517', '518'].includes(symbol)) {
    const selected = object.tagSide;
    const button = (side, label) => `<button type="button" class="${selected === side ? 'selected' : ''}" data-symbol-object-action="fence-side" data-object-id="${id}" data-symbol-setting-value="${side}">${label}</button>`;
    return `<div class="symbol-object-settings"><small>Taggarnas sida, räknat i linjens ritningsriktning. För inhägnader ska de peka inåt.</small><div class="symbol-setting-options">${button('left', 'Vänster sida')}${button('right', 'Höger sida')}</div></div>`;
  }
  if (symbol === '513.2') {
    const selected = object.lowerSide;
    const button = (side, label) => `<button type="button" class="${selected === side ? 'selected' : ''}" data-symbol-object-action="retaining-wall-side" data-object-id="${id}" data-symbol-setting-value="${side}">${label}</button>`;
    return `<div class="symbol-object-settings"><small>Halvpunkterna ska peka mot den lägre sidan, räknat i linjens ritningsriktning.</small><div class="symbol-setting-options">${button('left', 'Lägre till vänster')}${button('right', 'Lägre till höger')}</div></div>`;
  }
  if (symbol === '519') {
    const selected = Boolean(object.breakBarrier);
    const linked = object.parentObjectId ? `Kopplad till ISOM ${escapeHtml(object.parentSymbol || '')}` : 'Inte kopplad till en lokal barriär';
    const button = (value, label) => `<button type="button" class="${selected === value ? 'selected' : ''}" data-symbol-object-action="crossing-break" data-object-id="${id}" data-symbol-setting-value="${value}">${label}</button>`;
    return `<div class="symbol-object-settings"><small>${linked}</small><div class="symbol-setting-options">${button(true, 'Bryt barriärlinjen')}${button(false, 'Behåll barriärlinjen')}</div></div>`;
  }
  return '';
}

function projection(latitude) {
  const cos = Math.max(0.01, Math.cos(Number(latitude) * Math.PI / 180));
  return {
    toMetres: coordinate => ({x: Number(coordinate[0]) * METRES_PER_DEGREE * cos, y: Number(coordinate[1]) * METRES_PER_DEGREE}),
    toCoordinate: point => [point.x / (METRES_PER_DEGREE * cos), point.y / METRES_PER_DEGREE]
  };
}

export function nearestPointOnLine(coordinates, coordinate) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const project = projection(coordinate?.[1] ?? coordinates[0][1]);
  const target = project.toMetres(coordinate);
  let best = null;
  for (let index = 1; index < coordinates.length; index++) {
    const a = project.toMetres(coordinates[index - 1]);
    const b = project.toMetres(coordinates[index]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) continue;
    const t = Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / lengthSquared));
    const point = {x: a.x + t * dx, y: a.y + t * dy};
    const distanceSquared = (target.x - point.x) ** 2 + (target.y - point.y) ** 2;
    if (!best || distanceSquared < best.distanceSquared) best = {point, distanceSquared, segmentIndex: index - 1, angleDegrees: Math.atan2(dy, dx) * 180 / Math.PI};
  }
  return best ? {...best, coordinate: project.toCoordinate(best.point)} : null;
}

export function nearestBarrierAttachment(barriers, coordinate, maxDistanceMetres = 25) {
  let best = null;
  for (const barrier of barriers || []) {
    if (!isBarrierLineSymbol(barrier.symbol)) continue;
    const snapped = nearestPointOnLine(barrier.coordinates, coordinate);
    if (!snapped || snapped.distanceSquared > maxDistanceMetres * maxDistanceMetres || best && snapped.distanceSquared >= best.snapped.distanceSquared) continue;
    best = {barrier, snapped};
  }
  return best;
}

export function snapPowerSupports(object) {
  if (!Array.isArray(object.supports)) return object;
  object.supports = object.supports.map(support => {
    const snapped = nearestPointOnLine(object.coordinates, support.coordinates);
    return snapped ? {...support, coordinates: snapped.coordinate, angleDegrees: snapped.angleDegrees} : support;
  });
  return object;
}

export function cliffTagSegments(coordinates, definition, downhillSide, baseScale = 15000) {
  if (!Array.isArray(coordinates) || coordinates.length < 2 || !['left', 'right'].includes(downhillSide)) return [];
  const spacing = Number(definition?.tagSpacingMm || 0) * Number(baseScale) / 1000;
  const tagLength = Number(definition?.tagLengthMm || 0) * Number(baseScale) / 1000;
  if (!(spacing > 0) || !(tagLength > 0)) return [];
  const latitude = coordinates.reduce((sum, coordinate) => sum + Number(coordinate[1]), 0) / coordinates.length;
  const project = projection(latitude);
  const points = coordinates.map(project.toMetres);
  const result = [];
  let next = spacing / 2;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1];
    const b = points[index];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (!length) continue;
    while (next <= length) {
      const start = {x: a.x + dx * next / length, y: a.y + dy * next / length};
      const side = downhillSide === 'right' ? 1 : -1;
      const end = {x: start.x + side * dy / length * tagLength, y: start.y - side * dx / length * tagLength};
      result.push([project.toCoordinate(start), project.toCoordinate(end)]);
      next += spacing;
    }
    next -= length;
  }
  return result;
}

function sampledLinePoints(coordinates, spacing, initialOffset = spacing / 2) {
  if (!Array.isArray(coordinates) || coordinates.length < 2 || !(spacing > 0)) return [];
  const latitude = coordinates.reduce((sum, coordinate) => sum + Number(coordinate[1]), 0) / coordinates.length;
  const project = projection(latitude);
  const points = coordinates.map(project.toMetres);
  const result = [];
  let next = initialOffset;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1];
    const b = points[index];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (!length) continue;
    while (next <= length) {
      const point = {x: a.x + dx * next / length, y: a.y + dy * next / length};
      result.push({coordinate: project.toCoordinate(point), point, angle: Math.atan2(dy, dx), toCoordinate: project.toCoordinate});
      next += spacing;
    }
    next -= length;
  }
  return result;
}

export function wallDotCoordinates(coordinates, definition, baseScale = 15000) {
  const spacing = Number(definition?.styleSpacingMm || 0) * Number(baseScale) / 1000;
  const offset = Number(definition?.styleOffsetMm || definition?.styleSpacingMm / 2 || 0) * Number(baseScale) / 1000;
  return sampledLinePoints(coordinates, spacing, offset).map(sample => sample.coordinate);
}

function offsetSample(sample, distance) {
  const point = {x: sample.point.x + Math.cos(sample.angle) * distance, y: sample.point.y + Math.sin(sample.angle) * distance};
  return {...sample, point, coordinate: sample.toCoordinate(point)};
}

function groupedSamples(coordinates, definition, baseScale) {
  const scale = Number(baseScale) / 1000;
  const spacing = Number(definition?.groupSpacingMm || 0) * scale;
  const offset = Number(definition?.groupOffsetMm || definition?.groupSpacingMm / 2 || 0) * scale;
  const halfWithin = Number(definition?.withinGroupSpacingMm || 0) * scale / 2;
  return sampledLinePoints(coordinates, spacing, offset).flatMap(sample => [offsetSample(sample, -halfWithin), offsetSample(sample, halfWithin)]);
}

export function groupedWallDotCoordinates(coordinates, definition, baseScale = 15000) {
  return groupedSamples(coordinates, definition, baseScale).map(sample => sample.coordinate);
}

export function retainingWallHalfDotPolygons(coordinates, definition, lowerSide, baseScale = 15000) {
  if (!['left', 'right'].includes(lowerSide)) return [];
  const scale = Number(baseScale) / 1000;
  const spacing = Number(definition?.styleSpacingMm || 0) * scale;
  const offset = Number(definition?.styleOffsetMm || definition?.styleSpacingMm / 2 || 0) * scale;
  const radius = Number(definition?.styleDiameterMm || 0) * scale / 2;
  const sideOffset = Number(definition?.sideOffsetMm || 0) * scale;
  const side = lowerSide === 'right' ? -1 : 1;
  return sampledLinePoints(coordinates, spacing, offset).map(sample => {
    const tangent = {x: Math.cos(sample.angle), y: Math.sin(sample.angle)};
    const normal = {x: -tangent.y * side, y: tangent.x * side};
    const center = {x: sample.point.x + normal.x * sideOffset, y: sample.point.y + normal.y * sideOffset};
    const polygon = [];
    for (let step = 0; step <= 8; step++) {
      const angle = Math.PI - step * Math.PI / 8;
      polygon.push(sample.toCoordinate({x: center.x + tangent.x * radius * Math.cos(angle) + normal.x * radius * Math.sin(angle), y: center.y + tangent.y * radius * Math.cos(angle) + normal.y * radius * Math.sin(angle)}));
    }
    return polygon;
  });
}

export function fenceTagSegments(coordinates, definition, tagSide, baseScale = 15000) {
  if (!['left', 'right'].includes(tagSide)) return [];
  const spacing = Number(definition?.styleSpacingMm || 0) * Number(baseScale) / 1000;
  const tagLength = Number(definition?.tagLengthMm || 0) * Number(baseScale) / 1000;
  const angleOffset = (tagSide === 'right' ? -1 : 1) * Number(definition?.tagAngleDeg || 60) * Math.PI / 180;
  const offset = Number(definition?.styleOffsetMm || definition?.styleSpacingMm / 2 || 0) * Number(baseScale) / 1000;
  return sampledLinePoints(coordinates, spacing, offset).map(sample => {
    const end = {x: sample.point.x + Math.cos(sample.angle + angleOffset) * tagLength, y: sample.point.y + Math.sin(sample.angle + angleOffset) * tagLength};
    return [sample.coordinate, sample.toCoordinate(end)];
  });
}

export function groupedFenceTagSegments(coordinates, definition, tagSide, baseScale = 15000) {
  if (!['left', 'right'].includes(tagSide)) return [];
  const tagLength = Number(definition?.tagLengthMm || 0) * Number(baseScale) / 1000;
  const angleOffset = (tagSide === 'right' ? -1 : 1) * Number(definition?.tagAngleDeg || 60) * Math.PI / 180;
  return groupedSamples(coordinates, definition, baseScale).map(sample => {
    const end = {x: sample.point.x + Math.cos(sample.angle + angleOffset) * tagLength, y: sample.point.y + Math.sin(sample.angle + angleOffset) * tagLength};
    return [sample.coordinate, sample.toCoordinate(end)];
  });
}

export function powerSupportFeatures(object, symbol) {
  if (!isPowerLineSymbol(symbol) || !Array.isArray(object.supports)) return [];
  return object.supports.map(support => ({
    type: 'Feature',
    id: `${object.id}:support:${support.id}`,
    properties: {
      symbol: String(symbol),
      isomSymbol: String(symbol),
      symbolRegistryVersion: object.symbolRegistryVersion,
      category: 'point',
      source: object.source,
      featureKind: 'support',
      parentObjectId: object.id,
      supportId: support.id,
      supportType: support.supportType,
      angleDegrees: support.angleDegrees,
      largeMast: Boolean(support.largeMast)
    },
    geometry: {type: 'Point', coordinates: support.coordinates}
  }));
}
