# Dev log

What we built, why, and what's left. Newest session first. Add an entry when you land something big.

## 2026-10-17 — Items, Tab inventory and storage

- **Items are rows** (`items` table, `server/items.ts`): one row per stack with a stable id, its kind
  (`ITEMS` in `shared/items.ts`, string ids), size, owner (browser ID; `''` for shared boxes), box and slot.
  The old per-kind `inventory` counts are migrated into bag stacks on startup and the table dropped.
- **Boxes** (`shared/storage.ts`): your **bag** (the 4-slot hotbar, keys 1–4, plus 8 backpack slots), the
  **sand bike** (8 slots, yours, open while riding) and the **chest** against the bunker room's back wall
  (16 slots, shared by everyone, within 2.5 m). Nothing stacks: one item per slot (bigger stacks from before are split on load).
- **Starter kit:** new players get the canteen (slot 1) and spyglass (slot 2), once (`starter_kits`), so
  leaving them in the chest doesn't conjure new ones. No canteen in the bag → the server refuses sips and refills.
  The hotbar now shows whatever is in the bag's first four slots, and the keys take that out.
- **Tab** opens the inventory overlay (frees the mouse, stays fullscreen): backpack on the left, every box in
  reach on the right, appearing and vanishing as you walk. Drag to move/swap, shift-click to send an item
  across, Sort orders (the hotbar stays). The client applies
  `moveItem()` at once; the server re-checks reach, applies the same function and answers with the boxes.
- Pickups land in the bag after the hotbar; a full bag says "Backpack full" and leaves the piece.
- **Next:** dropping items in the world, crafting/disassembly using them, more storage (crates at crash sites?).

## 2026-10-17 — Heat meter (replaces the thirst bar)

Thirst became heat: instead of water running out, heat builds up and you keep it under control.

- **Meter** (0–100, `heat`; full = heatstroke): rises above 24 °C felt, on the same curve the drain used
  (table under "Temperature and shade"). Below 24 °C it falls by itself: full → empty in **60 s** at 20 °C
  or colder (nights), **120 s** in the base (22 °C). A sip from the canteen takes off **25**; 4 sips per
  canteen, refilled at the pump in the base as before.
- **Death:** at 100 you die of heatstroke (`died` with `cause: 'heat'`), respawn at the base with 0 heat
  and a full canteen.
- **Protocol:** `water` is now `{ heat, sips, rising, temp, shade }` (`rising` = heat building up, lights the
  HUD sun). Sent ~2×/s while the meter moves, at once when it settles at 0.
- **DB:** v4 adds `players.heat` (default 0); the old `water` column is left unused.
- **HUD:** the bar fills with heat, blue → amber (from 40) → red; above **80** it pulses and the screen
  edges glow (`HEAT_HIGH`). Drinking at ~0 heat says "You're cool enough".
- Files keep their `water` names (`shared/water.ts`, `server/water.ts`, `src/water.ts`, the `water` message);
  they hold the canteen and the meter.

## 2026-10-17 — Crash sites

Crashed spacecraft half-buried in the dunes, for players to hunt for parts later (salvage isn't built yet).
- **Layout** (`shared/crashsites.ts`, deterministic like scrap: integer hashing, no trig): 350 m cells, ~40%
  hold a site → **66 sites** in the world (34 smouldering). Each has one main wreck (fighter, freighter, pod,
  nacelle, shuttle or probe) and 3–8 debris pieces strewn along the ploughed approach line behind it, a few
  thrown ahead. Sites sit on flat-enough ground, ≥ 220 m from the base and spawn, clear of scrap piles, and fit
  inside their cell. Stable ids (`crashSiteId(ix, iz)`); query with `crashSitesNear()`, `crashSite(id)`,
  `allCrashSites()`. `?debug` lists them in `dbg.crash`.
- **Collision:** `collideCrash()` (vertical capsules, same rules as `collideScrap`) runs in `step()` and
  `stepBike()`; you can climb onto wrecks. Pieces sit at the (dug) ground height at their centre, sunk a little.
- **Models:** `public/models/crashsites.glb` from `tools/blender/crashsites.py`, which also writes
  `shared/crashKinds.ts` (node names, hitbox capsules, smoke and beacon points). Model +Z is the nose.
  Until the glb exists, each kind is drawn as grey boxes around its capsules with a glowing beacon cube.
  Drawn within 1 km (`src/world/crashsites.ts`), one InstancedMesh per kind and material; the `CrashGlow`
  material flickers irregularly, each site on its own phase.
- **Smoke** (`src/world/crashSmoke.ts`): a thin dark-brown column per smoke point of smouldering sites,
  rising 25–40 m and bending downwind, lit by the sun colour. One instanced sprite (one draw call); all motion
  is in the shader. Puffs swell with distance so the plume still reads over a crest at ~400 m.
- **Sound** (`src/crashSound.ts`, `src/crashSynth.ts`): sparse synthesised beeps, chirps, data blips, a
  dying-console warble, a servo whine and electrical crackle, with a root note, scale and tempo per site.
  HRTF-panned at the wreck's beacon, heard within 40 m, nearest two sites only. Measured with an
  OfflineAudioContext (HRTF panner 5 m in front, slider at 1.0) and `ffmpeg ebur128` over 30 s for four sites:
  −34.1 to −39.3 LUFS integrated (mean −36.4), true peak ≤ −19 dBFS. Inside 5 m it stays at that level; at the
  default slider (0.4) it is 8 dB lower. Later raised 6 dB (`VOICE_GAIN` 0.1 → 0.2, so ~−30 LUFS at 5 m, true
  peak ≤ −13 dBFS) because it was too subtle up close, with a steeper falloff (`rolloffFactor` 1.6) so at
  20–40 m it is only ~2.5 dB louder than before.
- `?spawn=crash` starts you just off the nose of the crash site nearest your saved position, facing it.

## 2026-10-17 — Base becomes an underground bunker (issue #12)

The dome hall, greenhouse and outdoor machines are gone (their scripts and models are in git history). The base
is now a minimal bunker under the pad at (−10, −216): a small plaster entrance hut on the surface, stairs
going down straight from its door, a hallway, and a 10 × 10 m concrete room with a hand water pump in the
middle, under a gridded glass skylight.

- **Layout + physics** (`shared/base.ts`): the heightfield stays where it is and is the bunker's roof.
  `terrainHidden()` tells `step()` where the sand isn't the ground (inside the hut, and anywhere over the
  bunker for feet that were already below the sand), so the stairs, hallway and room floors take over.
  Walls are capsules with a height range (`y0..top`), so the buried ones don't block people walking over
  them, and ceilings only count for players under them. The stairs are a ramp half a step under the nosings.
  No digging over the bunker (`overBase`); players who left over it rejoin at the door.
- **Terrain holes:** `TERRAIN_HOLES` (hut floor, skylight shaft) are cut out of the sand and the drift sheet
  with a `maskNode` (`outsideTerrainHoles()`), which also drops them from the sun's shadow map, so the sun
  shines down the shaft and draws the skylight's grid on the floor; the patch moves through the day.
- **Lighting indoors** (`src/world/base.ts`): indoor materials use their own `lightsNode`: the sun, a bounce
  light under the skylight that follows the daylight, the bulb over the stairs, and a 3% glow. No hemisphere
  fill, so it's dark away from the light. Those lights aren't in the scene, so they don't leak onto the sand.
- **Model:** `tools/blender/base/bunker.py` → `public/models/base/bunker.glb` (`hut`, `bunker`, `pump`,
  ~1.9k tris). Dimensions mirror `shared/base.ts`.
- Underground, the camera skips its stay-above-the-sand clamp, third person falls back to first person (the
  boom would be under the sand), and the wind sound drops to a draught.
- **Garden:** the bed code and protocol stay, but there are no beds now (`BEDS` is empty).
- **Next:** make the pump do something (fill a canteen, water plants), and let players build the base out.
## 2026-10-17 — Temperature and shade

Thirst now follows a **felt temperature** instead of the sun's elevation, and shade is real: dunes, the
entrance hut and scrap piles block the sun.

- **Air temperature** (`shared/temperature.ts`, plain math on the shared clock): 12 °C at 05:30 (just before
  sunrise), 44 °C at 14:00 (the peak lags noon by two hours, as in real deserts). It warms along an
  inverted squared half cosine, so mornings warm fast (~17 °C at 07:00, ~31 °C at 09:00), and cools along a
  squared half cosine, so evenings drop fast: ~35 °C at 18:00, ~23 °C at 21:00,
  ~15 °C at midnight.
- **Felt temperature** = air + up to **+12 °C in direct sun** (× sin(elevation)/sin(noon elevation)); no
  bonus in shade or at night. In the base (`inBase`: hut or bunker) it is `min(air, 22 °C)`.
- **Shade** (`shared/shade.ts`, run by the server every 250 ms per player): a ray from the head (feet +
  `EYE_HEIGHT`) towards the sun (`skyVector`, the same direction the client's light and shadows use),
  marched over `heightAt` (dunes, pad, digs) with steps of 0.2 m + 5% of the distance, up to 180 m, stopping
  early once it is above the highest possible ground. It also slab-tests the hut (with its roof overhang) and
  the skylight collar as boxes, and scrap hitboxes in the first 25 m. ~15–20 µs per check (~80 µs/s per player).
- **Heat build-up** (`shared/water.ts`; see "Heat meter" above, which replaced the thirst bar): above
  **24 °C** the meter rises at `100/60 s × ((felt − 24) / 30)²`, ×1.5 sprinting (was `/100 s`, fourth power:
  too gentle, ~16 min to heatstroke standing in the 17:00 sun). Shade felt is **10 °C under the air** while
  the sun is up (fading out in its last stretch above the horizon), so behind a dune it feels ~20 °C cooler
  than the sun next to it, and slows the build-up ~8–15×.

  | time | air | sun: felt | empty → full | shade: felt | empty → full |
  |---|---|---|---|---|---|
  | 00:00 | 14.5 | 14.5 | cools | 14.5 | cools |
  | 06:00 | 12.3 | 13.8 | cools | 6.0 | cools |
  | 09:00 | 23.6 | 32.5 | 12 min | 13.6 | cools |
  | 12:00 | 39.8 | 51.8 | 70 s | 29.8 | 26 min |
  | 13:30 | 43.7 | 54.9 (hottest) | 56 s | 33.7 | 9.5 min |
  | 15:00 | 43.3 | 52.3 | 68 s | 33.3 | 10 min |
  | 17:00 | 38.5 | 42.7 | 2.6 min | 28.5 | 44 min |
  | 18:00 | 34.8 | 36.3 | 5.9 min | 28.6 | 43 min |
  | 21:00 | 22.6 | 22.6 | cools | 22.6 | cools |

  Real time: a day is 30 min, so 1 in-game hour = 75 s. Real build-up only runs ~11:00–17:00.
- **Protocol/HUD:** `water` gains `temp` (felt °C, 0.1) and `shade` (no direct sun: shade, night or base).
  It is also sent when shade flips or temp moves 0.5 °C, so the thermometer stays live at night. Next to the
  thirst bar: a sun or shade icon and the eased °C, blue (≤18) → amber (34) → red (≥50).
- **Where to find shade:** in the afternoon the sun is too high for slip faces (32°) to throw much
  shadow; the hut's lee works, and from ~17:00 the slip faces facing the base's pan put it in shade.
  Mornings the shade is on the windward side of crests (sun from the east, slip faces face +Z, downwind).
- **Gaps:** the shade check is one point (the head), so half in shade counts as sun; the far march is
  coarse (steps ~9 m at 180 m) and can miss a thin crest at grazing angles; other players and the bike cast
  no shade; no cold at night (below 24 °C you only cool off); temperature doesn't vary with altitude
  or wind; the client doesn't predict the icon (it lags up to ~250 ms + latency).

## 2026-10-17 — Thirst and heat

The first survival mechanic: the sun dries you out, the canteen keeps you going, the base refills it.

- **Water** (0–100, the thirst bar) is server-authoritative (`server/water.ts`), not in `shared/sim.ts`
  (it never moves you). Saved per browser ID in `players` (`water`, `sips` columns) with the position.
- **Heat:** (superseded by "Temperature and shade" above) while the sun is up and you're outside the base (`inBase`: the hut or down in the bunker), water drains at
  `100 / 300 s × sin(elevation) / sin(57°)`: a full bar lasts **5 min at noon**, longer morning and evening,
  nothing at night or indoors. Sprinting (Shift held and moving faster than a walk) drains **1.5×**. Over a
  whole day (16 min of daylight) that's about two bars outdoors.
- **Shared sun:** the clock and the sun's arc moved from `src/world/dayNight.ts` into `shared/sun.ts`
  (plain math), so the server's heat matches the drawn sun. The server uses the real shared clock;
  `?tod`, `?day` and the debug slider stay visual-only (the debug menu's "Apply to all players" moves the
  server clock and therefore the heat too).
- **Canteen** (hotbar slot 1, key **1** takes it out/puts it away): 4 sips × 25 water, starts full. With it
  out, left mouse / E don't dig: hold for 1.2 s to drink one sip (`drink`, server checks sips, a 1 s cooldown
  and the respawn grace). In the base, **F** refills it in 1.5 s (`fill`, server checks `inBase` + 2 m
  slack); scrap pickup keeps F when a piece is targeted. The base's water is endless.
- **Death:** at 0 you die of thirst: the server moves you to `BASE_SPAWN` with full water and canteen and
  sends `died`; the client shows "You died of thirst" for 3 s, and the next reconciliation snaps (not
  glides) to the base. No drain or drinking for those 3 s. Scrap inventory is kept.
- **HUD** (`src/water.ts`, DOM/CSS): thirst bar bottom-centre (blue → amber → red as it empties) with a sun
  light that glows while you're draining, the 4-slot hotbar under it (canteen with sip pips), prompts under
  the crosshair, and below 20% a pulsing bar and a red heat vignette. The bar eases between the ~2 Hz
  server updates.
- **Viewmodel hook:** `playerHands` in `src/water.ts` (`held: 'none' | 'canteen'`, `drinking`, `filling`)
  is what the first-person hands should show. Tuning is at the top of `shared/water.ts`.
- **Known gaps:** dune and building shadows don't count as shade (only the base's footprint does); no
  shelter at night is needed (no cold); you can't drink from or share with other players; slots 2–4 are
  empty; drinking at a full bar is blocked client-side only (the server would accept and waste the sip).

## 2026-10-17 — Dev helpers: spawn at base, sand bike

- `?spawn=base` puts you in front of the base's door on join, instead of where you logged off (a reconnect
  keeps your position). Sent as `spawn: 'base'` in `hello`.
- **9 gets on / off a sand bike** (in `npm run dev`, or with `?debug` on the live site). It's the `BIKE` input
  bit, so it goes through prediction like everything else: `stepBike()` in `shared/sim.ts`. W throttle, S
  brake/reverse, A/D steer, Space hops; the mouse just looks around and the camera turns with the bike.
  Bicycle-model steering, limited tyre grip (hard turns drift), slope gravity, and it rides the surface until
  the sand falls away faster than gravity can follow, so dune crests at speed throw it into the air.
- Model: `tools/blender/sandbike.py` → `public/models/sandbike.glb`; drawn by `src/bike.ts` (pitch along the
  sand or flight path, lean into turns, spinning wheels, turning bars, tyre track). The rider is the crouched
  avatar sat on the pegs. Getting off makes the bike vanish; it isn't a world object, and isn't saved.

## 2026-10-17 — Item models and icons (issue #8)

- `tools/blender/items.py` builds battery, electric motor and heat sink in four tiers (`scrap`, `basic`,
  `quality`, `space`) → `public/models/items/<item>_<tier>.glb` (real metres, origin at the base centre,
  120–710 tris) and `public/icons/items/<item>_<tier>.png` (128 px, transparent, same 3/4 ortho camera,
  thin dark outline). Each item keeps its silhouette; tiers change finish: rusty/dented/taped →
  plain painted → bevelled with chrome/copper/orange accents → white/gunmetal with glowing cyan.
- **Not wired in yet:** the inventory only knows `SCRAP_KINDS`. Needs an item/tier id scheme in
  `shared/` (and in the inventory table/protocol) before the HUD can show these icons.

## 2026-10-17 — Water canteen (first-person)

For the water loop: `public/models/hands.glb` now carries an old military canteen and clips to use it.
Only the model so far; the game code that plays them is separate.

- **Model** (`tools/models/canteen.py`, built and baked by `tools/models/hands.py`): flattened kidney-shaped
  steel body in sun-bleached olive-brown enamel, pale washer and dark wooden stopper, khaki webbing cradle
  with D-rings for a carry strap (left off so nothing swings into the camera). 1.4k tris, own 512 atlas
  and material `Canteen`. Also exported alone as `public/models/canteen.glb` (origin at the bottom) for
  world use later.
- **In hands.glb:** mesh node `Canteen`, child of the `RightHand` bone, gripped like a flask: palm on its
  right edge, fingers round the back. It is visible by default; toggle `.visible`.
- **Clips (30 fps):** `CanteenIdle` (3 s loop, held low-right, left arm lowered out of view),
  `CanteenWalk` (0.73 s loop, same bob as `Walk`), `Drink` (1.2 s: neck to the mouth, tip up, two
  gulps, lower), `Fill` (1.5 s: lowered forward and tipped, left palm under the bottom). The one-shots
  start and end on the `CanteenIdle` pose. `Idle`/`Walk`/`Dig` are unchanged. Note the glTF sorts clips
  by name, so `animations[0]` is now `CanteenIdle`: look clips up by name.
- **How it's posed:** the canteen clips place the canteen (and the left palm) in view space and solve
  each arm with analytic two-bone IK, most of the wrist roll going into the forearm so the glove cuff
  doesn't twist. The canteen gets no closer than 0.12 m to the eye (camera near plane 0.05).
- The hands were checked in first person and left as they are: they read fine at game scale.

## 2026-10-17 — Home base

New goal: plant and grow nature, push back the desert. The players' home is a homestead in a dune pan at
(−10, −216), ~60 m from where the team was playing (prod DB positions): Tatooine-ish plaster dome crossed with steampunk brass, copper and iron
(all original designs). New players spawn at its front door (`BASE_SPAWN`). The palms are gone
(`tools/blender/palm.py` is kept for growing plants later).

- **Layout** (`shared/base.ts`): domed hall (r 7 m, oculus skylight) with the front door facing +Z, a
  glass greenhouse wing along −X with a rear door, and machines outside (dew condenser, cistern tank, wind
  pump, solar stills, signpost, wind-break fence). `BASE_PIECES` places every model and gives it a hitbox.
- **Physics:** `collideBase()` in `step()`: the hall wall is an annulus with two openings (trig-free, so it
  matches on every engine), greenhouse walls and furniture are capsules, floors are a support height, and
  `baseCeiling()` stops jumps at the roof. Low furniture can be jumped onto.
- **Terrain:** `baseHeight` flattens a pad around the base (`withPad`), no digging under the floor
  (`TerrainEdits.setMm` refuses it), no scrap piles on the pad. The wind drops to 15% indoors, so there's
  no blown sand inside and the wind sound goes quiet.
- **Models** (`tools/blender/base/*.py` → `public/models/base/*.glb`, made by four parallel agents):
  `shell` (building), `hall` (workbench, shelf, stove, table, bunk, chest, radio, rug, chandelier),
  `greenhouse` (planters in three growth stages, tree, trellis, seed cabinet, cistern, grow lamps…),
  `exterior` (machines; `condenser_rotor` and `windpump_rotor` spin faster in wind).
  `src/world/base.ts` loads them: glass is see-through and shadowless (sun and moon patches through the
  portholes are real), two warm point lights light the inside at night.
- **Planters** (`shared/garden.ts`, `server/garden.ts`): the six greenhouse beds are shared and persisted
  (`garden` table). Look at a bed and press F: an empty bed is planted (sprouts), sprouts grow on their own
  after `GROW_MS` (6 min), a grown bed is harvested back to soil. The server checks reach and broadcasts every
  bed's stage (`garden` message); `src/world/base.ts` swaps the three planter models. Harvests give nothing
  yet, and there is no watering.
- **Next:** carry water from the condenser and make beds need it, give harvests a use (food, seeds), and
  let greenery spread outward from the base.

## 2026-10-17 — Day and night

- **24 h every 30 min** (`src/world/dayNight.ts`, clock and sun arc now in `shared/sun.ts`), on the server's wall clock (`epoch` in `welcome`,
  `Net.worldTime()`), so everyone shares the same sky and it survives server restarts.
- The sun follows a real arc: rises east (+Z), peaks at 57° in the south (+X), sets just north of west,
  roughly ahead of the spawn view. A full moon rides opposite it and takes over the shadow light at night.
- Sky, haze, sun colour and ambient are keyframed on sun elevation; the 10° key is the tuned golden
  hour from `env.ts`/`sky.ts`, so tuning those still tunes the evening. Stars and a mottled moon at night.
- The clock shows top-left. `?tod=0.75` freezes the time (0 midnight, 0.5 noon); `?day=60` makes a day 60 s.

## 2026-10-17 — Desert planet (PR #4)

Jam theme: **old tech**. We went with a **scavenger game**, in the spirit of the scrappers in Star Wars
(Jawas, Rey on Jakku): you roam a burning desert planet and salvage old tech from crashed wrecks.
Designs and names must be original; the repo is public, so no Lucasfilm IP.

Goal of this session: *I can roam around the desert planet with my friends in the browser.* Done and live.

### What shipped

- **First person.** Eye height 1.65 m, pointer-lock mouse look, head bob, landing dip, strafe roll, FOV
  kick when sprinting (`src/camera.ts`). **T** toggles a third-person view (remembered per browser): the
  camera backs 4.5 m off along the view ray, so the crosshair still aims where digging and pickup go, and
  the boom shortens rather than going under a dune.
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
A light wind comes in puffs with near-calm lulls (a few seconds each); a strong wind blows steadily.
Measured at the default volume (0.4), rendered offline in Chrome while walking: about −46 LUFS in a calm,
−36 in a breeze (u10 = 8), −32 at 12 m/s, −26 in a sandstorm; true peak ≤ −8 dBTP. It is an ambience bed,
so it stays under the −23 LUFS mix target. (Measure in Chrome: node-web-audio-api mis-renders this graph.)

- **Layers:** low rumble (brown noise, buffeting), broadband rush (bandpass rising with speed), two
  narrow aeolian "howl" resonances that only come up in strong wind and slide with gusts (Strouhal),
  and a high sand hiss that follows saltation `q` and swells with streamers (`emit`).
- **Direction:** the rush is louder in the windward ear and brighter when facing into the wind.
- Starts on the first click/key (browser autoplay rules), suspends when the tab is hidden.

## Footsteps

`src/footsteps.ts` plays one step from `public/audio/footsteps.mp3` each time an avatar plants a foot
(the same stride that leaves a footprint; none while sliding). The file is a sprite of 8 single steps
(0.4 s slots) sliced from a Pixabay recording of a brisk walk on a gravel trail, levelled so a
steady 2.4 steps/s walk is −23 LUFS. In game (~5 steps/s, GAIN 0.2, default volume 0.4) the local
player's walking is roughly −42 LUFS: under a breeze, above a calm. Random step (no immediate repeat),
±8% pitch, ±15% level; remote players' steps are panned and fall off as 1/d beyond 2.5 m, silent past 30 m.

Inside the base (`inBase` at the foot) steps come from `public/audio/footsteps-concrete.mp3` instead: 10
steps (0.4 s slots) sliced from InspectorJ's "Footsteps, Concrete, A" on Freesound. The recording is
quiet and peaky, so at −1.6 dBTP the sprite only reaches −30 LUFS; its gain is 0.45 (vs 0.2) so both
surfaces walk at about the same loudness.

Picking up scrap plays `public/audio/pickup.mp3` (`src/pickupSound.ts`), a metal latch from Freesound
(CC0) trimmed to its main hit and levelled to −23 LUFS. Local only, played as you press F; GAIN 0.2
keeps it quiet, about as loud as your own steps, with ±6% pitch.

All sounds now go through `src/audio.ts`: one AudioContext, the volume slider as master gain, and the
limiter. New sounds connect to `audio.out` (or use `audio.onStart`).
  Volume slider in the top-right corner (default 0.4, remembered per browser); `dbg.wind.override` is handy for tuning.

## Ctrl slide

Titanfall-style intentional slide (input bit `SLIDE` = 256, keys Ctrl or C; C because browsers eat Ctrl+W).
Not to be confused with `sliding` on the avatar/`Slide` clip, which is slipping down a slip face.

- **Sim** (`shared/sim.ts`, state `sliding` + `slideCool`): starts on the ground at ≥ 4.5 m/s, +3 m/s entry
  burst (capped 14), 50-tick cooldown from the start. While held: 8 m/s² friction, 90% of the slope's
  gravity (downhill gains speed, uphill bleeds it), steering only turns the heading (1.6 rad/s). Ends on
  release, leaving the ground, or < 3.2 m/s. Jumping out keeps the speed (air control never brakes).
- **Animation:** `Powerslide` clip (leg driven forward, other knee tucked, leaning back; `tools/models/scavenger.py`).
  `ScavengerModel` tilts a group between root and model to the slope along/across the facing (`tiltPitch/Roll`),
  feet IK is off during it. Camera eye drops 0.65 m. Remote players get it from the snapshot's `sliding`.
- **Crouch:** Ctrl on the ground without sliding (too slow to start one, in cooldown, or the slide ran out)
  caps speed at 3 m/s (`crouching` in state; clips `Crouch` / `CrouchWalk`, camera drops 0.45 m).
- Tuning knobs are the `SLIDE_*` constants at the top of `sim.ts`. Untested with real multiplayer latency.

## Performance and network jitter

"Laggy on live, fine locally" turned out to be two separate problems.

**Network jitter** (`6760e65`). Ping to herkku.org from home Wi-Fi: 11 ms best, 150+ ms spikes. The server
sends snapshots every ~49 ms like clockwork, but they arrive in bunches with 100–360 ms gaps. The prediction
itself was fine (zero corrections on a steady link). What broke:
- The server's input rate limiter only banked 15 inputs (250 ms). After a longer stall, the delayed inputs
  arrive together and the rest were acked without being simulated, so the client snapped back up to ~1 m.
  `MAX_INPUT_BURST` is now one second (`TICK_RATE`); the long-run rate is still capped at 60/s.
- The clock offset averaged jittery arrival times, and remote players were drawn a fixed 100 ms in the past,
  so every late snapshot froze them and then made them jump (~4% of frames on live, now ~0.2%). The clock
  now comes from the least-delayed snapshot, and the interpolation delay is 100 ms plus measured jitter
  (capped at +300 ms, eased so it never jumps).
- An old browser tab was itself part of "laggy"; a fresh browser helped. Worth trying first.

**GPU** (`feb02e0`, `753232e`, `319f678`, `b022959`). The frame is bound by shading ground pixels: looking at
the sky runs at 120 fps, looking at the sand ran at 12–25 fps on an M2 Pro with a full-screen retina window.
Measured GPU time in a 1280×800 window (`trackTimestamp`, best of 3):

| Setting | GPU ms/frame |
|---|---|
| 2× retina ratio, MSAA (what we had) | ~32 |
| 2×, no MSAA | ~20 |
| 2×, no shadows | ~17 |
| 1.5× | ~13.5 |
| 1×, no MSAA | ~8 |

The drift sheet and the CPU side cost next to nothing (the CPU sits ~80% idle). What changed:
- **Dynamic resolution** (`src/resolution.ts`): the render pixel ratio follows the frame time. When slow it
  drops to the ratio that should fit (cost ∝ ratio²); when steady it creeps up 10% every 2 s, but never past a
  ratio that failed recently (that ceiling relaxes over ~1 min), so looking at the sky and back doesn't pump it.
  Range 0.5–1×. The info line shows it: `60 fps @ 0.91x`.
- **Lower defaults:** at most 1× (one pixel per CSS pixel), 1024 shadow maps per cascade (was 2048), one
  sand speckle layer (the ~1 cm one is gone). The look should be stylised, not ultra-realistic.
- **Sand shader:** the ripple warp's gradient comes from screen-space derivatives (`dFdx`/`dFdy`) instead of
  two extra warp evaluations, saving four noise calls per ground pixel.
- An FPS counter is at the start of the top-left info line.

Still expensive per ground pixel, if more is needed: ~10 noise calls in the sand shader, four shadow cascades
sampled unconditionally (`cascades.ts`), heat haze, lens flare and film grain in `post.ts`. Fewer cascades or
dropping haze/flare/grain is an art-direction call (`docs/look.md`).

**Measuring:** GPU numbers are only meaningful with no other game tab open; a running tab shares the GPU and
made timings swing 4× between identical runs. Headless Chrome (`--enable-gpu --use-angle=metal`, muted) gets
WebGPU on the Mac without stealing focus. To test the netcode against live without a browser, `src/net.ts`
runs under Node with `location`, `__BUILD_SHA__` and `localStorage` stubbed on `globalThis`.

## First-person hands

`src/viewmodel.ts` draws `public/models/hands.glb` parented to the camera (the camera is now in the scene so
its children render). Clips: Idle / Walk / Dig with empty hands; CanteenIdle / CanteenWalk plus one-shot
Drink / Fill while `playerHands` (`src/water.ts`) says a canteen is held. Missing clips fall back to the
empty-hand ones and a missing `Canteen` node just means no canteen. Walk clips are phase-locked to the
camera's step phase instead of a speed-scaled timeScale, so the hands bob with the head. The hands trail
mouse look slightly, drop and come back up when switching what's held, and dip while sliding.

- **Wall poke-through:** the model is scaled 0.55× about the eye. That leaves the picture unchanged (scaling
  about the projection centre doesn't move anything on screen) but pulls the hands within ~0.35 m, inside
  `PLAYER_RADIUS`, so they stay in front of walls the player is pressed against. The camera near plane
  (0.05 m) is unchanged.
- **No shadows:** the hands neither cast (the shadow-only body already does) nor receive (they'd sit inside
  that body and always be in its shadow). Downside: they stay sunlit indoors.
- **Testing:** `?hold=canteen` forces the canteen, `?anim=Drink` loops any clip; `dbg.viewmodel` with ?debug.

## Sandstorms

Local, short storms instead of the old global one (`wind.ts` used to hash a 3–7 minute storm into every
15-minute slot, for everybody, purely visual).

- **Where and when** (`server/storm.ts`, `shared/storm.ts`): every 2–6 minutes the server picks a random
  player and puts a storm within 220 m of them: radius 60–140 m, drifting downwind (the dunes' `WIND`) at
  1–4 m/s, 15–90 s long with 6 s ramps in and out. Announced 12 s ahead. The list goes to everyone on join
  and whenever it changes (`storms` message); its times are on the server clock (snapshot time), so client
  and server work out positions and strength from the same math. In memory only: a restart clears it.
- **Warning:** a storm whose path will cross where you stand (within 40 m) beeps three pips every 2.5 s
  and shows a countdown banner, unless you're in the base. The pips peak at −21.5 LUFS momentary at the default
  volume (true peak −8 dBTP), measured offline with the same waveform.
- **Inside:** +10 °C felt (`STORM_TEMP`, server/water.ts) on top of sun/shade, so heat builds fast by day
  and even nights get warm; the base keeps it out. The locator bar (our only map) is lost while the storm
  at the camera is over 0.35. The storm at the camera also sets `wind.local`, which drives the wind to
  ~17 m/s, so the grains, drift sheet, dust puffs, sky haze and wind sound all pick it up.
- **Look** (`src/post.ts`): each storm is a dust cylinder marched in the post pass (6 jittered steps along the
  view ray, clipped to the cylinder and the scene depth): density full out to 55% of the radius, thinning
  upwards over 60 m, billowed by 3D noise that drifts with the wind and rises. From outside: a tall rolling
  brown column (dark against the dusk sky); inside: dust fog ~20 m deep. Not drawn from inside the
  bunker (it would fog the rooms). Up to 4 at once.
- **Testing:** F3 → "Sandstorm here" summons one on you, for everyone. With `?debug`, `dbg.net.storms` can
  be set by hand for a look-only storm (the server doesn't know about it).

