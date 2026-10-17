// Guardians and night drones on the client (shared/guardians.ts): interpolates the server's 'bots' messages
// (src/world/botFrames.ts), walks the guardians (src/world/guardians.ts) and flies the drones
// (src/world/drones.ts), and does what makes them feel big and dangerous: footfall sound, dust and camera shake,
// the horn when one comes for you, the cannon (src/world/bolts.ts: charge whine, zap, burst), the missiles a drone
// calls down (src/world/missiles.ts: whistle, blast), a chirp when a drone locks on.
import * as THREE from 'three/webgpu';
import { BOT_DELAY_MS, dronesAt, guardiansAt } from './world/botFrames';
import { Drones } from './world/drones';
import { Guardians, type Footfall } from './world/guardians';
import { Bolts } from './world/bolts';
import { Missiles } from './world/missiles';
import { CHARGE_MS, CRAWLER, GUARDIAN, KINDS } from '../shared/guardians.ts';
import { guardianSound } from './guardianSound';
import { rifleSound } from './rifleSound';
import { tyreDust } from './tyreDust';
import type { Net } from './net';

/** Footfalls shake the camera within this distance (m), up to SHAKE metres at the foot. */
const SHAKE_R = 90;
const SHAKE = 0.35;
const DUST_R = 600;

export class GuardianFx {
  readonly guardians: Guardians;
  readonly drones: Drones;
  readonly bolts: Bolts;
  readonly missiles: Missiles;
  private bound = false;
  private locked = false;
  private charging = new Set<number>();
  private muzzle = new THREE.Vector3();
  private shake = 0;
  private hunted = new Set<number>();
  /** Something is after you: a guardian or crawlers hunting you, a drone's light on you, or a missile coming down. */
  combat = false;
  private crawled = new Set<number>();
  private bitAt = 0;
  private ear = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.guardians = new Guardians(scene);
    this.drones = new Drones(scene);
    this.bolts = new Bolts(scene);
    this.missiles = new Missiles(scene);
    this.guardians.onFootfall = (f) => this.footfall(f);
    // A shot-down drone hitting the sand: a bang and a clatter.
    this.drones.onCrash = (x, y, z) => {
      guardianSound.boom(x, y, z, this.ear);
      rifleSound.slam({ x, y, z }, this.ear, false);
      this.thump(x, y, z, 0.6, 0, 0, 0);
    };
    this.guardians.onEvent = (e) => {
      // A weak point shattered (whoever shot it), a dying walker's leg gave out, its hull hit the sand.
      const heavy = e.kind === GUARDIAN;
      if (e.what === 'break') rifleSound.impact('glass', e, this.ear);
      else if (e.what === 'fail') rifleSound.fail(e, this.ear, heavy);
      else {
        rifleSound.slam(e, this.ear, heavy);
        if (heavy) this.thump(e.x, e.y, e.z, 2.4, 28, 6, 3.2);
        else this.thump(e.x, e.y, e.z, 0.3, 5, 1, 0.4);
      }
    };
  }

  private footfall(f: Footfall) {
    if (f.kind === CRAWLER) {
      guardianSound.tick(f.x, f.y, f.z, this.ear);
      if (Math.random() < 0.3 && Math.hypot(f.x - this.ear.x, f.z - this.ear.z) < 60) {
        tyreDust.emit(f.x, f.y + 0.05, f.z, (Math.random() - 0.5) * 0.6, 0.2, (Math.random() - 0.5) * 0.6, 0.25);
      }
      return;
    }
    guardianSound.footfall(f.x, f.y, f.z, f.weight, this.ear);
    this.thump(f.x, f.y, f.z, f.weight, 9, 2.5 * KINDS[GUARDIAN].scale, 1.6 * KINDS[GUARDIAN].scale);
  }

  /** Shake and dust for something heavy at (x, y, z). */
  private thump(x: number, y: number, z: number, weight: number, puffs: number, speed: number, size: number) {
    const d = Math.hypot(x - this.ear.x, z - this.ear.z);
    if (d < SHAKE_R) this.shake = Math.max(this.shake, SHAKE * weight * (1 - d / SHAKE_R) ** 2);
    if (d < DUST_R) {
      for (let i = 0; i < puffs; i++) {
        const a = (i / puffs) * Math.PI * 2 + Math.random() * 0.5, v = speed + Math.random() * speed;
        tyreDust.emit(x + Math.cos(a) * 1.2, y + 0.3, z + Math.sin(a) * 1.2, Math.cos(a) * v, 0.6 + Math.random() * speed * 0.5, Math.sin(a) * v, size);
      }
    }
  }

  /** Every frame, after the camera has been placed: draws them and shakes the camera. */
  update(net: Net, dt: number, camera: THREE.Camera, focus: { x: number; z: number }) {
    this.ear.copy(camera.position);
    if (!this.bound) {
      this.bound = true;
      net.onBolt = (m) => {
        if (m.t === 'shot') {
          const muzzle = this.guardians.fire(m.g, this.muzzle);
          this.bolts.fire(m, muzzle);
          const at = muzzle ?? this.muzzle.set(m.x, m.y, m.z);
          guardianSound.zap(at.x, at.y, at.z, this.ear);
        } else if (m.t === 'boom') {
          this.bolts.boom(m.id, m.x, m.y, m.z, m.ground);
          guardianSound.boom(m.x, m.y, m.z, this.ear);
          if (m.ground) this.thump(m.x, m.y, m.z, 2.6, 30, 7, 3.4);
        } else if (m.t === 'missile') {
          this.missiles.launch(m);
          guardianSound.whistle(m.x1, m.y1, m.z1, m.flight - (net.serverTime() - m.time) / 1000, this.ear);
        } else {
          this.missiles.land(m.id);
          this.bolts.boom(-1, m.x, m.y, m.z, true);
          guardianSound.boom(m.x, m.y, m.z, this.ear);
          this.thump(m.x, m.y, m.z, 2.6, 30, 7, 3.4);
        }
      };
    }
    this.bolts.update(dt, net.serverTime());
    this.missiles.update(dt, net.serverTime());
    const t = net.serverTime() - BOT_DELAY_MS;
    const gs = guardiansAt(net.bots, t);
    const ds = dronesAt(net.bots, t);
    this.guardians.update(gs, dt, focus);
    this.drones.update(ds, dt, focus);
    guardianSound.drones(ds.filter((d) => !d.down), this.ear); // shot-down ones are quiet
    // The horn, once, when one starts hunting you; the cannon's whine as it charges.
    for (const g of gs) {
      if (g.gun === 1 && !this.charging.has(g.id) && Math.hypot(g.x - focus.x, g.z - focus.z) < 250) {
        guardianSound.charge(g.x, camera.position.y + 10, g.z, (CHARGE_MS - BOT_DELAY_MS) / 1000);
      }
      if (g.gun === 1) this.charging.add(g.id);
      else this.charging.delete(g.id);
      if (g.kind === CRAWLER) {
        // Crawlers chitter when they come for you, and snap when they get you (the server's bite lands about then).
        const d = Math.hypot(g.x - focus.x, g.z - focus.z);
        if (g.hunt === 2 && !this.crawled.has(g.id)) guardianSound.chitter(g.x, camera.position.y - 1, g.z, false);
        if (g.hunt === 2 && d < KINDS[CRAWLER].reach + 0.8 && performance.now() - this.bitAt > 1000) {
          this.bitAt = performance.now();
          guardianSound.chitter(g.x, camera.position.y - 1, g.z, true);
        }
        if (g.hunt === 2) this.crawled.add(g.id);
        else this.crawled.delete(g.id);
        continue;
      }
      if (g.hunt === 2 && !this.hunted.has(g.id)) guardianSound.horn(g.x, camera.position.y + 12, g.z);
      if (g.hunt === 2) this.hunted.add(g.id);
      else this.hunted.delete(g.id);
    }
    for (const id of this.crawled) if (!gs.some((g) => g.id === id)) this.crawled.delete(id);
    for (const id of this.hunted) if (!gs.some((g) => g.id === id)) this.hunted.delete(id);
    const spotted = ds.some((d) => d.lock === 2);
    if (spotted && !this.locked) guardianSound.chirp();
    this.locked = spotted;
    const incoming = this.missiles.incoming(focus.x, focus.z, 30, net.serverTime()).length > 0;
    this.combat = incoming || spotted || this.hunted.size > 0 || this.crawled.size > 0;
    if (this.shake > 0.001) {
      const s = this.shake;
      camera.position.x += (Math.random() - 0.5) * s;
      camera.position.y += (Math.random() - 0.5) * s;
      camera.position.z += (Math.random() - 0.5) * s;
      this.shake *= Math.exp(-dt * 7);
    }
  }
}
