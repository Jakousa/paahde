"""Home-base architecture shell: domed adobe hall + iron-and-glass greenhouse wing, exported as one glTF.

    blender -b --python tools/blender/base/shell.py                          # writes public/models/base/shell.glb
    blender -b --python tools/blender/base/shell.py -- --preview /tmp/shell  # also renders /tmp/shell_*.png

Coordinates below are in the GAME frame (X right, Y up, Z toward the viewer); `G()` maps them to Blender's
Z-up frame (game (x, y, z) = Blender (x, -z, y)) and the glTF exporter maps them back. Units are metres.
Origin = centre of the main hall, on the floor surface (floor top at y = 0).

Collision-relevant dimensions (keep in sync with the game):
  hall wall      inner r 7.0, outer r 7.6, top y 4.2; dome peak y ~8.2, oculus r 1.2
  front door     x in [-1.2, 1.2], y < 3.0, centred on +Z
  greenhouse gap z in [-1.5, 1.5], y < 3.2, centred on -X
  greenhouse     outer x in [-21.0, hall], z in [-4.0, 4.0]; knee wall 0.3 thick, 0.8 tall; vault ridge y 5.5
  rear door      z in [-1.0, 1.0], y < 2.8, in the end wall at x = -21

Everything is deterministic (no random module, a tiny LCG + hash noise), so re-running gives the same file.
"""

import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

sys.dont_write_bytecode = True  # no __pycache__ next to the scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from coplanar import separate_coplanar  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
OUT = os.path.join(ROOT, 'public', 'models', 'base', 'shell.glb')
TAU = 2 * math.pi
DEG = math.pi / 180

# ---------------------------------------------------------------------------------------------- dimensions
R_IN, R_OUT, WALL_H = 7.0, 7.6, 4.2
DOME_H_OUT, DOME_H_IN = 4.0, 3.7  # dome rises from y=4.2 to 8.2 (outer) / 7.9 (inner)
OCULUS_R = 1.2
DOOR_HW, DOOR_H = 1.2, 3.0
GH_HW, GH_H = 1.5, 3.2
GH_X0, GH_Z = -21.0, 4.0
KNEE_T, KNEE_H = 0.3, 0.8
VAULT_Y, VAULT_A, VAULT_B = 3.25, 3.85, 2.25  # ellipse centre height, half-span (glass plane), rise
REAR_HW, REAR_H = 1.0, 2.8
PORTHOLES = [42, 100, 175, 230, 320]  # degrees, measured from +Z towards +X
PORTHOLE_Y, PORTHOLE_R = 2.2, 0.3
EXT_PIPES = [65, 140, 215]


def G(p):
    return Vector((p[0], -p[2], p[1]))


def game(b):
    return Vector((b[0], b[2], -b[1]))


def V(x, y, z):
    return Vector((x, y, z))


def radial(th):
    return V(math.sin(th), 0, math.cos(th))


def tangent(th):
    return V(math.cos(th), 0, -math.sin(th))


def clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def smoothstep(e0, e1, x):
    t = clamp((x - e0) / (e1 - e0))
    return t * t * (3 - 2 * t)


def hexrgb(h):
    return tuple(((h >> s) & 0xFF) / 255 for s in (16, 8, 0))


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def to_lin(c):
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


class Rng:
    def __init__(self, seed):
        self.s = seed * 2654435761 % 2**32 or 1

    def __call__(self, a=0.0, b=1.0):
        self.s = (1664525 * self.s + 1013904223) % 2**32
        return a + (b - a) * self.s / 2**32


def _hash(ix, iy, iz):
    n = math.sin(ix * 127.1 + iy * 311.7 + iz * 74.7) * 43758.5453
    return n - math.floor(n)


def vnoise(x, y, z):
    ix, iy, iz = math.floor(x), math.floor(y), math.floor(z)
    fx, fy, fz = x - ix, y - iy, z - iz
    fx, fy, fz = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy), fz * fz * (3 - 2 * fz)

    def L(a, b, t):
        return a + (b - a) * t

    c = [[[_hash(ix + i, iy + j, iz + k) for k in (0, 1)] for j in (0, 1)] for i in (0, 1)]
    return L(L(L(c[0][0][0], c[0][0][1], fz), L(c[0][1][0], c[0][1][1], fz), fy),
             L(L(c[1][0][0], c[1][0][1], fz), L(c[1][1][0], c[1][1][1], fz), fy), fx)


# ----------------------------------------------------------------------------------------------- materials
PAL = {
    'Plaster': dict(c=0xffffff, rough=0.95, vcol=True),
    'Stone': dict(c=0xffffff, rough=0.9, vcol=True),
    'Dirt': dict(c=0xffffff, rough=1.0, vcol=True),
    'Gravel': dict(c=0xffffff, rough=0.95, vcol=True),
    'Wood': dict(c=0x7a5a3a, rough=0.8),
    'Brass': dict(c=0xa8844e, rough=0.4, metal=0.6),
    'BrassDark': dict(c=0x7d6236, rough=0.5, metal=0.6),
    'Copper': dict(c=0xb0683a, rough=0.45, metal=0.6),
    'Verdigris': dict(c=0x5f9c8a, rough=0.8, metal=0.1),
    'Iron': dict(c=0x3a3430, rough=0.7, metal=0.5),
    'SheetMetal': dict(c=0x6a5444, rough=0.75, metal=0.4),
    'Canvas': dict(c=0xd8c8a8, rough=0.95, double=True),
    'CanvasStripe': dict(c=0xa5532f, rough=0.95, double=True),
    'GaugeFace': dict(c=0xe8dcc0, rough=0.5),
    'Glass': dict(c=0xcfe6df, rough=0.05, alpha=0.25, double=True),
    'Emit_Lamp': dict(c=0xffb35a, rough=0.4, emit=3.0),
}
MAT = {}


def make_materials():
    for name, d in PAL.items():
        m = bpy.data.materials.new(name)
        rgb = to_lin(hexrgb(d['c']))
        m.diffuse_color = (*rgb, d.get('alpha', 1.0))
        nt = m.node_tree
        bsdf = nt.nodes.get('Principled BSDF')
        bsdf.inputs['Base Color'].default_value = (*rgb, 1)
        bsdf.inputs['Roughness'].default_value = d['rough']
        bsdf.inputs['Metallic'].default_value = d.get('metal', 0.0)
        if d.get('vcol'):
            vc = nt.nodes.new('ShaderNodeVertexColor')
            vc.layer_name = 'Col'
            nt.links.new(vc.outputs['Color'], bsdf.inputs['Base Color'])
        if 'alpha' in d:
            bsdf.inputs['Alpha'].default_value = d['alpha']
            m.surface_render_method = 'BLENDED'
            try:
                m.blend_method = 'BLEND'
            except Exception:  # noqa: BLE001
                pass
        if 'emit' in d:
            bsdf.inputs['Emission Color'].default_value = (*rgb, 1)
            bsdf.inputs['Emission Strength'].default_value = d['emit']
        m.use_backface_culling = not d.get('double', False)
        MAT[name] = m


# ------------------------------------------------------------------------------------------- mesh building
def newell(cos):
    n = Vector((0, 0, 0))
    for i, a in enumerate(cos):
        b = cos[(i + 1) % len(cos)]
        n.x += (a.y - b.y) * (a.z + b.z)
        n.y += (a.z - b.z) * (a.x + b.x)
        n.z += (a.x - b.x) * (a.y + b.y)
    return n


class Part:
    """One output mesh object. Faces are oriented by a hint direction (game frame)."""

    def __init__(self, name, smooth_angle=35):
        self.name = name
        self.bm = bmesh.new()
        self.mats = []
        self.smooth_angle = smooth_angle
        self.fcols = []

    def mi(self, m):
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def v(self, p):
        return self.bm.verts.new(G(p))

    def face(self, verts, mat, hint=None, cols=None):
        if hint is not None and newell([v.co for v in verts]).dot(G(hint)) < 0:
            verts = verts[::-1]
            cols = cols[::-1] if cols else cols
        f = self.bm.faces.new(verts)
        f.material_index = self.mi(mat)
        if cols:
            self.fcols.append((f, cols))
        return f

    def build(self, parent=None):
        separate_coplanar(self.bm)
        mesh = bpy.data.meshes.new(self.name)
        if self.fcols:
            lay = self.bm.loops.layers.float_color.new('Col')
            for f in self.bm.faces:
                for lp in f.loops:
                    lp[lay] = (1, 1, 1, 1)
            for f, cols in self.fcols:
                for lp, c in zip(f.loops, cols):
                    lp[lay] = (*to_lin(c), 1)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for m in self.mats:
            mesh.materials.append(MAT[m])
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        if parent:
            obj.parent = parent
        obj['smooth_angle'] = self.smooth_angle
        return obj


def finalize(obj):
    ang = obj.get('smooth_angle', 35) * DEG
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) != 2:
            e.smooth = False
        else:
            try:
                e.smooth = e.calc_face_angle() <= ang
            except ValueError:
                e.smooth = False
    bm.to_mesh(obj.data)
    bm.free()


def paint(obj, fn):
    """Per-corner colours from fn(material_name, game_pos, game_normal) -> sRGB tuple."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    lay = bm.loops.layers.float_color.get('Col') or bm.loops.layers.float_color.new('Col')
    names = [m.name for m in obj.data.materials]
    for f in bm.faces:
        n = game(f.normal)
        for lp in f.loops:
            c = fn(names[f.material_index], game(lp.vert.co), n)
            lp[lay] = (*to_lin(c), 1) if c else (1, 1, 1, 1)
    bm.to_mesh(obj.data)
    bm.free()


def boolean_cut(obj, cutters):
    for c in cutters:
        mod = obj.modifiers.new('cut', 'BOOLEAN')
        mod.operation = 'DIFFERENCE'
        mod.solver = 'EXACT'
        mod.object = c
        c.hide_render = True
    dg = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    old = obj.data
    obj.modifiers.clear()
    obj.data = mesh
    bpy.data.meshes.remove(old)
    mesh.name = obj.name
    for c in cutters:
        m = c.data
        bpy.data.objects.remove(c)
        bpy.data.meshes.remove(m)


# primitives -------------------------------------------------------------------------------------------
def obox(P, c, ax, ay, az, hx, hy, hz, mat):
    corners = {}
    for i in (-1, 1):
        for j in (-1, 1):
            for k in (-1, 1):
                corners[i, j, k] = P.v(c + ax * (i * hx) + ay * (j * hy) + az * (k * hz))
    for axis, d in ((0, ax), (1, ay), (2, az)):
        for s in (-1, 1):
            q = []
            for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                key = [a, b]
                key.insert(axis, s)
                q.append(corners[tuple(key)])
            P.face(q, mat, hint=d * s)


def abox(P, x0, x1, y0, y1, z0, z1, mat):
    obox(P, V((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), V(1, 0, 0), V(0, 1, 0), V(0, 0, 1),
         (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2, mat)


def rbox(P, th, r0, r1, y0, y1, w, mat):
    """Box on the hall wall: radial extent r0..r1 at angle th, height y0..y1, tangential width w."""
    c = radial(th) * ((r0 + r1) / 2) + V(0, (y0 + y1) / 2, 0)
    obox(P, c, radial(th), V(0, 1, 0), tangent(th), (r1 - r0) / 2, (y1 - y0) / 2, w / 2, mat)


def seg_box(P, a, b, w, h, mat, up=V(0, 1, 0)):
    """Box beam from point a to b, width w (sideways) and height h (along `up`)."""
    d = b - a
    ax = d.normalized()
    side = ax.cross(up)
    if side.length < 1e-6:
        side = ax.cross(V(1, 0, 0))
    side.normalize()
    upv = side.cross(ax).normalized()
    obox(P, (a + b) / 2, ax, upv, side, d.length / 2, h / 2, w / 2, mat)


def perp(t):
    ref = V(0, 1, 0) if abs(t.y) < 0.9 else V(1, 0, 0)
    return (ref - t * ref.dot(t)).normalized()


def tube(P, pts, r, sides, mat, closed=False, caps=True, phase=0.0, n0=None):
    n = len(pts)
    T = []
    for i in range(n):
        if closed:
            t = pts[(i + 1) % n] - pts[i - 1]
        else:
            t = pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]
        T.append(t.normalized())
    N = []
    cur = n0.normalized() if n0 is not None else perp(T[0])
    for i in range(n):
        cur = (cur - T[i] * cur.dot(T[i]))
        if cur.length < 1e-6:
            cur = perp(T[i])
        cur.normalize()
        N.append(cur.copy())
    rings = []
    for i in range(n):
        B = T[i].cross(N[i])
        rings.append([P.v(pts[i] + (N[i] * math.cos(a) + B * math.sin(a)) * r)
                      for a in (phase + TAU * k / sides for k in range(sides))])
    segs = n if closed else n - 1
    for i in range(segs):
        i2 = (i + 1) % n
        mid = (pts[i] + pts[i2]) / 2
        for k in range(sides):
            k2 = (k + 1) % sides
            q = [rings[i][k], rings[i][k2], rings[i2][k2], rings[i2][k]]
            cen = sum((game(v.co) for v in q), Vector()) / 4
            P.face(q, mat, hint=cen - mid)
    if caps and not closed:
        P.face(rings[0], mat, hint=-T[0])
        P.face(rings[-1], mat, hint=T[-1])


def cyl(P, c, axis, r, h, sides, mat, phase=0.0):
    a = axis.normalized()
    tube(P, [c - a * (h / 2), c + a * (h / 2)], r, sides, mat, phase=phase)


def ring_rect(P, c, axis, r_in, r_out, depth, sides, mat, a0=0.0, a1=TAU, n0=None):
    """Annulus with rectangular section around `axis` (a flat washer / rim / band)."""
    prof = [(r_in, -depth / 2), (r_out, -depth / 2), (r_out, depth / 2), (r_in, depth / 2)]
    revolve(P, c, axis, prof, a0, a1, sides, mat, ref=n0)


def revolve(P, c, axis, prof, a0, a1, seg, mat, ref=None):
    """Revolve a convex (radial, axial) profile around `axis` through c, angles a0..a1 from `ref`."""
    axis = axis.normalized()
    ref = (ref if ref is not None else perp(axis)).normalized()
    side = axis.cross(ref)
    full = abs((a1 - a0) - TAU) < 1e-6
    count = seg if full else seg + 1

    def d(a):
        return ref * math.cos(a) + side * math.sin(a)

    rings = []
    for k in range(count):
        a = a0 + (a1 - a0) * k / seg
        rings.append([P.v(c + d(a) * rr + axis * ax) for rr, ax in prof])
    pr = sum(p[0] for p in prof) / len(prof)
    pa = sum(p[1] for p in prof) / len(prof)
    m = len(prof)
    for k in range(seg):
        k2 = (k + 1) % count
        am = a0 + (a1 - a0) * (k + 0.5) / seg
        inside = c + d(am) * pr + axis * pa
        for j in range(m):
            j2 = (j + 1) % m
            q = [rings[k][j], rings[k][j2], rings[k2][j2], rings[k2][j]]
            cen = sum((game(v.co) for v in q), Vector()) / 4
            P.face(q, mat, hint=cen - inside)
    if not full:
        P.face(rings[0], mat, hint=-axis.cross(d(a0)))
        P.face(rings[-1], mat, hint=axis.cross(d(a1)))


def rivet(P, pos, n, r=0.032, mat='Brass', sides=4):
    n = n.normalized()
    u = perp(n)
    w = n.cross(u)
    base = pos - n * 0.006
    ring = [P.v(base + (u * math.cos(a) + w * math.sin(a)) * r) for a in (TAU * k / sides for k in range(sides))]
    apex = P.v(pos + n * r * 0.75)
    for k in range(sides):
        tri = [ring[k], ring[(k + 1) % sides], apex]
        cen = sum((game(v.co) for v in tri), Vector()) / 3
        P.face(tri, mat, hint=cen - (pos - n * r))


# ------------------------------------------------------------------------------------- revolved surfaces
class RevSurf:
    """A ring-by-ring surface of revolution (full circle) with optional per-vertex radial displacement.

    pt(th, t) returns the point on the actual faceted surface at angle th and continuous row index t,
    so decals (streaks, patches, ribs) can sit a fixed small distance above it.
    """

    def __init__(self, seg, rows, disp=None):
        self.seg, self.rows, self.d = seg, rows, TAU / seg
        self.P = []
        for k in range(seg):
            th = k * self.d
            col = []
            for j, (r, y) in enumerate(rows):
                rr = disp(th, r, y, j) if disp else r
                col.append(V(rr * math.sin(th), y, rr * math.cos(th)))
            self.P.append(col)

    def pt(self, th, t):
        th %= TAU
        k = int(th / self.d) % self.seg
        k2 = (k + 1) % self.seg
        dx, dz = math.sin(th), math.cos(th)

        def row(j):
            a, b = self.P[k][j], self.P[k2][j]
            ex, ez = b.x - a.x, b.z - a.z
            s = -(a.x * dz - a.z * dx) / (ex * dz - ez * dx)
            return a + (b - a) * s

        n = len(self.rows)
        t = clamp(t, 0, n - 1)
        j = min(int(t), n - 2)
        return row(j).lerp(row(j + 1), t - j)

    def t_at_y(self, y):
        ys = [r[1] for r in self.rows]
        for j in range(len(ys) - 1):
            if ys[j] <= y <= ys[j + 1]:
                return j + (y - ys[j]) / (ys[j + 1] - ys[j])
        return 0 if y < ys[0] else len(ys) - 1


WALL_ROWS = [-0.1, 0.15, 0.7, 1.6, 2.6, 3.5, 4.2]
SEG = 64


def _wall_disp(amp, salt):
    def f(th, r, y, j):
        if j in (0, len(WALL_ROWS) - 1):
            return r
        n = vnoise(math.sin(th) * 3.4 + 7.1 + salt, y * 0.75, math.cos(th) * 3.4 + salt)
        return r + amp * (2 * n - 1)
    return f


WALL_OUT = RevSurf(SEG, [(R_OUT, y) for y in WALL_ROWS], _wall_disp(0.026, 0.0))
WALL_INN = RevSurf(SEG, [(R_IN, y) for y in WALL_ROWS], _wall_disp(0.012, 13.0))

DOME_ROWS = 8
PHI_O = math.acos(OCULUS_R / R_OUT)
PHI_I = math.acos(OCULUS_R / R_IN)


def _dome_disp(th, r, y, j):
    if j in (0, DOME_ROWS - 1):
        return r
    n = vnoise(math.sin(th) * 3.0 + 2.3, y * 0.9, math.cos(th) * 3.0 + 4.4)
    return r + 0.03 * (2 * n - 1)


DOME_OUT = RevSurf(SEG, [(R_OUT * math.cos(PHI_O * j / (DOME_ROWS - 1)),
                          WALL_H + DOME_H_OUT * math.sin(PHI_O * j / (DOME_ROWS - 1))) for j in range(DOME_ROWS)],
                   _dome_disp)
DOME_INN = RevSurf(SEG // 2, [(R_IN * math.cos(PHI_I * j / (DOME_ROWS - 1)),
                          WALL_H + DOME_H_IN * math.sin(PHI_I * j / (DOME_ROWS - 1))) for j in range(DOME_ROWS)])
DOME_C = V(0, WALL_H, 0)


def dome_normal(p):
    # gradient of the outer ellipsoid (x^2 + z^2)/a^2 + (y - 4.2)^2/b^2
    return V(p.x / R_OUT ** 2, (p.y - WALL_H) / DOME_H_OUT ** 2, p.z / R_OUT ** 2).normalized()


def r_dome_out(y):
    t = (y - WALL_H) / DOME_H_OUT
    return R_OUT * math.sqrt(max(0.0, 1 - t * t))


def r_dome_in(y):
    t = (y - WALL_H) / DOME_H_IN
    return R_IN * math.sqrt(max(0.0, 1 - t * t))


def r_shell_mid(y):
    """Radius halfway through the hall's wall/dome shell at height y (greenhouse parts end here)."""
    if y <= WALL_H:
        return (R_IN + R_OUT) / 2
    return (r_dome_out(y) + r_dome_in(y)) / 2


def x_junction(y, z):
    return -math.sqrt(max(0.0, r_shell_mid(y) ** 2 - z * z))


# ---------------------------------------------------------------------------------------------- colours
C = {k: hexrgb(v) for k, v in dict(
    ext_a=0xc9ad86, ext_b=0xb8956a, bleach=0xdcc7a0, dirt=0x6f5038, int_a=0xd6c29e, int_b=0xc4a77e,
    soot=0x5c4838, rust=0x7a4428, verd=0x4f8a78, grout=0x4a3c30, stone_a=0x8a7560, stone_b=0x7b6753,
    stone_c=0x97826a, dirt_a=0x5a4030, dirt_b=0x6b4c36, dirt_wet=0x46301f, gravel_a=0x8b7862,
    gravel_b=0xa08c70, gravel_c=0x6e5c48).items()}


def plaster_col(p, interior):
    nz = vnoise(p.x * 0.45 + 3.0, p.y * 0.6, p.z * 0.45)
    if interior:
        c = mix(C['int_a'], C['int_b'], nz)
        c = mix(c, mix(C['dirt'], C['int_b'], 0.5), smoothstep(0.6, 0.0, p.y) * 0.5)
        c = mix(c, C['soot'], smoothstep(6.6, 7.9, p.y) * 0.5)
        return c
    c = mix(C['ext_a'], C['ext_b'], nz)
    c = mix(c, C['bleach'], smoothstep(2.5, 7.8, p.y) * 0.55)
    c = mix(c, C['dirt'], smoothstep(1.1, 0.0, p.y) * 0.72)
    return c


def hall_paint(mat, p, n):
    if mat != 'Plaster':
        return None
    if p.y > WALL_H + 0.01:
        interior = n.dot((p - DOME_C).normalized()) < -0.2
    else:
        rad = V(p.x, 0, p.z)
        interior = rad.length > 1e-6 and n.dot(rad.normalized()) < -0.5
    return plaster_col(p, interior)


# --------------------------------------------------------------------------------------------- the hall
def build_wall(root):
    P = Part('Hall_Wall', smooth_angle=30)
    n = len(WALL_ROWS)
    O = [[P.v(WALL_OUT.P[k][j]) for j in range(n)] for k in range(SEG)]
    I = [[P.v(WALL_INN.P[k][j]) for j in range(n)] for k in range(SEG)]
    for k in range(SEG):
        k2 = (k + 1) % SEG
        out = radial((k + 0.5) * TAU / SEG)
        for j in range(n - 1):
            P.face([O[k][j], O[k2][j], O[k2][j + 1], O[k][j + 1]], 'Plaster', hint=out)
            P.face([I[k][j], I[k2][j], I[k2][j + 1], I[k][j + 1]], 'Plaster', hint=-out)
        P.face([O[k][-1], O[k2][-1], I[k2][-1], I[k][-1]], 'Plaster', hint=V(0, 1, 0))
        P.face([O[k][0], O[k2][0], I[k2][0], I[k][0]], 'Plaster', hint=V(0, -1, 0))
    obj = P.build(root)

    cutters = []
    c = Part('cut_door')
    abox(c, -DOOR_HW - 0.06, DOOR_HW + 0.06, -0.5, DOOR_H + 0.05, 6.4, 8.2, 'Plaster')
    cutters.append(c.build())
    c = Part('cut_gh')
    abox(c, -8.2, -6.4, -0.5, GH_H + 0.05, -GH_HW - 0.06, GH_HW + 0.06, 'Plaster')
    cutters.append(c.build())
    for deg in PORTHOLES:
        c = Part('cut_port')
        th = deg * DEG
        cyl(c, radial(th) * 7.3 + V(0, PORTHOLE_Y, 0), radial(th), PORTHOLE_R, 1.6, 16, 'Plaster')
        cutters.append(c.build())
    boolean_cut(obj, cutters)
    paint(obj, hall_paint)
    return obj


def build_dome(root):
    """Outer shell at the wall's 64 segments; the inner shell uses 32 (its spring is hidden by the ring
    beam and its oculus lip by the brass collar), joined by pentagons at the lip and the spring."""
    P = Part('Hall_Dome', smooth_angle=30)
    n = DOME_ROWS
    si = SEG // 2
    O = [[P.v(DOME_OUT.P[k][j]) for j in range(n)] for k in range(SEG)]
    I = [[P.v(DOME_INN.P[k][j]) for j in range(n)] for k in range(si)]
    for k in range(SEG):
        k2 = (k + 1) % SEG
        for j in range(n - 1):
            q = [O[k][j], O[k2][j], O[k2][j + 1], O[k][j + 1]]
            cen = sum((game(v.co) for v in q), Vector()) / 4
            P.face(q, 'Plaster', hint=cen - DOME_C)
    for m in range(si):
        m2 = (m + 1) % si
        for j in range(n - 1):
            q = [I[m][j], I[m2][j], I[m2][j + 1], I[m][j + 1]]
            cen = sum((game(v.co) for v in q), Vector()) / 4
            P.face(q, 'Plaster', hint=DOME_C - cen)
        th = (m + 0.5) * TAU / si
        o0, o1, o2 = 2 * m, 2 * m + 1, (2 * m + 2) % SEG
        P.face([O[o0][-1], O[o1][-1], O[o2][-1], I[m2][-1], I[m][-1]], 'Plaster', hint=-radial(th))
        P.face([O[o0][0], O[o1][0], O[o2][0], I[m2][0], I[m][0]], 'Plaster', hint=V(0, -1, 0))
    obj = P.build(root)
    paint(obj, hall_paint)
    return obj


def surf_strip(P, surf, th, t0, t1, w_fn, off, nfn, mat, col_fn=None, cols3=None):
    """A thin strip draped over a RevSurf along a meridian (constant th) from row t0 to t1 (t0 > t1 ok).
    w_fn(s) gives the width at s in [0, 1]; col_fn(s, p, which) gives colours (which: 0 edge, 1 centre)."""
    ts = [t0]
    lo, hi = min(t0, t1), max(t0, t1)
    inner = [float(j) for j in range(math.ceil(lo + 1e-6), math.floor(hi - 1e-6) + 1)]
    ts += sorted(inner, reverse=t0 > t1)
    ts.append(t1)
    rows = []
    for t in ts:
        s = abs(t - t0) / max(1e-6, abs(t1 - t0))
        pc = surf.pt(th, t)
        r = math.hypot(pc.x, pc.z)
        dth = w_fn(s) / 2 / max(r, 0.5)
        row = []
        for which, a in ((0, th - dth), (1, th), (0, th + dth)):
            p = surf.pt(a, t)
            p = p + nfn(p) * off
            row.append((P.v(p), col_fn(s, p, which) if col_fn else None))
        rows.append(row)
    for i in range(len(rows) - 1):
        for k in range(2):
            q = [rows[i][k], rows[i][k + 1], rows[i + 1][k + 1], rows[i + 1][k]]
            verts = [x[0] for x in q]
            cen = sum((game(v.co) for v in verts), Vector()) / 4
            cols = [x[1] for x in q] if col_fn else None
            P.face(verts, mat, hint=nfn(cen), cols=cols)
    return rows


def wall_n(p):
    return V(p.x, 0, p.z).normalized()


def build_streaks(root):
    """Rust / verdigris run-off streaks: thin vertex-coloured decals a hair above the plaster."""
    P = Part('Hall_Streaks', smooth_angle=60)
    rng = Rng(21)

    def streak(surf, nfn, th, y_top, length, w, tint, k=0.75):
        t0 = surf.t_at_y(y_top) if surf is WALL_OUT else y_top
        t1 = surf.t_at_y(y_top - length) if surf is WALL_OUT else y_top - length

        def col(s, p, which):
            base = plaster_col(p, False)
            if which == 0:
                return base
            return mix(base, C[tint], k * (1 - s) ** 1.3 * smoothstep(0.0, 0.12, s + 0.06))

        surf_strip(P, surf, th, t0, t1, lambda s: w * (1 - 0.55 * s), 0.014, nfn, 'Plaster', col_fn=col)

    for deg in PORTHOLES:  # under each porthole rim
        streak(WALL_OUT, wall_n, deg * DEG + rng(-0.01, 0.01), PORTHOLE_Y - 0.42, rng(1.0, 1.4), 0.32, 'rust')
    for deg in [52, 84, 118, 158, 196, 248, 302, 334, 352]:  # under the top brass band
        if 236 < deg < 304:
            continue
        streak(WALL_OUT, wall_n, deg * DEG, 3.98, rng(1.2, 2.6), rng(0.18, 0.34), 'rust', rng(0.45, 0.75))
    for deg in EXT_PIPES:  # copper run-off beside the pipes
        streak(WALL_OUT, wall_n, (deg + 1.6) * DEG, 3.35, 2.2, 0.26, 'verd', 0.55)
    for deg, t, ln in [(10, 5.5, 3.2), (100, 7.0, 4.0), (200, 6.0, 3.5), (330, 8.0, 4.5)]:  # dome
        streak(DOME_OUT, dome_normal, deg * DEG, t, ln, 0.4, 'rust', 0.5)
    return P.build(root)


def surf_patch(P, surf, nfn, th0, th1, t0, t1, off, rivets):
    """Riveted sheet-metal patch draped over a RevSurf (with a skirt down to the surface)."""
    nu, nv = 3, 3
    grid, base = [], []
    for i in range(nu + 1):
        row, brow = [], []
        for j in range(nv + 1):
            th = th0 + (th1 - th0) * i / nu
            t = t0 + (t1 - t0) * j / nv
            p = surf.pt(th, t)
            row.append(p + nfn(p) * off)
            brow.append(p - nfn(p) * 0.01)
        grid.append(row)
        base.append(brow)
    vg = [[P.v(p) for p in row] for row in grid]
    for i in range(nu):
        for j in range(nv):
            q = [vg[i][j], vg[i + 1][j], vg[i + 1][j + 1], vg[i][j + 1]]
            P.face(q, 'SheetMetal', hint=nfn(grid[i][j]))
    # skirt
    loop = [(i, 0) for i in range(nu)] + [(nu, j) for j in range(nv)] + \
           [(i, nv) for i in range(nu, 0, -1)] + [(0, j) for j in range(nv, 0, -1)]
    cen = grid[nu // 2][nv // 2]
    vb = {}
    for (i, j) in loop:
        vb[i, j] = P.v(base[i][j])
    for idx, (i, j) in enumerate(loop):
        i2, j2 = loop[(idx + 1) % len(loop)]
        q = [vg[i][j], vg[i2][j2], vb[i2, j2], vb[i, j]]
        mid = (grid[i][j] + grid[i2][j2]) / 2
        P.face(q, 'SheetMetal', hint=mid - cen)
    if rivets:
        for (i, j) in ((0, 0), (nu, 0), (nu, nv), (0, nv)):
            p = grid[i][j]
            q = p.lerp(cen, 0.12 / max(0.2, (cen - p).length))
            rivet(rivets, q, nfn(p), 0.028, 'Iron')


def build_trim(root):
    """Brass bands, porthole rims, sheet-metal patches, dome ribs and their rivets."""
    P = Part('Hall_Trim', smooth_angle=40)
    Y = V(0, 1, 0)
    ref = V(0, 0, 1)
    # lower band: skip the two openings
    door_a = 11.8 * DEG
    gh_a0, gh_a1 = (-90 - 12.5) * DEG, (-90 + 12.5) * DEG
    prof = [(7.54, 0.22), (7.66, 0.22), (7.66, 0.38), (7.54, 0.38)]
    revolve(P, V(0, 0, 0), Y, prof, door_a, TAU + gh_a0, 36, 'Brass', ref=ref)
    revolve(P, V(0, 0, 0), Y, prof, TAU + gh_a1, TAU - door_a, 10, 'Brass', ref=ref)
    # top band
    revolve(P, V(0, 0, 0), Y, [(7.54, 4.0), (7.66, 4.0), (7.66, 4.16), (7.54, 4.16)], 0, TAU, 48, 'Brass', ref=ref)
    # band rivets
    for k in range(36):
        th = (k + 0.5) * TAU / 36
        rivet(P, radial(th) * 7.66 + Y * 4.08, radial(th), 0.03)
        a = math.degrees(th)
        if a < 13 or a > 347 or 256 < a < 284:
            continue
        rivet(P, radial(th) * 7.66 + Y * 0.30, radial(th), 0.03)
    # portholes: brass rims both sides + rivets
    for deg in PORTHOLES:
        th = deg * DEG
        c = radial(th) * 7.3 + Y * PORTHOLE_Y
        ring_rect(P, radial(th) * 7.605 + Y * PORTHOLE_Y, radial(th), 0.27, 0.41, 0.13, 10, 'Brass')
        ring_rect(P, radial(th) * 7.0 + Y * PORTHOLE_Y, radial(th), 0.27, 0.38, 0.12, 10, 'Brass')
        u, w = Y, tangent(th)
        for k in range(6):
            a = TAU * k / 6 + 0.2
            rivet(P, c + radial(th) * 0.37 + (u * math.cos(a) + w * math.sin(a)) * 0.345, radial(th), 0.026)
    # sheet-metal patches on the wall and dome
    for deg, y0, y1, wdeg in [(80, 0.7, 1.6, 6.0), (196, 2.5, 3.4, 5.0), (338, 1.0, 1.8, 4.5),
                              (120, 2.8, 3.6, 4.0)]:
        th = deg * DEG
        surf_patch(P, WALL_OUT, wall_n, th, th + wdeg * DEG, WALL_OUT.t_at_y(y0), WALL_OUT.t_at_y(y1), 0.02, P)
    for deg, t0, t1, wdeg in [(30, 3.0, 4.6, 7.0), (160, 5.0, 6.3, 8.0), (318, 7.2, 8.4, 10.0)]:
        th = deg * DEG
        surf_patch(P, DOME_OUT, dome_normal, th, th + wdeg * DEG, t0, t1, 0.025, P)
    # brass meridian ribs on the dome (skipped where the greenhouse vault meets the dome)
    for deg in [0, 45, 90, 135, 180, 225, 315]:
        th = deg * DEG
        pts = []
        for j in range(DOME_ROWS):
            t = min(j, DOME_ROWS - 1.25)
            p = DOME_OUT.pt(th, t)
            pts.append(p + dome_normal(p) * 0.045)
        tube(P, pts, 0.075, 4, 'Brass', phase=math.pi / 4, n0=tangent(th))
        for j in range(1, DOME_ROWS - 1, 1):
            p = DOME_OUT.pt(th, j + 0.5)
            rivet(P, p + dome_normal(p) * 0.098, dome_normal(p), 0.026)
    return P.build(root)


def build_oculus(root, glass):
    P = Part('Hall_Oculus', smooth_angle=40)
    Y = V(0, 1, 0)
    # brass collar lining the hole
    revolve(P, V(0, 0, 0), Y, [(1.15, 7.7), (1.42, 7.7), (1.42, 8.3), (1.15, 8.3)], 0, TAU, 24, 'Brass',
            ref=V(0, 0, 1))
    revolve(P, V(0, 0, 0), Y, [(1.38, 8.08), (1.62, 8.08), (1.62, 8.2), (1.38, 8.2)], 0, TAU, 24, 'BrassDark',
            ref=V(0, 0, 1))
    for k in range(12):
        th = (k + 0.5) * TAU / 12
        rivet(P, radial(th) * 1.5 + Y * 8.2, Y, 0.025)
    # low glass cone
    rim = [glass.v(radial(TAU * k / 24) * 1.36 + Y * 8.28) for k in range(24)]
    apex = glass.v(Y * 8.56)
    for k in range(24):
        glass.face([rim[k], rim[(k + 1) % 24], apex], 'Glass', hint=Y)
    # iron cross ribs over the glass + boss
    for k in range(4):
        th = k * TAU / 4 + math.pi / 4
        a = radial(th) * 1.45 + Y * 8.3
        b = radial(th) * 0.05 + Y * 8.6
        seg_box(P, a, b, 0.09, 0.08, 'Iron')
    cyl(P, Y * 8.6, Y, 0.12, 0.1, 8, 'Brass')
    # chandelier hook: rod + ring hanging from the boss
    cyl(P, Y * 7.9, Y, 0.03, 1.3, 6, 'Iron')
    pts = [V(0, 7.13 + 0.12 * (1 - math.cos(a)), 0.12 * math.sin(a)) for a in (TAU * k / 10 for k in range(10))]
    pts = [V(0, 7.25, 0) + (p - V(0, 7.25, 0)) for p in pts]
    tube(P, pts, 0.025, 5, 'Iron', closed=True)
    return P.build(root)


def build_beams(root):
    """Ring beam at the dome spring + curved radial ribs and an iron hoop under the dome."""
    P = Part('Hall_Beams', smooth_angle=40)
    Y = V(0, 1, 0)
    revolve(P, V(0, 0, 0), Y, [(6.72, 3.95), (7.04, 3.95), (7.04, 4.3), (6.72, 4.3)], 0, TAU, 40, 'Wood',
            ref=V(0, 0, 1))

    def inner_pt(th, phi, off):
        p = V(R_IN * math.cos(phi) * math.sin(th), WALL_H + DOME_H_IN * math.sin(phi), R_IN * math.cos(phi) * math.cos(th))
        n = V(p.x / R_IN ** 2, (p.y - WALL_H) / DOME_H_IN ** 2, p.z / R_IN ** 2).normalized()
        return p - n * off

    for k in range(12):
        th = (k * 30 + 15) * DEG
        pts = [inner_pt(th, PHI_I * (0.03 + 0.97 * j / 7), 0.13) for j in range(8)]
        tube(P, pts, 0.14, 4, 'Wood', phase=math.pi / 4, n0=tangent(th))
        # iron shoe where the rib lands on the ring beam
        rbox(P, th, 6.62, 6.98, 4.25, 4.55, 0.26, 'Iron')
    # iron hoop tying the ribs together
    phi = 0.62
    hoop = [inner_pt(TAU * k / 24, phi, 0.27) for k in range(24)]
    tube(P, hoop, 0.05, 4, 'Iron', closed=True, phase=math.pi / 4)
    return P.build(root)


def build_floor(root):
    P = Part('Hall_Floor', smooth_angle=10)
    rng = Rng(5)
    Y = V(0, 1, 0)
    # grout slab (top a hair below the tiles) — the gaps between tiles read as grout
    n = 64
    top = [P.v(radial(TAU * k / n) * 7.06 + Y * -0.008) for k in range(n)]
    bot = [P.v(radial(TAU * k / n) * 7.06 + Y * -0.1) for k in range(n)]
    g = C['grout']
    P.face(top, 'Stone', hint=Y, cols=[g] * n)
    P.face(bot, 'Stone', hint=-Y, cols=[g] * n)
    for k in range(n):
        k2 = (k + 1) % n
        P.face([top[k], top[k2], bot[k2], bot[k]], 'Stone', hint=radial((k + 0.5) * TAU / n), cols=[g] * 4)
    # brass compass medallion at the centre
    m = 16
    ctr = P.v(V(0, 0, 0))
    ring = [P.v(radial(TAU * k / m) * 0.82) for k in range(m)]
    for k in range(m):
        P.face([ctr, ring[k], ring[(k + 1) % m]], 'Brass' if k % 2 else 'BrassDark', hint=Y)
    # stone tiles in concentric courses
    radii = [0.9, 1.8, 2.75, 3.7, 4.65, 5.65, 6.55, 7.0]
    gap = 0.022
    for i in range(len(radii) - 1):
        r0, r1 = radii[i] + gap, radii[i + 1] - gap
        rm = (r0 + r1) / 2
        cnt = max(8, round(TAU * rm / (0.95 if r1 - r0 > 0.6 else 0.7)))
        ph = rng(0, TAU)
        for k in range(cnt):
            a0 = ph + TAU * k / cnt + gap / r0
            a1 = ph + TAU * (k + 1) / cnt - gap / r0
            tone = [C['stone_a'], C['stone_b'], C['stone_c']][int(rng(0, 3)) % 3]
            corners = [radial(a0) * r0, radial(a1) * r0, radial(a1) * r1, radial(a0) * r1]
            if r1 > 6.9:  # outer course: bow the outer edge so it follows the wall
                am = (a0 + a1) / 2
                corners = [radial(a0) * r0, radial(a1) * r0, radial(a1) * r1, radial(am) * r1, radial(a0) * r1]
            cols = []
            for p in corners:
                wear = smoothstep(2.0, 0.0, abs(p.x)) * smoothstep(-1.0, 3.0, p.z) * 0.25  # door->centre path
                c = mix(tone, mix(C['stone_c'], (0.75, 0.68, 0.58), 0.4), wear)
                nz = vnoise(p.x * 1.7, 0.5, p.z * 1.7)
                cols.append(mix(c, C['grout'], 0.25 * nz))
            P.face([P.v(p) for p in corners], 'Stone', hint=Y, cols=cols)
    # thresholds (brass plates in the wall gaps), flush at y=0
    abox(P, -DOOR_HW, DOOR_HW, -0.06, 0.0, 6.99, 7.62, 'Brass')
    abox(P, -7.62, -6.99, -0.06, 0.0, -GH_HW, GH_HW, 'Brass')
    for x in (-0.9, -0.3, 0.3, 0.9):
        rivet(P, V(x, 0.0, 7.12), Y, 0.025, 'BrassDark')
        rivet(P, V(x, 0.0, 7.5), Y, 0.025, 'BrassDark')
    return P.build(root)


def build_porch(root):
    P = Part('Porch', smooth_angle=10)
    Y = V(0, 1, 0)
    xs = [-1.6, -0.55, 0.55, 1.6]
    zs = [7.62, 8.32, 9.0]
    # slab with a slightly worn, dusty top, split into three flagstones per row
    for i in range(3):
        for j in range(2):
            x0, x1, z0, z1 = xs[i] + 0.012, xs[i + 1] - 0.012, zs[j] + 0.012, zs[j + 1] - 0.012
            c = mix(C['stone_b'], (0.72, 0.52, 0.34), 0.3 + 0.15 * ((i + j) % 2))
            corners = [V(x0, 0, z0), V(x1, 0, z0), V(x1, 0, z1), V(x0, 0, z1)]
            P.face([P.v(p) for p in corners], 'Stone', hint=Y, cols=[c] * 4)
    g = C['grout']
    abox_cols(P, -1.6, 1.6, -0.18, -0.006, 7.62, 9.0, 'Stone', g)
    return P.build(root)


def abox_cols(P, x0, x1, y0, y1, z0, z1, mat, col):
    before = len(P.bm.faces)
    abox(P, x0, x1, y0, y1, z0, z1, mat)
    P.bm.faces.ensure_lookup_table()
    for f in list(P.bm.faces)[before:]:
        P.fcols.append((f, [col] * len(f.verts)))


def build_pipes(root):
    P = Part('Hall_Pipes', smooth_angle=60)
    Y = V(0, 1, 0)
    rng = Rng(9)
    # exterior: up the wall, over the spring, along the dome, then elbow into it
    for deg in EXT_PIPES:
        th = deg * DEG
        R = radial(th)
        pts = [R * 7.8 + Y * -0.15, R * 7.8 + Y * 3.9]
        for j in range(1, 8):
            phi = 0.08 * j * 1.15
            p = V(R_OUT * math.cos(phi) * R.x, WALL_H + DOME_H_OUT * math.sin(phi), R_OUT * math.cos(phi) * R.z)
            pts.append(p + dome_normal(p) * 0.2)
        last = pts[-1]
        pts.append(last - dome_normal(last) * 0.25)
        tube(P, pts, 0.07, 6, 'Copper')
        for y in (0.9, 2.6, 3.9):  # verdigris flanges
            cyl(P, R * 7.8 + Y * y, Y, 0.1, 0.08, 6, 'Verdigris')
        for y in (1.7, 3.4):  # brass clamps to the wall
            rbox(P, th, 7.5, 7.84, y - 0.05, y + 0.05, 0.08, 'Brass')
            rbox(P, th, 7.7, 7.9, y - 0.06, y + 0.06, 0.2, 'Brass')
        p = last
        cyl(P, p - dome_normal(p) * 0.05, dome_normal(p), 0.11, 0.07, 6, 'Verdigris')
    # gauge on the first pipe
    th = EXT_PIPES[0] * DEG
    R, T = radial(th), tangent(th)
    gc = R * 7.95 + Y * 1.45
    cyl(P, gc, R, 0.15, 0.08, 12, 'Brass')
    face = [P.v(gc + R * 0.041 + (Y * math.cos(a) + T * math.sin(a)) * 0.12) for a in (TAU * k / 12 for k in range(12))]
    P.face(face, 'GaugeFace', hint=R)
    seg_box(P, gc + R * 0.046, gc + R * 0.046 + (Y * 0.6 + T * 0.8).normalized() * 0.1, 0.012, 0.006, 'Iron', up=R)
    cyl(P, R * 7.8 + Y * 1.45 + R * 0.08, R, 0.035, 0.14, 6, 'Brass')
    # valve wheel on the last pipe
    th = EXT_PIPES[2] * DEG
    R, T = radial(th), tangent(th)
    vc = R * 8.02 + Y * 1.2
    cyl(P, R * 7.88 + Y * 1.2, R, 0.03, 0.2, 6, 'Iron')
    wheel = [vc + (Y * math.cos(a) + T * math.sin(a)) * 0.17 for a in (TAU * k / 12 for k in range(12))]
    tube(P, wheel, 0.022, 4, 'Brass', closed=True)
    for k in range(3):
        a = TAU * k / 3
        seg_box(P, vc, vc + (Y * math.cos(a) + T * math.sin(a)) * 0.17, 0.025, 0.025, 'Brass', up=R)
    # interior: a ring main just under the ring beam, skipping the openings, with three drops + valves
    r_in = 6.86
    for a0, a1 in ((17, 258), (286, 343)):
        pts = [radial(a0 * DEG) * 7.05 + Y * 3.55]
        steps = max(2, int((a1 - a0) / 8))
        pts += [radial((a0 + (a1 - a0) * s / steps) * DEG) * r_in + Y * 3.55 for s in range(steps + 1)]
        pts.append(radial(a1 * DEG) * 7.05 + Y * 3.55)
        tube(P, pts, 0.06, 6, 'Copper')
        for s in range(0, steps + 1, 3):
            th = (a0 + (a1 - a0) * s / steps) * DEG
            rbox(P, th, 6.8, 7.02, 3.49, 3.61, 0.07, 'Iron')
    for deg in (70, 140, 205):
        th = deg * DEG
        R, T = radial(th), tangent(th)
        pts = [R * r_in + Y * 3.55, R * r_in + Y * 0.95, R * 6.9 + Y * 0.78, R * 7.05 + Y * 0.75]
        tube(P, pts, 0.05, 6, 'Copper')
        cyl(P, R * r_in + Y * 2.4, Y, 0.075, 0.07, 6, 'Verdigris')
        vc = R * (r_in - 0.16) + Y * 1.5
        cyl(P, R * (r_in - 0.08) + Y * 1.5, R, 0.025, 0.16, 6, 'Iron')
        wheel = [vc + (Y * math.cos(a) + T * math.sin(a)) * 0.14 for a in (TAU * k / 10 for k in range(10))]
        tube(P, wheel, 0.018, 4, 'Brass', closed=True)
        seg_box(P, vc + Y * 0.14, vc - Y * 0.14, 0.02, 0.02, 'Brass', up=R)
        seg_box(P, vc + T * 0.14, vc - T * 0.14, 0.02, 0.02, 'Brass', up=R)
        rbox(P, th, 6.8, 7.02, 1.95, 2.05, 0.06, 'Iron')
    rng(0, 1)
    return P.build(root)


# ---------------------------------------------------------------------------------------- front entrance
def build_front_frame(root):
    P = Part('FrontDoor_Frame', smooth_angle=30)
    Y = V(0, 1, 0)
    z_in, z_out = 6.84, 7.71
    for s in (-1, 1):
        x0, x1 = sorted((s * DOOR_HW, s * 1.45))
        abox(P, x0, x1, 0.0, 3.32, z_in, z_out, 'Iron')
        bx0, bx1 = sorted((s * 1.23, s * 1.42))
        abox(P, bx0, bx1, 0.15, 3.0, z_out, z_out + 0.025, 'Brass')
        for y in (0.45, 1.25, 2.05, 2.8):
            rivet(P, V(s * 1.325, y, z_out + 0.025), V(0, 0, 1), 0.03)
    abox(P, -1.45, 1.45, DOOR_H, 3.32, z_in, z_out + 0.01, 'Iron')
    abox(P, -1.38, 1.38, 3.06, 3.26, z_out + 0.01, z_out + 0.035, 'Brass')
    for x in (-1.15, -0.6, 0.0, 0.6, 1.15):
        rivet(P, V(x, 3.16, z_out + 0.035), V(0, 0, 1), 0.03)
    # half-round brass sunburst over the door (alternating rays)
    c = V(0, 3.52, 0)
    n = 10
    zb, zf = 7.53, 7.64
    rim = [c + V(-math.cos(math.pi * k / n), math.sin(math.pi * k / n), 0) * 0.5 for k in range(n + 1)]
    for k in range(n):
        a, b = rim[k], rim[k + 1]
        f = [P.v(V(c.x, c.y, zf)), P.v(V(a.x, a.y, zf)), P.v(V(b.x, b.y, zf))]
        P.face(f, 'Brass' if k % 2 else 'BrassDark', hint=V(0, 0, 1))
        bk = [P.v(V(c.x, c.y, zb)), P.v(V(a.x, a.y, zb)), P.v(V(b.x, b.y, zb))]
        P.face(bk, 'Iron', hint=V(0, 0, -1))
        P.face([f[1], f[2], bk[2], bk[1]], 'Brass', hint=(a + b) / 2 - c)
    P.face([P.v(V(-0.5, 3.52, zf)), P.v(V(0.5, 3.52, zf)), P.v(V(0.5, 3.52, zb)), P.v(V(-0.5, 3.52, zb))], 'Brass',
           hint=-Y)
    cyl(P, V(0, 3.52, 7.66), V(0, 0, 1), 0.1, 0.06, 10, 'Brass')
    # greenhouse opening frame (same construction, along -X)
    x_in, x_out = -6.84, -7.71
    for s in (-1, 1):
        z0, z1 = sorted((s * GH_HW, s * 1.75))
        abox(P, x_out, x_in, 0.0, 3.5, z0, z1, 'Iron')
        for y in (0.5, 1.5, 2.5):
            rivet(P, V(x_in, y, s * 1.62), V(1, 0, 0), 0.03)
    abox(P, x_out - 0.01, x_in, GH_H, 3.5, -1.75, 1.75, 'Iron')
    abox(P, x_in, x_in + 0.025, 3.26, 3.44, -1.66, 1.66, 'Brass')
    return P.build(root)


SLAB_A0, SLAB_A1 = 11.6 * DEG, 31.4 * DEG
SLAB_R0, SLAB_R1 = 7.80, 7.94


def build_door_slab(root):
    """Heavy curved sliding door, parked open beside the doorway. Rotating this node about Y around the
    hall centre slides it along its rail (closed = rotate by -21.5 deg)."""
    P = Part('FrontDoor_Slab', smooth_angle=30)
    Y = V(0, 1, 0)
    ref = V(0, 0, 1)
    revolve(P, V(0, 0, 0), Y, [(SLAB_R0, 0.04), (SLAB_R1, 0.04), (SLAB_R1, 3.1), (SLAB_R0, 3.1)],
            SLAB_A0, SLAB_A1, 10, 'Iron', ref=ref)
    for y0 in (0.32, 1.48, 2.66):
        revolve(P, V(0, 0, 0), Y, [(SLAB_R1 - 0.01, y0), (SLAB_R1 + 0.03, y0), (SLAB_R1 + 0.03, y0 + 0.16),
                                    (SLAB_R1 - 0.01, y0 + 0.16)], SLAB_A0 - 0.2 * DEG, SLAB_A1 + 0.2 * DEG, 10,
                'Brass', ref=ref)
        for k in range(6):
            th = SLAB_A0 + (SLAB_A1 - SLAB_A0) * (k + 0.5) / 6
            rivet(P, radial(th) * (SLAB_R1 + 0.03) + Y * (y0 + 0.08), radial(th), 0.028, 'BrassDark')
    for th, w in ((SLAB_A0 + 0.6 * DEG, 0.16), (SLAB_A1 - 0.6 * DEG, 0.16)):
        rbox(P, th, SLAB_R1 - 0.02, SLAB_R1 + 0.035, 0.04, 3.1, w, 'Iron')
    # sheet patch + handwheel
    th = (SLAB_A0 + SLAB_A1) / 2
    rbox(P, th + 2.5 * DEG, SLAB_R1, SLAB_R1 + 0.015, 0.75, 1.3, 0.7, 'SheetMetal')
    th = SLAB_A0 + 3.0 * DEG
    R, T = radial(th), tangent(th)
    vc = R * (SLAB_R1 + 0.14) + Y * 2.15
    cyl(P, R * (SLAB_R1 + 0.07) + Y * 2.15, R, 0.04, 0.14, 6, 'Iron')
    tube(P, [vc + (Y * math.cos(a) + T * math.sin(a)) * 0.22 for a in (TAU * k / 14 for k in range(14))], 0.03, 5,
         'Brass', closed=True)
    for k in range(4):
        a = TAU * k / 4 + math.pi / 4
        seg_box(P, vc, vc + (Y * math.cos(a) + T * math.sin(a)) * 0.22, 0.03, 0.03, 'Brass', up=R)
    cyl(P, vc, R, 0.05, 0.06, 8, 'Brass')
    # hangers up to the rail
    for th in (SLAB_A0 + 3 * DEG, SLAB_A1 - 3 * DEG):
        rbox(P, th, SLAB_R0 + 0.02, SLAB_R1 + 0.02, 3.05, 3.2, 0.12, 'Iron')
        cyl(P, radial(th) * 7.89 + Y * 3.27, radial(th), 0.07, 0.1, 8, 'Iron')
    obj = P.build(root)
    return obj


def build_rail_awning(root):
    P = Part('FrontDoor_Awning', smooth_angle=30)
    Y = V(0, 1, 0)
    ref = V(0, 0, 1)
    # door rail + brackets
    revolve(P, V(0, 0, 0), Y, [(7.84, 3.33), (7.94, 3.33), (7.94, 3.39), (7.84, 3.39)], -13.5 * DEG, 33.5 * DEG,
            16, 'Iron', ref=ref)
    for deg in (-13, -1.5, 13, 23, 33):
        th = deg * DEG
        rbox(P, th, 7.45, 7.92, 3.29, 3.4, 0.1, 'Iron')
    # canvas: striped, slight sag, from the wall out 1.2 m; top at y 3.4 against the wall
    xs = [-1.95 + 3.9 * i / 8 for i in range(9)]
    zs = [7.3, 7.75, 8.25, 8.8]

    def ya(x, z):
        s = (z - 7.3) / 1.5
        return 3.43 - 0.3 * s - 0.05 * math.sin(math.pi * s) - 0.025 * math.cos(math.pi * x / 1.95) * s

    vs = [[P.v(V(x, ya(x, z), z)) for z in zs] for x in xs]
    for i in range(8):
        for j in range(3):
            P.face([vs[i][j], vs[i + 1][j], vs[i + 1][j + 1], vs[i][j + 1]], 'Canvas' if i % 2 else 'CanvasStripe',
                   hint=Y)
    # scalloped valance on the front edge
    for i in range(8):
        x0, x1 = xs[i], xs[i + 1]
        za = 8.8
        y0, y1 = ya(x0, za), ya(x1, za)
        xm = (x0 + x1) / 2
        quad = [P.v(V(x0, y0, za)), P.v(V(x1, y1, za)), P.v(V(x1, y1 - 0.16, za)), P.v(V(xm, (y0 + y1) / 2 - 0.27, za)),
                P.v(V(x0, y0 - 0.16, za))]
        P.face(quad, 'Canvas' if i % 2 else 'CanvasStripe', hint=V(0, 0, 1))
    # iron frame: front bar, side bars, tie rods to the wall
    front = [V(x, ya(x, 8.8) + 0.03, 8.8) for x in xs]
    tube(P, front, 0.035, 6, 'Iron')
    for x in (-1.95, 1.95):
        tube(P, [V(x, ya(x, z) + 0.03, z) for z in zs], 0.035, 6, 'Iron')
        s = 1 if x > 0 else -1
        tube(P, [V(x, ya(x, 8.8) + 0.03, 8.8), V(s * 1.55, 4.0, 7.44)], 0.02, 5, 'Iron')
        rbox(P, math.asin(s * 1.55 / 7.6), 7.52, 7.64, 3.94, 4.04, 0.12, 'Brass')
    # batten fixing the canvas to the wall
    abox(P, -1.98, 1.98, 3.38, 3.49, 7.3, 7.68, 'Wood')
    for x in (-1.7, -0.85, 0.0, 0.85, 1.7):
        rivet(P, V(x, 3.435, 7.68), V(0, 0, 1), 0.03, 'Iron')
    return P.build(root)


def build_lamps(root):
    """Two lanterns hanging from the awning's front corners (Emit_Lamp glows amber at night)."""
    P = Part('FrontDoor_Lamps', smooth_angle=40)
    Y = V(0, 1, 0)
    for s in (-1, 1):
        x, z = s * 1.72, 8.72
        top = 3.1
        cyl(P, V(x, top - 0.07, z), Y, 0.012, 0.16, 5, 'Iron')
        c = V(x, 2.72, z)
        # brass cap (pyramid), glowing hex body, base
        ring = [P.v(c + Y * 0.17 + (V(1, 0, 0) * math.cos(a) + V(0, 0, 1) * math.sin(a)) * 0.13)
                for a in (TAU * k / 6 for k in range(6))]
        apex = P.v(c + Y * 0.3)
        for k in range(6):
            tri = [ring[k], ring[(k + 1) % 6], apex]
            cen = sum((game(v.co) for v in tri), Vector()) / 3
            P.face(tri, 'Brass', hint=cen - (c + Y * 0.2))
        P.face(ring, 'Brass', hint=-Y)
        cyl(P, c, Y, 0.085, 0.3, 6, 'Emit_Lamp')
        cyl(P, c - Y * 0.17, Y, 0.11, 0.04, 6, 'Brass')
        for k in range(3):
            a = TAU * k / 3 + 0.5
            off = V(math.cos(a), 0, math.sin(a)) * 0.1
            seg_box(P, c + off - Y * 0.16, c + off + Y * 0.17, 0.018, 0.018, 'Brass', up=V(0, 0, 1))
    return P.build(root)


# ------------------------------------------------------------------------------------------- greenhouse
GH_POSTS = [-20.85, -18.8, -16.75, -14.7, -12.65, -10.6, -8.55]
GH_ARC = 16


def vault_pt(i, n=GH_ARC):
    a = math.pi * i / n
    return VAULT_Y + VAULT_B * math.sin(a), VAULT_A * math.cos(a)  # (y, z)


def knee_paint(mat, p, n):
    if mat != 'Plaster':
        return None
    return plaster_col(p, False)


def build_gh_walls(root):
    P = Part('Greenhouse_Walls', smooth_angle=30)
    xe = -6.2  # buried in the hall wall (r 7.2..7.4 at z = 3.7..4.0)
    for s in (-1, 1):
        z0, z1 = sorted((s * (GH_Z - KNEE_T), s * GH_Z))
        abox(P, GH_X0 + KNEE_T, xe, -0.1, KNEE_H, z0, z1, 'Plaster')
        z0, z1 = sorted((s * (REAR_HW + 0.05), s * GH_Z))
        abox(P, GH_X0, GH_X0 + KNEE_T, -0.1, KNEE_H, z0, z1, 'Plaster')
    obj = P.build(root)
    paint(obj, knee_paint)
    return obj


def build_gh_frame(root):
    P = Part('Greenhouse_Frame', smooth_angle=30)
    Y = V(0, 1, 0)
    zg = VAULT_A
    # sills on the knee walls
    for s in (-1, 1):
        z0, z1 = sorted((s * (GH_Z - KNEE_T - 0.04), s * (GH_Z + 0.04)))
        abox(P, GH_X0 + KNEE_T + 0.04, -6.2, KNEE_H, KNEE_H + 0.08, z0, z1, 'Iron')
        z0, z1 = sorted((s * 1.2, s * (GH_Z + 0.04)))
        abox(P, GH_X0 - 0.04, GH_X0 + KNEE_T + 0.04, KNEE_H, KNEE_H + 0.08, z0, z1, 'Iron')
    # posts and arched ribs
    for x in GH_POSTS:
        for s in (-1, 1):
            abox(P, x - 0.06, x + 0.06, KNEE_H + 0.08, VAULT_Y, s * zg - 0.06, s * zg + 0.06, 'Iron')
        pts = [V(x, *vault_pt(i, 10)) for i in range(11)]
        tube(P, pts, 0.085, 4, 'Iron', phase=math.pi / 4, n0=V(1, 0, 0))
    # longitudinal members: eaves, transoms, purlins, ridge
    for s in (-1, 1):
        for y, h in ((VAULT_Y, 0.12), (2.05, 0.07)):
            xe = x_junction(y, zg)
            abox(P, GH_X0 + 0.09, xe, y - h / 2, y + h / 2, s * zg - 0.06, s * zg + 0.06, 'Iron')
    for i in (3, 6, 8, 10, 13):
        y, z = vault_pt(i)
        xe = x_junction(y, z)
        seg_box(P, V(GH_X0 + 0.09, y, z), V(xe, y, z), 0.07, 0.07, 'Brass' if i == 8 else 'Iron',
                up=V(0, y - VAULT_Y, z).normalized())
    # end wall: corner posts, mullions, rear door frame, rosette in the gable
    xw = GH_X0 + 0.15
    for z in (-2.5, 2.5):
        ytop = VAULT_Y + VAULT_B * math.sqrt(1 - (z / VAULT_A) ** 2)
        abox(P, xw - 0.06, xw + 0.06, KNEE_H + 0.08, ytop, z - 0.06, z + 0.06, 'Iron')
    for s in (-1, 1):
        z0, z1 = sorted((s * REAR_HW, s * (REAR_HW + 0.2)))
        abox(P, GH_X0 - 0.03, GH_X0 + KNEE_T + 0.03, 0.0, 3.0, z0, z1, 'Iron')
        for y in (0.4, 1.4, 2.4):
            rivet(P, V(GH_X0 - 0.03, y, s * (REAR_HW + 0.1)), V(-1, 0, 0), 0.028)
    abox(P, GH_X0 - 0.04, GH_X0 + KNEE_T + 0.04, REAR_H, 3.02, -REAR_HW - 0.2, REAR_HW + 0.2, 'Iron')
    abox(P, GH_X0, GH_X0 + KNEE_T, -0.05, 0.0, -REAR_HW, REAR_HW, 'Iron')  # threshold
    abox(P, xw - 0.05, xw + 0.05, 3.02, VAULT_Y + VAULT_B, -0.05, 0.05, 'Iron')
    rc = V(xw, 4.35, 0)
    ring_rect(P, rc, V(1, 0, 0), 0.42, 0.52, 0.1, 16, 'Brass')
    ring_rect(P, rc, V(1, 0, 0), 0.0, 0.1, 0.12, 8, 'Brass')
    for k in range(6):
        a = TAU * k / 6
        seg_box(P, rc, rc + V(0, math.cos(a), math.sin(a)) * 0.45, 0.04, 0.04, 'Iron', up=V(1, 0, 0))
    # rear door leaf: iron-framed glass door swung open flat against the end wall (outside, +z side)
    x = GH_X0 - 0.1
    z0, z1, y0, y1 = 1.28, 3.2, 0.03, 2.75
    for (a, b) in (((z0, y0), (z1, y0)), ((z0, y1), (z1, y1)), ((z0, y0), (z0, y1)), ((z1, y0), (z1, y1)),
                   ((z0, 1.35), (z1, 1.35))):
        seg_box(P, V(x, a[1], a[0]), V(x, b[1], b[0]), 0.09, 0.06, 'Iron', up=V(1, 0, 0))
    cyl(P, V(x - 0.06, 1.35, z1 - 0.15), V(1, 0, 0), 0.05, 0.08, 8, 'Brass')
    for y in (0.35, 2.45):  # hinges
        cyl(P, V(GH_X0 - 0.06, y, 1.24), Y, 0.04, 0.22, 6, 'Brass')
    return P.build(root)


def build_gh_glass(root):
    P = Part('Greenhouse_Glass', smooth_angle=60)
    zg = VAULT_A
    x0 = GH_X0 + 0.15
    y_sill = KNEE_H + 0.08
    # sides
    for s in (-1, 1):
        xe = x_junction(1.0, zg)
        q = [V(x0, y_sill, s * zg), V(xe, y_sill, s * zg), V(xe, VAULT_Y, s * zg), V(x0, VAULT_Y, s * zg)]
        P.face([P.v(p) for p in q], 'Glass', hint=V(0, 0, s))
    # vault
    a = [P.v(V(x0, *vault_pt(i))) for i in range(GH_ARC + 1)]
    b = [P.v(V(x_junction(*vault_pt(i)), *vault_pt(i))) for i in range(GH_ARC + 1)]
    for i in range(GH_ARC):
        y, z = vault_pt(i + 0.5)
        P.face([a[i], a[i + 1], b[i + 1], b[i]], 'Glass', hint=V(0, y - VAULT_Y, z))
    # end wall above the knee wall, minus the door
    X = V(-1, 0, 0)
    for z0, z1, ya, yb in ((-zg, -REAR_HW - 0.2, y_sill, VAULT_Y), (REAR_HW + 0.2, zg, y_sill, VAULT_Y),
                           (-REAR_HW - 0.2, REAR_HW + 0.2, 3.02, VAULT_Y)):
        q = [V(x0, ya, z0), V(x0, ya, z1), V(x0, yb, z1), V(x0, yb, z0)]
        P.face([P.v(p) for p in q], 'Glass', hint=X)
    c = P.v(V(x0, VAULT_Y, 0))
    arc = [P.v(V(x0, *vault_pt(i))) for i in range(GH_ARC + 1)]
    for i in range(GH_ARC):
        P.face([c, arc[i], arc[i + 1]], 'Glass', hint=X)
    # rear door leaf pane
    x = GH_X0 - 0.1
    q = [V(x, 0.06, 1.3), V(x, 0.06, 3.18), V(x, 2.72, 3.18), V(x, 2.72, 1.3)]
    P.face([P.v(p) for p in q], 'Glass', hint=X)
    return P


def build_gh_floor(root):
    P = Part('Greenhouse_Floor', smooth_angle=10)
    Y = V(0, 1, 0)
    rng = Rng(17)
    zs = [-3.7, -2.6, -1.55, -0.8, 0.0, 0.8, 1.55, 2.6, 3.7]
    xs = [GH_X0 + KNEE_T + i for i in range(13)]  # -20.7 .. -8.7

    def x_end(z):
        return -7.62 if abs(z) <= 1.56 else -math.sqrt(R_OUT ** 2 - z * z)

    def col(p, path):
        nz = vnoise(p.x * 1.3, 1.7, p.z * 1.3)
        if path:
            c = mix(C['gravel_a'], C['gravel_b'], nz)
            return mix(c, C['gravel_c'], vnoise(p.x * 3.1, 4.2, p.z * 3.1) * 0.6)
        c = mix(C['dirt_a'], C['dirt_b'], nz)
        edge = smoothstep(2.6, 3.7, abs(p.z))
        return mix(c, C['dirt_wet'], edge * 0.6)

    rows = []
    for z in zs:
        rows.append([V(x, 0, z) for x in xs] + [V(x_end(z), 0, z)])
    for j in range(len(zs) - 1):
        path = -0.81 < (zs[j] + zs[j + 1]) / 2 < 0.81
        for i in range(len(xs)):
            q = [rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]]
            P.face([P.v(p) for p in q], 'Gravel' if path else 'Dirt', hint=Y, cols=[col(p, path) for p in q])
    # plank stepping boards across the gravel path
    x = GH_X0 + KNEE_T + 0.45
    while x < -8.0:
        yaw = rng(-0.06, 0.06)
        c = V(x, 0.0025, 0)
        obox(P, c, V(math.cos(yaw), 0, math.sin(yaw)), Y, V(-math.sin(yaw), 0, math.cos(yaw)),
             0.12, 0.0225, 0.72, 'Wood')
        x += rng(0.85, 1.05)
    return P.build(root)


# --------------------------------------------------------------------------------------------- assembly
def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def build_all():
    root = bpy.data.objects.new('BaseShell', None)
    bpy.context.scene.collection.objects.link(root)
    objs = [build_wall(root), build_dome(root), build_streaks(root), build_trim(root)]
    hall_glass = Part('Hall_Glass', smooth_angle=60)
    for deg in PORTHOLES:
        th = deg * DEG
        c = radial(th) * 7.3 + V(0, PORTHOLE_Y, 0)
        pts = [hall_glass.v(c + (V(0, 1, 0) * math.cos(a) + tangent(th) * math.sin(a)) * (PORTHOLE_R + 0.01))
               for a in (TAU * k / 14 for k in range(14))]
        hall_glass.face(pts, 'Glass', hint=radial(th))
    objs.append(build_oculus(root, hall_glass))
    objs.append(hall_glass.build(root))
    objs += [build_beams(root), build_floor(root), build_porch(root), build_pipes(root), build_front_frame(root),
             build_door_slab(root), build_rail_awning(root), build_lamps(root), build_gh_walls(root),
             build_gh_frame(root), build_gh_floor(root)]
    objs.append(build_gh_glass(root).build(root))
    for o in objs:
        finalize(o)
    return root, objs


def export(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=False,
        export_yup=True,
        export_apply=True,
        export_materials='EXPORT',
        export_normals=True,
        export_texcoords=False,
        export_vertex_color='MATERIAL',
        export_cameras=False,
        export_lights=False,
    )


# ---------------------------------------------------------------------------------------------- preview
def render_previews(prefix):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = 1280, 800
    sc.view_settings.view_transform = 'AgX'
    try:
        sc.eevee.taa_render_samples = 32
    except Exception:  # noqa: BLE001
        pass
    world = bpy.data.worlds.new('W')
    sc.world = world
    bg = world.node_tree.nodes['Background']

    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.03))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new('Sand')
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.62, 0.30, 0.10, 1)
    ground.data.materials.append(gm)

    sun_d = bpy.data.lights.new('Sun', 'SUN')
    sun = bpy.data.objects.new('Sun', sun_d)
    sc.collection.objects.link(sun)
    to_sun = G(V(0.55, 0.5, 0.67)).normalized()
    sun.rotation_euler = to_sun.to_track_quat('Z', 'Y').to_euler()
    pt_d = bpy.data.lights.new('Fill', 'POINT')
    pt_d.energy = 1500
    pt_d.color = (1.0, 0.8, 0.6)
    pt = bpy.data.objects.new('Fill', pt_d)
    pt.location = G(V(0, 3.0, 0))
    sc.collection.objects.link(pt)
    pt2_d = bpy.data.lights.new('Fill2', 'POINT')
    pt2_d.energy = 1200
    pt2 = bpy.data.objects.new('Fill2', pt2_d)
    pt2.location = G(V(-14, 3.0, 0))
    sc.collection.objects.link(pt2)

    cam_d = bpy.data.cameras.new('Cam')
    cam = bpy.data.objects.new('Cam', cam_d)
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam_d.clip_end = 500

    def day():
        bg.inputs['Color'].default_value = (0.55, 0.3, 0.16, 1)
        bg.inputs['Strength'].default_value = 0.7
        sun_d.energy = 4.0
        sun_d.color = (1.0, 0.78, 0.52)
        pt_d.energy, pt2_d.energy = 1500, 1200

    def night():
        bg.inputs['Color'].default_value = (0.05, 0.035, 0.04, 1)
        bg.inputs['Strength'].default_value = 0.4
        sun_d.energy = 0.0
        pt_d.energy, pt2_d.energy = 0, 0

    def shot(name, pos, target, lens=30, ortho=None):
        cam.location = G(pos)
        d = G(target) - G(pos)
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        if ortho:
            cam_d.type = 'ORTHO'
            cam_d.ortho_scale = ortho
        else:
            cam_d.type = 'PERSP'
            cam_d.lens = lens
        sc.render.filepath = f'{prefix}_{name}.png'
        bpy.ops.render.render(write_still=True)

    day()
    shot('ext34', V(17, 7.5, 21), V(-5, 2.5, 0), 26)
    shot('back34', V(-32, 10, -16), V(-8, 2.5, 0), 28)
    shot('door', V(3.5, 2.0, 15.5), V(0, 2.0, 7.4), 30)
    cam.location = G(V(-7, 60, 0.001))
    cam_d.type = 'ORTHO'
    cam_d.ortho_scale = 32
    cam.rotation_euler = (0, 0, 0)
    sc.render.filepath = f'{prefix}_top.png'
    bpy.ops.render.render(write_still=True)
    shot('interior', V(0, 1.65, 7.3), V(0, 2.8, -4), 14)
    shot('interior_up', V(2, 1.65, 3), V(0, 7.5, -1), 12)
    shot('greenhouse', V(-20.2, 1.65, 2.6), V(-8, 2.2, -0.8), 16)
    night()
    shot('night', V(0, 2.0, 15), V(0, 2.2, 7.5), 30)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--preview', default=None, help='prefix for preview PNGs')
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    make_materials()
    root, objs = build_all()
    export(os.path.abspath(args.out))
    total = 0
    for o in objs:
        t = tri_count(o)
        total += t
        print(f'  {o.name:20s} {t:6d} tris  mats={[m.name for m in o.data.materials]}')
    print(f'TOTAL {total} tris -> {args.out} ({os.path.getsize(args.out) / 1024:.0f} KiB)')
    if args.preview:
        render_previews(os.path.abspath(args.preview))


main()
