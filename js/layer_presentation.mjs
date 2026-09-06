// Zoom changes symbol sizes, not geometry or membership. Keep Leaflet paths,
// markers, popup bindings and attribution alive until the underlying data changes.
export function refreshGeoJsonPresentation(layer, pointIcon) {
  if (!layer) return;
  layer.setStyle(layer.options.style);
  if (!pointIcon) return;
  const visit = child => {
    if (child.setIcon && child.feature) child.setIcon(pointIcon(child.feature));
    else child.eachLayer?.(visit);
  };
  layer.eachLayer(visit);
}
