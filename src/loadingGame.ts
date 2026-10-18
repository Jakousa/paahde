// The loading screen's game: a scavenger running the dunes, one button (click, tap, Space, W or Up) to jump scrap
// piles and grab water drops. It lives in the #cover from index.html, starts from src/entry.ts before the big game
// bundle has even downloaded, and is stopped by src/main.ts when the cover leaves. Plain canvas 2D, nothing loaded.
const W = 520;
const H = 170;
const GROUND = 134; // y of the sand line
const GRAVITY = 2000;
const JUMP_V = 640;
const BEST_KEY = 'dadajam.runner';

type Pile = { x: number; w: number; h: number; seed: number };
type Drop = { x: number; y: number; got: boolean };

let canvas: HTMLCanvasElement | null = null;
let raf = 0;
let off: (() => void) | null = null;

function best(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

function start() {
  const cover = document.getElementById('cover');
  if (!cover || canvas) return;
  const c = (canvas = document.createElement('canvas'));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = W * dpr;
  c.height = H * dpr;
  c.style.cssText = `width:min(${W}px,92vw);aspect-ratio:${W}/${H};touch-action:manipulation;cursor:pointer;`;
  cover.prepend(c);
  cover.style.pointerEvents = 'auto';
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);

  let state: 'idle' | 'run' | 'dead' = 'idle';
  let t = 0; // seconds since the start of the run
  let deadFor = 0;
  let dist = 0; // px run
  let speed = 230;
  let y = 0; // height above the sand
  let vy = 0;
  let held = false;
  let piles: Pile[] = [];
  let drops: Drop[] = [];
  let bonus = 0;
  let nextAt = 0; // dist at which the next pile spawns
  let top = best();
  let rand = 1;
  const rnd = () => ((rand = (rand * 16807) % 2147483647) / 2147483647);

  const reset = () => {
    state = 'run';
    t = dist = bonus = y = vy = 0;
    speed = 230;
    piles = [];
    drops = [];
    nextAt = 420;
  };
  const press = () => {
    held = true;
    if (state === 'idle' || (state === 'dead' && deadFor > 0.5)) return reset();
    if (state === 'run' && y === 0) vy = JUMP_V;
  };
  const release = () => {
    held = false;
    if (vy > JUMP_V * 0.45) vy = JUMP_V * 0.45; // let go early: a short hop
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.code !== 'Space' && e.code !== 'ArrowUp' && e.code !== 'KeyW') return;
    e.preventDefault();
    if (!e.repeat) press();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') release();
  };
  const onDown = (e: PointerEvent) => {
    e.preventDefault();
    press();
  };
  const onUp = () => release();
  addEventListener('keydown', onKey);
  addEventListener('keyup', onKeyUp);
  cover.addEventListener('pointerdown', onDown);
  addEventListener('pointerup', onUp);

  const score = () => Math.floor(dist / 20) + bonus;

  const update = (dt: number) => {
    if (state === 'dead') {
      deadFor += dt;
      return;
    }
    const v = state === 'idle' ? 70 : speed;
    dist += v * dt;
    if (state === 'idle') return;
    t += dt;
    speed = 230 + Math.min(220, t * 6);
    vy -= GRAVITY * (held || vy < 0 ? 1 : 1.5) * dt;
    y = Math.max(0, y + vy * dt);
    if (y === 0) vy = 0;
    while (dist > nextAt) {
      const w = 24 + rnd() * 26;
      const h = 18 + rnd() * 20;
      piles.push({ x: nextAt + W, w, h, seed: rnd() });
      // A water drop hangs above the pile now and then, at the top of a jump.
      if (rnd() < 0.45) drops.push({ x: nextAt + W + w / 2, y: 62 + rnd() * 18, got: false });
      nextAt += speed * 0.95 + 80 + rnd() * 240;
    }
    piles = piles.filter((p) => p.x - dist > -80);
    drops = drops.filter((d) => d.x - dist > -40);
    const px = 70; // the runner's x on screen
    for (const p of piles) {
      const sx = p.x - dist;
      if (sx < px + 9 && sx + p.w > px - 9 && y < p.h - 3) {
        state = 'dead';
        deadFor = 0;
        vy = 0;
        const s = score();
        if (s > top) {
          top = s;
          try {
            localStorage.setItem(BEST_KEY, String(s));
          } catch {}
        }
      }
    }
    for (const d of drops) {
      if (!d.got && Math.abs(d.x - dist - px) < 14 && Math.abs(GROUND - y - 20 - d.y) < 22) {
        d.got = true;
        bonus += 5;
      }
    }
  };

  // Soft rolling dune line, wrapping every `period` px.
  const dunes = (shift: number, base: number, amp: number, color: string) => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) g.lineTo(x, base - amp * (Math.sin((x + shift) / 70) * 0.6 + Math.sin((x + shift) / 31) * 0.4));
    g.lineTo(W, H);
    g.fill();
  };

  const runner = (px: number) => {
    const leg = state === 'run' && y === 0 ? Math.sin(t * speed * 0.045) * 6 : 0;
    const gy = GROUND - y;
    g.save();
    g.translate(px, gy);
    if (state === 'dead') {
      g.rotate(-1.35);
      g.translate(0, 4);
    }
    g.fillStyle = '#1a1612';
    g.fillRect(-4 + leg, -10, 4, 10); // legs
    g.fillRect(1 - leg, -10, 4, 10);
    g.fillStyle = '#c9a878';
    g.fillRect(-6, -28, 12, 19); // coat
    g.fillStyle = '#8a6a44';
    g.fillRect(-6, -14, 12, 3);
    g.fillStyle = '#e8d3a8';
    g.fillRect(-4, -36, 9, 9); // head, wrapped
    g.fillStyle = '#111';
    g.fillRect(1, -33, 4, 2); // goggles
    g.fillStyle = '#b4472b';
    const flap = Math.sin(t * 14) * 2;
    g.fillRect(-14, -31 + flap * 0.5, 9, 3); // scarf trailing behind
    g.fillRect(-19, -30 + flap, 6, 2);
    g.restore();
  };

  const draw = () => {
    g.clearRect(0, 0, W, H);
    // sun
    g.fillStyle = '#3a2a1c';
    g.beginPath();
    g.arc(410, 56, 26, 0, 7);
    g.fill();
    dunes(dist * 0.15, 118, 16, '#2a2018');
    dunes(dist * 0.4 + 90, 130, 10, '#3b2d1f');
    g.fillStyle = '#c9a878';
    g.fillRect(0, GROUND, W, 2);
    g.fillStyle = '#6e5538';
    g.fillRect(0, GROUND + 2, W, H);
    // sand flecks at ground speed
    g.fillStyle = '#8a6a44';
    for (let i = 0; i < 14; i++) g.fillRect(((i * 97 - dist) % W + W) % W, GROUND + 8 + (i % 4) * 7, 8, 1);

    for (const p of piles) {
      const sx = p.x - dist;
      g.fillStyle = '#4a3a2a';
      g.beginPath();
      g.moveTo(sx, GROUND);
      g.lineTo(sx + p.w * 0.15, GROUND - p.h * 0.7);
      g.lineTo(sx + p.w * 0.4, GROUND - p.h);
      g.lineTo(sx + p.w * (0.55 + p.seed * 0.1), GROUND - p.h * 0.55);
      g.lineTo(sx + p.w * 0.85, GROUND - p.h * 0.8);
      g.lineTo(sx + p.w, GROUND);
      g.fill();
      g.fillStyle = '#8a8f93'; // a bright plate in it
      g.fillRect(sx + p.w * 0.3, GROUND - p.h * 0.9, p.w * 0.3, 2);
      g.fillStyle = '#b4472b';
      g.fillRect(sx + p.w * 0.6, GROUND - p.h * 0.45, 5, 2);
    }
    for (const d of drops) {
      if (d.got) continue;
      const sx = d.x - dist;
      const bob = Math.sin(performance.now() / 300 + d.x) * 2;
      g.fillStyle = '#8fc8d8';
      g.beginPath();
      g.moveTo(sx, d.y - 8 + bob);
      g.quadraticCurveTo(sx + 6, d.y + 1 + bob, sx, d.y + 5 + bob);
      g.quadraticCurveTo(sx - 6, d.y + 1 + bob, sx, d.y - 8 + bob);
      g.fill();
    }
    runner(70);

    g.fillStyle = '#c9a878';
    g.font = '13px ui-monospace, Menlo, Consolas, monospace';
    g.textAlign = 'right';
    if (state !== 'idle') g.fillText(String(score()), W - 12, 20);
    if (top) {
      g.fillStyle = '#6e5538';
      g.fillText(String(top), W - 12, state === 'idle' ? 20 : 36);
    }
    if (state === 'idle' && Math.floor(performance.now() / 500) % 2 === 0) {
      // a little arrow over the runner: press to go
      g.fillStyle = '#c9a878';
      g.beginPath();
      g.moveTo(70, 58);
      g.lineTo(64, 50);
      g.lineTo(76, 50);
      g.fill();
    }
  };

  let last = performance.now();
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000); // the page stalls while the game compiles: don't leap
    last = now;
    update(dt);
    draw();
  };
  raf = requestAnimationFrame(frame);

  off = () => {
    removeEventListener('keydown', onKey);
    removeEventListener('keyup', onKeyUp);
    removeEventListener('pointerup', onUp);
    cover.removeEventListener('pointerdown', onDown);
  };
}

function stop() {
  cancelAnimationFrame(raf);
  off?.();
  off = null;
  canvas?.remove();
  canvas = null;
}

export const loading = { start, stop };
