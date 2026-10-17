// Crash-site sounds: the faint electronic chatter of a wreck's half-dead systems (crashSynth.ts), heard
// within HEAR metres of its beacon and placed there in 3D (HRTF PannerNode; the Web Audio listener follows
// the camera). Only the nearest MAX_VOICES sites play. Very quiet on purpose: background detail you notice
// when you stop next to a wreck, about −30 LUFS at 5 m (see docs/devlog.md for the measurement).
//
// Plays through the shared output in src/audio.ts (volume slider, limiter); every level change is ramped.
import { audio } from './audio';
import { CrashVoice } from './crashSynth';
import { beaconPos, crashSitesNear, type CrashSite } from '../shared/crashsites.ts';

/** Audible within this distance (m) of the beacon, fading in over the outer FADE metres. */
const HEAR = 40;
const FADE = 14;
/** Full level (before the 1/d falloff) at and inside this distance (m). */
const REF = 5;
/** Steeper than 1/d, so the +6 dB close up is only ~+2.5 dB at the edge of earshot. */
const ROLLOFF = 1.6;
const MAX_VOICES = 2;
/** Schedule events this far ahead (s). */
const LOOKAHEAD = 0.25;

type Active = { site: CrashSite; voice: CrashVoice; fade: GainNode; panner: PannerNode; until: number };

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class CrashSound {
  private active = new Map<number, Active>();
  private pos = { x: 0, y: 0, z: 0 };

  /** Called every frame with the camera position and yaw (three.js: forward = (−sin, −cos)). */
  update(cam: { x: number; y: number; z: number }, yaw: number) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const now = ctx.currentTime;
    const l = ctx.listener;
    if (l.positionX) {
      const set = (p: AudioParam, v: number) => p.setTargetAtTime(v, now, 0.03);
      set(l.positionX, cam.x);
      set(l.positionY, cam.y);
      set(l.positionZ, cam.z);
      set(l.forwardX, -Math.sin(yaw));
      set(l.forwardY, 0);
      set(l.forwardZ, -Math.cos(yaw));
      set(l.upX, 0);
      set(l.upY, 1);
      set(l.upZ, 0);
    } else {
      // Browsers without the AudioParam listener (older Firefox).
      l.setPosition(cam.x, cam.y, cam.z);
      l.setOrientation(-Math.sin(yaw), 0, -Math.cos(yaw), 0, 1, 0);
    }

    // The nearest beacons in earshot.
    const want: { s: CrashSite; d: number }[] = [];
    for (const s of crashSitesNear(cam.x, cam.z, HEAR + 30)) {
      const b = beaconPos(s, this.pos);
      const d = Math.hypot(b.x - cam.x, b.y - cam.y, b.z - cam.z);
      if (d < HEAR) want.push({ s, d });
    }
    want.sort((a, b) => a.d - b.d).length = Math.min(want.length, MAX_VOICES);

    for (const { s, d } of want) {
      let a = this.active.get(s.id);
      if (!a) {
        const panner = new PannerNode(ctx, {
          panningModel: 'HRTF', distanceModel: 'inverse', refDistance: REF, rolloffFactor: ROLLOFF, maxDistance: 1000,
        });
        const fade = ctx.createGain();
        fade.gain.value = 0;
        const voice = new CrashVoice(ctx, s.id);
        voice.out.connect(fade).connect(panner).connect(out);
        const b = beaconPos(s, this.pos);
        panner.positionX.value = b.x;
        panner.positionY.value = b.y;
        panner.positionZ.value = b.z;
        this.active.set(s.id, (a = { site: s, voice, fade, panner, until: Infinity }));
      }
      a.until = Infinity;
      a.fade.gain.setTargetAtTime(smooth(HEAR, HEAR - FADE, d), now, 0.3);
      a.voice.schedule(now + LOOKAHEAD);
    }
    // Sites out of earshot (or no longer among the nearest) fade out, then let go of their nodes.
    for (const [id, a] of this.active) {
      if (want.some((w) => w.s.id === id)) continue;
      if (a.until === Infinity) {
        a.fade.gain.setTargetAtTime(0, now, 0.3);
        a.until = now + 2.5;
      } else if (now > a.until) {
        a.panner.disconnect();
        this.active.delete(id);
      }
    }
  }
}
