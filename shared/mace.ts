// The scrap mace: a two-handed club of scrap ~1.55 m long, made by hand (shared/tables.ts HAND_TABLE), for when there's
// no gun. Swung with the use button (src/mace.ts) in a wide stroke from the right shoulder across to the left (the hands'
// MaceSwing, tools/models/hands.py): the blow lands MACE_STRIKE_MS after the press, on whatever is in front of the eye
// within MACE_REACH, anywhere across the stroke. A crawler (shared/guardians.ts) it lands on loses one of its two flank lenses (shared/rifle.ts weakPoints),
// so two blows kill one; on a guardian it only clangs off a leg and angers it. The server checks the mace is in hand,
// the rate, and that the walker is within reach of the swinger (server/world.ts onSwing).
export const MACE = 'scrap_mace';
/** At most one swing every MACE_MS: the whole stroke (MaceSwing is 0.9 s). */
export const MACE_MS = 950;
/** From the press to the blow landing (ms): MaceSwing's wind-up, to its MC_STRIKE key (tools/models/hands.py). */
export const MACE_STRIKE_MS = 450;
/** How far from the eye (m) a blow lands: the arms and the shaft. */
export const MACE_REACH = 3;
/** The server takes a blow on a walker this much further off (m, horizontally from the swinger's feet) than MACE_REACH:
 *  a crawler runs 9.5 m/s and is drawn some way in the past on the swinger's screen. */
export const MACE_SLACK = 3;
