// Day/night cycle: one 24 h day every DAY_SECONDS of real time, on the server's wall clock so every
// player sees the same sky. The clock and the sun's arc live in shared/sun.ts (the server uses them for
// heat); this file adds the visual overrides (?tod, ?day, debug menu) and the sky palette.
//
// The moon is full: opposite the sun.
//
// Sky colours and lighting are keyframed on sun elevation. The golden-hour key (10°) is whatever env.ts
// and sky.ts start with, so tuning those still tunes the evening; the other keys sit around it.
import * as THREE from 'three/webgpu';
import { hazeColor, heatHaze, horizonColor, horizonSunColor, midSkyColor, moonColor, moonDirection, nightLevel, sunColor, sunDirection, zenithColor } from './env.ts';
import { DAY_SECONDS, DECL, skyVector, sunHourAngle, timeOfDayAt } from '../../shared/sun.ts';
import { airTemp, sunStrength } from '../../shared/temperature.ts';

export { clockText, DAY_SECONDS } from '../../shared/sun.ts';

/** Moonlight on the ground at full strength (linear): dim, a little silver, still warm enough to read as sand. */
const MOONLIGHT = new THREE.Color(0.58, 0.62, 0.78).multiplyScalar(0.4);

const params = new URLSearchParams(location.search);
/** `?tod=0.75` freezes the clock (0 = midnight, 0.5 = noon); `?day=60` makes a day last 60 s. Visual only. */
const FIXED_TOD = params.has('tod') ? Number(params.get('tod')) : null;
const DAY_LEN = Number(params.get('day') ?? DAY_SECONDS);

/** Set by the debug menu (src/debugMenu.ts): a time of day in [0, 1) to hold instead of the shared clock. */
export const timeControl = { override: null as number | null };

/** Time of day in [0, 1) as drawn: the shared clock unless ?tod, ?day or the debug menu override it. */
export function timeOfDay(unixMs: number): number {
  if (timeControl.override !== null) return timeControl.override;
  if (FIXED_TOD !== null) return ((FIXED_TOD % 1) + 1) % 1;
  return timeOfDayAt(unixMs, DAY_LEN);
}

type Key = {
  el: number; // sun elevation, degrees
  sun: THREE.Color; zenith: THREE.Color; mid: THREE.Color; horizon: THREE.Color; horizonSun: THREE.Color;
  haze: THREE.Color; ambSky: THREE.Color; ambGround: THREE.Color; amb: number;
};

const hex = (h: number, k = 1) => new THREE.Color(h).multiplyScalar(k);
const rgb = (r: number, g: number, b: number, k = 1) => new THREE.Color(r, g, b).multiplyScalar(k);
const COLORS = ['sun', 'zenith', 'mid', 'horizon', 'horizonSun', 'haze', 'ambSky', 'ambGround'] as const;
const cloneKey = (k: Key): Key => {
  const c = { ...k };
  for (const n of COLORS) c[n] = k[n].clone();
  return c;
};

export class DayNight {
  tod = 0;
  /** Sun elevation, radians. */
  elevation = 0;
  private keys: Key[];
  private cur: Key;
  private ambient: THREE.HemisphereLight;

  /** `ambient` is the sky's hemisphere fill; its starting colours are the golden-hour ones. */
  constructor(ambient: THREE.HemisphereLight) {
    this.ambient = ambient;
    // Golden hour as tuned in env.ts / sky.ts.
    const golden = cloneKey({
      el: 10, sun: sunColor.value, zenith: zenithColor.value, mid: midSkyColor.value, horizon: horizonColor.value,
      horizonSun: horizonSunColor.value, haze: hazeColor.value, ambSky: ambient.color, ambGround: ambient.groundColor,
      amb: ambient.intensity,
    });
    this.keys = [
      { el: -16, sun: rgb(0, 0, 0), zenith: hex(0x0a0a14), mid: hex(0x13111e), horizon: hex(0x1e1822), horizonSun: hex(0x231a22),
        haze: hex(0x15141c), ambSky: hex(0x4a5070), ambGround: hex(0x1c1412), amb: 0.1 },
      { el: -6, sun: rgb(0, 0, 0), zenith: hex(0x1a1630), mid: hex(0x3a2438), horizon: hex(0x6a3024), horizonSun: hex(0x9a4418),
        haze: hex(0x4a2c2a), ambSky: hex(0x7a4a5a), ambGround: hex(0x2e1a12), amb: 0.25 },
      { el: 0, sun: rgb(1, 0.45, 0.2, 1.6), zenith: golden.zenith.clone().multiplyScalar(0.55), mid: golden.mid.clone().multiplyScalar(0.6),
        horizon: hex(0xc0601e), horizonSun: hex(0xe8701a), haze: hex(0xb06434), ambSky: hex(0xb86840), ambGround: hex(0x4a2010), amb: 0.42 },
      golden,
      { el: 24, sun: rgb(1, 0.8, 0.58, 3.7), zenith: hex(0x5a4848), mid: hex(0x9a6a52), horizon: hex(0xe89a58), horizonSun: hex(0xf0aa58),
        haze: hex(0xdea068, 0.9), ambSky: hex(0xd89a60), ambGround: hex(0x6a3418), amb: 0.6 },
      { el: 60, sun: rgb(1, 0.88, 0.72, 3.9), zenith: hex(0x6a5650), mid: hex(0xa88470), horizon: hex(0xe8b47c), horizonSun: hex(0xf0c084),
        haze: hex(0xd8a066, 0.9), ambSky: hex(0xe0b080), ambGround: hex(0x703a1a), amb: 0.65 },
    ];
    this.cur = cloneKey(golden);
  }

  /** Move the sun and moon to `unixMs` and blend the sky palette. Writes the env.ts uniforms. */
  update(unixMs: number) {
    this.tod = timeOfDay(unixMs);
    const h = sunHourAngle(this.tod);
    const sun = skyVector(h, DECL, sunDirection.value);
    skyVector(h + Math.PI, -DECL, moonDirection.value);
    this.elevation = Math.asin(sun.y);

    const el = THREE.MathUtils.radToDeg(this.elevation);
    const keys = this.keys;
    let i = 0;
    while (i < keys.length - 2 && el > keys[i + 1].el) i++;
    const a = keys[i], b = keys[i + 1];
    const t = THREE.MathUtils.smoothstep(el, a.el, b.el);
    const c = this.cur;
    for (const k of COLORS) c[k].copy(a[k]).lerp(b[k], t);
    c.amb = a.amb + (b.amb - a.amb) * t;

    // The disc's light goes out as it sinks; the twilight keys carry the afterglow.
    sunColor.value.copy(c.sun).multiplyScalar(THREE.MathUtils.smoothstep(el, -2, 1.5));
    zenithColor.value.copy(c.zenith);
    midSkyColor.value.copy(c.mid);
    horizonColor.value.copy(c.horizon);
    horizonSunColor.value.copy(c.horizonSun);
    hazeColor.value.copy(c.haze);
    this.ambient.color.copy(c.ambSky);
    this.ambient.groundColor.copy(c.ambGround);
    this.ambient.intensity = c.amb;
    nightLevel.value = 1 - THREE.MathUtils.smoothstep(el, -12, -2);
    // The moon lights the ground once it is clear of the horizon and the sun has gone.
    const moonUp = THREE.MathUtils.smoothstep(moonDirection.value.y, 0.03, 0.25);
    moonColor.value.copy(MOONLIGHT).multiplyScalar(moonUp * nightLevel.value);
    // Shimmer needs hot air over sun-baked sand: none in the cool night and morning, full in the afternoon.
    heatHaze.value = THREE.MathUtils.smoothstep(airTemp(this.tod), 26, 38) * THREE.MathUtils.smoothstep(sunStrength(this.tod), 0, 0.4);
  }
}
