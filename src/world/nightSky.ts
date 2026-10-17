// Night sky details on top of env.ts's star field (sky dome only): the Milky Way with its dust rift,
// a few star clusters, far-off lights that drift and pulse like distant ships, and
// shooting stars. Everything that moves is scheduled from the shared wall clock (Net.worldTime), so
// every player sees the same ship cross the sky and the same meteor fall.
import * as THREE from 'three/webgpu';
import { Fn, If, dot, exp, float, floor, fract, length, max, mix, mx_cell_noise_float, mx_noise_float, normalize, saturate, smoothstep, uniform, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { nightLevel, sandStorm, time } from './env.ts';

type N = Node<'vec3'>;
type F = Node<'float'>;

/** Galactic pole: the Milky Way is the great circle around it, tilted so it arches across the sky. */
const GALAXY_POLE = new THREE.Vector3(0.55, 0.42, -0.72).normalize();
/** Galactic centre (on that circle): the band is wider and warmer there. */
const GALAXY_CORE = new THREE.Vector3(-0.62, 0.3, -0.3);
GALAXY_CORE.addScaledVector(GALAXY_POLE, -GALAXY_CORE.dot(GALAXY_POLE)).normalize();

/** Star clusters: direction, angular radius, tint. One tight cool-white, one fuzzy warm globular, one loose. */
const CLUSTERS: { dir: THREE.Vector3; radius: number; tint: THREE.Color; fuzz: number }[] = [
  { dir: new THREE.Vector3(0.35, 0.62, 0.7), radius: 0.035, tint: new THREE.Color(0.9, 0.93, 1.0), fuzz: 0.25 },
  { dir: new THREE.Vector3(-0.5, 0.55, 0.45), radius: 0.018, tint: new THREE.Color(1.0, 0.94, 0.85), fuzz: 1.0 },
  { dir: new THREE.Vector3(0.1, 0.85, -0.5), radius: 0.06, tint: new THREE.Color(0.95, 0.92, 1.0), fuzz: 0.15 },
];
for (const c of CLUSTERS) c.dir.normalize();

const SHIP_SLOTS = 8;
/** Per light: direction (xyz) and brightness (w); colour. Written each frame by NightSky.update. */
const shipPos = Array.from({ length: SHIP_SLOTS }, () => uniform(new THREE.Vector4()));
const shipColor = Array.from({ length: SHIP_SLOTS }, () => uniform(new THREE.Color()));
const METEOR_SLOTS = 2;
/** Per meteor: start and end direction, progress 0..1 (w of the start) and brightness (w of the end). */
// Never zero vectors, even idle: normalize(0) is NaN, and NaN × 0 brightness would still black out the sky.
const meteorFrom = Array.from({ length: METEOR_SLOTS }, () => uniform(new THREE.Vector4(0, 1, 0, 0)));
const meteorTo = Array.from({ length: METEOR_SLOTS }, () => uniform(new THREE.Vector4(1, 0, 0, 0)));

const v3 = (v: THREE.Vector3) => vec3(v.x, v.y, v.z);
/** Angle-ish distance between unit vectors (chord length, ≈ angle when small). */
const chord = (a: N, b: N): F => length(a.sub(b));

/** Three octaves of value noise, roughly in 0..1. */
const fbm = (p: N): F => mx_noise_float(p).mul(0.5).add(mx_noise_float(p.mul(2.1)).mul(0.28)).add(mx_noise_float(p.mul(4.3)).mul(0.14)).add(0.5);

/** A layer of point stars in `freq` cells per unit direction; `density` 0..1 is how many cells hold one. */
const starLayer = (dir: N, freq: number, density: F, size: number): F => {
  const p = dir.mul(freq);
  const cell = floor(p);
  const pick = mx_cell_noise_float(cell);
  const spot = float(1).sub(smoothstep(size * 0.3, size, length(fract(p).sub(0.5))));
  const on = smoothstep(float(1).sub(density), float(1).sub(density.mul(0.5)), pick);
  return on.mul(spot).mul(mx_cell_noise_float(cell.add(17.3)).mul(0.8).add(0.2));
};

const milkyWay = (dir: N): N => {
  const lat = dot(dir, v3(GALAXY_POLE)); // sine of galactic latitude
  const coreAng = chord(dir, v3(GALAXY_CORE));
  const core = exp(coreAng.mul(coreAng).mul(-2.2)); // 1 at the centre, ~0 on the far side
  const width = mix(float(0.09), float(0.2), core);
  const clump = fbm(dir.mul(5));
  const wobble = mx_noise_float(dir.mul(3).add(4.1)).mul(0.04);
  const bandX = lat.add(wobble).div(width);
  const band = exp(bandX.mul(bandX).negate());
  // The dark rift: a ragged dust lane along the middle of the band, strongest towards the core.
  const laneX = lat.sub(wobble.mul(0.5)).add(0.012).div(0.03); // (squared by hand: WGSL pow of a negative is NaN)
  const lane = exp(laneX.mul(laneX).negate());
  const rift = float(1).sub(lane.mul(smoothstep(0.35, 0.75, fbm(dir.mul(11).add(2.7)))).mul(mix(float(0.45), float(0.85), core)));
  const glow = band.mul(clump.mul(clump)).mul(rift).mul(core.mul(1.6).add(0.4));
  const tint = mix(vec3(0.8, 0.82, 0.9), vec3(1.0, 0.9, 0.78), core);
  // Countless faint stars crowd the band (the glow is them, unresolved).
  const crowd = starLayer(dir, 620, band.mul(rift).mul(0.22), 0.3).mul(0.7);
  return tint.mul(glow.mul(0.05)).add(vec3(0.95, 0.93, 0.95).mul(crowd));
};

const clusters = (dir: N): N => {
  let out: N = vec3(0);
  for (const c of CLUSTERS) {
    const r = chord(dir, v3(c.dir)).div(c.radius);
    const inside = exp(r.mul(r).negate());
    const stars = starLayer(dir, 1100, inside.mul(0.45), 0.28).mul(1.4);
    out = out.add(vec3(c.tint.r, c.tint.g, c.tint.b).mul(stars.add(inside.mul(0.03 * c.fuzz))));
  }
  return out;
};

const ships = (dir: N): N => {
  let out: N = vec3(0);
  for (let i = 0; i < SHIP_SLOTS; i++) {
    const s = shipPos[i];
    const d = chord(dir, s.xyz);
    // A sharp point that blooms when bright, inside a small soft halo.
    const point = exp(d.div(0.0015).pow(2).negate()).add(exp(d.div(0.008).negate()).mul(0.05));
    out = out.add(shipColor[i].mul(point.mul(s.w)));
  }
  return out;
};

const meteors = (dir: N): N => {
  let out: N = vec3(0);
  for (let i = 0; i < METEOR_SLOTS; i++) {
    const a = meteorFrom[i], b = meteorTo[i];
    const p = a.w;
    const head = normalize(mix(a.xyz, b.xyz, p));
    const tail = normalize(mix(a.xyz, b.xyz, max(p.sub(0.4), 0)));
    // Distance to the head→tail segment and how far along it (0 head, 1 tail end).
    const seg = tail.sub(head);
    const len2 = max(dot(seg, seg), 1e-8);
    const t = saturate(dot(dir.sub(head), seg).div(len2));
    const d = length(dir.sub(head.add(seg.mul(t))));
    const width = mix(float(0.0016), float(0.0006), t);
    const streak = exp(d.div(width).pow(2).negate()).mul(float(1).sub(t).pow(1.6));
    // Flares as it burns up, then winks out.
    const life = smoothstep(0, 0.12, p).mul(smoothstep(1, 0.8, p)).mul(float(0.7).add(p.mul(0.8)));
    const color = mix(vec3(1.0, 0.98, 0.95), vec3(1.0, 0.85, 0.7), t);
    out = out.add(color.mul(streak.mul(life).mul(b.w)));
  }
  return out;
};

/** Everything above for a world-space view direction; 0 by day. Linear HDR. */
export const nightSky = Fn(([dirIn]: [N]) => {
  const out = vec3(0).toVar();
  If(nightLevel.greaterThan(0.002), () => {
    const dir = normalize(dirIn);
    const y = dir.y;
    // The diffuse light needs the darkest sky; points survive into the twilight.
    const dark = smoothstep(0.55, 1, nightLevel);
    const dust = float(1).sub(sandStorm.mul(0.85));
    const low = smoothstep(0.0, 0.35, y); // horizon dust swallows the faint stuff
    const diffuse = milkyWay(dir).add(clusters(dir)).mul(dark).mul(low);
    const points = ships(dir).add(meteors(dir)).mul(nightLevel).mul(smoothstep(-0.01, 0.04, y));
    // A gentle shimmer on the faint stars only (the band's glow stays still).
    const shimmer = mx_noise_float(dir.mul(300).add(time.mul(0.9))).mul(0.25).add(0.9);
    out.assign(diffuse.mul(shimmer).add(points).mul(dust));
  });
  return out;
});

// --- Scheduling (CPU, from the shared clock) ---

/** Deterministic hash of an integer (and a salt) to [0, 1). */
const hash = (n: number, salt = 0) => {
  let h = Math.imul((n | 0) ^ Math.imul(salt + 0x9e3779b9, 0x85ebca6b), 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
};

/** Random unit vector above the horizon with elevation in [minEl, maxEl] (radians). */
const skyDir = (u: number, v: number, minEl: number, maxEl: number, out: THREE.Vector3) => {
  const az = u * Math.PI * 2;
  const el = minEl + (maxEl - minEl) * v;
  return out.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
};

type Pattern = 'strobe' | 'pulse' | 'drift' | 'flare';
/** Far lights on slow great-circle tracks. Each one is out for a stretch of its own cycle, then gone. */
const SHIPS: { pattern: Pattern; color: THREE.Color; bright: number; speed: number; cycle: number; seed: number }[] = [
  { pattern: 'strobe', color: new THREE.Color(1.0, 0.95, 0.9), bright: 5, speed: 0.012, cycle: 240, seed: 1 },
  { pattern: 'pulse', color: new THREE.Color(1.0, 0.8, 0.6), bright: 3.2, speed: 0.004, cycle: 420, seed: 2 },
  { pattern: 'drift', color: new THREE.Color(0.85, 0.9, 1.0), bright: 1.5, speed: 0.02, cycle: 150, seed: 3 },
  { pattern: 'flare', color: new THREE.Color(0.9, 0.95, 1.0), bright: 7, speed: 0.016, cycle: 330, seed: 4 },
  { pattern: 'pulse', color: new THREE.Color(0.95, 0.95, 1.0), bright: 2, speed: 0.003, cycle: 600, seed: 5 },
];
/** The slot index the triangle formation starts at (three lights). */
const FORMATION = SHIPS.length;
const FORMATION_CYCLE = 900;
const FORMATION_COLOR = new THREE.Color(1.0, 0.6, 0.5);
const METEOR_WINDOW = 6; // s; a meteor falls in about one window in four

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _axis = new THREE.Vector3(), _q = new THREE.Quaternion();

/** Moves the ships and meteors to the shared clock every frame. */
export class NightSky {
  /** For tuning from the console (?debug): the per-frame light and meteor uniforms. */
  readonly debug = { shipPos, meteorFrom, meteorTo };

  update(unixMs: number) {
    const night = nightLevel.value;
    const t = unixMs / 1000;
    for (let i = 0; i < SHIP_SLOTS; i++) shipPos[i].value.w = 0;
    for (const m of meteorTo) m.value.w = 0;
    if (night <= 0.002) return;

    SHIPS.forEach((s, i) => {
      const n = Math.floor(t / s.cycle); // which pass this is
      const phase = t / s.cycle - n;
      const on = 0.55 + 0.25 * hash(n, s.seed * 7); // fraction of the cycle it is out
      if (phase > on) return;
      const visible = THREE.MathUtils.smoothstep(phase, 0, 0.04) * (1 - THREE.MathUtils.smoothstep(phase, on - 0.04, on));
      // A track through a random point well above the horizon, in a random heading.
      skyDir(hash(n, s.seed), hash(n, s.seed + 11), 0.45, 1.25, _a);
      _axis.set(hash(n, s.seed + 21) - 0.5, hash(n, s.seed + 31) - 0.5, hash(n, s.seed + 41) - 0.5).cross(_a).normalize();
      _q.setFromAxisAngle(_axis, (phase - on / 2) * s.cycle * s.speed);
      const p = shipPos[i].value;
      _a.applyQuaternion(_q);
      p.set(_a.x, _a.y, _a.z, s.bright * visible * blink(s.pattern, t + s.seed * 1.7));
      shipColor[i].value.copy(s.color);
    });

    // Something big, far off: three dim reddish lights holding a slowly turning triangle, firing in sequence.
    const fn = Math.floor(t / FORMATION_CYCLE);
    const fphase = t / FORMATION_CYCLE - fn;
    if (fphase < 0.3) {
      const visible = THREE.MathUtils.smoothstep(fphase, 0, 0.03) * (1 - THREE.MathUtils.smoothstep(fphase, 0.26, 0.3));
      const centre = skyDir(hash(fn, 91), hash(fn, 92), 0.35, 0.9, _b);
      const east = _axis.set(0, 1, 0).cross(centre).normalize();
      const north = _a.copy(centre).cross(east);
      const spin = t * 0.05;
      for (let k = 0; k < 3; k++) {
        const ang = spin + (k * Math.PI * 2) / 3;
        const p = shipPos[FORMATION + k].value;
        const r = 0.016;
        p.set(
          centre.x + (east.x * Math.cos(ang) + north.x * Math.sin(ang)) * r,
          centre.y + (east.y * Math.cos(ang) + north.y * Math.sin(ang)) * r,
          centre.z + (east.z * Math.cos(ang) + north.z * Math.sin(ang)) * r,
          0,
        );
        // A soft beat that runs round the triangle every 3 s.
        const beat = Math.max(0, Math.cos(((t / 3 - k / 3) % 1) * Math.PI * 2));
        p.w = visible * (0.35 + 2.4 * beat ** 6);
        shipColor[FORMATION + k].value.copy(FORMATION_COLOR);
      }
    }

    for (let i = 0; i < METEOR_SLOTS; i++) {
      const shifted = t + i * METEOR_WINDOW * 0.5;
      const w = Math.floor(shifted / METEOR_WINDOW);
      const salt = 200 + i * 50;
      if (hash(w, salt) > 0.25) continue;
      const fireball = hash(w, salt + 1) < 0.08;
      const dur = fireball ? 2.2 : 0.5 + 0.6 * hash(w, salt + 2);
      const start = hash(w, salt + 3) * (METEOR_WINDOW - dur);
      const p = (shifted - w * METEOR_WINDOW - start) / dur;
      if (p < 0 || p > 1) continue;
      // Starts high, falls a little towards the horizon on a random heading.
      skyDir(hash(w, salt + 4), hash(w, salt + 5), 0.5, 1.3, _a);
      const arc = (fireball ? 0.45 : 0.16 + 0.2 * hash(w, salt + 7));
      // Heading on the sky at the start: a random amount sideways, always some way down. Rotating the start
      // about start × heading carries it that way.
      const up = _b.set(0, 1, 0).addScaledVector(_a, -_a.y).normalize(); // "up" along the sky at the start
      const side = _axis.crossVectors(_a, up);
      side.multiplyScalar(hash(w, salt + 6) * 2 - 1).addScaledVector(up, -0.6);
      _axis.crossVectors(_a, side).normalize();
      _b.copy(_a).applyQuaternion(_q.setFromAxisAngle(_axis, arc));
      meteorFrom[i].value.set(_a.x, _a.y, _a.z, p);
      meteorTo[i].value.set(_b.x, _b.y, _b.z, (fireball ? 9 : 2.5 + 3 * hash(w, salt + 8)));
    }
  }
}

/** Brightness 0..1 of a light's blink pattern at time `t` (s). */
function blink(pattern: Pattern, t: number) {
  switch (pattern) {
    case 'strobe': { // double flash every 1.8 s over a faint steady glow
      const f = t % 1.8;
      return 0.12 + (f < 0.07 || (f > 0.22 && f < 0.29) ? 1 : 0);
    }
    case 'pulse': // slow breathing
      return 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * 1.3)) ** 3;
    case 'drift': // steady, shimmering a touch
      return 0.85 + 0.15 * Math.sin(t * 7.1);
    case 'flare': // a faint mote that briefly blazes once in its pass, like sunlight off a hull
      return 0.08 + 0.92 * Math.exp(-(((t % 47) - 23) ** 2) / 4);
  }
}
