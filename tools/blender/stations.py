"""The work stations and the chest put up with the wrench (shared/placed.ts WORKBENCH, TABLE, CHEST): the same
workbench, dismantling table and chest as the base's (tools/blender/base/bunker.py builds them, this script borrows
its builders and materials), each on its own.

    blender -b --python tools/blender/stations.py                       # models + icons
    blender -b --python tools/blender/stations.py -- --preview out.png  # also a perspective preview render

Writes public/models/placeables/<kind>.glb (workbench, dismantle_bench, storage_chest) and
public/icons/items/<kind>.png at the item's grid shape, with the icon look of tools/blender/items.py (docs/icons.md).
Each model's origin is the centre of its footprint on the floor, its front +Z (glTF), long side along X; shared/placed.ts
PLACEABLES has the sizes.
"""

import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, 'base'))
import items as it  # noqa: E402  (helpers only; items.py runs nothing on import)
import bunker  # noqa: E402  (its builders; bunker.py runs nothing on import)

ROOT = it.ROOT
# kind → (bunker.py builder, icon cells)
KINDS = {
    'workbench': (bunker.build_workbench, (3, 2)),
    'dismantle_bench': (bunker.build_disassembly, (2, 2)),
    'storage_chest': (bunker.build_chest, (2, 1)),
}


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    preview = argv[argv.index('--preview') + 1] if '--preview' in argv else None
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bunker.make_materials()
    out = os.path.join(ROOT, 'public', 'models', 'placeables')
    icons = os.path.join(ROOT, 'public', 'icons', 'items')
    os.makedirs(out, exist_ok=True)
    objs = {}
    for kind, (build, _) in KINDS.items():
        o = build()
        o.name = kind
        objs[kind] = o
        bunker.export([o], os.path.join(out, f'{kind}.glb'))
        d = o.dimensions
        print(f'{kind}: tris={bunker.tri_count(o)} size={d.x:.3f} x {d.y:.3f} x {d.z:.3f} m')

    cam = it.setup_render(bpy.context.scene, 128, 128)
    for kind, (_, cells) in KINDS.items():
        it.render_grid_icon(cam, [objs[kind]], cells, os.path.join(icons, f'{kind}.png'))

    if preview:
        scene = bpy.context.scene
        for o in objs.values():
            o.hide_render = False
        objs['workbench'].location = (-2.4, 0.6, 0)
        objs['storage_chest'].location = (2.3, 0.3, 0)
        scene.render.resolution_x, scene.render.resolution_y = 1400, 800
        scene.render.film_transparent = False
        scene.render.use_freestyle = False
        bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0))
        bpy.context.active_object.data.materials.append(it.make_material('ground', 0xc2a27a, 0, 0.95, 0))
        cam.data.type = 'PERSP'
        cam.data.lens = 32
        cam.data.clip_end = 100
        it.aim(cam, Vector((0, 0, 0.7)), 7.5)
        scene.render.filepath = os.path.abspath(preview)
        bpy.ops.render.render(write_still=True)


main()
