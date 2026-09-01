const EARTH_METRES_PER_DEGREE = 111320;
const ROAD_PRIORITY = Object.freeze({motorway: 10, trunk: 9, primary: 8, secondary: 7, tertiary: 6, unclassified: 5, residential: 5, service: 4, track: 3, cycleway: 2, footway: 2, path: 1, bridleway: 1});

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function truthyOsm(value) {
  return value != null && !['', 'no', 'false', '0', 'at_grade'].includes(String(value).toLowerCase());
}

function lineCoordinates(feature) {
  return feature?.geometry?.type === 'LineString' && Array.isArray(feature.geometry.coordinates) ? feature.geometry.coordinates : [];
}

function projector(latitude) {
  const xScale = EARTH_METRES_PER_DEGREE * Math.cos(Number(latitude) * Math.PI / 180);
  return {
    toXY: coordinate => ({x: Number(coordinate[0]) * xScale, y: Number(coordinate[1]) * EARTH_METRES_PER_DEGREE}),
    toCoordinate: point => [point.x / xScale, point.y / EARTH_METRES_PER_DEGREE]
  };
}

function segmentIntersection(a, b, c, d, endpointMargin = 0) {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-8) return null;
  const qx = c.x - a.x, qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / denominator, u = (qx * ry - qy * rx) / denominator;
  if (t < endpointMargin || t > 1 - endpointMargin || u < endpointMargin || u > 1 - endpointMargin) return null;
  return {point: {x: a.x + rx * t, y: a.y + ry * t}, t, u, firstUnit: unit(rx, ry), secondUnit: unit(sx, sy)};
}

function unit(x, y) {
  const length = Math.hypot(x, y) || 1;
  return {x: x / length, y: y / length};
}

function distanceSquared(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function featureWidth(feature) {
  const properties = feature?.properties || {};
  return Math.max(1.5, number(properties.renderWidthMetres, number(properties.width, String(properties.isomSymbol) === '502' ? 6 : 3)));
}

function featureId(feature) {
  return String(feature?.properties?.sourceId || feature?.id || 'road').replace(/[^a-zA-Z0-9_-]+/g, '-');
}

function bridgeKind(properties = {}) {
  if (truthOsmTunnel(properties)) return 'tunnel';
  if (truthyOsm(properties.bridge)) return 'bridge';
  return null;
}

function truthOsmTunnel(properties) {
  return truthyOsm(properties.tunnel) || truthyOsm(properties.covered) || ['underground', 'underwater'].includes(String(properties.location || '').toLowerCase());
}

function geometryAround(point, axis, lengthMetres, project) {
  const half = Math.max(0, Number(lengthMetres)) / 2;
  return [project.toCoordinate({x: point.x - axis.x * half, y: point.y - axis.y * half}), project.toCoordinate({x: point.x + axis.x * half, y: point.y + axis.y * half})];
}

function lineLengthMetres(coordinates, project) {
  let length = 0;
  for (let index = 1; index < coordinates.length; index++) {
    const a = project.toXY(coordinates[index - 1]), b = project.toXY(coordinates[index]);
    length += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return length;
}

function ensureMinimumLine(coordinates, minimumLengthMetres, project) {
  if (coordinates.length < 2 || lineLengthMetres(coordinates, project) >= minimumLengthMetres) return coordinates.map(coordinate => coordinate.slice(0, 2));
  const first = project.toXY(coordinates[0]), last = project.toXY(coordinates.at(-1)), axis = unit(last.x - first.x, last.y - first.y), centre = {x: (first.x + last.x) / 2, y: (first.y + last.y) / 2};
  return geometryAround(centre, axis, minimumLengthMetres, project);
}

export function ensureBridgeTunnelMinimum(coordinates, minimumLengthMetres = 6) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return [];
  const latitude = coordinates.reduce((sum, coordinate) => sum + Number(coordinate[1]), 0) / coordinates.length;
  return ensureMinimumLine(coordinates, minimumLengthMetres, projector(latitude));
}

export function bridgeTunnelGeometryFromRoads(structure, crossed, {minimumLengthMetres = 6, marginMetres = 2, anchor = null} = {}) {
  const firstCoordinates = lineCoordinates(structure), secondCoordinates = lineCoordinates(crossed);
  if (firstCoordinates.length < 2 || secondCoordinates.length < 2) return null;
  const latitude = [...firstCoordinates, ...secondCoordinates].reduce((sum, coordinate) => sum + Number(coordinate[1]), 0) / (firstCoordinates.length + secondCoordinates.length), project = projector(latitude), anchorPoint = anchor ? project.toXY(anchor) : null;
  const intersections = [];
  for (let firstIndex = 1; firstIndex < firstCoordinates.length; firstIndex++) {
    const a = project.toXY(firstCoordinates[firstIndex - 1]), b = project.toXY(firstCoordinates[firstIndex]);
    for (let secondIndex = 1; secondIndex < secondCoordinates.length; secondIndex++) {
      const c = project.toXY(secondCoordinates[secondIndex - 1]), d = project.toXY(secondCoordinates[secondIndex]), hit = segmentIntersection(a, b, c, d);
      if (hit) intersections.push({...hit, firstIndex, secondIndex});
    }
  }
  if (!intersections.length) return null;
  intersections.sort((left, right) => anchorPoint ? distanceSquared(left.point, anchorPoint) - distanceSquared(right.point, anchorPoint) : 0);
  const hit = intersections[0], lengthMetres = Math.max(minimumLengthMetres, featureWidth(crossed) + marginMetres * 2);
  return {coordinates: geometryAround(hit.point, hit.firstUnit, lengthMetres, project), centre: project.toCoordinate(hit.point), lengthMetres, structureId: featureId(structure), crossedId: featureId(crossed)};
}

function explicitCandidate(feature, minimumLengthMetres) {
  const coordinates = lineCoordinates(feature), properties = feature.properties || {}, kind = bridgeKind(properties);
  if (!kind || coordinates.length < 2) return null;
  const latitude = coordinates.reduce((sum, coordinate) => sum + Number(coordinate[1]), 0) / coordinates.length, project = projector(latitude), sourceId = featureId(feature);
  return {
    type: 'Feature', id: `osm-bridge-tunnel-explicit-${sourceId}`,
    properties: {source: 'OpenStreetMap', sourceId: properties.sourceId || feature.id, status: 'automatic-unverified', license: 'ODbL', featureKind: 'line', isomSymbol: '512', omapType: 'bridge_tunnel', automaticIsomSymbol: '512', automaticOmapType: 'bridge_tunnel', classificationConfidence: 'high', classificationReason: kind === 'bridge' ? 'mapped-bridge' : 'mapped-tunnel', bridgeTunnelKind: kind, generationMethod: 'osm-tag', reviewRequired: false, name: properties.name || null},
    geometry: {type: 'LineString', coordinates: ensureMinimumLine(coordinates, minimumLengthMetres, project)}
  };
}

function roadRank(feature) {
  const properties = feature?.properties || {}, layer = number(properties.layer), width = featureWidth(feature), priority = ROAD_PRIORITY[String(properties.highway || '')] || 0;
  return {layer, score: layer * 1000 + priority * 20 + width};
}

function sharedMappedNode(first, second, project, toleranceMetres = .6) {
  const secondPoints = lineCoordinates(second).map(project.toXY);
  return lineCoordinates(first).some(coordinate => {
    const point = project.toXY(coordinate);
    return secondPoints.some(other => distanceSquared(point, other) <= toleranceMetres ** 2);
  });
}

function inferredEvents(features, minimumLengthMetres) {
  const allCoordinates = features.flatMap(lineCoordinates);
  if (!allCoordinates.length) return [];
  const latitude = allCoordinates.reduce((sum, coordinate) => sum + Number(coordinate[1]), 0) / allCoordinates.length, project = projector(latitude), segments = [];
  features.forEach((feature, featureIndex) => {
    const coordinates = lineCoordinates(feature);
    for (let index = 1; index < coordinates.length; index++) {
      const a = project.toXY(coordinates[index - 1]), b = project.toXY(coordinates[index]);
      segments.push({feature, featureIndex, index, a, b, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y)});
    }
  });
  const grid = new Map(), cellSize = 60;
  segments.forEach((segment, segmentIndex) => {
    const minX = Math.floor(segment.minX / cellSize), maxX = Math.floor(segment.maxX / cellSize), minY = Math.floor(segment.minY / cellSize), maxY = Math.floor(segment.maxY / cellSize);
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      const key = `${x}:${y}`, bucket = grid.get(key) || [];
      bucket.push(segmentIndex); grid.set(key, bucket);
    }
  });
  const checked = new Set(), sharedNodeCache = new Map(), events = [];
  for (const bucket of grid.values()) for (let left = 0; left < bucket.length; left++) for (let right = left + 1; right < bucket.length; right++) {
    const firstSegment = segments[bucket[left]], secondSegment = segments[bucket[right]];
    if (firstSegment.featureIndex === secondSegment.featureIndex) continue;
    const pairKey = bucket[left] < bucket[right] ? `${bucket[left]}:${bucket[right]}` : `${bucket[right]}:${bucket[left]}`;
    if (checked.has(pairKey)) continue; checked.add(pairKey);
    if (firstSegment.maxX < secondSegment.minX || secondSegment.maxX < firstSegment.minX || firstSegment.maxY < secondSegment.minY || secondSegment.maxY < firstSegment.minY) continue;
    const featurePairKey = firstSegment.featureIndex < secondSegment.featureIndex ? `${firstSegment.featureIndex}:${secondSegment.featureIndex}` : `${secondSegment.featureIndex}:${firstSegment.featureIndex}`;
    if (!sharedNodeCache.has(featurePairKey)) sharedNodeCache.set(featurePairKey, sharedMappedNode(firstSegment.feature, secondSegment.feature, project));
    if (bridgeKind(firstSegment.feature.properties) || bridgeKind(secondSegment.feature.properties) || sharedNodeCache.get(featurePairKey)) continue;
    const hit = segmentIntersection(firstSegment.a, firstSegment.b, secondSegment.a, secondSegment.b, .08);
    if (!hit || Math.abs(hit.firstUnit.x * hit.secondUnit.x + hit.firstUnit.y * hit.secondUnit.y) > Math.cos(35 * Math.PI / 180)) continue;
    const firstRank = roadRank(firstSegment.feature), secondRank = roadRank(secondSegment.feature), firstIsStructure = firstRank.score >= secondRank.score, structureSegment = firstIsStructure ? firstSegment : secondSegment, crossedSegment = firstIsStructure ? secondSegment : firstSegment, axis = firstIsStructure ? hit.firstUnit : hit.secondUnit, crossedAxis = firstIsStructure ? hit.secondUnit : hit.firstUnit;
    events.push({point: hit.point, axis, crossedAxis, structure: structureSegment.feature, crossed: crossedSegment.feature, structureId: featureId(structureSegment.feature), crossedId: featureId(crossedSegment.feature), minimumLengthMetres: Math.max(minimumLengthMetres, featureWidth(crossedSegment.feature) + 4), project});
  }
  return events;
}

function groupInferredEvents(events) {
  const byStructure = new Map();
  for (const event of events) { const group = byStructure.get(event.structureId) || []; group.push(event); byStructure.set(event.structureId, group); }
  const result = [];
  for (const structureEvents of byStructure.values()) {
    const remaining = [...structureEvents];
    while (remaining.length) {
      const seed = remaining.shift(), group = [seed];
      for (let index = remaining.length - 1; index >= 0; index--) {
        const candidate = remaining[index], close = Math.sqrt(distanceSquared(seed.point, candidate.point)) <= 60, parallelCrossings = Math.abs(seed.crossedAxis.x * candidate.crossedAxis.x + seed.crossedAxis.y * candidate.crossedAxis.y) >= Math.cos(25 * Math.PI / 180), parallelStructure = Math.abs(seed.axis.x * candidate.axis.x + seed.axis.y * candidate.axis.y) >= Math.cos(20 * Math.PI / 180);
        if (close && parallelCrossings && parallelStructure) group.push(...remaining.splice(index, 1));
      }
      const projections = group.map(event => (event.point.x - seed.point.x) * seed.axis.x + (event.point.y - seed.point.y) * seed.axis.y), minProjection = Math.min(...projections), maxProjection = Math.max(...projections), padding = Math.max(seed.minimumLengthMetres / 2, 3), start = {x: seed.point.x + seed.axis.x * (minProjection - padding), y: seed.point.y + seed.axis.y * (minProjection - padding)}, end = {x: seed.point.x + seed.axis.x * (maxProjection + padding), y: seed.point.y + seed.axis.y * (maxProjection + padding)}, crossedIds = group.map(event => event.crossedId).sort();
      result.push({type: 'Feature', id: `osm-bridge-tunnel-inferred-${seed.structureId}-${crossedIds.join('-')}`, properties: {source: 'OpenStreetMap', sourceId: seed.structure.properties?.sourceId || seed.structure.id, status: 'automatic-unverified', license: 'ODbL', featureKind: 'line', isomSymbol: '512', omapType: 'bridge_tunnel', automaticIsomSymbol: '512', automaticOmapType: 'bridge_tunnel', classificationConfidence: 'low', classificationReason: 'road-overlap-no-shared-node', bridgeTunnelKind: 'inferred', generationMethod: 'road-overlap', reviewRequired: true, crossedSourceIds: group.map(event => event.crossed.properties?.sourceId || event.crossed.id), name: seed.structure.properties?.name || null}, geometry: {type: 'LineString', coordinates: [seed.project.toCoordinate(start), seed.project.toCoordinate(end)]}});
    }
  }
  return result;
}

export function generateBridgeTunnelFeatures(roadData, {includeInferred = false, minimumLengthMetres = 6} = {}) {
  const roads = (roadData?.features || []).filter(feature => lineCoordinates(feature).length >= 2 && !feature.properties?.suppressed);
  const explicit = roads.map(feature => explicitCandidate(feature, minimumLengthMetres)).filter(Boolean);
  if (!includeInferred) return explicit;
  const inferredRoads = roads.filter(feature => !bridgeKind(feature.properties));
  return [...explicit, ...groupInferredEvents(inferredEvents(inferredRoads, minimumLengthMetres))];
}

export function isRoadLikeFeature(feature) {
  const symbol = String(feature?.properties?.isomSymbol || feature?.properties?.symbol || '');
  return ['502', '503', '504', '505', '506', '507', '509'].includes(symbol) || Boolean(feature?.properties?.highway || feature?.properties?.railway);
}
