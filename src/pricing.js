// Material cost estimate: material presets, the user's settings (kept in localStorage)
// and the per-object estimate shown in the sidebar.
//
// Two numbers per printer type:
// - estimate: FDM prints walls solid and fills the inside with infill; resin prints are
//   hollowed to a wall thickness (or solid when it is 0). The wall volume is approximated
//   as surface area × wall thickness.
// - max: the whole model printed solid (100 % infill / not hollowed).
// Both include the supports & waste allowance.

// Densities (g/cm³) from manufacturer data sheets and slicer filament profiles; resin
// values are for the liquid resin as printed on data sheets (cured parts are 5–10 %
// denser, which the waste allowance covers). Prices are typical mid-range EU retail
// per kg incl. VAT (eSun, Sunlu, Elegoo, Anycubic, Polymaker, Phrozen), September 2026.
export const MATERIALS = {
  fdm: [
    { id: 'pla', name: 'PLA', density: 1.24, price: 18 },
    { id: 'pla-plus', name: 'PLA+ / PLA Pro', density: 1.23, price: 18 },
    { id: 'pla-silk', name: 'Silk PLA', density: 1.24, price: 20 },
    { id: 'pla-cf', name: 'PLA-CF', density: 1.22, price: 27 },
    { id: 'petg', name: 'PETG', density: 1.27, price: 17 },
    { id: 'petg-cf', name: 'PETG-CF', density: 1.27, price: 28 },
    { id: 'pctg', name: 'PCTG', density: 1.23, price: 28 },
    { id: 'abs', name: 'ABS', density: 1.04, price: 18 },
    { id: 'asa', name: 'ASA', density: 1.07, price: 24 },
    { id: 'hips', name: 'HIPS', density: 1.05, price: 25 },
    { id: 'tpu', name: 'TPU 95A', density: 1.22, price: 28 },
    { id: 'pc', name: 'PC', density: 1.2, price: 36 },
    { id: 'pa', name: 'PA6 (nylon)', density: 1.12, price: 40 },
    { id: 'pa12', name: 'PA12 (nylon)', density: 1.01, price: 65 },
    { id: 'pa-cf', name: 'PA-CF', density: 1.15, price: 60 },
    { id: 'pva', name: 'PVA (support)', density: 1.23, price: 80 },
  ],
  resin: [
    { id: 'standard', name: 'Standard', density: 1.1, price: 22 },
    { id: 'abs-like', name: 'ABS-like', density: 1.1, price: 24 },
    { id: 'water-washable', name: 'Water-washable', density: 1.1, price: 25 },
    { id: 'plant-based', name: 'Plant-based', density: 1.1, price: 26 },
    { id: 'high-detail', name: '8K / high-detail', density: 1.12, price: 30 },
    { id: 'tough', name: 'Tough', density: 1.1, price: 38 },
    { id: 'flexible', name: 'Flexible', density: 1.1, price: 55 },
  ],
};

export const KINDS = ['fdm', 'resin'];
const STORAGE_KEY = 'stl-kit.pricing';

// wall: mm (FDM: perimeters × line width; resin: hollowing wall, 0 = solid),
// infill: %, extra: supports & waste allowance in %.
export function defaultSettings() {
  const materials = (kind) =>
    Object.fromEntries(MATERIALS[kind].map((m) => [m.id, { density: m.density, price: m.price }]));
  return {
    currency: '€',
    fdm: { material: 'pla', wall: 0.9, infill: 15, extra: 5, materials: materials('fdm') },
    resin: { material: 'standard', wall: 2, extra: 20, materials: materials('resin') },
  };
}

const nonNegative = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// Defaults overlaid with whatever valid values were stored; unknown keys are ignored so
// presets added later still show up.
export function loadSettings() {
  const settings = defaultSettings();
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    // unavailable (private mode, blocked storage) or corrupt: use defaults
  }
  if (!stored || typeof stored !== 'object') return settings;

  if (typeof stored.currency === 'string') settings.currency = stored.currency.slice(0, 4);
  for (const kind of KINDS) {
    const from = stored[kind];
    const to = settings[kind];
    if (!from || typeof from !== 'object') continue;
    if (to.materials[from.material]) to.material = from.material;
    for (const key of ['wall', 'infill', 'extra']) {
      if (key in to && nonNegative(from[key])) to[key] = from[key];
    }
    for (const [id, m] of Object.entries(to.materials)) {
      const saved = from.materials?.[id];
      if (nonNegative(saved?.density) && saved.density > 0) m.density = saved.density;
      if (nonNegative(saved?.price)) m.price = saved.price;
    }
  }
  return settings;
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable: settings last for this page load only
  }
}

export function materialName(kind, id) {
  return MATERIALS[kind].find((m) => m.id === id)?.name ?? id;
}

// { volume: mm³, area: mm² } -> { grams, gramsMax, cost, costMax, ml, mlMax } for the
// printer type's selected material.
export function estimate(kind, { volume, area }, settings) {
  const cfg = settings[kind];
  const { density, price } = cfg.materials[cfg.material];
  const shell = Math.min(volume, area * cfg.wall);
  let used;
  if (kind === 'fdm') used = shell + (volume - shell) * (cfg.infill / 100);
  else used = cfg.wall > 0 ? shell : volume;

  const k = 1 + cfg.extra / 100;
  const ml = (used / 1000) * k; // mm³ -> cm³ (= ml)
  const mlMax = (volume / 1000) * k;
  const grams = ml * density;
  const gramsMax = mlMax * density;
  return {
    ml,
    mlMax,
    grams,
    gramsMax,
    cost: (grams / 1000) * price,
    costMax: (gramsMax / 1000) * price,
  };
}
