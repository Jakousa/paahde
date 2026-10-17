// Spyglass (a hotbar item, src/water.ts). With it out, hold the use button (left/right mouse, E or Q) to
// raise it to the eye; once the raise clip (src/viewmodel.ts) has played, the view zooms in behind a round
// lens mask and the mouse wheel sets the zoom. Letting go lowers it. Client-only: nothing is sent.
import type { FirstPersonCamera } from './camera';
import { aimHeld } from './input';
import { playerHands } from './water';

/** Length of the TelescopeRaise clip (s): the view zooms once it's at the eye. */
const RAISE_S = 0.35;
const ZOOM_MIN = 3;
const ZOOM_MAX = 12;
const ZOOM_DEFAULT = 6;

const css = `
#telescope { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity .12s; z-index: 5; }
#telescope svg { width: 100%; height: 100%; display: block; }
#telescope .zoom { position: absolute; left: 50%; bottom: 9%; transform: translateX(-50%); font: 600 12px var(--mono); color: #d9b98a; opacity: 0.7; font-variant-numeric: tabular-nums; }
body.scoped #crosshair { display: none; }
`;

// One lens circle cut out of black with a soft edge, a faint warm rim inside it.
const SVG = `<svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
<defs><filter id="bnBlur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter>
<mask id="bnMask"><rect width="1600" height="1000" fill="white"/>
<circle cx="800" cy="500" r="430" fill="black" filter="url(#bnBlur)"/></mask>
<radialGradient id="bnRim"><stop offset="0.8" stop-color="#3a1e0a" stop-opacity="0"/>
<stop offset="1" stop-color="#3a1e0a" stop-opacity="0.55"/></radialGradient></defs>
<circle cx="800" cy="500" r="430" fill="url(#bnRim)"/>
<rect width="1600" height="1000" fill="#050302" mask="url(#bnMask)"/></svg>`;

export class Telescope {
  private view: FirstPersonCamera;
  private el = document.createElement('div');
  private zoomEl: HTMLElement;
  private raised = 0; // seconds at the eye so far
  private zoom = ZOOM_DEFAULT;

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
      this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoom * Math.exp(-e.deltaY * 0.0015)));
    }, { passive: true });
  }

  update(dt: number) {
    const look = playerHands.held === 'telescope' && aimHeld() && !!document.pointerLockElement;
    this.raised = look ? this.raised + dt : 0;
    const scoped = look && this.raised >= RAISE_S;
    playerHands.looking = look;
    if (scoped !== playerHands.scoped) {
      playerHands.scoped = scoped;
      this.el.style.opacity = scoped ? '1' : '0';
      document.body.classList.toggle('scoped', scoped);
    }
    this.view.zoom = scoped ? this.zoom : 1;
    if (scoped) this.zoomEl.textContent = `${this.zoom.toFixed(1)}×`;
  }
}
