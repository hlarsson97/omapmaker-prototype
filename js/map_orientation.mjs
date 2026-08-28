export const MAP_ORIENTATION_MODES = ['map-north', 'magnetic-north', 'free'];

export function nextMapOrientation(mode) {
  const index=MAP_ORIENTATION_MODES.indexOf(mode);
  return MAP_ORIENTATION_MODES[(index+1+MAP_ORIENTATION_MODES.length)%MAP_ORIENTATION_MODES.length];
}

export function mapOrientationBearing(mode,declination=0,freeBearing=0) {
  if(mode==='magnetic-north')return -Number(declination||0);
  if(mode==='free')return Number(freeBearing||0);
  return 0;
}

export function mapOrientationLabel(mode) {
  if(mode==='magnetic-north')return 'Magnetiskt norr upp';
  if(mode==='free')return 'Fri rotation';
  return 'Kartnorr upp';
}
