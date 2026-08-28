import {cloneJson} from './utils.mjs';

const SOURCE_LABELS = Object.freeze({
  osm: 'OpenStreetMap',
  lantmateriet: 'Lantmäteriet',
  omapmaker: 'OMapMaker-observationer',
  gps: 'GPS-inmätt',
  manual: 'Manuellt skapad',
  'manual-adjustment': 'Justerad manuellt (äldre objekt)',
  unknown: 'Okänd källa'
});

export const MAP_OBJECT_CAPABILITIES = Object.freeze({editable: true, deletable: true, excludeable: true, resettable: true});

const LIFECYCLE_LABELS = Object.freeze({
  active: 'Aktivt kartobjekt',
  edited: 'Ändrat lokalt',
  excluded: 'Uteslutet lokalt',
  deleted: 'Raderat lokalt'
});

const SYNC_LABELS = Object.freeze({local: 'Lokalt utkast', submitted: 'Insänd observation'});

export function localObjectLifecycle(object) {
  if (object.status === 'locally-deleted') return 'deleted';
  if (object.status === 'locally-excluded') return 'excluded';
  if (object.modifiedBy || object.status === 'locally-edited') return 'edited';
  return 'active';
}

export function localOriginalSnapshot(object) {
  const snapshot = {};
  for (const key of ['objectType', 'symbol', 'coordinates', 'source', 'accuracy', 'quality', 'createdAt', 'boundary', 'downhillSide', 'tagSide', 'supports']) {
    if (object[key] !== undefined) snapshot[key] = cloneJson(object[key]);
  }
  return snapshot;
}

export function ensureLocalOriginal(object) {
  if (!object.originalObject) object.originalObject = localOriginalSnapshot(object);
  return object.originalObject;
}

export function restoreLocalOriginal(object) {
  const original = cloneJson(ensureLocalOriginal(object));
  for (const key of ['downhillSide', 'tagSide', 'supports']) if (!(key in original)) delete object[key];
  for (const [key, value] of Object.entries(original)) object[key] = value;
  for (const key of ['status', 'modifiedBy', 'modifiedAt', 'excludedAt', 'deletedAt']) delete object[key];
  return object;
}

export function mapObjectSource(source, sourceId = '') {
  const type = String(source || 'unknown');
  return {type, label: SOURCE_LABELS[type] || type, id: String(sourceId || '')};
}

export function localMapObject(cat, object, symbol) {
  const geometryType = {point: 'Point', line: 'LineString', area: 'Polygon'}[cat] || '';
  const lifecycle = localObjectLifecycle(object);
  return {
    id: String(object.id),
    category: cat,
    objectType: object.objectType,
    symbol: String(symbol || object.symbol || ''),
    geometryType,
    source: mapObjectSource(object.source),
    status: {type: lifecycle, label: LIFECYCLE_LABELS[lifecycle]},
    sync: {type: object.syncStatus || 'local', label: SYNC_LABELS[object.syncStatus] || object.syncStatus || SYNC_LABELS.local},
    capabilities: {...MAP_OBJECT_CAPABILITIES},
    modifiedBy: object.modifiedBy || null,
    canReset: lifecycle !== 'active'
  };
}

export function generatedMapObject(layerType, feature, {symbol, statusLabel, source = 'osm'} = {}) {
  const properties = feature.properties || {};
  return {
    id: String(feature.id),
    category: layerType,
    objectType: properties.objectType || properties.mapClass || properties.featureKind || layerType,
    symbol: String(symbol ?? properties.isomSymbol ?? ''),
    geometryType: feature.geometry?.type || '',
    source: mapObjectSource(source, properties.sourceId),
    status: {type: properties.status || 'automatic-unverified', label: statusLabel},
    capabilities: {...MAP_OBJECT_CAPABILITIES},
    canReset: Boolean(properties.originalGeometry || properties.status && properties.status !== 'automatic-unverified')
  };
}

export function mapObjectActionHtml(object, {kind, layerType = '', escapeHtml}) {
  const status = object.status.type;
  const inactive = ['excluded', 'deleted', 'locally-excluded', 'locally-deleted'].includes(status);
  const deleted = ['deleted', 'locally-deleted'].includes(status);
  const data = `data-object-kind="${escapeHtml(kind)}" data-object-id="${escapeHtml(object.id)}"${layerType ? ` data-object-layer="${escapeHtml(layerType)}"` : ''}`;
  const button = (action, label, disabled = false) => `<button type="button" data-object-action="${action}" ${data}${disabled ? ' disabled' : ''}>${label}</button>`;
  return `<div class="generated-actions">${object.capabilities.editable ? button('edit', 'Redigera objekt', inactive) : ''}${object.capabilities.excludeable ? button('exclude', 'Uteslut', inactive) : ''}${object.capabilities.deletable ? button('delete', deleted ? 'Raderat' : 'Radera', deleted) : ''}${object.capabilities.resettable ? button('reset', 'Återställ original', !object.canReset) : ''}</div>`;
}

export function mapObjectPopup(object, {title, isomClaim, escapeHtml, primaryDetails = [], secondaryDetails = [], controlsHtml = '', actionsHtml = '', className = ''}) {
  const primary = [isomClaim(object.symbol, object.geometryType), object.status.label, ...primaryDetails].filter(Boolean).map(value => escapeHtml(value)).join(' · ');
  const source = [object.source.label, object.source.id].filter(Boolean).map(value => escapeHtml(value)).join(' · ');
  const secondary = secondaryDetails.filter(Boolean).map(value => `<small>${escapeHtml(value)}</small>`).join('');
  const classes = [className, 'generated-object-popup'].filter(Boolean).join(' ');
  return `<div class="${escapeHtml(classes)}"><b>${escapeHtml(title)}</b><small>${primary}</small><small>${source}</small>${secondary}${controlsHtml}${actionsHtml}</div>`;
}
