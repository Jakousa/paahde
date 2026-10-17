# Dev log

What we built, why, and what's left. Newest session first. Add an entry when you land something big.

## 2026-10-17 — Desert planet (PR #4)

Jam theme: **old tech**. We went with a **scavenger game**, in the spirit of the scrappers in Star Wars
(Jawas, Rey on Jakku): you roam a burning desert planet and salvage old tech from crashed wrecks.
Designs and names must be original; the repo is public, so no Lucasfilm IP.

Goal of this session: *I can roam around the desert planet with my friends in the browser.* Done and live.

### What shipped

- **First person.** Eye height 1.65 m, pointer-lock mouse look, head bob, landing dip, strafe roll, FOV
  kick when sprinting (`src/camera.ts`).
- **Movement on sand** (`shared/sim.ts`, deterministic):
  - Slower uphill (about half speed on steep ground), a bit faster downhill.
  - You slide down slopes steeper than 30° and can't climb them.
  - Hard landings slow you down for a moment.
  - Sprint and the double jump are kept.
- **Procedural dunes** (`shared/dunes.ts`; `baseHeight` in `shared/terrain.ts` calls it):
  - Each dune has a long gentle windward slope (10–14°), a sharp crest and a 32° slip face.
  - Crests meander and break into crescents.
  - Big dunes are 12–30 m tall and about 260 m apart, with small dunes and flat pans between them.
  - Spawn (0,0) is on top of a 38 m crest.
- **Terrain mesh** (`src/world/terrain.ts`):
  - Chunks get coarser with distance, out to about 4.5 km.
  - Vertices are 0.5 m apart near the player, matching the edit grid.
  - Strips hang off chunk edges to hide cracks between detail levels.
  - Chunk building is limited to a few ms per frame.
- **Diggable terrain:**
  - Left click or E digs where you look, up to 4 m away. Right click or Q puts sand back.
  - Hole walls slump to 34°.
  - Holes sync to every player and survive server restarts.
- **The look** (`docs/look.md`): based on the team's reference images (Dune poster, golden-hour dunes).
  - Sand shader (`src/world/sandMaterial.ts`): Journey-style shading, wind ripples, sparkle, rust shadows.
  - Sky (`src/world/sky.ts`, `src/world/env.ts`): dusky brown-purple top, hot orange horizon.
  - Sun: low (10°), huge and blown out, with bloom, flare streak, starburst, lens ghosts and a halo ring.
  - Post-processing (`src/post.ts`): brightens when you stare at the sun, heat shimmer near the
    horizon, orange haze, warm grade, vignette, grain.
- **Other players** show as a placeholder hooded robe with glowing eyes and a `#id` name tag. They
  leave footprints (`src/footprints.ts`, client-side only).

### Architecture decisions

- **Clients still send only input.** Each tick sends the input bitmask, the camera yaw and the camera
  pitch. Yaw and pitch are rounded to 16-bit integers so client and server step exactly the same.
  Bits: FORWARD 1, BACK 2, LEFT 4, RIGHT 8, JUMP 16, SPRINT 32, DIG 64, PILE 128.
- **Terrain height = procedural base + edit layer** (`shared/terrain.ts`).
  - The base is a pure function of position.
  - The edit layer is a sparse grid of integer millimetres: 0.5 m cells in chunks of 32×32.
  - Edits travel as **absolute values, not deltas**. Applying one twice is harmless, so the client
    can predict its own digs and still end up matching the server.
- **The dune function avoids `Math.sin/cos/pow/exp`**, which can round differently in V8 (server)
  and Firefox/Safari (clients). It uses only `+ − * /`, `sqrt`, `floor`, `Math.imul` hashing and
  polynomial smoothstep.
- **Digging is server-authoritative with client prediction** (`shared/dig.ts`, `server/terrain.ts`,
  `src/net.ts`).
  - The client holds server values for its own predicted points until that input is acknowledged,
    so there is no flicker.
  - Sand slumping runs on the server 30 times a second, and only on recently changed points.
  - Edited chunks are saved in the SQLite table `terrain_chunks`.
- **Database migration:** `players` gained a `z` column. Old 2D positions were reset to spawn.
- **No wasm for terrain yet.** One height lookup takes about 0.3 µs in plain TypeScript, which is
  fast enough.

### Tuning calls we made

- **Sand looked like kinuski** (glossy caramel). Fixed in two passes:
  1. Removed the gloss: less saturated colours, much weaker sheen and crest glow, fewer sparkles.
  2. Changed the surface: ripples about half the size, less contrast, smooth fine grain instead of
     blocky grain.

  Most of the caramel look came from the ripple shape: wide smooth crests split by thin dark grooves.
- **Slide threshold lowered from 34° to 30°** (`SLIP_TAN`), so players slide on the dunes' 32° slip faces.
- **Terrain doesn't cast shadows.** The sun's shadow map covers only about ±70 m and ended in a
  visible hard rectangle. Slip faces are darkened by the sand shading instead. *(Superseded: see Shadows.)*
- **ACES tone mapping over AgX.** AgX washed out the oranges. `?agx` in the URL compares them.

### How we worked

- Claude Code set up the shared interfaces first: 3D sim, protocol, terrain and edit layer, and a
  module skeleton. Then six parallel agents worked in separate git worktrees, each owning its own files:
  1. Dunes and terrain mesh
  2. Sand shader
  3. Sky, sun and post-processing
  4. Player movement, camera and avatar
  5. Digging and sync
  6. 3D models (Blender). **Still running**, see below.
- A research agent wrote `docs/sand-rendering.md`: Journey sand, glitter papers, dune shapes,
  heat haze, sun bloom.
- Branches were merged into `desert`, checked with `npm run build` and headless-Chrome screenshots,
  then shipped as PR #4.

### Handy for testing

- `?debug`: exposes `window.dbg` (orbit, sky, post, scene, renderer, env) for tweaking in the console.
- `?agx`: AgX tone mapping.
- `sand.*` and `env.*` uniforms (wind, colours, ripple strength, glitter, haze, sun size) can be changed
  live without recompiling.
- `node scripts/test-dig.ts` checks that digging is deterministic, that slumping works and that
  saved data round-trips.
- `node scripts/ws-dig-check.ts [url] dig|look` checks dig sync against a running server.
- Agent worktrees live in `.claude/worktrees/`. It's gitignored and Vite doesn't watch it.

### Known gaps / next up

- **Realistic character** (in progress): a rigged scavenger made in Blender, coming in a follow-up PR.
  - Model: `public/models/scavenger.glb`, generated by scripts in `tools/models/`.
  - Code: `src/models/scavenger.ts`, plugged in through `Avatar.setModel()`.
  - Clips: idle, walk, run, jump, dig, slide.
  - Maybe first-person hands and props as well.
- **Untested in a real browser:** rebuilding the terrain mesh after a dig, and the WebGL2 fallback
  with the new terrain.
- **Remote heads don't tilt yet.** Pitch is already in the snapshots.
- **Shallow digging from standing.** A 4 m reach from eye height only gets you about 1 m below your
  feet; step into the hole to go deeper.
- **Gameplay:** wrecks to salvage, the trader, scrap items, carrying and stealing (the design pitch:
  walk, pick up, carry, steal, sell).

## Shadows: cascades, dunes cast, your own shadow

- **Cascaded shadow maps** (`src/world/sky.ts`, `src/world/cascades.ts`): four 2048² maps for 0–20,
  20–80, 80–320 and 320–1600 m, fitted to the widest sprint FOV so the FOV kick doesn't make shadows
  swim. Bias, normal offset and PCF radius are set per cascade from its texel size. Shadows fade out
  over the last cascade, where the haze is ~95%.
- **Terrain casts.** A 30 m crest at the 10° sun throws a ~170 m shadow across the corridor. The shadow
  pass draws back faces, so lit slopes can't self-shadow.
- **Your own shadow:** the local body is on a shadow-only layer (`SHADOW_ONLY_LAYER`), drawn into the
  shadow maps but not the view. Every avatar part casts now (legs and head were missing), and avatars
  darken when standing in dune shadow.
- **Two three.js r186 pitfalls**, both found with headless-Chrome probes:
  1. A material whose `colorNode` is a `vec3` never reaches the shadow map: the shadow pass reads
     `colorNode.a`. The sand's colour is now a `vec4`.
  2. `CSMShadowNode` picks the cascade inside a per-pixel `If`. Every cascade after the first came out
     black at any shadow intensity, on both backends, so beyond 20 m the sun disappeared entirely.
     `CascadedShadows` samples all cascades and blends them without branches.
- **Cost:** each lit pixel takes 4 cascades × 5 PCF taps, and the terrain is drawn once more per
  cascade (depth only). Not measured on a real GPU yet.

## Sandstorm dust and smoother crests

Builds on the wind in `src/world/wind.ts` and the grains and plumes in `src/blownSand.ts`.

- **Storm dust** (`src/world/dust.ts`): while `wind.storm` is up, big soft puffs of lifted sand roll
  downwind near the ground. The haze turns patchy, in plumes drifting with the wind; a thin veil covers
  the near field; the lower sky turns dusty and the sun dims a little. `dust.ts` also feeds the wind
  to the shaders (`windDir`, `windStrength`, `sandStorm`, `windDrift` in `env.ts`).
- **Glitter** is warm-tinted and dulled by dust, so it reads as quartz, not metal flakes.
- **Crests:** terrain chunks carry a per-vertex `crest` value (blurred convexity). The sand shader keeps
  a narrow band at the brink smooth and a touch paler, so ripples no longer run into the knife edge.

## Blown sand as a sheet, not sparks

The saltation streaks read as glowing metal sparks (bright HDR lines catching the bloom when backlit).
From a few metres away real blown sand is a translucent veil streaming over the surface, not grains.

- **Drift sheet** (`src/world/driftSheet.ts`): seven terrain-hugging shells (3–55 cm) on a 96 m grid
  around the player, drawn as one instanced mesh. Streamers are cut from wind-aligned noise advected at
  saltation speed (higher shells slide faster and softer); near the threshold only ribbons move, in a
  storm they merge. Slip faces stay clear. Lit by the same sun, sky fill and cascaded shadows as the
  sand (Lambert with the ground normal), so it darkens on shaded slopes and in dune and palm shadows.
- **Local wind:** every sheet vertex takes its strength from `wind.sample()` (interleaved over 4 frames),
  so gusts visibly race downwind as patches of moving sand, crests and high ridges run first, lee
  slopes stay quiet. `wind.ts` now veers ±25° over minutes with a few degrees of gusty flicker, has
  deeper lulls between gusts (0.65–1.45×) and adds an altitude term (height over the field ~120 m out).
- **Crest plumes** are part of the sheet: behind a brink it is carried on at the brink's height,
  sinking 0.32 m per m, spreading and thinning over ~8 m, fed by the wind at the brink. Continuous along
  every crest instead of the old per-emitter puffs (removed from `blownSand.ts`).
- **Grains** now only spawn within 14 m, thinner, much fainter and without the backlit glow: texture up
  close.
- Cost: ~0.2 ms/frame; ~5 ms when the 96 m grid recentres (every 8 m, heights reused) or the wind veers.

## Wind sound

`src/windSound.ts` synthesises wind from filtered noise (no samples), following `wind.sample()` at the
listener every frame, so dune lees are quieter than crests and passing gusts and streamers are audible.
The wind is averaged over a 4 m ring around the head (the topographic speed-up steps per 4 m cell),
blended 60/40 with the regional wind so lees are only somewhat quieter, and followed with a ~1 s lag.

- **Layers:** low rumble (brown noise, buffeting), broadband rush (bandpass rising with speed), two
  narrow aeolian "howl" resonances that only come up in strong wind and slide with gusts (Strouhal),
  and a high sand hiss that follows saltation `q` and swells with streamers (`emit`).
- **Direction:** the rush is louder in the windward ear and brighter when facing into the wind.
- Starts on the first click/key (browser autoplay rules), suspends when the tab is hidden.
  Volume slider in the top-right corner (default 0.4, remembered per browser); `dbg.wind.override` is handy for tuning.

## Ctrl slide

Titanfall-style intentional slide (input bit `SLIDE` = 256, keys Ctrl or C; C because browsers eat Ctrl+W).
Not to be confused with `sliding` on the avatar/`Slide` clip, which is slipping down a slip face.

- **Sim** (`shared/sim.ts`, state `sliding` + `slideCool`): starts on the ground at ≥ 4.5 m/s, +3 m/s entry
  burst (capped 14), 50-tick cooldown from the start. While held: 4.5 m/s² friction, 90% of the slope's
  gravity (downhill gains speed, uphill bleeds it), steering only turns the heading (1.6 rad/s). Ends on
  release, leaving the ground, or < 2.2 m/s. Jumping out keeps the speed (air control never brakes).
- **Animation:** `Powerslide` clip (leg driven forward, other knee tucked, leaning back; `tools/models/scavenger.py`).
  `ScavengerModel` tilts a group between root and model to the slope along/across the facing (`tiltPitch/Roll`),
  feet IK is off during it. Camera eye drops 0.65 m. Remote players get it from the snapshot's `sliding`.
- Tuning knobs are the `SLIDE_*` constants at the top of `sim.ts`. Untested with real multiplayer latency.
