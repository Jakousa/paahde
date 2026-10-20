// Server side of placed things (shared/placed.ts): the `placed` table, putting an item from the bag down on
// the bunker floor or the sand round the base and picking it back up, both in one transaction with the bag. A
// building (shared/gear.ts isBuilding) keeps its item, parts and all, in its own box while it stands (buildingBox):
// its parts are swapped there (server/items.ts fit / unfit), and it comes back into the bag as it is. Keeps
// shared/placed.ts's list (and so the collision) in step, and broadcasts the list when it changes.
import { EYE_HEIGHT } from '../shared/dig.ts';
import { buildingBox, isBuilding, partsOf } from '../shared/gear.ts';
import { isPlaceable, onSand, PLACE_FLOOR_Y, PLACE_REACH, PLACED_REACH, placeError, placed, placedReach, placedY, SAND_REACH, setPlaced, type Placed } from '../shared/placed.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import type { openDb } from './db.ts';
import type { ItemServer } from './items.ts';
import { TEXT } from '../shared/text.ts';

type Db = ReturnType<typeof openDb>;

/** Slack (m) on the reach checks for the server's view of the player lagging the client's. */
const REACH_SLACK = 1.5;

export class PlacedServer {
  private db: Db;
  private items: ItemServer;
  private changed = false;

  constructor(db: Db, items: ItemServer) {
    this.db = db;
    this.items = items;
    setPlaced(db.loadPlaced().filter((r) => isPlaceable(r.kind))
      .map((r) => ({ id: r.id, kind: r.kind, x: r.x, y: r.y ?? PLACE_FLOOR_Y, z: r.z, rot: r.rot })));
    // A building's parts come from its box (shared/storage.ts opens it now the list is in).
    setPlaced(placed.map((p) => (isBuilding(p.kind) ? this.withParts(p) : p)));
  }

  /** The building as its box has it: the parts fitted now. */
  private withParts(p: Placed): Placed {
    const it = this.items.slots('', buildingBox(p.id))[0];
    return { ...p, parts: it ? partsOf(it) : [] };
  }

  /** The buildings' boxes, for a joining player. */
  boxes(): string[] {
    return placed.filter((p) => isBuilding(p.kind)).map((p) => buildingBox(p.id));
  }

  /**
   * Put the item in bag slot `slot` down at (x, z). `players`: everyone's feet (nobody gets boxed in).
   * Returns the new placed thing, or why not.
   */
  place(browserId: string, feet: { x: number; y: number; z: number }, slot: unknown, x: unknown, z: unknown, rot: unknown,
    players: { x: number; y: number; z: number }[]): Placed | string {
    const kind = Number.isInteger(slot) ? this.items.slots(browserId, 'bag')[slot as number]?.kind : undefined;
    if (!kind || !isPlaceable(kind)) return TEXT.notice.cantPlace;
    if (typeof x !== 'number' || typeof z !== 'number' || typeof rot !== 'number') return TEXT.notice.badSpot;
    const why = placeError(kind, x, z, rot, placed, players);
    if (why) return why;
    const y = placedY(kind, x, z, rot);
    const dy = y - feet.y - EYE_HEIGHT;
    if (Math.hypot(x - feet.x, dy, z - feet.z) > (onSand(kind) ? SAND_REACH : PLACE_REACH) + REACH_SLACK) return TEXT.notice.tooFar;
    const p = this.db.tx((): Placed | null => {
      const it = this.items.takeItemAt(browserId, slot as number, kind);
      if (!it) return null;
      const q: Placed = { id: this.db.insertPlaced(kind, x, y, z, rot, browserId), kind, x, y, z, rot, ...(isBuilding(kind) ? { parts: partsOf(it) } : {}) };
      // In the list first: its box opens with it (shared/storage.ts boxSize).
      setPlaced([...placed, q]);
      if (isBuilding(kind)) this.items.stow(buildingBox(q.id), it);
      return q;
    });
    if (!p) return TEXT.notice.cantPlace;
    this.changed = true;
    return p;
  }

  /** Pick placed thing `id` back up into the bag (a building with the parts in it now). Returns it, or why not. */
  unplace(browserId: string, feet: { x: number; y: number; z: number }, id: unknown): Placed | string {
    const p = placed.find((q) => q.id === id);
    if (!p) return TEXT.notice.alreadyGone;
    if (placedReach(feet, p) > PLACED_REACH + REACH_SLACK) return TEXT.notice.tooFar;
    const box = buildingBox(p.id);
    const it = isBuilding(p.kind) ? this.items.slots('', box)[0] : null;
    if (!this.items.roomFor(browserId, p.kind)) return TEXT.notice.bagFull;
    const ok = this.db.tx(() => {
      if (!(it ? this.items.giveItem(browserId, { kind: it.kind, parts: partsOf(it) }) : this.items.give(browserId, p.kind))) return false;
      if (it) this.items.unstow(box);
      this.db.deletePlaced(p.id);
      return true;
    });
    if (!ok) return TEXT.notice.bagFull;
    setPlaced(placed.filter((q) => q !== p));
    this.changed = true;
    return p;
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
