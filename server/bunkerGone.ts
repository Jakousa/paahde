// Once per world: the starting bunker is gone (it stood at the world's origin, shared/origin.ts; players arrive at the
// crashed ship now), so whatever was kept in it comes out, and nothing anyone owned is lost. Run on world load
// (server/world.ts) after the terrain, the items and the placed things are in, before the vehicles, the garden and the
// players; marked done in `settings` ('bunker_gone').
//
// - The bunker's chests ('chest<i>', shared, endless) go into new chests put up by the ship (box `store<id>`, as many as
//   their things need), with the machine left on its dismantling table (the 'bench' job, as a whole machine again: the
//   parts already taken were given out) and whatever doesn't fit back in its owner's bag.
// - What players had on a workbench's repair slot (their 'bench' box) goes back into their bag, or that chest. (Any
//   workbench opens the slot, but there may be none standing now.)
// - Things put down on the bunker's floor: plant beds and UV lamps (they stand on floors only) back to whoever put them
//   down, or the chest; the rest (work stations, chests, bedrolls) are moved out onto the sand by the ship, their boxes,
//   jobs and owners going with them.
// - Everything on the sand where the bunker's pad and the ship's pad changed the ground is set back on it.
// - Players who left in or over the bunker, and vehicles parked down in it, are moved to the ship.
import { storeBox } from '../shared/boxes.ts';
import { CHEST_COLS, CHEST_ROWS, findSpot, gridShape, makeItem, type Item, type Slots } from '../shared/items.ts';
import { ORIGIN, originClear } from '../shared/origin.ts';
import { CHEST, onSand, placed, placedY, standsIndoors } from '../shared/placed.ts';
import { spawnPoint } from '../shared/sim.ts';
import { heightAt } from '../shared/terrain.ts';
import type { openDb } from './db.ts';
import type { ItemServer } from './items.ts';
import type { PlacedServer } from './placed.ts';

type Db = ReturnType<typeof openDb>;

/** The bunker's floor (world y): 48 steps of 0.25 m down from its entrance. */
export const OLD_FLOOR_Y = ORIGIN.y - 12;
/** The bunker's footprint, world [x0, z0, x1, z1], with a margin: its entrance, stairs, hallway, main room and alcoves. */
const FOOTPRINT = [ORIGIN.x - 10.5, ORIGIN.z - 39, ORIGIN.x + 10.5, ORIGIN.z + 3.5];
const inFootprint = (x: number, z: number) => x > FOOTPRINT[0] && x < FOOTPRINT[2] && z > FOOTPRINT[1] && z < FOOTPRINT[3];
/** Down in it (not on the sand over it). */
const below = (x: number, y: number, z: number) => inFootprint(x, z) && y < ORIGIN.y - 1;
/** The floor-only kinds: no sand to move them to. */
const FLOOR_ONLY = new Set(['plant_bed', 'uv_lamp']);
/** How far from the ship's ramp new chests and moved things are looked for a spot (m). */
const RINGS = [7, 10, 13, 16, 20, 24, 28, 33, 38, 44, 50];

export function bunkerGone(db: Db, items: ItemServer, placedSrv: PlacedServer) {
  if (db.getSetting('bunker_gone')) return;
  const spawn = spawnPoint();
  const log: string[] = [];
  db.tx(() => {
    const loose: Item[] = [];
    // Its chests.
    for (const box of db.sharedBoxes(/^chest\d+$/)) {
      const rows = db.loadBox('', box);
      for (const r of rows) loose.push(makeItem(r.id, r));
      db.clearBox('', box);
      if (rows.length) log.push(`${rows.length} stacks from ${box}`);
    }
    // The machine on its dismantling table.
    const job = db.loadBenches().find((j) => j.id === 'bench');
    if (job) {
      items.change('', [], (newId) => loose.push(makeItem(newId(), { kind: job.kind })));
      db.clearBench('bench');
      db.clearProgress('bench');
      log.push(`the ${job.kind} on its table`);
    }
    // The workbench's repair slot, back to the bag.
    for (const owner of db.ownersOf('bench')) {
      const slot = items.slots(owner, 'bench');
      items.change(owner, ['bench', 'bag'], () => {
        for (let i = 0; i < slot.length; i++) {
          const it = slot[i];
          if (!it) continue;
          slot[i] = null;
          if (!intoBag(items, owner, it)) loose.push(it);
        }
      });
    }
    // On its floor.
    const owners = new Map(db.loadPlaced().map((r) => [r.id, r.owner]));
    for (const p of placed.filter((q) => below(q.x, q.y, q.z))) {
      if (FLOOR_ONLY.has(p.kind) || !onSand(p.kind)) {
        placedSrv.remove(p.id);
        const owner = owners.get(p.id) ?? '';
        let given = false;
        if (owner) items.change(owner, ['bag'], (newId) => (given = intoBag(items, owner, makeItem(newId(), { kind: p.kind }))));
        if (!given) items.change('', [], (newId) => loose.push(makeItem(newId(), { kind: p.kind })));
        log.push(`${p.kind} ${p.id} given back`);
        continue;
      }
      const at = placedSrv.freeSpot(p.kind, spawn, RINGS);
      if (at) {
        placedSrv.moveTo(p.id, at.x, at.z, at.rot);
        log.push(`${p.kind} ${p.id} moved out`);
      } else log.push(`${p.kind} ${p.id}: no spot by the ship, left where it was`);
    }
    // The loose things into new chests by the ship.
    while (loose.length) {
      const at = placedSrv.freeSpot(CHEST, spawn, RINGS);
      if (!at) {
        log.push(`no room for a chest by the ship: ${loose.length} stacks left in box chest0`);
        items.change('', ['chest0'], () => items.slots('', 'chest0').push(...loose.splice(0)));
        break;
      }
      const c = placedSrv.put('', CHEST, at.x, at.z, at.rot);
      const box = storeBox(c.id), slots = items.slots('', box);
      const n = loose.length;
      items.change('', [box], () => fill(slots, loose));
      log.push(`chest ${c.id}: ${n - loose.length} stacks`);
      if (loose.length === n) {
        // (Something too big for any chest: it can't be, the chest is as big as any bag.)
        log.push(`${n} stacks fit no chest`);
        break;
      }
    }
    // The sand round the origin and by the ship has changed: what stands on it stands on it again.
    for (const p of [...placed]) {
      if (standsIndoors(p) || below(p.x, p.y, p.z)) continue;
      const y = placedY(p.kind, p.x, p.z, p.rot, null);
      if (Math.abs(y - p.y) > 0.02) placedSrv.moveTo(p.id, p.x, p.z, p.rot);
    }
    // Vehicles down in it to the ship; those on the sand over the old pad back on the sand.
    for (const v of db.loadVehicles()) {
      if (below(v.x, v.y, v.z)) db.moveVehicle(v.id, spawn.x + 4, heightAt(spawn.x + 4, spawn.z + 4), spawn.z + 4, v.heading);
      else if (originClear(v.x, v.z) < 1) db.moveVehicle(v.id, v.x, heightAt(v.x, v.z), v.z, v.heading);
    }
    const moved = db.movePlayers(FOOTPRINT, spawn.x, spawn.z);
    if (moved) log.push(`${moved} players moved to the ship`);
    db.setSetting('bunker_gone', 1);
  });
  console.log(`bunker gone${log.length ? ': ' + log.join('; ') : ''}`);
}

/** Item `it` into the first spot it fits in `owner`'s bag; false if none (the caller saves the bag). */
function intoBag(items: ItemServer, owner: string, it: Item): boolean {
  const bag = items.slots(owner, 'bag');
  const spot = findSpot(bag, items.bagShape(owner), it.kind, !!it.r);
  if (!spot) return false;
  bag[spot.i] = makeItem(it.id, { ...it, r: spot.r });
  return true;
}

/** As many of `loose` as fit into a chest's grid (taken out of `loose`). */
function fill(slots: Slots, loose: Item[]) {
  const shape = gridShape(CHEST_COLS, CHEST_ROWS);
  for (let k = 0; k < loose.length;) {
    const it = loose[k];
    const spot = findSpot(slots, shape, it.kind, !!it.r);
    if (!spot) {
      k++;
      continue;
    }
    slots[spot.i] = makeItem(it.id, { ...it, r: spot.r });
    loose.splice(k, 1);
  }
}
