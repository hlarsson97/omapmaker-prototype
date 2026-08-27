export const BUILDING_ATTRIBUTION = 'Byggnader © OpenStreetMap contributors';

export function buildingMetaText(data, generatedStatus, centralLayerLabel) {
  if (!data) return 'Inte hämtade';
  const edited = data.features.filter(feature => generatedStatus(feature) === 'edited').length;
  const excluded = data.features.filter(feature => generatedStatus(feature) === 'excluded').length;
  return `${data.features.length} automatiska${edited ? ` · ${edited} ändrade` : ''}${excluded ? ` · ${excluded} uteslutna` : ''}${centralLayerLabel(data)}`;
}

export function createGeneratedBuildingLayer({Leaflet, map, getData, isVisible, generatedStatus, generatedStatusLabel, generatedClass, generatedActionHtml, excludedStyle, symbolScale, isomAreaStyle, isomClaim, escapeHtml, centralLayerLabel, metaElement}) {
  let layer = null;
  let attributionVisible = false;

  function style(feature) {
    if (generatedStatus(feature) === 'excluded') return excludedStyle(Math.max(1, symbolScale()));
    return {...isomAreaStyle('521', feature.properties), className: generatedClass(feature, 'osm-building')};
  }

  function popup(feature) {
    const properties = feature.properties || {};
    return `<div class="building-popup generated-object-popup"><b>${escapeHtml(properties.name || 'Byggnad')}</b><small>${isomClaim('521', feature.geometry?.type)} · ${escapeHtml(generatedStatusLabel(feature))}</small><small>OpenStreetMap · ${escapeHtml(properties.sourceId || '')}</small>${generatedActionHtml('buildings', feature)}</div>`;
  }

  function render() {
    if (layer) map.removeLayer(layer);
    layer = null;
    if (attributionVisible) {
      map.attributionControl.removeAttribution(BUILDING_ATTRIBUTION);
      attributionVisible = false;
    }
    const data = getData();
    if (!data || !isVisible()) return;
    layer = Leaflet.geoJSON(data, {
      pane: 'buildingPane',
      style,
      onEachFeature: (feature, featureLayer) => featureLayer.bindPopup(popup(feature), {maxWidth: 280})
    }).addTo(map);
    map.attributionControl.addAttribution(BUILDING_ATTRIBUTION);
    attributionVisible = true;
  }

  function refreshMeta() {
    metaElement().textContent = buildingMetaText(getData(), generatedStatus, centralLayerLabel);
  }

  return {render, refreshMeta};
}
