"""The brood queen (shared/queen.ts), the crawlers' mother: a giant low eight-legged spider machine, exported as a
glTF binary. Same family and palette as the guardians (tools/blender/guardians.py): older, heavier, more organic.

    tools/blender/run.sh -b --python tools/blender/queen.py                     # writes public/models/queen.glb
    tools/blender/run.sh -b --python tools/blender/queen.py -- --preview <dir>  # also renders PNG previews

One top-level node per part, no parenting, identity transforms; the game (src/world/queen.ts) assembles it and
works the legs with IK. Coordinates are three.js (Y up, +Z forward), rotated into Blender's Z-up frame just before
export (see guardians.py). Lengths must match shared/queen.ts.

  Queen_Thorax     cephalothorax + head. Origin = body centre, forward +Z. Hip sockets at shared/queen.ts SOCKETS.
                   Dark sockets for the weak points: the eye cluster at (0, 0.2, 9.0), two under the belly at
                   (+-2.0, -2.0, 0.8).
  Queen_MandibleL/R  cutters, origin at their hinge (-+1.0, -0.8, 8.3) (thorax frame), opening about Y.
  Queen_AbdomenL/R the brood sac's two halves (-X / +X), origin at the pedicel (0, 0.4, -4.8) (thorax frame),
                   built drooping by ABD_PITCH; the cut faces glow (seen when it splits open, dead).
  Queen_Coxa       hip housing; origin = joint, local +Z along the leg; the femur pitches about local X.
  Queen_Femur      origin = hip joint, +Z to the knee at (0, 0, 9); +Y = top (towards the IK pole).
  Queen_Tibia      origin = knee, +Z to the ankle at (0, 0, 11.5).
  Queen_Tarsus     origin = ankle, +Z to the stabbing tip at (0, 0, 4.5).
"""

import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PI = math.pi

# name -> (sRGB hex, metallic, roughness, emission strength or None)
MATERIALS = {
    'QueenIron': (0x2a2420, 0.6, 0.62, None),       # dark weathered gunmetal, older than the guardians'
    'QueenSteel': (0x564e46, 0.7, 0.45, None),      # worn joints, axles
    'QueenRust': (0x642b15, 0.45, 0.78, None),      # deep rust: undersides, flanges, ribs
    'QueenCeramic': (0xb39c78, 0.1, 0.72, None),    # yellowed, sand-bleached carapace plates
    'QueenHazard': (0xb85a1c, 0.3, 0.6, None),      # faded hazard orange, sparingly
    'QueenDark': (0x14100e, 0.2, 0.85, None),       # cables, recesses, sockets
    'QueenEye': (0xff4a14, 0.0, 0.4, 8.0),          # sensor eyes
    'QueenGlow': (0xff5a10, 0.0, 0.4, 5.0),         # the brood sac's amber-red slits
    'QueenGut': (0xff3a0a, 0.0, 0.5, 2.5),          # inside the sac (the cut faces)
}

# three.js (Y up) -> Blender (Z up): (x, y, z) -> (x, -z, y), a +90 degree turn about X.
C = Matrix.Rotation(PI / 2, 4, 'X')


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lin(hex_color):
    return [srgb_to_linear(((hex_color >> s) & 0xFF) / 255) for s in (16, 8, 0)]


def make_material(name, hex_color, metallic, roughness, emission):
    mat = bpy.data.materials.new(name)
    rgb = lin(hex_color)
    mat.diffuse_color = (*rgb, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    if emission:
        bsdf.inputs['Emission Color'].default_value = (*rgb, 1)
        bsdf.inputs['Emission Strength'].default_value = emission
    mat.use_backface_culling = False  # double-sided: thin plates and cables
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


def smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def T(x, y=None, z=None):
    if y is None:
        return Matrix.Translation(Vector(x))
    return Matrix.Translation(Vector((x, y, z)))


def S(x, y, z):
    return Matrix.Diagonal((x, y, z, 1))


def Rx(a):
    return Matrix.Rotation(a, 4, 'X')


def Ry(a):
    return Matrix.Rotation(a, 4, 'Y')


def Rz(a):
    return Matrix.Rotation(a, 4, 'Z')


def aim(p, d):
    """Matrix putting local +Z along d at point p."""
    d = Vector(d).normalized()
    up = Vector((0, 1, 0)) if abs(d.y) < 0.95 else Vector((1, 0, 0))
    x = up.cross(d).normalized()
    y = d.cross(x)
    m = Matrix((x, y, d)).transposed().to_4x4()
    return T(p) @ m


def oct_ring(z, w, h, ch=None, cx=0.0, cy=0.0):
    """Chamfered rectangle in the XY plane at z. Face k of a loft: 0 +X, 2 bottom, 4 -X, 6 top, odd = chamfers."""
    ch = ch if ch is not None else min(w, h) * 0.25
    hw, hh = w / 2, h / 2
    pts = [(hw, hh - ch), (hw, -hh + ch), (hw - ch, -hh), (-hw + ch, -hh), (-hw, -hh + ch), (-hw, hh - ch),
           (-hw + ch, hh), (hw - ch, hh)]
    return [(cx + x, cy + y, z) for x, y in pts]


def hex_ring(z, w, h, cy=0.0):
    """Hexagon with points on +Y and -Y (a ridge along the back). Faces: 0,1 +X side, 2,3 -X side ... see loft."""
    hw, hh = w / 2, h / 2
    pts = [(0, hh), (hw, hh * 0.35), (hw * 0.8, -hh * 0.5), (0, -hh), (-hw * 0.8, -hh * 0.5), (-hw, hh * 0.35)]
    return [(x, cy + y, z) for x, y in pts]


class MB:
    """bmesh built in three.js coordinates under a transform stack, one material per face."""

    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []
        self.stack = [Matrix.Identity(4)]

    def push(self, m):
        self.stack.append(self.stack[-1] @ m)

    def pop(self):
        self.stack.pop()

    def mi(self, name):
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    def V(self, p):
        return self.bm.verts.new(self.stack[-1] @ Vector(p))

    def F(self, vs, mat):
        f = self.bm.faces.new(vs)
        f.material_index = self.mi(mat)
        f.smooth = False
        return f

    def fix(self, faces):
        if faces:
            bmesh.ops.recalc_face_normals(self.bm, faces=faces)

    def tag(self, verts, mat):
        faces = {f for v in verts for f in v.link_faces}
        for f in faces:
            f.material_index = self.mi(mat)
            f.smooth = False
        return list(faces)

    # ------------------------------------------------------------------ primitives
    def loft(self, rings, mat, cap0=False, cap1=False, matfn=None, closed=True, capmat=None):
        vr = [[self.V(p) for p in r] for r in rings]
        n = len(rings[0])
        faces = []
        for i in range(len(vr) - 1):
            for k in range(n if closed else n - 1):
                j = (k + 1) % n
                m = matfn(i, k) if matfn else mat
                if m is None:
                    continue
                faces.append(self.F([vr[i][k], vr[i][j], vr[i + 1][j], vr[i + 1][k]], m))
        if cap0:
            faces.append(self.F(list(reversed(vr[0])), capmat or mat))
        if cap1:
            faces.append(self.F(vr[-1], capmat or mat))
        self.fix(faces)
        return faces

    def fan(self, ring_pts, tip, mat):
        vs = [self.V(p) for p in ring_pts]
        t = self.V(tip)
        faces = [self.F([vs[k], vs[(k + 1) % len(vs)], t], mat) for k in range(len(vs))]
        self.fix(faces)
        return faces

    def cyl(self, a, b, r1, r2=None, segs=8, mat='QueenIron', cap0=True, cap1=True, phase=0.0, matfn=None):
        """Cylinder/cone from a to b. r2 == 0 makes a spike."""
        a, b = Vector(a), Vector(b)
        d = b - a
        r2 = r1 if r2 is None else r2
        self.push(aim(a, d))
        ring = [(math.cos(phase + 2 * PI * k / segs), math.sin(phase + 2 * PI * k / segs)) for k in range(segs)]
        r0 = [(c * r1, s * r1, 0) for c, s in ring]
        if r2 <= 1e-6:
            faces = self.fan(r0, (0, 0, d.length), mat)
            if cap0:
                faces.append(self.F([self.V(p) for p in reversed(r0)], mat))
        else:
            faces = self.loft([r0, [(c * r2, s * r2, d.length) for c, s in ring]], mat, cap0, cap1, matfn=matfn)
        self.pop()
        return faces

    def disc(self, c, n, r, segs, mat):
        """Flat polygon at c facing n."""
        self.push(aim(Vector(c), n))
        f = [self.F([self.V((r * math.cos(2 * PI * k / segs), r * math.sin(2 * PI * k / segs), 0))
                     for k in range(segs)], mat)]
        self.pop()
        return f

    def lathe(self, profile, segs, mat, M=None, matfn=None, phase=0.0, closed=False):
        """Revolve (r, z) profile about local Z (then M). matfn(k_profile)."""
        rings = [[(r * math.cos(phase + 2 * PI * i / segs), r * math.sin(phase + 2 * PI * i / segs), z)
                  for i in range(segs)] for r, z in profile]
        if closed:
            rings.append(rings[0])
        self.push(M if M is not None else Matrix.Identity(4))
        f = self.loft(rings, mat, matfn=(lambda i, k: matfn(i)) if matfn else None)
        self.pop()
        return f

    def box(self, c, size, mat, rot=(0, 0, 0), taper=(1, 1), M=None):
        """Box centred on c. taper scales the top (+Y) face in x and z."""
        verts = bmesh.ops.create_cube(self.bm, size=1)['verts']
        for v in verts:
            x, y, z = v.co
            if y > 0:
                x *= taper[0]
                z *= taper[1]
            v.co = Vector((x * size[0], y * size[1], z * size[2]))
        mm = self.stack[-1] @ (M if M is not None else Matrix.Identity(4)) @ T(c) @ Euler(rot).to_matrix().to_4x4()
        bmesh.ops.transform(self.bm, matrix=mm, verts=verts)
        return self.tag(verts, mat)

    def beam(self, a, b, w, h, mat, up=(0, 1, 0)):
        """Box from a to b with cross-section w x h, h along `up`."""
        a, b = Vector(a), Vector(b)
        d = (b - a)
        z = d.normalized()
        y = Vector(up)
        y = (y - z * y.dot(z)).normalized()
        x = y.cross(z)
        m = Matrix((x, y, z)).transposed().to_4x4()
        return self.box((0, 0, d.length / 2), (w, h, d.length), mat, M=T(a) @ m)

    def sphere(self, c, r, mat, u=8, v=5, scale=(1, 1, 1), M=None):
        # built by hand: bmesh's create_uvsphere orders its faces differently from run to run
        self.push((M if M is not None else Matrix.Identity(4)) @ T(c) @ S(*scale))
        rings = []
        for j in range(1, v):
            sj, cj = math.sin(PI * j / v), math.cos(PI * j / v)
            rings.append([(r * sj * math.cos(2 * PI * i / u), r * sj * math.sin(2 * PI * i / u), -r * cj)
                          for i in range(u)])
        faces = self.loft(rings, mat)
        faces += self.fan(list(reversed(rings[0])), (0, 0, -r), mat)
        faces += self.fan(rings[-1], (0, 0, r), mat)
        self.pop()
        return faces

    def prism_x(self, poly, x0, x1, mat):
        """Extrude a (y, z) polygon along X."""
        return self.loft([[(x0, y, z) for y, z in poly], [(x1, y, z) for y, z in poly]], mat, True, True)

    def sweep(self, pts, r, mat, segs=5, radii=None):
        """Tube through a polyline, capped."""
        pts = [Vector(p) for p in pts]
        n = len(pts)
        rings = []
        ref = Vector((1, 0, 0))
        for i, p in enumerate(pts):
            t = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
            if abs(t.dot(ref)) > 0.9:
                ref = Vector((0, 1, 0)) if abs(t.y) < 0.9 else Vector((1, 0, 0))
            u = (ref - t * ref.dot(t)).normalized()
            w = t.cross(u)
            rr = radii[i] if radii else r
            rings.append([tuple(p + (u * math.cos(a) + w * math.sin(a)) * rr)
                          for a in (2 * PI * (k + 0.5) / segs for k in range(segs))])
            ref = u
        return self.loft(rings, mat, True, True)

    def cable(self, a, b, sag, r, mat='QueenDark', n=6, segs=5):
        a, b = Vector(a), Vector(b)
        pts = [a.lerp(b, t) - Vector((0, sag * 4 * t * (1 - t), 0)) for t in (i / n for i in range(n + 1))]
        return self.sweep(pts, r, mat, segs)

    def shell(self, surf, u0, u1, v0, v1, nu, nv, off, thick, mat, edge_mat=None, inset=0.0, inner=False):
        """Armour plate following surf(u, v) -> (point, outward normal), lifted `off`, `thick` thick.
        inset shrinks the outer face a little (bevelled edge)."""
        gi, go = [], []
        for j in range(nv + 1):
            ri, ro = [], []
            for i in range(nu + 1):
                u = lerp(u0, u1, i / nu)
                v = lerp(v0, v1, j / nv)
                p, n = surf(u, v)
                pi_ = p + n * off
                po = p + n * (off + thick)
                if inset and (i in (0, nu) or j in (0, nv)):
                    # pull edge verts of the outer face towards the plate centre
                    pc, _ = surf((u0 + u1) / 2, (v0 + v1) / 2)
                    pc = pc + n * (off + thick)
                    po = po.lerp(pc, inset)
                ri.append(self.V(pi_))
                ro.append(self.V(po))
            gi.append(ri)
            go.append(ro)
        faces = []
        em = edge_mat or mat
        for j in range(nv):
            for i in range(nu):
                faces.append(self.F([go[j][i], go[j][i + 1], go[j + 1][i + 1], go[j + 1][i]], mat))
                if inner:
                    faces.append(self.F([gi[j][i], gi[j + 1][i], gi[j + 1][i + 1], gi[j][i + 1]], em))
        border = [(0, i) for i in range(nu)] + [(j, nu) for j in range(nv)] + \
                 [(nv, i) for i in range(nu, 0, -1)] + [(j, 0) for j in range(nv, 0, -1)]
        for k in range(len(border)):
            a = border[k]
            b = border[(k + 1) % len(border)]
            faces.append(self.F([gi[a[0]][a[1]], gi[b[0]][b[1]], go[b[0]][b[1]], go[a[0]][a[1]]], em))
        self.fix(faces)
        return faces

    def rivet(self, p, n, size=0.09, mat='QueenSteel'):
        p, n = Vector(p), Vector(n).normalized()
        return self.cyl(p - n * size * 0.3, p + n * size * 0.7, size, 0, segs=4, mat=mat, cap0=False)

    def glow_slit(self, c, size, M=None, rot=(0, 0, 0)):
        return self.box(c, size, 'QueenEye', rot=rot, M=M)


def surf_normal(fn, u, v, center, eps=1e-3):
    p = fn(u, v)
    du = fn(u + eps, v) - fn(u - eps, v)
    dv = fn(u, v + eps) - fn(u, v - eps)
    n = du.cross(dv)
    if n.length < 1e-9:
        n = p - center
    n.normalize()
    if n.dot(p - center) < 0:
        n = -n
    return p, n


# =================================================================================================== queen

FEMUR, TIBIA, TARSUS, LEAN = 9.0, 11.5, 4.5, 0.42
BODY_H = 7.2
SOCKETS = [(3.7, 0.2, 3.0), (4.2, 0.2, 1.0), (4.2, 0.2, -1.0), (3.7, 0.2, -3.0)]
SOCKETS += [(-x, y, z) for x, y, z in SOCKETS]
REST_A = [0.62, 1.25, 1.9, 2.55]
REST_D = [16, 15, 15, 16]
PEDICEL = (0, 0.4, -4.8)
ABD_PITCH = -0.25
HINGES = [(-1.0, -0.8, 8.3), (1.0, -0.8, 8.3)]
UP = Vector((0, 1, 0))


def rest(i):
    k, s = i % 4, (1 if i < 4 else -1)
    return Vector((math.sin(REST_A[k]) * REST_D[k] * s, 0, math.cos(REST_A[k]) * REST_D[k]))


def rows_at(rows, z):
    """Piecewise-linear lookup in rows of (z, *values)."""
    if z <= rows[0][0]:
        return rows[0][1:]
    for a, b in zip(rows, rows[1:]):
        if z <= b[0]:
            t = (z - a[0]) / (b[0] - a[0])
            return tuple(lerp(p, q, t) for p, q in zip(a[1:], b[1:]))
    return rows[-1][1:]


def spow(v, e):
    return math.copysign(abs(v) ** e, v)


def ring_pt(z, w, top, bot, a, ex=0.6, cy=0.0):
    """Point at angle a round a rounded (superellipse) cross-section at z: half width w/2, top above and bot below."""
    c, s = math.cos(a), math.sin(a)
    return Vector((w / 2 * spow(c, ex), cy + (top if s >= 0 else bot) * spow(s, ex), z))


def band(a):
    """Which band an angle round a cross-section is in: 1 top, 0 side, -1 belly."""
    s = math.sin(a)
    return 1 if s > 0.35 else (-1 if s < -0.35 else 0)


TH = [(-4.9, 3.6, 1.0, 0.8), (-4.3, 6.4, 1.9, 1.4), (-2.6, 8.0, 2.5, 1.9), (0.2, 8.7, 2.7, 2.0),
      (2.8, 8.0, 2.45, 1.85), (4.6, 6.6, 2.0, 1.6), (5.6, 5.0, 1.6, 1.4)]
HEAD = [(5.3, 4.9, 1.55, 1.4), (6.5, 4.6, 1.75, 1.45), (7.7, 4.0, 1.55, 1.35), (8.5, 3.0, 1.15, 1.05),
        (9.0, 1.9, 0.7, 0.7)]


def section_loft(mb, rows, n, matfn_band, cap0=False, cap1=False, capmat='QueenDark'):
    rings = []
    for z, w, top, bot in rows:
        rings.append([tuple(ring_pt(z, w, top, bot, 2 * PI * k / n)) for k in range(n)])
    return mb.loft(rings, None, cap0, cap1, matfn=lambda i, k: matfn_band(i, band(2 * PI * (k + 0.5) / n)),
                   capmat=capmat)


def build_thorax():
    mb = MB()
    n = 16
    section_loft(mb, TH, n, lambda i, b: 'QueenIron' if b == 1 else ('QueenRust' if b == -1 else 'QueenDark'),
                 cap0=True)
    section_loft(mb, HEAD, n, lambda i, b: 'QueenIron' if b >= 0 else 'QueenRust', cap1=True)

    def surf_of(rows):
        def f(a, z):
            w, top, bot = rows_at(rows, z)
            return ring_pt(z, w, top, bot, a)
        return lambda a, z: surf_normal(f, a, z, Vector((0, 0, z)))
    th, hd = surf_of(TH), surf_of(HEAD)
    # carapace: overlapping bleached plates, a dorsal row and a row down each flank, staggered
    for z0, z1 in ((-4.2, -1.5), (-1.7, 1.3), (1.1, 4.3)):
        mb.shell(th, 1.12, 2.02, z0, z1, 3, 2, 0.04, 0.24, 'QueenCeramic', 'QueenIron', inset=0.08)
    for z0, z1 in ((-3.4, -0.4), (-0.6, 2.6), (2.4, 4.8)):
        mb.shell(th, 0.42, 1.06, z0, z1, 2, 2, 0.04, 0.2, 'QueenCeramic', 'QueenIron', inset=0.1)
        mb.shell(th, PI - 1.06, PI - 0.42, z0, z1, 2, 2, 0.04, 0.2, 'QueenCeramic', 'QueenIron', inset=0.1)
    # head: a brow plate over the eyes
    mb.shell(hd, 0.75, PI - 0.75, 5.4, 7.6, 3, 2, 0.04, 0.2, 'QueenCeramic', 'QueenIron', inset=0.08)
    # dorsal spines raking back along the ridge
    for z, h in ((-3.0, 1.3), (-0.4, 1.7), (2.2, 1.4)):
        y = rows_at(TH, z)[1] + 0.2
        mb.cyl((0, y - 0.2, z), (0, y + h, z - 1.1), 0.34, 0, 4, 'QueenCeramic', phase=PI / 4, cap0=False)
    # hip collars round the sockets, facing out along each leg
    for i, (sx, sy, sz) in enumerate(SOCKETS):
        r = rest(i)
        d = Vector((r.x - sx, 0, r.z - sz)).normalized()
        p = Vector((sx, sy, sz))
        mb.cyl(p - d * 1.3, p - d * 0.25, 1.05, 0.98, 10, 'QueenIron', cap0=False, cap1=False)
        mb.cyl(p - d * 0.75, p - d * 0.55, 1.2, 1.2, 10, 'QueenRust', cap0=False, cap1=False)
    # belly: weak point sockets and the hoses between them
    for s in (-1, 1):
        c = Vector((s * 2.0, -2.0, 0.8))
        nrm = Vector((s * 0.4, -1, 0)).normalized()
        mb.cyl(c - nrm * 0.3, c + nrm * 0.1, 1.35, 1.25, 10, 'QueenRust', cap0=False)
        mb.disc(c + nrm * 0.11, nrm, 1.0, 10, 'QueenDark')
        mb.sweep([(s * 0.6, -1.9, -4.0), (s * 1.2, -2.25, -2.0), (s * 1.0, -2.2, 0.0), (s * 0.5, -2.05, 2.5),
                  (s * 0.9, -1.8, 4.4)], 0.16, 'QueenDark', 4)
    # pedicel (the abdomen's neck joint)
    mb.cyl((0, 0.4, -4.4), (0, 0.4, -5.3), 1.5, 1.4, 10, 'QueenDark', cap0=False)
    mb.cyl((0, 0.4, -4.95), (0, 0.4, -5.15), 1.6, 1.6, 10, 'QueenSteel', cap0=False, cap1=False)
    # eyes: many small glowing lenses round the weak point socket at the front, each in a dark rim
    eyes = [(0.78, 1.12, 8.2, 0.34), (1.38, 0.9, 7.75, 0.24), (0.38, 1.38, 7.6, 0.2), (1.75, 0.45, 7.85, 0.16),
            (1.1, 1.48, 6.95, 0.14), (0.62, 0.62, 8.7, 0.17), (1.5, -0.25, 8.0, 0.13), (0.95, -0.2, 8.6, 0.15)]
    for x, y, z, r in eyes:
        for s in (-1, 1):
            c = Vector((s * x, y, z))
            nrm = Vector((s * x * 0.5, y * 0.6, 1.6)).normalized()
            mb.cyl(c - nrm * 0.25, c + nrm * 0.05, r * 1.35, r * 1.3, 8, 'QueenDark', cap0=False, cap1=False)
            mb.sphere(c, r, 'QueenEye', 8, 4)
    mb.cyl((0, 0.2, 8.6), (0, 0.2, 9.05), 1.25, 1.2, 12, 'QueenRust', cap0=False)
    # cutter mounts
    for hx, hy, hz in HINGES:
        mb.box((hx, hy + 0.1, hz - 0.3), (0.9, 0.9, 1.1), 'QueenIron')
    return finish(mb, 'Queen_Thorax')


def build_mandible(s, name):
    """A cutter for the side of sign s, origin at its hinge, curving forward, down and in."""
    mb = MB()
    pts = [(0, 0, 0), (0.25 * s, -0.45, 1.1), (0.08 * s, -1.15, 2.15), (-0.42 * s, -1.7, 2.8), (-0.85 * s, -1.95, 3.0)]
    mb.sweep(pts, 0.4, 'QueenIron', 6, radii=[0.45, 0.4, 0.32, 0.2, 0.05])
    mb.cyl((-0.45, 0, 0), (0.45, 0, 0), 0.5, None, 8, 'QueenSteel')
    # an armour plate on the outside and teeth along the inner edge
    mb.sweep([(0.38 * s, 0.05, 0.3), (0.5 * s, -0.4, 1.2), (0.35 * s, -1.05, 2.0)], 0.2, 'QueenCeramic', 4)
    for x, y, z in ((0.0, -0.75, 1.55), (-0.1 * s, -1.2, 2.2), (-0.35 * s, -1.55, 2.6)):
        p = Vector((x - 0.2 * s, y, z))
        mb.cyl(p, p + Vector((-0.45 * s, -0.15, 0.15)), 0.14, 0, 4, 'QueenSteel', cap0=False)
    return finish(mb, name)


AB_ZC, AB_AZ = -9.4, 8.3
AB_RX, AB_TOP, AB_BOT, AB_CY = 5.6, 4.2, 3.6, 0.4


def ab_f(z):
    if z > -1.4:
        return None
    t = (z - AB_ZC) / AB_AZ
    return math.sqrt(max(0.0, 1 - t * t))


def ab_ring(z, s, k, n, ex=0.62, scale=1.0):
    """Half cross-section point k of n (0 belly ... n top) on the +X (s=1) or -X side."""
    f = ab_f(z)
    if f is None:  # neck
        f = 0.3
    f = max(f, 0.06) * scale
    a = -PI / 2 + PI * k / n
    c, sn = math.cos(a), math.sin(a)
    x = s * AB_RX * f * spow(c, ex)
    y = AB_CY + (AB_TOP if sn >= 0 else AB_BOT) * f * spow(sn, ex)
    return (x, y, z)


def ab_top(x, z, ex=0.62):
    """Height of the abdomen's top surface at (x, z) (unpitched frame)."""
    f = max(ab_f(z) or 0.3, 0.06)
    c = min(1.0, abs(x) / (AB_RX * f)) ** (1 / ex)
    return AB_CY + AB_TOP * f * math.sqrt(max(0.0, 1 - c * c)) ** ex


RIBS = [-2.6, -4.6, -6.6, -8.6, -10.6, -12.6, -14.6]


def build_abdomen(s, name):
    mb = MB()
    mb.push(Rx(ABD_PITCH))
    n = 10
    # rings front to back: the neck, then plates with a recessed glowing groove at every rib
    zs = [(-0.2, 1.0), (-1.0, 1.0), (-1.5, 1.0)]
    for r in RIBS:
        zs += [(r + 0.13, 1.0), (r, 0.9), (r - 0.13, 1.0)]
    zs += [(-15.8, 1.0), (-16.8, 1.0), (-17.4, 1.0), (-17.7, 1.0)]
    rings = [[ab_ring(z, s, k, n, scale=sc) for k in range(n + 1)] for z, sc in zs]
    vr = [[mb.V(p) for p in r] for r in rings]
    faces = []
    for i in range(len(vr) - 1):
        groove = zs[i][1] < 1 or zs[i + 1][1] < 1
        for k in range(n):
            a = -PI / 2 + PI * (k + 0.5) / n
            if groove:
                m = 'QueenGlow' if math.sin(a) > 0.2 else 'QueenDark'
            elif zs[i][0] > -1.45:
                m = 'QueenDark'
            else:
                b = band(a)
                m = 'QueenCeramic' if b == 1 else ('QueenIron' if b == 0 else 'QueenRust')
            faces.append(mb.F([vr[i][k], vr[i][k + 1], vr[i + 1][k + 1], vr[i + 1][k]], m))
        # the cut face down the middle: the sac's glowing inside, seen when it splits open
        faces.append(mb.F([vr[i][0], vr[i + 1][0], vr[i + 1][n], vr[i][n]], 'QueenGut'))
    # front (neck) cap and the tail tip
    faces.append(mb.F(list(reversed(vr[0])), 'QueenDark'))
    tip = mb.V((0, AB_CY, -17.8))
    for k in range(n):
        faces.append(mb.F([vr[-1][k], vr[-1][k + 1], tip], 'QueenRust'))
    mb.fix(faces)
    # dorsal spikes beside the ridge, raking back
    for z in (-5.6, -9.6, -13.4):
        x = s * 0.9
        y = ab_top(x, z)
        mb.cyl((x, y - 0.3, z), (x * 1.2, y + 1.1, z - 1.0), 0.3, 0, 4, 'QueenCeramic', phase=PI / 4, cap0=False)
    # glowing egg ports along the flank
    for z in (-7.6, -11.6):
        f = ab_f(z)
        c = Vector((s * AB_RX * f * 0.97, AB_CY - 0.4, z))
        nrm = Vector((s, -0.1, 0)).normalized()
        mb.cyl(c - nrm * 0.3, c + nrm * 0.15, 0.75, 0.7, 8, 'QueenRust', cap0=False)
        mb.disc(c + nrm * 0.16, nrm, 0.5, 8, 'QueenGlow')
    # spinnerets under the tail
    for x, y, z in ((0.9, -0.6, -16.4), (0.3, -1.1, -15.9)):
        p = Vector((s * x, AB_CY + y, z))
        mb.cyl(p, p + Vector((s * 0.2, -0.9, -0.8)), 0.38, 0.22, 6, 'QueenRust', cap0=False)
    mb.pop()
    return finish(mb, name)


def build_coxa():
    mb = MB()
    mb.sphere((0, 0, 0), 0.85, 'QueenSteel', 8, 5)
    mb.cyl((0, 0, -1.0), (0, 0, -0.35), 0.92, 0.9, 10, 'QueenIron', cap0=False)
    for s in (-1, 1):
        mb.box((s * 0.78, 0, 0.05), (0.26, 1.2, 1.3), 'QueenIron')
        mb.cyl((s * 0.9, 0, 0), (s * 1.08, 0, 0), 0.38, 0.32, 6, 'QueenRust', cap0=False)
    mb.box((0, 0.92, -0.35), (0.22, 0.4, 0.9), 'QueenHazard', taper=(0.5, 0.6))
    return finish(mb, 'Queen_Coxa')


def build_femur():
    mb = MB()
    L = FEMUR
    mb.cyl((-0.62, 0, 0), (0.62, 0, 0), 0.6, None, 8, 'QueenIron', phase=PI / 8)
    rings = [oct_ring(0.3, 0.95, 1.05, 0.28), oct_ring(1.4, 1.15, 1.3, 0.34), oct_ring(5.0, 1.0, 1.12, 0.3),
             oct_ring(8.0, 0.8, 0.86, 0.24), oct_ring(8.7, 0.66, 0.66, 0.2)]
    mb.loft(rings, 'QueenIron', cap1=True, matfn=lambda i, k: 'QueenRust' if k == 2 else 'QueenIron')
    mb.cyl((-0.5, 0, L), (0.5, 0, L), 0.55, None, 8, 'QueenSteel', phase=PI / 8)

    def surf(u, v):
        w = lerp(1.25, 0.85, v / 8.5)
        h = lerp(1.4, 0.9, v / 8.5)
        a = lerp(-1.1, 1.1, u)
        return Vector((math.sin(a) * w * 0.55, math.cos(a) * h * 0.5, v)), Vector((math.sin(a), math.cos(a), 0))
    for z0, z1 in ((1.0, 4.0), (4.3, 7.4)):
        mb.shell(surf, 0, 1, z0, z1, 2, 1, 0.03, 0.16, 'QueenCeramic', 'QueenIron', inset=0.1)
    for z, h in ((2.5, 0.8), (5.8, 0.65), (8.0, 0.5)):
        y = lerp(0.7, 0.45, z / 9)
        mb.cyl((0, y, z), (0, y + h, z - 0.6), 0.16, 0, 4, 'QueenSteel', phase=PI / 4, cap0=False)
    mb.loft([oct_ring(1.6, 1.22, 1.36, 0.35), oct_ring(1.95, 1.22, 1.36, 0.35)], 'QueenHazard',
            matfn=lambda i, k: 'QueenHazard' if k % 2 == 0 else 'QueenDark')
    mb.sweep([(0.55, -0.1, 0.9), (0.62, -0.35, 3.5), (0.5, -0.3, 6.5), (0.36, -0.1, 8.4)], 0.09, 'QueenDark', 4)
    mb.glow_slit((-0.52, 0.05, 3.0), (0.04, 0.1, 1.0))
    return finish(mb, 'Queen_Femur')


def build_tibia():
    mb = MB()
    L = TIBIA
    mb.cyl((-0.42, 0, 0), (0.42, 0, 0), 0.48, None, 8, 'QueenIron', phase=PI / 8)
    rings = [hex_ring(0.2, 0.78, 0.92), hex_ring(1.4, 0.86, 1.1), hex_ring(5.5, 0.66, 0.82),
             hex_ring(10.3, 0.42, 0.5), hex_ring(11.2, 0.34, 0.38)]
    mb.loft(rings, 'QueenIron', matfn=lambda i, k: 'QueenRust' if k in (2, 3) else 'QueenIron')
    for i, z in enumerate((2.4, 4.6, 6.8, 9.0)):
        sc = lerp(1.0, 0.55, i / 3)
        h = lerp(0.75, 0.4, i / 3)
        by = lerp(0.5, 0.25, z / 11)
        mb.loft([[(0.07 * sc, by, z - 0.4 * sc), (0.07 * sc, by, z + 0.4 * sc),
                  (-0.07 * sc, by, z + 0.4 * sc), (-0.07 * sc, by, z - 0.4 * sc)],
                 [(0.02, by + h, z - 0.7 * sc), (0.02, by + h * 0.75, z - 0.55 * sc),
                  (-0.02, by + h * 0.75, z - 0.55 * sc), (-0.02, by + h, z - 0.7 * sc)]],
                'QueenCeramic' if i < 2 else 'QueenIron', cap1=True)
    for z, w, h in ((1.0, 0.92, 1.18), (8.0, 0.56, 0.66)):
        mb.loft([hex_ring(z - 0.2, w, h), hex_ring(z + 0.2, w, h)], 'QueenRust')
    mb.lathe([(0.28, L - 0.8), (0.46, L - 0.45), (0.38, L - 0.15)], 8, 'QueenIron',
             matfn=lambda k: 'QueenSteel' if k == 1 else 'QueenIron')
    mb.cyl((0, -0.5, 1.1), (0, -0.4, 6.0), 0.13, None, 6, 'QueenSteel', cap0=False)
    return finish(mb, 'Queen_Tibia')


def build_tarsus():
    mb = MB()
    L = TARSUS
    mb.sphere((0, 0, 0), 0.42, 'QueenSteel', 8, 5)
    rings = [oct_ring(0.25, 0.5, 0.55, 0.15), oct_ring(1.4, 0.5, 0.56, 0.15), oct_ring(3.3, 0.3, 0.32, 0.09)]
    mb.loft(rings, 'QueenIron', matfn=lambda i, k: 'QueenRust' if k == 2 else 'QueenIron')
    mb.fan(oct_ring(3.3, 0.3, 0.32, 0.09), (0, 0, L), 'QueenSteel')
    mb.loft([oct_ring(0.5, 0.58, 0.63, 0.17), oct_ring(1.2, 0.58, 0.63, 0.17)], 'QueenCeramic')
    # a barb raking back off the spike, and a dew claw
    mb.cyl((0, 0.1, 3.0), (0, 0.55, 2.3), 0.12, 0, 4, 'QueenSteel', cap0=False)
    mb.cyl((0, -0.12, 2.4), (0, -0.7, 2.0), 0.13, 0, 4, 'QueenSteel', cap0=False)
    return finish(mb, 'Queen_Tarsus')


# ================================================================================================= helpers

def finish(mb, name, loc=None):
    bmesh.ops.transform(mb.bm, matrix=C, verts=mb.bm.verts)
    mb.bm.normal_update()
    mesh = bpy.data.meshes.new(name)
    mb.bm.to_mesh(mesh)
    mb.bm.free()
    for m in mb.mats:
        mesh.materials.append(bpy.data.materials[m])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    if loc is not None:
        obj.location = C @ Vector(loc)
    return obj


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def export_glb(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=True,
        export_materials='EXPORT', export_normals=True, export_texcoords=False,
    )


# ================================================================================================= preview

def aim_pole(p, d, pole):
    z = Vector(d).normalized()
    x = Vector(pole).cross(z)
    if x.length < 1e-6:
        x = Vector((1, 0, 0))
    x.normalize()
    y = z.cross(x)
    return T(p) @ Matrix((x, y, z)).transposed().to_4x4()


def leg_mats(body_M, i, foot):
    """Matrices (three.js) of coxa, femur, tibia, tarsus for leg i of a body at body_M, tip at foot (world)."""
    H = body_M @ Vector(SOCKETS[i])
    F = Vector(foot)
    out = Vector((F.x - H.x, 0, F.z - H.z)).normalized()
    A = F + UP * TARSUS * math.cos(LEAN) - out * TARSUS * math.sin(LEAN)
    v = A - H
    D = min(FEMUR + TIBIA - 0.01, max(abs(TIBIA - FEMUR) + 0.1, v.length))
    vn = v.normalized()
    pole = (UP + out * 0.15).normalized()
    p = (pole - vn * pole.dot(vn)).normalized()
    along = (FEMUR ** 2 - TIBIA ** 2 + D ** 2) / (2 * D)
    up = math.sqrt(max(0, FEMUR ** 2 - along ** 2))
    K = H + vn * along + p * up
    psi = math.atan2(out.x, out.z)
    return (T(H) @ Ry(psi), aim_pole(H, K - H, pole), aim_pole(K, A - K, pole), aim_pole(A, F - A, out))


def place(src, M3, coll):
    o = src.copy()
    o.hide_render = False
    coll.objects.link(o)
    o.matrix_world = C @ M3 @ C.inverted()
    return o


def render_previews(parts, points, out_dir, only=None):
    os.makedirs(out_dir, exist_ok=True)
    scene = bpy.context.scene
    for engine in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x, scene.render.resolution_y = 1200, 760
    scene.view_settings.view_transform = 'Standard'
    for o in parts.values():
        o.hide_render = True
    bpy.ops.mesh.primitive_plane_add(size=1200, location=(0, 0, 0))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new('ground')
    gm.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (*lin(0xc46a24), 1)
    gm.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value = 1.0
    ground.data.materials.append(gm)
    world = scene.world or bpy.data.worlds.new('world')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (*lin(0xe07b28), 1)
    bg.inputs['Strength'].default_value = 0.7
    sd = bpy.data.lights.new('sun', 'SUN')
    sd.energy = 4.0
    sd.color = (1.0, 0.72, 0.45)
    sun = bpy.data.objects.new('sun', sd)
    sun.rotation_euler = (math.radians(90 - 16), 0, math.radians(-150))
    scene.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.clip_end = 3000

    def look(pos3, target3, lens):
        p = C @ Vector(pos3)
        t = C @ Vector(target3)
        cam.location = p
        cam.rotation_euler = (t - p).to_track_quat('-Z', 'Y').to_euler()
        cam.data.lens = lens

    def shoot(name):
        if only and name not in only:
            return
        scene.render.filepath = os.path.join(out_dir, name)
        bpy.ops.render.render(write_still=True)

    hm = bpy.data.materials.new('human')
    hm.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (0.05, 0.15, 0.6, 1)
    lm = bpy.data.materials['QueenEye']

    def assemble(name, body_y, feet, pitch=0.0, abd=0.0, jaw=0.0):
        coll = bpy.data.collections.new(name)
        scene.collection.children.link(coll)
        B = T(0, body_y, 0) @ Rx(-pitch)
        place(parts['Queen_Thorax'], B, coll)
        for nm, (hx, hy, hz), s in (('Queen_MandibleL', HINGES[0], -1), ('Queen_MandibleR', HINGES[1], 1)):
            place(parts[nm], B @ T(hx, hy, hz) @ Ry(s * jaw), coll)
        A = B @ T(PEDICEL) @ Rx(abd)
        place(parts['Queen_AbdomenL'], A, coll)
        place(parts['Queen_AbdomenR'], A, coll)
        for i in range(8):
            for part, M in zip(('Queen_Coxa', 'Queen_Femur', 'Queen_Tibia', 'Queen_Tarsus'), leg_mats(B, i, feet[i])):
                place(parts[part], M, coll)
        # weak points as red balls where the game puts its lenses
        for frame, (x, y, z, r) in points:
            M = B if frame == 'thorax' else A @ Rx(ABD_PITCH)
            p = M @ Vector((x, y, z))
            bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=C @ p, segments=12, ring_count=8)
            o = bpy.context.active_object
            o.data.materials.append(lm)
            for c in o.users_collection:
                c.objects.unlink(o)
            coll.objects.link(o)
        return coll

    feet = [rest(i) for i in range(8)]
    rig = assemble('stand', BODY_H, feet)
    bpy.ops.mesh.primitive_cube_add(size=1)
    human = bpy.context.active_object
    human.scale = (0.5, 0.35, 1.8)
    human.location = C @ Vector((6, 0.9, 22))
    human.data.materials.append(hm)

    look((58, 22, 40), (0, 5, -3), 30)
    shoot('queen_34.png')
    look((75, 7, -4), (0, 6, -4), 30)
    shoot('queen_side.png')
    look((7, 1.7, 34), (0, 8, 0), 24)
    shoot('queen_front_low.png')
    look((26, 60, -10), (0, 4, -3), 30)
    shoot('queen_top.png')
    look((9, 9.5, 20), (0, 7, 8), 40)
    shoot('queen_head.png')
    look((-40, 9, -45), (0, 6, -6), 30)
    shoot('queen_back.png')
    look((14, 1.0, 6), (0, 5.2, 1), 24)
    shoot('queen_under.png')
    bg.inputs['Color'].default_value = (*lin(0xf7a440), 1)
    bg.inputs['Strength'].default_value = 1.3
    sd.energy = 0.6
    look((-55, 3, 40), (0, 8, 0), 26)
    shoot('queen_dusk.png')
    bg.inputs['Color'].default_value = (*lin(0xe07b28), 1)
    bg.inputs['Strength'].default_value = 0.7
    sd.energy = 4.0
    rig.hide_render = True

    # reared up: front legs raised high
    feet2 = list(feet)
    for i in (0, 4):
        s = 1 if i < 4 else -1
        feet2[i] = Vector((s * 5.0, 15.0, 14.0))
    rig2 = assemble('rear', BODY_H + 2.5, feet2, pitch=0.42, abd=0.3, jaw=0.4)
    look((60, 10, 30), (0, 8, 0), 28)
    shoot('queen_rear.png')
    rig2.hide_render = True
    human.hide_render = True


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models'))
    ap.add_argument('--preview', default=None, help='directory for PNG previews')
    ap.add_argument('--only', default=None, help='comma-separated preview names to render')
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in MATERIALS.items():
        make_material(name, *spec)

    parts = {}
    parts['Queen_Thorax'] = build_thorax()
    parts['Queen_MandibleL'] = build_mandible(-1, 'Queen_MandibleL')
    parts['Queen_MandibleR'] = build_mandible(1, 'Queen_MandibleR')
    parts['Queen_AbdomenL'] = build_abdomen(-1, 'Queen_AbdomenL')
    parts['Queen_AbdomenR'] = build_abdomen(1, 'Queen_AbdomenR')
    parts['Queen_Coxa'] = build_coxa()
    parts['Queen_Femur'] = build_femur()
    parts['Queen_Tibia'] = build_tibia()
    parts['Queen_Tarsus'] = build_tarsus()

    os.makedirs(args.out, exist_ok=True)
    export_glb(list(parts.values()), os.path.join(args.out, 'queen.glb'))
    total = 0
    for o in parts.values():
        n = tri_count(o)
        total += n * (8 if o.name in ('Queen_Coxa', 'Queen_Femur', 'Queen_Tibia', 'Queen_Tarsus') else 1)
        bb = [C.inverted() @ Vector(c) for c in o.bound_box]
        lo = [min(v[i] for v in bb) for i in range(3)]
        hi = [max(v[i] for v in bb) for i in range(3)]
        print(f'{o.name}: tris={n} bbox x {lo[0]:.2f}..{hi[0]:.2f} y {lo[1]:.2f}..{hi[1]:.2f} '
              f'z {lo[2]:.2f}..{hi[2]:.2f} mats={[m.name for m in o.data.materials]}')
    print(f'assembled queen tris: {total}')
    # weak points (src/world/queen.ts POINTS): lens centres a little under the surface, and radius
    pts = [('thorax', (0, 0.2, 9.1, 1.0)), ('thorax', (-2.0, -2.05, 0.8, 0.9)), ('thorax', (2.0, -2.05, 0.8, 0.9))]
    for x, z in ((-1.7, -6.6), (1.7, -11.6)):
        pts.append(('abdomen', (x, round(ab_top(x, z) - 0.15, 2), z, 1.2)))
    pts.append(('abdomen', (0, AB_CY + 0.6, -17.5, 1.1)))
    print('weak points:', pts)
    if args.preview:
        render_previews(parts, pts, os.path.abspath(args.preview), args.only.split(',') if args.only else None)


main()

