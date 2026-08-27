export const generationProfileLabels = {
  quick: 'Snabbt utkast',
  standard: 'Standard',
  detailed: 'Detaljerad',
  custom: 'Eget urval'
};

export const generationPresets = {
  surface: {
    quick: {buildings: true, water: true, land: true, paved: false, restricted: true, restrictedMode: 'cautious'},
    standard: {buildings: true, water: true, land: true, paved: true, restricted: true, restrictedMode: 'balanced'},
    detailed: {buildings: true, water: true, land: true, paved: true, restricted: true, restrictedMode: 'detailed'}
  },
  line: {
    quick: {roads: true, paths: true, faintPaths: false, watercourses: false, railways: false, disusedRailways: false, powerLines: false, aerialways: false},
    standard: {roads: true, paths: true, faintPaths: false, watercourses: true, railways: true, disusedRailways: false, powerLines: true, aerialways: false},
    detailed: {roads: true, paths: true, faintPaths: true, watercourses: true, railways: true, disusedRailways: true, powerLines: true, aerialways: true}
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
    surface: {profile: surfaceProfile, ...generationPresets.surface[surfaceProfile], ...(saved.surface || {})},
    line: {profile: lineProfile, ...generationPresets.line[lineProfile], ...(saved.line || {})}
  };
}

export function applyGenerationProfile(settings, category, profile) {
  settings[category] = {profile, ...generationPresets[category][profile]};
}

export function generationSummary(settings, category) {
  const selected = settings[category];
  const fields = category === 'surface'
    ? ['buildings', 'water', 'land', 'paved', 'restricted']
    : ['roads', 'paths', 'faintPaths', 'watercourses', 'railways', 'disusedRailways', 'powerLines', 'aerialways'];
  const count = fields.filter(key => selected[key]).length;
  return `${generationProfileLabels[selected.profile] || 'Eget urval'} · ${count} kategorier`;
}
