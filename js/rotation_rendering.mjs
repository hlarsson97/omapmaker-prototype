export function rotationRendererRadius(size, padding = 0.1) {
  const numericPadding = Number(padding);
  const margin = Number.isFinite(numericPadding) ? Math.max(0, numericPadding) : 0.1;
  return Math.ceil(Math.hypot(size.x, size.y) * (0.5 + margin));
}

export function installRotationRendering(Leaflet) {
  const prototype = Leaflet.Renderer?.prototype;
  if (!prototype || prototype._omapRotationRendering) return;
  const originalUpdate = prototype._update;
  prototype._omapRotationRendering = true;
  prototype._update = function () {
    const map = this._map;
    if (!map?._rotate || !map._bearing) return originalUpdate.call(this);

    // A circle around the padded viewport covers its corners at every bearing.
    // leaflet-rotate 0.2.4 forces padding >= 1.5, producing a surface four times
    // the screen diagonal on each side for every renderer. Retain the renderer's
    // normal padding instead to bound SVG/GPU and canvas memory on phones.
    const size = map.getSize();
    const center = map.containerPointToLayerPoint(size.divideBy(2));
    const radius = rotationRendererRadius(size, this.options.padding);
    this._bounds = new Leaflet.Bounds(
      center.subtract([radius, radius]).round(),
      center.add([radius, radius]).round()
    );
    this._center = map.getCenter();
    this._zoom = map.getZoom();
    // The rotate plugin uses this anchor when transforming renderers on zoom.
    this._boundsMinLatLng = map.layerPointToLatLng(this._bounds.min);
  };
}
