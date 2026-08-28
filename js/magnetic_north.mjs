export function magneticNorthRequestUrl(center,date=new Date()) {
  const day=typeof date==='string'?date:date.toISOString().slice(0,10);
  return `/api/magnetic-north?lat=${encodeURIComponent(center.lat)}&lng=${encodeURIComponent(center.lng)}&date=${encodeURIComponent(day)}`;
}

export function magneticNorthSummary(result) {
  const signed=value=>`${Number(value)>=0?'+':''}${Number(value).toFixed(2).replace('.',',')}°`;
  return `${result.model} ${result.date}: nordlinjer ${signed(result.declinationDegrees)} mot geografiskt kartnorr. SWEREF-konvergens ${signed(result.meridianConvergenceDegrees)}; mot SWEREF-rutnät ${signed(result.gridToMagneticDegrees)}.`;
}
