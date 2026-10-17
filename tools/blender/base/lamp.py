"""Bunker ceiling lamp: a caged bulb under an enamel shade, exported as one glTF binary.

    blender -b --python tools/blender/base/lamp.py                        # writes public/models/base/lamp.glb
    blender -b --python tools/blender/base/lamp.py -- --preview out.png   # also renders a preview shot

One node, `lamp`, origin at the ceiling mount (it hangs down from there). src/world/base.ts hangs a copy
with a point light at each of its LAMPS; the bulb's material is EmitWarm, like the hut's bulb in bunker.py.
Blender is Z-up; the exporter converts to Y-up. Game +Z = Blender -Y. Units are metres.
"""

import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))

# Hanging length from the ceiling to the shade's top, shade height and radius.
STEM, SHADE_H, SHADE_R = 0.12, 0.16, 0.24
BULB_Y = -(STEM + SHADE_H) + 0.02  # the bulb's centre (src/world/base.ts LAMP_BULB_Y)

# name: (sRGB hex, roughness, metallic)
MATERIALS = {
    'Iron': (0x3a3430, 0.7, 0.3),
    'Enamel': (0x4f6150, 0.55, 0.1),
    'EnamelInside': (0xe8dcc0, 0.6, 0.0),
}
EMIT = {'EmitWarm': 0xffb060}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgb(h):
    return [srgb_to_linear(((h >> s) & 0xFF) / 255) for s in (16, 8, 0)]


def make_materials():
    for name, (hx, rough, metal) in MATERIALS.items():
        m = bpy.data.materials.new(name)
        rgb = hex_rgb(hx)
        m.diffuse_color = (*rgb, 1)
        m.use_nodes = True
        b = m.node_tree.nodes.get('Principled BSDF')
        b.inputs['Base Color'].default_value = (*rgb, 1)
        b.inputs['Roughness'].default_value = rough
        b.inputs['Metallic'].default_value = metal
        m.use_backface_culling = not name.startswith('Enamel')  # the open shade is seen from both sides
    for name, hx in EMIT.items():
        m = bpy.data.materials.new(name)
        rgb = hex_rgb(hx)
        m.diffuse_color = (*rgb, 1)
        m.use_nodes = True
        b = m.node_tree.nodes.get('Principled BSDF')
        b.inputs['Base Color'].default_value = (*rgb, 1)
        b.inputs['Emission Color'].default_value = (*rgb, 1)
        b.inputs['Emission Strength'].default_value = 4.0
        m.use_backface_culling = True


def G(x, y, z):
    """Game coordinates → Blender."""
    return Vector((x, -z, y))


def build_lamp():
    bm = bmesh.new()
    mats = []

    def add(res, mat, smooth=False):
        if mat not in mats:
            mats.append(mat)
        idx = mats.index(mat)
        for f in {f for v in res['verts'] for f in v.link_faces}:
            f.material_index = idx
            f.smooth = smooth

    def cyl(y0, y1, r0, r1, mat, seg=12, caps=True):
        """Vertical frustum from radius r0 at y0 to r1 at y1."""
        m = Matrix.Translation(G(0, (y0 + y1) / 2, 0))
        add(bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=seg,
                                  radius1=r0, radius2=r1, depth=y1 - y0, matrix=m), mat)

    # Ceiling rose and the stem.
    cyl(-0.03, 0.0, 0.07, 0.07, 'Iron')
    cyl(-STEM, -0.03, 0.012, 0.012, 'Iron', seg=6)
    # Shade: a cap on the stem, then a flared cone, its inside a lighter enamel (a slightly smaller cone).
    top = -STEM
    cyl(top - 0.04, top, 0.07, 0.04, 'Enamel')
    cyl(top - SHADE_H, top - 0.04, SHADE_R, 0.07, 'Enamel', seg=16, caps=False)
    cyl(top - SHADE_H + 0.004, top - 0.045, SHADE_R - 0.012, 0.062, 'EnamelInside', seg=16, caps=False)
    # Bulb (a squashed sphere) under the cap, and a wire cage round it.
    m = Matrix.Translation(G(0, BULB_Y, 0)) @ Matrix.Diagonal((1, 1, 1.25, 1))
    add(bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=6, radius=0.055, matrix=m), 'EmitWarm', True)
    cage_y0, cage_y1, cage_r = BULB_Y - 0.1, top - SHADE_H, 0.085
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        x, z = cage_r * math.cos(a), cage_r * math.sin(a)
        mm = Matrix.Translation(G(x, (cage_y0 + cage_y1) / 2, z))
        add(bmesh.ops.create_cone(bm, cap_ends=False, cap_tris=False, segments=4, radius1=0.005,
                                  radius2=0.005, depth=cage_y1 - cage_y0, matrix=mm), 'Iron')
    cyl(cage_y0 - 0.008, cage_y0, cage_r + 0.006, cage_r + 0.006, 'Iron', seg=12, caps=False)

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new('lamp')
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    for mt in mats:
        mesh.materials.append(bpy.data.materials[mt])
    obj = bpy.data.objects.new('lamp', mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def export(obj, path):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                              export_apply=True, export_materials='EXPORT', export_normals=True,
                              export_texcoords=False)


def render_preview(path):
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new('cam')
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.location = G(0.9, -0.75, 0.9)
    cam_data.lens = 50
    cam.rotation_euler = (G(0, -0.4, 0) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    world = bpy.data.worlds.new('world')
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.2, 0.18, 0.16, 1)
    for engine in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'BLENDER_WORKBENCH'):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.view_settings.view_transform = 'AgX'
    scene.render.resolution_x = 600
    scene.render.resolution_y = 600
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models', 'base', 'lamp.glb'))
    ap.add_argument('--preview', default=None)
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    make_materials()
    obj = build_lamp()
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    export(obj, args.out)
    print(f'NODE lamp: tris={sum(len(p.vertices) - 2 for p in obj.data.polygons)}')
    print(f'WROTE {args.out} {os.path.getsize(args.out) / 1024:.1f} KiB')
    if args.preview:
        render_preview(os.path.abspath(args.preview))


main()
