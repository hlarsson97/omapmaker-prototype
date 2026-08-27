export function centralLayerParameters(layerType, {workspace, symbolRegistryVersion}) {
  const parameters = {
    contours: () => ({interval: Number(workspace?.contourInterval || 5), generalization: 'detailed', baseElevation: 0, verticalDatum: 'RH 2000', symbolRegistryVersion}),
    buildings: () => ({importVersion: 3, symbolRegistryVersion}),
    roads: () => ({importVersion: 3, symbolRegistryVersion}),
    infrastructure: () => ({importVersion: 1, symbolRegistryVersion}),
    'paved-areas': () => ({importVersion: 1, symbolRegistryVersion}),
    'land-cover': () => ({importVersion: 8, printScale: Number(workspace?.scale || 10000), symbolRegistryVersion})
  };
  return parameters[layerType]();
}

export const CENTRAL_LAYER_TYPES = Object.freeze(['contours', 'buildings', 'roads', 'infrastructure', 'paved-areas', 'land-cover']);

export function createMapLayerApi({fetchImpl = fetch, jsonResponse, hostname = location.hostname}) {
  const postJson = async (endpoint, payload) => jsonResponse(await fetchImpl(endpoint, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload)
  }));

  async function resolveCentralLayer(layerType, {bbox, workspace, symbolRegistryVersion, maxAgeSeconds, includeLayer = true} = {}) {
    if (!bbox || hostname.includes('github.io')) return null;
    const payload = {
      bbox,
      layerType,
      parameters: centralLayerParameters(layerType, {workspace, symbolRegistryVersion}),
      includeLayer
    };
    if (maxAgeSeconds !== undefined) payload.maxAgeSeconds = maxAgeSeconds;
    const endpoint = workspace ? '/api/map-layers/resolve' : '/api/map-layers/mosaic';
    const data = await postJson(endpoint, payload);
    return data.found ? data : null;
  }

  async function centralOrSource(layerType, endpoint, {bbox, workspace, symbolRegistryVersion}) {
    const central = await resolveCentralLayer(layerType, {bbox, workspace, symbolRegistryVersion, maxAgeSeconds: 86400});
    if (central) return {data: central.layer, reused: true};
    const payload = {bbox};
    if (layerType === 'land-cover') payload.printScale = Number(workspace?.scale || 10000);
    return {data: await postJson(endpoint, payload), reused: false};
  }

  return {resolveCentralLayer, centralOrSource};
}

export function createCentralLayerRestorer({resolveCentralLayer, applyCentralLayer, clearCentralLayer, hasWorkspace, hostname = location.hostname, log = console.info}) {
  let restoreSequence = 0;

  return async function restoreCentralLayers() {
    if (hostname.includes('github.io')) return;
    const sequence = ++restoreSequence;
    const results = await Promise.allSettled(CENTRAL_LAYER_TYPES.map(async layerType => [layerType, await resolveCentralLayer(layerType)]));
    if (sequence !== restoreSequence) return;
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const [layerType, data] = result.value;
      if (data) await applyCentralLayer(layerType, data);
      else if (!hasWorkspace()) clearCentralLayer(layerType);
    }
    if (results.some(result => result.status === 'rejected')) log('Ett eller flera centrala kartlager kunde inte återställas just nu.');
  };
}
