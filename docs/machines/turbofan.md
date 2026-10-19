# Turbofan engine (replaces `jet_engine`): reference and disassembly plan

Status: first version built (tools/blender/machines/turbofan.py, shared/machines/turbofan.ts, src/teardown/glbMachine.ts), in review in the test lab (`?w=lab`, shared/lab.ts). Not yet: the new turbine components (fan rotor, compressor rotor, combustor, turbine disc), scrap from fasteners and from the shell at the end, the shell recreated from scrap, lifts needing two players.

## Why a rework

The current jet engine is a long thin tube lying neatly on a plate with everything in order. A crash-site engine
should look crashed, be proportioned like a real engine, and come apart along its real structure, with fasteners
where a flange or a clamp really is.

## References

- CFM56 (the most common airliner engine): fan diameter about 1.74 m, length about 2.43 m, dry weight about 2,380 kg,
  bypass ratio 6:1. So the **diameter is about 70% of the length**: short and fat, with the fan face as wide as the
  engine is long. Variants range 1.55-1.74 m fan, 2.5-2.6 m long.
  (planefyi.com/engines/cfm56, engineering.purdue.edu/~propulsi/propulsion/jets/tfans/cfm56.html)
- Bigger airliner engines (GE90, PW4000) are 2.8-3.3 m across and 4.9-7.3 m long: ratio 0.45-0.6.
- Accessories are driven by an accessory gearbox (AGB) under the fan case: starter, generator, fuel pump and fuel
  control, hydraulic pump, oil pump, permanent-magnet alternator, each on its own "pad" (a bolted or V-clamped flange).
  The engine computer (FADEC) is bolted to the fan case; igniters are in the combustor casing; the oil tank sits on the
  fan case and oil is cooled by a heat exchanger by the gearbox. (USPTO accessory-mounting patents; CFM56-5B training
  documents.)
- Engine modules, front to back: spinner, fan (disc + 24-36 blades), fan case with containment ring, fan frame
  (outlet guide vanes, struts), booster (3-4 stages), high-pressure compressor (about 9 stages, variable stator vanes
  and bleed valves), annular combustor with fuel nozzles and igniters, high-pressure turbine (1-2 stages), low-pressure
  turbine (4-5 stages), turbine rear frame, exhaust nozzle and plug; a low-pressure shaft runs through a hollow
  high-pressure shaft on a few main bearings. Around it: core cowl, fan cowl and thrust-reverser halves, pylon mounts.
- Damage on real incident engines (Arik Air 737, Southwest 1380): inlet cowl gone, fan blades broken or bent at the
  root, cowl halves folded up exposing the accessories, fan blades chipped.

## Our engine: "turbofan"

Class **M** (site, worked in place). A real **CFM56-sized** engine: **fan 1.74 m, length 2.43 m** (ratio 0.71). A smaller
carried **turbojet / APU** can follow later as its own S machine.

Decided with the project owner: real CFM56 size; **components are individually present or missing** per engine
(seeded: any of them, most of them, can be gone); the **shell is its own thing** that turns into scrap when the
disassembly ends, like every machine's shell, and can later be recreated from scrap or other material (crafting is
reworked later); a built jet engine is used in **both** vehicles and the base, but that waits for the crafting overhaul.

### Which components are there

Each module and accessory has a chance of still being on the engine (seeded per engine, `machinePresence`): fan rotor,
compressor rotor, combustor, turbine disc, main bearings, and each gearbox pad (starter, generator, hydraulic pump, fuel
pump, oil pump, PMA), FADEC, ignition exciters, oil tank, oil cooler, vane actuators. A missing one leaves its mounting
bare (bolt holes, a cut harness, a scorched pad) and none of its steps or parts exist; the gearbox and the shell are
always there. So two engines differ in what they hold and what is left to take apart.

### How it lies (crash condition, no plate)

- Torn off its pylon, lying on its side at an angle, front half dug into the sand, rear end up; scorched on one side,
  paint peeled to bare metal and rust; oil and fuel stains.
- The inlet lip crushed, spinner gone or dented, 4-8 fan blades snapped at the root, others bent; fan cowl half missing,
  the other half folded back; thrust-reverser sleeve hanging; core cowl torn open along one side showing the casing.
- Accessories hanging off their pads on cables and hoses; the harness trailing; loose panels and a few blades on the
  sand around it. No cradle or skid dressing under it.

### What comes apart (steps follow the real hardware)

Sections are walked around, not turned (it is big). Each step has a reason:

1. **Cowls and covers:** fan cowl half (latches along the split line = clips, a hinge pin = bolt), core cowl panel
   (quarter-turn screws on its edge), AGB access door (screws). Frees access, gives scrap.
2. **Front (fan module):** spinner (3 bolts) -> fan blade retaining ring (bolt circle) -> the **fan rotor** with blades
   lifts out (lift, 2 players). Part: *fan rotor* (new component).
3. **Gearbox pads (underneath):** each accessory is held by a **V-clamp (clip) or 4-bolt pad flange**, plus its wires and
   hoses: starter (motor), generator (motor, and a coil winding), hydraulic pump (valve), fuel pump + control (valve),
   oil pump (bearing), PMA (coil). The gearbox itself is a split case (bolt line) with its **gear train** (gears) and
   bearings inside.
4. **Fan-case equipment:** FADEC (compute) on a mounting plate with a connector clip and harness wires; ignition exciters
   (coil) on brackets; oil tank on straps (clips); oil cooler (heatsink) on two bolts and two hose fittings.
5. **Core:** compressor casing split line (bolt circle) -> **compressor rotor** (new component) with variable-vane
   actuators (relay) and bleed valve (valve); combustor casing (bolt flange) -> **combustor** (new component) with fuel
   nozzles (valve) and igniter plugs (coil); turbine casing (bolt flange) -> **turbine disc** (new component) and the
   main shaft bearings (bearing).
6. **Rear:** exhaust nozzle and plug (clamp ring, bolts) - scrap-heavy frame.

Fasteners: axial bolt circles on flanges, V-band clamps (a clip with a T-bolt) round core joints, radial pad bolts on
the gearbox, latches on cowls, B-nut fittings on lines. Each faces along its flange normal (so they point in many
directions), and each one holds something you can see.

### What you get

- Generic parts the engine really contains: motor (starter, generator), gear (gearbox), bearing (main shaft + pump),
  valve (fuel control, bleed, hydraulic), compute (FADEC), coil (ignition, PMA), heatsink (oil cooler), relay (vane
  actuators). No battery or impeller.
- **New components, specific to turbines:** *fan rotor*, *compressor rotor*, *combustor*, *turbine disc*, each in four
  tiers. They are only found in engines, so collecting a full set matters.
- Scrap for every fastener, and the **shell** (casings, cowls, frames, nozzle) turns into a pile of scrap when the last
  step or part is out, like every machine's shell (more, being the biggest). The shell is a made thing: it can be recreated
  from scrap later, so its scrap value is the recipe's cost.

### A turbofan you can build

Because the engine-only components exist, a **jet engine can be built at the workbench** from them plus generic parts, and
used in a larger build. Used in both a jet vehicle and a base generator (decided), built when the crafting system is reworked. Its tier follows
the lowest tier among the four turbine components.

## Build plan (when approved)

1. Blender: `tools/blender/machines/turbofan.py` on the shared kit (lathe-turned casings, ring flanges with bolt
   circles, blade rows, cowl halves with crush damage, gearbox, accessories, harness), posed in its crashed state,
   half-buried orientation handled by the site placement.
2. Layout: steps and holds as above; new component ids; loot table; label text and speech.
3. Yard: replaces the old jet engine in the second row; review in the test lab.

## Review notes (round 1)

- The model holds only the engine: no sand, furrows or debris. The crash mark is the terrain's job (carve a hollow, bank and
  furrow from the machine's pose, like craters and the colossus's footprints).
- Next: the aerodynamic shell on the engine (shared with the flying jets), seams ground open with a craftable grinder; parts
  from real engine hardware (fan rotor in 3 sizes, compressor rotor, fuel manifold, turbine disc, bearings high tier).
