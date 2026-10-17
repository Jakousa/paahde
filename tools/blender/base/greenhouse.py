"""Greenhouse furniture and plants for the home base, exported as one glTF binary.

    blender -b --python tools/blender/base/greenhouse.py                          # writes public/models/base/greenhouse.glb
    blender -b --python tools/blender/base/greenhouse.py -- --preview out.png     # also renders a line-up + close-ups

Top-level nodes (each one joined mesh, origin at its base centre on the floor unless noted):
    planter_empty, planter_sprouts, planter_grown   raised bed in three growth stages (2.4 x 1.0 x 0.7 m)
    tree_pot        brass-banded pot with a young broad-leaf tree (~2.6 m)
    seed_cabinet    seed vault: drawers + glass-front jar cabinet + small lamp (1.2 x 0.5 x 1.8 m, back flat)
    cistern         barrel cistern with hand pump, bucket and watering can (1.6 x 1.2 footprint)
    grow_lamp       hanging grow light; origin at the TOP attachment, hangs down (chain + 2 m hood)
    vine_trellis    iron trellis with climbing vines and fruit (2.0 x 2.6 m, back flat)
    potting_bench   potting bench with pots, trays, tools and sacks (1.8 x 0.7 m, top at 0.9 m, back flat)
    pot_cluster     5-7 clay/brass pots with small plants, within radius 0.8 m

Blender is Z-up; the exporter converts to Y-up. The usable front faces Blender -Y (= game +Z); "back flat"
pieces have a flat back at their max Blender Y. Deterministic: the same output every run.
"""

import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

sys.dont_write_bytecode = True  # no __pycache__ next to the scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from coplanar import separate_coplanar  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))

# name: (sRGB hex, roughness, metallic)
PALETTE = {
    'brass': (0xa8844e, 0.4, 0.4),
    'brass_dark': (0x7d5f36, 0.55, 0.35),
    'verdigris': (0x5f9c8a, 0.7, 0.25),
    'copper': (0xb0683a, 0.4, 0.4),
    'iron': (0x3a3430, 0.7, 0.3),
    'wood': (0x7a5a3a, 0.8, 0.0),
    'wood_dark': (0x5a4029, 0.8, 0.0),
    'soil': (0x3b2a1e, 0.95, 0.0),
    'soil_light': (0x4d3726, 0.95, 0.0),
    'clay': (0xa85a38, 0.85, 0.0),
    'clay_dark': (0x8a4630, 0.85, 0.0),
    'paper': (0xe0d2a8, 0.8, 0.0),
    'burlap': (0xa88a5c, 0.95, 0.0),
    'burlap_dark': (0x86683f, 0.95, 0.0),
    'stem': (0x5d7a2e, 0.8, 0.0),
    'bark': (0x6a4a30, 0.9, 0.0),
    'leaf_a': (0x4f7d3a, 0.65, 0.0),
    'leaf_b': (0x6f9a45, 0.65, 0.0),
    'leaf_c': (0x2f5a2a, 0.65, 0.0),
    'leaf_young': (0x8fbf45, 0.6, 0.0),
    'cactus': (0x4f8a52, 0.7, 0.0),
    'flower_red': (0xd0402c, 0.6, 0.0),
    'flower_yellow': (0xf0c03a, 0.6, 0.0),
    'flower_violet': (0x8a50c0, 0.6, 0.0),
    'flower_pink': (0xe06a90, 0.6, 0.0),
    'flower_heart': (0xf2d070, 0.6, 0.0),
    'fruit_red': (0xc0302a, 0.45, 0.0),
    'fruit_orange': (0xec8a20, 0.45, 0.0),
    'fruit_purple': (0x5a2a66, 0.4, 0.0),
    'seed_a': (0xc8a060, 0.9, 0.0),
    'seed_b': (0x6a4a2a, 0.9, 0.0),
    'seed_c': (0xb0a050, 0.9, 0.0),
    'seed_d': (0x8a3a2a, 0.9, 0.0),
    'water': (0x3a7a80, 0.1, 0.0),
}
DOUBLE_SIDED = {'leaf_a', 'leaf_b', 'leaf_c', 'leaf_young', 'flower_red', 'flower_yellow', 'flower_violet',
                'flower_pink', 'paper', 'burlap', 'burlap_dark'}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgb(h):
    return [srgb_to_linear(((h >> s) & 0xFF) / 255) for s in (16, 8, 0)]


def make_materials():
    for name, (hx, rough, metal) in PALETTE.items():
        m = bpy.data.materials.new(name)
        rgb = hex_rgb(hx)
        m.diffuse_color = (*rgb, 1)
        m.use_nodes = True
        b = m.node_tree.nodes['Principled BSDF']
        b.inputs['Base Color'].default_value = (*rgb, 1)
        b.inputs['Roughness'].default_value = rough
        b.inputs['Metallic'].default_value = metal
        m.use_backface_culling = name not in DOUBLE_SIDED

    g = bpy.data.materials.new('Glass')
    rgb = hex_rgb(0xd8efe8)
    g.diffuse_color = (*rgb, 0.25)
    g.use_nodes = True
    b = g.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = 0.05
    b.inputs['Alpha'].default_value = 0.18
    g.use_backface_culling = False
    for attr, val in (('surface_render_method', 'BLENDED'), ('blend_method', 'BLEND')):
        try:
            setattr(g, attr, val)
        except (AttributeError, TypeError):
            pass

    for name, hx, strength in (('EmitGrow', 0xffe6b0, 6.0), ('EmitLamp', 0xffc070, 5.0)):
        m = bpy.data.materials.new(name)
        rgb = hex_rgb(hx)
        m.diffuse_color = (*rgb, 1)
        m.use_nodes = True
        b = m.node_tree.nodes['Principled BSDF']
        b.inputs['Base Color'].default_value = (*rgb, 1)
        b.inputs['Emission Color'].default_value = (*rgb, 1)
        b.inputs['Emission Strength'].default_value = strength


class Rng:
    """Tiny deterministic LCG so re-running the script gives identical models."""

    def __init__(self, seed):
        self.s = seed * 2654435761 % 2**32 or 1

    def __call__(self, a=0.0, b=1.0):
        self.s = (1664525 * self.s + 1013904223) % 2**32
        return a + (b - a) * self.s / 2**32

    def pick(self, seq):
        return seq[min(len(seq) - 1, int(self(0, len(seq))))]


def lerp(a, b, t):
    return a + (b - a) * t


V = Vector
UP = V((0, 0, 1))


def frame_to(d):
    """Rotation matrix taking +Z to direction d."""
    return V((0, 0, 1)).rotation_difference(V(d).normalized()).to_matrix().to_4x4()


class MB:
    """bmesh builder with named materials; every primitive is tagged with its material."""

    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []

    def mi(self, name):
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    def _tag(self, verts, mat, smooth=False):
        i = self.mi(mat)
        for f in {f for v in verts for f in v.link_faces}:
            f.material_index = i
            f.smooth = smooth

    def v(self, p):
        return self.bm.verts.new(p)

    def face(self, verts, mat, smooth=False):
        f = self.bm.faces.new(verts)
        f.material_index = self.mi(mat)
        f.smooth = smooth
        return f

    def box(self, c, s, mat, rot=(0, 0, 0)):
        M = Matrix.Translation(c) @ Euler(rot).to_matrix().to_4x4() @ Matrix.Diagonal((*s, 1))
        r = bmesh.ops.create_cube(self.bm, size=1, matrix=M)
        self._tag(r['verts'], mat)

    def box_between(self, p0, p1, w, h, mat, up=None):
        """Bar of cross-section w x h from p0 to p1."""
        p0, p1 = V(p0), V(p1)
        d = p1 - p0
        q = frame_to(d)
        M = Matrix.Translation((p0 + p1) / 2) @ q @ Matrix.Diagonal((w, h, d.length, 1))
        r = bmesh.ops.create_cube(self.bm, size=1, matrix=M)
        self._tag(r['verts'], mat)

    def cyl(self, p0, p1, r0, mat, r1=None, seg=8, caps=True, smooth=False):
        p0, p1 = V(p0), V(p1)
        d = p1 - p0
        M = Matrix.Translation((p0 + p1) / 2) @ frame_to(d)
        r = bmesh.ops.create_cone(self.bm, cap_ends=caps, cap_tris=False, segments=seg, radius1=r0,
                                  radius2=r0 if r1 is None else r1, depth=d.length, matrix=M)
        self._tag(r['verts'], mat, smooth)

    def sphere(self, c, r, mat, u=8, vv=5, scale=(1, 1, 1), smooth=False, jitter=0.0, rng=None, rot=(0, 0, 0)):
        M = Matrix.Translation(c) @ Euler(rot).to_matrix().to_4x4() @ Matrix.Diagonal((*scale, 1))
        res = bmesh.ops.create_uvsphere(self.bm, u_segments=u, v_segments=vv, radius=r, matrix=M)
        if jitter and rng:
            for vt in res['verts']:
                vt.co += V((rng(-1, 1), rng(-1, 1), rng(-1, 1))) * jitter * r
        self._tag(res['verts'], mat, smooth)

    def ico(self, c, r, mat, scale=(1, 1, 1), sub=1, jitter=0.0, rng=None, smooth=False):
        M = Matrix.Translation(c) @ Matrix.Diagonal((*scale, 1))
        res = bmesh.ops.create_icosphere(self.bm, subdivisions=sub, radius=r, matrix=M)
        if jitter and rng:
            for vt in res['verts']:
                vt.co += V((rng(-1, 1), rng(-1, 1), rng(-1, 1))) * jitter * r
        self._tag(res['verts'], mat, smooth)

    def rivet(self, p, n, r=0.012):
        n = V(n).normalized()
        p = V(p)
        h = r * 0.7
        M = Matrix.Translation(p + n * h / 2) @ frame_to(n)
        res = bmesh.ops.create_cone(self.bm, cap_ends=False, segments=4, radius1=r, radius2=0.0, depth=h,
                                    matrix=M)
        self._tag(res['verts'], 'brass')

    def tube(self, pts, r, mat, seg=6, r_end=None, caps=True, closed=False, fixed_n=None, smooth=True):
        pts = [V(p) for p in pts]
        n = len(pts)
        rings = []
        prev = None
        for i, p in enumerate(pts):
            if closed:
                t = (pts[(i + 1) % n] - pts[(i - 1) % n]).normalized()
            else:
                t = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
            if fixed_n is not None:
                nr = V(fixed_n)
                nr = (nr - t * nr.dot(t)).normalized()
            elif prev is None:
                a = UP if abs(t.z) < 0.9 else V((1, 0, 0))
                nr = t.cross(a).normalized()
            else:
                nr = (prev - t * prev.dot(t)).normalized()
            prev = nr
            b = t.cross(nr)
            rr = r if r_end is None else lerp(r, r_end, i / (n - 1))
            rings.append([self.v(p + (nr * math.cos(a) + b * math.sin(a)) * rr)
                          for a in (2 * math.pi * k / seg for k in range(seg))])
        last = n if closed else n - 1
        for i in range(last):
            lo, hi = rings[i], rings[(i + 1) % n]
            for j in range(seg):
                k = (j + 1) % seg
                self.face([lo[j], lo[k], hi[k], hi[j]], mat, smooth)
        if caps and not closed:
            self.face(list(reversed(rings[0])), mat)
            self.face(rings[-1], mat)

    def lathe(self, prof, mat, seg=12, c=(0, 0, 0), col_mats=None, smooth=False, phase=0.0, squash=1.0):
        """Revolve profile [(r, z) or (r, z, mat)] around Z. Profile order sets the outward side:
        go out along the bottom, up the outside, over the rim and down the inside."""
        c = V(c)
        rings = []
        for p in prof:
            r, z = p[0], p[1]
            if r <= 1e-6:
                rings.append([self.v(c + V((0, 0, z)))])
            else:
                rings.append([self.v(c + V((math.cos(a) * r, math.sin(a) * r * squash, z)))
                              for a in (phase + 2 * math.pi * k / seg for k in range(seg))])
        for i in range(len(rings) - 1):
            lo, hi = rings[i], rings[i + 1]
            m = prof[i + 1][2] if len(prof[i + 1]) > 2 else mat
            for j in range(seg):
                k = (j + 1) % seg
                mm = col_mats[j % len(col_mats)] if (col_mats and m == mat) else m
                if len(lo) == 1:
                    self.face([lo[0], hi[k], hi[j]], mm, smooth)
                elif len(hi) == 1:
                    self.face([lo[j], lo[k], hi[0]], mm, smooth)
                else:
                    self.face([lo[j], lo[k], hi[k], hi[j]], mm, smooth)

    def band(self, c, r, z0, z1, mat, seg=12, t=0.012, rivets=0, rng=None):
        """Metal hoop around a vertical round body of radius r."""
        self.lathe([(r, z0), (r + t, z0), (r + t, z1), (r, z1)], mat, seg=seg, c=c)
        for k in range(rivets):
            a = 2 * math.pi * (k + 0.5) / rivets
            n = V((math.cos(a), math.sin(a), 0))
            self.rivet(V(c) + n * (r + t) + V((0, 0, (z0 + z1) / 2)), n, r=min(0.012, (z1 - z0) * 0.35))

    def leaf(self, base, d, nrm, length, width, mat, droop=0.0, fold=0.25, ribbed=False):
        """Diamond leaf folded along its midrib (2 tris), or 4 tris with a bending rib."""
        base, d, nrm = V(base), V(d).normalized(), V(nrm)
        nrm = nrm - d * nrm.dot(d)
        if nrm.length < 1e-4:
            nrm = d.orthogonal()
        nrm.normalize()
        s = d.cross(nrm)
        down = V((0, 0, -1))
        tip = base + d * length + down * droop * length
        mid = base + d * length * 0.42 + down * droop * length * 0.2
        lft = mid + s * width * 0.5 - nrm * fold * width * 0.5
        rgt = mid - s * width * 0.5 - nrm * fold * width * 0.5
        b, l, r, t = self.v(base), self.v(lft), self.v(rgt), self.v(tip)
        if ribbed:
            m = self.v(mid + nrm * 0.02 * length)
            self.face([b, m, l], mat)
            self.face([m, t, l], mat)
            self.face([b, r, m], mat)
            self.face([m, r, t], mat)
        else:
            self.face([b, r, t], mat)
            self.face([b, t, l], mat)

    def flower(self, c, nrm, r, mat, petals=5, heart='flower_heart'):
        c, nrm = V(c), V(nrm).normalized()
        u = nrm.orthogonal().normalized()
        w = nrm.cross(u)
        ctr = self.v(c + nrm * r * 0.15)
        for k in range(petals):
            a0 = 2 * math.pi * k / petals
            a1 = a0 + math.pi / petals
            a2 = a0 + 2 * math.pi / petals
            p0 = self.v(c + (u * math.cos(a0) + w * math.sin(a0)) * r * 0.3)
            pa = self.v(c + (u * math.cos(a1 - 0.3) + w * math.sin(a1 - 0.3)) * r + nrm * r * 0.15)
            pb = self.v(c + (u * math.cos(a1 + 0.3) + w * math.sin(a1 + 0.3)) * r + nrm * r * 0.15)
            p2 = self.v(c + (u * math.cos(a2) + w * math.sin(a2)) * r * 0.3)
            self.face([ctr, p0, pa], mat)
            self.face([ctr, pa, pb], mat)
            self.face([ctr, pb, p2], mat)
        M = Matrix.Translation(c + nrm * r * 0.2) @ frame_to(nrm)
        res = bmesh.ops.create_cone(self.bm, cap_ends=False, segments=4, radius1=r * 0.3, radius2=0.0,
                                    depth=r * 0.25, matrix=M)
        self._tag(res['verts'], heart)

    def finish(self, name):
        separate_coplanar(self.bm)
        mesh = bpy.data.meshes.new(name)
        # Triangulate here (not in the exporter) so the output is byte-identical between runs.
        bmesh.ops.triangulate(self.bm, faces=self.bm.faces[:], quad_method='FIXED', ngon_method='EAR_CLIP')
        # bmesh primitive ops can order elements by memory address; sort for a stable element order.
        # (BMesh sort keys must be numbers, so sort in Python and pass the rank.)
        rank = {v: i for i, v in enumerate(sorted(self.bm.verts, key=lambda v: tuple(round(c, 5) for c in v.co)))}
        self.bm.verts.sort(key=lambda v: rank[v])
        self.bm.verts.index_update()
        rank = {f: i for i, f in enumerate(sorted(self.bm.faces, key=lambda f: (
            f.material_index, sorted(v.index for v in f.verts))))}
        self.bm.faces.sort(key=lambda f: rank[f])
        self.bm.normal_update()
        self.bm.to_mesh(mesh)
        self.bm.free()
        for m in self.mats:
            mesh.materials.append(bpy.data.materials[m])
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        return obj


def dir_ae(az, el):
    return V((math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)))


# ------------------------------------------------------------------------------------------- planters

PL_L, PL_W, PL_H = 2.4, 1.0, 0.7
ROWS = (-0.28, 0.0, 0.28)
SOIL_X = PL_L / 2 - 0.08
SOIL_Y = PL_W / 2 - 0.07


def soil_z(y):
    return 0.585 + 0.05 * (0.5 + 0.5 * math.cos(2 * math.pi * y / 0.28))


def planter_box(mb, rng):
    L, W, H = PL_L, PL_W, PL_H
    # Iron corner posts (also the feet).
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box((sx * (L / 2 - 0.04), sy * (W / 2 - 0.04), H / 2), (0.08, 0.08, H), 'iron')
    # Plank walls, three boards a side with thin gaps.
    for k in range(3):
        z = 0.06 + k * 0.2 + 0.095
        for sy in (-1, 1):
            mb.box((0, sy * (W / 2 - 0.035), z), (L - 0.14, 0.05, 0.19), rng.pick(['wood', 'wood', 'wood_dark']))
        for sx in (-1, 1):
            mb.box((sx * (L / 2 - 0.035), 0, z), (0.05, W - 0.14, 0.19), rng.pick(['wood', 'wood_dark']))
    # Top cap rail.
    for sy in (-1, 1):
        mb.box((0, sy * (W / 2 - 0.04), H - 0.02), (L + 0.02, 0.11, 0.04), 'wood_dark')
    for sx in (-1, 1):
        mb.box((sx * (L / 2 - 0.04), 0, H - 0.02), (0.11, W - 0.2, 0.04), 'wood_dark')
    # Riveted iron straps.
    for z in (0.16, 0.5):
        for sy in (-1, 1):
            mb.box((0, sy * (W / 2 - 0.004), z), (L - 0.1, 0.012, 0.05), 'iron')
            for k in range(8):
                x = -L / 2 + 0.2 + k * (L - 0.4) / 7
                mb.rivet((x, sy * (W / 2 + 0.002), z), (0, sy, 0))
        for sx in (-1, 1):
            mb.box((sx * (L / 2 - 0.004), 0, z), (0.012, W - 0.1, 0.05), 'iron')
    # Brass corner brackets on the front.
    for sx in (-1, 1):
        x = sx * (L / 2 - 0.09)
        mb.box((x, -W / 2 - 0.006, H - 0.12), (0.14, 0.008, 0.16), 'brass')
        for dz in (-0.05, 0.04):
            mb.rivet((x - 0.04 * sx, -W / 2 - 0.01, H - 0.12 + dz), (0, -1, 0), 0.011)
            mb.rivet((x + 0.03 * sx, -W / 2 - 0.01, H - 0.12 + dz), (0, -1, 0), 0.011)
    # Brass name plate, front centre.
    mb.box((0, -W / 2 - 0.006, 0.36), (0.26, 0.008, 0.08), 'brass')


def planter_soil(mb, rng):
    xs = [lerp(-SOIL_X, SOIL_X, i / 6) for i in range(7)]
    ys = [lerp(-SOIL_Y, SOIL_Y, j / 12) for j in range(13)]
    grid = []
    for i, x in enumerate(xs):
        col = []
        for j, y in enumerate(ys):
            edge = i in (0, 6) or j in (0, 12)
            z = soil_z(y) + (0 if edge else rng(-0.008, 0.008))
            col.append(mb.v((x, y, z)))
        grid.append(col)
    for i in range(6):
        for j in range(12):
            # Furrows (between rows) in the darker, wetter tone; ridges lighter.
            y = (ys[j] + ys[j + 1]) / 2
            mat = 'soil' if soil_z(y) < 0.61 else 'soil_light'
            mb.face([grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]], mat)
    # A few clods on the ridges.
    for _ in range(6):
        x = rng(-1.0, 1.0)
        y = rng.pick(ROWS) + rng(-0.05, 0.05)
        mb.ico((x, y, soil_z(y) + 0.005), rng(0.02, 0.035), 'soil_light', scale=(1, 1, 0.6), jitter=0.2, rng=rng)


def planter_irrigation(mb):
    """Copper feed pipe with valve + gauge on the left end, header across, drip lines along each ridge."""
    xf = -PL_L / 2 - 0.05
    mb.tube([(xf, 0.3, 0.03), (xf, 0.3, 0.72), (xf + 0.02, 0.3, 0.77), (xf + 0.08, 0.3, 0.79),
             (-SOIL_X + 0.06, 0.3, 0.77), (-SOIL_X + 0.1, 0.3, 0.72), (-SOIL_X + 0.1, 0.3, 0.66)],
            0.022, 'verdigris', seg=6)
    mb.cyl((xf, 0.3, 0.0), (xf, 0.3, 0.05), 0.04, 'brass', seg=6)  # floor flange
    mb.cyl((xf, 0.3, 0.38), (xf, 0.3, 0.42), 0.032, 'copper', seg=6)  # coupling
    # Valve: stem out to the front, handwheel.
    mb.cyl((xf, 0.3, 0.52), (xf, 0.22, 0.52), 0.035, 'brass', seg=6)
    mb.tube([(xf + 0.075 * math.cos(a), 0.2, 0.52 + 0.075 * math.sin(a)) for a in
             (2 * math.pi * k / 8 for k in range(8))], 0.012, 'fruit_red', seg=4, closed=True, fixed_n=(0, 1, 0))
    mb.box((xf, 0.2, 0.52), (0.15, 0.015, 0.015), 'fruit_red')
    mb.box((xf, 0.2, 0.52), (0.015, 0.015, 0.15), 'fruit_red')
    # Pressure gauge on the side of the feed pipe.
    mb.cyl((xf - 0.02, 0.3, 0.27), (xf - 0.06, 0.3, 0.27), 0.06, 'brass', seg=10)
    mb.cyl((xf - 0.06, 0.3, 0.27), (xf - 0.065, 0.3, 0.27), 0.05, 'paper', seg=10)
    mb.box((xf - 0.068, 0.29, 0.285), (0.004, 0.006, 0.05), 'iron', rot=(0.6, 0, 0))
    # Header across the rows, drip lines along the ridges with brass emitters.
    x0 = -SOIL_X + 0.1
    mb.tube([(x0, 0.3, 0.66), (x0, -0.3, 0.66)], 0.02, 'verdigris', seg=6)
    for y in ROWS:
        z = soil_z(y) + 0.015
        mb.cyl((x0, y, z), (SOIL_X - 0.06, y, z), 0.009, 'copper', seg=4)
        for k in range(4):
            x = x0 + 0.3 + k * 0.55
            mb.cyl((x, y, z - 0.01), (x, y, z + 0.022), 0.014, 'brass', seg=4)
        mb.cyl((SOIL_X - 0.06, y, z), (SOIL_X - 0.04, y, z), 0.014, 'brass', seg=4)


def seedling(mb, p, rng, s=1.0):
    h = rng(0.05, 0.08) * s
    top = V(p) + V((0, 0, h))
    mb.cyl(p, top, 0.005 * s, 'stem', seg=3, caps=False)
    az = rng(0, math.pi)
    for k in range(2):
        a = az + k * math.pi
        mb.leaf(top, dir_ae(a, 0.35), UP, 0.055 * s, 0.035 * s, 'leaf_young', droop=0.15)
    if rng() < 0.6:
        mb.leaf(top, dir_ae(az + 1.57, 1.1), UP, 0.05 * s, 0.03 * s, 'leaf_b')


def foliage(mb, c, r, mat, rng, leaves=10, scale=(1, 1, 0.9), leaf_mats=('leaf_a', 'leaf_b', 'leaf_young'),
            below=-0.3):
    """Leaf mass: a lumpy low-poly core with leaf cards sticking out of its surface."""
    c = V(c)
    mb.ico(c, r, mat, scale=scale, jitter=0.22, rng=rng)
    golden = math.pi * (3 - math.sqrt(5))
    a0 = rng(0, 6.28)
    for i in range(leaves):
        z = lerp(1.0, below, (i + 0.5) / leaves)
        rr = math.sqrt(max(0.0, 1 - z * z))
        n = V((math.cos(a0 + i * golden) * rr, math.sin(a0 + i * golden) * rr, z))
        p = c + V((n.x * r * scale[0], n.y * r * scale[1], n.z * r * scale[2])) * 0.85
        d = (n + V((rng(-0.4, 0.4), rng(-0.4, 0.4), 0.1))).normalized()
        mb.leaf(p, d, n + UP * 0.6, r * rng(0.75, 1.0), r * 0.55, rng.pick(leaf_mats), droop=0.3)


def lettuce(mb, c, rng, s=1.0):
    """Leafy head: a lumpy core with big ruffled leaves splayed around it."""
    c = V(c)
    mb.ico(c + V((0, 0, 0.07 * s)), 0.11 * s, 'leaf_young', scale=(1, 1, 0.75), jitter=0.15, rng=rng)
    az0 = rng(0, 6.28)
    mats = ('leaf_b', 'leaf_a', 'leaf_young')
    for k in range(7):
        a = az0 + k * 2 * math.pi / 7
        mb.leaf(c + dir_ae(a, 0) * 0.04 * s, dir_ae(a, rng(0.35, 0.65)), UP, rng(0.2, 0.25) * s, 0.17 * s,
                mats[k % 3], droop=0.3, fold=0.15, ribbed=True)


def herb_bush(mb, c, rng, mat='leaf_a', h=0.35):
    """Bushy herb: two leaf masses on a short stem."""
    c = V(c)
    mb.cyl(c, c + V((0, 0, h * 0.4)), 0.012, 'stem', seg=3, caps=False)
    foliage(mb, c + V((0, 0, h * 0.45)), h * 0.45, mat, rng, leaves=10, scale=(1.15, 1.15, 0.8))
    foliage(mb, c + V((h * 0.2, -h * 0.12, h * 0.8)), h * 0.3, 'leaf_b', rng, leaves=6)


def tomato(mb, c, rng, h=0.55):
    """Staked fruiting plant: stem, leaf masses and red fruit."""
    c = V(c)
    stake_top = c + V((0.05, 0.04, h + 0.03))
    mb.box_between(c + V((0.05, 0.04, -0.05)), stake_top, 0.022, 0.022, 'wood')
    mb.tube([c, c + V((0.01, 0.0, h * 0.5)), c + V((0.02, 0.01, h * 0.9))], 0.012, 'stem', seg=4, caps=False)
    foliage(mb, c + V((0.0, -0.02, h * 0.42)), 0.19, 'leaf_a', rng, leaves=11, scale=(1.1, 1.0, 1.0),
            leaf_mats=('leaf_a', 'leaf_b', 'leaf_c'))
    foliage(mb, c + V((0.02, 0.0, h * 0.8)), 0.12, 'leaf_c', rng, leaves=7, leaf_mats=('leaf_a', 'leaf_b', 'leaf_young'))
    for k in range(4):
        a = k * 1.4 + rng(-0.3, 0.3) - 2.6
        p = c + V((math.cos(a) * 0.17, math.sin(a) * 0.15, h * (0.25 + 0.14 * k)))
        mb.ico(p, rng(0.038, 0.048), 'fruit_red', sub=1)


def flower_stalk(mb, c, rng, mat, h):
    c = V(c)
    top = c + V((rng(-0.03, 0.03), rng(-0.03, 0.03), h))
    mb.cyl(c, top, 0.005, 'stem', seg=3, caps=False)
    mb.leaf(c.lerp(top, 0.4), dir_ae(rng(0, 6.28), 0.4), UP, 0.07, 0.04, 'leaf_b', droop=0.2)
    mb.flower(top, V((rng(-0.3, 0.3), -0.3, 1)), 0.06, mat)


def squash_vine(mb, start, rng, drop=0.55, flowers=1):
    """Trails forward over the front rim and hangs down the planks."""
    s = V(start)
    ry = -PL_W / 2 - 0.06
    pts = [s, s + V((0.05, -0.15, 0.04)), V((s.x + 0.1, ry + 0.07, PL_H + 0.04)), V((s.x + 0.12, ry, PL_H)),
           V((s.x + 0.14, ry - 0.02, PL_H - drop * 0.5)), V((s.x + 0.12, ry - 0.01, PL_H - drop))]
    mb.tube(pts, 0.011, 'stem', seg=4, r_end=0.006, caps=False)
    for k in range(1, len(pts)):
        p = pts[k - 1].lerp(pts[k], 0.6)
        side = 1 if k % 2 else -1
        if p.z > PL_H:
            mb.leaf(p, V((side * 0.6, -0.4, 0.5)), UP, 0.26, 0.22, 'leaf_a', droop=0.2, ribbed=True)
            mb.leaf(p, V((-side * 0.6, -0.2, 0.4)), UP, 0.22, 0.18, 'leaf_b', droop=0.25, ribbed=True)
        else:
            mb.leaf(p, V((side * 0.8, -0.3, -0.5)), V((0, -1, 0.1)), 0.22, 0.2,
                    rng.pick(['leaf_a', 'leaf_b']), ribbed=True)
            mb.leaf(p, V((-side * 0.7, -0.4, -0.2)), V((0, -1, 0.1)), 0.18, 0.16, 'leaf_young', ribbed=True)
    for k in range(flowers):
        p = pts[2 + k] + V((0.02, -0.04, 0.03))
        mb.flower(p, V((0.2, -0.6, 0.8)), 0.05, 'flower_yellow')


def build_planter(name, stage, seed):
    rng = Rng(seed)
    mb = MB()
    planter_box(mb, rng)
    planter_soil(mb, rng)
    planter_irrigation(mb)
    if stage == 'sprouts':
        for y in ROWS:
            for k in range(10):
                x = -0.85 + k * 0.205 + rng(-0.02, 0.02)
                yy = y + rng(-0.02, 0.02)
                seedling(mb, (x, yy, soil_z(yy) - 0.005), rng, s=rng(0.9, 1.4))
        # Row markers: little stakes with paper tags.
        for y in ROWS:
            mb.box((1.0, y, soil_z(y) + 0.08), (0.015, 0.015, 0.2), 'wood')
            mb.box((1.0, y - 0.01, soil_z(y) + 0.15), (0.07, 0.004, 0.045), 'paper')
    elif stage == 'grown':
        yb, ym, yf = ROWS[2], ROWS[1], ROWS[0]
        for x in (-0.85, -0.3, 0.25, 0.8):
            tomato(mb, (x + rng(-0.04, 0.04), yb, soil_z(yb) - 0.01), rng, h=rng(0.47, 0.55))
        for k, x in enumerate((-0.85, -0.42, 0.0, 0.42, 0.85)):
            if k % 2 == 0:
                herb_bush(mb, (x, ym, soil_z(ym) - 0.01), rng, mat=rng.pick(['leaf_a', 'leaf_c']), h=rng(0.34, 0.4))
            else:
                flower_stalk(mb, (x - 0.06, ym + 0.03, soil_z(ym)), rng, 'flower_violet', 0.36)
                flower_stalk(mb, (x + 0.07, ym + 0.05, soil_z(ym)), rng, 'flower_red', 0.28)
                flower_stalk(mb, (x + 0.0, ym - 0.06, soil_z(ym)), rng, 'flower_yellow', 0.22)
        for x in (-0.9, -0.45, 0.0, 0.45, 0.9):
            lettuce(mb, (x + rng(-0.03, 0.03), yf - 0.02, soil_z(yf) - 0.005), rng, s=rng(1.15, 1.3))
        squash_vine(mb, (-0.68, yf + 0.04, soil_z(yf)), rng, drop=0.5)
        squash_vine(mb, (0.22, yf + 0.04, soil_z(yf)), rng, drop=0.35)
    return mb.finish(name)


# ------------------------------------------------------------------------------------------- tree pot

def build_tree_pot(name='tree_pot', seed=21):
    rng = Rng(seed)
    mb = MB()
    seg = 16
    prof = [(0.0, 0.05), (0.33, 0.05), (0.35, 0.08), (0.42, 0.55), (0.45, 0.6), (0.45, 0.68), (0.4, 0.68),
            (0.39, 0.62), (0.0, 0.62, 'soil')]
    mb.lathe(prof, 'clay', seg=seg, smooth=True)
    for z0, z1, r in ((0.13, 0.2, 0.358), (0.47, 0.54, 0.41)):
        mb.band((0, 0, 0), r, z0, z1, 'brass', seg=seg, t=0.015, rivets=8)
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        p = V((math.cos(a) * 0.3, math.sin(a) * 0.3, 0))
        mb.box(p + V((0, 0, 0.03)), (0.1, 0.1, 0.06), 'iron', rot=(0, 0, a))
    for _ in range(5):
        a, r = rng(0, 6.28), rng(0.12, 0.33)
        mb.ico((math.cos(a) * r, math.sin(a) * r, 0.625), rng(0.025, 0.04), rng.pick(['clay_dark', 'soil_light']),
               scale=(1, 1, 0.6), jitter=0.2, rng=rng)

    # Trunk with a gentle S-curve, three main branches.
    trunk = [V((0, 0, 0.6)), V((0.02, 0.0, 0.9)), V((0.0, 0.02, 1.2)), V((-0.03, 0.02, 1.45)), V((-0.02, 0.0, 1.62))]
    mb.tube(trunk, 0.06, 'bark', seg=6, r_end=0.035)
    mb.cyl((0, 0, 0.6), (0, 0, 0.68), 0.09, 'bark', r1=0.06, seg=6, caps=False)
    crown_c = V((0.0, 0.0, 2.0))
    branch_tips = []
    for k, (az, el, z) in enumerate(((0.3, 0.6, 1.35), (2.4, 0.7, 1.45), (4.3, 0.5, 1.5), (1.4, 1.0, 1.55))):
        base = V((-0.02, 0.01, z))
        tip = base + dir_ae(az, el) * 0.5
        mid = base.lerp(tip, 0.5) + V((0, 0, 0.06))
        mb.tube([base, mid, tip], 0.03, 'bark', seg=5, r_end=0.012)
        branch_tips.append(tip)

    # Crown: lumpy leaf masses, covered with leaf cards to break up the silhouette.
    blobs = [(V((0.0, 0.0, 2.08)), 0.5), (V((0.38, -0.1, 1.95)), 0.38), (V((-0.38, 0.12, 1.98)), 0.4),
             (V((0.05, -0.38, 1.9)), 0.36), (V((-0.08, 0.38, 2.0)), 0.36), (V((0.12, 0.08, 2.3)), 0.32),
             (V((-0.3, -0.25, 2.25)), 0.3), (V((0.3, 0.28, 2.25)), 0.3)]
    for i, (c, r) in enumerate(blobs):
        mb.ico(c, r, ('leaf_a', 'leaf_c', 'leaf_a', 'leaf_b')[i % 4], scale=(1, 1, 0.85), sub=2, jitter=0.12,
               rng=rng)
    golden = math.pi * (3 - math.sqrt(5))
    n_leaves = 230
    for i in range(n_leaves):
        bi = i % len(blobs)
        c, r = blobs[bi]
        # Fibonacci-ish directions, skipping the underside of the crown.
        zt = 1 - 2 * ((i // len(blobs)) + 0.5) / (n_leaves // len(blobs) + 1)
        zt = lerp(-0.45, 1.0, (zt + 1) / 2)
        az = i * golden * 3.1 + bi
        rr = math.sqrt(max(0.0, 1 - zt * zt))
        n = V((math.cos(az) * rr, math.sin(az) * rr, zt))
        p = c + V((n.x * r * 0.92, n.y * r * 0.92, n.z * r * 0.8))
        if p.z < 1.55:
            continue
        d = (n + V((rng(-0.5, 0.5), rng(-0.5, 0.5), rng(-0.3, 0.1)))).normalized()
        mb.leaf(p, d, n + UP * 0.5, rng(0.13, 0.18), rng(0.08, 0.11),
                rng.pick(['leaf_a', 'leaf_b', 'leaf_b', 'leaf_young', 'leaf_c']), droop=0.25)
    # A handful of small orange fruits hanging under the crown.
    for k in range(7):
        a = k * 0.9 + 0.3
        r = rng(0.35, 0.6)
        p = V((math.cos(a) * r, math.sin(a) * r, rng(1.62, 1.85)))
        mb.sphere(p, 0.045, 'fruit_orange', u=6, vv=4)
        mb.cyl(p + V((0, 0, 0.04)), p + V((0, 0, 0.09)), 0.004, 'stem', seg=3, caps=False)
    return mb.finish(name)


# ------------------------------------------------------------------------------------------- seed cabinet

def build_seed_cabinet(name='seed_cabinet', seed=31):
    rng = Rng(seed)
    mb = MB()
    Wd, D = 1.2, 0.5
    yb, yf = D / 2, -D / 2
    # Carcass.
    mb.box((0, 0, 0.04), (Wd - 0.04, D - 0.04, 0.08), 'wood_dark')  # plinth
    for sx in (-1, 1):
        mb.box((sx * (Wd / 2 - 0.025), 0, 0.9), (0.05, D, 1.64), 'wood')
    mb.box((0, yb - 0.01, 0.9), (Wd - 0.1, 0.02, 1.64), 'wood_dark')  # back panel
    mb.box((0, 0, 1.75), (Wd + 0.04, D + 0.02, 0.06), 'wood_dark')  # cornice
    mb.box((0, 0.01, 1.79), (Wd - 0.04, D - 0.04, 0.02), 'wood')
    mb.box((0, -D / 2 - 0.006, 1.75), (0.32, 0.008, 0.045), 'brass')  # name plate
    for sx in (-1, 1):  # brass corner guards
        mb.box((sx * (Wd / 2 + 0.003), yf + 0.03, 0.9), (0.012, 0.07, 1.64), 'brass')
        for z in (0.2, 0.6, 1.0, 1.4):
            mb.rivet((sx * (Wd / 2 + 0.009), yf + 0.03, z), (sx, 0, 0), 0.01)
    # Drawer bank: 5 columns x 6 rows.
    z0, z1 = 0.1, 1.02
    mb.box((0, yf + 0.04, (z0 + z1) / 2), (Wd - 0.1, 0.04, z1 - z0 + 0.02), 'wood_dark')
    cols, rows = 5, 6
    cw, rh = (Wd - 0.12) / cols, (z1 - z0) / rows
    for i in range(cols):
        for j in range(rows):
            x = -Wd / 2 + 0.06 + cw * (i + 0.5)
            z = z0 + rh * (j + 0.5)
            mb.box((x, yf + 0.012, z), (cw - 0.014, 0.024, rh - 0.014), rng.pick(['wood', 'wood', 'wood_dark']))
            mb.box((x, yf - 0.006, z - 0.03), (0.07, 0.016, 0.014), 'brass')  # pull
            lbl = mb.v((x - 0.045, yf - 0.0005, z + 0.01)), mb.v((x + 0.045, yf - 0.0005, z + 0.01)), \
                mb.v((x + 0.045, yf - 0.0005, z + 0.045)), mb.v((x - 0.045, yf - 0.0005, z + 0.045))
            mb.face(list(lbl), 'paper')
            # brass label frame: top + bottom slivers
            mb.box((x, yf - 0.002, z + 0.0085), (0.096, 0.004, 0.004), 'brass')
    # Counter ledge.
    mb.box((0, -0.01, 1.05), (Wd + 0.02, D + 0.04, 0.04), 'wood_dark')
    # Upper glass cabinet: shelves, jars, doors.
    mb.box((0, 0.0, 1.38), (Wd - 0.1, D - 0.06, 0.02), 'wood')
    jar_cols = ['seed_a', 'seed_b', 'seed_c', 'seed_d', 'leaf_b', 'seed_a', 'seed_d', 'seed_c', 'seed_b', 'flower_yellow']
    for j, zs in enumerate((1.07, 1.39)):
        for i in range(5):
            x = -0.44 + i * 0.22 + rng(-0.02, 0.02)
            y = rng(-0.04, 0.04)
            h = rng(0.17, 0.24)
            fill = h * rng(0.45, 0.8)
            r = rng(0.05, 0.065)
            mb.cyl((x, y, zs), (x, y, zs + fill), r * 0.9, jar_cols[(i + j * 5) % len(jar_cols)], seg=8)
            mb.cyl((x, y, zs), (x, y, zs + h), r, 'Glass', seg=8)
            mb.cyl((x, y, zs + h), (x, y, zs + h + 0.03), r * 1.05, rng.pick(['brass', 'verdigris']), seg=8)
    zc0, zc1 = 1.07, 1.72
    mb.box((0, yf + 0.02, zc1 - 0.015), (Wd - 0.06, 0.04, 0.03), 'wood_dark')
    for k, x0 in enumerate((-Wd / 2 + 0.05, 0.0)):
        dw = Wd / 2 - 0.05
        cx = x0 + dw / 2
        y = yf + 0.01
        mb.box((cx, y, zc0 + 0.015), (dw, 0.02, 0.03), 'brass')
        mb.box((cx, y, zc1 - 0.035), (dw, 0.02, 0.03), 'brass')
        mb.box((x0 + 0.015, y, (zc0 + zc1) / 2 - 0.01), (0.03, 0.02, zc1 - zc0 - 0.02), 'brass')
        mb.box((x0 + dw - 0.015, y, (zc0 + zc1) / 2 - 0.01), (0.03, 0.02, zc1 - zc0 - 0.02), 'brass')
        mb.box((cx, y, (zc0 + zc1) / 2 + 0.05), (dw - 0.03, 0.012, 0.012), 'brass')  # muntin
        gx0, gx1, gz0, gz1 = cx - dw / 2 + 0.02, cx + dw / 2 - 0.02, zc0 + 0.025, zc1 - 0.045
        mb.face([mb.v((gx0, y, gz0)), mb.v((gx1, y, gz0)), mb.v((gx1, y, gz1)), mb.v((gx0, y, gz1))], 'Glass')
        kx = x0 + dw - 0.05 if k == 0 else x0 + 0.05
        mb.cyl((kx, y - 0.01, 1.38), (kx, y - 0.035, 1.38), 0.016, 'brass', seg=6)  # knob
    # Little picture lamp on a brass arm over the glass doors.
    mb.cyl((0, yf + 0.0, 1.72), (0, yf - 0.02, 1.72), 0.035, 'brass', seg=8)
    mb.tube([(0, yf - 0.01, 1.72), (0, yf - 0.05, 1.74), (0, yf - 0.08, 1.72)], 0.01, 'brass', seg=4)
    # Shade: half-cylinder trough open downward with the Emit bulb tube inside.
    pts = []
    for k in range(6):
        a = math.pi * k / 5
        pts.append((math.cos(a) * 0.05, math.sin(a) * 0.05))
    for x0, x1 in ((-0.17, 0.17),):
        for off, mat, flip in ((0.0, 'brass', False), (-0.004, 'brass_dark', True)):
            lo = [mb.v((x0, yf - 0.08 + py * (1 + off * 20), 1.69 + pz + off)) for py, pz in pts]
            hi = [mb.v((x1, yf - 0.08 + py * (1 + off * 20), 1.69 + pz + off)) for py, pz in pts]
            for k in range(5):
                q = [lo[k], hi[k], hi[k + 1], lo[k + 1]]
                mb.face(list(reversed(q)) if flip else q, mat)
    mb.cyl((-0.15, yf - 0.08, 1.695), (0.15, yf - 0.08, 1.695), 0.018, 'EmitLamp', seg=6)
    for sx in (-1, 1):
        mb.box((sx * 0.17, yf - 0.08, 1.71), (0.006, 0.1, 0.05), 'brass')
    return mb.finish(name)


# ------------------------------------------------------------------------------------------- cistern

def build_cistern(name='cistern', seed=41):
    rng = Rng(seed)
    mb = MB()
    bc = V((-0.25, 0.08, 0))
    seg = 16
    prof = [(0.0, 0.0), (0.44, 0.0), (0.49, 0.35), (0.5, 0.6), (0.49, 0.85), (0.44, 1.18), (0.4, 1.18)]
    mb.lathe(prof, 'wood', seg=seg, c=bc, col_mats=['wood', 'wood_dark'], phase=0.1)
    # Copper lid dome.
    mb.lathe([(0.4, 1.18), (0.46, 1.18), (0.46, 1.22), (0.38, 1.27), (0.2, 1.3), (0.0, 1.31)], 'verdigris',
             seg=seg, c=bc, phase=0.1)
    for z0, z1, r in ((0.08, 0.15, 0.455), (0.5, 0.58, 0.5), (0.95, 1.02, 0.478)):
        mb.band(bc, r, z0, z1, 'verdigris', seg=seg, t=0.014, rivets=8)
    # Level gauge on the front of the barrel: glass sight tube with brass fittings.
    gx, gy = bc.x - 0.12, bc.y - 0.5
    mb.cyl((gx, gy - 0.02, 0.2), (gx, gy - 0.02, 0.9), 0.02, 'Glass', seg=6)
    mb.cyl((gx, gy - 0.02, 0.2), (gx, gy - 0.02, 0.62), 0.014, 'water', seg=6)
    for z in (0.2, 0.9):
        mb.box((gx, gy - 0.005, z), (0.05, 0.05, 0.04), 'brass')
    # Brass tap low on the front-right.
    a = -0.6
    n = V((math.cos(a), math.sin(a), 0))
    tp = bc + n * 0.49 + V((0, 0, 0.3))
    mb.cyl(tp - n * 0.02, tp + n * 0.08, 0.025, 'brass', seg=6)
    mb.cyl(tp + n * 0.08, tp + n * 0.08 + V((0, 0, -0.06)), 0.02, 'brass', seg=6)
    mb.box(tp + n * 0.05 + V((0, 0, 0.045)), (0.08, 0.015, 0.012), 'brass', rot=(0, 0, a))

    # Hand pump on the lid.
    pc = bc + V((0.12, -0.08, 1.3))
    mb.cyl(pc + V((0, 0, -0.02)), pc + V((0, 0, 0.04)), 0.12, 'iron', seg=8)
    for k in range(6):
        aa = k * math.pi / 3
        mb.rivet(pc + V((math.cos(aa) * 0.095, math.sin(aa) * 0.095, 0.04)), UP, 0.01)
    mb.cyl(pc + V((0, 0, 0.04)), pc + V((0, 0, 0.4)), 0.065, 'iron', seg=8)
    mb.cyl(pc + V((0, 0, 0.14)), pc + V((0, 0, 0.18)), 0.075, 'brass', seg=8)
    mb.cyl(pc + V((0, 0, 0.4)), pc + V((0, 0, 0.45)), 0.08, 'brass', seg=8, r1=0.05)
    # Spout toward the bucket stool (front-right).
    sd = V((math.cos(-0.6), math.sin(-0.6), 0))
    stool = V((pc.x, pc.y, 0)) + sd * 0.55
    s0 = pc + V((0, 0, 0.3))
    mb.tube([s0, s0 + sd * 0.22 + V((0, 0, 0.02)), s0 + sd * 0.45, s0 + sd * 0.54 + V((0, 0, -0.08)),
             s0 + sd * 0.56 + V((0, 0, -0.16))], 0.03, 'verdigris', seg=6, r_end=0.024)
    # Lever: pivot bracket on top, handle sweeping up and back, brass knob.
    pv = pc + V((0, 0, 0.5))
    mb.box(pv - V((0, 0, 0.04)), (0.04, 0.05, 0.1), 'iron')
    mb.cyl(pv + V((-0.03, 0, 0)), pv + V((0.03, 0, 0)), 0.018, 'brass', seg=6)
    hd = V((-sd.x, -sd.y, 0.3)).normalized()
    hend = pv + hd * 0.5
    mb.tube([pv - hd * 0.12, pv, pv + hd * 0.3, hend], 0.017, 'iron', seg=5)
    mb.sphere(hend, 0.035, 'brass', u=6, vv=4)
    mb.box_between(pv - hd * 0.1, pc + V((-0.0, 0, 0.4)) - hd * 0.1, 0.02, 0.02, 'iron')  # plunger link

    # Stool with a bucket under the spout.
    st = V((stool.x, stool.y, 0))
    mb.cyl(st + V((0, 0, 0.42)), st + V((0, 0, 0.46)), 0.2, 'wood_dark', seg=8)
    for k in range(3):
        aa = k * 2 * math.pi / 3 + 0.4
        foot = st + V((math.cos(aa) * 0.17, math.sin(aa) * 0.17, 0))
        mb.box_between(foot, st + V((math.cos(aa) * 0.12, math.sin(aa) * 0.12, 0.42)), 0.035, 0.035, 'wood')
    bk = st + V((0, 0, 0.46))
    mb.lathe([(0.0, 0.0), (0.12, 0.0), (0.155, 0.26), (0.145, 0.26), (0.11, 0.02), (0.0, 0.02)], 'iron', seg=10,
             c=bk)
    mb.lathe([(0.0, 0.18), (0.136, 0.18)], 'water', seg=10, c=bk)
    mb.band(bk, 0.15, 0.2, 0.235, 'verdigris', seg=10, t=0.008)
    mb.band(bk, 0.126, 0.03, 0.06, 'verdigris', seg=10, t=0.008)
    handle = [bk + V((math.cos(t) * 0.155, 0, 0.25 + math.sin(t) * 0.14)) for t in
              (math.pi * k / 6 for k in range(7))]
    mb.tube(handle, 0.007, 'iron', seg=4)

    # Watering can on the floor, right side, spout toward the front.
    wc = V((0.6, 0.25, 0))
    mb.lathe([(0.0, 0.0), (0.12, 0.0), (0.125, 0.04), (0.12, 0.24), (0.06, 0.28), (0.04, 0.28), (0.0, 0.29)],
             'copper', seg=10, c=wc)
    mb.band(wc, 0.12, 0.18, 0.21, 'brass', seg=10, t=0.008)
    sp0 = wc + V((-0.02, -0.11, 0.06))
    sp1 = wc + V((-0.08, -0.38, 0.3))
    mb.cyl(sp0, sp1, 0.025, 'copper', r1=0.013, seg=6)
    mb.cyl(sp1, sp1 + (sp1 - sp0).normalized() * 0.05, 0.016, 'brass', r1=0.04, seg=8)
    mb.tube([wc + V((0.02, 0.11, 0.08)), wc + V((0.04, 0.2, 0.2)), wc + V((0.03, 0.12, 0.34)),
             wc + V((0.0, 0.0, 0.32)), wc + V((-0.01, -0.05, 0.28))], 0.012, 'copper', seg=4)
    return mb.finish(name)


# ------------------------------------------------------------------------------------------- grow lamp

def chain(mb, p0, p1, link=0.07, r=0.008, mat='iron'):
    p0, p1 = V(p0), V(p1)
    d = p1 - p0
    n = max(1, int(d.length / (link * 0.72)))
    t = d.normalized()
    side = t.orthogonal().normalized()
    for k in range(n):
        c = p0 + d * ((k + 0.5) / n)
        nrm = side if k % 2 else t.cross(side)
        # Each link: an oval loop in the plane spanned by t and the in-plane side vector.
        s = nrm.cross(t)
        pts = [c + t * math.cos(a) * link * 0.5 + s * math.sin(a) * link * 0.28 for a in
               (2 * math.pi * j / 6 for j in range(6))]
        mb.tube(pts, r, mat, seg=3, closed=True, fixed_n=nrm, smooth=False)


def build_grow_lamp(name='grow_lamp', seed=51):
    mb = MB()
    # Ceiling rose and hook.
    mb.cyl((0, 0, 0), (0, 0, -0.025), 0.07, 'brass', seg=8)
    mb.cyl((0, 0, -0.025), (0, 0, -0.06), 0.02, 'brass', seg=6)
    chain(mb, (0, 0, -0.06), (0, 0, -0.95))
    # Spreader yoke and two short chains down to the hood lugs.
    mb.sphere((0, 0, -0.97), 0.03, 'brass', u=6, vv=4)
    mb.tube([(-0.55, 0, -0.98), (0, 0, -0.97), (0.55, 0, -0.98)], 0.016, 'iron', seg=5)
    for sx in (-1, 1):
        mb.sphere((sx * 0.56, 0, -0.98), 0.025, 'brass', u=6, vv=4)
        chain(mb, (sx * 0.56, 0, -1.0), (sx * 0.7, 0, -1.19))
    # Reflector hood: a brass trough 2 m along X, polished brass inside.
    out = [(-0.2, -0.17), (-0.18, -0.08), (-0.11, -0.01), (0.11, -0.01), (0.18, -0.08), (0.2, -0.17)]
    inn = [(-0.185, -0.17), (-0.165, -0.085), (-0.1, -0.03), (0.1, -0.03), (0.165, -0.085), (0.185, -0.17)]
    z0 = -1.2
    X = 1.0
    prof = out + list(reversed(inn))
    mats = ['brass'] * 5 + ['brass_dark'] + ['copper'] * 5 + ['brass_dark']
    lo = [mb.v((-X, y, z0 + z)) for y, z in prof]
    hi = [mb.v((X, y, z0 + z)) for y, z in prof]
    m = len(prof)
    for k in range(m):
        j = (k + 1) % m
        mb.face([lo[j], lo[k], hi[k], hi[j]], mats[k])
    for sx in (-1, 1):  # end plates
        pts = [(sx * (X + 0.005), y, z0 + z) for y, z in out]
        vv = [mb.v(p) for p in pts]
        mb.face(vv if sx > 0 else list(reversed(vv)), 'brass_dark')
        vv2 = [mb.v((p[0] - sx * 0.01, p[1], p[2])) for p in pts]
        mb.face(list(reversed(vv2)) if sx > 0 else vv2, 'brass_dark')
    # Ridge seam and riveted ribs.
    mb.box((0, 0, z0 - 0.005), (2.04, 0.06, 0.012), 'brass_dark')
    for k in range(5):
        x = -0.9 + k * 0.45
        mb.tube([(x, -0.205, z0 - 0.17), (x, -0.185, z0 - 0.08), (x, -0.115, z0 - 0.005), (x, 0.115, z0 - 0.005),
                 (x, 0.185, z0 - 0.08), (x, 0.205, z0 - 0.17)], 0.008, 'brass_dark', seg=4, smooth=False)
    for sx in (-1, 1):
        mb.rivet((sx * 0.9, -0.04, z0 + 0.003), UP, 0.012)
        mb.rivet((sx * 0.9, 0.04, z0 + 0.003), UP, 0.012)
        mb.box((sx * 0.7, 0, z0 + 0.01), (0.04, 0.012, 0.04), 'iron')  # lug
    # Ballast box with a little gauge on top.
    mb.box((0.25, 0, z0 + 0.04), (0.3, 0.1, 0.08), 'iron')
    mb.cyl((0.25, -0.05, z0 + 0.04), (0.25, -0.065, z0 + 0.04), 0.03, 'brass', seg=8)
    mb.cyl((0.25, -0.065, z0 + 0.04), (0.25, -0.068, z0 + 0.04), 0.024, 'paper', seg=8)
    mb.tube([(0.1, 0, z0 + 0.06), (0.0, 0, z0 + 0.1), (0.0, 0.02, -0.97)], 0.008, 'verdigris', seg=4)
    # Emit tubes with brass sockets.
    for y in (-0.075, 0.075):
        mb.cyl((-0.93, y, z0 - 0.1), (0.93, y, z0 - 0.1), 0.024, 'EmitGrow', seg=6)
        for sx in (-1, 1):
            mb.cyl((sx * 0.93, y, z0 - 0.1), (sx * 0.99, y, z0 - 0.1), 0.032, 'brass', seg=6)
    return mb.finish(name)


# ------------------------------------------------------------------------------------------- vine trellis

def build_vine_trellis(name='vine_trellis', seed=61):
    rng = Rng(seed)
    mb = MB()
    W = 2.0
    yb = 0.16  # flat back
    yl = 0.12  # lattice plane
    # Planter trough.
    mb.box((0, -0.04, 0.17), (W - 0.04, 0.32, 0.3), 'wood')
    mb.box((0, -0.04, 0.33), (W, 0.36, 0.04), 'wood_dark')
    for sx in (-1, 1):
        mb.box((sx * (W / 2 - 0.03), -0.04, 0.165), (0.05, 0.34, 0.33), 'iron')
    for z in (0.1, 0.24):
        mb.box((0, -0.205, z), (W - 0.1, 0.01, 0.04), 'iron')
        for k in range(7):
            mb.rivet((-0.85 + k * 0.283, -0.21, z), (0, -1, 0), 0.011)
    mb.box((0, -0.04, 0.34), (W - 0.12, 0.28, 0.02), 'soil')
    # Posts and arched top.
    zt = 2.3
    for sx in (-1, 1):
        mb.box((sx * 0.97, yl, zt / 2), (0.05, 0.05, zt), 'iron')
        mb.sphere((sx * 0.97, yl, zt + 0.03), 0.04, 'brass', u=6, vv=4)
    arch = [(x, yl, zt + 0.27 * math.cos(x / 0.97 * math.pi / 2)) for x in (lerp(-0.97, 0.97, k / 10) for k in range(11))]
    mb.tube(arch, 0.02, 'iron', seg=5)
    mb.box((0, yl, zt), (1.94, 0.03, 0.03), 'iron')
    mb.sphere((0, yl, 2.57), 0.045, 'brass', u=6, vv=4)
    mb.cyl((0, yl, 2.57), (0, yl, 2.6), 0.02, 'brass', seg=6, r1=0.0)
    for z in (0.4, 1.35):
        mb.box((0, yl, z), (1.94, 0.025, 0.025), 'iron')
    # Diamond lattice of thin bars between z 0.4 and zt.
    xa, xb, za, zb = -0.95, 0.95, 0.4, zt
    sp = 0.38
    for sgn in (1, -1):
        for k in range(-8, 9):
            # Line: z = za + sgn*(x - xa) + k*sp, clipped to the box.
            pts = []
            for x in (xa, xb):
                z = za + sgn * (x - xa) + k * sp
                if za <= z <= zb:
                    pts.append(V((x, yl, z)))
            for z in (za, zb):
                x = xa + (z - za - k * sp) * sgn
                if xa <= x <= xb:
                    pts.append(V((x, yl, z)))
            uniq = []
            for p in pts:
                if all((p - q).length > 1e-4 for q in uniq):
                    uniq.append(p)
            if len(uniq) == 2 and (uniq[0] - uniq[1]).length > 0.05:
                mb.box_between(uniq[0], uniq[1], 0.014, 0.014, 'iron')
    for x, z in ((-0.57, 0.97), (0.19, 0.97), (-0.19, 1.73), (0.57, 1.73)):
        mb.cyl((x, yl - 0.012, z), (x, yl - 0.022, z), 0.035, 'brass', seg=8)

    # Climbing vines: wavy stems up the lattice with alternating leaves.
    vines = [(-0.75, 2.25), (-0.25, 1.9), (0.3, 2.45), (0.78, 1.7)]
    fruit_spots = []
    for vi, (x0, top) in enumerate(vines):
        pts = []
        n = 12
        for k in range(n + 1):
            t = k / n
            z = lerp(0.34, top, t)
            x = x0 + 0.13 * math.sin(t * 7 + vi) + 0.1 * t * (1 if vi % 2 else -1)
            y = lerp(-0.03, yl - 0.03, min(1, t * 4))
            pts.append(V((x, y, z)))
        mb.tube(pts, 0.014, 'stem', seg=4, r_end=0.006, caps=False)
        for k in range(1, n + 1):
            for half in (0.3, 0.8):
                p = pts[k - 1].lerp(pts[k], half)
                side = 1 if (k * 2 + (half > 0.5)) % 2 else -1
                d = V((side * rng(0.6, 1.0), -0.25, rng(-0.5, 0.2)))
                mb.leaf(p, d, V((0, -1, 0.3)), rng(0.14, 0.2), rng(0.12, 0.16),
                        rng.pick(['leaf_a', 'leaf_b', 'leaf_b', 'leaf_c', 'leaf_young']), droop=0.15,
                        ribbed=half > 0.5)
            if k in (4, 7, 10) and pts[k].z < top - 0.1:
                fruit_spots.append(pts[k])
        # Curly tendril tip.
        tip = pts[-1]
        mb.tube([tip, tip + V((0.04, -0.01, 0.06)), tip + V((0.08, -0.01, 0.04)), tip + V((0.07, -0.01, 0.0))],
                0.004, 'stem', seg=3, caps=False)
        mb.leaf(tip, V((0.2, -0.3, 1)), V((0, -1, 0)), 0.09, 0.07, 'leaf_young')
    # Hanging fruit: purple grape bunches and orange-red gourds alternately.
    for i, p in enumerate(fruit_spots):
        hang = p + V((0.04, -0.05, -0.04))
        if i % 2 == 0:
            mb.cyl(p, hang, 0.004, 'stem', seg=3, caps=False)
            for k, (dx, dz) in enumerate(((0, 0), (-0.03, -0.03), (0.03, -0.03), (0, -0.06), (-0.025, -0.09),
                                          (0.025, -0.09), (0, -0.12), (0.0, -0.035))):
                mb.ico(hang + V((dx, -0.015 * (k % 2), dz - 0.02)), 0.022, 'fruit_purple', sub=1)
        else:
            mb.cyl(p, hang, 0.004, 'stem', seg=3, caps=False)
            mb.sphere(hang + V((0, 0, -0.07)), 0.055, rng.pick(['fruit_orange', 'fruit_red']), u=8, vv=5,
                      scale=(0.85, 0.85, 1.25))
    # Flowers peeking out.
    for k in range(5):
        vi = k % len(vines)
        x0, top = vines[vi]
        z = lerp(0.6, top - 0.2, (k * 0.37) % 1)
        mb.flower((x0 + rng(-0.15, 0.15), -0.02, z), (0, -1, 0.3), 0.04, rng.pick(['flower_yellow', 'flower_violet']))
    return mb.finish(name)


# ------------------------------------------------------------------------------------------- potting bench

def clay_pot(mb, c, r, h, mat='clay', seg=8, soil=True, inverted=False):
    c = V(c)
    if inverted:
        prof = [(0.0, h), (r * 0.72, h), (r * 0.75, h * 0.05), (r * 1.06, h * 0.03), (r * 1.06, 0.0)]
        # Flip: build upright profile mirrored about mid height.
        prof = [(0.0, h + 0.0), (r * 0.72, h), (r * 0.9, h * 0.25), (r * 1.06, h * 0.22), (r * 1.06, 0.0),
                (r * 0.95, 0.0)]
        mb.lathe(list(reversed([(p[0], h - (h - p[1])) for p in prof])), mat, seg=seg, c=c)
        return
    prof = [(0.0, 0.0), (r * 0.72, 0.0), (r * 0.92, h * 0.78), (r * 1.06, h * 0.8), (r * 1.06, h), (r * 0.93, h),
            (r * 0.88, h * 0.82)]
    if soil:
        prof.append((0.0, h * 0.82, 'soil'))
    else:
        prof.append((r * 0.7, h * 0.1))
        prof.append((0.0, h * 0.1))
    mb.lathe(prof, mat, seg=seg, c=c)


def build_potting_bench(name='potting_bench', seed=71):
    rng = Rng(seed)
    mb = MB()
    L, D, H = 1.8, 0.7, 0.9
    yb = D / 2
    # Legs and frame.
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box((sx * (L / 2 - 0.05), sy * (D / 2 - 0.05), (H - 0.04) / 2), (0.05, 0.05, H - 0.04), 'iron')
        mb.box((sx * (L / 2 - 0.05), 0, 0.2), (0.04, D - 0.1, 0.04), 'iron')
    mb.box_between((-L / 2 + 0.05, -D / 2 + 0.05, 0.22), (L / 2 - 0.05, -D / 2 + 0.05, 0.22), 0.03, 0.03, 'iron')
    # Top planks.
    for k in range(5):
        y = -D / 2 + 0.07 + k * 0.14
        mb.box((0, y, H - 0.02), (L, 0.13, 0.04), rng.pick(['wood', 'wood', 'wood_dark']))
    mb.box((0, -D / 2 + 0.01, H - 0.07), (L - 0.04, 0.02, 0.07), 'wood_dark')  # apron
    # Lower shelf.
    for k in range(4):
        y = -D / 2 + 0.1 + k * 0.165
        mb.box((0, y, 0.25), (L - 0.12, 0.15, 0.03), rng.pick(['wood', 'wood_dark']))
    # Back board with tool rail.
    mb.box((0, yb - 0.015, H + 0.3), (L, 0.03, 0.6), 'wood')
    mb.box((0, yb - 0.035, H + 0.58), (L + 0.04, 0.03, 0.05), 'wood_dark')
    for sx in (-1, 1):
        mb.box((sx * (L / 2 - 0.02), yb - 0.04, H + 0.3), (0.03, 0.02, 0.6), 'iron')
    mb.box((0, yb - 0.04, H + 0.42), (L - 0.2, 0.012, 0.025), 'brass')
    for k in range(6):
        mb.rivet((-0.75 + k * 0.3, yb - 0.046, H + 0.42), (0, -1, 0), 0.01)

    def trowel(p, d, nrm, mat='brass'):
        p, d = V(p), V(d).normalized()
        nrm = V(nrm).normalized()
        s = d.cross(nrm)
        mb.cyl(p, p + d * 0.12, 0.016, 'wood_dark', seg=6)
        mb.cyl(p + d * 0.12, p + d * 0.16, 0.008, 'iron', seg=4)
        b0 = p + d * 0.16
        pts = [b0 + s * 0.05, b0 + d * 0.12 + s * 0.045, b0 + d * 0.2, b0 + d * 0.12 - s * 0.045, b0 - s * 0.05]
        ctr = mb.v(b0 + d * 0.08 + nrm * 0.012)
        vs = [mb.v(q) for q in pts]
        for i in range(4):
            mb.face([ctr, vs[i], vs[i + 1]], mat)
        mb.face([vs[4], vs[0], ctr], mat)
        vb = [mb.v(q - nrm * 0.003) for q in pts]
        mb.face(list(reversed(vb)), 'iron')

    def fork(p, d, nrm):
        p, d = V(p), V(d).normalized()
        s = d.cross(V(nrm)).normalized()
        mb.cyl(p, p + d * 0.12, 0.016, 'wood', seg=6)
        b0 = p + d * 0.13
        mb.box_between(b0 - s * 0.04, b0 + s * 0.04, 0.01, 0.01, 'iron')
        for k in (-1, 0, 1):
            mb.cyl(b0 + s * 0.035 * k, b0 + s * 0.035 * k + d * 0.13, 0.005, 'iron', seg=3)

    # Hanging tools on the back rail.
    for x in (-0.55, -0.35):
        mb.cyl((x, yb - 0.04, H + 0.47), (x, yb - 0.08, H + 0.47), 0.006, 'brass', seg=4)
    trowel((-0.55, yb - 0.06, H + 0.47), (0, 0, -1), (0, -1, 0))
    fork((-0.35, yb - 0.06, H + 0.47), (0, 0, -1), (0, -1, 0))
    mb.cyl((0.6, yb - 0.04, H + 0.47), (0.6, yb - 0.08, H + 0.47), 0.006, 'brass', seg=4)
    mb.tube([(0.6 + 0.09 * math.cos(a), yb - 0.07, H + 0.38 + 0.09 * math.sin(a)) for a in
             (2 * math.pi * k / 8 for k in range(8))], 0.014, 'verdigris', seg=4, closed=True, fixed_n=(0, 1, 0))
    mb.tube([(0.6 + 0.07 * math.cos(a), yb - 0.075, H + 0.38 + 0.08 * math.sin(a)) for a in
             (2 * math.pi * k / 8 + 0.3 for k in range(8))], 0.012, 'verdigris', seg=4, closed=True, fixed_n=(0, 1, 0))

    # On top: stack of clay pots (left), seedling trays (middle), seed bag (right), trowel.
    for k in range(4):
        clay_pot(mb, (-0.72, 0.1, H + k * 0.045), 0.1, 0.16, soil=False, seg=10)
    clay_pot(mb, (-0.5, -0.12, H), 0.08, 0.13, seg=8, inverted=True)
    clay_pot(mb, (-0.5, -0.12, H + 0.13), 0.065, 0.1, seg=8, inverted=True, mat='clay_dark')
    for t, (tx, ty) in enumerate(((-0.12, 0.05), (0.32, -0.02))):
        mb.box((tx, ty, H + 0.03), (0.42, 0.28, 0.06), 'wood_dark')
        mb.box((tx, ty, H + 0.058), (0.39, 0.25, 0.01), 'soil')
        for i in range(5):
            for j in range(3):
                p = V((tx - 0.156 + i * 0.078, ty - 0.08 + j * 0.08, H + 0.06))
                if t == 1 and (i + j) % 4 == 0:
                    continue
                s = 1.0 if t == 0 else 0.65
                top = p + V((0, 0, 0.04 * s))
                az = rng(0, 3)
                mb.leaf(top, dir_ae(az, 0.4), UP, 0.05 * s, 0.035 * s, 'leaf_young', droop=0.1)
                mb.leaf(top, dir_ae(az + math.pi, 0.4), UP, 0.05 * s, 0.035 * s, 'leaf_b', droop=0.1)
                mb.cyl(p, top, 0.004, 'stem', seg=3, caps=False)
    trowel((0.1, -0.27, H + 0.02), (-0.3, -0.05, 0), (0, 0, 1), mat='brass')
    # Burlap seed bag, rolled open, full of seeds.
    bc = V((0.7, 0.1, H))
    mb.lathe([(0.0, 0.0), (0.12, 0.0), (0.15, 0.08), (0.14, 0.22), (0.16, 0.25), (0.17, 0.27), (0.13, 0.27),
              (0.125, 0.2), (0.0, 0.21, 'seed_a')], 'burlap', seg=9, c=bc, squash=0.85)
    for _ in range(6):
        a, r = rng(0, 6.28), rng(0.0, 0.08)
        mb.ico(bc + V((math.cos(a) * r, math.sin(a) * r * 0.85, 0.215)), 0.018, 'seed_b', sub=1)
    mb.box((0.62, -0.25, H + 0.004), (0.06, 0.04, 0.008), 'seed_a', rot=(0, 0, 0.4))  # spilled seeds
    mb.box((0.6, -0.15, H + 0.03), (0.08, 0.004, 0.05), 'paper', rot=(0.3, 0, 0.2))  # seed packet

    # Lower shelf: lumpy sack of soil, two pots.
    sk = V((-0.4, -0.02, 0.265))
    mb.sphere(sk + V((0, 0, 0.14)), 0.2, 'burlap_dark', u=10, vv=6, scale=(1.5, 1.1, 0.75), jitter=0.08, rng=rng,
              smooth=True)
    mb.cyl(sk + V((0.28, 0, 0.12)), sk + V((0.38, 0, 0.18)), 0.05, 'burlap_dark', r1=0.03, seg=6)
    mb.tube([sk + V((0.33, -0.04, 0.12)), sk + V((0.33, 0, 0.18)), sk + V((0.33, 0.04, 0.12))], 0.008, 'copper',
            seg=3)
    mb.lathe([(0.0, 0.0), (0.12, 0.0), (0.08, 0.03, 'soil'), (0.0, 0.04, 'soil')], 'soil', seg=8,
             c=sk + V((0.0, -0.22, 0.0)))
    clay_pot(mb, (0.35, 0.0, 0.265), 0.12, 0.2, seg=10)
    herb_bush(mb, V((0.35, 0.0, 0.265 + 0.165)), rng, mat='leaf_b', h=0.2)
    clay_pot(mb, (0.65, -0.1, 0.265), 0.09, 0.14, seg=8, soil=False, mat='clay_dark')
    return mb.finish(name)


# ------------------------------------------------------------------------------------------- pot cluster

def cactus(mb, c, h, r, rng):
    c = V(c)
    ribs = 7
    seg = ribs * 2
    rings = []
    zs = [0.0, 0.25, 0.5, 0.75, 0.9, 0.97]
    scale = [1.0, 1.04, 1.02, 0.95, 0.75, 0.4]
    for z, s in zip(zs, scale):
        rings.append([mb.v(c + V((math.cos(a) * rr, math.sin(a) * rr, z * h)))
                      for a, rr in ((2 * math.pi * k / seg, r * s * (1.0 if k % 2 == 0 else 0.8)) for k in range(seg))])
    for i in range(len(rings) - 1):
        lo, hi = rings[i], rings[i + 1]
        for j in range(seg):
            k = (j + 1) % seg
            mb.face([lo[j], lo[k], hi[k], hi[j]], 'cactus')
    top = mb.v(c + V((0, 0, h)))
    for j in range(seg):
        mb.face([rings[-1][j], rings[-1][(j + 1) % seg], top], 'cactus')
    for sx, z, l in ((1, 0.45, 0.25), (-1, 0.6, 0.18)):
        p0 = c + V((sx * r * 0.8, 0, h * z))
        mb.tube([p0, p0 + V((sx * 0.08, 0, 0.0)), p0 + V((sx * 0.12, 0, 0.06)), p0 + V((sx * 0.12, 0, l))],
                r * 0.55, 'cactus', seg=6, r_end=r * 0.45, smooth=True)
    mb.flower(c + V((0, 0, h + 0.005)), UP, 0.06, 'flower_pink')
    mb.flower(c + V((0.21, 0, h * 0.6 + 0.0)) + V((0, 0, 0.0)), V((0.3, -0.2, 1)), 0.035, 'flower_pink')


def succulent(mb, c, rng, s=1.0):
    c = V(c)
    for ring, (n, el, ln) in enumerate(((8, 0.25, 0.11), (6, 0.6, 0.08), (4, 1.0, 0.05))):
        for k in range(n):
            a = k * 2 * math.pi / n + ring * 0.4
            mb.leaf(c + V((0, 0, 0.01 * ring)), dir_ae(a, el), UP, ln * s, ln * 0.6 * s,
                    ('cactus', 'leaf_b', 'leaf_young')[ring], fold=0.4)


def fern(mb, c, rng, n=12, l=0.45):
    c = V(c)
    for k in range(n):
        a = k * 2 * math.pi / n + rng(-0.2, 0.2)
        el = rng(0.6, 1.1)
        pts = [c]
        p = c
        pitch = el
        for i in range(4):
            p = p + dir_ae(a, pitch) * (l / 4)
            pts.append(p)
            pitch -= 0.35
        mb.tube(pts, 0.005, 'stem', seg=3, caps=False, smooth=False)
        for i in range(1, 5):
            for sgn in (1, -1):
                d = dir_ae(a + sgn * 1.2, pitch * 0.4)
                mb.leaf(pts[i - 1].lerp(pts[i], 0.5), d, UP, 0.1 * (1.2 - i * 0.15), 0.05, 'leaf_a' if (i + k) % 2 else 'leaf_b',
                        droop=0.25)


def build_pot_cluster(name='pot_cluster', seed=81):
    rng = Rng(seed)
    mb = MB()
    # 1: big brass pot with a fern.
    c1 = V((0.25, 0.3, 0))
    mb.lathe([(0.0, 0.0), (0.2, 0.0), (0.24, 0.05), (0.26, 0.36), (0.28, 0.4), (0.26, 0.4), (0.25, 0.37),
              (0.0, 0.36, 'soil')], 'brass', seg=12, c=c1)
    mb.band(c1, 0.248, 0.12, 0.16, 'verdigris', seg=12, t=0.01, rivets=6)
    mb.band(c1, 0.265, 0.3, 0.33, 'iron', seg=12, t=0.01, rivets=6)
    fern(mb, c1 + V((0, 0, 0.36)), rng)
    # 2: terracotta with a columnar cactus.
    c2 = V((-0.32, 0.22, 0))
    clay_pot(mb, c2, 0.19, 0.3, seg=10)
    cactus(mb, c2 + V((0, 0, 0.245)), 0.62, 0.08, rng)
    # 3: small pot with a succulent rosette.
    c3 = V((0.45, -0.3, 0))
    clay_pot(mb, c3, 0.12, 0.16, seg=8, mat='clay_dark')
    succulent(mb, c3 + V((0, 0, 0.13)), rng)
    # 4: tall pot with flowering plant.
    c4 = V((-0.05, -0.2, 0))
    clay_pot(mb, c4, 0.15, 0.36, seg=10)
    mb.band(c4, 0.15 * 0.95, 0.24, 0.27, 'brass', seg=10, t=0.008)
    cc = c4 + V((0, 0, 0.295))
    herb_bush(mb, cc, rng, mat='leaf_a', h=0.3)
    for k, mat in enumerate(('flower_red', 'flower_yellow', 'flower_red', 'flower_violet', 'flower_yellow')):
        a = k * 1.3
        p = cc + V((math.cos(a) * 0.09, math.sin(a) * 0.09, 0.28 + 0.04 * (k % 2)))
        mb.cyl(cc, p, 0.004, 'stem', seg=3, caps=False)
        mb.flower(p, V((math.cos(a) * 0.4, math.sin(a) * 0.4 - 0.2, 1)), 0.045, mat)
    # 5: tiny brass cup with a sprout.
    c5 = V((-0.5, -0.32, 0))
    mb.lathe([(0.0, 0.0), (0.07, 0.0), (0.09, 0.1), (0.1, 0.12), (0.085, 0.12), (0.0, 0.1, 'soil')], 'brass',
             seg=8, c=c5)
    seedling(mb, c5 + V((0, 0, 0.1)), rng, s=1.8)
    # 6: low wide bowl with round-leaf herbs.
    c6 = V((0.58, 0.12, 0))
    mb.lathe([(0.0, 0.0), (0.12, 0.0), (0.18, 0.1), (0.19, 0.12), (0.17, 0.12), (0.0, 0.1, 'soil')], 'clay', seg=10,
             c=c6)
    for k in range(3):
        a = k * 2.1
        lettuce(mb, c6 + V((math.cos(a) * 0.07, math.sin(a) * 0.07, 0.1)), rng, s=0.55)
    return mb.finish(name)


# ------------------------------------------------------------------------------------------- output

def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def game_bbox(obj):
    pts = [obj.matrix_world @ v.co for v in obj.data.vertices]
    xs = [p.x for p in pts]
    ys = [p.z for p in pts]
    zs = [-p.y for p in pts]
    return (min(xs), max(xs)), (min(ys), max(ys)), (min(zs), max(zs))


def export_glb(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                              export_apply=True, export_materials='EXPORT', export_normals=True,
                              export_texcoords=False)


DETAIL_SHOTS = {
    'planter_grown': [((0.6, -1.6, 1.6), (0.2, 0, 0.75), 35)],
    'planter_sprouts': [((0.3, -1.2, 1.4), (0, 0, 0.65), 35)],
    'seed_cabinet': [((0.4, -1.6, 1.5), (0, 0, 1.2), 35)],
    'cistern': [((0.8, -2.2, 1.4), (0, 0, 0.8), 35)],
    'potting_bench': [((0.3, -1.6, 1.6), (0, 0, 1.0), 35)],
    'grow_lamp': [((0.6, -1.5, -2.2), (0, 0, -1.3), 35)],
}


def render_preview(objs, path):
    scene = bpy.context.scene
    by = {o.name: o for o in objs}
    # Line-up in two rows.
    row1 = [('planter_empty', -6.0), ('planter_sprouts', -3.2), ('planter_grown', -0.4), ('tree_pot', 2.2),
            ('seed_cabinet', 4.0)]
    row2 = [('cistern', -5.5), ('grow_lamp', -3.0), ('vine_trellis', -0.4), ('potting_bench', 2.0),
            ('pot_cluster', 4.2)]
    for n, x in row1:
        by[n].location = (x, 0, 0)
    for n, x in row2:
        by[n].location = (x, 3.5, 2.6 if n == 'grow_lamp' else 0)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.15, depth=1.8, location=(6.0, 0, 0.9), vertices=12)
    ref = bpy.context.active_object
    refm = bpy.data.materials.new('ref')
    refm.diffuse_color = (0.8, 0.8, 0.85, 1)
    refm.use_nodes = True
    refm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.7, 0.7, 0.75, 1)
    ref.data.materials.append(refm)
    bpy.ops.mesh.primitive_plane_add(size=80, location=(0, 0, 0))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new('ground')
    gm.use_nodes = True
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.62, 0.32, 0.12, 1)
    ground.data.materials.append(gm)

    cam_data = bpy.data.cameras.new('cam')
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam

    sun_data = bpy.data.lights.new('sun', 'SUN')
    sun_data.energy = 3.5
    sun_data.color = (1.0, 0.85, 0.65)
    sun_data.angle = math.radians(3)
    sun = bpy.data.objects.new('sun', sun_data)
    sun.rotation_euler = (math.radians(50), 0, math.radians(-30))
    scene.collection.objects.link(sun)
    world = bpy.data.worlds.new('world')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.7, 0.55, 0.42, 1)
    bg.inputs['Strength'].default_value = 0.8
    scene.render.engine = 'BLENDER_EEVEE'
    scene.view_settings.view_transform = 'AgX'
    scene.render.resolution_x = 1800
    scene.render.resolution_y = 1000

    def look(loc, target, lens):
        cam.location = loc
        d = V(target) - V(loc)
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        cam_data.lens = lens

    def shot(p):
        scene.render.filepath = p
        bpy.ops.render.render(write_still=True)

    look((-0.5, -13, 4.2), (-0.5, 1.8, 0.9), 30)
    shot(path)
    scene.render.resolution_x = 1000
    scene.render.resolution_y = 800
    for o in objs:
        for other in objs:
            other.hide_render = other is not o
        ref.location = o.location + V((-1.4 if o.name != 'grow_lamp' else -1.5, 0.3, 0.9))
        ref.location.z = 0.9
        bb = [o.matrix_world @ V(b) for b in o.bound_box]
        lo = V((min(b.x for b in bb), min(b.y for b in bb), min(b.z for b in bb)))
        hi = V((max(b.x for b in bb), max(b.y for b in bb), max(b.z for b in bb)))
        ctr = (lo + hi) / 2
        size = max(hi.x - lo.x, hi.z - lo.z, 1.0)
        dist = size * 1.5 + 0.5
        look(ctr + V((dist * 0.4, -dist, dist * 0.3)), ctr, 35)
        shot(path.replace('.png', f'_{o.name}.png'))
        if o.name in DETAIL_SHOTS:
            for k, (off, tgt, lens) in enumerate(DETAIL_SHOTS[o.name]):
                look(o.location + V(off), o.location + V(tgt), lens)
                shot(path.replace('.png', f'_{o.name}_d{k}.png'))
    for other in objs:
        other.hide_render = False


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models', 'base', 'greenhouse.glb'))
    ap.add_argument('--preview', default=None)
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    make_materials()
    objs = [
        build_planter('planter_empty', 'empty', 1),
        build_planter('planter_sprouts', 'sprouts', 2),
        build_planter('planter_grown', 'grown', 3),
        build_tree_pot(),
        build_seed_cabinet(),
        build_cistern(),
        build_grow_lamp(),
        build_vine_trellis(),
        build_potting_bench(),
        build_pot_cluster(),
    ]
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    export_glb(objs, args.out)
    for o in objs:
        (x0, x1), (y0, y1), (z0, z1) = game_bbox(o)
        print(f'{o.name:16s} tris={tri_count(o):5d}  x[{x0:+.2f},{x1:+.2f}] y[{y0:+.2f},{y1:+.2f}] '
              f'z[{z0:+.2f},{z1:+.2f}]')
    print(f'wrote {args.out} ({os.path.getsize(args.out) / 1024:.1f} KiB)')
    if args.preview:
        render_preview(objs, os.path.abspath(args.preview))


main()
