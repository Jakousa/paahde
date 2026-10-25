# The machine program: how to continue it

For whoever continues the realistic-machines work. Read the whole file once; it is the result of a
long run of reviews and says what went wrong as well as what worked. Details of one machine live in `docs/machines/<machine>.md`
(the turbofan: `docs/machines/turbofan.md`); the art direction is `docs/look.md`; every player-visible text rule is `docs/text.md`.

## 1. What the program is

Replace the old code-built boxy "components" (`src/teardown/junk.ts` builders) with **realistic, Blender-authored, used-future machines** that
are taken apart in the disassembly mode, then grow the world around them: scrap economy, structures made of several machines, boss wrecks.

**Where it stands (update this paragraph when you finish something)**

- Done and reviewed: the **turbofan jet engine** (`tools/blender/machines/turbofan.py` -> `public/models/machines/turbofan.glb` +
  generated `shared/machines/turbofan.ts`): shells that need a grinder then prying, rotor modules, accessories on a gearbox, cables with plugs,
  hardware kit (`tools/blender/machines/hardware.py` -> `hardware.glb`: real screws, bolts, latches, clamps, pins), pushing/rolling the
  engine, picking up and turning pieces that come off, scrap per step, rotors / fuel manifold / turbine disc as collectable parts.
- Done, not yet marked good: **downed jets**: two planes (`JetKind`): the fixed-wing drone, MQ-9-like, with no engine to salvage (its wreck drops parts; a smaller
  engine part may come later) (`tools/blender/machines/dronejet.py` -> `public/models/dronejet.glb` + generated `shared/dronejetpieces.ts`), and the
  flying wing with them in pods on its back (`tools/blender/machines/plane.py` -> `public/models/jet.glb` + generated `shared/jetpieces.ts`), the break-up simulation (`shared/jetbreak.ts`), permanent crash sites (`shared/jetcrash.ts`,
  `server/jetcrash.ts`), engines that tear off, may be wrecked, otherwise lie as machines to take apart.
- Not done (suggested order, see section 9): findability of jet wrecks, uses for the rotor parts, the shell turning into scrap, terrain hollow for
  normal crash sites, pieces as inventory items, the other machines one by one (section 8), structures, boss wrecks.

## 2. Ground rules (they override habits)

1. `main` is the live game and must always build: run `npm run build` before each push. Commit small, push often.
2. Put dev switches in the URL (`?cascades=`, `?shadows=0`) rather than new menu entries.
3. Standing rules for machines:
   - **Models hold only the machine.** No sand, furrows, scorch decals, loose debris or spills in a machine's glb. Crash marks belong in the
     terrain (craters, see `server/terrain.ts crater()`); loose pieces that fly off are physics, not model.
   - **Disassembly is normal play**: movement and mouse look as usual; the mode starts near a machine and ends when you walk away; the crosshair is
     the pointer; gestures are done with the mouse itself. The setting "Disassembly guides" hides big indicators; interactables keep a
     faint sheen either way. Do not add tutorials or text (see CLAUDE.md game design).
   - **Fasteners belong to the machine**: real hardware in the machine's own materials, oriented by their flange, no yellow tabs, no pull rings. A part
     that pulls apart shows its indicator on the part and visibly splits.
   - **Shells start on.** A shell may need a grinder along a hinted seam, then a mashing prise (`grind` then `mash`). Both halves of the outer
     shell must go before the inner one can. The same shell model may be used by the flying jets.
   - **One player can do every step alone.** Several players may work a large machine at once (a shared session), but no step waits for a
     second pair of hands. Something heavy is a longer action instead: the pump motor and the jet engine's upper casing are a lifting eye held
     for `HEAVY_LIFT_S` (src/teardown/junk.ts) rather than the default 1.6 s, trembling as it comes up and dropping back if you let go.
   - **Parts are real**: a jet engine's parts come from what an engine really is (rotors, manifold, bearings, starter...). Keep interactions simple
     but visually rich; avoid complexity: few large things, clean connectors, nothing floating or
     sitting inside a rotor.
   - Every player-visible string goes in `shared/text.ts` (labels `TEXT.steps`, parts `TEXT.parts`, prompts); never inline.
4. Anything that moves a player is in `shared/sim.ts` and deterministic; shared/server code uses `.ts` import extensions and no enums,
   namespaces or constructor parameter properties (`erasableSyntaxOnly`). Import three from `three/webgpu`.
5. Say what you ran and what you only reasoned about; write "not verified in the running game" when that is the case.

## 3. How a machine is made (the pipeline)

```
tools/blender/machines/<machine>.py   builds geometry (kit.py MB) and RECORDS steps/parts/hits in the same pass
  -> public/models/machines/<model>.glb     nodes: Shell (never comes off), Mod_<id> (one per module)
  -> shared/machines/<kind>.ts              generated layout: modules (chance, pop, steps, parts), hits (capsules), pose
shared/machines.ts   layoutOf / rollModules   (server and client both read it: the server knows what a step is without trusting a client)
shared/machine.ts    machineModules / machineParts: which modules and parts a seed gives (seeded; deterministic)
src/teardown/glbMachine.ts   builds the Junk (steps, pieces, part slots) from the layout; src/teardown/junk.ts Kit builds the fasteners, wires, markers
src/teardown/teardown.ts     the mode: picking, gestures, held pieces, sheen, scrap
server/crash.ts      sessions (done steps / taken parts by index), scrap grants, pushing; shared/crash.ts the site ids; shared/machineBoxes.ts solid capsules
```

Run a model: `BLENDER=<path to Blender 5.0> sh tools/blender/run.sh -b --python tools/blender/machines/turbofan.py [-- --preview <dir>]`. The script writes the glb **and** the layout TS; commit both.

**Frames.** The scripts build in three.js axes (Y up, +Z forward, metres) under a transform stack and are turned into Blender Z-up just before
export (`kit.C`). The turbofan's own frame has the engine axis on Z, fan at +Z, angles measured from +Y towards +X (`polar(phi, r, z)`); the finished
engine is posed (pitch, roll, sunk) and written in world axes with the origin on the ground.

**`kit.py` in one paragraph.** `MB` is a bmesh builder with a matrix stack (`push/pop`): `loft(rings)`, `cyl`, `lathe(profile, segs, mat)` (revolves an (r,z)
profile about local Z), `box`, `beam`, `sphere`, `sweep` (tube along points), `deform`. `shell_solid` makes a thick lathed shell (use it for cowls and
casings: a one-sided surface is see-through). `Machine.module(id, chance, pop)` returns a `Module` that records geometry and:
`step(kind, label, pos, nrm, after, need)`, `ring` / `rring` / `row` (a ring or row of fasteners), `wire(label, pts, key, after, r)` (cables), `grind`, `mash`,
`part(partId, pos, rot, chance)`, `inside()`, `place(M)`. `Machine.hit(z0, z1, r, mods)` adds a solid cylinder that exists while any of `mods` is still on.

**Layout semantics that bite**

- `after` names a step id, a **module id** (means that module's *outer* steps: it has to be off), or a label within the same module.
- Steps and parts recorded **after `inside()`** belong to the piece once it is off the machine and lying on the ground (it can be picked up, turned and taken
  apart further; it persists). Parts recorded **before** `inside()` stay on the machine and are free once the module's outer steps are done (this is how the
  rotors work: the module is the stator/plate, the rotor is a part).
- `with=[module ids]`: the step exists only if those modules are present on this machine.
- Presence and part rolls are seeded in a fixed order (all modules first, then parts): **append new parts at the end of a module and new modules at the end of
  the list**, or every saved machine changes. The step *index* order must equal the order `glbMachine.ts` builds them (`shared/machineSteps.ts`).
- **Bump `TEARDOWN_LAYOUT` (`shared/crash.ts`) whenever step counts or order change** (saved progress is dropped when it differs). Currently 12.
- Part models are normalised to a size in `src/teardown/junk.ts` (`PART_SIZE`, per-part `SIZE`) and shown at `PART_SCALE` 0.4 inside machines; give big parts a `SIZE`.

**A new collectable part** needs: the id in `PartId` (`shared/salvage.ts`), `TEXT.parts`, a grid size in `shared/items.ts` (`PART_SIZES`; the small side is at most 2),
a Blender item in four tiers (`tools/blender/items.py`: `ITEMS` list + a `build_<id>` + `BUILDERS`; renders icons too), the empty roll records in `src/teardown/glbMachine.ts`
and `junk.ts`, loot exclusions if it must not be found loose (`shared/tables.ts ROTORS` / `noParts`), and **a use** (gear slot, recipe) or it is dead loot.
Run: `... --python tools/blender/items.py -- --item <id> --preview <png>` and LOOK at the preview.

## 4. Verifying without a human

Run all of these before every push, and look at images you render:

| What | How |
|---|---|
| Types and production build | `npx tsc --noEmit`; `npm run build` |
| Layouts solvable, counts within caps | `node tools/check-machines.ts` (400 seeds) |
| Step order / locks consistent | `node tools/check-teardown-order.ts` |
| Machine collision boxes | `node tools/check-machine-boxes.ts` |
| Geometry looks right | `... machines/<m>.py -- --preview <dir>`, then **open the PNGs**. Cowls too thin, parts floating, wrong axis: you can only see it here |
| Server-side logic | write a throwaway `tools/_t.ts` (delete it after), run it with `node`: e.g. `JetServer`, `breakup()`, `collideJetWrecks()` run fine in plain node |
| A drawing component (canvas, UI) | bundle it with `npx rolldown <file> --format iife --name X -o out.js`, load it in a test html, screenshot with headless Chrome over the DevTools protocol (a small script that opens Chrome with `--headless=new --remote-debugging-port=...` and calls `Page.captureScreenshot`) |
| Performance | record a Chrome trace and read it with `python tools/trace-report.py <trace> [frames|profile|compare]` |

What headless checks cannot show: the game running (a headless browser is too slow to render it), feel, sound, the look in sunlight. Make the
reviewer's check cheap: give the lab URL, what to click, what to look for.

**Test lab**: `npm run dev` then `http://localhost:5173/?w=lab` (flat room, every machine and part, the grinder). Dev server is on :8787 (game) and :5173 (Vite); restart it
fresh before asking for a review (stop the old `npm run dev`, then start it again).
Jets: the debug menu (F3) has "summon jet"; the rifle hits it three times. `?cascades=2..3` / `?shadows=0` for GPU experiments; "Show stats" in the Esc menu shows the frame-time graphs.

## 5. Procedure for a new or reworked machine (the loop)

1. **Reference first.** Write `docs/machines/<machine>.md` (short): real proportions and sizes (cite a real object), its real modules in order, what really holds what
   (flanges, clamps, latches), what parts it contains, how it lies when crashed, the step list, the parts it gives. Decide the number: **steps 70-150 for a big machine,
   10-30 for a carried one**; every step has a visible reason.
2. **Model it** in `tools/blender/machines/<machine>.py` (copy the structure of `turbofan.py`). Build the shell in modules that can be missing; think of what you see
   from 3 m away standing in the sand. Reuse the hardware kit; add hardware kinds to `hardware.py` rather than inventing boxes.
3. **Register it**: `shared/machines.ts` (LAYOUTS), `LEVEL_KINDS` / `COMPONENTS` in `shared/tables.ts` / `shared/salvage.ts`, `tools/check-machines.ts` KINDS, `shared/lab.ts` rows,
   `TEXT.machines`, step labels in `TEXT.steps`.
4. **Check** (section 4), fix, render previews, look, fix. Do this 2-3 rounds *before* asking for a review.
5. **Commit and push**, with what to look at (section 10). Iterate on the same step until it is good.

## 6. Performance (the game is already near its budget)

- The game's own code is under 1% of a frame; the cost is **three.js drawing and the GPU**: draw calls, and above all the **4 shadow cascades** (terrain chunks are 8k triangles each
  at every LOD and are drawn into every cascade). The far cascades are therefore redrawn on a schedule (`src/world/cascades.ts` PERIOD, taking turns so cost per frame stays even).
- A glTF node is one mesh **per material** and every shadow-casting mesh is drawn again in every cascade. Always merge model nodes with `mergePart` (`src/world/bossParts.ts`:
  one lit vertex-colour mesh per node); let small pieces not cast shadows; freeze matrices of things at rest (`matrixAutoUpdate = false`; `matrixWorldAutoUpdate = false` does **not** prune).
- Share materials (a unique node material makes a shader build and a hitch); build things a few per frame (`hideDetail` / `detailList` / `attachAll` in `junk.ts`); cull what is far.
- Measure, do not guess: stats overlay (draws and triangles are the whole frame), `tools/trace-report.py`. The loop is CPU-bound near 100% busy when the main thread is the limit,
  GPU-bound when slow frames show `(program)` growing. There is no 60 fps cap; DynamicResolution only lowers the render scale (shown in the text line).

## 7. Lessons and traps (all of these happened)

- **Bash heredocs mangle backslashes and quotes.** Write patch scripts with the file-writing tool and run them with python; do multi-line edits with exact-match
  `assert s.count(a) == 1` replaces so a missed edit fails loudly. Files may be CRLF: read with `newline=''`, normalise, write back the same style.
- `erasableSyntaxOnly` rejects constructor parameter properties in **client** code too.
- A Blender lathe turns about **Z** (hardware heads lay sideways until wrapped); mirrored lofts need reversed winding; `kit.crush` pulls toward the model axis (build engines about their own origin).
- Hitboxes: a capsule's radius is a *footprint*; a thin slab (wing, panel) needs a separate half-height or players cannot step onto it and pieces rest in the air.
- Pieces resting on terrain use `baseHeight` (no edits): craters dug later lower the real sand. Sink pieces into it (they sink 50-90% of their height) rather than hovering.
- Three's `renderer.info` resets at every render call; with post-processing the last call is a full-screen quad (0 draws). `autoReset = false` + one manual `reset()` a frame.
- A shared module registry (`shared/jetcrash.ts`, `shared/lab.ts`) can add machine sites without touching the crash-site layout; mark them `lab: true` so they are worked in place and never "spent".
- Stateless determinism: anything both sides simulate (`shared/jetbreak.ts`) must use seeded randomness and only shared inputs; store the *result* (final poses) in the DB for anything that must agree exactly.
- Do not leave dead code (`if False else`) in generated scripts.

## 8. The roster (suggested order for the next machines)

Existing code-built machines to replace one at a time, each with its own `docs/machines/<m>.md`: pump housing (the reference for look and feel at size M), winch, solenoid valve,
beacon, control cabinet, robot arm, then the four salvage wrecks (truck chassis, pump jet, control rack, reactor core). New ones as the design asks for them (section 12).
Keep `LEVEL_KINDS` in mind: level 0 scrap fields hold only small starter machines; jet engines must stay (nearly) absent from normal crash sites because downed jets are their source.

## 9. Backlog, in suggested order

1. **Findable jet wrecks**: smoke column + locator dot + beep like normal crash sites (`src/world/crashSmoke.ts`, `src/crashSound.ts`, `src/locator.ts` read `crashSpent` and crash-site
   lists; add the jet crashes as sources), until every engine at that wreck is stripped. Keep wrecks whose engines are untouched when the 12-site cap trims (`shared/jetcrash.ts JET_CRASH_MAX`).
2. **Jammed jets** (`shared/jammer.ts`) should land gentler than shot ones: fewer pieces tear off, engines mostly stay whole (`soft` in `shared/jets.ts` is available).
3. **Shell to scrap at the end / recreatable shell** (turbofan.md): scrap grant on stripping the last step (`server/crash.ts` `scrapFor` and its `reward` callback), numbers in `shared/tables.ts SCRAP_REWARD`.
4. **Uses for the five rotor/manifold parts**: a recipe for a built engine at the workbench (`shared/crafting.ts`, `shared/tables.ts` recipes), a gear slot; decide what a built engine does first.
5. **Terrain hollow for ordinary crash sites** (not only jets): a crater, bank and furrow from the machine's pose, stamped by the server once (`server/terrain.ts crater(..., false)`).
6. **Piece as an inventory item** (a second F puts a held piece into the bag): needs an item per module kind; keep "F again puts it down" as the first step.
7. Normal-world performance (trace first), then the next machine from section 8.

## 10. Open design decisions and reviews

- Which machine or feature is next, and how big (steps, scrap values, drop rates). Defaults: the numbers in `docs/machines/turbofan.md` and `shared/tables.ts`, adjusted by feel.
- Art direction: used-future, mechanical, water-seeking cities' leftovers (`docs/look.md`).
- What the economy rewards: scrap for fasteners and for finishing, how rare engines are, the odds an engine tears off (0.8) and is wrecked (0.3) (`shared/jetbreak.ts`).
- What a built engine or rotor is *for* (vehicle, base generator).

When asking for a review, say what changed and the commit, what was verified (commands run) and what was not, and what to look at (URL, exact steps, what you expect to see).
Feedback that works best: a screenshot with the problem circled, the machine and step, what was expected; for performance, a Chrome trace plus the stats panel in view.
Restart the server and client fresh before reviewing (a few "bugs" were old clients).

## 12. The larger picture: machines of every size, structures, and boss bodies you take apart

Everything above is about **one machine** (the turbofan, size M). The program's goal is bigger: a world whose big mechanical things are a reason to go places and
spend time. This section is the map for that, and how the pieces you build now must be shaped so the bigger ones fit. The engineering consequences are
here.

### 12.1 Size classes

| Class | Size | How you work it | Examples (working titles) |
|---|---|---|---|
| S | 0.4-1.2 m | carried home, taken apart on the disassembly table (`BENCH`, `shared/crash.ts`) | winch, valve, beacon, relay box, filter housing, hand pump |
| M | 1.2-3 m | a site you walk around, worked in place (the turbofan, a well-head pump) | generator set, compressor, cooler unit, gearbox, robot arm |
| L | 3-8 m, 1-3 sections | a site, sections walked between | tractor, hauler truck, combine header, pivot-irrigation span |
| XL | 8-60 m, 3-10 sections | a structure site | pumping station, windpump tower, desalination plant, bucket-wheel excavator, crashed cargo hauler |
| Wreck | 60-200 m, 3-10 sections | a boss wreck (12.3) | colossus, carrier, queen, worm |

Rules that carry across sizes: every machine has a **seeded presence** (any module can be missing, so two of a kind differ), **proportions from a real reference**,
**steps that each have a visible reason**, **parts that really are inside it**, and a **size range** per kind (seeded metric variation plus a few model variants:
swap `Mod_*` nodes) so they are not twins. Bigger things are not "more steps in one list": they are **several machines** (12.2), because a layout is capped
(the server stores a step as an index, `MAX_INDEX = 255` in `server/crash.ts`) and because a player works one place at a time (pivot, camera distance and
work radius are per machine: today `radius: 5`, `src/world/crash.ts`).

Scrap economy is the same at every size: scrap per step kind, more for finishing a module, a piece, the machine (`SCRAP_REWARD` in `shared/tables.ts`); the shell
turns to scrap at the end (backlog item 3). Bigger machines pay by section, so a long structure keeps paying while you walk it.

### 12.2 Structures: a site made of several machines

A structure is **a site with several machine sections**, each an ordinary machine layout (its own glb nodes, layout, hits, parts), placed by anchors in the
structure's own model. The id scheme already allows it (`"<site>:<0-9>"`); the engine pieces to build, in this order:

1. **Sections as machines.** `machinesAt()` (`shared/crash.ts`) yields one `CrashSite` per section at its anchor (an empty named `Section_<n>` in the structure's glb gives position
   and yaw). One structure model, many layouts; the shell can be one `Shell` for the whole thing with each section's `Mod_*` nodes in it.
2. **Per-section work space.** Pivot, work radius and camera distance become data on the section (not constants). Walking from one section to the next ends one work session and
   starts the other (the mode already starts and ends by distance; make the distance per section).
3. **Cross-section requirements** (`requires`): "cut the main power bus at the shoulder before the chest plates can be unbolted". A step in section B names a step in section A in its `after`
   (extend the id space to `<section>/<step id>`), and `shared/machineSteps.ts` plus the server check it from the shared layout, so a client cannot skip it. Always keep the puzzle
   solvable: extend `tools/check-machines.ts` to build the whole structure and prove every step has a legal order (it already proves this per machine).
4. **Per-kind layout versions.** Today one global `TEARDOWN_LAYOUT` resets everyone's progress whenever any machine changes. Move to a hash per kind (saved with the progress row in `machine_progress`)
   so reworking one machine resets only that machine.
5. **Placement and collision.** A deterministic cell grid in the style of `shared/crashsites.ts` and `shared/wrecks.ts` with its own random stream (nothing existing may move), a level by
   distance from the base (`SiteLevel`), solid capsules from the layout's `hits` (`shared/machineBoxes.ts` already does this per machine; sections just add more), and a husk state per section
   and per structure (the `crash_spent` pattern).
6. **Dev placement.** Put one of each structure in the test lab (`shared/lab.ts`) so it can be reviewed without finding it.

Start with one reference structure of three sections (a pumping station: pump house, tank, switch yard) before generalising; build the second only after the first is marked good.

### 12.3 Boss bodies as disassembly sites (with a puzzle for the boss item)

**The idea.** When a boss dies today, its model lies as a wreck for `wreckS` seconds (240-300, `BOSSES` in `shared/bosses.ts`) and then vanishes; its relic (`RELICS`:
carrier `hive_core`, queen `queen_eye`, colossus `furnace_heart`; the worm's receiver needs all three) drops as loose loot at the death spot. The goal: **the body stays for good, shared by
everyone in that world, and is a structure (12.2) whose sections you take apart; the relic is the last part of a puzzle inside it.**

What exists to build on: the bosses' models are small rigid-part kits (`public/models/<kind>.glb`, 3-9 nodes, from `tools/blender/<kind>.py`: the carrier's four fan ducts, the colossus's
head, chest, arms and legs, the queen's thorax, sac and leg groups, the worm's segments); death poses are pure functions of the death snapshot (`src/world/<kind>.ts`: the carrier's landing
point and roll, the colossus's fall yaw and footprints, the queen's seeded leg pose, the worm's exposed segments); spoils come from `BOSS_SPOILS` (`shared/tables.ts`); `beaten` is a bitmask
in the world settings; craters from footprints and falls are already terrain edits. All of it is server-owned in `server/bosses.ts` and `server/<kind>.ts`.

**Build it in this order** (each step is one review gate; none changes the living bosses):

1. **Persist the death pose.** On a boss's first kill (and on rematches, which do not re-drop the relic) the server stores a small record per kind in the settings or db: position, yaw and the few
   numbers each death animation derives from (carrier landing, roll and pitch; colossus fall yaw and feet; queen position and leg seed; worm exposed segments). Send it once on join
   (like `crashSpent`, not at 10 Hz like live bosses). Reuse the jet pattern: `shared/jetcrash.ts` plus `server/jetcrash.ts` is exactly "a permanent shared wreck kept in the world's database".
2. **Draw the wreck statically** in that pose from the same glb (a function of the record, no animation), with a dev placement so each wreck can be reviewed without killing the boss.
3. **Cut it into sections along its node boundaries** (colossus: head, chest and core, each arm, each leg, pelvis; carrier: four fan ducts and hull bays; queen: thorax and eyes, sac halves, leg groups;
   worm: head and a few segments) and give each section a normal layout (a Blender script per boss under `tools/blender/machines/`, same kit and hardware). Sections are machines (12.2); give
   each a seeded presence and parts so the same wreck is not identical in two worlds (the world seed already exists in `shared/world.ts`).
4. **The puzzle.** The relic stops being loose loot and becomes the **last part of the wreck's `requires` chain**: for example on the colossus, the chest plates need the shoulder power bus cut (arm section),
   the core housing needs both plates off and its coolant line drained, and the furnace heart sits in the core behind a seized mounting that needs the grinder. Each requirement is a normal step or part, so the
   existing mode, scrap and sounds work unchanged. Every step stays doable alone (a heavy lift is a long hold or a long mash, not a second player). Keep each puzzle to a handful of requirements: avoid complexity.
5. **Rules around it.** The worm is the de-facto last boss (its receiver needs the three relics): **decide** whether the worm also gets a wreck and a relic puzzle. A rematch
   kill must not respawn the relic. When a wreck is fully stripped it becomes a husk (the `crash_spent` pattern), never removed.
6. **Collision and findability.** Solid capsules from the generated layout (huge walkable ruins: the player must be able to climb on and into them), craters already exist, and give a wreck the same
   beacon, smoke and locator as other sites (backlog item 1), since these are the destinations of the whole game.

**Why this shape.** The boss kills stay the climax of play; the wreck turns the aftermath into a place worth a long expedition with several people, and the item that leads to the next boss is earned by
understanding the machine, not by a drop table. Everything built for ordinary machines (kit, hardware, shells, pieces, scrap) is reused; the new engine work is only sections (12.2), persistence (step 1)
and the cross-section requirements.

### 12.4 What to do first, and what needs a design call

- Finish the single-machine program (sections 8 and 9) until **three** different kinds are marked good (suggested: a small carried one, the pump, and one new large one): that proves the kit
  and the review loop. Then do the structure engine (12.2) with one reference structure, then the boss-wreck engine (12.3) with the carrier first (it is the simplest body: four ducts and a hull),
  then the colossus and the queen, then the worm.
- The design calls in this phase: the **catalogue** (which structures exist in this world and what they are for), **the puzzle for each boss item** (how the
  relic is held), the **scale of rewards** (how much scrap and which tiers a structure or a wreck gives), and **whether a boss wreck can be stripped to nothing** or always leaves something.
- Keep every step of this reviewable in the test lab first; a structure or a wreck that can only be reached by finding it in the desert will not get reviewed.
