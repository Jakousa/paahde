// The bosses on the client (shared/bosses.ts): interpolates the server's 'bosses' messages, gives each boss its
// kind's view (src/world/<kind>.ts, built on src/world/bossParts.ts), and does what all of them share: the weak
// points (shattering, smoking, the rifle's hit test, raycast), the bang when one dies, and the server's one-offs
// ('bossFx') handed to the view.
import * as THREE from 'three/webgpu';
import { MINION, type BossKind, type BossSnap } from '../shared/bosses.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { heightAt } from '../shared/terrain.ts';
import { brokenLensMat, lensMat, type BossCtx, type BossView } from './world/bossParts';
import { BOT_DELAY_MS } from './world/botFrames';
import { CarrierView } from './world/carrier';
import { ColossusView } from './world/colossus';
import { QueenView } from './world/queen';
import { WormView } from './world/worm';
import { zaps } from './world/zaps';
import { rifleSound } from './rifleSound';
import type { Net } from './net';

type BossesMsg = Extract<ServerMsg, { t: 'bosses' }>;

const VIEWS: Record<BossKind, (scene: THREE.Scene) => BossView> = {
  worm: (s) => new WormView(s),
  carrier: (s) => new CarrierView(s),
  colossus: (s) => new ColossusView(s),
  queen: (s) => new QueenView(s),
};

/** Smoke puffs per second out of a broken weak point. */
const SMOKE_RATE = 6;
/** The health bar shows the nearest live boss within this (m). */
const BAR_R = 700;
/** A boss casts sun shadows only this close (m) to the camera. Each casting part is drawn again into every shadow
 *  cascade it reaches (four, out to 1600 m: src/world/sky.ts), and a far boss reaches the big ones: four bosses in
 *  view were ~600 extra draw calls a frame. Past this its shadow would only land in the coarse outer cascade. */
const SHADOW_R = 350;
/** Re-check the parts for new meshes (a model that finished loading) this often (frames). */
const SHADOW_RECHECK = 60;
/** A shot weak point stays broken here this long (ms) waiting for the server to agree. */
const PREDICT_MS = 1500;

type Shown = { view: BossView; kind: BossKind; shown: number; predicted: Map<number, number>; smoke: number[]; dead: boolean; shadows: boolean; frames: number };

/** What a shot struck: weak point `index` of boss `boss` (-1: just its metal). */
export type BossHit = { boss: number; index: number; dist: number; point: THREE.Vector3; normal: THREE.Vector3 };

const lerpAngle = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const _w = new THREE.Vector3(), _n = new THREE.Vector3(), _s = new THREE.Vector3();

export class BossFx {
  private shown = new Map<number, Shown>();
  private scene: THREE.Scene;
  private ctx: BossCtx;
  /** Something is after us: a boss within FIGHT_R. */
  combat = false;
  /** The nearest live boss within BAR_R, for the health bar (src/bossBar.ts); null if none. */
  bar: { kind: BossKind; hp: number } | null = null;

  constructor(scene: THREE.Scene, thump: BossCtx['thump'], shake: BossCtx['shake']) {
    this.scene = scene;
    this.ctx = { scene, ear: new THREE.Vector3(), me: null, time: 0, dt: 0, thump, shake };
    bossFx = this;
  }

  /** Every frame, after the camera has been placed. */
  update(net: Net, dt: number, camera: THREE.Camera) {
    const c = this.ctx;
    c.ear.copy(camera.position);
    c.me = net.me ? { x: net.me.x, y: net.me.y, z: net.me.z } : null;
    c.dt = dt;
    c.time = net.serverTime() - BOT_DELAY_MS;
    for (const m of net.bossFx.splice(0)) this.shown.get(m.id)?.view.fx?.(m, c);
    const snaps = this.at(net.bosses, c.time);
    const seen = new Set<number>();
    let near = false, barD = BAR_R;
    this.bar = null;
    for (const s of snaps) {
      seen.add(s.id);
      let v = this.shown.get(s.id);
      if (!v) {
        const view = VIEWS[s.k](this.scene);
        this.shown.set(s.id, (v = { view, kind: s.k, shown: 0, predicted: new Map(), smoke: view.points.map(() => Math.random()), dead: s.dead > 0, shadows: true, frames: 0 }));
        this.setBroken(v, s.br, true);
      }
      v.view.update(s, c);
      this.shadows(v, Math.hypot(s.x - c.ear.x, s.z - c.ear.z) < SHADOW_R);
      this.syncBroken(v, s.br);
      this.smoulder(v, dt);
      if (s.dead > 0 && !v.dead) rifleSound.firework(s, c.ear, 1.4, 0.6);
      v.dead = s.dead > 0;
      const d = c.me ? Math.hypot(s.x - c.me.x, s.z - c.me.z) : Infinity;
      if (!v.dead && d < 250) near = true;
      if (!v.dead && d < barD) {
        barD = d;
        this.bar = { kind: s.k, hp: s.hp };
      }
    }
    this.combat = near;
    for (const [id, v] of this.shown) {
      if (seen.has(id)) continue;
      v.view.dispose();
      this.shown.delete(id);
    }
  }

  /** Shadows on or off for a boss's parts (the ones its view made casters: remembered on first sight). */
  private shadows(v: Shown, on: boolean) {
    if (on === v.shadows && ++v.frames % SHADOW_RECHECK) return;
    v.shadows = on;
    v.view.root.traverse((o) => {
      if (o.userData.casts === undefined) o.userData.casts = o.castShadow;
      o.castShadow = on && o.userData.casts;
    });
  }

  /** The bosses at server time `t`, between the two messages around it. */
  private at(msgs: readonly BossesMsg[], t: number): BossSnap[] {
    if (!msgs.length) return [];
    let a = msgs[0], b = msgs[0], f = 0;
    for (let i = msgs.length - 1; i > 0; i--) {
      if (msgs[i - 1].time <= t) {
        a = msgs[i - 1];
        b = msgs[i];
        f = Math.min(1, Math.max(0, (t - a.time) / Math.max(1, b.time - a.time)));
        break;
      }
    }
    return b.b.map((nb) => {
      const na = a.b.find((o) => o.id === nb.id);
      if (!na || na === nb) return nb;
      const lerp = (p: number, q: number) => p + (q - p) * f;
      const snapS = this.shown.get(nb.id)?.view.snapS || na.s.length !== nb.s.length;
      return {
        ...nb, x: lerp(na.x, nb.x), y: lerp(na.y, nb.y), z: lerp(na.z, nb.z), yaw: lerpAngle(na.yaw, nb.yaw, f), br: f < 0.5 ? na.br | nb.br : nb.br,
        dead: nb.dead > 0 && na.dead > 0 ? lerp(na.dead, nb.dead) : nb.dead, s: snapS ? nb.s : nb.s.map((v, i) => lerp(na.s[i], v)),
      };
    });
  }

  /** Server mask plus our own unconfirmed breaks. */
  private syncBroken(v: Shown, server: number) {
    let mask = server;
    const now = performance.now();
    for (const [i, at] of v.predicted) {
      if (server & (1 << i) || now - at > PREDICT_MS) v.predicted.delete(i);
      else mask |= 1 << i;
    }
    if (mask !== v.shown) this.setBroken(v, mask, false);
  }

  /** Show weak points by mask; newly broken ones shatter (unless `quiet`: already broken when it came into view). */
  private setBroken(v: Shown, mask: number, quiet: boolean) {
    v.view.points.forEach((p, i) => {
      const was = (v.shown & (1 << i)) !== 0, b = (mask & (1 << i)) !== 0;
      if (was === b && !quiet) return;
      const lens = p.getObjectByName('lens') as THREE.Mesh | undefined;
      if (lens) {
        lens.material = b ? brokenLensMat : lensMat;
        lens.scale.setScalar(b ? 0.7 : 1);
      }
      if (!b || quiet || was) return;
      p.getWorldPosition(_w);
      p.getWorldScale(_s);
      _n.set(0, 0, 1).transformDirection(p.matrixWorld);
      zaps.shatter(_w.x, _w.y, _w.z, _n.x, _n.y, _n.z, _s.x);
      rifleSound.impact('glass', _w, this.ctx.ear);
      rifleSound.firework(_w, this.ctx.ear, 1);
    });
    v.shown = mask;
  }

  private smoulder(v: Shown, dt: number) {
    v.view.points.forEach((p, i) => {
      if (!(v.shown & (1 << i))) return;
      v.smoke[i] += dt * SMOKE_RATE;
      if (v.smoke[i] < 1) return;
      v.smoke[i] -= 1;
      p.getWorldPosition(_w);
      p.getWorldScale(_s);
      if (_w.y < heightAt(_w.x, _w.z)) return;
      zaps.puff(_w.x, _w.y, _w.z, Math.max(0.6, _s.x * 1.6), 3);
      if (Math.random() < 0.08) zaps.burst(_w.x, _w.y, _w.z, 0, 1, 0, 4, 2);
    });
  }

  /** Where the shot from `o` along unit `d` first strikes a boss within `max` m: a whole weak point (padded a
   *  little; in view and out of the sand), else its metal. */
  raycast(o: THREE.Vector3, d: THREE.Vector3, max: number): BossHit | null {
    let best: BossHit | null = null;
    for (const [id, v] of this.shown) {
      if (v.dead) continue;
      const metal = v.view.hull?.(o, d, max) ?? null;
      let lens: BossHit | null = null;
      v.view.points.forEach((p, i) => {
        if (v.shown & (1 << i) || !visible(p)) return;
        p.getWorldPosition(_w);
        p.getWorldScale(_s);
        if (_w.y + _s.x * 0.3 < heightAt(_w.x, _w.z)) return;
        const r = _s.x * 1.3;
        const along = (_w.x - o.x) * d.x + (_w.y - o.y) * d.y + (_w.z - o.z) * d.z;
        if (along < 0 || along > max) return;
        const miss2 = o.distanceToSquared(_w) - along * along;
        if (miss2 > r * r) return;
        const dist = Math.max(0, along - Math.sqrt(r * r - miss2));
        // A lens sits in the metal: it counts if it's not far behind where the ray first meets the hull.
        if (metal !== null && dist > metal + r * 2) return;
        if (lens && dist >= lens.dist) return;
        const point = o.clone().addScaledVector(d, dist);
        lens = { boss: id, index: i, dist, point, normal: point.clone().sub(_w).normalize() };
      });
      let hit: BossHit | null = lens ?? (metal !== null ? { boss: id, index: -1, dist: metal, point: o.clone().addScaledVector(d, metal), normal: d.clone().negate() } : null);
      const m = v.view.minion?.(o, d, hit ? hit.dist : max) ?? null;
      if (m) hit = { boss: id, index: MINION + m.index, dist: m.dist, point: o.clone().addScaledVector(d, m.dist), normal: d.clone().negate() };
      if (hit && (!best || hit.dist < best.dist)) best = hit;
    }
    return best;
  }

  /** Weak point `i` of boss `id` shot here and now (the server hears of it; if it never agrees, it comes back). */
  breakLocal(id: number, i: number) {
    const v = this.shown.get(id);
    if (!v || i >= MINION) return;
    v.predicted.set(i, performance.now());
    this.setBroken(v, v.shown | (1 << i), false);
  }
}

/** The one BossFx (src/main.ts makes it), for the rifle (src/rifle.ts). */
export let bossFx: BossFx | null = null;

function visible(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
