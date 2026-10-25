"""The work stations and the chest put up with the wrench (shared/placed.ts WORKBENCH, TABLE, CHEST), and the shelters'
hand pump (src/world/shelters.ts). The builders and materials are in tools/blender/stationkit.py.

    blender -b --python tools/blender/stations.py                       # models + icons
    blender -b --python tools/blender/stations.py -- --only pump        # only some (comma-separated kinds, or pump)
    blender -b --python tools/blender/stations.py -- --preview out.png  # also a perspective preview render

Writes public/models/placeables/<kind>.glb (workbench, dismantle_bench, storage_chest) and
public/icons/items/<kind>.png at the item's grid shape, with the icon look of tools/blender/items.py (docs/icons.md),
and public/models/pump.glb (node `pump`). Each model's origin is the centre of its footprint on the floor, its front +Z
(glTF), long side along X; shared/placed.ts PLACEABLES has the sizes.
"""

import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
sys.path.insert(0, HERE)
import items as it  # noqa: E402  (helpers only; items.py runs nothing on import)
import stationkit as kit  # noqa: E402  (its builders; runs nothing on import)

ROOT = it.ROOT
# kind → (stationkit.py builder, icon cells)
KINDS = {
    'workbench': (kit.build_workbench, (3, 2)),
    'dismantle_bench': (kit.build_disassembly, (2, 2)),
    'storage_chest': (kit.build_chest, (2, 1)),
}


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    preview = argv[argv.index('--preview') + 1] if '--preview' in argv else None
    only = set(argv[argv.index('--only') + 1].split(',')) if '--only' in argv else None
    bpy.ops.wm.read_factory_settings(use_empty=True)
    kit.make_materials()
    out = os.path.join(ROOT, 'public', 'models', 'placeables')
    icons = os.path.join(ROOT, 'public', 'icons', 'items')
    os.makedirs(out, exist_ok=True)
    if only is None or 'pump' in only:
        pump = kit.build_pump()
        kit.export([pump], os.path.join(ROOT, 'public', 'models', 'pump.glb'))
        print(f'pump: tris={kit.tri_count(pump)}')
        bpy.data.objects.remove(pump)
        if only is not None and only == {'pump'}:
            return
    objs = {}
    for kind, (build, _) in KINDS.items():
        if only is not None and kind not in only:
            continue
        o = build()
        o.name = kind
        objs[kind] = o
        kit.export([o], os.path.join(out, f'{kind}.glb'))
        d = o.dimensions
        print(f'{kind}: tris={kit.tri_count(o)} size={d.x:.3f} x {d.y:.3f} x {d.z:.3f} m')

    cam = it.setup_render(bpy.context.scene, 128, 128)
    for kind, (_, cells) in KINDS.items():
        if kind not in objs:
            continue
        it.render_grid_icon(cam, [objs[kind]], cells, os.path.join(icons, f'{kind}.png'))

    if preview and len(objs) == len(KINDS):
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
