export const PAVED_AREA_ATTRIBUTION = 'Hårdgjorda ytor © OpenStreetMap contributors';

export function pavedAreaMetaText(data, generatedStatus, centralLayerLabel) {
  if (!data) return 'Inte hämtade';
  const edited = data.features.filter(feature => generatedStatus(feature) === 'edited').length;
  const excluded = data.features.filter(feature => generatedStatus(feature) === 'excluded').length;
  return `${data.features.length} automatiska${edited ? ` · ${edited} ändrade` : ''}${excluded ? ` · ${excluded} uteslutna` : ''}${centralLayerLabel(data)}`;
}

export function createGeneratedPavedAreaLayer({Leaflet, map, getData, isVisible, generatedStatus, generatedStatusLabel, generatedClass, generatedActionHtml, excludedStyle, symbolScale, isomAreaStyle, isomClaim, escapeHtml, centralLayerLabel, metaElement}) {
  let layer = null;
  let attributionVisible = false;

  function style(feature) {
    if (generatedStatus(feature) === 'excluded') return excludedStyle(Math.max(1, symbolScale()));
    return {...isomAreaStyle('501', feature.properties), className: generatedClass(feature, 'osm-paved-area')};
  }

  function popup(feature) {
    const properties = feature.properties || {};
    return `<div class="paved-area-popup generated-object-popup"><b>${escapeHtml(properties.name || 'Hårdgjord yta')}</b><small>${isomClaim('501', feature.geometry?.type)} · ${escapeHtml(generatedStatusLabel(feature))}</small><small>${Math.round(properties.areaSquareMetres || 0)} m²${properties.surface ? ` · ${escapeHtml(properties.surface)}` : ''} · ${escapeHtml(properties.sourceId || '')}</small>${generatedActionHtml('paved-areas', feature)}</div>`;
  }

  function render() {
    if (layer) map.removeLayer(layer);
    layer = null;
    if (attributionVisible) {
      map.attributionControl.removeAttribution(PAVED_AREA_ATTRIBUTION);
      attributionVisible = false;
    }
    const data = getData();
    if (!data || !isVisible()) return;
    layer = Leaflet.geoJSON(data, {
      pane: 'pavedAreaPane',
      style,
      onEachFeature: (feature, featureLayer) => featureLayer.bindPopup(popup(feature), {maxWidth: 300})
    }).addTo(map);
    map.attributionControl.addAttribution(PAVED_AREA_ATTRIBUTION);
    attributionVisible = true;
  }

  function refreshMeta() {
    metaElement().textContent = pavedAreaMetaText(getData(), generatedStatus, centralLayerLabel);
  }

  return {render, refreshMeta};
}
