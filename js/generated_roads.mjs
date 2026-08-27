export const ROAD_TYPES = Object.freeze({
  '502': ['wide_road', 'Bred väg'],
  '503': ['road', 'Väg'],
  '504': ['vehicle_track', 'Fordonsstig'],
  '505': ['wide_path', 'Bred stig'],
  '506': ['path', 'Stig'],
  '507': ['faint_path', 'Otydlig stig']
});

export const ROAD_ATTRIBUTION = 'Vägar © OpenStreetMap contributors';

export function roadMetaText(data, generatedStatus, centralLayerLabel) {
  if (!data) return 'Inte hämtade';
  const counts = {edited: 0, excluded: 0, wide: 0};
  data.features.forEach(feature => {
    if (String(feature.properties?.isomSymbol) === '502' && generatedStatus(feature) !== 'excluded') counts.wide++;
    if (generatedStatus(feature) === 'edited') counts.edited++;
    if (generatedStatus(feature) === 'excluded') counts.excluded++;
  });
  return `${data.features.length} automatiska · ${counts.wide} st 502${counts.edited ? ` · ${counts.edited} ändrade` : ''}${counts.excluded ? ` · ${counts.excluded} uteslutna` : ''}${centralLayerLabel(data)}`;
}

export function createGeneratedRoadLayer({Leaflet, map, getData, isVisible, featureIsVisible, generatedStatus, generatedStatusLabel, generatedClass, generatedActionHtml, excludedStyle, symbolScale, isomLineStyle, lineStyles, normContext, isomClaim, escapeHtml, centralLayerLabel, metaElement}) {
  let layer = null;
  let attributionVisible = false;

  function style(feature) {
    const symbol = String(feature.properties?.isomSymbol || '506');
    if (generatedStatus(feature) === 'excluded') return excludedStyle(symbolScale());
    return {...isomLineStyle(symbol, feature), opacity: 1, className: generatedClass(feature, `osm-road road-${symbol}`)};
  }

  function popup(feature) {
    const properties = feature.properties || {};
    const confidence = {high: 'hög', medium: 'medel', low: 'låg'};
    const reasons = {'explicit-width': 'uppmätt bredd', 'estimated-width': 'uppskattad bredd', 'inferred-lanes': 'antal körfält', 'motorway-system': 'motorvägssystem', 'junction-inherited': 'rondellens vägklass', 'dual-carriageway': 'delad körbana', 'paired-oneway': 'parade enkelriktade körbanor', 'road-class': 'OSM-vägklass', 'firm-vehicle-road': 'fast fordonsväg', 'vehicle-track': 'fordonsspår', 'trail-visibility': 'stigens synlighet', 'path-width-or-visibility': 'stigens bredd eller synlighet', 'path-class': 'OSM-stigtyp', 'unknown-highway': 'okänd vägtyp'};
    const id = escapeHtml(feature.id);
    const options = Object.entries(ROAD_TYPES).map(([symbol, data]) => `<option value="${symbol}" ${String(properties.isomSymbol) === symbol ? 'selected' : ''}>${symbol} ${data[1]}</option>`).join('');
    return `<div class="road-popup generated-object-popup"><b>${escapeHtml(properties.name || ROAD_TYPES[String(properties.isomSymbol)]?.[1] || 'Väg eller stig')}</b><small>${isomClaim(properties.isomSymbol, feature.geometry?.type)} · ${escapeHtml(generatedStatusLabel(feature))} · säkerhet ${escapeHtml(confidence[properties.classificationConfidence] || 'okänd')}</small><small>${escapeHtml(reasons[properties.classificationReason] || properties.classificationReason || 'okänd regel')} · ${escapeHtml(properties.sourceId)}</small><select class="road-type-select" data-road-id="${id}">${options}</select><button type="button" data-road-review="change" data-road-id="${id}">Ändra typ</button>${generatedActionHtml('roads', feature)}</div>`;
  }

  function render() {
    if (layer) map.removeLayer(layer);
    layer = null;
    if (attributionVisible) {
      map.attributionControl.removeAttribution(ROAD_ATTRIBUTION);
      attributionVisible = false;
    }
    const data = getData();
    if (!data || !isVisible()) return;
    const outer = Leaflet.geoJSON(data, {pane: 'foundationPane', filter: featureIsVisible, style, onEachFeature: (feature, featureLayer) => featureLayer.bindPopup(popup(feature), {maxWidth: 320})});
    const inner = Leaflet.geoJSON(data, {pane: 'foundationPane', interactive: false, filter: feature => featureIsVisible(feature) && String(feature.properties?.isomSymbol) === '502' && generatedStatus(feature) !== 'excluded', style: feature => ({...lineStyles('502', feature.properties || {}, normContext()).inner, className: 'osm-road-fill'})});
    layer = Leaflet.layerGroup([outer, inner]).addTo(map);
    map.attributionControl.addAttribution(ROAD_ATTRIBUTION);
    attributionVisible = true;
  }

  function refreshMeta() {
    metaElement().textContent = roadMetaText(getData(), generatedStatus, centralLayerLabel);
  }

  return {render, refreshMeta};
}
