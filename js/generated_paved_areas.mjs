import {generatedMapObject, mapObjectPopup} from './map_objects.mjs';

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
    if (['excluded', 'deleted'].includes(generatedStatus(feature))) return excludedStyle(Math.max(1, symbolScale()));
    return {...isomAreaStyle('501', feature.properties), className: generatedClass(feature, 'osm-paved-area')};
  }

  function popup(feature) {
    const properties = feature.properties || {};
    const object = generatedMapObject('paved-areas', feature, {symbol: '501', statusLabel: generatedStatusLabel(feature)});
    const details = [`${Math.round(properties.areaSquareMetres || 0)} m²`, properties.surface];
    return mapObjectPopup(object, {title: properties.name || 'Hårdgjord yta', isomClaim, escapeHtml, secondaryDetails: [details.filter(Boolean).join(' · ')], actionsHtml: generatedActionHtml('paved-areas', feature), className: 'paved-area-popup'});
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
