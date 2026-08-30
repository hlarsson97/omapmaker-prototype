import {generatedMapObject, mapObjectPopup} from './map_objects.mjs';

export const LAND_COVER_ATTRIBUTION = 'Mark, vatten och ISOM 520-underlag © OpenStreetMap contributors';

export const WATER_SYMBOL_CLASSES = Object.freeze({'301': 'water_301', '302': 'water_302', '303': 'water_303', '304': 'watercourse_304', '305': 'watercourse_305', '306': 'watercourse_306', '307': 'marsh_307', '308': 'marsh_308', '309': 'marsh_309', '310': 'marsh_310', '311': 'water_311', '312': 'water_312', '313': 'water_313'});
export const WATER_SYMBOL_NAMES = Object.freeze({'301': 'Ej passerbar vattenyta', '302': 'Grund vattenyta', '303': 'Vattenhål', '304': 'Passerbart vattendrag', '305': 'Mindre vattendrag', '306': 'Mindre eller periodiskt vattenflöde', '307': 'Ej passerbar sankmark', '308': 'Sankmark', '309': 'Smal sankmark', '310': 'Otydlig sankmark', '311': 'Brunn, fontän eller vattentank', '312': 'Källa', '313': 'Framträdande vattenobjekt'});

export function isWaterFeature(feature) {
  const symbol = String(feature.properties?.isomSymbol || '');
  return Number(symbol) >= 301 && Number(symbol) <= 313;
}

export function isCurrentLandCoverData(data) {
  return Number(data?.properties?.importVersion || 0) >= 10;
}

export function landCoverMetaText(data, generatedStatus, centralLayerLabel) {
  if (!data) return 'Inte hämtat';
  const counts = {water: 0, restricted: 0, edited: 0, excluded: 0};
  data.features.forEach(feature => {
    if (isWaterFeature(feature)) counts.water++;
    if (String(feature.properties?.isomSymbol) === '520') counts.restricted++;
    if (generatedStatus(feature) === 'edited') counts.edited++;
    if (generatedStatus(feature) === 'excluded') counts.excluded++;
  });
  if (!isCurrentLandCoverData(data)) return `${counts.water} vatten · 520 behöver hämtas på nytt`;
  return `${counts.water} vatten · ${counts.restricted} st 520${counts.edited ? ` · ${counts.edited} ändrade` : ''}${counts.excluded ? ` · ${counts.excluded} uteslutna` : ''}${centralLayerLabel(data)}`;
}

export function createGeneratedLandCoverLayer({Leaflet, map, mapMarker = Leaflet.marker, renderer, getData, isVisible, featureIsSelected, generatedStatus, generatedStatusLabel, generatedClass, generatedActionHtml, excludedStyle, symbolScale, isomLineStyle, isomAreaStyle, normContext, isomClaim, escapeHtml, centralLayerLabel, metaElement, getDeclination, documentObject = document, schedule = requestAnimationFrame}) {
  let layer = null;
  let attributionVisible = false;
  let patternSerial = 0;

  function style(feature) {
    const properties = feature.properties || {};
    const symbol = String(properties.isomSymbol || '');
    if (['excluded', 'deleted'].includes(generatedStatus(feature))) return excludedStyle(Math.max(.7, symbolScale()));
    const fallbackSymbols = {open_land: '401', rough_open_land: '403', cultivated_land: '412'};
    const renderedStyle = feature.geometry?.type?.includes('Line') ? isomLineStyle(symbol, feature) : isomAreaStyle(symbol || fallbackSymbols[properties.mapClass], properties);
    return {...renderedStyle, opacity: 1, className: generatedClass(feature, `osm-land-cover isom-pattern-${symbol} ${properties.mapClass || ''} ${properties.restrictedKind || ''}`)};
  }

  function pointIcon(feature) {
    const symbol = String(feature.properties?.isomSymbol || '303');
    const rendered = renderer.pointMarkup(symbol, normContext());
    const size = rendered.sizePx;
    return Leaflet.divIcon({className: `omap-water-symbol generated-object map-point-object ${generatedStatus(feature)}`, html: rendered.mapHtml, iconSize: [size, size], iconAnchor: [size / 2, size / 2]});
  }

  function symbolOptions(feature) {
    const type = feature.geometry?.type || '';
    if (type === 'Point') return ['303', '311', '312', '313'];
    if (type.includes('Line')) return ['304', '305', '306', '309'];
    return ['301', '302', '307', '308', '310'];
  }

  function popup(feature) {
    const properties = feature.properties || {};
    const confidence = {high: 'hög', medium: 'medel', low: 'låg'};
    const restrictedNames = {'industrial-enclosure': 'Inhägnat industriområde', 'industrial-private': 'Privat industriområde', 'residential-enclosure': 'Avgränsad hemfridszon', 'residential-boundary': 'Möjlig hemfridszon', 'residential-estimate': 'Uppskattad hemfridszon'};
    const names = {cultivated_land: 'Odlad mark', open_land: 'Öppen mark', rough_open_land: 'Öppen naturmark', restricted_area: restrictedNames[properties.restrictedKind] || 'ISOM 520-underlag'};
    const water = isWaterFeature(feature);
    const title = properties.name || (water ? WATER_SYMBOL_NAMES[String(properties.isomSymbol)] : names[properties.mapClass]) || 'Markyta';
    const id = escapeHtml(feature.id);
    const select = water ? `<select class="land-cover-type-select" data-land-cover-id="${id}">${symbolOptions(feature).map(symbol => `<option value="${symbol}" ${String(properties.isomSymbol) === symbol ? 'selected' : ''}>${symbol} ${WATER_SYMBOL_NAMES[symbol]}</option>`).join('')}</select><button type="button" data-land-cover-review="change" data-land-cover-id="${id}">Ändra typ</button>` : '';
    const object = generatedMapObject('land-cover', feature, {statusLabel: generatedStatusLabel(feature)});
    const osmType = properties.boundaryEvidence || properties.building || properties.barrier || properties.natural || properties.wetland || properties.water || properties.waterway || properties.landuse || 'okänd typ';
    return mapObjectPopup(object, {title, isomClaim, escapeHtml, primaryDetails: properties.reviewRequired ? [`säkerhet ${confidence[properties.classificationConfidence] || 'okänd'}`] : [], secondaryDetails: [`OSM-typ: ${osmType}`], controlsHtml: select, actionsHtml: generatedActionHtml('land-cover', feature), className: 'land-cover-popup'});
  }

  function installPatterns() {
    const symbols = ['307', '308', '310', '402', '404', '412'];
    const paths = [...documentObject.querySelectorAll(symbols.map(symbol => `.isom-pattern-${symbol}`).join(','))];
    const bySvg = new Map();
    paths.forEach(path => {
      const svg = path.ownerSVGElement;
      if (!svg) return;
      if (!bySvg.has(svg)) bySvg.set(svg, []);
      bySvg.get(svg).push(path);
    });
    const context = normContext();
    const unit = renderer.pixelsPerPaperMm(map, context.scale, context.mode);
    const declination = Number(getDeclination()) || 0;
    bySvg.forEach((items, svg) => {
      let defs = svg.querySelector('defs.omap-water-patterns');
      if (!defs) {
        defs = documentObject.createElementNS('http://www.w3.org/2000/svg', 'defs');
        defs.classList.add('omap-water-patterns');
        svg.prepend(defs);
      }
      const serial = ++patternSerial;
      symbols.forEach(symbol => {
        const definition = renderer.definition(symbol);
        const id = `omap-pattern-${symbol}-${serial}`;
        const pattern = documentObject.createElementNS('http://www.w3.org/2000/svg', 'pattern');
        const spacing = Math.max(2, renderer.paperMm(definition.patternSpacingMm || .8, context.scale) * unit);
        const line = Math.max(.5, renderer.paperMm(definition.patternLineWidthMm || .1, context.scale) * unit);
        const dot = Math.max(1, renderer.paperMm(definition.dotDiameterMm || .4, context.scale) * unit);
        pattern.setAttribute('id', id);
        pattern.setAttribute('patternUnits', 'userSpaceOnUse');
        pattern.setAttribute('width', spacing);
        pattern.setAttribute('height', spacing);
        if (definition.northOriented) pattern.setAttribute('patternTransform', `rotate(${declination + Number(definition.patternAngleDeg || 0)})`);
        const fill = definition.fill ? renderer.colour(definition.fill) : 'transparent';
        const ink = renderer.colour(definition.patternColour || 'blue');
        if (fill !== 'transparent') pattern.innerHTML += `<rect width="${spacing}" height="${spacing}" fill="${fill}"/>`;
        if (definition.pattern === 'scattered' || definition.pattern === 'cultivated') pattern.innerHTML += `<circle cx="${spacing / 2}" cy="${spacing / 2}" r="${dot / 2}" fill="${ink}"/>`;
        else pattern.innerHTML += `<path d="M0 ${line / 2}H${definition.pattern === 'marsh-dashed' ? Math.max(line, spacing * .75) : spacing}" stroke="${ink}" stroke-width="${line}"/>`;
        defs.append(pattern);
        items.filter(path => path.classList.contains(`isom-pattern-${symbol}`)).forEach(path => path.style.fill = `url(#${id})`);
      });
    });
  }

  function render() {
    if (layer) map.removeLayer(layer);
    layer = null;
    if (attributionVisible) {
      map.attributionControl.removeAttribution(LAND_COVER_ATTRIBUTION);
      attributionVisible = false;
    }
    const data = getData();
    if (!data || !isVisible()) return;
    const base = Leaflet.geoJSON(data, {pane: 'landCoverPane', filter: feature => String(feature.properties?.isomSymbol) !== '520' && featureIsSelected(feature), style, pointToLayer: (feature, latlng) => mapMarker(latlng, {pane: 'landCoverMarkerPane', icon: pointIcon(feature)}), onEachFeature: (feature, featureLayer) => featureLayer.bindPopup(popup(feature), {maxWidth: 310})});
    const restricted = Leaflet.geoJSON(data, {pane: 'restrictedAreaPane', filter: feature => isCurrentLandCoverData(data) && String(feature.properties?.isomSymbol) === '520' && featureIsSelected(feature), style, onEachFeature: (feature, featureLayer) => featureLayer.bindPopup(popup(feature), {maxWidth: 310})});
    layer = Leaflet.layerGroup([base, restricted]).addTo(map);
    schedule(installPatterns);
    map.attributionControl.addAttribution(LAND_COVER_ATTRIBUTION);
    attributionVisible = true;
  }

  function refreshMeta() {
    metaElement().textContent = landCoverMetaText(getData(), generatedStatus, centralLayerLabel);
  }

  return {render, refreshMeta, installPatterns};
}
