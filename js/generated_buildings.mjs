import {generatedMapObject, mapObjectPopup} from './map_objects.mjs';

export const BUILDING_ATTRIBUTION = 'Byggnader © OpenStreetMap contributors';
export const LANTMATERIET_BUILDING_ATTRIBUTION = 'Byggnad Nedladdning, vektor © Lantmäteriet · bearbetad av OMapMaker · CC BY 4.0';

export function buildingAttribution(data) {
  return data?.properties?.sourceType === 'lantmateriet' ? LANTMATERIET_BUILDING_ATTRIBUTION : BUILDING_ATTRIBUTION;
}

export function buildingMetaText(data, generatedStatus, centralLayerLabel) {
  if (!data) return 'Inte hämtade';
  const edited = data.features.filter(feature => generatedStatus(feature) === 'edited').length;
  const excluded = data.features.filter(feature => generatedStatus(feature) === 'excluded').length;
  return `${data.features.length} automatiska${edited ? ` · ${edited} ändrade` : ''}${excluded ? ` · ${excluded} uteslutna` : ''}${centralLayerLabel(data)}`;
}

export function createGeneratedBuildingLayer({Leaflet, map, getData, isVisible, generatedStatus, generatedStatusLabel, generatedClass, generatedActionHtml, excludedStyle, symbolScale, isomAreaStyle, isomClaim, escapeHtml, centralLayerLabel, metaElement}) {
  let layer = null;
  let visibleAttribution = '';

  function style(feature) {
    if (['excluded', 'deleted'].includes(generatedStatus(feature))) return excludedStyle(Math.max(1, symbolScale()));
    return {...isomAreaStyle('521', feature.properties), className: generatedClass(feature, 'osm-building')};
  }

  function popup(feature) {
    const properties = feature.properties || {};
    const object = generatedMapObject('buildings', feature, {symbol: '521', statusLabel: generatedStatusLabel(feature), source: properties.sourceType || 'osm'});
    return mapObjectPopup(object, {title: properties.name || 'Byggnad', isomClaim, escapeHtml, actionsHtml: generatedActionHtml('buildings', feature), className: 'building-popup'});
  }

  function render() {
    if (layer) map.removeLayer(layer);
    layer = null;
    if (visibleAttribution) {
      map.attributionControl.removeAttribution(visibleAttribution);
      visibleAttribution = '';
    }
    const data = getData();
    if (!data || !isVisible()) return;
    layer = Leaflet.geoJSON(data, {
      pane: 'buildingPane',
      style,
      onEachFeature: (feature, featureLayer) => featureLayer.bindPopup(popup(feature), {maxWidth: 280})
    }).addTo(map);
    visibleAttribution = buildingAttribution(data);
    map.attributionControl.addAttribution(visibleAttribution);
  }

  function refreshMeta() {
    metaElement().textContent = buildingMetaText(getData(), generatedStatus, centralLayerLabel);
  }

  return {render, refreshMeta};
}
