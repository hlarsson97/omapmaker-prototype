const SOURCE_LABELS = Object.freeze({
  osm: 'OpenStreetMap',
  lantmateriet: 'Lantmäteriet',
  gps: 'GPS-inmätt',
  manual: 'Manuellt skapad',
  'manual-adjustment': 'Justerad manuellt (äldre objekt)',
  unknown: 'Okänd källa'
});

const LOCAL_STATUS_LABELS = Object.freeze({
  local: 'Lokalt utkast',
  submitted: 'Insänd observation'
});

export function mapObjectSource(source, sourceId = '') {
  const type = String(source || 'unknown');
  return {type, label: SOURCE_LABELS[type] || type, id: String(sourceId || '')};
}

export function localMapObject(cat, object, symbol) {
  const geometryType = {point: 'Point', line: 'LineString', area: 'Polygon'}[cat] || '';
  return {
    id: String(object.id),
    category: cat,
    objectType: object.objectType,
    symbol: String(symbol || object.symbol || ''),
    geometryType,
    source: mapObjectSource(object.source),
    status: {type: object.syncStatus || 'local', label: LOCAL_STATUS_LABELS[object.syncStatus] || object.syncStatus || LOCAL_STATUS_LABELS.local},
    editable: true,
    modifiedBy: object.modifiedBy || null
  };
}

export function generatedMapObject(layerType, feature, {symbol, statusLabel, source = 'osm', editable = true} = {}) {
  const properties = feature.properties || {};
  return {
    id: String(feature.id),
    category: layerType,
    objectType: properties.objectType || properties.mapClass || properties.featureKind || layerType,
    symbol: String(symbol ?? properties.isomSymbol ?? ''),
    geometryType: feature.geometry?.type || '',
    source: mapObjectSource(source, properties.sourceId),
    status: {type: properties.status || 'automatic-unverified', label: statusLabel},
    editable
  };
}

export function mapObjectPopup(object, {title, isomClaim, escapeHtml, primaryDetails = [], secondaryDetails = [], controlsHtml = '', actionsHtml = '', className = ''}) {
  const primary = [isomClaim(object.symbol, object.geometryType), object.status.label, ...primaryDetails].filter(Boolean).map(value => escapeHtml(value)).join(' · ');
  const source = [object.source.label, object.source.id].filter(Boolean).map(value => escapeHtml(value)).join(' · ');
  const secondary = secondaryDetails.filter(Boolean).map(value => `<small>${escapeHtml(value)}</small>`).join('');
  const classes = [className, 'generated-object-popup'].filter(Boolean).join(' ');
  return `<div class="${escapeHtml(classes)}"><b>${escapeHtml(title)}</b><small>${primary}</small><small>${source}</small>${secondary}${controlsHtml}${actionsHtml}</div>`;
}
