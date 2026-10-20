# Performance measuring

Three tools, from quick to thorough. Numbers from the first runs are in the devlog of whoever changes performance next; write new ones down.

## 1. Stats overlay (Esc → Options → Gameplay → Show stats)
Frame-time bars, draw calls, triangles, **cpu ms** (our frame callback, render submission included) and **gpu ms** (WebGPU timestamp queries, the render
passes summed). The larger of the two is what the frame is bound by. GPU queries are only set up when stats were already on at page load (or for a
benchmark run), so tick the box and reload. Caveat: the shadow cascade passes may not be in the gpu number (turning shadows off moved it by 0.1 ms
while cpu fell from 12 to 4 ms): trust the cpu line and the trace for shadows. `src/perf.ts` also writes the same numbers as User Timing, which Chrome's
Performance panel shows as a "dadajam" track (CPU and GPU per frame, startup milestones as markers) in any trace you record by hand.

## 2. Automated run: `npm run perf` (`tools/perf.ts`)
`npm run dev` first. Then `npm run perf -- --seconds 30` opens a real Chrome (GPU on, precise GPU timestamps), makes a world, waits until the game is
**playable** (loaded, shaders warm, cover gone, name box answered), settles 3 s, walks a fixed route (forward, slow turn, sprint every other 10 s) for the
asked seconds and writes `data/perf/<time>[-label].json` (frame gap, cpu, submit, gpu, draws, triangles, render scale as mean/p50/p90/p99/max; fps, 1 % low,
frames over 20 / 50 ms; startup milestones and long tasks; the graphics settings and machine) plus a Chrome trace of the same stretch
(`.trace.json.gz`, read with `python tools/trace-report.py`). Options: `--trace play|startup|none`, `--seconds 0` (startup only), `--set k=v` for any graphics
option (`--set shadows=false --set resScale=0.7`), `--label`, `--world <id>`, `--base <url>`, `--chrome <path>`, `--headless`.
**Outdoor runs**: a new world starts in the bunker, so use `--spawn field|shelter` (the server's dev spawns: beside a scrap field, 6 m outside a shelter door), `--yaw 3.14` to turn round
(the field spawn faces the field, which blocks the walk) and `--tod 0.26` for the time of day the run starts at (0.333 = 8 am, sun 28°; **0.26 = about 6 am, sun 8°, long shadows**; sunrise is
~5:30 and sunset ~18:30 here, so 5 am or 10 pm are dark). The clock then runs on (a day is 30 min). The walk is a very wide circle (about 100 m radius), 140-200 m in 30 s, with a sprint every
other ten seconds. `--spawn crash` is beside a crash site's machine and its crawlers kill the player: use it to see what a death looks like in the data, not for numbers.

**Dying, and other runs that are not a walk, are part of the data, not noise.** The JSON has `valid` and `invalidReasons` at the top, and `gameplay.events` (`died` / `respawned`, with seconds into the walk,
position and heat), `gameplay.travelledM`, `framesExcluded`. The trace has a red `player died` / `player respawned` marker on the dadajam track. A run is invalid when the player died, barely moved
(blocked by a pile or a dune face: under 1.5 m/s), or ended early; `tools/perf.ts` prints `!! INVALID RUN` with the reasons, names the files `...-INVALID.json` and exits with code 2.
By default a death ends the run (the numbers after it would be a ragdoll's, then the bunker's); `--allow-death` keeps walking and leaves the frames while down, and the next second after the respawn,
out of the numbers (they are counted in `framesExcluded`; the run stays marked invalid so it is never mistaken for a clean one).
**Size matters for the GPU**: the game draws one pixel per CSS pixel, so the default 1280x800 window hides a GPU limit. `--size 2560x1440` (or your screen's size) sets the viewport. The JSON's `gpuPasses` and the
runner's "gpu ms per frame by render pass" split the GPU time by render pass (context id): the scene pass is the big one, the others (shadow cascades, post) small.
First numbers (field spawn, 6 am, fixed resolution): GPU ms p50 2.4 / 4.5 / 7.9 at 1280x800 / 1920x1080 / 2560x1440 (the scene pass 78 % of it), 142 -> 139 -> 102 fps: GPU-bound from about 1440p.
At 1440p: sun shadows off -1.2 ms, anti-aliasing off -1.3 ms, shadow quality low/medium 0, resolution 75 % -3.2 ms. The cost is the scene pass's per-pixel work, mostly the sand shader.
Example: `npm run perf -- --seconds 30 --spawn field --yaw 3.14 --tod 0.26 --set dynamicRes=false --label morning`.
Compare settings by running the same command with different `--set`s and `--label`s.

## 3. By hand
`?w=<id>&perf=30` in a normal tab runs the same walk and downloads the JSON. `?perf=startup` records only the startup timeline.

## Startup timeline
Milestones (ms since page start): main-start, renderer-ready, joined, models-in, warmup-start, warmed, loaded, cover-gone, playable. First measured run: models in
at 2.0 s, **the shader warm-up took 22 s** (2.1 → 24.4 s), playable at 25.6 s. That is the first thing to look at for start-up time.

## What the first rounds changed (this machine, default settings, same walk)
Before: ~66 fps, cpu 12.4 ms, ~1100 draw calls, 4 shadow cascades redrawn every frame or every other. After: ~130 fps (the screen's limit), cpu 5 ms, ~380 draws.
- **Cached cascades** (`src/world/cascades.ts`): every cascade but the nearest is a world-fixed box round the camera, redrawn only when the camera has moved out of its
  slack, the sun has turned half a texel's worth, or it is `MAX_AGE` old (the Shadow refresh option scales that). Biggest win.
- **Crash sites merged** (`src/world/crashsites.ts`): all wrecks and debris in view are one mesh per material (~7 draws, was ~100 instanced meshes, each drawn again in every cascade).
- **Small casters culled from far cascades** (`src/world/shadowLod.ts`): layer bits by size; cascades 2 and 3 only see casters bigger than ~0.6 texel. Terrain chunks and the merged site meshes are tagged big where made.
- **Render bundles for the terrain** were tried and dropped: processor time fell 15 % but fps fell too (bundles keep every chunk, culling off, so the graphics card draws 3x the
  triangles, and each layout change records them again: 1 % lows 14 → 5 fps).
- `npm run perf -- --shot [--ab shadowRefresh=0]` takes a picture where the walk ends, and a second one with an option changed live; the JSON has a `census` of what is drawn
  (casters by root and material, by size, and what each cascade would draw).

## Sun shadows: dunes from the heightfield (src/world/heightShadow.ts)
The dunes are not in the shadow maps any more. For a grid round the player the GPU finds, per texel, the "shadow ceiling" S (the highest the ray to the
sun has to clear) by doubling: one pass a frame looks 1, 2, 4 ... texels up-sun, so nothing thin is skipped; a point at height y is in the dunes' shadow when
y < S. Edges are the clean contour y = S at any distance, without the stairs a low sun makes of shadow-map texels. Grids: 0.5 m round the player, 4 m and 9 m
out to the terrain's edge (High); fewer and coarser on Low/Medium (graphics.ts SHADOW_QUALITY). The shadow maps keep players, wrecks, the base and bosses, and
can now filter narrowly (1.5-2 texels, was 5-8); the terrain casts into them only near the base and shelters (their rooms are underground, roofed by it).
Things learned on the way (all cost a debugging round): a render target sampled before it is first drawn into breaks every frame with "destroyed texture used in
a submit" (the scene is not drawn at all: clear every target once after renderer.init); three clamps a node material's colour output at 0, so passes that
write negative numbers use `fragmentNode`; 32-bit float targets cannot blend (NoBlending, or the pipeline is never ready and nothing is drawn) and are read
texel by texel (`.load`), not sampled. Spin runs at 1440p (`--route spin --spawn shelter`)
gave the two within run-to-run noise (98-135 fps for the same setting); the gain is the look, and ~100 fewer draw calls where the terrain no longer casts.

Ultra (shadow quality 4th step): 5 cascades of 4096² out to 4.5 km (choosing it sets the shadow distance to the maximum), far cascades keep only big casters
(a downed jet, a boss, the base), dune grid 0.25 m / 1 m / 4.5 m. ~0.6 GB of GPU memory. The packed shadow ceiling gets a small tent filter, which takes the
stair steps off rock outlines. Near the base and the shelters the heightfield is skipped only where a point is in their reach, under their floor *and* under
the drawn ground (dune valleys round the base are lower than its floor: they lost their dune shadows inside 45 m). `npm run perf -- --shot --view 60` lifts the
camera 60 m for the picture (fly camera, no HUD), looking away from the sun: the way to see shadows over a wide stretch.
