// Bosses: the desert's biggest machines, one of a kind each, seldom seen. Server-simulated (server/bosses.ts, one
// brain per kind in server/<kind>.ts), sent to players near them ~10 times a second ('bosses', shared/protocol.ts)
// and drawn by src/bosses.ts (one view per kind in src/world/<kind>.ts).
//
// Every boss is fought the same way for now: it carries glowing weak points (BOSSES[kind].points); a rifle or pistol
// hit breaks one (the shooter's client finds the hit against what it draws, the server checks the shot ended near the
// boss), and once every one is broken it dies and drops parts (shared/tables.ts BOSS_SPOILS). What it does to you and
// to the sand is its own: the worm swallows, the colossus stomps, the carrier bombs, the queen tramples, and all of
// them leave marks in the sand (server/terrain.ts craters, which the wind fills in again).
//
// They don't turn up by themselves: something has to call them (the debug menu, F3, brings one to you). Each kind's
// first death is kept in the world (`beaten`, server/world.ts) and gives the world BOSS_LIVES more lives; with every
// kind beaten the world is won (src/landing.ts victory), and play goes on.

/** The boss kinds, in the order of their debug menu buttons. */
export const BOSS_KINDS = ['worm', 'carrier', 'colossus', 'queen'] as const;
export type BossKind = (typeof BOSS_KINDS)[number];

/** Per kind: weak points to break, how long the wreck lies (s), and the debug button's label. */
export const BOSSES: Record<BossKind, { points: number; wreckS: number; label: string }> = {
  worm: { points: 6, wreckS: 240, label: 'Worm' },
  carrier: { points: 4, wreckS: 240, label: 'Carrier' },
  colossus: { points: 5, wreckS: 300, label: 'Colossus' },
  queen: { points: 6, wreckS: 240, label: 'Queen' },
};

/**
 * One boss in a 'bosses' message. (x, y, z): its centre of interest (the worm's head, the carrier's hull, the
 * colossus's hips, the queen's body), yaw (three.js: forward = (sin, cos)). br: weak points broken (bit i: point
 * i). dead: 0 alive, else seconds since it died + 0.01. s: the kind's own numbers (its brain's `snap`, its view
 * reads them; interpolated element by element between messages unless the view says otherwise).
 */
export type BossSnap = { id: number; k: BossKind; x: number; y: number; z: number; yaw: number; br: number; dead: number; s: number[] };

/** Players get bosses within this distance (m). */
export const BOSS_SEND_R = 3000;

/** All of a boss's weak points broken? */
export const bossDown = (kind: BossKind, broken: number) => broken === (1 << BOSSES[kind].points) - 1;

/** Lives a world gets for each kind's first kill. */
export const BOSS_LIVES = 10;

/** Bit of `kind` in a `beaten` mask (the 'lives' message, the world's 'bosses_beaten' setting). */
export const bossBit = (kind: BossKind) => 1 << BOSS_KINDS.indexOf(kind);

/** Every kind beaten: the world is won. */
export const allBeaten = (beaten: number) => beaten === (1 << BOSS_KINDS.length) - 1;

/** Kinds beaten in a mask. */
export const beatenCount = (beaten: number) => BOSS_KINDS.filter((k) => beaten & bossBit(k)).length;
