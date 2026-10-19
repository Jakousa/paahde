# Dev log

What we built, why, and what's left. Dated sessions newest first, then undated topic entries (oldest first, 17–19 October). Add an entry when you land something big.

## 2026-10-19 — Steps and parts left, scrapping the frame, Options tabs

- Near a machine (the table's, a field machine being worked, or a small one you could carry) a small pill at the top of the screen
  shows its name and `N steps · M parts` left (`TeardownUi.setCounts`, `TeardownView.setNear`). Setting: Options → Gameplay
  "Steps and parts left" (`tdPrefs.counts`), next to "Disassembly guides". The old hidden top panel's meters are gone.
- A machine with every step done and every part taken is a bare frame: mash the use button on it (14 presses, draining between,
  `FRAME_PRESSES`) and it turns to scrap. Out in the field that pays `frameScrap` (what the last part used to pay), spends the site
  (`siteScrap`, `scrapFrame` in server/crash.ts) and the frame is gone: no longer drawn or solid (`siteSpent`). It used to stay as a husk.
- Only the disassembly table can scrap an unfinished machine (its menu, or the same mash once stripped): the parts still on it are
  destroyed and pay `SCRAP_REWARD.perPartLeft` each on top of the frame. The table no longer frees itself when the last part is out.
- Esc menu: Settings moved into an Options sub-view with Gameplay and Audio tabs (Audio: volume, music; Gameplay: guides, counts,
  occlusion, stats).

## 2026-10-18 — More kinds of rock

- `shared/rocks.ts` grew from mesas and boulders to five kinds: mesas (some long escarpments), pillar fields
  (spires and stout buttes whose tops sit near an old plateau level, lower towards the edge), broad hills carved by
  meandering gullies (gentle enough to climb, tors on top), and jagged peaks (concave cones with arêtes, sub-summits
  lined up into little ranges). A slow "style" noise picks which kinds dominate a region, so rocky country has
  character and blends between them. About 6% of rocky cells hold a giant (×1.6–2.3): cliffs 50–90 m, peaks to
  ~100 m, hills ~280 m across. A per-cell footprint budget keeps rock cover where it was (~8% of the world).
- Giants reach two cells out, so `rocksIn` searches ±2 cells; `ROCK_H_MAX` (shade march ceiling) is 130.
- No trig: "angle round a rock" for gullies and arêtes is noise sampled on the unit vector out from its centre.
- Every world's rock layout changed (shelters, crash sites and scrap re-place around them).

## 2026-10-18 — One registry for all text

- Every player-visible text moved to `shared/text.ts` (`TEXT`, rules in `docs/text.md`): item, part, machine, boss,
  slot and box names, prompts, toasts and server notices, the Tab overlay, HUD, Esc menu, controls and key names,
  landing page, name gate, obituaries, disassembly UI and its 81 step labels, hints and speech. Data tables
  (`ITEMS`, `SALVAGE`, `COMPONENTS`, `GEAR`, `BOSSES`, ...) point at it. `Texts` is the shape a translation would fill.
- Made consistent on the way: one set of part names (the disassembly mode had its own: "Motor", "Heatsink"),
  "Backpack full"/"Too far away" from the server are now "Bag full"/"Too far", and every "Pick up …" lowercases the
  name the same way (`lower()`, acronyms kept).
- Known gaps: server notices are still English strings (send keys for translation); dev-only UI stays inline.

## 2026-10-18 — The character speaks

- Subtitled remarks from the player character to guide without tutorials (`src/speech.ts`, lines as data in
  `src/speechLines.ts`, writing rules in `docs/speech.md`). A line has an event (`see` a find in reach, `respawn`, or
  the polled `tick`) and a condition on `SpeechState` (day, indoors, heat, bottle sips, storm, bag). Lines sharing
  an id are variants (day/night). Without `again` a line is said once per browser, otherwise at most once per `again`.
  One line at a time with a pause after it.
- First lines: a water bottle in sight while you carry none (worded by day or by night), overheating (shade, or
  a sip), an empty bottle, the storm detector's warning, being in a storm, the first night out, and respawning.
- More events: `near` (a crash-site machine or wreck), `got` (any item newly in the bag, diffed per frame in
  `src/main.ts`), `bagFull`. Every item kind now has a first-pickup line, broken or working; also lines for the first
  ride, pumps, the first shelter, the first enemy and boss. Lines file renamed to `src/speechLines.ts`. Ideas
  for more: docs/speech.md.
- Known gap: `hints.ts` still shows its how-to banners; some of them could become lines.

## 2026-10-18 — Loading screen, then name, then you exist

- Joining shows the loading cover with a tiny disassembly game on it (`src/loadingRunner.ts`): the same moves as the
  real one (click screws, circle bolts, swipe wires, drag pry tabs, take the freed part into the bag), introduced one
  at a time, with the game's step markers and rarity colours. Game and loading bar are drawn in a worker
  (`src/loadingWorker.ts`), pointer events forwarded by `src/loadingGame.ts`, started from `src/entry.ts`.
- The world build yields to the browser (`src/yield.ts` `slice()`, between the constructors in `src/main.ts`), the loop
  draws nothing and runs at ~15 fps until loaded, and the terrain's first build is spread over frames
  (`Terrain.loading`). Traces showed the first rendered frame building every shader at once (1.5-2 s, shadow-pass
  materials included; `compileAsync` didn't cover them), so `src/warmup.ts` draws real frames a few materials at a
  time instead: one object per distinct material/geometry layout shown, batch doubling while frames are quick.
  Not sliceable: module evaluation, model parsing, objects first seen after the warm-up (bosses, loot).
- Last stage: once the models and terrain are in, `Warmup.run` (src/warmup.ts) builds the shaders in rounds while the
  minigame keeps going, waiting for the GPU (`queue.onSubmittedWorkDone`) after each. A trace showed a 5.6 s single GPU
  task: pipelines compile on the GPU process's main thread, the same one that shows the worker's canvas, so a big
  compile freezes the minigame however the page is sliced. Fix in progress: while warming, the WebGPU backend's
  `createRenderPipeline` is wrapped to use `createRenderPipelineAsync` (background threads) and `draw` skips pipelines
  not yet ready; slow rounds (>0.5 s) are logged to the console as `[warmup] slow round ...` with the materials in them.
  Still seen after loading: shadow-pass materials built on the first frames that the warm-up didn't reach.
- The loading game can also be played from the Esc menu ("Play minigame", `Menu.playMinigame`): same game, no loading
  bar, over the world with a see-through backdrop; Leave or Esc returns. Its step markers copy the game's (orange,
  white when hovered): a ring of dots round screws, a turning arc for bolts; for wires and pry tabs a pointer ring
  that presses on the thing and drags the way to go (the grab; the wire one starts ON the wire). The real wire marker (`makeMarker` in `src/teardown/junk.ts`) got
  the same pointer ring instead of the swinging double arrow.
- Minigame: taking a part swaps the machines in 0.18 s (old out left, new in right at once; the part flies to the bag in
  0.3 s) and it plays the real teardown sounds (`teardownSound`, `uiSound.plop`): the worker asks, `src/loadingGame.ts`
  plays, since a worker has no audio. When the loading cover lifts and the world already has our name, `capture()` puts
  the mouse straight in the game (the browser only grants it while the last click is fresh, so it works after playing).
- Minigame machines (`buildMachine` in `src/loadingRunner.ts`) are laid out like simple engineering diagrams: five
  layouts (crate, round pump with a side plate, cabinet with a door and a circuit board, a lid with a bolted plate under
  it, two bays with a link wire between them), randomly mirrored, covers nested, up to two parts each, components
  on rails with terminals and right-angled wires; a wire between two parts frees both. The first four machines teach
  click / wire / bolt / pry one at a time. Check the layouts without a browser: build 600 machines, solve them by
  working every ready step, test overlaps and bounds; `debugMachine()` plus a node canvas renders them to PNG.
- Minigame games and leaderboards: Esc menu > Teardown minigame (`src/minigameMenu.ts`) offers 5 / 10 / 20 machine
  speedruns (time, lowest first) and Endless (machines in one go, Finish ends it), each with a leaderboard
  (`server/minigame.ts`, `data/minigame.db`, `/api/minigame`; one best entry per name; the client reports its own
  score, the server only refuses the impossible and rate-limits). A run's machines get more complex with how many have
  been taken apart (`make()` in `createRunner`, level = one per machine +/- 1, max 20, so every other machine has something more
  to do: lid screws, clicks per screw, bolts through component bases and their turns, wires, latch tabs, nested covers, parts); a part's grade is the work behind it
  (`effort()`: covers over it and what holds it), so deeper parts are better and space-grade only turns up late. The bag
  groups parts into stacks by part and grade, best first, with counts. The loading screen keeps the free game with the
  four lessons. Tested without a browser: a bot plays whole runs through `debugState()`.
- Picking a game opens its records first (your best on top, the top 10, Start); Esc/Leave from a run or result goes back
  there. Games are 5 / 10 / 20 machines and Endless (the first speedrun sizes were 10 / 20 / 30; old `30` rows in
  `data/minigame.db` are just never shown).
- The Esc menu's minigame button is just the machine (a small crate, no frame) in the bottom-right corner, with a light
  that is always shining from under it and swells now and then, and a lid that lifts; still under reduced-motion.
- Minigame tips (`TEXT.minigame.hint`): the runner says which kind of step can be worked (`hint` callback, posted from the
  worker), and `src/minigameMenu.ts` shows it in a message box above the game, a "Tip" label in its top-left corner and an
  animated SVG picture of the move ("Click it, again and again", "Spin it: circle the pointer", "Press on the wire and
  drag", "Grab the tab and pull", "Take the glowing part"). A dim "Hide tips" line under the box turns them off (kept in
  localStorage). A free part comes first, the rest take turns every 4 s, each kind goes after four of it (parts: three).
  The minigame's own words are in `TEXT.minigame` too.
- Wires are shaken loose, not swiped (`Kit.wire` in `src/teardown/junk.ts`, `TeardownView.shake` in
  `src/teardown/teardown.ts`, and the same in the minigame): hold the mouse at an end of the wire and shake it (six
  swings, a swing being a stroke of 16 px the pointer turns back from, within reach of that end, which shrinks with the wire's
  length so a short wire's ends don't both count); an end that is loose lifts off its terminal and stays loose, a
  part-shaken one goes still when you let go, and the wire is free when both ends are. The markers are a ring jerking
  between two arrowheads *on each lug* (turned to face the camera, drawn over what's in front), replacing the one marker
  0.1 above the curve's midpoint that could float off a wire running up or away. Nothing new goes to the server: it
  still only hears the step done.
  A short cable (under `SHORT_WIRE`, 0.55 m in the game, 50 px in the minigame) is one pull: a single shake point in its
  middle, and one shake rips the whole cable out.
  Cables are fastened to something now (a terminal block, a stud through the lug and a nut at each end, `Kit.wire`) and
  are ropes (`src/teardown/rope.ts`, a Verlet chain along the modelled curve, rebuilt into the tube while it moves):
  shaking pulls the held end about and the whole cable swings, and once an end is off the cable hangs from the other,
  floppy, and the loose lug rides its end; one that is still with both ends held goes back to the modelled tube.
  Not yet tested in a browser: the stiffness/gravity numbers are in `TeardownView.updateRope`.
- Server: a joined player is not `ready` until the client sends `ready` (after the name, or at once if named).
  Until then they are left out of everyone else's snapshots and name list, can't die (`die()`), take no heat, cast
  no shade and count as `safe` for guardians and bosses. Reconnects resend `ready` on welcome.
- Known gap: no ready timeout, so a client that never answers stays unhurtable (and invisible) till it leaves.

## 2026-10-18 — The world has no edge

- The ±2000 m clamp is gone: you can walk and ride forever. Terrain, rocks, scrap, wrecks, crash sites and shelters
  were already generated per cell from the seed; their bound checks are dropped, so nothing inside the old square
  moved (checked: same sites, shelters, piles). Past 2 km every crash site is level 2 (guardian ground).
- Crash-site and shelter ids keep their old values in the old 128×128 cells and number every other cell after them
  (`shared/cells.ts`), so `crash_spent` rows stay valid. Packed cache keys (dig, rocks, blown sand, wind) widened.
- `CORE_HALF` (shared/terrain.ts, 2000) is the square the server still spreads the finite things over: finds,
  stashes, giant guardians (`coreCrashSites()`), the colossus's roaming. Crawlers and night drones go by the sites
  near players (`crashSitesNear`), so they turn up anywhere.
- Known gaps: nothing to find far out but scrap, machines and crawlers; shaders that use world positions (sand
  ripples) lose float precision some tens of km out; site caches grow with how far people have been.

## 2026-10-18 — Bosses are the goal: receivers, health, trophies

- **Win:** the world is won when every boss kind has been killed once (`beaten` in the world's settings,
  `bosses_beaten`, a bit per kind). Each first kill gives the world 10 more lives (`BOSS_LIVES`; the lives row grows,
  ten to a row) and sets up a big piece of the boss, full size, on the sand round the pad as its trophy (`shared/trophies.ts`, drawn by `src/world/trophies.ts`): the worm's head rearing out of the sand, jaws spread; the colossus's head sunk to the chin with its arm raised beside it; a carrier fan duct on edge; the queen's thorax nose-up with a leg arching out each side. They block (shared collision, on per kind beaten) and the sand round them isn't dug (`TROPHY_SPOTS`, shared/base.ts). They replaced small relics on the mast's fins, which nobody noticed. All
  four: a victory screen once per browser (*The desert is yours*, *Play on*), and the world goes on.
- **No more random bosses.** They're called with **receivers** (gear, `receiver_<kind>`, found broken on guardian
  ground, `FINDS` level 2): a **uranium cell** (the old anti-matter container, renamed: DB v9 migration) plus the
  boss's kin's part: a drone transponder (drones), brood gland (crawlers), walker servo (guardians) (`RELIC_DROPS`).
  The worm's receiver takes the part each of the other three bosses leaves (hive core, queen's eye, furnace heart:
  `RELICS`), so the worm comes last. Those slots are never filled in gear found broken (`PartSlot.rare`).
- **Calling** (`onCall`, server/world.ts): left mouse with a repaired receiver in hand spends the cell and the boss
  turns up some way off (its brain's non-summoned spawn), unless one of it is already about. A called boss stays
  until it's killed; its hits taken are kept (`called_<kind>`), so after a restart (or the world's process ending
  when empty) it comes back near whoever joins first.
- **Pointing** (`src/receiver.ts`): everyone gets every live boss's position each second (`{ t: 'called' }`). A
  receiver in hand, repaired or not, turns its dial's needle to its boss (wobblier on worse parts) and ticks faster
  and higher the more nearly you face it, the lamp blinking with the ticks. Held with the jammer's clips on the same
  mount (`src/models/receiver.ts`).
- **Health:** bosses have health (`BOSSES[kind].hp`, weak-point hits: worm 18, carrier 12, colossus 15, queen 18). A
  hit breaks the point for `REGROW_MS` (20 s), then it regrows, so the fight goes round the points. A bar across the
  top of the HUD (`src/bossBar.ts`) shows the nearest live boss within 700 m, with its name.
- **Gaps:** no world-wide sign when someone calls a boss; bosses don't scale with the number of players; receivers of
  beaten bosses still turn up (a rematch drops parts and its relic again).

## 2026-10-18 — The hive carrier

- **What**: the searchlight drones' mothership, a boss (shared/bosses.ts 'carrier'): a ~90 m armoured hull on four
  ducted fans (tools/blender/carrier.py -> public/models/carrier.glb, ~4.7k tris assembled: hull, one duct and one
  rotor cloned per fan). Nav lamps blink red/white, three searchlights sweep the sand under it (the drones' cone,
  glare and pool; full at night, faint by day), the front one swings red onto its target. Its shadow is the sun's.
- **Moves** (server/carrier.ts, shared/carrier.ts): ~74 m over the highest sand under it, drifting 3.5 m/s on long
  legs round the players, turning slowly (0.07 rad/s), banked into turns, nose down with speed, bobbing. The
  downwash scours a bowl every 8 m (r 6.5 m, 320 mm: a faint trench) and kicks dust up under each live fan.
- **Attacks**: anyone out in the open within 200 m it can see from its belly (lineOfSight; 700 m if they shot it)
  it follows at 4.6 m/s (a walk outruns it) and bombs every 2.6-3.8 s within 110 m: a bomb falls from the bay
  (blinking, whistling) aimed at where you'll be with 60% lead, ~3.9 s, and bursts: kills within 7 m (cause 'bomb',
  blastPush), crater r 5 m 1.5 m deep. Walking straight on or turning aside gets out from under it; indoors is safe.
  The fall is deterministic (bombAt from the 'bomb' bossFx), the server resolves the impact at the same time.
- **Weak points**: the four fan hubs (glowing lens under each motor pod, seen from below and under the duct rims).
  Each broken: that rotor runs down and smokes, the carrier slows, sinks 7 m and lists toward it. All four: it falls
  (~5 s, drifting and tumbling), craters the sand (r 11 m + r 7 m under each fan, kills within 26 m), and the wreck
  burns and sinks for its 240 s. server/bosses.ts got an optional `wreck` hook (brains ticked while the wreck lies)
  for that delayed impact.
- **Sound** (src/carrierSound.ts): four fans' chopped low noise beating against each other, a motor hum and a duct
  whoosh, delayed by the speed of sound and dulled with distance (heard ~3 km); bombs whistle down and boom.
- **Gaps**: loudness set by ear against the jets, not measured with ebur128 yet; the hub hit test only checks the
  lens (rotor blades and duct walls don't block shots); drops land under where it died, before the wreck does.
## 2026-10-18 — Bosses, and the worm

- **Bosses** (shared/bosses.ts): one-of-a-kind giant machines, the worm, the carrier, the colossus and the queen. They
  turn up rarely (one every 25–50 min near someone out in the open at least 500 m from the base, while no other is
  about) and leave after 6–10 min; F3 brings one to you for 10 min. For now each is fought the same way: glowing weak
  points (the walkers' red lenses) to shoot, all of them broken and it dies and leaves 5–8 Quality/Space-grade parts
  over its wreck (shared/tables.ts BOSS_SPOILS). Framework: server/bosses.ts (spawning, rifle hits, one brain per kind
  in server/<kind>.ts handing back deaths, craters and one-off effects), src/bosses.ts (interpolation, weak points,
  one view per kind in src/world/<kind>.ts), 'bosses' / 'bossFx' messages.
- **The worm** (the Borer: shared/worm.ts, server/worm.ts, src/world/worm.ts, src/wormSound.ts, tools/blender/worm.py):
  a mechanical worm a hundred metres long, 22 armoured ring segments behind a maw of three jaws with a grinder spinning
  in its throat. It moves the way Terraria's worms do (the usual recipe for burrowing worms; the snake/centipede
  "follow the leader" distance chain): only the head is simulated, steering under the sand (turn rate 1.1 rad/s,
  9 m/s roaming, 17 hunting), flying on gravity once out of it; every segment sits 4.4 m behind the one before along
  the head's path, so the body pours out of the hole after the head and back into the sand along the same arc.
  It roams 10 m down, now and then running just under the surface with its back out (a furrow behind it). Someone out
  on the sand within 200 m draws it: it closes in 15 m down, and once under them the sand shivers (a ring of dust, a
  swelling roar, the ground trembling) and a second later it bursts out at 36 m/s, leaps ~48 m high with its jaws
  open and plunges back in 40–50 m on. The burst and plunge kill within 6.5 m and blow craters (7 m / 2.4 m deep and
  5.5 m / 1.8 m), the head and any segment out of the sand kill what they pass through. Standing still is death;
  walking off as soon as the sand shivers gets you clear most of the time (simulated: ~70%). It can't swim through rock:
  it turns away from it, and anyone on rock or thin sand over it is out of reach; it keeps 380 m from the base.
  Weak points: six lenses on its back, shootable only while out of the sand. Dead, whatever was out falls onto the sand
  segment by segment and lies there for 4 min.
- **The brood queen** (shared/queen.ts, server/queen.ts, src/world/queen.ts, src/queenSound.ts, tools/blender/queen.py):
  the crawlers' mother, a low eight-legged spider machine ~31 m long (thorax 7 m off the sand, knees high over it like
  a harvestman's, a fat ribbed brood sac with amber slits behind), same parts and palette as the guardians. Roams
  round the nearest crawler/guardian site (walk 4 m/s), charges anyone in the open within 120 m at 6.8 m/s (you can
  outwalk it), gives up past 190 m or after a minute. Feet are server-stepped (alternating tetrapod, two groups of
  four) and each landing within 2.5 m of you kills; landings punch small holes (r 1.2 m, 650 mm), rationed by a
  bucket (1.2/s, 6 banked) so a charge leaves rows of holes and ambling every few steps one. Prey within 23 m in front:
  it rears up on its back legs (1.1 s, screech, cutters wide), then slams its front legs down 15 m ahead: everyone
  within 9 m dies, two holes r 4 m 1.5 m deep, booms, dust, shake; then it stands 2.6 s. Kills and holes wait the
  250 ms the client draws behind, so they land with the drawn foot. Weak points (6): the eye cluster, two under the
  thorax, three on the sac (two on top, one at the tail). Dead: its legs give out one by one in servo jerks, the body
  crashes into a hole, the sac splits open glowing and smokes. Model ~9.5k triangles, merged to a lit and a glow mesh
  per part.
- **The colossus** (shared/colossus.ts, server/colossus.ts, src/world/colossus.ts, src/colossusSound.ts,
  tools/blender/colossus.py): a 67 m iron biped (Liberty Prime / Fel Reaver), a furnace glowing in its chest, a burning
  eye slit, spiked pauldrons, hydraulic shins, 11 m feet; ~5.5k triangles, two draw calls per part. It roams between
  far waypoints at 3.6 m/s (well under a walking player's 7.5) and walks at anyone in the open within 250 m (a shooter
  from 700 m), never near the base. Feet are the server's (planted spots, a step when the rest spot is 11 m behind,
  2.3 s swings, ~24 m strides, the feet taking turns); the client swings them with heel lift and toe roll, two-bone
  IK, hips bobbing on a spring and swaying over the planted foot, torso twisting, arms swinging, head tracking its
  prey. Every footfall kills within 12 m and digs a 9.5 m / 2.8 m crater (only within 1.2 km of someone), so it
  leaves a trail of footprints; booms out to 1.5 km and shakes the camera (felt through the ground before heard).
  Within 26 m of its prey: the big stomp, a foot raised 15 m over them (aiming while it rises), held 1.6 s with a
  steam shriek and the furnace flaring, slammed: 14 m kill, 12 m / 3.5 m crater, a dust shockwave and a long shake;
  from the moment the spot is set, walking gets you 15 m. Footfalls happen on the server 250 ms after the server's
  step (SEEN_LAG_MS) so they line up with what clients draw. Weak points: the chest core, both kneecaps, the two
  exhaust stacks on its back (get behind it). Dead: knees buckle, it topples like a tower and slams down 4.8 s
  later, the server digging a furrow of four craters where it lands (and crushing anyone under it, from the brain's
  `wreck` tick); it smokes, and sinks in over its last 40 s.
- **Terrain healing is local now**: the wind's heal pass touched every edited vertex every 5 s and the server sent
  them all, so a boss's craters would have cost every client megabytes a pass. The server now sends `terrainHeal`
  and each client runs the same deterministic heal() on its copy (docs/netcode.md).
- Gaps: the boss sounds are levelled against the guardians' measured footfalls, not measured themselves yet.

## 2026-10-18 — Shade cools you off

- In full shade (a rock, a dune's lee, a wreck, a hut) the felt temperature is never above `SHADE_MAX` (26 °C,
  shared/temperature.ts) while the sun is up, so the heat meter goes down even at midday: a full meter empties in
  ~80 s, half the base's speed. Before, midday shade was air − 10 (~34 °C) and still built heat slowly. Half in the
  sun still builds a little. The cap fades out with the shade drop as the sun sets.

## 2026-10-18 — Hands for the shovel, metal detector, scrap and jammer

- **Shovel** (tools/models/handtools.py, wooden shaft with a T grip, painted steel blade): carried in the right fist
  under the T, the blade out ahead low in the view; digging or piling sand (ShovelDig, 1.2 s loop) brings it in close
  in both hands, the left underhand down the shaft: drive it in, lever, lift the scoop into view, flick it left.
- **Metal detector** (raked grip under an olive control box, shaft with a coiled cable, racetrack coil): held by its
  grip like the pistol, the coil low across the middle of the view, swept side to side (two sweeps per 3 s idle, one
  per walk cycle). Digging with it in hand, the right hand holds it up out of the way and the left scoops.
- **Scrap**: a bent angle-iron offcut in the fist. Throwing now winds up: the hand cocks back by the ear and lets go
  over the top (ScrapThrow, 0.5 s); the throw leaves 210 ms after the press, from where the hand lets go, and the
  piece in flight (yours and others') is that same offcut instead of a full-size pile prop.
- **Jammer**: its own clips. Carried low right; jamming, both hands bring it up in front at chest height, the left
  palm under its body, the antenna on the crosshair. Others now see a raised jammer's lamp blink and hear its
  searching static from where you stand (the 'hands' aim flag already sent for guns; no new messages): the same voice
  at the searching level (−38 LUFS) at 2 m, 1/d past it, not past 60 m.
- **Pistol aim** is canted 35° inwards about the sight line, so the forearm leaves the view at the bottom right
  instead of standing up the middle under the sights (still in view, a one-handed sight picture has the arm under it).
- All grips solved on the objects (`bar_in_hand` for shafts and bodies, `gun_in_right` for the raked grips), wrists
  under 46°. hands.glb 1.4 → 1.8 MB (three small atlases and 12 clips). `HANDS_FAST=1` builds skip the bakes for quick
  pose checks (docs/viewmodel-hands.md).
- Gaps: the shovel's blade is mostly edge-on or out of view while carried (it points away); the jammer's lock isn't
  shown to others, only that it's jamming; the remote static's level is the measured searching voice through a
  panner, not measured itself.

## 2026-10-18 — Partial shade, shade from wrecks and people

- **Body shade** (shared/shade.ts `sunOnBody`): four rays instead of one, from the head, both shoulders (±0.22 m
  across the sun) and the legs (0.5 m), lower when crouched, weighted 0.35/0.2/0.2/0.25. The felt temperature mixes
  sun and shade by the lit share (shared/temperature.ts `feltTemp(tod, sun, …)`), so legs below a crest or half
  behind the hut is partial shade. The `shade` flag sent to the client is "less than half lit".
- **What casts shade:** dunes, rocks and digs (`heightAt`, already), the hut and skylight collar (already), scrap
  (already), and now crash-site wrecks and debris (their collision capsules, within 80 m along the ray), other
  players (a 0.28 m capsule, 1.8 m tall, 1.2 crouched), their bikes while ridden (a low capsule along the heading)
  and motorcycles lying on the sand. Players and bikes are `Caster`s the server gathers every 250 ms
  (server/index.ts `shadeCasters`); your own don't shade you. Ray vs capsule is analytic (`hitsPrism`).
- **Finer far march:** a step that lands closer over the sand than 0.6 × its length is walked again in 0.5 m
  substeps. Against a 0.1 m reference march at the grazing evening sun, missed crests fell from 15 to 3 in 825
  shaded points. Cost: ~40 µs per ray as before, ~150–200 µs per body check, 4 checks/s per player.
- **Cold nights were tried and taken out again** the same day: a hidden chill below 10 °C felt (death by cold),
  shelter by the base, smouldering wrecks or cloth in the bag, shown as frost and shaking hands. The code is in
  git history (commit e6f2641) if we want it back.

## 2026-10-18 — Guardian feet are solid, stand on wrecks, and guardians keep apart

- **The server steps the guardians' feet** (`stepFeet` in server/guardians.ts, same rules as the client gait: rest
  spot, STEP_DIST, one foot or a diagonal pair at a time, swing times to keep up) and sends them in 'bots' (`f`:
  id, leg, x, y, z, swing left). The client swings each leg to the spot the server picked, in the time it has left
  (`followFeet`, src/world/guardians.ts). Crawlers keep their own client-side gait (tiny, quick, many).
- **Planted feet block players**: posts LEG_POST_R × scale around the foot, LEG_POST_H × scale tall, in `step()`
  (shared/sim.ts `collideLegs`, on foot and on the bike). The server passes the feet it has planted; the client the
  planted ones in the latest 'bots'. Planted feet don't move, so prediction agrees except for a moment as a foot lifts
  or lands near you (a small correction). Swinging feet, the upper legs and knees don't block.
- **Feet stand on whatever is there** (`footTop`, shared/guardians.ts): sand, rock (already in heightAt), or the top of
  the crash-site wreck and scrap capsules under the pad (the same hitboxes players collide with). A step up onto a
  wreck lifts higher, and the foot sits level on it.
- **Walkers of a kind steer apart** (SEP_R = 2·REST_R + STEP_DIST, × scale): repelled from each other on top of the
  way they're heading (less while hunting, so two after you close in side by side), a crowded one standing about
  walks off, and guardians pick patrol points away from each other.

## 2026-10-18 — World loot survives restarts

- Finds and buried caches are kept in SQLite (`world_loot`, `loot_pending` in server/db.ts), so a deploy no longer
  lays out a fresh world: what was taken stays gone until its respawn timer (also kept) runs out, dug-up caches stay
  on the surface, and the home bike keeps its id. Written on change only (lay out, take, dig up, respawn), never per
  tick. Each find row remembers what it stands in for (FINDS key, `rare`, `home_bike`); at start the counts are
  topped up or trimmed to shared/tables.ts, so retuning FINDS / CACHES still takes effect on the next deploy.

## 2026-10-18 — Real models and icons for the gear (issue #8)

- **Finds on the sand have real models** (src/world/loot.ts `FIND_MODELS`), no more boxes and cylinders. The water
  bottle, telescope, laser rifle and laser pistol are their held models (public/models/canteen.glb, telescope.glb,
  rifle.glb, pistol.glb) laid down; the motorcycle stays the sand bike on its side. New stylised low-poly models
  for the rest, in public/models/finds/ (tools/blender/finds.py, 560-1440 tris each, already in their lying pose):
  a spade with a D-grip and taped shaft, a metal detector (yellow search coil, cable wound up the shaft, control box,
  arm cuff), an orange storm detector (barometer dial, three-cup anemometer, whip aerial, rubber corners), the wrist
  computer (leather cuff, screen module, straps), a canvas backpack (flap, pockets, bedroll, tin cup) and the jammer
  (the held one's shape: raked grip, olive body, yagi, whip aerial, amber lamp).
- **The edge glow on broken gear** now pushes each mesh out along its normals (by the distance to the camera, in the
  shader) instead of scaling it about its box: a glTF mesh is one material's pieces spread over the whole model, so
  scaling it shifted them off the model and lit it up white.
- **Inventory icons for every piece of gear** are rendered too (public/icons/items/<kind>.png, same script, the part
  icons' light and outline), at the item's grid shape: they fill the item's cells in the Tab inventory (turned with
  it) and keep their shape in single slots and the hotbar (`img.fit`). The gear SVGs are gone.
- Every item in issue #8's list now has a model and an icon (parts were done before). The first-person shovel and
  metal detector are someone else's (tools/models/hands.py); these are only the world and icon models.

## 2026-10-18 — The jammer is found, not crafted

- The jammer is gear now (shared/gear.ts): found broken on crawler ground (level 1, 3 at once, not in caches), the
  ring where roaming drones and jets first come after you (the scrap fields have none), and repaired at the workbench
  with a compute unit, a coil and a battery. A broken one isn't raised and the server ignores its 'jam'. Better parts
  lock on faster (`jamMs`: JAM_MS at Scrap parts down to 60% at Space-grade; client lamp and server count agree).
- Its recipe is gone: the workbench crafts only the plant bed and the UV lamp. Jammers from before (no parts, in a
  box or dropped on the sand) load with Scrap parts and keep working. The debug gear button gives one with the rest.

## 2026-10-18 — Two basic materials: scrap and cloth; guns are found broken and repaired

- **Scrap is one item.** The nine junk kinds (metal sheet/plank, dented sheet, oil/rusty drum, scrap/bent frame,
  gear, spring) are now just `scrap` (shared/items.ts `SCRAP`), 1×1 and stacking to 20. Every scrap-pile piece and
  crash-site debris piece gives it (the world props keep their variety; `SCRAP_ITEMS` / `DEBRIS_ITEMS` are gone).
  Gear scrap slots (bottle, backpack, shovel) take a piece of scrap ("Scrap"), recipes cost N scrap (plant bed 4, UV
  lamp 2 + coil; the jammer is unchanged), caches hold scrap, and thrown scrap flies as one of the pile pieces.
  New inventory icon: a sheet, a plank and a cog.
- **Cloth** (shared/items.ts `CLOTH`, stacks to 20) is the other basic material: a new scrap-pile kind, a lumpy
  tied-up tarp drawn procedurally (shared/scrap.ts `item: 'cloth'`, src/world/scrap.ts `clothGeometry`, ~11% of
  pile pieces; the pile layout reshuffled its kinds once), the burnt-seat debris at crash sites (`debrisItem`), and
  buried caches. The bottle's second slot is cloth (its strap, was a drum), the backpack is cloth + scrap + gear,
  the plant bed is 2 scrap + 2 cloth. Gear whose slots changed is refitted on load (shared/gear.ts `refit`: each
  slot takes the first old part that fits; gear that worked gets the missing material for free).
- **Every equipment item and both guns are finds** (shared/tables.ts FINDS): bottle, telescope, backpack, pistol at
  the scrap fields; motorcycle, shovel, storm detector, wrist computer, metal detector, rifle on crawler ground;
  plus the home bike at the door. Only the plant bed, UV lamp and jammer are crafted.
- **Home bike** is once per player now (grant `home_bike`): someone who has taken one gets "Already had one", so it
  can't be farmed for its motor; it still lies there for everyone else and comes back 3 min after it's taken.
- **Migration** (server/db.ts v8, every start, idempotent): old kinds in `items` and `dropped` become `scrap`, also
  inside gear `parts` JSON; when a box loads, the stacks of one are merged (server/items.ts `mergeStacks`).
- **Guns are gear** (shared/gear.ts): the laser pistol (coil + scrap) and the laser rifle (coil, battery, heatsink,
  scrap) are no longer crafted. They lie broken like the bottle: pistols at the scrap fields (level 0, 4 at once),
  rifles on crawler ground (level 1, 3 at once); buried caches' pistol is a broken one too. A broken gun isn't raised
  or fired (client and server check `repaired`). Better parts recharge it faster (`gunCooldown`: ×1.2 at Scrap down to
  ×0.75 at Space-grade). Guns crafted before this load with Scrap parts in every slot, so they keep working.

## 2026-10-18 — Dying leaves your pack behind

- **The penalty** (shared/corpse.ts): dying out in the desert empties the bag past the hotbar (the backpack's grid and
  anything stranded past it) into a pack lying where you fell. The 4 hotbar slots, the equipment (backpack, bike…)
  and the bike's cargo stay with you. Dying in or over the base, or with nothing past the hotbar, leaves nothing.
- **Getting it back**: anyone can open it like a chest (Tab beside it, or F: "Open pack"), box `corpse<id>` shown as
  "Left behind"; things only come out (shared/gear.ts tryMove / unfitPart refuse anything going in, so no "Store all").
  It's gone once empty, or after 30 min (`CORPSE_MS`) with what's still in it.
- **Server** (server/corpses.ts): the pack row (`corpses` table) and the move of the items (same ids, bag and pack
  saved together) are one transaction; while lying dead you can't move, drop or sort items (so nothing races the
  pack). Emptied packs are dropped after any move, fit or drop out of them; expired ones on the 5 s save tick.
  Clients keep `CORPSES` from 'corpses' messages, so shared/storage.ts can say what's in reach on both sides.
- **Seen from afar** (src/world/corpses.ts): a tied canvas bundle with a slanted stick and a flapping rag in the dead
  player's colour, drawn out to 700 m.

## 2026-10-18 — A motorcycle in front of the door

- **Before**: the only motorcycles were 3 broken ones lying at random crawler-ground sites (950–1650 m out), drawn as a
  1 m box stand-in, and their missing motor only came from crawler-ground machines or salvage wrecks. Nothing near the
  base hinted a bike existed.
- **Now**: one broken motorcycle always lies on the sand ~20–40 m out from the base door (server/loot.ts
  `homeBikeSpot`: first clear spot off the door's axis, no rock, scrap or pad), in view as you come up the stairs. It
  has its motor fitted (scrap tier, `HOME_BIKE` in shared/tables.ts) and needs a battery and a bearing, both from the
  scrap fields' starter machines (beacon, winch), so it can be ridden after the first trips out. Taken, another lies
  there 3 minutes later. The crawler-ground ones stay.
- Broken motorcycles are drawn with the real sand bike model (src/bike.ts `loadBikeModel`) dropped on its side, so
  they read as a bike from far off (box stand-in until it loads; its shared geometry is never disposed).

## 2026-10-18 — Shorter disassembly

Taking machines apart was too long ("too many parts"). Same machines, same parts and mounts, about half the
steps (`src/teardown/junk.ts`, `wrecks.ts`; nothing in Blender changed, the machines are built in code):

- Steps per machine (average over seeds, before → after): jet engine 50 → 24, robot arm 43 → 20, pump 39 → 19,
  vehicle frame 28 → 13, control cabinet 25 → 12, warp core 25 → 12, AI control 20 → 9, water jet 20 → 10, solenoid
  valve 12 → 4.5, beacon 10 → 5, winch 8 → 3.6. Screws take 2 clicks (3 on fancy machines), bolts 3 half turns.
- How: a lid (`bay`) or plate (`rect`) has two screws at opposite corners (or none, held by a pry seam or latch),
  bolt circles are 2–4 bolts, one bolt where there were two, one spring clip per heat sink, two board standoffs.
  Wires that only doubled another (earth, coil feed / return, second starter lead, cell leads, ribbons) are plain
  cables now. The prerequisites that make sense stay: drain before the cover, cut the leads before the bolts, guard
  before the coupling, the two-player lifts.
- Saved progress: `machine_progress` has a `layout` column; steps done under another `TEARDOWN_LAYOUT`
  (shared/crash.ts, now 2) are dropped on load, parts taken stay taken. Bump it when a machine's steps change.

## 2026-10-17 — Roaming drones

- A few drones now roam the open desert day and night (server/guardians.ts `roam`, site `ROAM`): at most 6 out at
  once; someone out in the open with fewer than 2 within 800 m gets one drifting in from 300–420 m about every 60 s. It flies
  long legs (120–350 m) ahead-ish, keeps 250 m from the base unless chasing, and leaves after 3–6 minutes. Otherwise
  it's a normal drone: the searchlight locks on, calls the guardians and missiles, and can be shot down for parts.

## 2026-10-17 — Laser pistol: the cheap gun

- **Getting one**: no longer handed out to everyone (the `pistolGift` was dropped for the playtest reset):
  crafted at the workbench from a metal sheet and a
  wiring coil (any tiers, no battery or plank), and 4% of buried caches hold one. `laser_pistol`, 2×1; the debug gear
  button gives one too.
- **Model** (tools/models/pistol.py → public/models/pistol.glb): a Ruger-pattern .22 rebuilt as a blaster after a
  reference the team picked: black upper with a knurled bolt cap, steeply raked grip with checkered brown panels and a
  medallion, ribbed shroud with a glowing red tip, a silver cell tube on top, a long focusing rod down the right side, a
  charge window, iron sights. Baked like the rifle; `PistolGlow` pulses with the charge.
- **Held** one-handed (tools/models/hands.py, `gun_in_right` now shared with the rifle): PistolIdle / PistolWalk low
  right with the bore on the crosshair, PistolAim out at arm's length with the sights exactly on the view axis
  (`P_RELIEF` 0.38, the build checks it), left arm lowered out of view.
- **Feel** (src/rifle.ts `FEEL`): no scope, a 1.3× zoom on the sights, the crosshair hidden while aimed; sways 1.7× the
  rifle (one hand), wider hip cone, harder kick; recharges in 280 ms (rifle 420) but reaches only 100 m (rifle 260,
  a guardian's cannon 180), so it's for crawlers and drones or a close, risky fight. Hits break weak points and drones
  as the rifle's do. Higher, shorter, quieter zap (`rifleSound.shot(…, pistol)`; others hear it via `zap.pistol`).
- **Server** (server/index.ts onFire): any gun in `GUNS` (shared/rifle.ts) in hand, its own cooldown and reach.
- Aimed, it's canted 35° inwards about the sight line (2026-10-18), so the forearm runs out of the bottom right
  corner instead of up the middle of the view.

## 2026-10-17 — Progression: scrap fields, crawler ground, guardian ground

A new player starts with nothing, and the crash sites now lead them on in three rings around the base
(`shared/crashsites.ts` `SiteLevel`, by the distance of the site's cell from the base, `LEVEL_R` 950 / 1650 m):

- **Scrap fields (level 0):** no walkers and no drones. These are older, smaller junk (`CrashKind.field` wrecks and
  debris, tools/blender/crashsites.py) with more debris that lies in one of four styles: a trail, a heap, a wide
  scatter, or a fan spilled out ahead of the wreck. There is no large machine, only 2–3 small starter machines to carry
  home (`winch`: gear + bearing, `solenoid_valve`: valve + coil, `beacon`: battery + coil; mostly Scrap/Basic). Their
  machines come back 20 min after being carried off (`STARTER_RESPAWN_MS`, server/crash.ts), because every new player
  needs them. The broken canteen, telescope and backpack lie here (server/loot.ts `FINDS`), and almost half of them
  (`PILE_ODDS`) among the scrap piles within 600 m of the base instead. The laser rifle's plank,
  sheet, coils and battery come from the debris and the beacons. Nothing turns up by the spawn point any more.
- **Crawler ground (level 1):** crawlers swarm, and at night drones search here too: as everywhere, their searchlight
  calls in guardians within `ALERT_R` and missiles from guardians within `MISSILE_R` (shared/missiles.ts), which
  reach in from guardian ground. The large machine is mostly the pump housing (motor, bearing, valve).
  The motorcycle, shovel, storm detector, wristpad and metal detector are found here.
- **Guardian ground (level 2):** the 6 guardians roam only these sites, and a drone's searchlight brings them.
  The large machines are mostly jet engines, and their parts roll with `LEVEL_TIERS` (much more Quality and Space-grade).
  Loose Quality/Space-grade parts lie around (`RARE_FINDS`). The warp core salvage wreck only lies out here.

Crash sites are also much rarer: `DENSITY` is 0.14 per cell out in the desert and 0.4 around the base, which makes
28 sites (7 / 7 / 14) instead of 66. Machine kinds per level are in `LEVEL_KINDS` (shared/crash.ts).

## 2026-10-17 — Laser rifle: shoot the walkers' weak points

- **Crafted** at the workbench: metal plank + metal sheet + 2 wiring coils + a battery (any tiers). A hotbar item
  (`laser_rifle`, 4×1); the debug gear button gives one. Every player from before got one, once, in the 4th hotbar
  slot (server/items.ts `rifleGift`, the new `grants` table); what was there moved into the bag.
- **Weak points** (shared/rifle.ts): red glowing lenses, one on every knee of a guardian plus one on its belly under the core, and one on each flank of a
  crawler, all pulsing together. A hit shatters the lens (glass chips, sparks, an electric fizz), the walker flinches
  and turns on the shooter (a crawler's whole pack with it), and the broken point keeps smoking. All of them broken:
  it dies.
- **Death** (src/world/guardians.ts `die`): a pure function of the time since death, so a wreck that comes into view
  lies as it fell. The servos twitch, then the legs give out one at a time in three quick jerks each (a winding-down
  whine and a clunk), feet skidding outwards, the hull sinking in stages and tipping towards the legs that went first,
  then it slams down (dust, shake, crash). The eye stutters out, the gun sags, and it smokes until the server clears
  the wreck (3 min guardians, 40 s crawlers; it sinks into the sand first). A killed guardian drops 2–3 Quality or
  Space-grade parts and is replaced 8 minutes later at a far-off site; a crawler sometimes drops a poor part.
- **Drones** can be shot down too: two hits. The first makes it spark, trail smoke and wobble with its light
  stuttering; the second kills the light and it drops (the server simulates the fall, drifting on with its speed),
  tumbling and spinning down on a smoke trail, crashes with a bang, sparks and dust, smokes on the sand for 25 s and
  leaves a Basic or Quality part. A downed drone stops calling in missiles. Its site gets a new one once the wreck is
  cleared (it flies in from 220 m).
- **Shooting** (src/rifle.ts): hitscan from the eye. Right mouse or X raises it (the RifleAim clip is scrubbed by
  the aim, so it follows the button) into a 4× scope (wheel 2.5–7×) with a duplex reticle and a lit red dot. The aim
  sways like a held rifle: breathing (a slow vertical rise and fall), a figure-of-eight arm tremor and a little noise,
  more on the move and after sprinting, settling when still; Shift held still holds your breath for 4 s, then you
  gasp. The sway moves the camera itself (not the networked yaw/pitch), so the reticle stays centred and the world
  swims under it. Hip fire scatters within a cone (wider on the move; four ticks show it). One shot per click, then
  0.42 s to recharge (a rising whine, a click). Recoil: the muzzle climbs (35 % of it stays: pull it back down) with a
  random sideways kick, the view jolts on an under-damped spring, the rifle kicks back into the shoulder, and through
  the scope the eyepiece shadow jumps.
- **Netcode**: hits are found by the shooter's client against the walkers as it draws them (their legs are
  client-side IK, so only it knows where a knee is); `fire` tells the server, which checks the rifle is in hand, the
  rate, that the shot starts at the eye and passes and ends near that walker, then breaks the point (`bots` carries
  a broken mask and the time since death) and shows the beam to everyone near (`zap`). The shooter's own shatter
  shows at once and is undone after 1.5 s if the server never agrees.
- **Tactics**: a guardian's cannon reaches 120 m and the rifle 260 m, so snipe from range; up close you trade shots
  with its cannon and usually lose. Crawlers are quick and their lenses small: from the hip you'll miss.
- Levels measured (OfflineAudioContext + ebur128): own shots −23 LUFS rapid fire, −27 one; glass at 20 m −28; a
  guardian dying at 40 m −27.

## 2026-10-17 — Drones call down missiles; the searchlight is escapable

- **Searchlight look** (src/world/drones.ts): was a solid cream wedge, white even when locked, cut hard at the sand.
  Now a faint haze cone (back faces only, so it also reads from inside; brightest along the axis, nothing at the
  silhouette, fading towards the ground), a glare at the lens, and a pool that is a grid laid on the dunes each frame
  instead of a flat disc slicing through them.
- **Escapable**: the beam no longer burns. Locked on, it turns after you at most 0.22 rad/s and the drone chases at
  5.5 m/s (you walk 6). Out of the beam for 1.2 s it lets you go and ignores you for 15 s. Simulated: walking sideways
  out of the beam takes ~5 s, sprinting sideways ~2 s, sprinting straight away ~11 s; before, nothing escaped.
- **Missiles** (shared/missiles.ts, server `tickMissiles`, src/world/missiles.ts): while a beam holds you, the two
  nearest guardians within 1.5 km each launch one at you every 4.5 s (first 1.2 s after you're spotted). They arc
  high (a Bézier shared by server and client), land 3.5–8 s later where you were heading (85 % lead, 4 m scatter) and
  kill within 6 m ('missile'). The impact is marked on the sand from launch: a red ring whose disc fills as it comes
  down, plus a falling whistle over the last 2.2 s. Simulated: standing still or walking in a straight line gets you
  hit; sprinting or turning doesn't. Guardians are usually 0.8–2 km from a site, so the range is long on purpose.
- **Alarm**: the looping siren is gone; a drone locking on gives one short double chirp. The HUD line no longer
  blinks ("Spotted", "Incoming — keep moving").

## 2026-10-17 — Guardian cannons, crawlers, bigger and rarer guardians

- **Guardians** are now 3 giants (×1.5: body ~20 m up, legs 18 + 24 m) roaming the desert from crash site to crash
  site, starting away from the sites nearest the base. Faster: 2.8 m/s patrol, 5.2 hunting (you walk 6). Sight 65 m.
- **Cannon**: `Guardian_Turret` + `Guardian_Gun` (tools/blender/guardians.py) hang under the body. While a guardian
  hunts you and has line of sight within 120 m, the turret yaws and the gun pitches after you (slewing, so a quick
  sidestep gets ahead of it), the coils glow up over a 1 s charge (with a rising whine), and it fires a big slow bolt
  (38 m/s) every 3.2 s. A hit or a burst within 2.2 m kills ('laser'). Server-simulated straight-line bolts
  (`tickBolts`), announced as 'shot' / 'boom'; the client draws them from its own muzzle easing onto the server's
  line (src/world/bolts.ts). Strafing works: a simulated player zig-zagging away dodged 7 shots before it closed in.
- **Crawlers**: the same rig at ×0.11 (player-sized), 1–4 per crash site (one sees you, the pack comes), turning up when someone comes within 300 m
  and gone when everyone has left. Faster than you walk (7.4 m/s, sprint away), they notice you within 12 m, bite
  (+14 heat), then back off for 9 s; they give up after a 7 s chase or 70 m from their site. Tuned as a nuisance at
  the sites, not a wall, since you can't fight back yet. Crawlers use merged parts (one or two draw calls per part,
  no shadows), and only those within 300 m are sent.
- **Drones** now belong to crash sites: at night, two over every site someone is near; the open desert is dark and
  quiet.

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
- Gaps: the upper legs and knees don't block players (planted feet do since 2026-10-18, "Guardian feet are solid",
  which also put feet on top of wrecks and keeps guardians apart); bodies and shins still pass through wrecks and
  rocks (only the feet step on top).

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
- Gaps: ~~loot is in server memory~~ (kept in SQLite since 2026-10-18); the find models are boxes and cylinders;
  caches don't show their contents
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
bag); anywhere else a drag looks around (at a large machine; on the table it does nothing). Only middle-drag turns
the machine over on the table, right-drag moves it about. On the table **W A S D / arrows** turn the
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
- **Gaps:** ~~the shade check is one point (the head)~~, ~~the far march can miss a thin crest at grazing
  angles~~, ~~other players and the bike cast no shade~~: all fixed in "Partial shade, shade from wrecks and
  people" (2026-10-18). Still: no cold at night (tried and removed, same entry); temperature doesn't vary with altitude or wind; the
  client doesn't predict the icon (it lags up to ~250 ms + latency); placed things in the bunker don't matter
  (it is all base).

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
- **Known gaps:** ~~dune and building shadows don't count as shade~~ (fixed: "Temperature and shade"); no
  shelter at night is needed; you can't drink from or share with other players; slots 2–4 are
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
  6. 3D models (Blender), see below.
- A research agent wrote `docs/sand-rendering.md`: Journey sand, glitter papers, dune shapes,
  heat haze, sun bloom.
- Branches were merged into `desert`, checked with `npm run build` and headless-Chrome screenshots,
  then shipped as PR #4.

### Handy for testing

- `?debug`: exposes `window.dbg` (orbit, sky, post, scene, renderer, env) for tweaking in the console.
- `?agx`: AgX tone mapping.
- `sand.*` and `env.*` uniforms (wind, colours, ripple strength, glitter, haze, sun size) can be changed
  live without recompiling.
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

---

# Topic entries (oldest first)

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

## Speed slide (Shift)

Deadshot-style speed slide, replacing sprint (there is no sprint any more; run speed went 6 → 7.5 m/s).
Input bit `SLIDE` = 256 is Shift; bit 32 (was `SPRINT`) is now `CROUCH`, keys Ctrl or C (C because
browsers eat Ctrl+W). With the rifle aimed, Shift holds your breath instead of sliding (src/input.ts).
Not to be confused with `sliding` on the avatar/`Slide` clip, which is slipping down a slip face.

- **Sim** (`shared/sim.ts`, state `sliding`, `slideCool`, `slideSpent`): a fresh Shift press on the ground
  (or Shift held through a landing) throws you in the held direction at max(15, speed + 3) m/s (cap 18),
  45-tick cooldown from the start. A tap lasts 36 ticks; holding keeps it going until it slows to run
  speed. 9 m/s² friction, 90% of the slope's gravity (downhill gains speed, uphill bleeds it), steering
  only turns the heading (1.6 rad/s). Leaving the ground ends it; jumping out keeps the speed (air control
  never brakes), so slide → jump → slide on landing chains. Slides heat you up like sprinting did
  (`server/water.ts`).
- **Animation:** `Powerslide` clip (leg driven forward, other knee tucked, leaning back; `tools/models/scavenger.py`).
  `ScavengerModel` tilts a group between root and model to the slope along/across the facing (`tiltPitch/Roll`),
  feet IK is off during it. Camera eye drops 0.65 m. Remote players get it from the snapshot's `sliding`.
- **Crouch:** Ctrl / C on the ground caps speed at 3 m/s (`crouching` in state; clips `Crouch` /
  `CrouchWalk`, camera drops 0.45 m).
- Tuning knobs are the `SLIDE_*` constants at the top of `sim.ts`. `SPRINT_SPEED` stays only as the
  reference for "fast" effects (FOV kick in src/camera.ts, getting winded in src/rifle.ts).

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
  brown column (dark against the dusk sky); inside: dust fog ~20 m deep. Up to 4 at once.
- **From the bunker:** the storm used to vanish indoors (the columns weren't drawn and `wind.local` was 0), so
  the skylight showed a clear sky. Now, in the base (`stormIndoors`), the march starts only where the view ray
  leaves it: above the pad's surface (skylight, stairwell) or out of the entrance hut's box (its door), so the
  sky and doorway fill with moving dust while the rooms stay clear. The wind keeps blowing (`wind.local` is the
  storm over the camera's spot even indoors) and is heard underground through a 420 Hz lowpass
  (`src/windSound.ts`); grit sifts down the skylight and blows in at the door (`src/world/baseSand.ts`, from the
  storm over the base). No grit on the view, and the locator still works down there.
- **Testing:** F3 → "Sandstorm here" summons one on you, for everyone. With `?debug`, `dbg.net.storms` can
  be set by hand for a look-only storm (the server doesn't know about it), or `dbg.storm.summonHere()` puts a
  full-strength local one right on you for 90 s (only you see it).


## Throwing scrap

So someone with no gun can still fight a drone: any scrap item (`SCRAP_ITEMS`) taken out from the hotbar is
thrown with left mouse / E (`src/throw.ts`, `shared/throw.ts`).

- **Flight** (`server/throws.ts`): the server checks the junk is in that slot, the rate (`THROW_MS`), that the
  throw starts at your eye and you're out of the bunker, takes it out of the bag and flies it on a plain arc
  (30 m/s, gravity 13.5: straight up it climbs ~33 m, over a drone's 20 m). Passing within `THROW_HIT` (3 m) of a
  flying drone it counts as one rifle hit (`DRONE_HP` 2: two throws bring one down, and it comes for you after
  the first) and glances back, hitting nothing more. Where it lands it becomes dropped loot to pick up again; over
  the base it goes back into the thrower's bag. In memory only: a restart mid-flight loses it.
- **Client:** your throw shows from the hand as it lets go, flying on our clock's guess of the server's arc; others'
  come from the server ('toss', again with `hit` when it bounces, 'tossEnd' where it lands). Drawn as the piece held
  in the hands (2026-10-18; before, full-size scrap props), tumbling. A swish on the throw, a clank and sparks off a drone, a sand thump.
- **Gaps:** it only hits drones (not walkers or players); a bag-full return over the base loses the item. The swish/clank levels are by analogy with the beam's
  impact sounds, not measured.


## Fixed-wing drones

A second flying machine, by day and by night: a big unmanned plane (18 m span, `shared/jets.ts`) passing high
(110–180 m) and fast (60–90 m/s). No lights, no searchlight, no spotting; it only flies over, but it can be shot.

- **Flights** (`server/jets.ts`): every 4–10 min (at most 2 in the air) one is sent past a random player: a straight
  pass within 350 m of them, or (40%) an arc of 0.75–2.5 laps round a 700–1400 m circle whose ring runs near them.
  Each flight is a run in, an arc and a run out, entering and leaving 3 km out. Like the sandstorms the list goes out
  on join and on change ('jets'), and both sides compute the position from it and the server clock (`jetAt`), so
  nothing streams per frame. In memory only.
- **Client:** built from primitives in `src/world/jets.ts` (lathe fuselage, sensor dome, intake hump and nozzle,
  tapered wings, V tail), banked into its turns. The roar (`guardianSound.jets`) is the missile's roar, deeper, with a
  turbine whine, heard to 3.5 km and from where the plane was when the sound left it (fixed-point on
  te = now − d(te)/c), so it lags behind the plane overhead. Measured (mono K-weighted render, same method that gives
  the missile's −17): −20.5 LUFS at 150 m, −27 at 300 m, −37 at 700 m, −46 at 1.5 km.
- **Shooting:** the rifle tests its ray against two boxes (fuselage, wings) in the jet's frame (`Jets.raycast`); the
  server checks the shot passed within `JET_HIT` of where the jet was 0–300 ms ago (the client flies it on its guess
  of the server clock). `JET_HP` (3) hits: each a bang and a thicker smoke trail; the last kills the engine (the roar
  stops) and the server adds `down`: a straight glide along its heading at 0.8× speed, 1 m down per 5 forward,
  marched against `baseHeight` to where it meets the sand (mesas included: it can fly into one). The glide and wreck
  are math on that record like the flight. Landing: firework, slam, dust and shake; the wreck smoulders 90 s.
  Only within the rifle's 260 m, so a pass overhead gives a few seconds of shooting; the pistol can't reach.
- **Testing:** F3 → "Jet here" sends a straight pass over you, ~13 s out, for everyone.
- **Gaps:** thrown scrap doesn't reach them; no spoils from the wreck; holds one height over the whole flight
  (terrain at the player).


## Jammer

A handheld tool that brings down jets and searchlight drones without a shot (`shared/jammer.ts`, `src/jammer.ts`).
Crafted at the workbench from a compute unit, a wiring coil and a battery (any tier).

- **Use:** hold the use button (LMB / E) with a jet or drone inside the cone (`JAM_CONE` 0.2 rad half angle, out to
  `JAM_RANGE` 400 m). The client takes the one nearest the aim (and keeps it while it stays in), and tells the
  server ('jam': target, eye, aim) every 200 ms. The server (`onJam`) checks the jammer is in hand, the eye near the
  player and the target in the cone (0.1 rad slack; jets anywhere in the last 0.5 s, for ping), and adds the time
  since the last word, capped at 1.5× the send interval so a client can't run it ahead; any longer gap bleeds the
  lock at 0.5×; a new target starts over. At `JAM_MS` (3.5 s; was 5 s with a 0.2 rad, 400 m cone: too hard on jets)
  it goes down.
- **Downed jet (shot or jammed):** it falls like a plane, not a drone (`jetDive`, midpoint steps of `DIVE_STEP` on
  both sides): it keeps its way, the nose drops towards 72° (time constant 2.2 s jammed, 3.4 s shot) with the path
  following it, gaining 9 m/s a second, rolling over about its length (2.4 rad/s jammed, 0.9 shot, wound up over
  2.5 s): about 3.3 s from cruise height. The server marches it until the nose (`JET_NOSE` ahead) meets the sand,
  halved to the ms; the wreck sits as it hit, ploughed `BURY` m on, nose in, tail up (`jetWreck`). Impact: fireball
  (bolts.boom), sparks and shards thrown the way it was going, smoke, dust ring, big shake, bang + slam. Jammed: a
  thin trail and a light smoulder instead of smoke. Its wreck drops loot (`JET_SPOILS`, server `wrecks()`): 2–3
  avionics/engine parts (basic/quality, a little space-grade; +1 jammed), its drone transponder 20%, 2–4 scrap,
  strewn back along its heading. (Before: a 9:1 glide and a belly skid; then a flat spin like a drone's.) **Jammed drone:** light out,
  sinking at 2.5 m/s while it drifts to a stop, rotors winding down, settling upright (`jammed` field in 'bots',
  drone stride 12). Its parts drop as if shot down.
- **Feel, no HUD:** the hands raise it (JammerAim since 2026-10-18, before the pistol's clips: the model
  `src/models/jammer.ts` is built in the pistol's frame); the lamp on top glows while searching and blinks faster as the lock
  builds; the target twitches (only for the jammer's user); a warbling static climbs in pitch and speed as the lock
  builds, a falling chirp when it drops. Levels measured: searching −38 LUFS, lock −32 → −27, chirp −26.
- **Gaps:** others see and hear that you're jamming (lamp, static) but not the lock building; the lock bar is only
  felt, so the 5 s are learned by trying.

## Shelters

Small empty bunkers out in the desert for getting out of the sun, a storm or a drone's sight (`shared/shelters.ts`,
drawn by `src/world/shelters.ts`).
- **Where:** one at most per 400 m cell, likelier the rockier the cell (`rockiness`): 0.02 + 0.45·k. The spot is
  kept off rock (the pad flattens dunes only) and, in rocky country, within ~45 m of it; the dunes under the pad may
  vary at most 3.5 m. About 20 in the world (11 small, 5 deep, 4 long with seed 1017), none within 350 m of the base.
  Scrap, wrecks and crash sites keep off them (`shelterWithin`). Facing is one of the four world axes, so the local ↔
  world turn is exact.
- **Kinds:** a 2.6 m concrete hut over stairs, like the base's but smaller; *small* 14 steps to a 4.8 × 5 m room,
  *deep* 40 steps (10 m down) to a 5.2 × 6.5 m room, *long* 14 steps then a 20 m corridor to a 3.6 × 12 m gallery.
  Flat ceilings (stepped over the stairs) instead of the base's vaults, so collision and the drawn boxes stay simple.
- **Hooks:** same as the base's, side by side: pad in `baseHeight`, no edits over them, `collideShelter` /
  `shelterCeiling` / `sandHidden` in `step()`, `shelterSolid` for shots, the hut as a shade box, `indoors()` (base or
  shelter) for heat, storm drag, drones, throwing, music and footsteps. The storm dust's hut box is a uniform now
  (`indoorHutMin/Max`). The nearest 4 huts' floors are cut out of the sand (`shelterHoles`).
- **Light:** the sun through the door, a dim fill in the nearest shelter's room following the daylight, a faint glow.
- **Dev:** `?spawn=shelter` starts outside the nearest one's door. Someone who leaves inside one comes back at its door.
- **Pumps:** some have the base's hand pump in the middle of the room (`pump`, odds by kind: small 0.15, long 0.35,
  deep 0.7: the deeper, the likelier it reaches water; 8 of 20 with seed 1017). The canteen fills there like at the
  base (`atWater`, client and server); the pump has the base's hitbox. Drawn from bunker.glb's `pump` node.
- **Stashes:** `SHELTER_STASHES` (shared/tables.ts): every shelter is stocked, `perShelter` by kind (small 2, deep and
  long 3), on the room floor (`shelterLootSpot`); like a cache's contents but richer (more gear, mostly Basic/Quality
  parts). Taken, one comes back after FIND_RESPAWN_MS in whichever shelter is shortest (spawn key `shelter`). Loot now lies at `lootY` (a shelter's floor, else the sand) and is only in
  reach about level with it (`lootReach` checks height too), so it can't be taken through the roof.
- **Gaps:** no sand blowing in during storms (the base has `baseSand`); a stash isn't heard by the metal detector
  (it's not buried).

## Worlds and shared lives

- **Worlds:** the page without `?w=` is a landing page (`src/landing.ts`) with one button, *New world*: it asks
  `POST api/worlds` for a fresh random id and goes to `?w=<id>`. Anyone opening that URL plays the same world; the
  Esc menu copies it (*Copy invite link*). Each world has its own seed (`seedFor(id)`, shared/world.ts), so its own
  dunes, rocks, base spot and sites, and its own players, items and terrain edits in `data/worlds/<id>.db`. The world
  from before keeps `data/dadajam.db` and seed 1017 at `?w=main`. Unknown ids are turned away (close 4404).
- **One process per world:** the layouts are seeded once when the shared modules load, so the front server
  (`server/index.ts`: static files, the API, `/ws`) forks `server/world.ts` per world with `WORLD_ID` and pipes each
  WebSocket upgrade through to the world's local port. A world starts on its first connection and exits after 10
  minutes empty; on SIGTERM the front waits for the worlds to save. Dev: `--watch-path=server --watch-path=shared`
  restarts the front, and the worlds go with it.
- **Lives:** 10 per world (`LIVES`), shared by everyone, kept in the world's `settings` (`lives`); every death
  (`die()`) spends one and everyone gets `{ t: 'lives' }`. A row of marks in the top-right corner (`src/lives.ts`)
  puts one out per death. At 0 nobody can die any more, everyone is closed with 4410 once the last body has lain its
  `DOWN_MS`, and joining a spent world gets the end screen (*Game over*, *New world*).
- **Bosses:** each kind's first kill gives the world 10 more lives; every kind killed wins it (see *Bosses are the
  goal*).
- **Gaps:** finished worlds' databases stay on disk; nothing lists open worlds; the browser ID is the same in every
  world (each world's DB keeps its own player row).

## No digging (for now)

- **Taken out:** players can't dig or pile sand any more, and the shovel and metal detector are gone with it (items,
  gear, finds, hints, held models; `src/dig.ts`, `src/detector.ts` and the dig scripts deleted; the crosshair moved to
  `src/crosshair.ts`). The DIG/PILE input bits (64, 128) are free. The terrain edit layer stays for the bosses'
  craters, the relaxation and the wind's healing (`shared/dig.ts`, `server/terrain.ts`).
- **Caches** lie out on the sand now, picked up like any find; the ones buried before come up on the next start
  (`world_loot.depth` is always 0). Shovels and metal detectors already in boxes, dropped or lying in the world are
  removed on load (`RETIRED`, shared/items.ts), and a cache holding one is replaced.
- **To bring it back:** the commit that removed it has everything (client prediction, the dig fx and ring, the
  detector's ticks, `loot.dug`).

## Gear shows its tier; the shield plate

- **Tier looks:** every model of a piece of gear looks its tier (`tierOf`: the parts' mean tier rounded down, as the
  tooltip names it), with the parts' own language (tools/blender/items.py): Scrap rusts in blotches on metal and
  fades and stains on cloth (noise on the mesh's own unskinned vertex positions, so it rides with a worn backpack; metal
  only above 0.5 metalness: the player's baked atlas has in-between values over cloth), Basic is the model as made, Quality is polished with brass-warm metal and orange lamps,
  Space-grade goes pale with a cyan sheen along its edges and cyan lamps. `src/tierLook.ts` makes one node-material
  variant per material and tier and swaps it in per mesh (`applyTier`, cheap enough to call every frame, so models that
  load late catch up). On: the first-person hands (`playerHands.tier`), the avatar (held item, backpack, wrist, belt,
  shield, carried canteen and sidearm), the bike (from `PlayerState.bike`) and loot on the sand (broken gear is Scrap).
  Animated materials opt out with `userData.noTier` (the bike's headlight, the guns' charge glow, the player tint).
- **Others see it:** `PlayerSnap.tiers`, 2 bits per `TIER_SLOTS` entry (hand, each equipment slot, carried canteen and
  sidearm), omitted when all Scrap. Gear slots in the Tab inventory get the tier's rarity colour too.
- **Shield plate** (`shield`, new `armor` equipment slot, found at crawler sites and in caches): a torch-cut shard of
  ship hull on canvas padding with a copper-coil emitter and a cell (tools/blender/finds.py `build_shield`, worn on the
  chest from Spine2, lies on its back as a find). A killing blow that isn't heatstroke (`die` → `shielded`) breaks it
  instead: the cell burns out and the plate cracks (`SHIELD_BREAKS`: those slots empty, repair at the workbench), a
  crawler's bites come back off the heat meter, and nothing hurts you for `shieldGraceMs` (1.5 s Scrap .. 5 s
  Space-grade). Everyone near gets `shieldBreak`: the emitter's field flashes round you in the lens's tier colour and
  hangs on for the grace, flickering out at the end, hull shards fly, a crack, a glassy ring and a thump (−24.7 LUFS,
  −1.3 dBTP); the wearer gets a jolt and a flash over the screen.
- **Debug (F3):** *Give gear* at any tier, *Hit me* (a killing blow).


## Disassembly table in the middle of the room

- **Layout** (`BASE_PIECES`): the disassembly table now stands square in the middle of the main room, under the
  skylight, 1.6 m square (`square: true` makes its hitbox four capsules, so the corner legs can't be walked into); the
  water pump moved to the east wall (`PUMP_X` in tools/blender/base/bunker.py, its drain grate with it). A lamp hangs
  over the table (a little high, clear of the table camera), one over the pump.
- **Clear top:** the old table had a half-stripped machine, a vise, a grinder and bolts on it, which the machine
  being taken apart overlapped. The top is bare now; the tools sit round the sides, none more than ~0.3 m out (a
  player is 0.35 m wide): vise and bolt tray on the west side, grinder on a bracket and the scrap bin on the east, a
  tool rail on the back, hazard stripes on the front.

## The test lab (dev only)

- **What:** `http://localhost:5173/?w=lab` (after `npm run dev`; the dev server starts with `--lab`, which the
  production server and `npm start` don't) is a clean flat room for taking machines apart and trying components. It's
  an ordinary world with the id `lab` (own DB `data/worlds/lab.db`); every other `?w=` is the normal game. It opens with
  the F3 debug menu on (`&debug` is added to the URL).
- **Flat ground:** one switch, `LAB` in shared/world.ts (world id `lab` and the dev flag, same on client and server):
  `baseHeight` is the bunker pad's height everywhere, and the rock, scrap, wreck, crash-site and shelter layouts are
  empty, so physics, shots and drawing agree. The clock stands at noon (`timeOfDayAt`); the server runs no heat, storms,
  jets, walkers or bosses; the client has no wind or blown sand and draws the floor plain grey (`labFloor`).
- **Layout** (shared/lab.ts, metres from the bunker door, +Z out into the room): spawn (0, 12) facing out; parts at
  x 24..33, z 8..38 (11 parts as rows, 4 tiers as columns, plates beside and above); the grinder and every gear kind
  (broken, all slots empty) at x -24..-36, z 8 on; machines at z 50 / 70 / 90, 16 m apart: six jet engines (seeds
  differ, so shell halves and modules do), then every other kind, name plates in front (`src/world/labPlates.ts`).
- **Machines** are work sites `lab:<n>` (the old dev yard's mechanism, `CrashSite.lab`): the real disassembly, sessions,
  part grants and two players; F3 *Reset near / all* puts them back together. **Pickups** are loot (server/loot.ts)
  laid out afresh at every start and again where taken, so the tables never run out. The **workbench and disassembly
  table** are the bunker's own, a few steps from the spawn. A first visit hands over the debug kit (every gear kind
  repaired at Scrap tier, the grinder).
- **Replaced:** the earlier dev machine yard (`--yard`, `dev:yard`, `spawn=yard`) is gone; the normal game has no test
  machines. Yard progress ids (`yard:<n>`) are simply forgotten.


## Harvester

A new enemy: a tracked sand crawler the size of a building (`shared/harvester.ts`), 15 m wide, 34 m long, 21 m to
its stacks; slab-sided rust-black iron on four armoured track units, a toothed cutter drum in a low maw, an ore
hopper, a sieve tower with a slit eye under a heavy brow, a turret on top. It slowly grinds over the dunes sifting the
sand for ore.

- **Routes** (`server/harvesters.ts`): every 7–18 min (first after 3–8) one sets off on a ~4 km route passing
  160–420 m from a random player outside, 2.2 m/s (about half an hour across). The route wanders and steers round
  rock, the base, shelters, crash sites and slopes steeper than ~24°. Like the jets, only the route and the start go
  out ('harvesters'); the pose is math on the server clock: the front and rear axles ride the route 9 m either side,
  the hull sits on the four track units' sand (`baseHeight`), so it pitches and rolls over the dunes and cuts its
  corners.
- **Menace:** anyone in its footprint is run over (`'harvester'`, "ground into the sand by a harvester"). Within 75 m
  where its eye can see you, or once you shoot it, it turns on you: the eye goes red, the walkers' horn, then salvos
  of three of the walkers' bolts from the turret every 5.2 s (they fly and kill as theirs, `GuardianServer.bolt`,
  'shot' with g = −id). It loses you past 240 m or unseen for 25 s (angry for 90 s after a shot).
- **Killing it:** only the four glowing heat vents on its flanks count, 3 hits each; its armour just sparks (and
  angers it). Each vent shot out goes dark and smokes; the last one seizes the engine: a blast, it burns where it
  stopped for 8 min, and its hopper bursts round it (`HARVESTER_SPOILS`: mostly uranium, drive parts, 8–14 scrap,
  rarely a broken receiver).
- **Look and sound:** model `tools/blender/harvester.py` (`public/models/harvester.glb`); 120 instanced track shoes
  run round the loops by the distance come, the drum turns and throws sand, the chute spills sifted sand, the stacks
  smoke. Furrows dug behind the tracks while someone is within 700 m. `src/harvesterSound.ts`: diesel rumble, tread
  clank and drum grind, delayed and dulled with distance (levels set by ear against the carrier's thrum, not yet
  measured in LUFS).
- **Debug (F3):** *Harvester here*: one passes about 50 m away within a minute or so.
- **Gaps:** its hull isn't solid to walk into (being under it kills, but the wreck can be walked through); the AI
  ignores storms and night.
