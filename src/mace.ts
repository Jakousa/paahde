// The scrap mace (shared/mace.ts): with it out from the hotbar, left mouse / E swings it. The hands wind up first
// (src/viewmodel.ts, from `playerHands.swingAt`) and the blow lands MACE_STRIKE_MS after the press, where you look
// then: tested against the walkers as drawn (src/world/guardians.ts raycast, a few rays fanned about the view so a
// crawler at your feet still counts) and the sand, within MACE_REACH of the eye. A crawler struck loses the lens
// nearest the blow at once (shattered here, the server agreeing or not); a guardian's leg only clangs. The server
// checks it (server/world.ts onSwing) and shows the blow to everyone near ('swing'): a clank on metal, a thump on sand.
import * as THREE from 'three/webgpu';
import type { FirstPersonCamera } from './camera';
import { tools, useHeld } from './input';
import { playerHands } from './water';
import type { Net } from './net';
import { rifleSound } from './rifleSound';
import { rumble } from './gamepad';
import { tyreDust } from './tyreDust';
import { zaps } from './world/zaps';
import type { Guardians } from './world/guardians';
import { heightAt } from '../shared/terrain.ts';
import { MACE, MACE_MS, MACE_REACH, MACE_STRIKE_MS } from '../shared/mace.ts';
import type { ServerMsg } from '../shared/protocol.ts';

/** The rays a blow is tested along (yaw, pitch off the view, rad): the middle first, then about it. */
const FAN: [number, number][] = [[0, 0], [0.12, 0], [-0.12, 0], [0, -0.14], [0, 0.1], [0.1, -0.12], [-0.1, -0.12]];
/** Steps (m) the blow is marched along the view to find the sand. */
const SAND_STEP = 0.1;

const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3(), _q = new THREE.Quaternion();
const _r = new THREE.Euler(0, 0, 0, 'YXZ'), _rq = new THREE.Quaternion();

export class Mace {
  private view: FirstPersonCamera;
  private net: Net;
  private guardians: Guardians;
  private wasUse = false;
  private readyAt = 0;
  private strikeAt = 0;

  constructor(view: FirstPersonCamera, net: Net, guardians: Guardians) {
    this.view = view;
    this.net = net;
    this.guardians = guardians;
    net.onSwing = (m) => this.onSwing(m);
  }

  /** Every frame, after the camera is placed and the walkers drawn. `can`: free to swing (not riding, dead or busy). */
  update(can: boolean) {
    const held = this.net.boxes.bag?.[tools.slot]?.kind === MACE;
    const use = held && can && useHeld() && !!document.pointerLockElement;
    const now = performance.now();
    if (use && !this.wasUse && now >= this.readyAt) {
      // Wind up: the blow lands at the strike.
      this.readyAt = now + MACE_MS;
      this.strikeAt = now + MACE_STRIKE_MS;
      playerHands.swingAt = now;
      rifleSound.swish();
    }
    if (this.strikeAt && now >= this.strikeAt) {
      this.strikeAt = 0;
      if (held && can) this.strike();
    }
    this.wasUse = use;
  }

  private strike() {
    _o.copy(this.view.eye);
    this.view.camera.getWorldQuaternion(_q);
    // The nearest walker along any of the fan's rays.
    let hit: ReturnType<Guardians['raycast']> = null;
    for (const [yaw, pitch] of FAN) {
      _d.set(0, 0, -1).applyQuaternion(_rq.setFromEuler(_r.set(pitch, yaw, 0))).applyQuaternion(_q);
      const h = this.guardians.raycast(_o, _d, hit?.dist ?? MACE_REACH);
      if (h) hit = h;
      if (hit && yaw === 0 && pitch === 0) break; // straight ahead wins
    }
    const ear = this.view.camera.position;
    if (hit) {
      const i = hit.index >= 0 ? hit.index : this.guardians.smashPoint(hit.walker, hit.point);
      if (i >= 0) this.guardians.breakLocal(hit.walker, i);
      _e.copy(hit.point);
      rifleSound.clank(_e, ear);
      zaps.burst(_e.x, _e.y, _e.z, hit.normal.x, hit.normal.y, hit.normal.z, 12);
      rumble(0.8, 0.5, 120);
      this.net.swing(_e.x, _e.y, _e.z, { g: hit.walker, i });
      return;
    }
    // Else the sand, if it's in reach straight ahead, or the air at the end of the reach.
    _d.set(0, 0, -1).applyQuaternion(_q);
    let sand = false;
    for (let t = SAND_STEP; t <= MACE_REACH; t += SAND_STEP) {
      _e.copy(_o).addScaledVector(_d, t);
      if (_e.y <= heightAt(_e.x, _e.z)) {
        sand = true;
        break;
      }
    }
    if (sand) this.thump(_e, ear);
    this.net.swing(_e.x, _e.y, _e.z);
  }

  /** A blow on the sand: a thump and a spray of it. */
  private thump(at: THREE.Vector3, ear: THREE.Vector3) {
    rifleSound.impact('sand', at, ear);
    for (let i = 0; i < 5; i++) tyreDust.emit(at.x, at.y + 0.05, at.z, (Math.random() - 0.5) * 2, 0.8 + Math.random(), (Math.random() - 0.5) * 2, 0.4);
  }

  /** Someone else's blow: a whoosh, and a clank on a walker or a thump on the sand. */
  private onSwing(m: Extract<ServerMsg, { t: 'swing' }>) {
    const ear = this.view.camera.position;
    _e.set(m.x, m.y, m.z);
    rifleSound.swish(_e, ear);
    if (m.hit) {
      rifleSound.clank(_e, ear);
      zaps.burst(m.x, m.y, m.z, 0, 1, 0, 10);
    } else if (m.y <= heightAt(m.x, m.z) + 0.15) this.thump(_e, ear);
  }
}
