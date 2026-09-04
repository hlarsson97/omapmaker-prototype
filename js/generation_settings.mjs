export const generationProfileLabels = {
  quick: 'Snabbt utkast',
  standard: 'Standard',
  detailed: 'Detaljerad',
  custom: 'Eget urval'
};

export const defaultGenerationSources = Object.freeze({buildings: 'automatic', roads: 'automatic'});
export const defaultMaxSmallHousePropertyArea = 4000;

export function normalizeMaxSmallHousePropertyArea(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(500, Math.min(20000, Math.round(number))) : defaultMaxSmallHousePropertyArea;
}

export const generationPresets = {
  surface: {
    quick: {buildings: true, water: true, land: true, paved: false, restricted: true, restrictedMode: 'cautious'},
    standard: {buildings: true, water: true, land: true, paved: true, restricted: true, restrictedMode: 'balanced'},
    detailed: {buildings: true, water: true, land: true, paved: true, restricted: true, restrictedMode: 'detailed'}
  },
  line: {
    quick: {roads: true, paths: true, faintPaths: false, watercourses: false, bridges: true, inferredBridges: false, railways: false, disusedRailways: false, powerLines: false, aerialways: false},
    standard: {roads: true, paths: true, faintPaths: false, watercourses: true, bridges: true, inferredBridges: false, railways: true, disusedRailways: false, powerLines: true, aerialways: false},
    detailed: {roads: true, paths: true, faintPaths: true, watercourses: true, bridges: true, inferredBridges: true, railways: true, disusedRailways: true, powerLines: true, aerialways: true}
  }
};

export function readGenerationSettings(storage, storageKey) {
  let saved = {};
  try {
    saved = JSON.parse(storage.getItem(storageKey) || '{}');
  } catch {}
  const surfaceProfile = generationPresets.surface[saved.surface?.profile] ? saved.surface.profile : 'standard';
  const lineProfile = generationPresets.line[saved.line?.profile] ? saved.line.profile : 'standard';
  return {
    surface: {profile: surfaceProfile, ...generationPresets.surface[surfaceProfile], ...(saved.surface || {}), maxSmallHousePropertyArea: normalizeMaxSmallHousePropertyArea(saved.surface?.maxSmallHousePropertyArea)},
    line: {profile: lineProfile, ...generationPresets.line[lineProfile], ...(saved.line || {})},
    sources: {...defaultGenerationSources, ...(saved.sources || {})}
  };
}

export function applyGenerationProfile(settings, category, profile) {
  const advanced = category === 'surface' ? {maxSmallHousePropertyArea: normalizeMaxSmallHousePropertyArea(settings.surface?.maxSmallHousePropertyArea)} : {};
  settings[category] = {profile, ...generationPresets[category][profile], ...advanced};
}

export function generationSummary(settings, category) {
  const selected = settings[category];
  const fields = category === 'surface'
    ? ['buildings', 'water', 'land', 'paved', 'restricted']
    : ['roads', 'paths', 'faintPaths', 'watercourses', 'bridges', 'inferredBridges', 'railways', 'disusedRailways', 'powerLines', 'aerialways'];
  const count = fields.filter(key => selected[key]).length;
  return `${generationProfileLabels[selected.profile] || 'Eget urval'} · ${count} kategorier`;
}
