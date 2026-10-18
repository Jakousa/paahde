// The laser rifle in your hands (shared/rifle.ts): aiming, the shot, and the feel of it. The laser pistol works the same
// way with its own feel (FEEL): no scope, aimed it comes up at arm's length onto the iron sights (src/viewmodel.ts
// PistolAim) with a slight zoom; it sways more (one hand), spreads more from the hip and kicks harder, but recharges
// faster; and it reaches only PISTOL_RANGE.
//
// - Aim: right mouse or X raises it to the eye (src/viewmodel.ts plays RifleAim); once it is there the view goes
//   through the scope: a round eyepiece with a duplex reticle and a lit red dot, ZOOM× (the mouse wheel sets it). Let
//   go and it comes down.
// - The aim is never quite still. Through the scope the view drifts with your breathing (a slow rise and fall) and a
//   small figure-of-eight tremor of the arms, with a little noise on top; standing still it settles, walking makes it
//   wander and a sprint leaves you blowing for a few seconds. Shift (standing) holds your breath: steady for a few
//   seconds, then you gasp and it is worse for a moment. The drift moves the camera itself, so the reticle stays in
//   the middle and the world swims under it, and the shot goes where the reticle is. From the hip the shot goes
//   anywhere in a cone around the crosshair (wider on the move).
// - Fire: left mouse or E, one shot per press, then the cell recharges for COOLDOWN_MS. Recoil: the muzzle climbs
//   (part of it stays, so you pull it back down), with a little random sideways kick; the view jolts on a spring, the
//   rifle kicks back into the shoulder (viewmodel), and through the scope the eyepiece shadow jumps.
// - The shot is hitscan from the eye along the aim: the first thing it meets of the sand and the walkers as drawn
//   (src/world/guardians.ts raycast). The beam and sparks show at once (src/world/zaps.ts), a weak point hit shatters
//   at once, and the server is told (Net.fire), checks it, and shows everyone near the beam ('zap').
import * as THREE from 'three/webgpu';
import type { FirstPersonCamera } from './camera';
import { aimDown, breathHeld, tools, useHeld } from './input';
import { playerHands } from './water';
import type { Net } from './net';
import type { Guardians } from './world/guardians';
import type { Drones } from './world/drones';
import type { Jets } from './world/jets';
import { bossFx } from './bosses';
import { zaps } from './world/zaps';
import { rifleSound } from './rifleSound';
import { tyreDust } from './tyreDust';
import { GUNS, PISTOL, RIFLE } from '../shared/rifle.ts';
import { gunCooldown, quality } from '../shared/gear.ts';
import { heightAt, shotGround } from '../shared/terrain.ts';
import { baseSolid } from '../shared/base.ts';
import { shelterSolid } from '../shared/shelters.ts';
import { SPRINT_SPEED, WALK_SPEED } from '../shared/sim.ts';

/** Raising to the eye takes ADS_S; the scope view comes in at the end of it. */
const ADS_S = 0.26;
const ZOOM = 4, ZOOM_MIN = 2.5, ZOOM_MAX = 7;
/** Sway amplitudes (rad) standing still and settled: breathing (vertical), the arms' figure-eight, noise. */
const BREATH = 0.0026, TREMOR = 0.0014, JITTER = 0.0006;
/** Breaths per second, and the figure-eight's rate. */
const BREATH_HZ = 0.24, TREMOR_HZ = 0.55;
/** Hold your breath this long (s), then gasp for GASP_S. */
const HOLD_S = 4, GASP_S = 2.5;
/** Recoil: the share of the muzzle climb that stays. */
const CLIMB_STAYS = 0.35;
/** The recoil spring's longest step (s); stable well past this. */
const SPRING_DT = 1 / 120;

/**
 * How each gun handles. `scope`: aimed, the view goes through a scope; else `sight` is the zoom on the iron sights.
 * `sway`: × the aim's sway. Hip fire lands within a cone of `hip` rad standing, up to `move` more on the move. Recoil:
 * muzzle climb `climb` rad per shot, sideways kick up to `side` rad either way.
 */
const FEEL = {
  rifle: { kind: RIFLE, scope: true, sight: 1, sway: 1, hip: 0.022, move: 0.05, climb: 0.028, side: 0.007 },
  pistol: { kind: PISTOL, scope: false, sight: 1.3, sway: 1.7, hip: 0.035, move: 0.06, climb: 0.045, side: 0.012 },
};
type Gun = keyof typeof FEEL;
const isGun = (h: string): h is Gun => h in FEEL;

const css = `
#rifleScope { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity .08s; z-index: 5; }
#rifleScope svg { position: absolute; left: 50%; top: 50%; width: 150vmax; height: 150vmax; transform: translate(-50%, -50%); display: block; }
#rifleScope .zoom { position: absolute; left: 50%; bottom: 7%; transform: translateX(-50%); font: 600 12px var(--mono); color: #c9d6c0; opacity: 0.65; font-variant-numeric: tabular-nums; }
#rifleScope .cell { position: absolute; left: 50%; bottom: calc(7% + 18px); width: 120px; height: 3px; margin-left: -60px; background: rgba(120, 230, 255, 0.15); }
#rifleScope .cell i { display: block; height: 100%; background: #7fe8ff; transform-origin: left; }
body.rifleScoped #crosshair, body.rifleScoped #pickup { display: none !important; }
#rifleHip { position: fixed; left: 50%; top: 50%; pointer-events: none; z-index: 4; display: none; }
#rifleHip i { position: absolute; background: rgba(255, 244, 228, 0.75); box-shadow: 0 0 2px #000; }
body.rifleHip #rifleHip { display: block; }
body.third-person #rifleHip { display: none; }
body.rifleHip #crosshair { display: none; }
body.gunSights #crosshair { display: none; }
`;

// The scope: everything outside the eyepiece black, a soft edge, a faint green-grey lens tint and vignette, and a
// duplex reticle (heavy posts to thin cross hairs) with mil dots and an illuminated red centre dot. Drawn huge and
// centred, so the shadow can slide around (eye not quite on the axis).
const SCOPE = `<svg viewBox="-1000 -1000 2000 2000">
<defs><filter id="rsBlur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9"/></filter>
<mask id="rsMask"><rect x="-1000" y="-1000" width="2000" height="2000" fill="white"/><circle r="300" fill="black" filter="url(#rsBlur)"/></mask>
<radialGradient id="rsLens"><stop offset="0.55" stop-color="#0c1a14" stop-opacity="0"/><stop offset="0.93" stop-color="#0c1a14" stop-opacity="0.45"/>
<stop offset="1" stop-color="#000" stop-opacity="0.8"/></radialGradient></defs>
<circle r="300" fill="url(#rsLens)"/>
<g class="reticle" stroke="#0a0a08" fill="none">
<path d="M-300 0H-70M70 0H300M0 -300V-70M0 70V300" stroke-width="7"/>
<path d="M-70 0H-6M6 0H70M0 -70V-6M0 6V70" stroke-width="1.6"/>
<g fill="#0a0a08" stroke="none">${[-56, -42, -28, -14, 14, 28, 42, 56].map((v) => `<circle cx="${v}" cy="0" r="1.8"/><circle cx="0" cy="${v}" r="1.8"/>`).join('')}</g>
</g>
<circle r="2.4" fill="#ff2a14"/><circle r="5" fill="#ff2a14" opacity="0.25"/>
<rect x="-1000" y="-1000" width="2000" height="2000" fill="#030302" mask="url(#rsMask)"/></svg>`;

/** Smooth 1D noise: a sum of incommensurate sines, -1..1. */
const wobble = (t: number, seed: number) => (Math.sin(t * 1.31 + seed) * 0.5 + Math.sin(t * 2.97 + seed * 2.1) * 0.3 + Math.sin(t * 5.53 + seed * 3.7) * 0.2);

const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3(), _m = new THREE.Vector3();
const _q = new THREE.Quaternion(), _r = new THREE.Vector3(), _u = new THREE.Vector3();

export class Rifle {
  private view: FirstPersonCamera;
  private net: Net;
  private guardians: Guardians;
  private drones: Drones;
  private jets: Jets;
  /** Where the drawn muzzle is (src/viewmodel.ts), or null. */
  private muzzle: (out: THREE.Vector3) => THREE.Vector3 | null;
  private el = document.createElement('div');
  private svg: SVGSVGElement;
  private zoomEl: HTMLElement;
  private cellEl: HTMLElement;
  private hip = document.createElement('div');
  private zoom = ZOOM;
  private time = 0;
  private wasFire = false;
  private readyAt = 0;
  /** Breath: held for how long (s), gasping until (time). */
  private held = 0;
  private gaspUntil = 0;
  /** Out of breath after running, 0..1. */
  private winded = 0;
  /** How much the aim wanders right now (eased): 1 settled, more on the move. */
  private unsteady = 1;
  /** Where in a breath (rad): stepped by the breathing rate, which quickens when winded. */
  private breath = 0;
  /** The sway and recoil offsets on the view (rad), and the recoil spring's velocity. */
  private swayYaw = 0;
  private swayPitch = 0;
  private recoilPitch = 0;
  private recoilYaw = 0;
  private recoilVP = 0;
  private recoilVY = 0;
  private spread = FEEL.rifle.hip;
  private scoped = false;
  /** The gun in hand (or last in hand). */
  private gun: Gun = 'rifle';
  /** Debug (?debug, `dbg.rifle`): hold the aim / fire buttons without the mouse captured. */
  forceAim = false;
  forceFire = false;
  /** Where player `id`'s drawn gun's muzzle is (world), or null (not drawn, or no gun in hand). */
  remoteMuzzle: (id: number, out: THREE.Vector3) => THREE.Vector3 | null = () => null;

  constructor(view: FirstPersonCamera, net: Net, guardians: Guardians, drones: Drones, jets: Jets, muzzle: (out: THREE.Vector3) => THREE.Vector3 | null) {
    this.drones = drones;
    this.jets = jets;
    this.view = view;
    this.net = net;
    this.guardians = guardians;
    this.muzzle = muzzle;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    this.el.id = 'rifleScope';
    this.el.innerHTML = `${SCOPE}<span class="cell"><i></i></span><span class="zoom"></span>`;
    this.svg = this.el.querySelector('svg')!;
    this.zoomEl = this.el.querySelector('.zoom')!;
    this.cellEl = this.el.querySelector('.cell i')!;
    this.hip.id = 'rifleHip';
    this.hip.innerHTML = '<i></i><i></i><i></i><i></i>';
    document.body.append(this.el, this.hip);
    addEventListener('wheel', (e) => {
      if (!this.scoped) return;
      this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoom * Math.exp(-e.deltaY * 0.0015)));
    }, { passive: true });
    net.onZap = (m) => {
      // Someone else's shot: the beam from their gun's muzzle (or a little ahead of their eye), the sound from there.
      _d.set(m.ex - m.x, m.ey - m.y, m.ez - m.z);
      const len = _d.length();
      if (len < 0.5) return;
      _d.divideScalar(len);
      if (!this.remoteMuzzle(m.by, _o)) _o.set(m.x, m.y - 0.15, m.z).addScaledVector(_d, 0.8);
      const ear = this.view.camera.position;
      zaps.beam(_o.x, _o.y, _o.z, m.ex, m.ey, m.ez, _o.distanceTo(ear) < 60);
      rifleSound.shot(_o, ear, !!m.pistol);
      zaps.burst(m.ex, m.ey, m.ez, -_d.x, -_d.y, -_d.z, 10);
      rifleSound.impact(m.hit ? 'glass' : heightAt(m.ex, m.ez) > m.ey - 0.3 ? 'sand' : 'metal', _e.set(m.ex, m.ey, m.ez), ear);
    };
  }

  /**
   * Before the camera is placed: aim, zoom and sway. `pose`: the player's speed and stance; `can`: free to use it (not
   * riding, dead or busy).
   */
  update(dt: number, pose: { speed: number; grounded: boolean; crouching: boolean }, can: boolean) {
    this.time += dt;
    if (isGun(playerHands.held)) this.gun = playerHands.held;
    const feel = FEEL[this.gun];
    const holding = isGun(playerHands.held) && can;
    const aiming = holding && ((aimDown() && !!document.pointerLockElement) || this.forceAim);
    // The jammer (src/jammer.ts) raises the hand itself.
    if (playerHands.held !== 'jammer') playerHands.aim = Math.max(0, Math.min(1, playerHands.aim + (aiming ? dt : -dt * 1.4) / ADS_S));
    // In third person aiming brings the view in to the eye (src/camera.ts); the scope only once it's there.
    this.view.aimIn = aiming;
    const scoped = aiming && playerHands.aim >= 1 && feel.scope && this.view.boomLength < 0.05;
    if (scoped !== this.scoped) {
      this.scoped = scoped;
      this.el.style.opacity = scoped ? '1' : '0';
      document.body.classList.toggle('rifleScoped', scoped);
    }
    playerHands.rifleScoped = scoped;
    document.body.classList.toggle('rifleHip', holding && !aiming);
    document.body.classList.toggle('gunSights', holding && !feel.scope && playerHands.aim > 0.5);
    if (scoped) this.view.zoom = this.zoom;
    else if (isGun(playerHands.held)) this.view.zoom = 1 + (feel.sight - 1) * playerHands.aim;

    // How unsteady: the stance and pace now, being out of breath, holding it or gasping.
    const pace = pose.grounded ? pose.speed / WALK_SPEED : 2.5;
    if (pose.speed > (WALK_SPEED + SPRINT_SPEED) / 2) this.winded = Math.min(1, this.winded + dt * 0.4);
    else this.winded = Math.max(0, this.winded - dt * 0.18);
    const still = pose.speed < 0.5 && pose.grounded;
    if (aiming && still && breathHeld() && this.time > this.gaspUntil) {
      this.held += dt;
      if (this.held > HOLD_S) {
        this.held = 0;
        this.gaspUntil = this.time + GASP_S;
      }
    } else if (this.held > 0) {
      // Let go early: a short breath out, not a gasp.
      this.gaspUntil = Math.max(this.gaspUntil, this.time + Math.min(GASP_S, this.held * 0.3));
      this.held = 0;
    }
    const gasp = this.time < this.gaspUntil ? 1 + 1.5 * ((this.gaspUntil - this.time) / GASP_S) : 1;
    const stance = pose.crouching ? 0.6 : 1;
    const want = stance * (1 + 2.2 * Math.min(2, pace) + 2.5 * this.winded) * gasp * (this.held > 0 ? 0.18 : 1);
    this.unsteady += (want - this.unsteady) * (1 - Math.exp(-dt * 2));
    const u = this.unsteady * feel.sway;
    // The phase advances at the breathing rate. Not sin(time × rate): with the rate changing (getting winded, getting
    // your breath back) that swept the phase by time × Δrate, minutes into a game a jitter of tens of Hz on the view.
    this.breath = (this.breath + dt * BREATH_HZ * Math.PI * 2 * (1 + this.winded * 1.5)) % (Math.PI * 2);
    const b = Math.sin(this.breath);
    const f = this.time * TREMOR_HZ * Math.PI * 2;
    // Breath shows most when held to the eye; from the hip the arms just bob a little.
    const k = 0.35 + 0.65 * playerHands.aim;
    this.swayPitch = k * u * (BREATH * b * (this.held > 0 ? 0.2 : 1) + TREMOR * 0.6 * Math.sin(2 * f) + JITTER * wobble(this.time, 1.7));
    this.swayYaw = k * u * (TREMOR * Math.sin(f) + JITTER * wobble(this.time, 5.3));
    this.spread = playerHands.aim > 0.95 ? 0 : feel.hip + feel.move * Math.min(1, pace / 2) * (1 - playerHands.aim);
    // The recoil spring (rad): kicked on firing, pulled back (slightly under-damped: a little bounce past rest).
    // Stepped in short substeps: a whole slow frame (a hitch, low fps) at once would make it swing up and down ever harder.
    const kk = 160, cc = 17;
    for (let n = Math.ceil(dt / SPRING_DT), h = dt / n; n > 0; n--) {
      this.recoilVP += (-kk * this.recoilPitch - cc * this.recoilVP) * h;
      this.recoilVY += (-kk * this.recoilYaw - cc * this.recoilVY) * h;
      this.recoilPitch += this.recoilVP * h;
      this.recoilYaw += this.recoilVY * h;
    }
    playerHands.kick = Math.max(0, playerHands.kick - dt * 5);

    const charge = Math.min(1, 1 - (this.readyAt - performance.now()) / this.cooldown(feel.kind));
    playerHands.charge = charge;
    if (scoped) {
      this.zoomEl.textContent = `${this.zoom.toFixed(1)}×`;
      this.cellEl.style.transform = `scaleX(${charge})`;
    }
    const fire = holding && ((useHeld() && !!document.pointerLockElement) || this.forceFire);
    const pressed = fire && !this.wasFire;
    this.wasFire = fire;
    return pressed && performance.now() >= this.readyAt;
  }

  /**
   * After the camera is placed and the walkers drawn for this frame: lay the sway and recoil onto the camera, and fire
   * if `fire` (update()'s answer).
   */
  afterCamera(fire: boolean) {
    const cam = this.view.camera;
    if (!isGun(playerHands.held) && (!playerHands.aim || playerHands.held === 'jammer')) return;
    // Through the scope the eye's shadow slides about with the sway and the kick.
    if (this.scoped) {
      const px = innerHeight * 3;
      this.svg.style.transform = `translate(calc(-50% + ${(-this.recoilYaw * px * 0.6).toFixed(1)}px), calc(-50% + ${(this.recoilPitch * px * 0.8).toFixed(1)}px))`;
    }
    cam.rotation.x += this.swayPitch + this.recoilPitch;
    cam.rotation.y += this.swayYaw + this.recoilYaw;
    cam.updateMatrixWorld();
    // Hip crosshair: four ticks spread to the cone.
    const gap = 6 + (Math.tan(this.spread) / Math.tan(((cam.fov / 2) * Math.PI) / 180)) * innerHeight * 0.5;
    const ticks = this.hip.children as HTMLCollectionOf<HTMLElement>;
    const place = (e: HTMLElement, x: number, y: number, w: number, h: number) => (e.style.cssText = `left:${x - w / 2}px;top:${y - h / 2}px;width:${w}px;height:${h}px`);
    place(ticks[0], -gap - 5, 0, 8, 1.5);
    place(ticks[1], gap + 5, 0, 8, 1.5);
    place(ticks[2], 0, -gap - 5, 1.5, 8);
    place(ticks[3], 0, gap + 5, 1.5, 8);
    if (fire) this.shoot();
  }

  /** The held gun's recharge (ms): its parts' quality sets it (shared/gear.ts gunCooldown), as on the server. */
  private cooldown(kind: string) {
    const it = this.net.boxes.bag?.[tools.slot];
    return gunCooldown(GUNS[kind].cooldown, it?.kind === kind ? Math.max(0, quality(it)) : 0);
  }

  private shoot() {
    const cam = this.view.camera;
    const feel = FEEL[this.gun], { range } = GUNS[feel.kind], cooldown = this.cooldown(feel.kind);
    this.readyAt = performance.now() + cooldown;
    // From the eye along the aim (sway included), scattered within the cone from the hip. In third person the
    // camera is behind the eye on the view ray, so this still goes where the crosshair is.
    _o.copy(this.view.eye);
    cam.getWorldQuaternion(_q);
    _d.set(0, 0, -1).applyQuaternion(_q);
    if (this.spread > 0) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * this.spread;
      _r.set(1, 0, 0).applyQuaternion(_q);
      _u.set(0, 1, 0).applyQuaternion(_q);
      _d.addScaledVector(_r, Math.cos(a) * r).addScaledVector(_u, Math.sin(a) * r).normalize();
    }
    // The sand first, then anything of a walker before it.
    let dist = shotGround(_o.x, _o.y, _o.z, _d.x, _d.y, _d.z, range);
    const ground = dist < range;
    const hit = this.guardians.raycast(_o, _d, dist);
    if (hit) dist = hit.dist;
    const drone = this.drones.raycast(_o, _d, dist);
    if (drone) dist = drone.dist;
    const jet = this.jets.raycast(_o, _d, dist);
    if (jet) dist = jet.dist;
    const boss = bossFx?.raycast(_o, _d, dist) ?? null;
    if (boss) dist = boss.dist;
    _e.copy(_o).addScaledVector(_d, dist);
    // The beam from the drawn muzzle (first or third person). Through the scope no gun is drawn: from the barrel just
    // under it, a little ahead of the eye, so it rises from the bottom of the scope to the crosshair.
    const m = this.muzzle(_m) ?? (this.scoped
      ? _m.copy(_o).addScaledVector(_d, 0.8).addScaledVector(_u.set(0, 1, 0).applyQuaternion(_q), -0.07)
      : _m.copy(_o).addScaledVector(_d, 0.6).addScaledVector(_r.set(1, 0, 0).applyQuaternion(_q), 0.2).add(_u.set(0, -0.25, 0)));
    // It starts at the drawn muzzle as the gun kicks and the view climbs.
    zaps.beam(m.x, m.y, m.z, _e.x, _e.y, _e.z, true, this.muzzle);
    rifleSound.shot(null, null, this.gun === 'pistol');
    rifleSound.recharge(cooldown / 1000 - 0.08);
    if (boss) {
      zaps.burst(_e.x, _e.y, _e.z, boss.normal.x, boss.normal.y, boss.normal.z, boss.index >= 0 ? 6 : 16, 1.4);
      if (boss.index >= 0) bossFx!.breakLocal(boss.boss, boss.index);
      rifleSound.impact(boss.index >= 0 ? 'glass' : 'metal', _e, _o);
    } else if (drone || jet) {
      zaps.burst(_e.x, _e.y, _e.z, -_d.x, -_d.y, -_d.z, jet ? 24 : 16, jet ? 1.6 : 1);
      rifleSound.impact('metal', _e, _o);
    } else if (hit) {
      zaps.burst(_e.x, _e.y, _e.z, hit.normal.x, hit.normal.y, hit.normal.z, hit.index >= 0 ? 6 : 16);
      if (hit.index >= 0) this.guardians.breakLocal(hit.walker, hit.index);
      rifleSound.impact(hit.index >= 0 ? 'glass' : 'metal', _e, _o);
    } else if (ground && (baseSolid(_e.x, _e.y, _e.z) ?? shelterSolid(_e.x, _e.y, _e.z)) === true) {
      // The bunker's concrete.
      zaps.burst(_e.x, _e.y, _e.z, -_d.x, -_d.y, -_d.z, 10);
      rifleSound.impact('metal', _e, _o);
    } else if (ground) {
      zaps.burst(_e.x, _e.y + 0.05, _e.z, 0, 1, 0, 8);
      for (let i = 0; i < 3; i++) tyreDust.emit(_e.x, _e.y + 0.1, _e.z, (Math.random() - 0.5) * 1.5, 1 + Math.random(), (Math.random() - 0.5) * 1.5, 0.35);
      rifleSound.impact('sand', _e, _o);
    }
    this.net.fire(_o.x, _o.y, _o.z, _e.x, _e.y, _e.z, boss ? (boss.index >= 0 ? { b: boss.boss, bi: boss.index } : undefined) : jet ? { j: jet.jet } : drone ? { d: drone.drone } : hit ? { g: hit.walker, i: hit.index } : undefined);
    // Recoil: the muzzle climbs (some of it stays: pull it back down), kicks a little sideways; less held to the eye.
    const ads = playerHands.aim;
    const climb = feel.climb * (1.25 - 0.45 * ads) * (0.85 + Math.random() * 0.3);
    const side = (Math.random() - 0.5) * 2 * feel.side;
    this.view.pitch = Math.min(1.4, this.view.pitch + climb * CLIMB_STAYS);
    this.view.yaw += side * CLIMB_STAYS;
    this.recoilVP += climb * (1 - CLIMB_STAYS) * 30;
    this.recoilVY += side * (1 - CLIMB_STAYS) * 30;
    playerHands.kick = 1;
  }
}
