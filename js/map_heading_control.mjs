import {compassHeading, createMovementHeadingTracker} from './heading_tracking.mjs?v=1';

const angleDifference = (target, current) => ((target - current + 540) % 360 + 360) % 360 - 180;

// Sensor events can arrive much faster than the map can render on a phone.
// Keep only the newest target and turn along the shortest arc, at most 12.5 Hz.
export function createMapHeadingControl({map, getDeclination = () => 0, onStatus = () => {}, onError = () => {}}) {
  const movement = createMovementHeadingTracker();
  let mode = 'map-north', target = null, timer = null, sensorTimer = null;
  let latestCourse = null, latestCourseAt = 0, listening = false, sensorReceived = false, compassGranted = false;

  function cancelRotation() {
    clearTimeout(timer);
    timer = null;
    target = null;
  }

  function turn() {
    timer = null;
    if (target == null || document.hidden) return;
    if (map._animatingZoom || map._rotating || map.dragging?._draggable?._moving) {
      timer = setTimeout(turn, 80);
      return;
    }
    try {
      const current = map.getBearing(), delta = angleDifference(target, current);
      // Stop any in-flight pan before leaflet-rotate commits the pane offset.
      map.stop();
      map.setBearing(Math.abs(delta) < 1 ? target : current + delta * .45);
      if (Math.abs(delta) >= 1) timer = setTimeout(turn, 80);
    } catch (error) {
      cancelRotation();
      stopCompass();
      mode = 'map-north';
      onError(error);
    }
  }

  function queueHeading(heading) {
    if (!Number.isFinite(heading)) return;
    const next = ((-heading % 360) + 360) % 360;
    if (target != null && Math.abs(angleDifference(next, target)) < 1) return;
    target = next;
    if (timer == null && Math.abs(angleDifference(target, map.getBearing())) >= .7) timer = setTimeout(turn, 80);
  }

  function onOrientation(event) {
    if (mode !== 'compass' || document.hidden) return;
    const screenAngle = window.screen?.orientation?.angle ?? window.orientation ?? 0;
    const heading = compassHeading(event, screenAngle);
    if (heading == null) return;
    if (!sensorReceived) {
      sensorReceived = true;
      clearTimeout(sensorTimer);
      onStatus('Följer telefonens kompass');
    }
    // Both WebKit and the W3C Earth frame use magnetic north. Convert to the
    // map's geographic north, using the saved declination when offline.
    queueHeading(heading + (Number(getDeclination()) || 0));
  }

  function stopCompass() {
    window.removeEventListener('deviceorientation', onOrientation);
    window.removeEventListener('deviceorientationabsolute', onOrientation);
    clearTimeout(sensorTimer);
    sensorTimer = null;
    listening = false;
  }

  function startCompass() {
    if (listening || document.hidden) return;
    listening = true;
    sensorReceived = false;
    window.addEventListener('deviceorientation', onOrientation);
    window.addEventListener('deviceorientationabsolute', onOrientation);
    onStatus('Väntar på telefonens kompass');
    sensorTimer = setTimeout(() => {
      if (!sensorReceived) onStatus('Ingen kompassignal. Kontrollera sensortillstånd och håll telefonen med skärmen uppåt.', true);
    }, 8000);
  }

  document.addEventListener('visibilitychange', () => {
    cancelRotation();
    movement.reset();
    latestCourse = null;
    if (document.hidden) stopCompass();
    else if (mode === 'compass') startCompass();
  });
  window.addEventListener('pagehide', () => { cancelRotation(); stopCompass(); });
  window.addEventListener('pageshow', () => { if (mode === 'compass') startCompass(); });

  return {
    async requestCompassPermission({userGesture = false} = {}) {
      if (!window.isSecureContext) throw new Error('Kompassen kräver att appen öppnas via HTTPS.');
      const sensor = window.DeviceOrientationEvent;
      if (!sensor) throw new Error('Telefonens kompass är inte tillgänglig i den här webbläsaren.');
      if (typeof sensor.requestPermission === 'function' && !compassGranted) {
        if (!userGesture) throw new Error('Tryck på Kompass för att tillåta telefonens kompass.');
        // Must be invoked directly from the tap, before any other async work.
        let permission;
        try { permission = await sensor.requestPermission(true); }
        catch { throw new Error('Kompass saknar tillstånd. Tillåt rörelse och orientering i webbläsaren och tryck på Kompass igen.'); }
        if (permission !== 'granted') throw new Error('Kompass saknar tillstånd. Tillåt rörelse och orientering i webbläsaren och tryck på Kompass igen.');
        compassGranted = true;
      }
    },
    setMode(next) {
      cancelRotation();
      stopCompass();
      mode = next;
      if (mode === 'compass') startCompass();
      else if (mode === 'heading-up') {
        onStatus('Färdriktning upp · gå några meter för säker riktning');
        if (latestCourse != null && Date.now() - latestCourseAt < 15000) queueHeading(latestCourse);
      } else onStatus('');
    },
    updateMovement(fix) {
      const heading = movement.update(fix);
      if (heading == null) return;
      latestCourse = heading;
      latestCourseAt = Date.now();
      if (mode === 'heading-up') {
        onStatus('Följer färdriktningen · håller riktningen när du står still');
        queueHeading(heading);
      }
    },
    resetMovement() {
      movement.reset();
      latestCourse = null;
      if (mode === 'heading-up') cancelRotation();
    }
  };
}
