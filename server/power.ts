// Server side of the base's electricity (shared/power.ts): every tick each grid's windmills (what is wired together:
// shared/wires.ts grids) charge that grid's battery stations, each battery's charge is kept (live here, saved in the
// battery itself: its ItemData `charge`, fitted in the station's item, so it keeps it when it comes out), and
// the state goes out to everyone. A windmill on a grid with no station (or only full ones) delivers nothing. While the world
// sleeps (nobody in it, the process gone) the wind still blows: on start the time since the last save is caught up in
// steps of the same wind, storms left out. A beacon (shared/power.ts BEACON_W) is a store too, of its one battery: on a grid
// it takes its power first, from the wind and then from every battery on it; on its own it runs its battery flat. An electric
// well (shared/wells.ts) with every part in takes its control box's little power the same way, and runs while its grid
// could give its pump what it wants right now (the wind left over, or the batteries holding a bottle's worth); each
// bottle filled at it takes that out of the batteries (pump).
import { buildingBox, buildingId } from '../shared/boxes.ts';
import { ORIGIN } from '../shared/origin.ts';
import { BEACON, placed } from '../shared/placed.ts';
import { grids } from '../shared/wires.ts';
import { BEACON_W, cells, charge, draw, GAME_SPEED, windmillWatts, windSpeed, type PowerState, type Store } from '../shared/power.ts';
import { setWellsOn, WELL, WELL_IDLE_W, wellSpec } from '../shared/wells.ts';
import { partsOf } from '../shared/gear.ts';
import { chargeOf, partAt, setFitted, type Item } from '../shared/items.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import type { openDb } from './db.ts';
import type { ItemServer } from './items.ts';

type Db = ReturnType<typeof openDb>;

/** A live tick longer than this (s, real) is a clock jump (the debug menu moved the day): not counted. */
const MAX_TICK_S = 10;
/** Catching up: steps of this (s, real), at most this long ago (a week). */
const CATCH_UP_STEP_S = 60;
const CATCH_UP_MAX_S = 7 * 24 * 3600;
/** The shared clock of the last tick (setting). */
const POWER_AT = 'powerAt';
/** What keeps its batteries' charge here: the battery stations and the beacons. */
const isStore = (kind: string) => kind === 'battery_station' || kind === BEACON;

export class PowerServer {
  private db: Db;
  private items: ItemServer;
  /** Battery station or beacon id → its parts as last seen and each slot's charge (kWh). */
  private stores = new Map<number, { parts: (string | null)[]; charge: number[] }>();
  private gen: Record<number, number> = {};
  private intake: Record<number, number> = {};
  /** The beacons lit in the last step. */
  private lit: number[] = [];
  /** The wells running in the last step, and what the wind had left over on each one's grid then (W). */
  private wells: number[] = [];
  private spare = new Map<number, number>();
  private at: number;

  /** Call after the placed list is loaded (server/placed.ts). `worldMs`: the shared clock now. */
  constructor(db: Db, worldMs: number, items: ItemServer) {
    this.db = db;
    this.items = items;
    // Before the charge was the batteries' own it was kept per station slot in the `power` table: into the batteries.
    const old = db.loadPower();
    for (const p of placed) {
      if (!isStore(p.kind)) continue;
      this.load(p.id);
      const was = old.get(p.id);
      const s = this.stores.get(p.id)!;
      if (was) s.charge = s.charge.map((c, i) => (cells(s.parts)[i] ? Math.min(was[i] ?? 0, cells(s.parts)[i]!.kwh) : c));
    }
    if (old.size) {
      this.flush();
      db.savePower(new Map());
    }
    const last = db.getSetting(POWER_AT);
    this.at = worldMs;
    if (last !== undefined && worldMs > last) {
      const from = Math.max(last, worldMs - CATCH_UP_MAX_S * 1000);
      for (let t = from; t < worldMs; t += CATCH_UP_STEP_S * 1000) this.step(t, Math.min(CATCH_UP_STEP_S, (worldMs - t) / 1000), 0);
    }
  }

  /** A station's item (in its box, shared/gear.ts buildingBox), or null. */
  private station(id: number): Item | null {
    return this.items.slots('', buildingBox(id))[0] ?? null;
  }

  /** A station's batteries' charge, from the batteries themselves (their ItemData). */
  private load(id: number) {
    const it = this.station(id);
    const parts = it ? partsOf(it) : [];
    const cs = cells(parts);
    this.stores.set(id, { parts, charge: parts.map((_, i) => (it && cs[i] ? (chargeOf(partAt(it, i)!) ?? 0) * cs[i]!.kwh : 0)) });
  }

  /** Write the live charge into the batteries (every station's, or the one whose box is `box`), so they have it when
   *  they come out or the station comes down, and saved. */
  flush(box?: string) {
    for (const [id, s] of this.stores) {
      if (box !== undefined && buildingBox(id) !== box) continue;
      const cs = cells(s.parts);
      this.items.edit('', buildingBox(id), 0, (it) => {
        if (partsOf(it).join() !== s.parts.join()) return false;
        const fitted = partsOf(it).map((_, i) => {
          const data = { ...partAt(it, i)?.data };
          const q = cs[i] ? s.charge[i] / cs[i]!.kwh : 1;
          if (q < 1) data.charge = q;
          else delete data.charge;
          return data;
        });
        setFitted(it, fitted);
        return true;
      });
    }
  }

  /** A station's parts were fitted or taken out (`box`, its building box): its charge is its batteries' now. Call
   *  flush(box) before the change, so the batteries had the live charge. */
  refit(box: string) {
    const id = buildingId(box);
    if (this.stores.has(id)) this.load(id);
  }

  /** The stations and windmills as they stand now: new ones in, gone ones out (each battery brings its own charge). */
  private sync() {
    const ids = new Set<number>();
    for (const p of placed) {
      if (!isStore(p.kind)) continue;
      ids.add(p.id);
      const s = this.stores.get(p.id);
      if (!s || s.parts.join() !== (p.parts ?? []).join()) this.load(p.id);
    }
    for (const id of this.stores.keys()) if (!ids.has(id)) this.stores.delete(id);
  }

  /** `realS` seconds of the grid at shared clock `worldMs`, in a sandstorm of strength `storm` at the base. */
  private step(worldMs: number, realS: number, storm: number) {
    this.sync();
    const v = windSpeed(worldMs, storm);
    this.gen = {};
    this.intake = {};
    this.lit = [];
    this.wells = [];
    this.spare.clear();
    const kinds = new Map(placed.map((p) => [p.id, p]));
    const gameS = realS * GAME_SPEED;
    for (const grid of grids(placed)) {
      const mills = grid.filter((id) => kinds.get(id)?.kind === 'windmill');
      const ids = grid.filter((id) => this.stores.has(id));
      const stores = ids.map((id) => this.stores.get(id) as Store);
      const made = mills.map((id) => windmillWatts(kinds.get(id)!.parts, v));
      const watts = made.reduce((a, b) => a + b, 0);
      // The beacons and the wells' control boxes first: on the wind, what it can't give out of the batteries; all on,
      // or (too little) all dark.
      const beacons = grid.filter((id) => kinds.get(id)?.kind === BEACON);
      const wells = grid.filter((id) => kinds.get(id)?.kind === WELL && wellSpec(kinds.get(id)!.parts));
      const need = beacons.length * BEACON_W + wells.length * WELL_IDLE_W;
      const lit = need > 0 && (watts >= need || draw(stores, need - watts, gameS));
      if (lit) this.lit.push(...beacons);
      const lamps = lit ? Math.min(watts, need) : 0;
      // A well runs while its pump could have its power now: from the wind left over, or a bottle's worth from the
      // batteries.
      const spare = watts - lamps;
      const held = stores.reduce((a, s) => a + s.charge.reduce((x, y) => x + y, 0), 0);
      for (const id of lit ? wells : []) {
        const w = wellSpec(kinds.get(id)!.parts)!;
        if (spare < w.watts && held < (w.watts * w.fillMs * GAME_SPEED) / 1000 / 3600 / 1000) continue;
        this.wells.push(id);
        this.spare.set(id, spare);
      }
      const took = charge(stores, watts - lamps, gameS);
      ids.forEach((id, i) => (this.intake[id] = took[i]));
      // What each windmill gives the grid: its share of what was taken.
      const used = watts > 0 ? (took.reduce((a, b) => a + b, 0) + lamps) / watts : 0;
      mills.forEach((id, i) => (this.gen[id] = made[i] * used));
    }
    setWellsOn(this.wells);
  }

  /** A bottle was filled at well `id`: its pump ran for the fill, on what the wind had left over and the rest out of
   *  its grid's batteries. */
  pump(id: number) {
    const p = placed.find((q) => q.id === id);
    const w = p && wellSpec(p.parts);
    if (!w) return;
    const need = w.watts - (this.spare.get(id) ?? 0);
    const grid = grids(placed).find((g) => g.includes(id)) ?? [];
    const stores = grid.filter((g) => this.stores.has(g)).map((g) => this.stores.get(g) as Store);
    if (need > 0) draw(stores, need, (w.fillMs / 1000) * GAME_SPEED);
  }

  /** Every tick: the time since the last one. `stormAt`: a sandstorm's strength at a point (shared/storm.ts stormAt). */
  tick(worldMs: number, stormAt: (x: number, z: number) => number) {
    const s = (worldMs - this.at) / 1000;
    this.at = worldMs;
    if (s > 0 && s <= MAX_TICK_S) this.step(worldMs, s, stormAt(ORIGIN.x, ORIGIN.z));
  }

  save() {
    this.flush();
    this.db.setSetting(POWER_AT, this.at);
  }

  msg(): ServerMsg {
    const round = (x: number) => Math.round(x * 1000) / 1000;
    const state: PowerState = {
      gen: Object.fromEntries(Object.entries(this.gen).map(([id, w]) => [id, Math.round(w)])),
      store: Object.fromEntries([...this.stores].map(([id, s]) => [id, { charge: s.charge.map(round), w: Math.round(this.intake[id] ?? 0) }])),
      lit: this.lit,
      wells: this.wells,
    };
    return { t: 'power', ...state };
  }
}
