// Poison gas on the client (shared/gas.ts; the server picks when, server/storm.ts): the low cloud the post pass draws
// (post.ts, gasLayer), its hiss as it creeps near, and choking in it: the server's tally (server/world.ts) mirrored
// here, so the view darkens towards black as death comes (gassed, post.ts). No banner and no beep: the storm detector
// doesn't hear it; you see it and smell it (the character says so).
import { duneFloor, WORLD_SEED } from '../shared/dunes.ts';
import { GAS_DEPTH, GAS_GRACE_S, GAS_RECOVER, GAS_S, gasArrival, gasBehind, gasDepth, gasEnvelope, gasExposure, type Gas } from '../shared/gas.ts';
import { audio } from './audio';
import { DARK_LIFT_S, gasEnv, gasLayer, gassed } from './world/env';

/** Speech: gas this close (s) to reaching us; breathed this long (s) before saying so. */
const COMING_SAY_S = 20;
const GASSED_SAY_S = 1.5;
/** The hiss starts this far (m) ahead of the cloud, reaching HISS_EDGE of full at its edge, full with your head in it. */
const HISS_HEARD = 150;
const HISS_EDGE = 0.5;
/** Peak gain of the hiss (white noise, bandpass 260 Hz, lowpass 700 Hz): ffmpeg ebur128 puts that chain at −21 LUFS at
 *  gain 1, so this is about −31.5 LUFS at the reference volume (−39.5 at the default 0.4): a bed under the mix. */
const HISS_GAIN = 0.3;
/** Dune-floor slope is sampled this far (m) either side of the camera. */
const SLOPE_D = 25;

export class GasFx {
  /** Gas about to reach us; breathing it. */
  coming = false;
  gassing = false;
  /** Seconds of gas breathed (as the server counts it, server/world.ts). */
  private tally = 0;
  private hiss: GainNode | null = null;
  /** Seconds left of the grace after respawning (as the server's, server/world.ts). */
  private grace = 0;

  constructor() {
    audio.onStart((ctx, out) => {
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 260;
      bp.Q.value = 0.8;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 700;
      // A slow swell, like something breathing out of the ground.
      const swell = ctx.createGain();
      swell.gain.value = 0.8;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.13;
      const depth = ctx.createGain();
      depth.gain.value = 0.2;
      lfo.connect(depth).connect(swell.gain);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(bp).connect(lp).connect(swell).connect(gain).connect(out);
      src.start();
      lfo.start();
      this.hiss = gain;
    });
  }

  /** Just respawned: the gas doesn't count for a while. */
  respawned() {
    this.grace = GAS_GRACE_S;
  }

  /** Per render frame: the gas from the server, server time `now` (ms), the camera and the player's feet.
   *  `dead`: lying dead (the choking stops). */
  update(dt: number, gas: readonly Gas[], now: number, cam: { x: number; y: number; z: number }, me: { x: number; y: number; z: number }, dead = false) {
    // Choking, counted as the server does (it decides the death).
    this.grace = Math.max(0, this.grace - dt);
    const exposure = dead || this.grace > 0 ? 0 : gasExposure(gas, me.x, me.y, me.z, now);
    this.tally = dead ? 0 : Math.max(0, this.tally + (exposure > 0 ? exposure : -GAS_RECOVER) * dt);
    this.gassing = this.tally > GASSED_SAY_S;
    // Black a little before the server's tally kills, so the view is dark when the death comes.
    gassed.value = dead ? Math.max(0, gassed.value - dt / DARK_LIFT_S) : Math.min(1, this.tally / (GAS_S * 0.92));

    let comingIn = Infinity, near = 0;
    let drawn: Gas | null = null, drawnD = Infinity;
    for (const g of gas) {
      const at = gasArrival(g, me.x, me.z);
      if (now < at && at < g.end) comingIn = Math.min(comingIn, (at - now) / 1000);
      const u = gasBehind(g, cam.x, cam.z, now);
      const e = gasEnvelope(g, now);
      near = Math.max(near, e * (u < 0 ? Math.max(0, 1 + u / HISS_HEARD) * HISS_EDGE : u < g.r ? HISS_EDGE + (1 - HISS_EDGE) * gasDepth(g, cam.x, cam.z, now) / GAS_DEPTH : 0));
      // One cloud is drawn: the one nearest the camera.
      const d = u < 0 ? -u : Math.max(0, u - g.r);
      if (e > 0 && d < drawnD) {
        drawn = g;
        drawnD = d;
      }
    }
    this.coming = !dead && comingIn < COMING_SAY_S;
    near = Math.max(near, Math.min(1, exposure));
    if (this.hiss && audio.ctx) this.hiss.gain.setTargetAtTime(dead ? 0 : near * HISS_GAIN, audio.ctx.currentTime, 0.6);

    if (!drawn) {
      gasEnv.value.x = 0;
      return;
    }
    const lead = drawn.x * drawn.dx + drawn.z * drawn.dz + (drawn.speed * (now - drawn.start)) / 1000;
    gasLayer.value.set(drawn.dx, drawn.dz, lead, drawn.r);
    const h = duneFloor(cam.x, cam.z, WORLD_SEED);
    const sx = (duneFloor(cam.x + SLOPE_D, cam.z, WORLD_SEED) - duneFloor(cam.x - SLOPE_D, cam.z, WORLD_SEED)) / (2 * SLOPE_D);
    const sz = (duneFloor(cam.x, cam.z + SLOPE_D, WORLD_SEED) - duneFloor(cam.x, cam.z - SLOPE_D, WORLD_SEED)) / (2 * SLOPE_D);
    // The plane through the floor under the camera, written as its height at the world origin plus the slopes.
    gasEnv.value.set(gasEnvelope(drawn, now), h - sx * cam.x - sz * cam.z, sx, sz);
  }
}
