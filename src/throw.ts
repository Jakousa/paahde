// Throwing scrap (shared/throw.ts): with a piece of junk taken out from the hotbar, left mouse / E throws it where
// you look, on an arc you learn to aim above. The hand winds up first (ScrapThrow, src/viewmodel.ts, from
// `playerHands.throwAt`) and lets go RELEASE_MS after the press, where you look then. From there it flies on our guess of the server's path; the
// server takes it out of the bag, flies it (server/throws.ts) and tells everyone near ('toss'). Others' throws show
// from there. Off a drone it bounces with a clank and sparks; on the sand it thumps down and lies there as loot.
import * as THREE from 'three/webgpu';
import type { FirstPersonCamera } from './camera';
import { tools, useHeld } from './input';
import { playerHands } from './water';
import type { Net } from './net';
import { rifleSound } from './rifleSound';
import { tyreDust } from './tyreDust';
import { zaps } from './world/zaps';
import type { Scrap } from './world/scrap';
import { inBase } from '../shared/base.ts';
import { SCRAP_KINDS } from '../shared/scrap.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { heightAt } from '../shared/terrain.ts';
import { THROW_MS, THROWABLE, THROW_SPEED, tossAt, type TossPath } from '../shared/throw.ts';

/** From the press to letting go (ms): the wind-up of the hands' ScrapThrow (0.5 s, let go at 0.42). */
const RELEASE_MS = 210;
/** It leaves the hand here (eye frame: right, up, forward, m; where the hands let go) and eases onto the true arc
 *  over HAND_S. */
const HAND = new THREE.Vector3(0.06, 0.04, 0.25);
/** A pile piece flown when the hands' scrap model isn't there is shrunk to about this size (m across). */
const PIECE_M = 0.25;
const HAND_S = 0.18;
/** Lying on the sand waiting for the server's word this long (ms) at most. */
const LAND_WAIT_MS = 1500;

type Toss = {
  /** Server id (0: ours, not answered yet), our count for our own. */
  id: number; n: number; mine: boolean;
  path: TossPath; mesh: THREE.Object3D | null;
  /** Where it was drawn off its arc at launch (eases to 0), its spin axis and rate (rad/s). */
  off: THREE.Vector3; axis: THREE.Vector3; spin: number;
  /** When it reached the sand on our guess (performance.now(), 0 still flying). */
  landedAt: number;
};

const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _q = new THREE.Quaternion(), _p = { x: 0, y: 0, z: 0 };
const _spin = new THREE.Quaternion();

export class Thrower {
  private view: FirstPersonCamera;
  private net: Net;
  private scrap: Scrap;
  private root = new THREE.Group();
  private tosses: Toss[] = [];
  private wasUse = false;
  private readyAt = 0;
  private releaseAt = 0;
  private count = 0;
  /** The piece in flight: the one drawn in the hands (src/viewmodel.ts scrapPiece), null until it has loaded. */
  piece: (() => THREE.Object3D | null) | null = null;

  constructor(scene: THREE.Scene, view: FirstPersonCamera, net: Net, scrap: Scrap) {
    this.view = view;
    this.net = net;
    this.scrap = scrap;
    scene.add(this.root);
    net.onToss = (m) => this.onToss(m);
  }

  /** The junk in hand (selected hotbar slot), or null. */
  private inHand(): string | null {
    const kind = this.net.boxes.bag?.[tools.slot]?.kind;
    return kind && THROWABLE.has(kind) ? kind : null;
  }

  /** Every frame, after the camera is placed. `can`: free to throw (not riding, dead or busy). */
  update(dt: number, can: boolean) {
    const kind = this.inHand();
    const use = !!kind && can && useHeld() && !!document.pointerLockElement;
    const now = performance.now();
    const out = !inBase(this.net.me.x, this.net.me.y, this.net.me.z);
    if (use && !this.wasUse && now >= this.readyAt && out) {
      // Wind up: the throw itself goes at the release.
      this.readyAt = now + THROW_MS;
      this.releaseAt = now + RELEASE_MS;
      playerHands.throwAt = now;
    }
    if (this.releaseAt && now >= this.releaseAt) {
      this.releaseAt = 0;
      if (kind && can && out) this.toss();
    }
    this.wasUse = use;
    this.draw(dt);
  }

  private toss() {
    const cam = this.view.camera;
    _o.copy(this.view.eye);
    cam.getWorldQuaternion(_q);
    _d.set(0, 0, -1).applyQuaternion(_q);
    const n = ++this.count;
    const path: TossPath = { time: this.net.serverTime(), x: _o.x, y: _o.y, z: _o.z, vx: _d.x * THROW_SPEED, vy: _d.y * THROW_SPEED, vz: _d.z * THROW_SPEED };
    const t = this.add(0, n, true, path);
    t.off.set(HAND.x, HAND.y, -HAND.z).applyQuaternion(_q);
    this.net.throwScrap(tools.slot, n, _o.x, _o.y, _o.z, _d.x, _d.y, _d.z);
    rifleSound.swish();
  }

  private add(id: number, n: number, mine: boolean, path: TossPath): Toss {
    // Scrap is all one item: it flies as the piece drawn in the hands, or (not loaded yet) one of the scrap piles'
    // pieces picked by the thrower's count, shrunk to a handful.
    let mesh = this.piece?.() ?? null;
    if (!mesh) {
      const m = this.scrap.mesh(n % SCRAP_KINDS.filter((k) => !k.item).length);
      if (m) {
        m.geometry.computeBoundingSphere();
        m.scale.setScalar(Math.min(1, PIECE_M / 2 / (m.geometry.boundingSphere?.radius || 1)));
      }
      mesh = m;
    }
    if (mesh) this.root.add(mesh);
    const axis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    const t: Toss = { id, n, mine, path, mesh, off: new THREE.Vector3(), axis, spin: 6 + Math.random() * 8, landedAt: 0 };
    this.tosses.push(t);
    return t;
  }

  private remove(t: Toss) {
    if (t.mesh) this.root.remove(t.mesh);
    this.tosses.splice(this.tosses.indexOf(t), 1);
  }

  private onToss(m: Extract<ServerMsg, { t: 'toss' | 'tossEnd' }>) {
    const ear = this.view.camera.position;
    let t = this.tosses.find((o) => o.id === m.id);
    if (m.t === 'tossEnd') {
      if (t) this.remove(t);
      _o.set(m.x, m.y, m.z);
      rifleSound.impact('sand', _o, ear);
      for (let i = 0; i < 4; i++) tyreDust.emit(m.x, m.y + 0.1, m.z, (Math.random() - 0.5) * 2, 0.8 + Math.random(), (Math.random() - 0.5) * 2, 0.45);
      return;
    }
    // Our own throw answered: keep flying it on our path (the server's starts a little later), just learn its id.
    if (!t && m.by === this.net.id && !m.hit) t = this.tosses.find((o) => o.mine && o.n === m.n && !o.id);
    if (t && !m.hit) {
      t.id = m.id;
      return;
    }
    const path: TossPath = { time: m.time, x: m.x, y: m.y, z: m.z, vx: m.vx, vy: m.vy, vz: m.vz };
    if (!t) {
      t = this.add(m.id, m.n, false, path);
      if (!m.hit) rifleSound.swish(_o.set(m.x, m.y, m.z), ear);
    }
    if (!m.hit) return;
    // Off a drone: from here on the server's path, with a clank and sparks.
    t.path = path;
    t.off.set(0, 0, 0);
    t.landedAt = 0;
    _o.set(m.x, m.y, m.z);
    rifleSound.clank(_o, ear);
    _d.set(m.vx, m.vy, m.vz).normalize();
    zaps.burst(m.x, m.y, m.z, _d.x, _d.y, _d.z, 14);
  }

  private draw(dt: number) {
    const now = this.net.serverTime(), wall = performance.now();
    for (const t of [...this.tosses]) {
      if (t.landedAt && wall - t.landedAt > LAND_WAIT_MS) {
        this.remove(t);
        continue;
      }
      const s = Math.max(0, (now - t.path.time) / 1000);
      tossAt(t.path, s, _p);
      const ease = Math.max(0, 1 - s / HAND_S);
      _o.set(_p.x, _p.y, _p.z).addScaledVector(t.off, ease * ease);
      const ground = heightAt(_o.x, _o.z);
      if (_o.y <= ground) {
        _o.y = ground + 0.1;
        if (!t.landedAt) t.landedAt = wall;
      }
      if (!t.mesh) continue;
      t.mesh.position.copy(_o);
      if (!t.landedAt) t.mesh.quaternion.multiply(_spin.setFromAxisAngle(t.axis, t.spin * dt));
    }
  }
}
