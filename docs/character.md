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
- **Height and head size as free choices** (tall, giant, tiny; a huge head), and body sliders: odd mixes and a tuning
  job. Three bodies with set proportions instead.
- **A thick capelet:** it now sits close over chest and back with a thin hem.
- **Clipping:** the scarf's loops poked out of the smaller hoods at the back of the neck (they now stay level at the
  back, low only at the front); the hood was open at the back, a hole to see into without a cape (now drawn closed);
  the poncho's torn hem reached the belt's pouches (poncho and mantle now end above them). Every piece is checked
  against every hood and cape it can be worn with, and on every body, from behind and close up.

## The slots

Head (hood, cowl, ragged hood, shroud), eyes (goggles, monocle, round specs, welding goggles, big goggles), mask
(respirator, side canister, cloth filter mask, leather muzzle, steel grille, bandages, none), scarf (scarf, long, bib,
veil, none), shoulders (capelet, poncho, mantle, none), shoulder plate, gloves (leather, wrapped, gauntlets), boots
(buckled, wrapped, shin guards, tall), and over the robe: rags, stole, rope belt, satchel. Dyes for the robe; the hood,
cape, poncho and mantle; and the wraps. And the body: human, dwarf, gnome.

The backpack, the gear on the belt and the things carried are gameplay, not look: they show what you have.

## The bodies

Three bodies to choose from: human, dwarf and gnome (the `body` slot; its buttons sit to the left of the figure in
the Character view, the clothes and dyes to its right). The same scavenger in all three, with different proportions
(shared/look.ts `BODIES`): the human 1.85 m; the dwarf about 1.35 m and nearly as wide (a barrel of a trunk, thick
limbs on wide-set shoulders, big hands and boots, short legs, a big head; a Warcraft dwarf under a robe); the gnome
about 1 m, the head nearly a quarter of it, big hands and boots on a slight body. Fantasy convention (Tolkien, D&D, Warcraft)
for the sizes; fixed presets, not sliders (a body is a choice, not a tuning job). They are drawn only: the player
moves, collides, is hit and sees from the same height in any body (shared/sim.ts knows nothing of them).

src/models/scavenger.ts scales bones, not meshes: the root by `size` (so the held things and the hand and foot
targets grow with it), the thighs by `legs` (the body drops by what they lose, the feet stay on the ground), the chest
(Spine2) by `chest` with the shoulders scaled back (broad shoulders, arms of the same length), the neck by `neck` and
the head by `head`, the hands and feet by `hands` and `feet`; the arms and legs are set further apart (`shoulders`,
`hips`: the legs not much, or the robe's hem parts between them like trousers). Only uniform bone scales: a squashed
bone would shear everything under it as it turns. The girth (`wide`, `deep`, `limbs`) goes into the skin instead:
each trunk and limb bone's vertices are scaled in the bone's own rest frame (its inverse bind matrix, this instance's
copy), thicker across, never longer, so the bones, the clips and the IK are untouched. The hood hangs
from the neck and head and the face pieces from the head, so `neck` stays close to `head`, or the goggles and masks
grow out of the hood.

Each body moves its own way over the same clips (`GAITS`), as short races do in other games: the dwarf grounded,
rolling from foot to foot with its arms carried wide; the gnome scurrying, leaning into the run and pumping its arms.
Short legs take more steps (the clips play faster by `stride`, up to each gait's `rate`); the footprints, footsteps
and first-person bob follow the stride, the name tag sits over the head. On the bike the seat, grips and pegs stay
where they are: a short rider sits forward on the seat (up onto the back of the tank), leans over the bars until it
reaches them, and rests its feet on the frame above the pegs.

**Every piece fits every body.** Whenever a piece or a look is added or changed, look at it on all three bodies
(models lab `models-lab.html?clip=Idle&body=0,1,2&look=<packLook>`; on the bike with `&ride`): nothing may poke out of
the hood or through the robe on the dwarf's broad chest or the gnome's big head, and the hems, belt and satchel must
still sit right on short legs. A new proportion (another body, a changed scale) is checked against every piece the
same way. Riding, walking and running are checked for each body too.

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
   in the Character view and in the lab, on every body (human, dwarf, gnome; see "The bodies"): it must fit all three.

The runtime merged-look cache is reference counted: unused merged geometries are evicted beyond 24 looks or 16 MiB; original GLB geometry and live avatars are never disposed by eviction. `src/models/textureBudget.ts` caps only the 2048² color atlas to 1024² on Low/Medium startup, before GPU upload, saving about 16 MiB including mipmaps. Normal/ORM maps and High/Ultra textures retain their original resolution. Unsupported image resizing keeps the original valid texture. A reload applies a different startup texture budget.
