export function createFieldMap({Leaflet, initialCenter, hasWorkspace}) {
  const map = Leaflet.map('map', {zoomControl: false, rotate: true, bearing: 0, touchRotate: true, dragRotate: false, shiftKeyRotate: true}).setView(
    [initialCenter.lat, initialCenter.lng],
    hasWorkspace ? 14 : 15
  );
  for (const handler of ['touchGestures','dragRotate','shiftKeyRotate']) map[handler]?.disable?.();
  map.touchZoom?.enable?.();
  Leaflet.control.zoom({position: 'bottomright'}).addTo(map);

  const panes = {
    basemapPane: 200,
    landCoverPane: 300,
    pavedAreaPane: 310,
    restrictedAreaPane: 320,
    contourPane: 340,
    propertyBoundaryPane: 350,
    northLinePane: 360,
    foundationPane: 380,
    infrastructurePane: 385,
    buildingPane: 390,
    mapLabelPane: 395,
    evidencePane: 425,
    globalObjectPane: 440,
    fieldPane: 450,
    gpsPane: 650
  };
  const rotatingMarkerPanes = {
    landCoverMarkerPane: 305,
    infrastructureMarkerPane: 387,
    globalMarkerPane: 441,
    fieldMarkerPane: 451
  };
  const nonInteractive = new Set(['contourPane', 'northLinePane', 'mapLabelPane', 'evidencePane', 'gpsPane']);
  const rotatingPane = map.getPane('overlayPane')?.parentElement;
  for (const [name, zIndex] of Object.entries(panes)) {
    map.createPane(name, rotatingPane);
    const pane = map.getPane(name);
    pane.style.zIndex = zIndex;
    if (nonInteractive.has(name)) pane.style.pointerEvents = 'none';
  }
  for (const [name, zIndex] of Object.entries(rotatingMarkerPanes)) {
    map.createPane(name, rotatingPane);
    map.getPane(name).style.zIndex = zIndex;
  }
  const nonRotatingPane = map.getPane('markerPane')?.parentElement;
  map.createPane('editMarkerPane', nonRotatingPane);
  map.getPane('editMarkerPane').style.zIndex = 700;

  const baseMaps = {
    osm: Leaflet.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {pane: 'basemapPane', maxZoom: 20, attribution: '© OpenStreetMap'}),
    aerial: Leaflet.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {pane: 'basemapPane', maxZoom: 19, attribution: 'Imagery © Esri'}),
    terrain: Leaflet.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {pane: 'basemapPane', maxZoom: 17, attribution: '© OpenStreetMap · SRTM | OpenTopoMap'}),
    orientation: null
  };
  const contourReference = Leaflet.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    pane: 'contourPane',
    className: 'contour-reference',
    opacity: 0.42,
    maxZoom: 17,
    attribution: 'Höjdkurvor © OpenTopoMap · SRTM'
  });
  return {map, baseMaps, contourReference};
}
