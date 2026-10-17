"""Home-base main hall furniture: a cosy scavenger workshop / living room, exported as one glTF binary.

    blender -b --python tools/blender/base/hall.py                          # writes public/models/base/hall.glb
    blender -b --python tools/blender/base/hall.py -- --preview out.png     # also renders a line-up + close-ups

Top-level nodes (each at the world origin, origin at its base centre on the floor, front facing game +Z):
    workbench, shelf, stove, table, bunk, chandelier (origin at its top hook, hangs down), rug, chest, radio

Blender is Z-up and the front of every piece faces Blender -Y (= game +Z after the Y-up export).
Units are metres. Flat Principled colours only; glowing parts use materials named Emit*, glass is `Glass`.
Everything is built from a few bmesh primitives and a tiny LCG, so re-running gives identical output.
"""

import argparse
import math
import os
import sys
from contextlib import contextmanager

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

sys.dont_write_bytecode = True  # no __pycache__ next to the scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from coplanar import separate_coplanar  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
TAU = 2 * math.pi

# ---------------------------------------------------------------------------------------------------------
# Materials: name -> (sRGB hex, roughness, metallic, flags). Flags: 'ds' double-sided, 'emit' emissive.
MATS = {
    'brass': (0xa8844e, 0.45, 0.6, ''),
    'copper': (0x5f9c8a, 0.6, 0.3, ''),  # copper gone green with verdigris
    'copper_raw': (0xa8623a, 0.4, 0.7, ''),
    'iron': (0x3a3430, 0.7, 0.5, ''),
    'rust': (0x7a3d1e, 0.9, 0.2, ''),
    'steel': (0x8a8580, 0.4, 0.7, ''),
    'wood': (0x7a5a3a, 0.75, 0.0, ''),
    'wood_dark': (0x4e3826, 0.8, 0.0, ''),
    'wood_light': (0x9a7650, 0.75, 0.0, ''),
    'canvas': (0xd8c8a8, 0.95, 0.0, 'ds'),
    'canvas_dark': (0x8a7658, 0.95, 0.0, 'ds'),
    'paper': (0xe6d6b2, 0.9, 0.0, 'ds'),
    'ink': (0x3a2a20, 0.9, 0.0, 'ds'),
    'teal': (0x5d8a86, 0.8, 0.1, ''),
    'red': (0x9a4a32, 0.8, 0.1, ''),
    'bakelite': (0x241c18, 0.5, 0.0, ''),
    'dial': (0xece0c0, 0.6, 0.0, ''),
    'needle': (0xb02a1a, 0.6, 0.0, ''),
    'leaf': (0x5f9330, 0.8, 0.0, 'ds'),
    'leaf_young': (0x8fbf45, 0.8, 0.0, 'ds'),
    'soil': (0x3a2618, 1.0, 0.0, ''),
    'terracotta': (0xb0603a, 0.9, 0.0, ''),
    'jar_amber': (0xb87a2a, 0.5, 0.0, ''),
    'jar_green': (0x6a7a3a, 0.5, 0.0, ''),
    'jar_brown': (0x5a3a22, 0.6, 0.0, ''),
    'rug_red': (0x8e2f22, 1.0, 0.0, ''),
    'rug_ochre': (0xc08a3a, 1.0, 0.0, ''),
    'rug_brown': (0x4a2a1c, 1.0, 0.0, ''),
    'rug_cream': (0xd8c3a0, 1.0, 0.0, ''),
    'rug_orange': (0xb2582a, 1.0, 0.0, ''),
    'rug_teal': (0x4f7a76, 1.0, 0.0, ''),
    'patch_olive': (0x6b6a3a, 0.95, 0.0, 'ds'),
    'patch_plum': (0x6a3a4a, 0.95, 0.0, 'ds'),
    'patch_red': (0x9a4a32, 0.95, 0.0, 'ds'),
    'patch_teal': (0x5d8a86, 0.95, 0.0, 'ds'),
    'patch_ochre': (0xc08a3a, 0.95, 0.0, 'ds'),
    'patch_cream': (0xd8c8a8, 0.95, 0.0, 'ds'),
    'Glass': (0xcfe4e0, 0.05, 0.0, 'ds glass'),
    'EmitAmber': (0xffb35a, 0.5, 0.0, 'emit'),
    'EmitWarm': (0xffd08a, 0.5, 0.0, 'emit'),
}
EMIT_STRENGTH = 3.0


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgb(h):
    return [srgb_to_linear(((h >> s) & 0xFF) / 255) for s in (16, 8, 0)]


def make_materials():
    for name, (hx, rough, metal, flags) in MATS.items():
        mat = bpy.data.materials.new(name)
        rgb = hex_rgb(hx)
        mat.diffuse_color = (*rgb, 1)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get('Principled BSDF')
        bsdf.inputs['Base Color'].default_value = (*rgb, 1)
        bsdf.inputs['Roughness'].default_value = rough
        bsdf.inputs['Metallic'].default_value = metal
        if 'emit' in flags:
            bsdf.inputs['Emission Color'].default_value = (*rgb, 1)
            bsdf.inputs['Emission Strength'].default_value = EMIT_STRENGTH
        if 'glass' in flags:
            bsdf.inputs['Alpha'].default_value = 0.28
            mat.diffuse_color = (*rgb, 0.28)
            if hasattr(mat, 'surface_render_method'):
                mat.surface_render_method = 'BLENDED'
            else:
                mat.blend_method = 'BLEND'
        # The glTF exporter writes doubleSided = not use_backface_culling.
        mat.use_backface_culling = 'ds' not in flags


class Rng:
    """Tiny deterministic LCG so re-running the script gives identical models."""

    def __init__(self, seed):
        self.s = seed * 2654435761 % 2**32 or 1

    def __call__(self, a=0.0, b=1.0):
        self.s = (1664525 * self.s + 1013904223) % 2**32
        return a + (b - a) * self.s / 2**32

    def pick(self, seq):
        return seq[int(self(0, len(seq) - 0.001))]


def lod(n, r):
    """Fewer sides for thin things: they read the same at game distances."""
    if r < 0.011:
        return min(n, 3)
    if r < 0.02:
        return min(n, 4)
    if r < 0.045:
        return min(n, 6)
    if r < 0.09:
        return min(n, 8)
    return n


def frame(d):
    d = d.normalized()
    up = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
    u = d.cross(up).normalized()
    return u, d.cross(u), d


# ---------------------------------------------------------------------------------------------------------
class MB:
    """bmesh builder with a transform stack and per-face material names."""

    def __init__(self):
        self.bm = bmesh.new()
        self.mats = {}
        self.M = Matrix.Identity(4)

    def tris(self):
        return sum(len(f.verts) - 2 for f in self.bm.faces)

    def mark(self, label):
        """Debug: print the triangles added since the previous mark (HALL_DEBUG=1)."""
        if os.environ.get('HALL_DEBUG'):
            t = self.tris()
            print(f'    {label:24s} {t - getattr(self, "_last", 0):5d}')
            self._last = t

    def mi(self, name):
        if name not in self.mats:
            self.mats[name] = len(self.mats)
        return self.mats[name]

    @contextmanager
    def at(self, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
        old = self.M
        if isinstance(scale, (int, float)):
            scale = (scale, scale, scale)
        self.M = old @ Matrix.LocRotScale(Vector(loc), Euler(rot, 'XYZ'), Vector(scale))
        try:
            yield
        finally:
            self.M = old

    def v(self, p):
        return self.bm.verts.new(self.M @ Vector(p))

    def face(self, vs, mat, smooth=False):
        f = self.bm.faces.new(vs)
        f.material_index = self.mi(mat)
        f.smooth = smooth
        return f

    def quad(self, a, b, c, d, mat):
        return self.face([self.v(a), self.v(b), self.v(c), self.v(d)], mat)

    def tri(self, a, b, c, mat):
        return self.face([self.v(a), self.v(b), self.v(c)], mat)

    # -- primitives ------------------------------------------------------------------------------------
    def box(self, c, size, mat, rot=(0, 0, 0), bevel=0.0, mats=None):
        """Axis box centred at c (in the current frame, optionally rotated about its centre).
        mats: optional dict of per-side materials: keys bottom/top/front/back/left/right."""
        with self.at(c, rot):
            sx, sy, sz = (s / 2 for s in size)
            p = [self.v((x, y, z)) for (x, y, z) in [
                (-sx, -sy, -sz), (sx, -sy, -sz), (sx, sy, -sz), (-sx, sy, -sz),
                (-sx, -sy, sz), (sx, -sy, sz), (sx, sy, sz), (-sx, sy, sz)]]
        sides = {'bottom': [0, 3, 2, 1], 'top': [4, 5, 6, 7], 'front': [0, 1, 5, 4],
                 'back': [2, 3, 7, 6], 'left': [3, 0, 4, 7], 'right': [1, 2, 6, 5]}
        faces = [self.face([p[i] for i in idx], (mats or {}).get(k, mat)) for k, idx in sides.items()]
        if bevel > 0:
            edges = list({e for f in faces for e in f.edges})
            res = bmesh.ops.bevel(self.bm, geom=p + edges, offset=bevel, offset_type='OFFSET', segments=1,
                                  profile=0.5, affect='EDGES', clamp_overlap=True)
            for f in res['faces']:  # bevel faces otherwise get material slot 0
                f.material_index = self.mi(mat)
                f.smooth = False
            closed = [f for f in faces if f.is_valid] + list(res['faces'])
            bmesh.ops.recalc_face_normals(self.bm, faces=closed)
        return faces

    def bar(self, p0, p1, w, h, mat, up=(0, 0, 1)):
        """Rectangular beam from p0 to p1 (w across, h along `up`)."""
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        L = d.length
        x = d.normalized()
        upv = Vector(up)
        if abs(x.dot(upv)) > 0.95:
            upv = Vector((0, 1, 0)) if abs(x.y) < 0.9 else Vector((1, 0, 0))
        y = upv.cross(x).normalized()
        z = x.cross(y)
        R = Matrix((x, y, z)).transposed().to_4x4()
        old = self.M
        self.M = old @ Matrix.Translation((p0 + p1) / 2) @ R
        try:
            self.box((0, 0, 0), (L, w, h), mat)
        finally:
            self.M = old

    def ring(self, c, u, v, r, n, phase=0.0):
        return [self.v(c + (u * math.cos(a) + v * math.sin(a)) * r)
                for a in (phase + TAU * i / n for i in range(n))]

    def cyl(self, p0, p1, r0, mat, r1=None, n=8, caps=(True, True), smooth=False, cap_mat=None, phase=0.0):
        p0, p1 = Vector(p0), Vector(p1)
        r1 = r0 if r1 is None else r1
        n = lod(n, max(r0, r1))
        if max(r0, r1) < 0.011:
            caps = (False, False)
        u, v, d = frame(p1 - p0)
        a = self.ring(p0, u, v, r0, n, phase)
        b = self.ring(p1, u, v, r1, n, phase)
        for i in range(n):
            j = (i + 1) % n
            self.face([a[i], a[j], b[j], b[i]], mat, smooth)
        cm = cap_mat or mat
        if caps[0] and r0 > 0:
            ca = self.ring(p0, u, v, r0, n, phase) if smooth else a
            self.face(list(reversed(ca)), cm)
        if caps[1] and r1 > 0:
            cb = self.ring(p1, u, v, r1, n, phase) if smooth else b
            self.face(cb, cm)

    def cone(self, p0, p1, r0, mat, n=8, cap=True):
        """Cone from a base disc at p0 to a point at p1."""
        p0, p1 = Vector(p0), Vector(p1)
        u, v, d = frame(p1 - p0)
        a = self.ring(p0, u, v, r0, n)
        tip = self.v(p1)
        for i in range(n):
            self.face([a[i], a[(i + 1) % n], tip], mat)
        if cap:
            self.face(list(reversed(a)), mat)

    def lathe(self, prof, mats, n=12, smooth=False, phase=0.0):
        """Revolve [(r, z), ...] about the local Z axis. Profile runs bottom-centre -> out -> up -> top-centre
        for outward normals. mats: one name, or one per segment."""
        if isinstance(mats, str):
            mats = [mats] * (len(prof) - 1)
        rings = []
        for r, z in prof:
            if r <= 1e-6:
                rings.append(self.v((0, 0, z)))
            else:
                rings.append([self.v((math.cos(a) * r, math.sin(a) * r, z))
                              for a in (phase + TAU * i / n for i in range(n))])
        for k in range(len(prof) - 1):
            A, B, m = rings[k], rings[k + 1], mats[k]
            # flat (horizontal) segments are caps: shade them flat
            sm = smooth and abs(prof[k][1] - prof[k + 1][1]) > 1e-6
            for i in range(n):
                j = (i + 1) % n
                if isinstance(A, list) and isinstance(B, list):
                    self.face([A[i], A[j], B[j], B[i]], m, sm)
                elif isinstance(B, list):
                    self.face([A, B[j], B[i]], m, sm)
                elif isinstance(A, list):
                    self.face([A[i], A[j], B], m, sm)

    def sphere(self, c, r, mat, n=8, rings=5, scale=(1, 1, 1), smooth=True):
        n = lod(n, r * max(scale))
        rings = min(rings, 2 if r < 0.02 else 3 if r < 0.05 else rings)
        prof = [(r * math.sin(math.pi * k / rings), -r * math.cos(math.pi * k / rings)) for k in range(rings + 1)]
        with self.at(c, (0, 0, 0), scale):
            self.lathe(prof, mat, n, smooth)

    def torus(self, c, R, r, mat, n=12, m=5, rot=(0, 0, 0), arc=TAU, start=0.0, scale=(1, 1, 1), smooth=False):
        closed = arc >= TAU - 1e-6
        m = min(m, 3 if r < 0.012 else 4)
        n = min(n, max(6, int(R * TAU / 0.04)))
        cnt = n if closed else n + 1
        with self.at(c, rot, scale):
            grid = []
            for i in range(cnt):
                a = start + arc * i / n
                ca, sa = math.cos(a), math.sin(a)
                grid.append([self.v(((R + r * math.cos(b)) * ca, (R + r * math.cos(b)) * sa, r * math.sin(b)))
                             for b in (TAU * k / m for k in range(m))])
        for i in range(n):
            i2 = (i + 1) % cnt
            for k in range(m):
                k2 = (k + 1) % m
                self.face([grid[i][k], grid[i2][k], grid[i2][k2], grid[i][k2]], mat, smooth)

    def tube(self, pts, r, mat, n=6, caps=True, smooth=False):
        pts = [Vector(p) for p in pts]
        n = lod(n, r)
        caps = caps and r >= 0.011
        tans = []
        for i in range(len(pts)):
            a = pts[max(0, i - 1)]
            b = pts[min(len(pts) - 1, i + 1)]
            tans.append((b - a).normalized())
        u, _, _ = frame(tans[0])
        rings = []
        for p, t in zip(pts, tans):
            u = (u - t * u.dot(t)).normalized()
            v = t.cross(u)
            rings.append(self.ring(p, u, v, r, n))
        for A, B in zip(rings, rings[1:]):
            for i in range(n):
                j = (i + 1) % n
                self.face([A[i], A[j], B[j], B[i]], mat, smooth)
        if caps:
            self.face(list(reversed(rings[0])), mat)
            self.face(rings[-1], mat)

    def prism(self, poly, z0, z1, mat, side_mat=None):
        """Extrude a CCW 2D polygon (local XY) from z0 to z1."""
        a = [self.v((x, y, z0)) for x, y in poly]
        b = [self.v((x, y, z1)) for x, y in poly]
        n = len(poly)
        for i in range(n):
            j = (i + 1) % n
            self.face([a[i], a[j], b[j], b[i]], side_mat or mat)
        self.face(list(reversed(a)), mat)
        self.face(b, mat)

    def gear(self, c, r, teeth, thick, mat, rot=(0, 0, 0), hole=False):
        poly = []
        step = TAU / teeth
        for i in range(teeth):
            a = step * i
            poly.append((math.cos(a) * r * 0.8, math.sin(a) * r * 0.8))
            for da in (0.3, 0.6):
                poly.append((math.cos(a + da * step) * r, math.sin(a + da * step) * r))
        with self.at(c, rot):
            self.prism(poly, -thick / 2, thick / 2, mat)

    def leaf(self, base, direction, length, width, mat, droop=0.3):
        """A diamond leaf (two tris, double-sided material) from base along direction."""
        base = Vector(base)
        d = Vector(direction).normalized()
        side = d.cross(Vector((0, 0, 1)))
        if side.length < 1e-4:
            side = Vector((1, 0, 0))
        side.normalize()
        mid = base + d * length * 0.45 + Vector((0, 0, -droop * length * 0.2))
        tip = base + d * length + Vector((0, 0, -droop * length))
        l, r = mid + side * width / 2, mid - side * width / 2
        self.face([self.v(base), self.v(r), self.v(tip), self.v(l)], mat)

    def finish(self, name):
        separate_coplanar(self.bm)
        mesh = bpy.data.meshes.new(name)
        self.bm.normal_update()
        self.bm.to_mesh(mesh)
        self.bm.free()
        for m in sorted(self.mats, key=self.mats.get):
            mesh.materials.append(bpy.data.materials[m])
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        return obj


# ---------------------------------------------------------------------------------------------------------
# Small reusable props


def wrench(mb, c, rot, L=0.24, mat='steel'):
    with mb.at(c, rot):
        mb.box((0, 0, 0), (0.022, 0.008, L * 0.7), mat)
        mb.torus((0, 0, L * 0.4), 0.022, 0.008, mat, n=8, m=4, rot=(math.pi / 2, 0, 0))
        mb.torus((0, 0, -L * 0.42), 0.026, 0.009, mat, n=7, m=4, rot=(math.pi / 2, 0, 0), arc=TAU * 0.7,
                 start=-math.pi * 0.15)


def hammer(mb, c, rot, L=0.32):
    with mb.at(c, rot):
        mb.cyl((0, 0, -L / 2), (0, 0, L / 2), 0.014, 'wood_light', n=6)
        mb.box((0.02, 0, L / 2 + 0.01), (0.13, 0.03, 0.035), 'iron')


def screwdriver(mb, c, rot, handle='red', L=0.2):
    with mb.at(c, rot):
        mb.cyl((0, 0, 0), (0, 0, L * 0.45), 0.013, handle, n=6)
        mb.cyl((0, 0, L * 0.45), (0, 0, L), 0.004, 'steel', n=4)


def jar(mb, c, content, h=0.14, r=0.05, fill=0.7):
    x, y, z = c
    mb.cyl((x, y, z + 0.004), (x, y, z + 0.004 + h * fill), r * 0.88, content, n=6, caps=(False, True))
    mb.cyl((x, y, z), (x, y, z + h), r, 'Glass', n=6, caps=(False, False))
    mb.cyl((x, y, z + h), (x, y, z + h + 0.02), r * 1.04, 'brass', n=6, caps=(False, True))


def wire_coil(mb, c, R=0.07, r=0.02, mat='copper_raw', rot=(0, 0, 0)):
    mb.torus(c, R, r, mat, n=8, m=4, rot=rot)


def crate(mb, c, s, mat='wood', rot=(0, 0, 0), stripe=None):
    """Slatted crate of size s=(x, y, z), base at c."""
    sx, sy, sz = s
    with mb.at(c, rot):
        mb.box((0, 0, sz / 2), (sx, sy, sz), mat)
        t = 0.025
        for x in (-sx / 2 + t / 2, sx / 2 - t / 2):
            mb.box((x, 0, sz / 2), (t, sy + 0.01, sz + 0.01), 'wood_dark')
        mb.box((0, 0, sz - t / 2), (sx + 0.006, sy + 0.01, t), 'wood_dark')
        mb.box((0, 0, t / 2), (sx + 0.006, sy + 0.01, t), 'wood_dark')
        if stripe:
            mb.box((0, -sy / 2 - 0.002, sz * 0.5), (sx * 0.5, 0.004, sz * 0.18), stripe)


def potted_cutting(mb, c, rng, h=0.18, leaves=6, pot=0.07):
    x, y, z = c
    with mb.at((x, y, z)):
        mb.lathe([(0, 0), (pot * 0.7, 0), (pot, pot * 1.5), (pot * 1.1, pot * 1.5), (pot * 1.1, pot * 1.75),
                  (pot * 0.95, pot * 1.75), (pot * 0.95, pot * 1.55), (0, pot * 1.55)],
                 ['terracotta'] * 6 + ['soil'], n=7)
        top = pot * 1.55
        mb.cyl((0, 0, top), (0.01, 0.005, top + h), 0.006, 'leaf', n=4, caps=(False, True))
        for i in range(leaves):
            a = TAU * i / leaves * 1.618 + rng(-0.3, 0.3)
            hz = top + h * (0.3 + 0.7 * i / leaves)
            mb.leaf((0.005, 0, hz), (math.cos(a), math.sin(a), 0.5), h * rng(0.45, 0.7), h * 0.22,
                    'leaf_young' if i >= leaves - 2 else 'leaf', droop=0.25)


def gauge(mb, c, r, axis_rot=(math.pi / 2, 0, 0), needle_a=0.6):
    """Round dial gauge facing local -Z rotated by axis_rot (default: faces -Y)."""
    with mb.at(c, axis_rot):
        mb.cyl((0, 0, 0), (0, 0, 0.03), r, 'brass', n=12)
        mb.cyl((0, 0, 0.03), (0, 0, 0.032), r * 0.85, 'dial', n=12, caps=(False, True))
        mb.box((math.cos(needle_a) * r * 0.35, math.sin(needle_a) * r * 0.35, 0.034), (r * 0.7, 0.006, 0.003),
               'needle', rot=(0, 0, needle_a))
        mb.cyl((0, 0, 0.036), (0, 0, 0.038), r * 0.88, 'Glass', n=12, caps=(False, True))


def lantern(mb, c, s=1.0):
    with mb.at(c, (0, 0, 0), s):
        mb.cyl((0, 0, 0), (0, 0, 0.03), 0.07, 'brass', n=8)
        mb.cyl((0, 0, 0.03), (0, 0, 0.17), 0.055, 'Glass', n=8, caps=(False, False))
        mb.sphere((0, 0, 0.09), 0.025, 'EmitAmber', n=6, rings=4, scale=(1, 1, 1.6))
        for i in range(4):
            a = TAU * i / 4 + math.pi / 4
            mb.box((math.cos(a) * 0.06, math.sin(a) * 0.06, 0.1), (0.008, 0.008, 0.14), 'brass')
        mb.cyl((0, 0, 0.17), (0, 0, 0.19), 0.07, 'brass', n=8)
        mb.cone((0, 0, 0.19), (0, 0, 0.25), 0.055, 'brass', n=8, cap=False)
        mb.torus((0, 0, 0.27), 0.04, 0.006, 'iron', n=8, m=3, rot=(math.pi / 2, 0, 0), arc=math.pi)


# ---------------------------------------------------------------------------------------------------------
# 1. Workbench


def build_workbench():
    mb = MB()
    rng = Rng(11)
    W, D, H = 2.2, 0.9, 0.95
    # top: three thick planks
    for k, y in enumerate((-0.3, 0.0, 0.3)):
        mb.box((0, y, H - 0.04), (W, 0.296, 0.08), ('wood', 'wood_light', 'wood')[k])
    # iron legs, apron, stretchers
    for x in (-1.03, 1.03):
        for y in (-0.38, 0.38):
            mb.box((x, y, (H - 0.08) / 2), (0.07, 0.07, H - 0.08), 'iron')
            mb.box((x, y, 0.015), (0.11, 0.11, 0.03), 'rust')
        mb.box((x, 0, 0.2), (0.05, 0.72, 0.05), 'iron')
        mb.box((x, 0, H - 0.12), (0.05, 0.72, 0.07), 'iron')
    mb.box((0, -0.41, H - 0.12), (2.0, 0.03, 0.07), 'iron')
    for x in (-0.9, -0.3, 0.3, 0.9):  # rivets on the front apron
        mb.cyl((x, -0.425, H - 0.12), (x, -0.432, H - 0.12), 0.012, 'brass', n=6)
    for y in (-0.38, 0.38):
        mb.box((0, y, 0.2), (2.0, 0.05, 0.05), 'iron')
    mb.box((0, 0, 0.235), (2.0, 0.7, 0.025), 'wood_dark')
    # stuff on the lower shelf
    crate(mb, (-0.6, -0.02, 0.25), (0.5, 0.5, 0.3), 'wood_light', rot=(0, 0, 0.08), stripe='red')
    mb.cyl((0.1, 0.05, 0.25), (0.1, 0.05, 0.6), 0.12, 'rust', n=10)
    mb.cyl((0.1, 0.05, 0.6), (0.1, 0.05, 0.63), 0.125, 'iron', n=10)
    mb.torus((0.6, 0.0, 0.29), 0.15, 0.04, 'copper', n=12, m=5)

    # pegboard back panel with iron posts
    for x in (-1.07, 1.07):
        mb.box((x, 0.42, (H + 2.05) / 2 - 0.04), (0.06, 0.06, 2.05 - H + 0.08), 'iron')
        mb.sphere((x, 0.42, 2.07), 0.035, 'brass', n=6, rings=4)
    PY = 0.43  # board centre; front face at PY - 0.0125
    mb.box((0, PY, (H + 2.0) / 2), (2.08, 0.025, 2.0 - H), 'teal')
    mb.box((0, PY - 0.015, 2.0), (2.1, 0.03, 0.04), 'wood_dark')
    mb.box((0, PY - 0.015, H + 0.02), (2.1, 0.03, 0.04), 'wood_dark')
    fy = PY - 0.0135
    for i in range(13):
        for k in range(6):
            x = -0.9 + i * (1.8 / 12)
            z = H + 0.14 + k * 0.145
            s = 0.008
            mb.quad((x - s, fy, z - s), (x + s, fy, z - s), (x + s, fy, z + s), (x - s, fy, z + s), 'ink')
    # little top shelf with brackets
    mb.box((0, PY - 0.12, 1.86), (1.4, 0.2, 0.025), 'wood')
    for x in (-0.6, 0.6):
        mb.bar((x, PY - 0.02, 1.72), (x, PY - 0.2, 1.85), 0.02, 0.02, 'iron', up=(1, 0, 0))
    jar(mb, (-0.5, PY - 0.12, 1.873), 'jar_amber')
    jar(mb, (-0.37, PY - 0.13, 1.873), 'jar_green', h=0.11)
    jar(mb, (-0.25, PY - 0.11, 1.873), 'jar_brown', h=0.16)
    mb.box((0.05, PY - 0.12, 1.92), (0.22, 0.14, 0.1), 'red', bevel=0.005)
    potted_cutting(mb, (0.58, PY - 0.12, 1.873), rng, h=0.14, pot=0.05)

    # tools hanging on the board
    ty = fy - 0.012
    for x in (-0.82, -0.64):
        mb.cyl((x, fy, 1.72), (x, fy - 0.05, 1.72), 0.004, 'steel', n=4)
    wrench(mb, (-0.82, ty, 1.55), (0, 0, 0), 0.26)
    wrench(mb, (-0.64, ty, 1.58), (0, 0, 0), 0.2)
    hammer(mb, (-0.3, ty - 0.01, 1.45), (0, 0, 0))
    # saw: blade + handle
    with mb.at((0.1, ty - 0.004, 1.62), (math.pi / 2, 0, 0)):
        mb.prism([(-0.28, -0.05), (0.18, -0.06), (0.18, 0.05), (-0.28, -0.01)], -0.002, 0.002, 'steel')
        mb.box((0.24, 0.0, 0), (0.12, 0.1, 0.025), 'wood')
    for i, (col, x) in enumerate((('red', 0.44), ('teal', 0.51), ('wood_light', 0.58))):
        screwdriver(mb, (x, ty, 1.35 + i * 0.02), (math.pi, 0, 0), col, L=0.18 + 0.02 * i)
    mb.box((0.51, ty, 1.36), (0.26, 0.03, 0.02), 'iron')  # screwdriver rack
    wire_coil(mb, (0.82, ty - 0.03, 1.6), 0.1, 0.018, rot=(math.pi / 2, 0, 0))
    with mb.at((0.75, ty - 0.005, 1.3), (0, 0.3, 0)):  # pliers
        mb.box((0.02, 0, 0), (0.016, 0.01, 0.2), 'iron', rot=(0, 0.12, 0))
        mb.box((-0.02, 0, 0), (0.016, 0.01, 0.2), 'iron', rot=(0, -0.12, 0))
    gauge(mb, (-0.85, fy - 0.03, 1.17), 0.07, needle_a=2.2)
    mb.tube([(-0.85, fy, 1.1), (-0.85, fy - 0.02, 1.07), (-0.7, fy - 0.02, 1.06), (-0.6, fy, 1.0)], 0.01,
            'copper', n=5)

    # vice on the front-left corner (faded red body, steel jaws)
    with mb.at((-0.82, -0.35, H)):
        mb.box((0, 0.02, 0.025), (0.16, 0.2, 0.05), 'red')
        mb.box((0, 0.06, 0.11), (0.2, 0.06, 0.12), 'red')
        mb.box((0, -0.06, 0.1), (0.2, 0.05, 0.1), 'red')
        mb.box((0, 0.028, 0.155), (0.2, 0.012, 0.03), 'steel')
        mb.box((0, -0.03, 0.135), (0.2, 0.012, 0.03), 'steel')
        mb.cyl((0, -0.08, 0.08), (0, -0.2, 0.08), 0.014, 'steel', n=6)
        mb.cyl((-0.11, -0.2, 0.08), (0.11, -0.2, 0.08), 0.009, 'steel', n=5)
        for x in (-0.11, 0.11):
            mb.sphere((x, -0.2, 0.08), 0.016, 'iron', n=6, rings=3)
        mb.box((0.0, 0.0, 0.135), (0.08, 0.04, 0.02), 'brass')  # brass piece clamped in

    # scattered tools on top
    wrench(mb, (-0.45, -0.25, H + 0.005), (math.pi / 2, 0, 1.2), 0.22)
    screwdriver(mb, (-0.3, -0.12, H + 0.014), (0, math.pi / 2, 0.4), 'teal')
    hammer(mb, (0.8, -0.28, H + 0.016), (0, math.pi / 2, -0.3))
    for i in range(3):
        x, y = rng(-0.25, 0.35), rng(-0.32, 0.1)
        mb.cyl((x, y, H), (x, y, H + 0.01), 0.012, 'steel', n=6)  # nuts

    # disassembled gadget: open brass casing, gears, a spring, a tube, loose panel
    with mb.at((0.15, -0.05, H), (0, 0, -0.15)):
        t = 0.008
        mb.box((0, 0, t / 2), (0.3, 0.22, t), 'brass')
        for x in (-0.15, 0.15):
            mb.box((x, 0, 0.06), (t, 0.22, 0.12), 'brass')
        mb.box((0, 0.11, 0.06), (0.3, t, 0.12), 'brass')
        mb.gear((-0.05, 0.02, 0.06), 0.06, 8, 0.012, 'brass', rot=(math.pi / 2, 0, 0))
        mb.gear((0.06, 0.03, 0.04), 0.04, 6, 0.012, 'copper_raw', rot=(math.pi / 2, 0, 0))
        mb.cyl((-0.05, -0.08, 0.06), (-0.05, 0.1, 0.06), 0.005, 'steel', n=4)
        mb.cyl((0.09, -0.04, t), (0.09, -0.04, t + 0.012), 0.015, 'bakelite', n=6)
        mb.cyl((0.09, -0.04, t + 0.012), (0.09, -0.04, t + 0.08), 0.014, 'Glass', n=6)
        mb.cyl((0.09, -0.04, t + 0.02), (0.09, -0.04, t + 0.06), 0.006, 'steel', n=4)
        mb.tube([(-0.12, -0.07, t), (-0.06, -0.12, 0.03), (0.02, -0.08, 0.05), (0.05, 0.0, 0.03)], 0.004,
                'needle', n=3)
    mb.box((0.48, -0.15, H + 0.004), (0.3, 0.22, 0.008), 'brass', rot=(0, 0, 0.35))  # casing lid
    mb.gear((0.36, -0.32, H + 0.006), 0.035, 8, 0.012, 'brass')

    # magnifier lamp: clamp base at back right, two arm segments, shade with bulb and lens
    base = Vector((0.82, 0.25, H))
    j1 = Vector((0.78, 0.18, H + 0.45))
    j2 = Vector((0.62, -0.08, H + 0.5))
    head = Vector((0.58, -0.14, H + 0.36))
    mb.cyl(base, base + Vector((0, 0, 0.04)), 0.06, 'iron', n=8)
    mb.cyl(base + Vector((0, 0, 0.04)), base + Vector((0, 0, 0.08)), 0.02, 'brass', n=6)
    mb.cyl(base + Vector((0, 0, 0.06)), j1, 0.012, 'brass', n=5)
    mb.cyl(base + Vector((0.025, 0, 0.06)), j1 + Vector((0.025, 0, 0)), 0.006, 'steel', n=4)
    mb.sphere(j1, 0.022, 'brass', n=6, rings=4)
    mb.cyl(j1, j2, 0.011, 'brass', n=5)
    mb.sphere(j2, 0.02, 'brass', n=6, rings=4)
    mb.cyl(j2, head + Vector((0, 0, 0.05)), 0.01, 'brass', n=5)
    with mb.at(head, (0.35, 0.15, 0)):
        mb.lathe([(0.05, 0.06), (0.04, 0.08), (0.0, 0.085)], 'brass', n=8)
        mb.cyl((0, 0, 0.06), (0, 0, -0.02), 0.05, 'brass', r1=0.11, n=10, caps=(False, False))
        mb.cyl((0, 0, -0.02), (0, 0, 0.06), 0.105, 'iron', r1=0.045, n=10, caps=(False, False))  # inside
        mb.sphere((0, 0, 0.02), 0.032, 'EmitWarm', n=6, rings=3)
        mb.torus((0, 0, -0.02), 0.11, 0.012, 'brass', n=10, m=3)
        mb.cyl((0, 0, -0.022), (0, 0, -0.018), 0.1, 'Glass', n=10, caps=(True, False))
    return mb.finish('workbench')


# ---------------------------------------------------------------------------------------------------------
# 2. Shelf


def build_shelf():
    mb = MB()
    rng = Rng(23)
    W, D, H = 1.6, 0.5, 2.4
    for x in (-W / 2 + 0.025, W / 2 - 0.025):
        for y in (-D / 2 + 0.025, D / 2 - 0.025):
            mb.box((x, y, H / 2), (0.05, 0.05, H), 'iron')
            mb.box((x, y, 0.01), (0.08, 0.08, 0.02), 'rust')
    levels = [0.12, 0.66, 1.2, 1.74, 2.28]
    for z in levels:
        mb.box((0, 0, z - 0.015), (W - 0.02, D - 0.02, 0.03), 'wood' if z != 1.2 else 'wood_light')
        mb.box((0, -D / 2 + 0.01, z - 0.04), (W - 0.1, 0.02, 0.03), 'iron')  # front lip
        for x in (-0.7, -0.25, 0.25, 0.7):
            mb.cyl((x, -D / 2 + 0.0, z - 0.04), (x, -D / 2 - 0.006, z - 0.04), 0.008, 'brass', n=4)
    # back + side X-bracing straps
    bx = D / 2 - 0.006
    mb.bar((-W / 2 + 0.05, bx, 0.1), (W / 2 - 0.05, bx, H - 0.1), 0.012, 0.035, 'iron', up=(0, 1, 0))
    mb.bar((W / 2 - 0.05, bx, 0.1), (-W / 2 + 0.05, bx, H - 0.1), 0.012, 0.035, 'iron', up=(0, 1, 0))
    for x in (-W / 2 + 0.006, W / 2 - 0.006):
        for z0, z1 in ((0.12, 1.2), (1.2, 2.28)):
            mb.bar((x, -D / 2 + 0.05, z0), (x, D / 2 - 0.05, z1), 0.012, 0.03, 'iron', up=(1, 0, 0))
    for x in (-W / 2 + 0.025, W / 2 - 0.025):
        mb.sphere((x, -D / 2 + 0.025, H + 0.02), 0.03, 'brass', n=6, rings=4)
        mb.sphere((x, D / 2 - 0.025, H + 0.02), 0.03, 'brass', n=6, rings=4)

    z = levels[0]  # bottom: crate, rusty canister, hose coil, big gear
    crate(mb, (-0.45, 0.0, z), (0.52, 0.4, 0.42), 'wood', stripe='teal')
    mb.cyl((0.1, 0.02, z), (0.1, 0.02, z + 0.4), 0.13, 'rust', n=10)
    mb.cyl((0.1, 0.02, z + 0.4), (0.1, 0.02, z + 0.43), 0.135, 'iron', n=10)
    mb.cyl((0.16, -0.05, z + 0.43), (0.16, -0.05, z + 0.47), 0.025, 'brass', n=6)
    mb.torus((0.5, 0.0, z + 0.07), 0.15, 0.07, 'copper', n=12, m=5, scale=(1, 1, 1.0))
    mb.gear((0.5, 0.15, z + 0.2), 0.17, 9, 0.04, 'rust', rot=(math.pi / 2 - 0.2, 0, 0))

    z = levels[1]  # jars, boxes, wire coils
    crate(mb, (-0.55, 0.02, z), (0.34, 0.36, 0.26), 'wood_light', rot=(0, 0, -0.05))
    mb.box((-0.55, 0.0, z + 0.32), (0.26, 0.3, 0.12), 'canvas_dark', rot=(0, 0, 0.1), bevel=0.01)
    for i, c in enumerate(('jar_amber', 'jar_green', 'jar_brown', 'jar_amber')):
        jar(mb, (-0.2 + i * 0.13, -0.1 + rng(-0.03, 0.03), z), c, h=rng(0.12, 0.2), r=rng(0.045, 0.055))
    wire_coil(mb, (0.5, 0.0, z + 0.02), 0.09, 0.025)
    wire_coil(mb, (0.5, 0.0, z + 0.08), 0.08, 0.022, mat='needle')
    mb.cyl((0.3, 0.12, z), (0.3, 0.12, z + 0.25), 0.05, 'steel', n=8)  # tin
    mb.cyl((0.3, 0.12, z + 0.25), (0.3, 0.12, z + 0.27), 0.052, 'red', n=8)

    z = levels[2]  # potted cuttings, books, salvaged gauge, a vacuum tube
    potted_cutting(mb, (-0.55, -0.05, z), rng, h=0.26, leaves=7, pot=0.08)
    potted_cutting(mb, (-0.3, -0.08, z), rng, h=0.18, leaves=5, pot=0.065)
    for i, (c, h) in enumerate((('red', 0.28), ('teal', 0.25), ('canvas_dark', 0.3), ('wood_dark', 0.26),
                                 ('rug_ochre', 0.24))):
        mb.box((-0.05 + i * 0.05, 0.08, z + h / 2), (0.045, 0.22, h), c)
    mb.box((0.25, 0.1, z + 0.12), (0.045, 0.22, 0.25), 'red', rot=(0, 0.35, 0))
    with mb.at((0.48, 0.05, z)):
        mb.box((0, 0.05, 0.1), (0.24, 0.12, 0.2), 'iron')
        gauge(mb, (0, -0.01, 0.1), 0.08, needle_a=0.9)
        mb.cyl((0.1, 0.05, 0.2), (0.1, 0.05, 0.27), 0.012, 'copper', n=5)
    mb.cyl((0.68, -0.1, z), (0.68, -0.1, z + 0.02), 0.025, 'bakelite', n=6)
    mb.cyl((0.68, -0.1, z + 0.02), (0.68, -0.1, z + 0.14), 0.022, 'Glass', n=6)
    mb.cyl((0.68, -0.1, z + 0.04), (0.68, -0.1, z + 0.1), 0.01, 'steel', n=4)

    z = levels[3]  # oil can, jars, tin box, scrap
    with mb.at((-0.58, 0.0, z)):
        mb.lathe([(0, 0), (0.09, 0), (0.09, 0.12), (0.04, 0.18), (0.015, 0.25), (0, 0.25)], 'red', n=10)
        mb.cyl((0.05, 0, 0.1), (0.2, 0, 0.22), 0.009, 'brass', r1=0.004, n=5)
        mb.torus((-0.03, 0, 0.14), 0.05, 0.008, 'iron', n=8, m=3, rot=(math.pi / 2, 0, 0), arc=math.pi,
                 start=-0.2)
    for i, c in enumerate(('jar_brown', 'jar_amber', 'jar_brown')):
        jar(mb, (-0.3 + i * 0.13, -0.05, z), c, h=0.18, r=0.06)
    mb.box((0.2, 0.0, z + 0.07), (0.3, 0.22, 0.14), 'teal', bevel=0.008)
    mb.box((0.2, 0.0, z + 0.145), (0.31, 0.23, 0.02), 'brass')
    mb.gear((0.55, 0.05, z + 0.12), 0.11, 8, 0.025, 'brass', rot=(math.pi / 2 - 0.15, 0, 0.3))

    z = levels[4]  # top: big glass carboy, crate, pipe bundle
    with mb.at((-0.5, 0.0, z)):
        mb.lathe([(0, 0), (0.15, 0), (0.17, 0.12), (0.15, 0.24), (0.06, 0.3), (0.04, 0.36), (0, 0.36)],
                 'Glass', n=9)
        mb.lathe([(0, 0.005), (0.14, 0.005), (0.16, 0.12), (0.155, 0.14), (0, 0.14)], 'jar_green', n=9)
        mb.cyl((0, 0, 0.36), (0, 0, 0.39), 0.045, 'wood_dark', n=8)
    crate(mb, (0.05, 0.0, z), (0.4, 0.36, 0.22), 'wood_dark', rot=(0, 0, 0.06))
    for i in range(4):
        y = -0.1 + i * 0.06
        mb.cyl((0.35, y, z + 0.03 + (i % 2) * 0.03), (0.75, y, z + 0.03 + (i % 2) * 0.03), 0.025,
               ('copper', 'iron', 'copper_raw', 'rust')[i], n=6)
    return mb.finish('shelf')


# ---------------------------------------------------------------------------------------------------------
# 3. Stove


def build_stove():
    mb = MB()
    prof = [(0, 0.14), (0.3, 0.14), (0.36, 0.16), (0.36, 0.21), (0.40, 0.27), (0.44, 0.38), (0.46, 0.52),
            (0.455, 0.66), (0.43, 0.80), (0.39, 0.92), (0.34, 1.02), (0.33, 1.06), (0.37, 1.08), (0.37, 1.13),
            (0.33, 1.15), (0.33, 1.35), (0.40, 1.36), (0.40, 1.42), (0, 1.42)]
    mats = ['iron', 'iron', 'brass', 'rust', 'rust', 'iron', 'iron', 'iron', 'iron', 'iron', 'iron', 'brass',
            'brass', 'brass', 'iron', 'iron', 'brass', 'iron']
    mb.lathe(prof, mats, n=16, smooth=True)
    mb.torus((0, 0, 0.6), 0.462, 0.018, 'brass', n=16, m=4)
    for i in range(16):  # rivets around the band
        a = TAU * (i + 0.5) / 16
        if abs(a - 1.5 * math.pi) < 0.4:
            continue
        mb.sphere((math.cos(a) * 0.47, math.sin(a) * 0.47, 0.6), 0.012, 'brass', n=4, rings=2)
    # feet
    for i in range(4):
        a = TAU * (i + 0.5) / 4
        c, s = math.cos(a), math.sin(a)
        mb.tube([(c * 0.28, s * 0.28, 0.2), (c * 0.38, s * 0.38, 0.12), (c * 0.44, s * 0.44, 0.05),
                 (c * 0.47, s * 0.47, 0.02)], 0.032, 'iron', n=6)
        mb.cyl((c * 0.47, s * 0.47, 0), (c * 0.47, s * 0.47, 0.03), 0.05, 'iron', n=6)
    # firebox door: brass frame, glowing panel behind an iron grille
    fy, zc = -0.455, 0.56
    mb.box((0, fy + 0.01, zc), (0.3, 0.02, 0.28), 'EmitAmber')
    for x in (-0.17, 0.17):
        mb.box((x, fy - 0.01, zc), (0.04, 0.06, 0.34), 'brass')
    for z in (zc - 0.15, zc + 0.15):
        mb.box((0, fy - 0.01, z), (0.38, 0.06, 0.04), 'brass')
    for i in range(6):
        x = -0.125 + i * 0.05
        mb.box((x, fy - 0.025, zc), (0.016, 0.016, 0.27), 'iron')
    mb.box((0, fy - 0.03, zc), (0.3, 0.016, 0.016), 'iron')
    mb.cyl((-0.19, fy - 0.03, zc - 0.11), (-0.19, fy - 0.03, zc - 0.04), 0.014, 'iron', n=6)
    mb.cyl((-0.19, fy - 0.03, zc + 0.04), (-0.19, fy - 0.03, zc + 0.11), 0.014, 'iron', n=6)
    mb.cyl((0.2, fy - 0.04, zc), (0.2, fy - 0.1, zc), 0.012, 'steel', n=5)
    mb.sphere((0.2, fy - 0.1, zc), 0.02, 'wood_dark', n=6, rings=3)
    # ash drawer with glowing slit above
    mb.box((0, -0.375, 0.235), (0.26, 0.04, 0.008), 'EmitAmber')
    mb.box((0, -0.385, 0.2), (0.3, 0.06, 0.06), 'iron')
    mb.cyl((0, -0.415, 0.2), (0, -0.44, 0.2), 0.012, 'brass', n=5)
    # top: kettle
    with mb.at((-0.15, -0.13, 1.42)):
        mb.lathe([(0, 0), (0.08, 0), (0.105, 0.04), (0.105, 0.09), (0.075, 0.14), (0.03, 0.155), (0.03, 0.165),
                  (0.0, 0.175)], 'copper_raw', n=10, smooth=True)
        mb.cyl((0.08, 0, 0.05), (0.17, 0, 0.13), 0.016, 'copper_raw', r1=0.008, n=5)
        mb.torus((0, 0, 0.13), 0.08, 0.008, 'iron', n=8, m=3, rot=(math.pi / 2, 0, 0), arc=math.pi)
        mb.sphere((0, 0, 0.18), 0.012, 'wood_dark', n=5, rings=3)
    # flue: rises from the back of the top plate into the dome
    fx, fyy = 0.0, 0.17
    mb.cyl((fx, fyy, 1.42), (fx, fyy, 4.0), 0.09, 'iron', n=10, caps=(False, True))
    for z, r in ((1.42, 0.115), (2.3, 0.1), (3.15, 0.1)):
        mb.cyl((fx, fyy, z), (fx, fyy, z + 0.07), r, 'brass', n=10)
    mb.cyl((fx - 0.13, fyy, 1.9), (fx + 0.13, fyy, 1.9), 0.01, 'steel', n=4)
    mb.box((fx + 0.15, fyy, 1.9), (0.04, 0.02, 0.06), 'wood_dark')
    # boiler bits: copper water tank at the back right, pipe with valve wheel, pressure gauge
    tx, ty = 0.38, 0.3
    mb.cyl((tx, ty, 0.72), (tx, ty, 1.22), 0.11, 'copper', n=10, smooth=True)
    mb.sphere((tx, ty, 1.22), 0.11, 'copper', n=10, rings=4, scale=(1, 1, 0.5))
    mb.torus((tx, ty, 0.85), 0.112, 0.01, 'brass', n=10, m=3)
    mb.torus((tx, ty, 1.1), 0.112, 0.01, 'brass', n=10, m=3)
    mb.tube([(0.2, 0.28, 0.45), (0.33, 0.33, 0.5), (tx, ty, 0.6), (tx, ty, 0.72)], 0.02, 'copper', n=6)
    mb.tube([(0.3, 0.18, 0.95), (0.42, 0.2, 0.98), (0.48, 0.2, 1.1), (0.46, 0.25, 1.25), (tx, ty, 1.3)],
            0.018, 'copper', n=6)
    with mb.at((0.49, 0.2, 1.06), (0, math.pi / 2, 0)):
        mb.torus((0, 0, 0.03), 0.06, 0.008, 'red', n=10, m=3)
        for k in range(3):
            a = TAU * k / 3
            mb.bar((0, 0, 0.03), (math.cos(a) * 0.06, math.sin(a) * 0.06, 0.03), 0.008, 0.008, 'red')
    mb.tube([(0.28, -0.22, 1.0), (0.4, -0.27, 1.04), (0.44, -0.29, 1.12)], 0.014, 'copper', n=5)
    gauge(mb, (0.44, -0.27, 1.21), 0.075, needle_a=0.4)
    return mb.finish('stove')


# ---------------------------------------------------------------------------------------------------------
# 4. Table with three stools


def build_table():
    mb = MB()
    rng = Rng(5)
    R, H = 0.7, 0.75
    mb.lathe([(0, H - 0.05), (R - 0.04, H - 0.05), (R, H - 0.035), (R, H - 0.012), (R - 0.01, H),
              (R - 0.08, H), (R - 0.1, H), (0, H)],
             ['wood_dark', 'brass', 'brass', 'wood', 'wood', 'wood_dark', 'wood'], n=24)
    mb.cyl((0, 0, 0.1), (0, 0, H - 0.05), 0.07, 'wood_dark', n=8, smooth=True)
    for z in (0.18, H - 0.1):
        mb.cyl((0, 0, z), (0, 0, z + 0.04), 0.085, 'brass', n=8)
    for i in range(4):
        a = TAU * i / 4 + math.pi / 4
        c, s = math.cos(a), math.sin(a)
        mb.bar((0, 0, 0.05), (c * 0.5, s * 0.5, 0.04), 0.07, 0.08, 'wood_dark')
        mb.bar((c * 0.05, s * 0.05, 0.4), (c * 0.38, s * 0.38, 0.08), 0.04, 0.04, 'iron')
        mb.cyl((c * 0.5, s * 0.5, 0), (c * 0.5, s * 0.5, 0.02), 0.05, 'iron', n=6)
    # on the table: lantern, cups, map with a compass and paperweight, a seedling in a tin
    lantern(mb, (0.22, 0.18, H))
    for x, y, m in ((-0.35, 0.3, 'steel'), (0.42, -0.2, 'copper_raw'), (-0.05, 0.45, 'teal')):
        mb.cyl((x, y, H), (x, y, H + 0.09), 0.04, m, n=8, caps=(True, False))
        mb.cyl((x, y, H + 0.005), (x, y, H + 0.006), 0.038, 'jar_brown', n=8, caps=(False, True))
        mb.cyl((x, y, H + 0.07), (x, y, H + 0.071), 0.038, 'jar_brown', n=8, caps=(False, True))
        mb.torus((x + 0.045, y, H + 0.045), 0.025, 0.006, m, n=6, m=3, rot=(math.pi / 2, 0, 0), arc=math.pi,
                 start=-math.pi / 2)
    with mb.at((-0.12, -0.15, H + 0.002), (0, 0, 0.25)):
        mb.box((0, 0, 0), (0.62, 0.42, 0.003), 'paper')
        mb.box((-0.32, 0, 0.01), (0.04, 0.44, 0.04), 'paper', rot=(0, 0.5, 0))  # curled edge
        lines = [((-0.25, -0.12), (-0.05, 0.02)), ((-0.05, 0.02), (0.15, -0.06)), ((0.15, -0.06), (0.22, 0.12)),
                 ((-0.2, 0.15), (0.05, 0.12)), ((0.0, -0.17), (0.08, -0.05))]
        for (x0, y0), (x1, y1) in lines:
            mb.bar((x0, y0, 0.002), (x1, y1, 0.002), 0.008, 0.001, 'ink')
        mb.cyl((0.15, -0.06, 0.0), (0.15, -0.06, 0.004), 0.03, 'needle', n=6)
        mb.cyl((-0.18, 0.12, 0.0), (-0.18, 0.12, 0.015), 0.04, 'brass', n=10)  # compass
        mb.box((-0.18, 0.12, 0.016), (0.05, 0.006, 0.002), 'needle', rot=(0, 0, 0.7))
        mb.sphere((0.22, 0.14, 0.03), 0.045, 'rust', n=6, rings=3, scale=(1.2, 1, 0.7), smooth=False)
    with mb.at((-0.42, 0.0, H)):
        mb.cyl((0, 0, 0), (0, 0, 0.1), 0.05, 'steel', n=8, caps=(True, False))
        mb.cyl((0, 0, 0.085), (0, 0, 0.086), 0.049, 'soil', n=8, caps=(False, True))
        mb.cyl((0, 0, 0.085), (0, 0, 0.16), 0.004, 'leaf', n=4)
        for i in range(4):
            a = TAU * i / 4 + 0.4
            mb.leaf((0, 0, 0.12 + i * 0.012), (math.cos(a), math.sin(a), 0.6), 0.07, 0.035,
                    'leaf_young' if i > 1 else 'leaf', droop=0.2)
    # stools
    for a in (math.radians(-90 - 40), math.radians(-90 + 40), math.radians(90 + 15)):
        cx, cy = math.cos(a) * 0.95, math.sin(a) * 0.95
        with mb.at((cx, cy, 0), (0, 0, a + rng(-0.3, 0.3))):
            mb.cyl((0, 0, 0.42), (0, 0, 0.46), 0.19, 'wood', n=10, smooth=False)
            mb.cyl((0, 0, 0.405), (0, 0, 0.42), 0.15, 'iron', n=10)
            for k in range(3):
                b = TAU * k / 3
                mb.cyl((math.cos(b) * 0.1, math.sin(b) * 0.1, 0.41), (math.cos(b) * 0.2, math.sin(b) * 0.2, 0),
                       0.016, 'iron', n=5)
            mb.torus((0, 0, 0.16), 0.15, 0.01, 'brass', n=10, m=3)
    return mb.finish('table')


# ---------------------------------------------------------------------------------------------------------
# 5. Bunk bed


def patchwork(mb, x0, x1, y0, y1, z, nx, ny, rng, front_drop=0.18, jitter=0.0):
    """Patchwork blanket over a mattress top (x0..x1, y0..y1 at height z), draping down the front (-y)."""
    cols = ['patch_red', 'patch_ochre', 'patch_teal', 'patch_cream', 'patch_olive', 'patch_plum']
    xs = [x0 + (x1 - x0) * i / nx for i in range(nx + 1)]
    ys = [y0 + (y1 - y0) * k / ny for k in range(ny + 1)]
    grid = {}
    for i, x in enumerate(xs):
        for k, y in enumerate(ys):
            inner = 0 < i < nx and 0 < k < ny
            grid[i, k] = mb.v((x, y, z + (rng(0, jitter) if inner else 0)))
    for i in range(nx):
        for k in range(ny):
            mb.face([grid[i, k], grid[i + 1, k], grid[i + 1, k + 1], grid[i, k + 1]], rng.pick(cols))
    # front drape
    low = [mb.v((x, y0 - 0.02, z - front_drop)) for x in xs]
    for i in range(nx):
        mb.face([low[i], low[i + 1], grid[i + 1, 0], grid[i, 0]], rng.pick(cols))
    # side drape at the foot end
    lows = [mb.v((x1 + 0.02, y, z - front_drop)) for y in ys]
    for k in range(ny):
        mb.face([grid[nx, k], lows[k], lows[k + 1], grid[nx, k + 1]], rng.pick(cols))


def build_bunk():
    mb = MB()
    rng = Rng(7)
    L, D = 2.1, 1.0
    px, py = L / 2 - 0.03, D / 2 - 0.03
    for x in (-px, px):
        for y in (-py, py):
            mb.cyl((x, y, 0), (x, y, 1.88), 0.03, 'iron', n=8)
            mb.sphere((x, y, 1.9), 0.04, 'brass', n=8, rings=4)
    decks = [0.32, 1.3]
    for z in decks:
        for y in (-py, py):
            mb.box((0, y, z), (2 * px, 0.04, 0.07), 'iron')
        for x in (-px, px):
            mb.box((x, 0, z), (0.04, 2 * py, 0.07), 'iron')
        mb.box((0, 0, z + 0.03), (2 * px - 0.04, 2 * py - 0.04, 0.02), 'wood_dark')
    # head/foot boards: bars between rails
    for x in (-px, px):
        for z0, z1 in ((0.32, 0.8), (1.3, 1.75)):
            mb.cyl((x, -py, z1), (x, py, z1), 0.02, 'iron', n=6)
            for k in range(1, 5):
                y = -py + 2 * py * k / 5
                mb.cyl((x, y, z0), (x, y, z1), 0.012, 'iron', n=5)
    # upper guard rail on the front, leaving the ladder gap
    mb.cyl((-px, -py, 1.62), (0.45, -py, 1.62), 0.02, 'iron', n=6)
    mb.cyl((0.45, -py, 1.3), (0.45, -py, 1.62), 0.02, 'iron', n=6)
    mb.cyl((-px, py, 1.62), (px, py, 1.62), 0.02, 'iron', n=6)
    # mattresses, pillows, blankets
    for z, jit in zip(decks, (0.035, 0.02)):
        top = z + 0.04 + 0.15
        mb.box((0, 0, z + 0.04 + 0.075), (2 * px - 0.08, 2 * py - 0.08, 0.15), 'canvas', bevel=0.03)
        mb.box((-px + 0.25, 0.0, top + 0.05), (0.32, 0.6, 0.12), 'canvas', bevel=0.04, rot=(0, -0.15, 0))
        patchwork(mb, -px + 0.48, px - 0.06, -py + 0.02, py - 0.04, top + 0.012, 5, 3, rng, jitter=jit)
        # rolled-back top edge
        mb.cyl((-px + 0.47, -py, top + 0.03), (-px + 0.47, py - 0.04, top + 0.03), 0.04, 'patch_red', n=6)
    # ladder on the front right, hooked over the upper front rail
    lx0, lx1 = 0.6, 0.95
    bot_y, top_y = -py - 0.16, -py - 0.04
    for x in (lx0, lx1):
        mb.bar((x, bot_y, 0.0), (x, top_y, 1.62), 0.05, 0.03, 'wood', up=(0, 1, 0))
        mb.torus((x, -py, 1.62), 0.035, 0.008, 'iron', n=6, m=3, rot=(0, math.pi / 2, 0), arc=math.pi,
                 start=0)
    for k in range(5):
        t = (k + 0.7) / 5.5
        z = 1.62 * t
        y = bot_y + (top_y - bot_y) * t
        mb.cyl((lx0, y, z), (lx1, y, z), 0.016, 'iron', n=5)
    # satchel hanging from the head post, boots under the bunk
    mb.box((-px - 0.08, -py + 0.12, 1.1), (0.1, 0.24, 0.26), 'canvas_dark', bevel=0.03)
    mb.tube([(-px - 0.05, -py + 0.04, 1.2), (-px - 0.02, -py + 0.0, 1.45), (-px - 0.05, -py + 0.2, 1.2)],
            0.008, 'wood_dark', n=4)
    for x in (-0.5, -0.36):
        with mb.at((x, -0.25, 0), (0, 0, rng(-0.2, 0.2))):
            mb.box((0, 0, 0.12), (0.1, 0.12, 0.24), 'wood_dark', bevel=0.02)
            mb.box((0, -0.09, 0.04), (0.1, 0.18, 0.08), 'wood_dark', bevel=0.02)
            mb.box((0, -0.03, 0.005), (0.11, 0.3, 0.01), 'iron')
    return mb.finish('bunk')


# ---------------------------------------------------------------------------------------------------------
# 6. Chandelier (origin at the top hook, hangs down)


def build_chandelier():
    mb = MB()
    mb.cyl((0, 0, -0.03), (0, 0, 0), 0.13, 'brass', n=12)
    mb.cone((0, 0, -0.03), (0, 0, -0.07), 0.06, 'brass', n=8, cap=False)
    pitch = 0.08
    z = -0.075
    k = 0
    while z > -1.68:
        mb.torus((0, 0, z - 0.04), 0.03, 0.007, 'iron', n=6, m=3, rot=(math.pi / 2, 0, (k % 2) * math.pi / 2),
                 scale=(1, 1.7, 1))
        z -= pitch
        k += 1
    hub = -1.72
    mb.gear((0, 0, hub - 0.02), 0.13, 12, 0.04, 'brass')
    mb.lathe([(0, hub + 0.05), (0.04, hub + 0.05), (0.06, hub), (0.07, hub - 0.08), (0, hub - 0.1)], 'copper',
             n=8)
    mb.sphere((0, 0, hub - 0.17), 0.08, 'EmitWarm', n=10, rings=5)
    mb.torus((0, 0, hub - 0.15), 0.082, 0.008, 'brass', n=10, m=3)
    RZ, RR = -2.4, 0.7
    mb.torus((0, 0, RZ), RR, 0.032, 'brass', n=24, m=6, smooth=True)
    mb.torus((0, 0, RZ + 0.05), RR - 0.08, 0.014, 'copper', n=24, m=4)
    N = 6
    for i in range(N):
        a = TAU * i / N
        c, s = math.cos(a), math.sin(a)
        mb.cyl((c * 0.1, s * 0.1, hub), (c * RR, s * RR, RZ + 0.02), 0.008, 'iron', n=4)
        mb.sphere((c * RR, s * RR, RZ + 0.03), 0.03, 'brass', n=6, rings=3)
        # lantern hanging below the ring
        b = a + math.pi / N
        lx, ly = math.cos(b) * RR, math.sin(b) * RR
        mb.cyl((lx, ly, RZ - 0.03), (lx, ly, RZ - 0.08), 0.005, 'iron', n=4)
        with mb.at((lx, ly, RZ - 0.08 - 0.19 * 1.3), (0, 0, 0), 1.3):  # lanterns scaled up 1.3x
            mb.cyl((0, 0, 0), (0, 0, 0.02), 0.05, 'brass', n=8)
            mb.cyl((0, 0, 0.02), (0, 0, 0.14), 0.045, 'Glass', n=8, caps=(False, False))
            mb.sphere((0, 0, 0.08), 0.03, 'EmitAmber', n=6, rings=4)
            for k in range(3):
                d = TAU * k / 3
                mb.box((math.cos(d) * 0.05, math.sin(d) * 0.05, 0.08), (0.008, 0.008, 0.13), 'brass')
            mb.cone((0, 0, 0.14), (0, 0, 0.19), 0.06, 'brass', n=8)
            mb.cone((0, 0, 0.0), (0, 0, -0.04), 0.03, 'brass', n=6)
    return mb.finish('chandelier')


# ---------------------------------------------------------------------------------------------------------
# 7. Rug


def build_rug():
    mb = MB()
    N = 48
    T = 0.01
    bands = [  # (outer radius, kind, colours)
        (0.24, 'star', ('rug_red', 'rug_ochre')),
        (0.30, 'solid', ('rug_cream',)),
        (0.48, 'diamond', ('rug_red', 'rug_ochre')),
        (0.54, 'solid', ('rug_brown',)),
        (0.82, 'check', ('rug_red', 'rug_orange')),
        (0.88, 'solid', ('rug_cream',)),
        (1.08, 'saw', ('rug_brown', 'rug_ochre')),
        (1.14, 'solid', ('rug_cream',)),
        (1.22, 'solid', ('rug_red',)),
        (1.42, 'diamond', ('rug_red', 'rug_teal')),
        (1.48, 'solid', ('rug_cream',)),
        (1.6, 'saw', ('rug_brown', 'rug_red')),
    ]

    def ring(r):
        return [mb.v((math.cos(TAU * i / N) * r, math.sin(TAU * i / N) * r, T)) for i in range(N)]

    centre = mb.v((0, 0, T))
    prev = None
    for r, kind, cols in bands:
        cur = ring(r)
        for i in range(N):
            j = (i + 1) % N
            if prev is None:
                mb.face([centre, cur[i], cur[j]], cols[(i // 3) % 2])
                continue
            a0, a1, b0, b1 = prev[i], prev[j], cur[i], cur[j]
            # (a = inner ring, b = outer ring; faces wound counter-clockwise seen from above)
            if kind == 'solid':
                mb.face([a0, b0, b1, a1], cols[0])
            elif kind == 'check':
                mb.face([a0, b0, b1, a1], cols[(i // 4) % 2])
            elif kind == 'saw':
                mb.face([a0, b1, a1], cols[0])
                mb.face([a0, b0, b1], cols[1])
            elif kind == 'diamond':
                if i % 2 == 0:
                    mb.face([a0, b1, a1], cols[0])
                    mb.face([a0, b0, b1], cols[1])
                else:
                    mb.face([a0, b0, a1], cols[0])
                    mb.face([a1, b0, b1], cols[1])
        prev = cur
    # side wall and bottom
    bot = [mb.v((math.cos(TAU * i / N) * 1.6, math.sin(TAU * i / N) * 1.6, 0)) for i in range(N)]
    for i in range(N):
        j = (i + 1) % N
        mb.face([bot[i], bot[j], prev[j], prev[i]], 'rug_brown')  # outward: tangent x up
    mb.face(list(reversed(bot)), 'rug_brown')
    return mb.finish('rug')


# ---------------------------------------------------------------------------------------------------------
# 8. Chest (+ crate stack beside it)


def build_chest():
    mb = MB()
    cx, W, D, H, t = -0.18, 1.0, 0.6, 0.46, 0.03
    x0, x1, y0, y1 = cx - W / 2, cx + W / 2, -D / 2, D / 2
    for x in (x0 + 0.05, x1 - 0.05):
        for y in (y0 + 0.05, y1 - 0.05):
            mb.box((x, y, 0.015), (0.08, 0.08, 0.03), 'iron')
    zb = 0.03
    hh = H - zb
    mb.box((cx, 0, zb + t / 2), (W, D, t), 'wood_dark')
    mb.box((cx, y0 + t / 2, zb + hh / 2), (W, t, hh), 'teal')
    mb.box((cx, y1 - t / 2, zb + hh / 2), (W, t, hh), 'teal')
    mb.box((x0 + t / 2, 0, zb + hh / 2), (t, D - 2 * t, hh), 'teal')
    mb.box((x1 - t / 2, 0, zb + hh / 2), (t, D - 2 * t, hh), 'teal')
    # brass bands around, iron corner straps, rivets
    e = 0.008
    for z in (zb + 0.04, H - 0.03):
        mb.box((cx, y0 - e / 2, z), (W + 2 * e, e, 0.04), 'brass')
        mb.box((cx, y1 + e / 2, z), (W + 2 * e, e, 0.04), 'brass')
        mb.box((x0 - e / 2, 0, z), (e, D, 0.04), 'brass')
        mb.box((x1 + e / 2, 0, z), (e, D, 0.04), 'brass')
    for x in (x0 + 0.03, x1 - 0.03, cx - 0.22, cx + 0.22):
        mb.box((x, y0 - e, zb + hh / 2), (0.05, e, hh), 'iron')
        for z in (zb + 0.12, zb + 0.24, zb + 0.34):
            mb.sphere((x, y0 - 2 * e, z), 0.009, 'brass', n=4, rings=2)
    for x in (x0, x1):  # side handles
        sgn = -1 if x == x0 else 1
        mb.torus((x + sgn * 0.02, 0, 0.3), 0.07, 0.01, 'iron', n=8, m=3, rot=(math.pi / 2, 0, math.pi / 2),
                 arc=math.pi, start=math.pi)
    # hasp + hanging open padlock
    mb.box((cx, y0 - 0.012, H - 0.06), (0.07, 0.01, 0.1), 'brass')
    mb.box((cx, y0 - 0.03, H - 0.14), (0.06, 0.025, 0.06), 'iron')
    mb.torus((cx + 0.01, y0 - 0.03, H - 0.1), 0.022, 0.006, 'steel', n=6, m=3, rot=(math.pi / 2, 0, 0.3),
             arc=math.pi)
    # glowing contents: an orb, power cells, a bundle of cloth
    mb.sphere((cx + 0.18, 0.02, 0.32), 0.1, 'EmitAmber', n=10, rings=5)
    for i in range(3):
        y = -0.15 + i * 0.1
        mb.cyl((cx - 0.38, y, 0.33), (cx - 0.1, y + 0.03, 0.35), 0.035, 'Glass', n=6)
        mb.cyl((cx - 0.36, y, 0.33), (cx - 0.12, y + 0.03, 0.35), 0.02, 'EmitWarm', n=6)
        mb.cyl((cx - 0.4, y, 0.33), (cx - 0.38, y, 0.33), 0.036, 'brass', n=6)
    mb.box((cx + 0.33, -0.05, 0.3), (0.2, 0.4, 0.16), 'canvas', bevel=0.04, rot=(0.2, 0, 0.3))
    # barrel lid, hinged at the back top edge, propped open
    with mb.at((cx, y1, H), (math.radians(-24), 0, 0)):
        n = 8
        arc = [(-D / 2 + math.cos(math.pi * k / n) * D / 2, math.sin(math.pi * k / n) * 0.14) for k in range(n + 1)]
        L = [mb.v((-W / 2, y, z)) for y, z in arc]
        Rr = [mb.v((W / 2, y, z)) for y, z in arc]
        for k in range(n):
            mb.face([L[k], L[k + 1], Rr[k + 1], Rr[k]], 'teal')
        mb.face(list(reversed(L)), 'teal')
        mb.face(Rr, 'teal')
        mb.face([L[0], Rr[0], Rr[n], L[n]], 'wood_dark')
        for xb in (-W / 2 + 0.03, -0.22, 0.22, W / 2 - 0.03):
            band = [(-D / 2 + math.cos(math.pi * k / n) * (D / 2 + 0.008), math.sin(math.pi * k / n) * 0.148)
                    for k in range(n + 1)]
            mb.tube([(xb, y, z) for y, z in band], 0.012, 'brass', n=4)
        mb.cyl((-W / 2 + 0.1, 0, 0), (W / 2 - 0.1, 0, 0), 0.012, 'iron', n=6)  # hinge pin
    # crate stack on the right
    crate(mb, (0.53, 0.0, 0), (0.34, 0.34, 0.34), 'wood', stripe='red')
    crate(mb, (0.52, 0.02, 0.34), (0.27, 0.27, 0.24), 'wood_light', rot=(0, 0, 0.22))
    return mb.finish('chest')


# ---------------------------------------------------------------------------------------------------------
# 9. Radio desk


def build_radio():
    mb = MB()
    W, D, HT = 1.2, 0.6, 0.76
    mb.box((0, 0, HT - 0.02), (W, D, 0.04), 'wood', bevel=0.006)
    for x in (-0.55, 0.55):
        for y in (-0.25, 0.25):
            mb.box((x, y, (HT - 0.04) / 2), (0.05, 0.05, HT - 0.04), 'wood_dark')
    mb.box((0, 0.27, HT - 0.09), (1.05, 0.02, 0.1), 'wood_dark')
    mb.box((-0.3, -0.27, HT - 0.09), (0.5, 0.03, 0.1), 'wood_dark')  # drawer
    mb.cyl((-0.3, -0.285, HT - 0.09), (-0.3, -0.31, HT - 0.09), 0.015, 'brass', n=6)
    mb.box((0, 0, 0.15), (1.1, 0.5, 0.025), 'wood_dark')
    # lower shelf: battery box with terminals + spare cable coil
    mb.box((-0.25, 0.02, 0.27), (0.4, 0.3, 0.22), 'iron', bevel=0.01)
    for x in (-0.35, -0.15):
        mb.cyl((x, 0.02, 0.38), (x, 0.02, 0.42), 0.02, 'copper_raw', n=6)
    mb.torus((0.3, 0.0, 0.18), 0.14, 0.012, 'bakelite', n=10, m=3)
    mb.torus((0.3, 0.0, 0.2), 0.12, 0.012, 'bakelite', n=10, m=3)

    # console cabinet
    cy, CW, CD, CH = 0.08, 1.0, 0.42, 0.5
    fy = cy - CD / 2
    mb.box((0, cy, HT + CH / 2), (CW, CD, CH), 'wood_dark', bevel=0.012)
    mb.box((0, fy - 0.004, HT + CH / 2), (CW - 0.06, 0.01, CH - 0.06), 'brass')
    py = fy - 0.009  # panel front
    for x in (-0.44, 0.44):
        for z in (HT + 0.05, HT + CH - 0.05):
            mb.sphere((x, py, z), 0.01, 'iron', n=4, rings=2)
    # tuning window (glowing) with needle and frame
    wz = HT + 0.39
    mb.box((0.12, py - 0.002, wz), (0.42, 0.006, 0.08), 'EmitWarm')
    for z in (wz - 0.045, wz + 0.045):
        mb.box((0.12, py - 0.006, z), (0.45, 0.012, 0.012), 'iron')
    for x in (-0.105, 0.345):
        mb.box((x, py - 0.006, wz), (0.012, 0.012, 0.1), 'iron')
    mb.box((0.18, py - 0.007, wz), (0.006, 0.004, 0.075), 'needle')
    for i in range(9):
        mb.box((-0.06 + i * 0.045, py - 0.006, wz - 0.03), (0.003, 0.003, 0.015), 'ink')
    # speaker: cloth disc, brass bezel and bars
    sx, sz = -0.3, HT + 0.23
    mb.cyl((sx, py, sz), (sx, py - 0.004, sz), 0.13, 'canvas_dark', n=16)
    mb.torus((sx, py - 0.006, sz), 0.13, 0.013, 'brass', n=16, m=4, rot=(math.pi / 2, 0, 0))
    for dz in (-0.07, -0.025, 0.025, 0.07):
        w = 2 * math.sqrt(0.13 ** 2 - dz ** 2)
        mb.box((sx, py - 0.008, sz + dz), (w, 0.006, 0.012), 'brass')
    # meters, knobs, toggles, a pilot jewel
    gauge(mb, (0.0, py, HT + 0.24), 0.055, needle_a=1.9)
    gauge(mb, (0.22, py, HT + 0.24), 0.055, needle_a=1.1)
    for i, x in enumerate((-0.05, 0.1, 0.25, 0.4)):
        mb.cyl((x, py, HT + 0.09), (x, py - 0.035, HT + 0.09), 0.03, 'bakelite', n=10)
        mb.cyl((x, py - 0.035, HT + 0.09), (x, py - 0.04, HT + 0.09), 0.018, 'brass', n=8)
        mb.box((x, py - 0.04, HT + 0.105), (0.004, 0.004, 0.02), 'dial')
    for x in (0.36, 0.4, 0.44):
        mb.box((x, py - 0.004, HT + 0.24), (0.025, 0.008, 0.04), 'iron')
        mb.cyl((x, py - 0.008, HT + 0.25), (x, py - 0.035, HT + 0.27), 0.004, 'steel', n=4)
    mb.sphere((0.4, py - 0.005, HT + 0.33), 0.016, 'EmitAmber', n=6, rings=3)
    # tubes on top, behind a brass cage
    top = HT + CH
    for i in range(4):
        x = -0.36 + i * 0.12
        y = cy + 0.06
        mb.cyl((x, y, top), (x, y, top + 0.025), 0.03, 'bakelite', n=8)
        mb.cyl((x, y, top + 0.025), (x, y, top + 0.15), 0.026, 'Glass', n=8, caps=(False, False))
        mb.sphere((x, y, top + 0.15), 0.026, 'Glass', n=8, rings=4, scale=(1, 1, 0.6))
        mb.cyl((x, y, top + 0.04), (x, y, top + 0.12), 0.012, 'EmitAmber', n=6)
    for y in (cy - 0.01, cy + 0.13):
        mb.cyl((-0.44, y, top + 0.17), (0.0, y, top + 0.17), 0.006, 'brass', n=4)
    for x in (-0.44, -0.22, 0.0):
        for y in (cy - 0.01, cy + 0.13):
            mb.cyl((x, y, top), (x, y, top + 0.17), 0.006, 'brass', n=4)
    # vents
    for i in range(5):
        mb.box((0.25, cy - 0.12 + i * 0.05, top + 0.002), (0.3, 0.02, 0.004), 'bakelite')
    # hand-crank generator on the right side
    with mb.at((CW / 2 + 0.01, cy, HT + 0.25), (0, math.pi / 2, 0)):
        mb.cyl((0, 0, 0), (0, 0, 0.03), 0.06, 'brass', n=10)
        mb.bar((0, 0, 0.04), (0.0, 0.13, 0.04), 0.02, 0.012, 'iron')
        mb.cyl((0, 0.13, 0.04), (0, 0.13, 0.11), 0.014, 'wood_light', n=6)
    # antenna: insulator + telescoping sections, tip ball
    ab = Vector((0.4, cy + 0.15, top))
    pts = [ab + Vector((0, 0, 0.06)), ab + Vector((0.03, 0.02, 0.4)), ab + Vector((0.06, 0.04, 0.72)),
           ab + Vector((0.09, 0.06, 1.0))]
    mb.cyl(ab, pts[0], 0.03, 'bakelite', r1=0.02, n=8)
    for k, r in enumerate((0.012, 0.009, 0.006)):
        mb.cyl(pts[k], pts[k + 1], r, 'steel', n=5)
        mb.cyl(pts[k + 1] - (pts[k + 1] - pts[k]).normalized() * 0.02, pts[k + 1], r * 1.4, 'brass', n=5)
    mb.sphere(pts[-1], 0.018, 'brass', n=6, rings=3)
    # cable: out of the back, down behind the desk, a loop on the floor
    cable = [(-0.2, cy + CD / 2 - 0.02, HT + 0.12), (-0.25, 0.3, HT + 0.05), (-0.3, 0.3, 0.5), (-0.4, 0.27, 0.1),
             (-0.45, 0.2, 0.015)]
    for i in range(9):
        a = math.pi / 2 + TAU * i / 8 * 0.9
        cable.append((-0.45 + 0.0 + math.cos(a) * 0.14 + 0.0, 0.06 + math.sin(a) * 0.14, 0.015))
    mb.tube(cable, 0.012, 'bakelite', n=5)
    # desk clutter: microphone, morse key, notepad with pencil, headphones hooked on the left side
    with mb.at((-0.48, -0.2, HT)):
        mb.cyl((0, 0, 0), (0, 0, 0.02), 0.05, 'iron', n=8)
        mb.cyl((0, 0, 0.02), (0, 0, 0.16), 0.008, 'steel', n=4)
        mb.torus((0, 0, 0.2), 0.04, 0.006, 'brass', n=8, m=3, rot=(math.pi / 2, 0, 0))
        mb.sphere((0, 0, 0.2), 0.032, 'steel', n=8, rings=4, scale=(1, 0.8, 1.2))
    with mb.at((0.4, -0.22, HT), (0, 0, 0.2)):
        mb.box((0, 0, 0.012), (0.08, 0.12, 0.024), 'wood_dark')
        mb.box((0, 0.0, 0.035), (0.012, 0.11, 0.008), 'brass', rot=(0.08, 0, 0))
        mb.cyl((0, -0.055, 0.035), (0, -0.055, 0.05), 0.014, 'bakelite', n=6)
    mb.box((0.0, -0.22, HT + 0.002), (0.2, 0.13, 0.004), 'paper', rot=(0, 0, -0.1))
    mb.cyl((-0.05, -0.24, HT + 0.008), (0.08, -0.2, HT + 0.008), 0.004, 'rug_ochre', n=4)
    with mb.at((-CW / 2 - 0.01, cy - 0.05, HT + 0.33)):
        mb.box((-0.01, 0, 0.04), (0.02, 0.02, 0.04), 'brass')
        mb.torus((-0.03, 0, -0.05), 0.08, 0.008, 'iron', n=8, m=3, rot=(0, math.pi / 2, 0), arc=math.pi,
                 start=0)
        for y in (-0.08, 0.08):
            mb.cyl((-0.03, y, -0.06), (-0.03, y, -0.1), 0.035, 'red', n=8)
            mb.cyl((-0.03, y, -0.1), (-0.03, y, -0.11), 0.03, 'bakelite', n=8)
    return mb.finish('radio')


# ---------------------------------------------------------------------------------------------------------


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def game_bbox(obj):
    """Bounding box in the game frame (X right, Y up, Z = -Blender Y)."""
    vs = [obj.matrix_world @ v.co for v in obj.data.vertices]
    xs = [v.x for v in vs]
    ys = [v.z for v in vs]
    zs = [-v.y for v in vs]
    return (min(xs), max(xs)), (min(ys), max(ys)), (min(zs), max(zs))


def export_glb(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
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


def render_preview(objs, path):
    scene = bpy.context.scene
    for engine in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT', 'BLENDER_WORKBENCH'):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.view_settings.view_transform = 'AgX'
    world = bpy.data.worlds.new('world')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (0.5, 0.32, 0.2, 1)
    bg.inputs['Strength'].default_value = 0.5

    bpy.ops.mesh.primitive_plane_add(size=80, location=(0, 0, -0.001))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new('ground')
    gm.use_nodes = True
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.35, 0.2, 0.12, 1)
    ground.data.materials.append(gm)
    # 1.8 m reference figure
    bpy.ops.mesh.primitive_cylinder_add(radius=0.22, depth=1.8, location=(0, 0, 0.9), vertices=16)
    fig = bpy.context.active_object
    fm = bpy.data.materials.new('figure')
    fm.use_nodes = True
    fm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.15, 0.25, 0.5, 1)
    fig.data.materials.append(fm)

    sun_data = bpy.data.lights.new('sun', 'SUN')
    sun_data.energy = 3.0
    sun_data.color = (1.0, 0.85, 0.7)
    sun_data.angle = math.radians(4)
    sun = bpy.data.objects.new('sun', sun_data)
    sun.rotation_euler = (math.radians(50), math.radians(0), math.radians(-30))
    scene.collection.objects.link(sun)

    cam_data = bpy.data.cameras.new('cam')
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam

    def look(loc, target):
        cam.location = loc
        d = Vector(target) - Vector(loc)
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()

    def render(p, w, h):
        scene.render.resolution_x, scene.render.resolution_y = w, h
        scene.render.filepath = p
        bpy.ops.render.render(write_still=True)

    # line-up (two rows) with the figure
    layout = {
        'workbench': (-7.5, 3.0, 0), 'shelf': (-4.6, 3.0, 0), 'stove': (-2.6, 3.0, 0), 'bunk': (0.0, 3.0, 0),
        'radio': (2.8, 3.0, 0), 'chandelier': (5.4, 3.0, 4.2), 'rug': (-4.5, -0.6, 0), 'table': (-4.5, -0.6, 0.01),
        'chest': (-1.0, -0.4, 0),
    }
    for o in objs:
        o.location = layout[o.name]
    fig.location = (1.2, -0.5, 0.9)
    cam_data.lens = 32
    look((-1.2, -13.5, 5.2), (-1.2, 1.0, 1.4))
    render(path, 2000, 1000)

    # close-ups: each piece alone at the origin
    for o in objs:
        o.hide_render = True
    fig.location = (0, 0, 0.9)
    base, ext = os.path.splitext(path)
    shots = {
        'workbench': ((1.0, -3.0, 2.2), (0.0, 0.0, 1.2), 40, -1.5),
        'shelf': ((1.2, -3.4, 2.0), (0.0, 0.0, 1.2), 35, -1.2),
        'stove': ((1.6, -3.2, 2.2), (0.0, 0.0, 1.3), 30, -1.1),
        'table': ((1.4, -2.8, 2.3), (0.0, 0.0, 0.5), 35, 1.45),
        'bunk': ((1.4, -3.6, 2.0), (0.0, 0.0, 1.0), 35, -1.5),
        'bunk_detail': ((-0.2, -1.6, 0.9), (-0.8, 0.0, 0.5), 35, None),
        'chandelier': ((1.6, -4.0, 0.6), (0.0, 0.0, 1.9), 35, None),
        'rug': ((0.0, -3.2, 3.6), (0.0, 0.0, 0.0), 30, None),
        'chest': ((1.1, -2.2, 1.5), (0.0, 0.0, 0.35), 35, 1.2),
        'radio': ((0.9, -2.4, 1.8), (0.0, 0.0, 1.0), 35, -1.0),
    }
    for o in objs:
        o.hide_render = False
        o.location = (0, 0, 4.2 if o.name == 'chandelier' else 0)
        loc, tgt, lens, fx = shots[o.name]
        fig.hide_render = fx is None
        if fx is not None:
            fig.location = (fx, 0.3, 0.9)
        cam_data.lens = lens
        look(loc, tgt)
        render(f'{base}_{o.name}{ext}', 1000, 800)
        if o.name + '_detail' in shots:
            loc, tgt, lens, fx = shots[o.name + '_detail']
            fig.hide_render = True
            cam_data.lens = lens
            look(loc, tgt)
            render(f'{base}_{o.name}_detail{ext}', 1000, 800)
        o.hide_render = True


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models', 'base', 'hall.glb'))
    ap.add_argument('--preview', default=None, help='render a line-up PNG (+ one close-up per piece)')
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    make_materials()
    builders = [build_workbench, build_shelf, build_stove, build_table, build_bunk, build_chandelier, build_rug,
                build_chest, build_radio]
    objs = [b() for b in builders]
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    export_glb(objs, args.out)
    for o in objs:
        (x0, x1), (y0, y1), (z0, z1) = game_bbox(o)
        print(f'{o.name:11s} tris={tri_count(o):5d}  x[{x0:+.2f},{x1:+.2f}] y[{y0:+.2f},{y1:+.2f}] '
              f'z[{z0:+.2f},{z1:+.2f}]')
    print(f'wrote {args.out} ({os.path.getsize(args.out) / 1024:.1f} KiB)')
    if args.preview:
        render_preview(objs, os.path.abspath(args.preview))


main()
