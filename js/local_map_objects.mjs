import {localMapObject, mapObjectActionHtml, mapObjectPopup, mapObjectSource} from './map_objects.mjs';

export function localObjectSourceLabel(source) {
  return mapObjectSource(source).label;
}

export function localObjectPopup(cat, object, {name, isomClaim, escapeHtml}) {
  const mapObject = localMapObject(cat, object, object.symbol);
  const category = {point: 'Punkt', line: 'Linje', area: 'Yta'}[cat] || cat;
  const details = [category];
  details.push(mapObject.sync.label);
  if (cat === 'point' && Number(object.accuracy) > 0) details.push(`Noggrannhet ±${Math.round(Number(object.accuracy))} m`);
  if (mapObject.modifiedBy === 'manual') details.push('Geometrin är manuellt justerad');
  const actionsHtml = mapObjectActionHtml(mapObject, {kind: 'local', escapeHtml});
  return mapObjectPopup(mapObject, {title: name(cat, object.objectType), isomClaim, escapeHtml, secondaryDetails: details, actionsHtml, className: 'local-object-popup'});
}
