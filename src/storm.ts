// Sandstorms on the client (shared/storm.ts; the server picks them, server/storm.ts): the warning beep
// and banner for a storm heading your way, how stormy it is where you stand (that drives the wind,
// src/world/wind.ts, and through it the dust, grains, haze and wind sound), and the storm columns the post
// pass draws (src/post.ts). The heat is the server's (server/water.ts); the HUD just shows the felt °C.
//
// In the dust you lose the locator bar (src/locator.ts): no bearings on the base or the others.
//
// Mega-storm fronts: drawn as a wall of dust (post.ts, stormFront), roaring up as it nears; in the lee of rock
// the grit and the wind ease off, and out in the open the view closes in as you choke (the server's tally,
// mirrored here: server/world.ts).
import { BASE, HUT, ROOM_Z, W, inBase } from '../shared/base.ts';
import { indoors, S_HUT, shelterAt, shelterHutInside } from '../shared/shelters.ts';
import { CHOKE_RECOVER, CHOKE_S, FRONT_PASS_S, FRONT_RAMP_MS, FRONT_SPEED, RAMP_MS, frontArrival, frontAt, frontDepth, frontExposure, inStormPath, sheltered, stormAt, stormCentre, stormEnvelope, stormStrength, type Storm } from '../shared/storm.ts';
import { WIND } from '../shared/dunes.ts';
import { heightAt } from '../shared/terrain.ts';
import { audio } from './audio';
import { choking, indoorHutMax, indoorHutMin, indoorSurface, STORM_SLOTS, stormDiscs, stormFront, stormFrontEnv, stormGround, stormHere, stormIndoors } from './world/env';
import { wind } from './world/wind';
import { TEXT } from '../shared/text.ts';

/** Seconds between beep bursts while a storm you're in the path of is on its way. */
const BEEP_EVERY = 2.5;
/** Three pips per burst: length and gap (s), pitch (Hz). */
const PIP = 0.09;
const PIP_GAP = 0.07;
const PIP_HZ = 1760;
/** Peak gain of a pip. At the default volume (0.4) a burst peaks at −27.5 LUFS momentary, true peak −14 dBTP
 *  (6 dB under the −21.5 measured at gain 1): a quiet tell under the mix, not an alarm. */
const PIP_GAIN = 0.5;
/** Storm strength at the camera above which the locator bar is lost in the dust. */
const LOST_AT = 0.35;
/** How fast the felt storm follows where you are (s), so walking out of one doesn't pop. */
const TAU = 0.8;
/** A front's roar starts this far (m) ahead of it, rising to FRONT_ROAR of a storm's wind at its wall. */
const FRONT_HEARD = 400;
const FRONT_ROAR = 0.6;
/** What's left of a front's grit on the view, and of its wind, in the lee of rock. */
const LEE_GRIT = 0.4;
const LEE_WIND = 0.6;
/** Speech: a front this close (s) to reaching you; choked this long (s) before saying so. */
const FRONT_SAY_S = 25;
const CHOKE_SAY_S = 2;

/** Debug menu: storms only this client sees, merged into the server's (no heat, no one else). */
const localStorms: Storm[] = [];
let summonLocal: boolean | 'here' | 'front' = false;
/** A storm rolling in from upwind right now, seen only by you, to look at the dust (debug menu). */
export function summonLocalStorm() {
  summonLocal = true;
}
/** Debug (dbg.storm.summonHere()): a full-strength local storm right over you for a minute and a half. */
export function summonHere() {
  summonLocal = 'here';
}
/** Debug (dbg.storm.summonFront()): a storm front only you see, standing still `ahead` m upwind for three minutes,
 *  to look at the wall (you choke in it, but the server doesn't know). */
let frontAhead = 300;
export function summonFront(ahead = 300) {
  summonLocal = 'front';
  frontAhead = ahead;
}

const css = `
#storm { position: fixed; left: 50%; top: 14%; transform: translateX(-50%); padding: 6px 14px; display: none;
  font: 600 14px var(--mono); letter-spacing: .03em; color: #ffd9a0; background: rgba(40, 18, 6, 0.6);
  border-radius: 6px; box-shadow: 0 0 0 1px rgba(255, 190, 110, 0.35); text-shadow: 0 1px 2px #000;
  pointer-events: none; white-space: nowrap; }
#storm.warn { animation: stormPulse 1.25s ease-in-out infinite; }
@keyframes stormPulse { 0%, 100% { box-shadow: 0 0 0 1px rgba(255, 150, 60, 0.35); }
  50% { box-shadow: 0 0 0 2px rgba(255, 120, 40, 0.9); } }
`;

export class StormFx {
  /** Storm strength at the camera, eased, 0..1 (0 in the base). */
  level = 0;
  /** Storm strength over the camera's spot, in the base too, eased, 0..1. */
  outside = 0;
  /** Storm strength over the base, eased, 0..1: the sand sifting in (src/world/baseSand.ts). */
  atBase = 0;
  /** The storm detector is warning of a storm on its way here. */
  warning = false;
  /** A mega-storm front is about to hit us out in the open; we're choking in one; sitting one out in the lee of rock. */
  frontComing = false;
  choking = false;
  lee = false;
  /** Seconds of a front breathed in the open (as the server counts it, server/world.ts). */
  private choke = 0;
  private banner = document.createElement('div');
  private warned = new Map<number, number>(); // storm id → server ms of the last beep burst
  private c = { x: 0, z: 0 };

  constructor() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.banner.id = 'storm';
    document.body.appendChild(this.banner);
  }

  /** Per render frame: storms from the server, server time `now` (ms), the camera and the player's feet. */
  /** `warnS`: how early the storm detector on your belt warns (s, shared/gear.ts stormWarnS); 0 without one. */
  /** `dead`: lying dead (the choking stops). */
  update(dt: number, serverStorms: readonly Storm[], now: number, cam: { x: number; y: number; z: number }, me: { x: number; y: number; z: number }, warnS: number, dead = false) {
    if (summonLocal === 'front') {
      summonLocal = false;
      localStorms.push({ id: -1 - localStorms.length, x: me.x - WIND.x * frontAhead, z: me.z - WIND.z * frontAhead, r: FRONT_SPEED * FRONT_PASS_S,
        speed: 0.001, start: now - FRONT_RAMP_MS, end: now + 180_000, front: true });
    } else if (summonLocal === 'here') {
      summonLocal = false;
      localStorms.push({ id: -1 - localStorms.length, x: me.x, z: me.z, r: 60, speed: 0.5, start: now - RAMP_MS, end: now + 90_000 });
    } else if (summonLocal) {
      summonLocal = false;
      // Already building up, 180 m upwind: you see the wall from outside, then it rolls over you.
      localStorms.push({ id: -1 - localStorms.length, x: me.x - WIND.x * 140, z: me.z - WIND.z * 140, r: 60, speed: 4,
        start: now - RAMP_MS / 2, end: now + 90_000 });
    }
    for (let i = localStorms.length - 1; i >= 0; i--) if (localStorms[i].end <= now) localStorms.splice(i, 1);
    const storms = localStorms.length ? [...serverStorms, ...localStorms] : serverStorms;
    // The bunker (or a shelter) keeps the dust out: no grit on the view and the locator works down there. But the storm
    // still blows overhead: the wind (muffled underground, src/windSound.ts), the columns seen up through
    // the skylight and out of the door (the post pass starts them where the view leaves the base), and the
    // sand sifting in (src/world/baseSand.ts).
    const inside = indoors(cam.x, cam.y, cam.z);
    let column = 0, roar = 0;
    for (const s of storms) {
      if (!s.front) column = Math.max(column, stormStrength(s, cam.x, cam.z, now));
      else roar = Math.max(roar, stormEnvelope(s, now) * FRONT_ROAR * (1 - Math.min(1, -frontDepth(s, cam.x, cam.z, now) / FRONT_HEARD)));
    }
    const front = frontAt(storms, cam.x, cam.z, now);
    this.lee = front > 0.05 && !indoors(me.x, me.y, me.z) && sheltered(me.x, me.y, me.z);
    const outside = Math.max(column, front * (this.lee ? LEE_WIND : 1), Math.min(roar, FRONT_ROAR));
    const k = 1 - Math.exp(-dt / TAU);
    this.outside += (outside - this.outside) * k;
    this.level += ((inside ? 0 : Math.max(column, front * (this.lee ? LEE_GRIT : 1))) - this.level) * k;
    // Choking, counted as the server does (it decides the death).
    const exposure = dead ? 0 : frontExposure(storms, me.x, me.y, me.z, now);
    this.choke = dead ? 0 : Math.max(0, this.choke + (exposure > 0 ? exposure : -CHOKE_RECOVER) * dt);
    this.choking = this.choke > CHOKE_SAY_S;
    choking.value = Math.min(1, Math.max(0, (this.choke / CHOKE_S - 0.1) / 0.9));
    this.atBase += (stormAt(storms, BASE.x, BASE.z + ROOM_Z / 2, now) - this.atBase) * k;
    wind.local = this.outside;
    stormHere.value = this.level;
    stormIndoors.value = inside ? 1 : 0;
    const sh = inside && !inBase(cam.x, cam.y, cam.z) ? shelterAt(cam.x, cam.z) : null;
    if (sh) {
      const [x0, z0, x1, z1] = shelterHutInside(sh);
      indoorHutMin.value.set(x0, sh.y - 100, z0);
      indoorHutMax.value.set(x1, sh.y + S_HUT.h, z1);
      indoorSurface.value = sh.y;
    } else {
      indoorHutMin.value.set(BASE.x - W, BASE.y - 100, BASE.z + HUT.z0);
      indoorHutMax.value.set(BASE.x + W, BASE.y + HUT.h, BASE.z + HUT.z1);
      indoorSurface.value = BASE.y;
    }

    const g = stormGround.value;
    const ground = [0, 0, 0, 0];
    let n = 0;
    let fe = 0, fd = Infinity;
    for (const s of storms) {
      const e = stormEnvelope(s, now);
      if (s.front) {
        // One front is drawn: the one nearest the camera (two only overlap when summoned from the debug menu).
        const u = frontDepth(s, cam.x, cam.z, now);
        const d = u < 0 ? -u : Math.max(0, u - s.r);
        if (e <= 0 || d >= fd) continue;
        fe = e;
        fd = d;
        stormCentre(s, now, this.c);
        stormFront.value.set(WIND.x, WIND.z, this.c.x * WIND.x + this.c.z * WIND.z, s.r);
        continue;
      }
      if (e <= 0 || n >= STORM_SLOTS) continue;
      stormCentre(s, now, this.c);
      stormDiscs[n].value.set(this.c.x, this.c.z, s.r, e);
      ground[n++] = heightAt(this.c.x, this.c.z);
    }
    for (let i = n; i < STORM_SLOTS; i++) stormDiscs[i].value.w = 0;
    g.set(ground[0], ground[1], ground[2], ground[3]);
    stormFrontEnv.value.set(fe, fe > 0 ? heightAt(cam.x, cam.z) : 0);

    // Warning: a storm about to start whose path crosses where you stand, from the storm detector only.
    // A front: the detector hears it twice as early (it's that loud); you see it coming yourself.
    let coming: Storm | null = null;
    let frontIn = Infinity;
    for (const s of storms) {
      if (s.front) {
        const at = frontArrival(s, me.x, me.z);
        if (now >= at || at >= s.end) continue;
        frontIn = Math.min(frontIn, (at - now) / 1000);
        if (at - now <= warnS * 2000 && (!coming || at < coming.start)) coming = s;
        continue;
      }
      if (now >= s.start || s.start - now > warnS * 1000 || !inStormPath(s, me.x, me.z)) continue;
      if (!coming || s.start < coming.start) coming = s;
    }
    for (const id of this.warned.keys()) if (!storms.some((s) => s.id === id)) this.warned.delete(id);
    const out = !indoors(me.x, me.y, me.z);
    this.frontComing = out && frontIn < FRONT_SAY_S;
    this.warning = !!coming && out;
    if (coming && this.warning) {
      const last = this.warned.get(coming.id);
      if (last === undefined || now - last >= BEEP_EVERY * 1000) {
        this.warned.set(coming.id, now);
        beep();
      }
      this.show(coming.front ? TEXT.hud.stormFront : TEXT.hud.sandstorm, true);
    } else {
      this.show('', false);
    }
  }

  summonHere() {
    summonHere();
  }

  summonFront(ahead?: number) {
    summonFront(ahead);
  }

  /** The locator bar is lost in the dust. */
  get lost(): boolean {
    return this.level > LOST_AT;
  }

  private show(text: string, warn: boolean) {
    const b = this.banner;
    if (b.textContent !== text) b.textContent = text;
    b.style.display = text ? 'block' : 'none';
    b.classList.toggle('warn', warn);
  }
}

/** Three short pips, like a wrist alarm. Through the shared output (src/audio.ts: volume, limiter). */
function beep() {
  const ctx = audio.ctx, out = audio.out;
  if (!ctx || !out || !audio.running) return;
  const t0 = ctx.currentTime + 0.02;
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = PIP_HZ;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  osc.connect(gain).connect(out);
  for (let i = 0; i < 3; i++) {
    const t = t0 + i * (PIP + PIP_GAP);
    gain.gain.setTargetAtTime(PIP_GAIN, t, 0.004);
    gain.gain.setTargetAtTime(0, t + PIP, 0.008);
  }
  const end = t0 + 3 * (PIP + PIP_GAP) + 0.1;
  osc.start(t0);
  osc.stop(end);
  osc.onended = () => gain.disconnect();
}
