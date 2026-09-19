const RADIANS = Math.PI / 180;
const EARTH_RADIUS_METRES = 6371008.8;
const MAXIMUM_ACCURACY_METRES = 50;
const MINIMUM_SPEED_METRES_PER_SECOND = 0.5;
const MAXIMUM_BASELINE_AGE_MS = 30000;

function normalizedHeading(degrees) {
  return ((degrees % 360) + 360) % 360;
}

function isHeading(value) {
  return Number.isFinite(value) && value >= 0 && value < 360;
}

function displacement(a, b) {
  const latitude1 = a.latitude * RADIANS, latitude2 = b.latitude * RADIANS;
  const latitudeDelta = latitude2 - latitude1;
  const longitudeDelta = (b.longitude - a.longitude) * RADIANS;
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
  const distance = 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))));
  const east = Math.sin(longitudeDelta) * Math.cos(latitude2);
  const north = Math.cos(latitude1) * Math.sin(latitude2)
    - Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(longitudeDelta);
  return {distance, heading: normalizedHeading(Math.atan2(east, north) / RADIANS)};
}

/**
 * Accepts a GeolocationPosition or a normalized fieldSurveyFix. A returned
 * heading is clockwise from true north; null means retain the previous map
 * bearing. GPS noise, stationary fixes and expired baselines cannot turn it.
 */
export function createMovementHeadingTracker() {
  let baseline = null;
  let lastTimestamp = -Infinity;

  return {
    reset() {
      baseline = null;
      lastTimestamp = -Infinity;
    },

    update(position) {
      const coords = position?.coords || position;
      const timestamp = position?.timestamp;
      if (!coords || !Number.isFinite(timestamp) || timestamp < 0 || timestamp <= lastTimestamp) return null;
      lastTimestamp = timestamp;
      const {latitude, longitude, accuracy, heading, speed} = coords;
      if (!Number.isFinite(latitude) || Math.abs(latitude) > 90
        || !Number.isFinite(longitude) || Math.abs(longitude) > 180
        || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > MAXIMUM_ACCURACY_METRES) {
        baseline = null;
        return null;
      }
      const fix = {latitude, longitude, accuracy, timestamp};
      const knownSpeed = Number.isFinite(speed) && speed >= 0;
      if (knownSpeed && speed < MINIMUM_SPEED_METRES_PER_SECOND) {
        baseline = fix;
        return null;
      }
      if (knownSpeed && isHeading(heading)) {
        baseline = fix;
        return heading;
      }
      if (!baseline || timestamp - baseline.timestamp > MAXIMUM_BASELINE_AGE_MS) {
        baseline = fix;
        return null;
      }
      const {distance, heading: derivedHeading} = displacement(baseline, fix);
      const seconds = (timestamp - baseline.timestamp) / 1000;
      // An isolated GPS jump must not establish a course. Restart at the new
      // position so reception can recover without retaining a poisoned anchor.
      if (distance > accuracy + baseline.accuracy + 50 * seconds) {
        baseline = fix;
        return null;
      }
      // Accumulate displacement from the last useful anchor, rather than from
      // every small step. The two uncertainty circles must no longer overlap.
      if (distance <= Math.max(5, baseline.accuracy + accuracy)
        || distance / seconds < MINIMUM_SPEED_METRES_PER_SECOND) return null;
      baseline = fix;
      return derivedHeading;
    }
  };
}

/**
 * Heading of the displayed screen's top edge, clockwise from magnetic north.
 * Apple's native heading and the current W3C absolute Earth frame both use
 * magnetic north; callers add local declination for a true-north map bearing.
 * https://www.w3.org/TR/orientation-sensor/#absoluteorientationsensor-model
 * No relative alpha is accepted as a compass reading.
 * screenAngle is screen.orientation.angle (or legacy window.orientation).
 */
export function compassHeading(event, screenAngle = 0) {
  if (!event || !Number.isFinite(screenAngle)) return null;
  if (isHeading(event.webkitCompassHeading)) {
    const accuracy = event.webkitCompassAccuracy;
    // Apple specifies -1 for an uncalibrated, unusable compass. Large positive
    // uncertainty also cannot provide useful map alignment.
    if (accuracy != null && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 50)) return null;
    return normalizedHeading(event.webkitCompassHeading + screenAngle);
  }
  if (event.absolute !== true || !isHeading(event.alpha)
    || !Number.isFinite(event.beta) || event.beta < -180 || event.beta > 180
    || !Number.isFinite(event.gamma) || event.gamma < -90 || event.gamma > 90) return null;

  const alpha = event.alpha * RADIANS, beta = event.beta * RADIANS;
  const gamma = event.gamma * RADIANS, screen = screenAngle * RADIANS;
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  const cb = Math.cos(beta), sb = Math.sin(beta);
  const cg = Math.cos(gamma), sg = Math.sin(gamma);
  const screenX = Math.sin(screen), screenY = Math.cos(screen);
  // Project screen-up through the specified Rz(alpha) Rx(beta) Ry(gamma)
  // rotation. W3C's worked AR example projects the back of the phone instead,
  // which is undefined with the phone flat and is unsuitable for a map.
  // https://www.w3.org/TR/orientation-event/#deviceorientation
  // https://www.w3.org/TR/screen-orientation/#current-orientation-angle
  const east = (ca * cg - sa * sb * sg) * screenX - sa * cb * screenY;
  const north = (sa * cg + ca * sb * sg) * screenX + ca * cb * screenY;
  // Near vertical, screen-up has no stable horizontal direction. Keep the last
  // map orientation instead of spinning when sensor noise crosses the zenith.
  if (Math.hypot(east, north) < 0.1) return null;
  return normalizedHeading(Math.atan2(east, north) / RADIANS);
}
