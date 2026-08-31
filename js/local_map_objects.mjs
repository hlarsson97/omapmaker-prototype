import {localMapObject, mapObjectActionHtml, mapObjectPopup, mapObjectSource} from './map_objects.mjs';
import {symbolObjectControlsHtml} from './symbol_object_settings.mjs';

const TYPE_SPECIFIC_PROPERTIES = Object.freeze(['boundary', 'downhillSide', 'tagSide', 'lowerSide', 'supports', 'closedBoundary', 'parentObjectId', 'parentSymbol', 'breakBarrier', 'breakBarrierMode']);

export function changeLocalObjectType(cat, object, typeId, manualTypes, applyDefaults = () => {}) {
  const definition = manualTypes[typeId];
  if (!definition || definition.category !== cat || !definition.symbol) return false;
  object.objectType = typeId;
  object.symbol = String(definition.symbol);
  for (const property of TYPE_SPECIFIC_PROPERTIES) delete object[property];
  applyDefaults(object, object.symbol);
  return true;
}

export function localObjectSourceLabel(source) {
  return mapObjectSource(source).label;
}

export function localObjectPopup(cat, object, {name, isomClaim, escapeHtml, typeOptions = []}) {
  const mapObject = localMapObject(cat, object, object.symbol);
  const category = {point: 'Punkt', line: 'Linje', area: 'Yta'}[cat] || cat;
  const details = [category];
  details.push(mapObject.sync.label);
  if (cat === 'point' && Number(object.accuracy) > 0) details.push(`Noggrannhet ±${Math.round(Number(object.accuracy))} m`);
  const actionsHtml = mapObjectActionHtml(mapObject, {kind: 'local', escapeHtml});
  const options = typeOptions.map(option => `<option value="${escapeHtml(option.id)}" ${String(option.id) === String(object.objectType) ? 'selected' : ''}>${escapeHtml(option.symbol)} ${escapeHtml(option.name)}</option>`).join('');
  const typeControls = options ? `<div class="object-type-control"><label for="local-object-type-${escapeHtml(object.id)}">Objekttyp</label><select id="local-object-type-${escapeHtml(object.id)}" data-local-object-type="${escapeHtml(object.id)}">${options}</select><button type="button" data-local-object-change-type="${escapeHtml(object.id)}">Ändra typ</button></div>` : '';
  const controlsHtml = `${typeControls}${symbolObjectControlsHtml(object, escapeHtml)}`;
  return mapObjectPopup(mapObject, {title: name(cat, object.objectType), isomClaim, escapeHtml, secondaryDetails: details, controlsHtml, actionsHtml, className: 'local-object-popup'});
}
