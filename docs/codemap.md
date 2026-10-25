# Code map

Where each system lives, file by file, grouped by area. CLAUDE.md has the short version; this is the detail. The
numbers here are a snapshot to orient you: the code is the truth, so check it before relying on one, and fix this file
when you find it stale.

## Core

- `shared/sim.ts` — deterministic movement/physics, run by **both** client and server (docs/netcode.md)
- `shared/protocol.ts` — WebSocket message types
- `src/main.ts` — entry: renderer, scene, fixed-step game loop
- `src/net.ts` — client netcode (prediction, reconciliation, interpolation, reconnect)
- `src/input.ts` — keyboard → input bitmask
- `src/gamepad.ts` — gamepad (third-person shooter layout): presses the keys bound to each action as synthetic key
  events, so rebinding and every key reader just work; right stick → `FirstPersonCamera.look`; layout in its header. In
  the inventory a drawn cursor (`src/padCursor.ts`) sends synthetic pointer events, so it works as with the mouse.
  `src/uiNavigation.ts` handles keyboard and controller focus, sliders, back actions and controller text entry on
  the landing page and all menus; `src/uiFocus.ts` chooses neighbours from their screen bounds at any UI scale.
  `src/padMap.ts` — the pad's buttons (read by the pad code and by the hints). Control hints:
  `src/bindings.ts` `kbd`/`ctl`/`hintKeys` name keys or pad buttons for the device last used (docs/text.md)
- `src/uiScale.ts` — the menus' and inventory's size: `--ui`, from the window's size times Options → Interface size,
  taken as CSS `zoom` by the panels it lists. In a zoomed panel write `calc(100vw / var(--ui))` for viewport units,
  and convert pointer px to `left`/`top` with `uiScale()`
- `src/comfort.ts` — validated, persisted camera/input and readability settings: independent mouse/stick axes,
  inverted look, FOV, motion, glare/grain, HUD and subtitle presentation; edited in `src/options.ts`.

- `desktop/` — the desktop app (Electron; docs/desktop.md): the web build in a window, the first step towards Steam.
  `desktop/update.mjs` keeps its game files at the server's build, from `dist/manifest.json` (`tools/manifest.ts`).
  `src/desktop.ts` — the game server's address when the page isn't served by it (`PAGE_URL`). Built by
  `.github/workflows/desktop.yml`

## Worlds, server and players

- `shared/world.ts` — worlds: each game is its own world at its own URL (`?w=<id>`, made on the landing page,
  `src/landing.ts`), with a seed from its id, its own players and DB (`data/worlds/<id>.db`; the old world is
  `?w=main`), and 10 shared lives (`src/lives.ts`; +10 per boss kind beaten); at 0 the game is over. Games are public
  (in the main menu's browser) or private (link or code), with a max of players and maybe a password
  (`server/registry.ts`, `data/registry.db`); a game's URL opens its lobby first (`src/lobby.ts`)
- `shared/look.ts` — a player's look: the piece in each slot of the scavenger (hood, eyes, mask, scarf, cape, shoulder,
  gloves, boots), the dyes of the robe, hood and wraps and the body's drawn height and head size (`bodyScale`, docs/character.md), packed in one number. Chosen on the main menu's Character view
  (`src/lookView.ts`, its own little renderer), kept in the browser (`src/profile.ts`), sent in `hello`, relayed in
  `PlayerSnap.look`; drawn by `src/models/scavenger.ts` `setLook` (the chosen pieces merged with the body, one mesh per
  material; the pieces are meshes in scavenger.glb, `tools/models/scavenger.py` LOOK_MESH; the dyed cloth is baked pale)
- `shared/names.ts` — names others see (game names, player names): allowed characters and the slur/swear filter
  (`obscenity` + our list), checked on the client as typed and by the server. Your name and colour are chosen in a
  game's lobby (`src/profile.ts`, remembered by the browser as the default), sent in `hello`; a name is required (server
  closes 4422). They're fixed per game after the first join (`server/world.ts` `join` keeps the stored ones)
- `server/index.ts` — front server: static files, `POST /api/worlds` (make a game), `GET /api/browse` (public games),
  `GET /api/worlds/<id>` (lobby), `POST /api/worlds/<id>/key` (password -> key), `POST /api/worlds/mine` (the landing
  page's list of worlds this browser joined, kept in localStorage by `src/landing.ts`, with your name and play time
  there), passes `/ws?w=<id>&k=<key>` through to the world's process (4403 locked, 4429 full)
- `server/world.ts` — authoritative game server for one world (forked per world, exits when empty); `server/db.ts` —
  SQLite; `server/scrap.ts` — scrap pickups, respawn
- `shared/pods.ts` — the crashed escape pod(s) players arrive in (new players and the dead without a bedroll appear
  beside the hatch of "their" pod, `podOf(browserId)`: `podSpawn`, `spawnPoint(n)` in shared/sim.ts): each pod in the
  world (`podPlaces`), collision (`collidePods`), shade casters, the water tap on each hull (`atPodTap`, through
  shared/wells.ts `waterAt`), a starter machine by each (`podSites`, ids `pod:<n>`, through shared/crash.ts; kinds
  `POD_MACHINES`, no winch: no bearing before the workbench) and loot spots (`POD_LOOT`, server/loot.ts: a starter kit
  kept whole, an older kit's surplus cleared on load). The kit's pod console and power box (`pod_console`,
  `pod_powerbox`) are carried machines (shared/salvage.ts COMPONENTS, never at crash sites) holding the first wiring and
  the first bike's battery: models `tools/blender/finds.py` → `public/models/finds/pod_*.glb` (lying, and the icons),
  on the bench `podConsole` / `podPowerbox` in src/teardown/junk.ts. Their spots (a cluster picked per world 37–67 m from the origin), the keep-clear
  that hugs each hull (`nearPod`), the layout's keep-off (`onPodGround`) and the furrows in the terrain:
  `shared/podSpot.ts`; model `tools/blender/pod.py` → `public/models/pod.glb` + generated `shared/podModel.ts` (one
  model in four poses, a drogue chute behind one); drawn by `src/world/pods.ts`. Old worlds: `server/podsLanded.ts`
  (once: things in a pod's way moved out, the first bike by the pods, the gone pump shelter's things back on the sand)
- Bedrolls (`bedroll`, shared/placed.ts) and spawn points — each player has at most one spawn point, a bedroll
  (anyone's), where they wake up after dying (`homeOf` in server/world.ts; none: where players arrive). Laying a
  bedroll makes it yours; F on one toggles it (`spawnToggle`, server/placed.ts `toggleSpawn`; `spawns` table, browser
  IDs server-side only). Only a bedroll's owner picks it up; taking one up clears it for whoever slept there. Each
  player alone is told theirs (`spawn` message): a lantern by its pillow (src/world/placed.ts), the locator's home
- `shared/lab.ts` — the dev test lab (`?w=lab`, `LAB` in shared/world.ts: flat floor at y 0, no desert or events; laid out
  from its own spot `LAB_AT`, world (0, 0), you start at `LAB_SPAWN`; layout of the machine sites `lab:<n>`, pickups and plates); drawn by `src/world/labPlates.ts`, pickups via `server/loot.ts`
- `src/artBench.ts` — the art-style bench (`?w=bench`): the desert from a fixed seed with no events, fixed camera shots
  at set times of day (`[` `]`), a panel tuning the global look live (tone, grade, bloom, light, sky palette keys,
  haze, sand/rock/mud colours; hold `\` for the defaults), exported as JSON or a diff naming where each default lives
- `shared/ragdoll.ts` — dying: you lie where you fell for `DOWN_MS` (input ignored, third-person camera) as a
  Verlet ragdoll (`src/models/ragdoll.ts`) thrown by the killing blast's push (`blastPush`), then respawn
- `shared/corpse.ts` — dying leaves the bag past the hotbar in a pack where you fell (shared box `corpse<id>`,
  take-only, 30 min); `server/corpses.ts` makes/expires them, `src/world/corpses.ts` draws the bundle and rag flag

## Terrain and biomes

- `shared/rocks.ts` — rock formations (mesas, buttes, pillar fields, carved hills, jagged peaks, boulders; now and then a
  giant) placed by a rockiness noise, the kind by a regional style noise; part of `baseHeight` (max with the dunes).
  Steep rock is a wall in `step()`, craters stop at rock, `rock` attribute paints them in `src/world/sandMaterial.ts`
- `shared/canyons.ts` — canyons: Grand Canyon-scale gorges (8–14 km long, 220–400 m under the dune floor, up to
  ~1.5 km rim to rim, terraced walls, buttes, side canyons) cut through a raised sandstone tableland, open at their
  ends; part of `baseHeight` (`ground` in shared/terrain.ts: the tableland adds rock, the gorge cuts to bare rock walls
  over a sandy floor with dried mud, its floor rocks from `canyonRockHeight` in shared/rocks.ts; `rockTop` for the
  rock). A biome (`CANYON` in shared/biomes.ts, weight `canyonCover`). Walls and rock tint follow the rock column
  `shared/strata.ts` (formations by height: colour and hardness, cliff or slope), shaded in `src/world/sandMaterial.ts`
- `shared/biomes.ts` — biomes: kinds of country met further out the further you go, one common concept: each is an
  entry in `BIOMES` (in order of precedence: earlier ones claim the land first) with its placement (`place`, weight
  0..1) and its properties (`groundHeat`, `haze`, `empty`...; new per-biome things like finds or enemies go there).
  Read them with `biome(id, x, z)`, `biomeAt` or `blend` (a property mixed by weight). Biomes so far: canyons
  (`shared/canyons.ts`, first) and mud flats (dried lake beds: noise blobs (`blobs`) — no dunes (`duneHeight`), next to
  no rocks (`rockiness`), cracked clay via the per-vertex `mud` attribute in `src/world/sandMaterial.ts`, hotter by
  day). Noise primitives and the seeded PRNG (`mulberry32`) in `shared/noise.ts`; per-cell layouts (rocks, canyons) are
  cached with `cellCache` (`shared/cellCache.ts`, bounded for the server)
- `shared/scrap.ts` — deterministic scrap-pile layout + hitboxes (collided in `step()`, drawn by `src/world/scrap.ts`);
  pieces give one of the two basic materials, `scrap` or `cloth` (shared/items.ts `SCRAP`/`CLOTH`)
- `shared/shelters.ts` — small empty bunkers (small/deep/long) scattered mostly in rocky country: placement, pad,
  collision, pumps (`atWater`), stash spots, `indoors()`/`sandHidden()`; none within 350 m of the origin; drawn by
  `src/world/shelters.ts`

## Weather and survival

- `shared/sun.ts` — day clock + sun elevation (client sky and server heat); `shared/water.ts` — thirst/canteen; where
  it fills: `shared/wells.ts` `waterAt` (a pump, or a running electric well)
- `shared/health.ts` — health (`HEALTH_MAX`), apart from heat: blows go through `hurt` in server/world.ts (a shield
  takes each one whole), heatstroke, choking and vortices take it all (`die`); server-side only for now
- `shared/temperature.ts` — air/felt °C by time of day (drives thirst); `shared/shade.ts` — sun ray march (shade;
  counts huts, wrecks, players and bikes, built tarps)
  tuning, drained and validated in `server/water.ts`, HUD + `playerHands` in `src/water.ts`
- `shared/storm.ts` — local sandstorms (path, strength, warning) and rare world-wide storm fronts (mega-storms: choke
  you in the open, `sheltered` = a shelter or the lee of rock; death tally in server/world.ts); scheduled by
  `server/storm.ts`, heat in `server/water.ts`, beep/banner/locator in `src/storm.ts`, dust columns and the front's wall
  in `src/post.ts`
- `shared/gas.ts` — poison gas (night weather, scheduled with the storms in `server/storm.ts`): a low cloud creeping
  in, rising to `GAS_DEPTH` over the dune floor (`duneFloor`, shared/dunes.ts), so climb a big dune or rock; it fills
  shelters; chokes in `GAS_S` (`gassed` in server/world.ts); no effect on electronics. Client `src/gas.ts`, drawn in
  `src/post.ts`
- `shared/vortex.ts` — sand vortices: a seeded field over the whole desert (3 km squares, some with a vortex circling
  inside for ever on the wall clock, none near the pods), found near a point with `vorticesNear` (the server's
  `StormServer.vorticesNear` adds the debug menu's summoned ones; the clock's zero comes with the storms); faster heading
  downwind; the drag (`vortexPull`, fed to `step()` like the storm's push), death in the core (thrown high,
  server/world.ts), drones dragged in and torn apart (server/drones.ts `whirl`). Client `src/vortex.ts` (wind, grit) and
  `src/vortexSound.ts` (its roar), drawn in `src/post.ts` (its own reduced-resolution pass, the nearest one). Debug
  menu: summon one, go to one

## Home, buildings and power

There is no starting base: players arrive in the crashed pods (shared/pods.ts, above) and build what they need, anywhere.
Everything built is shared, and anyone can take a building down.

- `shared/origin.ts` — the world's origin (`ORIGIN`, picked per seed: where the first bunker stood), which the layout is
  measured from (site levels, the scrap fields, the pods' spots, keep-outs round the start, the flying wing's odds); it
  stays put so every world keeps its layout. `originClear` is the ground round it the layout keeps clear
- `shared/capsules.ts` — vertical capsule collision (`collideCapsules`, the arch/vault helpers the shelters use) and the
  grid of 16 m cells holding everything put up (`setPlacedCapsules`, `collideOutdoor`, `overPlaced`: never dug), in
  world coordinates
- `server/bunkerGone.ts` — once per world (settings `bunker_gone`): what was kept in the old bunker comes out (its chests
  into new chests by the spawn, the machine on its table, repair slots back to the bags, things on its floor back to
  their owners or moved out onto the sand, players and vehicles in it to the spawn)
- Buildings — the windmill, the battery station, the power pole, the beacon, the tarp, the well, the workbench, the
  dismantling bench and the chest, anywhere on the sand: put up with the wrench (made by hand; right mouse with it in
  hand opens the build menu, `src/buildMenu.ts`, placing in `src/placing.ts`)
  from base materials only (scrap, cloth, wiring: `shared/tables.ts` BUILD_TABLE, `shared/crafting.ts` BUILDS), used up
  as it goes up and all given back when it's dismantled (G with the wrench); never carried as items. The windmill and
  station are gear with part slots and quality (`shared/gear.ts` `built`), standing with their slots empty (bearings
  and motor, batteries fitted after), placed via `shared/placed.ts` (`sand` kinds: `gap` between them,
  `STRUCTURE_GAP` from the shelters' huts, `POD_GAP` (0.8 m) off a crashed pod's hull (`nearPod`); where it goes by where you stand, `placeFloor`: the `floor` kinds also on a shelter's room floor,
  `shelterRoomClear` in shared/shelters.ts; collision in shared/capsules.ts); while standing, the item is in box
  `bld<id>`, whose parts are swapped in place (F, `src/inventory.ts` `part:<box>`); drawn by `src/world/placed.ts` (lit
  by the sky or a shelter's fill, by where it stands; materials `src/world/glbMaterial.ts`), models
  `tools/blender/placeables.py`
- Work stations and chests built with the wrench (shared/placed.ts `WORKBENCH`, `TABLE`, `CHEST`; models
  `tools/blender/stations.py` with the builders in `tools/blender/stationkit.py`, which also makes the shelters' hand
  pump, `public/models/pump.glb`) — `shared/stations.ts` `stations()`: every placed one; any workbench opens the repair
  slot ('bench', each player's own) and its recipes, any dismantling table takes carried machines apart
  (shared/crash.ts `tables()`, a session per table, `bench<placed id>`; server/crash.ts keeps a job per table,
  `bench_jobs`); a chest is box `store<placed id>` (CHEST_COLS × CHEST_ROWS, shared). A table with a machine on it or a
  chest with anything in it can't be taken down (server/world.ts onUnplace)
- `shared/garden.ts` — plant beds (stages, look target), owned by `server/garden.ts`; beds and UV lamps are placed
  things that stand on a shelter's floor only (not crafted for now)
- `shared/trophies.ts` — the bosses' trophies, buildings like the others (kinds `trophy_<boss>`, `TROPHY_PLACEABLES` in
  shared/placed.ts, no cost in shared/crafting.ts BUILDS): in the wrench's build menu once their kind is beaten and while
  not up (`trophyFree`: one per kind per world, checked in server/world.ts onBuild); anyone takes one down with the wrench
  and it's back in the menu. Footprint and boxes from the model's real shape (`POSTS`, recentred: `CENTRE`). Models made
  from the bosses' glbs by `src/world/trophies.ts` and handed to src/world/placed.ts (`provide`). Winning doesn't need
  them standing
- Beacons (`beacon_light`, shared/placed.ts `BEACON`) — a lamp on a mast that shines a column of light into the sky, a
  marker: built with the wrench like the others (scrap, wiring), `MAX_BEACONS` of their own; one battery slot. Powered like a load on the grid (shared/power.ts `BEACON_W`, `draw`;
  server/power.ts): wired, it runs on the windmills, then on every battery on its grid (and the grid charges its battery);
  alone, its own battery runs flat (a Scrap one ~2 real hours). Dark without power (`PowerState.lit`). R in view of one
  cycles its colour (`BEACON_COLORS`, 8; src/placing.ts, `beaconColor` message), kept in its item's ItemData `color`.
  Model made in code and every beam in one instanced draw (a camera-facing quad per beam that widens with distance):
  `src/world/beacons.ts`
- Tarps (`tarp`, shared/placed.ts `TARP`) — shade you build: an 8 m canvas pyramid on a 4.6 m centre pole, corners
  staked low, one edge up on a short pole as the doorway; wrench-built (3 cloth, 2 scrap), four turns (R: which way the
  doorway faces); the poles and the canvas lower than a head collide (you go in by the doorway; bedrolls, chests,
  benches fit inside: `shelteredBy`), and the camera stays on its side of the canvas. The rig (peak, corners, doorway, stakes, each over its own
  sand) and the canvas's shape are `shared/tarp.ts`, used by `shared/shade.ts` (the canvas as a fan of triangles: inside
  is shade for the heat, low sun included) and by `src/world/tarps.ts` (model made in code; the canvas billows in
  `windSpeed` in a TSL vertex shader)
- Electric wells (`well`, `shared/wells.ts`) — a borehole with a submersible pump, water at home: built with the wrench
  (scrap, wiring), gear with three slots (motor, valve, relay: `GEAR.well`), wired to a grid. Its control box is a small
  load all the time (`WELL_IDLE_W`, lamp lit); it runs (`PowerState.wells`, `setWellsOn`) while its grid could give the
  pump `wellSpec().watts` right now (wind left over, or a bottle's worth in the batteries), and each bottle filled
  takes that out of them (server/power.ts `pump`). The canteen fills at its spigot (`waterAt`: a pump or a running
  well, the fill time by the parts; server/water.ts `fill`, src/water.ts); no water table, it goes wherever a building
  can. Drawn with its lamp, wet patch and drip in `src/world/placed.ts`, hum and pump in `src/wellSound.ts`; the
  character remarks on a dry one (`src/speechLines.ts` `well.dry`). Model `tools/blender/well.py`
- `shared/power.ts` — electricity, somewhat realistic in game time (`GAME_SPEED`: a game day is 30 real min): the
  shared wind (`windSpeed`: day cycle, weather, gusts, storms), windmill output (½ρAv³·Cp·η by bearings/motor,
  furling) and rotor speed, battery stations (per-battery kWh by tier, a Scrap battery = a car battery, 0.6 kWh; coils
  = the charger) and charging; `server/power.ts` runs each grid (what is wired together) each second, keeps each
  battery's charge live and saves it in the battery itself (its ItemData `charge`, fitted in the station), catches up the time the world slept; the panel shows W / kWh (`src/inventory.ts`),
  cells' lamps the charge
- `shared/wires.ts` — power lines: connectors (`CONNECTORS`, a socket ~3.2 m up on each electric thing; the power
  pole, scrap, is one up at 4.5 m), a wire per wiring coil (used up; its tier is its reach, `COIL_REACH`), `grids()`;
  strung with a coil in hand, click a connector then another, right-click cancels (`src/wiring.ts`); `server/wires.ts`
  (`wires` table), drawn by `src/world/wires.ts`

## Loot, items and gear

- `shared/tables.ts` — every loot table and crafting recipe (machine/wreck yields, world finds, caches, kill drops,
  workbench recipes, HAND_TABLE (made by hand anywhere: the wrench), BUILD_TABLE, BOSS_SPOILS, HARVESTER_SPOILS) as plain data; tune drops and recipes there.
  `shared/lootRoll.ts` — the dice that roll them in the world (caches, stashes, finds and where they lie,
  kill/jet/harvester/boss drops), shared by the server and the economy simulator (`tools/econsim`, docs/econsim.md)
- Item data — one item's own state (`ItemData` in `shared/items.ts`: a battery's `charge`, a shield's `worn`), one
  JSON `data` column; it goes wherever the item goes, and items with any never stack. Fitted parts keep theirs in
  `data.fitted` (`partAt` / `setPart`)
- `server/itemMigrations.ts` — items saved by older versions made current as their box loads (`migrateBox`);
  `server/grants.ts` — one-off gifts to players from before a change (the backpack, the rifle)
- `server/items.ts` — item stacks in boxes (bag, equipment, workbench, bike, chests: `shared/items.ts`,
  `shared/storage.ts`), Tab overlay in `src/inventory.ts`. Box ids and each kind's traits (own or shared, grows,
  fitted, take-only) are in `shared/boxes.ts` (`BOX_KINDS`); what depends on the world (size, label, shape) is a
  `Record<BoxKind, ...>` in `shared/storage.ts` and `shared/gear.ts`, so a new kind of box is added in those places
- `shared/gear.ts` — gear found broken and repaired with parts at the workbench (part slots, quality, what each does);
  `shared/moves.ts` the move and repair rules for client and server (tryMove, fitPart, unfitPart, boxShape);
  `shared/gearBits.ts` what others see worn and carried (wornGear, carriedGear, gearTiers); `shared/loot.ts` + `server/loot.ts` — finds and caches in the world, drawn
  by `src/world/loot.ts`. Every model of gear shows its tier (quality rounded down: rust → as made → polished brass →
  pale with a cyan sheen), `src/tierLook.ts` `applyTier`; others see it via `PlayerSnap.tiers` (`gearTiers`). The
  shield plate (Armor slot) takes one killing blow, then breaks (`shielded` in server/world.ts, `src/shieldFx.ts`)

## Crash sites and machines

- `shared/crashsites.ts` — deterministic crash-site layout + hitboxes; sites have a level by distance from the origin
  (`SiteLevel`: 0 scrap fields with starter machines/gear, 1 crawlers, 2 guardians + rarest parts; outposts are level 1
  sites among the scrap fields, 1–2 crawlers, loot in between: `LootLevel`) that picks their wrecks, machines
  (`LEVEL_KINDS`, shared/crash.ts), finds (server/loot.ts) and walkers (`shared/crashKinds.ts` is generated by
  `tools/blender/crashsites.py`); drawn by `src/world/crashsites.ts`, heard via `src/crashSound.ts`. Each site holds
  machines to take apart (`machines`): `shared/crash.ts` gives them ids/kinds, `server/crash.ts` sessions and spent
  sites (`crash_spent`) and visited ones (`crash_visited`: something picked up there, its smoke stops), `src/world/crash.ts` + `src/teardown/` the disassembly. The machine pipeline: docs/machines.md

## Enemies

- `shared/enemies.ts` — the registry of everything a player can destroy and loot (crawlers, guardians, drones, jets,
  the harvester, the bosses): how many come at once, where they're met, what one leaves (`drops`: the server's kill
  drops go through it) and rough fight odds by weapon (read by the economy simulator; tune them there)
- `shared/guardians.ts` — walkers (rare giant guardians with cannons, player-sized crawlers at crash sites) + night
  searchlight drones (constants, beam test); walkers, bolts and missiles simulated in `server/guardians.ts`, which ticks
  the drones (`server/drones.ts`; their beams call the guardians, `alert`), what both share in `server/bots.ts`; legs
  are client IK in `src/world/guardians.ts`, bolts `src/world/bolts.ts`, drones `src/world/drones.ts`, glue/sound/shake
  in `src/guardians.ts`, `src/guardianSound.ts`
- `shared/jets.ts` — fixed-wing drones: high fast flyovers (straight or big circles), day and night; 3 rifle hits and
  it glides down; scheduled by `server/jets.ts`, drawn by `src/world/jets.ts`, roar in `src/guardianSound.ts`
  (`jets`). Two kinds (`JetKind`, shared/jetbreak.ts): the fixed-wing drone (MQ-9-like, 18 m span, no engine: its
  wreck drops parts, `DRONE_JET_SPOILS`, `tools/blender/machines/dronejet.py` -> `dronejet.glb` +
  `shared/dronejetpieces.ts`) and the stealth flying wing (`tools/blender/machines/plane.py` -> `jet.glb` +
  `shared/jetpieces.ts`); the wing's odds grow with the distance from the origin, 0 to 80% at 10 km (`WING_ODDS`,
  server/jets.ts). Down, it comes apart on impact (`shared/jetbreak.ts`: each piece (`PIECES_OF[kind]`) flies,
  tumbles, bounces and settles on the sand, splashing it; deterministic, so the server and every client run the same),
  and when they lie still a permanent crash site is made (`shared/jetcrash.ts`, `server/jetcrash.ts`, in the world's
  DB, pieces solid via their own capsules): each of the wing's engines (80% tear off, 30% of those are wrecked in the
  landing) is a `jet:<n>:<k>` machine to take apart (the turbofan; jet engines hardly lie anywhere else)
- `shared/harvester.ts` — the harvester: a building-sized tracked monolith of the mud flats, rising out of the mud and
  crawling a route that keeps to the flat (pose is math on the route, its pace stretches and the server clock); ignores
  everyone but whoever it sees ahead (a wedge), whom it turns towards, charges and runs over; killed only by shooting
  the three cores in its maw; brain `server/harvesters.ts`, view `src/world/harvesters.ts`, sound
  `src/harvesterSound.ts`, model `tools/blender/harvester.py`, spoils `shared/tables.ts` HARVESTER_SPOILS

## Bosses

- `shared/bosses.ts` — bosses (one-of-a-kind giants with health, weak points to shoot that regrow, HUD bar
  `src/bossBar.ts`): called with receivers (gear: uranium cell + an enemy's part, `RECEIVERS`/`RELICS`; `onCall` in
  server/world.ts, needle `src/receiver.ts`) or F3; every kind beaten wins the world (`beaten` in server/world.ts,
  trophies `src/world/trophies.ts`). `server/bosses.ts` spawns and ticks one brain per kind, `src/bosses.ts`
  interpolates them and handles the weak points; spoils in `shared/tables.ts` BOSS_SPOILS. Shared by the brains:
  delayed blasts (`server/blasts.ts`: due, blast, ball, column) and players' smoothed velocities (`server/tracks.ts`
  Tracks, also the crawler packs')
- Each kind follows one pattern: numbers in `shared/<kind>.ts`, brain `server/<kind>.ts`, view `src/world/<kind>.ts`
  (built on `src/world/bossParts.ts`), sound `src/<kind>Sound.ts`, model `tools/blender/<kind>.py`. The kinds:
  - worm — 200 m, swims through the sand, bursts out under prey, charges half out of it, or flies a huge arc firing
    missiles from its back; Terraria-style head steering, segments follow its path
  - carrier — the hive carrier: huge four-fan drone that bombs from its belly, fan hubs are its weak points
  - queen — the brood queen: giant eight-legged spider (gait, rear-and-slam numbers); the server steps the feet and
    simulates the spiderlings it drops from its sac (drawn by `src/world/brood.ts`); leg IK in the view
  - colossus — 67 m biped (rig sizes, gait, stomps, snapshot layout); the server has the feet, footprint craters, big
    stomp and fall furrow; leg IK and the death topple in the view

## Weapons and tools

- `shared/rifle.ts` — the laser rifle and the cheaper one-handed laser pistol (`GUNS`; gear found broken and repaired,
  shared/gear.ts; model `tools/models/pistol.py`), the walkers' red weak points (all shot: it dies) and drone hits;
  aim, sway, recoil, scope and the hitscan in `src/rifle.ts`, beam/sparks/smoke `src/world/zaps.ts`, sounds
  `src/rifleSound.ts`, targets and the collapse in `src/world/guardians.ts`, checked by `GuardianServer.shoot`
  (server/guardians.ts) and `DroneServer.shoot` (server/drones.ts)
- `shared/jammer.ts` — the jammer (gear, found broken and repaired): hold it 3.5 s on a jet or drone in its cone and it
  glides down whole; the lock is added up by `onJam` (server/world.ts), aimed and heard in `src/jammer.ts`, model
  `src/models/jammer.ts`
- `shared/throw.ts` — thrown scrap (any scrap item in hand, use button): flown and struck against drones in
  `server/throws.ts`, lands as loot; drawn and thrown in `src/throw.ts`
- `tools/models/hands.py` — first-person hands + held-item clips (docs/viewmodel-hands.md)
- `tools/blender/icons.py`, `tools/icons/` — inventory icons for what has no Blender model of its own (scrap, cloth, the
  wrench, the carried machines, dumped from their three.js models); every icon's look and size: `docs/icons.md`

## Text and speech

- `shared/text.ts` — every player-visible text (`TEXT`): names of things, prompts, notices, menus, hints, step labels,
  speech; rules in `docs/text.md`
- `src/speech.ts`, `src/speechLines.ts` — the character's subtitled remarks: engine + when each line is said (event,
  condition, once/again; the words are in `TEXT.speech`); guidelines in `docs/speech.md`

## Audio and measurement

- `src/audio.ts` — shared audio context, volume buses, warning ducking, finite-sample guard and post-limiter capture;
  `src/audioWorklet.js`, `src/limiterKernel.mjs` — stereo-linked look-ahead limiter with intersample peak detection
- `src/acoustics.ts` — placed sounds, distance/air filtering, shared reverbs and echoes; `src/audioBudget.ts` bounds
  transient voices/echoes, and `src/obstruction.ts` caches conservative line-of-sight attenuation
- `tools/audio-bench.html`, `tools/audio-bench.ts`, `tools/audio-measure.mjs` — real browser sound graphs captured
  after the limiter, measured by FFmpeg; scenarios, target levels and recorded results in `docs/audio.md`

## Rendering and performance

- `src/world/heightShadow.ts` (dune shadows from the heightfield, not the shadow maps), `src/world/cascades.ts`
  (cached cascades: redrawn only when needed; they hold only things: players, wrecks, the pods, bosses),
  `src/world/shadowLod.ts` (small casters left out of far cascades): see `docs/perf.md`
- `src/perf.ts`, `tools/perf.ts` — CPU/GPU frame timing (stats graphs, User Timing for traces) and the automated
  benchmark run (`npm run perf`: waits for the game to be playable, walks a route, writes JSON + a Chrome trace to
  `data/perf/`); `tools/trace-report.py` reads Chrome performance traces; read `docs/perf.md`
- `tools/bench/` — the CI benchmarks (`npm run bench`, `.github/workflows/bench.yml`): world generation, physics and the
  enemies in Node (`cases/`), the world server under bot load (`server.ts`, `serverHook.ts`), the client in headless
  Chrome (`client.ts` driving `tools/perf.ts --software`), two commits in turns and compared (`stats.ts`); read `docs/bench.md`
- `src/telemetry.ts`, `server/telemetry.ts` — stall tracing to `data/telemetry.jsonl` (docs/netcode.md "Telemetry");
  read it with `node tools/telemetry.ts` (digest + HTML report, or `tail`)
