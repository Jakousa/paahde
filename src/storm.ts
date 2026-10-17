// Sandstorms on the client (shared/storm.ts; the server picks them, server/storm.ts): the warning beep
// and banner for a storm heading your way, how stormy it is where you stand (that drives the wind,
// src/world/wind.ts, and through it the dust, grains, haze and wind sound), and the storm columns the post
// pass draws (src/post.ts). The heat is the server's (server/water.ts); the HUD just shows the felt °C.
//
// In the dust you lose the locator bar (src/locator.ts): no bearings on the base or the others.
import { inBase } from '../shared/base.ts';
import { RAMP_MS, inStormPath, stormAt, stormCentre, stormEnvelope, type Storm } from '../shared/storm.ts';
import { WIND } from '../shared/dunes.ts';
import { heightAt } from '../shared/terrain.ts';
import { audio } from './audio';
import { STORM_SLOTS, stormDiscs, stormGround, stormHere } from './world/env';
import { wind } from './world/wind';

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

/** Debug menu: storms only this client sees, merged into the server's (no heat, no one else). */
const localStorms: Storm[] = [];
let summonLocal = false;
/** A storm rolling in from upwind right now, seen only by you, to look at the dust (debug menu). */
export function summonLocalStorm() {
  summonLocal = true;
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
  /** Storm strength at the camera, eased, 0..1. */
  level = 0;
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
  update(dt: number, serverStorms: readonly Storm[], now: number, cam: { x: number; y: number; z: number }, me: { x: number; y: number; z: number }, warnS: number) {
    if (summonLocal) {
      summonLocal = false;
      // Already building up, 180 m upwind: you see the wall from outside, then it rolls over you.
      localStorms.push({ id: -1 - localStorms.length, x: me.x - WIND.x * 180, z: me.z - WIND.z * 180, r: 100, speed: 4,
        start: now - RAMP_MS / 2, end: now + 90_000 });
    }
    for (let i = localStorms.length - 1; i >= 0; i--) if (localStorms[i].end <= now) localStorms.splice(i, 1);
    const storms = localStorms.length ? [...serverStorms, ...localStorms] : serverStorms;
    // The bunker keeps the dust out, and the columns aren't drawn from in there (they'd fog the rooms).
    const indoors = inBase(cam.x, cam.y, cam.z);
    const here = indoors ? 0 : stormAt(storms, cam.x, cam.z, now);
    this.level += (here - this.level) * (1 - Math.exp(-dt / TAU));
    wind.local = this.level;
    stormHere.value = this.level;

    const g = stormGround.value;
    const ground = [0, 0, 0, 0];
    let n = 0;
    for (const s of storms) {
      const e = stormEnvelope(s, now);
      if (e <= 0 || n >= STORM_SLOTS || indoors) continue;
      stormCentre(s, now, this.c);
      stormDiscs[n].value.set(this.c.x, this.c.z, s.r, e);
      ground[n++] = heightAt(this.c.x, this.c.z);
    }
    for (let i = n; i < STORM_SLOTS; i++) stormDiscs[i].value.w = 0;
    g.set(ground[0], ground[1], ground[2], ground[3]);

    // Warning: a storm about to start whose path crosses where you stand, from the storm detector only.
    let coming: Storm | null = null;
    for (const s of storms) {
      if (now >= s.start || s.start - now > warnS * 1000 || !inStormPath(s, me.x, me.z)) continue;
      if (!coming || s.start < coming.start) coming = s;
    }
    for (const id of this.warned.keys()) if (!storms.some((s) => s.id === id)) this.warned.delete(id);
    if (coming && !inBase(me.x, me.y, me.z)) {
      const last = this.warned.get(coming.id);
      if (last === undefined || now - last >= BEEP_EVERY * 1000) {
        this.warned.set(coming.id, now);
        beep();
      }
      this.show('⚠ Sandstorm', true);
    } else {
      this.show('', false);
    }
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
