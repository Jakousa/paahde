// One simulated world, in a process of its own (the world's seed is read from WORLD_ID when shared/ is first imported,
// shared/world.ts): `WORLD_ID=sim0001 node tools/econsim/run.ts <seed>` prints its RunResult as one line of JSON.
// tools/econsim/cli.ts starts these by the hundred.
import { Sim } from './sim.ts';

const seed = Number(process.argv[2] ?? 1);
const world = process.env.WORLD_ID ?? '';
if (!world) throw new Error('set WORLD_ID');
const t0 = performance.now();
const out = new Sim(world, seed).run();
process.stdout.write(JSON.stringify({ ...out, seed, ms: Math.round(performance.now() - t0) }) + '\n');
