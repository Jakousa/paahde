// Locator bar, after Minecraft's (1.21.6): a thin strip at the bottom of the screen with a coloured dot
// per far-away player at their bearing relative to where you look. The bar spans the horizontal FOV;
// players behind you pin to its ends, dimmed. Dots shrink with distance, and an arrow marks players
// well above or below your view. Close players (name tag in view) get no dot. The home base gets a
// house-shaped marker the same way, so you can always find your way back (except in a sandstorm).
import type * as THREE from 'three/webgpu';
import { BASE } from '../shared/base.ts';

const NEAR = 25; // m: closer than this, no dot (fades in over the next FADE metres)
const FADE = 10;
const ELEVATION = 0.35; // rad off the view's pitch before the up/down arrow shows

export type LocatorTarget = { id: number; color: number; x: number; y: number; z: number };

const BASE_ID = -1; // player ids are positive
const BASE_TARGET: LocatorTarget = { id: BASE_ID, color: 0xf2e6c8, x: BASE.x, y: BASE.y, z: BASE.z };

const css = `
#locator { position: fixed; left: 50%; bottom: 28px; width: min(480px, 70vw); height: 6px;
  transform: translateX(-50%); background: rgba(20, 10, 5, 0.45); border-radius: 3px;
  box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.18); pointer-events: none; transition: opacity 0.3s; }
#locator .dot { position: absolute; top: 50%; border-radius: 50%; transform: translate(-50%, -50%);
  box-shadow: 0 0 0 1.5px rgba(20, 10, 5, 0.8); }
#locator .arrow { position: absolute; left: 50%; transform: translateX(-50%); font: bold 9px system-ui;
  line-height: 1; color: inherit; text-shadow: 0 0 2px #000; }
#locator .dot.base { border-radius: 0; box-shadow: none; filter: drop-shadow(0 0 1px rgba(20, 10, 5, 0.9)); }
#locator .dot.base::before { content: ''; position: absolute; inset: 0; background: currentColor;
  clip-path: polygon(50% 0, 100% 48%, 84% 48%, 84% 100%, 16% 100%, 16% 48%, 0 48%); }
`;

export class LocatorBar {
  private bar = document.createElement('div');
  private dots = new Map<number, { el: HTMLDivElement; arrow: HTMLDivElement }>();
  /** Lost in a sandstorm (src/storm.ts): the bar fades out until the dust clears. */
  lost = false;

  constructor() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.bar.id = 'locator';
    document.body.appendChild(this.bar);
  }

  update(camera: THREE.PerspectiveCamera, yaw: number, pitch: number, me: { x: number; y: number; z: number }, players: LocatorTarget[]) {
    const halfH = Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect);
    const seen = new Set<number>();
    for (const p of [...players, BASE_TARGET]) {
      const isBase = p.id === BASE_ID;
      const dx = p.x - me.x, dy = p.y - me.y, dz = p.z - me.z;
      const flat = Math.hypot(dx, dz);
      const dist = Math.hypot(flat, dy);
      const fade = Math.min(1, Math.max(0, (dist - NEAR) / FADE));
      if (fade <= 0) continue;
      seen.add(p.id);
      let d = this.dots.get(p.id);
      if (!d) {
        d = { el: document.createElement('div'), arrow: document.createElement('div') };
        d.el.className = isBase ? 'dot base' : 'dot';
        d.arrow.className = 'arrow';
        d.el.appendChild(d.arrow);
        this.bar.appendChild(d.el);
        this.dots.set(p.id, d);
      }
      // Bearing in the camera's frame (forward is -Z, yaw turns left): positive = to the left.
      const rel = Math.atan2(Math.sin(Math.atan2(-dx, -dz) - yaw), Math.cos(Math.atan2(-dx, -dz) - yaw));
      const u = -rel / halfH; // -1 = left edge, 1 = right edge
      const outside = Math.abs(u) > 1;
      const size = (dist < 60 ? 10 : dist < 150 ? 8 : dist < 400 ? 6 : 5) + (isBase ? 4 : 0);
      const color = `#${p.color.toString(16).padStart(6, '0')}`;
      const s = d.el.style;
      s.left = `${(Math.max(-1, Math.min(1, u)) * 0.5 + 0.5) * 100}%`;
      s.width = s.height = `${size}px`;
      s.color = color;
      s.background = isBase ? '' : color;
      s.opacity = String(fade * (outside ? 0.45 : 1));
      const elev = Math.atan2(dy, flat) - pitch;
      d.arrow.textContent = elev > ELEVATION ? '▲' : elev < -ELEVATION ? '▼' : '';
      d.arrow.style.bottom = elev > 0 ? `${size + 2}px` : '';
      d.arrow.style.top = elev < 0 ? `${size + 2}px` : '';
    }
    for (const [id, d] of this.dots) {
      if (seen.has(id)) continue;
      d.el.remove();
      this.dots.delete(id);
    }
    this.bar.style.opacity = this.dots.size && !this.lost ? '1' : '0';
  }
}
