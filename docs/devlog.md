# Dev log

What we built, why, and what's left. Newest session first. Add an entry when you land something big.

## 2026-10-17 — Guardians and night drones

Giant spider-like walkers ("guardians") patrol the crash sites, and at night searchlight drones hunt players who are
out in the open.
- **Server** (`server/guardians.ts`, constants in `shared/guardians.ts`): 8 guardians, one posted at each of the crash
  sites nearest the base. They walk loops 25–60 m around their site at 1.8 m/s, sometimes stand guard (turning slowly)
  and sometimes wander to another site within 1 km; they never come within 170 m of the base. Get within 42 m of
  one and it hunts you at 4.4 m/s (you walk 6); if its body gets within 5 m of you, you're crushed (`died`
  cause 'guardian'). At night (sun < −3.4°) up to 2 drones per player out in the desert come in from 260 m, patrol
  20 m up and sweep a searchlight (±37°, 8.6° half-angle). The beam's cone, range and a terrain line-of-sight march
  decide who's lit (`inBeam`). Locked on, it follows you at 6.5 m/s, burns 5 heat/s (`tickHeat` burn → cause
  'beam') and calls every guardian within 420 m. Out of the beam (over a dune crest, into the base, or outrun it)
  for 2.5 s and it lets go. In memory only; ticked at 10 Hz, sent per player as `bots` (within 900 m).
- **Legs** (`src/world/guardians.ts`): client-side procedural IK, the classic multi-legged recipe: each foot has a
  rest spot (14 m out along its hip socket, turned with the body, led by the velocity); a planted foot never moves
  until its spot is 9 m away; then it swings on a sine arc to a point ahead of the rest spot (half the swing's
  travel), following it as the body moves, and lands. Four legs walk one foot at a time (heavy wave gait) and in
  diagonal pairs when hunting; tripods one at a time. Swing time comes from speed so they keep up (0.6–1.5 s). The
  body rides 13 m over the feet's average height on a spring that dips on each landing, tilted to their plane.
  Two-bone IK, knee bent up and out. References: the Spider Walker Blender add-on's step-threshold approach and
  the Vulkan tutorial's foot-placement notes.
- **Feel**: each footfall is a 55→24 Hz thump + rumble + clank, placed in 3D and *delayed by distance at the speed
  of sound* (you hear far steps after you see them), dust puffs, and camera shake within 90 m. A brass horn when one
  starts hunting you; drones buzz; a siren while one has you; a blinking HUD warning.
- **Models**: `tools/blender/guardians.py` → `public/models/guardian.glb` (body ×2, hip, femur, tibia, foot, each
  origin at its joint) and `drone.glb`. Boxes stand in if they fail to load.
- Debug menu (F3): "Guardian here" brings the nearest one 90 m from you; "Drone here" sends a drone for a minute, by
  day too. Drones by night need the shared clock at night ("Apply to all players").
- Gaps: legs pass through wrecks and players (no collision with legs, only the crush under the body); feet stand on
  sand only; guardians don't avoid each other.

## 2026-10-17 — Crash-site debris can be picked up

The debris strewn along each crash trail (hull plates, bent fins, pipe bundles, burnt seats, porthole rings, boiler
tanks, gear housings: 372 pieces over 66 sites) looked like scrap but couldn't be taken. Now F picks it up, aimed with
the look ray like junk-pile scrap (`debrisTarget` in shared/crashsites.ts, 3.5 m reach), and it goes in the bag as
the scrap material it is closest to (`DEBRIS_ITEMS` in shared/items.ts: hull plate → metal sheet, boiler tank →
rusty drum, gear housing → gear, ...), so it counts for gear slots and crafting straight away.
- Same path as the wrecks: ids `d:<site>:<i>` (`CrashPiece.id`, null for the main wreck and dressing), `crashTake`,
  `CrashServer.carry` (reach checked against the piece's pickup sphere), `crashTaken` / `crash_taken`. A taken piece
  isn't drawn and has no hitbox (`collideCrash`), and lies there again 30 min later, like scrap.
- `crashTaken` moved to shared/crashsites.ts (re-exported from shared/crash.ts) so the collision can see it
  without an import cycle.

## 2026-10-17 — Salvage wrecks in the desert (#13–#17)

The salvage models (`public/models/salvage/*.glb`) are now in the game. `shared/wrecks.ts` lays them out
deterministically, one per 300 m cell at most (about 100 over the map), the kind picked by a new `weight` in
`SALVAGE` (shared/salvage.ts): vehicle frames and AI racks are common, jet skis less so, the **warp drive core is
rare** (~7 on the map). They keep clear of the base pad, the machine sites and the crashed spacecraft, and one
vehicle frame (`w:start`) lies ~50 m from the spawn. `src/world/wrecks.ts` draws them with their models out to
450 m and puts a **diamond on the locator bar** (src/locator.ts, needs the wrist computer) for each one within 450 m,
so you can go looking.

- **Same flow as the small crash-site machines**, no parallel one: F says "Pick up …", `crashTake` with the wreck's
  id (`w:ix,iz`), the server's `CrashServer.carry` (now for small sites and wrecks) puts an item of the wreck's kind
  in the bag, the wreck vanishes for everyone (`crashTaken`, `crash_taken` table) and lies there again 45 min later (unlike small machines, which stay gone). Item
  kinds = salvage ids (`vehicle_frame`, `water_jet`, `warp_core`, `ai_control` in shared/items.ts, labels from
  `SALVAGE`, icons the Blender-rendered `public/icons/salvage/*.png`).
- **Disassembly table**: `CARRY_KINDS` includes the salvage ids, so the table offers "Put the broken vehicle
  frame on the table" and the job runs through the same `Bench` / teardown code, parts rolled from `SALVAGE` yields and
  `tierWeights` by `buildJunk` (now taking any `JunkKind` = component or salvage id; `junkSpec()` gives either's
  spec). Parts come out through the same path as the crash-site machines: the server picks the table job's seed,
  `machineParts` / `rollParts` (now any `JunkKind`) give the wreck's part list, and part i goes in the taker's bag.
- **Disassembly structure per wreck** (`src/teardown/wrecks.ts`), laid out like each model: the buggy's battery
  tray (lid, cell straps and leads), seat pan over the chokes (choke bolts from underneath), controller heat sinks,
  hub motors on axle nuts facing out; the jet ski's seat as the bay lid over batteries and the drive motor (its shaft
  coupling only through the intake grate under the hull), a stern hatch over the bilge pump motor; the warp core's
  shrouded fin bank, the compute rack behind a door (rack bolts underneath) and the anti-matter bottles behind a
  field vent; the AI rack's module faceplates, side heat sinks on one coolant loop and the PSU choke under the roof
  hood. Everything is one-player (no lifts) and was checked with a ray replay: every step and part is reachable.
- **Open:** wrecks have no collision (like the small machines, they can be taken, and sim.ts would need that state);
  a carried wreck is just an item (nothing is drawn in your hands).

## 2026-10-17 — Gear: found broken, repaired and upgraded with parts

Instead of crafting tools, you find them broken and fix them. Eight pieces of **gear** (`shared/gear.ts`):
motorcycle, telescope, water bottle, backpack, storm detector, wrist computer, metal detector, shovel.

- **Part slots:** each has 1–3 slots, mostly tiered parts (motorcycle: motor, battery, bearing; water bottle: valve
  plus a drum; shovel: a sheet blade plus a motor; ...). An item's `parts` (new `items.parts` column, JSON) lists what's
  fitted, null where one is missing. Every slot filled = it works. **Quality** is the mean tier of its tiered parts
  (0 Common .. 3 Legendary) and sets what it does: bike top speed 14→26 m/s, telescope zoom 4→12×, bottle 2→6 sips,
  backpack 4→12 slots, storm warning 6→20 s ahead (storms are now announced 20 s ahead), locator range for players
  250→2000 m, detector range 8→22 m, shovel stroke depth/width/rate. A better part dropped on a filled slot swaps in
  (the old one comes back): that's the upgrade.
- **Workbench** (F, or just stand by it with Tab open): the Workbench panel has one slot for the item being repaired
  (the `bench` box, yours) with its part slots under it, and the crafting recipes below. Drag parts onto slots,
  shift-click sends a part into the first slot it fits. Rules live in `tryMove` / `fitPart` / `unfitPart`, run as a
  prediction on the client and for real on the server (`fit` / `unfit` messages).
- **Equipment** (`equip` box: back, wrist, belt, vehicle), at the top of the Tab inventory. Only repaired gear goes in.
  Telescope, water bottle, metal detector and shovel are used from the hotbar instead.
- **Bag size:** the hotbar's 4 slots, plus the backpack's. A backpack can't come off (or be swapped for a smaller one)
  while its slots hold anything; items stranded past a smaller one are shown in red and can only be moved out.
- **No starter kit.** New players start with nothing. Players from before keep their canteen and spyglass (they
  get Common parts so they work) and get a backpack with a Rare gear (9 slots) equipped, once (`gear_kits`).
- **What's gated:** the motorcycle (key 9 for everyone now, but `PlayerState.bike` is 0 without one equipped; the
  server sets it, quality scales `stepBike`), the clock/temperature box and the locator bar (wrist computer), the
  storm beep and banner (storm detector), drinking and refilling (`maxSips` in `water`), digging speed (the server
  digs with the selected hotbar slot, sent with `hands`; bare hands are slow and narrow).
- **Finds** (`server/loot.ts`, `loot` message): broken gear lies at crash sites (4 water bottles, 3 shovels, 3
  backpacks, 2 of the rest), a water bottle and a shovel near the spawn. Each comes with some Common/Uncommon parts
  already in and at least one slot empty. Taken ones turn up somewhere else 3 minutes later. Drawn by
  `src/world/loot.ts` (small stand-in models, a shimmer column over broken gear), F picks up within 2.5 m.
- **Buried caches:** 60 within 1.2 km of the base, 0.5–1.1 m down: mostly parts (weighted towards Common), some scrap,
  sometimes broken gear. The **metal detector** in hand ticks faster and higher the closer the spot you look at is
  (−37 LUFS at the edge of its range up to −28 LUFS right on top, at the default volume; ffmpeg ebur128 on the same
  waveform), with a signal meter under the crosshair. Dig there: once the hole within a cell of the cache is as deep
  as it, it comes up (`LootServer.dug`). About 2.5 s by hand for 0.5 m, 0.5 s with a Common shovel.
- **Batteries** had no source: control cabinets now hold a backup battery (last in their yields and builder, so saved
  bench jobs keep their indexes).
- **Testing:** F3 → "Give gear" puts one of each, repaired with Common parts, in your bag and equipment.
- Gaps: loot is in server memory (a restart lays out fresh finds); no first-person models for the shovel or metal
  detector (the hands stay empty); the find models are boxes and cylinders; caches don't show their contents
  until dug up.

## 2026-10-17 — Crafting, plant beds and UV lamps (issues #21–#24)

- **Crafting at the workbench** (`shared/crafting.ts`): F at the workbench opens the Tab inventory with a
  Workbench panel next to the bag (it also shows whenever the bench is in reach). Recipes: **plant bed** = 3 metal
  sheets, **UV lamp** = 2 metal sheets + 1 wiring coil. Ingredients match groups: clean or dented sheets, a coil of
  any tier (`coil_scrap` … `coil_space`, worst tier used first). The server checks reach and runs the same
  `craft()` on the real bag (`server/items.ts`); a refusal comes back as a `notice` toast.
- **Placeables** (`shared/placed.ts`, `server/placed.ts`, `placed` table): `plant_bed` and `uv_lamp` are items.
  Take one out in the hotbar and a green/red see-through preview follows the crosshair over the bunker floor
  (0.25 m grid; R turns it 90°, left mouse / E puts it down, G picks a placed thing back up). Only on the main
  room's floor, clear of the walls, the hallway mouth, the pump, the stations and the chest; nothing overlaps,
  except that a lamp and a bed share a spot when aligned exactly (the lamp's legs straddle the bed's short ends),
  and aiming a lamp at a bed snaps it over it. The server re-checks everything (plus nobody standing there), and
  the list goes out whole before the snapshot. Placed things **collide**: their floor-standing parts become extra
  capsules in `collideBase` (`setPlacedCapsules`), on both client and server.
- **Plant beds are the garden** (`shared/garden.ts`, `server/garden.ts`, `beds` table keyed by placed id; the old
  `garden` table is unused). F plants an empty bed, F harvests a grown one, as before. **Sprouts only grow under a
  UV lamp** standing over the bed: GROW_MS (6 min) of lamp time and they're grown; without a lamp they wait (the
  prompt says so), with one it shows "Growing under the lamp · N%". Picking a bed up loses its crop.
- **Models and icons:** `tools/blender/placeables.py` → `public/models/placeables/{plant_bed,uv_lamp}.glb` and
  `public/icons/items/{plant_bed,uv_lamp}.png` (the part icons' camera and lights; it imports `items.py`'s helpers,
  now guarded by `__main__`). The bed is a trough of patchwork scrap sheets with soil and two stage objects
  (`plant_bed_sprouts`, `plant_bed_grown`); the lamp a scrap gantry with violet `EmitUV` tubes, a ballast box and
  coiled cable. `src/world/placed.ts` draws them with the bunker's indoor lights plus a violet light pool.
- **Metal sheet (#21)** was already a scrap pickup with an icon; it's now what crafting runs on.
- Gaps: placing works only in the base; harvesting yields nothing yet (no food item); the lamp's light is a fake
  pool, not a real light; growth doesn't count while the server is down.

## 2026-10-17 — Parts are items (issues #8–#11, #18–#20)

- **One item kind per part and tier**, `<part>_<tier>` (`battery_space`, `relay_scrap`, …; `shared/parts.ts`,
  spread into `ITEMS`): the six Blender parts (battery, electric motor, heat sink, compute unit, anti-matter
  container, wiring coil) and the five code-built ones (impeller, bearing, gear, valve, relay), 44 kinds. Labels
  read "Space-grade battery"; `ITEMS[kind].tier` is the rarity (`RARITY`), shown in the Tab inventory as a coloured
  underline and glow, and in the hover text.
- **Icons:** `public/icons/items/<part>_<tier>.png` for all of them. The code-built parts' icons are rendered from
  `src/teardown/parts.ts` by `tools/models/part-icons.ts` (headless Chrome via `part-icons.mjs`), matched to the
  Blender ones (same 3/4 ortho view, suns, outline). The hotbar shows them too.
- **Taking a part puts it in your backpack** the moment you pull it free (right-drag), at crash sites and on the
  disassembly table. Predicted on the client (like a move); the server rolls the machine's contents from the same
  seed (`rollParts`, also what `src/teardown/junk.ts` mounts) and never hands out more of a kind than it holds,
  checks reach, and answers with the bag (toast "+1 …"). **Full backpack:** the part won't come out ("make room
  (Tab)"); if the server refuses one anyway (`partRefused`), it goes back into the machine.
- **The bench job moved to the server** (`bench_jobs` table): putting a carried machine on the table makes the
  server pick its seed, and steps done / parts taken are kept there until the machine is empty, so the client can't
  pick a lucky seed and a job carries over reloads and devices. Old browser-only jobs (localStorage) are dropped.
- The parts tray now lists what you took on this visit (the all-time localStorage tally is gone).
- **Next:** crafting with parts (the workbench still says "Nothing to craft yet"); stacking parts would help the
  12-slot backpack; Blender models for the five code-built parts.
- **Superseded the same day** (merged with the disassembly rework, see "Machines move into the crash sites"): the
  five code-built parts are Blender models now (`tools/blender/items.py`, icons rendered there, `part-icons` tool
  gone); you take a part with a left click and the server answers (`siteTook`) instead of predicting it; the table's
  job is one shared session (`bench_job`, id 'bench') that everyone in the base sees and anyone can work on, not a
  per-player `bench_jobs` row (that table is left unused); the tray is gone.

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

- **Meter** (0–100, `heat`; full = heatstroke): rises above 30 °C felt (was 24), on the same curve the drain used
  (table under "Temperature and shade"). Below 30 °C it falls by itself: full → empty in **40 s** at 22 °C or cooler
  (the base, nights), slower between 22 and 30 °C. A sip from the canteen takes off **25**; 4 sips per
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
  20–40 m it is only ~2.5 dB louder than before. Then +4 dB more (0.2 → 0.32, ~−26 LUFS at 5 m, true peak
  ≤ −9 dBFS) on request: still a background detail, now noticeable.
- `?spawn=crash` starts you just off the nose of the crash site nearest your saved position, facing it.
## 2026-10-17 — Machines move into the crash sites; smoke means "not stripped yet"

The machine sites no longer have their own grid or the two starter sites by the base: every crashed spacecraft
(shared/crashsites.ts) now holds the machines.
- **Layout** (`placeMachines`, its own rng stream so the wreck layout is unchanged): one **large** machine (pump
  housing or jet engine) thrown clear of the main wreck, with 4.2 m of open ground around it so you can walk around
  it, clear of every tall hitbox (all 66 sites pass; the closest is 4.35 m), and 0–2 **small** ones beside trail
  debris (21/28/17 sites have 0/1/2). Ids are `"<crash site id>:<index>"`, 0 the large one (shared/crash.ts
  `machinesAt`, `crashSiteById`, `sitesNear`). The nearest site to the spawn is ~356 m out.
- **Dressing** (Blender, tools/blender/crashsites.py `Crash_Cradle`, `Crash_Skid`; CRASH_KINDS entries with
  `dressing: true`, never picked as debris): a sand berm the machine shoved up ahead of it, thrown-out sand, the
  torn cargo cradle it was strapped into lying behind it (towards the wreck) with snapped straps, a ratchet buckle
  and ripped-out cables trailing back to the wreck; a small furrow mound, strap and bracket under small ones. These
  are draped over the dunes vertex by vertex and merged per material (src/world/crashsites.ts), and their sand uses
  the terrain's sand material, so they sit in the ground on slopes instead of sticking out as slabs. The old
  code-built scorch disc, trench and plates are gone. (A scorch decal was tried and dropped: it vanished under the
  rendered terrain unless lifted well above it.)
- **Smoke = not visited**: every site smoulders (a column from the wreck and one from the ground by the large
  machine) until its large machine has had every part taken. The server counts parts with `rollParts` /
  `machineParts` (now shared in salvage.ts; junk.ts builds one slot per rolled part, checked for 300 seeds of each
  kind), marks the crash site **spent** (`crash_spent` table with a timestamp), and sends `crashSpent` (full list on
  join, then each new one). The client stops feeding that site's columns (puffs born after the stop are not drawn,
  so the plume drifts off), the beeping goes quiet, and the machine is rebuilt as a stripped husk with no prompt.
  The server refuses to open a session on a spent site and ignores part indexes past the machine's part count.
- **Nothing respawns**: spent sites stay spent and carried-off small machines stay gone (the 45 min refill is
  gone); both keep their timestamps in SQLite in case respawns come back.
- `?spawn=crash` puts you 7 m from the nearest site's large machine, facing it.

## 2026-10-17 — Machine sites and disassembly

Wrecked machinery now lies in the desert (shared/crash.ts: deterministic sites, one machine each; two near the
base so there is something to try straight away). These are separate from the crashed spacecraft of the entry
above (shared/crashsites.ts) and share only the idea; the names overlap, so the machine sites live in
`shared/crash.ts`, `server/crash.ts` and `MachineSites` in `src/world/crash.ts`. Walk up and press **F**:

- **Large machines** (pump housing, jet engine) stay where they are. F says "Disassemble": the character walks up to
  3.2 m through the normal input path, the keyboard goes quiet and the disassembly controls take over, in the world,
  no separate scene. Everyone near the site shares one session (server/crash.ts): steps done, parts taken, and
  **lifts** that need two players holding the mouse button at once (pump motor, jet engine casing). First to take a
  part gets it.
- **Small machines** (robot arm joint, control cabinet) are picked up with F and land in the bag as items (kinds
  `robot_arm`, `control_cabinet` in shared/items.ts). Carry them to the **disassembly table** in the bunker (F at it,
  the station from shared/stations.ts) and take them apart there, scaled to fit the table. The table is the
  server's: the job (kind, a seed the server picks, steps done, parts taken) is in SQLite (`bench_job` +
  `machine_progress`), everyone sees the machine on the table and its progress live, anyone at it can help, and
  the table is free again once the last part is out.

Controls, all on the **left mouse**: on a step it works it (click screws and clips, hold and circle big bolts, hold
and swipe across wires, drag pry tabs, hold lifting eyes); on a freed part a **click takes it** (it flies to the
bag); anywhere else a drag turns the machine over (on the table) or looks around (at a large machine). Middle-drag
does the same turn / look, right-drag moves a machine about the table. On the table **W A S D / arrows** turn the
machine and the wheel zooms; at a large machine W / S step closer and further and A / D walk around it. R resets,
Esc (or the Leave button) leaves. `?debug` lets one player do the two-player lifts.

The UI (redone after "confusing, hard to use"): one panel at the top with the machine, its rarity, steps and parts
progress bars, a **"Next:"** line (take the freed part / the most common ready step on the side you look at / "turn
it over: 3 more on another side") and the four keys that matter. A tip by the pointer names the thing under it and
the exact action ("click ×3 to unscrew", "hold and circle to unscrew"), or why it is locked ("Remove the lid screw
×4 first"), and the blockers light up white on the machine. A radial ring shows a step's progress (a dashed guide
circle for bolts), freed parts carry a rarity-coloured tag, events are a short line above the hotbar. At the
**disassembly table the camera swings to a fixed three-quarter view above the table** (0.7 s ease in and out,
pointer rays use it) instead of the first-person walk-up view; large machines keep the walk-around view. The parts
tray and its localStorage store are gone: taken parts go to the bag (`TeardownView.onTake` / `applyTook`).

Code: `src/teardown/junk.ts` builds the machines and their steps, `teardown.ts`
the mode (walk-up, input, loose-piece physics, session link), `ui.ts` the panels, `src/world/crash.ts` the
sites, wreckage and the table job. Netcode: `crash*`/`site*` messages in shared/protocol.ts.

- **Fasteners follow the engineering**: bolt circles on round flanges (pump suction cover, robot top cover), corner
  screws on box lids (mids on long ones), a row down each side of the jet engine's split casing, set screws on
  coupling hubs, a supply cable through a gland to a terminal block via a contactor (live in, live to motor, neutral,
  earth, coil), harness cables from round connectors to the starter, valve and igniter. Prerequisites make sense:
  drain the pump before opening it, cut wires before the mount bolts, guard before coupling. Hardware is only built
  for parts the machine actually rolled, so nothing is a decoy.
- **Rarity** = part tier (`RARITY` in shared/salvage.ts). Each machine rolls its parts from `COMPONENTS` using its
  `tierWeights`, seeded by the site, so every player sees the same contents; the best part sets how fancy it looks.
- **Mechanical parts** (impeller, bearing, gear, valve, relay) are Blender models in `tools/blender/items.py` like
  the other items, four tiers each; they lie with their axis along +y so `Kit.ax` can mount them on a shaft.
- **Parts are items.** `shared/machine.ts` `machineParts(kind, seed)` rolls a machine's parts (no three.js), so
  the client mounts part i as the slot with `index` i and the server knows what part i is. The first to take a
  part gets item `${part}_${tier}` (e.g. `motor_basic`, "Motor (Uncommon)", shared/items.ts `PART_ITEMS`) in their
  bag, in one DB transaction; with a full bag it is refused ('siteTook' ok: false) and goes back on the machine.
  Inventory icons: the rendered PNGs, framed in the tier colour.
- **Progress never resets.** Every machine's steps done and parts taken (large sites and the table) are kept in
  SQLite for good and sent to everyone: 'sites' on join, then siteDone / siteTake to all players, so a machine
  you walk up to later is fast-forwarded to it. `CrashServer.resetSite(id)` makes one whole again (dev/admin
  only; nothing calls it).
- Not done: the server checks part indexes against its own part list but not whether a part's holds are done
  (step indexes are only range-checked; lifts are checked against the holders). The tray only lists this
  session's takes (the items are in the bag).
- Idea taken from the Godot DOHOJAM teardown: parts stay locked until the earlier steps are done.

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
  **30 °C** (was 24) the meter rises at `100/60 s × ((felt − 30) / 24)²`, ×1.5 sprinting (was `/100 s`, fourth power:
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
  brake/reverse, A/D steer, Space held pulls a wheelie and hops on release; the mouse just looks around and the camera turns with the bike.
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
  - The wind slowly erases them: every 5 s the server moves each edited point 3 mm + 1/64 of its
    offset back toward the original dunes (`heal` in `shared/dig.ts`). A 1 m hole is gone in ~12 min.
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
- **Real fingers + grasping (spyglass grip fix):** the viewmodel glove now has 3 bones per finger and a
  3-bone thumb. Held items are posed by closing the fingers on the object's distance function until they
  touch (GraspIt!-style), with the spyglass in a Napier power grip: oblique across the palm, thumb over the
  fingers, wrist in line with the forearm. The old pose pointed it ahead along the forearm, which a fist
  can't do, and sank it 1 cm into the palm. How-to and the anatomy in `docs/viewmodel-hands.md`.

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

