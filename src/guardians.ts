// Guardians and night drones on the client (shared/guardians.ts): interpolates the server's 'bots' messages
// (src/world/botFrames.ts), walks the guardians (src/world/guardians.ts) and flies the drones
// (src/world/drones.ts), and does what makes them feel big and dangerous: footfall sound, dust and camera shake,
// the horn when one comes for you, the drone siren, and a warning line on the HUD.
import * as THREE from 'three/webgpu';
import { BOT_DELAY_MS, dronesAt, guardiansAt } from './world/botFrames';
import { Drones } from './world/drones';
import { Guardians, type Footfall } from './world/guardians';
import { guardianSound } from './guardianSound';
import { tyreDust } from './tyreDust';
import type { Net } from './net';

/** Footfalls shake the camera within this distance (m), up to SHAKE metres at the foot. */
const SHAKE_R = 90;
const SHAKE = 0.35;
const DUST_R = 600;

const css = `
#botWarn { position: fixed; left: 50%; top: 14%; transform: translateX(-50%); pointer-events: none; z-index: 6;
  font: 700 15px var(--mono, monospace); letter-spacing: 0.12em; text-transform: uppercase; color: #ffd0b0;
  text-shadow: 0 0 8px rgba(255, 40, 10, 0.9), 0 1px 2px #000; opacity: 0; transition: opacity .3s; white-space: nowrap; }
#botWarn.on { opacity: 1; animation: botBlink 0.7s steps(2, start) infinite; }
@keyframes botBlink { to { visibility: hidden; } }
`;

export class GuardianFx {
  readonly guardians: Guardians;
  readonly drones: Drones;
  private shake = 0;
  private hunted = new Set<number>();
  private warn = document.createElement('div');
  private ear = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.guardians = new Guardians(scene);
    this.drones = new Drones(scene);
    this.guardians.onFootfall = (f) => this.footfall(f);
    const style = document.createElement('style');
    style.textContent = css;
    this.warn.id = 'botWarn';
    document.head.append(style);
    document.body.append(this.warn);
  }

  private footfall(f: Footfall) {
    guardianSound.footfall(f.x, f.y, f.z, f.weight, this.ear);
    const d = Math.hypot(f.x - this.ear.x, f.z - this.ear.z);
    if (d < SHAKE_R) this.shake = Math.max(this.shake, SHAKE * f.weight * (1 - d / SHAKE_R) ** 2);
    if (d < DUST_R) {
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2 + Math.random() * 0.5, v = 2.5 + Math.random() * 2.5;
        tyreDust.emit(f.x + Math.cos(a) * 1.2, f.y + 0.3, f.z + Math.sin(a) * 1.2, Math.cos(a) * v, 0.6 + Math.random(), Math.sin(a) * v, 1.6);
      }
    }
  }

  /** Every frame, after the camera has been placed: draws them and shakes the camera. */
  update(net: Net, dt: number, camera: THREE.Camera, focus: { x: number; z: number }) {
    this.ear.copy(camera.position);
    const t = net.serverTime() - BOT_DELAY_MS;
    const gs = guardiansAt(net.bots, t);
    const ds = dronesAt(net.bots, t);
    this.guardians.update(gs, dt, focus);
    this.drones.update(ds, dt, focus);
    guardianSound.drones(ds, this.ear);
    // The horn, once, when one starts hunting you.
    for (const g of gs) {
      if (g.hunt === 2 && !this.hunted.has(g.id)) guardianSound.horn(g.x, camera.position.y + 12, g.z);
      if (g.hunt === 2) this.hunted.add(g.id);
      else this.hunted.delete(g.id);
    }
    const spotted = ds.some((d) => d.lock === 2);
    const text = spotted ? 'Spotted — get out of the light' : this.hunted.size ? 'A guardian is coming for you' : '';
    if (text) this.warn.textContent = text;
    this.warn.classList.toggle('on', text !== '');
    if (this.shake > 0.001) {
      const s = this.shake;
      camera.position.x += (Math.random() - 0.5) * s;
      camera.position.y += (Math.random() - 0.5) * s;
      camera.position.z += (Math.random() - 0.5) * s;
      this.shake *= Math.exp(-dt * 7);
    }
  }
}
