export function createFieldMap({Leaflet, initialCenter, hasWorkspace}) {
  const map = Leaflet.map('map', {zoomControl: false}).setView(
    [initialCenter.lat, initialCenter.lng],
    hasWorkspace ? 14 : 15
  );
  Leaflet.control.zoom({position: 'bottomright'}).addTo(map);

  const panes = {
    basemapPane: 200,
    landCoverPane: 300,
    pavedAreaPane: 310,
    restrictedAreaPane: 320,
    contourPane: 340,
    northLinePane: 360,
    foundationPane: 380,
    infrastructurePane: 385,
    buildingPane: 390,
    evidencePane: 425,
    globalObjectPane: 440,
    fieldPane: 450,
    gpsPane: 650
  };
  const nonInteractive = new Set(['contourPane', 'northLinePane', 'evidencePane', 'gpsPane']);
  for (const [name, zIndex] of Object.entries(panes)) {
    map.createPane(name);
    const pane = map.getPane(name);
    pane.style.zIndex = zIndex;
    if (nonInteractive.has(name)) pane.style.pointerEvents = 'none';
  }

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
