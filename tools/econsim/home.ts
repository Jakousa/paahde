// Where the simulated player lives. This simulator also runs against older commits (cli.ts --base), so what those may not
// have is looked up, not imported:
// - ORIGIN: the world's origin (shared/origin.ts), where the layout is measured from; in a commit from before there was
//   one, the starting bunker's spot (shared/base.ts BASE), the same point.
// - BUNKER: the commit still has the starting bunker (shared/base.ts): home is the bunker (its workbench, table, chests
//   and pump stand there, and the dead wake up in it).
// - HOME: without the bunker, the agent settles by the crashed pods (SPAWN: where new players and the dead without a
//   bedroll appear, shared/sim.ts spawnPoint, by a pod's hatch and its water tap), building its workbench, chest and
//   dismantling bench there; in a commit with a shelter with a pump near where players arrive (shared/shelters.ts
//   homeShelter, the crashed ship's), by that shelter's door.
type Point = { x: number; z: number };
type Spot = Point & { y: number };
const b = (await import('../../shared/base.ts' as string).catch(() => null)) as { BASE?: Spot } | null;
const o = (await import('../../shared/origin.ts' as string).catch(() => null)) as { ORIGIN: Spot } | null;
export const BUNKER = !!b;
export const ORIGIN: Spot = o?.ORIGIN ?? b!.BASE!;

const shelters = (await import('../../shared/shelters.ts')) as { homeShelter?: () => { x: number; z: number; dx: number; dz: number } | null };
const sim = (await import('../../shared/sim.ts')) as { spawnPoint?: () => Point };
const spawn = sim.spawnPoint?.() ?? null;
const shelter = shelters.homeShelter?.() ?? null;
export const SPAWN: Point = BUNKER || !spawn ? ORIGIN : spawn;
export const HOME: Point = BUNKER ? ORIGIN : shelter ? { x: shelter.x + shelter.dx * 4, z: shelter.z + shelter.dz * 4 } : SPAWN;
