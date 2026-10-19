// The loading cover's picture: sand dust blown through a slowly turning flow field on the dark, the prologue's
// paragraphs fading in over it a letter at a time, then the title card, and a hairline loading bar. On a reload
// in the same tab (src/prologue.ts) only the title comes up.
// Plain canvas 2D that knows nothing of the page: it runs in a worker (src/prologueWorker.ts, src/prologue.ts)
// because the main thread is busy building the world while this is up.
import { TEXT } from '../shared/text.ts';

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** Neuropol (public/fonts), loaded by whoever runs this (src/prologueWorker.ts, index.html); `relayout` once it's in. */
export const FONT_URL = './fonts/neuropol.woff2';
const FONT = 'Neuropol, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const INK = '236, 228, 210'; // the prologue's warm white (rgb, for alpha)
const GOLD = '217, 178, 106';
/** Dust colours: whites, pale golds, yellows and ochres; the fine haze and the far layer are dim, the near one bright. */
const LAYERS = [
  { share: 0.3, speed: 15, width: 0.28, colors: ['rgba(196,164,112,.4)', 'rgba(222,200,160,.35)', 'rgba(168,132,80,.45)', 'rgba(240,228,204,.3)'] },
  { share: 0.39, speed: 11, width: 0.45, colors: ['rgba(122,92,48,.55)', 'rgba(150,118,62,.5)', 'rgba(104,80,46,.6)', 'rgba(170,150,120,.4)'] },
  { share: 0.23, speed: 16, width: 0.65, colors: ['rgba(214,170,84,.6)', 'rgba(232,196,110,.55)', 'rgba(190,138,62,.6)', 'rgba(240,226,196,.45)'] },
  { share: 0.08, speed: 26, width: 0.9, colors: ['rgba(246,214,128,.75)', 'rgba(255,240,206,.7)', 'rgba(228,180,92,.75)', 'rgba(255,250,236,.65)'] },
];
const MAX_PIXELS = 4.2e6; // the visible canvas's backing store, at most (about 2560x1600)
const TRAIL_PIXELS = 2.2e6; // the dust's own canvas: soft anyway, so cheaper
const FADE = 0.1; // how much of the dust's trails fades per frame (at 60 fps)

// The prologue's timeline (s): each paragraph starts, then they all go and the card comes up and stays.
const PARA_AT = [1, 5.4, 10];
const OUT_AT = 16;
const CARD_AT = 17.6;
/** When the full prologue has been told: the cover stays up at least this long on a tab's first load. */
export const PROLOGUE_S = CARD_AT + 4;
const TITLE_AT = 0.4; // the title alone, on a reload
const CHAR_S = 0.022; // the letters' stagger
const LETTER_S = 0.9; // one letter's fade in

/** `full`: the whole prologue; otherwise only the title. */
export function createPrologue(g: Ctx, makeCanvas: (w: number, h: number) => OffscreenCanvas | HTMLCanvasElement, full = true) {
  let w = 1;
  let h = 1;
  let dpr = 1;
  let trail = makeCanvas(1, 1);
  let tg = trail.getContext('2d') as Ctx;
  let ts = 1; // trail pixels per css px
  let bg: CanvasGradient | null = null;
  let vignette: CanvasGradient | null = null;

  let clock = 0;
  let target = 0; // loading progress asked for, and the eased value drawn
  let shown = 0;
  let rand = 11;
  const rnd = () => ((rand = (rand * 16807) % 2147483647) / 2147483647);

  // Particles: position, previous position, layer, and the stroke bucket (layer x colour) they're drawn in.
  let n = 0;
  let px = new Float32Array(0);
  let py = new Float32Array(0);
  let ox = new Float32Array(0);
  let oy = new Float32Array(0);
  let layer = new Uint8Array(0);
  let twinkle = new Float32Array(0); // a phase; the near layer's grains glint now and then
  let pace = new Float32Array(0); // each grain's own speed, so they don't move as one sheet
  let buckets: Int32Array[] = [];

  // Text laid out for the current size: each line's letters with their x from the line's start.
  type Line = { s: string; xs: number[] };
  let size = 15;
  let big = 27;
  let lineH = 28;
  let paras: { lines: Line[]; y: number }[] = [];
  let title: Line & { x: number } = { s: '', xs: [], x: 0 };
  let time: Line & { x: number } = { s: '', xs: [], x: 0 };
  let blockX = 0;
  let blockTop = 0;
  let blockBottom = 0;

  function spawn(i: number, anywhere: boolean) {
    px[i] = anywhere ? rnd() * w : -rnd() * 40;
    py[i] = rnd() * h;
    ox[i] = px[i];
    oy[i] = py[i];
  }

  /** A line's letters placed in the current font, `spacing` px apart past their own widths, and its width. */
  function line(s: string, spacing: number): Line & { width: number } {
    const xs: number[] = [];
    for (let k = 0; k < s.length; k++) xs.push(g.measureText(s.slice(0, k)).width + k * spacing);
    return { s, xs, width: g.measureText(s).width + (s.length - 1) * spacing };
  }

  function layout() {
    size = Math.round(Math.max(12, Math.min(16, w / 64)));
    big = Math.round(size * 1.8);
    g.font = `${size}px ${FONT}`;
    const spacing = size * 0.05;
    const width = (t: string) => g.measureText(t).width + (t.length - 1) * spacing;
    lineH = Math.round(size * 1.95);
    const max = Math.min(w * 0.86, size * 36);
    const wrapped = TEXT.prologue.lines.map((p) => {
      const lines: Line[] = [];
      let text = '';
      for (const word of p.split(' ')) {
        if (text && width(`${text} ${word}`) > max) {
          lines.push(line(text, spacing));
          text = word;
        } else text = text ? `${text} ${word}` : word;
      }
      lines.push(line(text, spacing));
      return lines;
    });
    const longest = Math.max(...wrapped.flat().map((l) => width(l.s)));
    const rows = wrapped.reduce((s, l) => s + l.length, 0) + wrapped.length - 1;
    blockX = Math.round((w - longest) / 2);
    blockTop = Math.round(h * 0.47 - (rows * lineH) / 2);
    blockBottom = blockTop + rows * lineH;
    let y = blockTop;
    paras = wrapped.map((lines) => {
      const p = { lines, y };
      y += (lines.length + 1) * lineH;
      return p;
    });

    // the title card: spaced wide, in capitals
    const card = (s: string, px: number, spread: number) => {
      g.font = `${px}px ${FONT}`;
      const l = line(s.toUpperCase(), g.measureText('M').width * spread);
      return { ...l, x: Math.round((w - l.width) / 2) };
    };
    title = card(TEXT.game.title, big, 0.6);
    time = card(TEXT.prologue.time, size, 0.25);
  }

  function resize(cw: number, ch: number, deviceRatio: number) {
    w = Math.max(1, cw);
    h = Math.max(1, ch);
    dpr = Math.min(deviceRatio, 2, Math.sqrt(MAX_PIXELS / (w * h)));
    g.canvas.width = Math.round(w * dpr);
    g.canvas.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    ts = Math.min(1, Math.sqrt(TRAIL_PIXELS / (w * h)));
    trail = makeCanvas(Math.round(w * ts), Math.round(h * ts));
    tg = trail.getContext('2d') as Ctx;
    tg.setTransform(ts, 0, 0, ts, 0, 0);
    tg.lineCap = 'round';

    const r = Math.hypot(w, h) / 2;
    bg = g.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h * 0.45, r);
    bg.addColorStop(0, '#15100b');
    bg.addColorStop(1, '#050403');
    vignette = g.createRadialGradient(w / 2, h / 2, r * 0.45, w / 2, h / 2, r);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,.7)');

    n = Math.round(Math.min(16000, Math.max(3500, (w * h) / 105)));
    px = new Float32Array(n);
    py = new Float32Array(n);
    ox = new Float32Array(n);
    oy = new Float32Array(n);
    layer = new Uint8Array(n);
    twinkle = new Float32Array(n);
    pace = new Float32Array(n);
    const lists: number[][] = LAYERS.flatMap((l) => l.colors.map(() => []));
    for (let i = 0; i < n; i++) {
      let r = rnd();
      let L = 0;
      while (L < LAYERS.length - 1 && r >= LAYERS[L].share) r -= LAYERS[L++].share;
      layer[i] = L;
      twinkle[i] = rnd() * 1000;
      pace[i] = 0.55 + rnd() * rnd() * 1.4;
      lists[L * 4 + Math.floor(rnd() * 4)].push(i);
      spawn(i, true);
    }
    buckets = lists.map((l) => Int32Array.from(l));
    layout();
  }

  /** The wind at (x, y): a domain-warped field of sines that drifts in time, so eddies form, wander and let go,
   *  on top of a steady wind to the right. Sets the heading and a gust factor. */
  let heading = 0;
  let gust = 1;
  function wind(x: number, y: number, t: number) {
    const k = 1 / (Math.min(w, h) * 0.33);
    const u = x * k;
    const v = y * k;
    const qx = u + 0.9 * Math.sin(v * 1.7 + t * 0.11);
    const qy = v + 0.9 * Math.sin(u * 1.3 - t * 0.09);
    heading = Math.sin(qx * 1.9 + t * 0.05) * Math.cos(qy * 2.3 - t * 0.07) * 2.6 + Math.sin((qx + qy) * 0.8 + t * 0.13) * 0.9;
    const s = Math.sin(u * 0.6 - v * 0.3 - t * 0.35);
    gust = 0.45 + s * s * 1.1;
  }

  function step(dt: number) {
    for (let i = 0; i < n; i++) {
      const x = px[i];
      const y = py[i];
      ox[i] = x;
      oy[i] = y;
      const L = LAYERS[layer[i]];
      wind(x, y, clock + layer[i] * 7);
      const sp = L.speed * gust * pace[i] * dt;
      px[i] = x + (Math.cos(heading) * 0.85 + 0.65) * sp;
      py[i] = y + (Math.sin(heading) * 0.85 - 0.08) * sp;
      const nx = px[i];
      const ny = py[i];
      if (nx > w + 20 || ny < -20 || ny > h + 20 || nx < -60 || rnd() < 0.003) spawn(i, rnd() < 0.5);
    }
  }

  function dust() {
    tg.globalCompositeOperation = 'destination-out';
    tg.fillStyle = `rgba(0,0,0,${FADE})`;
    tg.fillRect(0, 0, w, h);
    tg.globalCompositeOperation = 'source-over';
    for (let b = 0; b < buckets.length; b++) {
      const L = LAYERS[Math.floor(b / 4)];
      const list = buckets[b];
      tg.strokeStyle = L.colors[b % 4];
      tg.lineWidth = L.width;
      tg.beginPath();
      for (let j = 0; j < list.length; j++) {
        const i = list[j];
        if (ox[i] === px[i] && oy[i] === py[i]) continue;
        tg.moveTo(ox[i], oy[i]);
        tg.lineTo(px[i], py[i]);
      }
      tg.stroke();
    }
    // a near grain catching the light
    tg.fillStyle = 'rgba(255,248,226,.9)';
    for (const i of buckets[buckets.length - 1]) {
      if (Math.sin(twinkle[i] + clock * 3.1) * Math.sin(twinkle[i] * 1.7 + clock * 1.3) > 0.97) tg.fillRect(px[i] - 0.75, py[i] - 0.75, 1.5, 1.5);
    }
  }

  const ramp = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

  /** One laid-out line from `x`, each letter fading in (and rising a touch) `CHAR_S` after the one before it from `t0`. */
  function letters({ s, xs }: Line, x: number, y: number, t0: number, k0: number, rgb: string, scale: number) {
    for (let k = 0; k < s.length; k++) {
      if (s[k] === ' ') continue;
      const a = ramp((clock - t0 - (k0 + k) * CHAR_S) / LETTER_S) * scale;
      if (a <= 0.003) continue;
      g.fillStyle = `rgba(${rgb},${a})`;
      g.fillText(s[k], x + xs[k], y + (1 - a / scale) * 5);
    }
  }

  function text() {
    const out = 1 - ramp((clock - OUT_AT) / 1.6);
    if (full && out > 0 && clock > PARA_AT[0]) {
      // a soft dark bed so the dust doesn't eat the letters
      const cy = (blockTop + blockBottom) / 2;
      const rx = Math.min(w * 0.6, (w - 2 * blockX) * 0.75 + 80);
      const ry = (blockBottom - blockTop) * 0.75 + 60;
      g.save();
      g.translate(w / 2, cy);
      g.scale(rx, ry);
      const bed = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      bed.addColorStop(0, `rgba(6,5,4,${0.6 * out * ramp(clock - PARA_AT[0])})`);
      bed.addColorStop(1, 'rgba(6,5,4,0)');
      g.fillStyle = bed;
      g.fillRect(-1, -1, 2, 2);
      g.restore();

      g.font = `${size}px ${FONT}`;
      g.textBaseline = 'middle';
      paras.forEach((p, i) => {
        let k0 = 0;
        p.lines.forEach((line, r) => {
          letters(line, blockX, p.y + r * lineH + lineH / 2, PARA_AT[i], k0, INK, out);
          k0 += line.s.length + 1;
        });
      });
    }
    const at = full ? CARD_AT : TITLE_AT;
    if (clock > at) {
      g.textBaseline = 'middle';
      g.font = `${big}px ${FONT}`;
      letters(title, title.x, full ? h * 0.47 - big * 0.6 : h * 0.47, at, 0, GOLD, 1);
      if (!full) return;
      g.font = `${size}px ${FONT}`;
      letters(time, time.x, h * 0.47 + big * 0.8, at + 1.4, 0, INK, 0.7);
    }
  }

  function draw() {
    g.globalAlpha = 1;
    g.fillStyle = bg!;
    g.fillRect(0, 0, w, h);
    g.globalAlpha = ramp(clock / 1.5);
    g.drawImage(trail, 0, 0, w, h);
    g.globalAlpha = 1;
    g.fillStyle = vignette!;
    g.fillRect(0, 0, w, h);
    text();
    // the loading bar: a hairline that grows out from the middle near the bottom
    const bw = Math.min(320, w * 0.4) * shown;
    g.fillStyle = `rgba(${GOLD},${0.18 + 0.12 * shown})`;
    g.fillRect(Math.round(w / 2 - bw / 2), Math.round(h - 30), bw, 1);
  }

  return {
    resize,
    relayout: layout,
    progress: (p: number) => (target = Math.max(target, p)),
    frame(dt: number) {
      dt = Math.min(0.05, dt);
      clock += dt;
      shown += (target - shown) * Math.min(1, dt * 4);
      step(dt);
      dust();
      draw();
    },
  };
}
