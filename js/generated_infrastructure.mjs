import {generatedMapObject, mapObjectPopup} from './map_objects.mjs';
import {parallelLineCoordinates} from './symbol_object_settings.mjs?v=4';

export const INFRASTRUCTURE_TYPES = Object.freeze({
  '509': ['railway', 'Järnväg'],
  '510': ['power_line', 'Kraftledning eller linbana'],
  '511': ['major_power_line', 'Större kraftledning']
});

export const INFRASTRUCTURE_ATTRIBUTION = 'Järnvägar och kraftledningar © OpenStreetMap contributors';

export function infrastructureMetaText(data, generatedStatus, centralLayerLabel) {
  if (!data) return 'Inte hämtade';
  const counts = {rail: 0, power: 0, supports: 0, edited: 0, excluded: 0};
  data.features.forEach(feature => {
    const properties = feature.properties || {};
    if (properties.featureKind === 'support') counts.supports++;
    else if (String(properties.isomSymbol) === '509') counts.rail++;
    else counts.power++;
    if (generatedStatus(feature) === 'edited') counts.edited++;
    if (generatedStatus(feature) === 'excluded') counts.excluded++;
  });
  return `${counts.rail} järnvägar · ${counts.power} ledningar · ${counts.supports} stolpar/master${counts.edited ? ` · ${counts.edited} ändrade` : ''}${counts.excluded ? ` · ${counts.excluded} uteslutna` : ''}${centralLayerLabel(data)}`;
}

export function createGeneratedInfrastructureLayer({Leaflet, map, mapMarker = Leaflet.marker, renderer, getData, isVisible, featureIsSelected, generatedStatus, generatedStatusLabel, generatedClass, generatedActionHtml, excludedStyle, symbolScale, normContext, pointNormContext, isomClaim, escapeHtml, centralLayerLabel, metaElement}) {
  let layer = null;
  let attributionVisible = false;

  function outerStyle(feature) {
    const symbol = String(feature.properties?.isomSymbol || '510');
    if (['excluded', 'deleted'].includes(generatedStatus(feature))) return excludedStyle(symbolScale());
    return {...renderer.lineStyles(symbol, feature.properties || {}, normContext()).outer, className: generatedClass(feature, `osm-infrastructure infrastructure-${symbol}`)};
  }

  function innerStyle(feature) {
    const symbol = String(feature.properties?.isomSymbol);
    return {...renderer.lineStyles(symbol, feature.properties || {}, normContext()).inner, className: `infrastructure-${symbol}-inner map-line-object`};
  }

  function supportIcon(feature) {
    const properties = feature.properties || {};
    const symbol = String(properties.isomSymbol || '510');
    const large = symbol === '511' && Boolean(properties.largeMast);
    const definition = renderer.definition(symbol);
    const context = (pointNormContext || normContext)();
    if (large) {
      const rendered = renderer.pointMarkup('524', context, properties);
      return Leaflet.divIcon({className: `infrastructure-support-icon generated-object map-point-object ${generatedStatus(feature)}`, html: rendered.mapHtml, iconSize: [rendered.sizePx, rendered.sizePx], iconAnchor: [rendered.sizePx / 2, rendered.sizePx / 2]});
    }
    const unit = renderer.pixelsPerPaperMm(map, context.scale, context.mode);
    const width = renderer.paperMm(definition.supportWidthMm, context.scale) * unit;
    const stroke = renderer.paperMm(definition.supportStrokeMm, context.scale) * unit;
    const size = Math.max(18, width + 8);
    const angle = 90 - Number(properties.angleDegrees || 0);
    return Leaflet.divIcon({className: `infrastructure-support-icon generated-object map-point-object ${generatedStatus(feature)}`, html: `<span class="${large ? 'large' : ''}" style="--support-width:${width}px;--support-stroke:${stroke}px;transform:rotate(${angle}deg)"></span>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2]});
  }

  function popup(feature) {
    const properties = feature.properties || {};
    const symbol = String(properties.isomSymbol || '510');
    const support = properties.featureKind === 'support';
    const confidence = {high: 'hög', medium: 'medel', low: 'låg'};
    const id = escapeHtml(feature.id);
    const options = Object.entries(INFRASTRUCTURE_TYPES).map(([value, data]) => `<option value="${value}" ${symbol === value ? 'selected' : ''}>${value} ${data[1]}</option>`).join('');
    const title = properties.name || INFRASTRUCTURE_TYPES[symbol]?.[1] || 'Tekniskt linjeobjekt';
    const object = generatedMapObject('infrastructure', feature, {symbol, statusLabel: generatedStatusLabel(feature), editable: !support});
    const controlsHtml = support ? '' : `<select class="infrastructure-type-select" data-infrastructure-id="${id}">${options}</select><button type="button" data-infrastructure-review="change" data-infrastructure-id="${id}">Ändra typ</button>`;
    return mapObjectPopup(object, {title: support ? (properties.largeMast ? 'Högt torn' : properties.supportType === 'tower' ? 'Kraftledningsmast' : 'Kraftledningsstolpe') : title, isomClaim, escapeHtml, secondaryDetails: [support ? 'Exakt OSM-position' : `Klassificeringssäkerhet ${confidence[properties.classificationConfidence] || 'okänd'}`], controlsHtml, actionsHtml: generatedActionHtml('infrastructure', feature, {editable: !support})});
  }

  function render() {
    if (layer) map.removeLayer(layer);
    layer = null;
    if (attributionVisible) {
      map.attributionControl.removeAttribution(INFRASTRUCTURE_ATTRIBUTION);
      attributionVisible = false;
    }
    const data = getData();
    if (!data || !isVisible()) return;
    const lineFilter = feature => feature.properties?.featureKind === 'line' && featureIsSelected(feature);
    const outer = Leaflet.geoJSON(data, {pane: 'infrastructurePane', filter: feature => lineFilter(feature) && String(feature.properties?.isomSymbol) !== '511', style: outerStyle, onEachFeature: (feature, featureLayer) => featureLayer.bindPopup(popup(feature), {maxWidth: 320})});
    const majorPowerLines = {type: 'FeatureCollection', features: data.features.filter(feature => lineFilter(feature) && String(feature.properties?.isomSymbol) === '511').flatMap(feature => {
      if (['excluded', 'deleted'].includes(generatedStatus(feature))) return [feature];
      const definition = renderer.definition('511'), coordinates = feature.geometry?.coordinates || [];
      return [-1, 1].map(side => ({...feature, id: `${feature.id}:side:${side}`, geometry: {...feature.geometry, coordinates: parallelLineCoordinates(coordinates, definition.lineCentreGapMm, 15000)(side)}}));
    })};
    const major = Leaflet.geoJSON(majorPowerLines, {pane: 'infrastructurePane', style: outerStyle, onEachFeature: (feature, featureLayer) => featureLayer.bindPopup(popup(feature), {maxWidth: 320})});
    const inner = Leaflet.geoJSON(data, {pane: 'infrastructurePane', interactive: false, filter: feature => lineFilter(feature) && String(feature.properties?.isomSymbol) === '509' && !['excluded', 'deleted'].includes(generatedStatus(feature)), style: innerStyle});
    const supports = Leaflet.geoJSON(data, {pane: 'infrastructurePane', filter: feature => feature.properties?.featureKind === 'support' && featureIsSelected(feature), pointToLayer: (feature, latlng) => mapMarker(latlng, {pane: 'infrastructureMarkerPane', icon: supportIcon(feature)}), onEachFeature: (feature, featureLayer) => featureLayer.bindPopup(popup(feature), {maxWidth: 300})});
    layer = Leaflet.layerGroup([outer, major, inner, supports]).addTo(map);
    map.attributionControl.addAttribution(INFRASTRUCTURE_ATTRIBUTION);
    attributionVisible = true;
  }

  function refreshMeta() {
    metaElement().textContent = infrastructureMetaText(getData(), generatedStatus, centralLayerLabel);
  }

  return {render, refreshMeta};
}
