// The rock column: flat-lying sandstone, shale and limestone formations at fixed heights, the same everywhere (as on
// the Colorado Plateau), modelled on the Grand Canyon's, squeezed to the canyons' depths (shared/canyons.ts). Each
// formation has a colour and a hardness: hard ones stand as cliffs, soft ones weather back into slopes and benches.
// The canyons' walls and buttes take their profile from it (wallY, so a cliff is where a cliff-former is) and the
// rock shader (src/world/sandMaterial.ts) its tint (strataMap), so the ledges and the colour bands
// line up. Mesas and other rocks show the same layers at their heights.
//
// Same determinism rules as shared/dunes.ts: the table is built from constants with + - * / only.

export type Stratum = {
  /** Its top (m, world height); it reaches down to the next one's top. */
  top: number;
  /** sRGB colour, as it reads in photos (iron oxide reds, pale sandstones and limestones, dark basement). */
  color: number;
  /** How far (m) a wall in it leans back per metre of height, before scaling to the canyon's width: ~0.1 a cliff,
   *  ~0.5 ledges, ≥ 1.5 a slope or bench. */
  run: number;
};

/** Top to bottom. The first reaches up forever, the last down forever. */
export const STRATA: Stratum[] = [
  { top: Infinity, color: 0xd8cdb4, run: 0.15 }, // caprock (Kaibab): pale cream-grey limestone, the rim
  { top: 48, color: 0xc9a882, run: 0.7 }, // Toroweap: yellow-grey to buff ledges
  { top: 30, color: 0xe3cfa6, run: 0.12 }, // Coconino: white cross-bedded sandstone, a sheer pale band
  { top: 2, color: 0xa4452a, run: 1.5 }, // Hermit shale: deep red slope
  { top: -34, color: 0x9a4228, run: 0.2 }, // Supai: dark red sandstone ledges and slopes, the wall's darker middle...
  { top: -50, color: 0x823622, run: 1.0 },
  { top: -62, color: 0x9e4529, run: 0.2 },
  { top: -80, color: 0x7f3521, run: 1.0 },
  { top: -92, color: 0x96432a, run: 0.25 },
  { top: -110, color: 0x86402c, run: 0.1 }, // Redwall: massive limestone cliff, grey under red stain washed down
  { top: -185, color: 0x7e6a5c, run: 0.5 }, // Muav: grey-brown ledges
  { top: -200, color: 0x7e8468, run: 2.6 }, // Bright Angel shale: grey-green slope, the broad bench (Tonto)
  { top: -255, color: 0x6c4930, run: 0.15 }, // Tapeats: dark brown sandstone cliff, the inner gorge's lip
  { top: -280, color: 0x3f3337, run: 0.22 }, // Vishnu: near-black schist, the steep inner gorge
];

/** The table's extent (m) and resolution (1 m). */
export const STRATA_Y0 = -700;
export const STRATA_Y1 = 200;
const N = STRATA_Y1 - STRATA_Y0;

/** The formation at height y. */
export function stratumAt(y: number): Stratum {
  let i = 0;
  while (i + 1 < STRATA.length && y < STRATA[i + 1].top) i++;
  return STRATA[i];
}

/** cum[i]: ∫ run dy from STRATA_Y1 down to STRATA_Y1 − i: how far a wall from the top leans back by that depth. */
const cum = new Float64Array(N + 1);
for (let i = 0; i < N; i++) cum[i + 1] = cum[i] + stratumAt(STRATA_Y1 - i - 0.5).run;

/** The column's lean-back at height y (decreasing upwards). */
function C(y: number): number {
  const f = Math.max(0, Math.min(N, STRATA_Y1 - y));
  const i = Math.min(N - 1, Math.floor(f));
  return cum[i] + (cum[i + 1] - cum[i]) * (f - i);
}

/** The height of a wall rising from `floor` to `top`, `q` of the way out across its `run` (m; 0 at its foot, 1 at
 *  its top): cliffs where the column has cliff-formers, slopes and benches where it has soft rock. No layer leans
 *  back less than MIN_LEAN (m per m of height): squeezed into a narrow canyon the cliff-formers stood sheer, which
 *  the terrain mesh drew as spikes and combs. (So a narrow wall is less layered than a wide one.) */
export function wallY(floor: number, top: number, q: number, run: number): number {
  if (q <= 0) return floor;
  if (q >= 1) return top;
  const h = top - floor, cf = C(floor), ct = C(top), dc = cf - ct;
  if (h < 1e-6) return floor;
  // Leans scale as run / (dc + k·h) × (layer run + k): the smallest layer run (STRATA_RUN_MIN) gets MIN_LEAN.
  const den = run - MIN_LEAN * h;
  let k = den > 1e-6 ? Math.max(0, (MIN_LEAN * dc - run * STRATA_RUN_MIN) / den) : 50;
  if (k > 50) k = 50;
  // Bisect for the height whose share of C + k·(depth) is q.
  const target = cf + k * (STRATA_Y1 - floor) - (dc + k * h) * q;
  let lo = floor, hi = top;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) * 0.5;
    if (C(mid) + k * (STRATA_Y1 - mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/** The least a wall leans back (m per m of height), whatever the rock. */
const MIN_LEAN = 0.2;
/** The column's smallest lean (its hardest cliff-former). */
const STRATA_RUN_MIN = Math.min(...STRATA.map((st) => st.run));
