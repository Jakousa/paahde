# Review implementation — 25 October 2026

The approved review work was implemented directly on `main`, in focused commits with production builds before
pushes. Three parallel agents handled gameplay/UI/audio, rendering, and server/networking; integration and
cross-reviews caught additional recovery, warmup, audio-budget and backup-path defects.

Review items **3, 30, 31, 32, 34 and 35 were excluded** as requested. Other collaborators continued working on
the repository during this implementation; their health, crawler, character and placement changes are separate.

## Changes by original review item

| Items | Implemented behavior |
| --- | --- |
| 1–2 | Runtime message validation, malformed-peer isolation, loading-state restrictions and authoritative dismantling prerequisites. |
| 4–5 | Frame-rate-independent bolt gestures and correct radians for pushing machines. |
| 6 | Immediate danger speech, bounded/contextual discovery queue, and earlier audible worm warnings. |
| 7 | Bounded world startup/admission, never-joined process expiry, stored-world quota and bounded lobby queries; existing saves are retained. |
| 8 | Behavioral regression checks in CI/build workflow, including live multiplayer, migration, prediction/input and teardown invariants. |
| 9 | Economy simulation follows live salvage rewards and settles boss rewards before scheduling another expedition. No loot/recipe rebalance. |
| 10–12 | Inactive headlight shader work is skipped; Low/Medium sand paths do less work; selective cascade filtering is available for measured experiments. |
| 13–16 | Bounded startup diagnostics, hidden held-tool prewarming, validated GPU timestamps, shadow-map release, and accessible recovery after graphics loss. |
| 17–18 | Depth-aware AO filtering and bounded darkening; roughness-aware sky/ground reflections; hands respond to environmental shade. |
| 19–20 | Resumable terrain generation, byte-budgeted terrain cache, remote pose cadence/culling, reference-counted avatar geometry, reduced Low/Medium color-atlas memory, and pruned first-person assets. |
| 21–22 | Glare/grain/motion controls and clearer material lighting; caster visibility, required attributes and TSL portability fixes. |
| 23–24 | Real post-limiter full-mix capture, measured combat calibration, stereo-linked look-ahead limiting, full listener orientation and bounded direct-path obstruction. |
| 25–27 | Lazy/streamed audio resources, protected warning routing, bounded voices/echoes with actual source lifetimes, and frame-independent acoustic timers. |
| 28–29 | Keyboard/controller menus, text entry, inventory operations, focus retention and scaling; persisted sensitivity, invert-Y, FOV, motion, HUD and subtitle options. |
| 33 | Only active exposed participants affect combat/weather scaling. |
| 36 | Persisted boss damage/position and recovery-pack lifetime; telescope home matches the selected bedroll. |
| 37–39 | Compact relevant poses, chunk-local/compressed terrain streams, bounded backpressure, fixed server simulation, asynchronous password work and protocol compatibility recovery. |
| 40 | Per-world telemetry with bounded rotation-aware readers, online SQLite backup/verification and restore regression, plus a retained-world benchmark fixture. |
| 41 | Verified atomic desktop updates, bounded downloads/startup, fallback to a verified playable build and restricted navigation/content handling. |

## Measured results and deliberate alternatives

- Paired rendering on the review machine: inactive headlights improved throughput **17.7%** in the tested view.
  This is a local scene comparison, not universal gameplay FPS. The earlier Low/Medium sand timing claims
  were withdrawn: a shader branching defect produced incorrect lighting, so those timings do not establish a valid gain.
- The all-sample cascade path remains the default. Selective sampling is experimental; the earlier frozen
  captures did not establish its correctness or cost because render-pass caching and late filter setup hid the distinction.
- Low/Medium scavenger texture storage is approximately **32 → 16 MiB** including mipmaps. Hands GLB size is
  **1,887,412 → 1,612,564 bytes (−14.6%)**. Selective atlas resizing/pruning was used instead of adding a KTX2
  encoder/transcoder dependency. High-quality atlases and data textures are retained.
- AO is a bounded artistic approximation, not exact ambient-only light separation. Environment reflection uses
  an analytic sky/ground gradient rather than dynamic PMREM captures. These choices avoid an extra scene pass
  and repeated environment convolution.
- The calibrated default combat fixtures measured **−23.7 LUFS solo / −22.0 LUFS multiplayer**, with zero
  dropped voices. Reference-volume true peaks were **−2.6 / −2.2 dBTP**. Quiet exploration/storm beds stayed quiet.
  See [audio.md](audio.md) for source isolation, fixture coverage and the compressor-fallback limitation.
- Terrain traversal completed all twelve tested layouts over about 4 km without holes and stayed within its
  configured cache budget. Generation budgets are soft: row work/GC can overshoot. Shadow reallocation still
  caused a **183 ms maximum hitch** in the tested toggle sequence, despite avoiding the earlier shader stalls.
- Three alternating 30-second, eight-player server runs against `941c515` reduced median bytes sent per player
  from **98.4 to 48.8 KiB/s (−50.4%)**. Median first-snapshot join time was **228 → 461 ms**; baselines now finish
  before snapshots. Other active Blender/browser work made timing results noisy, including apparent speedups
  in unchanged physics, so no CPU-speedup claim is made. Repeat timing comparisons on an idle host.
- The retained-world fixture (600 buildings, 2,500 drops, 500 edited chunks, 600 visits) completed a 30-second
  eight-player run: **259 ms** maximum join-to-first-snapshot, **52.6 KiB/s/player**, **162 MiB RSS** and **7.66 ms**
  tick p99. These are a successful stress sample, not a statistically comparable fresh/aged speed claim.
  Reproduce with `npm run bench -- --base 941c515 --suites worldgen,physics,ai,server --rounds 3` and
  `node tools/bench/server.ts --aged --types --seconds 30`.

## Validation and remaining operational work

Automated checks cover malformed peers with seven healthy peers, sparse/burst inputs, ordered backpressure,
terrain re-entry/healing/large baselines, teardown reach/prerequisites, economy reward ordering, saved state,
desktop corruption/timeouts/atomic activation, audio limiting/budgets/routing/obstruction, focus and subtitles,
and telemetry rotation/partial lines/byte bounds. SQLite recovery tests include committed WAL contents and an
older schema migration with item conservation. The 200-world economy comparison completed with all worlds
winning; earlier estimated dismantling work and the corrected exact-step model are not a balance-equivalent
yardstick, so milestone differences were not used as a gameplay-balance claim.

Browser checks covered WebGPU and native WebGL2 rendering, actual WebGPU device destruction followed by
Reload into the same world, WebGL context-loss recovery UI, quality transitions, hidden prewarm restoration,
avatar-cache ownership, shelter shading, keyboard/controller inventory/menu flows and desktop startup.
Builds retain the existing large-chunk and runtime font-reference warnings.

**Host backup scheduling and off-host retention were not configured or verified.** Repository backup and restore
tools are ready; the actual host still needs the operational checks in [recovery.md](recovery.md). No production
release tags were created. Graphics measurements and reproductions are in [perf.md](perf.md); multiplayer details
and resource limits are in [netcode.md](netcode.md) and [server-limits.md](server-limits.md).
