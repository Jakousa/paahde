// Server side of the base's electricity (shared/power.ts): every tick the windmills' output goes into the battery
// stations, each battery's charge is kept (and saved in `power`), and the state goes out to everyone. While the world
// sleeps (nobody in it, the process gone) the wind still blows: on start the time since the last save is caught up in
// steps of the same wind, storms left out.
import { BASE } from '../shared/base.ts';
import { placed } from '../shared/placed.ts';
import { charge, GAME_SPEED, recharge, windmillWatts, windSpeed, type PowerState, type Store } from '../shared/power.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import type { openDb } from './db.ts';

type Db = ReturnType<typeof openDb>;

/** A live tick longer than this (s, real) is a clock jump (the debug menu moved the day): not counted. */
const MAX_TICK_S = 10;
/** Catching up: steps of this (s, real), at most this long ago (a week). */
const CATCH_UP_STEP_S = 60;
const CATCH_UP_MAX_S = 7 * 24 * 3600;
/** The shared clock of the last tick (setting). */
const POWER_AT = 'powerAt';

export class PowerServer {
  private db: Db;
  /** Battery station id → its parts as last seen and each slot's charge (kWh). */
  private stores = new Map<number, { parts: (string | null)[]; charge: number[] }>();
  private gen: Record<number, number> = {};
  private intake: Record<number, number> = {};
  private at: number;

  /** Call after the placed list is loaded (server/placed.ts). `worldMs`: the shared clock now. */
  constructor(db: Db, worldMs: number) {
    this.db = db;
    const saved = db.loadPower();
    for (const p of placed) {
      if (p.kind !== 'battery_station') continue;
      const parts = p.parts ?? [];
      this.stores.set(p.id, { parts, charge: parts.map((_, i) => saved.get(p.id)?.[i] ?? 0) });
    }
    const last = db.getSetting(POWER_AT);
    this.at = worldMs;
    if (last !== undefined && worldMs > last) {
      const from = Math.max(last, worldMs - CATCH_UP_MAX_S * 1000);
      for (let t = from; t < worldMs; t += CATCH_UP_STEP_S * 1000) this.step(t, Math.min(CATCH_UP_STEP_S, (worldMs - t) / 1000), 0);
    }
  }

  /** The stations and windmills as they stand now: new ones in, gone ones out, swapped parts (shared/power.ts recharge). */
  private sync() {
    const ids = new Set<number>();
    for (const p of placed) {
      if (p.kind !== 'battery_station') continue;
      ids.add(p.id);
      const parts = p.parts ?? [];
      const s = this.stores.get(p.id);
      if (!s) this.stores.set(p.id, { parts, charge: parts.map(() => 0) });
      else if (s.parts.join() !== parts.join()) this.stores.set(p.id, { parts, charge: recharge(s.parts, s.charge, parts) });
    }
    for (const id of this.stores.keys()) if (!ids.has(id)) this.stores.delete(id);
  }

  /** `realS` seconds of the grid at shared clock `worldMs`, in a sandstorm of strength `storm` at the base. */
  private step(worldMs: number, realS: number, storm: number) {
    this.sync();
    const v = windSpeed(worldMs, storm);
    let watts = 0;
    this.gen = {};
    for (const p of placed) {
      if (p.kind !== 'windmill') continue;
      this.gen[p.id] = windmillWatts(p.parts, v);
      watts += this.gen[p.id];
    }
    const ids = [...this.stores.keys()];
    const took = charge(ids.map((id) => this.stores.get(id) as Store), watts, realS * GAME_SPEED);
    this.intake = Object.fromEntries(ids.map((id, i) => [id, took[i]]));
  }

  /** Every tick: the time since the last one. `stormAt`: a sandstorm's strength at a point (shared/storm.ts stormAt). */
  tick(worldMs: number, stormAt: (x: number, z: number) => number) {
    const s = (worldMs - this.at) / 1000;
    this.at = worldMs;
    if (s > 0 && s <= MAX_TICK_S) this.step(worldMs, s, stormAt(BASE.x, BASE.z));
  }

  save() {
    this.db.savePower(new Map([...this.stores].map(([id, s]) => [id, s.charge])));
    this.db.setSetting(POWER_AT, this.at);
  }

  msg(): ServerMsg {
    const round = (x: number) => Math.round(x * 1000) / 1000;
    const state: PowerState = {
      gen: Object.fromEntries(Object.entries(this.gen).map(([id, w]) => [id, Math.round(w)])),
      store: Object.fromEntries([...this.stores].map(([id, s]) => [id, { charge: s.charge.map(round), w: Math.round(this.intake[id] ?? 0) }])),
    };
    return { t: 'power', ...state };
  }
}
