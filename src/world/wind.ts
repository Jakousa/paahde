// Surface wind over the dunes, and how much sand it moves. Client-side and visual only: nothing that
// moves a player reads it, so it may use Math.sin/exp freely. Every client evaluates it on the server
// clock (Net.serverTime), so everyone sees the same gusts.
//
// Physics (Bagnold 1941; Kok et al. 2012, "The physics of wind-blown sand and dust", arXiv:1201.4353):
//   - Near the ground the wind follows the law of the wall, u(z) = u*/κ · ln(z/z0), with κ = 0.4 and
//     roughness z0 ≈ 0.1 mm over sand. The shear (friction) velocity u* is what lifts grains.
//   - Saltation starts above a threshold u*t ≈ 0.22 m/s for 0.25 mm dune sand, i.e. about 6.3 m/s
//     measured at 10 m. Below that, nothing moves.
//   - Sand flux grows as Q ∝ (u*² − u*t²) (Ungar & Haff 1987, Durán et al. 2011). Just above the
//     threshold, transport is intermittent: gusts sweep the surface in snaking "streamers" a few
//     metres long, aligned with the wind. Well above it, the streamers merge into a continuous
//     carpet of grains flowing over the ground.
//   - Grains hop ballistically, mostly lower than 10–30 cm, 10–15 hop heights long, at 1–3 m/s.
//   - Turbulent gusts are carried along with the mean wind (Taylor's frozen turbulence), so gust
//     patches visibly race downwind across the sand.
//   - Topography: wind speeds up over a dune's windward slope (Jackson & Hunt 1975), fastest at the
//     crest, so crests start moving first. Past the sharp brink the flow separates: the slip face
//     sits in a sheltered eddy where almost nothing saltates, and sand thrown off the brink rains
//     down onto it. In strong wind this shows as plumes "smoking" off the crests.
//   - Wind also grows with height above the wider dune field, so the high ridges run first.
import { insideBase } from '../../shared/base.ts';
import { heightAt, normalAt, WIND } from '../../shared/terrain.ts';

const KAPPA = 0.4;
/** Aerodynamic roughness of the sand surface (m). */
export const Z0 = 1e-4;
/** Fluid threshold shear velocity for 0.25 mm quartz sand (m/s). */
export const USTAR_T = 0.22;
const LOG10 = Math.log(10 / Z0);
/** Gusts scale the local wind between GUST_MIN and GUST_MIN + GUST_RANGE times the regional one. */
const GUST_MIN = 0.65;
const GUST_RANGE = 0.8;
/** Strongest local wind relative to the regional one: the peak gust on the most exposed crest. */
export const PEAK_LOCAL = (GUST_MIN + GUST_RANGE) * 1.8;
/** Peak 10 m wind in a sandstorm (m/s), before its surges. */
const STORM_PEAK = 23;

/** Shear velocity from the wind speed at 10 m. */
export const ustarFrom10 = (u10: number) => (KAPPA * u10) / LOG10;
/** Mean wind speed at height z (m) above the sand for shear velocity u*. */
export const uAt = (ustar: number, z: number) => (ustar / KAPPA) * Math.log(Math.max(z, Z0 * 2) / Z0);

function hash(i: number, j: number): number {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const fade = (t: number) => t * t * (3 - 2 * t);
/** 2D value noise in [0, 1). */
function noise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = fade(x - ix), fz = fade(z - iz);
  const a = hash(ix, iz + seed), b = hash(ix + 1, iz + seed);
  const c = hash(ix, iz + 1 + seed), d = hash(ix + 1, iz + 1 + seed);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/** Local conditions at a point. Reused output object to avoid allocation. */
export type WindSample = {
  /** Unit xz direction the wind blows towards. */
  dx: number;
  dz: number;
  /** Shear velocity here (gusts and topography included), m/s. */
  ustar: number;
  /** Transport strength (u*² − u*t²)/u*t², 0 below the threshold; ~1 is a brisk wind, 4 a sandstorm. */
  q: number;
  /** Probability-like weight in [0, 1] for emitting a saltating grain here (streamers near threshold). */
  emit: number;
};

class Wind {
  /** Seconds on the shared clock (set every frame by update). */
  t = 0;
  /** 10 m wind speed right now, before gusts and topography (m/s). */
  u10 = 0;
  /** Unit xz direction the wind blows towards (the dunes' wind, wobbling a few degrees). */
  dx = WIND.x;
  dz = WIND.z;
  /** Set to a number (m/s at 10 m) to pin the wind, e.g. dbg.wind.override = 14 from the console. */
  override: number | null = null;
  /** Sandstorm strength where we are, 0..1 (shared/storm.ts; set every frame by src/storm.ts). Storms are
   *  local, so the "regional" wind here is really the wind around the camera. */
  local = 0;
  /** Speed of the gust pattern drifting downwind (m/s). */
  private conv = 0;
  /** Topographic speed-up per 4 m cell: packed key → factor. Static terrain, so cached. */
  private topo = new Map<number, number>();
  private n = { x: 0, y: 1, z: 0 };

  /** Advance to shared-clock time `seconds`. */
  update(seconds: number) {
    // Keep the numbers small; the weather pattern repeats every ~11 days anyway.
    const t = (this.t = seconds % 1e6);
    if (this.override !== null) {
      this.u10 = this.override;
    } else {
      // Weather: mostly calm, a light air wandering below the threshold (only exposed crests stir in
      // the gusts). Inside a sandstorm it blows a gale, with surges.
      const base = 1.5 + 4.5 * fade(noise(t / 180, 0.5, 101)) ** 2;
      const storm = STORM_PEAK * (0.85 + 0.25 * noise(t / 6, 0.5, 202));
      this.u10 = base + (storm - base) * this.local;
    }
    // The wind veers slowly (±25° over minutes) and flickers a few degrees with the gusts.
    const wobble = (noise(t / 120, 3.5, 303) - 0.5) * 0.9 + (noise(t / 12, 7.5, 404) - 0.5) * 0.15;
    const c = Math.cos(wobble), s = Math.sin(wobble);
    this.dx = WIND.x * c - WIND.z * s;
    this.dz = WIND.x * s + WIND.z * c;
    // Gusts are carried with roughly the wind speed at a few metres up.
    this.conv = 0.6 * this.u10;
  }

  /** Wind speed-up over the terrain at (x, z): >1 on crests and windward slopes, <1 in the lee. */
  private topography(x: number, z: number): number {
    const ix = Math.floor(x / 4), iz = Math.floor(z / 4);
    const key = ix * 65536 + iz;
    let f = this.topo.get(key);
    if (f === undefined) {
      const cx = ix * 4 + 2, cz = iz * 4 + 2;
      const wx = WIND.x, wz = WIND.z;
      const h = heightAt(cx, cz);
      // Height above the ground 30 m up- and downwind: how exposed this spot is (crest speed-up).
      const rel = h - 0.5 * (heightAt(cx - 30 * wx, cz - 30 * wz) + heightAt(cx + 30 * wx, cz + 30 * wz));
      // Altitude over the wider dune field: the high ridges stand in faster air than the corridors.
      const far = 0.25 * (heightAt(cx - 120 * wx, cz - 120 * wz) + heightAt(cx + 120 * wx, cz + 120 * wz) +
        heightAt(cx - 120 * wz, cz + 120 * wx) + heightAt(cx + 120 * wz, cz - 120 * wx));
      f = Math.min(1.8, Math.max(0.5, 1 + rel * 0.03 + (h - far) * 0.008));
      // Slip faces (steep, facing downwind) sit in the separation eddy behind the brink.
      normalAt(cx, cz, this.n);
      const lee = Math.min(1, Math.max(0, (this.n.x * wx + this.n.z * wz - 0.12) / 0.25));
      f *= 1 - 0.85 * lee;
      if (this.topo.size > 50000) this.topo.clear();
      this.topo.set(key, f);
    }
    return f;
  }

  /** Conditions at ground point (x, z), written into `out`. */
  sample(x: number, z: number, out: WindSample): WindSample {
    const dx = this.dx, dz = this.dz;
    const along = x * dx + z * dz - this.conv * this.t;
    const across = z * dx - x * dz;
    // Gust patches (~50 m, racing downwind, lulls between them) and streamers (long and narrow,
    // wandering sideways over time).
    const gust = fade(noise(along / 50, across / 35, 7));
    const streak = noise(along / 14, across / 2.5 + this.t * 0.15, 11);
    // Indoors (the home base) the air is still; right outside its walls it's sheltered.
    const shelter = insideBase(x, z) ? 0.15 : insideBase(x, z, 2) ? 0.6 : 1;
    const u = this.u10 * (GUST_MIN + GUST_RANGE * gust) * this.topography(x, z) * shelter;
    const us = ustarFrom10(u);
    const q = Math.max(0, (us * us - USTAR_T * USTAR_T) / (USTAR_T * USTAR_T));
    // Near the threshold only streamers carry sand; as transport grows they merge into a carpet.
    const streamers = Math.min(1, Math.max(0, (streak - 0.45) / 0.3));
    const merge = Math.min(1, q / 2.5);
    out.dx = dx;
    out.dz = dz;
    out.ustar = us;
    out.q = q;
    out.emit = Math.min(1, q / 4) * (streamers + (1 - streamers) * merge * merge);
    return out;
  }

  /** How stormy it is overall, 0 (calm) to 1 (sandstorm), from the regional wind only. */
  get storm(): number {
    const us = ustarFrom10(this.u10);
    return Math.min(1, Math.max(0, (us * us - USTAR_T * USTAR_T) / (USTAR_T * USTAR_T) / 4));
  }
}

export const wind = new Wind();
