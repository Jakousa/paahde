"""Wrecked warp drive core (salvage, GitHub issue #16), exported as a glTF binary + inventory icon.

    blender -b --python tools/blender/salvage/warp_core.py                       # model + icon
    blender -b --python tools/blender/salvage/warp_core.py -- --preview out.png  # also a 3/4 render on sand

Writes public/models/salvage/warp_core.glb and public/icons/salvage/warp_core.png (128x128, transparent, the
same orthographic 3/4 camera and lighting as the item icons in tools/blender/items.py).

Once the heart of a starship: a heavy octagonal reactor column lying on its side in a bent cradle. One end
still has its coupling cap and coolant lines feeding a fin bank on top; the other end is torn off and
scorched, the inner coil stack sticks out snapped and dangles cables. A hull panel is ripped out of the
middle so the dim cyan core shows through. Strapped to the hull: a compute rack (cards, amber LEDs) and a
pair of anti-matter containment bottles with a faint magenta glow - the parts it is taken apart for.

About 1.4 x 0.75 x 0.75 m. Blender is Z-up (the glTF exporter converts to Y-up), units are metres, the origin
is on the ground under the centre of the footprint, and the core axis runs along X (three.js X too).
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

# Materials: name -> (sRGB hex, metallic, roughness, emission strength). Glows are kept dim: it's dying.
MATERIALS = {
    'hull': (0x5a5f66, 0.7, 0.5, 0),          # gunmetal housing
    'hull_light': (0xb9b4aa, 0.2, 0.6, 0),    # faded white panels, sand-scoured
    'hull_dark': (0x2e3238, 0.7, 0.5, 0),
    'ring': (0x8e9298, 0.85, 0.4, 0),
    'scorch': (0x1d1714, 0.2, 0.95, 0),       # soot black
    'burnt': (0x6a4430, 0.6, 0.7, 0),         # heat-tinted metal round the burns
    'rust': (0x8a4a24, 0.3, 0.9, 0),
    'steel_dull': (0x7d776e, 0.6, 0.7, 0),
    'copper': (0xc87a43, 1.0, 0.35, 0),
    'alu': (0xa9acae, 0.8, 0.5, 0),
    'core_dark': (0x1b2f38, 0.5, 0.5, 0),
    'core_glow': (0x1f8aa6, 0.0, 0.5, 0.7),
    'am_glow': (0xb83a9a, 0.0, 0.4, 0.7),
    'glass': (0x5a7a86, 0.1, 0.2, 0),
    'pcb': (0x2f6a3a, 0.0, 0.6, 0),
    'led': (0xffb040, 0.0, 0.4, 3),
    'hazard': (0xd9a020, 0.1, 0.6, 0),
    'cable': (0x1e1c1a, 0.0, 0.8, 0),
    'cable_red': (0xa83224, 0.0, 0.6, 0),
}

CZ = 0.33   # core axis height
R = 0.26    # housing radius (octagon)
SEGS = 8


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
    """One bmesh, built in world space; every primitive gets its own material."""

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

    def xcyl(self, r1, r2, x0, x1, segs, mat, y=0.0, z=CZ, spin=math.pi / 8):
        """Cylinder along X from x0 (radius r1) to x1 (radius r2); `spin` turns the octagon flat-side up."""
        return self.cyl(r1, r2, x1 - x0, segs, ((x0 + x1) / 2, y, z), mat, rot=(spin, math.pi / 2, 0))

    def sweep(self, pts, r, mat, segs=6):
        """Bent tube through a polyline (cables, coolant lines)."""
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
        return self._finish([v for ring in rings for v in ring], mat)

    def shell(self, x0, x1, r_out, r_in, a0, a1, segs, mat, rng=None, jag=0.0, tear=0.0):
        """Thick tube wall around the core axis (X), from angle a0 to a1 (degrees, 0 = +Y, 90 = up).
        A full 360 sweep closes on itself; a partial one leaves a ripped-out gap whose edges get `tear`
        jitter. `jag` cuts the x1 rim back by a random amount per section (torn-off end)."""
        full = abs(a1 - a0) >= 360 - 1e-6
        n = segs if full else segs + 1
        secs = []
        for i in range(n):
            a = math.radians(a0 + (a1 - a0) * i / segs)
            d = Vector((0, math.cos(a), math.sin(a)))
            cut = rng(0, jag) if jag else 0.0
            if jag and i % 2:
                cut *= 0.25  # alternate deep and shallow notches: a saw-tooth tear
            sec = [self.bm.verts.new(Vector((x, 0, CZ)) + d * r)
                   for x, r in ((x0, r_out), (x1 - cut, r_out), (x1 - cut, r_in), (x0, r_in))]
            if tear and not full and i in (0, n - 1):
                for v in sec[1:3]:
                    v.co += Vector((rng(-tear, tear), rng(-tear, tear), rng(-tear, tear)))
            secs.append(sec)
        pairs = list(zip(secs, secs[1:])) + ([(secs[-1], secs[0])] if full else [])
        for s0, s1 in pairs:
            for k in range(4):
                j = (k + 1) % 4
                self.bm.faces.new([s0[k], s1[k], s1[j], s0[j]])
        if not full:
            self.bm.faces.new(list(reversed(secs[0])))
            self.bm.faces.new(secs[-1])
        verts = [v for s in secs for v in s]
        bmesh.ops.recalc_face_normals(self.bm, faces=list({f for v in verts for f in v.link_faces}))
        return self._finish(verts, mat)

    def paint(self, center, radius, mat, only=None):
        """Recolour faces whose centre lies within `radius` of `center` (soot, heat tint)."""
        c = Vector(center)
        idx = self.mat(mat)
        keep = {self.mats.index(m) for m in only if m in self.mats} if only else None
        for f in self.bm.faces:
            if keep is not None and f.material_index not in keep:
                continue
            if (f.calc_center_median() - c).length < radius:
                f.material_index = idx

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


def on_hull(a_deg, r, x):
    a = math.radians(a_deg)
    return Vector((x, math.cos(a) * r, CZ + math.sin(a) * r))


# ------------------------------------------------------------------------------------------------ build

def build_core(mb, rng):
    T = 0.03                 # wall thickness
    XA, XB = -0.58, 0.48     # capped end, torn end

    # --- coil stack inside: a dim glowing column with dark coil rings, snapped off past the torn end.
    core = mb.xcyl(0.13, 0.13, XA, XB + 0.16, 8, 'core_glow', spin=0)
    for v in core:
        if v.co.x > XB + 0.1:
            v.co += Vector((rng(-0.04, 0.0), rng(-0.02, 0.02), rng(-0.03, 0.03)))
    for i in range(9):
        x = XA + 0.1 + i * 0.12
        mb.xcyl(0.165, 0.165, x - 0.018, x + 0.018, 8, 'core_dark', spin=0)

    # --- housing: three wall sections between collar rings.
    s1 = mb.shell(XA, -0.2, R, R - T, -22.5, 337.5, SEGS, 'hull')
    mb.dent(s1, on_hull(250, R, -0.35), 0.12, 0.03)
    # Middle section with a panel ripped out where the camera (front, above) looks in.
    s2 = mb.shell(-0.17, 0.15, R, R - T, 172, 108 + 360, 12, 'hull', rng=rng, tear=0.03)
    mb.jitter(s2, rng, 0.004)
    # Torn-off end, saw-tooth rim.
    s3 = mb.shell(0.18, 0.31, R, R - T, -22.5, 337.5, SEGS, 'hull')
    s4 = mb.shell(0.31, XB, R, R - T, -22.5, 337.5, 16, 'burnt', rng=rng, jag=0.16)
    mb.dent(s3 + s4, on_hull(300, R, 0.36), 0.14, 0.04)
    mb.jitter(s4, rng, 0.006)
    # A bent flap of hull peeling back from the tear.
    flap = mb.box((0.16, 0.012, 0.13), on_hull(160, R + 0.02, XB + 0.03), 'burnt', rot=(0.3, 0.5, -0.6))
    mb.jitter(flap, rng, 0.01)

    # Collar rings (thicker, light-panelled) with a thin dim glow seam beside each.
    for x0, x1 in ((-0.215, -0.165), (0.145, 0.195)):
        mb.xcyl(R + 0.025, R + 0.025, x0, x1, SEGS, 'ring')
        mb.xcyl(R + 0.006, R + 0.006, x1, x1 + 0.012, SEGS, 'core_glow')
    # Faded white panel stripe along the top of the first section.
    mb.box((0.3, 0.2, 0.006), (-0.39, 0, CZ + R * math.cos(math.pi / 8) + 0.003), 'hull_light')
    for x0, x1, a in ((-0.55, -0.24, 225), (0.2, 0.3, 90), (-0.55, -0.24, 315)):
        mb.box((x1 - x0, 0.2, 0.006), on_hull(a, R * math.cos(math.pi / 8) + 0.003, (x0 + x1) / 2),
               'hull_light', rot=(math.radians(a - 90), 0, 0))
    # Cracks: dark zig-zags scored into the hull.
    for pts in (((-0.5, 200), (-0.42, 212), (-0.36, 205), (-0.28, 220)),
                ((0.2, 120), (0.25, 132), (0.29, 126))):
        for (xa, aa), (xb, ab) in zip(pts, pts[1:]):
            pa, pb = on_hull(aa, R * 0.94, xa), on_hull(ab, R * 0.94, xb)
            mb.sweep([pa, pb], 0.008, 'scorch', segs=4)

    # --- capped end: tapered cap, coupling flange and stub, hazard marks.
    mb.xcyl(R * 0.72, R, XA - 0.09, XA, SEGS, 'hull_dark')
    mb.xcyl(0.11, 0.11, XA - 0.13, XA - 0.09, 12, 'ring', spin=0)
    mb.xcyl(0.06, 0.07, XA - 0.2, XA - 0.13, 10, 'copper', spin=0)
    for k in (-1, 1):
        mb.box((0.006, 0.05, 0.05), (XA - 0.092, k * 0.115, CZ + 0.08), 'hazard', rot=(math.pi / 4, 0, 0))

    # --- coolant: fin bank on top of the capped section, fed by pipes from the cap.
    top = CZ + R * math.cos(math.pi / 8)
    mb.box((0.34, 0.24, 0.025), (-0.38, 0, top + 0.012), 'hull_dark')
    for i in range(7):
        y = -0.1 + i * 0.2 / 6
        h = 0.11 if i not in (1, 5) else 0.08
        bend = {2: 0.25, 6: -0.35}.get(i, 0)
        fin = mb.box((0.32, 0.008, h), (-0.38, y, top + 0.025 + h / 2), 'alu', rot=(bend, 0, 0))
        if i == 6:
            mb.jitter(fin, rng, 0.008)
    for y in (-0.08, 0.08):
        mb.sweep([(XA - 0.11, y, CZ + 0.12), (XA - 0.11, y, top + 0.04), (XA - 0.04, y, top + 0.08),
                  (-0.53, y, top + 0.08)], 0.018, 'copper', segs=6)

    # --- compute rack bolted to the front (-Y) of the capped section: card slots and amber LEDs.
    cy = -(R + 0.045)
    mb.box((0.26, 0.07, 0.17), (-0.36, cy, CZ - 0.01), 'hull_dark')
    for i in range(5):
        x = -0.46 + i * 0.05
        out = 0.045 if i != 3 else 0.015
        rot = (0, 0, 0) if i != 1 else (0.0, 0.35, 0.0)
        mb.box((0.008, 0.03 + out, 0.13), (x, cy - 0.02 - out / 2, CZ - 0.01), 'pcb', rot=rot)
    mb.box((0.008, 0.11, 0.12), (-0.2, cy - 0.06, CZ - 0.13), 'pcb', rot=(0.9, 0.3, 0.2))  # card hanging out
    for i in range(3):
        mb.box((0.014, 0.008, 0.014), (-0.45 + i * 0.03, cy - 0.038, CZ + 0.06), 'led' if i != 1 else 'scorch')

    # --- anti-matter containment bottles in a cradle on the upper back of the torn section.
    for k, x in enumerate((0.25, 0.4)):
        p = on_hull(55, R + 0.07, x)
        mb.box((0.035, 0.05, 0.07), on_hull(55, R + 0.02, x), 'hull_dark', rot=(math.radians(-35), 0, 0))
        tilt = (math.radians(-35) + (0.12 if k else 0), 0, 0.08 * k)
        mb.cyl(0.052, 0.052, 0.035, 10, p + rot_up(-35, 0.085), 'hull_dark', rot=tilt)
        mb.cyl(0.042, 0.042, 0.13, 10, p, 'am_glow', rot=tilt)
        mb.cyl(0.052, 0.052, 0.035, 10, p - rot_up(-35, 0.085), 'hull_dark', rot=tilt)
        for j in range(3):  # cage bars
            a = j * 2 * math.pi / 3
            off = Vector((math.cos(a) * 0.05, math.sin(a) * 0.05, 0))
            off.rotate(Euler(tilt))
            mb.cyl(0.006, 0.006, 0.15, 4, p + off, 'ring', rot=tilt)

    # --- cables spilling out of the torn end onto the ground.
    for y0, z0, y1, mat in ((0.06, 0.06, 0.18, 'cable'), (-0.05, -0.04, -0.1, 'cable_red'),
                            (0.0, 0.08, 0.02, 'cable')):
        mb.sweep([(XB - 0.05, y0, CZ + z0), (XB + 0.12, y0 * 1.3, CZ + z0 * 0.5),
                  (XB + 0.22, (y0 + y1) / 2, 0.12), (XB + 0.3, y1, 0.02), (XB + 0.42, y1 * 1.2, 0.015)],
                 0.014, mat, segs=5)

    # --- cradle: two bent skids it lies in.
    for x, bend in ((-0.38, 0.0), (0.3, 0.08)):
        mb.shell(x - 0.035, x + 0.035, R + 0.03, R, 200, 340, 6, 'steel_dull')
        mb.box((0.08, 0.6, 0.04), (x, 0, 0.02), 'rust', rot=(bend, 0, bend * 0.5))
        for k in (-1, 1):
            mb.box((0.05, 0.04, 0.12), (x, k * 0.2, 0.08), 'rust', rot=(k * 0.5, 0, 0))

    # --- burns: soot round the tear and the breach, heat tint further out.
    mb.paint(on_hull(150, R, XB - 0.06), 0.2, 'scorch', only=('burnt',))
    mb.paint(on_hull(270, R, XB - 0.06), 0.15, 'scorch', only=('burnt',))
    mb.paint(on_hull(140, R, 0.0), 0.14, 'burnt', only=('hull',))
    mb.paint(on_hull(140, R, -0.02), 0.08, 'scorch', only=('hull', 'burnt'))
    mb.paint(on_hull(230, R, -0.1), 0.1, 'scorch', only=('hull', 'ring'))


def rot_up(a_deg, d):
    """Offset of length d along a bottle's axis when tilted a_deg about X (bottle axis is local Z)."""
    a = math.radians(a_deg)
    return Vector((0, -math.sin(a) * d, math.cos(a) * d))


def build_object():
    mb = MeshBuilder()
    build_core(mb, Rng(16))
    bm = mb.bm
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    pts = [v.co for v in bm.verts]
    cx = (min(p.x for p in pts) + max(p.x for p in pts)) / 2
    cy = (min(p.y for p in pts) + max(p.y for p in pts)) / 2
    zmin = min(p.z for p in pts)
    bmesh.ops.translate(bm, vec=Vector((-cx, -cy, -zmin)), verts=bm.verts)
    bm.normal_update()
    mesh = bpy.data.meshes.new('warp_core')
    bm.to_mesh(mesh)
    bm.free()
    for m in mb.mats:
        mesh.materials.append(bpy.data.materials[m])
    obj = bpy.data.objects.new('warp_core', mesh)
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


def aim(cam, target, distance, direction=CAM_DIR):
    cam.location = target + direction * distance
    cam.rotation_euler = (-direction).to_track_quat('-Z', 'Y').to_euler()


def frame_ortho(cam, obj):
    pts = [obj.matrix_world @ v.co for v in obj.data.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    aim(cam, (lo + hi) / 2, 3)
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
    cam.data.clip_end = 10


def render_icon(obj, path, size):
    scene = bpy.context.scene
    cam = setup_render(scene, size, size)
    frame_ortho(cam, obj)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def render_preview(obj, path):
    """3/4 perspective view on a sand plane (path), plus a view from the other side (path_back)."""
    scene = bpy.context.scene
    cam = scene.camera or setup_render(scene, 1400, 1000)
    scene.render.resolution_x, scene.render.resolution_y = 1400, 1000
    scene.render.film_transparent = False
    scene.render.use_freestyle = False
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))
    bpy.context.active_object.data.materials.append(make_material('ground', 0xd9a066, 0, 0.9, 0))
    cam.data.type = 'PERSP'
    cam.data.lens = 50
    for suffix, d in (('', CAM_DIR), ('_back', Vector((-1.0, 1.1, 0.7)).normalized())):
        aim(cam, Vector((0, 0, 0.35)), 3.4, d)
        scene.render.filepath = path.replace('.png', suffix + '.png')
        bpy.ops.render.render(write_still=True)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models', 'salvage', 'warp_core.glb'))
    ap.add_argument('--icon', default=os.path.join(ROOT, 'public', 'icons', 'salvage', 'warp_core.png'))
    ap.add_argument('--icon-size', type=int, default=128)
    ap.add_argument('--no-icon', action='store_true')
    ap.add_argument('--preview', default=None, help='render a 3/4 PNG on sand (+ _back view)')
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in MATERIALS.items():
        make_material(name, *spec)

    obj = build_object()
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    export_glb(obj, args.out)
    d = obj.dimensions
    print(f'{obj.name}: tris={tri_count(obj)} size={d.x:.3f} x {d.y:.3f} x {d.z:.3f} m')

    if not args.no_icon:
        render_icon(obj, args.icon, args.icon_size)
    if args.preview:
        render_preview(obj, os.path.abspath(args.preview))


main()
