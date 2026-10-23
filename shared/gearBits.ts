// What others see of your gear, packed into a player snapshot (PlayerSnap.gear, .tiers): what you wear, what
// hangs off you, and each one's tier (shared/gear.ts tierOf).
import { EQUIP_SLOTS, equipped, tierOf, type EquipSlot } from './gear.ts';
import type { Slots } from './items.ts';

/** What others need to draw your gear's tier (PlayerSnap.tiers): 2 bits each, in TIER_SLOTS order: the item in hand,
 *  each equipment slot (EQUIP_SLOTS), and the carried canteen and sidearm (the best one in the bag). */
export const TIER_SLOTS = ['hand', ...EQUIP_SLOTS, 'canteen', 'laser_pistol'] as const;
export type TierSlot = (typeof TIER_SLOTS)[number];
export function gearTiers(equip: Slots | undefined, bag: Slots | undefined, held: number): number {
  const t: Partial<Record<TierSlot, number>> = { hand: held >= 0 ? tierOf(bag?.[held]) : 0 };
  EQUIP_SLOTS.forEach((s, i) => (t[s] = tierOf(equip?.[i])));
  bag?.forEach((it, i) => {
    if (i !== held && (it?.kind === 'canteen' || it?.kind === 'laser_pistol')) t[it.kind] = Math.max(t[it.kind] ?? 0, tierOf(it));
  });
  return TIER_SLOTS.reduce((bits, s, i) => bits | ((t[s] ?? 0) << (2 * i)), 0);
}
/** One slot's tier out of gearTiers' bits. */
export const tierIn = (tiers: number | undefined, s: TierSlot) => ((tiers ?? 0) >> (2 * TIER_SLOTS.indexOf(s))) & 3;

/** The repaired gear equipped, as bits (wornBit): what others see worn. */
export function wornGear(equip: Slots | undefined): number {
  let bits = 0;
  for (const s of EQUIP_SLOTS) if (equipped(equip, s)) bits |= wornBit(s);
  return bits;
}

/** An equipment slot's bit in wornGear (by EQUIP_SLOTS index: back 1, wrist 2, belt 4, vehicle 8, armor 16). */
export const wornBit = (slot: EquipSlot) => 1 << EQUIP_SLOTS.indexOf(slot);

/** Things drawn on the body while in the bag (not in hand): the scrap plate on the backpack, the canteen
 *  and sidearm on the belt. Their bits follow the worn ones (carriedBit). */
export const CARRIED = ['scrap', 'canteen', 'laser_pistol'] as const;
export const carriedBit = (kind: (typeof CARRIED)[number]) => 1 << (EQUIP_SLOTS.length + CARRIED.indexOf(kind));

/** The CARRIED kinds in the bag outside the hand (`held`: the selected hotbar slot, -1 for none), as bits. */
export function carriedGear(bag: Slots | undefined, held: number): number {
  let bits = 0;
  bag?.forEach((it, i) => {
    const k = CARRIED.indexOf(it?.kind as (typeof CARRIED)[number]);
    if (k >= 0 && i !== held) bits |= 1 << (EQUIP_SLOTS.length + k);
  });
  return bits;
}

