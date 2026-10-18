// The loading screen's game: a tiny version of the disassembly mode (src/teardown). A machine slides in; take it apart
// with the same moves as in the world, then take the freed part and it goes to the bag.
//   screws    click them (the beads count the clicks)          bolts     circle the pointer around them
//   wires     swipe across them                                pry tabs  drag them away
// The first machines have only screws, then each of the other moves turns up on its own, then they mix. The step
// markers look like the game's. Plain canvas 2D, and it knows nothing of the page: it runs in a worker
// (src/loadingWorker.ts, src/loadingGame.ts) because the main thread is busy building the world while this is up.
// The loading bar is drawn here too, for the same reason.
export const W = 520;
export const H = 270;
const BAR_Y = 262;
const BAR_W = 160;

const HI = '#ffd9a0'; // the disassembly UI's highlight
const BODY = '#7a5238';
const TRIM = '#3b2616';
const STEEL = '#8a8f93';
const COPPER = '#c47a3a';
const TIER_COLORS = ['#b08a62', '#74d08a', '#ff9a3c', '#3ff0ff']; // shared/salvage.ts RARITY: scrap, basic, quality, space
const CX = 260; // the machine's centre
const CY = 105;
const BAG_Y = 236;
const BAG_N = 8;
const BAG_GAP = 32;
const CUT_PX = 70;
const PRY_PX = 80;

type Kind = 'screw' | 'bolt' | 'wire' | 'pry';
interface Step {
  kind: Kind;
  x: number;
  y: number;
  need: number;
  progress: number;
  done: boolean;
  after: Step[];
}
interface Machine {
  steps: Step[];
  lidHolds: Step[];
  lid: { released: boolean; age: number; x: number; y: number; vx: number; vy: number; rot: number; vr: number };
  part: number; // which glyph
  tier: number;
  taken: boolean;
}
interface Act {
  step: Step;
  x0: number;
  y0: number;
  prev: number;
  total: number;
}

const LID_SCREWS: [number, number][] = [[162, 67], [358, 67], [162, 143], [358, 143]];
const ready = (s: Step) => !s.done && s.after.every((a) => a.done);

export function createRunner(g: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, dpr: number) {
  g.scale(dpr, dpr);
  let target = 0; // loading progress asked for, and the eased value drawn
  let shown = 0;
  let clock = 0;
  let rand = 7;
  const rnd = () => ((rand = (rand * 16807) % 2147483647) / 2147483647);

  let n = 0; // machines so far
  let m = make(0);
  let phase: 'in' | 'work' | 'out' = 'in';
  let slide = 420; // the machine's x offset while it comes in and goes out
  let fly = -1; // seconds into the part's trip to the bag, -1 when not flying
  const bag: { part: number; tier: number }[] = [];
  let act: Act | null = null;
  let hover: Step | null = null;
  let px = -99;
  let py = -99;
  let flash = 0; // a screw just turned
  let splashing = false; // the last stage: the game fades out for a calm view while the page does what can't be sliced
  let splashT = 0;

  function make(i: number): Machine {
    const screws = i < 2 ? 2 : i < 6 ? 3 : 2 + Math.floor(rnd() * 3);
    const lidHolds: Step[] = LID_SCREWS.slice(0, screws).map(([x, y]) => ({ kind: 'screw', x, y, need: i < 2 ? 2 : 3, progress: 0, done: false, after: [] }));
    // One new move at a time, then mixes.
    const inner: Kind[] = i === 0 ? [] : i === 1 ? ['wire'] : i === 2 ? ['bolt'] : i === 3 ? ['pry'] : (['wire', 'bolt', 'pry'] as Kind[]).filter(() => rnd() < 0.55);
    if (i >= 4 && inner.length === 0) inner.push('wire');
    const steps: Step[] = [...lidHolds];
    for (const k of inner) {
      const at = k === 'wire' ? [320, 105] : k === 'bolt' ? [198, 105] : [380, 105];
      steps.push({ kind: k, x: at[0], y: at[1], need: 1, progress: 0, done: false, after: lidHolds });
    }
    return {
      steps, lidHolds, part: i % 4, tier: Math.min(3, Math.floor(i / 2)), taken: false,
      lid: { released: false, age: 0, x: 0, y: 0, vx: 0, vy: 0, rot: 0, vr: 0 },
    };
  }

  const partFree = () => m.lid.released && !m.taken && m.steps.every((s) => s.done);
  const bagAt = (i: number) => ({ x: CX + (i - (BAG_N - 1) / 2) * BAG_GAP, y: BAG_Y });

  const stepAt = (x: number, y: number): Step | null => {
    for (const s of m.steps) {
      if (!ready(s)) continue;
      if (s.kind === 'wire') {
        if (Math.abs(x - s.x) < 13 && y > s.y - 40 && y < s.y + 40) return s;
      } else if (Math.hypot(x - s.x - (s.kind === 'pry' ? 10 : 0), y - s.y) < (s.kind === 'bolt' ? 22 : 17)) return s;
    }
    return null;
  };

  const finish = (s: Step) => {
    s.done = true;
    s.progress = s.need;
    if (m.lidHolds.every((h) => h.done) && !m.lid.released) {
      m.lid.released = true;
      m.lid.vx = 90;
      m.lid.vy = -300;
      m.lid.vr = 2.2;
    }
  };

  function down(x: number, y: number) {
    px = x;
    py = y;
    if (phase !== 'work' || splashing) return;
    x -= slide;
    if (partFree() && Math.hypot(x - CX, y - CY) < 30) {
      m.taken = true;
      fly = 0;
      return;
    }
    const s = stepAt(x, y);
    if (!s) return;
    if (s.kind === 'screw') {
      s.progress++;
      flash = 0.12;
      if (s.progress >= s.need) finish(s);
    } else {
      act = { step: s, x0: x, y0: y, prev: Math.atan2(y - s.y, x - s.x), total: 0 };
    }
  }

  function move(x: number, y: number) {
    px = x;
    py = y;
    x -= slide;
    if (!act) {
      hover = phase === 'work' ? stepAt(x, y) : null;
      return;
    }
    const s = act.step;
    if (s.kind === 'bolt') {
      const a = Math.atan2(y - s.y, x - s.x);
      let d = a - act.prev;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      act.prev = a;
      if (Math.hypot(x - s.x, y - s.y) > 12) act.total += Math.abs(d);
      s.progress = Math.min(1, act.total / (2 * Math.PI));
    } else if (s.kind === 'wire') {
      s.progress = Math.min(1, Math.hypot(x - act.x0, y - act.y0) / CUT_PX);
    } else {
      s.progress = Math.min(1, Math.max(0, x - act.x0) / PRY_PX);
    }
    if (s.progress >= 1) {
      finish(s);
      act = null;
    }
  }

  function up() {
    if (act) act.step.progress = 0; // let go early: it springs back
    act = null;
  }

  function update(dt: number) {
    clock += dt;
    if (splashing) splashT = Math.min(1, splashT + dt * 2);
    flash = Math.max(0, flash - dt);
    const L = m.lid;
    if (L.released) {
      L.age += dt;
      L.vy += 1100 * dt;
      L.x += L.vx * dt;
      L.y += L.vy * dt;
      L.rot += L.vr * dt;
    }
    if (phase === 'in') {
      slide = Math.max(0, slide - dt * 900 * Math.max(0.15, slide / 420));
      if (slide === 0) phase = 'work';
    } else if (phase === 'out') {
      slide -= dt * 1100;
      if (slide < -420) {
        m = make(++n);
        slide = 420;
        phase = 'in';
        act = null;
      }
    }
    if (fly >= 0) {
      fly += dt;
      if (fly >= 0.6) {
        fly = -1;
        bag.push({ part: m.part, tier: m.tier });
        if (bag.length > BAG_N) bag.shift();
        phase = 'out';
      }
    }
  }

  // ---- drawing -----------------------------------------------------------------------------------------------

  function glyph(kind: number, x: number, y: number, s: number, color: string) {
    g.save();
    g.translate(x, y);
    g.scale(s, s);
    g.fillStyle = color;
    g.strokeStyle = '#1c0f07';
    g.lineWidth = 2;
    if (kind === 0) {
      // gear
      g.beginPath();
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const r = i % 2 ? 17 : 22;
        g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.closePath();
      g.fill();
      g.stroke();
      g.fillStyle = '#1c0f07';
      g.beginPath();
      g.arc(0, 0, 7, 0, 7);
      g.fill();
    } else if (kind === 1) {
      // battery
      g.fillRect(-18, -12, 36, 24);
      g.strokeRect(-18, -12, 36, 24);
      g.fillRect(18, -5, 5, 10);
      g.fillStyle = '#1c0f07';
      g.fillRect(-10, -3, 14, 6);
      g.fillRect(-7, -6, 8, 12);
    } else if (kind === 2) {
      // motor
      g.beginPath();
      g.arc(0, 0, 16, 0, 7);
      g.fill();
      g.stroke();
      g.fillRect(14, -3, 10, 6);
      g.fillStyle = '#1c0f07';
      g.beginPath();
      g.arc(0, 0, 6, 0, 7);
      g.fill();
    } else {
      // coil
      g.beginPath();
      g.arc(0, 0, 18, 0, 7);
      g.stroke();
      g.strokeStyle = color;
      g.lineWidth = 3;
      for (let r = 5; r <= 15; r += 5) {
        g.beginPath();
        g.arc(0, 0, r, 0, 7);
        g.stroke();
      }
    }
    g.restore();
  }

  function arrow(x0: number, y0: number, x1: number, y1: number, alpha: number) {
    const a = Math.atan2(y1 - y0, x1 - x0);
    g.strokeStyle = g.fillStyle = HI;
    g.globalAlpha = alpha;
    g.lineWidth = 3;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
    g.beginPath();
    g.moveTo(x1 + Math.cos(a) * 6, y1 + Math.sin(a) * 6);
    g.lineTo(x1 + Math.cos(a + 2.5) * 8, y1 + Math.sin(a + 2.5) * 8);
    g.lineTo(x1 + Math.cos(a - 2.5) * 8, y1 + Math.sin(a - 2.5) * 8);
    g.fill();
    g.globalAlpha = 1;
  }

  function ring(x: number, y: number, r: number, f: number) {
    g.lineWidth = 5;
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(28, 15, 7, 0.7)';
    g.beginPath();
    g.arc(x, y, r, 0, 7);
    g.stroke();
    g.strokeStyle = HI;
    g.beginPath();
    g.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f);
    g.stroke();
  }

  function drawStep(s: Step) {
    const on = ready(s);
    const lit = hover === s || act?.step === s;
    g.globalAlpha = on ? 1 : 0.4;
    if (s.kind === 'screw') {
      if (s.done) return;
      g.fillStyle = STEEL;
      g.strokeStyle = TRIM;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(s.x, s.y, 10, 0, 7);
      g.fill();
      g.stroke();
      const a = s.progress * 0.9 + 0.4;
      g.strokeStyle = '#2b2622';
      g.beginPath();
      g.moveTo(s.x - Math.cos(a) * 7, s.y - Math.sin(a) * 7);
      g.lineTo(s.x + Math.cos(a) * 7, s.y + Math.sin(a) * 7);
      g.stroke();
      if (lit) {
        g.strokeStyle = HI;
        g.beginPath();
        g.arc(s.x, s.y, 14, 0, 7);
        g.stroke();
      }
      // a bead per click, filled as they are done
      for (let i = 0; i < s.need; i++) {
        g.fillStyle = i < s.progress ? HI : 'rgba(255, 217, 160, 0.3)';
        g.beginPath();
        g.arc(s.x + (i - (s.need - 1) / 2) * 9, s.y - 22, 3, 0, 7);
        g.fill();
      }
    } else if (s.kind === 'bolt') {
      g.fillStyle = s.done ? '#1c0f07' : STEEL;
      g.strokeStyle = TRIM;
      g.lineWidth = 2;
      g.beginPath();
      const rot = s.progress * Math.PI * 2;
      for (let i = 0; i < 6; i++) g.lineTo(s.x + Math.cos(rot + (i * Math.PI) / 3) * 14, s.y + Math.sin(rot + (i * Math.PI) / 3) * 14);
      g.closePath();
      g.fill();
      g.stroke();
      if (!s.done) {
        g.fillStyle = '#2b2622';
        g.beginPath();
        g.arc(s.x, s.y, 5, 0, 7);
        g.fill();
        // the circle to follow, with the turning arrow
        g.setLineDash([4, 6]);
        g.strokeStyle = 'rgba(255, 217, 160, 0.4)';
        g.lineWidth = 3;
        g.beginPath();
        g.arc(s.x, s.y, 34, 0, 7);
        g.stroke();
        g.setLineDash([]);
        if (act?.step === s) ring(s.x, s.y, 34, s.progress);
        else {
          const a = clock * 2.2;
          const tx = s.x + Math.cos(a) * 34;
          const ty = s.y + Math.sin(a) * 34;
          g.fillStyle = HI;
          g.beginPath();
          g.moveTo(tx - Math.sin(a) * 9, ty + Math.cos(a) * 9);
          g.lineTo(tx + Math.cos(a) * 6, ty + Math.sin(a) * 6);
          g.lineTo(tx + Math.sin(a) * 9, ty - Math.cos(a) * 9);
          g.fill();
        }
      }
    } else if (s.kind === 'wire') {
      g.strokeStyle = COPPER;
      g.lineWidth = 5;
      g.lineCap = 'round';
      g.beginPath();
      if (s.done) {
        g.moveTo(s.x, s.y - 40);
        g.lineTo(s.x - 2, s.y - 9);
        g.moveTo(s.x, s.y + 40);
        g.lineTo(s.x + 3, s.y + 10);
      } else {
        g.moveTo(s.x, s.y - 40);
        g.lineTo(s.x, s.y + 40);
      }
      g.stroke();
      if (!s.done) {
        if (lit) {
          g.strokeStyle = HI;
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(s.x, s.y - 40);
          g.lineTo(s.x, s.y + 40);
          g.stroke();
        }
        // a sweeping arrow across it
        const k = act?.step === s ? s.progress : (clock * 0.9) % 1;
        const x1 = s.x - 36 + k * 72;
        arrow(x1 - 24, s.y, x1, s.y, act?.step === s ? 1 : Math.sin(k * Math.PI));
        if (act?.step === s) {
          g.strokeStyle = HI;
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(act.x0, act.y0);
          g.lineTo(px - slide, py);
          g.stroke();
        }
      }
    } else {
      if (s.done) return;
      const off = s.progress * PRY_PX;
      g.fillStyle = STEEL;
      g.strokeStyle = TRIM;
      g.lineWidth = 2;
      g.beginPath();
      g.roundRect(s.x + off, s.y - 14, 22, 28, 3);
      g.fill();
      g.stroke();
      g.fillStyle = '#2b2622';
      g.beginPath();
      g.arc(s.x + off + 11, s.y, 4, 0, 7);
      g.fill();
      if (lit) {
        g.strokeStyle = HI;
        g.strokeRect(s.x + off - 3, s.y - 17, 28, 34);
      }
      // a pulling arrow
      const k = act?.step === s ? 1 : (clock * 1.1) % 1;
      arrow(s.x + 34 + off, s.y, s.x + 34 + off + 14 + k * 14, s.y, act?.step === s ? 1 : Math.sin(k * Math.PI));
    }
    g.globalAlpha = 1;
  }

  function drawMachine() {
    // the open machine: dark inside, the part in the middle, the inner steps
    g.fillStyle = '#251509';
    g.strokeStyle = TRIM;
    g.lineWidth = 4;
    g.beginPath();
    g.roundRect(CX - 120, CY - 60, 240, 120, 8);
    g.fill();
    g.stroke();
    if (m.lid.released || m.lid.age > 0) {
      g.fillStyle = '#3b2616';
      g.fillRect(CX - 100, CY - 4, 40, 8); // a mounting rail under the part
      g.fillRect(CX + 60, CY - 4, 40, 8);
      if (!m.taken) {
        const free = partFree();
        const c = TIER_COLORS[m.tier];
        if (free) {
          // glows in its rarity colour and pulses once it's free
          const r = 34 + Math.sin(clock * 5) * 4;
          const grad = g.createRadialGradient(CX, CY, 6, CX, CY, r);
          grad.addColorStop(0, c + 'aa');
          grad.addColorStop(1, c + '00');
          g.fillStyle = grad;
          g.beginPath();
          g.arc(CX, CY, r, 0, 7);
          g.fill();
        }
        g.globalAlpha = free ? 1 : 0.55;
        glyph(m.part, CX, CY, 1.1, c);
        g.globalAlpha = 1;
      }
      for (const s of m.steps) if (!m.lidHolds.includes(s)) drawStep(s);
    }
    // the lid
    const L = m.lid;
    if (!L.released || L.age < 1) {
      g.save();
      g.globalAlpha = L.released ? Math.max(0, 1 - L.age) : 1;
      g.translate(CX + L.x, CY + L.y);
      g.rotate(L.rot);
      g.fillStyle = BODY;
      g.strokeStyle = TRIM;
      g.lineWidth = 4;
      g.beginPath();
      g.roundRect(-120, -60, 240, 120, 8);
      g.fill();
      g.stroke();
      g.fillStyle = 'rgba(160, 74, 32, 0.8)'; // the accent stripe
      g.fillRect(-96, -8, 192, 16);
      g.fillStyle = TIER_COLORS[m.tier];
      g.fillRect(-96, -8, 14, 16); // the rarity tag
      g.fillStyle = TRIM;
      for (let i = -3; i <= 3; i++) g.fillRect(i * 26 - 3, 28, 6, 3); // vents
      g.restore();
      g.globalAlpha = 1;
      if (!L.released) for (const s of m.lidHolds) drawStep(s);
    }
  }

  function draw() {
    g.clearRect(0, 0, W, H);
    g.globalAlpha = 1 - splashT;
    g.fillStyle = 'rgba(0, 0, 0, 0.35)';
    g.beginPath();
    g.ellipse(CX + slide, CY + 70, 140, 9, 0, 0, 7);
    g.fill();
    g.save();
    g.translate(slide, 0);
    drawMachine();
    g.restore();

    // a part on its way to the bag
    if (fly >= 0) {
      const t = Math.min(1, fly / 0.6);
      const e = t * t;
      const to = bagAt(Math.min(bag.length, BAG_N - 1));
      glyph(m.part, CX + (to.x - CX) * e, CY + (to.y - CY) * e - Math.sin(t * Math.PI) * 30, 1.1 - 0.6 * e, TIER_COLORS[m.tier]);
    }
    // the bag
    for (let i = 0; i < BAG_N; i++) {
      const b = bagAt(i);
      g.fillStyle = 'rgba(28, 15, 7, 0.8)';
      g.strokeStyle = 'rgba(255, 240, 220, 0.16)';
      g.lineWidth = 1;
      g.beginPath();
      g.roundRect(b.x - 13, b.y - 13, 26, 26, 4);
      g.fill();
      g.stroke();
      const it = bag[i];
      if (it) {
        g.strokeStyle = TIER_COLORS[it.tier];
        g.beginPath();
        g.roundRect(b.x - 13, b.y - 13, 26, 26, 4);
        g.stroke();
        glyph(it.part, b.x, b.y, 0.5, TIER_COLORS[it.tier]);
      }
    }

    g.globalAlpha = 1;
    if (splashT > 0) {
      // a slowly turning gear in the middle: nothing to do, just wait
      g.globalAlpha = splashT;
      const r = 40 + Math.sin(clock * 3) * 2;
      const grad = g.createRadialGradient(CX, 95, 8, CX, 95, r + 30);
      grad.addColorStop(0, 'rgba(255, 217, 160, 0.35)');
      grad.addColorStop(1, 'rgba(255, 217, 160, 0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(CX, 95, r + 30, 0, 7);
      g.fill();
      g.save();
      g.translate(CX, 95);
      g.rotate(clock * 0.8);
      glyph(0, 0, 0, 2.2, HI);
      g.restore();
      g.globalAlpha = 1;
    }
    // the loading bar, drawn here so it keeps moving while the page is busy
    const bx = (W - BAR_W) / 2;
    g.fillStyle = '#2a2622';
    g.fillRect(bx, BAR_Y, BAR_W, 2);
    g.fillStyle = '#c9a878';
    g.fillRect(bx, BAR_Y, BAR_W * shown, 2);
    const sh = ((performance.now() / 900) % 1) * (BAR_W * shown + 30) - 30; // a glint sliding along it
    g.fillStyle = '#f0dcb0';
    g.fillRect(bx + Math.max(0, sh), BAR_Y, Math.max(0, Math.min(30, BAR_W * shown - sh, sh + 30)), 2);
  }

  return {
    down,
    move,
    up,
    splash() {
      splashing = true;
      act = null;
      target = 1;
    },
    progress: (p: number) => (target = Math.max(target, p)),
    frame(dt: number) {
      dt = Math.min(0.05, dt);
      shown += (target - shown) * Math.min(1, dt * 6);
      update(dt);
      draw();
    },
  };
}
