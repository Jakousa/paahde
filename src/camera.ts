// First-person camera. Click the canvas to lock the pointer; the mouse moves yaw/pitch.
// The yaw is also the movement frame sent to the server (see shared/sim.ts step()), and the body faces it.
//
// Feel: the eye height is smoothed a little so slopes don't jitter, the head bobs with stride, hard
// landings dip the view on a spring, strafing rolls it slightly, and sprinting kicks the FOV out.
// T toggles a third-person view over the right shoulder: the camera backs off behind the eye and to its right, turned
// in so the screen centre (crosshair) crosses the dig/pickup ray at about arm's reach, and the boom shortens so it
// never sinks into a dune.
// Holding Alt (Option) looks around freely: the mouse turns only the view (freeYaw / freePitch on top of yaw / pitch),
// so you keep running or sliding the way you were going; letting go swings the view back.
import * as THREE from 'three/webgpu';
import { isBound } from './bindings';
import { tools } from './input';
import { heightAt } from '../shared/terrain.ts';
import { placed, TARP, type Placed } from '../shared/placed.ts';
import { canvasYAt, TARP_HALF, tarpRig, type TarpRig } from '../shared/tarp.ts';
import { WALK_SPEED, SPRINT_SPEED, CROUCH_SPEED, slopeAt } from '../shared/sim.ts';
import { CROUCH_CYCLE } from './models/crouchGait';
import { EYE_HEIGHT } from '../shared/dig.ts'; // the dig and pickup rays start here too
import { sandHidden, shelterSolid } from '../shared/shelters.ts';
const SENSITIVITY = 0.0022;
const PITCH_LIMIT = (85 * Math.PI) / 180;
// Riding in first person the rider's body is drawn (headless) around the eye: a neck's range keeps the view out of it.
const RIDE_YAW_LIMIT = (100 * Math.PI) / 180; // either side of the bike's heading
const RIDE_PITCH_DOWN = (55 * Math.PI) / 180; // looking ahead over the bars; less over a shoulder (see limitRide)
const BASE_FOV = 72;
const SPRINT_FOV_KICK = 9;
/** Widest the view gets (sprinting); the sun's shadow cascades are fitted to it. */
export const MAX_FOV = BASE_FOV + SPRINT_FOV_KICK;
// Metres per step (half a bob cycle): the third-person Run clip's (RUN_REF × its 0.73 s cycle / 2, src/models/scavenger.ts)
// so the view, the footstep sounds (src/players.ts) and the body's feet keep one cadence, ~4.4 steps/s at a walk.
const STRIDE = 1.72;
// Climbing (grade from CLIMB_FROM to CLIMB_FULL along the way you walk): steps up to CLIMB_SHORTEN shorter and
// up to 1 + CLIMB_HEAVY times the bob, a trudge in step with the third-person body (src/models/scavenger.ts).
const CLIMB_FROM = 0.08;
const CLIMB_FULL = 0.5;
const CLIMB_SHORTEN = 0.25;
const CLIMB_HEAVY = 1.2;
const slope = { gx: 0, gz: 0 };
const BOOM = 4.5; // third-person distance behind the eye (m)
const OTS_BOOM = 3.0; // third person: the camera sits behind the shoulder (m)
const OTS_SIDE = 0.55; // ...and over it, to the right of the aim line (m)
const OTS_MEET = 3; // ...turned in so its centre ray crosses the eye's look ray this far ahead (m): pickups' reach
const BOOM_CLEARANCE = 0.35; // keep the camera this far above the sand
const WALL_CLEARANCE = 0.2; // ...and this far from the shelters' walls, floors and ceilings (m)
/** Speed slide: the view rolls this far (rad) towards the trailing left hand. */
const SLIDE_ROLL = 0.07;
const SPRING_DT = 1 / 120; // the landing dip's longest step (s): a slow frame taken whole would make it swing ever harder
const THIRD_PERSON_KEY = 'dadajam.thirdPerson';
const FREE_YAW_LIMIT = (160 * Math.PI) / 180; // free look: as far round as over a shoulder

/** What the camera needs from the local player each frame. */
export type ViewPose = { x: number; y: number; z: number; vx: number; vy: number; vz: number; grounded: boolean; sliding?: boolean; crouching?: boolean; riding?: boolean;
  /** The bike's lean into a turn (rad, + = left): the view rolls with part of it. */
  lean?: number;
  /** The bike's heading while riding (rad), for the neck limits. */
  heading?: number };

export class FirstPersonCamera {
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0;
  pitch = -0.05;
  /** Free look (Alt held): the view's turn away from yaw / pitch, which still steer and aim. Eases back to 0 on release. */
  freeYaw = 0;
  freePitch = 0;
  private freeLook = false;

  private eyeY = NaN; // smoothed feet height
  private bobPhase = 0;
  private bobAmount = 0; // about 0..1 (more when trudging uphill), fades in with walking, out when airborne/stopped
  private climb = 0; // 0..1, eased: how much of a trudge uphill the step is
  private crouch = 0; // 0..1, eased in while sliding (crouching: 0.7): the eye drops and the view rolls a touch
  private dip = 0; // landing dip offset (m), spring back to 0
  private dipVel = 0;
  private roll = 0;
  private slide = 0; // 0..1, eased in while speed-sliding: the view leans back onto the trailing (left) hand
  private slideClock = 0; // seconds, drives the slide's shake
  private fov = BASE_FOV;
  /** Magnification (spyglass, src/telescope.ts); 1 = none. The view eases towards it. */
  zoom = 1;
  private zoomShown = 1;
  private wasGrounded = true;
  private lastVy = 0;
  /** Third-person view on (T toggles it, remembered per browser). */
  thirdPerson = false;
  /** Lying dead (shared/ragdoll.ts): third person whatever the T setting, looking at the body. */
  down = false;
  /** Aiming a scoped gun: the view comes in to the eye whatever the T setting, quickly. */
  aimIn = false;
  /** The body's drawn height (shared/look.ts bodyScale): the steps are that much longer, in step with the body's. */
  stride = 1;
  /** Where the eye is (the view ray passes through it; in third person the camera is behind it on that ray). */
  readonly eye = new THREE.Vector3();
  /** Sideways offset (m) of the over-the-shoulder view, eased. */
  shoulder = 0;
  private boom = 0; // current boom length (m), eased toward BOOM or 0
  private rideHeading = NaN; // set while riding in first person: the view is limited to a neck's range of it

  constructor(dom: HTMLElement) {
    try {
      this.thirdPerson = localStorage.getItem(THIRD_PERSON_KEY) === '1';
    } catch {}
    document.body.classList.toggle('third-person', this.thirdPerson);
    addEventListener('keydown', (e) => {
      if (!isBound('thirdPerson', e.code) ||e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      this.thirdPerson = !this.thirdPerson;
      document.body.classList.toggle('third-person', this.thirdPerson);
      try {
        localStorage.setItem(THIRD_PERSON_KEY, this.thirdPerson ? '1' : '0');
      } catch {}
    });
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, 0.05, 6000);
    this.camera.rotation.order = 'YXZ';
    dom.addEventListener('click', () => {
      if (document.pointerLockElement !== dom) dom.requestPointerLock();
    });
    const alt = (e: KeyboardEvent) => {
      if (isBound('freeLook', e.code)) this.freeLook = e.type === 'keydown';
    };
    addEventListener('keydown', alt);
    addEventListener('keyup', alt);
    addEventListener('blur', () => (this.freeLook = false));
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== dom) return;
      this.look(e.movementX * SENSITIVITY, e.movementY * SENSITIVITY);
    });
  }

  /** Turn the view by (dx, dy) radians at no zoom, right and down: the mouse, or the gamepad's stick (src/gamepad.ts). */
  look(dx: number, dy: number) {
    if (tools.spinning) return; // (turning a machine or a piece in the hand with the mouse: the view stays)
    const s = 1 / this.zoomShown; // zoomed in, the same hand movement turns the view less
    if (this.freeLook && !Number.isFinite(this.rideHeading) && this.zoom <= 1) {
      this.freeYaw = Math.max(-FREE_YAW_LIMIT, Math.min(FREE_YAW_LIMIT, this.freeYaw - dx * s));
      this.freePitch = Math.max(-PITCH_LIMIT - this.pitch, Math.min(PITCH_LIMIT - this.pitch, this.freePitch - dy * s));
      return;
    }
    this.yaw -= dx * s;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - dy * s));
    if (Number.isFinite(this.rideHeading)) this.limitRide(1);
  }

  /** Pull yaw/pitch back inside the riding neck limits, all the way (t = 1) or part of it (easing in on mounting). */
  private limitRide(t: number) {
    const d = Math.atan2(Math.sin(this.yaw - this.rideHeading), Math.cos(this.yaw - this.rideHeading));
    const turn = d + (Math.max(-RIDE_YAW_LIMIT, Math.min(RIDE_YAW_LIMIT, d)) - d) * t;
    this.yaw += turn - d;
    const down = RIDE_PITCH_DOWN * (1 - (0.6 * Math.abs(turn)) / RIDE_YAW_LIMIT);
    if (this.pitch < -down) this.pitch += (-down - this.pitch) * t;
  }

  /** Where the view looks (yaw plus any free look): for the listener and other things that follow the screen. */
  get viewYaw() {
    return this.yaw + this.freeYaw;
  }

  /** Step phase in radians (one step per π), so hands/footsteps can sync to the bob. */
  get stepPhase() {
    return this.bobPhase;
  }

  /** Draw the local body: the camera is far enough behind the head not to be inside it. */
  get showBody() {
    return this.boom > 0.9;
  }

  /** The camera's distance behind the eye (m): 0 in first person. */
  get boomLength() {
    return this.boom;
  }

  /** Place the eye at the player's feet position `p` (predicted state + visual error offset). */
  update(p: ViewPose, dt: number) {
    const speed = Math.hypot(p.vx, p.vz);
    // On the bike in first person, keep the view to a neck's range (eased, so mounting or leaving third person doesn't snap).
    this.rideHeading = p.riding && !this.thirdPerson && p.heading !== undefined ? p.heading : NaN;
    if (Number.isFinite(this.rideHeading)) this.limitRide(1 - Math.exp(-dt * 8));
    if (!this.freeLook || Number.isFinite(this.rideHeading) || this.zoom > 1) {
      const k = 1 - Math.exp(-dt * 7);
      this.freeYaw -= this.freeYaw * k;
      this.freePitch -= this.freePitch * k;
      if (Math.abs(this.freeYaw) + Math.abs(this.freePitch) < 1e-4) this.freeYaw = this.freePitch = 0;
    }
    const viewYaw = this.yaw + this.freeYaw;

    // Eye height: follow the feet quickly but smoothly; snap if far (respawn/teleport) or airborne. Riding, it is
    // the rider's head (already smooth): any lag here sinks the view into the body and bike on a fast climb.
    if (!Number.isFinite(this.eyeY) || Math.abs(p.y - this.eyeY) > 3 || p.riding) this.eyeY = p.y;
    else this.eyeY += (p.y - this.eyeY) * (1 - Math.exp(-dt * (p.grounded ? 22 : 40)));

    // Landing dip: a damped spring kicked by the impact speed.
    if (p.grounded && !this.wasGrounded) {
      const impact = Math.max(0, -this.lastVy);
      this.dipVel -= Math.min(impact, 30) * 0.06;
    }
    this.wasGrounded = p.grounded;
    this.lastVy = p.vy;
    // Dropping into a slide kicks the eye down on the same spring (it overshoots, then settles low).
    const sliding = !!p.sliding && p.grounded;
    if (sliding && this.slide < 0.05) this.dipVel -= 0.9;
    const k = 120, c = 16;
    for (let n = Math.ceil(dt / SPRING_DT), h = dt / n; n > 0; n--) {
      this.dipVel += (-k * this.dip - c * this.dipVel) * h;
      this.dip = Math.max(-0.45, this.dip + this.dipVel * h);
    }

    // Head bob tied to distance travelled.
    const moving = p.grounded && speed > 0.5;
    // Past a walk it grows only gently (sprint ≈ 1.1×, its faster step rate is enough), and the vertical shape is sin², which is smooth
    // at footfall where |sin| had a hard cusp.
    const pace = speed / WALK_SPEED;
    // Crouched: short quick steps (the body's, src/models/crouchGait.ts), the bob gentle.
    const crouched = !!p.crouching && !p.sliding;
    const walking = moving && !p.sliding && !p.riding;
    let grade = 0;
    if (walking && !crouched && !sandHidden(p.x, p.z, p.y)) {
      slopeAt(p.x, p.z, slope);
      grade = (p.vx * slope.gx + p.vz * slope.gz) / speed;
    }
    const climbTarget = Math.max(0, Math.min(1, (grade - CLIMB_FROM) / (CLIMB_FULL - CLIMB_FROM)));
    this.climb += (climbTarget - this.climb) * (1 - Math.exp(-dt * 5));
    const bobTarget = !walking ? 0
      : crouched ? 0.35 * Math.min(1, speed / CROUCH_SPEED)
      : (pace <= 1 ? pace : Math.min(1 + (pace - 1) * 0.12, 1.15)) * (1 + CLIMB_HEAVY * this.climb);
    this.bobAmount += (bobTarget - this.bobAmount) * (1 - Math.exp(-dt * 6));
    if (p.grounded) this.bobPhase += (speed * dt * Math.PI) / (crouched ? CROUCH_CYCLE / 2 : STRIDE * this.stride * (1 - CLIMB_SHORTEN * this.climb));
    const s = Math.sin(this.bobPhase);
    const bobY = (0.5 - s * s) * 0.018 * this.bobAmount;
    const bobX = s * 0.009 * this.bobAmount;

    // Camera basis on the ground plane.
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const rightX = cy, rightZ = -sy;
    const lateral = p.vx * rightX + p.vz * rightZ;
    this.roll += (-lateral * 0.0035 + (p.lean ?? 0) * 0.4 - this.roll) * (1 - Math.exp(-dt * 6));

    const x = p.x + rightX * bobX;
    const z = p.z + rightZ * bobX;
    this.crouch += ((p.grounded ? (p.sliding ? 1 : p.crouching ? 0.7 : 0) : 0) - this.crouch) * (1 - Math.exp(-dt * 12));
    // Sliding: lean back and to the left, the hand in the sand; the sand shakes the view, more the faster.
    this.slide += ((sliding ? 1 : 0) - this.slide) * (1 - Math.exp(-dt * (sliding ? 9 : 5)));
    let shakeY = 0, shakeR = 0, shakeP = 0;
    if (this.slide > 1e-3) {
      const t = (this.slideClock += dt);
      // Less from behind the body (third person), where the body shows the slide.
      const a = this.slide * Math.min(1, Math.max(0, (speed - WALK_SPEED) / 10)) * (1 - 0.6 * Math.min(1, this.boom / BOOM));
      shakeY = a * 0.008 * (Math.sin(t * 31) * 0.6 + Math.sin(t * 47.3 + 1.3) * 0.4);
      shakeR = a * 0.006 * Math.sin(t * 23.7 + 0.4) * Math.sin(t * 5.1);
      shakeP = a * 0.005 * Math.sin(t * 37.9 + 2.1);
    } else this.slideClock = 0;
    let y = this.eyeY + EYE_HEIGHT - 0.65 * this.crouch + bobY + this.dip + shakeY;
    // Never look out from under a dune (in a shelter's entrance and rooms the sand isn't in the way).
    if (!sandHidden(x, z, p.y)) y = Math.max(y, heightAt(x, z) + 0.3);

    // Third person: back off along the view ray (and over the shoulder), shortening both together where the camera
    // would go into the sand or through a shelter's wall.
    const pitch = this.pitch + this.freePitch + this.dip * 0.12 + shakeP;
    const cp = Math.cos(pitch), vs = Math.sin(viewYaw), vc = Math.cos(viewYaw);
    const bx = vs * cp, by = -Math.sin(pitch), bz = vc * cp; // unit vector pointing behind the view
    const third = (this.thirdPerson && !this.aimIn) || this.down;
    const ots = this.thirdPerson && !this.aimIn && !this.down;
    const full = ots ? OTS_BOOM : BOOM, side = ots ? OTS_SIDE : 0;
    let room = third ? 1 : 0;
    for (let i = 1; i <= 12 && room > 0; i++) {
      const f = i / 12;
      if (f > room) break;
      const px = x + (bx * full + vc * side) * f, py = y + by * full * f, pz = z + (bz * full - vs * side) * f;
      if (blocked(px, py, pz) || tarpBetween(x, y, z, px, py, pz)) room = f - 1 / 12;
    }
    const reach = full * room;
    // Ease out smoothly, but snap in when something cuts the boom short.
    this.boom = reach < this.boom && third ? reach : this.boom + (reach - this.boom) * (1 - Math.exp(-dt * (this.aimIn ? 16 : ots ? 9 : 8)));
    if (this.boom < 0.01) this.boom = 0;
    this.eye.set(x, y, z);
    const shoulder = side * room;
    this.shoulder = shoulder < this.shoulder ? shoulder : this.shoulder + (shoulder - this.shoulder) * (1 - Math.exp(-dt * 9));
    if (this.shoulder < 0.005) this.shoulder = 0;
    this.camera.position.set(x + bx * this.boom + vc * this.shoulder, y + by * this.boom, z + bz * this.boom - vs * this.shoulder);
    // Turned in towards the point OTS_MEET ahead on the eye's look ray, so the crosshair is on what F picks up there.
    const mx = x - bx * OTS_MEET - this.camera.position.x, my = y - by * OTS_MEET - this.camera.position.y, mz = z - bz * OTS_MEET - this.camera.position.z;
    const camYaw = this.shoulder > 0 ? Math.atan2(-mx, -mz) : viewYaw;
    const camPitch = this.shoulder > 0 ? Math.atan2(my, Math.hypot(mx, mz)) : pitch;
    this.camera.rotation.set(camPitch, camYaw, this.roll + bobX * 0.1 + this.slide * SLIDE_ROLL * (1 - 0.6 * Math.min(1, this.boom / BOOM)) + shakeR);

    // FOV kick when moving faster than a walk (sprint, slides).
    const t = Math.max(0, Math.min(1, (speed - WALK_SPEED - 0.5) / (SPRINT_SPEED - WALK_SPEED - 1)));
    const target = BASE_FOV + SPRINT_FOV_KICK * t;
    this.fov += (target - this.fov) * (1 - Math.exp(-dt * 5));
    // Zoom narrows the view by the magnification (tan of the half-angle), snapping back out when it ends.
    this.zoomShown = this.zoom <= 1 ? 1 : this.zoomShown + (this.zoom - this.zoomShown) * (1 - Math.exp(-dt * 12));
    const fov = this.zoomShown > 1 ? (360 / Math.PI) * Math.atan(Math.tan((this.fov * Math.PI) / 360) / this.zoomShown) : this.fov;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }
}

/** The camera can't be at world (x, y, z): within WALL_CLEARANCE of a shelter's solid, or too near the sand. */
function blocked(x: number, y: number, z: number): boolean {
  const c = WALL_CLEARANCE;
  for (const [dx, dy, dz] of PROBE) {
    const px = x + dx * c, py = y + dy * c, pz = z + dz * c;
    const solid = shelterSolid(px, py, pz);
    if (solid ?? y < heightAt(px, pz) + BOOM_CLEARANCE) return true;
  }
  return false;
}
/** The tarps' rigs (shared/tarp.ts), per placed thing. */
const rigs = new WeakMap<Placed, TarpRig>();
/** Would the camera at (px, py, pz) be on the other side of a tarp's canvas from the eye at (ex, ey, ez), or in it? Under
 *  the canvas is one side, everything else (over it, or out past its edge) the other; the doorway counts as canvas,
 *  which only shortens the boom there. */
function tarpBetween(ex: number, ey: number, ez: number, px: number, py: number, pz: number): boolean {
  for (const p of placed) {
    if (p.kind !== TARP || Math.abs(p.x - px) > TARP_HALF + 4 || Math.abs(p.z - pz) > TARP_HALF + 4) continue;
    let r = rigs.get(p);
    if (!r) rigs.set(p, (r = tarpRig(p.x, p.z, p.rot)));
    const ce = canvasYAt(r, ex, ez), cp = canvasYAt(r, px, pz);
    const eyeUnder = ey < ce, camUnder = py < cp - WALL_CLEARANCE;
    if (eyeUnder !== camUnder || Math.abs(py - cp) < WALL_CLEARANCE) return true;
  }
  return false;
}

/** The point and six around it (unit offsets). */
const PROBE = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
