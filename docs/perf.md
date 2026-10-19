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
Compare settings by running the same command with different `--set`s and `--label`s.

## 3. By hand
`?w=<id>&perf=30` in a normal tab runs the same walk and downloads the JSON. `?perf=startup` records only the startup timeline.

## Startup timeline
Milestones (ms since page start): main-start, renderer-ready, joined, models-in, warmup-start, warmed, loaded, cover-gone, playable. First measured run: models in
at 2.0 s, **the shader warm-up took 22 s** (2.1 → 24.4 s), playable at 25.6 s. That is the first thing to look at for start-up time.
