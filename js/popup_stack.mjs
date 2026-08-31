export function popupLayersFromElements(elements, map, source = null) {
  const layers = [], seen = new Set();
  const add = layer => {
    if (!layer || seen.has(layer) || typeof layer.getPopup !== 'function' || !layer.getPopup()) return;
    if (typeof layer.getPopup().getContent() !== 'string') return;
    seen.add(layer);
    layers.push(layer);
  };
  add(source);
  for (const element of elements || []) {
    let current = element;
    while (current && current !== map.getContainer()) {
      add(map._targets?.[current._leaflet_id]);
      current = current.parentElement;
    }
  }
  return layers;
}

export function popupStackContent(content, index, total) {
  if (total < 2) return content;
  const position = Math.max(0, Math.min(total - 1, Number(index) || 0));
  return `<nav class="popup-stack-nav" aria-label="Överlappande kartobjekt"><b>Objekt ${position + 1}/${total}</b><span><button type="button" data-popup-stack-step="-1" aria-label="Föregående objekt">‹</button><button type="button" data-popup-stack-step="1" aria-label="Nästa objekt">›</button></span></nav>${content}`;
}
