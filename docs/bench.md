# Benchmarks (`tools/bench`)

What CI measures at every push to `main` that touches the game, and how it tells a change from noise. For measuring
the rendering on your own machine with a real graphics card, see `docs/perf.md` (`npm run perf`); this is the
automatic, every-commit kind.

## Running it

- `npm run bench -- --base origin/main`: every suite at this tree and at `origin/main` (a temporary git worktree of
  it, these benchmarks copied in, your `node_modules` linked), in turns, then the report. A few minutes for the Node
  suites; the client suite adds about 6 min (it builds both trees and needs Chrome).
- `npm run bench -- --suites worldgen,physics`: only some suites (`worldgen`, `physics`, `ai`, `server`, `client`);
  without `--base` both sides are this tree, so every "change" in the report is the noise.
- `--rounds n` runs each side n times (defaults: 7 for the Node cases, 3 for the server, 2 for the client, after one client
  run thrown away: the first Chrome on a fresh CI runner starts a second slower).
- One suite by hand: `node tools/bench/case.ts worldgen|physics|ai`, `node tools/bench/server.ts [dir] [--types]`,
  `node tools/bench/client.ts [dir]` (after `npx vite build`). Each prints its numbers as one JSON line.

CI (`.github/workflows/bench.yml`) installs and builds the pushed commit and the one before, runs
`tools/bench/cli.ts ab ../base --suites auto` (only the suites the changed files can move: `shared/` moves everything,
`server/` the AI and the server, `src/`, `public/` and the packages the client) and puts the report in the run's
summary. Changes it flags go to Discord (`BENCH_DISCORD_WEBHOOK`, else the economy simulator's webhook). It only
reports: it never blocks a deploy.

## What's measured

All of it runs in the bench world (`bench0001`: its id is its seed, so the desert is the same on both commits), with
`Math.random` seeded where the game's code runs in Node (both commits roll the same dice).

- **worldgen** (`cases/worldgen.ts`): loading the layout modules; the heightfield over the core (10 m grid) and round
  the spawn (2 m, a terrain chunk's detail); normals; biomes; every crash site, shelter, wreck and scrap pile in the
  core, all cold. Plus the counts of sites and scrap pieces, and a checksum of the layout.
- **physics** (`cases/physics.ts`): `shared/sim.ts step` for a minute of scripted walking (forward, a weave, jumps,
  slides, crouching) where new players start (the ship's ramp), by the world's origin, by a scrap field, at a shelter and on open dunes, and a minute on the
  motorcycle, each the fastest of three goes. The checksum of where they all ended up changes when the physics does
  something else (old clients would then mispredict against the server).
- **ai** (`cases/ai.ts`): a simulated minute of night with four players about, everything summoned on them (crawlers,
  a guardian, drones, all four bosses, a harvester, a storm, a jet), ticked as `server/world.ts` ticks it, and what each
  player is sent about it built and serialized. Deterministic: the checksum of how the fight went changes only when
  the AI does something else.
- **server** (`server.ts`): the real `server/world.ts` (fresh database, `serverHook.ts` preloaded with `node --import`:
  seeded dice and every `setInterval` timed, so the game's code is measured unchanged) with eight bot players at the
  dev spawns sending input at 60 Hz. Three seconds in, one makes it midnight and they summon everything; four seconds
  later 30 s are measured: CPU per second, how busy the event loop is, the 60 Hz loop (mean, p99, max), memory, and
  what each player is sent (KB/s, messages/s). `--types` breaks the sending down by message type.
- **client** (`client.ts`): the production build served by that tree's own server, `tools/perf.ts --software` in
  headless Chrome (no graphics card: WebGL2 by SwiftShader on the CPU), low settings at 480×300, a 15 s spin on the
  spot beside a scrap field at 9:36 (the same views every run). The startup timeline (renderer ready, joined, models
  in, loaded, playable, long tasks), the game's CPU time per frame (the median: at ~40 frames a p90 is a few stalls) and its render submission, draws and
  triangles, and the software rasterizer's time per frame (a rough measure of what a frame asks of a graphics card:
  it grows with triangles and pixels). Real GPU numbers need a real GPU: `npm run perf`.

## Telling a change from noise

Times can't be kept from one machine to the next, so the base is measured again every time, on the same runner, in
turns (base, head, head, base, ...), each run a fresh process. For every number the report gives both medians, the
change, and a 95 % bootstrap interval for it (each side's runs resampled). It flags (🔺 worse, 🟢 better):

- a time that moved by at least its suite's threshold (10 % for the Node cases, 15 % for the server and the client)
  with its interval clear of no change, and at least 0.05 ms;
- a count (draws, triangles, sites, scrap pieces) that moved by 2 % or more;
- a changed checksum (↺): the code does something else now, not only at another speed.

Measured A/A (this tree against itself): the Node cases agree within a few %, the server within about 5 % (its tick
maximum and p99 wobble more, ±15 %), the client within 3 % (draws and triangles exactly).

A suite that fails at the base (a benchmark newer than the code it measures, say) is reported and left out; one
that fails at the pushed commit is reported as a failure.

## Adding a measurement

A new number in an existing case: add it to the case's `m` (value and unit: `ms`, `µs`, `KB/s`, ... for times and
rates, `''` or `k` for counts, which are held to the 2 % rule). Lower is better for every number. A new case: a file
in `tools/bench/cases/` exporting `run(): Promise<Sample>`, then its name in `SUITES` (`stats.ts`), `SUITE_ROUNDS` and
`SUITE_PATHS` (`cli.ts`). Cases import the game by relative path (`../../../shared/...`) and get the base tree's code
when they run there; a renamed export makes the case fail at the base, which is reported, not fatal.
