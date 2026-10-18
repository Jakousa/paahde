// Client netcode:
// - Local player: client-side prediction. Every fixed tick we simulate our own input immediately,
//   send it with a sequence number and keep it as "pending". When a snapshot arrives we take the
//   server's state for us, drop the inputs it has acknowledged and replay the rest (reconciliation).
// - Remote players: entity interpolation. We render them INTERP_MS in the past, between the two
//   snapshots that surround that time, so their motion is smooth despite 20 Hz updates. INTERP_MS
//   grows by the measured network jitter, so late snapshots don't freeze them and then make them jump.
// - Clock: the server's time is taken from the least-delayed snapshot (the largest offset seen), not an
//   average, so the shared clock (wind, interpolation) doesn't wobble with jitter.
// - Terrain: the server owns the edit layer and sends absolute values. Our own dig strokes are predicted
//   immediately; the server's value for each predicted vertex is held back until a snapshot acks the
//   input that dug it (terrainEdit always arrives before that snapshot), then applied.
// - Survival: heat/canteen state comes from the server ('water'); src/water.ts plays drink/fill and asks.
//   Dying of heatstroke moves us to the base on the server; the next reconciliation snaps there.
// - Scrap: picked-up pieces are hidden (and lose their hitbox) as soon as we ask; the server sends the
//   piece back to us if it refuses, and our new bag if it agrees.
// - Items: moves between boxes (shared/items.ts) are applied at once with the server's own rules; its
//   'items' answer then replaces the boxes, which undoes a refused move.
//   Repairs at the workbench (fit / unfit, shared/gear.ts) work the same way.
// - Parts (shared/parts.ts): a part taken out of a machine in the disassembly mode goes in the bag at once
//   (predicted, like a move); the server checks it against the machine's roll and answers with the bag, or
//   'partRefused' (the part goes back in the machine) and the bag.
// - Loot (shared/loot.ts): what lies in the world, from the server; F asks to take it.
// - Hands: what we hold (canteen, drinking, filling) is sent when it changes and relayed in snapshots, cosmetic only;
//   with it the selected hotbar slot, which the server digs with (a shovel digs faster).
import { DIG, PILE, spawnState, step, type PlayerState } from '../shared/sim.ts';
import type { BenchJob, ClientMsg, DeathCause, Hands, PlayerSnap, ServerMsg } from '../shared/protocol.ts';
import { cellKey, cellX, cellZ, pitchFromQ, stroke, type Point } from '../shared/dig.ts';
import { bagShape, boxShape, digTool, fitPart, lockedWhileRiding, tryMove, unfitPart } from '../shared/gear.ts';
import { debrisItem, HOTBAR, roomFor, scrapItem, sortItems, type Slots } from '../shared/items.ts';
import type { Loot } from '../shared/loot.ts';
import { tools } from './input';
import { scrapChanged, scrapKey, scrapPiece, scrapTaken, type ScrapPiece } from '../shared/scrap.ts';
import { crashChanged, crashSpent, crashTaken } from '../shared/crash.ts';
import { growChest, isShared } from '../shared/storage.ts';
import { corpseBox, CORPSES } from '../shared/corpse.ts';
import { CRASH_KINDS } from '../shared/crashKinds.ts';
import type { CrashPiece } from '../shared/crashsites.ts';
import type { SiteLink } from './teardown/teardown';

/** Machine progress and table messages, handed to src/world/crash.ts and the disassembly mode (src/main.ts). */
export type SiteMsg = Extract<ServerMsg, { t: 'siteState' | 'siteDone' | 'siteTake' | 'sites' | 'siteReset' | 'bench' | 'siteTook' }>;
import { EDIT_CHUNK, edits, TerrainEdits } from '../shared/terrain.ts';
import { stormDrag, type Storm } from '../shared/storm.ts';
import type { Jet } from '../shared/jets.ts';
import { shiftToTimeOfDay } from '../shared/sun.ts';
import { setPlaced } from '../shared/placed.ts';
import type { BedState } from '../shared/garden.ts';

const INTERP_MS = 100;
/** Ceiling on the extra interpolation delay added for jitter. */
const MAX_JITTER_MS = 300;
/** Per snapshot, the clock offset creeps down this much (1 ms/s, to follow drift or a slower route)… */
const OFFSET_DECAY_MS = 0.05;
/** …and the jitter estimate decays by this factor (a ~5 s time constant at 20 Hz). */
const JITTER_DECAY = 0.99;

export type RemotePlayer = {
  id: number; color: number; x: number; y: number; z: number; facing: number; speed: number; grounded: boolean;
  vx: number; vz: number;
  sliding: boolean; // speed (Shift) slide
  crouching: boolean;
  pitch: number; // camera pitch in radians (negative = looking down)
  riding: boolean; // on the sand bike; facing is then the bike's heading
  jumpHeld: boolean; // Space down: a wheelie while riding
  vy: number;
  /** Kind of the item in their hand (selected hotbar slot), null for none; the gear they wear (wornGear bits). */
  item: string | null;
  /** Dead, lying as a ragdoll thrown by this push (m/s); null when alive. */
  down: [number, number, number] | null;
  gear: number;
  drinking: boolean;
  /** Filling their canteen at the pump. */
  filling: boolean;
};

type Snapshot = { time: number; players: Map<number, PlayerSnap> };

export class Net {
  status = 'connecting';
  id = 0;
  color = 0xffffff;
  /** Predicted local state (authoritative for physics on this client). */
  me: PlayerState = spawnState();
  /** The predicted state one tick before `me`: view() draws between the two. */
  private prev: PlayerState = this.me;
  /** Visual offset after a correction, decays to zero so corrections don't look like teleports. */
  errorX = 0;
  errorY = 0;
  errorZ = 0;

  private ws?: WebSocket;
  private seq = 0;
  private pending: { seq: number; input: number; yaw: number; drag: number }[] = [];
  private snapshots: Snapshot[] = [];
  private clockOffset?: number; // serverTime - localTime
  /** Recent worst snapshot delay beyond the best one (ms), and the eased interpolation delay. */
  private jitter = 0;
  private interpMs = INTERP_MS;
  private epoch?: number; // wall-clock ms at server time 0
  private retryMs = 500;
  private browserId: string;
  private joinedOnce = false;
  private digCooldown = 0;
  /** Take the next reconciliation as a teleport (respawn). */
  private snapNext = false;
  /** Predicted terrain vertices: the server's latest value, and the input seq that last dug there. */
  private predicted = new Map<number, { server: number; seq: number }>();
  /** Chunks we held before a (re)join; whatever the server doesn't resend is dropped. */
  private staleChunks = new Set<string>();
  /** What's in our hands, and what the server last heard (-1: tell it again, after a (re)join). */
  private hands: Hands = 0;
  private sentHands = -1;
  private sentSlot = -1;

  /** Loot in the world by id (shared/loot.ts), from the server. */
  loot = new Map<number, Loot>();
  onLoot?: () => void;

  /** The packs left by the dead changed (shared/corpse.ts CORPSES). */
  onCorpses?: () => void;

  /** Item boxes we can see (shared/storage.ts BoxId → slots): bag, equip, bench, bike and chests, from the server. */
  boxes: Record<string, Slots> = {};
  /** A box changed (server update or our own predicted move); `got` names a scrap pickup's item kind. */
  onItems?: (box: string, got?: string) => void;
  /** Ids for stacks split off by a predicted move, until the server's answer brings the real ones. */
  private tempId = 0;

  /** Shared large-site sessions: lifting eye holders by site and step (server 'siteHolders'), and the events for the
   *  disassembly mode (src/main.ts hands them to it). */
  private holders = new Map<string, Map<number, number>>();
  private holdTimers = new Map<string, ReturnType<typeof setInterval>>();
  onSite?: (msg: SiteMsg) => void;

  /** Heat meter, canteen sips, whether heat is building up, felt °C and shade (server 'water', shared/water.ts). */
  water = { heat: 0, sips: 0, maxSips: 0, rising: false, temp: 20, shade: true, at: 0 };
  onWater?: (w: { heat: number; sips: number; rising: boolean; temp: number; shade: boolean }) => void;
  /** We died (heatstroke, a drone's beam or a guardian): we lie where we fell until the server respawns us. */
  onDied?: (cause: DeathCause) => void;
  /** Dead and lying as a ragdoll: the push (m/s) that threw the body (shared/ragdoll.ts); null when alive. */
  down: [number, number, number] | null = null;
  /** Plant bed stages and growth by placed id (shared/garden.ts), from the server. Beds without one are empty. */
  garden = new Map<number, BedState>();
  /** Placed things changed (shared/placed.ts keeps the list), or a bed's stage did. */
  onPlaced?: () => void;
  /** A short message from the server for the HUD (a refused place, pickup or craft). */
  onNotice?: (text: string) => void;
  /** Sandstorms announced and not over yet (shared/storm.ts), times on the server clock. */
  storms: Storm[] = [];
  /** Fixed-wing drone flights in the air (shared/jets.ts), times on the server clock. */
  jets: Jet[] = [];
  /** Recent 'bots' messages (guardians and drones, shared/guardians.ts), oldest first; src/world/botFrames.ts
   *  interpolates them. */
  bots: Extract<ServerMsg, { t: 'bots' }>[] = [];
  /** A guardian's laser bolt was fired or burst (src/world/bolts.ts). */
  onBolt?: (msg: Extract<ServerMsg, { t: 'shot' | 'boom' | 'missile' | 'blast' }>) => void;
  /** A chat line from player `id` (us too), src/chat.ts. */
  onChat?: (msg: Extract<ServerMsg, { t: 'chat' }>) => void;
  /** Another player's laser rifle shot (src/rifle.ts draws it). */
  onZap?: (msg: Extract<ServerMsg, { t: 'zap' }>) => void;
  /** Thrown scrap flying, bouncing off a drone or landed (src/throw.ts). */
  onToss?: (msg: Extract<ServerMsg, { t: 'toss' | 'tossEnd' }>) => void;
  /** A bed we tended was planted or harvested. */
  onTended?: (what: 'planted' | 'harvested') => void;

  /** A dig/pile stroke landed: ours (predicted) or another player's. For effects only. */
  onDig?: (at: Point, pile: boolean, mine: boolean, id: number) => void;

  constructor(browserId: string) {
    this.browserId = browserId;
    this.connect();
  }

  get connected() {
    return this.id !== 0;
  }

  /** Called once per fixed tick with the sampled input and quantized camera yaw and pitch. */
  tick(input: number, yaw: number, pitch: number) {
    if (!this.connected || this.down) return; // the server ignores input while we lie dead
    this.seq++;
    this.prev = this.me;
    const drag = stormDrag(this.storms, this.me.x, this.me.y, this.me.z, this.serverTime());
    this.me = step(this.me, input, yaw, drag);
    this.pending.push({ seq: this.seq, input, yaw, drag });
    this.send({ t: 'input', seq: this.seq, input, yaw, pitch });
    this.predictDig(input, yaw, pitch);
  }

  /** Pick up a scrap piece: hidden now, confirmed (items) or put back by the server. False if the bag is full. */
  pickup(pc: ScrapPiece): boolean {
    if (!this.connected || scrapTaken.has(pc.key)) return true;
    if (!roomFor(this.boxes.bag ?? [], scrapItem(pc.kind), bagShape(this.boxes.equip))) return false;
    this.send({ t: 'pickup', ix: pc.ix, iz: pc.iz, i: pc.i });
    scrapTaken.add(pc.key);
    scrapChanged();
    return true;
  }

  /**
   * Move a stack between boxes (shared/gear.ts tryMove), turned if `r` (default: as it lies): applied now, the
   * server answers with both boxes. False if refused.
   */
  moveItem(from: string, fi: number, to: string, ti: number, n?: number, r?: boolean): boolean {
    if (!this.connected || (this.me.riding && lockedWhileRiding(from, fi))) return false;
    if (!tryMove(this.boxes, from, fi, to, ti, n, () => --this.tempId, r)) return false;
    this.growChests(from, to);
    this.send({ t: 'move', from, fi, to, ti, ...(n !== undefined ? { n } : {}), ...(r !== undefined ? { r } : {}) });
    this.onItems?.(from);
    if (to !== from) this.onItems?.(to);
    return true;
  }

  /** Fit a part into slot `slot` of the item on the workbench (shared/gear.ts fitPart). False if refused. */
  fit(from: string, fi: number, slot: number): boolean {
    if (!this.connected || !fitPart(this.boxes, from, fi, slot, () => --this.tempId)) return false;
    this.growChests(from);
    this.send({ t: 'fit', from, fi, slot });
    for (const box of new Set([from, 'bag', 'bench'])) this.onItems?.(box);
    return true;
  }

  /** Take a part out of the workbench item into box `to` slot ti (-1: anywhere). False if refused. */
  unfit(slot: number, to: string, ti: number): boolean {
    if (!this.connected || !unfitPart(this.boxes, slot, to, ti, () => --this.tempId)) return false;
    this.growChests(to);
    this.send({ t: 'unfit', slot, to, ti });
    for (const box of new Set([to, 'bench'])) this.onItems?.(box);
    return true;
  }

  /** Chests are endless (shared/storage.ts growChest): resize the ones a predicted change touched, like the server does. */
  private growChests(...boxes: string[]) {
    for (const b of boxes) if (isShared(b) && this.boxes[b]) growChest(this.boxes[b]);
  }

  /** Tidy a box's grid (the bag's hotbar stays put). False if it wouldn't all fit packed again (nothing changes). */
  sortBox(box: string): boolean {
    const slots = this.boxes[box];
    if (!this.connected || !slots || box === 'equip' || box === 'bench') return false;
    if (!sortItems(slots, boxShape(box, this.boxes))) return false;
    this.growChests(box);
    this.send({ t: 'sort', box });
    this.onItems?.(box);
    return true;
  }

  /** Drop one of the item at `box`[slot] on the sand (applied now; the server answers with the box and the loot). */
  dropItem(box: string, slot: number): boolean {
    const slots = this.boxes[box];
    const it = slots?.[slot];
    if (!this.connected || !it || (this.me.riding && lockedWhileRiding(box, slot))) return false;
    slots[slot] = it.n > 1 ? { ...it, n: it.n - 1 } : null;
    this.growChests(box);
    this.send({ t: 'drop', box, slot });
    this.onItems?.(box);
    return true;
  }

  /** Pick up loot (shared/loot.ts); the server answers with the bag, or a toast if it's full. */
  lootTake(id: number) {
    if (this.connected) this.send({ t: 'lootTake', id });
  }

  /** Debug menu: repaired gear of every kind. */
  debugGear() {
    if (this.connected) this.send({ t: 'debugGear' });
  }

  /** Carry off the small machine at a crash site: hidden now, confirmed (it lands in the bag) or put back by the server. */
  crashTake(id: string) {
    if (!this.connected || crashTaken.has(id)) return;
    this.send({ t: 'crashTake', id });
    crashTaken.add(id);
    crashChanged();
  }

  /** Pick up a crash debris piece (shared/crashsites.ts), the same way as a wreck. False if the bag is full. */
  debrisTake(pc: CrashPiece): boolean {
    if (!this.connected || !pc.id || crashTaken.has(pc.id)) return true;
    if (!roomFor(this.boxes.bag ?? [], debrisItem(CRASH_KINDS[pc.kind].node), bagShape(this.boxes.equip))) return false;
    this.crashTake(pc.id);
    return true;
  }

  /** Put a carried machine (its item kind) on the workbench; the server uses one up and answers with the bag. */
  crashUse(kind: string) {
    if (this.connected) this.send({ t: 'crashUse', kind });
  }

  /** The shared session of a large crash site, or of the disassembly table ('bench') (see SiteLink in src/teardown/teardown.ts). */
  siteLink(id: string): SiteLink {
    const key = (i: number) => `${id}:${i}`;
    return {
      join: () => this.send({ t: 'siteJoin', id }),
      leave: () => {
        for (const [k, t] of this.holdTimers) if (k.startsWith(`${id}:`)) { clearInterval(t); this.holdTimers.delete(k); }
        this.holders.delete(id);
        this.send({ t: 'siteLeave', id });
      },
      done: (i) => this.send({ t: 'siteDone', id, i }),
      take: (i) => this.send({ t: 'siteTake', id, i }),
      hold: (i, players, on) => {
        // The server forgets a hold after a few seconds, so keep saying it while we hold.
        const old = this.holdTimers.get(key(i));
        if (old) clearInterval(old);
        this.holdTimers.delete(key(i));
        this.send({ t: 'siteHold', id, i, players, on });
        if (on) this.holdTimers.set(key(i), setInterval(() => this.send({ t: 'siteHold', id, i, players, on: true }), 1000));
      },
      holders: (i) => this.holders.get(id)?.get(i) ?? 0,
    };
  }

  /** Say something in chat; it comes back as 'chat' to everyone. */
  chat(text: string) {
    if (this.connected) this.send({ t: 'chat', text });
  }

  /** One sip finished (src/water.ts); the server answers with 'water'. */
  drink() {
    this.send({ t: 'drink' });
  }

  /** A laser rifle shot from (x, y, z) to (ex, ey, ez); `hit`: weak point i of walker g, as we saw it (shared/rifle.ts). */
  /** Holding the jammer on a jet or drone (shared/jammer.ts), from the eye along the aim. */
  jam(kind: 'jet' | 'drone', id: number, x: number, y: number, z: number, dx: number, dy: number, dz: number) {
    this.send({ t: 'jam', kind, id, x, y, z, dx, dy, dz });
  }

  fire(x: number, y: number, z: number, ex: number, ey: number, ez: number, hit?: { g: number; i: number } | { d: number } | { j: number }) {
    const r = (n: number) => Math.round(n * 100) / 100;
    this.send({ t: 'fire', x: r(x), y: r(y), z: r(z), ex: r(ex), ey: r(ey), ez: r(ez), ...hit });
  }

  /** Throw the scrap in hotbar slot `slot` from (x, y, z) along unit (dx, dy, dz); `n` our count of throws. */
  throwScrap(slot: number, n: number, x: number, y: number, z: number, dx: number, dy: number, dz: number) {
    const r = (v: number) => Math.round(v * 1000) / 1000;
    this.send({ t: 'throw', slot, n, x: r(x), y: r(y), z: r(z), dx: r(dx), dy: r(dy), dz: r(dz) });
  }

  /** Guardian `g`'s foot came down on us (src/guardians.ts). */
  stomped(g: number) {
    this.send({ t: 'stomped', g });
  }

  /** Canteen refill finished at the base; the server answers with 'water'. */
  fill() {
    this.send({ t: 'fill' });
  }

  /**
   * What we're holding, for other players' view of us; sent when it changes. Call every frame. The server
   * shows others the item in the selected slot; `hands` adds drinking from the canteen or filling it.
   */
  setHands(held: string, drinking: boolean, filling: boolean) {
    this.hands = held === 'canteen' ? (drinking ? 2 : filling ? 3 : 1) : 0;
    if (this.connected && (this.hands !== this.sentHands || tools.slot !== this.sentSlot)) {
      this.send({ t: 'hands', hands: this.hands, slot: tools.slot });
      this.sentHands = this.hands;
      this.sentSlot = tools.slot;
    }
  }

  /** Plant or harvest a plant bed (its placed id); the server answers with 'garden' (and 'tended' to us). */
  tend(bed: number) {
    if (this.connected) this.send({ t: 'tend', bed });
  }

  /** Put down the placeable in bag slot `slot` (shared/placed.ts); the server answers 'placed' or a notice. */
  place(slot: number, x: number, z: number, rot: number) {
    if (this.connected) this.send({ t: 'place', slot, x, z, rot });
  }

  /** Pick a placed thing back up into the bag. */
  unplace(id: number) {
    if (this.connected) this.send({ t: 'unplace', id });
  }

  /** Craft at the workbench (shared/crafting.ts); the bag comes back with what was made, or a notice. */
  craft(recipe: string) {
    if (this.connected) this.send({ t: 'craft', recipe });
  }

  private applyScrap(msg: Extract<ServerMsg, { t: 'scrap' }>) {
    if (msg.reset) scrapTaken.clear();
    for (let i = 0; i + 2 < msg.taken.length; i += 3) {
      const pc = scrapPiece(msg.taken[i], msg.taken[i + 1], msg.taken[i + 2]);
      if (pc) scrapTaken.add(pc.key);
    }
    for (let i = 0; i + 2 < msg.back.length; i += 3) scrapTaken.delete(scrapKey(msg.back[i], msg.back[i + 1], msg.back[i + 2]));
    scrapChanged();
  }

  // Same countdown and stroke as the server's dig() in server/index.ts.
  private predictDig(input: number, yaw: number, pitch: number) {
    if (this.digCooldown > 0) this.digCooldown--;
    if (!(input & (DIG | PILE)) || this.digCooldown > 0 || this.me.riding) return;
    const pile = (input & DIG) === 0;
    const seq = this.seq;
    const tool = digTool(tools.slot >= 0 ? this.boxes.bag?.[tools.slot] : null);
    const at = stroke(edits, this.me, yaw, pitch, pile, (ix, iz, prev) => {
      const k = cellKey(ix, iz);
      const p = this.predicted.get(k);
      if (p) p.seq = seq;
      else this.predicted.set(k, { server: prev, seq });
    }, tool);
    if (!at) return;
    this.digCooldown = tool.cooldown;
    this.onDig?.(at, pile, true, this.id);
  }

  private applyTerrainEdit(cells: number[]) {
    for (let i = 0; i + 2 < cells.length; i += 3) {
      const ix = cells[i], iz = cells[i + 1], mm = cells[i + 2];
      const p = this.predicted.get(cellKey(ix, iz));
      if (p) p.server = mm; // held until the dig that predicted it is acked
      else edits.setMm(ix, iz, mm);
    }
  }

  private applyTerrainChunks(msg: Extract<ServerMsg, { t: 'terrainChunks' }>) {
    if (msg.reset) {
      this.staleChunks.clear();
      for (const [cx, cz] of edits.entries()) this.staleChunks.add(TerrainEdits.key(cx, cz));
    }
    for (const c of msg.chunks) {
      if (c.mm.length !== EDIT_CHUNK * EDIT_CHUNK) continue;
      this.staleChunks.delete(TerrainEdits.key(c.cx, c.cz));
      edits.setChunk(c.cx, c.cz, Int32Array.from(c.mm));
    }
    if (msg.done) {
      for (const k of this.staleChunks) {
        const [cx, cz] = k.split(',').map(Number);
        edits.deleteChunk(cx, cz);
      }
      this.staleChunks.clear();
    }
  }

  /** The server has processed inputs up to `ack`: its terrain values now include our predicted digs. */
  private resolvePredictions(ack: number) {
    for (const [k, p] of this.predicted) {
      if (p.seq > ack) continue;
      edits.setMm(cellX(k), cellZ(k), p.server);
      this.predicted.delete(k);
    }
  }

  /** Server clock in ms (local clock until the first snapshot), for effects all players should share. */
  serverTime(): number {
    return performance.now() + (this.clockOffset ?? 0);
  }

  /** Shared wall clock (Unix ms) on the server's time, for the day/night cycle. Local clock until welcome. */
  worldTime(): number {
    return this.epoch === undefined || this.clockOffset === undefined ? Date.now() : this.serverTime() + this.epoch;
  }

  /** Debug menu: move the shared clock so the time of day becomes `tod` for everyone (the server may refuse). */
  shareTimeOfDay(tod: number) {
    if (this.epoch === undefined) return;
    this.epoch += shiftToTimeOfDay(this.worldTime(), tod);
    this.send({ t: 'setEpoch', epoch: this.epoch });
  }

  /** Debug menu: the nearest guardian, or a drone, brought to us (shared/guardians.ts). */
  summonBot(what: 'guardian' | 'drone' | 'jet') {
    this.send({ t: 'summon', what });
  }

  /** Debug menu: a sandstorm where we stand, for everyone. */
  summonStorm() {
    this.send({ t: 'storm' });
  }

  /** Debug menu: put the shared clock back to real time. */
  resetSharedTime() {
    this.send({ t: 'setEpoch', epoch: null });
  }

  /**
   * Where to draw us: `alpha` (the leftover fraction of a tick, 0..1) of the way from the previous predicted
   * tick to the latest, plus the decaying correction. At 60 Hz ticks and a 120 Hz screen (or a frame that
   * runs two ticks) drawing the latest tick alone moves in uneven steps, which shows on the bike's 26 m/s.
   */
  view(alpha: number) {
    const a = this.prev, b = this.me;
    return {
      x: a.x + (b.x - a.x) * alpha + this.errorX,
      y: a.y + (b.y - a.y) * alpha + this.errorY,
      z: a.z + (b.z - a.z) * alpha + this.errorZ,
      heading: a.riding === b.riding ? lerpAngle(a.heading, b.heading, alpha) : b.heading, // mounting sets it
      facing: lerpAngle(a.facing, b.facing, alpha),
    };
  }

  /** Decay the visual error and interpolate remote players for this render frame. */
  frame(dtSeconds: number): RemotePlayer[] {
    const k = Math.exp(-dtSeconds * 15);
    this.errorX *= k;
    this.errorY *= k;
    this.errorZ *= k;
    // Ease towards the target delay so remote players slow down or speed up a little instead of jumping.
    const target = INTERP_MS + Math.min(this.jitter, MAX_JITTER_MS);
    this.interpMs += (target - this.interpMs) * (1 - Math.exp(-dtSeconds * 2));
    return this.interpolate(performance.now() + (this.clockOffset ?? 0) - this.interpMs);
  }

  private connect() {
    const ws = new WebSocket(new URL('ws', location.href.replace(/^http/, 'ws')));
    this.ws = ws;
    ws.onopen = () => {
      this.status = 'joining';
      // ?spawn=base / crash / field: start down in the bunker, the nearest crash site or scrap field (only on the
      // first join; a reconnect keeps where you are).
      const spawn = this.joinedOnce ? null : new URLSearchParams(location.search).get('spawn');
      this.send(spawn === 'base' || spawn === 'crash' || spawn === 'field' ? { t: 'hello', browserId: this.browserId, spawn } : { t: 'hello', browserId: this.browserId });
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data) as ServerMsg);
    ws.onclose = () => {
      this.id = 0;
      this.pending = [];
      this.snapshots = [];
      this.clockOffset = undefined; // a restarted server has a new clock
      this.jitter = 0;
      // Predicted vertices go back to the last server value; the rejoin resends all chunks anyway.
      for (const [k, p] of this.predicted) edits.setMm(cellX(k), cellZ(k), p.server);
      this.predicted.clear();
      this.digCooldown = 0;
      this.holders.clear();
      this.status = 'reconnecting';
      // Reconnect with backoff; deploys restart the server, so this is expected to happen.
      // Jitter spreads everyone's reconnects out after a restart.
      setTimeout(() => this.connect(), this.retryMs * (0.5 + Math.random()));
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    };
  }

  private onMessage(msg: ServerMsg) {
    if (msg.t === 'epoch') {
      this.epoch = msg.epoch;
      return;
    }
    if (msg.t === 'version') return reloadIfStale(msg.build);
    if (msg.t === 'terrainChunks') return this.applyTerrainChunks(msg);
    if (msg.t === 'terrainEdit') return this.applyTerrainEdit(msg.cells);
    if (msg.t === 'scrap') return this.applyScrap(msg);
    if (msg.t === 'items') {
      this.boxes[msg.box] = msg.slots;
      return this.onItems?.(msg.box, msg.got);
    }
    if (msg.t === 'corpses') {
      if (msg.reset) {
        for (const id of CORPSES.keys()) delete this.boxes[corpseBox(id)];
        CORPSES.clear();
      }
      for (const id of msg.remove) {
        CORPSES.delete(id);
        delete this.boxes[corpseBox(id)];
      }
      for (const c of msg.add) CORPSES.set(c.id, c);
      return this.onCorpses?.();
    }
    if (msg.t === 'loot') {
      if (msg.reset) this.loot.clear();
      for (const id of msg.remove) this.loot.delete(id);
      for (const l of msg.add) this.loot.set(l.id, l);
      return this.onLoot?.();
    }
    if (msg.t === 'crash') {
      if (msg.reset) crashTaken.clear();
      for (const id of msg.taken) crashTaken.add(id);
      for (const id of msg.back) crashTaken.delete(id);
      return crashChanged();
    }
    if (msg.t === 'crashSpent') {
      if (msg.reset) crashSpent.clear();
      for (const id of msg.spent) crashSpent.add(id);
      return crashChanged();
    }
    if (msg.t === 'siteHolders') {
      let m = this.holders.get(msg.id);
      if (!m) this.holders.set(msg.id, (m = new Map()));
      m.set(msg.i, msg.n);
      return;
    }
    if (msg.t === 'siteState' || msg.t === 'siteDone' || msg.t === 'siteTake' || msg.t === 'sites' || msg.t === 'siteReset' || msg.t === 'bench' || msg.t === 'siteTook') {
      if (msg.t === 'siteDone') this.holders.get(msg.id)?.delete(msg.i);
      return this.onSite?.(msg);
    }
    if (msg.t === 'water') {
      this.water = { heat: msg.heat, sips: msg.sips, maxSips: msg.maxSips, rising: msg.rising, temp: msg.temp, shade: msg.shade, at: performance.now() };
      return this.onWater?.(msg);
    }
    if (msg.t === 'died') {
      this.down = msg.push ?? [0, 0, 0];
      this.pending = []; // the server drops whatever we sent after dying, so don't replay it
      return this.onDied?.(msg.cause);
    }
    if (msg.t === 'respawn') {
      this.down = null;
      this.snapNext = true; // the next snapshot has us back at the base: jump there, don't glide
      return;
    }
    if (msg.t === 'placed') {
      setPlaced(msg.list);
      return this.onPlaced?.();
    }
    if (msg.t === 'garden') {
      this.garden = new Map(msg.beds.map((b) => [b.id, b]));
      return this.onPlaced?.();
    }
    if (msg.t === 'notice') return this.onNotice?.(msg.text);
    if (msg.t === 'tended') return this.onTended?.(msg.what);
    if (msg.t === 'storms') {
      this.storms = msg.storms;
      return;
    }
    if (msg.t === 'jets') {
      this.jets = msg.jets;
      return;
    }
    if (msg.t === 'shot' || msg.t === 'boom' || msg.t === 'missile' || msg.t === 'blast') return this.onBolt?.(msg);
    if (msg.t === 'zap') return this.onZap?.(msg);
    if (msg.t === 'toss' || msg.t === 'tossEnd') return this.onToss?.(msg);
    if (msg.t === 'chat') return this.onChat?.(msg);
    if (msg.t === 'bots') {
      this.bots.push(msg);
      if (this.bots.length > 12) this.bots.shift();
      return;
    }
    if (msg.t === 'dug') {
      if (msg.id !== this.id) this.onDig?.({ x: msg.x, y: msg.y, z: msg.z }, msg.pile, false, msg.id);
      return;
    }
    if (msg.t === 'welcome') {
      this.id = msg.id;
      this.joinedOnce = true;
      this.down = null;
      this.color = msg.color;
      this.epoch = msg.epoch;
      this.me = this.prev = msg.state;
      this.seq = 0;
      this.sentHands = -1;
      this.sentSlot = -1;
      this.retryMs = 500;
      this.status = 'online';
      return;
    }
    if (msg.t === 'snap') {
      // A snapshot can arrive late but never early: the largest offset is the least-delayed one. Creep
      // down slowly so clock drift and a slower route are still followed.
      const offset = msg.time - performance.now();
      this.clockOffset = this.clockOffset === undefined ? offset : Math.max(offset, this.clockOffset - OFFSET_DECAY_MS);
      this.jitter = Math.max(this.clockOffset - offset, this.jitter * JITTER_DECAY);

      const players = new Map(msg.players.map((p) => [p.id, p]));
      this.snapshots.push({ time: msg.time, players });
      while (this.snapshots.length > 30) this.snapshots.shift();

      this.resolvePredictions(msg.ack);
      const server = players.get(this.id);
      if (server) this.reconcile(server, msg.ack);
    }
  }

  private reconcile(server: PlayerState, ack: number) {
    this.pending = this.pending.filter((p) => p.seq > ack);
    let s: PlayerState = {
      x: server.x, y: server.y, z: server.z, vx: server.vx, vy: server.vy, vz: server.vz, facing: server.facing,
      grounded: server.grounded, airJumps: server.airJumps, jumpHeld: server.jumpHeld, landTicks: server.landTicks,
      sliding: server.sliding, crouching: server.crouching, slideCool: server.slideCool, slideSpent: server.slideSpent,
      riding: server.riding, bikeHeld: server.bikeHeld, heading: server.heading, bike: server.bike,
    };
    for (const p of this.pending) s = step(s, p.input, p.yaw, p.drag);
    this.errorX += this.me.x - s.x;
    this.errorY += this.me.y - s.y;
    this.errorZ += this.me.z - s.z;
    // Big jumps (respawn, long lag) should snap, not glide.
    if (this.snapNext || Math.hypot(this.errorX, this.errorY, this.errorZ) > 3) this.errorX = this.errorY = this.errorZ = 0;
    this.snapNext = false;
    // Move the previous tick with the correction, so view() between them doesn't jump either.
    const p = this.prev;
    this.prev = { ...p, x: p.x + s.x - this.me.x, y: p.y + s.y - this.me.y, z: p.z + s.z - this.me.z, heading: p.heading + s.heading - this.me.heading };
    this.me = s;
  }

  private interpolate(renderTime: number): RemotePlayer[] {
    const snaps = this.snapshots;
    if (snaps.length === 0) return [];
    let i = snaps.length - 1;
    while (i > 0 && snaps[i - 1].time > renderTime) i--;
    const b = snaps[i];
    const a = snaps[i - 1] ?? b;
    const t = b.time === a.time ? 1 : Math.min(1, Math.max(0, (renderTime - a.time) / (b.time - a.time)));
    const out: RemotePlayer[] = [];
    for (const pb of b.players.values()) {
      if (pb.id === this.id) continue;
      const pa = a.players.get(pb.id) ?? pb;
      const pick = t < 0.5 ? pa : pb; // discrete fields come from the nearer snapshot
      out.push({
        id: pb.id, color: pb.color,
        x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t, z: pa.z + (pb.z - pa.z) * t,
        facing: lerpAngle(pa.facing, pb.facing, t), speed: Math.hypot(pick.vx, pick.vz), vx: pick.vx, vz: pick.vz, grounded: pick.grounded, sliding: pick.sliding ?? false, crouching: pick.crouching ?? false,
        riding: pick.riding ?? false, jumpHeld: pick.jumpHeld ?? false, vy: pick.vy, item: pick.item ?? null, gear: pick.gear ?? 0, drinking: pick.hands === 2, filling: pick.hands === 3,
        pitch: pitchFromQ(pa.pitch ?? 32768) * (1 - t) + pitchFromQ(pb.pitch ?? 32768) * t, down: pb.down ?? null,
      });
    }
    return out;
  }

  private send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

export function getBrowserId(): string {
  try {
    let id = localStorage.getItem('dadajam.browserId');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('dadajam.browserId', id);
    }
    return id;
  } catch {
    return crypto.randomUUID(); // storage blocked: play as a fresh guest
  }
}

// A deploy restarts the server, so every client reconnects and hears the new build here. Reload to
// pick it up (position is kept server-side by browserId). Dev builds never reload, and we try each
// build only once per tab in case a cache still hands us the old page.
function reloadIfStale(build: string) {
  if (build === __BUILD_SHA__ || build === 'dev' || __BUILD_SHA__ === 'dev') return;
  try {
    if (sessionStorage.getItem('reloadedFor') === build) return;
    sessionStorage.setItem('reloadedFor', build);
  } catch {
    return;
  }
  location.reload();
}
