// A player's look: which piece they wear in each slot of the scavenger, and the dyes of its robe, its hood and cape,
// and its wraps. Chosen on the main menu (src/lookView.ts), kept in this browser (src/profile.ts), sent with every join
// ('hello') and to everyone with the player (PlayerSnap.look), drawn by src/models/scavenger.ts setLook. Packed in one
// number, slot by slot (mixed radix, the first slot lowest); 0 is the first choice everywhere: the scavenger as it always looked.
// The pieces are meshes in public/models/scavenger.glb (tools/models/scavenger.py LOOK_MESH).

export type LookSlot = { key: string; options: readonly string[] };

/** The cloth dyes (sRGB), one palette in one order for the robe; the hood, cape and poncho; and the head wrap, arm and
 *  shin wraps and wrapped gloves and boots. Light to dark, then the colours. */
export const DYE_COLORS = [
  0xd8cdb6, 0xc8a57a, 0x9c8a6e, 0x7d705e, 0x6a4430, 0x5a4a3a, 0x3b3734, 0x8a3e22, 0x6e1f1a, 0x5d6140, 0x4a5a3a, 0x6a7698,
  0x3d4a6e, 0x2b2f42,
] as const;
/** Each dyed slot's old colour (its place in DYE_COLORS): what a look's 0 there means. */
const DYE_FIRST = { robe: 2, cloak: 4, wrap: 3 } as const;
export type DyeSlot = keyof typeof DYE_FIRST;
const DYE_OPTIONS = DYE_COLORS.map((_, i) => String(i));

/** The place in DYE_COLORS of the dye chosen in `slot`, and the choice that puts it there. */
export const dyeIndex = (look: Look, slot: DyeSlot) => (look[slot] + DYE_FIRST[slot]) % DYE_COLORS.length;
export const dyeChoice = (slot: DyeSlot, index: number) => (index - DYE_FIRST[slot] + DYE_COLORS.length) % DYE_COLORS.length;

/** The slots and their options, top to bottom of the body. A new option goes at the end of its list (looks saved in
 *  browsers keep their meaning); a new slot at the end of the list. */
export const LOOK_SLOTS = [
  { key: 'hood', options: ['hood', 'cowl', 'ragged', 'shroud'] },
  { key: 'eyes', options: ['goggles', 'monocle', 'round', 'welder', 'big'] },
  { key: 'face', options: ['respirator', 'side', 'none', 'filter', 'muzzle', 'grille', 'bandages'] },
  { key: 'scarf', options: ['scarf', 'long', 'bib', 'veil', 'none'] },
  { key: 'cape', options: ['cape', 'poncho', 'none', 'mantle'] },
  { key: 'shoulder', options: ['none', 'plate'] },
  { key: 'gloves', options: ['leather', 'wrapped', 'gauntlet'] },
  { key: 'boots', options: ['buckled', 'wrapped', 'guard', 'tall'] },
  // the dyes: one palette for all three (DYE_COLORS), each slot's 0 its old colour (dyeIndex)
  { key: 'robe', options: DYE_OPTIONS },
  { key: 'cloak', options: DYE_OPTIONS },
  { key: 'wrap', options: DYE_OPTIONS },
  // over the robe (docs/character.md)
  { key: 'rags', options: ['none', 'rags'] },
  { key: 'stole', options: ['none', 'stole'] },
  { key: 'belt', options: ['none', 'rope'] },
  { key: 'satchel', options: ['none', 'satchel'] },
  // the body (BODIES): drawn only, the player moves and collides the same in any body.
  { key: 'body', options: ['human', 'dwarf', 'gnome'] },
] as const satisfies readonly LookSlot[];

/** Each body's proportions, scales of the scavenger (a 1.85 m human, legs about half of that): `size` the whole
 *  figure about the feet, `legs` the legs' length from the hips (the body drops to keep the feet on the ground),
 *  `chest` the chest (the arms not scaled with it), `neck` the neck and all on it, and `head` the head (from the neck
 *  up, the neck's scale included). The hood hangs from both neck and head and the face pieces from the head alone, so
 *  the two stay close or the goggles and masks poke out of the hood. The build, without touching the skeleton's
 *  lengths: `wide` and `deep` the trunk's girth (side to side, front to back), `limbs` the arms' and legs' thickness,
 *  `hands` and `feet` their size, and `hips` and `shoulders` how far apart the legs and arms are set (the legs not too
 *  far: the robe's hem hangs from both and parts between them like trousers).
 *  A dwarf about 1.35 m and nearly as wide as tall: a barrel of a trunk, thick limbs on wide-set joints, big hands and
 *  boots, short legs, a big head. A gnome about 1 m: the head nearly a quarter of it, big hands and boots on a small
 *  slight body. */
const BODIES = [
  { size: 1, legs: 1, chest: 1, neck: 1, head: 1, wide: 1, deep: 1, limbs: 1, hands: 1, feet: 1, hips: 1, shoulders: 1 },
  { size: 0.85, legs: 0.72, chest: 1.1, neck: 1.25, head: 1.38, wide: 1.6, deep: 1.4, limbs: 1.5, hands: 1.4, feet: 1.35, hips: 1.3, shoulders: 1.7 },
  { size: 0.6, legs: 0.82, chest: 1, neck: 1.5, head: 1.65, wide: 1.1, deep: 1.1, limbs: 0.95, hands: 1.65, feet: 1.6, hips: 1.15, shoulders: 1.1 },
] as const;
/** The bare legs' share of the height. */
const LEG_SHARE = 0.51;

export type LookKey = (typeof LOOK_SLOTS)[number]['key'];
export type Look = Record<LookKey, number>;

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

export type BodyScale = (typeof BODIES)[number] & {
  /** The figure's drawn height and its stride's length, relative to the human's. */
  height: number;
  stride: number;
};

/** The body's drawn proportions (BODIES). */
export function bodyScale(look: Look): BodyScale {
  const b = BODIES[look.body] ?? BODIES[0];
  return { ...b, height: b.size * (1 - LEG_SHARE + LEG_SHARE * b.legs), stride: b.size * b.legs };
}

/** The option chosen in a slot, by name ('hood', 'cowl', ...). */
export const lookOption = <K extends LookKey>(look: Look, key: K) =>
  LOOK_SLOTS.find((s) => s.key === key)!.options[look[key]];
