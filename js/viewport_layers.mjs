export const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const contains = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];

export function geometryBounds(geometry) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = coordinates => {
    if (!Array.isArray(coordinates)) return;
    if (typeof coordinates[0] === 'number') {
      const [x, y] = coordinates;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
      bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
    } else coordinates.forEach(visit);
  };
  const walk = value => {
    if (value?.type === 'GeometryCollection') value.geometries.forEach(walk);
    else visit(value?.coordinates);
  };
  walk(geometry);
  return Number.isFinite(bounds[0]) ? bounds : null;
}

// Static bounding-volume tree: build once per data revision, search without
// scanning all coordinates on every movement. Bounds also retain lines crossing
// the view and polygons surrounding it, even when no vertex is on screen.
export function createFeatureIndex(features, getBounds = feature => geometryBounds(feature.geometry)) {
  const entries = features.map((feature, order) => ({feature, order, bounds: getBounds(feature)})).filter(entry => entry.bounds);
  const build = items => {
    if (!items.length) return null;
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const {bounds: box} of items) {
      bounds[0] = Math.min(bounds[0], box[0]); bounds[1] = Math.min(bounds[1], box[1]);
      bounds[2] = Math.max(bounds[2], box[2]); bounds[3] = Math.max(bounds[3], box[3]);
    }
    if (items.length <= 32) return {bounds, entries: items};
    const axis = bounds[2] - bounds[0] >= bounds[3] - bounds[1] ? 0 : 1;
    items.sort((a, b) => (a.bounds[axis] + a.bounds[axis + 2]) - (b.bounds[axis] + b.bounds[axis + 2]));
    const mid = Math.floor(items.length / 2);
    return {bounds, left: build(items.slice(0, mid)), right: build(items.slice(mid))};
  };
  const root = build(entries);
  return {search(bounds) {
    const found = [];
    const visit = node => {
      if (!node || !intersects(node.bounds, bounds)) return;
      if (node.entries) {
        for (const entry of node.entries) if (intersects(entry.bounds, bounds)) found.push(entry);
      } else { visit(node.left); visit(node.right); }
    };
    visit(root);
    return found.sort((a, b) => a.order - b.order);
  }};
}

export function createViewportLayers(Leaflet, map) {
  const groups = new Set();
  let frame = null, zooming = false, coverage = null, zoom = null;
  // A circle around the screen covers its corners at every bearing. The extra
  // pixels account for symbols/labels anchored just outside the viewport.
  const viewBounds = (margin = 0) => {
    const size = map.getSize(), center = map.project(map.getCenter());
    const radius = Math.hypot(size.x, size.y) / 2 + 128;
    const extra = Math.max(size.x, size.y) * margin;
    const sw = map.unproject(center.subtract([radius + extra, -radius - extra]));
    const ne = map.unproject(center.add([radius + extra, -radius - extra]));
    return [sw.lng, sw.lat, ne.lng, ne.lat];
  };
  const reorder = () => {
    // Restore source order and outer/inner group order after entering objects
    // have been appended to shared SVG panes (e.g. road casings and fills).
    const front = layer => {
      if (layer.eachLayer) layer.eachLayer(front);
      else layer.bringToFront?.();
    };
    for (const group of groups) {
      for (const [, layer] of [...group._visible].sort((a, b) => a[0] - b[0])) front(layer);
    }
  };
  const update = (force = false) => {
    if (zooming) return;
    const view = viewBounds();
    if (!force && zoom === map.getZoom() && coverage && contains(coverage, view)) return;
    zoom = map.getZoom(); coverage = viewBounds(.25);
    let changed = false;
    for (const group of groups) changed = group.updateViewport(coverage) || changed;
    if (changed) { reorder(); map.fire('viewportlayerschange'); }
  };
  const schedule = () => {
    if (frame !== null || zooming) return;
    frame = requestAnimationFrame(() => { frame = null; update(); });
  };
  map.on('move rotate', schedule);
  map.on('moveend resize', () => update());
  map.on('zoomstart', () => { zooming = true; });
  map.on('zoomend', () => { zooming = false; update(true); });
  map.on('unload', () => { if (frame !== null) cancelAnimationFrame(frame); groups.clear(); });

  const ViewportGeoJSON = Leaflet.GeoJSON.extend({
    initialize(data, options) {
      Leaflet.GeoJSON.prototype.initialize.call(this, null, options);
      this._visible = new Map();
      this._viewportData = data;
      const features = data?.type === 'FeatureCollection' ? data.features : data ? [data] : [];
      this._featureIndex = createFeatureIndex(features.filter(feature => !options?.filter || options.filter(feature)));
    },
    onAdd(target) {
      // Populate before adding children, using current zoom styles/icons.
      this.updateViewport(viewBounds(.25));
      Leaflet.GeoJSON.prototype.onAdd.call(this, target);
      groups.add(this);
      coverage = null;
    },
    onRemove(target) {
      groups.delete(this);
      Leaflet.GeoJSON.prototype.onRemove.call(this, target);
      this.clearLayers(); this._visible.clear();
    },
    updateViewport(bounds) {
      const entries = this._featureIndex.search(bounds);
      const wanted = new Set(entries.map(entry => entry.order));
      let changed = false;
      for (const [order, layer] of this._visible) {
        if (wanted.has(order) || layer.isPopupOpen?.()) continue;
        this.removeLayer(layer); this._visible.delete(order); changed = true;
      }
      for (const entry of entries) {
        if (this._visible.has(entry.order)) continue;
        const temporary = Leaflet.geoJSON(entry.feature, this.options);
        const child = temporary.getLayers()[0];
        if (!child) continue;
        temporary.removeLayer(child);
        this.addLayer(child); this._visible.set(entry.order, child); changed = true;
      }
      return changed;
    }
  });
  return {geoJSON: (data, options) => new ViewportGeoJSON(data, options)};
}
