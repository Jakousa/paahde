// One simulated player in one world: a greedy agent that goes out for whatever moves its next goals along the most per
// second (risk, heat and bag room counted), brings it home, takes machines apart, repairs and crafts, and calls the
// bosses when it can. The rules are the game's (bag grid, gear slots and quality, recipes, machine contents, drop
// dice); every enemy (where it's met, what it leaves, the fight odds) is shared/enemies.ts; the times are
// tools/econsim/costs.ts. Deterministic for a world and a seed.
import { BASE } from '../../shared/base.ts';
import { biome } from '../../shared/biomes.ts';
import { BOSS_KINDS, BOSS_LIVES, RECEIVERS, type BossKind } from '../../shared/bosses.ts';
import { ENEMIES, fightOdds, type EnemyKind, type Meet, type Weapon } from '../../shared/enemies.ts';
import * as crafting from '../../shared/crafting.ts';
import { RECIPES, type Ingredient, type Recipe } from '../../shared/crafting.ts';
import { type LootLevel } from '../../shared/crashsites.ts';
import { seeded } from '../../shared/crash.ts';
import {
  bagShape, backpackRows, bikeTopSpeed, canteenSips, EQUIP_SLOTS, fitsSlot, GEAR, quality, repaired, shieldSaves, spyglassZoom, tierOf, type EquipSlot,
} from '../../shared/gear.ts';
import { addItem, BAG_SLOTS, BIKE_COLS, BIKE_ROWS, CLOTH, gridShape, HOTBAR, parsePart, SCRAP, type Item, type Shape, type Slots } from '../../shared/items.ts';
import { type Drop, type Rand } from '../../shared/lootRoll.ts';
import { machineParts } from '../../shared/machine.ts';
import { frameScrap, stepList } from '../../shared/machineSteps.ts';
import { PART_IDS, partItem } from '../../shared/parts.ts';
import { COMPONENTS, junkSpec, SALVAGE, type JunkKind, type PartId } from '../../shared/salvage.ts';
import { DAY_SECONDS } from '../../shared/sun.ts';
import { RARE_PARTS } from '../../shared/lootRoll.ts';
import { FINDS, RARE_FINDS, SCRAP_REWARD } from '../../shared/tables.ts';
import { feltTemp } from '../../shared/temperature.ts';
import { heatPerSecond, SIP_COOL } from '../../shared/water.ts';
import { LIVES } from '../../shared/world.ts';
import { COSTS, MIN_SCORE } from './costs.ts';
import { CORPSE_S, World, type Poi, type Source, type Thing } from './world.ts';

/** What the agent works towards, in order: each piece of gear repaired (or crafted), each boss beaten. */
const GOALS = [
  'canteen', 'backpack', 'laser_pistol', 'motorcycle', 'spyglass', 'shield', 'laser_rifle', 'storm_detector', 'jammer', 'wristpad',
  'grinder', 'receiver_colossus', 'boss:colossus', 'receiver_queen', 'boss:queen', 'receiver_carrier', 'boss:carrier', 'receiver_worm', 'boss:worm',
  'wrench', 'windmill', 'battery_station',
] as const;
/** Worn gear: its equipment slot. */
const WORN: Partial<Record<string, EquipSlot>> = { backpack: 'back', motorcycle: 'vehicle', shield: 'armor', storm_detector: 'belt', wristpad: 'wrist' };
/** Carried in the hotbar when there's one. */
const CARRIED = ['canteen', 'laser_rifle', 'laser_pistol', 'jammer', 'spyglass'];
/** Gear whose quality is a milestone of its own (q2: quality 2+, Quality-grade parts throughout). */
const QUALITY_MILESTONES = ['laser_rifle', 'motorcycle', 'backpack', 'canteen'];
/** Scrap-tier metal parts the workbench hammers out of scrap (shared/tables.ts RECIPE_TABLE). */
const SMITHED: Partial<Record<PartId, string>> = { gear: 'gear_scrap', bearing: 'bearing_scrap', valve: 'valve_scrap', heatsink: 'heatsink_scrap' };

// (This file also runs against older commits (cli.ts --base): what they may not have yet is looked up, not imported.)
/** The buildings put up with the wrench (shared/crafting.ts), none before there were. */
const BUILDS: Record<string, Recipe> = (crafting as { BUILDS?: Record<string, Recipe> }).BUILDS ?? {};
const WRENCH = 'wrench';
const WIRING = 'wiring';
/** The base materials (shared/items.ts): stacked in the chest, a need of their own. */
const MATERIALS = [SCRAP, CLOTH, WIRING];
/** What an item counts as for needs: its part, or its own kind (scrap, cloth, wiring, a relic, a piece of gear). */
const keyOf = (kind: string) => parsePart(kind) ? kind.slice(0, kind.lastIndexOf('_')) : kind;
const tierNum = (kind: string) => parsePart(kind)?.tier ?? -1;
const slotKey = (s: (typeof GEAR)[string]['slots'][number]) => ('part' in s ? s.part : s.scrap[0]);
/** The need key an ingredient is met by: a part (any tier) or a base material. */
const ingKey = (ing: Ingredient) => keyOf(PART_IDS.map((p) => partItem(p, 'scrap')).find((k) => ing.match(k)) ?? MATERIALS.find((k) => ing.match(k)) ?? CLOTH);
const lerp = (a: [number, number], u: number) => a[0] + (a[1] - a[0]) * u;

export type RunResult = {
  world: string;
  /** Game time (s) each milestone was first reached. */
  milestones: Record<string, number>;
  deaths: number;
  gameOverS: number | null;
  wonS: number | null;
  endS: number;
  /** Part items that came in, by part and source; by part and tier. */
  sources: Record<string, Record<string, number>>;
  tiers: Record<string, number[]>;
  /** Part items used up (fitted or crafted with). */
  used: Record<string, number>;
  /** Left in the chest at the end, by need key. */
  leftover: Record<string, number>;
  /** Time (s) the top goal waited on each missing thing. */
  wait: Record<string, number>;
  km: number;
  trips: number;
  /** Fights by enemy kind, and how many of them were won (it was killed). */
  fights: Record<string, number>;
  kills: Record<string, number>;
  bossTries: number;
};

/** A site's pack is back this long after you've left it (the longest `backS` of the site meets, shared/enemies.ts). */
const SITE_BACK_S = Math.max(0, ...Object.values(ENEMIES).flatMap((e) => e.meet.map((m) => (m.at === 'site' ? m.backS ?? 0 : 0))));

/** The enemies met on the move: each kind with its roaming meet (shared/enemies.ts). */
const ROAMING = (Object.keys(ENEMIES) as EnemyKind[]).flatMap((kind) =>
  ENEMIES[kind].meet.filter((m): m is Extract<Meet, { at: 'roam' }> => m.at === 'roam').map((m) => ({ kind, m })));

export class Sim {
  t = 0;
  x = BASE.x;
  z = BASE.z;
  heat = 0;
  sips = 0;
  lives = LIVES;
  beaten = new Set<BossKind>();
  private nextId = 1;
  private newId = () => this.nextId++;
  readonly bag: Slots = Array(BAG_SLOTS).fill(null);
  readonly equip: Slots = Array(EQUIP_SLOTS.length).fill(null);
  readonly cargo: Slots = Array(BIKE_COLS * BIKE_ROWS).fill(null);
  /** The base's chests: room enough for anything. */
  chest: Item[] = [];
  private world: World;
  private rand: Rand;
  /** Separate streams, so a change in one kind of roll doesn't reshuffle the others. */
  private fightRand: Rand;
  private machineRand: Rand;
  private todOffset: number;
  /** In a fight (nothing else comes at you meanwhile). */
  private fighting = false;
  /** What each enemy kind leaves, a sample of kills (rolled once, from a stream of their own), to value a fight by. */
  private spoilSamples = new Map<EnemyKind, Drop[][]>();
  private needCache: Map<string, number> | null = null;
  /** Item kind → value, while needCache holds; what's in hand by need key. */
  private valueCache = new Map<string, number>();
  private stock = new Map<string, number>();
  readonly out: RunResult;

  constructor(worldId: string, seed: number) {
    this.rand = seeded(seed * 7919 + 1);
    this.fightRand = seeded(seed * 7919 + 2);
    this.machineRand = seeded(seed * 7919 + 3);
    this.world = new World(seeded(seed * 7919 + 4));
    this.todOffset = 0.2 + this.rand() * 0.6;
    this.out = { world: worldId, milestones: {}, deaths: 0, gameOverS: null, wonS: null, endS: 0, sources: {}, tiers: {}, used: {}, leftover: {}, wait: {}, km: 0, trips: 0, fights: {}, kills: {}, bossTries: 0 };
    const sampleRand = seeded(seed * 7919 + 5);
    for (const kind of Object.keys(ENEMIES) as EnemyKind[]) {
      this.spoilSamples.set(kind, Array.from({ length: 40 }, () => ENEMIES[kind].drops(sampleRand, { jet: 'drone' })));
    }
    // The broken motorcycle in front of the door (shared/tables.ts HOME_BIKE): one each.
    this.chest.push({ id: this.newId(), kind: 'motorcycle', n: 1, parts: GEAR.motorcycle.slots.map((s) => ('part' in s && s.part === 'motor' ? 'motor_scrap' : null)) });
  }

  // ---- inventory --------------------------------------------------------------------------------------------------

  private all(): Item[] {
    return [...this.chest, ...this.bag, ...this.equip, ...this.cargo].filter((x): x is Item => !!x);
  }
  private gearOf(kind: string): Item[] {
    return this.all().filter((x) => x.kind === kind);
  }
  /** How `goal` is made: its workbench recipe, or, for a building not up yet, what it's built of (the wrench's). */
  private recipeOf(goal: string): Recipe | undefined {
    return RECIPES[goal] ?? (BUILDS[goal] && !this.gearOf(goal).length ? BUILDS[goal] : undefined);
  }
  private best(kind: string): Item | null {
    return this.gearOf(kind).filter(repaired).sort((a, b) => quality(b) - quality(a))[0] ?? null;
  }
  /** The best gun carried and its quality; the jammer's quality, null without one. */
  private weapon(): { w: Weapon; q: number; jam: number | null } {
    const jammer = this.carried('jammer');
    const jam = jammer ? quality(jammer) : null;
    for (const k of ['laser_rifle', 'laser_pistol'] as const) {
      const g = this.carried(k);
      if (g) return { w: k === 'laser_rifle' ? 'rifle' : 'pistol', q: quality(g), jam };
    }
    return { w: 'none', q: 0, jam };
  }
  private odds(kind: EnemyKind) {
    const { w, q, jam } = this.weapon();
    return fightOdds(kind, w, q, jam);
  }
  private carried(kind: string): Item | null {
    const slot = WORN[kind];
    const it = slot ? this.equip[EQUIP_SLOTS.indexOf(slot)] : this.bag.slice(0, HOTBAR).find((x) => x?.kind === kind);
    return it && repaired(it) ? it : null;
  }
  private get onBike() {
    return !!this.carried('motorcycle');
  }
  private speed() {
    const bike = this.carried('motorcycle');
    return bike ? bikeTopSpeed(quality(bike)) * COSTS.bikeShare : COSTS.footSpeed;
  }

  /** Put an item in the bag or the bike's cargo; false if there's no room. */
  private stow(kind: string, parts?: (string | null)[]): boolean {
    const boxes: [Slots, Shape][] = [[this.bag, bagShape(this.equip)]];
    if (this.onBike) boxes.push([this.cargo, gridShape(BIKE_COLS, BIKE_ROWS)]);
    for (const [slots, shape] of boxes) {
      let made = -1;
      if (addItem(slots, kind, 1, () => (made = this.newId()), shape)) {
        if (parts) {
          const it = slots.find((x) => x?.id === made);
          if (it) it.parts = [...parts];
        }
        return true;
      }
    }
    return false;
  }

  private toChest(kind: string, n = 1, parts?: (string | null)[]) {
    const stack = !parts && MATERIALS.includes(kind) ? this.chest.find((x) => x.kind === kind && !x.parts) : undefined;
    if (stack) stack.n += n;
    else this.chest.push({ id: this.newId(), kind, n, ...(parts ? { parts: [...parts] } : {}) });
    this.needCache = null;
  }

  /** Count a part coming in, by where it came from. */
  private got(kind: string, src: Source) {
    // (Wiring is a machine's coil: counted with the parts, as Scrap.)
    const p = parsePart(kind) ?? (kind === WIRING ? { tier: 0 } : null);
    if (!p) return;
    const part = keyOf(kind);
    (this.out.sources[part] ??= {})[src] = (this.out.sources[part]?.[src] ?? 0) + 1;
    (this.out.tiers[part] ??= [0, 0, 0, 0])[p.tier]++;
  }

  private chestCount(key: string) {
    return this.chest.reduce((n, it) => n + (keyOf(it.kind) === key && !it.parts ? it.n : 0), 0);
  }
  /** Take one item of `key` out of the chest: the best tier, or the worst (crafting). */
  private takeFromChest(key: string, best = true): string | null {
    const cands = this.chest.filter((it) => keyOf(it.kind) === key && !it.parts).sort((a, b) => (tierNum(b.kind) - tierNum(a.kind)) * (best ? 1 : -1));
    const it = cands[0];
    if (!it) return null;
    if (--it.n <= 0) this.chest.splice(this.chest.indexOf(it), 1);
    this.needCache = null;
    if (parsePart(it.kind) || it.kind === WIRING) this.out.used[key] = (this.out.used[key] ?? 0) + 1;
    return it.kind;
  }

  // ---- goals and what things are worth -----------------------------------------------------------------------------

  private done(goal: string): boolean {
    if (goal.startsWith('boss:')) return this.beaten.has(goal.slice(5) as BossKind);
    const boss = Object.entries(RECEIVERS).find(([, r]) => r === goal)?.[0] as BossKind | undefined;
    if (boss && this.beaten.has(boss)) return true;
    // (A tool crafted whole, like the grinder, isn't gear: having one is enough.)
    return GEAR[goal] ? this.gearOf(goal).some(repaired) : this.gearOf(goal).length > 0;
  }

  private open(): string[] {
    return GOALS.filter((g) => !this.done(g));
  }

  /** What's still wanted, by need key, with the weight of the most pressing goal that wants it (the first open goal
   *  weighs 1, the next 0.85, ...); the chest is counted off first, earlier goals first. */
  needs(): Map<string, number> {
    if (this.needCache) return this.needCache;
    this.valueCache.clear();
    this.stock.clear();
    for (const it of this.all()) if (!it.parts) this.stock.set(keyOf(it.kind), (this.stock.get(keyOf(it.kind)) ?? 0) + it.n);
    const stock = new Map(this.stock);
    const out = new Map<string, number>();
    const want = (key: string, n: number, w: number) => {
      const have = stock.get(key) ?? 0;
      const use = Math.min(have, n);
      stock.set(key, have - use);
      for (let i = use; i < n; i++) {
        out.set(key, Math.max(out.get(key) ?? 0, w));
        out.set(`${key}#${i}`, w); // (a count: the i-th one wanted)
      }
      // A plain metal part can be hammered out of scrap instead.
      const smith = SMITHED[key as PartId];
      if (smith && n > use) want(SCRAP, (n - use) * RECIPES[smith].needs[0].n, w * 0.6);
    };
    this.open().forEach((g, rank) => {
      const w = Math.pow(0.85, rank);
      if (g.startsWith('boss:')) return;
      const r = this.recipeOf(g);
      if (r) for (const ing of r.needs) want(ingKey(ing), ing.n, w);
      // A building isn't done when it stands: its slots are filled after (below). (No recipe and no gear: a goal this
      // commit doesn't have yet.)
      if (RECIPES[g] || !GEAR[g]) return;
      const it = this.gearOf(g).sort((a, b) => filled(b) - filled(a))[0];
      if (!it && !BUILDS[g]) want(g, 1, w);
      GEAR[g].slots.forEach((s, i) => {
        if (!it?.parts?.[i]) want(slotKey(s), 1, it ? w : w * 0.6);
      });
    });
    return (this.needCache = out);
  }

  /** What one more of this item is worth now: what a goal wants it for, or a little as an upgrade or spare. */
  value(kind: string, parts?: (string | null)[]): number {
    this.needs(); // (fresh needs, and the cache with them)
    let v = this.valueCache.get(kind) ?? -1;
    if (v < 0) this.valueCache.set(kind, (v = this.plainValue(kind)));
    if (parts) for (const p of parts) if (p) v += 0.5 * this.value(p);
    return v;
  }

  private plainValue(kind: string): number {
    const needs = this.needs();
    const key = keyOf(kind);
    let v = needs.get(key) ?? 0;
    if (!v) {
      const t = tierNum(kind);
      if (t > 0) {
        // An upgrade: a better part than one fitted in gear in use.
        for (const g of [...this.equip, ...this.bag.slice(0, HOTBAR)]) {
          if (!g?.parts) continue;
          g.parts.forEach((p, i) => {
            if (p && keyOf(p) === key && fitsSlot(GEAR[g.kind].slots[i], kind) && tierNum(p) < t) v = Math.max(v, 0.08 * (t - tierNum(p)));
          });
        }
      }
      // A spare: worth less the more of it there is.
      if (!v) v = (MATERIALS.includes(key) ? 0.02 : parsePart(kind) ? 0.01 : 0) * 10 / (10 + (this.stock.get(key) ?? 0));
    }
    return v;
  }

  /** What a machine is worth before it's opened: the mean of what its kind holds, and its scrap. */
  private machineValue(kind: JunkKind, level: LootLevel): number {
    const key = `@${kind}:${level}`;
    const had = this.valueCache.get(key);
    if (had !== undefined) return had;
    let v = 0;
    if (kind !== 'jet_engine' || this.gearOf('grinder').length) {
      for (const y of junkSpec(kind).yields) v += ((y.min + y.max) / 2) * this.value(partItem(y.part, level >= 2 ? 'quality' : 'basic'));
      v += this.value(SCRAP) * 10;
    }
    this.valueCache.set(key, v);
    return v;
  }

  /** The finds a crash site may hold that a goal wants, by the odds (FINDS: how many lie at sites of its level), the
   *  more the longer since it was looked at. */
  private findsValue(p: Poi): number {
    const level = p.site!.loot;
    const fresh = Math.min(1, (this.t - p.seenAt) / COSTS.findTurnoverS);
    let v = 0;
    for (const [kind, f] of Object.entries(FINDS)) {
      if (f.level !== level) continue;
      const w = this.needs().get(kind);
      if (w) v += (w * f.n) / this.world.sitesAt(level);
    }
    if (level === 2) v += (Math.max(...RARE_PARTS.map((q) => this.needs().get(q) ?? 0)) * RARE_FINDS.n) / this.world.sitesAt(2);
    return v * fresh;
  }

  // ---- time passing ------------------------------------------------------------------------------------------------

  private tod(t = this.t) {
    const u = t / DAY_SECONDS + this.todOffset;
    return u - Math.floor(u);
  }
  private night() {
    const d = this.tod();
    return d < 0.23 || d > 0.77;
  }

  /** Spend `s` seconds outdoors (walking, riding or working): heat builds by the time of day, the bottle is sipped,
   *  and the agent sits out the worst in the shade. */
  private outdoors(s: number) {
    const end = this.t + s, deaths = this.out.deaths;
    while (this.t < end && this.out.deaths === deaths) {
      const dt = Math.min(20, end - this.t);
      this.heat = Math.max(0, this.heat + heatPerSecond(feltTemp(this.tod(), COSTS.sunShare, false), false) * dt);
      this.t += dt;
      if (this.heat >= COSTS.sipAt && this.sips > 0) {
        this.sips--;
        this.heat = Math.max(0, this.heat - SIP_COOL);
      }
      if (this.heat >= COSTS.restAt) {
        // In the shade till it's down (it always cools there: shade is capped under COMFORT_TEMP, shared/temperature.ts).
        while (this.heat > COSTS.restTo) {
          this.heat = Math.max(0, this.heat + heatPerSecond(feltTemp(this.tod(), 0, false), false) * 10);
          this.t += 10;
        }
      }
      this.roam(dt / 60);
    }
  }

  /** Go to (x, z): the time, the heat, what's seen and met on the way. False: died on the way. */
  private go(x: number, z: number): boolean {
    const d = Math.hypot(x - this.x, z - this.z);
    if (d < 1) return true;
    const s = d / this.speed() + (this.onBike ? COSTS.bikeMountS : 0);
    const steps = Math.max(1, Math.ceil(d / 100));
    const x0 = this.x, z0 = this.z, deaths = this.out.deaths;
    for (let i = 1; i <= steps; i++) {
      this.outdoors(s / steps);
      this.x = x0 + ((x - x0) * i) / steps;
      this.z = z0 + ((z - z0) * i) / steps;
      this.out.km += d / steps / 1000;
      this.look();
      if (this.out.deaths !== deaths) return false;
    }
    return true;
  }

  /** Things noticed from here. */
  private look() {
    const glass = this.carried('spyglass');
    const small = COSTS.see.loot * (glass ? lerp(COSTS.spyglassSee, (spyglassZoom(quality(glass)) - spyglassZoom(0)) / (spyglassZoom(3) - spyglassZoom(0))) : 1);
    for (const p of this.world.pois) {
      if (p.known) continue;
      const r = p.type === 'pile' ? COSTS.see.pile : p.type === 'wreck' ? COSTS.see.wreck : p.type === 'shelter' ? COSTS.see.shelter : small;
      if ((p.x - this.x) ** 2 + (p.z - this.z) ** 2 < r * r) p.known = true;
    }
  }

  /** `min` minutes outdoors here: whatever roams this ground may come at you (shared/enemies.ts roaming meets). */
  private roam(min: number) {
    if (this.fighting || this.lives <= 0) return;
    const deaths = this.out.deaths;
    for (const { kind, m } of ROAMING) {
      if (!this.roamsHere(m.where) || this.fightRand() >= 1 - Math.exp(-m.perMin * min)) continue;
      this.fight(kind);
      if (this.out.deaths !== deaths) return;
    }
  }

  /** Is (x, z) (default: here) ground where `where` roams? */
  private roamsHere(where: Extract<Meet, { at: 'roam' }>['where'], x = this.x, z = this.z): boolean {
    const d = Math.hypot(x - BASE.x, z - BASE.z);
    if (where === 'overhead') return d > 30;
    if (where === 'open') return d > 250; // (server/guardians.ts ROAM_BASE_KEEP_OUT)
    if (where === 'guardianGround') return d >= 1650; // (shared/crashsites.ts LEVEL_R)
    return this.world.nearMud(x, z);
  }

  /** How often `kind` comes to you where it can be hunted (per minute). */
  private huntRate(kind: EnemyKind): number {
    return ROAMING.find((r) => r.kind === kind && r.m.hunt)?.m.perMin ?? 0.01;
  }

  /** At a hunting spot: wait (outdoors, so it can come) until `kind` has been met, or for three times the usual wait. */
  private hunt(kind: EnemyKind) {
    const met = this.out.fights[kind] ?? 0, deaths = this.out.deaths;
    const until = this.t + 3 * 60 / this.huntRate(kind);
    while ((this.out.fights[kind] ?? 0) === met && this.out.deaths === deaths && this.t < until) this.outdoors(20);
  }

  /** The fights waiting at `p` on arrival (shared/enemies.ts site meets), each with its odds: a site's crawlers (unless
   *  you were there lately), its drones by night, a guardian maybe. */
  private arrival(p: Poi): [EnemyKind, number][] {
    const s = p.site;
    if (!s) return [];
    const out: [EnemyKind, number][] = [];
    for (const kind of Object.keys(ENEMIES) as EnemyKind[]) for (const m of ENEMIES[kind].meet) {
      if (m.at !== 'site' || !m.levels.includes(s.loot) || (m.night && !this.night()) || (m.backS && p.packBackAt > this.t)) continue;
      out.push([kind, m.spread !== undefined ? Math.min(1, m.spread / this.world.sitesAt(s.loot)) : m.odds ?? 1]);
    }
    return out;
  }

  /** What a fight with `kind` is worth: what its kills leave (a sample of them, valued now) times the odds of winning. */
  private spoilsValue(kind: EnemyKind): number {
    const { win } = this.odds(kind);
    if (!win) return 0;
    const key = `!${kind}`;
    let v = this.valueCache.get(key);
    if (v === undefined) {
      const samples = this.spoilSamples.get(kind)!;
      v = samples.reduce((a, ds) => a + ds.reduce((b, d) => b + this.value(d.kind, d.parts), 0), 0) / samples.length;
      this.valueCache.set(key, v);
    }
    const n = ENEMIES[kind].n;
    return v * win * ((n[0] + n[1]) / 2);
  }

  /** A fight with `kind` (n of them, one after another): won, it's killed and leaves its loot; lost, it may kill you (the
   *  shield takes the blow if it can), else you get away. */
  private fight(kind: EnemyKind) {
    const e = ENEMIES[kind];
    const n = e.n[0] + Math.floor(this.fightRand() * (e.n[1] - e.n[0] + 1));
    this.fighting = true;
    try {
      for (let i = 0; i < n; i++) {
        const { win, death, seconds } = this.odds(kind);
        this.out.fights[kind] = (this.out.fights[kind] ?? 0) + 1;
        this.outdoors(seconds);
        if (this.fightRand() < win) {
          this.out.kills[kind] = (this.out.kills[kind] ?? 0) + 1;
          this.out.milestones[`kill:${kind}`] ??= this.t;
          this.killed(kind);
          continue;
        }
        if (this.fightRand() < death && !this.shieldSaves()) return this.die();
        return; // (got away)
      }
    } finally {
      this.fighting = false;
    }
  }

  /** What a killed `kind` leaves: at your feet (taken at once, as far as it's worth it), or where it came down. */
  private killed(kind: EnemyKind) {
    const e = ENEMIES[kind];
    const jammed = kind === 'jet' && this.weapon().jam !== null;
    let x = this.x, z = this.z, jet: 'wing' | 'drone' | undefined;
    if (e.falls) {
      const a = this.fightRand() * Math.PI * 2, d = lerp(e.falls, this.fightRand());
      x += Math.cos(a) * d;
      z += Math.sin(a) * d;
    }
    if (kind === 'jet') {
      const far = Math.hypot(x - BASE.x, z - BASE.z);
      jet = this.fightRand() < COSTS.wing.odds * Math.min(1, far / COSTS.wing.far) ? 'wing' : 'drone';
    }
    const things = e.drops(this.fightRand, { jet, soft: jammed }).map((d) => this.world.thing(d, kind));
    const p = this.world.drop(x, z, things, e.falls ? 'jet' : 'loot');
    // The flying wing's engines that tore off whole are machines to take apart (shared/jetcrash.ts).
    if (jet === 'wing') for (let i = 0; i < COSTS.wing.engines; i++) {
      if (this.fightRand() < COSTS.wing.tearOff * (1 - COSTS.wing.wrecked)) p.machines.push({ kind: 'jet_engine', seed: (this.fightRand() * 2 ** 32) >>> 0, level: 1, carry: false, backAt: 0, respawn: Infinity });
    }
    if (!e.falls) this.collect(p);
  }

  /** The shield plate takes a killing blow if it has one left (shared/gear.ts shieldSaves), and breaks on its last. */
  private shieldSaves(): boolean {
    const s = this.carried('shield');
    if (!s) return false;
    s.worn = (s.worn ?? 0) + 1;
    if (s.worn >= shieldSaves(tierOf(s))) {
      s.worn = 0;
      s.parts = s.parts!.map((p, i) => ([1, 2].includes(i) ? null : p)); // (SHIELD_BREAKS: the cell and the plate)
      this.needCache = null;
    }
    return true;
  }

  private die() {
    this.out.deaths++;
    this.out.milestones.first_death ??= this.t;
    this.lives--;
    // The bag past the hotbar stays where you fell, in a pack (shared/corpse.ts).
    const things: Thing[] = [];
    for (let i = HOTBAR; i < this.bag.length; i++) {
      const it = this.bag[i];
      if (it) for (let k = 0; k < it.n; k++) things.push(this.world.thing({ kind: it.kind, ...(it.parts ? { parts: it.parts } : {}) }, 'corpse'));
      this.bag[i] = null;
    }
    if (things.length) this.world.drop(this.x, this.z, things, 'corpse', this.t + CORPSE_S);
    this.t += COSTS.respawnS;
    this.x = BASE.x;
    this.z = BASE.z;
    this.heat = 0;
    this.needCache = null;
    if (this.lives <= 0) this.out.gameOverS = this.t;
  }

  // ---- out there ---------------------------------------------------------------------------------------------------

  /** The odds of dying going to `p`: the fights waiting there, what roams there (a few minutes of it), and at a
   *  hunting spot the fight it's for. */
  private risk(p: Poi): number {
    const lose = (kind: EnemyKind) => {
      const o = this.odds(kind);
      return (1 - o.win) * o.death;
    };
    let r = 0;
    for (const [kind, odds] of this.arrival(p)) r += odds * lose(kind);
    for (const { kind, m } of ROAMING) if (this.roamsHere(m.where, p.x, p.z)) r += (1 - Math.exp(-m.perMin * 4)) * lose(kind);
    if (p.hunt) r += lose(p.hunt);
    return r * (this.carried('shield') ? 0.5 : 1);
  }

  /** What going to `p` is worth now, and how long working there takes. */
  private worth(p: Poi, room = this.roomLeft()): { v: number; work: number } {
    let v = 0, work = 0;
    for (const [kind, odds] of this.arrival(p)) {
      v += odds * this.spoilsValue(kind);
      work += odds * this.odds(kind).seconds;
    }
    if (p.hunt) {
      // A hunting spot: the wait for one to come, and the fight.
      v += this.spoilsValue(p.hunt);
      work += 60 / this.huntRate(p.hunt) + this.odds(p.hunt).seconds;
    }
    if (p.seenAt === -Infinity && p.type === 'shelter') v += 0.1;
    for (const th of p.things) {
      if (p.type === 'shelter' && p.seenAt === -Infinity) break;
      const tv = this.value(th.kind, th.parts);
      if (tv > 0.009) {
        v += tv;
        work += COSTS.openS;
      }
    }
    let pieces = 0;
    for (const pc of p.pieces) if (pc.backAt <= this.t && pieces < room) {
      const pv = this.value(pc.item);
      if (pv > 0.009) {
        v += pv;
        pieces++;
      }
    }
    work += pieces * (COSTS.pickS + COSTS.pileWalkS);
    for (const m of p.machines) {
      if (m.backAt > this.t) continue;
      const mv = this.machineValue(m.kind, m.carry ? 1 : m.level);
      if (mv < 0.05) continue;
      if (m.carry && !room) continue;
      v += mv;
      work += m.carry ? COSTS.pickS : this.teardownS(m.kind, m.seed, m.level);
    }
    // A crash site not looked at (lately) may hold finds.
    if (p.site) v += this.findsValue(p);
    return { v, work };
  }

  /** Free bag and cargo cells, roughly. */
  private roomLeft(): number {
    const shape = bagShape(this.equip);
    const cells = shape.free + shape.cols * shape.rows + (this.onBike ? BIKE_COLS * BIKE_ROWS : 0);
    let used = 0;
    for (const s of [this.bag, this.onBike ? this.cargo : []]) for (const it of s) if (it) used += 1;
    return Math.max(0, cells - used - CARRIED.filter((k) => this.carried(k)).length);
  }

  private teardownS(kind: JunkKind, seed: number, level: number): number {
    const steps = stepList(kind, seed, level);
    return COSTS.stepS * (steps ? steps.list.length : COSTS.codeSteps.base + COSTS.codeSteps.perPart * machineParts(kind, seed, level).length);
  }
  private teardownScrap(kind: JunkKind, seed: number, level: number): number {
    const steps = stepList(kind, seed, level);
    if (steps) return steps.list.length * SCRAP_REWARD.step + frameScrap(kind, seed, level, 0);
    const parts = machineParts(kind, seed, level).length;
    const modules = Math.ceil(parts / 2);
    return Math.round((COSTS.codeSteps.base + COSTS.codeSteps.perPart * parts) * SCRAP_REWARD.step + modules * (SCRAP_REWARD.module + SCRAP_REWARD.perModule) + SCRAP_REWARD.machine);
  }

  /** Pick the best place to go next: value for the time it takes, given the risk. Null: nothing worth it. */
  private choose(): Poi | null {
    let best: Poi | null = null, bestScore = MIN_SCORE;
    const spd = this.speed();
    const top = this.needs().size ? Math.max(...this.needs().values()) : 0;
    const room = this.roomLeft();
    for (const p of this.world.pois) {
      if (!p.known) continue;
      const { v, work } = this.worth(p, room);
      if (v <= 0) continue;
      const risk = this.risk(p);
      if (risk > COSTS.maxRisk * (v >= top && top > 0 ? 2 : 1)) continue;
      const out = Math.hypot(p.x - this.x, p.z - this.z) / spd;
      const back = Math.max(0, Math.hypot(p.x - BASE.x, p.z - BASE.z) - Math.hypot(this.x - BASE.x, this.z - BASE.z)) / spd;
      const score = (v * (1 - risk) - risk * 2) / (out + work + 0.5 * back + 1);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  /** Go to `p` and take what's worth taking. */
  private visit(p: Poi) {
    const deaths = this.out.deaths;
    if (!this.go(p.x, p.z)) return;
    for (const [f, odds] of this.arrival(p)) {
      if (this.fightRand() >= odds) continue;
      this.fight(f);
      if (this.out.deaths !== deaths) return;
    }
    if (p.hunt) {
      this.hunt(p.hunt);
      if (this.out.deaths !== deaths) return;
    }
    p.packBackAt = this.t + SITE_BACK_S;
    if (p.site) {
      // Walking round a site, the finds among its debris are seen.
      for (const q of this.world.pois) if (!q.known && q.type === 'loot' && Math.hypot(q.x - p.x, q.z - p.z) < p.site.radius + 40) q.known = true;
    }
    p.seenAt = this.t;
    this.collect(p);
  }

  /** Take what's worth taking at `p`, as far as there's room. */
  private collect(p: Poi) {
    for (const th of [...p.things].sort((a, b) => this.value(b.kind, b.parts) - this.value(a.kind, a.parts))) {
      if (this.value(th.kind, th.parts) <= 0.009) break;
      this.outdoors(COSTS.openS);
      if (!this.stow(th.kind, th.parts)) continue;
      this.world.taken(p, th, this.t);
      this.got(th.kind, th.src);
      this.needCache = null;
    }
    for (const pc of p.pieces) {
      if (pc.backAt > this.t || this.value(pc.item) <= 0.009) continue;
      if (!this.stow(pc.item)) break;
      this.outdoors(COSTS.pickS + COSTS.pileWalkS);
      pc.backAt = this.t + pc.respawn;
      this.needCache = null;
    }
    for (const m of p.machines) {
      if (m.backAt > this.t || this.machineValue(m.kind, m.carry ? 1 : m.level) < 0.05) continue;
      if (m.carry) {
        if (!this.stow(m.kind)) continue;
        this.outdoors(COSTS.pickS);
        m.backAt = this.t + m.respawn;
      } else {
        // Taken apart where it lies; what doesn't fit is left on the sand by it.
        this.outdoors(this.teardownS(m.kind, m.seed, m.level));
        m.backAt = Infinity;
        const left: Thing[] = [];
        for (const pt of machineParts(m.kind, m.seed, m.level)) {
          const kind = partItem(pt.part, pt.tier);
          if (this.stow(kind)) this.got(kind, m.kind);
          else left.push(this.world.thing({ kind }, m.kind));
        }
        for (let i = this.teardownScrap(m.kind, m.seed, m.level); i > 0; i--) if (!this.stow(SCRAP)) break;
        p.things.push(...left);
      }
      this.needCache = null;
    }
  }

  /** Whether to head home rather than go on to `next`. */
  private homeward(next: Poi | null): boolean {
    if (!next) return true;
    if (this.roomLeft() <= 0) return true;
    // Everything a goal waits on is in hand: go and fix it.
    const fixable = this.open().some((g) => !g.startsWith('boss:') && this.couldFinish(g));
    return fixable;
  }

  /** Could `goal` be done at the base with what's in the chest and the bag? */
  private couldFinish(goal: string): boolean {
    const stock = new Map<string, number>();
    for (const it of this.all()) if (!it.parts) stock.set(keyOf(it.kind), (stock.get(keyOf(it.kind)) ?? 0) + it.n);
    const take = (k: string, n: number) => {
      const have = stock.get(k) ?? 0;
      stock.set(k, have - n);
      return have >= n;
    };
    const r = this.recipeOf(goal);
    if (r) return r.needs.every((ing) => [...stock.keys()].some((k) => (ing.match(k) || ing.match(`${k}_scrap`)) && take(k, ing.n)));
    const it = this.gearOf(goal).sort((a, b) => filled(b) - filled(a))[0];
    if (!it) return false;
    if (repaired(it)) return false;
    // Only worth a trip home if something for it is in the bag (else it was fixable last time home).
    const inBag = [...this.bag, ...this.cargo].some((b) => b && (b.kind === goal || GEAR[goal].slots.some((s) => fitsSlot(s, b.kind))));
    return inBag && GEAR[goal].slots.every((s, i) => it.parts?.[i] || take(slotKey(s), 1) || (SMITHED[slotKey(s) as PartId] && take(SCRAP, 4)));
  }

  // ---- at the base -------------------------------------------------------------------------------------------------

  private home() {
    this.go(BASE.x, BASE.z);
    if (this.lives <= 0) return;
    this.t += COSTS.baseS;
    this.heat = 0;
    // Unload all but the carried tools.
    for (const slots of [this.bag, this.cargo]) for (let i = 0; i < slots.length; i++) {
      const it = slots[i];
      if (!it || (slots === this.bag && i < HOTBAR && CARRIED.includes(it.kind) && repaired(it))) continue;
      this.toChest(it.kind, it.n, it.parts ?? undefined);
      slots[i] = null;
    }
    // The disassembly table: carried machines, each rolled afresh at level 1 (server/crash.ts crashUse).
    for (const it of [...this.chest]) {
      if (it.parts || !isMachine(it.kind)) continue;
      for (let k = 0; k < it.n; k++) {
        const seed = (this.machineRand() * 2 ** 32) >>> 0;
        this.t += this.teardownS(it.kind as JunkKind, seed, 1);
        for (const pt of machineParts(it.kind as JunkKind, seed, 1)) {
          this.toChest(partItem(pt.part, pt.tier));
          this.got(partItem(pt.part, pt.tier), it.kind);
        }
        this.toChest(SCRAP, this.teardownScrap(it.kind as JunkKind, seed, 1));
      }
      this.chest.splice(this.chest.indexOf(it), 1);
    }
    this.bench();
    this.kit();
    this.milestones();
    this.bosses();
    const bottle = this.carried('canteen');
    this.sips = bottle ? canteenSips(quality(bottle)) : 0;
  }

  /** Repairs, crafting and upgrades, goal by goal, until nothing more can be done. */
  private bench() {
    for (let changed = true; changed;) {
      changed = false;
      for (const g of this.open()) {
        if (g.startsWith('boss:')) continue;
        if (this.recipeOf(g)) {
          if (this.craft(g, this.reserved(g))) changed = true;
          if (RECIPES[g]) continue;
        }
        const it = this.gearOf(g).sort((a, b) => filled(b) - filled(a))[0];
        if (!it) continue;
        const parts = [...(it.parts ?? GEAR[g].slots.map(() => null))];
        // A building (put up empty) leaves what earlier goals still want, as crafting does.
        const keep = GEAR[g].built ? this.reserved(g) : null;
        GEAR[g].slots.forEach((s, i) => {
          if (parts[i]) return;
          const key = slotKey(s);
          if (keep && this.chestCount(key) <= (keep.get(key) ?? 0) && !SMITHED[key as PartId]) return;
          let got = this.takeFromChest(key, !keep);
          if (!got && SMITHED[key as PartId] && this.craft(SMITHED[key as PartId]!)) got = this.takeFromChest(key);
          if (got) {
            parts[i] = got;
            this.t += COSTS.benchS;
            changed = true;
          }
        });
        it.parts = parts;
      }
      // Spare broken gear: strip it for parts.
      for (const it of [...this.chest]) {
        if (!it.parts || repaired(it) || !this.done(it.kind)) continue;
        for (const p of it.parts) if (p) this.toChest(p);
        this.chest.splice(this.chest.indexOf(it), 1);
        changed = true;
      }
    }
    this.upgrade();
    this.needCache = null;
  }

  /** Craft recipe `id` from the chest (worst tiers first, shared/crafting.ts); gear crafted comes with its parts fitted. */
  /** What the open goals before `goal` still want from the chest, by need key: a slot of gear not found yet counts too. */
  private reserved(goal: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const g of this.open()) {
      if (g === goal) break;
      if (g.startsWith('boss:') || !GEAR[g]) continue;
      const it = this.gearOf(g).sort((a, b) => filled(b) - filled(a))[0];
      GEAR[g].slots.forEach((s, i) => {
        if (!it?.parts?.[i]) out.set(slotKey(s), (out.get(slotKey(s)) ?? 0) + 1);
      });
    }
    return out;
  }

  /** Craft recipe `id` from the chest, leaving what's `reserved` (by need key) for earlier goals. */
  private craft(id: string, reserved = new Map<string, number>()): boolean {
    const r = RECIPES[id] ?? BUILDS[id];
    // A building goes up with the wrench (src/placing.ts).
    if (BUILDS[id] && !this.gearOf(WRENCH).length) return false;
    const take: string[] = [];
    const counts = new Map<string, number>();
    for (const it of this.chest) if (!it.parts) counts.set(it.kind, (counts.get(it.kind) ?? 0) + it.n);
    for (const ing of r.needs) {
      const key = keyOf([...counts.keys()].find((k) => ing.match(k)) ?? '');
      if (ing.n > this.chestCount(key) - (reserved.get(key) ?? 0)) return false;
    }
    for (const ing of r.needs) {
      let n = ing.n;
      for (const [k, c] of [...counts].sort((a, b) => tierNum(a[0]) - tierNum(b[0]))) {
        if (!ing.match(k)) continue;
        const use = Math.min(c, n);
        counts.set(k, c - use);
        n -= use;
        for (let i = 0; i < use; i++) take.push(k);
        if (!n) break;
      }
      if (n) return false;
    }
    const used = take.map((k) => this.takeFromChest(keyOf(k), false)!);
    this.t += COSTS.benchS;
    const gear = GEAR[r.makes];
    if (gear) this.toChest(r.makes, 1, gear.slots.map((s) => { const j = used.findIndex((k) => fitsSlot(s, k)); return j < 0 ? null : used.splice(j, 1)[0]; }));
    else this.toChest(r.makes);
    return true;
  }

  /** Better parts into the gear in use, when nothing still open needs them. */
  private upgrade() {
    const needs = this.needs();
    for (const it of this.all()) {
      if (!it.parts || !repaired(it) || !GEAR[it.kind] || GEAR[it.kind].built) continue;
      GEAR[it.kind].slots.forEach((s, i) => {
        const cur = it.parts![i]!;
        const key = slotKey(s);
        if (needs.has(key) || !parsePart(cur)) return;
        const better = this.chest.filter((c) => !c.parts && keyOf(c.kind) === key && tierNum(c.kind) > tierNum(cur)).sort((a, b) => tierNum(b.kind) - tierNum(a.kind))[0];
        if (!better) return;
        const got = this.takeFromChest(key);
        if (!got) return;
        this.toChest(cur);
        it.parts![i] = got;
        this.t += COSTS.benchS;
      });
    }
  }

  /** Wear and carry the best of each. */
  private kit() {
    for (const [kind, slot] of Object.entries(WORN) as [string, EquipSlot][]) {
      const b = this.best(kind);
      const i = EQUIP_SLOTS.indexOf(slot);
      if (!b || this.equip[i] === b) continue;
      if (this.equip[i]) this.chest.push(this.equip[i]!);
      this.chest.splice(this.chest.indexOf(b), 1);
      this.equip[i] = b;
    }
    let h = 0;
    for (let i = 0; i < HOTBAR; i++) if (this.bag[i]) this.chest.push(this.bag[i]!), (this.bag[i] = null);
    for (const kind of CARRIED) {
      if (h >= HOTBAR) break;
      if (kind === 'laser_pistol' && this.best('laser_rifle')) continue;
      const b = this.best(kind);
      if (!b) continue;
      this.chest.splice(this.chest.indexOf(b), 1);
      this.bag[h++] = b;
    }
    this.needCache = null;
  }

  private milestones() {
    const m = this.out.milestones;
    for (const kind of Object.keys(GEAR)) {
      const b = this.best(kind);
      if (!b) continue;
      m[`gear:${kind}`] ??= this.t;
      if (QUALITY_MILESTONES.includes(kind) && quality(b) >= 2) m[`q2:${kind}`] ??= this.t;
    }
    if (bagShape(this.equip).rows >= backpackRows(3)) m.full_backpack ??= this.t;
  }

  /** Call every boss whose receiver works, if there's a rifle to fight it with. */
  private bosses() {
    for (const kind of BOSS_KINDS) {
      if (this.beaten.has(kind) || this.lives <= 0) continue;
      const r = this.best(RECEIVERS[kind]);
      // Called only with a fair chance of winning (shared/enemies.ts: in practice, the rifle).
      const { win, death, seconds } = this.odds(kind);
      if (!r || win < 0.5) continue;
      this.out.bossTries++;
      this.out.fights[kind] = (this.out.fights[kind] ?? 0) + 1;
      this.t += seconds;
      r.parts![0] = null; // the uranium cell is spent on the call
      if (this.fightRand() < win) {
        this.beaten.add(kind);
        this.lives += BOSS_LIVES;
        this.out.kills[kind] = (this.out.kills[kind] ?? 0) + 1;
        this.out.milestones[`boss:${kind}`] ??= this.t;
        for (const d of ENEMIES[kind].drops(this.fightRand)) {
          this.toChest(d.kind, 1, d.parts);
          this.got(d.kind, kind);
        }
        this.t += 60;
      } else if (this.fightRand() < death && !this.shieldSaves()) this.die();
      this.needCache = null;
    }
    if (this.beaten.size === BOSS_KINDS.length) this.out.wonS ??= this.t;
  }

  // ---- the run -----------------------------------------------------------------------------------------------------

  run(): RunResult {
    this.home();
    while (this.t < COSTS.capS && this.lives > 0 && this.out.wonS === null) {
      const start = this.t;
      const top = this.open()[0];
      const waiting = [...this.needs().entries()].filter(([k, w]) => !k.includes('#') && w === 1).map(([k]) => k);
      this.trip();
      this.home();
      this.world.tick(this.t);
      this.out.trips++;
      if (top) for (const k of waiting) this.out.wait[k] = (this.out.wait[k] ?? 0) + (this.t - start) / waiting.length;
    }
    this.out.endS = this.t;
    for (const it of this.chest) if (!it.parts) this.out.leftover[keyOf(it.kind)] = (this.out.leftover[keyOf(it.kind)] ?? 0) + it.n;
    return this.out;
  }

  /** Out and back: from place to place while it's worth it and there's room. */
  private trip() {
    const start = this.t;
    const deaths = this.out.deaths;
    for (let stops = 0; stops < 40 && this.out.deaths === deaths; stops++) {
      const next = this.choose();
      if (stops > 0 && this.homeward(next)) return;
      if (!next) {
        // Nothing known worth going to: look around further out.
        this.explore();
        if (this.t - start > 1200) return;
        continue;
      }
      this.visit(next);
      this.world.tick(this.t);
    }
  }

  /** Head out somewhere not looked at yet, as far as is safe. */
  private explore() {
    const unseen = this.world.pois.filter((p) => p.type === 'site' && p.seenAt === -Infinity && this.risk(p) <= COSTS.maxRisk);
    const p = unseen.sort((a, b) => Math.hypot(a.x - this.x, a.z - this.z) - Math.hypot(b.x - this.x, b.z - this.z))[0];
    if (p) return this.visit(p);
    const a = this.rand() * Math.PI * 2, d = 200 + this.rand() * 700;
    this.go(BASE.x + Math.cos(a) * d, BASE.z + Math.sin(a) * d);
  }
}

const filled = (it: Item) => it.parts?.filter(Boolean).length ?? 0;
const isMachine = (kind: string) => kind in COMPONENTS || kind in SALVAGE;
