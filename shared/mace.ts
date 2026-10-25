// The scrap mace: a club of scrap made by hand (shared/tables.ts HAND_TABLE), for when there's no gun. Swung with the
// use button (src/mace.ts): a blow lands MACE_STRIKE_MS after the press, on whatever is in front of the eye within
// MACE_REACH. A crawler (shared/guardians.ts) it lands on loses one of its two flank lenses (shared/rifle.ts weakPoints),
// so two blows kill one; on a guardian it only clangs off a leg and angers it. The server checks the mace is in hand,
// the rate, and that the walker is within reach of the swinger (server/world.ts onSwing).
export const MACE = 'scrap_mace';
/** At most one swing every MACE_MS. */
export const MACE_MS = 650;
/** From the press to the blow landing (ms): the swing's wind-up (src/viewmodel.ts). */
export const MACE_STRIKE_MS = 190;
/** How far from the eye (m) a blow lands. */
export const MACE_REACH = 2.4;
/** The server takes a blow on a walker this much further off (m, horizontally from the swinger's feet) than MACE_REACH:
 *  a crawler runs 9.5 m/s and is drawn some way in the past on the swinger's screen. */
export const MACE_SLACK = 3;
