# The economy simulator

`tools/econsim` plays the game's loot economy many times over, fast, so a change to the loot tables, the crash-site
layout or the drops shows up as a change in how quickly a player gets on: the first canteen, the rifle, each boss.
It's not a bot in the real game. It's a greedy solo agent moving between points of interest on the game's own
deterministic layout (crash sites, scrap piles, wrecks, shelters, caches, finds), with the game's own rules for what's
there and what it's worth. Its absolute times are optimistic (it never gets lost or wastes a trip). What it's good at
is **comparison**: the same 200 worlds with the same dice before and after a commit.

## Running it

```sh
npm run econ                          # this tree: 200 worlds, a milestone table
npm run econ -- --base origin/main    # ...and the same worlds at origin/main: what changed
npm run econ -- --worlds 50           # quicker, noisier
```

`--base` checks the other commit out in a temporary git worktree, copies this simulator into it and runs it there, so
both sides use the same yardstick. The commit needs `shared/lootRoll.ts` (from 62181fe on).

Lower level: `node tools/econsim/cli.ts run --out r.json` and `node tools/econsim/cli.ts compare base.json head.json`.
A single world: `WORLD_ID=sim0001 node tools/econsim/run.ts 1` prints its full result as JSON (milestones, where every
part came from, what was used, what was left, the waits).

## On every push

`.github/workflows/econ.yml` runs on every push to `main` that touches `shared/`, `server/` or `tools/econsim/`. It
simulates the pushed commit and the commit before the push (with the pushed simulator) and writes the report in the
run's summary. When something moved, it posts the flagged lines to Discord. It never blocks anything. Each commit's
results are cached, so the next push only simulates its own commit.

**Discord:** make a webhook for the channel (Channel settings → Integrations → Webhooks → New webhook → Copy URL),
then add it as the repository secret `ECON_DISCORD_WEBHOOK` (Settings → Secrets and variables → Actions). Without the
secret the run still writes its report and just doesn't post.

## Reading the report

- **Milestones**: the median minutes of play to reach each one (`gear:<kind>`: repaired and working; `q2:<kind>`: Quality-grade
  parts on average; `kill:<kind>`: the first of an enemy kind killed; `boss:<kind>`; `won`: every boss; `game over`: the world's lives used up), and the share of worlds
  that got there within the cap (10 h). `Δ` is the change of the median with a 95% interval, from resampling the
  worlds in pairs. A line is **flagged** when the reach rate moves 10 points or more, or the median moves 10% or
  more with an interval that excludes zero.
- **Bottlenecks**: the time per world the top goal spent waiting on each missing thing. This is where to look when
  something is slow.
- **Part sources**: per world, how many of each part came from each source (machine kinds, `find`, `cache`, `stash`,
  `crawler`, `guardian`, `drone`, `jet`, `boss`, ...), and which of those moved.

Any change to a table reshuffles every roll after it (a bit like the machine contents note in shared/tables.ts), so
expect small wobbles everywhere. The flag thresholds are set so that a change that doesn't matter (one more scrap in
the windmill recipe) flags nothing over 200 worlds, while doubling the rare finds on guardian ground flags the
boss milestones (the win comes ~20% sooner, the uranium wait halves).

## What it models

From the game's code, so changes there show:

- the layout: `coreCrashSites`/`machinesAt` (levels, outposts, machine kinds), `scrapPieces` (scrap and cloth), `wrecksNear`, `sheltersNear`,
  the crashed ship players arrive at (`shipSites`, `SHIP_LOOT`: known from the start)
- what lies where: `shared/lootRoll.ts` (finds, caches, stashes and where they go, kill, jet, harvester and boss drops; the server
  rolls the same functions) on the server's respawn timers
- what's inside a machine: `machineParts` (site level; carried ones roll again at level 1 on the table, as `server/crash.ts` does),
  scrap per `SCRAP_REWARD` (`stepList` for model-built machines)
- the bag: `bagShape` (no backpack: the hotbar only), `addItem` grid packing, the bike's cargo, the carried tools in the hotbar
- gear: `GEAR` slots, `quality`, `bikeTopSpeed`, `canteenSips`, `spyglassZoom`, `shieldSaves` (it breaks on its last blow),
  `RECIPES` (worst tiers first; plain metal parts hammered out of scrap), stripping spare broken gear for parts
- heat: `heatPerSecond(feltTemp(...))` by the time of day; sips, and resting in the shade when there's no water left
- bosses: called by a working receiver (the uranium cell is spent) once the odds of winning are at least even; lives:
  `LIVES`, `BOSS_LIVES`
- **every enemy: `shared/enemies.ts`**, the registry of everything a player can destroy and loot (crawlers, guardians,
  drones, jets, the harvester, the four bosses). Per kind: how many come at once, where you meet them, what one
  leaves (the server drops loot through the same `drops`), and rough fight odds by your best gun (and the jammer for
  flying things): the odds of winning, of dying when you don't (else you get away), how long it takes, and how much
  each tier of the gun's quality helps. Where you meet them:
  - at a crash site when you get there: crawlers at outposts and crawler/guardian ground (back 5 min after you leave),
    drones there by night, a guardian with the odds 6 / guardian-ground sites;
  - roaming, while you're out where they are: drones in the open, guardians on guardian ground, jets overhead (brought
    down some way off, their wreck a crash site; the flying wing's engines are machines to take apart), the harvester
    near a mud flat (`shared/biomes.ts`);
  - hunted: the agent may go and wait where harvesters or guardians roam when what they leave is worth it (a few hunting
    spots per world, the nearest stretches of that ground);
  - called: the bosses.

  The odds are rough on purpose and lean towards the player, more so with the rifle; tune them there. A new enemy (or a
  new way to meet one) is a new entry: the simulator values it by sampling its `drops`, so nothing else needs to change
  unless it's met somewhere new (`roamsHere` in tools/econsim/sim.ts).

Assumed, in `tools/econsim/costs.ts` (calibrate these against real play; changing one changes the yardstick, and the
report says "sim changed"):

- speeds, the share of time in the sun, how long picking up, opening, a teardown step and the bench take
- how far off things are noticed (the spyglass widens it for small loot)
- how much risk the agent takes, and the flying wing's wreck (mirroring server/jets.ts and shared/jetbreak.ts)

Not modelled yet: storms and gas, the worm's ambush, other players, buildings' effect (power), corpse runs beyond
picking the pack up if it's worth it.

## The agent

`tools/econsim/sim.ts`. Goals in order: the wrench (made by hand), the workbench (built with it; nothing is repaired or
crafted at home without one; carried machines are still taken apart as if on the base's table), canteen, backpack, pistol, motorcycle, spyglass, shield, rifle, storm detector,
jammer, wristpad, grinder, then each receiver and its boss, the worm last, the windmill, battery station and well. Each open goal
weighs 0.85× the one before. From that come needs (`needs()`: what's missing for each goal after the chest is
counted off) and the value of anything it could pick up. A part no goal needs is a spare (worth less the more there are)
or an upgrade for gear in use. Each stop is the known place with the best `value × (1 − risk) / time`. It heads home
when the bag is full, when something in it finishes a goal, or when nothing's worth going on for. At home it unloads,
takes carried machines apart, repairs and crafts goal by goal (a building only from what earlier goals don't need),
fits better parts, wears and carries the best gear, and calls any boss it can.

Every random draw comes from seeded streams (layout loot, fights, machines on the table, the rest), so a world plays
the same every time for the same code.
