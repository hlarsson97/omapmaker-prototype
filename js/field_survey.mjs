export const FIELD_SURVEY_SEGMENTS = Object.freeze({
  terrain: {label: 'Terräng', objectType: null},
  path: {label: 'Liten stig', objectType: 'path'},
  wide_path: {label: 'Bred stig', objectType: 'wide_path'},
  road: {label: 'Väg', objectType: 'road'},
  paved_road: {label: 'Bred väg', objectType: 'paved_road'}
});

const radians = degrees => Number(degrees) * Math.PI / 180;

export function distanceMetres(a, b) {
  if (!a || !b) return Infinity;
  const latitude = radians((Number(a[1]) + Number(b[1])) / 2);
  const dx = (Number(b[0]) - Number(a[0])) * 111320 * Math.cos(latitude);
  const dy = (Number(b[1]) - Number(a[1])) * 111320;
  return Math.hypot(dx, dy);
}

export function fieldSurveyFix(position, timestamp = Date.now()) {
  const coords = position?.coords || position || {};
  return {
    longitude: Number(coords.longitude),
    latitude: Number(coords.latitude),
    accuracy: Number(coords.accuracy),
    altitude: coords.altitude == null ? null : Number(coords.altitude),
    altitudeAccuracy: coords.altitudeAccuracy == null ? null : Number(coords.altitudeAccuracy),
    heading: coords.heading == null || !Number.isFinite(Number(coords.heading)) ? null : Number(coords.heading),
    speed: coords.speed == null || !Number.isFinite(Number(coords.speed)) ? null : Number(coords.speed),
    timestamp: Number(position?.timestamp || timestamp)
  };
}

export function fixCoordinate(fix) {
  return [fix.longitude, fix.latitude, fix.accuracy, fix.timestamp, fix.altitude, fix.altitudeAccuracy];
}

export function usableSurveyFix(fix, maximumAccuracy = 50) {
  return Number.isFinite(fix?.longitude) && Number.isFinite(fix?.latitude) && Number.isFinite(fix?.accuracy) && fix.accuracy <= maximumAccuracy;
}

export function appendSurveyCoordinate(coordinates, fix, {maximumAccuracy = 50, minimumDistance = 1.5, maximumPause = 10000} = {}) {
  if (!usableSurveyFix(fix, maximumAccuracy)) return false;
  const coordinate = fixCoordinate(fix), previous = coordinates.at(-1);
  if (previous && Number(fix.timestamp) - Number(previous[3]) < maximumPause && distanceMetres(previous, coordinate) < minimumDistance) return false;
  coordinates.push(coordinate);
  return true;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 5;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function pointSegmentDistance(point, start, end) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
}

function simplifyIndices(points, tolerance) {
  const keep = new Set([0, points.length - 1]), stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop(); let furthest = -1, distance = tolerance;
    for (let index = first + 1; index < last; index++) {
      const candidate = pointSegmentDistance(points[index], points[first], points[last]);
      if (candidate > distance) { distance = candidate; furthest = index; }
    }
    if (furthest >= 0) { keep.add(furthest); stack.push([first, furthest], [furthest, last]); }
  }
  return keep;
}

// Reduces ordinary GPS side-to-side noise while keeping endpoints, metadata and sharp turns.
// The maximum movement is accuracy-bound, and the caller can retain the untouched coordinates.
export function smoothSurveyLine(coordinates, {minimumDistance = 1.5, passes = 2, simplifyTolerance} = {}) {
  const source = (coordinates || []).filter(coordinate => Number.isFinite(Number(coordinate?.[0])) && Number.isFinite(Number(coordinate?.[1]))).map(coordinate => [...coordinate]);
  if (source.length < 3) return source;
  const filtered = [source[0]];
  for (let index = 1; index < source.length - 1; index++) if (distanceMetres(filtered.at(-1), source[index]) >= minimumDistance) filtered.push(source[index]);
  if (distanceMetres(filtered.at(-1), source.at(-1)) < minimumDistance && filtered.length > 1) filtered[filtered.length - 1] = source.at(-1); else filtered.push(source.at(-1));
  if (filtered.length < 5) return filtered.map(coordinate => [...coordinate]);
  const latitude = filtered.reduce((sum, coordinate) => sum + Number(coordinate[1]), 0) / filtered.length;
  const mx = 111320 * Math.cos(radians(latitude)), origin = filtered[0];
  const original = filtered.map(coordinate => ({x: (Number(coordinate[0]) - origin[0]) * mx, y: (Number(coordinate[1]) - origin[1]) * 111320}));
  const accuracy = median(filtered.map(coordinate => Number(coordinate[2]))), maximumAdjustment = Math.max(1.5, Math.min(3.5, accuracy * .5));
  let points = original.map(point => ({...point}));
  for (let pass = 0; pass < passes; pass++) points = points.map((point, index) => {
    if (index === 0 || index === points.length - 1) return {...point};
    let x = 0, y = 0, total = 0;
    for (let neighbour = Math.max(0, index - 2); neighbour <= Math.min(points.length - 1, index + 2); neighbour++) {
      const proximity = 3 - Math.abs(neighbour - index), neighbourAccuracy = Math.max(1, Number(filtered[neighbour][2]) || accuracy), weight = proximity / neighbourAccuracy;
      x += points[neighbour].x * weight; y += points[neighbour].y * weight; total += weight;
    }
    x /= total; y /= total;
    const dx = x - original[index].x, dy = y - original[index].y, movement = Math.hypot(dx, dy), scale = movement > maximumAdjustment ? maximumAdjustment / movement : 1;
    return {x: original[index].x + dx * scale, y: original[index].y + dy * scale};
  });
  const tolerance = Number.isFinite(Number(simplifyTolerance)) ? Math.max(0, Number(simplifyTolerance)) : Math.max(1, Math.min(2, maximumAdjustment * .7));
  const keep = simplifyIndices(points, tolerance);
  return points.map((point, index) => {
    const coordinate = [...filtered[index]];
    coordinate[0] = origin[0] + point.x / mx; coordinate[1] = origin[1] + point.y / 111320;
    return coordinate;
  }).filter((_, index) => keep.has(index));
}

export function headingUpBearing(heading) {
  const numeric = Number(heading);
  if (!Number.isFinite(numeric)) return 0;
  return -(((numeric % 360) + 360) % 360);
}

export function movementHeading(a, b) {
  if (!a || !b) return null;
  const latitude1 = radians(Number(a.latitude ?? a[1])), latitude2 = radians(Number(b.latitude ?? b[1]));
  const longitudeDelta = radians(Number(b.longitude ?? b[0]) - Number(a.longitude ?? a[0]));
  const y = Math.sin(longitudeDelta) * Math.cos(latitude2);
  const x = Math.cos(latitude1) * Math.sin(latitude2) - Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(longitudeDelta);
  if (!Number.isFinite(x) || !Number.isFinite(y) || (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12)) return null;
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export function fieldSurveyDuration(session, now = Date.now()) {
  if (!session?.startedAt) return 0;
  const start = new Date(session.startedAt).getTime();
  const end = session.endedAt ? new Date(session.endedAt).getTime() : Number(now);
  return Math.max(0, end - start);
}

export function formatFieldSurveyDuration(milliseconds) {
  const totalMinutes = Math.floor(Number(milliseconds || 0) / 60000);
  const hours = Math.floor(totalMinutes / 60), minutes = totalMinutes % 60;
  return hours ? `${hours} h ${String(minutes).padStart(2, '0')} min` : `${minutes} min`;
}
