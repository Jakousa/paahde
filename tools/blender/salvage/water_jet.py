"""Broken water jet (GitHub issue #17): a personal watercraft stranded in the desert, salvage for #13.

    blender -b --python tools/blender/salvage/water_jet.py                         # model + icon
    blender -b --python tools/blender/salvage/water_jet.py -- --preview out.png    # also out.png + out_side.png

Writes public/models/salvage/water_jet.glb and public/icons/salvage/water_jet.png (128x128, transparent,
orthographic 3/4 view like the item icons).

A sun-bleached jet ski lying a little on its side in the sand: cream hull with a faded teal deck and a
washed-out magenta stripe, cracks and a punched-in hole by the bow, the seat gone so the battery bay and the
drive motor show, a bent handlebar missing a grip, a split windscreen and a rusty jet nozzle at the stern.

Blender is Z-up and the bow faces Blender +Y; the glTF exporter (Y-up) turns that into three.js -Z.
Units are metres (about 2.7 m long); the origin is on the ground under the middle of the hull.
Output is deterministic (fixed seeds, no Blender randomness).
"""

import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))

# Materials: name -> (sRGB hex, metallic, roughness, emission strength).
MATERIALS = {
    'hull': (0xe2d6bc, 0.0, 0.85, 0),         # sun-bleached white plastic, gone cream
    'hull_bottom': (0xb9ad96, 0.0, 0.9, 0),   # scuffed underside
    'stripe': (0xb46a86, 0.0, 0.85, 0),       # magenta decal, washed out
    'deck': (0x4f9a92, 0.05, 0.8, 0),         # faded teal
    'deck_dark': (0x3a7470, 0.05, 0.85, 0),
    'rail': (0x3a3633, 0.0, 0.8, 0),          # rubber rub rail
    'mat': (0x2e2b29, 0.0, 0.95, 0),          # footwell mats
    'hole': (0x15100d, 0.0, 1.0, 0),          # dark interior seen through cracks and the open bay
    'foam': (0xd8b45a, 0.0, 0.95, 0),         # torn seat foam
    'steel': (0x9a958c, 0.75, 0.45, 0),
    'rust': (0x8a4a24, 0.3, 0.9, 0),
    'rust_dark': (0x5a2f18, 0.3, 0.95, 0),
    'grip': (0x1e1c1a, 0.0, 0.9, 0),
    'glass': (0x5a6a70, 0.2, 0.25, 0),        # smoked windscreen
    'battery': (0x3a3c40, 0.0, 0.6, 0),
    'term_red': (0xc0392b, 0.0, 0.5, 0),
    'motor': (0x4f6d8a, 0.2, 0.55, 0),
    'wire_red': (0xa83224, 0.0, 0.6, 0),
    'wire_yellow': (0xc9a12e, 0.0, 0.6, 0),
}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def make_material(name, hex_color, metallic, roughness, emission):
    mat = bpy.data.materials.new(name)
    rgb = [srgb_to_linear(((hex_color >> s) & 0xFF) / 255) for s in (16, 8, 0)]
    mat.diffuse_color = (*rgb, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    if emission:
        bsdf.inputs['Emission Color'].default_value = (*rgb, 1)
        bsdf.inputs['Emission Strength'].default_value = emission
    mat.use_backface_culling = True
    return mat


class Rng:
    """Tiny deterministic LCG so re-running the script gives identical models."""

    def __init__(self, seed):
        self.s = seed * 2654435761 % 2**32 or 1

    def __call__(self, a=0.0, b=1.0):
        self.s = (1664525 * self.s + 1013904223) % 2**32
        return a + (b - a) * self.s / 2**32


class MeshBuilder:
    """One bmesh built in world space; every primitive gets its own material."""

    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []

    def mat(self, name):
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    def _finish(self, verts, mat, m=None):
        if m is not None:
            bmesh.ops.transform(self.bm, matrix=m, verts=verts)
        idx = self.mat(mat)
        for f in {f for v in verts for f in v.link_faces}:
            f.material_index = idx
            f.smooth = False
        return verts

    def box(self, size, loc, mat, rot=(0, 0, 0), taper=None):
        """Box centred on loc. taper=(sx, sy) scales the top face (local +Z) for wedge shapes."""
        verts = bmesh.ops.create_cube(self.bm, size=1)['verts']
        for v in verts:
            if taper and v.co.z > 0:
                v.co.x *= taper[0]
                v.co.y *= taper[1]
            v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
        m = Matrix.Translation(Vector(loc)) @ Euler(rot).to_matrix().to_4x4()
        return self._finish(verts, mat, m)

    def cyl(self, r1, r2, depth, segs, loc, mat, rot=(0, 0, 0)):
        """Cylinder/cone along local Z, centred on loc."""
        verts = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segs,
                                      radius1=r1, radius2=r2, depth=depth)['verts']
        m = Matrix.Translation(Vector(loc)) @ Euler(rot).to_matrix().to_4x4()
        return self._finish(verts, mat, m)

    def sweep(self, pts, r, mat, segs=6):
        """Bent tube through a polyline with shared rings at the joints."""
        pts = [Vector(p) for p in pts]
        rings = []
        ref = Vector((1, 0, 0))
        for i, p in enumerate(pts):
            t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
            if abs(t.dot(ref)) > 0.9:
                ref = Vector((0, 0, 1))
            u = (ref - t * ref.dot(t)).normalized()
            w = t.cross(u)
            rings.append([self.bm.verts.new(p + (u * math.cos(a) + w * math.sin(a)) * r)
                          for a in (2 * math.pi * k / segs for k in range(segs))])
            ref = u
        for lo, hi in zip(rings, rings[1:]):
            for k in range(segs):
                j = (k + 1) % segs
                self.bm.faces.new([lo[k], lo[j], hi[j], hi[k]])
        self.bm.faces.new(list(reversed(rings[0])))
        self.bm.faces.new(rings[-1])
        return self._finish([v for ring in rings for v in ring], 'grip' if mat is None else mat)

    def blob(self, r, loc, mat, squash=1.0):
        verts = bmesh.ops.create_icosphere(self.bm, subdivisions=1, radius=r)['verts']
        for v in verts:
            v.co.z *= squash
        return self._finish(verts, mat, Matrix.Translation(Vector(loc)))

    def jitter(self, verts, rng, amount):
        for v in verts:
            v.co += Vector((rng(-amount, amount), rng(-amount, amount), rng(-amount, amount)))

    def dent(self, verts, center, radius, depth):
        """Push verts near `center` inwards (towards the part's centroid)."""
        c = Vector(center)
        mid = sum((v.co for v in verts), Vector()) / len(verts)
        for v in verts:
            d = (v.co - c).length
            if d < radius:
                v.co += (mid - v.co).normalized() * depth * (1 - d / radius)


# ------------------------------------------------------------------------------------------------- hull

# Half cross-sections from the keel round to the deck centreline, (x, z) per point, at stations along Y.
# Points: keel, chine, stripe low, stripe high, gunwale, deck lip, footwell, seat/hood side, centreline.
# The face band between point k and k+1 takes BAND_MATS[k].
BAND_MATS = ['hull_bottom', 'hull', 'stripe', 'hull', 'rail', 'deck', 'deck_dark', 'deck']
STATIONS = [
    # y        keel        chine          stripe lo      stripe hi      gunwale        lip            well           side           top
    (-1.32, [(0, 0.05), (0.40, 0.09), (0.44, 0.20), (0.45, 0.25), (0.47, 0.38), (0.45, 0.42), (0.33, 0.40), (0.20, 0.41), (0, 0.43)]),
    (-0.95, [(0, 0.00), (0.43, 0.07), (0.48, 0.20), (0.49, 0.26), (0.51, 0.41), (0.49, 0.45), (0.34, 0.42), (0.22, 0.62), (0, 0.70)]),
    (-0.20, [(0, 0.00), (0.46, 0.09), (0.51, 0.22), (0.53, 0.28), (0.55, 0.46), (0.53, 0.50), (0.36, 0.45), (0.23, 0.66), (0, 0.73)]),
    (0.35, [(0, 0.02), (0.44, 0.13), (0.49, 0.25), (0.50, 0.31), (0.52, 0.51), (0.50, 0.56), (0.38, 0.60), (0.26, 0.82), (0, 0.90)]),
    (0.85, [(0, 0.10), (0.33, 0.20), (0.37, 0.29), (0.38, 0.34), (0.40, 0.54), (0.37, 0.59), (0.30, 0.67), (0.20, 0.78), (0, 0.83)]),
    (1.22, [(0, 0.28), (0.16, 0.33), (0.18, 0.39), (0.19, 0.42), (0.20, 0.52), (0.18, 0.56), (0.14, 0.60), (0.09, 0.63), (0, 0.64)]),
]
FOOTWELL_BAND = 5
FOOTWELL_SEGS = 3
BOW = Vector((0, 1.40, 0.50))


def build_hull(mb, rng):
    rings = []
    for y, half in STATIONS:
        pts = [(x, z) for x, z in half] + [(-x, z) for x, z in reversed(half[1:-1])]
        rings.append([mb.bm.verts.new((x, y, z)) for x, z in pts])
    n = len(rings[0])
    nh = len(STATIONS[0][1]) - 1  # bands on one side
    hull_faces = []
    for seg, (r0, r1) in enumerate(zip(rings, rings[1:])):
        for k in range(n):
            j = (k + 1) % n
            f = mb.bm.faces.new([r0[k], r0[j], r1[j], r1[k]])
            band = k if k < nh else n - 1 - k
            # Footwells (lip to well) get dark rubber mats from the stern up to the console.
            name = 'mat' if band == FOOTWELL_BAND and seg < FOOTWELL_SEGS else BAND_MATS[band]
            f.material_index = mb.mat(name)
            hull_faces.append(f)
    # Transom (flat stern) and a pointed bow.
    t = mb.bm.faces.new(list(reversed(rings[0])))
    t.material_index = mb.mat('hull')
    apex = mb.bm.verts.new(BOW)
    for k in range(n):
        j = (k + 1) % n
        f = mb.bm.faces.new([rings[-1][k], rings[-1][j], apex])
        band = k if k < nh else n - 1 - k
        f.material_index = mb.mat(BAND_MATS[band])
    hull_verts = [v for r in rings for v in r] + [apex]
    for f in mb.bm.faces:
        f.smooth = False
    # Knocks and dents from years of tumbling around the dunes.
    mb.dent(hull_verts, (0.52, 0.30, 0.30), 0.35, 0.06)
    mb.dent(hull_verts, (-0.50, -0.70, 0.40), 0.30, 0.04)
    mb.jitter(hull_verts, rng, 0.008)


def build_details(mb, rng):
    # Missing seat: an open bay on the seat pedestal, a few torn foam lumps and bare mounting studs left.
    mb.box((0.30, 0.66, 0.02), (0, -0.56, 0.713), 'hole', rot=(-0.04, 0, 0))
    for x, y, z, r in ((0.13, -0.92, 0.70, 0.05), (-0.12, -0.25, 0.73, 0.045), (0.12, -0.18, 0.735, 0.035)):
        mb.blob(r, (x, y, z), 'foam', squash=0.6)
    for x, y in ((0.17, -0.85), (-0.17, -0.85), (0.17, -0.28), (-0.17, -0.28)):
        mb.cyl(0.012, 0.012, 0.06, 5, (x, y, 0.74), 'steel')

    # In the bay: the battery and the drive motor (what you salvage it for), plus loose wiring.
    mb.box((0.22, 0.14, 0.16), (0.02, -0.75, 0.72), 'battery', rot=(0, 0.06, 0.15))
    mb.cyl(0.018, 0.018, 0.03, 6, (0.08, -0.74, 0.815), 'term_red', rot=(0, 0.06, 0))
    mb.cyl(0.11, 0.11, 0.3, 10, (0, -0.38, 0.72), 'motor', rot=(math.pi / 2, 0, 0))
    mb.cyl(0.115, 0.115, 0.04, 10, (0, -0.24, 0.72), 'steel', rot=(math.pi / 2, 0, 0))
    mb.sweep([(0.08, -0.74, 0.83), (0.12, -0.62, 0.92), (0.05, -0.45, 0.86), (0.03, -0.42, 0.82)], 0.012,
             'wire_red', segs=4)
    mb.sweep([(-0.06, -0.72, 0.80), (-0.16, -0.60, 0.88), (-0.24, -0.66, 0.80)], 0.012, 'wire_yellow', segs=4)

    # Handlebar on a short steering post in front of the seat, bent down on the left and missing that grip.
    post_base = Vector((0, 0.42, 0.86))
    post_top = Vector((0, 0.34, 1.02))
    mb.cyl(0.07, 0.06, 0.08, 8, post_base + Vector((0, 0, 0.03)), 'deck_dark')
    mb.sweep([post_base, post_top], 0.03, 'steel', segs=6)
    mb.sweep([(0.36, 0.30, 1.04), (0.22, 0.32, 1.06), (0, post_top.y, post_top.z + 0.02),
              (-0.20, 0.33, 1.02), (-0.32, 0.30, 0.93)], 0.016, 'steel', segs=6)
    mb.cyl(0.026, 0.026, 0.13, 8, (0.42, 0.30, 1.04), 'grip', rot=(0, math.pi / 2, 0))
    mb.box((0.18, 0.10, 0.05), (0, 0.38, 1.05), 'deck_dark', rot=(0.3, 0, 0))  # gauge pod
    # Smoked windscreen, cracked in two, the left half sagging.
    mb.box((0.26, 0.012, 0.16), (0.13, 0.58, 1.0), 'glass', rot=(-0.6, 0, -0.12), taper=(0.8, 1))
    mb.box((0.24, 0.012, 0.15), (-0.14, 0.59, 0.96), 'glass', rot=(-0.85, 0.15, 0.12), taper=(0.8, 1))

    # Cracks and a hole punched in the right bow, plus a crack running along the left side.
    mb.box((0.012, 0.22, 0.14), (0.47, 0.62, 0.36), 'hole', rot=(0, -0.2, 0.25))
    mb.box((0.012, 0.42, 0.012), (0.535, -0.05, 0.36), 'hole', rot=(0.2, 0, 0.03))
    mb.box((0.012, 0.26, 0.012), (0.528, 0.22, 0.30), 'hole', rot=(-0.45, 0, 0.05))
    mb.box((0.012, 0.55, 0.012), (-0.52, -0.55, 0.30), 'hole', rot=(0.12, 0, -0.02))
    mb.box((0.012, 0.18, 0.012), (-0.51, -0.30, 0.25), 'hole', rot=(0.7, 0, 0))

    # Stern: rusty jet nozzle, ride plate, tow eye, and a pair of little sponsons.
    mb.box((0.34, 0.30, 0.03), (0, -1.25, 0.03), 'rust_dark')
    mb.cyl(0.08, 0.065, 0.14, 8, (0, -1.38, 0.16), 'rust', rot=(math.pi / 2, 0, 0))
    mb.cyl(0.06, 0.05, 0.10, 8, (0.015, -1.48, 0.155), 'rust_dark', rot=(math.pi / 2 - 0.1, 0.25, 0))
    mb.sweep([(-0.04, -1.33, 0.36), (0, -1.40, 0.40), (0.04, -1.33, 0.36)], 0.012, 'steel', segs=4)
    for sx in (1, -1):
        mb.box((0.04, 0.40, 0.07), (sx * 0.47, -1.05, 0.14), 'hull_bottom', taper=(1, 0.6))
    # Bow eye and a loose length of rope.
    mb.sweep([(0, 1.33, 0.46), (0, 1.40, 0.44), (0, 1.36, 0.40)], 0.014, 'steel', segs=4)


def build():
    mb = MeshBuilder()
    rng = Rng(17)
    build_hull(mb, rng)
    build_details(mb, rng)
    # Lying a little on its right side with the nose dropped into the sand, then sat on the ground.
    tilt = Euler((-0.035, 0.09, 0.0)).to_matrix().to_4x4()
    bmesh.ops.transform(mb.bm, matrix=tilt, verts=mb.bm.verts)
    bmesh.ops.recalc_face_normals(mb.bm, faces=mb.bm.faces)
    zmin = min(v.co.z for v in mb.bm.verts)
    bmesh.ops.translate(mb.bm, vec=Vector((0, 0, -zmin)), verts=mb.bm.verts)
    mb.bm.normal_update()
    mesh = bpy.data.meshes.new('water_jet')
    mb.bm.to_mesh(mesh)
    mb.bm.free()
    for m in mb.mats:
        mesh.materials.append(bpy.data.materials[m])
    obj = bpy.data.objects.new('water_jet', mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def export_glb(obj, path):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_materials='EXPORT',
        export_normals=True,
        export_texcoords=False,
    )


# ------------------------------------------------------------------------------------------------ render

CAM_DIR = Vector((1.0, -1.25, 0.95)).normalized()  # same 3/4 view as the item icons


def setup_render(scene, size_x, size_y):
    for engine in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x = size_x
    scene.render.resolution_y = size_y
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.render.use_freestyle = True
    scene.render.line_thickness_mode = 'ABSOLUTE'
    scene.render.line_thickness = 1.2
    lineset = scene.view_layers[0].freestyle_settings.linesets[0]
    lineset.select_by_visibility = True
    lineset.select_silhouette = True
    lineset.select_border = True
    lineset.select_crease = False
    lineset.linestyle = lineset.linestyle or bpy.data.linestyles.new('outline')
    lineset.linestyle.color = (0.05, 0.03, 0.02)
    lineset.linestyle.thickness = 1.2

    world = scene.world or bpy.data.worlds.new('world')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (0.55, 0.45, 0.38, 1)
    bg.inputs['Strength'].default_value = 0.9

    for name, energy, rot in (('key', 3.5, (50, 0, 30)), ('fill', 1.0, (70, 0, -120)), ('rim', 3.0, (115, 0, 170))):
        data = bpy.data.lights.new(name, 'SUN')
        data.energy = energy
        data.angle = math.radians(5)
        light = bpy.data.objects.new(name, data)
        light.rotation_euler = tuple(math.radians(a) for a in rot)
        scene.collection.objects.link(light)

    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    return cam


def aim(cam, target, offset):
    cam.location = target + offset
    cam.rotation_euler = (-offset).to_track_quat('-Z', 'Y').to_euler()


def render_icon(obj, path, size):
    """Orthographic 3/4 view fitted to the model, transparent background, thin dark outline."""
    scene = bpy.context.scene
    cam = setup_render(scene, size, size)
    pts = [obj.matrix_world @ v.co for v in obj.data.vertices]
    lo = Vector([min(p[i] for p in pts) for i in range(3)])
    hi = Vector([max(p[i] for p in pts) for i in range(3)])
    aim(cam, (lo + hi) / 2, CAM_DIR * 5)
    bpy.context.view_layer.update()
    inv = cam.matrix_world.inverted()
    local = [inv @ p for p in pts]
    w = max(p.x for p in local) - min(p.x for p in local)
    h = max(p.y for p in local) - min(p.y for p in local)
    cx = (max(p.x for p in local) + min(p.x for p in local)) / 2
    cy = (max(p.y for p in local) + min(p.y for p in local)) / 2
    cam.location = cam.matrix_world @ Vector((cx, cy, 0))
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = max(w, h) * 1.08
    cam.data.clip_start = 0.01
    cam.data.clip_end = 20
    os.makedirs(os.path.dirname(path), exist_ok=True)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def render_preview(path):
    scene = bpy.context.scene
    cam = scene.camera
    scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
    scene.render.film_transparent = False
    scene.render.use_freestyle = False
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    ground = bpy.context.active_object
    ground.data.materials.append(make_material('ground', 0xd9a066, 0, 0.9, 0))
    cam.data.type = 'PERSP'
    target = Vector((0, 0, 0.45))
    for suffix, offset, lens in (('', Vector((3.0, 3.2, 2.0)), 35), ('_side', Vector((-4.6, -0.4, 1.0)), 35),
                                 ('_rear', Vector((2.2, -3.4, 2.4)), 35)):
        cam.data.lens = lens
        aim(cam, target, offset)
        scene.render.filepath = path.replace('.png', suffix + '.png')
        bpy.ops.render.render(write_still=True)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models', 'salvage', 'water_jet.glb'))
    ap.add_argument('--icon', default=os.path.join(ROOT, 'public', 'icons', 'salvage', 'water_jet.png'))
    ap.add_argument('--icon-size', type=int, default=128)
    ap.add_argument('--preview', default=None, help='also render PNG previews (3/4, side, rear 3/4)')
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in MATERIALS.items():
        make_material(name, *spec)

    obj = build()
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    export_glb(obj, args.out)
    d = obj.dimensions
    print(f'water_jet: tris={tri_count(obj)} size={d.x:.3f} x {d.y:.3f} x {d.z:.3f} m')

    render_icon(obj, args.icon, args.icon_size)
    if args.preview:
        render_preview(os.path.abspath(args.preview))


main()
