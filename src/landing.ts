// The landing page (no world in the URL) and the end screens over the game (game over, unknown world):
// a title and one button that makes a new world (server/index.ts /api/worlds) and shows its link to copy
// and share, and to join from. Also the victory screen (every boss beaten), which goes away again: the
// world plays on.

const css = `
#landing { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; color: #e8d2ae;
  background: #4a2414; font-family: var(--mono); overflow: hidden; }
#landing .bg { position: absolute; inset: -3%; background: url(./landing.jpg) center 70% / cover;
  filter: contrast(1.08) saturate(1.04) brightness(.95); animation: landing-drift 60s ease-in-out infinite alternate; }
#landing .shade { position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(180deg, rgba(43, 34, 38, .55) 0%, rgba(43, 34, 38, 0) 45%),
    radial-gradient(ellipse 75% 65% at 50% 55%, transparent 55%, rgba(42, 18, 10, .55) 100%); }
#landing canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
#landing.over .bg, #landing.over .shade { display: none; }
#landing.over { background: rgba(17, 10, 6, 0.82); }
#landing .panel { position: relative; display: grid; justify-items: center; gap: 30px; text-align: center; padding: 16px;
  transform: translateY(-18vh); animation: landing-in 1.6s ease-out both; }
#landing h1 { margin: 0; font-size: clamp(40px, 7vw, 88px); font-weight: 300; letter-spacing: .38em;
  margin-right: -.38em; color: #fff4d0;
  text-shadow: 0 0 40px rgba(255, 179, 71, .45), 0 0 12px rgba(140, 50, 10, .5), 0 2px 3px rgba(60, 20, 5, .45); }
#landing p { margin: 0; font-size: 14px; letter-spacing: .2em; color: #fff4d0; text-shadow: 0 1px 2px rgba(60, 20, 5, .6); }
#landing .link { display: flex; gap: 0; }
#landing input { font: 14px var(--mono); width: min(64vw, 380px); padding: 12px 14px; border: 1px solid rgba(255, 244, 208, .5);
  border-right: 0; border-radius: 2px 0 0 2px; color: #2a120a; background: rgba(255, 244, 208, .92); outline: none; }
#landing .link button { border-radius: 0 2px 2px 0; }
#landing button { font: 13px var(--mono); padding: 12px 30px; color: #fff4d0; background: rgba(42, 18, 10, .55);
  border: 1px solid rgba(255, 244, 208, .45); border-radius: 2px; cursor: pointer; letter-spacing: .3em;
  text-transform: uppercase; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  transition: background .25s, border-color .25s, color .25s; }
#landing button:hover { background: rgba(255, 244, 208, .92); border-color: #fff4d0; color: #2a120a; }
#landing button:disabled { opacity: .5; cursor: default; }
@keyframes landing-drift { from { transform: scale(1) translateX(0); } to { transform: scale(1.06) translateX(-1.5%); } }
@keyframes landing-in { from { opacity: 0; transform: translateY(calc(-18vh + 12px)); } }
@media (prefers-reduced-motion: reduce) { #landing .bg, #landing .panel { animation: none; } }
`;

/** Show the page; `why` puts it over the game as an end screen. */
export function landing(why?: 'over' | 'missing') {
  if (document.getElementById('landing')) return;
  document.exitPointerLock?.();
  document.getElementById('cover')?.remove();
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const el = document.createElement('div');
  el.id = 'landing';
  if (why) el.className = 'over';
  const line = why === 'over' ? 'Game over' : why === 'missing' ? 'No such world' : '';
  el.innerHTML = `${why ? '' : '<div class="bg"></div><div class="shade"></div>'}<div class="panel"><h1>hiekka</h1>${line ? `<p>${line}</p>` : ''}<button>Start a new game</button></div>`;
  document.body.append(el);
  if (!why) blowingSand(el);
  const button = el.querySelector('button')!;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const res = await fetch('api/worlds', { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      const { id } = (await res.json()) as { id: string };
      shareLink(el, `${location.origin}${location.pathname}?w=${id}`);
    } catch {
      button.disabled = false;
    }
  });
}

/** Sand blowing across the picture on a canvas under the panel: soft veils of it low over the dunes and
 * fine grains, coming in gusts. Stops once the page is gone. */
function blowingSand(el: HTMLElement) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  el.insertBefore(canvas, el.querySelector('.panel'));
  const g = canvas.getContext('2d')!;
  // Veils: wide flat clouds of sand along the ground (y and sizes are fractions of the screen height).
  const veils = Array.from({ length: 16 }, () => ({ x: 0, y: 0, rx: 0, ry: 0, speed: 0, alpha: 0, phase: 0 }));
  const grains = Array.from({ length: 220 }, () => ({ x: 0, y: 0, len: 0, speed: 0, alpha: 0, phase: 0 }));
  const placeVeil = (v: (typeof veils)[number], anywhere: boolean) => {
    v.y = 0.47 + 0.45 * Math.random();
    const near = (v.y - 0.4) / 0.6; // lower on the screen = closer = bigger and faster
    v.rx = (0.25 + 0.5 * Math.random()) * (0.5 + near);
    v.ry = v.rx * (0.08 + 0.08 * Math.random());
    v.x = anywhere ? Math.random() * 2 - 0.5 : -v.rx * 1.2;
    v.speed = 0.04 + 0.1 * near;
    v.alpha = 0.06 + 0.1 * Math.random();
    v.phase = Math.random() * 6.28;
  };
  const placeGrain = (p: (typeof grains)[number], anywhere: boolean) => {
    p.x = anywhere ? Math.random() * 2 : -0.05;
    p.y = 0.46 + 0.54 * Math.pow(Math.random(), 0.8);
    const near = (p.y - 0.4) / 0.6;
    p.speed = 0.12 + 0.35 * near * (0.6 + Math.random() * 0.8);
    p.len = 1 + 12 * near * Math.random();
    p.alpha = 0.06 + 0.22 * near * Math.random();
    p.phase = Math.random() * 6.28;
  };
  for (const v of veils) placeVeil(v, true);
  for (const p of grains) placeGrain(p, true);
  let w = 0;
  let h = 0;
  let last = performance.now();
  const frame = (now: number) => {
    if (!el.isConnected) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const dpr = Math.min(devicePixelRatio, 2);
    if (w !== innerWidth * dpr || h !== innerHeight * dpr) {
      w = canvas.width = innerWidth * dpr;
      h = canvas.height = innerHeight * dpr;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    const t = now / 1000;
    const gust = 0.55 + 0.45 * Math.sin(t * 0.37) * Math.sin(t * 0.13 + 1); // 0.1..1
    // x is in screen heights so shapes keep their proportions on any aspect ratio.
    const aspect = w / h;
    for (const v of veils) {
      v.x += v.speed * (0.4 + gust) * dt;
      if (v.x - v.rx > aspect) placeVeil(v, false);
      const y = v.y + 0.006 * Math.sin(t * 0.5 + v.phase);
      g.setTransform(v.rx * h, 0, 0, v.ry * h, v.x * h, y * h);
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      const a = v.alpha * (0.4 + 0.6 * gust);
      grad.addColorStop(0, `rgba(250, 196, 120, ${a})`);
      grad.addColorStop(0.5, `rgba(240, 170, 90, ${a * 0.5})`);
      grad.addColorStop(1, 'rgba(240, 170, 90, 0)');
      g.fillStyle = grad;
      g.fillRect(-1, -1, 2, 2);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.lineCap = 'round';
    for (const p of grains) {
      p.x += p.speed * (0.3 + gust) * dt;
      if (p.x > aspect + 0.05) placeGrain(p, false);
      const y = (p.y + 0.01 * Math.sin(t * 2 + p.phase + p.x * 7)) * h;
      const len = p.len * (0.3 + gust) * dpr;
      g.strokeStyle = `rgba(255, 232, 190, ${p.alpha * (0.4 + 0.6 * gust)})`;
      g.lineWidth = dpr * (0.6 + 0.6 * Math.random());
      g.beginPath();
      g.moveTo(p.x * h, y);
      g.lineTo(p.x * h - len, y + len * 0.08);
      g.stroke();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** The new world's link in place of the button: copy it to share, Join to go there yourself. */
function shareLink(el: HTMLElement, url: string) {
  const p = el.querySelector('p');
  el.querySelector('.panel > button')!.remove();
  p?.remove();
  const row = document.createElement('div');
  row.className = 'link';
  row.innerHTML = '<input readonly><button>Copy</button>';
  const join = document.createElement('button');
  join.textContent = 'Join';
  el.querySelector('.panel')!.append(row, join);
  const input = row.querySelector('input')!;
  const copy = row.querySelector('button')!;
  input.value = url;
  input.addEventListener('focus', () => input.select());
  input.focus();
  copy.addEventListener('click', async () => {
    input.select();
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      document.execCommand('copy');
    }
    copy.textContent = 'Copied';
  });
  join.addEventListener('click', () => location.assign(url));
}

/** Every boss kind is beaten (shared/bosses.ts allBeaten): say so once per world on this browser, then play on. */
export function victory(world: string) {
  const key = `dadajam.won.${world}`;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
  } catch {}
  if (document.getElementById('landing')) return;
  document.exitPointerLock?.();
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const el = document.createElement('div');
  el.id = 'landing';
  el.className = 'over';
  el.innerHTML = '<div class="panel"><h1>hiekka</h1><p>The desert is yours</p><button>Play on</button></div>';
  document.body.append(el);
  el.querySelector('button')!.addEventListener('click', () => {
    el.remove();
    style.remove();
    Promise.resolve(document.querySelector('canvas')?.requestPointerLock()).catch(() => {});
  });
}
