const CLIFF_SYMBOLS = new Set(['104', '201', '202']);
const POWER_LINE_SYMBOLS = new Set(['510', '511']);
const DECORATED_BARRIER_SYMBOLS = new Set(['105.1', '105.2', '106', '513.1', '513.2', '514', '515', '516', '517', '518']);
const PROMINENT_LINE_SYMBOLS = new Set(['528', '529']);
const STAIRWAY_SYMBOLS = new Set(['532']);
const OTHER_DECORATED_LINE_SYMBOLS = new Set(['512', '711']);
const IMPASSABLE_BARRIER_SYMBOLS = new Set(['515', '518', '529']);
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

export function isDecoratedLineSymbol(symbol) {
  const value = String(symbol || '');
  return DECORATED_BARRIER_SYMBOLS.has(value) || PROMINENT_LINE_SYMBOLS.has(value) || STAIRWAY_SYMBOLS.has(value) || OTHER_DECORATED_LINE_SYMBOLS.has(value);
}

export function isBarrierLineSymbol(symbol) {
  const value = String(symbol || '');
  return DECORATED_BARRIER_SYMBOLS.has(value) || value === '529';
}

export function isImpassableBarrierSymbol(symbol) {
  return IMPASSABLE_BARRIER_SYMBOLS.has(String(symbol || ''));
}

export function applyDefaultSymbolSettings(object, symbol) {
  const value = String(symbol || object.symbol || '');
  if (isCliffSymbol(value) && !['left', 'right'].includes(object.downhillSide)) object.downhillSide = 'right';
  if (isPowerLineSymbol(value) && !Array.isArray(object.supports)) object.supports = [];
  if (['105.2', '513.2'].includes(value) && !['left', 'right'].includes(object.lowerSide)) object.lowerSide = 'right';
  if (['516', '517', '518'].includes(value) && !['left', 'right'].includes(object.tagSide)) object.tagSide = 'right';
  return object;
}

export function symbolObjectControlsHtml(object, escapeHtml) {
  const symbol = String(object.symbol || '');
  const id = escapeHtml(object.id);
  const orientationControls = ['203.1', '413', '414', '701', '710', '715'].includes(symbol) ? `<div class="symbol-object-settings"><label><small>Riktning i grader från kartnorr</small><input type="number" min="0" max="359.9" step="0.1" value="${escapeHtml(Number(object.orientationDegrees) || 0)}" data-symbol-value-property="orientationDegrees" data-object-id="${id}"></label></div>` : '';
  const valueControls = symbol === '603' ? `<div class="symbol-object-settings"><label><small>Höjd i hela meter</small><input type="number" step="1" value="${escapeHtml(Math.round(Number(object.elevation) || 0))}" data-symbol-value-property="elevation" data-object-id="${id}"></label><label><input type="checkbox" data-symbol-value-property="waterSurface" data-object-id="${id}" ${object.waterSurface?'checked':''}> Vattenyta utan punkt</label></div>` : symbol === '704' ? `<div class="symbol-object-settings"><label><small>Kontrollsiffra</small><input type="text" inputmode="numeric" value="${escapeHtml(object.controlNumber || '')}" data-symbol-value-property="controlNumber" data-object-id="${id}"></label></div>` : '';
  const definitionControls = ['115','313','419','528','529','530','531'].includes(symbol) ? `<div class="symbol-object-settings"><label><small>Betydelse i teckenförklaringen (obligatorisk)</small><input type="text" value="${escapeHtml(object.legendDefinition || '')}" data-symbol-value-property="legendDefinition" data-object-id="${id}"></label></div>` : '';
  const choiceButtons = (property, values, labels) => `<div class="symbol-setting-options">${values.map((value,index)=>`<button type="button" class="${String(object[property]??values[0])===value?'selected':''}" data-symbol-object-action="setting-choice" data-symbol-setting-property="${property}" data-symbol-setting-value="${value}" data-object-id="${id}">${labels[index]}</button>`).join('')}</div>`;
  const choiceControls = ['413','414'].includes(symbol) ? `<div class="symbol-object-settings"><small>Bakgrund</small>${choiceButtons('background',['yellow','yellow50'],['Gul 100 %','Gul 50 %'])}</div>` : symbol === '416' ? `<div class="symbol-object-settings"><small>Utförande (samma variant ska användas över hela kartan)</small>${choiceButtons('variant',['green-dashes','black-dots'],['Mörkgröna streck','Svarta punkter'])}</div>` : symbol === '508' ? `<div class="symbol-object-settings"><small>Löpbarhet i öppningen</small>${choiceButtons('runnability',['surrounding','better','normal','slow','walk'],['Som omgivningen','Bättre','Normal','Nedsatt','Gångfart'])}</div>` : '';
  const enclosureControls = isBarrierLineSymbol(symbol) && isClosedLineCoordinates(object.coordinates) ? `<div class="symbol-object-settings"><small>Sluten inhägnad identifierad. Ytan skapas med den områdestyp som är vald i ritverktyget.</small><div class="symbol-setting-options"><button type="button" data-symbol-object-action="create-enclosed-area" data-object-id="${id}">Skapa vald yta innanför</button></div></div>` : '';
  if (isCliffSymbol(symbol)) {
    const selected = object.downhillSide;
    const button = (side, label) => `<button type="button" class="${selected === side ? 'selected' : ''}" data-symbol-object-action="cliff-side" data-object-id="${id}" data-symbol-setting-value="${side}">${label}</button>`;
    return `<div class="symbol-object-settings"><small>Taggarna pekar nedför, räknat i linjens ritningsriktning</small><div class="symbol-setting-options">${button('left', 'Vänster sida')}${button('right', 'Höger sida')}</div></div>`;
  }
  if (isPowerLineSymbol(symbol)) {
    const supports = Array.isArray(object.supports) ? object.supports : [];
    const controls = symbol === '511'
      ? `<button type="button" data-symbol-object-action="add-support" data-object-id="${id}" data-support-large="true">Placera stor kraftledningsmast</button><button type="button" data-symbol-object-action="add-support" data-object-id="${id}" data-support-large="false">Placera mastmarkering</button>`
      : `<button type="button" data-symbol-object-action="add-support" data-object-id="${id}">Placera stolpe</button>`;
    return `<div class="symbol-object-settings"><small>${supports.length} ${supports.length === 1 ? 'stöd' : 'stöd'} placerade exakt på linjen</small><div class="symbol-setting-options">${controls}</div></div>`;
  }
  if (['516', '517', '518'].includes(symbol)) {
    const selected = object.tagSide;
    const button = (side, label) => `<button type="button" class="${selected === side ? 'selected' : ''}" data-symbol-object-action="fence-side" data-object-id="${id}" data-symbol-setting-value="${side}">${label}</button>`;
    return `<div class="symbol-object-settings"><small>Taggarnas sida, räknat i linjens ritningsriktning. För inhägnader ska de peka inåt.</small><div class="symbol-setting-options">${button('left', 'Vänster sida')}${button('right', 'Höger sida')}</div></div>${enclosureControls}`;
  }
  if (['105.2', '513.2'].includes(symbol)) {
    const selected = object.lowerSide;
    const button = (side, label) => `<button type="button" class="${selected === side ? 'selected' : ''}" data-symbol-object-action="retaining-wall-side" data-object-id="${id}" data-symbol-setting-value="${side}">${label}</button>`;
    return `<div class="symbol-object-settings"><small>Halvpunkterna ska peka mot den lägre sidan, räknat i linjens ritningsriktning.</small><div class="symbol-setting-options">${button('left', 'Lägre till vänster')}${button('right', 'Lägre till höger')}</div></div>${enclosureControls}`;
  }
  if (symbol === '519') {
    const selected = Boolean(object.breakBarrier);
    const linked = object.parentObjectId ? `Kopplad till ISOM ${escapeHtml(object.parentSymbol || '')}` : 'Inte kopplad till en lokal barriär';
    const button = (value, label) => `<button type="button" class="${selected === value ? 'selected' : ''}" data-symbol-object-action="crossing-break" data-object-id="${id}" data-symbol-setting-value="${value}">${label}</button>`;
    return `<div class="symbol-object-settings"><small>${linked}</small><div class="symbol-setting-options">${button(true, 'Bryt barriärlinjen')}${button(false, 'Behåll barriärlinjen')}</div></div>`;
  }
  return `${orientationControls}${valueControls}${definitionControls}${choiceControls}${enclosureControls}`;
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

export function parallelLineCoordinates(coordinates, separationMm, baseScale = 15000) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return Array.isArray(coordinates) ? coordinates.slice() : [];
  const latitude = coordinates.reduce((sum, coordinate) => sum + Number(coordinate[1]), 0) / coordinates.length;
  const project = projection(latitude);
  const offset = Number(separationMm || 0) * Number(baseScale || 15000) / 2000;
  const points = coordinates.map(project.toMetres);
  const shift = direction => points.map((point, index) => {
    const previous = points[Math.max(0, index - 1)], next = points[Math.min(points.length - 1, index + 1)];
    const dx = next.x - previous.x, dy = next.y - previous.y, length = Math.hypot(dx, dy) || 1;
    const shifted = {x: point.x - direction * dy / length * offset, y: point.y + direction * dx / length * offset};
    return [...project.toCoordinate(shifted), ...coordinates[index].slice(2)];
  });
  return shift;
}

export function isClosedLineCoordinates(coordinates, toleranceMetres = 0.25) {
  if (!Array.isArray(coordinates) || coordinates.length < 3) return false;
  const first = coordinates[0], last = coordinates.at(-1);
  if (!Array.isArray(first) || !Array.isArray(last)) return false;
  const project = projection((Number(first[1]) + Number(last[1])) / 2);
  const a = project.toMetres(first), b = project.toMetres(last);
  return Math.hypot(b.x - a.x, b.y - a.y) <= Number(toleranceMetres);
}

export function closeLineCoordinates(coordinates, toleranceMetres = 3) {
  if (!isClosedLineCoordinates(coordinates, toleranceMetres)) return {coordinates, closed: false};
  const closed = coordinates.map(coordinate => [...coordinate]);
  closed[closed.length - 1] = [...closed[0]];
  return {coordinates: closed, closed: true};
}

export function lineCoordinatesWithoutGaps(coordinates, gapCoordinates, gapMetres) {
  if (!Array.isArray(coordinates) || coordinates.length < 2 || !Array.isArray(gapCoordinates) || !gapCoordinates.length || !(Number(gapMetres) > 0)) return [coordinates];
  const latitude = coordinates.reduce((sum, coordinate) => sum + Number(coordinate[1]), 0) / coordinates.length;
  const project = projection(latitude), points = coordinates.map(project.toMetres), cumulative = [0];
  for (let index = 1; index < points.length; index++) cumulative.push(cumulative[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y));
  const total = cumulative.at(-1), halfGap = Number(gapMetres) / 2, intervals = [];
  for (const coordinate of gapCoordinates) {
    const target = project.toMetres(coordinate); let best = null;
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1], b = points[index], dx = b.x - a.x, dy = b.y - a.y, lengthSquared = dx * dx + dy * dy;
      if (!lengthSquared) continue;
      const t = Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / lengthSquared)), x = a.x + t * dx, y = a.y + t * dy, distanceSquared = (target.x - x) ** 2 + (target.y - y) ** 2;
      if (!best || distanceSquared < best.distanceSquared) best = {distanceSquared, along: cumulative[index - 1] + Math.sqrt(lengthSquared) * t};
    }
    if (best) intervals.push([Math.max(0, best.along - halfGap), Math.min(total, best.along + halfGap)]);
  }
  intervals.sort((a, b) => a[0] - b[0]); const merged = [];
  for (const interval of intervals) { const previous = merged.at(-1); if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]); else merged.push([...interval]); }
  const visible = []; let cursor = 0;
  for (const [start, end] of merged) { if (start > cursor) visible.push([cursor, start]); cursor = Math.max(cursor, end); }
  if (cursor < total) visible.push([cursor, total]);
  const pointAt = distance => { let index = 1; while (index < cumulative.length && cumulative[index] < distance) index++; index = Math.min(index, cumulative.length - 1); const a = points[index - 1], b = points[index], length = cumulative[index] - cumulative[index - 1], t = length ? (distance - cumulative[index - 1]) / length : 0; return project.toCoordinate({x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t}); };
  return visible.filter(([start, end]) => end - start > 1e-6).map(([start, end]) => { const part = [pointAt(start)]; for (let index = 1; index < coordinates.length - 1; index++) if (cumulative[index] > start && cumulative[index] < end) part.push(coordinates[index].slice(0, 2)); part.push(pointAt(end)); return part; });
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

function chevronSegmentsFromSamples(samples, definition, baseScale) {
  const tagLength = Number(definition?.tagLengthMm || 0) * Number(baseScale) / 1000;
  const angleOffset = Number(definition?.tagAngleDeg || 45) * Math.PI / 180;
  return samples.flatMap(sample => [-1, 1].map(direction => {
    const angle = sample.angle + Math.PI + direction * angleOffset;
    const end = {x: sample.point.x + Math.cos(angle) * tagLength, y: sample.point.y + Math.sin(angle) * tagLength};
    return [sample.coordinate, sample.toCoordinate(end)];
  }));
}

export function prominentLineChevronSegments(coordinates, definition, baseScale = 15000) {
  const spacing = Number(definition?.styleSpacingMm || 0) * Number(baseScale) / 1000;
  const offset = Number(definition?.styleOffsetMm || definition?.styleSpacingMm / 2 || 0) * Number(baseScale) / 1000;
  return chevronSegmentsFromSamples(sampledLinePoints(coordinates, spacing, offset), definition, baseScale);
}

export function groupedProminentLineChevronSegments(coordinates, definition, baseScale = 15000) {
  return chevronSegmentsFromSamples(groupedSamples(coordinates, definition, baseScale), definition, baseScale);
}

export function stairwayStepSegments(coordinates, definition, baseScale = 15000) {
  const scale = Number(baseScale) / 1000;
  const spacing = Number(definition?.stepSpacingMm || 0) * scale;
  const halfWidth = Number(definition?.innerWidthMm || 0) * scale / 2;
  return sampledLinePoints(coordinates, spacing, spacing / 2).map(sample => {
    const normal = {x: -Math.sin(sample.angle) * halfWidth, y: Math.cos(sample.angle) * halfWidth};
    return [sample.toCoordinate({x: sample.point.x - normal.x, y: sample.point.y - normal.y}), sample.toCoordinate({x: sample.point.x + normal.x, y: sample.point.y + normal.y})];
  });
}

export function courseCrossSegments(coordinates, definition, baseScale = 15000) {
  const scale = Number(baseScale) / 1000;
  const spacing = Number(definition?.styleSpacingMm || 5) * scale;
  const halfWidth = Number(definition?.styleWidthMm || 3) * scale / 2;
  const halfHeight = Number(definition?.styleHeightMm || 3) * scale / 2;
  return sampledLinePoints(coordinates, spacing, spacing / 2).flatMap(sample => {
    const tangent = {x: Math.cos(sample.angle), y: Math.sin(sample.angle)};
    const normal = {x: -tangent.y, y: tangent.x};
    const point = (along, across) => sample.toCoordinate({x: sample.point.x + tangent.x * along + normal.x * across, y: sample.point.y + tangent.y * along + normal.y * across});
    return [[point(-halfWidth, -halfHeight), point(halfWidth, halfHeight)], [point(-halfWidth, halfHeight), point(halfWidth, -halfHeight)]];
  });
}

export function bridgeTunnelCurveSegments(coordinates, definition, baseScale = 15000) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return [];
  const latitude = coordinates.reduce((sum, coordinate) => sum + Number(coordinate[1]), 0) / coordinates.length;
  const project = projection(latitude), points = coordinates.map(project.toMetres), scale = Number(baseScale) / 1000;
  const tagLength = Number(definition?.tagLengthMm || .5) * scale;
  const angle = Number(definition?.tagAngleDeg || 60) * Math.PI / 180;
  const along = Math.cos(angle) * tagLength, across = Math.sin(angle) * tagLength;
  const outerPoint = (end, inside, isStart) => {
    const dx = isStart ? inside.x - end.x : end.x - inside.x;
    const dy = isStart ? inside.y - end.y : end.y - inside.y;
    const length = Math.hypot(dx, dy) || 1;
    const axis = {x: dx / length, y: dy / length}, normal = {x: -axis.y, y: axis.x};
    const outward = isStart ? -1 : 1;
    return project.toCoordinate({x: end.x + axis.x * outward * along + normal.x * across, y: end.y + axis.y * outward * along + normal.y * across});
  };
  return [[outerPoint(points[0], points[1], true), ...coordinates.map(coordinate => coordinate.slice(0, 2)), outerPoint(points.at(-1), points.at(-2), false)]];
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
