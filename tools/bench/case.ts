// One benchmark case in a process of its own (docs/bench.md): cold module caches and a fresh JIT, like a world process
// starting. The world is always BENCH_WORLD_ID (its seed fixes the layout) and Math.random is seeded, so both commits of
// a comparison do the same work. Prints one JSON line: { m: { name: [value, unit] }, info: { name: text } }.
//
//   node tools/bench/case.ts worldgen|physics|ai
import { BENCH_WORLD_ID, seedRandom } from './common.ts';

process.env.WORLD_ID = BENCH_WORLD_ID; // (before the game's modules load: shared/world.ts reads it once)
seedRandom(1);
const name = process.argv[2];
const { run } = (await import(`./cases/${name}.ts`)) as { run: () => Promise<import('./common.ts').Sample> };
process.stdout.write(JSON.stringify(await run()) + '\n');
