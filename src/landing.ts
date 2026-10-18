// The landing page (no world in the URL) and the end screens over the game (game over, unknown world):
// a title and one button that makes a new world (server/index.ts /api/worlds) and goes to its URL. Also the
// victory screen (every boss beaten), which goes away again: the world plays on.

const css = `
#landing { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; color: #e8d2ae;
  background: radial-gradient(ellipse at 50% 120%, #c46a24 0%, #4a2414 45%, #111 85%); font-family: var(--mono); }
#landing.over { background: rgba(17, 10, 6, 0.82); }
#landing .panel { display: grid; justify-items: center; gap: 22px; text-align: center; padding: 16px; }
#landing h1 { margin: 0; font-size: 44px; font-weight: 400; letter-spacing: .3em; color: #ffb24a; }
#landing p { margin: 0; font-size: 14px; color: #c9a878; }
#landing button { font: 15px var(--mono); padding: 10px 26px; color: #111; background: #e8902e; border: 0;
  border-radius: 2px; cursor: pointer; letter-spacing: .1em; }
#landing button:hover { background: #ffb24a; }
#landing button:disabled { opacity: .5; cursor: default; }
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
  el.innerHTML = `<div class="panel"><h1>dadajam</h1>${line ? `<p>${line}</p>` : ''}<button>New world</button></div>`;
  document.body.append(el);
  const button = el.querySelector('button')!;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const res = await fetch('api/worlds', { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      const { id } = (await res.json()) as { id: string };
      location.assign(`${location.pathname}?w=${id}`);
    } catch {
      button.disabled = false;
    }
  });
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
  el.innerHTML = '<div class="panel"><h1>dadajam</h1><p>The desert is yours</p><button>Play on</button></div>';
  document.body.append(el);
  el.querySelector('button')!.addEventListener('click', () => {
    el.remove();
    style.remove();
    Promise.resolve(document.querySelector('canvas')?.requestPointerLock()).catch(() => {});
  });
}
