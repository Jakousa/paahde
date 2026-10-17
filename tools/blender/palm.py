"""Low-poly palm tree in three growth stages, exported as glTF binaries.

    blender -b --python tools/blender/palm.py                         # writes public/models/palm_*.glb
    blender -b --python tools/blender/palm.py -- --preview out.png    # also renders the three side by side

Everything is driven by one growth factor `g` (0 = fresh cutting, 1 = full-grown), so the stages are
the same plant: same construction, palette and materials, only sizes/counts/droop change.
Blender is Z-up; the glTF exporter converts to Y-up. Units are metres, origin at the trunk base.
"""

import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

STAGES = [
    # name, growth factor, random seed
    ('palm_sapling', 0.03, 3),
    ('palm_young', 0.4, 7),
    ('palm_full', 1.0, 11),
]

# Palette (sRGB hex). Warm, slightly dusty so it sits in the orange desert light.
PALETTE = {
    'bark': 0x7a5634,
    'bark_ring': 0x4e3420,
    'crown': 0x6d6a2c,
    'frond_old': 0x4f7a2a,
    'frond': 0x5f9330,
    'frond_young': 0x8fbf45,
    'frond_dry': 0xa88a4a,
    'nut': 0x8a5a24,
}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def make_material(name, hex_color, double_sided=False, roughness=0.85):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    rgb = [srgb_to_linear(((hex_color >> s) & 0xFF) / 255) for s in (16, 8, 0)]
    mat.diffuse_color = (*rgb, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = 0
    # The glTF exporter writes doubleSided = not use_backface_culling.
    mat.use_backface_culling = not double_sided
    return mat


class Rng:
    """Tiny deterministic LCG so re-running the script gives identical models."""

    def __init__(self, seed):
        self.s = seed * 2654435761 % 2**32 or 1

    def __call__(self, a=0.0, b=1.0):
        self.s = (1664525 * self.s + 1013904223) % 2**32
        return a + (b - a) * self.s / 2**32


def lerp(a, b, t):
    return a + (b - a) * t


class MeshBuilder:
    def __init__(self, materials):
        self.bm = bmesh.new()
        self.mat_index = {name: i for i, name in enumerate(materials)}

    def v(self, p):
        return self.bm.verts.new(p)

    def face(self, verts, mat):
        f = self.bm.faces.new(verts)
        f.material_index = self.mat_index[mat]
        f.smooth = False
        return f

    def ring(self, center, radius, sides, phase=0.0, squash=1.0):
        return [self.v(center + Vector((math.cos(a) * radius, math.sin(a) * radius * squash, 0)))
                for a in (phase + 2 * math.pi * i / sides for i in range(sides))]

    def bridge(self, lo, hi, mat):
        n = len(lo)
        for i in range(n):
            j = (i + 1) % n
            self.face([lo[i], lo[j], hi[j], hi[i]], mat)


def trunk_center(s, height, lean, lean_dir):
    """Trunk axis at s in [0, 1]: rises to `height`, curving out by `lean` metres (more near the top)."""
    off = lean * (0.6 * s * s + 0.4 * s)
    return Vector((lean_dir.x * off, lean_dir.y * off, height * s))


def build_trunk(mb, g, rng):
    height = 0.1 + 6.1 * g ** 1.4
    r_base = 0.035 + 0.2 * g
    r_top = r_base * lerp(0.75, 0.62, g)
    lean = height * lerp(0.04, 0.16, g)
    lean_dir = Vector((1, 0.25, 0)).normalized()
    sides = 6 if g < 0.2 else 7
    segments = max(2, round(height / 0.38))

    # Flared root base.
    base = mb.ring(Vector((0, 0, -0.05)), r_base * 1.45, sides)
    mb.face(list(reversed(base)), 'bark_ring')
    prev = base
    for k in range(segments):
        s0 = k / segments
        s1 = (k + 0.3) / segments
        r0 = lerp(r_base, r_top, s0)
        r1 = lerp(r_base, r_top, s1)
        phase = 0.35 * k  # twist a little so ring facets don't line up into stripes
        # Ring ridge: slightly fatter loop, then the narrower stretch of bark above it.
        ridge = mb.ring(trunk_center(s0, height, lean, lean_dir), r0 * 1.12, sides, phase)
        if k == 0:
            mb.bridge(prev, ridge, 'bark_ring')
        else:
            mb.bridge(prev, ridge, 'bark')
        band = mb.ring(trunk_center(s1, height, lean, lean_dir), r1 * 0.97, sides, phase)
        mb.bridge(ridge, band, 'bark_ring')
        prev = band

    top = trunk_center(1.0, height, lean, lean_dir)
    # Crown shaft: a green-brown bulge where the fronds come out, closed with a cone.
    bulge = mb.ring(top + Vector((0, 0, r_top * lerp(0.3, 0.6, g))), r_top * lerp(1.1, 1.35, g), sides)
    mb.bridge(prev, bulge, 'crown')
    tip = mb.v(top + Vector((0, 0, r_top * lerp(1.0, 2.2, g))))
    for i in range(sides):
        mb.face([bulge[i], bulge[(i + 1) % sides], tip], 'crown')
    return top + Vector((0, 0, r_top * lerp(0.6, 1.2, g))), height, r_top


def build_frond(mb, origin, azimuth, elevation, length, width, droop, mat, rng):
    """One pinnate frond: a bending midrib with sawtooth leaflets on both sides, folded into a V."""
    n = 12
    horiz = Vector((math.cos(azimuth), math.sin(azimuth), 0))
    side = Vector((-math.sin(azimuth), math.cos(azimuth), 0))
    # Integrate the midrib: starts at `elevation` above horizontal, gravity bends it down.
    pts = [origin.copy()]
    pitch = elevation
    step = length / n
    for i in range(n):
        p = pts[-1] + (horiz * math.cos(pitch) + Vector((0, 0, math.sin(pitch)))) * step
        pts.append(p)
        pitch = max(pitch - droop * (0.5 + i / n) / n * 2.2, math.radians(-75))
    rib = [mb.v(p) for p in pts]

    def width_at(t):
        if t < 0.12:
            return 0.0  # bare petiole
        return width * math.sin(math.pi * min(1.0, (t - 0.08) / 0.92)) ** 0.6

    fold = 0.45  # how far the leaflet tips hang below the rib (fraction of width)
    for sgn in (1, -1):
        for i in range(n):
            t0, t1 = i / n, (i + 1) / n
            a, b = pts[i], pts[i + 1]
            w = width_at(t0 + 0.6 / n)
            if w <= 0:
                continue
            down = Vector((0, 0, -1))
            # Leaflet tip, swept forward towards the frond tip; notch close to the rib.
            tip = pts[min(n, i + 2)]
            edge = a.lerp(tip, 0.6) + side * sgn * w + down * w * fold * rng(0.8, 1.2)
            notch = b + side * sgn * w * 0.12 + down * w * fold * 0.15
            ve, vn = mb.v(edge), mb.v(notch)
            quad = [rib[i], ve, vn, rib[i + 1]]
            if sgn < 0:
                quad.reverse()
            mb.face(quad[:3], mat)
            mb.face([quad[0], quad[2], quad[3]], mat)


def build_crown(mb, crown, g, r_top, rng):
    count = 3 + round(7 * g ** 0.9)
    length = 0.35 + 3.6 * g
    width = length * lerp(0.2, 0.16, g)
    golden = math.pi * (3 - math.sqrt(5))
    az0 = rng(0, 2 * math.pi)
    for i in range(count):
        age = 1 - i / max(1, count - 1)  # first fronds are the oldest (outermost, droopiest)
        az = az0 + i * golden + rng(-0.15, 0.15)
        elev = math.radians(lerp(lerp(70, 55, g), lerp(35, -5, g), age)) + rng(-0.08, 0.08)
        droop = lerp(0.35, lerp(0.7, 1.6, g), age) * rng(0.85, 1.15)
        if g > 0.8 and age > 0.85:
            mat = 'frond_dry'
            droop *= 1.4
            elev -= 0.4
        elif age > 0.6:
            mat = 'frond_old'
        elif age < 0.25:
            mat = 'frond_young'
        else:
            mat = 'frond'
        l = length * lerp(0.75, 1.0, min(1, age * 1.5)) * rng(0.92, 1.08)
        o = crown + Vector((math.cos(az), math.sin(az), 0)) * r_top * 0.5
        build_frond(mb, o, az, elev, l, width, droop, mat, rng)


def build_nuts(mb, crown, r_top, rng):
    for i in range(6):
        az = i * 2 * math.pi / 6 + rng(-0.3, 0.3)
        r = 0.13 * rng(0.9, 1.1)
        c = crown + Vector((math.cos(az) * (r_top + r * 0.7), math.sin(az) * (r_top + r * 0.7), -r * rng(1.2, 2.4)))
        res = bmesh.ops.create_icosphere(mb.bm, subdivisions=1, radius=r)
        for v in res['verts']:
            v.co += c
        for f in {f for v in res['verts'] for f in v.link_faces}:
            f.material_index = mb.mat_index['nut']
            f.smooth = False


def build_palm(name, g, seed):
    rng = Rng(seed)
    mats = list(PALETTE)
    mb = MeshBuilder(mats)
    crown, _height, r_top = build_trunk(mb, g, rng)
    build_crown(mb, crown, g, r_top, rng)
    if g > 0.8:
        build_nuts(mb, crown, r_top, rng)

    mesh = bpy.data.meshes.new(name)
    mb.bm.normal_update()
    mb.bm.to_mesh(mesh)
    mb.bm.free()
    for m in mats:
        mesh.materials.append(bpy.data.materials[m])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


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


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def render_preview(objs, path):
    scene = bpy.context.scene
    xs = [-4.5, -1.5, 5]
    for o, x in zip(objs, xs):
        o.location.x = x
    # Ground plane.
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
    ground = bpy.context.active_object
    ground.data.materials.append(make_material('ground', 0xd9a066))

    cam_data = bpy.data.cameras.new('cam')
    cam_data.lens = 35
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    cam.location = (0.5, -21, 5.0)
    cam.rotation_euler = (math.radians(84), 0, 0)
    scene.camera = cam

    sun_data = bpy.data.lights.new('sun', 'SUN')
    sun_data.energy = 4
    sun_data.angle = math.radians(3)
    sun = bpy.data.objects.new('sun', sun_data)
    sun.rotation_euler = (math.radians(55), math.radians(10), math.radians(-35))
    scene.collection.objects.link(sun)

    world = scene.world or bpy.data.worlds.new('world')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (0.75, 0.45, 0.25, 1)
    bg.inputs['Strength'].default_value = 0.6

    for engine in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT', 'BLENDER_WORKBENCH'):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1000
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)

    # Close-up of the sapling (it is tiny in the wide shot).
    cam.location = (xs[0] + 0.3, -1.9, 0.75)
    cam.rotation_euler = (math.radians(75), 0, math.radians(8))
    scene.render.filepath = path.replace('.png', '_sapling.png')
    bpy.ops.render.render(write_still=True)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models'))
    ap.add_argument('--preview', default=None, help='render a PNG of all three stages side by side')
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, hex_color in PALETTE.items():
        make_material(name, hex_color, double_sided=name.startswith('frond'))

    os.makedirs(args.out, exist_ok=True)
    objs = []
    for name, g, seed in STAGES:
        obj = build_palm(name, g, seed)
        export_glb(obj, os.path.join(args.out, name + '.glb'))
        dims = obj.dimensions
        print(f'{name}: g={g} tris={tri_count(obj)} size={dims.x:.2f} x {dims.y:.2f} x {dims.z:.2f} m')
        objs.append(obj)

    if args.preview:
        render_preview(objs, os.path.abspath(args.preview))


main()
