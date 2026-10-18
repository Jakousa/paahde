// Bosses: the desert's biggest machines, one of a kind each, seldom seen. Server-simulated (server/bosses.ts, one
// brain per kind in server/<kind>.ts), sent to players near them ~10 times a second ('bosses', shared/protocol.ts)
// and drawn by src/bosses.ts (one view per kind in src/world/<kind>.ts).
//
// Every boss is fought the same way for now: it carries glowing weak points (BOSSES[kind].points); a rifle or pistol
// hit on one (the shooter's client finds the hit against what it draws, the server checks the shot ended near the
// boss) breaks it and takes a hit off the boss's health (BOSSES[kind].hp, the HUD's bar: src/bossBar.ts). A broken
// point regrows after REGROW_MS, so it can't be shot again at once: the fight goes round the points. At 0 health it
// dies and drops parts (shared/tables.ts BOSS_SPOILS). What it does to you and
// to the sand is its own: the worm swallows, the colossus stomps, the carrier bombs, the queen tramples, and all of
// them leave marks in the sand (server/terrain.ts craters, which the wind fills in again).
//
// They don't turn up by themselves: a receiver calls them (RECEIVERS: gear found broken, repaired with a uranium cell
// and the boss's own part, shared/gear.ts). Used, it spends the cell, the boss turns up some way off (server/bosses.ts
// call) and stays until it's killed, across restarts ('called' in the world's settings); the receiver's needle points
// to it (src/receiver.ts). The worm's receiver takes the part each of the other three leaves (RELICS), so it comes last.
// The debug menu (F3) brings one to you for a while.
// Each kind's first death is kept in the world (`beaten`, server/world.ts), gives the world BOSS_LIVES more lives and
// puts its trophy up at the base (src/world/trophies.ts); with every kind beaten the world is won (src/landing.ts
// victory), and play goes on.

/** The boss kinds, in the order of their debug menu buttons. */
export const BOSS_KINDS = ['worm', 'carrier', 'colossus', 'queen'] as const;
export type BossKind = (typeof BOSS_KINDS)[number];

/** Per kind: weak points, health (weak-point hits to kill it), how long the wreck lies (s), and its name (the health
 *  bar, the debug button). */
export const BOSSES: Record<BossKind, { points: number; hp: number; wreckS: number; label: string }> = {
  worm: { points: 6, hp: 18, wreckS: 240, label: 'Worm' },
  carrier: { points: 4, hp: 16, wreckS: 240, label: 'Carrier' },
  colossus: { points: 5, hp: 15, wreckS: 300, label: 'Colossus' },
  queen: { points: 6, hp: 22, wreckS: 240, label: 'Queen' },
};

/** A broken weak point grows back after this long (ms). */
export const REGROW_MS = 20_000;
/** A shot at one of a boss's minions (the carrier's gun drones, the queen's spiderlings) names it as weak point
 *  MINION + its id (slot): they die to one hit and leave the boss's health alone. */
export const MINION = 32;

/**
 * One boss in a 'bosses' message. (x, y, z): its centre of interest (the worm's head, the carrier's hull, the
 * colossus's hips, the queen's body), yaw (three.js: forward = (sin, cos)). br: weak points broken now (bit i: point
 * i; they regrow). hp: health left, 0..1. dead: 0 alive, else seconds since it died + 0.01. s: the kind's own numbers (its brain's `snap`, its view
 * reads them; interpolated element by element between messages unless the view says otherwise). f: 1 when it's in a
 * fight with the player the message is for (it turned on them, or they shot it, lately): only then their health bar.
 */
export type BossSnap = { id: number; k: BossKind; x: number; y: number; z: number; yaw: number; br: number; hp: number; dead: number; s: number[]; f?: 1 };

/** Players get bosses within this distance (m). */
export const BOSS_SEND_R = 3000;

/** Every weak point of `kind` broken (the mask a dead boss shows). */
export const allPoints = (kind: BossKind) => (1 << BOSSES[kind].points) - 1;

/** Lives a world gets for each kind's first kill. */
export const BOSS_LIVES = 10;

/** Bit of `kind` in a `beaten` mask (the 'lives' message, the world's 'bosses_beaten' setting). */
export const bossBit = (kind: BossKind) => 1 << BOSS_KINDS.indexOf(kind);

/** Every kind beaten: the world is won. */
export const allBeaten = (beaten: number) => beaten === (1 << BOSS_KINDS.length) - 1;

/** Kinds beaten in a mask. */
export const beatenCount = (beaten: number) => BOSS_KINDS.filter((k) => beaten & bossBit(k)).length;

/** The receiver (gear item kind) that calls each kind. */
export const RECEIVERS: Record<BossKind, string> = {
  worm: 'receiver_worm', carrier: 'receiver_carrier', colossus: 'receiver_colossus', queen: 'receiver_queen',
};
/** The boss a receiver calls, or null if `kind` isn't one. */
export const receiverBoss = (kind: string | undefined): BossKind | null =>
  BOSS_KINDS.find((k) => RECEIVERS[k] === kind) ?? null;

/** The one-of-a-kind part each kind leaves on its wreck (an item kind; the worm's receiver takes all three). */
export const RELICS: Partial<Record<BossKind, string>> = { carrier: 'hive_core', queen: 'queen_eye', colossus: 'furnace_heart' };
