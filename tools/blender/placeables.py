"""Placeable things crafted at the workbench (GitHub issues #22-#24): the plant bed and the UV lamp stand.

    blender -b --python tools/blender/placeables.py                       # models + icons
    blender -b --python tools/blender/placeables.py -- --preview out.png  # also a perspective preview render

Writes public/models/placeables/<kind>.glb and public/icons/items/<kind>.png (128x128, the same camera and
lighting as the part icons of tools/blender/items.py, whose helpers this imports).

plant_bed.glb holds three objects: `plant_bed` (the scrap-metal trough with soil) and the growth stages
`plant_bed_sprouts` and `plant_bed_grown`, which src/world/placed.ts shows or hides (shared/garden.ts stages).
uv_lamp.glb is a gantry whose legs straddle a bed's short ends (shared/placed.ts footprints match these
sizes); its tube's material is named Emit* so the bunker's material conversion keeps it glowing.

Blender is Z-up; the glTF exporter converts to Y-up. Units are metres, origin at the centre of the footprint on
the floor, long side along X (glTF X). Output is deterministic.
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import items as it  # noqa: E402  (helpers only; items.py runs nothing on import)

ROOT = it.ROOT

MATERIALS = {
    'soil': (0x3b2416, 0.0, 1.0, 0),
    'soil_dark': (0x2a180e, 0.0, 1.0, 0),
    'leaf': (0x6d9a35, 0.0, 0.7, 0),
    'leaf_dark': (0x3e6b26, 0.0, 0.75, 0),
    'leaf_light': (0x9cc24a, 0.0, 0.65, 0),
    'stem_red': (0x8e3a3a, 0.0, 0.7, 0),
    'cable': (0x1c1c1e, 0.0, 0.6, 0),
    'EmitUV': (0xd25cff, 0.0, 0.3, 5),
    'EmitLed': (0x6cff7a, 0.0, 0.4, 3),
}

# Plant bed: outer size and soil height (shared/placed.ts uses BED = 1.6 x 0.8, 0.5 high).
BED_X, BED_Y, BED_H, SOIL = 1.6, 0.8, 0.5, 0.44
# UV lamp: legs at +-LEG_X straddle the bed's short ends; the tube hangs at about TUBE_Z.
LEG_X, LAMP_TOP, TUBE_Z = 0.94, 1.98, 1.86


def patch_wall(mb, rng, length, along_x, offset, mats):
    """One side of the trough from two or three overlapping sheets of different scrap, riveted at the seams,
    with stamped ribs across them."""
    n = len(mats)
    t = 0.025
    seg = length / n
    for i, m in enumerate(mats):
        c = -length / 2 + seg * (i + 0.5)
        w = seg + 0.04  # overlap the neighbour
        h = BED_H - 0.05 - rng(0, 0.03)
        size = (w, t, h) if along_x else (t, w, h)
        loc = (c, offset, 0.04 + h / 2) if along_x else (offset, c, 0.04 + h / 2)
        v = mb.box(size, loc, m, rot=(0, 0, rng(-0.01, 0.01)))
        if m.startswith('rust'):
            mb.jitter(v, rng, 0.004)
        # Two pressed ribs across each sheet.
        for z in (0.17, 0.33):
            rs = (w - 0.06, 0.012, 0.022) if along_x else (0.012, w - 0.06, 0.022)
            o = 0.012 if offset > 0 else -0.012
            rl = (c, offset + o, z) if along_x else (offset + o, c, z)
            mb.box(rs, rl, m)
        # Rivets down the seam to the next sheet.
        if i < n - 1:
            s = c + seg / 2
            for z in (0.1, 0.25, 0.4):
                o = 0.016 if offset > 0 else -0.016
                p = (s, offset + o, z) if along_x else (offset + o, s, z)
                mb.cyl(0.009, 0.007, 0.01, 6, p, 'steel_dull', rot=it.X90 if along_x else it.Y90)


def build_bed(mb, rng):
    hx, hy = BED_X / 2, BED_Y / 2
    patch_wall(mb, rng, BED_X - 0.06, True, -hy + 0.0125, ['paint_faded', 'rust', 'steel_dull'])
    patch_wall(mb, rng, BED_X - 0.06, True, hy - 0.0125, ['steel_dull', 'paint_faded_blue', 'rust_dark'])
    patch_wall(mb, rng, BED_Y - 0.06, False, -hx + 0.0125, ['rust', 'paint_faded'])
    patch_wall(mb, rng, BED_Y - 0.06, False, hx - 0.0125, ['paint_faded_blue', 'steel_dull'])
    # Angle-iron corner posts on little feet, and a rolled lip round the top.
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box((0.06, 0.06, BED_H + 0.02), (sx * (hx - 0.03), sy * (hy - 0.03), (BED_H + 0.02) / 2), 'rust_dark')
            mb.box((0.09, 0.09, 0.02), (sx * (hx - 0.03), sy * (hy - 0.03), 0.01), 'steel_dull')
    for sy in (-1, 1):
        mb.box((BED_X, 0.04, 0.025), (0, sy * (hy - 0.02), BED_H), 'steel_dull')
    for sx in (-1, 1):
        mb.box((0.04, BED_Y, 0.025), (sx * (hx - 0.02), 0, BED_H), 'steel_dull')
    # Soil, with a few clods.
    mb.box((BED_X - 0.08, BED_Y - 0.08, SOIL - 0.06), (0, 0, 0.06 + (SOIL - 0.06) / 2), 'soil')
    for i in range(9):
        x = -hx + 0.15 + (BED_X - 0.3) * rng()
        y = -hy + 0.12 + (BED_Y - 0.24) * rng()
        mb.blob(rng(0.02, 0.035), (x, y, SOIL - 0.005), 'soil_dark')


ROWS = (-0.2, 0.0, 0.2)


def build_sprouts(mb, rng):
    for y in ROWS:
        for i in range(7):
            x = -0.62 + i * 0.205 + rng(-0.03, 0.03)
            yy = y + rng(-0.02, 0.02)
            h = rng(0.05, 0.08)
            mb.cyl(0.004, 0.003, h, 4, (x, yy, SOIL + h / 2), 'leaf_dark')
            a = rng(0, math.pi)
            for s in (-1, 1):
                ca, sa = math.cos(a), math.sin(a)
                mb.box((0.045, 0.022, 0.004), (x + s * 0.02 * ca, yy + s * 0.02 * sa, SOIL + h),
                       'leaf_light', rot=(s * 0.35 * -sa, s * 0.35 * ca, a))


def build_grown(mb, rng):
    """Leafy greens: a rosette of tilted leaves per plant, alternating dark and light rows, red-stemmed chard
    in the middle row."""
    for r, y in enumerate(ROWS):
        for i in range(5):
            x = -0.58 + i * 0.29 + rng(-0.03, 0.03)
            yy = y + rng(-0.02, 0.02)
            n = 6
            for k in range(n):
                a = k / n * 2 * math.pi + rng(-0.3, 0.3)
                ca, sa = math.cos(a), math.sin(a)
                L = rng(0.1, 0.14)
                tilt = rng(0.55, 0.85)
                mat = 'leaf_dark' if (k + r) % 2 else ('leaf' if r != 1 else 'leaf_light')
                mb.box((L, 0.06, 0.008), (x + ca * L * 0.42, yy + sa * L * 0.42, SOIL + 0.06 + math.sin(tilt) * L * 0.4),
                       mat, rot=(0, -tilt, a))
                if r == 1:
                    mb.cyl(0.005, 0.005, 0.08, 4, (x + ca * 0.02, yy + sa * 0.02, SOIL + 0.04), 'stem_red',
                           rot=(-sa * 0.4, ca * 0.4, 0))
            # A tight heart in the middle.
            v = mb.blob(0.035, (x, yy, SOIL + 0.07), 'leaf_light')
            for p in v:
                p.co.z = SOIL + 0.07 + (p.co.z - SOIL - 0.07) * 1.4


def build_lamp(mb, rng):
    for sx in (-1, 1):
        x = sx * LEG_X
        # Square-tube leg on a flat foot with two braces.
        mb.box((0.05, 0.05, LAMP_TOP - 0.02), (x, 0, (LAMP_TOP - 0.02) / 2 + 0.02), 'paint_faded_blue' if sx < 0 else 'steel_dull')
        mb.box((0.08, 0.52, 0.03), (x, 0, 0.015), 'rust_dark')
        for sy in (-1, 1):
            it.wire(mb, [(x, sy * 0.24, 0.03), (x, sy * 0.02, 0.42)], 0.012, 6, 'steel_dull')
        mb.box((0.1, 0.1, 0.05), (x, 0, LAMP_TOP - 0.02), 'steel_dull')
    # Crossbar and the lamp hanging from it on two rods.
    mb.box((2 * LEG_X + 0.1, 0.06, 0.05), (0, 0, LAMP_TOP + 0.02), 'steel_dull')
    for sx in (-1, 1):
        mb.cyl(0.006, 0.006, LAMP_TOP - TUBE_Z - 0.03, 5, (sx * 0.6, 0, (LAMP_TOP + TUBE_Z) / 2), 'steel')
    mb.box((1.52, 0.2, 0.06), (0, 0, TUBE_Z + 0.03), 'plastic_dark', bevel=0.01)
    mb.box((1.48, 0.17, 0.02), (0, 0, TUBE_Z - 0.005), 'alu')
    # Two UV tubes under the reflector, in sight from the side, and a glowing slot along both faces.
    for sy in (-1, 1):
        mb.cyl(0.024, 0.024, 1.42, 8, (0, sy * 0.045, TUBE_Z - 0.035), 'EmitUV', rot=it.Y90)
        mb.box((1.4, 0.006, 0.014), (0, sy * 0.1, TUBE_Z + 0.03), 'EmitUV')
    for sx in (-1, 1):
        mb.box((0.04, 0.22, 0.09), (sx * 0.76, 0, TUBE_Z + 0.025), 'paint_faded')
    # Ballast box on the left leg with a green lamp; the wiring runs up to the tube and down to the floor,
    # where the spare cable lies coiled.
    bx = -LEG_X + 0.075
    mb.box((0.1, 0.09, 0.17), (bx, -0.02, 1.15), 'paint_faded', bevel=0.008)
    mb.cyl(0.011, 0.011, 0.01, 8, (bx + 0.051, -0.02, 1.2), 'EmitLed', rot=it.Y90)
    it.wire(mb, [(bx, -0.02, 1.24), (bx + 0.01, -0.04, 1.5), (-LEG_X + 0.04, -0.045, LAMP_TOP - 0.06),
                 (-0.7, -0.05, TUBE_Z + 0.07)], 0.008, 5, 'cable')
    it.wire(mb, [(bx, -0.02, 1.06), (bx + 0.02, -0.045, 0.6), (bx + 0.03, -0.06, 0.12), (bx + 0.08, -0.12, 0.012)],
            0.008, 5, 'cable')
    cx, cy = bx + 0.2, -0.2
    pts = [(cx + 0.11 * math.cos(a), cy + 0.08 * math.sin(a), 0.012 + 0.004 * k)
           for k in range(3) for a in [j / 8 * 2 * math.pi for j in range(9)]]
    it.wire(mb, [(bx + 0.08, -0.12, 0.012)] + pts, 0.008, 5, 'cable')


def finish(mb, name):
    bmesh.ops.recalc_face_normals(mb.bm, faces=mb.bm.faces)
    mesh = bpy.data.meshes.new(name)
    mb.bm.normal_update()
    mb.bm.to_mesh(mesh)
    mb.bm.free()
    for m in mb.mats:
        mesh.materials.append(bpy.data.materials[m])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build(name, fn, seed):
    mb = it.MeshBuilder()
    fn(mb, it.Rng(seed))
    return finish(mb, name)


def export(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                              export_apply=True, export_materials='EXPORT', export_normals=True,
                              export_texcoords=False)


def render_icon(cam, objs, show, path):
    scene = bpy.context.scene
    for o in bpy.data.objects:
        if o.type == 'MESH':
            o.hide_render = o not in show
    it.frame_ortho(cam, show)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    preview = argv[argv.index('--preview') + 1] if '--preview' in argv else None
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in {**it.MATERIALS, **MATERIALS}.items():
        it.make_material(name, *spec)

    out = os.path.join(ROOT, 'public', 'models', 'placeables')
    icons = os.path.join(ROOT, 'public', 'icons', 'items')
    os.makedirs(out, exist_ok=True)
    bed = build('plant_bed', build_bed, 1)
    sprouts = build('plant_bed_sprouts', build_sprouts, 2)
    grown = build('plant_bed_grown', build_grown, 3)
    lamp = build('uv_lamp', build_lamp, 4)
    export([bed, sprouts, grown], os.path.join(out, 'plant_bed.glb'))
    export([lamp], os.path.join(out, 'uv_lamp.glb'))
    for o in (bed, sprouts, grown, lamp):
        d = o.dimensions
        print(f'{o.name}: tris={it.tri_count(o)} size={d.x:.3f} x {d.y:.3f} x {d.z:.3f} m')

    cam = it.setup_render(bpy.context.scene, 128, 128)
    render_icon(cam, [bed, grown, sprouts], [bed, grown], os.path.join(icons, 'plant_bed.png'))
    render_icon(cam, [lamp], [lamp], os.path.join(icons, 'uv_lamp.png'))

    if preview:
        scene = bpy.context.scene
        for o in bpy.data.objects:
            o.hide_render = False
        sprouts.hide_render = True
        # The lamp over the bed, and a second bed beside it with sprouts.
        bed2 = bed.copy()
        sp2 = sprouts.copy()
        scene.collection.objects.link(bed2)
        scene.collection.objects.link(sp2)
        bed2.location = sp2.location = (0, 1.4, 0)
        sp2.hide_render = False
        scene.render.resolution_x, scene.render.resolution_y = 1400, 900
        scene.render.film_transparent = False
        scene.render.use_freestyle = False
        bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))
        bpy.context.active_object.data.materials.append(it.make_material('ground', 0x8a8378, 0, 0.9, 0))
        cam.data.type = 'PERSP'
        cam.data.lens = 40
        it.aim(cam, Vector((0, 0.6, 0.7)), 5.2)
        scene.render.filepath = os.path.abspath(preview)
        bpy.ops.render.render(write_still=True)


main()
