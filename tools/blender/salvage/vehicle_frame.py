"""Broken vehicle frame (GitHub issue #14, salvage for #13), exported as a glTF binary + inventory icon.

    blender -b --python tools/blender/salvage/vehicle_frame.py                       # glb + icon
    blender -b --python tools/blender/salvage/vehicle_frame.py -- --preview out.png  # also a 3/4 render on sand

Writes public/models/salvage/vehicle_frame.glb and public/icons/salvage/vehicle_frame.png (128x128,
transparent, the same orthographic 3/4 camera and lighting as tools/blender/items.py icons).

The rusted ladder chassis of a small electric buggy, beyond repair: one side rail snapped and bent down
into the sand, the front axle twisted with a bare hub, a snapped roll hoop, a crumpled seat pan. What is
still worth something is visible: a cracked battery tray with cells, the rear hub motor and a finned
controller heat sink, with cut wires hanging off. About 1.6 x 0.9 x 0.6 m: something one person can drag.

Blender is Z-up; the glTF exporter converts to Y-up. Units are metres; the origin is on the ground at the
centre of the footprint. The frame's nose points along Blender +Y (three.js -Z).
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
NAME = 'vehicle_frame'

# Materials: name -> (sRGB hex, metallic, roughness, emission strength).
MATERIALS = {
    'rust': (0x8a4a24, 0.3, 0.9, 0),
    'rust_dark': (0x5a2f18, 0.3, 0.95, 0),
    'rust_light': (0xa8602e, 0.25, 0.9, 0),
    'paint_faded': (0x6f8a6a, 0.1, 0.85, 0),      # flaking army-green paint on the tray
    'paint_yellow': (0xb89a3a, 0.1, 0.85, 0),     # faded hazard yellow on the roll hoop
    'steel_dull': (0x7d776e, 0.6, 0.7, 0),
    'alu': (0xa9aaa6, 0.7, 0.55, 0),              # weathered heat sink fins
    'motor': (0x4a4744, 0.5, 0.6, 0),
    'copper': (0xb06a3a, 0.9, 0.4, 0),
    'cell': (0x3a3c40, 0.0, 0.6, 0),
    'cell_wrap': (0x4f6d8a, 0.1, 0.6, 0),
    'rubber': (0x2b2420, 0.0, 0.95, 0),
    'wire_red': (0xa83224, 0.0, 0.6, 0),
    'wire_yellow': (0xc9a12e, 0.0, 0.6, 0),
    'tape': (0x9a9890, 0.0, 0.8, 0),
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
    """One bmesh for the whole object, built in place; every primitive gets its own material."""

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

    def box(self, size, loc, mat, rot=(0, 0, 0)):
        verts = bmesh.ops.create_cube(self.bm, size=1)['verts']
        for v in verts:
            v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
        m = Matrix.Translation(Vector(loc)) @ Euler(rot).to_matrix().to_4x4()
        return self._finish(verts, mat, m)

    def cyl(self, r1, r2, depth, segs, loc, mat, rot=(0, 0, 0)):
        """Cylinder/cone along local Z, centred on loc."""
        verts = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segs,
                                      radius1=r1, radius2=r2, depth=depth)['verts']
        m = Matrix.Translation(Vector(loc)) @ Euler(rot).to_matrix().to_4x4()
        return self._finish(verts, mat, m)

    def tube(self, a, b, r, mat, segs=6):
        """Straight tube from point a to point b."""
        a, b = Vector(a), Vector(b)
        d = b - a
        verts = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segs,
                                      radius1=r, radius2=r, depth=d.length)['verts']
        q = d.normalized().to_track_quat('Z', 'Y')
        m = Matrix.Translation((a + b) / 2) @ q.to_matrix().to_4x4()
        return self._finish(verts, mat, m)

    def sweep(self, pts, r, mat, segs=6, square=False):
        """Bent tube through a polyline with shared rings at the joints. square=True gives box section."""
        pts = [Vector(p) for p in pts]
        rings = []
        ref = Vector((0, 0, 1))
        off = math.pi / 4 if square else 0
        for i, p in enumerate(pts):
            t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
            if abs(t.dot(ref)) > 0.9:
                ref = Vector((1, 0, 0))
            u = (ref - t * ref.dot(t)).normalized()
            w = t.cross(u)
            rr = r * (math.sqrt(2) if square else 1)
            rings.append([self.bm.verts.new(p + (u * math.cos(a) + w * math.sin(a)) * rr)
                          for a in (off + 2 * math.pi * k / segs for k in range(segs))])
            ref = u
        for lo, hi in zip(rings, rings[1:]):
            for k in range(segs):
                j = (k + 1) % segs
                self.bm.faces.new([lo[k], lo[j], hi[j], hi[k]])
        self.bm.faces.new(list(reversed(rings[0])))
        self.bm.faces.new(rings[-1])
        verts = [v for ring in rings for v in ring]
        bmesh.ops.recalc_face_normals(self.bm, faces=list({f for v in verts for f in v.link_faces}))
        return self._finish(verts, mat)

    def jitter(self, verts, rng, amount):
        for v in verts:
            v.co += Vector((rng(-amount, amount), rng(-amount, amount), rng(-amount, amount)))

    def dent(self, verts, center, radius, depth):
        c = Vector(center)
        mid = sum((v.co for v in verts), Vector()) / len(verts)
        for v in verts:
            d = (v.co - c).length
            if d < radius:
                v.co += (mid - v.co).normalized() * depth * (1 - d / radius)


Y90 = (0, math.pi / 2, 0)  # turns a Z-axis cylinder to lie along X
X90 = (math.pi / 2, 0, 0)  # ... along Y


# ------------------------------------------------------------------------------------------------- model

RAIL_X = 0.34      # side rails at +-x
RAIL_Z = 0.22      # rail centre height
RAIL_R = 0.035     # half the box-section size
REAR_Y, FRONT_Y = -0.75, 0.72


def build(mb, rng):
    z = RAIL_Z
    # ---- ladder chassis: square-section side rails. The left rail is intact but sags; the right one
    # snapped just ahead of the seat and its front half is bent down into the sand.
    left = mb.sweep([(-RAIL_X, REAR_Y, z + 0.02), (-RAIL_X, -0.2, z), (-RAIL_X + 0.01, 0.3, z - 0.02),
                     (-RAIL_X + 0.03, FRONT_Y, z + 0.06)], RAIL_R, 'rust', segs=4, square=True)
    mb.jitter(left, rng, 0.006)
    mb.sweep([(RAIL_X, REAR_Y, z + 0.02), (RAIL_X, -0.2, z), (RAIL_X - 0.01, 0.12, z - 0.01)],
             RAIL_R, 'rust', segs=4, square=True)
    # Snapped-off front half, kinked down so its end digs into the ground.
    broken = mb.sweep([(RAIL_X + 0.03, 0.16, z - 0.05), (RAIL_X + 0.08, 0.42, z - 0.11),
                       (RAIL_X + 0.16, FRONT_Y - 0.04, RAIL_R * 0.6)], RAIL_R, 'rust_dark', segs=4, square=True)
    mb.jitter(broken, rng, 0.008)
    # Torn ends: a jagged collar of rust flakes on both sides of the break.
    for p in ((RAIL_X - 0.01, 0.13, z - 0.01), (RAIL_X + 0.03, 0.17, z - 0.05)):
        mb.box((0.08, 0.025, 0.08), p, 'rust_light', rot=(rng(-0.4, 0.4), rng(-0.3, 0.3), rng(-0.5, 0.5)))

    # Cross members: rear, middle, front (front one twisted and only welded to the left rail).
    mb.box((2 * RAIL_X, 0.06, 0.06), (0, REAR_Y + 0.05, z + 0.02), 'rust_dark')
    mb.box((2 * RAIL_X, 0.05, 0.05), (0, -0.12, z), 'rust')
    mb.box((0.52, 0.05, 0.05), (-RAIL_X + 0.26, FRONT_Y - 0.08, z + 0.04), 'rust_dark', rot=(0.25, 0, -0.18))

    # ---- front axle: bent beam with a bare hub (tyre long gone) on the left, the other end snapped.
    fy = FRONT_Y - 0.1
    mb.sweep([(-RAIL_X - 0.18, fy + 0.02, 0.16), (-RAIL_X, fy, 0.2), (-0.05, fy - 0.02, 0.22),
              (0.12, fy + 0.03, 0.16)], 0.025, 'steel_dull', segs=6)
    mb.cyl(0.11, 0.11, 0.06, 10, (-RAIL_X - 0.21, fy + 0.02, 0.15), 'rust', rot=(0, math.pi / 2, 0.15))
    mb.cyl(0.05, 0.05, 0.1, 8, (-RAIL_X - 0.23, fy + 0.02, 0.15), 'steel_dull', rot=(0, math.pi / 2, 0.15))
    # Shredded scrap of tyre still clinging to the rim.
    mb.box((0.06, 0.16, 0.05), (-RAIL_X - 0.21, fy + 0.04, 0.03), 'rubber', rot=(0.3, 0.1, 0.1))

    # ---- rear axle with the hub motor (worth salvaging) on the right and a flat tyre on the left.
    ry = REAR_Y + 0.12
    mx = RAIL_X + 0.12
    mb.cyl(0.02, 0.02, 2 * RAIL_X + 0.32, 6, (0, ry, 0.2), 'steel_dull', rot=Y90)
    # Hub motor: fat can with an end bell, copper-glinting shaft nut and a few bolt heads.
    mb.cyl(0.13, 0.13, 0.13, 12, (mx, ry, 0.2), 'motor', rot=Y90)
    mb.cyl(0.12, 0.135, 0.03, 12, (mx + 0.08, ry, 0.2), 'steel_dull', rot=Y90)
    mb.cyl(0.04, 0.04, 0.03, 8, (mx + 0.105, ry, 0.2), 'copper', rot=Y90)
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        mb.box((0.02, 0.02, 0.02), (mx + 0.095, ry + math.cos(a) * 0.08, 0.2 + math.sin(a) * 0.08), 'steel_dull')
    # Phase wires cut off, dangling from the motor.
    mb.sweep([(mx - 0.04, ry + 0.06, 0.3), (mx - 0.1, ry + 0.2, 0.36), (mx - 0.18, ry + 0.3, 0.3)],
             0.009, 'wire_red', segs=4)
    mb.sweep([(mx - 0.04, ry + 0.04, 0.32), (mx + 0.0, ry + 0.18, 0.2), (mx + 0.06, ry + 0.3, 0.02)],
             0.009, 'wire_yellow', segs=4)
    # Flat, sagging tyre on the left wheel: the bottom squashed onto the ground and bulging out.
    tx = -RAIL_X - 0.14
    tyre = mb.cyl(0.2, 0.2, 0.14, 10, (tx, ry, 0.19), 'rubber', rot=Y90)
    for v in tyre:
        if v.co.z < 0.06:
            v.co.y += (v.co.y - ry) * 0.3
            v.co.x += (v.co.x - tx) * 0.3
            v.co.z = 0.0 if v.co.z < 0.02 else 0.03
    mb.jitter(tyre, rng, 0.008)
    mb.cyl(0.11, 0.11, 0.15, 8, (tx, ry, 0.19), 'rust_light', rot=Y90)

    # ---- battery tray between the rails: green-painted tub, lid cracked open and slid aside, cells inside.
    by, bz = 0.25, z + 0.02
    tub = mb.box((0.5, 0.42, 0.14), (0, by, bz), 'paint_faded')
    mb.dent(tub, (0.25, by + 0.1, bz + 0.07), 0.15, 0.04)
    mb.jitter(tub, rng, 0.004)
    for i in range(3):
        for j in range(2):
            mb.box((0.13, 0.17, 0.12), (-0.15 + i * 0.15, by - 0.09 + j * 0.19, bz + 0.08),
                   'cell' if (i + j) % 2 else 'cell_wrap', rot=(0, rng(-0.06, 0.06), rng(-0.05, 0.05)))
    mb.box((0.02, 0.36, 0.02), (0, by, bz + 0.15), 'copper', rot=(0, 0, 0.04))  # bus bar
    # Lid half: lifted on one edge, flaking, with tape across a crack.
    lid = mb.box((0.52, 0.24, 0.02), (-0.05, by + 0.2, bz + 0.2), 'paint_faded', rot=(0.55, 0.06, 0.12))
    mb.jitter(lid, rng, 0.006)
    mb.box((0.06, 0.25, 0.025), (0.05, by + 0.2, bz + 0.205), 'tape', rot=(0.55, 0.06, 0.12))

    # ---- controller box with a finned heat sink on top, bolted behind the seat cross member.
    cy, cz = -0.47, z + 0.085
    mb.box((2 * RAIL_X + 0.04, 0.2, 0.012), (0, cy, z + 0.035), 'rust_dark', rot=(0, 0.03, 0))  # mounting plate
    mb.box((0.26, 0.18, 0.09), (0.1, cy, cz), 'motor', rot=(0, 0, 0.08))
    for k in range(6):
        h = 0.07 if k != 4 else 0.035  # one fin snapped short
        mb.box((0.25, 0.008, h), (0.1 - 0.012 * k * 0.08, cy - 0.075 + k * 0.03, cz + 0.045 + h / 2), 'alu',
               rot=(rng(-0.08, 0.08) + (0.35 if k == 5 else 0), 0, 0.08))
    mb.sweep([(-0.04, cy + 0.06, cz), (-0.12, cy + 0.15, cz + 0.12), (-0.08, by - 0.2, bz + 0.15)],
             0.01, 'wire_red', segs=4)

    # ---- seat pan: crumpled sheet on two stubs, sitting crooked over the middle cross member.
    seat = mb.box((0.44, 0.4, 0.025), (-0.04, -0.2, z + 0.2), 'rust_light', rot=(-0.12, 0.18, 0.05))
    mb.dent(seat, (0.1, -0.12, z + 0.2), 0.2, 0.05)
    mb.jitter(seat, rng, 0.008)
    for x in (-0.18, 0.1):
        mb.box((0.04, 0.04, 0.16), (x, -0.2, z + 0.1), 'rust_dark')

    # ---- roll hoop: rose from the rear corners, snapped at the top; one half folded back over the rear.
    mb.sweep([(-RAIL_X + 0.02, REAR_Y + 0.1, z + 0.03), (-RAIL_X + 0.04, REAR_Y + 0.05, 0.55),
              (-RAIL_X + 0.12, REAR_Y + 0.02, 0.66), (-0.07, REAR_Y + 0.04, 0.68)], 0.025, 'paint_yellow', segs=6)
    mb.sweep([(RAIL_X - 0.02, REAR_Y + 0.1, z + 0.03), (RAIL_X - 0.03, REAR_Y - 0.02, 0.4),
              (RAIL_X - 0.1, REAR_Y - 0.2, 0.42), (0.1, REAR_Y - 0.28, 0.33)], 0.025, 'paint_yellow', segs=6)
    mb.box((0.06, 0.06, 0.06), (-0.06, REAR_Y + 0.04, 0.68), 'rust', rot=(0.4, 0.3, 0.6))  # torn end


def build_object():
    mb = MeshBuilder()
    build(mb, Rng(14))
    bm = mb.bm
    # Origin on the ground at the centre of the footprint.
    lo = Vector([min(v.co[i] for v in bm.verts) for i in range(3)])
    hi = Vector([max(v.co[i] for v in bm.verts) for i in range(3)])
    bmesh.ops.translate(bm, vec=Vector((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z)), verts=bm.verts)
    bm.normal_update()
    mesh = bpy.data.meshes.new(NAME)
    bm.to_mesh(mesh)
    bm.free()
    for m in mb.mats:
        mesh.materials.append(bpy.data.materials[m])
    obj = bpy.data.objects.new(NAME, mesh)
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
# Same icon camera and lighting as tools/blender/items.py.

CAM_DIR = Vector((1.0, -1.25, 0.95)).normalized()


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


def aim(cam, target, distance):
    cam.location = target + CAM_DIR * distance
    cam.rotation_euler = (-CAM_DIR).to_track_quat('-Z', 'Y').to_euler()


def frame_ortho(cam, obj):
    pts = [obj.matrix_world @ v.co for v in obj.data.vertices]
    lo = Vector([min(p[i] for p in pts) for i in range(3)])
    hi = Vector([max(p[i] for p in pts) for i in range(3)])
    aim(cam, (lo + hi) / 2, 5)
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


def render_icon(obj, path, size):
    scene = bpy.context.scene
    cam = setup_render(scene, size, size)
    frame_ortho(cam, obj)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def render_preview(obj, path):
    """3/4 perspective view on a sand plane, plus a side and a front view."""
    scene = bpy.context.scene
    cam = scene.camera or setup_render(scene, 1600, 1100)
    scene.render.resolution_x, scene.render.resolution_y = 1600, 1100
    scene.render.film_transparent = False
    scene.render.use_freestyle = False
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0))
    ground = bpy.context.active_object
    ground.data.materials.append(make_material('ground', 0xd9a066, 0, 0.9, 0))
    cam.data.type = 'PERSP'
    cam.data.lens = 40
    target = Vector((0, 0, 0.25))
    for suffix, offset in (('', Vector((2.0, -2.5, 1.9))), ('_side', Vector((3.4, 0, 0.7))),
                           ('_front', Vector((-1.6, 2.8, 1.5)))):
        cam.location = target + offset
        cam.rotation_euler = (-offset).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = path.replace('.png', suffix + '.png')
        bpy.ops.render.render(write_still=True)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models', 'salvage', NAME + '.glb'))
    ap.add_argument('--icon', default=os.path.join(ROOT, 'public', 'icons', 'salvage', NAME + '.png'))
    ap.add_argument('--icon-size', type=int, default=128)
    ap.add_argument('--no-icon', action='store_true')
    ap.add_argument('--preview', default=None, help='also render PNG previews (3/4, side, front)')
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in MATERIALS.items():
        make_material(name, *spec)

    obj = build_object()
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    export_glb(obj, args.out)
    d = obj.dimensions
    print(f'{NAME}: tris={tri_count(obj)} size={d.x:.3f} x {d.y:.3f} x {d.z:.3f} m')

    if not args.no_icon:
        render_icon(obj, os.path.abspath(args.icon), args.icon_size)
    if args.preview:
        render_preview(obj, os.path.abspath(args.preview))


main()
