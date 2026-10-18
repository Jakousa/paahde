"""The fixed-wing drones (shared/jets.ts): an unmanned recon/strike plane, MQ-9 / Bayraktar-like, exported as a glTF
binary.

    tools/blender/run.sh -b --python tools/blender/jet.py                     # writes public/models/jet.glb
    tools/blender/run.sh -b --python tools/blender/jet.py -- --preview <dir>  # also renders PNG previews

All coordinates are three.js (Y up, +Z forward = the nose, span along X), built in three.js space and turned into
Blender's Z-up frame just before export (as tools/blender/carrier.py does), so the glTF exporter's Y-up conversion
gives these numbers back. Modelled for an 18 m span (shared/jets.ts JET_SPAN), 11.4 m long; origin about the centre
of mass, keep inside src/world/jets.ts BOXES.

  Jet_Body   the whole plane: slim fuselage with a satcom bulge over the nose and a sensor ball under the chin, the
             intake hump over the back running into the jet nozzle, long straight wings with ailerons and flaps, a
             V tail and ventral fin, two pylons a wing with a missile on each, antennas and probes.
  Tail       an empty at the nozzle exit (0, 0.5, -5.8) = src/world/jets.ts TAIL, where the smoke streams from.

Materials are flat Principled BSDF colours (no textures, no lamps): a dark warm grey hull with worn sand camo
blotches on top, darker control surfaces and panel lines. Units are metres. Deterministic.
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
    'JetHull': (0x3a332d, 0.45, 0.6, None),      # the old jets' grey-brown
    'JetSand': (0x8a7556, 0.25, 0.75, None),     # worn sand camo blotches on top
    'JetFlap': (0x2a2420, 0.45, 0.6, None),      # control surfaces, a shade darker
    'JetDark': (0x15110f, 0.6, 0.45, None),      # intake, nozzle inside, panel lines, rubber
    'JetSteel': (0x6a6158, 0.8, 0.35, None),     # nozzle, intake lip, rails, probes
    'JetBurnt': (0x3b2a22, 0.7, 0.5, None),      # heat-stained nozzle band
    'JetGlass': (0x0c0d10, 0.3, 0.1, None),      # sensor windows
    'JetMissile': (0x8b8574, 0.3, 0.55, None),   # pale grey missile bodies
    'JetBand': (0xa8823a, 0.2, 0.6, None),       # yellow-brown warhead band
}

TAIL = (0, 0.5, -5.8)

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

    def cyl(self, a, b, r1, r2=None, segs=8, mat='JetHull', cap0=True, cap1=True, phase=0.0, matfn=None):
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

    def cable(self, a, b, sag, r, mat='JetDark', n=6, segs=5):
        a, b = Vector(a), Vector(b)
        pts = [a.lerp(b, t) - Vector((0, sag * 4 * t * (1 - t), 0)) for t in (i / n for i in range(n + 1))]
        return self.sweep(pts, r, mat, segs)


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
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_materials='EXPORT',
        export_normals=True,
        export_texcoords=False,
    )


# ================================================================================================= jet

def camo(x, z):
    """Sand blotch or hull at (x, z) on the top surfaces: a couple of crossing waves, cut at a level."""
    v = math.sin(1.1 * x + 0.6 * z + 0.4) + math.sin(-0.7 * x + 1.5 * z + 2.1) + 0.6 * math.sin(2.3 * x - 0.4 * z)
    return 'JetSand' if v > 0.55 else 'JetHull'


def ring_pts(z, hw, ht, hb, cy, segs=16, p=2.4):
    """Superellipse cross-section at z: half width hw, top/bottom heights ht/hb from centre cy. k=0 at +X, CCW
    (towards +Y first), so k in (0, segs/2) is the top half."""
    pts = []
    for k in range(segs):
        a = 2 * PI * k / segs
        c, s = math.cos(a), math.sin(a)
        x = hw * math.copysign(abs(c) ** (2 / p), c)
        y = (ht if s > 0 else hb) * math.copysign(abs(s) ** (2 / p), s)
        pts.append((x, cy + y, z))
    return pts


# fuselage: z, half width, top, bottom, centre y, material for the band behind this ring (None: hull/camo)
FUSE = [(-5.3, 0.2, 0.2, 0.2, 0.42, None), (-4.6, 0.28, 0.3, 0.32, 0.34, None), (-3.0, 0.4, 0.42, 0.46, 0.21, None),
        (-2.2, 0.45, 0.46, 0.52, 0.17, 'JetDark'), (-2.16, 0.45, 0.46, 0.52, 0.17, None),
        (-1.0, 0.54, 0.52, 0.6, 0.12, None), (1.2, 0.58, 0.56, 0.64, 0.1, None),
        (2.1, 0.58, 0.6, 0.64, 0.1, 'JetDark'), (2.14, 0.58, 0.6, 0.64, 0.1, None),
        (3.0, 0.58, 0.74, 0.63, 0.1, None), (3.8, 0.54, 0.8, 0.6, 0.1, None),
        (4.5, 0.46, 0.68, 0.5, 0.08, 'JetDark'), (4.54, 0.455, 0.67, 0.495, 0.08, None),
        (5.05, 0.34, 0.47, 0.34, 0.05, None), (5.4, 0.19, 0.22, 0.18, 0.03, None)]
SEGS = 16


def fuse_at(z):
    for a, b in zip(FUSE, FUSE[1:]):
        if a[0] <= z <= b[0]:
            t = (z - a[0]) / (b[0] - a[0])
            return [lerp(a[i], b[i], t) for i in range(1, 5)]
    return list(FUSE[-1][1:5])


def fuse_top(z):
    hw, ht, hb, cy = fuse_at(z)
    return cy + ht


def fuse_bot(z):
    hw, ht, hb, cy = fuse_at(z)
    return cy - hb


def surface(mb, sections, M, top_camo=True, flap_from=0.0, cap_tip=True, mirror=False):
    """A lifting surface along local +X (-X if mirror): sections (s, le_z, chord, thick, y). Airfoil ring of 10
    points; the trailing 22% of chord is the control surface (JetFlap) for s >= flap_from. Upper faces camo."""
    af = [(0, 0), (0.06, 0.55), (0.25, 1.0), (0.5, 0.85), (0.78, 0.4), (1.0, 0.0), (0.78, -0.12), (0.5, -0.3),
          (0.25, -0.42), (0.06, -0.35)]
    sx = -1 if mirror else 1
    rings = [[(sx * s, y + t * v, le - c * u) for u, v in af] for s, le, c, t, y in sections]
    mb.push(M)
    vr = [[mb.V(p) for p in r] for r in rings]
    faces = []
    n = len(af)
    for i in range(len(vr) - 1):
        s_mid = (sections[i][0] + sections[i + 1][0]) / 2
        for k in range(n):
            j = (k + 1) % n
            if k in (4, 5) and s_mid >= flap_from:
                m = 'JetFlap'
            elif k < 5 and top_camo:
                p = mb.stack[-1] @ Vector(rings[i][k])
                m = camo(p.x, p.z)
            else:
                m = 'JetHull'
            faces.append(mb.F([vr[i][k], vr[i][j], vr[i + 1][j], vr[i + 1][k]], m))
    if cap_tip:
        faces.append(mb.F(vr[-1], 'JetDark'))
    mb.fix(faces)
    mb.pop()
    return faces


def missile(mb, x, y, z0, z1, r=0.09):
    """A Hellfire-ish missile from z0 (tail) to z1 (nose) along +Z at (x, y)."""
    prof = [(0.0, z0 - 0.02), (r * 0.8, z0), (r, z0 + 0.06), (r, z1 - 0.42), (r, z1 - 0.28), (r * 0.96, z1 - 0.26),
            (r * 0.7, z1 - 0.1), (r * 0.25, z1), (0.0, z1 + 0.01)]
    mats = ['JetDark', 'JetMissile', 'JetMissile', 'JetBand', 'JetMissile', 'JetMissile', 'JetGlass', 'JetGlass']
    mb.lathe(prof, 8, 'JetMissile', M=T(x, y, 0), matfn=lambda k: mats[min(k, len(mats) - 1)], phase=PI / 8)
    for a in range(4):
        R = T(x, y, 0) @ Rz(PI / 4 + a * PI / 2)
        mb.box((0, r + 0.06, z0 + 0.16), (0.012, 0.13, 0.22), 'JetMissile', M=R, taper=(1, 0.5))
        mb.box((0, r + 0.03, z1 - 0.62), (0.01, 0.07, 0.1), 'JetMissile', M=R)


def build_body():
    mb = MB()
    # ---- fuselage, with dark panel-line bands
    rings = [ring_pts(z, hw, ht, hb, cy, SEGS) for z, hw, ht, hb, cy, _ in FUSE]
    vr = [[mb.V(p) for p in r] for r in rings]
    faces = []
    for i in range(len(vr) - 1):
        for k in range(SEGS):
            j = (k + 1) % SEGS
            p = rings[i][k]
            m = FUSE[i][5]
            if m is None:
                m = camo(p[0] * 3, p[2]) if 0 < k < SEGS // 2 else 'JetHull'
            faces.append(mb.F([vr[i][k], vr[i][j], vr[i + 1][j], vr[i + 1][k]], m))
    tip = mb.V((0, 0.03, 5.62))
    faces += [mb.F([vr[-1][k], vr[-1][(k + 1) % SEGS], tip], 'JetHull') for k in range(SEGS)]
    faces.append(mb.F(list(reversed(vr[0])), 'JetHull'))
    mb.fix(faces)
    # satcom radome over the nose top, a shade darker
    mb.sphere((0, 0.6, 3.6), 0.5, 'JetFlap', 10, 5, scale=(0.92, 0.66, 1.7))

    # ---- intake hump over the back into the nozzle: z, half width, half height, centre y
    hump = [(0.78, 0.25, 0.17, 0.68), (0.98, 0.33, 0.25, 0.68), (0.92, 0.36, 0.29, 0.68), (0.4, 0.4, 0.33, 0.67),
            (-0.8, 0.43, 0.37, 0.65), (-2.4, 0.42, 0.38, 0.6), (-3.8, 0.39, 0.37, 0.54), (-4.9, 0.37, 0.37, 0.5)]
    hr = [ring_pts(z, rx, ry, ry, cy, SEGS, 2.0) for z, rx, ry, cy in hump]

    def hump_mat(i, k):
        if i == 0:
            return 'JetDark'
        if i == 1:
            return 'JetSteel'
        p = hr[i][k]
        return camo(p[0] * 3, p[2]) if 0 < k < SEGS // 2 else 'JetHull'

    mb.loft(hr, 'JetHull', cap0=True, capmat='JetDark', matfn=hump_mat)
    # nozzle: outer shell, heat band, lip, dark inside, turbine cone
    noz = [(0.37, -4.9), (0.365, -5.2), (0.35, -5.45), (0.32, -5.78), (0.27, -5.8), (0.255, -5.55), (0.2, -5.4),
           (0.1, -5.36), (0.0, -5.5)]
    nm = ['JetSteel', 'JetBurnt', 'JetBurnt', 'JetSteel', 'JetDark', 'JetDark', 'JetDark', 'JetDark']
    mb.lathe(noz, SEGS, 'JetSteel', M=T(0, 0.5, 0), matfn=lambda k: nm[min(k, len(nm) - 1)])
    # dorsal blade antennas and a small satcom/GPS puck
    for z, h in ((-1.2, 0.32), (-2.9, 0.22)):
        y = 0.65 + 0.36
        mb.box((0, y + h / 2, z), (0.03, h, 0.3), 'JetDark', taper=(1, 0.45))
    mb.lathe([(0.12, 0), (0.1, 0.05), (0.0, 0.07)], 8, 'JetSteel', M=T(0, fuse_top(1.8) - 0.01, 1.8) @ Rx(-PI / 2))

    # ---- sensor ball under the chin
    zb = 3.95
    yb = fuse_bot(zb)
    mb.cyl((0, yb + 0.1, zb), (0, yb - 0.14, zb), 0.2, 0.17, 10, 'JetHull')
    mb.sphere((0, yb - 0.38, zb), 0.29, 'JetHull', 12, 7)
    d = Vector((0, -0.45, 1)).normalized()
    c = Vector((0, yb - 0.38, zb)) + d * 0.27
    mb.cyl(tuple(c - d * 0.02), tuple(c + d * 0.04), 0.17, 0.15, 10, 'JetDark')
    mb.disc(tuple(c + d * 0.045), d, 0.12, 10, 'JetGlass')
    d2 = Vector((0.45, -0.35, 1)).normalized()
    c2 = Vector((0, yb - 0.38, zb)) + d2 * 0.28
    mb.disc(tuple(c2), d2, 0.05, 6, 'JetGlass')

    # ---- belly: blade antennas, a whip, gear-door outlines; pitot probes either side of the nose
    for z, h in ((0.6, 0.28), (-2.6, 0.2)):
        mb.box((0, fuse_bot(z) - h / 2 + 0.02, z), (0.03, h, 0.26), 'JetDark', taper=(1, 1.6))
    mb.cyl((0.0, fuse_bot(-1.6) + 0.02, -1.6), (0.0, fuse_bot(-1.6) - 0.5, -1.75), 0.012, 0.008, 4, 'JetDark')
    for z0, z1 in ((2.6, 3.5), (-0.6, 0.4)):
        for s in (-1, 1):
            mb.box((s * 0.17, fuse_bot((z0 + z1) / 2) + 0.005, (z0 + z1) / 2), (0.025, 0.03, z1 - z0), 'JetDark')
        for z in (z0, z1):
            mb.box((0, fuse_bot(z) + 0.005, z), (0.36, 0.03, 0.025), 'JetDark')
    mb.cyl((0.3, 0.05, 4.7), (0.33, 0.06, 5.4), 0.018, 0.01, 4, 'JetSteel')

    # ---- wings: straight, long, a little dihedral; ailerons and flaps (the JetFlap strip)
    for mirror in (False, True):
        sg = -1 if mirror else 1
        secs = []
        for s in (0.3, 1.4, 2.8, 4.2, 5.6, 7.0, 8.2, 9.0):
            u = s / 9
            secs.append((s, 1.15 - 0.05 * s, lerp(1.55, 0.62, u), lerp(0.13, 0.06, u), 0.12 + 0.035 * s))
        surface(mb, secs, Matrix.Identity(4), mirror=mirror, flap_from=0.6)
        # pylons with a missile on each
        for s in (2.6, 4.3):
            y = 0.12 + 0.035 * s
            le = 1.15 - 0.05 * s
            x = sg * s
            mb.box((x, y - 0.17, le - 0.55), (0.07, 0.2, 0.8), 'JetHull', taper=(1, 1.25))
            mb.box((x, y - 0.29, le - 0.55), (0.05, 0.04, 0.9), 'JetSteel')
            missile(mb, x, y - 0.4, le - 1.45, le + 0.2)
    # ---- V tail (fins 43 degrees off vertical) and a small ventral fin
    for mirror in (False, True):
        sg = -1 if mirror else 1
        secs = [(0.0, -3.65, 1.35, 0.075, 0.0), (1.2, -3.95, 1.0, 0.06, 0.0), (2.35, -4.27, 0.58, 0.04, 0.0)]
        surface(mb, secs, T(sg * 0.18, 0.5, 0) @ Rz(sg * 0.75), mirror=mirror, flap_from=0.3)
    secs = [(0.0, -4.0, 1.0, 0.05, 0.0), (0.55, -4.25, 0.65, 0.035, 0.0)]
    surface(mb, secs, T(0, fuse_bot(-4.4) + 0.05, 0) @ Rz(-PI / 2), top_camo=False, flap_from=9)
    return finish(mb, 'Jet_Body')


def build_tail():
    e = bpy.data.objects.new('Tail', None)
    bpy.context.scene.collection.objects.link(e)
    e.location = C @ Vector(TAIL)
    e.empty_display_size = 0.3
    return e


def render_previews(objs, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    scene = bpy.context.scene
    for engine in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x, scene.render.resolution_y = 1400, 900
    scene.view_settings.view_transform = 'Standard'
    body = objs[0]
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
    sun.rotation_euler = (math.radians(90 - 35), 0, math.radians(-150))
    scene.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.clip_end = 5000

    def look(pos3, target3, lens, name):
        p = C @ Vector(pos3)
        t = C @ Vector(target3)
        cam.location = p
        cam.rotation_euler = (t - p).to_track_quat('-Z', 'Y').to_euler()
        cam.data.lens = lens
        scene.render.filepath = os.path.join(out_dir, name)
        bpy.ops.render.render(write_still=True)

    look((6, -40, 10), (0, 0, 0), 40, 'jet_below.png')
    look((0, -300, 60), (0, 0, 0), 200, 'jet_below_far.png')
    look((26, 1, 0), (0, 0.2, 0), 40, 'jet_side.png')
    look((14, 9, 16), (0, 0, 0), 35, 'jet_34.png')
    look((-12, 5, -14), (0, 0.3, 0), 35, 'jet_rear34.png')
    look((2.6, 0.2, 7.2), (0, -0.2, 3.6), 30, 'jet_nose.png')
    # crashed on the sand: belly down on a ground plane, a bit tilted
    bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, 0))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new('ground')
    gm.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (*lin(0xc46a24), 1)
    gm.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value = 1.0
    ground.data.materials.append(gm)
    body.location = (0, 0, 0.75)
    body.rotation_euler = (0.03, -0.08, 0.6)
    for o in objs[1:]:
        o.hide_render = True
    look((9, 4.5, 11), (0, 0.3, 0), 28, 'jet_crashed.png')
    look((2.2, 2.2, -9.5), (0, 0.6, -4), 30, 'jet_crashed_tail.png')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--preview', default=None)
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models'))
    args = ap.parse_args(argv)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in MATERIALS.items():
        make_material(name, *spec)
    body = build_body()
    tail = build_tail()
    os.makedirs(args.out, exist_ok=True)
    export_glb([body, tail], os.path.join(args.out, 'jet.glb'))
    print(f'{body.name}: tris={tri_count(body)}')
    if args.preview:
        render_previews([body, tail], os.path.abspath(args.preview))


main()
