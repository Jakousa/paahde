// The landing page (no world in the URL) and the end screens over the game (game over, unknown world):
// a title and one button that makes a new world (server/index.ts /api/worlds) and shows its link to copy
// and share, and to join from. Also the victory screen (every boss beaten), which goes away again: the
// world plays on.

const css = `
#landing { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; color: #e8d2ae;
  background: #4a2414 url(./landing.jpg) center 70% / cover; font-family: var(--mono); }
#landing.over { background: rgba(17, 10, 6, 0.82); }
#landing .panel { display: grid; justify-items: center; gap: 22px; text-align: center; padding: 16px;
  transform: translateY(-18vh); }
#landing h1 { margin: 0; font-size: 64px; font-weight: 400; letter-spacing: .3em; color: #fff4d0;
  text-shadow: 0 0 24px rgba(140, 50, 10, .6), 0 2px 2px rgba(60, 20, 5, .5); }
#landing p { margin: 0; font-size: 14px; color: #fff4d0; text-shadow: 0 1px 2px rgba(60, 20, 5, .6); }
#landing .link { display: flex; gap: 0; }
#landing input { font: 15px var(--mono); width: min(64vw, 380px); padding: 10px 12px; border: 0; border-radius: 2px 0 0 2px;
  color: #2a120a; background: #fff4d0; outline: none; }
#landing .link button { border-radius: 0 2px 2px 0; }
#landing button { font: 15px var(--mono); padding: 10px 26px; color: #fff4d0; background: #2a120a; border: 0;
  border-radius: 2px; cursor: pointer; letter-spacing: .1em; }
#landing button:hover { background: #4a2414; }
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
  el.innerHTML = `<div class="panel"><h1>hiekka</h1>${line ? `<p>${line}</p>` : ''}<button>Start a new game</button></div>`;
  document.body.append(el);
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
