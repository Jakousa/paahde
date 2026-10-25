// A player's look: which piece they wear in each slot of the scavenger, and the dyes of its robe, its hood and cape,
// and its wraps. Chosen on the main menu (src/lookView.ts), kept in this browser (src/profile.ts), sent with every join
// ('hello') and to everyone with the player (PlayerSnap.look), drawn by src/models/scavenger.ts setLook. Packed in one
// number, slot by slot (mixed radix, the first slot lowest); 0 is the first choice everywhere: the scavenger as it always looked.
// The pieces are meshes in public/models/scavenger.glb (tools/models/scavenger.py LOOK_MESH).

export type LookSlot = { key: string; options: readonly string[] };

/** The slots and their options, top to bottom of the body. A new option goes at the end of its list (looks saved in
 *  browsers keep their meaning); a new slot at the end of the list. */
export const LOOK_SLOTS = [
  { key: 'hood', options: ['hood', 'cowl', 'ragged'] },
  { key: 'eyes', options: ['goggles', 'monocle', 'round', 'welder', 'big'] },
  { key: 'face', options: ['respirator', 'side', 'none', 'filter', 'muzzle', 'grille'] },
  { key: 'scarf', options: ['scarf', 'long', 'bib', 'veil', 'none'] },
  { key: 'cape', options: ['cape', 'poncho', 'none'] },
  { key: 'shoulder', options: ['none', 'plate'] },
  { key: 'gloves', options: ['leather', 'wrapped', 'gauntlet'] },
  { key: 'boots', options: ['buckled', 'wrapped', 'guard', 'tall'] },
  // the dyes: an index into DYES[key]
  { key: 'robe', options: ['0', '1', '2', '3', '4', '5', '6', '7'] },
  { key: 'cloak', options: ['0', '1', '2', '3', '4', '5', '6', '7'] },
  { key: 'wrap', options: ['0', '1', '2', '3', '4', '5', '6', '7'] },
] as const satisfies readonly LookSlot[];

export type LookKey = (typeof LOOK_SLOTS)[number]['key'];
export type Look = Record<LookKey, number>;

/** The cloth dyes (sRGB): the robe; the hood, cape and poncho; the head wrap, arm and shin wraps and wrapped gloves
 *  and boots. The first of each is the old undyed look. */
export const DYES = {
  robe: [0x9c8a6e, 0xd8cdb6, 0x3d4a6e, 0x5d6140, 0x3b3734, 0xc8a57a, 0x8a3e22, 0x6b6247],
  cloak: [0x6a4430, 0x2b2f42, 0x8a3e22, 0x6e1f1a, 0xb8946a, 0x4a5a3a, 0x3a3633, 0x9a8a70],
  wrap: [0x7d705e, 0xd8cdb6, 0xc8a57a, 0x2d2a28, 0x5a4a3a, 0x6a7698, 0x9c8a6e, 0x4a4035],
} as const satisfies Record<'robe' | 'cloak' | 'wrap', readonly number[]>;

/** One past the largest look. */
export const LOOK_END = LOOK_SLOTS.reduce((n, s) => n * s.options.length, 1);

export function packLook(look: Look): number {
  let n = 0;
  for (let i = LOOK_SLOTS.length - 1; i >= 0; i--) {
    const s = LOOK_SLOTS[i];
    const v = look[s.key];
    n = n * s.options.length + (Number.isInteger(v) && v >= 0 && v < s.options.length ? v : 0);
  }
  return n;
}

export function unpackLook(n: number): Look {
  const look = {} as Look;
  let rest = isLook(n) ? n : 0;
  for (const s of LOOK_SLOTS) {
    look[s.key] = rest % s.options.length;
    rest = Math.floor(rest / s.options.length);
  }
  return look;
}

export const isLook = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < LOOK_END;

/** The option chosen in a slot, by name ('hood', 'cowl', ...). */
export const lookOption = <K extends LookKey>(look: Look, key: K) =>
  LOOK_SLOTS.find((s) => s.key === key)!.options[look[key]];
