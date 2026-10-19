# The machine program: how to continue it

For the agent that picks up the realistic-machines work, and for the project owner who steers it. Read the whole file once; it is the result of a
long run of reviews and says what went wrong as well as what worked. Details of one machine live in `docs/machines/<machine>.md`
(the turbofan: `docs/machines/turbofan.md`); the owner's art direction is `docs/look.md`; every player-visible text rule is `docs/text.md`.

## 1. What the program is

Replace the old code-built boxy "components" (`src/teardown/junk.ts` builders) with **realistic, Blender-authored, used-future machines** that
are taken apart in the disassembly mode, then grow the world around them: scrap economy, structures made of several machines, boss wrecks.
The long plan is in the owner's plan file (`~/.claude/plans/okay-i-want-to-joyful-eich.md`; if you do not have it, this file is enough).

**Where it stands (update this paragraph when you finish something)**

- Done and reviewed by the owner: the **turbofan jet engine** (`tools/blender/machines/turbofan.py` -> `public/models/machines/turbofan.glb` +
  generated `shared/machines/turbofan.ts`): shells that need a grinder then prying, rotor modules, accessories on a gearbox, cables with plugs,
  hardware kit (`tools/blender/machines/hardware.py` -> `hardware.glb`: real screws, bolts, latches, clamps, pins), pushing/rolling the
  engine, picking up and turning pieces that come off, scrap per step, rotors / fuel manifold / turbine disc as collectable parts.
- Done, not yet marked good: **downed jets**: the new twin-engine plane (`tools/blender/machines/plane.py` -> `public/models/jet.glb` +
  generated `shared/jetpieces.ts`), the break-up simulation (`shared/jetbreak.ts`), permanent crash sites (`shared/jetcrash.ts`,
  `server/jetcrash.ts`), engines that tear off, may be wrecked, otherwise lie as machines to take apart. Never watched running by an agent.
- Not done (suggested order, see section 9): findability of jet wrecks, uses for the rotor parts, the shell turning into scrap, terrain hollow for
  normal crash sites, pieces as inventory items, the other machines one by one (section 8), structures, boss wrecks.
- Everything lives on the git branch **`machines`** (pushed to `origin/machines`). `main` is the live game.

## 2. Ground rules (they override habits)

1. **Never merge into or push `main`** until the owner says a step is good. Pushing `machines` is allowed and wanted (back-up, others can see it;
   it deploys nothing). Commit small, push often. Commit trailer: `Co-Authored-By: <your model name> <noreply@anthropic.com>`.
2. `main` must always build, so before the owner-approved merge run `npm run build`. On the branch run it before each push anyway.
3. Another session may have **uncommitted edits in `src/debugMenu.ts`**: never commit that file (`git reset -q src/debugMenu.ts` before committing;
   `git add` explicit paths, not `-A` at the root). Do not edit it either, put dev switches in the URL (`?cascades=`, `?shadows=0`) or elsewhere.
4. The owner's standing rules for machines:
   - **Models hold only the machine.** No sand, furrows, scorch decals, loose debris or spills in a machine's glb. Crash marks belong in the
     terrain (craters, see `server/terrain.ts crater()`); loose pieces that fly off are physics, not model.
   - **Disassembly is normal play**: movement and mouse look as usual; the mode starts near a machine and ends when you walk away; the crosshair is
     the pointer; gestures are done with the mouse itself. The setting "Disassembly guides" hides big indicators; interactables keep a
     faint sheen either way. Do not add tutorials or text (see CLAUDE.md game design).
   - **Fasteners belong to the machine**: real hardware in the machine's own materials, oriented by their flange, no yellow tabs, no pull rings. A part
     that pulls apart shows its indicator on the part and visibly splits.
   - **Shells start on.** A shell may need a grinder along a hinted seam, then a mashing prise (`grind` then `mash`). Both halves of the outer
     shell must go before the inner one can. The same shell model may be used by the flying jets.
   - **Parts are real**: a jet engine's parts come from what an engine really is (rotors, manifold, bearings, starter...). Keep interactions simple
     but visually rich; the owner is "scared of too much complexity": few large things, clean connectors, nothing floating or
     sitting inside a rotor.
   - Every player-visible string goes in `shared/text.ts` (labels `TEXT.steps`, parts `TEXT.parts`, prompts); never inline.
5. Anything that moves a player is in `shared/sim.ts` and deterministic; shared/server code uses `.ts` import extensions and no enums,
   namespaces or constructor parameter properties (`erasableSyntaxOnly`). Import three from `three/webgpu`.
6. Be honest in reports: say what you ran and what you could only reason about. The owner has twice caught confident statements that were wrong
   ("a 60 fps cap"; stats that read 0). Say "not verified in the running game" when that is the case.

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

Run a model: `BLENDER="C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" sh tools/blender/run.sh -b --python tools/blender/machines/turbofan.py [-- --preview <dir>]`
(Blender 5.0 is installed there; if the path differs find it). The script writes the glb **and** the layout TS; commit both.

**Frames.** The scripts build in three.js axes (Y up, +Z forward, metres) under a transform stack and are turned into Blender Z-up just before
export (`kit.C`). The turbofan's own frame has the engine axis on Z, fan at +Z, angles measured from +Y towards +X (`polar(phi, r, z)`); the finished
engine is posed (pitch, roll, sunk) and written in world axes with the origin on the ground.

**`kit.py` in one paragraph.** `MB` is a bmesh builder with a matrix stack (`push/pop`): `loft(rings)`, `cyl`, `lathe(profile, segs, mat)` (revolves an (r,z)
profile about local Z), `box`, `beam`, `sphere`, `sweep` (tube along points), `deform`. `shell_solid` makes a thick lathed shell (use it for cowls and
casings: a one-sided surface is see-through, the owner reported this). `Machine.module(id, chance, pop)` returns a `Module` that records geometry and:
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
| Geometry looks right | `... machines/<m>.py -- --preview <dir>`, then **open the PNGs** (the Read tool shows images). Cowls too thin, parts floating, wrong axis: you can only see it here |
| Server-side logic | write a throwaway `tools/_t.ts` (delete it after), run it with `node`: e.g. `JetServer`, `breakup()`, `collideJetWrecks()` run fine in plain node |
| A drawing component (canvas, UI) | bundle it with `npx rolldown <file> --format iife --name X -o out.js`, load it in a test html, screenshot with headless Chrome over the DevTools protocol (a small script that opens `chrome.exe --headless=new --remote-debugging-port=...` and calls `Page.captureScreenshot`) |
| Performance | the owner records a Chrome trace; you read it with `python tools/trace-report.py <trace> [frames|profile|compare]` |

What an agent **cannot** check: the game running (the headless browser is too slow to render the game itself), feel, sound, the look in sunlight. Say so and make
the owner's check cheap: give the lab URL, what to click, what to look for.

**Test lab**: `npm run dev` then `http://localhost:5173/?w=lab` (flat room, every machine and part, the grinder). Dev server is on :8787 (game) and :5173 (Vite); restart it
fresh before asking for a review: find listeners with `netstat -ano | findstr ":8787 :5173"`, `taskkill /PID <pid> /F`, then `npm run dev` in the background.
Jets: the debug menu (F3) has "summon jet"; the rifle hits it three times. `?cascades=1..3` / `?shadows=0` for GPU experiments; "Show stats" in the Esc menu shows the frame-time graphs.

## 5. Procedure for a new or reworked machine (the loop)

1. **Reference first.** Write `docs/machines/<machine>.md` (short): real proportions and sizes (cite a real object), its real modules in order, what really holds what
   (flanges, clamps, latches), what parts it contains, how it lies when crashed, the step list, the parts it gives. Decide the number: **steps 70-150 for a big machine,
   10-30 for a carried one**; every step has a visible reason.
2. **Model it** in `tools/blender/machines/<machine>.py` (copy the structure of `turbofan.py`). Build the shell in modules that can be missing; think of what you see
   from 3 m away standing in the sand. Reuse the hardware kit; add hardware kinds to `hardware.py` rather than inventing boxes.
3. **Register it**: `shared/machines.ts` (LAYOUTS), `LEVEL_KINDS` / `COMPONENTS` in `shared/tables.ts` / `shared/salvage.ts`, `tools/check-machines.ts` KINDS, `shared/lab.ts` rows,
   `TEXT.machines`, step labels in `TEXT.steps`.
4. **Check** (section 4), fix, render previews, look, fix. Do this 2-3 rounds *before* showing the owner anything.
5. **Commit and push to `machines`.** Report to the owner in the format of section 10. Wait for review; iterate on the same step until they say it is good. Only then (and only
   if asked) does anything go towards `main`.

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
- The previous reports: chat-visible claims must be backed by a command you ran. Do not leave dead code (`if False else`) in generated scripts.

## 8. The roster (suggested order for the next machines)

Existing code-built machines to replace one at a time, each with its own `docs/machines/<m>.md`: pump housing (the reference for look and feel at size M), winch, solenoid valve,
beacon, control cabinet, robot arm, then the four salvage wrecks (truck chassis, pump jet, control rack, reactor core). New ones when the owner asks: see the plan file's catalogue.
Keep `LEVEL_KINDS` in mind: level 0 scrap fields hold only small starter machines; jet engines must stay (nearly) absent from normal crash sites because downed jets are their source.

## 9. Backlog, in the order I would take it (an agent can do all of these with no human in the loop except where marked)

1. **Findable jet wrecks**: smoke column + locator dot + beep like normal crash sites (`src/world/crashSmoke.ts`, `src/crashSound.ts`, `src/locator.ts` read `crashSpent` and crash-site
   lists; add the jet crashes as sources), until every engine at that wreck is stripped. Keep wrecks whose engines are untouched when the 12-site cap trims (`shared/jetcrash.ts JET_CRASH_MAX`).
2. **Jammed jets** (`shared/jammer.ts`) should land gentler than shot ones: fewer pieces tear off, engines mostly stay whole (`soft` in `shared/jets.ts` is available).
3. **Shell to scrap at the end / recreatable shell** (turbofan.md): scrap grant on stripping the last step (`server/crash.ts` `scrapFor` and its `reward` callback), numbers in `shared/tables.ts SCRAP_REWARD`.
4. **Uses for the five rotor/manifold parts**: a recipe for a built engine at the workbench (`shared/crafting.ts`, `shared/tables.ts` recipes), a gear slot; *ask the owner* what a built engine does if the plan file does not say.
5. **Terrain hollow for ordinary crash sites** (not only jets): a crater, bank and furrow from the machine's pose, stamped by the server once (`server/terrain.ts crater(..., false)`).
6. **Piece as an inventory item** (a second F puts a held piece into the bag): needs an item per module kind; keep "F again puts it down" as the first step.
7. Normal-world performance (trace first), then the next machine from section 8.

## 10. What the owner should think about and steer (and how an agent asks)

**Decisions only the owner can make** (an agent should propose a default and keep going, then list these in its report):
- Which machine or feature is next, and how big (steps, scrap values, drop rates). Defaults: use the numbers in `docs/machines/turbofan.md` and `shared/tables.ts` and adjust by feel.
- Art direction: used-future, mechanical, water-seeking cities' leftovers (`docs/look.md`). Anything that shifts it (colours, new materials, text) is theirs.
- What the economy rewards: how much scrap for fasteners and for finishing, how rare engines are (jets spawn every 2.5-6 min, max two, three hits to down), the odds
  an engine tears off (0.8) and is wrecked (0.3) (`shared/jetbreak.ts`).
- What a built engine or rotor is *for* (vehicle, base generator).
- When a step is good enough to merge to `main`.

**How the owner can give feedback that makes the next round fast**: a screenshot with the problem circled (it has worked every time), the machine name and which step, what
they expected. For performance: a Chrome trace saved while looking at the problem, plus the stats panel (draws / tris) in view. Say if a build was stale (the server and client must be restarted fresh; a few "bugs" were old clients).

**An agent should only stop and ask** when a choice changes the design in a way that is expensive to undo (a new economy rule, deleting a feature, anything that touches `main`). Everything else:
pick the recommended option, say so in one line, and move on.

## 11. Report format after each round

- One line: what is on the branch now and the commit.
- **Verified** (commands run and what they printed) and **not verified** (what only the running game can show).
- What to look at, with the URL (`?w=lab` or the jet recipe) and exact steps; what you expect to see.
- Defaults you chose that the owner may want to change (numbers, names, odds).
- Next step you would take.
