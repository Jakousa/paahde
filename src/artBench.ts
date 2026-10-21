// Art-style bench (?w=bench, development only: shared/world.ts BENCH): the real desert from a fixed seed, with nothing
// happening in it (CALM: no weather, walkers, jets or heat), seen from a list of fixed camera shots at set times of day,
// while a panel tunes the global look live: tone curve and grade, bloom, sun / ambient / moon light, sky, haze, the sand,
// rock and mud colours, and the sky palette's keyframes (src/world/dayNight.ts). Nothing here changes the game's defaults:
// export the look (JSON, or a diff naming where each default lives in the code) and bake the values in by hand.
//
// Keys: [ and ] the previous / next shot, hold \ to see the code's defaults (A/B), F2 frees the mouse or hides the panel.
// Click the picture to fly (src/flyCam.ts: WASD, Space / Ctrl, Shift fast, wheel speed); "Save view" puts the view on the
// shot, "Copy shots" copies the list as code for SHOTS below. The look and edited shots are kept in this browser.
import * as THREE from 'three/webgpu';
import { heightAt } from '../shared/terrain.ts';
import { ui } from './input';
import type { FlyCam } from './flyCam';
import type { BlownSand } from './blownSand';
import { grade, TONE_CURVES, toneControl, type Post, type ToneCurve } from './post';
import { clockText, dayGain, KEY_COLORS, timeControl, type DayNight, type Key } from './world/dayNight';
import { hazeDensity, hazeFalloff, hazeFar, skyGain, sunDiscRadius } from './world/env';
import { sand } from './world/sandMaterial';

/** A camera shot: where (x, z, `up` m above the sand), which way (degrees: yaw 0 looks to -z, pitch up), lens and time. */
export interface Shot {
  name: string;
  x: number;
  z: number;
  up: number;
  yaw: number;
  pitch: number;
  fov: number;
  /** Hour of the day, 0..24 (12 noon). */
  hour: number;
}

/** A shot from `from` looking at `at` ([x, z, m above the sand] each). */
function aim(name: string, from: [number, number, number], at: [number, number, number], hour: number, fov = 60): Shot {
  const [x, z, up] = from;
  const dx = at[0] - x, dz = at[1] - z;
  const dy = heightAt(at[0], at[1]) + at[2] - (heightAt(x, z) + up);
  const r = (v: number) => Math.round(v * 10) / 10;
  return { name, x, z, up, yaw: r(THREE.MathUtils.radToDeg(Math.atan2(-dx, -dz))), pitch: r(THREE.MathUtils.radToDeg(Math.atan2(dy, Math.hypot(dx, dz)))), fov, hour };
}

/** The bench's shots, in the bench world (seed of BENCH_WORLD): the base at (-376, -8), a rock outcrop to its east, the big
 *  dune to the north-east, scrap fields and a crashed ship further north, mud flats to the north-west. */
const SHOTS: Shot[] = [
  aim('Base, golden hour', [-340, 20, 3], [-376, -8, 1], 17),
  aim('Rock, dawn', [-260, -170, 2], [-197, -249, 12], 6.5),
  aim('Dune crest, noon', [-46, 218, 2], [-300, 400, 0], 12),
  aim('Scrap field, afternoon', [-140, 478, 2], [-159, 498, 0.5], 15),
  aim('Into the sun, golden hour', [-46, 218, 2], [-46, -300, 30], 17.5),
  aim('Crash site, dusk', [-494, 818, 3], [-514, 841, 1.5], 18.5),
  aim('Mud flats, morning', [-1002, 693, 6], [-1200, 900, 0], 9),
  aim('Dunes at night', [-300, 60, 3], [-46, 218, 20], 0),
  aim('Wide from above, golden hour', [-600, -200, 120], [-200, 300, 0], 17.5, 50),
];

type Rgb = [number, number, number];
type Value = number | string | Rgb;

/** One tunable: how to read and write it, how to show it, and where its default lives in the code (for the diff). */
interface Param {
  id: string;
  group: string;
  label: string;
  src: string;
  /** `color`: an albedo-like colour, picked directly; `hdr`: a colour picked as a hue times a gain. */
  kind: 'num' | 'color' | 'hdr' | 'choice';
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
  get(): Value;
  set(v: Value): void;
}

const num = (group: string, id: string, label: string, src: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void): Param =>
  ({ id, group, label, src, kind: 'num', min, max, step, get, set: (v) => set(v as number) });
const uni = (group: string, id: string, label: string, src: string, u: { value: number }, min: number, max: number, step: number) =>
  num(group, id, label, src, min, max, step, () => u.value, (v) => (u.value = v));
const col = (group: string, id: string, label: string, src: string, c: THREE.Color, hdr = false): Param =>
  ({ id, group, label, src, kind: hdr ? 'hdr' : 'color', get: () => c.toArray() as Rgb, set: (v) => c.fromArray(v as Rgb) });

/** Every tunable, in panel order. */
function lookParams(post: Post, day: DayNight, blownSand: BlownSand): Param[] {
  const ps: Param[] = [];
  let g = 'Tone & grade';
  ps.push({ id: 'tone.curve', group: g, label: 'Tone curve', src: 'src/post.ts toneControl (filmic)', kind: 'choice', options: TONE_CURVES,
    get: () => toneControl.curve, set: (v) => toneControl.set(v as ToneCurve) });
  ps.push(num(g, 'tone.white', 'White point (filmic)', 'src/post.ts toneControl.white', 1, 8, 0.05, () => toneControl.white, (v) => toneControl.set(toneControl.curve, v)));
  ps.push(uni(g, 'grade.exposure', 'Exposure', 'src/post.ts grade.exposure', grade.exposure, 0.2, 3, 0.01));
  ps.push(uni(g, 'grade.contrast', 'Contrast', 'src/post.ts grade.contrast', grade.contrast, 0.5, 1.8, 0.01));
  ps.push(uni(g, 'grade.saturation', 'Saturation', 'src/post.ts grade.saturation', grade.saturation, 0, 2, 0.01));
  ps.push(col(g, 'grade.balance', 'White balance', 'src/post.ts grade.balance', grade.balance.value as THREE.Color, true));
  ps.push(col(g, 'grade.lift', 'Shadow lift', 'src/post.ts grade.lift', grade.lift.value as THREE.Color, true));
  ps.push(uni(g, 'grade.vignette', 'Vignette', 'src/post.ts grade.vignette', grade.vignette, 0, 0.8, 0.01));
  ps.push(uni(g, 'grade.grain', 'Grain', 'src/post.ts grade.grain', grade.grain, 0, 0.1, 0.001));
  g = 'Bloom';
  ps.push(uni(g, 'bloom.strength', 'Strength', 'src/post.ts BLOOM.strength', post.bloom.strength, 0, 2, 0.01));
  ps.push(uni(g, 'bloom.radius', 'Radius', 'src/post.ts BLOOM.radius', post.bloom.radius, 0, 1, 0.01));
  ps.push(uni(g, 'bloom.threshold', 'Threshold', 'src/post.ts BLOOM.threshold', post.bloom.threshold, 0, 8, 0.05));
  g = 'Light';
  ps.push(num(g, 'light.sun', 'Sun intensity ×', 'src/world/dayNight.ts dayGain.sun (or the keys\' sun)', 0, 3, 0.01, () => dayGain.sun, (v) => (dayGain.sun = v)));
  ps.push(num(g, 'light.ambient', 'Ambient ×', 'src/world/dayNight.ts dayGain.ambient (or the keys\' amb)', 0, 3, 0.01, () => dayGain.ambient, (v) => (dayGain.ambient = v)));
  ps.push(num(g, 'light.moon', 'Moonlight ×', 'src/world/dayNight.ts dayGain.moon (or MOONLIGHT)', 0, 4, 0.01, () => dayGain.moon, (v) => (dayGain.moon = v)));
  ps.push(uni(g, 'sky.sunDisc', 'Sun disc radius', 'src/world/env.ts sunDiscRadius', sunDiscRadius, 0.005, 0.15, 0.001));
  g = 'Sky & haze';
  ps.push(uni(g, 'sky.gain', 'Sky brightness', 'src/world/env.ts skyGain', skyGain, 0, 4, 0.01));
  ps.push(num(g, 'haze.density', 'Haze density', 'src/world/terrain.ts HAZE_DENSITY', 0, 0.012, 0.0001, () => blownSand.baseHaze,
    (v) => (blownSand.baseHaze = hazeDensity.value = v)));
  ps.push(uni(g, 'haze.falloff', 'Haze height falloff', 'src/world/env.ts hazeFalloff', hazeFalloff, 0, 0.05, 0.0005));
  ps.push(uni(g, 'haze.far', 'Haze total at (m)', 'src/world/terrain.ts hazeFar (VIEW_DISTANCE × 0.95)', hazeFar, 200, 4500, 10));
  ps.push(num(g, 'haze.heat', 'Heat shimmer ×', 'src/world/dayNight.ts dayGain.heatHaze', 0, 4, 0.05, () => dayGain.heatHaze, (v) => (dayGain.heatHaze = v)));
  const s = (group: string, key: keyof typeof sand, label: string, hdr = false, range: [number, number, number] = [0, 1, 0.01]) => {
    const u = sand[key] as { value: unknown };
    const src = `src/world/sandMaterial.ts sand.${key}`;
    ps.push(u.value instanceof THREE.Color ? col(group, `sand.${key}`, label, src, u.value, hdr) : uni(group, `sand.${key}`, label, src, u as { value: number }, ...range));
  };
  g = 'Sand';
  s(g, 'albedoRed', 'Red sand');
  s(g, 'albedoGold', 'Golden sand');
  s(g, 'shadowTint', 'Shadow tint');
  s(g, 'bounce', 'Bounce light', false, [0, 0.4, 0.005]);
  s(g, 'contrast', 'Terminator contrast', false, [0.5, 3, 0.01]);
  s(g, 'offset', 'Terminator offset', false, [-0.5, 0.8, 0.01]);
  s(g, 'rippleStrength', 'Ripples', false, [0, 0.4, 0.005]);
  s(g, 'megaRippleStrength', 'Big ripples', false, [0, 0.15, 0.002]);
  s(g, 'sheen', 'Sheen', false, [0, 0.2, 0.002]);
  s(g, 'rim', 'Crest rim', false, [0, 1, 0.01]);
  s(g, 'sheenTint', 'Sheen / rim tint');
  s(g, 'glitter', 'Glitter', false, [0, 8, 0.05]);
  s(g, 'glitterTint', 'Glitter tint');
  g = 'Rock & mud';
  s(g, 'rockDark', 'Rock, dark beds');
  s(g, 'rockLight', 'Rock, pale beds');
  s(g, 'varnish', 'Desert varnish');
  s(g, 'mudLight', 'Mud, pale');
  s(g, 'mudDark', 'Mud, dark');
  s(g, 'mudCrack', 'Mud cracks');

  // The sky palette: each keyframe's colours. The golden-hour key (10°) is the starting values in env.ts and sky.ts.
  const GOLDEN_SRC: Record<string, string> = {
    sun: 'src/world/sky.ts sunColor.value.setRGB (golden hour)', zenith: 'src/world/env.ts zenithColor', mid: 'src/world/env.ts midSkyColor',
    horizon: 'src/world/env.ts horizonColor', horizonSun: 'src/world/env.ts horizonSunColor', haze: 'src/world/env.ts hazeColor',
    ambSky: 'src/world/sky.ts HemisphereLight sky colour', ambGround: 'src/world/sky.ts HemisphereLight ground colour', amb: 'src/world/sky.ts HemisphereLight intensity',
  };
  const LABEL: Record<string, string> = {
    sun: 'Sunlight', zenith: 'Zenith', mid: 'Mid sky', horizon: 'Horizon', horizonSun: 'Horizon, sunward', haze: 'Haze', ambSky: 'Ambient, sky',
    ambGround: 'Ambient, ground', amb: 'Ambient strength',
  };
  for (const k of day.keys) {
    g = keyGroup(k);
    const src = (n: string) => (k.el === 10 ? GOLDEN_SRC[n] : `src/world/dayNight.ts keys, el ${k.el}: ${n}`);
    for (const n of KEY_COLORS) ps.push(col(g, `key${k.el}.${n}`, LABEL[n], src(n), k[n], n === 'sun'));
    ps.push(num(g, `key${k.el}.amb`, LABEL.amb, src('amb'), 0, 1.5, 0.01, () => k.amb, (v) => (k.amb = v)));
  }
  return ps;
}

const keyGroup = (k: Key) => `Palette · sun ${k.el}°`;

const STORE_LOOK = 'artBench.look';
const STORE_SHOTS = 'artBench.shots';
const STORE_SHOT = 'artBench.shot';
const load = <T>(key: string): T | null => {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
};
const save = (key: string, v: unknown) => {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // (private window: the bench still works, it just forgets)
  }
};

const same = (a: Value, b: Value) =>
  Array.isArray(a) && Array.isArray(b) ? a.every((x, i) => Math.abs(x - b[i]) < 1e-6) : typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b;
const valid = (p: Param, v: unknown): v is Value =>
  p.kind === 'choice' ? typeof v === 'string' && p.options!.includes(v)
  : p.kind === 'num' ? typeof v === 'number' && Number.isFinite(v)
  : Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0);
const round = (v: number) => Math.round(v * 10000) / 10000;
const tmp = new THREE.Color();
/** The gain a colour is shown at: its hue is picked, the gain sets how bright (hdr), or how far past 1 it goes. */
const gainOf = (p: Param, c: Rgb) => {
  const m = Math.max(...c);
  return p.kind === 'hdr' ? (m > 0 ? m : 1) : Math.max(1, m);
};
const hexOf = (c: Rgb, gain: number) => `#${tmp.setRGB(c[0] / gain, c[1] / gain, c[2] / gain).getHexString()}`;
const text = (p: Param, v: Value) => {
  if (Array.isArray(v)) {
    const gain = gainOf(p, v);
    return `(${v.map(round).join(', ')}) ≈ ${hexOf(v, gain)}${gain !== 1 ? ` × ${round(gain)}` : ''}`;
  }
  return typeof v === 'number' ? String(round(v)) : v;
};

const css = `
#artBench { position: fixed; top: 12px; right: 12px; bottom: 12px; width: 320px; overflow-y: auto; z-index: 11; padding: 10px 12px;
  font: 12px var(--mono); color: #ffe9cc; background: rgba(20, 10, 5, 0.86); border-radius: 8px; box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.18); }
#artBench.hidden { display: none; }
#artBench h4 { margin: 0 0 6px; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; opacity: .75; }
#artBench .row { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
#artBench button, #artBench select, #artBench input[type=text], #artBench input[type=number] { font: inherit; color: inherit;
  background: rgba(255, 233, 204, 0.12); border: 0; border-radius: 4px; padding: 3px 7px; }
#artBench button { cursor: pointer; }
#artBench button:hover { background: rgba(255, 233, 204, 0.25); }
#artBench button.on { background: #ffd9a0; color: #2a160a; }
#artBench input[type=range] { flex: 1; min-width: 0; }
#artBench input[type=color] { width: 34px; height: 20px; padding: 0; border: 0; background: none; }
#artBench input[type=number] { width: 58px; padding: 2px 4px; }
#artBench .shotName { flex: 1; min-width: 0; }
#artBench details { margin-top: 8px; border-top: 1px solid rgba(255, 233, 204, 0.12); padding-top: 4px; }
#artBench summary { cursor: pointer; padding: 2px 0; font-weight: 600; }
#artBench summary .now { color: #ffd9a0; font-weight: normal; }
#artBench .p { display: grid; grid-template-columns: 112px 1fr auto 16px; gap: 5px; align-items: center; margin-top: 4px; }
#artBench .p > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#artBench .p.changed > span:first-child { color: #ffd9a0; }
#artBench .p .ctl { display: flex; gap: 5px; align-items: center; min-width: 0; }
#artBench .p .reset { cursor: pointer; opacity: 0; text-align: center; }
#artBench .p.changed .reset { opacity: .8; }
#artBench .hint { opacity: .6; margin-top: 6px; line-height: 1.4; }
#artBench .flash { color: #ffd9a0; }
#artBenchAB { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 11; display: none; padding: 4px 10px;
  font: 600 12px var(--mono); letter-spacing: .1em; color: #2a160a; background: #ffd9a0; border-radius: 4px; }
`;

export interface BenchHooks {
  fly: FlyCam;
  camera: THREE.PerspectiveCamera;
  day: DayNight;
  post: Post;
  blownSand: BlownSand;
  /** Start flying from the player's view. */
  startFly(): void;
}

export class ArtBench {
  private h: BenchHooks;
  private params: Param[];
  /** The code's defaults, read before any saved look is applied. */
  private defaults = new Map<string, Value>();
  private shots: Shot[];
  private index = 0;
  private started = false;
  private touring = false;
  private tourT = 0;
  /** While comparing (\ held): the look to go back to. */
  private held: Map<string, Value> | null = null;
  private panel = document.createElement('div');
  private ab = document.createElement('div');
  private rows: { p: Param; show(): void }[] = [];
  private groups = new Map<string, HTMLElement>();
  private shotSelect!: HTMLSelectElement;
  private shotName!: HTMLInputElement;
  private todSlider!: HTMLInputElement;
  private todLabel!: HTMLElement;
  private status!: HTMLElement;
  private saveTimer = 0;

  constructor(h: BenchHooks) {
    this.h = h;
    this.params = lookParams(h.post, h.day, h.blownSand);
    for (const p of this.params) this.defaults.set(p.id, p.get());
    const saved = load<Record<string, unknown>>(STORE_LOOK);
    if (saved) this.apply(saved);
    this.shots = load<Shot[]>(STORE_SHOTS) ?? SHOTS.map((s) => ({ ...s }));
    this.index = Math.min(Math.max(0, load<number>(STORE_SHOT) ?? 0), this.shots.length - 1);
    this.build();
    this.keys();
    setInterval(() => this.showPalette(), 250);
  }

  /** Per render frame, once joined: starts on the saved shot, and moves the tour on. */
  frame(dt: number) {
    if (!this.started) {
      this.started = true;
      this.h.startFly();
      this.h.fly.setClean(true);
      this.go(this.index);
    }
    if (this.touring && (this.tourT += dt) > 5) {
      this.tourT = 0;
      this.go(this.index + 1);
    }
  }

  private go(i: number) {
    const n = this.shots.length;
    if (!n) return;
    this.index = ((i % n) + n) % n;
    save(STORE_SHOT, this.index);
    const s = this.shots[this.index];
    if (!this.h.fly.active) this.h.startFly();
    const deg = THREE.MathUtils.degToRad;
    this.h.fly.place(new THREE.Vector3(s.x, heightAt(s.x, s.z) + s.up, s.z), deg(s.yaw), deg(s.pitch), s.fov);
    this.setHour(s.hour);
    this.showShots();
  }

  private setHour(hour: number) {
    timeControl.override = (((hour / 24) % 1) + 1) % 1;
    this.todSlider.value = String(Math.round(hour * 60));
    this.todLabel.textContent = clockText(timeControl.override);
  }

  /** The current view and time as a shot. */
  private view(name: string): Shot {
    const c = this.h.camera, r = (v: number, k = 10) => Math.round(v * k) / k, deg = THREE.MathUtils.radToDeg;
    const pos = this.h.fly.active ? this.h.fly.pos : c.position;
    return { name, x: r(pos.x), z: r(pos.z), up: r(pos.y - heightAt(pos.x, pos.z)), yaw: r(deg(c.rotation.y)), pitch: r(deg(c.rotation.x)), fov: Math.round(this.h.fly.fov),
      hour: r(((timeControl.override ?? this.h.day.tod) * 24), 100) };
  }

  private saveShots() {
    save(STORE_SHOTS, this.shots);
    this.showShots();
  }

  // --- The look ---------------------------------------------------------------------------------------------------

  private values(): Map<string, Value> {
    return new Map(this.params.map((p) => [p.id, p.get()]));
  }

  private apply(values: Record<string, unknown> | Map<string, Value>) {
    const get = (id: string) => (values instanceof Map ? values.get(id) : values[id]);
    for (const p of this.params) {
      const v = get(p.id);
      if (v !== undefined && valid(p, v)) p.set(v);
    }
  }

  private changed(): Param[] {
    return this.params.filter((p) => !same(p.get(), this.defaults.get(p.id)!));
  }

  /** After any change: the panel follows, and the look is kept (only what differs from the defaults). */
  private touched() {
    for (const r of this.rows) r.show();
    if (this.held) return; // (comparing: the defaults are on show, not the look)
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      const c = this.changed();
      save(STORE_LOOK, c.length ? Object.fromEntries(c.map((p) => [p.id, p.get()])) : null);
    }, 300);
    this.status.textContent = `${this.changed().length} changed`;
  }

  private compare(on: boolean) {
    if (on === !!this.held) return;
    if (on) {
      this.held = this.values();
      this.apply(this.defaults);
    } else {
      const back = this.held!;
      this.held = null;
      this.apply(back);
    }
    this.ab.style.display = on ? 'block' : 'none';
    this.touched();
  }

  private exportJson() {
    const look = Object.fromEntries(this.params.map((p) => [p.id, p.get()]));
    const blob = new Blob([JSON.stringify({ artBench: 1, changed: this.changed().map((p) => p.id), look }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `look-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private importJson(file: File) {
    file.text().then((t) => {
      try {
        const j = JSON.parse(t) as { look?: Record<string, unknown> };
        this.apply(j.look ?? (j as Record<string, unknown>));
        this.touched();
        this.flash('Imported');
      } catch {
        this.flash('Not a look file');
      }
    });
  }

  /** What differs from the defaults, one line each, with where the default lives in the code. */
  private diff(): string {
    const c = this.changed();
    if (!c.length) return 'Art bench: the look is the code\'s defaults.';
    return [`Art bench look: ${c.length} change${c.length > 1 ? 's' : ''} from the code's defaults`,
      ...c.map((p) => `- ${p.src}: ${text(p, this.defaults.get(p.id)!)} → ${text(p, p.get())}`)].join('\n');
  }

  private copy(s: string, what: string) {
    navigator.clipboard.writeText(s).then(() => this.flash(`${what} copied`), () => {
      console.log(s);
      this.flash(`${what} logged to the console`);
    });
  }

  private flash(s: string) {
    this.status.textContent = s;
    this.status.classList.add('flash');
    setTimeout(() => {
      this.status.classList.remove('flash');
      this.status.textContent = `${this.changed().length} changed`;
    }, 1800);
  }

  // --- The panel --------------------------------------------------------------------------------------------------

  private build() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    this.ab.id = 'artBenchAB';
    this.ab.textContent = 'Defaults';
    document.body.append(this.ab);
    const p = this.panel;
    p.id = 'artBench';
    p.innerHTML = `<h4>Art bench · F2</h4>
<div class="row"><select class="shots" style="flex:1;min-width:0"></select><button data-a="prev" title="Previous shot ([)">◀</button><button data-a="next" title="Next shot (])">▶</button></div>
<div class="row"><input class="shotName" type="text" title="This shot's name"><button data-a="tour" title="Go round the shots, 5 s each">Tour</button></div>
<div class="row">Time <input class="tod" type="range" min="0" max="1439" step="1"> <b class="todText"></b></div>
<div class="row"><button data-a="saveView" title="Put the current view and time on this shot">Save view</button><button data-a="addView" title="A new shot from the current view and time">Add view</button><button data-a="delShot" title="Remove this shot">Delete</button></div>
<div class="row"><button data-a="copyShots" title="The shot list as code, for SHOTS in src/artBench.ts">Copy shots</button><button data-a="resetShots" title="Back to the shots in the code">Reset shots</button></div>
<div class="row" style="margin-top:10px"><button data-a="ab" title="Hold (or hold \\) to see the code's defaults">Hold: A/B</button><button data-a="export" title="Download the whole look as JSON">Export</button><button data-a="import" title="Load a look from an exported JSON">Import</button>
<button data-a="diff" title="Copy what differs from the defaults, with where each lives in the code">Copy diff</button><button data-a="resetAll" title="Every setting back to the code's default">Reset all</button></div>
<div class="row status"></div>
<input class="file" type="file" accept=".json,application/json" style="display:none">`;
    document.body.append(p);
    const $ = <T extends HTMLElement>(q: string) => p.querySelector<T>(q)!;
    this.shotSelect = $('.shots');
    this.shotName = $('.shotName');
    this.todSlider = $('.tod');
    this.todLabel = $('.todText');
    this.status = $('.status');
    const file = $<HTMLInputElement>('.file');
    this.shotSelect.addEventListener('change', () => this.go(Number(this.shotSelect.value)));
    this.shotName.addEventListener('change', () => {
      this.shots[this.index].name = this.shotName.value || `Shot ${this.index + 1}`;
      this.saveShots();
    });
    this.todSlider.addEventListener('input', () => {
      const hour = Number(this.todSlider.value) / 60;
      this.setHour(hour);
    });
    file.addEventListener('change', () => {
      if (file.files?.[0]) this.importJson(file.files[0]);
      file.value = '';
    });
    const actions: Record<string, (b: HTMLButtonElement) => void> = {
      prev: () => this.go(this.index - 1),
      next: () => this.go(this.index + 1),
      tour: (b) => {
        this.touring = !this.touring;
        this.tourT = 0;
        b.classList.toggle('on', this.touring);
      },
      saveView: () => {
        this.shots[this.index] = this.view(this.shots[this.index].name);
        this.saveShots();
        this.flash('Shot saved');
      },
      addView: () => {
        this.shots.splice(this.index + 1, 0, this.view(`View ${this.shots.length + 1}`));
        this.index++;
        this.saveShots();
      },
      delShot: () => {
        if (this.shots.length < 2) return;
        this.shots.splice(this.index, 1);
        this.saveShots();
        this.go(Math.min(this.index, this.shots.length - 1));
      },
      copyShots: () => this.copy(`const SHOTS: Shot[] = [\n${this.shots.map((s) => `  ${JSON.stringify(s).replace(/"(\w+)":/g, '$1: ').replace(/,(?=\w+: )/g, ', ').replace(/"/g, "'")},`).join('\n')}\n];`, 'Shots'),
      resetShots: () => {
        this.shots = SHOTS.map((s) => ({ ...s }));
        save(STORE_SHOTS, null);
        this.go(0);
      },
      export: () => this.exportJson(),
      import: () => file.click(),
      diff: () => this.copy(this.diff(), 'Diff'),
      resetAll: () => {
        this.apply(this.defaults);
        this.touched();
      },
    };
    for (const b of p.querySelectorAll<HTMLButtonElement>('button[data-a]')) {
      const a = b.dataset.a!;
      if (a === 'ab') {
        b.addEventListener('pointerdown', () => this.compare(true));
        for (const ev of ['pointerup', 'pointerleave'] as const) b.addEventListener(ev, () => this.compare(false));
      } else b.addEventListener('click', () => actions[a](b));
    }

    for (const prm of this.params) this.row(prm);
    this.groups.get('Tone & grade')?.parentElement?.setAttribute('open', '');
    this.showShots();
    this.touched();
  }

  private group(name: string): HTMLElement {
    let body = this.groups.get(name);
    if (!body) {
      const d = document.createElement('details');
      d.innerHTML = `<summary>${name} <span class="now"></span></summary><div></div>`;
      this.panel.append(d);
      body = d.lastElementChild as HTMLElement;
      this.groups.set(name, body);
    }
    return body;
  }

  /** One setting's row: name, control, value, and a reset to the default. */
  private row(p: Param) {
    const el = document.createElement('div');
    el.className = 'p';
    el.title = `${p.src}\ndefault ${text(p, this.defaults.get(p.id)!)}`;
    el.innerHTML = `<span>${p.label}</span><span class="ctl"></span><span class="val"></span><span class="reset" title="Back to the default">↺</span>`;
    const ctl = el.querySelector<HTMLElement>('.ctl')!;
    const val = el.querySelector<HTMLElement>('.val')!;
    el.querySelector('.reset')!.addEventListener('click', () => {
      p.set(this.defaults.get(p.id)!);
      this.touched();
    });
    let show: () => void;
    if (p.kind === 'choice') {
      const sel = document.createElement('select');
      sel.innerHTML = p.options!.map((o) => `<option>${o}</option>`).join('');
      sel.addEventListener('change', () => (p.set(sel.value), this.touched()));
      ctl.append(sel);
      show = () => (sel.value = p.get() as string);
    } else if (p.kind === 'num') {
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(p.min);
      range.max = String(p.max);
      range.step = String(p.step);
      const box = document.createElement('input');
      box.type = 'number';
      box.step = String(p.step);
      const set = (v: number) => Number.isFinite(v) && (p.set(v), this.touched());
      range.addEventListener('input', () => set(Number(range.value)));
      box.addEventListener('change', () => set(Number(box.value)));
      ctl.append(range);
      val.append(box);
      show = () => {
        const v = p.get() as number;
        range.value = String(v);
        if (document.activeElement !== box) box.value = String(round(v));
      };
    } else {
      const pick = document.createElement('input');
      pick.type = 'color';
      const gain = document.createElement('input');
      gain.type = 'number';
      gain.step = '0.01';
      gain.min = '0';
      gain.title = p.kind === 'hdr' ? 'Intensity' : 'Gain past 1 (HDR)';
      pick.addEventListener('input', () => {
        const c = p.get() as Rgb, k = gainOf(p, c);
        tmp.set(pick.value);
        p.set([tmp.r * k, tmp.g * k, tmp.b * k]);
        this.touched();
      });
      gain.addEventListener('change', () => {
        const c = p.get() as Rgb, k = gainOf(p, c), next = Number(gain.value);
        if (!(next >= 0)) return;
        p.set(Math.max(...c) > 0 ? (c.map((x) => (x / k) * next) as Rgb) : [next, next, next]);
        this.touched();
      });
      ctl.append(pick);
      val.append(gain);
      show = () => {
        const c = p.get() as Rgb, k = gainOf(p, c);
        pick.value = hexOf(c, k);
        if (document.activeElement !== gain) gain.value = String(round(k));
      };
    }
    const all = () => {
      show();
      el.classList.toggle('changed', !same(p.get(), this.defaults.get(p.id)!));
    };
    this.rows.push({ p, show: all });
    this.group(p.group).append(el);
  }

  private showShots() {
    this.shotSelect.innerHTML = this.shots.map((s, i) => `<option value="${i}">${i + 1}. ${s.name.replace(/</g, '&lt;')}</option>`).join('');
    this.shotSelect.value = String(this.index);
    this.shotName.value = this.shots[this.index]?.name ?? '';
  }

  /** Marks the palette keys the sky is blended from now, with how much of each. */
  private showPalette() {
    const keys = this.h.day.keys;
    const el = THREE.MathUtils.radToDeg(this.h.day.elevation);
    let i = 0;
    while (i < keys.length - 2 && el > keys[i + 1].el) i++;
    const t = THREE.MathUtils.smoothstep(el, keys[i].el, keys[i + 1].el);
    keys.forEach((k, j) => {
      const share = j === i ? 1 - t : j === i + 1 ? t : 0;
      const now = this.groups.get(keyGroup(k))?.parentElement?.querySelector('.now');
      if (now) now.textContent = share > 0.005 ? `● ${Math.round(share * 100)}%` : '';
    });
    if (timeControl.override !== null) this.todLabel.textContent = `${clockText(timeControl.override)} · sun ${Math.round(el)}°`;
  }

  private keys() {
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement && e.target.type !== 'range' || e.target instanceof HTMLSelectElement;
    addEventListener('keydown', (e) => {
      if (e.code === 'F2') {
        e.preventDefault();
        if (document.pointerLockElement) {
          ui.debugFreed = true; // (not the Esc menu)
          document.exitPointerLock();
          this.panel.classList.remove('hidden');
        } else this.panel.classList.toggle('hidden');
        return;
      }
      if (typing(e)) return;
      if (e.code === 'BracketLeft') this.go(this.index - 1);
      else if (e.code === 'BracketRight') this.go(this.index + 1);
      else if (e.code === 'Backslash' && !e.repeat) this.compare(true);
    });
    addEventListener('keyup', (e) => e.code === 'Backslash' && this.compare(false));
    addEventListener('blur', () => this.compare(false));
  }
}
