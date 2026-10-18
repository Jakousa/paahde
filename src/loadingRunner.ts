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
const MARK = '#ffb050'; // the step markers' orange (src/teardown/junk.ts)
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
/** The swap of one machine for the next, and the part's trip to the bag (s); the slide starts this far off screen. */
const SWAP_S = 0.18;
const FLY_S = 0.3;
const SLIDE_FROM = 420;
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

/** `bar`: draw the loading bar under the game (the loading screen; not when played from the menu). */
/** What it asks to have played (src/loadingGame.ts plays them: audio isn't there in a worker): the real teardown's metal
 *  hits (src/teardownSound.ts), the bolt's ring while it's turned and when it stops, and a part going into the bag. */
export type Sound = 'tink' | 'clink' | 'soft' | 'clang' | 'turn' | 'stop' | 'take';

export function createRunner(g: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, dpr: number, bar = true, sound: (s: Sound) => void = () => {}) {
  g.scale(dpr, dpr);
  let target = 0; // loading progress asked for, and the eased value drawn
  let shown = 0;
  let clock = 0;
  let rand = 7;
  const rnd = () => ((rand = (rand * 16807) % 2147483647) / 2147483647);

  let n = 0; // machines so far
  let m = make(0);
  let slide = 420; // the machine's x offset while it comes in (the first one slides in, the rest swap with the old one)
  let old: Machine | null = null; // the machine just taken apart, on its way out
  let oldSlide = 0;
  let swap = 0; // 0..1: the swap of old for new (the first machine comes in the same way)
  let fly = -1; // seconds into the part's trip to the bag, -1 when not flying
  let flyItem = { part: 0, tier: 0 };
  const bag: { part: number; tier: number }[] = [];
  let act: Act | null = null;
  let hover: Step | null = null;
  let px = -99;
  let py = -99;
  let flash = 0; // a screw just turned

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
      } else if (Math.hypot(x - s.x - (s.kind === 'pry' ? 13 : 0), y - s.y) < (s.kind === 'bolt' ? 22 : 17)) return s;
    }
    return null;
  };

  const finish = (s: Step) => {
    s.done = true;
    s.progress = s.need;
    sound(s.kind === 'pry' || s.kind === 'wire' ? 'soft' : 'clink');
    if (s.kind === 'bolt') sound('stop');
    if (m.lidHolds.every((h) => h.done) && !m.lid.released) {
      sound('clang'); // the cover drops
      m.lid.released = true;
      m.lid.vx = 90;
      m.lid.vy = -300;
      m.lid.vr = 2.2;
    }
  };

  function down(x: number, y: number) {
    px = x;
    py = y;
    x -= slide;
    if (partFree() && Math.hypot(x - CX, y - CY) < 30) {
      // Into the bag, and at once the next machine comes in as this one goes out.
      m.taken = true;
      flyItem = { part: m.part, tier: m.tier };
      fly = 0;
      sound('take');
      old = m;
      oldSlide = slide;
      m = make(++n);
      swap = 0;
      act = null;
      return;
    }
    const s = stepAt(x, y);
    if (!s) return;
    if (s.kind === 'screw') {
      s.progress++;
      flash = 0.12;
      if (s.progress >= s.need) finish(s);
      else sound('tink');
    } else {
      act = { step: s, x0: x, y0: y, prev: Math.atan2(y - s.y, x - s.x), total: 0 };
    }
  }

  function move(x: number, y: number) {
    px = x;
    py = y;
    x -= slide;
    if (!act) {
      hover = stepAt(x, y);
      return;
    }
    const s = act.step;
    if (s.kind === 'bolt') {
      const a = Math.atan2(y - s.y, x - s.x);
      let d = a - act.prev;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      act.prev = a;
      if (Math.hypot(x - s.x, y - s.y) > 12) {
        act.total += Math.abs(d);
        if (d) sound('turn');
      }
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
    if (act?.step.kind === 'bolt') sound('stop');
    if (act) act.step.progress = 0; // let go early: it springs back
    act = null;
  }

  function update(dt: number) {
    clock += dt;
    flash = Math.max(0, flash - dt);
    const L = m.lid;
    if (L.released) {
      L.age += dt;
      L.vy += 1100 * dt;
      L.x += L.vx * dt;
      L.y += L.vy * dt;
      L.rot += L.vr * dt;
    }
    if (swap < 1) {
      swap = Math.min(1, swap + dt / SWAP_S);
      const e = 1 - Math.pow(1 - swap, 3);
      slide = SLIDE_FROM * (1 - e);
      oldSlide = -SLIDE_FROM * e;
      if (swap >= 1) old = null;
    }
    if (fly >= 0) {
      fly += dt;
      if (fly >= FLY_S) {
        fly = -1;
        bag.push(flyItem);
        if (bag.length > BAG_N) bag.shift();
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

  // Step markers, as in the game (src/teardown/junk.ts makeMarker): orange, white under the pointer. Screws get a
  // ring of dots that tap in turn and go as the clicks are done, bolts a turning three-quarter arc with an
  // arrowhead; wires and pry tabs show the grab: a pointer ring presses on the thing and slides along the way to
  // go, leaving a trail.
  const markColor = (lit: boolean) => (lit ? '#ffffff' : MARK);

  /** The grab cue: press at (x0, y0), slide to (x1, y1), let go, repeat. `k` is the pointer's progress 0..1. */
  function dragCue(x0: number, y0: number, x1: number, y1: number, lit: boolean) {
    const ph = (clock * 0.85) % 1;
    const k = ph < 0.7 ? (1 - Math.cos((ph / 0.7) * Math.PI)) / 2 : 1;
    const fade = ph < 0.1 ? ph / 0.1 : ph > 0.85 ? Math.max(0, (1 - ph) / 0.15) : 1;
    const x = x0 + (x1 - x0) * k;
    const y = y0 + (y1 - y0) * k;
    const c = markColor(lit);
    g.save();
    g.globalAlpha = fade;
    g.lineCap = 'round';
    // the trail
    const trail = g.createLinearGradient(x0, y0, x1, y1);
    trail.addColorStop(0, 'rgba(255, 176, 80, 0)');
    trail.addColorStop(1, c);
    g.strokeStyle = trail;
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x, y);
    g.stroke();
    // the press: a ring that spreads out from where it lands
    if (ph < 0.25) {
      g.strokeStyle = c;
      g.globalAlpha = fade * (1 - ph / 0.25);
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x0, y0, 7 + (ph / 0.25) * 12, 0, 7);
      g.stroke();
      g.globalAlpha = fade;
    }
    // the pointer: a ring with a dot, pressed in a little while it's held down
    g.fillStyle = 'rgba(28, 15, 7, 0.55)';
    g.beginPath();
    g.arc(x, y, 8, 0, 7);
    g.fill();
    g.strokeStyle = c;
    g.lineWidth = 2.5;
    g.beginPath();
    g.arc(x, y, 8, 0, 7);
    g.stroke();
    g.fillStyle = c;
    g.beginPath();
    g.arc(x, y, ph < 0.7 ? 3.5 : 2.5, 0, 7);
    g.fill();
    // an arrowhead where the drag ends, so it reads as a direction rather than a thing to take hold of in the middle
    g.fillStyle = c;
    g.globalAlpha = fade * 0.9;
    const ang = Math.atan2(y1 - y0, x1 - x0);
    g.beginPath();
    g.moveTo(x1 + Math.cos(ang) * 8, y1 + Math.sin(ang) * 8);
    g.lineTo(x1 + Math.cos(ang + 2.4) * 7, y1 + Math.sin(ang + 2.4) * 7);
    g.lineTo(x1 + Math.cos(ang - 2.4) * 7, y1 + Math.sin(ang - 2.4) * 7);
    g.fill();
    g.restore();
  }

  function drawStep(s: Step) {
    const on = ready(s);
    const lit = hover === s || act?.step === s;
    const c = markColor(lit);
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
      // a dot per click still to do, in a ring round the screw, tapping one after another
      if (on) {
        const left = Math.max(0, s.need - Math.floor(s.progress));
        const pulse = lit ? 1.25 : 1 + 0.08 * Math.sin(clock * 6);
        for (let i = 0; i < left; i++) {
          const ang = (i / s.need) * Math.PI * 2 - Math.PI / 2;
          const tap = 1 + 0.7 * Math.pow(Math.max(0, Math.sin(clock * 7 - i * 0.9)), 4);
          g.fillStyle = c;
          g.beginPath();
          g.arc(s.x + Math.cos(ang) * 19 * pulse, s.y + Math.sin(ang) * 19 * pulse, 3.2 * tap, 0, 7);
          g.fill();
        }
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
        if (act?.step === s) {
          // while turning it: the circle to follow and how far round you are
          g.setLineDash([4, 6]);
          g.strokeStyle = 'rgba(255, 217, 160, 0.4)';
          g.lineWidth = 3;
          g.beginPath();
          g.arc(s.x, s.y, 34, 0, 7);
          g.stroke();
          g.setLineDash([]);
          ring(s.x, s.y, 34, s.progress);
        } else {
          // the marker: a three-quarter arc turning round with an arrowhead on its end
          const a0 = clock * 3.2;
          const a1 = a0 + Math.PI * 1.5;
          const r = 24 * (lit ? 1.25 : 1);
          g.strokeStyle = c;
          g.lineWidth = 3;
          g.lineCap = 'round';
          g.beginPath();
          g.arc(s.x, s.y, r, a0, a1);
          g.stroke();
          const tx = s.x + Math.cos(a1) * r;
          const ty = s.y + Math.sin(a1) * r;
          g.fillStyle = c;
          g.beginPath();
          g.moveTo(tx - Math.sin(a1) * 8, ty + Math.cos(a1) * 8);
          g.lineTo(tx + Math.cos(a1 + 0.5) * 3 + Math.sin(a1) * 8, ty + Math.sin(a1 + 0.5) * 3 - Math.cos(a1) * 8);
          g.lineTo(tx + Math.cos(a1) * 9, ty + Math.sin(a1) * 9);
          g.closePath();
          g.fill();
        }
      }
    } else if (s.kind === 'wire') {
      const top = s.y - 40;
      const bot = s.y + 40;
      if (s.done) {
        g.strokeStyle = COPPER;
        g.lineWidth = 5;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(s.x, top);
        g.lineTo(s.x - 2, s.y - 9);
        g.moveTo(s.x, bot);
        g.lineTo(s.x + 3, s.y + 10);
        g.stroke();
      } else {
        // a glow round the wire says it's the thing to grab
        if (on) {
          g.strokeStyle = lit ? 'rgba(255, 255, 255, 0.35)' : `rgba(255, 176, 80, ${0.22 + 0.12 * Math.sin(clock * 5)})`;
          g.lineWidth = 13;
          g.lineCap = 'round';
          g.beginPath();
          g.moveTo(s.x, top);
          g.lineTo(s.x, bot);
          g.stroke();
        }
        g.strokeStyle = COPPER;
        g.lineWidth = 5;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(s.x, top);
        g.lineTo(s.x, bot);
        g.stroke();
        if (act?.step === s) {
          // being swiped: the cut line from where you pressed to the pointer
          g.strokeStyle = '#ffffff';
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(act.x0, act.y0);
          g.lineTo(px - slide, py);
          g.stroke();
        } else if (on) dragCue(s.x, s.y, s.x + 52, s.y, lit); // press ON the wire and drag away from it
      }
    } else {
      if (s.done) return;
      const off = s.progress * PRY_PX;
      const tx = s.x + off;
      if (on && act?.step !== s) {
        // the way it comes out: a track to the end of the pull, with chevrons running along it
        g.setLineDash([3, 5]);
        g.strokeStyle = 'rgba(255, 176, 80, 0.45)';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(s.x + 24, s.y);
        g.lineTo(s.x + PRY_PX + 14, s.y);
        g.stroke();
        g.setLineDash([]);
        g.strokeStyle = c;
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(s.x + PRY_PX + 14, s.y - 9);
        g.lineTo(s.x + PRY_PX + 14, s.y + 9);
        g.stroke();
        for (let i = 0; i < 3; i++) {
          const q = ((clock * 1.1 + i / 3) % 1);
          const cx = s.x + 28 + q * (PRY_PX - 18);
          g.globalAlpha = Math.sin(q * Math.PI) * 0.9;
          g.beginPath();
          g.moveTo(cx - 4, s.y - 6);
          g.lineTo(cx + 3, s.y);
          g.lineTo(cx - 4, s.y + 6);
          g.stroke();
        }
        g.globalAlpha = on ? 1 : 0.4;
      }
      // the panel tab: a plate with a lip and grip ridges
      g.fillStyle = STEEL;
      g.strokeStyle = TRIM;
      g.lineWidth = 2;
      g.beginPath();
      g.roundRect(tx, s.y - 15, 26, 30, 3);
      g.fill();
      g.stroke();
      g.fillStyle = '#6c7175';
      g.fillRect(tx + 22, s.y - 17, 6, 34); // the lip to take hold of
      g.strokeStyle = '#2b2622';
      g.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        g.beginPath();
        g.moveTo(tx + 6 + i * 5, s.y - 9);
        g.lineTo(tx + 6 + i * 5, s.y + 9);
        g.stroke();
      }
      if (lit) {
        g.strokeStyle = '#ffffff';
        g.lineWidth = 2;
        g.strokeRect(tx - 3, s.y - 19, 35, 38);
      }
      if (on && act?.step !== s) dragCue(s.x + 18, s.y, s.x + 18 + PRY_PX, s.y, lit); // grab the lip and pull
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
    const cur = m;
    for (const [mach, at] of old ? [[old, oldSlide], [cur, slide]] as const : [[cur, slide]] as const) {
      m = mach; // drawMachine() draws the current one
      g.fillStyle = 'rgba(0, 0, 0, 0.35)';
      g.beginPath();
      g.ellipse(CX + at, CY + 70, 140, 9, 0, 0, 7);
      g.fill();
      g.save();
      g.translate(at, 0);
      drawMachine();
      g.restore();
    }
    m = cur;

    // a part on its way to the bag
    if (fly >= 0) {
      const t = Math.min(1, fly / FLY_S);
      const e = t * t;
      const to = bagAt(Math.min(bag.length, BAG_N - 1));
      glyph(flyItem.part, CX + (to.x - CX) * e, CY + (to.y - CY) * e - Math.sin(t * Math.PI) * 30, 1.1 - 0.6 * e, TIER_COLORS[flyItem.tier]);
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

    // the loading bar, drawn here so it keeps moving while the page is busy
    if (!bar) return;
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
    progress: (p: number) => (target = Math.max(target, p)),
    frame(dt: number) {
      dt = Math.min(0.05, dt);
      shown += (target - shown) * Math.min(1, dt * 6);
      update(dt);
      draw();
    },
  };
}
