// Guardians and night drones on the client (shared/guardians.ts): interpolates the server's 'bots' messages
// (src/world/botFrames.ts), walks the guardians (src/world/guardians.ts) and flies the drones
// (src/world/drones.ts), and does what makes them feel big and dangerous: footfall sound, dust and camera shake,
// the horn when one comes for you, the cannon (src/world/bolts.ts: charge whine, zap, burst), the missiles a drone
// calls down (src/world/missiles.ts: jet roar, blast), a chirp when a drone locks on. Also flies the fixed-wing
// drones (src/world/jets.ts) and their roar, and the harvesters (src/world/harvesters.ts): their rumble (a roar when
// one charges), the ground trembling near one, the shots that land in their maws, their death.
import * as THREE from 'three/webgpu';
import { BOT_DELAY_MS, dronesAt, guardiansAt } from './world/botFrames';
import { Drones } from './world/drones';
import { Guardians, type Footfall } from './world/guardians';
import { Bolts } from './world/bolts';
import { Missiles } from './world/missiles';
import { Jets } from './world/jets';
import { Harvesters } from './world/harvesters';
import { harvesterSound } from './harvesterSound';
import { SPEED } from '../shared/harvester.ts';
import { jetAt, jetPose, type JetPose } from '../shared/jets.ts';
import { SPEED_OF_SOUND } from './acoustics';
import { CHARGE_MS, CRAWLER, FIRE_R, FOOT_CRUSH_R, GUARDIAN, KINDS } from '../shared/guardians.ts';
import { guardianSound } from './guardianSound';
import { rifleSound } from './rifleSound';
import { tyreDust } from './tyreDust';
import { zaps } from './world/zaps';
import type { Net } from './net';
import { claim } from './kills';

/** Footfalls shake the camera within this distance (m), up to SHAKE metres at the foot. */
const SHAKE_R = 90;
const SHAKE = 0.35;
const DUST_R = 600;
/** A harvester shakes the ground within TREMBLE_R m; one charging within CHARGE_NEAR counts as a fight. */
const TREMBLE_R = 90;
const CHARGE_NEAR = 250;
/** A harvester charging within this (m) is coming for us. */
const RAM_NEAR = 90;
/** A crawler's bite jolts the camera this much (m). */
const BITE_SHAKE = 0.18;

/** Firework bursts (rifleSound.firework) besides a guardian's weak point: a crawler's and a crashing drone's softer
 *  (×level), a missile's blast lower (pitch) to sound bigger. */
const CRAWLER_FIREWORK = 0.4;
const DRONE_FIREWORK = 0.5;
const MISSILE_FIREWORK_PITCH = 0.8;
const MISSILE_FIREWORK = 0.7;

/** What can turn on us, and what we can kill (the character's remarks: src/speechLines.ts). */
export type Aggro = 'guardian' | 'crawler' | 'drone' | 'harvester';
export type Kill = Aggro | 'jet';

export class GuardianFx {
  readonly guardians: Guardians;
  readonly drones: Drones;
  readonly bolts: Bolts;
  readonly missiles: Missiles;
  readonly jets: Jets;
  readonly harvesters: Harvesters;
  /** A harvester is charging within CHARGE_NEAR m of us. */
  private charged = false;
  private jetPose: JetPose = jetPose();
  private bound = false;
  private locked = false;
  private charging = new Set<number>();
  private muzzle = new THREE.Vector3();
  private shake = 0;
  private hunted = new Set<number>();
  /** Something is after you: a guardian or crawlers hunting you, a drone's light on you, or a missile coming down. */
  combat = false;
  /** An epic battle: a guardian on the hunt within its cannon's range (FIRE_R). */
  epic = false;
  private crawled = new Set<number>();
  /** A harvester charging within RAM_NEAR m of us. */
  private rammed = false;
  /** Enemies alive last frame and this frame (src/kills.ts keys), to catch the moment one dies. */
  private living = new Set<string>();
  private alive = new Set<string>();
  /** One turned on us: a walker started hunting us, a drone's light locked on, a harvester is charging at us. */
  onAggro: (kind: Aggro) => void = () => {};
  /** One we hit lately (src/kills.ts) just died. */
  onKill: (kind: Kill) => void = () => {};
  private bitAt = 0;
  private ear = new THREE.Vector3();
  private net: Net | null = null;
  /** When we last told the server a foot came down on us (ms). */
  private stompedAt = 0;

  constructor(scene: THREE.Scene) {
    this.guardians = new Guardians(scene);
    this.drones = new Drones(scene);
    this.bolts = new Bolts(scene);
    this.missiles = new Missiles(scene);
    this.jets = new Jets(scene);
    this.harvesters = new Harvesters(scene);
    // A shot into a core: a heavy clang; one shot out: a burst of fire and sparks out of its maw.
    this.harvesters.onHit = (x, y, z) => guardianSound.footfall(x, y, z, 0.8, this.ear);
    this.harvesters.onCoreOut = (x, y, z, dx, dz) => {
      zaps.burst(x, y, z, dx, 0.5, dz, 40, 4);
      for (let i = 0; i < 6; i++) zaps.puff(x + dx * 2, y, z + dz * 2, 3 + Math.random() * 3, 3);
      guardianSound.boom(x, y, z, this.ear);
      rifleSound.firework({ x, y, z }, this.ear, 0.7, MISSILE_FIREWORK_PITCH);
    };
    // The last core: the engine seizes, a blast through the hull, fire and a column of smoke, a shake felt far off.
    this.harvesters.onDeath = (x, y, z) => {
      this.bolts.burst(x, y, z, true);
      zaps.burst(x, y + 4, z, 0, 1, 0, 120, 14);
      zaps.shatter(x, y + 6, z, 0, 1, 0, 9);
      for (let i = 0; i < 24; i++) zaps.puff(x + (Math.random() - 0.5) * 16, y + Math.random() * 10, z + (Math.random() - 0.5) * 24, 8 + Math.random() * 10, 5 + Math.random() * 4);
      guardianSound.boom(x, y, z, this.ear);
      rifleSound.firework({ x, y, z }, this.ear, 1, MISSILE_FIREWORK_PITCH * 0.8);
      rifleSound.slam({ x, y, z }, this.ear, true);
      this.thump(x, y - 8, z, 3, 60, 14, 8);
    };
    // Shot: a heavier bang than a drone's. Down: it hits the sand like a walker's hull, with the burst of a drone's crash.
    this.jets.onHit = (x, y, z) => guardianSound.footfall(x, y, z, 1, this.ear);
    // A jammed drone just settles.
    this.drones.onLand = (x, y, z) => rifleSound.slam({ x, y, z }, this.ear, false);
    // Nose first into the sand (shot or jammed): a fireball, a spray of sparks and torn panels thrown on the way it
    // was going, a ring of dust and a big shake, a bang and a slam.
    this.jets.onCrash = (x, y, z, dx, dy, dz) => {
      this.bolts.burst(x, y, z, true);
      zaps.burst(x, y + 1, z, dx * 0.6, 0.8, dz * 0.6, 90, 10);
      zaps.shatter(x, y + 1.5, z, dx * 0.8, 0.6 - dy * 0.3, dz * 0.8, 6);
      for (let i = 0; i < 16; i++) zaps.puff(x + (Math.random() - 0.5) * 12, y + Math.random() * 6, z + (Math.random() - 0.5) * 12, 8 + Math.random() * 8, 5 + Math.random() * 4);
      this.thump(x, y, z, 0, 40, 22, 7);
      guardianSound.boom(x, y, z, this.ear);
      rifleSound.firework({ x, y, z }, this.ear, 1, MISSILE_FIREWORK_PITCH);
      rifleSound.slam({ x, y, z }, this.ear, true);
      this.thump(x, y, z, 3, 48, 12, 5);
    };
    // A piece of the broken plane hitting the sand: a thud and sand thrown up, by its size.
    this.jets.onSplash = (x, y, z, size) => {
      this.thump(x, y, z, 0.3 + size * 0.25, 6 + Math.round(size * 5), 3 + size * 1.5, 2 + size);
      rifleSound.slam({ x, y, z }, this.ear, size > 2.5);
    };
    this.guardians.onFootfall = (f) => this.footfall(f);
    // A shot hitting a drone: a lighter bang than its crash (each one counts, so no firework like a weak point's).
    this.drones.onHit = (x, y, z) => guardianSound.footfall(x, y, z, 0.7, this.ear);
    // A shot-down drone hitting the sand: a softer firework than a weak point's, and a clatter.
    this.drones.onCrash = (x, y, z) => {
      rifleSound.firework({ x, y, z }, this.ear, DRONE_FIREWORK);
      rifleSound.slam({ x, y, z }, this.ear, false);
      this.thump(x, y, z, 0.6, 0, 0, 0);
    };
    this.guardians.onEvent = (e) => {
      // A weak point shattered (whoever shot it), a dying walker's leg gave out, its hull hit the sand.
      const heavy = e.kind === GUARDIAN;
      if (e.what === 'break') {
        rifleSound.impact('glass', e, this.ear);
        rifleSound.firework(e, this.ear, heavy ? 1 : CRAWLER_FIREWORK);
      }
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
    // Came down on us: crushed (the server checks it; the feet are only animated here).
    const me = this.net?.me;
    const r = FOOT_CRUSH_R * KINDS[GUARDIAN].scale;
    if (me && Math.hypot(me.x - f.x, me.z - f.z) < r && Math.abs(me.y - f.y) < r && performance.now() - this.stompedAt > 1000) {
      this.stompedAt = performance.now();
      this.net!.stomped(f.id);
    }
    guardianSound.footfall(f.x, f.y, f.z, f.weight, this.ear);
    this.thump(f.x, f.y, f.z, f.weight, 9, 2.5 * KINDS[GUARDIAN].scale, 1.6 * KINDS[GUARDIAN].scale);
  }

  /** The jets where the sound reaching the ear now left them: the time te with te = now − distance(te) / c, found
   *  by a few fixed-point steps (they fly well under the speed of sound, so it settles fast). */
  private heardJets(net: Net) {
    const now = net.serverTime(), p = this.jetPose, e = this.ear, out = [];
    for (const j of net.jets) {
      let te = now, ok = false;
      for (let i = 0; i < 4; i++) {
        if (!(ok = jetAt(j, te, p))) break;
        te = now - (Math.hypot(p.x - e.x, p.y - e.y, p.z - e.z) / SPEED_OF_SOUND) * 1000;
      }
      if (ok && jetAt(j, te, p) && p.state === 0) out.push({ id: j.id, kind: j.kind, x: p.x, y: p.y, z: p.z, vx: p.vx, vz: p.vz });
    }
    return out;
  }

  /** Enemy `key` seen this frame, dead or alive: tells onKill if it just died and we had a hand in it. */
  private seen(key: string, dead: boolean, kind: Kill) {
    if (!dead) this.alive.add(key);
    else if (this.living.has(key) && claim(key)) this.onKill(kind);
  }

  /** Shake the camera this much (m) at least, from now. */
  jolt(amount: number) {
    this.shake = Math.max(this.shake, amount);
  }

  /** Shake and dust for something heavy at (x, y, z). */
  thump(x: number, y: number, z: number, weight: number, puffs: number, speed: number, size: number) {
    const d = Math.hypot(x - this.ear.x, z - this.ear.z);
    if (d < SHAKE_R) this.shake = Math.max(this.shake, SHAKE * weight * (1 - d / SHAKE_R) ** 2);
    if (d < DUST_R) {
      for (let i = 0; i < puffs; i++) {
        const a = (i / puffs) * Math.PI * 2 + Math.random() * 0.5, v = speed + Math.random() * speed;
        tyreDust.emit(x + Math.cos(a) * 1.2, y + 0.3, z + Math.sin(a) * 1.2, Math.cos(a) * v, 0.6 + Math.random() * speed * 0.5, Math.sin(a) * v, size);
      }
    }
  }

  /** The harvesters: drawn and heard; near one the ground trembles under it, more as it charges. */
  private updateHarvesters(net: Net, dt: number) {
    this.harvesters.update(net.harvesters, net.serverTime(), this.ear, dt);
    let nearest: { id: number; x: number; y: number; z: number; v: number; cores: number } | null = null, best = Infinity;
    const rammed = this.rammed;
    this.charged = this.rammed = false;
    for (const b of this.harvesters.bodies()) {
      const d = Math.hypot(b.x - this.ear.x, b.z - this.ear.z);
      if (b.alive && d < best) (best = d), (nearest = b);
      if (b.alive && b.v > SPEED * 1.5 && d < CHARGE_NEAR) this.charged = true;
      if (b.alive && b.v > SPEED * 1.5 && d < RAM_NEAR) this.rammed = true;
      this.seen(`h${b.id}`, !b.alive, 'harvester');
    }
    if (this.rammed && !rammed) this.onAggro('harvester');
    harvesterSound.update(nearest, this.ear);
    const v = nearest ? nearest.v / SPEED : 1;
    if (best < TREMBLE_R) this.shake = Math.max(this.shake, 0.06 * Math.min(4, v) * (1 - best / TREMBLE_R));
  }

  /** Every frame, after the camera has been placed: draws them and shakes the camera. */
  update(net: Net, dt: number, camera: THREE.Camera, focus: { x: number; z: number }) {
    this.net = net;
    this.ear.copy(camera.position);
    if (!this.bound) {
      this.bound = true;
      // A bolt that killed us comes late after a stall: we fall when it gets here on screen (src/net.ts).
      net.holdDeath = (id) => this.bolts.flying(id);
      this.bolts.onBurst = (id, x, y, z, ground) => {
        guardianSound.boom(x, y, z, this.ear);
        if (ground) this.thump(x, y, z, 2.6, 30, 7, 3.4);
        net.boltArrived(id);
      };
      net.onBolt = (m) => {
        if (m.t === 'shot') {
          const muzzle = this.guardians.fire(m.g, this.muzzle);
          this.bolts.fire(m, muzzle);
          const at = muzzle ?? this.muzzle.set(m.x, m.y, m.z);
          rifleSound.cannon(at, this.ear);
        } else if (m.t === 'boom') {
          this.bolts.boom(m.id, m.x, m.y, m.z, m.ground);
        } else if (m.t === 'missile') {
          this.missiles.launch(m);
        } else {
          this.missiles.land(m.id);
          this.bolts.burst(m.x, m.y, m.z, true);
          guardianSound.boom(m.x, m.y, m.z, this.ear);
          rifleSound.firework(m, this.ear, MISSILE_FIREWORK, MISSILE_FIREWORK_PITCH);
          this.thump(m.x, m.y, m.z, 2.6, 30, 7, 3.4);
        }
      };
    }
    this.bolts.update(dt, net.serverTime());
    this.missiles.update(dt, net.serverTime());
    guardianSound.missiles(this.missiles.heads(net.serverTime()), this.ear);
    this.jets.update(net.jets, net.serverTime(), this.ear, dt);
    for (const j of net.jets) this.seen(`j${j.id}`, !!j.down && net.serverTime() >= j.down.at, 'jet');
    guardianSound.jets(this.heardJets(net), this.ear);
    this.updateHarvesters(net, dt);
    const t = net.serverTime() - BOT_DELAY_MS;
    const gs = guardiansAt(net.bots, t);
    const ds = dronesAt(net.bots, t);
    this.epic = gs.some((g) => g.kind === GUARDIAN && !g.dead && g.hunt > 0 && Math.hypot(g.x - focus.x, g.z - focus.z) < FIRE_R);
    this.guardians.update(gs, dt, focus);
    this.drones.update(ds, dt, focus, net.storms, t);
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
        if (g.hunt === 2 && !this.crawled.has(g.id)) {
          guardianSound.chitter(g.x, camera.position.y - 1, g.z, false);
          if (!this.crawled.size) this.onAggro('crawler');
        }
        if (g.hunt === 2 && d < KINDS[CRAWLER].reach + 0.8 && performance.now() - this.bitAt > 1000) {
          this.bitAt = performance.now();
          guardianSound.chitter(g.x, camera.position.y - 1, g.z, true);
          this.shake = Math.max(this.shake, BITE_SHAKE);
        }
        if (g.hunt === 2) this.crawled.add(g.id);
        else this.crawled.delete(g.id);
        continue;
      }
      if (g.hunt === 2 && !this.hunted.has(g.id)) {
        guardianSound.horn(g.x, camera.position.y + 12, g.z);
        this.onAggro('guardian');
      }
      if (g.hunt === 2) this.hunted.add(g.id);
      else this.hunted.delete(g.id);
    }
    for (const id of this.crawled) if (!gs.some((g) => g.id === id)) this.crawled.delete(id);
    for (const id of this.hunted) if (!gs.some((g) => g.id === id)) this.hunted.delete(id);
    const spotted = ds.some((d) => d.lock === 2);
    if (spotted && !this.locked) {
      guardianSound.chirp();
      this.onAggro('drone');
    }
    for (const g of gs) this.seen(`g${g.id}`, g.dead > 0, g.kind === CRAWLER ? 'crawler' : 'guardian');
    for (const d of ds) this.seen(`d${d.id}`, d.down > 0, 'drone');
    [this.living, this.alive] = [this.alive, this.living];
    this.alive.clear();
    this.locked = spotted;
    const incoming = this.missiles.incoming(focus.x, focus.z, 30, net.serverTime()).length > 0;
    this.combat = incoming || spotted || this.hunted.size > 0 || this.crawled.size > 0 || this.charged;
    if (this.shake > 0.001) {
      const s = this.shake;
      camera.position.x += (Math.random() - 0.5) * s;
      camera.position.y += (Math.random() - 0.5) * s;
      camera.position.z += (Math.random() - 0.5) * s;
      this.shake *= Math.exp(-dt * 7);
    }
  }
}
