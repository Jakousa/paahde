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

export const WORLD_ID = readWorldId();
export const WORLD_SEED = seedFor(WORLD_ID);
