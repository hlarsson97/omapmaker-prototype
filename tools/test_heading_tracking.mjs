import assert from 'node:assert/strict';
import {compassHeading, createMovementHeadingTracker} from '../js/heading_tracking.mjs';

const METRES_PER_DEGREE = Math.PI * 6371008.8 / 180;
const fix = (east, north, timestamp, extra = {}) => ({
  longitude: east / METRES_PER_DEGREE,
  latitude: north / METRES_PER_DEGREE,
  accuracy: 3, speed: null, heading: null, timestamp, ...extra
});
const near = (actual, expected, message) => {
  assert.notEqual(actual, null, message);
  assert.ok(Math.abs(((actual - expected + 540) % 360) - 180) < 0.01, `${message}: ${actual} vs ${expected}`);
};

// Walking steps must accumulate until displacement exceeds both error radii.
const walk = createMovementHeadingTracker();
assert.equal(walk.update(fix(0, 0, 1000)), null);
for (let step = 1; step <= 3; step++) assert.equal(walk.update(fix(step * 2, 0, 1000 + step * 1000)), null);
near(walk.update(fix(8, 0, 5000)), 90, 'Walking east produces a course');
near(walk.update(fix(8, 8, 10000)), 0, 'A subsequent northward leg changes course');
assert.equal(walk.update(fix(9, 8, 11000)), null, 'Insufficient movement retains the last course');

// Reported headings at rest, including a spurious zero, must not rotate north.
const stationary = createMovementHeadingTracker();
near(stationary.update(fix(0, 0, 1000, {speed: 1, heading: 275})), 275, 'Moving native course is accepted');
assert.equal(stationary.update(fix(0, 0, 2000, {speed: 0, heading: 0})), null);
assert.equal(stationary.update(fix(15, 0, 3000, {speed: 0.2, heading: 90})), null, 'Low speed also suppresses position drift');
assert.equal(stationary.update(fix(15, 0, 4000, {speed: null, heading: 0})), null, 'Unknown speed cannot validate native course');
near(stationary.update(fix(15, 8, 8000)), 0, 'Movement restarts from the stopped position');

const invalid = createMovementHeadingTracker();
assert.equal(invalid.update(fix(0, 0, 1000)), null);
for (const timestamp of [null, undefined, NaN, Infinity, -1]) {
  assert.equal(invalid.update(fix(0, 15, timestamp, {speed: 1, heading: 180})), null, 'Invalid time cannot create course or poison the anchor');
}
assert.equal(invalid.update(fix(0, 15, 1000, {speed: 1, heading: 180})), null, 'Duplicate timestamps are rejected');
assert.equal(invalid.update(fix(0, 15, 500, {speed: 1, heading: 180})), null, 'Out-of-order fixes are rejected');
near(invalid.update(fix(10, 0, 6000)), 90, 'Rejected old fixes cannot move the anchor');
for (const extra of [{latitude: NaN}, {latitude: 91}, {longitude: Infinity}, {longitude: -181},
  {accuracy: -1}, {accuracy: null}, {accuracy: 51}, {accuracy: Infinity}]) {
  invalid.reset();
  assert.equal(invalid.update(fix(0, 0, 1000, {...extra, speed: 2, heading: 45})), null, 'Invalid fixes reject even native course');
}
for (const heading of [null, NaN, Infinity, -1, 360]) {
  invalid.reset();
  assert.equal(invalid.update(fix(0, 0, 1000, {heading, speed: 1})), null, 'Invalid heading is not coerced to north');
}

const reception = createMovementHeadingTracker();
reception.update(fix(0, 0, 1000));
assert.equal(reception.update(fix(50, 50, 2000, {accuracy: 75, speed: 1, heading: 180})), null);
assert.equal(reception.update(fix(0, 20, 3000)), null, 'Bad reception breaks the displacement baseline');
assert.equal(reception.update(fix(0, 200, 35000)), null, 'An old baseline cannot create a false course after resuming');
near(reception.update(fix(10, 200, 40000)), 90, 'Tracking recovers after an expired baseline');
reception.reset();
assert.equal(reception.update(fix(0, 0, 1000)), null, 'Reset clears both time and baseline');
assert.equal(reception.update(fix(5000, 0, 2000)), null, 'GPS teleport does not create a course');
assert.equal(reception.update(fix(0, 0, 3000)), null, 'Return from GPS teleport does not create a course');
near(reception.update(fix(8, 0, 7000)), 90, 'Tracking recovers after GPS teleport');

const jitter = createMovementHeadingTracker();
jitter.update(fix(0, 0, 1000, {accuracy: 10}));
for (let i = 1; i <= 15; i++) assert.equal(jitter.update(fix(i % 2 ? 8 : -8, i % 3 ? 3 : -3, 1000 + i * 1000, {accuracy: 10})), null);
const slowDrift = createMovementHeadingTracker();
slowDrift.update(fix(0, 0, 0, {accuracy: 1}));
assert.equal(slowDrift.update(fix(8, 0, 25000, {accuracy: 1})), null, 'Slow drift alone is not a walking course');
const native = createMovementHeadingTracker();
near(native.update({timestamp: 1000, coords: fix(0, 0, 1000, {speed: 1, heading: 0})}), 0, 'Native GeolocationPosition and due north both work');
const dateline = createMovementHeadingTracker();
dateline.update(fix(0, 0, 1000, {longitude: 179.9999}));
near(dateline.update(fix(0, 0, 11000, {longitude: -179.9999})), 90, 'Crossing the dateline takes the short eastward route');

// W3C uses an absolute Z-X-Y device frame, independent of screen orientation.
const orientation = (alpha, beta = 0, gamma = 0) => ({absolute: true, alpha, beta, gamma});
near(compassHeading(orientation(0)), 0, 'Phone flat and pointing north');
near(compassHeading(orientation(270)), 90, 'Phone flat and pointing east');
near(compassHeading(orientation(180)), 180, 'Phone flat and pointing south');
near(compassHeading(orientation(90)), 270, 'W3C example: alpha 90 points west');
near(compassHeading(orientation(315, 55, 20)), 45, 'Portrait screen top retains heading while tilted');
near(compassHeading(orientation(90), 90), 0, 'Landscape screen top compensates for device rotation');
near(compassHeading(orientation(270), -90), 0, 'Legacy negative landscape angle is supported');
near(compassHeading(orientation(0, 45, 45), 90), 54.7356, 'Tilted landscape uses projected screen top');
for (const screenAngle of [0, 90, 180, 270]) {
  near(compassHeading(orientation(screenAngle), screenAngle), 0, 'Turning the flat device while keeping displayed screen-up north preserves heading');
}
assert.equal(compassHeading(orientation(0, 90)), null, 'Vertical screen top has no stable horizontal bearing');
assert.equal(compassHeading({...orientation(90), absolute: false}), null, 'Relative alpha is not a compass');
assert.equal(compassHeading({...orientation(90), absolute: undefined}), null);
for (const event of [null, {}, {absolute: true}, orientation(null), orientation(NaN), orientation(0, null), orientation(0, 0, Infinity)]) {
  assert.equal(compassHeading(event), null, 'Incomplete orientation does not fabricate north');
}
assert.equal(compassHeading(orientation(90), NaN), null);

const apple = {absolute: false, webkitCompassHeading: 350, webkitCompassAccuracy: 10};
near(compassHeading(apple), 350, 'iOS magnetic heading works without absolute alpha');
near(compassHeading(apple, 90), 80, 'iOS landscape compensation wraps through north');
near(compassHeading({...apple, webkitCompassHeading: 0}), 0, 'iOS heading zero is valid');
assert.equal(compassHeading({...apple, webkitCompassAccuracy: -1}), null, 'Uncalibrated iOS compass is rejected');
assert.equal(compassHeading({...apple, webkitCompassAccuracy: 80}), null, 'Very uncertain iOS compass is rejected');
assert.equal(compassHeading({...apple, webkitCompassHeading: -1}), null, 'Invalid native heading cannot become north');

console.log('Heading tracking: walking, stationary drift, reception recovery, compass geometry and invalid sensor checks passed');
