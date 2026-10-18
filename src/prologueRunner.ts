// The loading cover's picture: sand dust blown through a slowly turning flow field on the dark, the prologue's
// paragraphs fading in over it a letter at a time, then the place and time card, and a hairline loading bar.
// Plain canvas 2D that knows nothing of the page: it runs in a worker (src/prologueWorker.ts, src/prologue.ts)
// because the main thread is busy building the world while this is up.
import { TEXT } from '../shared/text.ts';

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const INK = '236, 228, 210'; // the prologue's warm white (rgb, for alpha)
const GOLD = '217, 178, 106';
/** Dust colours: whites, pale golds, yellows and ochres; the far layer is dim, the near one bright. */
const LAYERS = [
  { share: 0.56, speed: 34, width: 0.7, colors: ['rgba(122,92,48,.55)', 'rgba(150,118,62,.5)', 'rgba(104,80,46,.6)', 'rgba(170,150,120,.4)'] },
  { share: 0.33, speed: 70, width: 1, colors: ['rgba(214,170,84,.6)', 'rgba(232,196,110,.55)', 'rgba(190,138,62,.6)', 'rgba(240,226,196,.45)'] },
  { share: 0.11, speed: 135, width: 1.5, colors: ['rgba(246,214,128,.75)', 'rgba(255,240,206,.7)', 'rgba(228,180,92,.75)', 'rgba(255,250,236,.65)'] },
];
const MAX_PIXELS = 4.2e6; // the visible canvas's backing store, at most (about 2560x1600)
const TRAIL_PIXELS = 2.2e6; // the dust's own canvas: soft anyway, so cheaper
const FADE = 0.14; // how much of the dust's trails fades per frame (at 60 fps)

// The prologue's timeline (s): each paragraph starts, then they all go and the card comes up and stays.
const PARA_AT = [1.2, 5.8, 10.6];
const OUT_AT = 17;
const CARD_AT = 18.8;
const CHAR_S = 0.022; // the letters' stagger
const LETTER_S = 0.9; // one letter's fade in

export function createPrologue(g: Ctx, makeCanvas: (w: number, h: number) => OffscreenCanvas | HTMLCanvasElement) {
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

  // Text laid out for the current size.
  let size = 15;
  let adv = 9; // one monospace letter's advance, letter spacing included
  let lineH = 28;
  let paras: { lines: string[]; y: number }[] = [];
  let blockX = 0;
  let blockTop = 0;
  let blockBottom = 0;

  function spawn(i: number, anywhere: boolean) {
    px[i] = anywhere ? rnd() * w : -rnd() * 40;
    py[i] = rnd() * h;
    ox[i] = px[i];
    oy[i] = py[i];
  }

  function layout() {
    size = Math.round(Math.max(13, Math.min(17, w / 58)));
    g.font = `${size}px ${MONO}`;
    adv = g.measureText('M').width * 1.08;
    lineH = Math.round(size * 1.85);
    const cols = Math.max(24, Math.min(52, Math.floor((w * 0.86) / adv)));
    const wrapped = TEXT.prologue.lines.map((p) => {
      const lines: string[] = [];
      let line = '';
      for (const word of p.split(' ')) {
        if (line && line.length + 1 + word.length > cols) {
          lines.push(line);
          line = word;
        } else line = line ? `${line} ${word}` : word;
      }
      lines.push(line);
      return lines;
    });
    const longest = Math.max(...wrapped.flat().map((l) => l.length));
    const rows = wrapped.reduce((s, l) => s + l.length, 0) + wrapped.length - 1;
    blockX = Math.round((w - longest * adv) / 2);
    blockTop = Math.round(h * 0.47 - (rows * lineH) / 2);
    blockBottom = blockTop + rows * lineH;
    let y = blockTop;
    paras = wrapped.map((lines) => {
      const p = { lines, y };
      y += (lines.length + 1) * lineH;
      return p;
    });
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

    n = Math.round(Math.min(11000, Math.max(2500, (w * h) / 150)));
    px = new Float32Array(n);
    py = new Float32Array(n);
    ox = new Float32Array(n);
    oy = new Float32Array(n);
    layer = new Uint8Array(n);
    twinkle = new Float32Array(n);
    pace = new Float32Array(n);
    const lists: number[][] = LAYERS.flatMap((l) => l.colors.map(() => []));
    for (let i = 0; i < n; i++) {
      const r = rnd();
      const L = r < LAYERS[0].share ? 0 : r < LAYERS[0].share + LAYERS[1].share ? 1 : 2;
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
      if (Math.sin(twinkle[i] + clock * 3.1) * Math.sin(twinkle[i] * 1.7 + clock * 1.3) > 0.97) tg.fillRect(px[i] - 1, py[i] - 1, 2, 2);
    }
  }

  const ramp = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

  /** One line of letters `step` apart, each fading in (and rising a touch) `CHAR_S` after the one before it from `t0`. */
  function letters(s: string, x: number, y: number, step: number, t0: number, k0: number, rgb: string, scale: number) {
    for (let k = 0; k < s.length; k++) {
      if (s[k] === ' ') continue;
      const a = ramp((clock - t0 - (k0 + k) * CHAR_S) / LETTER_S) * scale;
      if (a <= 0.003) continue;
      g.fillStyle = `rgba(${rgb},${a})`;
      g.fillText(s[k], x + k * step, y + (1 - a / scale) * 5);
    }
  }

  function text() {
    const out = 1 - ramp((clock - OUT_AT) / 1.6);
    if (out > 0 && clock > PARA_AT[0]) {
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

      g.font = `${size}px ${MONO}`;
      g.textBaseline = 'middle';
      paras.forEach((p, i) => {
        let k0 = 0;
        p.lines.forEach((line, r) => {
          letters(line, blockX, p.y + r * lineH + lineH / 2, adv, PARA_AT[i], k0, INK, out);
          k0 += line.length + 1;
        });
      });
    }
    if (clock > CARD_AT) {
      const place = TEXT.prologue.place.toUpperCase();
      const time = TEXT.prologue.time.toUpperCase();
      const big = Math.round(size * 1.35);
      g.textBaseline = 'middle';
      g.font = `${big}px ${MONO}`;
      // spaced wide, and centred on the letters rather than on their spacing
      const card = (s: string, y: number, spacing: number, t0: number, rgb: string, a: number) => {
        const m = g.measureText('M').width;
        const step = m * spacing;
        letters(s, Math.round((w - (s.length - 1) * step - m) / 2), y, step, t0, 0, rgb, a);
      };
      g.font = `${big}px ${MONO}`;
      card(place, h * 0.47 - big * 0.7, 1.5, CARD_AT, GOLD, 1);
      g.font = `${size}px ${MONO}`;
      card(time, h * 0.47 + big * 0.9, 1.25, CARD_AT + 1.4, INK, 0.7);
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
