// One-off gifts to the players from before a change, given once each as they join (server/world.ts): the backpack
// for those who had the old starter kit, and the laser rifle for those who played before it. Kept in the DB
// (`gear_kits`, `starter_kits`, `grants`) so nobody gets one twice.
import { EQUIP_SLOTS, isGear, scrapParts } from '../shared/gear.ts';
import { CLOTH, findSpot, HOTBAR, makeItem, partKind, SCRAP } from '../shared/items.ts';
import { RIFLE } from '../shared/rifle.ts';
import type { openDb } from './db.ts';
import type { ItemServer } from './items.ts';

type Db = ReturnType<typeof openDb>;

/**
 * Once per player: there's no starter kit any more (the water bottle and the rest are found broken, see
 * server/loot.ts). Players from before keep what they had, and get a backpack with a Quality gear (9 slots) so
 * their bag keeps its 8; if its slot is taken, it goes past the end of the bag.
 */
export function grantKits(items: ItemServer, db: Db, browserId: string) {
  rifleGift(items, db, browserId);
  if (db.hasGearKit(browserId)) return;
  db.tx(() => {
    if (db.hasStarterKit(browserId)) {
      items.change(browserId, ['equip', 'bag'], (newId) => {
        const equip = items.slots(browserId, 'equip');
        const pack = makeItem(newId(), { kind: 'backpack', parts: [CLOTH, SCRAP, partKind('gear', 'quality')] });
        const back = EQUIP_SLOTS.indexOf('back');
        if (!equip[back]) equip[back] = pack;
        else items.slots(browserId, 'bag').push(pack);
      });
    } else db.markStarterKit(browserId);
    db.markGearKit(browserId);
  });
}

/**
 * Once, to the players from before the laser rifle (shared/rifle.ts): one in the 4th hotbar slot. New players find
 * and repair their own.
 */
function rifleGift(items: ItemServer, db: Db, browserId: string) {
  slotGift(items, db, browserId, 'rifle', RIFLE, HOTBAR - 1, db.hasGearKit(browserId));
}

/**
 * Grant `grant`, once: if `give`, a `kind` into bag slot `slot`. Whatever was there moves to the first free spot in
 * the bag (past its end if there's none).
 */
function slotGift(items: ItemServer, db: Db, browserId: string, grant: string, kind: string, slot: number, give: boolean) {
  if (db.hasGrant(browserId, grant)) return;
  db.tx(() => {
    db.markGrant(browserId, grant);
    if (!give) return;
    items.change(browserId, ['bag'], (newId) => {
      const bag = items.slots(browserId, 'bag');
      const was = bag[slot];
      bag[slot] = makeItem(newId(), { kind, ...(isGear(kind) ? { parts: scrapParts(kind) } : {}) });
      if (!was) return;
      const spot = findSpot(bag, items.bagShape(browserId), was.kind, !!was.r, [slot]);
      if (spot) bag[spot.i] = makeItem(was.id, { ...was, r: spot.r });
      else bag.push(was);
    });
  });
}
