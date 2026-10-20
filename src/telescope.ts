// Spyglass (a hotbar item, src/water.ts). With it out, hold the use button (left/right mouse, E or Q) to
// raise it to the eye; once the raise clip (src/viewmodel.ts) has played, the view zooms in behind a round
// lens mask and the mouse wheel sets the zoom, up to what its parts allow (shared/gear.ts spyglassZoom). In third
// person the view comes in to the eye first, like a scoped gun's (src/camera.ts aimIn).
// Through the lens, the places worth going to that are in sight (the base, other players, wrecks, crash sites, shelters,
// downed jets' engines; not behind a dune) get a small mark with their distance, the locator's shapes (src/locator.ts).
// Letting go lowers it. Client-only: nothing is sent.
import * as THREE from 'three/webgpu';
import { BASE } from '../shared/base.ts';
import { crashSpent, crashTaken } from '../shared/crash.ts';
import { crashSitesNear } from '../shared/crashsites.ts';
import { jetSites } from '../shared/jetcrash.ts';
import { sheltersNear } from '../shared/shelters.ts';
import { heightAt } from '../shared/terrain.ts';
import { wrecksNear } from '../shared/wrecks.ts';
import type { FirstPersonCamera } from './camera';
import { aimHeld } from './input';
import type { LocatorTarget } from './locator';
import { playerHands } from './water';

/** Length of the TelescopeRaise clip (s): the view zooms once it's at the eye. */
const RAISE_S = 0.35;
const ZOOM_MIN = 2;
const ZOOM_DEFAULT = 6;
/** Places further than this (m) get no mark. */
const MARK_R = 2500;
/** Closer than this (m), no mark: you can see it. */
const MARK_NEAR = 25;
/** How often (s) the marked places and their line of sight are looked up again (the marks follow the view every frame). */
const REFRESH_S = 0.2;
/** The lens circle (SVG units of the 1600×1000 view box); marks show inside LENS_IN of it, fading out towards the rim. */
const LENS_R = 430;
const LENS_IN = 0.9;

type Kind = 'base' | 'player' | 'wreck' | 'site' | 'shelter';
type Mark = { key: string; kind: Kind; color: number; x: number; y: number; z: number; id?: number };

const COLOR: Record<Exclude<Kind, 'player'>, number> = { base: 0xf2e6c8, wreck: 0xe8a050, site: 0xc8d6dc, shelter: 0xb9c48e };

const css = `
#telescope { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity .12s; z-index: 5; }
#telescope svg { width: 100%; height: 100%; display: block; }
#telescope .zoom { position: absolute; left: 50%; bottom: 9%; transform: translateX(-50%); font: 600 12px var(--mono); color: #d9b98a; opacity: 0.7; font-variant-numeric: tabular-nums; }
#telescope .mark { position: absolute; left: 0; top: 0; display: flex; flex-direction: column; align-items: center; gap: 3px; }
#telescope .mark i { width: 9px; height: 9px; background: currentColor; filter: drop-shadow(0 0 1.5px rgba(5, 3, 2, 0.9)); }
#telescope .mark.player i { border-radius: 50%; }
#telescope .mark.base i { width: 12px; height: 12px; clip-path: polygon(50% 0, 100% 48%, 84% 48%, 84% 100%, 16% 100%, 16% 48%, 0 48%); }
#telescope .mark.wreck i { clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); }
#telescope .mark.site i { clip-path: polygon(50% 100%, 100% 0, 0 0); }
#telescope .mark.shelter i { width: 8px; height: 8px; }
#telescope .mark span { font: 600 11px var(--mono); font-variant-numeric: tabular-nums; text-shadow: 0 0 3px #050302, 0 0 1px #050302; white-space: nowrap; }
body.scoped #crosshair { display: none; }
`;

// One lens circle cut out of black with a soft edge, a faint warm rim inside it.
const SVG = `<svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
<defs><filter id="bnBlur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter>
<mask id="bnMask"><rect width="1600" height="1000" fill="white"/>
<circle cx="800" cy="500" r="${LENS_R}" fill="black" filter="url(#bnBlur)"/></mask>
<radialGradient id="bnRim"><stop offset="0.8" stop-color="#3a1e0a" stop-opacity="0"/>
<stop offset="1" stop-color="#3a1e0a" stop-opacity="0.55"/></radialGradient></defs>
<circle cx="800" cy="500" r="${LENS_R}" fill="url(#bnRim)"/>
<rect width="1600" height="1000" fill="#050302" mask="url(#bnMask)"/></svg>`;

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
/** Distance as read off the lens: to 10 m, past a kilometre to 100 m. */
const distText = (d: number) => (d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`);

/** Whether the sand or rock hides the point (x, y, z) from the eye (marched over the heightfield; the first few metres skipped,
 *  so looking out of a bunker's hatch works). */
function hidden(eye: THREE.Vector3, x: number, y: number, z: number): boolean {
  const dx = x - eye.x, dy = y - eye.y, dz = z - eye.z;
  const d = Math.hypot(dx, dz);
  const n = Math.min(80, Math.ceil(d / 12));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (t * d < 6) continue;
    if (heightAt(eye.x + dx * t, eye.z + dz * t) > eye.y + dy * t) return true;
  }
  return false;
}

export class Telescope {
  private view: FirstPersonCamera;
  private el = document.createElement('div');
  private zoomEl: HTMLElement;
  private raised = 0; // seconds at the eye so far
  private zoom = ZOOM_DEFAULT;
  private max = ZOOM_DEFAULT;
  private marks: Mark[] = []; // in sight at the last refresh
  private markEls = new Map<string, { el: HTMLDivElement; dist: HTMLSpanElement }>();
  private refreshIn = 0;
  private v = new THREE.Vector3();
  /** Debug (?debug, `dbg.telescope`): raise it without one in hand or the mouse captured. */
  forceLook = false;

  constructor(view: FirstPersonCamera) {
    this.view = view;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.el.id = 'telescope';
    this.el.innerHTML = `${SVG}<span class="zoom"></span>`;
    this.zoomEl = this.el.querySelector('.zoom')!;
    document.body.append(this.el);
    addEventListener('wheel', (e) => {
      if (!playerHands.scoped) return;
      this.zoom = Math.max(ZOOM_MIN, Math.min(this.max, this.zoom * Math.exp(-e.deltaY * 0.0015)));
    }, { passive: true });
  }

  /** Before the camera is placed. `maxZoom`: the strongest zoom of the telescope in hand. */
  update(dt: number, maxZoom: number) {
    this.max = maxZoom;
    this.zoom = Math.min(this.zoom, maxZoom);
    const look = (playerHands.held === 'telescope' && aimHeld() && !!document.pointerLockElement) || this.forceLook;
    this.raised = look ? this.raised + dt : 0;
    // In third person it waits for the view to come in to the eye (src/rifle.ts sets aimIn from playerHands.looking).
    const scoped = look && this.raised >= RAISE_S && this.view.boomLength < 0.05;
    playerHands.looking = look;
    if (scoped !== playerHands.scoped) {
      playerHands.scoped = scoped;
      this.el.style.opacity = scoped ? '1' : '0';
      document.body.classList.toggle('scoped', scoped);
      this.refreshIn = 0;
    }
    this.view.zoom = scoped ? this.zoom : 1;
    if (scoped) this.zoomEl.textContent = `${this.zoom.toFixed(1)}×`;
  }

  /** After the camera is placed: mark the places in the lens. `players`: the others (their dots move every frame). */
  afterCamera(dt: number, players: readonly LocatorTarget[]) {
    if (!playerHands.scoped) {
      if (this.markEls.size) this.clearMarks();
      return;
    }
    const cam = this.view.camera;
    const eye = cam.position;
    if ((this.refreshIn -= dt) <= 0) {
      this.refreshIn = REFRESH_S;
      this.marks = this.gather(eye, players).filter((m) => !hidden(eye, m.x, m.y, m.z));
    }
    cam.updateMatrixWorld();
    const scale = Math.max(innerWidth / 1600, innerHeight / 1000);
    const r = LENS_R * scale * LENS_IN;
    const cx = innerWidth / 2, cy = innerHeight / 2;
    const seen = new Set<string>();
    for (const m of this.marks) {
      const p = m.id !== undefined ? players.find((o) => o.id === m.id) : m;
      if (!p) continue;
      const y = m.id !== undefined ? p.y + 2.2 : m.y; // over a player's head
      this.v.set(p.x, y, p.z).project(cam);
      if (this.v.z > 1) continue; // behind
      const sx = (this.v.x * 0.5 + 0.5) * innerWidth, sy = (-this.v.y * 0.5 + 0.5) * innerHeight;
      const off = Math.hypot(sx - cx, sy - cy) / r;
      if (off > 1) continue;
      seen.add(m.key);
      let e = this.markEls.get(m.key);
      if (!e) {
        const el = document.createElement('div');
        el.className = `mark ${m.kind}`;
        el.style.color = hex(m.color);
        el.innerHTML = '<i></i><span></span>';
        this.el.appendChild(el);
        this.markEls.set(m.key, (e = { el, dist: el.querySelector('span')! }));
      }
      e.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -6px)`;
      e.el.style.opacity = String(Math.min(1, (1 - off) / 0.2));
      e.dist.textContent = distText(Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z));
    }
    for (const [key, e] of this.markEls) {
      if (seen.has(key)) continue;
      e.el.remove();
      this.markEls.delete(key);
    }
  }

  private clearMarks() {
    for (const e of this.markEls.values()) e.el.remove();
    this.markEls.clear();
    this.marks = [];
  }

  /** The places within MARK_R of the eye (each at a point just over the sand there, for the line of sight). */
  private gather(eye: THREE.Vector3, players: readonly LocatorTarget[]): Mark[] {
    const out: Mark[] = [];
    const add = (key: string, kind: Kind, x: number, z: number, up: number, color = COLOR[kind as Exclude<Kind, 'player'>], id?: number, y = heightAt(x, z) + up) => {
      const d = Math.hypot(x - eye.x, z - eye.z);
      if (d >= MARK_NEAR && d <= MARK_R) out.push({ key, kind, color, x, y, z, id });
    };
    add('base', 'base', BASE.x, BASE.z, 2);
    for (const p of players) add(`p${p.id}`, 'player', p.x, p.z, 0, p.color, p.id, p.y + 1.6);
    for (const w of wrecksNear(eye.x, eye.z, MARK_R)) if (!crashTaken.has(w.id)) add(w.id, 'wreck', w.x, w.z, 1.5);
    for (const s of crashSitesNear(eye.x, eye.z, MARK_R)) if (!crashSpent.has(s.id)) add(`c${s.id}`, 'site', s.x, s.z, 4);
    for (const s of jetSites()) add(s.id, 'site', s.x, s.z, 3);
    for (const s of sheltersNear(eye.x, eye.z, MARK_R)) add(`s${s.id}`, 'shelter', s.x, s.z, 2.5);
    return out;
  }
}
