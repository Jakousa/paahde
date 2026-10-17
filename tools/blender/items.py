"""Craftable items (GitHub issue #8) in four quality tiers, exported as glTF binaries + inventory icons.

    blender -b --python tools/blender/items.py                              # every item, every tier
    blender -b --python tools/blender/items.py -- --item battery --tier space
    blender -b --python tools/blender/items.py -- --preview out.png         # also a tiers x items overview render
    blender -b --python tools/blender/items.py -- --no-icons                # models only

Writes public/models/items/<item>_<tier>.glb and public/icons/items/<item>_<tier>.png (128x128, transparent,
same orthographic 3/4 camera and lighting for every icon; each item is framed the same across its tiers).

Tiers keep one silhouette per item and change finish and detail:
  scrap   rusty, dented, mismatched and taped-together parts
  basic   plain, clean, painted
  quality refined: bevelled edges, extra detail, warm metal accents
  space   sleek white/gunmetal with glowing cyan accents (emissive)

Blender is Z-up; the glTF exporter converts to Y-up. Units are metres, origin at the centre of the base.
Output is deterministic (fixed seeds, no Blender randomness).
"""

import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

TIERS = ['scrap', 'basic', 'quality', 'space']
ITEMS = ['battery', 'motor', 'heatsink', 'compute', 'coil', 'antimatter']

# Materials: name -> (sRGB hex, metallic, roughness, emission strength). Emissive ones glow in their colour.
MATERIALS = {
    # scrap
    'rust': (0x8a4a24, 0.3, 0.9, 0),
    'rust_dark': (0x5a2f18, 0.3, 0.95, 0),
    'paint_faded': (0x6f8a6a, 0.1, 0.85, 0),
    'paint_faded_blue': (0x5f7586, 0.1, 0.85, 0),
    'steel_dull': (0x7d776e, 0.6, 0.7, 0),
    'tape': (0x9a9890, 0.0, 0.8, 0),
    'corrosion': (0xb8d6b0, 0.0, 0.9, 0),
    'wire_red': (0xa83224, 0.0, 0.6, 0),
    'wire_yellow': (0xc9a12e, 0.0, 0.6, 0),
    'pcb': (0x2f6b3a, 0.0, 0.6, 0),
    # basic
    'plastic_dark': (0x3a3c40, 0.0, 0.6, 0),
    'plastic_black': (0x1e1f22, 0.0, 0.55, 0),
    'label': (0xe8e2d4, 0.0, 0.7, 0),
    'term_red': (0xc0392b, 0.0, 0.5, 0),
    'term_black': (0x26262a, 0.0, 0.5, 0),
    'paint_blue': (0x4f6d8a, 0.2, 0.55, 0),
    'steel': (0xb0b4b8, 0.85, 0.4, 0),
    'alu': (0xc4c8cc, 0.8, 0.45, 0),
    # quality
    'navy': (0x1f3350, 0.2, 0.4, 0),
    'red_deep': (0x8e2b22, 0.25, 0.4, 0),
    'chrome': (0xdfe3e8, 1.0, 0.18, 0),
    'copper': (0xc87a43, 1.0, 0.3, 0),
    'brass': (0xc9a24a, 1.0, 0.3, 0),
    'anodised': (0x34373e, 0.6, 0.35, 0),
    'accent_orange': (0xe8862a, 0.1, 0.45, 0),
    'led_green': (0x6cff7a, 0.0, 0.4, 3),
    # space
    'white': (0xeef0f2, 0.1, 0.25, 0),
    'gunmetal': (0x3b4048, 0.8, 0.3, 0),
    'gold': (0xe6b54a, 1.0, 0.22, 0),
    'glow': (0x3ff0ff, 0.0, 0.3, 6),
    'glow_soft': (0x7ad8ff, 0.0, 0.3, 2.5),
    # antimatter core (every tier): a violet glow, dimmer and sickly when scrap
    'am_core': (0xc04dff, 0.0, 0.3, 2.2),
    'am_core_dim': (0x9a5cc8, 0.0, 0.5, 1.0),
    'hazard_yellow': (0xe0b52a, 0.1, 0.55, 0),
}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def make_material(name, hex_color, metallic, roughness, emission):
    mat = bpy.data.materials.new(name)
    rgb = [srgb_to_linear(((hex_color >> s) & 0xFF) / 255) for s in (16, 8, 0)]
    mat.diffuse_color = (*rgb, 1)
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
    """One bmesh per item; every primitive is added in place with its own material."""

    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []

    def mat(self, name):
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    def _place(self, verts, mat, loc, rot):
        m = Matrix.Translation(Vector(loc)) @ Euler(rot).to_matrix().to_4x4()
        bmesh.ops.transform(self.bm, matrix=m, verts=verts)
        faces = {f for v in verts for f in v.link_faces}
        idx = self.mat(mat)
        for f in faces:
            f.material_index = idx
            f.smooth = False
        return verts

    def box(self, size, loc, mat, rot=(0, 0, 0), bevel=0.0, cuts=0):
        before = set(self.bm.verts)
        verts = bmesh.ops.create_cube(self.bm, size=1)['verts']
        bmesh.ops.scale(self.bm, vec=Vector(size), verts=verts)
        if cuts:
            edges = list({e for v in verts for e in v.link_edges})
            res = bmesh.ops.subdivide_edges(self.bm, edges=edges, cuts=cuts, use_grid_fill=True)
            verts = [v for v in self.bm.verts if v not in before]
        if bevel:
            edges = list({e for v in verts for e in v.link_edges})
            res = bmesh.ops.bevel(self.bm, geom=verts + edges, offset=bevel, segments=1, affect='EDGES',
                                  profile=0.5)
            verts = [v for v in self.bm.verts if v not in before]
        return self._place(verts, mat, loc, rot)

    def cyl(self, r1, r2, depth, segs, loc, mat, rot=(0, 0, 0)):
        """Cylinder/cone along local Z, centred on loc."""
        verts = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segs,
                                      radius1=r1, radius2=r2, depth=depth)['verts']
        return self._place(verts, mat, loc, rot)

    def blob(self, r, loc, mat):
        verts = bmesh.ops.create_icosphere(self.bm, subdivisions=1, radius=r)['verts']
        return self._place(verts, mat, loc, (0, 0, 0))

    def dent(self, verts, center, radius, depth):
        """Push verts near `center` inwards (towards the part's centroid) - crude dents for scrap."""
        c = Vector(center)
        mid = sum((v.co for v in verts), Vector()) / len(verts)
        for v in verts:
            d = (v.co - c).length
            if d < radius:
                v.co += (mid - v.co).normalized() * depth * (1 - d / radius)

    def jitter(self, verts, rng, amount):
        for v in verts:
            v.co += Vector((rng(-amount, amount), rng(-amount, amount), rng(-amount, amount)))


Y90 = (0, math.pi / 2, 0)  # turns a Z-axis cylinder to lie along X
X90 = (math.pi / 2, 0, 0)  # ... along Y


# ---------------------------------------------------------------------------------------------- battery

def build_battery(mb, tier, rng):
    """A chunky 12 V block battery, about 30 x 18 x 22 cm, terminals on top."""
    W, D, H, LID = 0.30, 0.18, 0.19, 0.03
    top = H + LID
    if tier == 'scrap':
        body = mb.box((W, D, H), (0, 0, H / 2), 'rust', cuts=2)
        mb.dent(body, (0.06, -D / 2, H * 0.6), 0.09, 0.025)
        mb.dent(body, (-W / 2, 0.03, H * 0.35), 0.07, 0.015)
        mb.jitter(body, rng, 0.003)
        # Mismatched lid off another battery, sitting crooked.
        mb.box((W * 0.97, D * 1.04, LID), (0.008, 0.004, H + LID / 2), 'paint_faded', rot=(0.03, -0.02, 0.05))
        # Duct tape holding it together.
        mb.box((0.045, D + 0.01, H * 0.85), (-0.07, 0, H * 0.45), 'tape', rot=(0, 0.1, 0))
        mb.box((0.04, D + 0.01, H * 0.6), (0.115, 0, H * 0.5), 'tape', rot=(0, -0.08, 0))
        # One crusty corroded terminal, one bare steel stub.
        mb.cyl(0.018, 0.016, 0.03, 6, (0.09, 0, top + 0.015), 'steel_dull')
        mb.blob(0.022, (0.09, 0, top + 0.008), 'corrosion')
        mb.blob(0.016, (0.075, -0.012, top + 0.004), 'corrosion')
        mb.cyl(0.016, 0.013, 0.025, 6, (-0.09, 0.01, top + 0.012), 'steel_dull', rot=(0.2, 0.1, 0))
    elif tier == 'basic':
        mb.box((W, D, H), (0, 0, H / 2), 'plastic_dark')
        mb.box((W + 0.01, D + 0.01, LID), (0, 0, H + LID / 2), 'plastic_black')
        mb.box((W * 0.6, 0.004, H * 0.4), (0, -D / 2 - 0.002, H * 0.55), 'label')
        for x, m in ((0.09, 'term_red'), (-0.09, 'term_black')):
            mb.cyl(0.02, 0.02, 0.008, 8, (x, 0, top + 0.004), m)
            mb.cyl(0.015, 0.013, 0.03, 8, (x, 0, top + 0.015), 'steel')
    elif tier == 'quality':
        mb.box((W, D, H), (0, 0, H / 2), 'navy', bevel=0.012)
        mb.box((W + 0.008, D + 0.008, LID), (0, 0, H + LID / 2), 'chrome', bevel=0.006)
        mb.box((W + 0.006, D + 0.006, 0.025), (0, 0, H * 0.3), 'accent_orange')  # stripe all round
        mb.cyl(0.012, 0.012, 0.01, 10, (0, -D * 0.25, top + 0.005), 'led_green')  # charge eye
        # Carry handle.
        for x in (-0.07, 0.07):
            mb.box((0.012, 0.02, 0.05), (x, D * 0.15, top + 0.025), 'plastic_black')
        mb.box((0.152, 0.02, 0.012), (0, D * 0.15, top + 0.05), 'plastic_black')
        for x, m in ((0.11, 'term_red'), (-0.11, 'term_black')):
            mb.cyl(0.022, 0.022, 0.012, 10, (x, -0.02, top + 0.006), m)
            mb.cyl(0.015, 0.013, 0.032, 10, (x, -0.02, top + 0.016), 'copper')
    else:  # space
        mb.box((W, D, H), (0, 0, H / 2), 'white', bevel=0.025)
        mb.box((W - 0.02, D - 0.02, LID), (0, 0, H + LID / 2 - 0.005), 'gunmetal', bevel=0.008)
        # Glowing charge cells across the front and a light seam around the waist.
        for i in range(4):
            mb.box((0.045, 0.006, 0.09), (-0.0825 + i * 0.055, -D / 2 - 0.001, H * 0.5), 'glow')
        for sy in (1, -1):
            mb.box((W - 0.05, 0.004, 0.01), (0, sy * D / 2, H * 0.14), 'glow_soft')
        for sx in (1, -1):
            mb.box((0.004, D - 0.05, 0.01), (sx * W / 2, 0, H * 0.14), 'glow_soft')
        for x in (0.1, -0.1):
            mb.cyl(0.02, 0.016, 0.03, 12, (x, 0, top + 0.01), 'gold')
            mb.cyl(0.023, 0.023, 0.004, 12, (x, 0, top - 0.002), 'glow')


# ------------------------------------------------------------------------------------------------ motor

def build_motor(mb, tier, rng):
    """Electric motor lying along X on a mounting foot: can, end bells, output shaft (+X), terminal box."""
    R, L = 0.1, 0.24
    cz = R + 0.035
    segs = {'scrap': 10, 'basic': 12, 'quality': 14, 'space': 20}[tier]
    shaft_x = L / 2 + 0.06

    def foot(mat, bevel=0.0):
        mb.box((L * 0.8, R * 1.9, 0.025), (0, 0, 0.0125), mat, bevel=bevel)
        mb.box((L * 0.55, R * 1.1, cz - 0.02), (0, 0, 0.02 + (cz - 0.02) / 2), mat, bevel=bevel)

    if tier == 'scrap':
        can = mb.cyl(R, R, L, segs, (0, 0, cz), 'rust', rot=Y90)
        mb.jitter(can, rng, 0.006)
        mb.dent(can, (0.03, -R, cz + 0.03), 0.07, 0.02)
        mb.cyl(R * 1.06, R * 1.06, 0.035, segs, (L / 2, 0, cz), 'steel_dull', rot=Y90)
        mb.cyl(R * 1.03, R * 1.0, 0.03, segs, (-L / 2 - 0.005, 0, cz), 'paint_faded_blue', rot=(0, math.pi / 2, 0.08))
        mb.cyl(0.014, 0.014, 0.1, 6, (shaft_x, 0.008, cz + 0.008), 'steel_dull', rot=(0, math.pi / 2 - 0.2, 0.15))
        mb.box((L * 0.8, R * 1.9, 0.025), (0, 0, 0.0125), 'rust_dark', rot=(0, 0.04, 0.06))
        mb.box((L * 0.55, R * 1.1, cz - 0.02), (0, 0, 0.02 + (cz - 0.02) / 2), 'rust_dark')
        # Terminal box with its lid gone, wire stubs poking out.
        mb.box((0.07, 0.07, 0.035), (-0.02, 0, cz + R + 0.008), 'rust_dark')
        mb.cyl(0.006, 0.006, 0.08, 5, (-0.03, -0.01, cz + R + 0.05), 'wire_red', rot=(0.5, -0.3, 0))
        mb.cyl(0.006, 0.006, 0.07, 5, (-0.005, 0.012, cz + R + 0.045), 'wire_yellow', rot=(-0.4, 0.4, 0))
        mb.box((0.18, 0.05, 0.004), (0.02, 0, cz + R * 0.98), 'tape', rot=(0, 0, 0.3))
    elif tier == 'basic':
        mb.cyl(R, R, L, segs, (0, 0, cz), 'paint_blue', rot=Y90)
        for sx in (1, -1):
            mb.cyl(R * 1.04, R * 1.04, 0.03, segs, (sx * L / 2, 0, cz), 'steel', rot=Y90)
        mb.cyl(R * 0.3, R * 0.3, 0.02, 8, (L / 2 + 0.02, 0, cz), 'steel', rot=Y90)
        mb.cyl(0.014, 0.014, 0.1, 8, (shaft_x, 0, cz), 'steel', rot=Y90)
        foot('paint_blue')
        mb.box((0.07, 0.07, 0.04), (-0.02, 0, cz + R + 0.01), 'paint_blue')
    elif tier == 'quality':
        mb.cyl(R, R, L, segs, (0, 0, cz), 'red_deep', rot=Y90)
        for i in range(5):  # cooling ribs
            x = -L / 2 + 0.04 + i * (L - 0.08) / 4
            mb.cyl(R * 1.08, R * 1.08, 0.012, segs, (x, 0, cz), 'red_deep', rot=Y90)
        for sx in (1, -1):
            mb.cyl(R * 1.05, R * 0.95, 0.035, segs, (sx * (L / 2 + 0.01), 0, cz), 'chrome',
                   rot=(0, sx * math.pi / 2, 0))
        mb.cyl(R * 1.09, R * 1.09, 0.008, segs, (L / 2 - 0.01, 0, cz), 'accent_orange', rot=Y90)
        mb.cyl(R * 0.35, R * 0.3, 0.025, 10, (L / 2 + 0.035, 0, cz), 'chrome', rot=Y90)
        mb.cyl(0.015, 0.015, 0.1, 10, (shaft_x + 0.01, 0, cz), 'chrome', rot=Y90)
        foot('anodised', bevel=0.005)
        mb.box((0.08, 0.075, 0.045), (-0.02, 0, cz + R + 0.012), 'anodised', bevel=0.006)
        for dx in (-0.02, 0.02):
            mb.cyl(0.008, 0.008, 0.012, 6, (-0.02 + dx, -0.015, cz + R + 0.04), 'copper')
    else:  # space
        mb.cyl(R, R, L, segs, (0, 0, cz), 'white', rot=Y90)
        for sx in (1, -1):
            mb.cyl(R * 1.01, R * 1.01, 0.008, segs, (sx * (L / 2 - 0.005), 0, cz), 'glow', rot=Y90)
            mb.cyl(R * 0.98, R * 0.7, 0.05, segs, (sx * (L / 2 + 0.024), 0, cz), 'gunmetal',
                   rot=(0, sx * math.pi / 2, 0))
        mb.cyl(R * 0.4, R * 0.4, 0.004, 12, (L / 2 + 0.05, 0, cz), 'glow_soft', rot=Y90)
        mb.cyl(0.014, 0.011, 0.09, 12, (shaft_x + 0.03, 0, cz), 'gold', rot=Y90)
        # Glowing vent slots along the top of the can.
        for i in range(3):
            mb.box((0.04, 0.012, 0.012), (-0.07 + i * 0.07, -R * 0.55, cz + R * 0.82), 'glow', rot=(0.6, 0, 0))
        mb.box((L * 0.85, R * 1.7, 0.02), (0, 0, 0.01), 'gunmetal', bevel=0.008)
        mb.box((L * 0.5, R * 0.9, cz - 0.02), (0, 0, 0.02 + (cz - 0.02) / 2), 'gunmetal', bevel=0.008)
        mb.box((L * 0.86, R * 1.72, 0.004), (0, 0, 0.022), 'glow_soft')


# --------------------------------------------------------------------------------------------- heat sink

def build_heatsink(mb, tier, rng):
    """Finned heat sink: a base plate with parallel fins along X, about 20 x 16 x 12 cm."""
    W, D, BASE, FIN_H = 0.2, 0.16, 0.022, 0.1

    def fins(n, mat, t=0.006, heights=None, skip=(), bent=None, length=W):
        for i in range(n):
            if i in skip:
                continue
            y = -D / 2 + 0.008 + i * (D - 0.016) / (n - 1)
            h = heights(i) if heights else FIN_H
            rot = (bent.get(i, 0), 0, 0) if bent else (0, 0, 0)
            m = mat(i) if callable(mat) else mat
            yield i, y, h, mb.box((length, t, h), (0, y, BASE + h / 2), m, rot=rot)

    if tier == 'scrap':
        base = mb.box((W, D, BASE), (0, 0, BASE / 2), 'rust', cuts=1)
        mb.jitter(base, rng, 0.003)
        hs = [rng(0.6, 1.0) for _ in range(8)]
        for i, y, h, v in fins(8, lambda i: 'steel_dull' if i % 3 else 'rust', t=0.007,
                               heights=lambda i: FIN_H * hs[i], skip=(5,), bent={1: 0.3, 6: -0.4, 7: -0.15}):
            mb.jitter(v, rng, 0.004)
    elif tier == 'basic':
        mb.box((W, D, BASE), (0, 0, BASE / 2), 'alu')
        list(fins(9, 'alu'))
    elif tier == 'quality':
        mb.box((W, D, BASE), (0, 0, BASE / 2), 'copper', bevel=0.004)
        list(fins(12, 'anodised', t=0.005))
        # Two copper heat pipes looping up out of the base and through the fins.
        for x in (-0.055, 0.055):
            for y in (-D / 2 - 0.012, D / 2 + 0.012):
                mb.cyl(0.008, 0.008, FIN_H * 0.75, 8, (x, y, BASE + FIN_H * 0.375), 'copper')
            mb.cyl(0.008, 0.008, D + 0.024, 8, (x, 0, BASE + FIN_H * 0.75), 'copper', rot=X90)
        mb.box((W + 0.004, 0.012, 0.008), (0, -D / 2 - 0.004, BASE * 0.5), 'accent_orange')
    else:  # space
        mb.box((W, D, BASE), (0, 0, BASE / 2), 'gold', bevel=0.006)
        mb.box((W * 0.7, 0.004, 0.008), (0, -D / 2 - 0.001, BASE * 0.5), 'glow')
        n = 11
        # Fins swept into an arch (tallest in the middle) with a glowing strip on each crest.
        for i, y, h, v in fins(n, 'gunmetal', t=0.005, length=W * 0.92,
                               heights=lambda i: FIN_H * (0.7 + 0.35 * math.sin(math.pi * i / (n - 1)))):
            mb.box((W * 0.92, 0.007, 0.005), (0, y, BASE + h), 'glow')


# ------------------------------------------------------------------------------------------- compute unit

def build_compute(mb, tier, rng):
    """Chunky compute module: a flat casing about 24 x 16 x 7 cm with a cooling fan on top, status lights
    on the front (-Y) and a circuit board edge connector sticking out of the +X end."""
    W, D, H = 0.24, 0.16, 0.07
    FX, FR = -0.04, 0.05  # fan centre (x) and radius
    segs = {'scrap': 10, 'basic': 12, 'quality': 16, 'space': 20}[tier]

    def edge_connector(board_mat, pin_mat, skip=()):
        mb.box((0.04, D * 0.6, 0.006), (W / 2 + 0.018, 0, H * 0.45), board_mat)
        for i in range(6):
            if i in skip:
                continue
            y = -D * 0.25 + i * D * 0.1
            for sz in (1, -1):
                mb.box((0.026, 0.008, 0.002), (W / 2 + 0.024, y, H * 0.45 + sz * 0.0035), pin_mat)

    def fan(ring_mat, blade_mat, hub_mat, z, blades=5, twist=0.5):
        mb.cyl(FR + 0.008, FR + 0.008, 0.006, segs, (FX, 0, z), ring_mat)
        mb.cyl(FR, FR, 0.004, segs, (FX, 0, z + 0.003), 'plastic_black')
        for i in range(blades):
            a = 2 * math.pi * i / blades
            mb.box((FR * 0.8, 0.018, 0.003), (FX + math.cos(a) * FR * 0.5, math.sin(a) * FR * 0.5, z + 0.006),
                   blade_mat, rot=(twist, 0, a))
        mb.cyl(FR * 0.3, FR * 0.3, 0.008, 10, (FX, 0, z + 0.007), hub_mat)

    if tier == 'scrap':
        body = mb.box((W, D, H * 0.75), (0, 0, H * 0.375), 'rust', cuts=2)
        mb.dent(body, (W / 2, -D / 2, H * 0.5), 0.07, 0.015)
        mb.jitter(body, rng, 0.002)
        # Half the lid is gone: the green board shows, with chips and a fat capacitor.
        mb.box((W * 0.55, D * 1.02, 0.008), (-W * 0.22, 0.002, H * 0.75 + 0.004), 'paint_faded_blue',
               rot=(0.02, -0.03, 0.04))
        mb.box((W * 0.44, D * 0.92, 0.004), (W * 0.27, 0, H * 0.75 - 0.002), 'pcb')
        mb.box((0.04, 0.04, 0.008), (W * 0.24, -0.03, H * 0.75 + 0.004), 'plastic_black', rot=(0, 0, 0.1))
        mb.box((0.025, 0.018, 0.006), (W * 0.36, 0.04, H * 0.75 + 0.003), 'plastic_black')
        mb.cyl(0.011, 0.011, 0.03, 8, (W * 0.38, -0.035, H * 0.75 + 0.015), 'steel_dull', rot=(0.25, 0, 0))
        fan('rust_dark', 'steel_dull', 'steel_dull', H * 0.75 + 0.008, blades=4, twist=0.3)
        mb.box((0.035, D + 0.012, 0.03), (FX - 0.07, 0, H * 0.6), 'tape', rot=(0, 0.06, 0))
        mb.cyl(0.004, 0.004, 0.07, 5, (W * 0.15, 0.03, H * 0.75 + 0.03), 'wire_red', rot=(0.9, 0.5, 0))
        mb.cyl(0.004, 0.004, 0.06, 5, (W * 0.18, 0.05, H * 0.75 + 0.025), 'wire_yellow', rot=(-0.7, 0.8, 0))
        edge_connector('pcb', 'steel_dull', skip=(1, 4))
    elif tier == 'basic':
        mb.box((W, D, H), (0, 0, H / 2), 'plastic_dark')
        mb.box((W + 0.006, D + 0.006, 0.008), (0, 0, H + 0.004), 'alu')
        fan('plastic_black', 'plastic_dark', 'alu', H + 0.008)
        for i in range(5):  # vent slots
            mb.box((0.008, D * 0.6, 0.003), (W * 0.12 + i * 0.016, 0, H + 0.009), 'plastic_black')
        mb.box((W * 0.3, 0.004, H * 0.45), (-W * 0.2, -D / 2 - 0.002, H * 0.5), 'label')
        mb.cyl(0.005, 0.005, 0.004, 8, (W * 0.35, -D / 2 - 0.002, H * 0.6), 'term_red', rot=X90)
        edge_connector('pcb', 'copper')
    elif tier == 'quality':
        mb.box((W, D, H), (0, 0, H / 2), 'anodised', bevel=0.008)
        mb.box((W - 0.01, D - 0.01, 0.008), (0, 0, H + 0.003), 'chrome', bevel=0.003)
        mb.box((W + 0.004, D + 0.004, 0.008), (0, 0, H * 0.25), 'accent_orange')
        fan('brass', 'anodised', 'chrome', H + 0.007, blades=7)
        # Copper heat pipes running from the fan to a fin stack.
        for y in (-0.03, 0.03):
            mb.cyl(0.006, 0.006, 0.1, 8, (0.045, y, H + 0.012), 'copper', rot=Y90)
        for i in range(6):
            mb.box((0.004, D * 0.7, 0.022), (0.065 + i * 0.01, 0, H + 0.018), 'alu')
        for i in range(3):
            mb.box((0.012, 0.004, 0.006), (W * 0.22 + i * 0.02, -D / 2 - 0.002, H * 0.6), 'led_green')
        edge_connector('navy', 'brass')
    else:  # space
        mb.box((W, D, H), (0, 0, H / 2), 'white', bevel=0.018)
        mb.box((W - 0.03, D - 0.03, 0.01), (0, 0, H + 0.001), 'gunmetal', bevel=0.004)
        mb.cyl(FR + 0.014, FR + 0.014, 0.004, segs, (FX, 0, H + 0.006), 'glow')
        fan('gunmetal', 'white', 'gold', H + 0.008, blades=7)
        # Glowing core window and data-light strip on the front, light seam all round.
        mb.box((0.06, 0.06, 0.004), (0.06, 0, H + 0.008), 'glow_soft')
        for i in range(5):
            mb.box((0.014, 0.004, 0.008), (-W * 0.25 + i * 0.022, -D / 2 - 0.001, H * 0.55), 'glow')
        for sy in (1, -1):
            mb.box((W - 0.04, 0.004, 0.006), (0, sy * D / 2, H * 0.2), 'glow_soft')
        for sx in (1, -1):
            mb.box((0.004, D - 0.04, 0.006), (sx * W / 2, 0, H * 0.2), 'glow_soft')
        edge_connector('gunmetal', 'gold')


# ------------------------------------------------------------------------------------------------- coil

def wire(mb, pts, r, segs, mat):
    """A bent wire through `pts`: one thin cylinder per segment, overlapping a little at the bends."""
    for a, b in zip(pts, pts[1:]):
        a, b = Vector(a), Vector(b)
        d = b - a
        mb.cyl(r, r, d.length + r, segs, (a + b) / 2, mat, rot=d.to_track_quat('Z', 'Y').to_euler())


def build_coil(mb, tier, rng):
    """Spool of copper wire lying on its side (axis along X): two flanges, a wound core, a loose end.
    About 14 x 16 x 16 cm, handheld."""
    R, L, FL = 0.08, 0.14, 0.012  # flange radius, length over the flanges, flange thickness
    cz = R
    inner = L / 2 - FL  # x of the flanges' inner faces
    segs = {'scrap': 10, 'basic': 12, 'quality': 16, 'space': 20}[tier]

    def windings(mat, r, n, alt=None, rw=0.0):
        """n bands of wire across the core; every other band sits a little proud so they read as turns."""
        w = 2 * inner / n
        for i in range(n):
            m = alt if alt and i % 2 else mat
            rr = r + (0.003 if i % 2 else 0) + (rng(-rw, rw) if rw else 0)
            yield mb.cyl(rr, rr, w, segs, (-inner + w * (i + 0.5), 0, cz), m, rot=Y90)

    def lead(r, x, mat, wr=0.004, tail=0.07):
        """Loose end peeling off the front of windings of radius r, dropping down and trailing along the ground
        towards +X (both in view of the 3/4 camera). Returns the tip."""
        tip = (x + tail, -R - 0.012, wr)
        wire(mb, [(x, -r * 0.7, cz + r * 0.7), (x + 0.006, -r - 0.016, cz + 0.005), (x + 0.014, -R - 0.016, 0.03),
                  (x + 0.03, -R - 0.018, wr), tip], wr, 6, mat)
        return tip

    if tier == 'scrap':
        # Rusty steel flange on one side, a dented faded-paint one off another spool on the other.
        a = mb.cyl(R, R, FL, segs, (inner + FL / 2, 0, cz), 'rust', rot=(0, math.pi / 2, 0.06))
        mb.jitter(a, rng, 0.004)
        b = mb.cyl(R * 0.94, R * 0.94, FL, segs, (-inner - FL / 2, 0, cz - R * 0.06), 'paint_faded_blue',
                   rot=(0.1, math.pi / 2, 0))
        mb.dent(b, (-inner, 0, cz + R), 0.05, 0.02)
        mb.cyl(R * 0.3, R * 0.3, L + 0.01, 8, (0, 0, cz), 'steel_dull', rot=Y90)
        # Half used up and lumpy: oxidised turns patched with green corrosion.
        for v in windings('copper', R * 0.62, 7, alt='rust_dark', rw=0.006):
            mb.jitter(v, rng, 0.002)
        mb.blob(0.018, (0.02, -R * 0.55, cz + R * 0.3), 'corrosion')
        mb.blob(0.014, (-0.03, -R * 0.4, cz + R * 0.5), 'corrosion')
        mb.box((0.035, R * 1.35, 0.004), (0.01, 0, cz + R * 0.66), 'tape', rot=(0, 0.1, 0.05))
        # Tangled loose ends: one sprung up over the top, one slumped down the front with a kink.
        wire(mb, [(0.025, -R * 0.35, cz + R * 0.5), (0.04, -R * 0.3, cz + R * 1.05), (0.0, 0.0, cz + R * 1.2),
                  (-0.05, 0.03, cz + R * 1.0), (-0.035, 0.07, cz + R * 1.15)], 0.0035, 5, 'copper')
        x, y, z = lead(R * 0.62, -0.03, 'copper', tail=0.05)
        wire(mb, [(x, y, z), (x + 0.015, y - 0.02, z), (x + 0.03, y + 0.005, z)], 0.004, 5, 'copper')
    elif tier == 'basic':
        for sx in (1, -1):
            mb.cyl(R, R, FL, segs, (sx * (inner + FL / 2), 0, cz), 'plastic_black', rot=Y90)
        mb.cyl(R * 0.22, R * 0.22, L + 0.004, 8, (0, 0, cz), 'plastic_dark', rot=Y90)
        list(windings('copper', R * 0.78, 6))
        lead(R * 0.78, 0.0, 'copper')
        mb.cyl(R * 0.62, R * 0.62, 0.002, segs, (L / 2 + 0.001, 0, cz), 'label', rot=Y90)  # paper label
        mb.cyl(R * 0.22, R * 0.22, 0.004, 8, (L / 2 + 0.002, 0, cz), 'plastic_dark', rot=Y90)
    elif tier == 'quality':
        for sx in (1, -1):
            mb.cyl(R, R * 0.96, FL, segs, (sx * (inner + FL / 2), 0, cz), 'anodised', rot=(0, sx * math.pi / 2, 0))
            mb.cyl(R * 1.01, R * 1.01, 0.004, segs, (sx * (inner + 0.002), 0, cz), 'brass', rot=Y90)
            mb.cyl(R * 0.28, R * 0.24, 0.012, 10, (sx * (L / 2 + 0.006), 0, cz), 'chrome',
                   rot=(0, sx * math.pi / 2, 0))
        list(windings('copper', R * 0.82, 9))
        mb.cyl(R * 0.86, R * 0.86, 0.012, segs, (-inner + 0.025, 0, cz), 'accent_orange', rot=Y90)  # band
        # Neat lead-out ending in a brass crimp lug.
        x, y, z = lead(R * 0.82, 0.01, 'copper', tail=0.06)
        mb.box((0.024, 0.014, 0.004), (x + 0.012, y, 0.002), 'brass', bevel=0.0015)
    else:  # space
        for sx in (1, -1):
            mb.cyl(R, R * 0.9, FL, segs, (sx * (inner + FL / 2), 0, cz), 'white', rot=(0, sx * math.pi / 2, 0))
            mb.cyl(R * 1.005, R * 1.005, 0.003, segs, (sx * (inner + 0.0015), 0, cz), 'glow', rot=Y90)
            mb.cyl(R * 0.3, R * 0.3, 0.008, 12, (sx * (L / 2 + 0.002), 0, cz), 'gunmetal', rot=Y90)
            mb.cyl(R * 0.16, R * 0.16, 0.003, 12, (sx * (L / 2 + 0.0075), 0, cz), 'glow_soft', rot=Y90)
        # Gold superconductor windings with glowing gaps between the bands.
        list(windings('gold', R * 0.8, 5))
        w = 2 * inner / 5
        for i in range(1, 5):
            mb.cyl(R * 0.8 + 0.002, R * 0.8 + 0.002, 0.003, segs, (-inner + w * i, 0, cz), 'glow', rot=Y90)
        x, y, z = lead(R * 0.8, 0.0, 'gold', wr=0.0035, tail=0.06)
        mb.cyl(0.007, 0.007, 0.014, 10, (x + 0.007, y, 0.007), 'glow', rot=Y90)  # glowing connector tip


# ------------------------------------------------------------------------------------------- anti-matter

def build_antimatter(mb, tier, rng):
    """Anti-matter container: a magnetic bottle about 15 cm across and 26 cm tall. Two heavy end caps joined
    by rods, a glowing violet core floating inside, held by containment rings round the waist, handle on top."""
    R, CAP, H = 0.075, 0.035, 0.26
    segs = {'scrap': 8, 'basic': 10, 'quality': 12, 'space': 16}[tier]
    mid = H / 2
    rod_r = R * 0.82

    def rods(n, mat, r=0.008, phase=math.pi / 4, skip=(), lean=None):
        for i in range(n):
            if i in skip:
                continue
            a = phase + 2 * math.pi * i / n
            rot = (lean.get(i, 0), 0, 0) if lean else (0, 0, 0)
            yield mb.cyl(r, r, H - 2 * CAP, 6, (rod_r * math.cos(a), rod_r * math.sin(a), mid), mat,
                         rot=(rot[0], 0, a) if lean else (0, 0, 0))

    def ring(r, t, z, mat, n=None, tilt=0.0):
        """Open hoop of n box segments (a low-poly torus) so the core stays visible through it."""
        n = n or segs
        seg = 2 * math.pi * r / n * 1.08
        for i in range(n):
            a = 2 * math.pi * (i + 0.5) / n
            p = Euler((tilt, 0, 0)).to_matrix() @ Vector((r * math.cos(a), r * math.sin(a), 0))
            rot = (Euler((tilt, 0, 0)).to_matrix() @ Euler((0, 0, a)).to_matrix()).to_euler()
            mb.box((t, seg, t), (p.x, p.y, z + p.z), mat, rot=tuple(rot))

    def handle(mat, z):
        for sx in (1, -1):
            mb.box((0.012, 0.014, 0.04), (sx * 0.045, 0, z + 0.02), mat)
        mb.box((0.102, 0.016, 0.014), (0, 0, z + 0.044), mat)

    if tier == 'scrap':
        # Mismatched caps: a rusty base, a faded blue top off something else, sitting crooked.
        base = mb.cyl(R, R * 0.97, CAP, segs, (0, 0, CAP / 2), 'rust')
        mb.jitter(base, rng, 0.003)
        top = mb.cyl(R * 0.95, R * 1.02, CAP, segs, (0.004, 0, H - CAP / 2), 'paint_faded_blue', rot=(0.05, -0.03, 0))
        mb.dent(top, (R, -0.02, H - CAP / 2), 0.05, 0.012)
        # Three rods left of four; one bent.
        for v in rods(4, 'steel_dull', skip=(2,), lean={1: 0.12}):
            mb.jitter(v, rng, 0.002)
        # One crooked containment hoop; the core is dim and lumpy, a strip of tape across the gap.
        ring(R * 0.62, 0.012, mid - 0.01, 'rust_dark', tilt=0.15)
        core = mb.blob(0.04, (0, 0, mid), 'am_core_dim')
        mb.jitter(core, rng, 0.005)
        mb.box((0.022, R * 2.05, 0.04), (0.03, 0, H - CAP - 0.03), 'tape', rot=(0.1, -0.1, -0.4))
        mb.cyl(0.005, 0.005, H * 0.7, 5, (R * 0.9, -R * 0.4, mid + 0.01), 'wire_red', rot=(0.25, 0.1, 0))
        mb.cyl(0.005, 0.005, H * 0.55, 5, (-R * 0.5, -R * 0.85, mid - 0.02), 'wire_yellow', rot=(-0.2, -0.15, 0))
        # A bent strap for a handle.
        mb.box((0.012, 0.014, 0.04), (0.045, 0, H + 0.016), 'steel_dull', rot=(0, 0.2, 0))
        mb.box((0.012, 0.014, 0.03), (-0.045, 0, H + 0.012), 'steel_dull', rot=(0, -0.1, 0))
        mb.box((0.105, 0.016, 0.012), (0, 0, H + 0.036), 'steel_dull', rot=(0, 0.12, 0.05))
    elif tier == 'basic':
        mb.cyl(R, R, CAP, segs, (0, 0, CAP / 2), 'plastic_dark')
        mb.cyl(R, R, CAP, segs, (0, 0, H - CAP / 2), 'plastic_dark')
        for z in (CAP / 2, H - CAP / 2):  # hazard bands round both caps
            mb.cyl(R * 1.02, R * 1.02, 0.012, segs, (0, 0, z), 'hazard_yellow')
        list(rods(4, 'steel'))
        ring(R * 0.6, 0.012, mid, 'steel')
        mb.blob(0.042, (0, 0, mid), 'am_core')
        mb.box((0.05, 0.004, 0.016), (0, -R - 0.002, H - CAP / 2 - 0.001), 'label', rot=(0, 0, 0))
        handle('plastic_black', H)
    elif tier == 'quality':
        mb.cyl(R, R * 0.92, CAP, segs, (0, 0, CAP / 2), 'anodised', rot=(math.pi, 0, 0))
        mb.cyl(R, R * 0.92, CAP, segs, (0, 0, H - CAP / 2), 'anodised')
        for z in (CAP + 0.004, H - CAP - 0.004):
            mb.cyl(R * 1.03, R * 1.03, 0.008, segs, (0, 0, z), 'chrome')
        list(rods(6, 'brass', r=0.007, phase=0))
        # Copper containment coils above and below the core, orange band at the base.
        for dz, rr in ((-0.045, 0.5), (0, 0.66), (0.045, 0.5)):
            ring(R * rr, 0.01, mid + dz, 'copper')
        mb.blob(0.04, (0, 0, mid), 'am_core')
        mb.cyl(R * 1.01, R * 1.01, 0.01, segs, (0, 0, CAP * 0.4), 'accent_orange')
        mb.cyl(0.007, 0.007, 0.006, 6, (0, -R * 0.6, H + 0.002), 'led_green')
        handle('chrome', H)
    else:  # space
        mb.cyl(R, R * 0.8, CAP, segs, (0, 0, CAP / 2), 'white', rot=(math.pi, 0, 0))
        mb.cyl(R, R * 0.8, CAP, segs, (0, 0, H - CAP / 2), 'white')
        for z in (CAP + 0.003, H - CAP - 0.003):
            mb.cyl(R * 0.96, R * 0.96, 0.006, segs, (0, 0, z), 'gunmetal')
        list(rods(3, 'gunmetal', r=0.009, phase=math.pi / 2))
        # Floating glowing containment hoops, the middle one tilted like a gyroscope.
        ring(R * 0.55, 0.007, mid - 0.05, 'glow', n=12)
        ring(R * 0.55, 0.007, mid + 0.05, 'glow', n=12)
        ring(R * 0.68, 0.007, mid, 'glow_soft', n=16, tilt=0.5)
        mb.blob(0.04, (0, 0, mid), 'am_core')
        mb.cyl(R * 0.4, R * 0.4, 0.004, 12, (0, 0, H + 0.001), 'glow')
        for sx in (1, -1):
            mb.box((0.012, 0.014, 0.034), (sx * 0.045, 0, H + 0.017), 'gunmetal', bevel=0.003)
        mb.box((0.102, 0.016, 0.012), (0, 0, H + 0.038), 'gold', bevel=0.003)


BUILDERS = {'battery': build_battery, 'motor': build_motor, 'heatsink': build_heatsink, 'compute': build_compute,
            'coil': build_coil, 'antimatter': build_antimatter}


def build_item(item, tier):
    name = f'{item}_{tier}'
    mb = MeshBuilder()
    BUILDERS[item](mb, tier, Rng(ITEMS.index(item) * 10 + TIERS.index(tier) + 1))
    # Origin at the centre of the base: shift so the lowest point sits on z = 0.
    bmesh.ops.recalc_face_normals(mb.bm, faces=mb.bm.faces)
    zmin = min(v.co.z for v in mb.bm.verts)
    bmesh.ops.translate(mb.bm, vec=Vector((0, 0, -zmin)), verts=mb.bm.verts)
    mesh = bpy.data.meshes.new(name)
    mb.bm.normal_update()
    mb.bm.to_mesh(mesh)
    mb.bm.free()
    for m in mb.mats:
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


# ------------------------------------------------------------------------------------------------ render

CAM_DIR = Vector((1.0, -1.25, 0.95)).normalized()  # camera sits front-right, above: a 3/4 view


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
    # A thin dark outline keeps the silhouette readable on any inventory background at 128 px.
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


def aim(cam, target, distance):
    cam.location = target + CAM_DIR * distance
    cam.rotation_euler = (-CAM_DIR).to_track_quat('-Z', 'Y').to_euler()


def frame_ortho(cam, objs):
    """Ortho camera along CAM_DIR fitting the union of the objects' bounding boxes (same framing per item)."""
    pts = [o.matrix_world @ v.co for o in objs for v in o.data.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    center = (lo + hi) / 2
    aim(cam, center, 3)
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
    cam.data.clip_end = 10


def render_icons(objs_by_item, out_dir, size):
    scene = bpy.context.scene
    cam = setup_render(scene, size, size)
    all_objs = [o for objs in objs_by_item.values() for o in objs]
    os.makedirs(out_dir, exist_ok=True)
    for item, objs in objs_by_item.items():
        frame_ortho(cam, objs)
        for obj in objs:
            for o in all_objs:
                o.hide_render = o is not obj
            scene.render.filepath = os.path.join(out_dir, obj.name + '.png')
            bpy.ops.render.render(write_still=True)
    for o in all_objs:
        o.hide_render = False


def render_preview(objs_by_item, path):
    """All items (rows, back to front) x tiers (columns) on a sand plane, perspective 3/4 view."""
    scene = bpy.context.scene
    cam = scene.camera or setup_render(scene, 1600, 1100)
    scene.render.resolution_x, scene.render.resolution_y = 1600, 1100
    scene.render.film_transparent = False
    scene.render.use_freestyle = False
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))
    ground = bpy.context.active_object
    ground.data.materials.append(make_material('ground', 0xd9a066, 0, 0.9, 0))
    rows = len(objs_by_item)
    for row, (item, objs) in enumerate(objs_by_item.items()):
        for col, obj in enumerate(objs):
            obj.location = ((col - (len(objs) - 1) / 2) * 0.45, (row - (rows - 1) / 2) * 0.45, 0)
    cam.data.type = 'PERSP'
    cam.data.lens = 50
    aim(cam, Vector((0, 0, 0.05)), 3.6 * max(1.0, rows / 3) ** 0.8)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--item', choices=ITEMS, action='append', help='only this item (repeatable)')
    ap.add_argument('--tier', choices=TIERS, action='append', help='only this tier (repeatable)')
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models', 'items'))
    ap.add_argument('--icons', default=os.path.join(ROOT, 'public', 'icons', 'items'))
    ap.add_argument('--icon-size', type=int, default=128)
    ap.add_argument('--no-icons', action='store_true')
    ap.add_argument('--preview', default=None, help='render a PNG of every built item side by side')
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in MATERIALS.items():
        make_material(name, *spec)

    os.makedirs(args.out, exist_ok=True)
    objs_by_item = {}
    for item in args.item or ITEMS:
        for tier in args.tier or TIERS:
            obj = build_item(item, tier)
            export_glb(obj, os.path.join(args.out, obj.name + '.glb'))
            d = obj.dimensions
            print(f'{obj.name}: tris={tri_count(obj)} size={d.x:.3f} x {d.y:.3f} x {d.z:.3f} m')
            objs_by_item.setdefault(item, []).append(obj)

    if not args.no_icons:
        render_icons(objs_by_item, args.icons, args.icon_size)
    if args.preview:
        render_preview(objs_by_item, os.path.abspath(args.preview))


main()
