// The loading screen's game: a tiny version of the disassembly mode (src/teardown). A machine slides in; take it apart
// with the same moves as in the world, then take the freed parts and they go to the bag.
//   screws    click them (the dots round them count the clicks)    bolts     circle the pointer around them
//   wires     press on the wire and drag across it                 pry tabs  grab the lip and pull
// Machines are laid out like simple engineering diagrams: components sit on rails and meet at terminals, wires run
// between terminals in right angles, and what holds a thing is what it would be in real life: lids and plates by
// screws, bolts or a tab, a component by bolts through its base and by the wires on its terminals. Covers nest (a
// plate under a lid), a machine can hold several parts, and a wire between two parts frees both when it is cut.
// The first machines teach one move each, then the shapes mix; in a run they get more complex with every machine taken
// apart (with some luck either way), and the parts behind more work are better grades. The step markers look like the game's. Plain
// canvas 2D, and it knows nothing of the page: it runs in a worker (src/loadingWorker.ts, src/loadingGame.ts)
// because the main thread is busy building the world while this is up. The loading bar is drawn here too.
import type { TEXT } from '../shared/text.ts';

/** What the tip box can say (src/minigameMenu.ts): the kind of thing to do. */
export type Hint = keyof typeof TEXT.minigame.hint;

export const W = 520;
export const H = 270;
const BAR_Y = 262;
const BAR_W = 160;

const HI = '#ffd9a0'; // the disassembly UI's highlight
const MARK = '#ffb050'; // the step markers' orange (src/teardown/junk.ts)
const BODY = '#7a5238';
const TRIM = '#3b2616';
const STEEL = '#8a8f93';
const WIRE_COLORS = ['#c47a3a', '#b02a20', '#2858b8', '#d8a820'];
const TIER_COLORS = ['#b08a62', '#74d08a', '#ff9a3c', '#3ff0ff']; // shared/salvage.ts RARITY: scrap, basic, quality, space
const CX = 260; // the machine's centre on the canvas
const CY = 105;
const BAG_Y = 236;
const BAG_N = 12;
const BAG_GAP = 30;
/** The swap of one machine for the next, and a part's trip to the bag (s); the slide starts this far off screen. */
const SWAP_S = 0.18;
const FLY_S = 0.3;
const SLIDE_FROM = 420;
const CUT_PX = 60;
const PRY_PX = 64;
/** Where a component's terminals are from its centre, along its axis. */
const TERM = 27;

type P = [number, number];
type Kind = 'screw' | 'bolt' | 'wire' | 'pry';
type Shape = { t: 'rect'; w: number; h: number; r: number } | { t: 'circle'; r: number };
interface Step {
  kind: Kind;
  x: number;
  y: number;
  need: number;
  progress: number;
  done: boolean;
  after: Step[];
  /** The cover this sits under: it can't be reached until that one is off. */
  under: Cover | null;
  /** The cover it holds, if it is one of its fasteners. */
  owner: Cover | null;
  /** Pry tabs: the way they come off. Wires: the way to swipe (across the wire). */
  dx: number;
  dy: number;
  wire?: Wire;
}
interface Cover {
  shape: Shape;
  cx: number;
  cy: number;
  style: 'lid' | 'plate' | 'door';
  holds: Step[];
  under: Cover | null;
  released: boolean;
  age: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  /** The way it jumps off. */
  pop: P;
}
interface Wire {
  pts: P[];
  color: string;
  cut: Step;
}
interface Slot {
  part: number; // which glyph: 0 gear, 1 battery, 2 motor, 3 coil
  tier: number;
  x: number;
  y: number;
  rot: number;
  under: Cover | null;
  holds: Step[];
  taken: boolean;
  /** Bolted down through a base plate. */
  plate: boolean;
}
interface Decor {
  t: 'rail' | 'block' | 'pcb';
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Machine {
  body: { shape: Shape; x: number; y: number }[];
  covers: Cover[];
  steps: Step[];
  slots: Slot[];
  wires: Wire[];
  decor: Decor[];
  halfW: number;
  halfH: number;
  /** The best grade among its parts (the tag on its lid). */
  best: number;
}
interface Act {
  step: Step;
  x0: number;
  y0: number;
  prev: number;
  total: number;
}

export const visible = (u: Cover | null) => !u || u.released;
export const ready = (s: Step) => !s.done && s.after.every((a) => a.done) && visible(s.under);
export const free = (sl: Slot) => !sl.taken && visible(sl.under) && sl.holds.every((h) => h.done);

function inside(sh: Shape, dx: number, dy: number): boolean {
  return sh.t === 'rect' ? Math.abs(dx) <= sh.w / 2 && Math.abs(dy) <= sh.h / 2 : Math.hypot(dx, dy) <= sh.r;
}

function segDist(px: number, py: number, a: P, b: P): number {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(px - a[0] - vx * t, py - a[1] - vy * t);
}

/** A right-angled run from a to b: straight if they line up, else across, over and across (or the other way round). */
function route(a: P, b: P, vertical: boolean): P[] {
  if (a[0] === b[0] || a[1] === b[1]) return [a, b];
  if (!vertical) {
    const mx = (a[0] + b[0]) / 2;
    return [a, [mx, a[1]], [mx, b[1]], b];
  }
  const my = (a[1] + b[1]) / 2;
  return [a, [a[0], my], [b[0], my], b];
}

/** How much work it takes to get a part out: what holds the covers over it, and what holds it. Better parts are behind more. */
function effort(sl: Slot): number {
  const seen = new Set<Step>();
  const add = (s: Step) => seen.add(s);
  for (let c = sl.under; c; c = c.under) c.holds.forEach(add);
  sl.holds.forEach(add);
  let sum = 0;
  for (const s of seen) sum += s.kind === 'screw' ? s.need / 2 : s.kind === 'bolt' ? 1 + s.need : 2;
  return sum;
}

/** Part grade (0 scrap .. 3 space-grade) by effort and how far along the run is. */
const gradeOf = (sl: Slot, level: number) => {
  const e = effort(sl) + level * 0.15;
  return e < 5 ? 0 : e < 9 ? 1 : e < 14 ? 2 : 3;
};

/** A machine of complexity `L` (0 up; more covers, clicks, bolts, wires and parts as it grows, and the better the parts
 *  behind them). With `teach`, machines 0..3 are the fixed lessons: click, wire, bolt, pry, one at a time. */
export function buildMachine(L: number, rnd: () => number, teach = false): Machine {
  const M: Machine = { body: [], covers: [], steps: [], slots: [], wires: [], decor: [], halfW: 0, halfH: 0, best: 0 };
  const lesson = teach ? L : -1; // 0..3: which lesson
  const lv = teach ? 0 : L;
  const need = 2 + (lv >= 4 ? 1 : 0) + (lv >= 9 ? 1 : 0) + (lv >= 13 ? 1 : 0) + (lv >= 17 ? 1 : 0); // clicks per screw
  const turns = 1 + (lv >= 12 ? 1 : 0) + (lv >= 16 ? 1 : 0); // full turns per bolt
  const mountP = Math.min(0.85, lv * 0.09); // chance a component is bolted down through its base
  const rect = (w: number, h: number, r = 8): Shape => ({ t: 'rect', w, h, r });
  const circle = (r: number): Shape => ({ t: 'circle', r });
  const body = (shape: Shape, x = 0, y = 0) => M.body.push({ shape, x, y });
  const step = (kind: Kind, x: number, y: number, o: { need?: number; under?: Cover | null; dx?: number; dy?: number } = {}): Step => {
    const s: Step = { kind, x, y, need: o.need ?? 1, progress: 0, done: false, after: [], under: o.under ?? null, owner: null, dx: o.dx ?? 0, dy: o.dy ?? 0 };
    M.steps.push(s);
    return s;
  };
  const cover = (shape: Shape, cx: number, cy: number, style: Cover['style'], under: Cover | null, pop: P = [0.4, -1]): Cover => {
    const c: Cover = { shape, cx, cy, style, holds: [], under, released: false, age: 0, x: 0, y: 0, vx: 0, vy: 0, rot: 0, vr: 0, pop };
    M.covers.push(c);
    return c;
  };
  const hold = (c: Cover, s: Step) => {
    s.owner = c;
    c.holds.push(s);
  };
  const screws = (c: Cover, pts: P[]) => {
    for (const [x, y] of pts) hold(c, step('screw', x, y, { need, under: c.under }));
  };
  const slot = (part: number, x: number, y: number, under: Cover | null, rot = 0): Slot => {
    const s: Slot = { part, tier: 0, x, y, rot, under, holds: [], taken: false, plate: false };
    M.slots.push(s);
    return s;
  };
  const term = (s: Slot, side: 1 | -1): P => [s.x + Math.round(Math.cos(s.rot)) * side * TERM, s.y + Math.round(Math.sin(s.rot)) * side * TERM];
  /** A wire between two terminals; cutting it frees whatever holds it. `at`: where along its longest run to swipe. */
  const wire = (a: P, b: P, under: Cover | null, o: { vertical?: boolean; at?: number } = {}): Step => {
    const pts = route(a, b, !!o.vertical);
    let bi = 0, bl = -1;
    for (let k = 0; k + 1 < pts.length; k++) {
      const l = Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
      if (l > bl) (bl = l), (bi = k);
    }
    const t = o.at ?? 0.5;
    const p = pts[bi], q = pts[bi + 1];
    const horiz = Math.abs(q[0] - p[0]) >= Math.abs(q[1] - p[1]);
    const s = step('wire', p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, { under, dx: horiz ? 0 : 1, dy: horiz ? -1 : 0 });
    const w: Wire = { pts, color: WIRE_COLORS[Math.floor(rnd() * WIRE_COLORS.length)], cut: s };
    s.wire = w;
    M.wires.push(w);
    return s;
  };
  /** Bolts through a component's base (a gear: the one on its shaft). */
  const mount = (sl: Slot) => {
    const at: P[] = sl.part === 0 ? [[sl.x, sl.y]] : Math.round(Math.cos(sl.rot)) !== 0
      ? [[sl.x - 26, sl.y + 27], [sl.x + 26, sl.y + 27]]
      : [[sl.x - 27, sl.y - 26], [sl.x - 27, sl.y + 26]]; // (turned 90 degrees, its base plate is on the left)
    // Not where another fastener already is.
    if (at.some(([x, y]) => M.steps.some((o) => o.kind !== 'wire' && Math.hypot(o.x - x, o.y - y) < 27))) return;
    sl.plate = sl.part !== 0;
    for (const [x, y] of at) sl.holds.push(step('bolt', x, y, { need: turns, under: sl.under }));
  };
  const maybeMount = (sl: Slot) => {
    if (rnd() < mountP) mount(sl);
  };
  const corners = (hw: number, hh: number, n: number): P[] => ([[-hw, -hh], [hw, hh], [hw, -hh], [-hw, hh]] as P[]).slice(0, n);
  /** 2 lid screws, a third from level 2, a fourth from 5. */
  const lidScrews = (max: number) => Math.min(max, 2 + (lv >= 2 ? 1 : 0) + (lv >= 5 ? 1 : 0));

  /** A long run keeps adding to do: the lid of a crate or nested box also has a latch tab from level 8, two from 11. */
  const latches = (lid: Cover, x: number) => {
    if (teach) return;
    if (lv >= 8) hold(lid, step('pry', x, -24, { dx: 1 }));
    if (lv >= 11) hold(lid, step('pry', -x, -24, { dx: -1 }));
  };

  const all = ['crate', 'pump', 'cabinet', 'nested', 'twobay'] as const;
  const pool = lv < 1 ? all.slice(0, 1) : lv < 3 ? all.slice(0, 3) : all;
  const kind = teach ? (['crate', 'crate', 'pump', 'cabinet'] as const)[lesson] : pool[Math.floor(rnd() * pool.length)];

  if (kind === 'crate') {
    body(rect(250, 120));
    const lid = cover(rect(240, 110), 0, 0, 'lid', null);
    screws(lid, corners(108, 46, lidScrews(4)));
    latches(lid, 125);
    M.decor.push({ t: 'rail', x: 0, y: 50, w: 210, h: 6 });
    const variants = lesson === 0 || (!teach && lv < 1) ? ['one'] : lesson === 1 || lv < 3 ? ['elbow'] : lv < 5 ? ['elbow', 'block'] : ['elbow', 'block', 'three'];
    const variant = variants[Math.floor(rnd() * variants.length)];
    if (variant === 'one') {
      maybeMount(slot(Math.floor(rnd() * 4), 0, -2, lid));
    } else if (variant === 'elbow') {
      // two components side by side, wired through one run: one cut frees both
      const a = slot(1, -82, -22, lid);
      const b = slot(2, 82, 22, lid);
      const w = wire(term(a, 1), term(b, -1), lid);
      a.holds.push(w);
      b.holds.push(w);
      maybeMount(a);
    } else if (variant === 'block') {
      // each on its own wire to a terminal block between them
      const a = slot(1, -82, -10, lid);
      const b = slot(rnd() < 0.5 ? 2 : 3, 82, -10, lid);
      M.decor.push({ t: 'block', x: 0, y: -10, w: 22, h: 34 });
      a.holds.push(wire(term(a, 1), [-11, -10], lid));
      b.holds.push(wire([11, -10], term(b, -1), lid));
      maybeMount(a);
    } else {
      // three in a row, a wire between each pair: the middle one needs both cut
      const a = slot(1, -84, -10, lid);
      const b = slot(2, 0, -10, lid);
      const c = slot(3, 84, -10, lid);
      const w1 = wire(term(a, 1), term(b, -1), lid);
      const w2 = wire(term(b, 1), term(c, -1), lid);
      a.holds.push(w1);
      b.holds.push(w1, w2);
      c.holds.push(w2);
      maybeMount(b);
    }
  } else if (kind === 'pump') {
    const sides = teach || lv < 2 ? 0 : lv < 6 ? 1 : 2; // inspection plates on the sides, each with a part behind it
    body(circle(74));
    if (sides >= 1) body(rect(64, 76, 6), 88, 0);
    if (sides >= 2) body(rect(64, 76, 6), -88, 0);
    const lid = cover(circle(66), 0, 0, 'lid', null);
    screws(lid, [[-38, -38], [38, -38], [38, 38], [-38, 38]]);
    const gear = slot(0, 0, 0, lid);
    mount(gear);
    if (sides >= 1) {
      const plate = cover(rect(54, 62, 4), 88, 0, 'plate', null, [1, -0.6]);
      hold(plate, step('pry', 116, 0, { dx: 1 }));
      maybeMount(slot(3, 88, 0, plate));
    }
    if (sides >= 2) {
      const plate = cover(rect(54, 62, 4), -88, 0, 'plate', null, [-1, -0.6]);
      hold(plate, step('pry', -116, 0, { dx: -1 }));
      maybeMount(slot(2, -88, 0, plate));
    }
  } else if (kind === 'cabinet') {
    body(rect(168, 158, 6));
    const door = cover(rect(158, 148, 4), 0, 0, 'door', null, [1, -0.3]);
    hold(door, step('pry', 84, 0, { dx: 1 }));
    if (!teach && lv >= 2) screws(door, [[-66, -64]]);
    M.decor.push({ t: 'pcb', x: 0, y: 0, w: 132, h: 142 });
    const a = slot(1, 0, -48, door, Math.PI / 2);
    // from level 8 a shield plate on screws covers the lower component
    const shield = !teach && lv >= 6 ? cover(rect(120, 56, 3), 0, 50, 'plate', door, [0, -1]) : null;
    if (shield) screws(shield, [[52, 32], [52, 68]]); // on the side away from the component's bolts
    const b = slot(rnd() < 0.5 ? 3 : 2, 0, 48, shield ?? door, Math.PI / 2);
    const w = wire(term(a, 1), term(b, -1), door, { vertical: true });
    a.holds.push(w);
    b.holds.push(w);
    if (!teach) maybeMount(rnd() < 0.5 ? a : b);
  } else if (kind === 'nested') {
    // a lid with a bolted plate inside it, and the wire from outside the plate to the coil under it; deeper still, a
    // cap on screws over the coil
    body(rect(272, 132));
    const lid = cover(rect(262, 122), 0, 0, 'lid', null);
    screws(lid, corners(122, 50, lidScrews(4)));
    latches(lid, 136);
    M.decor.push({ t: 'rail', x: -88, y: 52, w: 70, h: 6 });
    const motor = slot(2, -88, -6, lid);
    const plate = cover(rect(122, 94, 4), 52, 0, 'plate', lid, [0.6, -1]);
    hold(plate, step('bolt', 6, -36, { need: turns, under: lid }));
    hold(plate, step('bolt', 98, 36, { need: turns, under: lid }));
    const cap = lv >= 8 ? cover(rect(54, 50, 4), 52, -6, 'plate', plate, [0, -1]) : null;
    if (cap) screws(cap, [[36, -22], [68, 10]]);
    const coil = slot(3, 52, -6, cap ?? plate);
    const w = wire(term(motor, 1), term(coil, -1), lid, { at: 0.3 });
    motor.holds.push(w);
    coil.holds.push(w);
    maybeMount(motor);
  } else {
    // two bays with a lid each, a link through the wall between them that has to be cut first
    body(rect(292, 112));
    M.decor.push({ t: 'rail', x: 0, y: 0, w: 8, h: 112 });
    const left = cover(rect(124, 102), -81, 0, 'lid', null, [-0.5, -1]);
    screws(left, [[-128, -38], [-34, -38]]);
    const right = cover(rect(124, 102), 81, 0, 'door', null, [1, -0.4]);
    if (rnd() < 0.5) hold(right, step('pry', 146, 0, { dx: 1 }));
    else screws(right, [[34, -38], [128, -38]]);
    const a = slot(1, -80, 0, left);
    const b = slot(rnd() < 0.5 ? 2 : 3, 80, 0, right);
    M.decor.push({ t: 'block', x: 0, y: 0, w: 30, h: 40 });
    const link = wire(term(a, 1), term(b, -1), null);
    a.holds.push(link);
    b.holds.push(link);
    maybeMount(rnd() < 0.5 ? a : b);
  }

  // From level 6, components that weren't bolted down get bolted down more and more often.
  if (!teach) for (const sl of M.slots) if (lv >= 6 && !sl.holds.some((h) => h.kind === 'bolt') && !sl.under?.under && rnd() < (lv - 5) * 0.12) mount(sl);
  for (const sl of M.slots) {
    sl.tier = gradeOf(sl, lv);
    M.best = Math.max(M.best, sl.tier);
  }

  // Half the machines are the other way round.
  if (rnd() < 0.5) {
    for (const b of M.body) b.x = -b.x;
    for (const c of M.covers) (c.cx = -c.cx), (c.pop = [-c.pop[0], c.pop[1]]);
    for (const s of M.steps) (s.x = -s.x), (s.dx = -s.dx);
    for (const s of M.slots) s.x = -s.x;
    for (const d of M.decor) d.x = -d.x;
    for (const w of M.wires) for (const p of w.pts) p[0] = -p[0];
  }
  for (const b of M.body) {
    const hw = Math.abs(b.x) + (b.shape.t === 'rect' ? b.shape.w / 2 : b.shape.r);
    const hh = Math.abs(b.y) + (b.shape.t === 'rect' ? b.shape.h / 2 : b.shape.r);
    M.halfW = Math.max(M.halfW, hw);
    M.halfH = Math.max(M.halfH, hh);
  }
  return M;
}

/** What it asks to have played (src/loadingGame.ts plays them: audio isn't there in a worker): the real teardown's metal
 *  hits (src/teardownSound.ts), the bolt's ring while it's turned and when it stops, and a part going into the bag. */
export type Sound = 'tink' | 'clink' | 'soft' | 'clang' | 'turn' | 'stop' | 'take';

/** 'free': the loading screen (no clock, no end). 5 / 10 / 20: a speedrun, the time to take that many machines apart.
 *  'endless': as many machines as you like in one go, scored by how many. */
export type Mode = 5 | 10 | 20 | 'endless' | 'free';
export interface RunResult {
  mode: Mode;
  machines: number;
  /** Milliseconds from the first click to the last part out. */
  ms: number;
}

/** m:ss.t */
export const clockText = (ms: number) => `${Math.floor(ms / 60000)}:${(Math.floor(ms / 100) / 10 % 60).toFixed(1).padStart(4, '0')}`;

/** `bar`: draw the loading bar under the game (the loading screen; not when played from the menu). */
export function createRunner(g: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, dpr: number, bar = true, sound: (s: Sound) => void = () => {}, run?: { mode: Mode; finish: (r: RunResult) => void; hint?: (k: Hint | null) => void }) {
  g.scale(dpr, dpr);
  const mode: Mode = run?.mode ?? 'free';
  const goal = typeof mode === 'number' ? mode : 0; // machines to take apart in a speedrun
  let done = 0; // machines emptied this run
  let t0 = 0; // performance.now() at the first click, 0 before it
  let finished = false;
  let lastMs = 0;
  // Tips: what to do with whatever can be worked now (told to the page, which shows them in a box above the game);
  // each kind goes once you've done its thing a few times.
  const learned: Record<Hint, number> = { screw: 0, bolt: 0, wire: 0, pry: 0, part: 0 };
  const LEARNED = 4;
  let hintKey: Hint | null = null;
  let target = 0; // loading progress asked for, and the eased value drawn
  let shown = 0;
  let clock = 0;
  let rand = 7;
  const rnd = () => ((rand = (rand * 16807) % 2147483647) / 2147483647);

  let n = 0; // machines so far
  /** Machine k of the run: its complexity grows with k, with some luck either way (the loading screen starts with
   *  the four lessons). */
  const make = (k: number): Machine => {
    if (mode === 'free' && k < 4) return buildMachine(k, rnd, true);
    const lo = mode === 'free' ? 4 : 0;
    // A run climbs about a level a machine, so every other one has something more to do; the loading screen is gentler.
    const level = Math.round((mode === 'free' ? k * 0.8 - 1 : k) + (rnd() - 0.5) * 2);
    return buildMachine(Math.max(lo, Math.min(20, level)), rnd);
  };
  let m = make(0);
  let slide = SLIDE_FROM; // the machine's x offset while it comes in (the first slides in, the rest swap with the old one)
  let old: Machine | null = null; // the machine just emptied, on its way out
  let oldSlide = 0;
  let swap = 0; // 0..1: the swap of old for new
  const flights: { t: number; part: number; tier: number; x: number; y: number; to: number }[] = []; // parts on their way to the bag
  // The bag holds stacks of the same part and grade, best grade first.
  const bag: { part: number; tier: number; count: number; pulse: number }[] = [];
  const stacks = (extra?: { part: number; tier: number }) => {
    const list = bag.map((b) => ({ part: b.part, tier: b.tier, count: b.count }));
    if (extra) {
      const hit = list.find((b) => b.part === extra.part && b.tier === extra.tier);
      if (hit) hit.count++;
      else list.push({ part: extra.part, tier: extra.tier, count: 1 });
    }
    return list.sort((a, b) => b.tier - a.tier || b.count - a.count || a.part - b.part);
  };
  let act: Act | null = null;
  let hover: Step | null = null;
  let px = -99; // the pointer, in canvas pixels
  let py = -99;

  const bagAt = (i: number) => ({ x: CX + (i - (BAG_N - 1) / 2) * BAG_GAP, y: BAG_Y });

  /** What a pointer at (x, y) in the machine's own frame is on: the first ready step there. */
  const stepAt = (x: number, y: number): Step | null => {
    for (const s of m.steps) {
      if (!ready(s)) continue;
      if (s.kind === 'wire') {
        if (m.covers.some((c) => !c.released && inside(c.shape, x - c.cx, y - c.cy))) continue; // under a lid
        const pts = s.wire!.pts;
        for (let k = 0; k + 1 < pts.length; k++) if (segDist(x, y, pts[k], pts[k + 1]) < 11) return s;
      } else if (s.kind === 'pry') {
        const off = s.progress * PRY_PX + 7;
        if (Math.hypot(x - s.x - s.dx * off, y - s.y - s.dy * off) < 20) return s;
      } else if (Math.hypot(x - s.x, y - s.y) < (s.kind === 'bolt' ? 22 : 17)) return s;
    }
    return null;
  };

  const finish = (s: Step) => {
    s.done = true;
    s.progress = s.need;
    learned[s.kind]++;
    sound(s.kind === 'pry' || s.kind === 'wire' ? 'soft' : 'clink');
    if (s.kind === 'bolt') sound('stop');
    for (const c of m.covers) {
      if (c.released || !c.holds.every((h) => h.done)) continue;
      sound('clang'); // the cover drops
      c.released = true;
      c.vx = c.pop[0] * 130;
      c.vy = c.pop[1] * 260 - 60;
      c.vr = c.pop[0] * 2.4 || 1.5;
    }
  };

  function finishRun() {
    if (finished) return;
    finished = true;
    act = null;
    lastMs = Math.round(performance.now() - t0);
    run?.finish({ mode, machines: done, ms: lastMs });
  }

  function down(x: number, y: number) {
    px = x;
    py = y;
    if (finished) return;
    if (!t0) t0 = performance.now();
    const lx = x - slide - CX;
    const ly = y - CY;
    for (const sl of m.slots) {
      if (!free(sl) || Math.hypot(lx - sl.x, ly - sl.y) > 30) continue;
      // Into the bag; when the last part is out the next machine comes in as this one goes out.
      sl.taken = true;
      learned.part++;
      const to = stacks(sl).findIndex((b) => b.part === sl.part && b.tier === sl.tier);
      flights.push({ t: 0, part: sl.part, tier: sl.tier, x: CX + slide + sl.x, y: CY + sl.y, to: Math.min(to, BAG_N - 1) });
      sound('take');
      if (m.slots.every((o) => o.taken)) {
        done++;
        if (goal && done >= goal) return finishRun();
        old = m;
        oldSlide = slide;
        m = make(++n);
        swap = 0;
        act = null;
      }
      return;
    }
    const s = stepAt(lx, ly);
    if (!s) return;
    if (s.kind === 'screw') {
      s.progress++;
      if (s.progress >= s.need) finish(s);
      else sound('tink');
    } else {
      act = { step: s, x0: lx, y0: ly, prev: Math.atan2(ly - s.y, lx - s.x), total: 0 };
    }
  }

  function move(x: number, y: number) {
    px = x;
    py = y;
    const lx = x - slide - CX;
    const ly = y - CY;
    if (!act) {
      hover = stepAt(lx, ly);
      return;
    }
    const s = act.step;
    if (s.kind === 'bolt') {
      const a = Math.atan2(ly - s.y, lx - s.x);
      let d = a - act.prev;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      act.prev = a;
      if (Math.hypot(lx - s.x, ly - s.y) > 12) {
        act.total += Math.abs(d);
        if (d) sound('turn');
      }
      s.progress = Math.min(1, act.total / (2 * Math.PI * s.need)); // `need` turns
    } else if (s.kind === 'wire') {
      s.progress = Math.min(1, Math.hypot(lx - act.x0, ly - act.y0) / CUT_PX);
    } else {
      s.progress = Math.min(1, Math.max(0, (lx - act.x0) * s.dx + (ly - act.y0) * s.dy) / PRY_PX);
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

  /** The hint for now: a free part first (the next thing to do), else the kinds of step that can be worked, in turn. */
  function wantedHint(): Hint | null {
    if (finished) return null;
    const list: Hint[] = [];
    if (learned.part < 3 && m.slots.some(free)) list.push('part');
    else for (const k of ['screw', 'bolt', 'wire', 'pry'] as const) if (learned[k] < LEARNED && m.steps.some((s) => s.kind === k && ready(s))) list.push(k);
    return list.length ? list[Math.floor(clock / 4) % list.length] : null;
  }

  function update(dt: number) {
    clock += dt;
    const want = wantedHint();
    if (want !== hintKey) {
      hintKey = want;
      run?.hint?.(want);
    }
    for (const mm of old ? [m, old] : [m]) {
      for (const c of mm.covers) {
        if (!c.released) continue;
        c.age += dt;
        c.vy += 1100 * dt;
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.rot += c.vr * dt;
      }
    }
    if (swap < 1) {
      swap = Math.min(1, swap + dt / SWAP_S);
      const e = 1 - Math.pow(1 - swap, 3);
      slide = SLIDE_FROM * (1 - e);
      oldSlide = -SLIDE_FROM * e;
      if (swap >= 1) old = null;
    }
    for (const b of bag) b.pulse = Math.max(0, b.pulse - dt * 3);
    for (let i = flights.length - 1; i >= 0; i--) {
      flights[i].t += dt;
      if (flights[i].t >= FLY_S) {
        const f = flights[i];
        const have = bag.find((b) => b.part === f.part && b.tier === f.tier);
        if (have) {
          have.count++;
          have.pulse = 1;
        } else bag.push({ part: f.part, tier: f.tier, count: 1, pulse: 1 });
        flights.splice(i, 1);
      }
    }
  }

  // ---- drawing -----------------------------------------------------------------------------------------------

  function glyph(kind: number, x: number, y: number, s: number, color: string, rot = 0) {
    g.save();
    g.translate(x, y);
    g.rotate(rot);
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
  // arrowhead; wires and pry tabs show the grab: a pointer ring presses ON the thing and drags the way to go,
  // leaving a trail.
  const markColor = (lit: boolean) => (lit ? '#ffffff' : MARK);

  /** The grab cue: press at (x0, y0), drag to (x1, y1), let go, repeat. */
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
    // the pointer: a ring with a dot
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
    // an arrowhead where the drag ends: a direction, not something to take hold of in the middle
    g.globalAlpha = fade * 0.9;
    const ang = Math.atan2(y1 - y0, x1 - x0);
    g.beginPath();
    g.moveTo(x1 + Math.cos(ang) * 8, y1 + Math.sin(ang) * 8);
    g.lineTo(x1 + Math.cos(ang + 2.4) * 7, y1 + Math.sin(ang + 2.4) * 7);
    g.lineTo(x1 + Math.cos(ang - 2.4) * 7, y1 + Math.sin(ang - 2.4) * 7);
    g.fill();
    g.restore();
  }

  function shapePath(sh: Shape) {
    g.beginPath();
    if (sh.t === 'rect') g.roundRect(-sh.w / 2, -sh.h / 2, sh.w, sh.h, sh.r);
    else g.arc(0, 0, sh.r, 0, 7);
  }

  /** A fastener: what it looks like on its own, not its marker. */
  function drawFastener(s: Step) {
    const dim = ready(s) ? 1 : 0.4;
    g.globalAlpha = dim;
    if (s.kind === 'screw') {
      if (s.done) return void (g.globalAlpha = 1);
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
      }
    } else if (s.kind === 'pry' && !s.done) {
      // the panel tab: a plate with grip ridges and a lip, sticking out the way it comes off
      const off = s.progress * PRY_PX;
      g.save();
      g.translate(s.x + s.dx * off, s.y + s.dy * off);
      g.rotate(Math.atan2(s.dy, s.dx));
      g.fillStyle = STEEL;
      g.strokeStyle = TRIM;
      g.lineWidth = 2;
      g.beginPath();
      g.roundRect(-6, -15, 26, 30, 3);
      g.fill();
      g.stroke();
      g.fillStyle = '#6c7175';
      g.fillRect(16, -17, 6, 34);
      g.strokeStyle = '#2b2622';
      for (let i = 0; i < 3; i++) {
        g.beginPath();
        g.moveTo(i * 5 + 1, -9);
        g.lineTo(i * 5 + 1, 9);
        g.stroke();
      }
      if (hover === s || act?.step === s) {
        g.strokeStyle = '#ffffff';
        g.lineWidth = 2;
        g.strokeRect(-9, -19, 35, 38);
      }
      g.restore();
    }
    g.globalAlpha = 1;
  }

  /** The marker of a step that can be worked now, on top of everything. */
  function drawMarker(s: Step) {
    const lit = hover === s || act?.step === s;
    const c = markColor(lit);
    if (s.kind === 'screw') {
      // a dot per click still to do, in a ring round the screw, tapping one after another
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
    } else if (s.kind === 'bolt') {
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
        // a three-quarter arc turning round with an arrowhead on its end
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
        // pointing the way the arc goes (along its tangent), wide across the arc
        const tnx = -Math.sin(a1), tny = Math.cos(a1);
        const rdx = Math.cos(a1), rdy = Math.sin(a1);
        g.moveTo(tx + tnx * 9, ty + tny * 9);
        g.lineTo(tx - tnx * 2 + rdx * 5.5, ty - tny * 2 + rdy * 5.5);
        g.lineTo(tx - tnx * 2 - rdx * 5.5, ty - tny * 2 - rdy * 5.5);
        g.closePath();
        g.fill();
      }
    } else if (s.kind === 'wire') {
      if (act?.step === s) {
        // being swiped: the cut line from where you pressed to the pointer
        g.strokeStyle = '#ffffff';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(act.x0, act.y0);
        g.lineTo(px - slide - CX, py - CY);
        g.stroke();
      } else dragCue(s.x, s.y, s.x + s.dx * CUT_PX, s.y + s.dy * CUT_PX, lit); // press ON the wire and drag across it
    } else if (act?.step !== s) {
      // the way it comes out: a track to the end of the pull, with chevrons running along it, and the grab on the lip
      g.save();
      g.translate(s.x, s.y);
      g.rotate(Math.atan2(s.dy, s.dx));
      g.setLineDash([3, 5]);
      g.strokeStyle = 'rgba(255, 176, 80, 0.45)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(26, 0);
      g.lineTo(PRY_PX + 20, 0);
      g.stroke();
      g.setLineDash([]);
      g.strokeStyle = c;
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(PRY_PX + 20, -9);
      g.lineTo(PRY_PX + 20, 9);
      g.stroke();
      for (let i = 0; i < 3; i++) {
        const q = (clock * 1.1 + i / 3) % 1;
        const cx = 30 + q * (PRY_PX - 22);
        g.globalAlpha = Math.sin(q * Math.PI) * 0.9;
        g.beginPath();
        g.moveTo(cx - 4, -6);
        g.lineTo(cx + 3, 0);
        g.lineTo(cx - 4, 6);
        g.stroke();
      }
      g.globalAlpha = 1;
      dragCue(19, 0, 19 + PRY_PX, 0, lit);
      g.restore();
    }
  }

  function drawWire(w: Wire) {
    const cut = w.cut.done;
    const on = ready(w.cut);
    const lit = hover === w.cut || act?.step === w.cut;
    const trace = (pts: P[]) => {
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]);
      g.stroke();
    };
    let runs: P[][] = [w.pts];
    if (cut) {
      // the run is broken in the middle of the cut segment: two ends hanging
      let at = 0;
      let best = Infinity;
      for (let k = 0; k + 1 < w.pts.length; k++) {
        const d = segDist(w.cut.x, w.cut.y, w.pts[k], w.pts[k + 1]);
        if (d < best) (best = d), (at = k);
      }
      const p = w.pts[at], q = w.pts[at + 1];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      const ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
      const gx = w.cut.x, gy = w.cut.y;
      runs = [[...w.pts.slice(0, at + 1), [gx - ux * 8, gy - uy * 8]], [[gx + ux * 8, gy + uy * 8], ...w.pts.slice(at + 1)]];
    }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (on) {
      // a glow round the wire says it's the thing to grab
      g.strokeStyle = lit ? 'rgba(255, 255, 255, 0.35)' : `rgba(255, 176, 80, ${0.22 + 0.12 * Math.sin(clock * 5)})`;
      g.lineWidth = 13;
      for (const r of runs) trace(r);
    }
    g.strokeStyle = w.color;
    g.lineWidth = 5;
    for (const r of runs) trace(r);
    g.lineJoin = 'miter';
    // solder dots at the terminals
    g.fillStyle = '#d9b66a';
    for (const p of [w.pts[0], w.pts[w.pts.length - 1]]) {
      g.beginPath();
      g.arc(p[0], p[1], 3.2, 0, 7);
      g.fill();
    }
  }

  function drawSlot(sl: Slot) {
    if (sl.taken) return;
    const open = free(sl);
    g.save();
    g.translate(sl.x, sl.y);
    g.rotate(sl.rot);
    if (sl.part !== 0) {
      // leads out to the terminals
      g.strokeStyle = '#d9b66a';
      g.fillStyle = '#d9b66a';
      g.lineWidth = 3;
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(side * 16, 0);
        g.lineTo(side * TERM, 0);
        g.stroke();
        g.fillRect(side * TERM - 3.5, -3.5, 7, 7);
      }
    }
    if (sl.plate) {
      g.fillStyle = TRIM;
      g.fillRect(-34, 21, 68, 12);
    }
    g.restore();
    if (open) {
      // glows in its rarity colour and pulses once it's free
      const c = TIER_COLORS[sl.tier];
      const r = 36 + Math.sin(clock * 5) * 4;
      const grad = g.createRadialGradient(sl.x, sl.y, 6, sl.x, sl.y, r);
      grad.addColorStop(0, c + 'aa');
      grad.addColorStop(1, c + '00');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(sl.x, sl.y, r, 0, 7);
      g.fill();
    }
    g.globalAlpha = open ? 1 : 0.55;
    glyph(sl.part, sl.x, sl.y, 1, TIER_COLORS[sl.tier], sl.rot);
    g.globalAlpha = 1;
  }

  function drawCover(c: Cover, tag: number) {
    g.save();
    g.globalAlpha = c.released ? Math.max(0, 1 - c.age) : 1;
    g.translate(c.cx + c.x, c.cy + c.y);
    g.rotate(c.rot);
    shapePath(c.shape);
    g.fillStyle = c.style === 'lid' ? BODY : c.style === 'door' ? '#56705e' : '#6c7175';
    g.fill();
    g.strokeStyle = c.style === 'lid' ? TRIM : c.style === 'door' ? '#2b3a30' : '#2b2622';
    g.lineWidth = 4;
    g.stroke();
    const dark = c.style === 'lid' ? 'rgba(160, 74, 32, 0.8)' : 'rgba(0, 0, 0, 0.22)';
    if (c.style === 'lid' && c.shape.t === 'rect') {
      g.fillStyle = dark;
      g.fillRect(-c.shape.w / 2 + 24, -8, c.shape.w - 48, 16); // the accent stripe
      g.fillStyle = TIER_COLORS[tag];
      g.fillRect(-c.shape.w / 2 + 24, -8, 14, 16); // the rarity tag: the best grade inside
      g.fillStyle = TRIM;
      const vy = c.shape.h / 2 - 20;
      for (let i = -2; i <= 2; i++) g.fillRect(i * 22 - 3, vy, 6, 3); // vents
    } else if (c.style === 'lid') {
      g.strokeStyle = dark;
      g.lineWidth = 6;
      g.beginPath();
      g.arc(0, 0, (c.shape as { r: number }).r * 0.55, 0, 7);
      g.stroke();
    } else if (c.style === 'door' && c.shape.t === 'rect') {
      g.strokeStyle = dark;
      g.lineWidth = 2;
      g.strokeRect(-c.shape.w / 2 + 8, -c.shape.h / 2 + 8, c.shape.w - 16, c.shape.h - 16); // a pressed panel
    } else if (c.shape.t === 'rect') {
      g.fillStyle = dark;
      g.fillRect(-c.shape.w / 2 + 8, -2, c.shape.w - 16, 4); // a label line
    }
    // its fasteners ride on it
    if (!c.released) {
      g.translate(-(c.cx + c.x), -(c.cy + c.y));
      g.rotate(-c.rot);
      for (const s of c.holds) drawFastener(s);
    }
    g.restore();
  }

  function drawMachine(mm: Machine, markers: boolean) {
    for (const b of mm.body) {
      g.save();
      g.translate(b.x, b.y);
      shapePath(b.shape);
      g.fillStyle = '#251509';
      g.fill();
      g.strokeStyle = TRIM;
      g.lineWidth = 4;
      g.stroke();
      g.restore();
    }
    for (const d of mm.decor) {
      if (d.t === 'rail') {
        g.fillStyle = TRIM;
        g.fillRect(d.x - d.w / 2, d.y - d.h / 2, d.w, d.h);
      } else if (d.t === 'block') {
        // a terminal block: a body with a screw per terminal
        g.fillStyle = '#2b2622';
        g.strokeStyle = '#1c0f07';
        g.lineWidth = 2;
        g.beginPath();
        g.roundRect(d.x - d.w / 2, d.y - d.h / 2, d.w, d.h, 3);
        g.fill();
        g.stroke();
        g.fillStyle = STEEL;
        for (const k of [-1, 1]) {
          g.beginPath();
          g.arc(d.x, d.y + k * d.h * 0.28, 3, 0, 7);
          g.fill();
        }
      } else {
        // a circuit board with a few traces and chips
        g.fillStyle = '#1f5a36';
        g.fillRect(d.x - d.w / 2, d.y - d.h / 2, d.w, d.h);
        g.strokeStyle = 'rgba(255, 255, 255, 0.12)';
        g.lineWidth = 1.5;
        for (let k = -2; k <= 2; k++) {
          g.beginPath();
          g.moveTo(d.x + k * 22, d.y - d.h / 2 + 6);
          g.lineTo(d.x + k * 22, d.y + d.h / 2 - 6);
          g.stroke();
        }
        g.fillStyle = '#14181c';
        g.fillRect(d.x - d.w / 2 + 10, d.y - d.h / 2 + 10, 20, 12);
        g.fillRect(d.x + d.w / 2 - 30, d.y + d.h / 2 - 22, 20, 12);
      }
    }
    for (const w of mm.wires) drawWire(w);
    for (const sl of mm.slots) {
      drawSlot(sl);
      for (const s of sl.holds) if (s.kind === 'bolt') drawFastener(s);
    }
    // inner covers first, so the outer one is on top of them
    for (let k = mm.covers.length - 1; k >= 0; k--) {
      const c = mm.covers[k];
      if (!c.released || c.age < 1) drawCover(c, mm.best);
    }
    if (markers) for (const s of mm.steps) if (ready(s)) drawMarker(s);
  }

  function draw() {
    g.clearRect(0, 0, W, H);
    for (const [mach, at, markers] of old ? ([[old, oldSlide, false], [m, slide, true]] as const) : ([[m, slide, true]] as const)) {
      g.fillStyle = 'rgba(0, 0, 0, 0.35)';
      g.beginPath();
      g.ellipse(CX + at, CY + mach.halfH - 2, mach.halfW * 0.95, 9, 0, 0, 7);
      g.fill();
      g.save();
      g.translate(CX + at, CY);
      drawMachine(mach, markers);
      g.restore();
    }

    // parts on their way to the bag
    for (const f of flights) {
      const t = Math.min(1, f.t / FLY_S);
      const e = t * t;
      const to = bagAt(f.to);
      glyph(f.part, f.x + (to.x - f.x) * e, f.y + (to.y - f.y) * e - Math.sin(t * Math.PI) * 30, 1.1 - 0.6 * e, TIER_COLORS[f.tier]);
    }
    // the bag: a stack per part and grade, best grade first; the grade is the colour of the frame and glow, the number
    // how many; a stack that just got one pulses
    const list = stacks();
    for (let i = 0; i < BAG_N; i++) {
      const b = bagAt(i);
      const it = list[i];
      const pulse = it ? (bag.find((o) => o.part === it.part && o.tier === it.tier)?.pulse ?? 0) : 0;
      g.fillStyle = 'rgba(28, 15, 7, 0.8)';
      g.strokeStyle = 'rgba(255, 240, 220, 0.16)';
      g.lineWidth = 1;
      g.beginPath();
      g.roundRect(b.x - 13, b.y - 13, 26, 26, 4);
      g.fill();
      g.stroke();
      if (!it) continue;
      const c = TIER_COLORS[it.tier];
      if (it.tier >= 2) {
        const glow = g.createRadialGradient(b.x, b.y, 4, b.x, b.y, 24);
        glow.addColorStop(0, c + '66');
        glow.addColorStop(1, c + '00');
        g.fillStyle = glow;
        g.fillRect(b.x - 24, b.y - 24, 48, 48);
      }
      g.strokeStyle = c;
      g.lineWidth = it.tier >= 2 ? 2 : 1.5;
      g.beginPath();
      g.roundRect(b.x - 13, b.y - 13, 26, 26, 4);
      g.stroke();
      glyph(it.part, b.x, b.y, 0.5 + pulse * 0.18, c);
      if (it.count > 1) {
        g.fillStyle = '#fff4e4';
        g.font = '600 9px ui-monospace, Menlo, Consolas, monospace';
        g.textAlign = 'right';
        g.textBaseline = 'alphabetic';
        g.fillText(String(it.count), b.x + 12, b.y + 11);
      }
    }

    // the run's clock and count
    if (mode !== 'free') {
      g.fillStyle = HI;
      g.font = '600 14px ui-monospace, Menlo, Consolas, monospace';
      g.textBaseline = 'top';
      g.textAlign = 'left';
      if (mode !== 'endless') g.fillText(clockText(finished ? lastMs : t0 ? performance.now() - t0 : 0), 12, 10);
      g.textAlign = 'right';
      g.fillText(goal ? `${done}/${goal}` : String(done), W - 12, 10);
      g.textBaseline = 'alphabetic';
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
    /** For looking at a machine without playing up to it (tools, not the game). */
    debugMachine(i: number, seed = 7, peel = 0) {
      rand = seed;
      m = buildMachine(i, rnd, false);
      slide = 0;
      swap = 1;
      // peel: take that many covers off, outermost first, to see what is under them
      for (const c of m.covers.slice(0, peel)) {
        for (const h of c.holds) h.done = true;
        c.released = true;
        c.age = 2;
      }
    },
    debugState: () => ({ m, slide, done, finished }),
    debugBag(list: [number, number, number][]) {
      for (const [part, tier, count] of list) bag.push({ part, tier, count, pulse: 0 });
    },
    /** Endless: stop here with the machines done so far. */
    finishNow() {
      if (done > 0) finishRun();
    },
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
