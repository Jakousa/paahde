"""Salvage: AI control system (GitHub issue #15, part of #13), exported as a glTF binary + inventory icon.

    blender -b --python tools/blender/salvage/ai_control.py                       # model + icon
    blender -b --python tools/blender/salvage/ai_control.py -- --preview out.png  # also out.png (front 3/4)
                                                                                  # and out_back.png

Writes public/models/salvage/ai_control.glb and public/icons/salvage/ai_control.png (128x128, transparent,
the same orthographic 3/4 camera and lighting as the item icons in tools/blender/items.py).

Once a computer that ran some big machine; now a broken waist-high-plus rack cabinet, about 0.64 x 0.5 x
1.3 m, that one player can drag home. Faded slate paint, a dead red "eye" lens in the top bezel, a cooling
fan on the roof with a blade missing, a stack of compute modules in the front (two slots empty, one half
pulled out with its green board showing, wires dangling) and a big finned heat sink bolted to the right
side where the panel has rusted away, fed by copper coolant pipes, one of them snapped. It yields heat
sinks and compute units (shared/salvage.ts).

Blender is Z-up and the cabinet front faces Blender -Y; the glTF exporter (Y-up) turns that into three.js
+Z. Units are metres; the origin is on the ground at the centre of the footprint. Output is deterministic
(fixed seed, no Blender randomness).
"""

import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
NAME = 'ai_control'

# Materials: name -> (sRGB hex, metallic, roughness, emission strength).
MATERIALS = {
    'paint': (0x5f7580, 0.2, 0.75, 0),        # faded slate-blue cabinet paint, contrasts the orange sand
    'paint_dark': (0x3e4c54, 0.2, 0.8, 0),
    'cream': (0xd8c49a, 0.05, 0.8, 0),        # bezel, labels
    'rust': (0x8a4a24, 0.3, 0.9, 0),
    'rust_dark': (0x5a2f18, 0.3, 0.95, 0),
    'void': (0x15130f, 0.0, 1.0, 0),          # the dark inside of the cabinet
    'frame': (0x2c2a28, 0.5, 0.6, 0),         # rails, plinth, corner posts
    'module': (0x46494d, 0.4, 0.55, 0),       # compute module faceplates
    'slit': (0x101010, 0.0, 0.9, 0),
    'pcb': (0x2f6b3a, 0.0, 0.6, 0),
    'alu': (0xb4b6b4, 0.8, 0.45, 0),          # heat-sink fins
    'alu_dull': (0x8a8780, 0.6, 0.65, 0),
    'copper': (0xb8703e, 0.9, 0.4, 0),
    'hose': (0x1e1c1a, 0.0, 0.9, 0),
    'steel': (0x9a958c, 0.75, 0.45, 0),
    'yellow': (0xd9a82a, 0.1, 0.7, 0),        # hazard stripes
    'wire_red': (0xa83224, 0.0, 0.6, 0),
    'wire_yellow': (0xc9a12e, 0.0, 0.6, 0),
    'eye': (0xff2a14, 0.0, 0.3, 1.5),         # the AI's eye, barely glowing
    'eye_rim': (0x8c8880, 0.8, 0.35, 0),
    'led_amber': (0xffa020, 0.0, 0.4, 3),
    'led_dead': (0x3a4a3a, 0.0, 0.5, 0),
    'glass': (0x1c2a30, 0.3, 0.15, 0),
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
    """One bmesh for the whole object; every primitive is added in place with its own material."""

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

    def box(self, size, loc, mat, rot=(0, 0, 0), cuts=0):
        """Box centred on loc; `cuts` subdivides it so dent() has verts to push."""
        n0 = len(self.bm.verts)  # new verts are appended, so everything past n0 belongs to this box
        verts = bmesh.ops.create_cube(self.bm, size=1)['verts']
        if cuts:
            edges = list({e for v in verts for e in v.link_edges})
            bmesh.ops.subdivide_edges(self.bm, edges=edges, cuts=cuts, use_grid_fill=True)
            self.bm.verts.ensure_lookup_table()
            verts = [self.bm.verts[i] for i in range(n0, len(self.bm.verts))]
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

    def sweep(self, pts, r, mat, segs=6):
        """Bent tube through a polyline with shared rings at the joints (pipes, cables)."""
        pts = [Vector(p) for p in pts]
        rings = []
        ref = Vector((1, 0, 0))
        for i, p in enumerate(pts):
            t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
            if abs(t.dot(ref)) > 0.9:
                ref = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((0, 1, 0))
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
        verts = [v for ring in rings for v in ring]
        bmesh.ops.recalc_face_normals(self.bm, faces=list({f for v in verts for f in v.link_faces}))
        return self._finish(verts, mat)

    def jitter(self, verts, rng, amount):
        for v in verts:
            v.co += Vector((rng(-amount, amount), rng(-amount, amount), rng(-amount, amount)))

    def dent(self, verts, center, radius, depth, direction):
        """Push verts near `center` along `direction` - crude dents."""
        c, d = Vector(center), Vector(direction).normalized()
        for v in verts:
            dist = (v.co - c).length
            if dist < radius:
                v.co += d * depth * (1 - dist / radius)


Y90 = (0, math.pi / 2, 0)  # turns a Z-axis cylinder to lie along X
X90 = (math.pi / 2, 0, 0)  # ... along Y

# ----------------------------------------------------------------------------------------------- layout
# Blender coordinates: +X right, -Y front, +Z up.
W, D, H = 0.64, 0.5, 1.22    # cabinet shell (without the roof fan)
PLINTH = 0.08
T = 0.025                    # panel thickness
FRONT = -D / 2
SLOT_Z0, SLOT_H, SLOTS = PLINTH + 0.03, 0.105, 7
BEZEL_Z0 = SLOT_Z0 + SLOTS * SLOT_H + 0.01
SINK_Z0, SINK_Z1 = 0.45, 1.12


def build(mb, rng):
    # Plinth with hazard stripes across the front, and four squat feet.
    mb.box((W + 0.02, D + 0.02, PLINTH - 0.02), (0, 0, 0.02 + (PLINTH - 0.02) / 2), 'frame')
    for sx in (1, -1):
        for sy in (1, -1):
            mb.box((0.06, 0.06, 0.02), (sx * (W / 2 - 0.03), sy * (D / 2 - 0.03), 0.01), 'frame')
    for i in range(6):
        mb.box((0.035, 0.006, 0.075), (-W / 2 + 0.06 + i * 0.105, FRONT - 0.012, PLINTH / 2 + 0.01), 'yellow',
               rot=(0, 0.75, 0))
    mb.box((W + 0.022, 0.004, 0.012), (0, FRONT - 0.012, PLINTH - 0.004), 'frame')
    mb.box((W + 0.022, 0.004, 0.012), (0, FRONT - 0.012, 0.026), 'frame')

    # Dark inside of the cabinet: empty slots show this, recessed behind the rails.
    iy0, iy1 = FRONT + 0.06, D / 2 - T
    mb.box((W - 2 * T, iy1 - iy0, H - PLINTH - 0.06), (0, (iy0 + iy1) / 2, PLINTH + (H - PLINTH) / 2), 'void')

    # Shell: left side, back and roof, dented and patched with rust.
    left = mb.box((T, D, H - PLINTH), (-W / 2 + T / 2, 0, PLINTH + (H - PLINTH) / 2), 'paint', cuts=2)
    mb.dent(left, (-W / 2, -0.05, 0.75), 0.28, 0.045, (1, 0, 0))
    mb.dent(left, (-W / 2, 0.15, 0.3), 0.18, 0.025, (1, 0, 0))
    mb.jitter(left, rng, 0.004)
    mb.box((0.004, 0.22, 0.12), (-W / 2 - 0.002, 0.08, 0.98), 'cream')                # stencil plate
    mb.box((0.005, 0.18, 0.02), (-W / 2 - 0.004, 0.08, 1.0), 'paint_dark')
    mb.box((0.005, 0.12, 0.014), (-W / 2 - 0.004, 0.05, 0.955), 'paint_dark')
    mb.box((0.006, 0.16, 0.2), (-W / 2 - 0.002, -0.12, 0.28), 'rust', rot=(0.3, 0, 0))
    mb.box((0.006, 0.1, 0.09), (-W / 2 + 0.001, 0.16, 0.55), 'rust_dark', rot=(-0.5, 0, 0))
    back = mb.box((W, T, H - PLINTH), (0, D / 2 - T / 2, PLINTH + (H - PLINTH) / 2), 'paint')
    mb.jitter(back, rng, 0.004)
    mb.box((0.2, 0.006, 0.24), (0.1, D / 2 + 0.001, 0.36), 'rust', rot=(0, 0.2, 0))
    roof = mb.box((W + 0.02, D + 0.02, T), (0, 0, H - T / 2), 'paint', cuts=2)
    mb.dent(roof, (0.18, -0.12, H), 0.22, 0.02, (0, 0, -1))
    mb.jitter(roof, rng, 0.003)
    mb.box((0.18, 0.2, 0.006), (-0.2, 0.12, H + 0.001), 'rust', rot=(0, 0, 0.4))

    # Corner posts and front rack rails.
    for sx in (1, -1):
        mb.box((0.03, 0.03, H - PLINTH), (sx * (W / 2 - 0.015), FRONT + 0.015, PLINTH + (H - PLINTH) / 2), 'frame')
    mb.box((0.03, 0.03, H - PLINTH), (W / 2 - 0.015, D / 2 - 0.015, PLINTH + (H - PLINTH) / 2), 'frame')
    for sx in (1, -1):
        mb.box((0.022, 0.012, BEZEL_Z0 - SLOT_Z0), (sx * (W / 2 - 0.045), FRONT + 0.02,
               (SLOT_Z0 + BEZEL_Z0) / 2), 'steel')

    # Right side: the lower panel survives (torn top edge); above it the big heat sink is bolted on.
    rp = mb.box((T, D - 0.03, SINK_Z0 - PLINTH), (W / 2 - T / 2, 0.0, PLINTH + (SINK_Z0 - PLINTH) / 2), 'paint',
                cuts=2)
    for v in rp:
        if v.co.z > SINK_Z0 - 0.01:
            v.co.z -= rng(0.0, 0.07)
    mb.jitter(rp, rng, 0.003)
    mb.box((0.006, 0.14, 0.1), (W / 2 + 0.001, 0.12, 0.2), 'rust_dark', rot=(0.4, 0, 0))
    build_heatsink(mb, rng)

    # Top bezel with the AI's eye and a cracked status screen.
    bz = BEZEL_Z0 + (H - T - BEZEL_Z0) / 2
    bh = H - T - BEZEL_Z0
    mb.box((W - 0.03, 0.03, bh), (0, FRONT + 0.015, bz), 'cream')
    mb.cyl(0.07, 0.07, 0.02, 14, (-0.14, FRONT - 0.005, bz), 'eye_rim', rot=X90)
    mb.cyl(0.05, 0.042, 0.02, 14, (-0.14, FRONT - 0.014, bz), 'eye', rot=X90)
    mb.cyl(0.012, 0.012, 0.01, 6, (-0.128, FRONT - 0.025, bz + 0.015), 'cream', rot=X90)  # glint
    mb.box((0.26, 0.012, 0.11), (0.12, FRONT - 0.002, bz + 0.01), 'glass')
    mb.box((0.004, 0.014, 0.12), (0.1, FRONT - 0.003, bz + 0.01), 'cream', rot=(0, 0.6, 0))  # crack
    mb.box((0.004, 0.014, 0.06), (0.13, FRONT - 0.003, bz + 0.035), 'cream', rot=(0, -1.2, 0))
    for i, m in enumerate(('led_dead', 'led_amber', 'led_dead', 'led_dead')):
        mb.box((0.02, 0.01, 0.012), (0.03 + i * 0.05, FRONT - 0.004, bz - 0.06), m)

    build_modules(mb, rng)
    build_fan(mb, rng)
    build_pipes(mb)


def build_heatsink(mb, rng):
    """Base plate on the right side with horizontal fins sticking out along +X, copper pipes through them."""
    x0 = W / 2
    depth = D - 0.07
    mb.box((0.03, depth + 0.02, SINK_Z1 - SINK_Z0 + 0.02), (x0 - 0.005, 0.0, (SINK_Z0 + SINK_Z1) / 2), 'alu_dull')
    n = 15
    fin_w = 0.13
    for i in range(n):
        if i in (9,):
            continue  # one fin snapped clean off
        z = SINK_Z0 + 0.012 + i * (SINK_Z1 - SINK_Z0 - 0.024) / (n - 1)
        bend = {2: -0.22, 3: -0.12, 10: 0.18, 13: -0.3}.get(i, 0.0)
        w = fin_w * (0.55 if i == 12 else 1.0)
        fin = mb.box((w, depth, 0.008), (x0 + w / 2, 0.0, z), 'alu' if i % 4 else 'alu_dull', rot=(0, bend, 0))
        if bend:
            # Bend about the root: shift the fin so its inner edge stays on the plate.
            for v in fin:
                v.co.z += math.sin(-bend) * (w / 2)
        mb.jitter(fin, rng, 0.003)
    for y in (-0.13, 0.13):
        mb.cyl(0.012, 0.012, SINK_Z1 - SINK_Z0 + 0.03, 8, (x0 + 0.075, y, (SINK_Z0 + SINK_Z1) / 2), 'copper')


def build_modules(mb, rng):
    """Compute modules in the rack: a faceplate per slot; two slots empty, one module pulled half out."""
    fw = W - 2 * 0.06
    pulled = 3
    empty = (1, 5)
    for s in range(SLOTS):
        if s in empty:
            continue
        zc = SLOT_Z0 + s * SLOT_H + SLOT_H / 2
        fh = SLOT_H - 0.012
        y = FRONT + 0.02
        rot = (0, 0, 0)
        if s == pulled:
            y -= 0.2
            rot = (-0.06, 0, 0.05)
            # Its board slides out with it: green PCB on a steel tray, with chips.
            mb.box((fw - 0.02, 0.26, 0.01), (0.01, y + 0.14, zc - fh / 2 + 0.01), 'steel', rot=rot)
            mb.box((fw - 0.04, 0.24, 0.012), (0.01, y + 0.14, zc - fh / 2 + 0.022), 'pcb', rot=rot)
            for cx, cy in ((-0.12, 0.08), (0.02, 0.1), (0.15, 0.06), (-0.04, 0.19)):
                mb.box((0.07, 0.06, 0.016), (cx, y + cy, zc - fh / 2 + 0.032 + cy * 0.012), 'module', rot=rot)
        plate = mb.box((fw, 0.018, fh), (0.0 if s != pulled else 0.01, y, zc), 'module', rot=rot)
        if s == 6:
            mb.jitter(plate, rng, 0.006)
        # Vent slits, a status LED and a pull handle on each faceplate.
        for k in range(3):
            mb.box((0.012, 0.006, fh * 0.55), (-fw / 2 + 0.06 + k * 0.03 + (0.01 if s == pulled else 0), y - 0.008,
                                              zc), 'slit', rot=rot)
        led = 'led_amber' if s == 4 else 'led_dead'
        mb.box((0.016, 0.008, 0.016), (0.1 + (0.01 if s == pulled else 0), y - 0.01, zc + 0.02), led, rot=rot)
        hx = fw / 2 - 0.08 + (0.01 if s == pulled else 0)
        if s != 2:  # module 2 lost its handle
            mb.box((0.11, 0.014, 0.014), (hx, y - 0.035, zc - 0.005), 'steel', rot=rot)
            for dx in (-0.05, 0.05):
                mb.box((0.012, 0.03, 0.012), (hx + dx, y - 0.02, zc - 0.005), 'steel', rot=rot)

    # Wires spilling out of the empty top-middle slot.
    zc = SLOT_Z0 + 5 * SLOT_H + SLOT_H / 2
    mb.sweep([(-0.1, FRONT + 0.1, zc + 0.02), (-0.08, FRONT - 0.01, zc), (-0.06, FRONT - 0.05, zc - 0.12),
              (-0.07, FRONT - 0.06, zc - 0.22)], 0.007, 'wire_red', segs=5)
    mb.sweep([(0.02, FRONT + 0.1, zc + 0.01), (0.03, FRONT - 0.01, zc - 0.01), (0.07, FRONT - 0.04, zc - 0.09),
              (0.06, FRONT - 0.07, zc - 0.17)], 0.007, 'wire_yellow', segs=5)
    mb.sweep([(0.1, FRONT + 0.1, zc - 0.03), (0.12, FRONT - 0.02, zc - 0.04), (0.14, FRONT - 0.03, zc - 0.13)],
             0.009, 'hose', segs=5)


def build_fan(mb, rng):
    """Roof cooling fan in a raised shroud: hub, three blades (one snapped off), a bent guard bar."""
    cx, cy, top = -0.08, 0.04, H
    s = 0.36
    sh = 0.06
    for sx, sy, w, d in ((0, -1, s, 0.03), (0, 1, s, 0.03), (-1, 0, 0.03, s), (1, 0, 0.03, s)):
        mb.box((w, d, sh), (cx + sx * (s / 2 - 0.015), cy + sy * (s / 2 - 0.015), top + sh / 2), 'paint_dark')
    mb.cyl(0.155, 0.155, 0.01, 12, (cx, cy, top + 0.006), 'void')
    mb.cyl(0.04, 0.035, 0.04, 8, (cx, cy, top + 0.025), 'frame')
    for k, a in enumerate((0.3, 0.3 + 2.1, 0.3 + 4.2)):
        if k == 2:
            mb.box((0.035, 0.02, 0.008), (cx + math.cos(a) * 0.055, cy + math.sin(a) * 0.055, top + 0.03),
                   'alu_dull', rot=(0.4, 0, a))  # stub of the snapped blade
            continue
        mb.box((0.11, 0.045, 0.008), (cx + math.cos(a) * 0.09, cy + math.sin(a) * 0.09, top + 0.03), 'alu_dull',
               rot=(0.4, 0, a))
    mb.box((s - 0.02, 0.014, 0.012), (cx, cy, top + sh - 0.004), 'steel', rot=(0, 0.08, 0.6))
    mb.box((0.014, s * 0.6, 0.012), (cx + 0.05, cy - 0.06, top + sh + 0.01), 'steel', rot=(0.35, 0, 0.1))


def build_pipes(mb):
    """Copper coolant loop from the roof down the back corner into the heat sink; the second pipe snapped."""
    r = 0.016
    mb.sweep([(-0.08, 0.22, H + 0.02), (0.12, 0.27, H + 0.03), (0.3, 0.27, H - 0.05), (0.36, 0.2, 1.1),
              (W / 2 + 0.075, 0.13, SINK_Z1 + 0.02)], r, 'copper', segs=6)
    mb.sweep([(-0.04, 0.27, H + 0.0), (0.2, 0.3, H - 0.02), (0.355, 0.29, 1.0), (0.38, 0.28, 0.82)], r, 'copper',
             segs=6)
    mb.cyl(r * 1.4, r * 1.6, 0.03, 6, (0.38, 0.28, 0.8), 'rust_dark')  # torn, crusty end
    # A rubber hose dangling down the back from the snapped pipe.
    mb.sweep([(0.38, 0.28, 0.79), (0.36, 0.32, 0.6), (0.3, 0.33, 0.42), (0.26, 0.36, 0.3)], 0.014, 'hose', segs=6)


def build_object():
    mb = MeshBuilder()
    build(mb, Rng(15))
    bmesh.ops.recalc_face_normals(mb.bm, faces=mb.bm.faces)
    zmin = min(v.co.z for v in mb.bm.verts)
    bmesh.ops.translate(mb.bm, vec=Vector((0, 0, -zmin)), verts=mb.bm.verts)
    mesh = bpy.data.meshes.new(NAME)
    mb.bm.normal_update()
    mb.bm.to_mesh(mesh)
    mb.bm.free()
    for m in mb.mats:
        mesh.materials.append(bpy.data.materials[m])
    obj = bpy.data.objects.new(NAME, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def export_glb(obj, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
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
# Same camera direction, lights and outline as the item icons (tools/blender/items.py).

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

    cam_data = bpy.data.cameras.new('cam')
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    return cam


def aim(cam, target, direction, distance):
    cam.location = target + direction * distance
    cam.rotation_euler = (-direction).to_track_quat('-Z', 'Y').to_euler()


def frame_ortho(cam, obj):
    pts = [obj.matrix_world @ v.co for v in obj.data.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    aim(cam, (lo + hi) / 2, CAM_DIR, 5)
    bpy.context.view_layer.update()
    inv = cam.matrix_world.inverted()
    local = [inv @ p for p in pts]
    w = max(p.x for p in local) - min(p.x for p in local)
    h = max(p.y for p in local) - min(p.y for p in local)
    cx = (max(p.x for p in local) + min(p.x for p in local)) / 2
    cy = (max(p.y for p in local) + min(p.y for p in local)) / 2
    cam.location = cam.matrix_world @ Vector((cx, cy, 0))
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = max(w, h) * 1.12
    cam.data.clip_start = 0.01
    cam.data.clip_end = 20


def render_icon(obj, path, size):
    scene = bpy.context.scene
    cam = setup_render(scene, size, size)
    frame_ortho(cam, obj)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def render_preview(path):
    """Perspective 3/4 views on a sand plane: front-right (path) and back-right (path_back.png)."""
    scene = bpy.context.scene
    cam = scene.camera or setup_render(scene, 1200, 1200)
    scene.render.resolution_x, scene.render.resolution_y = 1200, 1200
    scene.render.film_transparent = False
    scene.render.use_freestyle = False
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))
    ground = bpy.context.active_object
    ground.data.materials.append(make_material('ground', 0xd9a066, 0, 0.9, 0))
    cam.data.type = 'PERSP'
    cam.data.lens = 50
    target = Vector((0, 0, 0.62))
    for out, d in ((path, CAM_DIR), (os.path.splitext(path)[0] + '_back.png',
                                      Vector((0.9, 1.2, 0.7)).normalized())):
        aim(cam, target, d, 3.2)
        scene.render.filepath = out
        bpy.ops.render.render(write_still=True)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models', 'salvage', NAME + '.glb'))
    ap.add_argument('--icon', default=os.path.join(ROOT, 'public', 'icons', 'salvage', NAME + '.png'))
    ap.add_argument('--icon-size', type=int, default=128)
    ap.add_argument('--no-icon', action='store_true')
    ap.add_argument('--preview', default=None, help='also render a 3/4 preview PNG (+ <name>_back.png)')
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in MATERIALS.items():
        make_material(name, *spec)

    obj = build_object()
    export_glb(obj, args.out)
    d = obj.dimensions
    print(f'{NAME}: tris={tri_count(obj)} size={d.x:.3f} x {d.y:.3f} x {d.z:.3f} m')
    if not args.no_icon:
        render_icon(obj, args.icon, args.icon_size)
    if args.preview:
        render_preview(os.path.abspath(args.preview))


main()
