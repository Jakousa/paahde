# The character: how the scavenger looks

Design notes for the player character (`tools/models/scavenger.py` → `public/models/scavenger.glb`) and the looks a
player can choose for it (shared/look.ts, the main menu's Character view: src/lookView.ts). What we're going for, what
was tried and dropped and why, and how to add a piece.

## The direction

- **One character, many outfits.** Every look is the same tired, stubborn scavenger: a long robe to the shins, the head
  covered, the face hidden, two glowing lenses for eyes. A choice changes what they've scraped together, never who
  they are.
- **Primitive and makeshift.** Old cloth, worn thin and torn: frayed and jagged hems, strips and rags, bandages, rope,
  patched leather, a scrap plate. Things found and tied on, not made to fit. References that set it (2026-10): a
  pilgrim in a ragged mantle with a stole, rope belt and bandaged face; a sand traveller under a head cloth with
  bedrolls and drapes; a burlap poncho over everything; a long cloak and a cowl of wound cloth.
- **The silhouette reads at a distance:** the hood's point, the gown's ragged hem, the pack on the back. Pieces change
  the outline within that, at the head, shoulders and hem, and in colour.
- **Colours are dusty and muted:** bone, sand, khaki, umber, soot, rust, oxblood, olive, slate, indigo. One palette in
  one order for every dyed cloth (shared/look.ts DYE_COLORS). The player's own colour is the bright accent: scarf,
  mask, sash, armband, stole.
- **Stylised, not realistic** (docs/look.md): soft forms, few triangles (~22k worn), detail in the baked texture.

## What we tried and dropped

- **Hats, a turban, a helmet:** each read as another character. Keep the head under cloth.
- **The hood thrown back, a slit visor:** the bare head wrap and the visor's bands read as an odd hat.
- **Short coats and light looks** (a crossover tunic, no pack, in the spirit of a desert scavenger in a light wrap):
  not this character. Only long gowns.
- **No face:** goggles pushed up, or no eye piece at all, leave a blank egg of a head. There are always eyes.
- **A bunched snood:** too much, and it stuck out of the hood.
- **A big hood:** the old hood was too big; now ~20% smaller, close round the head (shrunk about the brow so the crown
  keeps clear of the skull).
- **Bands wound over the skull:** in the hood's shadow they read as swirls. The head wrap is smooth.
- **A thick capelet:** it now sits close over chest and back with a thin hem.
- **Clipping:** the scarf's loops poked out of the smaller hoods at the back of the neck (they now stay level at the
  back, low only at the front); the hood was open at the back, a hole to see into without a cape (now drawn closed);
  the poncho's torn hem reached the belt's pouches (poncho and mantle now end above them). Every piece is checked
  against every hood and cape it can be worn with, from behind and close up.

## The slots

Head (hood, cowl, ragged hood, shroud), eyes (goggles, monocle, round specs, welding goggles, big goggles), mask
(respirator, side canister, cloth filter mask, leather muzzle, steel grille, bandages, none), scarf (scarf, long, bib,
veil, none), shoulders (capelet, poncho, mantle, none), shoulder plate, gloves (leather, wrapped, gauntlets), boots
(buckled, wrapped, shin guards, tall), and over the robe: rags, stole, rope belt, satchel. Dyes for the robe; the hood,
cape, poncho and mantle; and the wraps.

The backpack, the gear on the belt and the things carried are gameplay, not look: they show what you have.

## Adding a piece

1. Build it in `tools/models/scavenger.py` as a `build_<piece>()` that adds its parts with `part(...)`, and register it
   in `build_character` with `tagged('<Piece>', build_<piece>)`: it becomes the mesh `Scavenger_<Piece>`. Use the
   dyed cloth (`M['robe']`, `M['cape']`, `M['wrap']`) or the player colour (`M['tint']`) for cloth, so it takes the
   dyes; `torso_r(z)` / `on_robe(a, z, off)` put things on the robe's surface. Weight it like what it lies on (rigid on
   the head, `skirt_weights` below the belt, the cape's bones over the shoulders).
2. Look at it before baking (the Character view zooms to the face, so close-ups matter): `scavenger.py -- --fast`, then `tools/models/look_preview.py` with the pieces and dyes
   you want, then `render_preview.py` (front, back, side, face). Check it from behind and close up, with the other
   pieces it goes with: nothing may poke through (paint the head wrap red to find a clipping hood).
3. Add the option to its slot in `shared/look.ts` (at the end of the list) and its meshes to `LOOK_PIECES` in
   `src/models/scavenger.ts`, bake (`scavenger.py` without `--fast`, ~10 min, one Blender at a time) and look at it
   in the Character view and in the lab.
