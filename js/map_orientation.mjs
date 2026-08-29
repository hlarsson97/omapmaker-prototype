export const MAP_ORIENTATION_MODES = ['map-north', 'magnetic-north', 'heading-up', 'free'];

export function nextMapOrientation(mode) {
  const index=MAP_ORIENTATION_MODES.indexOf(mode);
  return MAP_ORIENTATION_MODES[(index+1+MAP_ORIENTATION_MODES.length)%MAP_ORIENTATION_MODES.length];
}

export function isAppleTouchDevice(navigatorObject = {}) {
  const userAgent = String(navigatorObject.userAgent || '');
  const platform = String(navigatorObject.platform || '');
  return /iPad|iPhone|iPod/.test(userAgent) || (platform === 'MacIntel' && Number(navigatorObject.maxTouchPoints || 0) > 1);
}

export function nextSupportedMapOrientation(mode, freeRotationSupported = true) {
  const next = nextMapOrientation(mode);
  return !freeRotationSupported && next === 'free' ? nextMapOrientation(next) : next;
}

export function mapOrientationBearing(mode,declination=0,freeBearing=0) {
  if(mode==='magnetic-north')return -Number(declination||0);
  if(mode==='heading-up')return Number(freeBearing||0);
  if(mode==='free')return Number(freeBearing||0);
  return 0;
}

export function mapOrientationLabel(mode) {
  if(mode==='magnetic-north')return 'Magnetiskt norr upp';
  if(mode==='heading-up')return 'Färdriktning upp';
  if(mode==='free')return 'Fri rotation';
  return 'Kartnorr upp';
}
