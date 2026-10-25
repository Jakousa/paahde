// Sand vortices on the client (shared/vortex.ts; the server picks them, server/storm.ts): the one nearest the camera is
// drawn by the post pass (src/post.ts, env.ts vortex), and near it the wind roars and the grit flies (src/world/wind.ts,
// the storm's grit on the view) the closer you are. The drag is shared/sim.ts's, the death the server's.
import { indoors } from '../shared/shelters.ts';
import { heightAt } from '../shared/terrain.ts';
import { vortexCentre, vortexEnvelope, vortexNear, type Vortex } from '../shared/vortex.ts';
import { stormHere, vortex } from './world/env';
import { wind } from './world/wind';

/** How fast the felt vortex follows where you are (s). */
const TAU = 0.8;

export class VortexFx {
  /** How close the nearest vortex is, eased, 0..1 (1 at its core). */
  near = 0;
  private c = { x: 0, z: 0 };

  /** Per render frame, after the storms (it only ever adds to their wind and grit). */
  update(dt: number, vortices: readonly Vortex[], now: number, cam: { x: number; y: number; z: number }) {
    let best: Vortex | null = null, bd = Infinity;
    for (const v of vortices) {
      if (vortexEnvelope(v, now) <= 0) continue;
      vortexCentre(v, now, this.c);
      const d = Math.hypot(this.c.x - cam.x, this.c.z - cam.z);
      if (d < bd) (best = v), (bd = d);
    }
    if (best) {
      vortexCentre(best, now, this.c);
      vortex.value.set(this.c.x, this.c.z, heightAt(this.c.x, this.c.z), vortexEnvelope(best, now));
    } else vortex.value.w = 0;
    this.near += (vortexNear(vortices, cam.x, cam.z, now) - this.near) * (1 - Math.exp(-dt / TAU));
    wind.local = Math.max(wind.local, this.near);
    if (!indoors(cam.x, cam.y, cam.z)) stormHere.value = Math.max(stormHere.value, this.near * this.near);
  }
}
