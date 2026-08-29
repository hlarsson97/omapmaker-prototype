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
