// Server side of placed things (shared/placed.ts): the `placed` table, putting an item from the bag down on
// a floor and picking it back up, and putting up a building with the wrench from the base materials in the
// bag (shared/crafting.ts BUILDS) and taking it down again (they all come back, with the parts fitted in it), each in
// one transaction with the bag. A windmill or battery station (shared/gear.ts isBuilding) keeps its item in its own
// box while it stands (buildingBox), its part slots empty at first: its parts are fitted there (server/items.ts fit /
// unfit); a beacon's light colour is its item's data (recolor); a chest keeps its things in box `store<id>` (shared/storage.ts;
// server/world.ts won't take one down with anything in it, nor a dismantling table with a machine on it). A bedroll is its
// owner's (browser IDs stay here, never sent: the owner alone is told where theirs lies, bedrollOf): one each, laying a new
// one moves the old, and only the owner picks it up. Keeps shared/placed.ts's list (and so the collision) in step, and
// broadcasts the list when it changes.
import { buildingBox, storeBox } from '../shared/boxes.ts';
import { EYE_HEIGHT } from '../shared/dig.ts';
import { BUILDS, buildCost, isBuildable, WRENCH } from '../shared/crafting.ts';
import { isBuilding, partsOf } from '../shared/gear.ts';
import { partAt, setData } from '../shared/items.ts';
import { BEACON, BEACON_COLORS, BEDROLL, CHEST, isPlaceable, PLACE_REACH, PLACED_REACH, placeError, placeFloor, placed, placedReach, placedY, SAND_REACH, setPlaced, type Placed } from '../shared/placed.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import type { openDb } from './db.ts';
import type { ItemServer } from './items.ts';
import { OLD_FLOOR_Y } from './bunkerGone.ts';
import { TEXT } from '../shared/text.ts';

type Db = ReturnType<typeof openDb>;

/** Slack (m) on the reach checks for the server's view of the player lagging the client's. */
const REACH_SLACK = 1.5;

export class PlacedServer {
  private db: Db;
  private items: ItemServer;
  private changed = false;
  /** Who put each bedroll down (browser ID): server-side only. */
  private owners = new Map<number, string>();

  constructor(db: Db, items: ItemServer) {
    this.db = db;
    this.items = items;
    const rows = db.loadPlaced().filter((r) => isPlaceable(r.kind));
    for (const r of rows) if (r.kind === BEDROLL) this.owners.set(r.id, r.owner);
    // (Rows from before `y` was saved were all on the old bunker's floor: server/bunkerGone.ts moves them out.)
    setPlaced(rows.map((r) => ({ id: r.id, kind: r.kind, x: r.x, y: r.y ?? OLD_FLOOR_Y, z: r.z, rot: r.rot })));
    // A building's parts come from its box (shared/storage.ts opens it now the list is in).
    setPlaced(placed.map((p) => (isBuilding(p.kind) ? this.withParts(p) : p)));
  }

  /** The building as its box has it: the parts fitted now, a beacon's colour. */
  private withParts(p: Placed): Placed {
    const it = this.items.slots('', buildingBox(p.id))[0];
    const color = it?.data?.color;
    return { ...p, parts: it ? partsOf(it) : [], ...(color ? { color } : {}) };
  }

  /** Beacon `id`'s light to colour `color` (BEACON_COLORS index), for a player at `feet` in reach of it. Null when done. */
  recolor(feet: { x: number; y: number; z: number }, id: unknown, color: unknown): string | null {
    const p = placed.find((q) => q.id === id);
    if (!p || p.kind !== BEACON) return TEXT.notice.alreadyGone;
    if (!Number.isInteger(color) || (color as number) < 0 || (color as number) >= BEACON_COLORS.length) return TEXT.notice.badSpot;
    if (placedReach(feet, p) > PLACED_REACH + REACH_SLACK) return TEXT.notice.tooFar;
    const box = buildingBox(p.id);
    this.items.edit('', box, 0, (it) => {
      setData(it, 'color', color ? (color as number) : undefined);
      return true;
    });
    this.refresh(box);
    return null;
  }

  /** The bedroll `browserId` laid out, if it's still there. */
  bedrollOf(browserId: string): Placed | null {
    return placed.find((p) => p.kind === BEDROLL && this.owners.get(p.id) === browserId) ?? null;
  }

  /** The buildings' and the chests' boxes, for a joining player. */
  boxes(): string[] {
    return placed.flatMap((p) => (isBuilding(p.kind) ? [buildingBox(p.id)] : p.kind === CHEST ? [storeBox(p.id)] : []));
  }

  /**
   * Put the item in bag slot `slot` down at (x, z). `players`: everyone's feet (nobody gets boxed in).
   * Returns the new placed thing, or why not.
   */
  place(browserId: string, feet: { x: number; y: number; z: number }, slot: unknown, x: unknown, z: unknown, rot: unknown,
    players: { x: number; y: number; z: number }[]): Placed | string {
    const kind = Number.isInteger(slot) ? this.items.slots(browserId, 'bag')[slot as number]?.kind : undefined;
    // (A building is put up with the wrench: build.)
    if (!kind || !isPlaceable(kind) || isBuildable(kind)) return TEXT.notice.cantPlace;
    // A new bedroll rolls up your old one, back into the bag: the same as moving the old one here and keeping this one in
    // the bag (bedrolls are all alike), which can't run out of room.
    const old = kind === BEDROLL ? this.bedrollOf(browserId) : null;
    const why = this.spotError(kind, feet, x, z, rot, players, old);
    if (why) return why;
    const p = this.db.tx((): Placed | null => {
      if (old) this.db.deletePlaced(old.id);
      else if (!this.items.takeItemAt(browserId, slot as number, kind)) return null;
      return this.add(browserId, kind, x as number, z as number, rot as number, placeFloor(kind, feet));
    });
    if (p && old) {
      this.owners.delete(old.id);
      setPlaced(placed.filter((q) => q !== old));
      this.changed = true;
    }
    if (!p) return TEXT.notice.cantPlace;
    return p;
  }

  /**
   * Put up building `kind` at (x, z) with the wrench, using up its materials from the bag (shared/crafting.ts BUILDS).
   * A windmill or battery station stands with its part slots empty. Returns the new placed thing, or why not.
   */
  build(browserId: string, feet: { x: number; y: number; z: number }, kind: unknown, x: unknown, z: unknown, rot: unknown,
    players: { x: number; y: number; z: number }[]): Placed | string {
    if (typeof kind !== 'string' || !isBuildable(kind) || !isPlaceable(kind)) return TEXT.notice.cantPlace;
    if (!this.items.has(browserId, WRENCH)) return TEXT.notice.cantPlace;
    const why = this.spotError(kind, feet, x, z, rot, players);
    if (why) return why;
    const p = this.db.tx((): Placed | null => {
      if (!this.items.useUp(browserId, BUILDS[kind])) return null;
      const q = this.add(browserId, kind, x as number, z as number, rot as number, placeFloor(kind, feet));
      if (isBuilding(kind)) this.items.stowNew(buildingBox(q.id), kind);
      return q;
    });
    return p ?? TEXT.notice.missingMaterials;
  }

  /** Why `kind` can't go at (x, z) turned `rot` for a player at `feet`, or null. */
  private spotError(kind: string, feet: { x: number; y: number; z: number }, x: unknown, z: unknown, rot: unknown,
    players: { x: number; y: number; z: number }[], moving: Placed | null = null): string | null {
    if (typeof x !== 'number' || typeof z !== 'number' || typeof rot !== 'number') return TEXT.notice.badSpot;
    const floor = placeFloor(kind, feet);
    const why = placeError(kind, x, z, rot, floor, moving ? placed.filter((q) => q !== moving) : placed, players);
    if (why) return why;
    const dy = placedY(kind, x, z, rot, floor) - feet.y - EYE_HEIGHT;
    if (Math.hypot(x - feet.x, dy, z - feet.z) > (floor === null ? SAND_REACH : PLACE_REACH) + REACH_SLACK) return TEXT.notice.tooFar;
    return null;
  }

  /** Into the table and the list (a building's box opens with it, shared/storage.ts boxSize). Call inside a transaction. */
  private add(browserId: string, kind: string, x: number, z: number, rot: number, floor: number | null): Placed {
    const y = placedY(kind, x, z, rot, floor);
    const id = this.db.insertPlaced(kind, x, y, z, rot, browserId);
    if (kind === BEDROLL) this.owners.set(id, browserId);
    const q: Placed = { id, kind, x, y, z, rot, ...(isBuilding(kind) ? { parts: partsOf({ id: 0, kind, n: 1 }) } : {}) };
    setPlaced([...placed, q]);
    this.changed = true;
    return q;
  }

  /**
   * Pick placed thing `id` back up into the bag, or take a building down with the wrench: what it was built of and the
   * parts in it come back, with `extra` (its wires' wiring). All of it must fit in the bag. Returns it, or why not.
   */
  unplace(browserId: string, feet: { x: number; y: number; z: number }, id: unknown, extra: (p: Placed) => { kind: string; n: number }[] = () => []): Placed | string {
    const p = placed.find((q) => q.id === id);
    if (!p) return TEXT.notice.alreadyGone;
    if (placedReach(feet, p) > PLACED_REACH + REACH_SLACK) return TEXT.notice.tooFar;
    if (p.kind === BEDROLL && this.owners.get(p.id) !== browserId) return TEXT.notice.notYours;
    const built = isBuildable(p.kind);
    if (built && !this.items.has(browserId, WRENCH)) return TEXT.notice.cantPlace;
    const box = buildingBox(p.id);
    const it = isBuilding(p.kind) ? this.items.slots('', box)[0] : null;
    const back = built
      ? [...buildCost(p.kind), ...(it ? partsOf(it).map((_, i) => partAt(it, i)) : []).flatMap((q) => (q ? [{ ...q, n: 1 }] : [])), ...extra(p)]
      : [{ kind: p.kind, n: 1 }, ...extra(p)];
    const ok = this.db.tx(() => {
      if (!this.items.giveAll(browserId, back)) return false;
      if (it) this.items.unstow(box);
      this.db.deletePlaced(p.id);
      return true;
    });
    if (!ok) return TEXT.notice.bagFull;
    this.owners.delete(p.id);
    setPlaced(placed.filter((q) => q !== p));
    this.changed = true;
    return p;
  }

  /** Put `kind` up at (x, z) on the sand turned `rot` for `owner`, no questions asked (server/bunkerGone.ts: check the spot
   *  with freeSpot). A building's box opens with it, empty. Returns it. */
  put(owner: string, kind: string, x: number, z: number, rot: number): Placed {
    return this.db.tx(() => {
      const q = this.add(owner, kind, x, z, rot, null);
      if (isBuilding(kind)) this.items.stowNew(buildingBox(q.id), kind);
      return q;
    });
  }

  /** Placed thing `id` now stands at (x, z) on the sand, turned `rot` (its boxes, owner and jobs go with its id). */
  moveTo(id: number, x: number, z: number, rot: number) {
    const i = placed.findIndex((p) => p.id === id);
    if (i < 0) return;
    const y = placedY(placed[i].kind, x, z, rot, null);
    this.db.movePlaced(id, x, y, z, rot);
    const list = [...placed];
    list[i] = { ...list[i], x, y, z, rot };
    setPlaced(list);
    this.changed = true;
  }

  /** Placed thing `id` is gone (what it was is the caller's to give back). */
  remove(id: number) {
    this.db.deletePlaced(id);
    this.owners.delete(id);
    setPlaced(placed.filter((p) => p.id !== id));
    this.changed = true;
  }

  /** The first spot on the sand where `kind` may go (shared/placed.ts placeError, nobody about), trying rings of
   *  `rings` m round `at` in eight directions each, either turn; null if none. */
  freeSpot(kind: string, at: { x: number; z: number }, rings: number[]): { x: number; z: number; rot: number } | null {
    const dirs = [[1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071], [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071]];
    for (const d of rings) for (const [ux, uz] of dirs) for (const rot of [0, 1]) {
      const x = Math.round((at.x + ux * d) * 4) / 4, z = Math.round((at.z + uz * d) * 4) / 4;
      if (!placeError(kind, x, z, rot, null, placed)) return { x, z, rot };
    }
    return null;
  }

  /** A building's box changed (parts fitted or taken out): its parts in the list follow. */
  refresh(box: string) {
    const i = placed.findIndex((p) => isBuilding(p.kind) && buildingBox(p.id) === box);
    if (i < 0) return;
    const list = [...placed];
    list[i] = this.withParts(list[i]);
    setPlaced(list);
    this.changed = true;
  }

  joinMessage(): ServerMsg {
    return { t: 'placed', list: placed };
  }

  flush(): ServerMsg | null {
    if (!this.changed) return null;
    this.changed = false;
    return this.joinMessage();
  }
}
