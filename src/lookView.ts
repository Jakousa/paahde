// The character view on the main menu (src/landing.ts): your scavenger turning slowly in the warm light, and beside it
// a row per slot of the look (shared/look.ts): arrows step through a slot's pieces, swatches pick a dye. Every change
// is kept at once (src/profile.ts setMyLook) and goes with your next join. Drag the figure to turn it; the dice picks a
// whole look at random. The figure has its own small renderer, gone with the view.
import * as THREE from 'three/webgpu';
import { DYES, LOOK_SLOTS, type LookKey, packLook, unpackLook } from '../shared/look.ts';
import { TEXT } from '../shared/text.ts';
import { ScavengerModel } from './models/scavenger';
import { myColor, myLook, setMyLook } from './profile';

const CSS = `
#landing .lookView { display: grid; gap: 16px; justify-items: center; }
#landing .lookView .body { display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: center; justify-content: center; }
#landing .lookView canvas { width: min(64vw, 280px); height: min(92vw, 400px); cursor: grab; touch-action: none; }
#landing .lookView canvas:active { cursor: grabbing; }
#landing .lookView .slots { display: grid; gap: 6px; }
#landing .lookView .slot { display: grid; grid-template-columns: 7.5em auto; gap: 10px; align-items: center; justify-items: start; }
#landing .lookView .slot .label { font: 11px var(--mono); letter-spacing: .15em; text-transform: uppercase; opacity: .85; text-align: right; justify-self: end; }
#landing .lookView .steps { display: flex; gap: 4px; }
#landing .lookView .steps button { padding: 4px 14px; font-size: 15px; letter-spacing: 0; }
#landing .lookView .dyes { display: flex; gap: 4px; }
#landing .lookView .dyes button { width: 20px; height: 20px; padding: 0; border-radius: 2px; border: 1px solid rgba(255, 244, 208, .35); }
#landing .lookView .dyes button.on, #landing .lookView .dyes button:hover { border: 2px solid #fff4d0; }
`;

const DYED: Partial<Record<LookKey, keyof typeof DYES>> = { robe: 'robe', cloak: 'cloak', wrap: 'wrap' };

export function lookView(back: () => void): HTMLElement {
  if (!document.getElementById('lookStyle')) {
    const style = document.createElement('style');
    style.id = 'lookStyle';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const el = document.createElement('div');
  el.className = 'lookView';
  el.innerHTML = `<div class="body"><canvas></canvas><div class="slots"></div></div>
<div class="buttons"><button class="dice">${TEXT.landing.randomColour}</button><button class="back">${TEXT.landing.back}</button></div>`;
  const canvas = el.querySelector('canvas')!;
  const slots = el.querySelector<HTMLElement>('.slots')!;
  let look = unpackLook(myLook());
  const model = new ScavengerModel(myColor());

  const rows: (() => void)[] = [];
  const changed = () => {
    const n = packLook(look);
    setMyLook(n);
    model.setLook(n);
    for (const r of rows) r();
  };
  for (const slot of LOOK_SLOTS) {
    const row = document.createElement('div');
    row.className = 'slot';
    row.innerHTML = `<span class="label">${TEXT.look.slots[slot.key]}</span>`;
    const dye = DYED[slot.key];
    const n = slot.options.length;
    if (dye) {
      const box = document.createElement('div');
      box.className = 'dyes';
      const swatches = DYES[dye].map((c, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.style.background = `#${c.toString(16).padStart(6, '0')}`;
        b.addEventListener('click', () => ((look[slot.key] = i), changed()));
        box.append(b);
        return b;
      });
      rows.push(() => swatches.forEach((b, i) => b.classList.toggle('on', i === look[slot.key])));
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
  el.querySelector('.back')!.addEventListener('click', back);
  stage(canvas, model, () => model.setLook(packLook(look)));
  return el;
}

/** The figure: its own renderer on `canvas`, until the canvas leaves the page. */
function stage(canvas: HTMLCanvasElement, model: ScavengerModel, ready: () => void) {
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
  camera.position.set(0, 1.05, 4.6);
  camera.lookAt(0, 0.92, 0);
  scene.add(model.root);
  let yaw = 0.45;
  let spin = 0.12; // rad/s, until it's dragged
  let drag: number | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = e.clientX;
    spin = 0;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag === null) return;
    yaw += (e.clientX - drag) * 0.012;
    drag = e.clientX;
  });
  canvas.addEventListener('pointerup', () => (drag = null));
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
      model.root.rotation.y = Math.PI + yaw;
      model.update({ speed: 0, grounded: true, plant: false }, dt);
      renderer.render(scene, camera);
    });
  }, () => canvas.remove());
}
