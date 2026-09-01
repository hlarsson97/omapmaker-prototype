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

function baselineAxisForOutward(outwardAxis) {
  return {x: outwardAxis.y, y: -outwardAxis.x};
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
  const hit = intersections[0], passageAxis = hit.firstUnit, halfCrossedWidth = featureWidth(crossed) / 2;
  const portalCentres = [-1, 1].map(side => ({point: {x: hit.point.x + passageAxis.x * halfCrossedWidth * side, y: hit.point.y + passageAxis.y * halfCrossedWidth * side}, side}));
  const portal = anchorPoint ? portalCentres.sort((left, right) => distanceSquared(left.point, anchorPoint) - distanceSquared(right.point, anchorPoint))[0] : portalCentres[0], portalCentre = portal.point, outwardAxis = {x: passageAxis.x * portal.side, y: passageAxis.y * portal.side}, baselineAxis = baselineAxisForOutward(outwardAxis);
  const lengthMetres = Math.max(minimumLengthMetres, featureWidth(structure) + marginMetres * 2);
  return {coordinates: geometryAround(portalCentre, baselineAxis, lengthMetres, project), centre: project.toCoordinate(portalCentre), lengthMetres, structureId: featureId(structure), crossedId: featureId(crossed)};
}

function explicitPortalEvents(feature, marginMetres = 2) {
  const coordinates = lineCoordinates(feature), properties = feature.properties || {}, kind = bridgeKind(properties);
  if (!kind || coordinates.length < 2) return [];
  const latitude = coordinates.reduce((sum, coordinate) => sum + Number(coordinate[1]), 0) / coordinates.length, project = projector(latitude), points = coordinates.map(project.toXY), sourceId = featureId(feature), halfWidth = featureWidth(feature) / 2 + marginMetres;
  return [[points[0], points[1], 'start'], [points.at(-1), points.at(-2), 'end']].map(([point, inside, endpoint]) => {
    const inward = unit(inside.x - point.x, inside.y - point.y), outwardAxis = {x: -inward.x, y: -inward.y};
    return {point, outwardAxis, baselineAxis: baselineAxisForOutward(outwardAxis), halfWidth, feature, sourceId, kind, endpoint, project};
  });
}

function groupExplicitPortals(events, minimumLengthMetres) {
  const remaining = [...events], groups = [];
  while (remaining.length) {
    const seed = remaining.shift(), group = [seed];
    for (let index = remaining.length - 1; index >= 0; index--) {
      const candidate = remaining[index], close = Math.sqrt(distanceSquared(seed.point, candidate.point)) <= 30, sameKind = seed.kind === candidate.kind, samePortalSide = seed.outwardAxis.x * candidate.outwardAxis.x + seed.outwardAxis.y * candidate.outwardAxis.y >= Math.cos(25 * Math.PI / 180);
      if (close && sameKind && samePortalSide) group.push(...remaining.splice(index, 1));
    }
    groups.push(group);
  }
  return groups.map(group => {
    const seed = group[0], baselineAxis = seed.baselineAxis, outwardAxis = seed.outwardAxis;
    const lateral = group.map(event => (event.point.x - seed.point.x) * baselineAxis.x + (event.point.y - seed.point.y) * baselineAxis.y), longitudinal = group.map(event => (event.point.x - seed.point.x) * outwardAxis.x + (event.point.y - seed.point.y) * outwardAxis.y);
    const min = Math.min(...group.map((event, index) => lateral[index] - event.halfWidth)), max = Math.max(...group.map((event, index) => lateral[index] + event.halfWidth)), lengthMetres = Math.max(minimumLengthMetres, max - min), centre = {x: seed.point.x + baselineAxis.x * ((min + max) / 2) + outwardAxis.x * (longitudinal.reduce((sum, value) => sum + value, 0) / longitudinal.length), y: seed.point.y + baselineAxis.y * ((min + max) / 2) + outwardAxis.y * (longitudinal.reduce((sum, value) => sum + value, 0) / longitudinal.length)}, sourceIds = group.map(event => event.sourceId).sort(), properties = seed.feature.properties || {};
    return {type: 'Feature', id: `osm-bridge-tunnel-explicit-${seed.kind}-${sourceIds.join('-')}-${seed.endpoint}`, properties: {source: 'OpenStreetMap', sourceId: properties.sourceId || seed.feature.id, sourceIds, status: 'automatic-unverified', license: 'ODbL', featureKind: 'line', isomSymbol: '512', omapType: 'bridge_tunnel', automaticIsomSymbol: '512', automaticOmapType: 'bridge_tunnel', classificationConfidence: 'high', classificationReason: seed.kind === 'bridge' ? 'mapped-bridge' : 'mapped-tunnel', bridgeTunnelKind: seed.kind, generationMethod: 'osm-tag-portal', reviewRequired: false, portalEndpoint: seed.endpoint, name: properties.name || null}, geometry: {type: 'LineString', coordinates: geometryAround(centre, baselineAxis, lengthMetres, seed.project)}};
  });
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
    const firstRank = roadRank(firstSegment.feature), secondRank = roadRank(secondSegment.feature), firstIsStructure = firstRank.score >= secondRank.score, structureSegment = firstIsStructure ? firstSegment : secondSegment, passageSegment = firstIsStructure ? secondSegment : firstSegment, structureAxis = firstIsStructure ? hit.firstUnit : hit.secondUnit, passageAxis = firstIsStructure ? hit.secondUnit : hit.firstUnit;
    events.push({point: hit.point, structureAxis, passageAxis, structure: structureSegment.feature, passage: passageSegment.feature, structureId: featureId(structureSegment.feature), passageId: featureId(passageSegment.feature), structureHalfWidth: featureWidth(structureSegment.feature) / 2, baselineHalfWidth: Math.max(minimumLengthMetres / 2, featureWidth(passageSegment.feature) / 2 + 2), project});
  }
  return events;
}

function groupInferredEvents(events) {
  const remaining = [...events], result = [];
  while (remaining.length) {
    const seed = remaining.shift(), group = [seed];
    for (let index = remaining.length - 1; index >= 0; index--) {
      const candidate = remaining[index], close = Math.sqrt(distanceSquared(seed.point, candidate.point)) <= 60, parallelPassages = Math.abs(seed.passageAxis.x * candidate.passageAxis.x + seed.passageAxis.y * candidate.passageAxis.y) >= Math.cos(25 * Math.PI / 180), parallelStructures = Math.abs(seed.structureAxis.x * candidate.structureAxis.x + seed.structureAxis.y * candidate.structureAxis.y) >= Math.cos(20 * Math.PI / 180);
      if (close && parallelPassages && parallelStructures) group.push(...remaining.splice(index, 1));
    }
    const passageProjection = event => (event.point.x - seed.point.x) * seed.passageAxis.x + (event.point.y - seed.point.y) * seed.passageAxis.y, baselineProjection = event => (event.point.x - seed.point.x) * seed.structureAxis.x + (event.point.y - seed.point.y) * seed.structureAxis.y;
    const structureMin = Math.min(...group.map(event => passageProjection(event) - event.structureHalfWidth)), structureMax = Math.max(...group.map(event => passageProjection(event) + event.structureHalfWidth)), baselineMin = Math.min(...group.map(event => baselineProjection(event) - event.baselineHalfWidth)), baselineMax = Math.max(...group.map(event => baselineProjection(event) + event.baselineHalfWidth)), structureIds = [...new Set(group.map(event => event.structureId))].sort(), passageIds = [...new Set(group.map(event => event.passageId))].sort();
    for (const [side, portalProjection, direction] of [['start', structureMin, -1], ['end', structureMax, 1]]) {
      const centre = {x: seed.point.x + seed.passageAxis.x * portalProjection + seed.structureAxis.x * ((baselineMin + baselineMax) / 2), y: seed.point.y + seed.passageAxis.y * portalProjection + seed.structureAxis.y * ((baselineMin + baselineMax) / 2)}, halfLength = (baselineMax - baselineMin) / 2, outwardAxis = {x: seed.passageAxis.x * direction, y: seed.passageAxis.y * direction}, baselineAxis = baselineAxisForOutward(outwardAxis), start = {x: centre.x - baselineAxis.x * halfLength, y: centre.y - baselineAxis.y * halfLength}, end = {x: centre.x + baselineAxis.x * halfLength, y: centre.y + baselineAxis.y * halfLength};
      result.push({type: 'Feature', id: `osm-bridge-tunnel-inferred-${structureIds.join('-')}-${passageIds.join('-')}-${side}`, properties: {source: 'OpenStreetMap', sourceId: seed.structure.properties?.sourceId || seed.structure.id, status: 'automatic-unverified', license: 'ODbL', featureKind: 'line', isomSymbol: '512', omapType: 'bridge_tunnel', automaticIsomSymbol: '512', automaticOmapType: 'bridge_tunnel', classificationConfidence: 'low', classificationReason: 'road-overlap-no-shared-node', bridgeTunnelKind: 'inferred', generationMethod: 'road-overlap', reviewRequired: true, structureSourceIds: structureIds, crossedSourceIds: passageIds, portalEndpoint: side, name: seed.structure.properties?.name || null}, geometry: {type: 'LineString', coordinates: [seed.project.toCoordinate(start), seed.project.toCoordinate(end)]}});
    }
  }
  return result;
}

export function generateBridgeTunnelFeatures(roadData, {includeInferred = false, minimumLengthMetres = 6} = {}) {
  const roads = (roadData?.features || []).filter(feature => lineCoordinates(feature).length >= 2 && !feature.properties?.suppressed);
  const explicit = groupExplicitPortals(roads.flatMap(feature => explicitPortalEvents(feature)), minimumLengthMetres);
  if (!includeInferred) return explicit;
  const inferredRoads = roads.filter(feature => !bridgeKind(feature.properties));
  return [...explicit, ...groupInferredEvents(inferredEvents(inferredRoads, minimumLengthMetres))];
}

export function isRoadLikeFeature(feature) {
  const symbol = String(feature?.properties?.isomSymbol || feature?.properties?.symbol || '');
  return ['502', '503', '504', '505', '506', '507', '509'].includes(symbol) || Boolean(feature?.properties?.highway || feature?.properties?.railway);
}
