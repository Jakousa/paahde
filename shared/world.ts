// Which world this is. Every world is its own game at its own URL (?w=<id>), with its own seed, players and
// lives; the server runs each in a process of its own (server/index.ts forks server/world.ts with WORLD_ID),
// the client reads it from the page's URL. Read once when the modules load: the layouts seeded from it
// (dunes, rocks, scrap, wrecks, crash sites, shelters, the base) are worked out at import time.

/** World ids: what the landing page makes (newWorldId) and the URL carries. */
export const WORLD_ID_RE = /^[a-z0-9]{4,16}$/;
/** The world from before there were worlds: its old database and seed. */
export const LEGACY_WORLD = 'main';
const LEGACY_SEED = 1017;
/** Shared deaths per world: the game ends when they're gone. */
export const LIVES = 10;

function readWorldId(): string {
  const env = typeof process !== 'undefined' ? process.env?.WORLD_ID : undefined;
  if (env) return env;
  if (typeof location !== 'undefined') return new URLSearchParams(location.search).get('w') ?? '';
  return '';
}

/** The seed a world id stands for: the id is random, so the seed is too. */
export function seedFor(id: string): number {
  if (id === LEGACY_WORLD) return LEGACY_SEED;
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return (h >>> 0) % 1_000_000;
}

export function newWorldId(): string {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = '';
  for (const b of bytes) s += abc[b % abc.length];
  return s;
}

/**
 * The dev test lab (shared/lab.ts): the world with this id, in development only. The dev server (npm run dev) starts
 * with `--lab`, which sets DADAJAM_LAB for the world processes; the browser asks Vite's dev flag. The production
 * server and `npm start` have neither, so the id is just an unknown world there.
 */
export const LAB_WORLD = 'lab';
export function labAllowed(): boolean {
  if (typeof process !== 'undefined' && process.env) return process.env.DADAJAM_LAB === '1';
  return !!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
}

/** The art-style bench (src/artBench.ts): the world with this id, in development only (like the lab): the real desert from a
 *  fixed seed, without weather, walkers, jets or heat, seen from a list of fixed camera shots while the look is tuned. */
export const BENCH_WORLD = 'bench';

export const WORLD_ID = readWorldId();
/** This world is the dev test lab: flat floor, no desert and no events, every machine and part laid out (shared/lab.ts). */
export const LAB = WORLD_ID === LAB_WORLD && labAllowed();
/** This world is the art-style bench (BENCH_WORLD). */
export const BENCH = WORLD_ID === BENCH_WORLD && labAllowed();
/** A dev world with nothing happening in it: no heat, weather, jets, walkers, drones or bosses (the lab, the bench). */
export const CALM = LAB || BENCH;
export const WORLD_SEED = seedFor(WORLD_ID);
