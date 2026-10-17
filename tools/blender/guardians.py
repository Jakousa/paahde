"""Guardians (giant derelict walking war machines) and the night patrol drone, exported as glTF binaries.

    blender -b --python tools/blender/guardians.py                          # writes guardian.glb + drone.glb
    blender -b --python tools/blender/guardians.py -- --preview <dir>       # also renders PNG previews into <dir>

public/models/guardian.glb has one top-level node per part, no parenting, identity transforms; the game
assembles the legs with IK. All coordinates below are three.js (Y up, +Z forward); the script builds every
mesh in three.js coordinates and rotates it into Blender's Z-up frame (x, y, z) -> (x, -z, y) just before
export, so the glTF exporter's Y-up conversion gives back exactly these numbers.

  Guardian_Body4   chassis, 4 legs. Origin = body centre, forward +Z. Hip sockets at (+-2.3, 0, +-2.3).
  Guardian_Body3   chassis, 3 legs (tripod). Sockets at (+-2.6, 0, 1.5) and (0, 0, -3.0).
  Guardian_Hip     joint housing; origin = joint centre. Placed at a socket, yawed so local +Z points along
                   the leg; the femur pitches about local X through the origin.
  Guardian_Femur   origin = hip joint, runs along +Z to the knee at (0, 0, 12); +Y is the top side.
  Guardian_Tibia   origin = knee joint (pitch axis = local X), runs along +Z to the ankle at (0, 0, 16);
                   +Y is the back/outside face.
  Guardian_Foot    origin = ground contact centre, sole on y = 0, +Y up; ankle ball centred at (0, 1.2, 0).
  Guardian_Turret  laser turret (yaw part). Origin = mount point, placed at body-local (0, -2.4, 0.6) on both
                   bodies (a collar sits there) and rotated about Y. Hangs down; the gun's pitch axis is
                   local X through (0, -1.3, 0).
  Guardian_Gun     laser cannon (pitch part). Origin = pitch pivot, placed at turret (0, -1.3, 0) and rotated
                   about local X; barrel along +Z, muzzle at (0, 0, 5.0). Clears the yoke for pitch -80..+20
                   degrees. Coil rings + muzzle lip use GuardianGunGlow (intensity animated by the game).

public/models/drone.glb:

  Drone_Body       origin at its centre, forward +Z; four rotor ducts at (+-0.75, 0.1, +-0.75); searchlight
                   under the nose (lens material DroneLamp), nav lights DroneNavRed (+X, left) / DroneNavGreen.
  Drone_Rotor_0..3 blades only, origin at each hub, node translation = hub position: 0 (+X,+Z), 1 (-X,+Z),
                   2 (-X,-Z), 3 (+X,-Z). Spin about local Y.

Materials are flat Principled BSDF colours (no textures). GuardianEye is the emissive one (eyes, glowing slits).
Units are metres. Output is deterministic.
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
    'GuardianIron': (0x2c2622, 0.6, 0.6, None),      # dark weathered gunmetal frame
    'GuardianSteel': (0x5a524a, 0.7, 0.45, None),     # worn edges, axles, piston rods
    'GuardianRust': (0x6a2f17, 0.45, 0.75, None),     # deep rust: undersides, flanges, bands
    'GuardianCeramic': (0xc9b48f, 0.1, 0.7, None),    # pale sand-bleached armour plates
    'GuardianHazard': (0xc8641e, 0.3, 0.6, None),     # faded hazard orange
    'GuardianDark': (0x14100e, 0.2, 0.85, None),      # cables, hoses, recesses, eye sockets
    'GuardianEye': (0xff4a14, 0.0, 0.4, 8.0),         # sensor eyes + glowing slits
    'GuardianGunGlow': (0xff4a14, 0.0, 0.4, 4.0),     # laser coil rings / muzzle lip (game animates intensity)
    'DroneIron': (0x2c2622, 0.6, 0.55, None),
    'DroneSteel': (0x6a6158, 0.7, 0.4, None),
    'DroneCeramic': (0xc9b48f, 0.1, 0.65, None),
    'DroneRust': (0x6a2f17, 0.45, 0.7, None),
    'DroneHazard': (0xc8641e, 0.3, 0.6, None),
    'DroneDark': (0x14100e, 0.2, 0.85, None),
    'DroneLamp': (0xfff0d0, 0.0, 0.3, 12.0),          # searchlight lens, warm white
    'DroneNavRed': (0xff2010, 0.0, 0.4, 6.0),
    'DroneNavGreen': (0x20ff50, 0.0, 0.4, 6.0),
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

    def cyl(self, a, b, r1, r2=None, segs=8, mat='GuardianIron', cap0=True, cap1=True, phase=0.0, matfn=None):
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

    def cable(self, a, b, sag, r, mat='GuardianDark', n=6, segs=5):
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

    def rivet(self, p, n, size=0.09, mat='GuardianSteel'):
        p, n = Vector(p), Vector(n).normalized()
        return self.cyl(p - n * size * 0.3, p + n * size * 0.7, size, 0, segs=4, mat=mat, cap0=False)

    def glow_slit(self, c, size, M=None, rot=(0, 0, 0)):
        return self.box(c, size, 'GuardianEye', rot=rot, M=M)


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


# ================================================================================================ guardian

HULL_ROWS = [(-2.0, 0.36), (-1.45, 0.72), (-0.55, 0.96), (0.3, 1.0), (1.05, 0.86), (1.75, 0.58), (2.25, 0.26)]


def angdist(a, b):
    d = (a - b) % (2 * PI)
    return min(d, 2 * PI - d)


def build_body(name, sockets, base_fn, seed, rear_reactor):
    """Lobed carapace: big lobes between the hip sockets, deep notches where the hips sit."""
    rng = Rng(seed)
    mb = MB()
    socks = [(math.atan2(x, z), math.hypot(x, z)) for x, y, z in sockets]
    W = math.radians(34)

    def rad(th):
        r = base_fn(th)
        for sa, sd in socks:
            n = smooth(1 - angdist(th, sa) / W)
            r = lerp(r, sd - 0.8, n)
        return r

    def hull_p(th, v):
        i = min(int(v), len(HULL_ROWS) - 2)
        t = v - i
        y = lerp(HULL_ROWS[i][0], HULL_ROWS[i + 1][0], t)
        s = lerp(HULL_ROWS[i][1], HULL_ROWS[i + 1][1], t)
        r = rad(th) * s
        return Vector((math.sin(th) * r, y, math.cos(th) * r))

    def hull(th, v):
        return surf_normal(hull_p, th, v, Vector((0, 0.2, 0)))

    N = 32
    rings = [[tuple(hull_p(2 * PI * k / N, j)) for k in range(N)] for j in range(len(HULL_ROWS))]
    mb.loft(rings, 'GuardianIron', cap0=True, cap1=True, capmat='GuardianIron',
            matfn=lambda i, k: 'GuardianRust' if i == 0 else ('GuardianDark' if i == 1 else 'GuardianIron'))

    # lobes = midway between neighbouring sockets
    sa_sorted = sorted(s[0] % (2 * PI) for s in socks)
    lobes = []
    for i, a in enumerate(sa_sorted):
        b = sa_sorted[(i + 1) % len(sa_sorted)] + (2 * PI if i + 1 == len(sa_sorted) else 0)
        lobes.append(((a + b) / 2, (b - a) / 2))

    for li, (lc, half) in enumerate(lobes):
        hw = half - W * 0.62
        front = angdist(lc, 0) < 0.3
        # carapace: two ceramic plates over the top with a panel gap, slightly narrower upper one
        mb.shell(hull, lc - hw, lc + hw, 3.02, 4.35, 4, 2, 0.06, 0.22, 'GuardianCeramic', 'GuardianIron', inset=0.08)
        mb.shell(hull, lc - hw * 0.86, lc + hw * 0.86, 4.45, 5.75, 3, 1, 0.06, 0.22, 'GuardianCeramic',
                 'GuardianIron', inset=0.08)
        # skirt plate (rusted iron), ends a little short of the notch
        mb.shell(hull, lc - hw * 0.94, lc + hw * 0.94, 1.55, 2.92, 4, 1, 0.05, 0.2, 'GuardianIron',
                 'GuardianRust', inset=0.05)
        # hazard stripes on the skirt (side and rear lobes)
        if not front:
            for i in range(3):
                th = lc + lerp(-hw * 0.4, hw * 0.4, i / 2)
                p, n = hull(th, 2.1)
                mb.box((0, 0, 0), (0.28, 0.5, 0.06), 'GuardianHazard' if i % 2 == 0 else 'GuardianDark',
                       M=T(p + n * 0.27) @ Ry(th) @ Rz(0.5))
            # glowing vent slits
            for i in range(2):
                th = lc + lerp(-hw * 0.45, hw * 0.45, i)
                p, n = hull(th, 1.25)
                mb.glow_slit((0, 0, 0), (0.9, 0.09, 0.05), M=T(p + n * 0.02) @ Ry(th))

    # socket flanges (recess with a rust ring), hoses coming down to each socket
    for (sa, sd), (sx, sy, sz) in zip(socks, sockets):
        d = Vector((math.sin(sa), 0, math.cos(sa)))
        side = Vector((0, 1, 0)).cross(d)
        angles = [2 * PI * k / 8 + PI / 8 for k in range(8)]
        flange = ((d * (sd - 1.3), 1.25), (d * (sd - 0.95), 1.25), (d * (sd - 0.6), 1.0))
        mb.loft([[tuple(c + (side * math.cos(a) + Vector((0, 1, 0)) * math.sin(a)) * r) for a in angles]
                 for c, r in flange],
                'GuardianIron', cap1=True, matfn=lambda i, k: 'GuardianRust' if i == 0 else 'GuardianIron')
        side = Vector((0, 1, 0)).cross(d)
        for s in (-1, 1):
            p0, _ = hull(sa + s * 0.55, 3.6)
            mb.sweep([p0, p0 * 0.5 + (d * (sd - 0.7) + side * s * 0.8 + Vector((0, 0.9, 0))) * 0.5 +
                      Vector((0, -0.35, 0)), d * (sd - 0.7) + side * s * 0.85 + Vector((0, 0.7, 0))],
                     0.13, 'GuardianDark', 4)
        # piston struts bracing the socket from below
        for s in (-1, 1):
            p0, _ = hull(sa + s * 0.5, 1.2)
            mb.cyl(p0, d * (sd - 0.9) + side * s * 0.7 + Vector((0, -0.6, 0)), 0.16, None, 4, 'GuardianSteel',
                   cap0=False)

    # top turret ring, hatch, antenna mast
    top = HULL_ROWS[-1][0]
    mb.lathe([(1.15, top - 0.2), (1.25, top + 0.15), (1.05, top + 0.35), (0.6, top + 0.55), (0.0, top + 0.6)], 10,
             'GuardianIron', matfn=lambda k: 'GuardianRust' if k == 0 else 'GuardianIron', M=Rx(-PI / 2))
    mb.cyl((0.4, top + 0.3, -0.5), (0.55, top + 3.4, -1.1), 0.08, 0.03, 4, 'GuardianSteel', cap0=False, cap1=False)
    mb.cyl((-0.5, top + 0.3, -0.3), (-0.6, top + 2.0, -0.6), 0.06, 0.03, 4, 'GuardianSteel', cap0=False, cap1=False)
    mb.box((0.55, top + 2.6, -0.95), (0.5, 0.06, 0.06), 'GuardianSteel')
    mb.box((0.55, top + 3.45, -1.1), (0.16, 0.16, 0.16), 'GuardianEye', rot=(0.6, 0.6, 0))

    # ---------------------------------------------------------------- head + eye cluster (front, +Z)
    R0 = rad(0.0)
    hz = R0 - 1.3
    rings = [oct_ring(hz, 2.6, 2.0, 0.5, cy=-0.35), oct_ring(hz + 1.3, 2.4, 1.85, 0.5, cy=-0.45),
             oct_ring(hz + 2.25, 1.8, 1.35, 0.4, cy=-0.5), oct_ring(hz + 2.6, 1.3, 0.95, 0.3, cy=-0.55)]
    mb.loft(rings, 'GuardianIron', cap1=True, capmat='GuardianDark',
            matfn=lambda i, k: 'GuardianRust' if k in (1, 2, 3) else 'GuardianIron')
    ez = hz + 2.6
    # brow plate (ceramic visor overhanging the eyes)
    brow = [(-1.35, 0.55, hz + 0.6), (1.35, 0.55, hz + 0.6), (0.95, 0.25, ez + 0.35), (-0.95, 0.25, ez + 0.35)]
    mb.loft([[(x, y, z) for x, y, z in brow], [(x * 0.92, y + 0.25, z - 0.05) for x, y, z in brow]],
            'GuardianCeramic', cap0=True, cap1=True)
    # eyes: dark sockets with glowing domes
    eyes = [((0, -0.5, ez), 0.36), ((0.47, -0.3, ez - 0.12), 0.17), ((-0.47, -0.3, ez - 0.12), 0.17),
            ((0.32, -0.85, ez - 0.08), 0.12), ((-0.32, -0.85, ez - 0.08), 0.12)]
    for (x, y, z), r in eyes:
        dirn = Vector((x * 0.6, -0.15, 1)).normalized()
        M = aim(Vector((x, y, z)), dirn)
        segs = 8 if r > 0.3 else 6
        mb.lathe([(r * 1.5, -0.1), (r * 1.05, 0.09)], segs, 'GuardianDark', M=M)
        mb.cyl(M @ Vector((0, 0, -0.05)), M @ Vector((0, 0, r * 0.55)), r, 0, segs, 'GuardianEye', cap0=False)
    # mandibles / chelicerae: hooked prongs under the head, forward of the laser cannon's reach
    for s in (-1, 1):
        a = Vector((s * 0.65, -0.95, hz + 2.45))
        b = Vector((s * 0.55, -1.75, hz + 3.25))
        c = Vector((s * 0.25, -2.4, hz + 3.45))
        mb.sweep([a, b, c], 0.0, 'GuardianCeramic', 4, radii=[0.3, 0.2, 0.02])
        mb.cyl(a + Vector((0, 0.1, -0.4)), a + Vector((0, 0.05, 0.3)), 0.36, 0.3, 6, 'GuardianIron')

    # ---------------------------------------------------------------- rear
    if rear_reactor:
        Rb = rad(PI)
        for s in (-1, 1):
            a = Vector((s * 0.85, 1.0, -Rb * 0.55))
            b = a + Vector((s * 0.2, 1.3, -1.0))
            mb.cyl(a, b, 0.42, 0.36, 8, 'GuardianIron', cap0=False, cap1=False)
            mb.cyl(b, b + (b - a).normalized() * 0.25, 0.44, 0.44, 8, 'GuardianRust', cap1=False)
            mb.disc(b + (b - a).normalized() * 0.12, b - a, 0.3, 8, 'GuardianEye')
        # radiator fins across the rear lobe
        for i in range(4):
            z = -Rb * 0.42 - i * 0.48
            p, n = hull(PI, 3.2 + i * 0.25)
            mb.box((0, p.y + 0.35, z), (1.4 - i * 0.12, 0.6, 0.08), 'GuardianSteel')
    else:
        # tripod: exhaust stacks up top behind the turret
        for s in (-1, 1):
            a = Vector((s * 0.9, 1.6, -1.2))
            b = a + Vector((s * 0.25, 1.4, -0.7))
            mb.cyl(a, b, 0.36, 0.3, 8, 'GuardianIron', cap0=False, cap1=False)
            mb.cyl(b, b + (b - a).normalized() * 0.22, 0.38, 0.38, 8, 'GuardianRust', cap1=False)
            mb.disc(b + (b - a).normalized() * 0.12, b - a, 0.25, 8, 'GuardianEye')

    # ---------------------------------------------------------------- underside machinery
    yb = HULL_ROWS[0][0]
    # keel ribs under each lobe
    for lc, half in lobes:
        d = Vector((math.sin(lc), 0, math.cos(lc)))
        for s in (-0.28, 0.28):
            dd = Vector((math.sin(lc + s), 0, math.cos(lc + s)))
            mb.beam(dd * 0.9 + Vector((0, yb - 0.15, 0)), dd * (rad(lc + s) * 0.78) + Vector((0, -1.3, 0)), 0.3,
                    0.4, 'GuardianIron')
    # ventral pod ending in the laser turret's mount collar (Guardian_Turret hangs from TURRET_MOUNT)
    mx, my, mz = TURRET_MOUNT
    mb.push(T(0, yb + 0.05, mz) @ Rx(PI / 2))
    mb.loft([oct_ring(0.0, 2.8, 2.8, 0.8), oct_ring(0.3, 2.55, 2.55, 0.72)],
            'GuardianIron', cap1=True, capmat='GuardianRust',
            matfn=lambda i, k: 'GuardianHazard' if k % 4 == 0 else 'GuardianIron')
    mb.pop()
    mb.lathe([(0.9, 0.0), (1.3, 0.0), (1.38, 0.08), (1.24, 0.18), (1.18, 0.3)], 12, 'GuardianIron',
             M=T(mx, my, mz) @ Rx(-PI / 2), phase=PI / 12,
             matfn=lambda k: 'GuardianDark' if k == 0 else ('GuardianRust' if k == 1 else 'GuardianSteel'))
    mb.disc((mx, my + 0.02, mz), (0, -1, 0), 0.95, 12, 'GuardianDark')
    for i in range(8):
        a = 2 * PI * (i + 0.5) / 8
        mb.rivet((mx + 1.2 * math.sin(a), my + 0.12, mz + 1.2 * math.cos(a)),
                 (math.sin(a), -0.6, math.cos(a)), 0.08)
    # tanks and greebles (kept tight up under the hull, clear of the turret's sweep)
    for s in (-1, 1):
        mb.cyl((s * 1.7, yb + 0.15, -1.1), (s * 1.7, yb + 0.15, 0.9), 0.38, None, 6, 'GuardianHazard')
        mb.box((s * 0.9, yb + 0.25, -1.7), (0.7, 0.4, 0.9), 'GuardianIron')
        mb.box((s * 0.9, yb + 0.04, -1.7), (0.4, 0.04, 0.08), 'GuardianEye')
    # cable bundles slung under each lobe and a short loose hose (above the cannon's reach)
    for lc, half in lobes:
        d = Vector((math.sin(lc), 0, math.cos(lc)))
        side = Vector((0, 1, 0)).cross(d)
        for k, s in enumerate((-0.4, 0.4)):
            a = d * (rad(lc) * 0.62) + side * s + Vector((0, -1.45, 0))
            b = d * 1.6 + side * s * 1.5 + Vector((0, yb + 0.1, 0))
            mb.cable(a, b, 0.15 + 0.1 * k + rng(0, 0.08), 0.13, 'GuardianDark', 4, 3)
        a = d * (rad(lc) * 0.7) + side * 0.8 + Vector((0, -1.2, 0))
        mb.sweep([a, a + Vector((0, -0.3, 0)) - d * 0.2, a + Vector((0, -0.15, 0)) + d * 0.25 + side * 0.3],
                 0.1, 'GuardianDark', 3)
    return finish(mb, name)


# laser cannon: turret hangs from TURRET_MOUNT (body-local), gun pitches about turret-local GUN_PIVOT
TURRET_MOUNT = (0.0, -2.4, 0.6)
GUN_PIVOT = (0.0, -1.3, 0.0)
GUN_MUZZLE = 5.0


def build_turret():
    """Yaw part. Origin = mount point on the body's underside; hangs down; pitch axis = X through GUN_PIVOT."""
    mb = MB()
    py = GUN_PIVOT[1]
    # slewing ring (top sits against the body's collar)
    mb.lathe([(0.95, 0.0), (1.1, 0.05), (1.1, 0.18), (1.04, 0.22), (1.04, 0.3), (0.85, 0.42), (0.0, 0.42)], 12,
             'GuardianIron', M=Rx(PI / 2), phase=PI / 12,
             matfn=lambda k: ['GuardianSteel', 'GuardianRust', 'GuardianDark', 'GuardianIron', 'GuardianIron',
                              'GuardianDark'][k])
    # hazard ticks on the rust band so the yaw reads
    for i in range(4):
        a = 2 * PI * i / 4 + PI / 4
        mb.box((0, 0, 0), (0.3, 0.12, 0.05), 'GuardianHazard', M=T(1.11 * math.sin(a), -0.12, 1.11 * math.cos(a)) @
               Ry(a))
    # yoke cheeks, round about the pitch axis
    poly = [(-0.3, -0.75)] + [(py - 0.62 * math.sin(a), -0.62 * math.cos(a))
                              for a in (PI * i / 6 for i in range(7))] + [(-0.3, 0.75)]
    for s in (-1, 1):
        mb.prism_x(poly, s * 0.8, s * 1.02, 'GuardianIron')
        # ceramic cheek plate + hazard edge
        mb.box((s * 1.06, -0.78, -0.05), (0.06, 0.62, 1.15), 'GuardianCeramic')
        mb.box((s * 1.06, -0.78, 0.6), (0.07, 0.62, 0.12), 'GuardianHazard')
        # trunnion bearing caps
        mb.cyl((s * 1.02, py, 0), (s * 1.16, py, 0), 0.44, 0.4, 8, 'GuardianSteel', cap0=False, phase=PI / 8)
        mb.cyl((s * 1.16, py, 0), (s * 1.22, py, 0), 0.22, 0.18, 6, 'GuardianRust', cap0=False)
        # hoses from the ring down the back of each cheek into the bearing
        mb.sweep([(s * 0.9, -0.36, -0.75), (s * 1.12, -0.7, -0.85), (s * 1.17, py + 0.15, -0.42)], 0.08,
                 'GuardianDark', 4)
    # targeting eye on the +X cheek
    mb.box((1.13, -0.62, 0.5), (0.16, 0.26, 0.34), 'GuardianIron')
    mb.cyl((1.13, -0.62, 0.62), (1.13, -0.62, 0.74), 0.09, 0.07, 6, 'GuardianEye', cap0=False)
    return finish(mb, 'Guardian_Turret')


def build_gun():
    """Pitch part. Origin = pitch pivot, barrel along +Z, muzzle face at z = GUN_MUZZLE.
    Everything stays within |x| < 0.78 (between the yoke cheeks) and keeps under the slewing ring
    for pitch -80..+20 degrees."""
    mb = MB()
    G = 'GuardianGunGlow'
    # trunnion drum (the breech's heavy core), rust end bands, axle stubs into the bearings
    mb.cyl((-0.58, 0, 0), (0.58, 0, 0), 0.75, None, 10, 'GuardianIron', phase=PI / 10)
    for s in (-1, 1):
        mb.cyl((s * 0.58, 0, 0), (s * 0.76, 0, 0), 0.72, 0.66, 10, 'GuardianRust', cap0=False, phase=PI / 10)
        mb.cyl((s * 0.76, 0, 0), (s * 0.79, 0, 0), 0.3, None, 6, 'GuardianSteel', cap0=False)
    # capacitor housing, sloped down on top so it slips under the ring when the gun looks up
    rings = [oct_ring(0.3, 1.3, 1.2, 0.3, cy=-0.12), oct_ring(0.9, 1.36, 1.22, 0.32, cy=-0.15),
             oct_ring(1.9, 1.1, 0.98, 0.28, cy=-0.15), oct_ring(2.15, 0.78, 0.74, 0.2, cy=-0.05)]
    mb.loft(rings, 'GuardianIron', cap1=True, capmat='GuardianDark',
            matfn=lambda i, k: 'GuardianCeramic' if k in (5, 6, 7) and i < 2 else (
                'GuardianRust' if k in (1, 2, 3) else 'GuardianIron'))
    for s in (-1, 1):
        for y in (0.05, -0.25):
            mb.box((s * 0.66, y, 1.25), (0.04, 0.08, 0.75), G)
        # capacitor tanks slung under the housing
        mb.cyl((s * 0.34, -0.74, 0.35), (s * 0.34, -0.74, 1.75), 0.2, None, 6, 'GuardianHazard')
        mb.cyl((s * 0.34, -0.74, 1.75), (s * 0.34, -0.6, 2.4), 0.07, None, 4, 'GuardianDark', cap0=False)
    # barrel: steel core, coil pack (glowing rings between iron heat-sink discs), four long cooling fins
    mb.cyl((0, 0, 2.1), (0, 0, 4.35), 0.3, 0.27, 8, 'GuardianSteel', cap0=False, cap1=False, phase=PI / 8)
    for i in range(5):
        z = 2.35 + i * 0.36
        mb.cyl((0, 0, z), (0, 0, z + 0.12), 0.43, None, 8, G, phase=PI / 8)
        mb.cyl((0, 0, z + 0.18), (0, 0, z + 0.24), 0.52, None, 8, 'GuardianIron', phase=PI / 8)
    for k in range(4):
        mb.box((0.39, 0, 3.25), (0.24, 0.06, 2.2), 'GuardianIron' if k % 2 else 'GuardianRust',
               M=Rz(PI / 4 + k * PI / 2))
    # muzzle shroud: flared collar, hot inner lip, dark bore
    mb.lathe([(0.27, 4.2), (0.5, 4.32), (0.6, 4.78), (0.56, GUN_MUZZLE), (0.42, GUN_MUZZLE), (0.33, 4.86)], 10,
             'GuardianIron', phase=PI / 10,
             matfn=lambda k: ['GuardianRust', 'GuardianIron', 'GuardianSteel', G, G][k])
    mb.disc((0, 0, 4.86), (0, 0, 1), 0.33, 10, 'GuardianDark')
    for k in range(3):
        a = PI / 2 + k * 2 * PI / 3
        mb.box((0, 0, 0), (0.1, 0.1, 0.4), 'GuardianHazard',
               M=T(0.55 * math.cos(a), 0.55 * math.sin(a), 4.55) @ Rz(a))
    # counterweight slung low behind the breech (low enough to clear the ring at -80 degrees)
    mb.beam((0, -0.25, -0.3), (0, -1.15, -0.78), 1.1, 0.62, 'GuardianIron', up=(0, 0.47, -0.88))
    mb.beam((0, -1.1, -0.74), (0, -1.36, -0.88), 1.16, 0.7, 'GuardianRust', up=(0, 0.47, -0.88))
    for s in (-1, 1):
        mb.box((s * 0.3, -0.9, -0.9), (0.18, 0.4, 0.06), 'GuardianHazard', M=Matrix.Identity(4),
               rot=(-0.5, 0, 0))
        mb.sweep([(s * 0.45, -0.5, -0.45), (s * 0.55, -0.8, 0.0), (s * 0.5, -0.6, 0.45)], 0.07, 'GuardianDark', 4)
    return finish(mb, 'Guardian_Gun')


def build_hip():
    mb = MB()
    # back collar (goes into the body socket) with a rust flange
    mb.cyl((0, 0, -1.15), (0, 0, -0.4), 1.0, 0.95, 10, 'GuardianIron', cap0=False, cap1=False)
    mb.cyl((0, 0, -0.85), (0, 0, -0.7), 1.14, 1.14, 10, 'GuardianRust', cap0=False, cap1=False)
    # yoke block
    mb.loft([oct_ring(-0.5, 1.9, 1.5, 0.35), oct_ring(0.0, 1.9, 1.5, 0.35)], 'GuardianIron', True, True)
    # cheeks: rounded at the front around the pitch axis (so the femur reads at any pitch), square at the back
    poly = [(-0.75, -0.45)] + [(0.9 * math.sin(a), 0.9 * math.cos(a))
                               for a in (-PI / 2 + PI * i / 4 for i in range(5))] + [(0.75, -0.45)]
    for s in (-1, 1):
        mb.prism_x(poly, s * 0.6, s * 0.86, 'GuardianIron')
        mb.cyl((s * 0.86, 0, 0), (s * 1.02, 0, 0), 0.6, 0.55, 8, 'GuardianSteel', cap0=False)
        mb.cyl((s * 1.02, 0, 0), (s * 1.12, 0, 0), 0.3, 0.26, 6, 'GuardianRust', cap0=False)
    # ceramic cowl over the top + a hazard fin
    def cowl(u, v):
        p = Vector((u, 0.8 + 0.25 * math.cos(u * 1.2), v))
        return p, Vector((math.sin(u * 0.6), 1, 0)).normalized()
    mb.shell(cowl, -1.0, 1.0, -1.05, 0.3, 3, 1, 0.0, 0.16, 'GuardianCeramic', 'GuardianIron', inset=0.1)
    mb.box((0, 1.2, -0.6), (0.18, 0.32, 0.8), 'GuardianHazard', taper=(0.5, 0.6))
    # hoses from the collar into the cheeks
    for s in (-1, 1):
        mb.sweep([(s * 0.55, -0.6, -0.9), (s * 0.98, -0.98, -0.6), (s * 0.98, -0.7, -0.2)], 0.1, 'GuardianDark', 4)
    return finish(mb, 'Guardian_Hip')


L_FEMUR = 12.0
L_TIBIA = 16.0


def build_femur():
    mb = MB()
    L = L_FEMUR
    # root knuckle (pitch axis = X), sits between the hip's cheeks
    mb.cyl((-0.58, 0, 0), (0.58, 0, 0), 0.72, None, 8, 'GuardianIron', phase=PI / 8)
    # box girder, its underside tapered up near the knee so a folded tibia clears it
    rings = [oct_ring(0.3, 1.1, 1.3, 0.3), oct_ring(1.6, 1.35, 1.55, 0.35), oct_ring(6.0, 1.2, 1.45, 0.33),
             oct_ring(9.6, 1.0, 1.2, 0.3), oct_ring(10.9, 0.85, 0.85, 0.25, cy=0.22)]
    mb.loft(rings, 'GuardianIron', cap1=True, matfn=lambda i, k: 'GuardianRust' if k == 2 else 'GuardianIron')
    # knee fork cheeks, round about the knee axis
    poly = [(0.6, L - 1.9)] + [(0.74 * math.sin(a), L + 0.74 * math.cos(a))
                               for a in (PI / 2 - PI * i / 5 for i in range(6))] + [(-0.45, L - 1.0)]
    for s in (-1, 1):
        mb.prism_x(poly, s * 0.46, s * 0.74, 'GuardianIron')
        mb.cyl((s * 0.74, 0, L), (s * 0.92, 0, L), 0.52, 0.46, 8, 'GuardianSteel', cap0=False)
    # armour: ceramic plates on both upper shoulders, leaving a channel for the piston
    for s in (-1, 1):
        for z0, z1 in ((0.9, 4.4), (4.7, 7.9), (8.2, 10.3)):
            def surf(u, v, s=s):
                w = lerp(1.35, 1.0, v / 10.5)
                h = lerp(1.55, 1.2, v / 10.5)
                a = lerp(0.3, 1.4, u)  # from the top corner round onto the side
                p = Vector((s * (w * 0.32 + math.sin(a) * w * 0.32), h * 0.3 + math.cos(a) * h * 0.32, v))
                return p, Vector((s * math.sin(a), math.cos(a), 0))
            mb.shell(surf, 0, 1, z0, z1, 2, 1, 0.04, 0.17, 'GuardianCeramic', 'GuardianIron', inset=0.1)
    # knee spike: an armoured horn raking up and back over the knee (silhouette against the sky)
    mb.cyl((0, 0.55, L - 1.2), (0, 2.1, L - 1.9), 0.3, 0, 4, 'GuardianCeramic', phase=PI / 4, cap0=False)
    # hazard band near the hip
    mb.loft([oct_ring(0.95, 1.42, 1.62, 0.36), oct_ring(1.3, 1.42, 1.62, 0.36)], 'GuardianHazard',
            matfn=lambda i, k: 'GuardianHazard' if k % 2 == 0 else 'GuardianDark')
    # hydraulic piston along the top channel driving the knee
    y = 0.95
    mb.box((0, 0.75, 1.3), (0.45, 0.5, 0.5), 'GuardianIron')
    mb.cyl((0, y, 1.0), (0, y, 7.2), 0.3, None, 8, 'GuardianIron', cap0=False)
    mb.cyl((0, y, 6.9), (0, y, 7.4), 0.37, None, 8, 'GuardianRust', cap0=False, cap1=False)
    mb.cyl((0, y, 7.2), (0, y + 0.1, 11.0), 0.14, None, 6, 'GuardianSteel', cap0=False, cap1=False)
    mb.box((0, y - 0.05, 11.15), (0.35, 0.45, 0.4), 'GuardianIron')
    # cable bundle along the +X side, clamped
    clamps = [1.6, 5.2, 8.6]
    for zz in clamps:
        mb.box((0.68, -0.1, zz), (0.22, 0.6, 0.25), 'GuardianSteel')
    pts = [(0.8, -0.05, 1.6), (0.86, -0.4, 3.4), (0.8, -0.05, 5.2), (0.86, -0.45, 6.9), (0.8, -0.05, 8.6),
           (0.62, -0.2, 10.4), (0.55, 0.1, 11.2)]
    mb.sweep(pts, 0.11, 'GuardianDark', 4)
    # glowing slit on the -X side
    mb.glow_slit((-0.62, 0.05, 2.6), (0.04, 0.12, 1.1))
    return finish(mb, 'Guardian_Femur')


def build_tibia():
    mb = MB()
    L = L_TIBIA
    # knee knuckle (fits between the femur's fork cheeks)
    mb.cyl((-0.44, 0, 0), (0.44, 0, 0), 0.6, None, 8, 'GuardianIron', phase=PI / 8)
    # long tapering lance, hexagonal with a ridge on the back (+Y)
    rings = [hex_ring(0.25, 0.85, 1.0), hex_ring(1.6, 0.98, 1.4), hex_ring(4.5, 0.86, 1.25), hex_ring(9.0, 0.6, 0.85),
             hex_ring(13.0, 0.4, 0.55), hex_ring(15.25, 0.3, 0.4)]
    mb.loft(rings, 'GuardianIron', matfn=lambda i, k: 'GuardianRust' if k in (2, 3) else 'GuardianIron')
    # ceramic sheath plates on the back/outside (+Y)
    def surf(u, v):
        t = v / 9.0
        w = lerp(1.0, 0.62, t)
        h = lerp(1.4, 0.86, t)
        a = lerp(-1.25, 1.25, u)
        p = Vector((math.sin(a) * w * 0.52, math.cos(a) * h * 0.52 - 0.1, v))
        return p, Vector((math.sin(a), math.cos(a), 0)).normalized()
    for z0, z1 in ((0.8, 3.6), (3.9, 6.6), (6.9, 8.8)):
        mb.shell(surf, 0, 1, z0, z1, 2, 1, 0.03, 0.15, 'GuardianCeramic', 'GuardianIron', inset=0.1)
    # serrated spines raking back along the ridge
    for i, z in enumerate((3.75, 6.75, 9.6, 11.9)):
        sc = lerp(1.0, 0.55, i / 3)
        h = lerp(0.9, 0.45, i / 3)
        by = lerp(0.62, 0.3, z / 13)
        mb.loft([[(0.08 * sc, by, z - 0.45 * sc), (0.08 * sc, by, z + 0.45 * sc),
                  (-0.08 * sc, by, z + 0.45 * sc), (-0.08 * sc, by, z - 0.45 * sc)],
                 [(0.02, by + h, z - 0.75 * sc), (0.02, by + h * 0.75, z - 0.6 * sc),
                  (-0.02, by + h * 0.75, z - 0.6 * sc), (-0.02, by + h, z - 0.75 * sc)]],
                'GuardianCeramic' if i < 2 else 'GuardianIron', cap1=True)
    # rust collars and a hazard band near the tip
    for z, w, h in ((1.3, 1.08, 1.5), (9.3, 0.7, 0.95)):
        mb.loft([hex_ring(z - 0.2, w, h), hex_ring(z + 0.2, w, h)], 'GuardianRust')
    mb.loft([hex_ring(12.6, 0.5, 0.66), hex_ring(13.4, 0.46, 0.62)], 'GuardianHazard',
            matfn=lambda i, k: 'GuardianHazard' if k % 2 == 0 else 'GuardianDark')
    # ankle cup around the foot's ball (ball centre at z = L)
    mb.lathe([(0.3, L - 0.9), (0.5, L - 0.55), (0.42, L - 0.22)], 8, 'GuardianIron',
             matfn=lambda k: 'GuardianSteel' if k == 1 else 'GuardianIron')
    # actuator rod + cable on the front/inside (-Y)
    mb.box((0, -0.62, 1.2), (0.3, 0.3, 0.5), 'GuardianIron')
    mb.cyl((0, -0.62, 1.4), (0, -0.55, 5.5), 0.17, None, 6, 'GuardianIron', cap0=False)
    mb.cyl((0, -0.55, 5.3), (0, -0.36, 10.0), 0.08, None, 5, 'GuardianSteel', cap0=False, cap1=False)
    mb.box((0, -0.36, 10.1), (0.18, 0.2, 0.3), 'GuardianIron')
    mb.sweep([(0.42, -0.2, 1.0), (0.48, -0.5, 3.6), (0.38, -0.25, 6.0), (0.28, -0.2, 9.0)], 0.07, 'GuardianDark', 4)
    for s in (-1, 1):
        mb.glow_slit((s * 0.49, 0.1, 2.3), (0.04, 0.1, 0.9))
    return finish(mb, 'Guardian_Tibia')


def build_foot():
    mb = MB()
    # ankle ball (the tibia tip's cup closes over its top) + the foot's socket cup
    mb.sphere((0, 1.2, 0), 0.47, 'GuardianSteel', 8, 5)
    mb.lathe([(0.62, 0.42), (0.6, 0.8), (0.44, 0.95)], 8, 'GuardianIron', M=Rx(-PI / 2), phase=PI / 8,
             matfn=lambda k: 'GuardianRust' if k == 0 else 'GuardianIron')
    # heavy hub pad, sole slightly sunk into the sand
    mb.lathe([(0.0, -0.12), (1.0, -0.12), (1.08, 0.14), (0.86, 0.4), (0.55, 0.5), (0.0, 0.5)], 8, 'GuardianIron',
             M=Rx(-PI / 2), phase=PI / 8,
             matfn=lambda k: 'GuardianDark' if k == 0 else ('GuardianRust' if k == 1 else 'GuardianIron'))
    # three chunky hooked claws digging in
    for c in range(3):
        az = 2 * PI * c / 3
        d = Vector((math.sin(az), 0, math.cos(az)))
        side = Vector((0, 1, 0)).cross(d)
        path = [(0.45, 0.3), (0.95, 0.62), (1.32, 0.48), (1.5, 0.08), (1.52, -0.3)]
        widths = [0.62, 0.52, 0.42, 0.26]
        heights = [0.6, 0.52, 0.42, 0.28]
        rings = []
        for (r, y), w, h in zip(path, widths, heights):
            ctr = d * r + Vector((0, y, 0))
            rings.append([tuple(ctr + Vector((0, h * 0.6, 0))), tuple(ctr + side * w * 0.5),
                          tuple(ctr - Vector((0, h * 0.4, 0))), tuple(ctr - side * w * 0.5)])
        mb.loft(rings, 'GuardianIron', cap0=True,
                matfn=lambda i, k: 'GuardianCeramic' if k in (0, 3) and i < 2 else 'GuardianIron')
        tip = d * path[-1][0] + Vector((0, path[-1][1], 0))
        mb.fan(rings[-1], tuple(tip), 'GuardianSteel')
        # short rusty spur between claws
        d2 = Vector((math.sin(az + PI / 3), 0, math.cos(az + PI / 3)))
        mb.cyl(d2 * 0.85 + Vector((0, 0.2, 0)), d2 * 1.3 + Vector((0, -0.1, 0)), 0.18, 0, 4, 'GuardianRust',
               cap0=False)
    return finish(mb, 'Guardian_Foot')


# =================================================================================================== drone

ROTORS = [(0.75, 0.1, 0.75), (-0.75, 0.1, 0.75), (-0.75, 0.1, -0.75), (0.75, 0.1, -0.75)]


def build_drone():
    mb = MB()
    # fuselage: chamfered lozenge along Z
    rings = [oct_ring(-0.6, 0.3, 0.18, 0.06), oct_ring(-0.4, 0.62, 0.36, 0.12), oct_ring(0.15, 0.66, 0.4, 0.13),
             oct_ring(0.5, 0.5, 0.32, 0.11), oct_ring(0.66, 0.26, 0.18, 0.06)]
    mb.loft(rings, 'DroneIron', cap0=True, cap1=True, capmat='DroneDark',
            matfn=lambda i, k: 'DroneCeramic' if k in (5, 6, 7) else ('DroneRust' if k == 2 else 'DroneIron'))
    # dorsal spine + antenna
    mb.box((0, 0.23, -0.05), (0.14, 0.08, 0.7), 'DroneHazard', taper=(0.6, 0.9))
    mb.cyl((0.08, 0.2, -0.4), (0.12, 0.65, -0.62), 0.012, 0.006, 4, 'DroneSteel')
    # arms + ducts
    for x, y, z in ROTORS:
        c = Vector((x, y, z))
        d = Vector((x, 0, z)).normalized()
        mb.beam(d * 0.22 + Vector((0, 0.02, 0)), c - d * 0.28 + Vector((0, -0.02, 0)), 0.12, 0.09, 'DroneIron')
        M = T(c) @ Rx(-PI / 2)
        mb.lathe([(0.27, -0.06), (0.32, -0.06), (0.32, 0.05), (0.27, 0.07), (0.27, -0.06)], 12,
                 'DroneCeramic', M=M,
                 matfn=lambda k: ('DroneRust' if k == 0 else 'DroneCeramic' if k == 1 else
                                  'DroneHazard' if k == 2 else 'DroneDark'))
        # motor + cross strut under the rotor
        mb.cyl(c + Vector((0, -0.09, 0)), c + Vector((0, -0.02, 0)), 0.06, 0.055, 6, 'DroneSteel')
        mb.beam(c - d * 0.28 + Vector((0, -0.05, 0)), c + d * 0.28 + Vector((0, -0.05, 0)), 0.04, 0.03, 'DroneIron')
    # nav lights on the outer front of the front ducts: red on +X (left), green on -X
    mb.sphere((0.75 + 0.32, 0.1, 0.75 + 0.05), 0.035, 'DroneNavRed', 6, 3)
    mb.sphere((-0.75 - 0.32, 0.1, 0.75 + 0.05), 0.035, 'DroneNavGreen', 6, 3)
    mb.sphere((0, 0.08, -0.62), 0.03, 'DroneNavRed', 6, 3)
    # belly: battery box + skids
    mb.box((0, -0.25, -0.1), (0.36, 0.14, 0.5), 'DroneRust')
    for s in (-1, 1):
        mb.cyl((s * 0.2, -0.18, -0.15), (s * 0.28, -0.4, -0.15), 0.018, None, 4, 'DroneSteel')
        mb.cyl((s * 0.2, -0.18, 0.25), (s * 0.28, -0.4, 0.25), 0.018, None, 4, 'DroneSteel')
        mb.cyl((s * 0.28, -0.4, -0.4), (s * 0.28, -0.4, 0.45), 0.022, None, 4, 'DroneIron')
    # searchlight: yoke under the nose, housing aimed forward-down
    mb.box((0, -0.2, 0.42), (0.26, 0.08, 0.14), 'DroneIron')
    for s in (-1, 1):
        mb.box((s * 0.15, -0.28, 0.45), (0.03, 0.18, 0.08), 'DroneIron')
    lc = Vector((0, -0.33, 0.47))
    dirn = Vector((0, -math.sin(math.radians(35)), math.cos(math.radians(35))))
    M = aim(lc - dirn * 0.16, dirn)
    mb.lathe([(0.08, 0.0), (0.12, 0.05), (0.14, 0.24), (0.15, 0.3), (0.115, 0.3)], 10, 'DroneSteel', M=M,
             matfn=lambda k: 'DroneDark' if k == 0 else 'DroneIron' if k == 1 else 'DroneSteel')
    mb.cyl(M @ Vector((0, 0, 0.27)), M @ Vector((0, 0, 0.305)), 0.118, 0.105, 10, 'DroneLamp')
    mb.cyl(lc - Vector((0.16, 0, 0)), lc + Vector((0.16, 0, 0)), 0.03, None, 5, 'DroneSteel')
    # camera eye on the nose
    mb.sphere((0, -0.02, 0.66), 0.06, 'DroneDark', 6, 4)
    mb.sphere((0, -0.02, 0.715), 0.025, 'DroneNavRed', 5, 3)
    body = finish(mb, 'Drone_Body')
    rotors = []
    for i, c in enumerate(ROTORS):
        rm = MB()
        rm.cyl((0, -0.03, 0), (0, 0.03, 0), 0.05, 0.04, 6, 'DroneSteel')
        for b in range(3):
            a = 2 * PI * b / 3 + i * 0.4
            rm.box((0, 0, 0.15), (0.07, 0.012, 0.25), 'DroneIron' if b else 'DroneHazard',
                   M=Ry(a) @ Rz(math.radians(14)))
        rotors.append(finish(rm, f'Drone_Rotor_{i}', loc=c))
    return body, rotors


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
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_materials='EXPORT',
        export_normals=True,
        export_texcoords=False,
    )


def cannon_pose(body_M, yaw, pitch):
    """three.js matrices for turret and gun; pitch in radians, negative = muzzle down."""
    Mt = body_M @ T(TURRET_MOUNT) @ Ry(yaw)
    return Mt, Mt @ T(GUN_PIVOT) @ Rx(-pitch)


def cannon_aim(body_M, target):
    """yaw, pitch that put the barrel axis through target (three.js world point)."""
    p = body_M @ T(TURRET_MOUNT) @ Vector(GUN_PIVOT)
    d = Vector(target) - p
    return math.atan2(d.x, d.z), math.atan2(d.y, math.hypot(d.x, d.z))


def bvh(obj, M):
    from mathutils.bvhtree import BVHTree
    Ci = C.inverted()
    verts = [M @ (Ci @ v.co) for v in obj.data.vertices]
    return BVHTree.FromPolygons(verts, [list(p.vertices) for p in obj.data.polygons])


def check_cannon(parts):
    """Print any mesh overlaps of the gun against the turret over its pitch range, and of turret/gun against
    each body over a yaw sweep (pitch -80..+20)."""
    I = Matrix.Identity(4)
    tur, gun = parts['Guardian_Turret'], parts['Guardian_Gun']
    bad = []
    for pd in range(-80, 21, 5):
        Mt, Mg = cannon_pose(I, 0, math.radians(pd))
        if bvh(gun, Mg).overlap(bvh(tur, Mt)):
            bad.append(f'gun/turret @ pitch {pd}')
    for bn in ('Guardian_Body4', 'Guardian_Body3'):
        tb = bvh(parts[bn], I)
        for yd in range(0, 360, 5):
            Mt, _ = cannon_pose(T(0, -0.02, 0), math.radians(yd), 0)  # (its top face sits on the collar)
            if tb.overlap(bvh(tur, Mt)):
                bad.append(f'{bn}/turret @ yaw {yd}')
            for pd in range(-80, 21, 10):
                _, Mg = cannon_pose(I, math.radians(yd), math.radians(pd))
                ov = tb.overlap(bvh(gun, Mg))
                if ov:
                    bp = parts[bn].data.polygons[ov[0][0]].center
                    gp = gun.data.polygons[ov[0][1]].center
                    bad.append(f'{bn}/gun @ yaw {yd} pitch {pd} [{tuple(round(c, 2) for c in C.inverted() @ bp)} '
                               f'{tuple(round(c, 2) for c in C.inverted() @ gp)}]')
    print('cannon clearance: ' + ('OK' if not bad else f'{len(bad)} clashes: ' + ', '.join(bad)))


# ================================================================================================= preview

def leg_pose(sock, body_y, foot_dist):
    """Simple 2-bone IK in three.js coords. Returns three.js matrices for hip, femur, tibia, foot."""
    sx, sy, sz = sock
    psi = math.atan2(sx, sz)
    d = Vector((math.sin(psi), 0, math.cos(psi)))
    H = Vector((sx, body_y + sy, sz))
    F = d * foot_dist
    A = F + Vector((0, 1.2, 0))
    h = (A - H)
    hh = Vector((h.x, 0, h.z)).length
    dv = h.y
    D = math.hypot(hh, dv)
    alpha = math.acos(max(-1, min(1, (L_FEMUR ** 2 + D ** 2 - L_TIBIA ** 2) / (2 * L_FEMUR * D))))
    th1 = math.atan2(dv, hh) + alpha
    K = H + d * L_FEMUR * math.cos(th1) + Vector((0, L_FEMUR * math.sin(th1), 0))
    kh = Vector((A.x - K.x, 0, A.z - K.z)).length
    th2 = math.atan2(A.y - K.y, kh)
    knee = math.degrees(math.acos((H - K).normalized().dot((A - K).normalized())))
    return (T(H) @ Ry(psi), T(H) @ Ry(psi) @ Rx(-th1), T(K) @ Ry(psi) @ Rx(-th2), T(F) @ Ry(psi)), knee


def place(src, M3, coll):
    o = src.copy()
    o.hide_render = False
    coll.objects.link(o)
    o.matrix_world = C @ M3 @ C.inverted()
    return o


def render_previews(parts, drone, rotors, out_dir):
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
    for o in list(parts.values()) + [drone] + rotors:
        o.hide_render = True
    bpy.ops.mesh.primitive_plane_add(size=800, location=(0, 0, 0))
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
    sun.rotation_euler = (math.radians(90 - 14), 0, math.radians(-150))
    scene.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.clip_end = 2000

    def look(pos3, target3, lens):
        p = C @ Vector(pos3)
        t = C @ Vector(target3)
        cam.location = p
        cam.rotation_euler = (t - p).to_track_quat('-Z', 'Y').to_euler()
        cam.data.lens = lens

    def shoot(name):
        scene.render.filepath = os.path.join(out_dir, name)
        bpy.ops.render.render(write_still=True)

    hm = bpy.data.materials.new('human')
    hm.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (0.05, 0.15, 0.6, 1)

    def assemble(body, sockets, body_y, foot_dist, yaw=0.0, pitch=0.0):
        coll = bpy.data.collections.new(body.name + '_rig')
        scene.collection.children.link(coll)
        place(body, T(0, body_y, 0), coll)
        Mt, Mg = cannon_pose(T(0, body_y, 0), yaw, pitch)
        place(parts['Guardian_Turret'], Mt, coll)
        place(parts['Guardian_Gun'], Mg, coll)
        knees = []
        for s in sockets:
            Ms, knee = leg_pose(s, body_y, foot_dist)
            knees.append(knee)
            for part, M in zip(('Guardian_Hip', 'Guardian_Femur', 'Guardian_Tibia', 'Guardian_Foot'), Ms):
                place(parts[part], M, coll)
        print(f'{body.name} preview knee angles: {[round(k) for k in knees]}')
        return coll

    S4 = [(2.3, 0, 2.3), (-2.3, 0, 2.3), (2.3, 0, -2.3), (-2.3, 0, -2.3)]
    S3 = [(2.6, 0, 1.5), (-2.6, 0, 1.5), (0, 0, -3.0)]
    # human-sized box next to the front-left foot; the laser cannon aims at it
    fd = Vector((1, 0, 1)).normalized() * 15.0
    hp = Vector((fd.x - 2.6, 0.9, fd.z + 0.6))
    yaw, pitch = cannon_aim(T(0, 13.0, 0), hp)
    print(f'preview cannon aim: yaw {math.degrees(yaw):.1f} pitch {math.degrees(pitch):.1f}')
    rig4 = assemble(parts['Guardian_Body4'], S4, 13.0, 15.0, yaw, pitch)
    bpy.ops.mesh.primitive_cube_add(size=1)
    human = bpy.context.active_object
    human.scale = (0.5, 0.35, 1.8)
    human.location = C @ hp
    human.data.materials.append(hm)

    look((fd.x - 6, 1.6, fd.z + 14), (0, 11, 0), 20)
    shoot('guardian_low.png')
    look((44, 12, 16), (0, 9, 0), 30)
    shoot('guardian_34.png')
    look((0, 6, 42), (0, 9, 0), 28)
    shoot('guardian_front.png')
    look((0, 1.0, 0.1), (0.5, 13, 3), 18)
    shoot('guardian_under.png')
    look((4.5, 19, 9), (0, 13.5, 0), 30)
    shoot('guardian_body_close.png')
    look((fd.x + 5, 2.2, fd.z - 3), (fd.x, 1.6, fd.z), 30)
    shoot('guardian_foot_close.png')
    look((24, 2.0, -6), (4, 6, 6), 24)
    shoot('cannon_aim.png')
    pv = T(0, 13.0, 0) @ T(TURRET_MOUNT) @ Vector(GUN_PIVOT)
    look(pv + Vector((-6, -1.5, 7)), pv + Vector((0.8, -0.6, 1.4)), 30)
    shoot('cannon_close.png')
    # dusk silhouette
    bg.inputs['Color'].default_value = (*lin(0xf7a440), 1)
    bg.inputs['Strength'].default_value = 1.3
    sd.energy = 0.6
    look((-40, 2, 30), (0, 12, 0), 26)
    shoot('guardian_dusk.png')
    bg.inputs['Color'].default_value = (*lin(0xe07b28), 1)
    bg.inputs['Strength'].default_value = 0.7
    sd.energy = 4.0
    rig4.hide_render = True
    human.hide_render = True

    # cannon pitch limits: body + turret + gun at -80 and +20 degrees, seen from the side
    for pd in (-80, 20):
        coll = bpy.data.collections.new(f'cannon_{pd}')
        scene.collection.children.link(coll)
        place(parts['Guardian_Body4'], T(0, 13.0, 0), coll)
        Mt, Mg = cannon_pose(T(0, 13.0, 0), 0, math.radians(pd))
        place(parts['Guardian_Turret'], Mt, coll)
        place(parts['Guardian_Gun'], Mg, coll)
        look(pv + Vector((16, -1.0, 1.5)), pv + Vector((0, 0.3, 1.5)), 30)
        shoot(f'cannon_pitch{pd:+d}.png')
        coll.hide_render = True

    rig3 = assemble(parts['Guardian_Body3'], S3, 13.0, 15.0, math.radians(-30), math.radians(-10))
    look((26, 16, 30), (0, 8, 0), 30)
    shoot('guardian3_34.png')
    look((5, 20, 9), (0, 13.5, 0), 30)
    shoot('guardian3_body.png')
    rig3.hide_render = True

    # knee range check: femur-tibia angle 40 and 140 degrees, side by side (hip + femur level, at 20 m up)
    coll = bpy.data.collections.new('knee_test')
    scene.collection.children.link(coll)
    for x, knee in ((-6, 40), (6, 140)):
        base = T(x, 20, -10)
        place(parts['Guardian_Hip'], base, coll)
        place(parts['Guardian_Femur'], base, coll)
        place(parts['Guardian_Tibia'], base @ T(0, 0, L_FEMUR) @ Rx(math.radians(180 - knee)), coll)
    look((40, 22, 2), (0, 18, 0), 32)
    shoot('knee_range.png')
    coll.hide_render = True

    # drone close up, hovering
    coll = bpy.data.collections.new('drone_rig')
    scene.collection.children.link(coll)
    place(drone, T(0, 3, 0), coll)
    for r, c in zip(rotors, ROTORS):
        place(r, T(0, 3, 0) @ T(*c), coll)
    look((2.4, 3.9, 3.0), (0, 2.95, 0), 40)
    shoot('drone_34.png')
    look((1.2, 1.2, 3.4), (0, 3.0, 0), 40)
    shoot('drone_low.png')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models'))
    ap.add_argument('--preview', default=None, help='directory for PNG previews')
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in MATERIALS.items():
        make_material(name, *spec)

    S4 = [(2.3, 0, 2.3), (-2.3, 0, 2.3), (2.3, 0, -2.3), (-2.3, 0, -2.3)]
    S3 = [(2.6, 0, 1.5), (-2.6, 0, 1.5), (0, 0, -3.0)]
    parts = {}
    parts['Guardian_Body4'] = build_body(
        'Guardian_Body4', S4, lambda th: 3.75 + 0.55 * max(0, math.cos(th)) ** 4 + 0.25 * max(0, -math.cos(th)) ** 4,
        11, True)
    parts['Guardian_Body3'] = build_body(
        'Guardian_Body3', S3, lambda th: 3.7 + 0.6 * max(0, math.cos(th)) ** 4, 13, False)
    parts['Guardian_Hip'] = build_hip()
    parts['Guardian_Femur'] = build_femur()
    parts['Guardian_Tibia'] = build_tibia()
    parts['Guardian_Foot'] = build_foot()
    parts['Guardian_Turret'] = build_turret()
    parts['Guardian_Gun'] = build_gun()
    drone, rotors = build_drone()

    os.makedirs(args.out, exist_ok=True)
    export_glb(list(parts.values()), os.path.join(args.out, 'guardian.glb'))
    export_glb([drone] + rotors, os.path.join(args.out, 'drone.glb'))

    for o in list(parts.values()) + [drone] + rotors:
        bb = [C.inverted() @ Vector(c) for c in o.bound_box]
        lo = [min(v[i] for v in bb) for i in range(3)]
        hi = [max(v[i] for v in bb) for i in range(3)]
        print(f'{o.name}: tris={tri_count(o)} three.js bbox x {lo[0]:.2f}..{hi[0]:.2f} '
              f'y {lo[1]:.2f}..{hi[1]:.2f} z {lo[2]:.2f}..{hi[2]:.2f} mats={[m.name for m in o.data.materials]}')
    leg = sum(tri_count(parts[p]) for p in ('Guardian_Hip', 'Guardian_Femur', 'Guardian_Tibia', 'Guardian_Foot'))
    print(f'assembled 4-leg guardian tris: {tri_count(parts["Guardian_Body4"]) + 4 * leg}')
    print(f'assembled 3-leg guardian tris: {tri_count(parts["Guardian_Body3"]) + 3 * leg}')
    print(f'drone tris: {tri_count(drone) + sum(tri_count(r) for r in rotors)}')
    print(f'laser turret + gun tris: {tri_count(parts["Guardian_Turret"]) + tri_count(parts["Guardian_Gun"])}')
    check_cannon(parts)

    if args.preview:
        render_previews(parts, drone, rotors, os.path.abspath(args.preview))


main()
