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
ITEMS = ['battery', 'motor', 'heatsink', 'compute', 'coil', 'uranium', 'impeller', 'bearing', 'gear', 'valve',
         'relay', 'fanrotor', 'comprotor', 'turbinerotor']

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
    # uranium fuel (every tier): a green glow, dimmer and sickly when scrap
    'u_core': (0x8cff4a, 0.0, 0.3, 2.5),
    'u_core_dim': (0xa8c24a, 0.0, 0.5, 0.9),
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

    def _place(self, verts, mat, loc, rot, smooth=False):
        m = Matrix.Translation(Vector(loc)) @ Euler(rot).to_matrix().to_4x4()
        bmesh.ops.transform(self.bm, matrix=m, verts=verts)
        faces = {f for v in verts for f in v.link_faces}
        idx = self.mat(mat)
        for f in faces:
            f.material_index = idx
            f.smooth = smooth
        return verts

    def lathe(self, profile, segs, loc, mat, rot=(0, 0, 0), smooth=False, arc=2 * math.pi, phase=0.0):
        """Revolve a closed (r, z) profile loop about local Z (a race, flange, hub, shroud, torus...).
        Points on the axis (r = 0) are welded, so solid discs and domes work too."""
        n = len(profile)
        rings = []
        for i in range(segs):
            a = phase + arc * i / segs
            rings.append([self.bm.verts.new((r * math.cos(a), r * math.sin(a), z)) for r, z in profile])
        for i in range(segs):
            a, b = rings[i], rings[(i + 1) % segs]
            for j in range(n):
                k = (j + 1) % n
                self.bm.faces.new((a[j], b[j], b[k], a[k]))
        verts = [v for ring in rings for v in ring]
        axis = [v for v in verts if v.co.xy.length < 1e-7]
        if axis:
            bmesh.ops.remove_doubles(self.bm, verts=axis, dist=1e-6)
            verts = [v for v in verts if v.is_valid]
        return self._place(verts, mat, loc, rot, smooth)

    def torus(self, R, r, segs, tube_segs, loc, mat, rot=(0, 0, 0), smooth=True):
        prof = [(R + r * math.cos(2 * math.pi * j / tube_segs), r * math.sin(2 * math.pi * j / tube_segs))
                for j in range(tube_segs)]
        return self.lathe(prof, segs, loc, mat, rot, smooth)

    def ring_prism(self, outer, inner, z0, z1, mat, loc=(0, 0, 0), rot=(0, 0, 0)):
        """Flat plate between two closed (x, y) loops with the same point count (a gear rim, a bored disc),
        extruded from z0 to z1."""
        n = len(outer)
        o0 = [self.bm.verts.new((x, y, z0)) for x, y in outer]
        o1 = [self.bm.verts.new((x, y, z1)) for x, y in outer]
        i0 = [self.bm.verts.new((x, y, z0)) for x, y in inner]
        i1 = [self.bm.verts.new((x, y, z1)) for x, y in inner]
        for j in range(n):
            k = (j + 1) % n
            self.bm.faces.new((o1[j], o1[k], i1[k], i1[j]))
            self.bm.faces.new((o0[j], i0[j], i0[k], o0[k]))
            self.bm.faces.new((o0[j], o0[k], o1[k], o1[j]))
            self.bm.faces.new((i0[j], i1[j], i1[k], i0[k]))
        return self._place(o0 + o1 + i0 + i1, mat, loc, rot)

    def loft(self, sections, mat, loc=(0, 0, 0), rot=(0, 0, 0)):
        """Solid through a run of closed cross-sections (lists of points, same count each), capped at both
        ends: a curved impeller vane, a bent strap."""
        rows = [[self.bm.verts.new(p) for p in sec] for sec in sections]
        n = len(rows[0])
        for a, b in zip(rows, rows[1:]):
            for j in range(n):
                k = (j + 1) % n
                self.bm.faces.new((a[j], b[j], b[k], a[k]))
        self.bm.faces.new(list(reversed(rows[0])))
        self.bm.faces.new(rows[-1])
        return self._place([v for r in rows for v in r], mat, loc, rot)

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

    def ball(self, r, loc, mat, u=10, v=6):
        verts = bmesh.ops.create_uvsphere(self.bm, u_segments=u, v_segments=v, radius=r)['verts']
        return self._place(verts, mat, loc, (0, 0, 0), smooth=True)

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


# ---------------------------------------------------------------------------------------------- uranium

FRONT = -0.9  # azimuth (rad) of the side the icon camera looks at (CAM_DIR seen from above)


def trefoil(mb, r, z, az, mat, centre_mat, size=0.02, t=0.002):
    """Radiation mark flat on a cylinder of radius r, facing outwards at azimuth az: three blades round a dot."""
    rot = (0, math.pi / 2, az)  # local Z out of the surface, local -X up
    loc = (r * math.cos(az), r * math.sin(az), z)
    for k in range(3):
        c = math.pi + 2 * math.pi * k / 3  # local -X is up: one blade up, two below
        mb.lathe([(size * 0.32, 0), (size, 0), (size, t), (size * 0.32, t)], 4, loc, mat, rot=rot, arc=math.pi / 3,
                 phase=c - math.pi / 6)
    mb.cyl(size * 0.2, size * 0.2, t * 2, 8, loc, centre_mat, rot=rot)


def build_uranium(mb, tier, rng):
    """Uranium fuel cell: a heavy canister about 15 cm across and 26 cm tall. Thick end caps, a hazard-yellow band
    with a dark radiation mark low down, and above it a cage of ribs with slots showing the glowing green fuel rods
    round the core; a plug on top."""
    R, CAP, H = 0.075, 0.042, 0.26
    segs = {'scrap': 8, 'basic': 10, 'quality': 12, 'space': 16}[tier]
    band0, band1 = CAP, CAP + 0.058  # hazard band
    win0, win1 = band1 + 0.006, H - CAP  # window (slots) zone
    wmid, wh = (win0 + win1) / 2, win1 - win0

    def ribs(n, mat, r=R * 0.86, w=0.026, t=0.016, skip=(), phase=0.0):
        for i in range(n):
            if i in skip:
                continue
            a = phase + 2 * math.pi * i / n
            yield mb.box((t, w, wh + 0.004), (r * math.cos(a), r * math.sin(a), wmid), mat, rot=(0, 0, a))

    def fuel(mat, n=6, phase=math.pi / 6, rr=0.042, r=0.011, core=None):
        """Fuel rods standing in a ring between the ribs (so they show through the slots), and the core."""
        for i in range(n):
            a = phase + 2 * math.pi * i / n
            yield mb.cyl(r, r, wh, 6, (rr * math.cos(a), rr * math.sin(a), wmid), mat)
        mb.cyl(0.024, 0.024, wh, 8, (0, 0, wmid), core or mat)

    def band(mat, r=R * 0.97):
        mb.cyl(r, r, band1 - band0, segs * 2, (0, 0, (band0 + band1) / 2), mat)

    def plug(body, pin):
        mb.cyl(0.026, 0.026, 0.014, segs, (0, 0, H + 0.007), body)
        for a in (0.4, 0.4 + 2 * math.pi / 3, 0.4 + 4 * math.pi / 3):
            mb.cyl(0.004, 0.004, 0.014, 6, (0.014 * math.cos(a), 0.014 * math.sin(a), H + 0.018), pin)

    if tier == 'scrap':
        # Mismatched caps, dented, a rib torn out; the rods glow dim and sickly, tape over a crack.
        base = mb.cyl(R, R * 0.98, CAP, segs, (0, 0, CAP / 2), 'rust', rot=(0, 0, 0.1))
        mb.jitter(base, rng, 0.003)
        top = mb.cyl(R * 1.02, R * 0.96, CAP, segs, (0.003, 0, H - CAP / 2), 'paint_faded', rot=(0.04, -0.03, 0))
        mb.dent(top, (R * 0.6, -R * 0.8, H - CAP / 2), 0.05, 0.012)
        b = mb.cyl(R * 0.96, R * 0.96, band1 - band0, segs * 2, (0, 0, (band0 + band1) / 2), 'hazard_yellow')
        mb.jitter(b, rng, 0.0015)
        trefoil(mb, R * 0.96, (band0 + band1) / 2, FRONT, 'rust_dark', 'rust_dark', size=0.022)
        for v in ribs(6, 'steel_dull', skip=(4,)):
            mb.jitter(v, rng, 0.002)
        for v in fuel('u_core_dim'):
            mb.jitter(v, rng, 0.0015)
        mb.box((0.03, 0.006, wh * 0.8), (R * 0.88 * math.cos(-0.2), R * 0.88 * math.sin(-0.2), wmid), 'tape',
               rot=(0.05, 0.12, -0.2))
        mb.cyl(0.005, 0.005, H * 0.6, 5, (-R * 0.9, -R * 0.35, wmid), 'wire_red', rot=(0.2, -0.1, 0))
        plug('steel_dull', 'corrosion')
    elif tier == 'basic':
        mb.cyl(R, R, CAP, segs, (0, 0, CAP / 2), 'plastic_dark')
        mb.cyl(R, R, CAP, segs, (0, 0, H - CAP / 2), 'plastic_dark')
        band('hazard_yellow')
        trefoil(mb, R * 0.97, (band0 + band1) / 2, FRONT, 'plastic_black', 'plastic_black', size=0.023)
        list(ribs(6, 'steel'))
        list(fuel('u_core'))
        mb.box((0.05, 0.004, 0.018), (R * math.cos(FRONT + 0.9), R * math.sin(FRONT + 0.9), H - CAP / 2), 'label',
               rot=(0, 0, FRONT + 0.9 + math.pi / 2))
        plug('plastic_black', 'steel')
    elif tier == 'quality':
        mb.cyl(R * 0.94, R, CAP, segs, (0, 0, CAP / 2), 'anodised')
        mb.cyl(R, R * 0.94, CAP, segs, (0, 0, H - CAP / 2), 'anodised')
        for z in (CAP - 0.004, H - CAP + 0.004):
            mb.cyl(R * 1.03, R * 1.03, 0.008, segs, (0, 0, z), 'chrome')
        band('hazard_yellow')
        trefoil(mb, R * 0.97, (band0 + band1) / 2, FRONT, 'plastic_black', 'plastic_black', size=0.023)
        mb.cyl(R * 1.0, R * 1.0, 0.008, segs * 2, (0, 0, CAP * 0.35), 'accent_orange')
        list(ribs(8, 'brass', w=0.02, t=0.014, phase=math.pi / 8))
        list(fuel('u_core', n=8, phase=0, rr=0.044, r=0.009))
        mb.cyl(0.007, 0.007, 0.006, 6, (R * 0.55 * math.cos(FRONT), R * 0.55 * math.sin(FRONT), H + 0.002), 'led_green')
        plug('chrome', 'copper')
    else:  # space
        mb.cyl(R * 0.82, R, CAP, segs, (0, 0, CAP / 2), 'white')
        mb.cyl(R, R * 0.82, CAP, segs, (0, 0, H - CAP / 2), 'white')
        for z in (CAP + 0.002, H - CAP - 0.002):
            mb.cyl(R * 0.99, R * 0.99, 0.004, segs, (0, 0, z), 'glow')
        band('hazard_yellow', r=R * 0.95)
        trefoil(mb, R * 0.95, (band0 + band1) / 2, FRONT, 'gunmetal', 'gunmetal', size=0.023)
        list(ribs(4, 'gunmetal', w=0.032, t=0.016, phase=math.pi / 4))
        list(fuel('u_core', n=4, phase=0, rr=0.042, r=0.012))
        mb.cyl(0.026, 0.026, 0.004, 12, (0, 0, H + 0.016), 'glow_soft')
        plug('gunmetal', 'gold')


# ------------------------------------------------------------------------------------------------ bearing
# The mechanical and switching parts below come out of the crash-site machines in the disassembly mode. Each lies
# with its axis along Z (the game mounts it on a shaft by that axis) and keeps the same bounding-box proportions
# across its tiers, since the game scales every model to the same size.

def build_bearing(mb, tier, rng):
    """Open deep-groove ball bearing lying flat: outer and inner race with their ball grooves, a ring of balls in
    the gap kept apart by cage bridges. 9 cm across, 2.6 cm wide."""
    OD, W = 0.045, 0.026  # outer radius, width
    RO, RI, BORE = 0.0375, 0.0215, 0.015  # outer race's inside face, inner race's outside face, bore radius
    RB, BR, N = 0.0295, 0.0083, 8  # ball circle, ball radius, ball count
    segs = {'scrap': 16, 'basic': 20, 'quality': 24, 'space': 28}[tier]

    def races(outer, inner):
        c = 0.0012
        o = mb.lathe([(RO, 0), (OD - c, 0), (OD, c), (OD, W - c), (OD - c, W), (RO, W), (RO + 0.0005, W * 0.78),
                      (RO + 0.0022, W * 0.5), (RO + 0.0005, W * 0.22)], segs, (0, 0, 0), outer)
        i = mb.lathe([(BORE + c, 0), (RI, 0), (RI - 0.0005, W * 0.22), (RI - 0.0022, W * 0.5), (RI - 0.0005, W * 0.78),
                      (RI, W), (BORE + c, W), (BORE, W - c), (BORE, c)], segs, (0, 0, 0), inner)
        return o, i

    def balls(mat, skip=(), alt=None):
        for k in range(N):
            if k in skip:
                continue
            a = 2 * math.pi * k / N
            mb.ball(BR, (RB * math.cos(a), RB * math.sin(a), W / 2), alt if alt and k % 3 == 1 else mat, u=8)

    def cage(mat, skip=(), rivet=None):
        for k in range(N):
            if k in skip:
                continue
            a = 2 * math.pi * (k + 0.5) / N
            x, y = RB * math.cos(a), RB * math.sin(a)
            mb.box((0.005, 0.0052, 0.013), (x, y, W / 2), mat, rot=(0, 0, a))
            if rivet:
                mb.cyl(0.0016, 0.0016, 0.0145, 6, (x, y, W / 2), rivet)

    def face_ring(r0, r1, mat, z=W):
        """A thin band flush with a face (marking, seal lip, light strip)."""
        mb.lathe([(r0, z - 0.0004), (r1, z - 0.0004), (r1, z + 0.0004), (r0, z + 0.0004)], segs, (0, 0, 0), mat)

    if tier == 'scrap':
        o, i = races('rust', 'steel_dull')
        mb.jitter(o, rng, 0.0006)
        mb.dent(o, (OD, 0, W * 0.7), 0.02, 0.003)
        # A ball gone, some pitted, cage bridges broken out; grit and corrosion packed in the gap.
        balls('steel_dull', skip=(3,), alt='rust_dark')
        cage('rust_dark', skip=(2, 3, 6))
        mb.blob(0.005, (RB * math.cos(2.3), RB * math.sin(2.3), W * 0.62), 'corrosion')
        mb.blob(0.004, (RB * math.cos(5.0), RB * math.sin(5.0), W * 0.6), 'rust_dark')
    elif tier == 'basic':
        races('steel', 'steel')
        balls('steel')
        cage('plastic_black')
    elif tier == 'quality':
        races('chrome', 'chrome')
        balls('chrome')
        cage('brass', rivet='brass')
        face_ring(RO + 0.003, RO + 0.0055, 'accent_orange')
        face_ring(BORE + 0.002, BORE + 0.0035, 'brass')
    else:  # space
        races('white', 'gunmetal')
        balls('gold')
        cage('glow')
        face_ring(RO + 0.0025, RO + 0.0045, 'glow')
        face_ring(OD - 0.002, OD - 0.0008, 'gunmetal')


# ------------------------------------------------------------------------------------------------- gear

def gear_outline(n, ra, rp, rf, broken=(), worn=0.0):
    """Closed (x, y) outline of a spur gear: n teeth with tapered, slightly curved (involute-like) flanks.
    Broken teeth are snapped off near the root; `worn` rounds the tips down."""
    p = 2 * math.pi / n
    pts = []
    for i in range(n):
        c = i * p
        tip = rf + (ra - rf) * 0.2 if i in broken else ra - worn
        mid = min(rp, tip)
        for r, f in ((rf, -0.31), (mid, -0.235), (tip, -0.13), (tip, 0.13), (mid, 0.235), (rf, 0.31), (rf, 0.5)):
            pts.append((r * math.cos(c + f * p), r * math.sin(c + f * p)))
    return pts


def build_gear(mb, tier, rng):
    """Spur gear lying flat: 16 teeth on a rim, a web (or spokes) to a hub that stands proud on top, with a bore.
    11 cm across, 3.4 cm tall over the hub."""
    N, RP = 16, 0.05
    m = 2 * RP / N
    RA, RF, RIM = RP + m, RP - 1.25 * m, 0.036  # tip, root, rim's inside radius
    F, HUB_R, BORE, HUB_H = 0.022, 0.017, 0.009, 0.034  # face width, hub, bore, hub height
    segs = {'scrap': 16, 'basic': 20, 'quality': 24, 'space': 28}[tier]

    def rim(mat, broken=(), worn=0.0):
        outer = gear_outline(N, RA, RP, RF, broken, worn)
        inner = [(RIM * math.cos(math.atan2(y, x)), RIM * math.sin(math.atan2(y, x))) for x, y in outer]
        return mb.ring_prism(outer, inner, 0, F, mat)

    def hub(mat):
        c = 0.0012
        return mb.lathe([(BORE, 0), (HUB_R, 0), (HUB_R, HUB_H - c), (HUB_R - c, HUB_H), (BORE, HUB_H)], segs,
                        (0, 0, 0), mat)

    def web(mat):
        return mb.lathe([(HUB_R - 0.001, F * 0.3), (RIM + 0.001, F * 0.3), (RIM + 0.001, F * 0.7),
                         (HUB_R - 0.001, F * 0.7)], segs, (0, 0, 0), mat)

    def spokes(mat, n=5):
        L = RIM - HUB_R + 0.002
        for k in range(n):
            a = 2 * math.pi * (k + 0.25) / n
            r = (RIM + HUB_R) / 2
            mb.box((L, 0.008, F * 0.55), (r * math.cos(a), r * math.sin(a), F / 2), mat, rot=(0, 0, a))

    def set_screw(mat):
        mb.cyl(0.0032, 0.0032, 0.004, 8, (HUB_R + 0.0012, 0, F + (HUB_H - F) / 2), mat, rot=Y90)

    def face_ring(r0, r1, z, mat):
        mb.lathe([(r0, z - 0.0004), (r1, z - 0.0004), (r1, z + 0.0004), (r0, z + 0.0004)], segs, (0, 0, 0), mat)

    if tier == 'scrap':
        v = rim('rust', broken=(4, 5, 11), worn=0.0012)
        mb.jitter(v, rng, 0.0005)
        web('rust_dark')
        h = hub('steel_dull')
        mb.jitter(h, rng, 0.0004)
        mb.blob(0.006, (0.026 * math.cos(1.2), 0.026 * math.sin(1.2), F * 0.75), 'corrosion')
        mb.blob(0.005, (0.03 * math.cos(3.6), 0.03 * math.sin(3.6), F * 0.72), 'rust')
    elif tier == 'basic':
        rim('steel')  # machined teeth, painted cast body
        web('paint_blue')
        hub('paint_blue')
        face_ring(BORE, BORE + 0.0025, HUB_H, 'steel')
        set_screw('steel_dull')
    elif tier == 'quality':
        rim('chrome')
        spokes('anodised')
        hub('brass')
        face_ring(RIM + 0.0005, RIM + 0.003, F, 'accent_orange')
        set_screw('chrome')
    else:  # space
        rim('gunmetal')
        web('white')
        hub('gold')
        face_ring(0.024, 0.0275, F * 0.7, 'glow')
        face_ring(BORE, BORE + 0.002, HUB_H, 'glow')
        face_ring(RIM + 0.0008, RIM + 0.002, F, 'glow_soft')


# ---------------------------------------------------------------------------------------------- impeller

def build_impeller(mb, tier, rng):
    """Semi-open centrifugal pump impeller lying flat: a dished back shroud, six backward-curved vanes sweeping
    out from the eye, tall at the eye and tapering to the rim, a hub with its nut on top. 16 cm across."""
    R = 0.08
    NV, R0, R1, SWEEP = 6, 0.021, 0.0775, 1.15
    segs = {'scrap': 18, 'basic': 24, 'quality': 28, 'space': 32}[tier]
    shroud_top = [(0.012, 0.014), (0.02, 0.014), (0.05, 0.008), (R, 0.0045)]

    def top_at(r):
        for (ra, za), (rb, zb) in zip(shroud_top, shroud_top[1:]):
            if r <= rb:
                return za + (zb - za) * (r - ra) / (rb - ra)
        return shroud_top[-1][1]

    def shroud(mat):
        return mb.lathe([(0.012, 0), (R, 0)] + list(reversed(shroud_top))[:-1] + [(0.012, 0.014)], segs, (0, 0, 0),
                        mat)

    def hub(mat, h=0.048):
        return mb.lathe([(0.008, 0), (0.019, 0), (0.019, h - 0.006), (0.016, h), (0.008, h)], segs, (0, 0, 0), mat)

    def vane(k, mat, upto=1.0, t=0.0024, cap=None):
        """Vane k as a loft of quad sections along a backward-curved arc, its top dropping from eye to rim."""
        th0 = 2 * math.pi * k / NV
        n = 9
        secs, tops = [], []
        for j in range(n):
            s = upto * j / (n - 1)
            r = R0 + (R1 - R0) * s
            a = th0 - SWEEP * s ** 0.85
            c = Vector((r * math.cos(a), r * math.sin(a), 0))
            s2 = s + 0.01  # tangent from a nearby sample
            r2 = R0 + (R1 - R0) * s2
            a2 = th0 - SWEEP * s2 ** 0.85
            d = (Vector((r2 * math.cos(a2), r2 * math.sin(a2), 0)) - c).normalized()
            nrm = Vector((-d.y, d.x, 0))
            tt = t * (1.3 - 0.4 * s)
            z0 = top_at(r) - 0.0015
            z1 = 0.04 - 0.022 * s ** 0.9
            secs.append([c - nrm * tt + Vector((0, 0, z0)), c + nrm * tt + Vector((0, 0, z0)),
                         c + nrm * tt + Vector((0, 0, z1)), c - nrm * tt + Vector((0, 0, z1))])
            tops.append((c, nrm, tt, z1))
        v = mb.loft(secs, mat)
        if cap:  # a light strip along the vane's top edge
            mb.loft([[c - nrm * tt * 0.7 + Vector((0, 0, z1 - 0.0005)), c + nrm * tt * 0.7 + Vector((0, 0, z1 - 0.0005)),
                      c + nrm * tt * 0.7 + Vector((0, 0, z1 + 0.0009)), c - nrm * tt * 0.7 + Vector((0, 0, z1 + 0.0009))]
                     for c, nrm, tt, z1 in tops], cap)
        return v

    def nut(mat, z=0.048):
        mb.cyl(0.0125, 0.0125, 0.008, 6, (0, 0, z + 0.004), mat)
        mb.cyl(0.0075, 0.0075, 0.0085, 10, (0, 0, z + 0.004), 'plastic_black')  # shaft end in the nut

    def rim_band(mat):
        mb.lathe([(R - 0.0006, -0.0003), (R + 0.0003, -0.0003), (R + 0.0003, 0.0035), (R - 0.0006, 0.0035)], segs,
                 (0, 0, 0), mat)

    if tier == 'scrap':
        s = shroud('rust')
        mb.jitter(s, rng, 0.0008)
        mb.dent(s, (R, 0.01, 0.003), 0.025, 0.004)
        for k in range(NV):
            v = vane(k, 'rust', upto=0.55 if k == 2 else 1.0)  # one vane snapped off half way
            mb.jitter(v, rng, 0.0006)
        hub('steel_dull')
        nut('steel_dull')
        mb.blob(0.006, (0.045 * math.cos(1.0), 0.045 * math.sin(1.0), 0.012), 'corrosion')
        mb.blob(0.005, (0.06 * math.cos(4.1), 0.06 * math.sin(4.1), 0.009), 'rust_dark')
    elif tier == 'basic':
        shroud('alu')
        for k in range(NV):
            vane(k, 'alu')
        hub('alu')
        nut('steel')
    elif tier == 'quality':
        shroud('brass')  # cast bronze
        for k in range(NV):
            vane(k, 'brass')
        hub('brass')
        nut('chrome')
        rim_band('accent_orange')
    else:  # space
        shroud('white')
        for k in range(NV):
            vane(k, 'gunmetal', cap='glow')
        hub('gold')
        nut('gunmetal')
        mb.lathe([(0.0205, 0.0138), (0.024, 0.0132), (0.024, 0.0148), (0.0205, 0.0152)], segs, (0, 0, 0), 'glow')


# ------------------------------------------------------------------------------------------------- valve

def build_valve(mb, tier, rng):
    """Flanged gate valve, flow along Z (it stands in a vertical pipe run): flanged ends with studs and nuts, a
    bulging body, and the bonnet, gland and stem out to +X ending in a spoked handwheel. 22 cm flange to flange."""
    L, FR, FT, RB = 0.22, 0.09, 0.018, 0.031  # length, flange radius, flange thickness, bore
    ZC = L / 2
    segs = {'scrap': 12, 'basic': 16, 'quality': 18, 'space': 20}[tier]
    WX, WR, WT = 0.096, 0.046, 0.0055  # handwheel centre x, radius, rim thickness

    def flanges(bottom, top):
        c = 0.0015
        prof = [(RB, 0), (FR - c, 0), (FR, c), (FR, FT - c), (FR - c, FT), (RB, FT)]
        f0 = mb.lathe(prof, segs, (0, 0, 0), bottom)
        f1 = mb.lathe(prof, segs, (0, 0, L - FT), top)
        for z in (FT + 0.002, L - FT - 0.002):  # dark bore, so the pipe reads hollow
            mb.cyl(RB, RB, 0.002, segs, (0, 0, z), 'plastic_black')
        return f0, f1

    def body(mat):
        return mb.lathe([(RB, FT - 0.001), (0.045, FT - 0.001), (0.045, 0.05), (0.06, 0.068), (0.067, ZC),
                         (0.06, L - 0.068), (0.045, L - 0.05), (0.045, L - FT + 0.001), (RB, L - FT + 0.001)],
                        segs, (0, 0, 0), mat, smooth=True)

    def studs(nut_mat, skip=()):
        for k in range(4):
            a = math.pi / 4 + k * math.pi / 2
            x, y = 0.07 * math.cos(a), 0.07 * math.sin(a)
            for z, side in ((FT, 1), (L - FT, -1)):
                if (k, side) in skip:
                    continue
                mb.cyl(0.0075, 0.0075, 0.007, 6, (x, y, z + side * 0.0035), nut_mat)
                mb.cyl(0.0038, 0.0038, 0.012, 6, (x, y, z + side * 0.008), nut_mat)

    def bonnet(mat, flange_mat, gland_mat, stem_mat, bolts=None):
        mb.cyl(0.03, 0.026, 0.04, segs, (0.05, 0, ZC), mat, rot=Y90)
        mb.cyl(0.035, 0.035, 0.007, segs, (0.072, 0, ZC), flange_mat, rot=Y90)
        mb.cyl(0.016, 0.016, 0.011, 6, (0.081, 0, ZC), gland_mat, rot=Y90)
        mb.cyl(0.0055, 0.0055, 0.018, 8, (0.093, 0, ZC), stem_mat, rot=Y90)
        if bolts:
            for k in range(4):
                a = math.pi / 4 + k * math.pi / 2
                mb.cyl(0.0035, 0.0035, 0.004, 6, (0.0765, 0.027 * math.cos(a), ZC + 0.027 * math.sin(a)), bolts,
                       rot=Y90)

    def wheel(rim_mat, spoke_mat, hub_mat, spokes=3, skip=(), tilt=0.0):
        mb.torus(WR, WT, segs + 4, 6, (WX, 0, ZC), rim_mat, rot=(tilt, math.pi / 2, 0))
        mb.cyl(0.011, 0.011, 0.012, 8, (WX, 0, ZC), hub_mat, rot=Y90)
        for k in range(spokes):
            if k in skip:
                continue
            a = math.pi / 2 + 2 * math.pi * k / spokes
            r = (WR + 0.009) / 2
            mb.box((0.005, WR - 0.008, 0.006), (WX, r * math.cos(a), ZC + r * math.sin(a)), spoke_mat,
                   rot=(a - math.pi / 2, 0, 0))

    if tier == 'scrap':
        b = body('rust')
        mb.jitter(b, rng, 0.0008)
        f0, f1 = flanges('rust_dark', 'paint_faded')  # top flange off another valve
        mb.jitter(f1, rng, 0.0006)
        studs('steel_dull', skip={(1, 1), (2, -1)})
        bonnet('rust', 'rust_dark', 'steel_dull', 'steel_dull')
        mb.cyl(0.033, 0.033, 0.018, 10, (0.045, 0, ZC), 'tape', rot=(0.15, math.pi / 2, 0))  # taped-up leak
        wheel('rust_dark', 'rust_dark', 'steel_dull', skip=(1,))
        mb.blob(0.007, (0.064, -0.02, ZC - 0.02), 'corrosion')
        mb.blob(0.006, (0.045, 0.03, L - FT - 0.008), 'corrosion')
    elif tier == 'basic':
        body('paint_blue')
        flanges('paint_blue', 'paint_blue')
        studs('steel')
        bonnet('paint_blue', 'paint_blue', 'steel', 'steel')
        wheel('term_red', 'term_red', 'term_red')
    elif tier == 'quality':
        body('navy')
        flanges('chrome', 'chrome')
        studs('brass')
        bonnet('chrome', 'chrome', 'brass', 'chrome', bolts='brass')
        wheel('accent_orange', 'chrome', 'chrome', spokes=4)
        mb.lathe([(0.0675, ZC - 0.004), (0.069, ZC - 0.004), (0.069, ZC + 0.004), (0.0675, ZC + 0.004)], segs,
                 (0, 0, 0), 'chrome')  # body seam band
    else:  # space
        body('white')
        flanges('gunmetal', 'gunmetal')
        studs('gunmetal')
        for z in (FT, L):  # light rings on the flange faces
            mb.lathe([(0.048, z - 0.0004), (0.054, z - 0.0004), (0.054, z + 0.0004), (0.048, z + 0.0004)], segs,
                     (0, 0, 0), 'glow')
        bonnet('white', 'gunmetal', 'gold', 'gold')
        wheel('glow', 'gunmetal', 'gold', spokes=4)
        mb.lathe([(0.0675, ZC - 0.003), (0.0685, ZC - 0.003), (0.0685, ZC + 0.003), (0.0675, ZC + 0.003)], segs,
                 (0, 0, 0), 'glow_soft')


# ------------------------------------------------------------------------------------------------- relay

def build_relay(mb, tier, rng):
    """Electromechanical contactor (a big relay) as it sits on a DIN rail, front face up: a stepped moulded body,
    three main poles with screw terminals on a shelf at each end (line in, load out), the coil terminals A1/A2
    and the contact carrier showing through a window on top. 5.4 x 8 x 8 cm."""
    WX, DY, H = 0.054, 0.08, 0.076
    SH = 0.05  # shelf height (terminal level)
    UY = 0.044  # raised middle's depth

    def body(low, high, bevel=0.0):
        lo = mb.box((WX, DY, SH), (0, 0, SH / 2), low, bevel=bevel)
        hi = mb.box((WX, UY, H - SH), (0, 0, SH + (H - SH) / 2), high, bevel=bevel)
        return lo, hi

    def terminals(head, plate=None, skip=(), bad=None):
        for side in (1, -1):
            y = side * (UY / 2 + (DY - UY) / 4)
            for k, x in enumerate((-0.017, 0.0, 0.017)):
                mb.box((0.012, 0.012, 0.0012), (x, y, SH + 0.0004), 'plastic_black')  # recess
                mb.box((0.007, 0.0012, 0.006), (x, side * (DY / 2 + 0.0002), SH - 0.006), 'plastic_black')  # wire entry
                if (side, k) in skip:
                    continue
                if plate:
                    mb.box((0.01, 0.01, 0.0012), (x, y, SH + 0.0012), plate)
                m = bad if bad and (side, k) == (1, 2) else head
                mb.cyl(0.0042, 0.0042, 0.0025, 10, (x, y, SH + 0.0025), m)
                mb.box((0.0075, 0.0012, 0.0008), (x, y, SH + 0.0039), 'plastic_black', rot=(0, 0, 0.6))  # slot

    def coil_terminals(head):
        for x in (-0.0175, 0.0175):
            mb.box((0.011, 0.011, 0.0012), (x, -UY / 2 + 0.008, H + 0.0004), 'plastic_black')
            mb.cyl(0.0038, 0.0038, 0.0022, 10, (x, -UY / 2 + 0.008, H + 0.0011), head)

    def window(mat, label=None):
        mb.box((0.022, 0.014, 0.0014), (0, 0.004, H + 0.0004), 'plastic_black')
        mb.box((0.016, 0.009, 0.002), (0, 0.004, H + 0.0006), mat)
        if label:
            mb.box((0.04, 0.007, 0.0008), (0, UY / 2 - 0.006, H + 0.0002), label)

    if tier == 'scrap':
        lo, hi = body('plastic_dark', 'label')
        mb.jitter(hi, rng, 0.0006)
        mb.dent(hi, (WX / 2, UY / 2, H), 0.012, 0.005)  # cracked corner
        terminals('steel_dull', skip={(-1, 0)}, bad='corrosion')
        coil_terminals('steel_dull')
        window('rust_dark')
        # Scorched, melted pole: a burnt patch down the side and a slumped lump by the terminal.
        mb.box((0.0012, 0.03, 0.03), (WX / 2 + 0.0002, 0.018, 0.028), 'plastic_black', rot=(0.2, 0, 0))
        mb.blob(0.006, (0.018, 0.032, SH + 0.002), 'plastic_black')
        mb.box((0.003, 0.03, 0.022), (-0.012, 0, H - 0.008), 'tape', rot=(0, 0.05, 0.1))
        wire(mb, [(0.0, -0.031, SH + 0.002), (0.004, -0.036, SH + 0.012), (0.012, -0.034, SH + 0.022)], 0.0022, 5,
             'wire_red')
        wire(mb, [(0.017, 0.031, SH + 0.002), (0.02, 0.034, SH + 0.014), (0.014, 0.038, SH + 0.02)], 0.0022, 5,
             'copper')
    elif tier == 'basic':
        body('plastic_dark', 'label', bevel=0.001)
        terminals('steel')
        coil_terminals('steel')
        window('plastic_black', label='paint_blue')
    elif tier == 'quality':
        body('anodised', 'navy', bevel=0.0015)
        terminals('brass', plate='chrome')
        coil_terminals('brass')
        window('accent_orange', label='label')
        mb.cyl(0.0022, 0.0022, 0.002, 8, (0.019, 0.004, H + 0.0008), 'led_green')
    else:  # space
        body('gunmetal', 'white', bevel=0.002)
        terminals('gold')
        coil_terminals('gold')
        window('glow')
        for sx in (1, -1):  # light seam along the waist
            mb.box((0.0008, UY - 0.008, 0.003), (sx * WX / 2, 0, SH + 0.006), 'glow_soft')
        mb.box((0.03, 0.002, 0.0008), (0, UY / 2 - 0.006, H + 0.0002), 'glow')


# ---------------------------------------------------------------------------------------------- jet engine rotors
# The rotors of tools/blender/machines/turbofan.py taken whole out of the engine, at 0.4 of its size (the game scales the
# model to fit: src/teardown/junk.ts SIZE). The axis is Z, the front of the engine up. Engine dimensions are kept in
# the numbers below ("E" = engine metres) so the rotor in the engine and this one match.

ROTOR_K = 0.4


def _rotor_mats(tier):
    return {
        'scrap': dict(body='rust_dark', hub='steel_dull', blade='rust', alt='steel_dull'),
        'basic': dict(body='steel', hub='paint_blue', blade='alu', alt='steel'),
        'quality': dict(body='anodised', hub='copper', blade='chrome', alt='brass'),
        'space': dict(body='gunmetal', hub='white', blade='white', alt='glow_soft'),
    }[tier]


def _rotor_blade(mb, a, r0, r1, z, chord0, chord1, tw0, tw1, thick, mat, bend=0.0, stations=4):
    """One blade root at r0 tip at r1 about the axis at angle a, centred at engine z (see turbofan.py blade())."""
    K = ROTOR_K
    rings = []
    ca, sa = math.cos(a), math.sin(a)
    for i in range(stations):
        s = i / (stations - 1)
        c = chord0 + (chord1 - chord0) * s
        tw = tw0 + (tw1 - tw0) * s
        x = r0 + (r1 - r0) * s
        off = bend * s * s
        ring = []
        for (u, v) in ((-0.5, 0.0), (-0.1, thick), (0.5, 0.0), (-0.1, -thick)):
            cz, cy = u * c, v
            y = cy * math.cos(tw) - cz * math.sin(tw) + off
            zz = z + cy * math.sin(tw) + cz * math.cos(tw)
            ring.append(Vector(((x * ca - y * sa) * K, (x * sa + y * ca) * K, zz * K)))
        rings.append(ring)
    return mb.loft(rings, mat)


def _rotor_row(mb, tier, rng, n, r0, r1, z, chord, tw, thick, mat, alt, broken=0, bent=0, phase=0.0):
    idx = list(range(n))
    for i in range(n - 1, 0, -1):  # a deterministic shuffle
        j = int(rng(0, i + 0.999))
        idx[i], idx[j] = idx[j], idx[i]
    if tier != 'scrap':
        broken = bent = 0
    snapped, folded = set(idx[:broken]), set(idx[broken:broken + bent])
    for i in range(n):
        a = phase + 2 * math.pi * i / n
        if i in snapped:
            _rotor_blade(mb, a, r0, r0 + (r1 - r0) * rng(0.2, 0.5), z, chord, chord * 0.9, tw, tw, thick, alt)
        elif i in folded:
            _rotor_blade(mb, a, r0, r1, z, chord, chord * 0.8, tw, tw, thick, mat, bend=rng(0.12, 0.3))
        else:
            _rotor_blade(mb, a, r0, r1, z, chord, chord * 0.8, tw, tw * 0.5, thick, mat)


def _disc(mb, prof, mat, segs=32):
    K = ROTOR_K
    return mb.lathe([(r * K, z * K) for r, z in prof], segs, (0, 0, 0), mat)


def build_fanrotor(mb, tier, rng):
    """The fan: a disc with a ring of wide, twisted blades (some snapped or bent when scrap), a nose seat on the front."""
    m = _rotor_mats(tier)
    _disc(mb, [(0.0, 0.85), (0.23, 0.85), (0.23, 0.97), (0.205, 1.0), (0.0, 1.0)], m['hub'])
    _disc(mb, [(0.09, 1.0), (0.15, 1.0), (0.15, 1.02), (0.09, 1.02)], m['alt'], 20)
    _disc(mb, [(0.0, 0.85), (0.1, 0.85), (0.1, 0.8), (0.0, 0.8)], m['body'], 20)  # the shaft stub
    _rotor_row(mb, tier, rng, 28, 0.20, 0.785, 0.93, 0.19, 0.55, 0.014, m['blade'], m['alt'], broken=5, bent=4)
    if tier == 'space':
        _disc(mb, [(0.228, 0.9), (0.232, 0.9), (0.232, 0.92), (0.228, 0.92)], 'glow', 32)


def _drum_r(z):
    return 0.19 + 0.05 * (0.44 - z) / 0.24 if z > 0.2 else 0.24 + 0.015 * (0.2 - z) / 0.28


def _case_r(z):
    return 0.34 - 0.015 * (0.46 - z) / 0.26 if z > 0.2 else 0.325 - 0.015 * (0.2 - z) / 0.28


def build_comprotor(mb, tier, rng):
    """The compressor: a drum widening toward the back with seven rows of blades, each row longer than the one before."""
    m = _rotor_mats(tier)
    _disc(mb, [(0.0, 0.44), (0.19, 0.44), (0.24, 0.20), (0.255, -0.08), (0.0, -0.08)], m['hub'])
    _disc(mb, [(0.05, -0.08), (0.05, -0.14), (0.0, -0.14)], m['body'], 14)
    for j in range(7):
        z = 0.40 - j * 0.07
        _rotor_row(mb, tier, rng, 34, _drum_r(z) - 0.01, _case_r(z) - 0.04, z, 0.045, 0.5, 0.006, m['blade'], m['alt'],
                   broken=1 if j in (2, 5) else 0, bent=1 if j == 3 else 0, phase=j * 0.07)


def build_turbinerotor(mb, tier, rng):
    """The turbine: a heavy disc with its ring of burnt blades, four lighter discs behind it, and the shaft out of the back."""
    m = _rotor_mats(tier)
    burnt = 'rust_dark' if tier == 'scrap' else m['blade']
    _disc(mb, [(0.0, -0.42), (0.20, -0.42), (0.22, -0.60), (0.0, -0.60)], m['hub'], 24)
    _rotor_row(mb, tier, rng, 40, 0.20, 0.285, -0.50, 0.07, 0.6, 0.008, burnt, m['alt'], broken=3, bent=2)
    for j in range(4):
        z = -0.70 - j * 0.07
        _rotor_row(mb, tier, rng, 54, 0.12, 0.30 + 0.02 * j, z, 0.05, 0.4, 0.006, burnt, m['alt'], broken=2 if j in (1, 3) else 0,
                   bent=2 if j == 2 else 0, phase=j * 0.05)
        _disc(mb, [(0.0, z + 0.015), (0.16 + 0.015 * j, z + 0.015), (0.16 + 0.015 * j, z - 0.015), (0.0, z - 0.015)], m['body'], 24)
    _disc(mb, [(0.0, -0.60), (0.06, -0.60), (0.06, -0.98), (0.0, -0.98)], m['body'], 14)
    if tier == 'space':
        _disc(mb, [(0.2, -0.43), (0.205, -0.43), (0.205, -0.45), (0.2, -0.45)], 'glow', 24)


BUILDERS = {'battery': build_battery, 'motor': build_motor, 'heatsink': build_heatsink, 'compute': build_compute,
            'coil': build_coil, 'uranium': build_uranium, 'impeller': build_impeller, 'bearing': build_bearing,
            'gear': build_gear, 'valve': build_valve, 'relay': build_relay,
            'fanrotor': build_fanrotor, 'comprotor': build_comprotor, 'turbinerotor': build_turbinerotor}


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


# Guarded so tools/blender/placeables.py can import the helpers above.
if __name__ == '__main__':
    main()
