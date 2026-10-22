// Server side of vehicles (shared/vehicles.ts): the `vehicles` table, the broken motorcycles lying in the world (one in
// front of the base door in a new world, HOME_BIKE; FINDS.motorcycle at the crash sites, a new one a while after one
// is stood up), standing one up once its part slots are filled (its item is in box veh<id>: parts are fitted there
// like a building's, server/items.ts fit / unfit), and getting on and off: mount() moves the player onto it and starts
// the mount (shared/sim.ts), and whoever rides it carries it with them until they get off (or die, or leave), when it
// is parked where they are. Keeps shared/vehicles.ts's list in step and broadcasts it when it changes.
import { cargoBox, bikeLevel, GEAR, isVehicle, partsOf, repaired, scrapParts, vehicleBox, vehicleId } from '../shared/gear.ts';
import { partKind } from '../shared/items.ts';
import { coreCrashSites } from '../shared/crashsites.ts';
import { brokenParts, findSpot, homeBikeSpot, nearPiles } from '../shared/lootRoll.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { MOUNT_TICKS, type PlayerState } from '../shared/sim.ts';
import { FINDS, HOME_BIKE } from '../shared/tables.ts';
import { heightAt } from '../shared/terrain.ts';
import { TEXT } from '../shared/text.ts';
import { inReach, parked, setVehicles, vehicles, type Vehicle } from '../shared/vehicles.ts';
import { LAB } from '../shared/world.ts';
import type { openDb } from './db.ts';
import type { ItemServer } from './items.ts';

type Db = ReturnType<typeof openDb>;

/** Slack (m) on the reach checks for the server's view of the player lagging the client's. */
const REACH_SLACK = 1.5;
/** A find stood up is replaced by another broken one this long after (ms). */
const FIND_RESPAWN_MS = 3 * 60_000;
/** The world's DB setting that says the motorcycle items were made vehicles (v12, migrate()). */
const MIGRATED = 'vehicles';
const KIND = 'motorcycle';

export class VehicleServer {
  private db: Db;
  private items: ItemServer;
  private changed = false;
  /** Where each came from ('home', 'find', 'old'). */
  private src = new Map<number, string>();
  /** When the finds stood up are replaced (ms since epoch). */
  private due: number[] = [];
  private sites = coreCrashSites();
  private piles = nearPiles();

  constructor(db: Db, items: ItemServer) {
    this.db = db;
    this.items = items;
    if (db.getSetting(MIGRATED) === undefined) this.migrate();
    const rows = db.loadVehicles().filter((r) => isVehicle(r.kind));
    // The list first (shared/storage.ts opens the boxes by it), then each one's parts from its box.
    setVehicles(rows.map((r) => ({ id: r.id, kind: r.kind, x: r.x, y: r.y, z: r.z, heading: r.heading, up: r.up, parts: [] })));
    for (const r of rows) this.src.set(r.id, r.src);
    setVehicles(vehicles.map((v) => this.withParts(v)));
    db.tx(() => {
      if (![...this.src.values()].includes('home')) this.spawnHome();
      for (let n = this.lyingFinds(); n < this.wantFinds(); n++) this.spawnFind();
    });
    this.changed = false;
  }

  /** The vehicle as its box has it: the parts fitted now. */
  private withParts(v: Vehicle): Vehicle {
    const it = this.items.slots('', vehicleBox(v.id))[0];
    return { ...v, parts: it ? partsOf(it) : [] };
  }

  private set(list: Vehicle[]) {
    setVehicles(list);
    this.changed = true;
  }

  private update(id: number, change: Partial<Vehicle>) {
    this.set(vehicles.map((v) => (v.id === id ? { ...v, ...change } : v)));
  }

  /** A new vehicle (in the table, its item in its box with `parts`). Call inside a transaction. */
  private add(x: number, z: number, heading: number, parts: (string | null)[], up: boolean, src: string, y = heightAt(x, z)): Vehicle {
    const id = this.db.insertVehicle(KIND, x, y, z, heading, up, src);
    const v: Vehicle = { id, kind: KIND, x, y, z, heading, up, parts: [...parts] };
    this.src.set(id, src);
    this.set([...vehicles, v]); // (its box opens with it: shared/storage.ts boxSize)
    this.items.stowNew(vehicleBox(id), KIND, parts);
    return v;
  }

  /** The broken motorcycle in front of the base door, once in a world (HOME_BIKE). */
  private spawnHome() {
    const { x, z } = homeBikeSpot();
    const parts = GEAR[KIND].slots.map((s) => ('part' in s && HOME_BIKE.fitted.includes(s.part) ? partKind(s.part, 'scrap') : null));
    this.add(x, z, 0.6, parts, false, 'home');
  }

  /** Finds wanted lying broken at the crash sites at once (none in the lab: no desert). */
  private wantFinds() {
    return LAB ? 0 : (FINDS[KIND]?.n ?? 0);
  }

  /** Finds lying broken now, and those due back. */
  private lyingFinds() {
    return vehicles.filter((v) => this.src.get(v.id) === 'find' && !v.up).length + this.due.length;
  }

  /** A broken one at a crash site of its level (FINDS), like the gear found there (shared/lootRoll.ts). */
  private spawnFind(): Vehicle {
    const { x, z } = findSpot(FINDS[KIND]?.level ?? 1, this.sites, this.piles, Math.random);
    return this.add(x, z, Math.random() * Math.PI * 2, brokenParts(KIND, Math.random), false, 'find');
  }

  /**
   * v12: the motorcycle was an item (in the bag, the Vehicle slot, the chests, dropped on the sand) with a cargo box
   * of its own per player ('bike'). Each becomes a vehicle: one dropped on the sand where it lay, the others in a row
   * by the base door; a player's old cargo goes into their bike's (or a working one of their own if they had none).
   */
  private migrate() {
    this.db.tx(() => {
      const { bikes, cargo } = this.db.takeOldBikes();
      const dropped = this.db.loadDropped().filter((r) => r.kind === KIND);
      const home = homeBikeSpot();
      let row = 0;
      const lined = () => {
        row++;
        return { x: home.x + 3 * row, z: home.z - 2 };
      };
      const mine = new Map<string, Vehicle>();
      for (const b of bikes) {
        const parts = b.parts ?? scrapParts(KIND);
        const { x, z } = lined();
        const v = this.add(x, z, 0.6, parts, repaired({ id: 0, kind: KIND, n: 1, parts }), 'old');
        if (b.owner && (!mine.has(b.owner) || v.up)) mine.set(b.owner, v);
      }
      for (const d of dropped) {
        this.db.deleteDropped(d.id);
        this.add(d.x, d.z, Math.random() * Math.PI * 2, d.parts ?? scrapParts(KIND), false, 'old');
      }
      for (const owner of cargo) {
        let v = mine.get(owner);
        if (!v?.up) {
          const { x, z } = lined();
          v = this.add(x, z, 0.6, scrapParts(KIND), true, 'old');
        }
        this.db.moveBox(owner, 'bike', '', cargoBox(v.id));
      }
      this.db.setSetting(MIGRATED, 1);
      if (bikes.length || dropped.length || cargo.length) {
        console.log(`vehicles: ${bikes.length + dropped.length} motorcycles and ${cargo.length} cargo boxes are in the world now`);
      }
    });
  }

  /** The vehicles' boxes, for a joining player: each one's item, and a working one's cargo. */
  boxes(): string[] {
    return vehicles.flatMap((v) => (v.up ? [vehicleBox(v.id), cargoBox(v.id)] : [vehicleBox(v.id)]));
  }

  /** A vehicle's box changed (parts fitted or taken out): its parts in the list follow. */
  refresh(box: string) {
    const id = vehicleId(box);
    if (vehicles.some((v) => v.id === id)) this.set(vehicles.map((v) => (v.id === id ? this.withParts(v) : v)));
  }

  /** May a part come out of this box? Not out of a working vehicle (only swapped for another). */
  canUnfit(box: string): boolean {
    const id = vehicleId(box);
    return id < 0 || !vehicles.find((v) => v.id === id)?.up;
  }

  /** Stand broken vehicle `id` up (every part slot filled, in reach of `s`). Returns it, or why not. */
  repair(s: PlayerState, id: unknown): Vehicle | string {
    const v = vehicles.find((q) => q.id === id);
    if (!v || v.up) return TEXT.notice.alreadyGone;
    if (!parked(v) || !inReach(s, v, REACH_SLACK)) return TEXT.notice.tooFar;
    if (!repaired(this.items.slots('', vehicleBox(v.id))[0])) return TEXT.notice.missingParts;
    this.db.standVehicle(v.id);
    this.update(v.id, { up: true });
    // A find stood up: another broken one comes after a while.
    if (this.src.get(v.id) === 'find') this.due.push(Date.now() + FIND_RESPAWN_MS);
    return vehicles.find((q) => q.id === v.id)!;
  }

  /**
   * Player `rider` (public id) at `s` starts getting on vehicle `id`: it must be working, in reach and nobody's on it.
   * Returns their state moved onto it, mounting (shared/sim.ts), or why not.
   */
  mount(rider: number, s: PlayerState, id: unknown): PlayerState | string {
    const v = vehicles.find((q) => q.id === id);
    if (!v) return TEXT.notice.alreadyGone;
    if (s.riding || s.mounting > 0 || this.ridden(rider)) return TEXT.notice.getOffFirst;
    if (!parked(v)) return TEXT.notice.someoneOnIt;
    if (!inReach(s, v, REACH_SLACK)) return TEXT.notice.tooFar;
    const bike = bikeLevel(this.items.slots('', vehicleBox(v.id))[0]);
    if (!v.up || !bike) return TEXT.notice.broken;
    this.update(v.id, { rider });
    return {
      ...s, x: v.x, y: v.y, z: v.z, vx: 0, vy: 0, vz: 0, sliding: false, crouching: false,
      riding: false, mounting: MOUNT_TICKS, heading: v.heading, bike, nose: 0, noseSpin: 0,
    };
  }

  /** The vehicle player `rider` is getting on or riding, if any. */
  ridden(rider: number): Vehicle | undefined {
    return vehicles.find((v) => v.rider === rider);
  }

  /**
   * Player `rider` is off their vehicle: after riding it (`s`: where they got off), it's parked there; stopped while
   * getting on, it stays where it stood.
   */
  release(rider: number, s?: PlayerState) {
    const v = this.ridden(rider);
    if (!v) return;
    if (!s) return this.update(v.id, { rider: undefined });
    // In the air (died, left mid-jump): down on the ground under them.
    const y = s.grounded ? s.y : Math.min(s.y, heightAt(s.x, s.z));
    this.db.moveVehicle(v.id, s.x, y, s.z, s.heading);
    this.update(v.id, { x: s.x, y, z: s.z, heading: s.heading, rider: undefined });
  }

  /** Every few seconds: the finds stood up a while ago are replaced by broken ones. Returns the new ones' ids. */
  respawn(): number[] {
    const now = Date.now();
    const n = this.due.filter((t) => t <= now).length;
    if (!n) return [];
    this.due = this.due.filter((t) => t > now);
    return this.db.tx(() => Array.from({ length: n }, () => this.spawnFind().id));
  }

  joinMessage(): ServerMsg {
    return { t: 'vehicles', list: vehicles };
  }

  flush(): ServerMsg | null {
    if (!this.changed) return null;
    this.changed = false;
    return this.joinMessage();
  }
}
