// The character view on the main menu (src/landing.ts): your scavenger turning slowly in the warm light, and beside it
// a row per slot of the look (shared/look.ts): arrows step through a slot's pieces, swatches pick a dye. Every change
// shows on the figure at once; Save keeps it (src/profile.ts setMyLook) for your next join and goes back, Back goes back
// without it. Drag the figure to turn it, wheel or pinch to
// zoom in on it (up to the face); the dice picks a
// whole look at random. The figure has its own small renderer, gone with the view.
// Also the character creation on your first join to a game (src/lobby.ts): the same, with your name and colour
// (src/profile.ts profileForm, the colour on the figure as you pick it), and Join in place of Save.
import * as THREE from 'three/webgpu';
import { bodyScale, DYE_COLORS, dyeChoice, dyeIndex, type DyeSlot, LOOK_SLOTS, type LookKey, packLook, unpackLook } from '../shared/look.ts';
import { TEXT } from '../shared/text.ts';
import { ScavengerModel } from './models/scavenger';
import { myColor, myLook, profileForm, setMyLook } from './profile';

const CSS = `
#landing .lookView { display: grid; gap: 16px; justify-items: center; }
#landing .lookView .body { display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: center; justify-content: center; }
#landing .lookView canvas { width: min(80vw, 360px); height: min(115vw, 520px); cursor: grab; touch-action: none; }
#landing .lookView canvas:active { cursor: grabbing; }
#landing .lookView .slots { display: grid; gap: 6px; }
#landing .lookView .slot { display: grid; grid-template-columns: 7.5em auto; gap: 10px; align-items: center; justify-items: start; }
#landing .lookView .slot .label { font: 11px var(--mono); letter-spacing: .15em; text-transform: uppercase; opacity: .85; text-align: right; justify-self: end; }
#landing .lookView .steps { display: flex; gap: 4px; }
#landing .lookView .steps button { padding: 4px 14px; font-size: 15px; letter-spacing: 0; }
#landing .lookView .dyes { display: flex; gap: 4px; }
#landing .lookView .dyes button { width: 18px; height: 18px; padding: 0; border-radius: 2px; border: 1px solid rgba(255, 244, 208, .35); }
#landing .lookView .dyes button.on, #landing .lookView .dyes button:hover { border: 2px solid #fff4d0; }
`;

const DYED: Partial<Record<LookKey, DyeSlot>> = { robe: 'robe', cloak: 'cloak', wrap: 'wrap' };

/** `join`: character creation for a game, `go` joins it once the name will do; `flag` says at once what's wrong
 *  with the name (the game turned it away). */
export function lookView(back: () => void, join?: { go: () => void; flag?: boolean }): HTMLElement {
  if (!document.getElementById('lookStyle')) {
    const style = document.createElement('style');
    style.id = 'lookStyle';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const el = document.createElement('div');
  el.className = 'lookView';
  el.innerHTML = `<div class="body"><canvas></canvas><div class="slots"></div></div>
<div class="buttons"><button class="dice">${TEXT.landing.randomColour}</button><button class="save">${join ? TEXT.landing.join : TEXT.look.save}</button><button class="back">${TEXT.landing.back}</button></div>`;
  const canvas = el.querySelector('canvas')!;
  const slots = el.querySelector<HTMLElement>('.slots')!;
  let look = unpackLook(myLook());
  const model = new ScavengerModel(myColor());

  const rows: (() => void)[] = [];
  const changed = () => {
    const n = packLook(look);
    model.setLook(n);
    for (const r of rows) r();
  };
  // the pieces, then the dyes
  for (const slot of [...LOOK_SLOTS].sort((a, b) => Number(!!DYED[a.key]) - Number(!!DYED[b.key]))) {
    const row = document.createElement('div');
    row.className = 'slot';
    row.innerHTML = `<span class="label">${TEXT.look.slots[slot.key]}</span>`;
    const dye = DYED[slot.key];
    const n = slot.options.length;
    if (dye) {
      const box = document.createElement('div');
      box.className = 'dyes';
      // the same palette in the same order on every dyed slot
      const swatches = DYE_COLORS.map((c, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.style.background = `#${c.toString(16).padStart(6, '0')}`;
        b.addEventListener('click', () => ((look[slot.key] = dyeChoice(dye, i)), changed()));
        box.append(b);
        return b;
      });
      rows.push(() => swatches.forEach((b, i) => b.classList.toggle('on', i === dyeIndex(look, dye))));
      row.append(box);
    } else {
      const steps = document.createElement('div');
      steps.className = 'steps';
      steps.innerHTML = `<button type="button">${TEXT.look.prev}</button><button type="button">${TEXT.look.next}</button>`;
      const [prev, next] = steps.querySelectorAll('button');
      prev.addEventListener('click', () => ((look[slot.key] = (look[slot.key] + n - 1) % n), changed()));
      next.addEventListener('click', () => ((look[slot.key] = (look[slot.key] + 1) % n), changed()));
      row.append(steps);
    }
    slots.append(row);
  }
  for (const r of rows) r();
  el.querySelector('.dice')!.addEventListener('click', () => {
    for (const s of LOOK_SLOTS) look[s.key] = Math.floor(Math.random() * s.options.length);
    changed();
  });
  const save = el.querySelector<HTMLButtonElement>('.save')!;
  const profile = join && profileForm((ok) => (save.disabled = !ok));
  if (profile) {
    el.insertBefore(profile.el, el.querySelector('.buttons'));
    // the colour on the figure as it's picked (the form keeps it before its events reach here)
    const recolor = () => model.setColor(myColor());
    profile.el.addEventListener('input', recolor);
    profile.el.addEventListener('click', recolor);
    if (join.flag) queueMicrotask(() => profile.flag());
  }
  save.addEventListener('click', () => {
    if (profile && !profile.flag()) return;
    setMyLook(packLook(look));
    if (join) join.go();
    else back();
  });
  el.querySelector('.back')!.addEventListener('click', back);
  stage(canvas, model, () => model.setLook(packLook(look)), () => bodyScale(look));
  return el;
}

/** The figure: its own renderer on `canvas`, until the canvas leaves the page. */
function stage(canvas: HTMLCanvasElement, model: ScavengerModel, ready: () => void, size: () => { height: number; head: number }) {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xf2c08a, 0x5a2a14, 1.8));
  const sun = new THREE.DirectionalLight(0xffc68a, 3.6); // low and warm, from the front left
  sun.position.set(-3, 2.2, 4);
  const rim = new THREE.DirectionalLight(0xff9a50, 2.0); // the sky behind, on the edges
  rim.position.set(3, 3, -4);
  scene.add(sun, rim);
  const camera = new THREE.PerspectiveCamera(26, 0.7, 0.1, 50);
  scene.add(model.root);
  let yaw = 0.45;
  let spin = 0.12; // rad/s, until it's dragged
  // Zoom: 0 the whole figure .. 1 the head and shoulders; eased towards `zoomTo`.
  let zoom = 0, zoomTo = 0;
  // The figure's proportions (shared/look.ts bodyScale), eased: the framing follows a body or head drawn bigger.
  let height = 1, head = 1;
  const zoomBy = (d: number) => (zoomTo = Math.min(1, Math.max(0, zoomTo + d)));
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomBy(-e.deltaY * 0.0015);
  }, { passive: false });
  // One pointer turns the figure, two pinch.
  const down = new Map<number, number[]>();
  let pinch = 0;
  const spread = () => {
    const [a, b] = [...down.values()];
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  };
  canvas.addEventListener('pointerdown', (e) => {
    down.set(e.pointerId, [e.clientX, e.clientY]);
    spin = 0;
    canvas.setPointerCapture(e.pointerId);
    if (down.size === 2) pinch = spread();
  });
  canvas.addEventListener('pointermove', (e) => {
    const was = down.get(e.pointerId);
    if (!was) return;
    if (down.size === 1) yaw += (e.clientX - was[0]) * 0.012;
    down.set(e.pointerId, [e.clientX, e.clientY]);
    if (down.size === 2) {
      const now = spread();
      zoomBy((now - pinch) * 0.004);
      pinch = now;
    }
  });
  const up = (e: PointerEvent) => down.delete(e.pointerId);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  model.ready.then(ready, () => {});
  const timer = new THREE.Timer();
  const stop = () => {
    renderer.setAnimationLoop(null);
    model.dispose();
    renderer.dispose();
  };
  renderer.init().then(() => {
    if (!canvas.isConnected) return stop();
    renderer.setAnimationLoop((time) => {
      if (!canvas.isConnected) return stop();
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * renderer.getPixelRatio())) {
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      timer.update(time);
      const dt = Math.min(timer.getDelta(), 0.1);
      yaw += spin * dt;
      zoom += (zoomTo - zoom) * Math.min(1, dt * 10);
      const z = zoom * zoom * (3 - 2 * zoom);
      const want = size();
      height += (want.height - height) * Math.min(1, dt * 8);
      head += (want.head - head) * Math.min(1, dt * 8);
      // whole figure from 4.6 m, looking at its middle; the head and shoulders from 1.3 m, looking at the face,
      // wherever it is and however big. A figure drawn taller backs the camera off only partly and raises the
      // view to keep the head in, so it fills more of the frame (and a small one less): the size reads.
      const top = 1.85 * height * (1 + 0.17 * (head - 1));
      const fit = Math.max(1, 1 + (top / 1.85 - 1) * 0.6);
      const mid = Math.max(0.92, top + 0.06 - 1.06 * fit); // 1.06: half the view's height at 4.6 m
      const face = (1.62 + 0.1 * (head - 1)) * height, near = 1.3 * height * head;
      camera.position.set(0, mid + 0.13 * fit + (face - 0.02 - mid - 0.13 * fit) * z, 4.6 * fit + (near - 4.6 * fit) * z);
      camera.lookAt(0, mid + (face - mid) * z, 0);
      model.root.rotation.y = Math.PI + yaw;
      model.update({ speed: 0, grounded: true, plant: false }, dt);
      renderer.render(scene, camera);
    });
  }, () => canvas.remove());
}
