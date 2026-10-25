// Once per world: the crashed ship players arrived at for a while is gone, and the pods (shared/pods.ts) lie near the
// origin instead. Run on world load (server/world.ts) after bunkerGone, before the vehicles; marked done in `settings`
// ('pods_landed').
//
// - Anything put up on the sand that a pod now lies on (or within its keep-clear: shared/placed.ts) moves out beside it,
//   its boxes, owner and jobs going with it (the chests bunkerGone put up by the ship's ramp among them).
// - The sand changed where the ship's furrow was and where the pods' are: what stands on it stands on it again.
// - The small shelter with a pump that lay near the ship is gone too (water is at the pods' taps now): what stood on its
//   floor stands on the sand over it, and what stands only on floors (plant beds, UV lamps) goes back to whoever put it
//   down.
// - The world's first bike, still lying broken where the ship left it, goes to its spot by the first pod; vehicles in a
//   pod move out of it, the rest back onto the sand.
// (The machines carried off the ship ("ship:<n>") and the ship's loot are forgotten by server/crash.ts and server/loot.ts
// on their own: nothing has those ids now.)
import { homeBikeSpot } from '../shared/lootRoll.ts';
import { makeItem } from '../shared/items.ts';
import { onSand, placeError, placed, placedY, standsIndoors } from '../shared/placed.ts';
import { overShelter } from '../shared/shelters.ts';
import { nearPod } from '../shared/podSpot.ts';
import { TEXT } from '../shared/text.ts';
import { heightAt } from '../shared/terrain.ts';
import type { openDb } from './db.ts';
import { intoBag } from './bunkerGone.ts';
import type { ItemServer } from './items.ts';
import type { PlacedServer } from './placed.ts';

type Db = ReturnType<typeof openDb>;

/** How far from where it stood a thing in a pod's way is looked for a spot (m). */
const RINGS = [3, 4.5, 6, 8, 10, 13, 16, 20, 25];

export function podsLanded(db: Db, items: ItemServer, placedSrv: PlacedServer) {
  if (db.getSetting('pods_landed')) return;
  const log: string[] = [];
  const blocked = TEXT.notice.tooClose(TEXT.spots.pod);
  db.tx(() => {
    const owners = new Map(db.loadPlaced().map((r) => [r.id, r.owner]));
    for (const p of [...placed]) {
      if (standsIndoors(p)) continue;
      if (!onSand(p.kind)) {
        // (On the floor of the shelter that's gone: back to its owner.)
        const owner = owners.get(p.id) ?? '';
        let given = false;
        if (owner) items.change(owner, ['bag'], (newId) => (given = intoBag(items, owner, makeItem(newId(), { kind: p.kind }))));
        if (given) {
          placedSrv.remove(p.id);
          log.push(`${p.kind} ${p.id} given back`);
        }
        continue;
      }
      const others = placed.filter((q) => q.id !== p.id);
      if (placeError(p.kind, p.x, p.z, p.rot, null, others) === blocked) {
        const at = placedSrv.freeSpot(p.kind, p, RINGS);
        if (at) {
          placedSrv.moveTo(p.id, at.x, at.z, at.rot);
          log.push(`${p.kind} ${p.id} moved out of a pod's way`);
          continue;
        }
        log.push(`${p.kind} ${p.id}: no spot by the pods, left where it was`);
      }
      const y = placedY(p.kind, p.x, p.z, p.rot, null);
      if (Math.abs(y - p.y) > 0.02) placedSrv.moveTo(p.id, p.x, p.z, p.rot);
    }
    for (const v of db.loadVehicles()) {
      if (v.src === 'home' && !v.up) {
        const at = homeBikeSpot();
        db.moveVehicle(v.id, at.x, heightAt(at.x, at.z), at.z, 0.6);
        log.push('the first bike moved by the first pod');
      } else if (nearPod(v.x, v.z, 1)) {
        let x = v.x, z = v.z;
        for (let d = 2; d < 20 && nearPod(x, z, 1.5); d += 1) [x, z] = [v.x + d, v.z + d * 0.5];
        db.moveVehicle(v.id, x, heightAt(x, z), z, v.heading);
        log.push(`vehicle ${v.id} moved out of a pod`);
      } else {
        // (On the sand, or in the shelter that's gone: not one down in a shelter that stands.)
        const y = heightAt(v.x, v.z);
        if (Math.abs(y - v.y) > 0.02 && !overShelter(v.x, v.z, 0.5)) db.moveVehicle(v.id, v.x, y, v.z, v.heading);
      }
    }
    db.setSetting('pods_landed', 1);
  });
  console.log(`pods landed${log.length ? ': ' + log.join('; ') : ''}`);
}
