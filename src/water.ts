// STUB: owned by the water-mechanic work; replaced on merge. The viewmodel (src/viewmodel.ts) only reads
// `playerHands` to pick its clips.
export type Held = 'none' | 'canteen';

/** What the local player's hands are doing (read by the first-person viewmodel). */
export const playerHands: { held: Held; drinking: boolean; filling: boolean } = {
  held: 'none',
  drinking: false,
  filling: false,
};
