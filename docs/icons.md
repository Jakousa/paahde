# Item icons

Every item in the inventory, the hotbar and the build menu has one kind of icon: a Blender render of its model. Never
draw one by hand as an SVG or use a letter. If an item has no Blender model, render it from whatever model the game
draws for it (see "Models built in code" below).

## The look

All of this comes from `tools/blender/items.py` (`setup_render`, `CAM_DIR`, `render_grid_icon`). Import those helpers
rather than copying them.

- **Camera:** orthographic, the same 3/4 view for every icon: from the front-right and above (`CAM_DIR`). Turn the
  model rather than the camera. Lay it so its most recognisable side faces the camera: a cabinet stands with its door
  to the front, and a flat tool such as the wrench is turned face-on (`face_on` in `tools/blender/icons.py`).
- **Light:** the three sun lamps (key, fill, rim) and the warm grey world of `setup_render`, with the Standard view
  transform. Never add lights of your own for one item.
- **Outline:** Freestyle silhouette, 1.2 px, dark brown (≈ `#0d0805`). It keeps the shape readable on any slot
  background.
- **Background:** transparent PNG.
- **Model:** the game's own low-poly model with flat Principled colours, never a separate prettier one. The icon
  should look like the thing you pick up.
- **Tiers** (parts) keep the silhouette and change the finish: scrap is rusty, dented and taped; basic is plain paint;
  quality has bevels and chrome, copper or orange accents; space is white or gunmetal with a cyan glow. The inventory
  adds the rarity colour (underline and glow), not the icon.

## Size and framing

- **Shape:** an icon is rendered at its item's grid shape (`ITEMS[kind].size` in `shared/items.ts`), at twice its CSS
  size in the Tab inventory: `2 × (n × 54 + (n − 1) × 4)` px per side, so 108 for 1 cell, 224 for 2, 340 for 3 and
  456 for 4 (`grid_px`). Pass the item's cells to `render_grid_icon`, which also frames the model.
- **Framing:** the model's bounding box fills the frame with a 10 % margin (`pad=1.1`), centred.
- **When the model doesn't fit the shape:** turn it until it does. The UV lamp is turned end-on so it fits its tall
  1 × 2 frame. Don't add empty space around it.
- **Older icons:** the parts (`tools/blender/items.py`), relics (`relics.py`) and salvage (`salvage/`) are still
  square 128 px. They work because the inventory fits every icon the same way, but re-render them at their grid
  shape when you next touch them.

## In the game

`src/inventory.ts` `itemIcon` gives every icon as `<img class="fit">`. It is stretched over the item's cells, keeping
its shape, and turns with the item. The hotbar fits it into 36 px, and the build menu into 46. The file is always
`public/icons/items/<kind>.png` (salvage: `public/icons/salvage/<kind>.png`). A new item needs only the PNG and an entry
in `ICONS` if it isn't a part or salvage.

## Which script renders what

| Icons | Script |
|---|---|
| parts, all tiers | `tools/blender/items.py` |
| gear (canteen, spyglass, guns, receivers, ...), the pod's console and power box | `tools/blender/finds.py` |
| buildings and placeables (windmill, battery station, power pole, plant bed, UV lamp) | `tools/blender/placeables.py` |
| the workbench, the dismantling bench, the chest | `tools/blender/stations.py` (models from `stationkit.py`) |
| the electric well | `tools/blender/well.py` |
| enemy and boss relics | `tools/blender/relics.py` |
| salvage wrecks | `tools/blender/salvage/` |
| scrap, cloth, the wrench, the carried crash-site machines | `tools/blender/icons.py` |

### Models built in code

The wrench (`src/models/wrench.ts`), the carried machines (`src/teardown/junk.ts`), the beacon (`src/world/beacons.ts`) and the tarp (`src/world/tarps.ts`) are built with three.js, not
Blender. `node tools/icons/dump.mjs` starts Vite and headless Chrome, builds them on a dev-only page
(`tools/icons/code-models.ts`) and writes their triangles and flat materials to `tools/icons/out/code-models.json`.
`blender -b --python tools/blender/icons.py` then renders them like any other icon. When one of those models
changes, run both again.

## Checking

Put the new icon next to a few existing ones on the slot colour (`rgba(66, 44, 26, 0.96)`) at in-game size: 54 px per
cell, and 36 px in the hotbar. It should read at that size, sit at the same scale and brightness as its neighbours,
and have the outline.
