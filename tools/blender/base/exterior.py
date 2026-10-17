"""Home-base exterior machines (steampunk desert homestead), exported as one glTF binary.

    blender -b --python tools/blender/base/exterior.py                        # writes public/models/base/exterior.glb
    blender -b --python tools/blender/base/exterior.py -- --preview out.png   # also renders a line-up + close-ups

Top-level nodes (each at the world origin, origin at its base centre on the ground):
    condenser (+ child condenser_rotor, spins about its local Y), tank, windpump (+ child windpump_rotor,
    spins about its local Z), pipe_run, solar_still, signpost, fence.

Blender is Z-up; the exporter converts to Y-up. Game +Z ("front") = Blender -Y. Units are metres.
Deterministic geometry (only a seeded LCG); the glTF exporter may emit triangles in a different order
between runs, so the .glb bytes can differ while vertices and triangle sets are identical.
"""

import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True  # no __pycache__ next to the scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from coplanar import separate_coplanar  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))

# name: (sRGB hex, roughness, metallic, double_sided)
MATERIALS = {
    'Brass': (0xa8844e, 0.45, 0.3, False),
    'Copper': (0xa4603a, 0.5, 0.3, False),
    'Verdigris': (0x5f9c8a, 0.8, 0.05, False),
    'Iron': (0x3a3430, 0.7, 0.25, True),
    'Rust': (0x7a3d1e, 0.95, 0.0, True),
    'PaintTeal': (0x5d8a86, 0.85, 0.0, True),
    'PaintRed': (0x9a4a32, 0.85, 0.0, True),
    'Canvas': (0xd8c8a8, 0.95, 0.0, True),
    'Wood': (0x7a5a3a, 0.9, 0.0, False),
    'GaugeFace': (0xe8dcc0, 0.6, 0.0, False),
    'Ink': (0x1c1612, 0.6, 0.0, False),
    'Water': (0x3f7f8c, 0.15, 0.0, False),
    'Soil': (0x3e2516, 0.95, 0.0, False),
    'Leaf': (0x6a9a34, 0.8, 0.0, True),
    'Stone': (0x8a5a3a, 0.95, 0.0, False),
}
EMIT = {'EmitAmber': 0xffa838}

Z = Vector((0, 0, 1))
FRONT = Vector((0, -1, 0))  # game +Z


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgb(h):
    return [srgb_to_linear(((h >> s) & 0xFF) / 255) for s in (16, 8, 0)]


def make_materials():
    for name, (hx, rough, metal, ds) in MATERIALS.items():
        m = bpy.data.materials.new(name)
        rgb = hex_rgb(hx)
        m.diffuse_color = (*rgb, 1)
        m.use_nodes = True
        b = m.node_tree.nodes.get('Principled BSDF')
        b.inputs['Base Color'].default_value = (*rgb, 1)
        b.inputs['Roughness'].default_value = rough
        b.inputs['Metallic'].default_value = metal
        m.use_backface_culling = not ds
    for name, hx in EMIT.items():
        m = bpy.data.materials.new(name)
        rgb = hex_rgb(hx)
        m.diffuse_color = (*rgb, 1)
        m.use_nodes = True
        b = m.node_tree.nodes.get('Principled BSDF')
        b.inputs['Base Color'].default_value = (*rgb, 1)
        b.inputs['Emission Color'].default_value = (*rgb, 1)
        b.inputs['Emission Strength'].default_value = 4.0
        b.inputs['Roughness'].default_value = 0.4
        m.use_backface_culling = True
    m = bpy.data.materials.new('Glass')
    rgb = hex_rgb(0xcfe6e0)
    m.diffuse_color = (*rgb, 0.3)
    m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = 0.05
    b.inputs['Metallic'].default_value = 0.0
    b.inputs['Alpha'].default_value = 0.3
    m.use_backface_culling = False
    try:
        m.surface_render_method = 'BLENDED'
    except AttributeError:
        m.blend_method = 'BLEND'


class Rng:
    """Tiny deterministic LCG."""

    def __init__(self, seed):
        self.s = seed * 2654435761 % 2**32 or 1

    def __call__(self, a=0.0, b=1.0):
        self.s = (1664525 * self.s + 1013904223) % 2**32
        return a + (b - a) * self.s / 2**32


def frame(axis, origin=(0, 0, 0), phase=0.0):
    """4x4 matrix mapping local +Z to `axis` at `origin`, rotated `phase` about the axis."""
    axis = Vector(axis).normalized()
    rot = Z.rotation_difference(axis).to_matrix().to_4x4()
    return Matrix.Translation(Vector(origin)) @ rot @ Matrix.Rotation(phase, 4, 'Z')


class MB:
    """bmesh builder with named material slots."""

    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []

    def mi(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def tag(self, verts, mat):
        idx = self.mi(mat)
        for f in {f for v in verts for f in v.link_faces}:
            f.material_index = idx
            f.smooth = False

    def v(self, p):
        return self.bm.verts.new(Vector(p))

    def face(self, pts, mat):
        vs = [self.v(p) for p in pts]
        f = self.bm.faces.new(vs)
        f.material_index = self.mi(mat)
        f.smooth = False
        return f

    # --- primitives -------------------------------------------------------------------------------
    def cyl(self, p0, p1, r0, mat, r1=None, seg=10, caps=True, phase=0.0):
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        r1 = r0 if r1 is None else r1
        m = frame(d, (p0 + p1) / 2, phase)
        res = bmesh.ops.create_cone(self.bm, cap_ends=caps, cap_tris=False, segments=seg,
                                    radius1=r0, radius2=r1, depth=d.length, matrix=m)
        self.tag(res['verts'], mat)

    def beam(self, p0, p1, w, mat, phase=0.0):
        """Square-section bar of width w between two points."""
        self.cyl(p0, p1, w * 0.7071, mat, seg=4, caps=False, phase=math.pi / 4 + phase)

    def box(self, center, size, mat, rot=None):
        m = Matrix.Translation(Vector(center))
        if rot is not None:
            m = m @ (rot.to_4x4() if len(rot) == 3 else rot)
        m = m @ Matrix.Diagonal((*size, 1))
        res = bmesh.ops.create_cube(self.bm, size=1.0, matrix=m)
        self.tag(res['verts'], mat)

    def sphere(self, center, r, mat, u=8, v=5):
        res = bmesh.ops.create_uvsphere(self.bm, u_segments=u, v_segments=v, radius=r,
                                        matrix=Matrix.Translation(Vector(center)))
        self.tag(res['verts'], mat)

    def ico(self, center, r, mat, scale=(1, 1, 1)):
        m = Matrix.Translation(Vector(center)) @ Matrix.Diagonal((*scale, 1))
        res = bmesh.ops.create_icosphere(self.bm, subdivisions=1, radius=r, matrix=m)
        self.tag(res['verts'], mat)

    def lathe(self, profile, mat, seg=12, m=None, phase=0.0):
        """Revolve [(r, z), ...] around local Z. Traverse the profile with the visible side on the left
        (bottom-outside → top for an outer wall). r == 0 gives a single pole vertex."""
        m = m or Matrix.Identity(4)
        rings = []
        for r, z in profile:
            if r == 0:
                rings.append([self.v(m @ Vector((0, 0, z)))])
            else:
                rings.append([self.v(m @ Vector((math.cos(a) * r, math.sin(a) * r, z)))
                              for a in (phase + 2 * math.pi * i / seg for i in range(seg))])
        idx = self.mi(mat)
        for lo, hi in zip(rings, rings[1:]):
            for j in range(seg):
                k = (j + 1) % seg
                if len(lo) == 1:
                    vs = [lo[0], hi[k], hi[j]]
                elif len(hi) == 1:
                    vs = [lo[j], lo[k], hi[0]]
                else:
                    vs = [lo[j], lo[k], hi[k], hi[j]]
                f = self.bm.faces.new(vs)
                f.material_index = idx
                f.smooth = False

    def torus(self, center, axis, R, r, mat, seg=12, sides=4):
        m = frame(axis, center)
        rings = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            c, s = math.cos(a), math.sin(a)
            ring = []
            for j in range(sides):
                b = 2 * math.pi * j / sides + math.pi / sides
                rr = R + r * math.cos(b)
                ring.append(self.v(m @ Vector((c * rr, s * rr, r * math.sin(b)))))
            rings.append(ring)
        idx = self.mi(mat)
        for i in range(seg):
            a, b = rings[i], rings[(i + 1) % seg]
            for j in range(sides):
                k = (j + 1) % sides
                f = self.bm.faces.new([a[j], b[j], b[k], a[k]])
                f.material_index = idx
                f.smooth = False

    def slab(self, pts, normal, t, mat):
        """Extrude a planar polygon (CCW seen from `normal`) by thickness t along normal (centred)."""
        n = Vector(normal).normalized() * (t / 2)
        top = [self.v(Vector(p) + n) for p in pts]
        bot = [self.v(Vector(p) - n) for p in pts]
        idx = self.mi(mat)
        fs = [self.bm.faces.new(top), self.bm.faces.new(list(reversed(bot)))]
        k = len(pts)
        for i in range(k):
            j = (i + 1) % k
            fs.append(self.bm.faces.new([bot[i], bot[j], top[j], top[i]]))
        for f in fs:
            f.material_index = idx
            f.smooth = False

    def rivet(self, pos, normal, s, mat='Brass'):
        n = Vector(normal).normalized()
        t = n.orthogonal().normalized()
        b = n.cross(t)
        base = [self.v(Vector(pos) + (t * math.cos(a) + b * math.sin(a)) * s)
                for a in (math.pi * k / 2 for k in range(4))]
        apex = self.v(Vector(pos) + n * s * 0.9)
        idx = self.mi(mat)
        for i in range(4):
            f = self.bm.faces.new([base[i], base[(i + 1) % 4], apex])
            f.material_index = idx
            f.smooth = False

    # --- compound parts --------------------------------------------------------------------------
    def valve_wheel(self, center, axis, R, mat='PaintRed', spokes=4):
        axis = Vector(axis).normalized()
        c = Vector(center)
        self.torus(c, axis, R, R * 0.12, mat, seg=12, sides=4)
        t = axis.orthogonal().normalized()
        b = axis.cross(t)
        for k in range(spokes):
            a = math.pi * k / spokes
            d = t * math.cos(a) + b * math.sin(a)
            self.beam(c - d * R, c + d * R, R * 0.1, mat)
        self.cyl(c - axis * R * 0.15, c + axis * R * 0.2, R * 0.2, 'Brass', seg=6)

    def gauge(self, center, normal, r):
        n = Vector(normal).normalized()
        c = Vector(center)
        self.cyl(c - n * 0.02, c + n * r * 0.4, r, 'Brass', seg=12)
        self.cyl(c + n * r * 0.4, c + n * (r * 0.4 + 0.004), r * 0.82, 'GaugeFace', seg=12)
        # needle pointing up-right
        up = Vector((0, 0, 1)) if abs(n.z) < 0.9 else Vector((0, 1, 0))
        side = up.cross(n).normalized()
        d = (up * 0.8 + side * 0.6).normalized()
        p = c + n * (r * 0.4 + 0.008)
        self.beam(p - d * r * 0.15, p + d * r * 0.7, r * 0.07, 'Ink')
        self.cyl(p - n * 0.004, p + n * 0.006, r * 0.12, 'Ink', seg=6)
        # brass bezel
        self.torus(c + n * r * 0.42, n, r * 0.9, r * 0.09, 'Brass', seg=12, sides=4)

    def flange(self, center, axis, r, t, mat='Brass', bolts=6):
        axis = Vector(axis).normalized()
        c = Vector(center)
        self.cyl(c - axis * t / 2, c + axis * t / 2, r, mat, seg=12)
        if bolts:
            tt = axis.orthogonal().normalized()
            bb = axis.cross(tt)
            for k in range(bolts):
                a = 2 * math.pi * (k + 0.5) / bolts
                p = c + (tt * math.cos(a) + bb * math.sin(a)) * r * 0.78
                self.cyl(p - axis * t * 0.9, p + axis * t * 0.9, r * 0.1, 'Iron', seg=4)

    def lamp(self, center, r, cage='Brass'):
        """Small caged amber lamp: emissive bulb, brass cap, base and 4 cage bars."""
        c = Vector(center)
        self.sphere(c, r, 'EmitAmber', u=8, v=5)
        self.cyl(c + Vector((0, 0, r * 0.8)), c + Vector((0, 0, r * 1.5)), r * 1.15, cage, r1=r * 0.4, seg=8)
        self.cyl(c - Vector((0, 0, r * 1.3)), c - Vector((0, 0, r * 0.75)), r * 0.9, cage, seg=8)
        for k in range(4):
            a = math.pi / 4 + k * math.pi / 2
            o = Vector((math.cos(a), math.sin(a), 0)) * r * 1.12
            self.beam(c + o - Vector((0, 0, r * 0.9)), c + o + Vector((0, 0, r * 0.9)), r * 0.12, cage)

    def build(self, name, origin=(0, 0, 0)):
        separate_coplanar(self.bm)
        mesh = bpy.data.meshes.new(name)
        o = Vector(origin)  # geometry is built in local coordinates; origin only places the object
        self.bm.normal_update()
        self.bm.to_mesh(mesh)
        self.bm.free()
        for m in self.mats:
            mesh.materials.append(bpy.data.materials[m])
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.location = o
        return obj


def attach(child, parent):
    child.parent = parent
    child.matrix_parent_inverse = Matrix.Identity(4)


def pipe_path(mb, pts, r, mat, seg=8, elbow_mat=None):
    """Pipe through a polyline with a small ball at each bend."""
    pts = [Vector(p) for p in pts]
    for a, b in zip(pts, pts[1:]):
        mb.cyl(a, b, r, mat, seg=seg, caps=False)
    for p in pts[1:-1]:
        mb.sphere(p, r * 1.25, elbow_mat or mat, u=seg, v=4)


# =================================================================================================
# 1. condenser
# =================================================================================================
def build_condenser():
    mb = MB()
    # footing: iron octagon plinth + four splayed feet
    mb.cyl((0, 0, 0), (0, 0, 0.18), 0.95, 'Iron', r1=0.88, seg=8, phase=math.pi / 8)
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        d = Vector((math.cos(a), math.sin(a), 0))
        mb.box(d * 0.98 + Vector((0, 0, 0.04)), (0.34, 0.22, 0.08), 'Iron',
               rot=Matrix.Rotation(a, 3, 'Z'))
        mb.beam(d * 0.95 + Vector((0, 0, 0.08)), d * 0.45 + Vector((0, 0, 0.9)), 0.08, 'Iron', phase=a)
    # reservoir drum (copper, brass bands)
    mb.cyl((0, 0, 0.18), (0, 0, 0.95), 0.5, 'Copper', seg=12)
    for z in (0.3, 0.83):
        mb.torus((0, 0, z), Z, 0.51, 0.025, 'Brass', seg=12, sides=4)
    for k in range(8):
        a = 2 * math.pi * (k + 0.5) / 8
        d = Vector((math.cos(a), math.sin(a), 0))
        mb.rivet(d * 0.52 + Vector((0, 0, 0.57)), d, 0.022)
    # brass collection funnel (thick lathe) on a neck
    mb.lathe([(0.5, 0.95), (0.2, 1.05), (0.16, 1.2), (0.82, 1.78), (0.86, 1.82),
              (0.8, 1.81), (0.14, 1.25), (0, 1.25)], 'Brass', seg=14)
    mb.torus((0, 0, 1.82), Z, 0.86, 0.03, 'Brass', seg=14, sides=4)
    # core column
    mb.cyl((0, 0, 1.2), (0, 0, 5.72), 0.16, 'Verdigris', seg=10)
    # tie rods and stacked condensing plates (dished, alternating copper / verdigris)
    rods = []
    for k in range(4):
        a = k * math.pi / 2
        rods.append(Vector((math.cos(a) * 0.72, math.sin(a) * 0.72, 0)))
        mb.cyl(rods[-1] + Vector((0, 0, 1.7)), rods[-1] + Vector((0, 0, 5.4)), 0.03, 'Iron', seg=6)
    n = 9
    for i in range(n):
        z = 2.0 + i * 0.39
        mat = 'Copper' if i % 2 == 0 else 'Verdigris'
        r_out = 0.92 - 0.04 * abs(i - n / 2) / (n / 2)
        mb.lathe([(0.17, z - 0.07), (r_out, z), (r_out, z + 0.035), (0.17, z - 0.035)], mat, seg=10,
                 phase=0.13 * i)
        # spacer collar
        mb.cyl((0, 0, z - 0.09), (0, 0, z - 0.03), 0.21, 'Brass', seg=8)
    # rod nuts top & bottom
    for p in rods:
        for z in (1.72, 5.4):
            mb.cyl(p + Vector((0, 0, z - 0.04)), p + Vector((0, 0, z + 0.04)), 0.055, 'Brass', seg=6)
    # top cross-ring tying the rods + bearing housing for the rotor
    mb.torus((0, 0, 5.4), Z, 0.72, 0.035, 'Iron', seg=12, sides=4)
    for k in range(4):
        a = k * math.pi / 2
        mb.beam((0, 0, 5.4), (math.cos(a) * 0.72, math.sin(a) * 0.72, 5.4), 0.05, 'Iron', phase=a)
    mb.cyl((0, 0, 5.4), (0, 0, 5.72), 0.28, 'Brass', r1=0.2, seg=10)
    mb.cyl((0, 0, 5.72), (0, 0, 5.78), 0.3, 'Iron', seg=10)
    # drip pipe: from the reservoir out to +X and down to a little ground cup
    pipe_path(mb, [(0.45, -0.1, 0.4), (0.9, -0.1, 0.4), (0.9, -0.1, 0.1)], 0.045, 'Copper', elbow_mat='Brass')
    mb.cyl((0.9, -0.1, 0.0), (0.9, -0.1, 0.1), 0.13, 'Verdigris', r1=0.15, seg=8)
    mb.cyl((0.9, -0.1, 0.1), (0.9, -0.1, 0.11), 0.11, 'Water', seg=8)
    # small valve on the drip pipe
    mb.cyl((0.7, -0.1, 0.4), (0.7, -0.1, 0.55), 0.035, 'Brass', seg=6)
    mb.valve_wheel((0.7, -0.1, 0.57), Z, 0.09)
    # front: pressure gauge on a stand pipe, amber indicator lamp on a bracket
    mb.cyl((0, -0.48, 0.7), (0, -0.62, 0.7), 0.03, 'Brass', seg=6)
    mb.gauge((0, -0.64, 0.7), FRONT, 0.13)
    mb.beam((-0.3, -0.38, 0.79), (-0.3, -0.7, 0.79), 0.04, 'Iron')
    mb.lamp((-0.3, -0.7, 0.88), 0.06)
    # secondary drip collector: small sight gauge on the column
    mb.cyl((-0.16, -0.05, 1.45), (-0.16, -0.05, 1.95), 0.05, 'Glass', seg=8)
    mb.cyl((-0.16, -0.05, 1.45), (-0.16, -0.05, 1.7), 0.035, 'Water', seg=8)
    for z in (1.42, 1.98):
        mb.cyl((-0.16, -0.05, z - 0.03), (-0.16, -0.05, z + 0.03), 0.065, 'Brass', seg=8)
    body = mb.build('condenser')

    # rotor: open turbine cowl -- six twisted curved vanes between a ring and a dome, with a finial
    rm = MB()
    h0, h1, R = 0.05, 0.72, 0.64
    rm.lathe([(0.12, 0), (R, 0), (R, h0), (0.12, h0)], 'Brass', seg=12)
    rm.lathe([(R + 0.02, h1), (0.45, h1 + 0.14), (0.12, h1 + 0.2), (0, h1 + 0.21)], 'Verdigris', seg=12)
    rm.cyl((0, 0, h1 - 0.03), (0, 0, h1), R + 0.02, 'Brass', seg=12)
    rm.cyl((0, 0, 0), (0, 0, h1), 0.08, 'Iron', seg=8)
    for k in range(6):
        a0 = k * math.pi / 3
        mat = 'PaintRed' if k % 3 == 0 else 'PaintTeal'
        cols = []
        for s in range(4):
            t = s / 3
            r = 0.1 + t * (R - 0.12)
            row = []
            for zz, tw in ((h0, 0.0), (h1 - 0.03, 0.45)):
                ang = a0 + t * 1.1 + tw
                row.append((math.cos(ang) * r, math.sin(ang) * r, zz))
            cols.append(row)
        for s in range(3):
            rm.face([cols[s][0], cols[s + 1][0], cols[s + 1][1], cols[s][1]], mat)
    # finial spike + little pennant
    rm.cyl((0, 0, h1 + 0.2), (0, 0, h1 + 0.6), 0.025, 'Brass', r1=0.012, seg=6)
    rm.sphere((0, 0, h1 + 0.3), 0.05, 'Brass', u=8, v=4)
    rm.slab([(0.0, 0, h1 + 0.52), (0.0, 0, h1 + 0.4), (0.22, 0, h1 + 0.46)], FRONT, 0.008, 'PaintRed')
    for k in range(8):
        a = 2 * math.pi * (k + 0.5) / 8
        d = Vector((math.cos(a), math.sin(a), 0))
        rm.rivet(d * R + Vector((0, 0, h0 / 2)), d, 0.02)
    rotor = rm.build('condenser_rotor', origin=(0, 0, 5.78))
    attach(rotor, body)
    return body


# =================================================================================================
# 2. tank
# =================================================================================================
def build_tank():
    mb = MB()
    R = 1.18
    z0, z1 = 0.8, 2.65
    # legs + braces
    legs = []
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        d = Vector((math.cos(a), math.sin(a), 0))
        legs.append(d)
        mb.beam(d * 0.98, d * 0.88 + Vector((0, 0, z0 + 0.1)), 0.11, 'Iron', phase=a)
        mb.box(d * 0.98 + Vector((0, 0, 0.025)), (0.24, 0.24, 0.05), 'Iron', rot=Matrix.Rotation(a, 3, 'Z'))
    for k in range(4):
        a, b = legs[k], legs[(k + 1) % 4]
        mb.beam(a * 0.96 + Vector((0, 0, 0.15)), b * 0.9 + Vector((0, 0, 0.75)), 0.05, 'Rust')
        mb.beam(a * 0.93 + Vector((0, 0, 0.45)), b * 0.93 + Vector((0, 0, 0.45)), 0.05, 'Iron')
    # bottom dish + shell
    mb.lathe([(0, z0 - 0.08), (R * 0.9, z0 - 0.02), (R, z0)], 'Iron', seg=16)
    mb.lathe([(R, z0), (R, z1)], 'Verdigris', seg=16)
    # conical roof with hatch and vent
    mb.lathe([(R, z1), (R + 0.04, z1 + 0.02), (0.3, 2.92), (0, 2.92)], 'Rust', seg=16)
    mb.cyl((0.0, 0.0, 2.88), (0.0, 0.0, 2.98), 0.28, 'Iron', seg=10)
    mb.cyl((0.35, 0.35, 2.7), (0.35, 0.35, 3.0), 0.06, 'Copper', seg=8)
    mb.cyl((0.35, 0.35, 3.0), (0.35, 0.35, 3.05), 0.11, 'Brass', r1=0.03, seg=8)
    # riveted brass bands
    for z in (z0 + 0.06, 1.45, 2.05, z1 - 0.04):
        mb.torus((0, 0, z), Z, R + 0.015, 0.03, 'Brass', seg=16, sides=4)
    for z in (1.45, 2.05):
        for k in range(16):
            a = 2 * math.pi * (k + 0.5) / 16
            d = Vector((math.cos(a), math.sin(a), 0))
            mb.rivet(d * (R + 0.04) + Vector((0, 0, z)), d, 0.022)
    # vertical seam strip with rivets (front-left)
    a = math.radians(-125)
    d = Vector((math.cos(a), math.sin(a), 0))
    mb.box(d * (R + 0.005) + Vector((0, 0, (z0 + z1) / 2)), (0.03, 0.08, z1 - z0), 'Copper',
           rot=Matrix.Rotation(a, 3, 'Z'))
    for i in range(7):
        mb.rivet(d * (R + 0.02) + Vector((0, 0, z0 + 0.2 + i * 0.26)), d, 0.02)
    # ladder on the front (game +Z = Blender -Y)
    ly = -(R + 0.08)
    for x in (-0.2, 0.2):
        mb.beam((x, ly, 0.0), (x, ly, 3.0), 0.045, 'Iron')
        mb.beam((x, ly + 0.02, 2.9), (x, -0.95, 2.85), 0.035, 'Iron')  # hook over the roof edge
    for i in range(11):
        z = 0.3 + i * 0.26
        mb.cyl((-0.2, ly, z), (0.2, ly, z), 0.016, 'Rust', seg=4, caps=False)
    # level gauge glass at front-right, brass fittings, water column inside
    a = math.radians(-50)
    d = Vector((math.cos(a), math.sin(a), 0))
    gp = d * (R + 0.07)
    for z in (1.0, 2.45):
        mb.cyl(d * (R - 0.02) + Vector((0, 0, z)), gp + Vector((0, 0, z)), 0.025, 'Brass', seg=6)
        mb.cyl(gp + Vector((0, 0, z - 0.05)), gp + Vector((0, 0, z + 0.05)), 0.05, 'Brass', seg=8)
    mb.cyl(gp + Vector((0, 0, 1.05)), gp + Vector((0, 0, 2.4)), 0.035, 'Glass', seg=8, caps=False)
    mb.cyl(gp + Vector((0, 0, 1.05)), gp + Vector((0, 0, 1.85)), 0.022, 'Water', seg=6)
    for z in (1.3, 1.6, 1.9, 2.2):  # level marks
        mb.box(gp + d * 0.045 + Vector((0, 0, z)), (0.012, 0.06, 0.012), 'Brass', rot=Matrix.Rotation(a, 3, 'Z'))
    # outlet: from the bottom dish down, out to the front-right with a valve wheel
    pipe_path(mb, [(0, 0, z0 - 0.08), (0, 0, 0.45), (0.45, -0.75, 0.45), (0.6, -1.0, 0.45)], 0.06,
              'Copper', elbow_mat='Brass')
    mb.flange((0.6, -1.0, 0.45), Vector((0.6, -1.0, 0)) - Vector((0.45, -0.75, 0)), 0.11, 0.04, bolts=5)
    mb.cyl((0.34, -0.57, 0.45), (0.34, -0.57, 0.66), 0.04, 'Brass', seg=6)
    mb.cyl((0.34, -0.57, 0.38), (0.34, -0.57, 0.52), 0.09, 'Brass', seg=8)
    mb.valve_wheel((0.34, -0.57, 0.68), Z, 0.16)
    # pipe stubs with flanges: side inlet (+X) and back (+Y)
    for a, z in ((0.0, 1.15), (math.pi / 2, 2.3), (math.pi, 1.8)):
        d = Vector((math.cos(a), math.sin(a), 0))
        mb.cyl(d * (R - 0.02) + Vector((0, 0, z)), d * (R + 0.08) + Vector((0, 0, z)), 0.07, 'Copper', seg=8)
        mb.flange(d * (R + 0.09) + Vector((0, 0, z)), d, 0.12, 0.035, bolts=6)
    # gauge near the top on the front-left
    a = math.radians(-112)
    d = Vector((math.cos(a), math.sin(a), 0))
    mb.gauge(d * (R + 0.02) + Vector((0, 0, 2.35)), d, 0.1)
    return mb.build('tank')


# =================================================================================================
# 3. windpump
# =================================================================================================
def build_windpump():
    mb = MB()
    top = 7.2
    hb, ht = 1.02, 0.26  # half-width at base / top

    def corner(k, z):
        h = hb + (ht - hb) * z / top
        sx = 1 if k in (0, 3) else -1
        sy = 1 if k in (0, 1) else -1
        return Vector((sx * h, sy * h, z))

    levels = [0.0, 1.9, 3.5, 4.8, 5.9, 6.6, top]
    for k in range(4):
        mb.beam(corner(k, 0), corner(k, top), 0.09, 'Iron')
        c = corner(k, 0)
        mb.box((c.x, c.y, 0.06), (0.3, 0.3, 0.12), 'Stone')  # footing block
    for li, z in enumerate(levels[1:], 1):
        for k in range(4):
            mb.beam(corner(k, z), corner((k + 1) % 4, z), 0.05, 'Iron')
    for li in range(len(levels) - 1):
        za, zb = levels[li], levels[li + 1]
        for k in range(4):
            j = (k + 1) % 4
            mb.beam(corner(k, za), corner(j, zb), 0.035, 'Rust')
            mb.beam(corner(j, za), corner(k, zb), 0.035, 'Rust')
    # top platform (wood planks) and head turntable
    mb.box((0, 0, top + 0.04), (0.8, 0.8, 0.06), 'Wood')
    mb.cyl((0, 0, top + 0.07), (0, 0, top + 0.3), 0.18, 'Brass', seg=10)
    mb.torus((0, 0, top + 0.15), Z, 0.2, 0.025, 'Iron', seg=10, sides=4)
    # gearbox housing: horizontal brass drum along Y with riveted end caps
    hub_z = top + 0.55
    mb.cyl((0, 0.35, hub_z), (0, -0.3, hub_z), 0.24, 'Brass', seg=12)
    mb.lathe([(0.24, 0), (0.18, 0.08), (0, 0.1)], 'Copper', seg=12, m=frame((0, 1, 0), (0, 0.35, hub_z)))
    for yy in (-0.3, 0.33):
        mb.torus((0, yy, hub_z), (0, 1, 0), 0.245, 0.025, 'Iron', seg=12, sides=4)
    mb.cyl((0, -0.3, hub_z), (0, -0.62, hub_z), 0.06, 'Iron', seg=8)  # main shaft to the rotor hub
    # crank/pitman box under the head, pump rod down the tower centre
    mb.box((0, 0.05, top + 0.3), (0.2, 0.3, 0.18), 'Iron')
    mb.cyl((0, 0.05, 0.75), (0, 0.05, top + 0.25), 0.022, 'Iron', seg=6)
    for z in (1.9, 3.5, 4.8, 5.9):  # guide bushings
        mb.cyl((0, 0.05, z - 0.05), (0, 0.05, z + 0.05), 0.05, 'Brass', seg=6)
        mb.beam((-hb - (ht - hb) * z / top + 0.05, 0.05, z), (hb + (ht - hb) * z / top - 0.05, 0.05, z),
                0.03, 'Iron')
    # tail boom + vane, pointing back (+Y)
    mb.beam((0, 0.3, hub_z + 0.05), (0, 2.2, hub_z + 0.25), 0.06, 'Iron')
    mb.beam((0, 0.3, hub_z - 0.12), (0, 1.6, hub_z + 0.22), 0.04, 'Iron')
    vane = [(0, 1.55, hub_z - 0.2), (0, 2.45, hub_z - 0.45), (0, 2.6, hub_z + 0.85), (0, 1.75, hub_z + 0.55)]
    mb.slab(vane, (1, 0, 0), 0.02, 'PaintTeal')
    stripe = [(0, 2.05, hub_z - 0.32), (0, 2.25, hub_z - 0.38), (0, 2.4, hub_z + 0.78), (0, 2.2, hub_z + 0.72)]
    mb.slab([Vector(p) + Vector((0.012, 0, 0)) for p in stripe], (1, 0, 0), 0.006, 'PaintRed')
    mb.slab([Vector(p) - Vector((0.012, 0, 0)) for p in stripe], (1, 0, 0), 0.006, 'PaintRed')
    for p in ((0, 1.7, hub_z - 0.1), (0, 1.9, hub_z + 0.55), (0, 2.45, hub_z - 0.3), (0, 2.5, hub_z + 0.75)):
        mb.rivet(Vector(p) + Vector((0.01, 0, 0)), (1, 0, 0), 0.025)
        mb.rivet(Vector(p) - Vector((0.01, 0, 0)), (-1, 0, 0), 0.025)
    # pump housing at the base: plinth, cylinder, spout, pressure dome
    mb.box((0, 0.05, 0.08), (0.6, 0.6, 0.16), 'Stone')
    mb.cyl((0, 0.05, 0.16), (0, 0.05, 0.75), 0.17, 'Verdigris', seg=10)
    for z in (0.2, 0.7):
        mb.torus((0, 0.05, z), Z, 0.175, 0.025, 'Brass', seg=10, sides=4)
    mb.cyl((0, 0.05, 0.75), (0, 0.05, 0.82), 0.2, 'Brass', seg=10)
    mb.lathe([(0.1, 0.0), (0.1, 0.25), (0.06, 0.38), (0, 0.4)], 'Copper', seg=10,
             m=Matrix.Translation((0.22, 0.12, 0.25)))
    mb.cyl((0.12, 0.12, 0.45), (0.22, 0.12, 0.45), 0.04, 'Copper', seg=6)
    pipe_path(mb, [(0, -0.12, 0.55), (0, -0.45, 0.55), (0, -0.55, 0.4)], 0.05, 'Copper', elbow_mat='Brass')
    mb.cyl((0, -0.6, 0.0), (0, -0.6, 0.22), 0.2, 'Iron', r1=0.24, seg=10)  # drip bucket
    mb.cyl((0, -0.6, 0.2), (0, -0.6, 0.21), 0.2, 'Water', seg=10)
    mb.gauge((-0.17, 0.05, 0.5), (-1, 0, 0), 0.08)
    body = mb.build('windpump')

    # rotor: multi-blade fan facing the front (Blender -Y = game +Z), axis along Blender Y
    rm = MB()
    hub_y = -0.65
    nblades = 16
    r_in, r_out = 0.32, 1.55
    rm.cyl((0, 0.04, 0), (0, -0.12, 0), 0.16, 'Brass', seg=10)
    rm.lathe([(0.16, 0), (0.12, 0.1), (0.05, 0.2), (0, 0.24)], 'Copper', seg=10, m=frame((0, -1, 0), (0, -0.12, 0)))
    for k in range(nblades):
        a = 2 * math.pi * k / nblades
        u = Vector((math.cos(a), 0, math.sin(a)))  # radial in XZ plane
        t = Vector((-math.sin(a), 0, math.cos(a)))  # tangential
        pitch = math.radians(28)
        mat = 'PaintRed' if k % 4 == 0 else 'Canvas'
        pts = []
        for s, r in enumerate((r_in, (r_in + r_out) / 2, r_out)):
            w = 0.1 + 0.17 * (r - r_in) / (r_out - r_in)
            tw = pitch + math.radians(10) * (1 - s / 2)
            chord = t * math.cos(tw) + Vector((0, 1, 0)) * math.sin(tw)
            c = u * r
            pts.append((c - chord * w, c + chord * w))
        for s in range(2):
            rm.face([pts[s][0], pts[s][1], pts[s + 1][1], pts[s + 1][0]], mat)
        # spoke
        rm.beam(u * 0.14, u * r_in, 0.03, 'Iron')
    # inner and outer tie rings (thin polygon bands)
    rm.torus((0, 0, 0), (0, -1, 0), r_out - 0.02, 0.025, 'Iron', seg=nblades, sides=4)
    rm.torus((0, 0, 0), (0, -1, 0), (r_in + r_out) / 2, 0.02, 'Iron', seg=nblades, sides=4)
    rm.torus((0, 0, 0), (0, -1, 0), r_in, 0.02, 'Iron', seg=nblades, sides=4)
    rotor = rm.build('windpump_rotor', origin=(0, hub_y, hub_z))
    attach(rotor, body)
    return body


# =================================================================================================
# 4. pipe_run
# =================================================================================================
def build_pipe_run():
    mb = MB()
    zc, r = 0.4, 0.085
    X = Vector((1, 0, 0))
    mb.cyl((-1.97, 0, zc), (-0.04, 0, zc), r, 'Verdigris', seg=12, caps=False)
    mb.cyl((0.04, 0, zc), (1.97, 0, zc), r, 'Verdigris', seg=12, caps=False)
    for x in (-1.964, 1.964):
        mb.flange((x, 0, zc), X, 0.15, 0.04, bolts=6)
    mb.flange((-0.025, 0, zc), X, 0.15, 0.05, bolts=6)
    mb.flange((0.025, 0, zc), X, 0.15, 0.05, bolts=0)
    # copper bands
    for x in (-1.5, -0.7, 0.9, 1.6):
        mb.cyl((x - 0.03, 0, zc), (x + 0.03, 0, zc), r + 0.012, 'Copper', seg=12)
    # valve: brass body, bonnet, stem, handwheel
    vx = 0.7
    mb.sphere((vx, 0, zc), 0.14, 'Brass', u=10, v=6)
    mb.cyl((vx, 0, zc + 0.08), (vx, 0, zc + 0.25), 0.07, 'Brass', r1=0.05, seg=8)
    mb.cyl((vx, 0, zc + 0.25), (vx, 0, zc + 0.38), 0.018, 'Iron', seg=6)
    mb.valve_wheel((vx, 0, zc + 0.38), Z, 0.15)
    # small gauge tap
    mb.cyl((-0.6, 0, zc + 0.08), (-0.6, 0, zc + 0.24), 0.02, 'Brass', seg=6)
    mb.gauge((-0.6, 0, zc + 0.3), FRONT, 0.07)
    # stands: foot plate, post, saddle cradling the pipe
    for x in (-1.35, 1.35):
        mb.box((x, 0, 0.015), (0.22, 0.3, 0.03), 'Iron')
        mb.beam((x, 0, 0.03), (x, 0, zc - r - 0.02), 0.06, 'Iron')
        mb.lathe([(r + 0.02, -0.03), (r + 0.02, 0.03)], 'Rust', seg=12,
                 m=frame(X, (x, 0, zc)))  # strap around the pipe
        mb.box((x, 0, zc - r - 0.02), (0.08, 0.22, 0.04), 'Rust')
        for sy in (-1, 1):
            mb.beam((x, 0, 0.18), (x, sy * 0.13, 0.03), 0.035, 'Rust')
    return mb.build('pipe_run')


# =================================================================================================
# 5. solar_still
# =================================================================================================
def build_solar_still():
    mb = MB()
    hx, hy = 0.95, 0.42
    zb, zr = 0.3, 0.6  # basin top, ridge height
    # wooden basin box with iron corner brackets
    mb.box((0, 0, zb / 2), (2 * hx, 2 * hy, zb), 'Wood')
    mb.box((0, 0, zb - 0.01), (2 * hx - 0.08, 2 * hy - 0.08, 0.02), 'Soil')
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box((sx * (hx - 0.02), sy * (hy - 0.02), zb / 2), (0.08, 0.08, zb + 0.02), 'Iron')
    for z in (0.08, 0.22):  # plank seams / iron straps
        mb.box((0, -hy - 0.003, z), (2 * hx - 0.1, 0.01, 0.025), 'Iron')
        mb.box((0, hy + 0.003, z), (2 * hx - 0.1, 0.01, 0.025), 'Iron')
    # sprouts on the soil
    rng = Rng(5)
    for i in range(14):
        x = -0.78 + i * 0.12 + rng(-0.03, 0.03)
        y = rng(-0.25, 0.25)
        h = rng(0.05, 0.12)
        mb.cyl((x, y, zb), (x, y, zb + h), 0.006, 'Leaf', seg=3, caps=False)
        for s in (-1, 1):
            a = rng(0, math.pi)
            d = Vector((math.cos(a), math.sin(a), 0)) * s * 0.04
            mb.face([(x, y, zb + h), (x + d.x * 0.5 - d.y * 0.4, y + d.y * 0.5 + d.x * 0.4, zb + h + 0.02),
                     (x + d.x, y + d.y, zb + h + 0.01), (x + d.x * 0.5 + d.y * 0.4, y + d.y * 0.5 - d.x * 0.4,
                                                       zb + h - 0.01)], 'Leaf')
    # iron frame: gable posts, ridge bar, eave bars
    for x in (-hx, 0.0, hx):
        mb.beam((x, -hy, zb), (x, 0, zr), 0.03, 'Iron')
        mb.beam((x, hy, zb), (x, 0, zr), 0.03, 'Iron')
    mb.beam((-hx - 0.02, 0, zr), (hx + 0.02, 0, zr), 0.04, 'Iron')
    for sy in (-1, 1):
        mb.beam((-hx, sy * hy, zb + 0.01), (hx, sy * hy, zb + 0.01), 0.03, 'Iron')
    # glass panes (pitched roof + gable triangles)
    for sy in (-1, 1):
        mb.face([(-hx, sy * hy, zb + 0.01), (hx, sy * hy, zb + 0.01), (hx, 0, zr), (-hx, 0, zr)], 'Glass')
    for x in (-hx, hx):
        mb.face([(x, -hy, zb), (x, hy, zb), (x, 0, zr)], 'Glass')
    # copper troughs along both long edges, with an end spout
    for sy in (-1, 1):
        y = sy * (hy + 0.06)
        prof = [(-hx, y - 0.05, zb + 0.02), (-hx, y - 0.035, zb - 0.03), (-hx, y + 0.035, zb - 0.03),
                (-hx, y + 0.05, zb + 0.02)]
        a = [mb.v(p) for p in prof]
        b = [mb.v(Vector(p) + Vector((2 * hx, 0, 0))) for p in prof]
        for i in range(3):
            f = mb.bm.faces.new([a[i], a[i + 1], b[i + 1], b[i]])
            f.material_index = mb.mi('Copper')
        for vs in (a, list(reversed(b))):
            f = mb.bm.faces.new(vs)
            f.material_index = mb.mi('Copper')
        for x in (-0.6, 0.0, 0.6):
            mb.beam((x, sy * hy, zb - 0.02), (x, y, zb - 0.035), 0.015, 'Iron')
        mb.cyl((hx, y, zb - 0.01), (hx + 0.08, y, zb - 0.06), 0.02, 'Verdigris', seg=6)
    # brass ridge cap knobs
    for x in (-hx - 0.02, hx + 0.02):
        mb.sphere((x, 0, zr), 0.035, 'Brass', u=6, v=4)
    return mb.build('solar_still')


# =================================================================================================
# 6. signpost
# =================================================================================================
def build_signpost():
    mb = MB()
    H = 2.6
    # base: rock cairn
    for (x, y, r, s) in ((0.18, 0.05, 0.16, 0.7), (-0.15, 0.12, 0.14, 0.75), (0.02, -0.17, 0.15, 0.6),
                         (-0.12, -0.1, 0.11, 0.8), (0.12, 0.2, 0.1, 0.8)):
        mb.ico((x, y, r * s * 0.6), r, 'Stone', scale=(1.1, 1.0, s))
    # post: rusty I-beam made of three slabs, with a welded patch plate and a brass band
    mb.box((0, 0, H / 2), (0.05, 0.12, H), 'Rust')
    for sx in (-1, 1):
        mb.box((sx * 0.055, 0, H / 2), (0.012, 0.16, H), 'Iron')
    mb.box((0, -0.075, 1.0), (0.13, 0.012, 0.35), 'PaintTeal', rot=Matrix.Rotation(0.06, 3, 'Y'))
    for z in (0.86, 1.14):
        for x in (-0.045, 0.045):
            mb.rivet((x, -0.083, z), FRONT, 0.012)
    mb.box((0, 0, 0.45), (0.16, 0.2, 0.05), 'Brass')
    # top: cog wheel finial
    zc = H + 0.08
    mb.cyl((0, -0.03, zc), (0, 0.03, zc), 0.2, 'Brass', seg=16)
    for k in range(12):
        a = 2 * math.pi * k / 12
        d = Vector((math.cos(a), 0, math.sin(a)))
        mb.box(d * 0.23 + Vector((0, 0, zc)), (0.07, 0.05, 0.06), 'Brass', rot=Matrix.Rotation(-a, 3, 'Y'))
    mb.cyl((0, -0.04, zc), (0, 0.04, zc), 0.07, 'Iron', seg=8)
    # cross arm (riveted iron bar) with a diagonal strut
    za = H - 0.12
    mb.box((0.3, 0, za), (1.5, 0.06, 0.07), 'Iron')
    mb.beam((0.05, 0, za - 0.5), (0.6, 0, za - 0.03), 0.04, 'Rust')
    for x in (-0.38, 0.35, 0.95):
        mb.rivet((x, -0.03, za), FRONT, 0.014)
    # hanging plate: riveted brass sheet on two short chains
    px, ptop, pw, ph = 0.6, za - 0.3, 0.72, 0.5
    for x in (px - 0.27, px + 0.27):
        for i in range(3):
            z = za - 0.06 - i * 0.08
            if i % 2 == 0:
                mb.torus((x, 0, z), (0, 1, 0), 0.03, 0.007, 'Iron', seg=6, sides=3)
            else:
                mb.torus((x, 0, z), (1, 0, 0), 0.03, 0.007, 'Iron', seg=6, sides=3)
    pts = [(px - pw / 2, 0, ptop - ph), (px + pw / 2, 0, ptop - ph), (px + pw / 2 + 0.02, 0, ptop),
           (px - pw / 2 - 0.02, 0, ptop)]
    pts = [pts[0], pts[1], (px + pw / 2 + 0.03, 0, ptop - ph * 0.55), pts[2], pts[3]]
    mb.slab(pts, FRONT, 0.02, 'Brass')
    # teal painted inset panel and riveted border
    inset = [(px - pw / 2 + 0.05, 0, ptop - ph + 0.05), (px + pw / 2 - 0.05, 0, ptop - ph + 0.05),
             (px + pw / 2 - 0.05, 0, ptop - 0.05), (px - pw / 2 + 0.05, 0, ptop - 0.05)]
    for sgn in (1, -1):
        mb.slab([Vector(p) + Vector((0, sgn * 0.012, 0)) for p in inset], FRONT, 0.004, 'PaintTeal')
    for i in range(6):
        x = px - pw / 2 + 0.025 + i * (pw - 0.05) / 5
        for z in (ptop - 0.025, ptop - ph + 0.025):
            mb.rivet((x, -0.011, z), FRONT, 0.012)
            mb.rivet((x, 0.011, z), (0, 1, 0), 0.012)
    # abstract pictograph (both faces): half sun on a horizon, a sprout rising, water ripples below
    for sgn in (-1, 1):
        y = sgn * 0.016
        n = Vector((0, sgn, 0))
        cz = ptop - ph / 2 + 0.02
        hz = cz - 0.05
        mb.beam((px - 0.27, y, hz), (px + 0.27, y, hz), 0.02, 'Ink')
        sx0 = px - 0.11
        semi = [(sx0 + math.cos(a) * 0.065, y, hz + 0.012 + math.sin(a) * 0.065)
                for a in (math.pi * k / 6 for k in range(7))]
        if sgn < 0:
            semi.reverse()
        mb.slab(semi, n, 0.008, 'PaintRed')
        for k in range(5):
            a = math.pi * (k + 1) / 6
            d = Vector((math.cos(a), 0, math.sin(a)))
            c0 = Vector((sx0, y, hz + 0.012))
            mb.beam(c0 + d * 0.09, c0 + d * 0.14, 0.016, 'PaintRed')
        sx = px + 0.13
        mb.beam((sx, y, hz), (sx + 0.01, y, hz + 0.17), 0.018, 'Ink')
        for d, zz, sc in ((-1, 0.07, 1.0), (1, 0.12, 0.8)):
            leaf = [(sx, y, hz + zz), (sx + d * 0.05 * sc, y, hz + zz + 0.06 * sc),
                    (sx + d * 0.12 * sc, y, hz + zz + 0.055 * sc), (sx + d * 0.07 * sc, y, hz + zz)]
            if d * sgn > 0:
                leaf.reverse()
            mb.slab(leaf, n, 0.008, 'Leaf')
        for row, x0 in ((0, px - 0.2), (1, px - 0.1)):
            zz = hz - 0.07 - row * 0.055
            pts = [Vector((x0 + i * 0.05, y, zz + (0.015 if i % 2 else -0.015))) for i in range(6)]
            for a, b in zip(pts, pts[1:]):
                mb.beam(a, b, 0.014, 'Ink')
    # lantern hanging from the short end of the arm
    lx = -0.38
    mb.beam((lx, 0, za - 0.035), (lx, 0, za - 0.2), 0.02, 'Iron')
    mb.torus((lx, 0, za - 0.22), (0, 1, 0), 0.035, 0.008, 'Iron', seg=6, sides=3)
    lz = za - 0.42
    mb.lamp((lx, 0, lz), 0.07)
    mb.cyl((lx, 0, lz + 0.1), (lx, 0, lz + 0.17), 0.13, 'Brass', r1=0.02, seg=8)
    return mb.build('signpost')


# =================================================================================================
# 7. fence
# =================================================================================================
def build_fence():
    mb = MB()
    rng = Rng(17)
    H = 1.6
    poles = [-1.44, -0.5, 0.45, 1.44]
    for i, x in enumerate(poles):
        lean = rng(-0.04, 0.04)
        top = H + rng(-0.05, 0.08)
        mb.cyl((x, 0, 0), (x + lean, 0, top), 0.045, 'Wood', r1=0.035, seg=6)
        mb.cyl((x + lean - 0.02, 0, top), (x + lean, 0, top + 0.04), 0.05, 'Rust', seg=6)  # cap tin
    # corrugated scrap sheets: zigzag strips (double-sided materials), slightly tilted
    sheets = [  # x0, x1, z0, z1, y, material, tilt
        (-1.42, -0.42, 0.08, 0.95, -0.055, 'Rust', 0.03),
        (-0.55, 0.5, 0.05, 0.85, 0.055, 'PaintTeal', -0.04),
        (0.42, 1.42, 0.1, 0.9, -0.055, 'Iron', 0.02),
        (-1.0, -0.2, 0.85, 1.25, 0.055, 'PaintRed', -0.06),
        (0.6, 1.35, 0.95, 1.4, 0.055, 'Rust', 0.05),
    ]
    for x0, x1, z0, z1, y, mat, tilt in sheets:
        ncor = max(4, round((x1 - x0) / 0.07))
        cz = (z0 + z1) / 2
        rot = Matrix.Rotation(tilt, 3, 'Y')
        cx = (x0 + x1) / 2
        prev = None
        for i in range(ncor + 1):
            x = x0 + (x1 - x0) * i / ncor
            yy = y + (0.012 if i % 2 else -0.012)
            lo = Vector((cx, 0, cz)) + rot @ Vector((x - cx, yy, z0 - cz))
            hi = Vector((cx, 0, cz)) + rot @ Vector((x - cx, yy, z1 - cz))
            cur = (mb.v(lo), mb.v(hi))
            if prev:
                f = mb.bm.faces.new([prev[0], cur[0], cur[1], prev[1]])
                f.material_index = mb.mi(mat)
                f.smooth = False
            prev = cur
        # nail/rivet heads
        for xx in (x0 + 0.06, x1 - 0.06):
            for zz in (z0 + 0.1, z1 - 0.1):
                p = Vector((cx, 0, cz)) + rot @ Vector((xx - cx, y + math.copysign(0.015, y), zz - cz))
                mb.rivet(p, (0, math.copysign(1, y), 0), 0.012, 'Iron')
    # canvas strips woven between poles in the upper part, with sag and lashings
    for (xa, xb, z, y, w) in ((-1.44, 0.45, 1.42, 0.0, 0.16), (-0.5, 1.44, 1.15, -0.02, 0.14),
                              (-1.44, -0.5, 0.62, 0.02, 0.12)):
        n = 8
        prev = None
        for i in range(n + 1):
            t = i / n
            x = xa + (xb - xa) * t
            sag = -0.06 * math.sin(math.pi * t)
            yy = y + 0.035 * math.sin(t * math.pi * 3)
            cur = (mb.v((x, yy, z + sag - w / 2)), mb.v((x, yy, z + sag + w / 2)))
            if prev:
                f = mb.bm.faces.new([prev[0], cur[0], cur[1], prev[1]])
                f.material_index = mb.mi('Canvas')
                f.smooth = False
            prev = cur
        for x in (xa, xb):
            mb.torus((x, 0, z), Z, 0.055, 0.012, 'Canvas', seg=6, sides=3)
    # rope lashings at sheet joints
    for x in poles:
        for z in (0.3, 0.9):
            mb.torus((x, 0, z), Z, 0.05, 0.01, 'Wood', seg=6, sides=3)
    # a torn canvas flag tail flapping off the end pole
    mb.face([(1.44, 0.0, 1.5), (1.44, 0.0, 1.3), (1.5, -0.04, 1.33), (1.49, -0.03, 1.47)], 'Canvas')
    return mb.build('fence')


# =================================================================================================
def tri_count(obj):
    n = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    return n + sum(tri_count(c) for c in obj.children)


def game_bbox(obj):
    bpy.context.view_layer.update()
    pts = []

    def collect(o):
        mw = o.matrix_world
        pts.extend(mw @ v.co for v in o.data.vertices)
        for c in o.children:
            collect(c)

    collect(obj)
    xs = [p.x for p in pts]
    ys = [p.z for p in pts]  # game Y = Blender Z
    zs = [-p.y for p in pts]  # game Z = Blender -Y
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


def export(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
        for c in o.children:
            c.select_set(True)
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


def look_at(cam, target):
    d = Vector(target) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def render_preview(objs, path):
    scene = bpy.context.scene
    spacing = [0, 3.4, 4.5, 4.6, 3.6, 3.0, 3.2]
    x = -10.0
    places = []
    for o, s in zip(objs, spacing):
        x += s
        o.location.x = x
        places.append(x)
    bpy.ops.mesh.primitive_plane_add(size=120, location=(0, 0, 0))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new('ground')
    gm.use_nodes = True
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.62, 0.30, 0.10, 1)
    gm.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.95
    ground.data.materials.append(gm)

    cam_data = bpy.data.cameras.new('cam')
    cam_data.lens = 35
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    sun_data = bpy.data.lights.new('sun', 'SUN')
    sun_data.energy = 4.5
    sun_data.color = (1.0, 0.8, 0.6)
    sun_data.angle = math.radians(2)
    sun = bpy.data.objects.new('sun', sun_data)
    sun.rotation_euler = (math.radians(55), 0, math.radians(-30))
    scene.collection.objects.link(sun)
    world = bpy.data.worlds.new('world')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (0.75, 0.5, 0.32, 1)
    bg.inputs['Strength'].default_value = 0.9
    for engine in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT', 'BLENDER_WORKBENCH'):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.view_settings.view_transform = 'AgX'
    scene.render.resolution_x = 1800
    scene.render.resolution_y = 900
    cx = (places[0] + places[-1]) / 2
    cam.location = (cx, -26, 6.0)
    look_at(cam, (cx, 0, 3.0))
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)

    scene.render.resolution_x = 1000
    scene.render.resolution_y = 1000
    cam_data.lens = 50
    for o, px in zip(objs, places):
        (mnx, mny, mnz), (mxx, mxy, mxz) = game_bbox(o)
        size = max(mxx - mnx, mxy - mny, mxz - mnz)
        cy = (mny + mxy) / 2
        for tag, az in (('front', -30), ('back', 150)):
            a = math.radians(az)
            d = size * 1.25 + 0.6
            cam.location = (px + math.sin(a) * d, -math.cos(a) * d, cy + size * 0.35)
            look_at(cam, (px, 0, cy))
            scene.render.filepath = path.replace('.png', f'_{o.name}_{tag}.png')
            bpy.ops.render.render(write_still=True)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models', 'base', 'exterior.glb'))
    ap.add_argument('--preview', default=None)
    ap.add_argument('--only', default=None, help='preview close-ups only for this node')
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    make_materials()
    objs = [build_condenser(), build_tank(), build_windpump(), build_pipe_run(), build_solar_still(),
            build_signpost(), build_fence()]
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    export(objs, args.out)
    for o in objs:
        (a, b) = game_bbox(o)
        kids = ', '.join(f'{c.name} pivot(game)=({c.location.x:.2f}, {c.location.z:.2f}, {-c.location.y:.2f})'
                         for c in o.children)
        print(f'NODE {o.name}: tris={tri_count(o)} bbox game min=({a[0]:.2f}, {a[1]:.2f}, {a[2]:.2f}) '
              f'max=({b[0]:.2f}, {b[1]:.2f}, {b[2]:.2f}) {kids}')
    print(f'WROTE {args.out} {os.path.getsize(args.out) / 1024:.1f} KiB')
    if args.preview:
        if args.only:
            objs = [o for o in objs if o.name == args.only] + [o for o in objs if o.name != args.only]
        render_preview(objs, os.path.abspath(args.preview))


main()
