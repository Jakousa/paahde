"""The colossus boss (shared/colossus.ts): a 67 m bipedal war machine, exported as a glTF binary.

    tools/blender/run.sh -b --python tools/blender/colossus.py                    # writes public/models/colossus.glb
    tools/blender/run.sh -b --python tools/blender/colossus.py -- --preview <dir> # also renders PNG previews

One top-level node per moving part, no parenting, identity transforms; the game (src/world/colossus.ts) assembles
them: the legs with two-bone IK, the arms swinging. Coordinates below are three.js (Y up, +Z forward), built in
three.js coordinates and turned into Blender's Z-up frame just before export (as tools/blender/guardians.py does).
The measurements are shared/colossus.ts's.

  Colossus_Pelvis    origin = between the hip joints; sockets at (+-6.5, 0, 0); the waist at (0, 3.2, 0).
  Colossus_Torso     origin = waist. Shoulders at (+-13.5, 15.5, 0), neck at (0, 20, 0.5). The chest core (weak point)
                     at (0, 9.5, 7.7) facing +Z; the exhaust stacks open at (+-6.5, 21.6, -8.6) facing up and back.
  Colossus_Head      origin = neck; eye slit forward (+Z).
  Colossus_UpperArm  origin = shoulder joint; hangs along -Y to the elbow at (0, -14, 0). Built for the +X arm
                     (mirrored in the game with a negative X scale for the other).
  Colossus_Forearm   origin = elbow; along -Y, the wrist at (0, -13, 0) and the fist under it.
  Colossus_Thigh     origin = hip joint; along +Z to the knee at (0, 0, 19); +Y is its front.
  Colossus_Shin      origin = knee joint; along +Z to the ankle at (0, 0, 20); +Y is its front. The knee's weak point
                     sits under the kneecap at (0, 3.1, 3.8) facing +Y.
  Colossus_Foot      origin = ankle; sole on y = -3; heel at z = -3.5, toes to z = +7.5.

Materials: flat Principled BSDF colours; ColossusGlow is the emissive one (the eye, the furnace grille, the stacks'
throats). Metres. Deterministic.
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
    'ColossusIron': (0x2e2723, 0.6, 0.6, None),     # dark weathered iron, the bulk
    'ColossusRust': (0x6e3218, 0.45, 0.75, None),   # deep rust plates
    'ColossusSoot': (0x161210, 0.2, 0.85, None),    # soot-black recesses, joints' shadows, cables
    'ColossusSteel': (0x5c544b, 0.75, 0.42, None),  # worn steel: joints, piston rods
    'ColossusBronze': (0x6f5532, 0.7, 0.5, None),   # dull bronze trim
    'ColossusGlow': (0xff4a14, 0.0, 0.4, 8.0),      # furnace, eye, stacks
    'PreviewLens': (0xff0800, 0.0, 0.2, 6.0),       # previews only: where the game puts the weak points
}
CORE, CORE_R = (0, 9.5, 9.2), 3.0
KNEE, KNEE_R = (0, 3.1, 3.8), 1.8
VENT, VENT_R = (6.95, 21.3, -12.95), 2.1

C = Matrix.Rotation(PI / 2, 4, 'X')  # three.js (Y up) -> Blender (Z up)


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
    mat.use_backface_culling = False
    return mat


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
    """Chamfered rectangle in the XY plane at z."""
    ch = ch if ch is not None else min(w, h) * 0.25
    hw, hh = w / 2, h / 2
    pts = [(hw, hh - ch), (hw, -hh + ch), (hw - ch, -hh), (-hw + ch, -hh), (-hw, -hh + ch), (-hw, hh - ch),
           (-hw + ch, hh), (hw - ch, hh)]
    return [(cx + x, cy + y, z) for x, y in pts]


def ring_y(y, w, d, ch=None, cz=0.0, cx=0.0):
    """Chamfered rectangle in the XZ plane at height y (for lofting up a torso)."""
    ch = ch if ch is not None else min(w, d) * 0.28
    hw, hd = w / 2, d / 2
    pts = [(hw, hd - ch), (hw, -hd + ch), (hw - ch, -hd), (-hw + ch, -hd), (-hw, -hd + ch), (-hw, hd - ch),
           (-hw + ch, hd), (hw - ch, hd)]
    return [(cx + x, y, cz + z) for x, z in reversed(pts)]


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

    def loft(self, rings, mat, cap0=False, cap1=False, matfn=None, capmat=None):
        vr = [[self.V(p) for p in r] for r in rings]
        n = len(rings[0])
        faces = []
        for i in range(len(vr) - 1):
            for k in range(n):
                j = (k + 1) % n
                m = matfn(i, k) if matfn else mat
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

    def cyl(self, a, b, r1, r2=None, segs=8, mat='ColossusIron', cap0=True, cap1=True, phase=0.0, capmat=None):
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
            faces = self.loft([r0, [(c * r2, s * r2, d.length) for c, s in ring]], mat, cap0, cap1, capmat=capmat)
        self.pop()
        return faces

    def lathe(self, profile, segs, mat, M=None, matfn=None, phase=0.0, cap=False):
        """Revolve an (r, z) profile about local Z (then M); matfn(profile index) picks a band's material."""
        rings = [[(r * math.cos(phase + 2 * PI * i / segs), r * math.sin(phase + 2 * PI * i / segs), z)
                  for i in range(segs)] for r, z in profile]
        self.push(M if M is not None else Matrix.Identity(4))
        f = self.loft(rings, mat, matfn=(lambda i, k: matfn(i)) if matfn else None, cap1=cap)
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
        a, b = Vector(a), Vector(b)
        d = (b - a)
        z = d.normalized()
        y = Vector(up)
        y = (y - z * y.dot(z)).normalized()
        x = y.cross(z)
        m = Matrix((x, y, z)).transposed().to_4x4()
        return self.box((0, 0, d.length / 2), (w, h, d.length), mat, M=T(a) @ m)

    def sphere(self, c, r, mat, u=8, v=5, scale=(1, 1, 1), M=None):
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

    def sweep(self, pts, r, mat, segs=5):
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
            rings.append([tuple(p + (u * math.cos(a) + w * math.sin(a)) * r)
                          for a in (2 * PI * (k + 0.5) / segs for k in range(segs))])
            ref = u
        return self.loft(rings, mat, True, True)

    def cable(self, a, b, sag, r, mat='ColossusSoot', n=5, segs=5):
        a, b = Vector(a), Vector(b)
        pts = [a.lerp(b, t) - Vector((0, sag * 4 * t * (1 - t), 0)) for t in (i / n for i in range(n + 1))]
        return self.sweep(pts, r, mat, segs)


# ================================================================================================= parts

def build_pelvis():
    mb = MB()
    # The pelvic block: a tapered box with a bronze belt, hip axle housings out to the sockets.
    mb.box((0, 0.6, 0), (11, 5.6, 8.4), 'ColossusIron', taper=(1.12, 1.0))
    mb.box((0, 3.1, 0), (12.6, 0.9, 9.0), 'ColossusBronze')
    for sx in (1, -1):
        mb.cyl((sx * 3.5, 0, 0), (sx * 5.0, 0, 0), 3.1, 3.1, 10, 'ColossusRust')
        mb.sphere((sx * 6.5, 0, 0), 2.9, 'ColossusSteel', u=10, v=6)
        mb.cyl((sx * 8.0, 0, 0), (sx * 9.6, 0, 0), 2.4, 1.6, 10, 'ColossusIron')
        # outer armour skirt over the hip joint, flared out
        mb.box((sx * 10.4, -1.2, 0), (0.9, 7.0, 7.6), 'ColossusRust', rot=(0, 0, sx * 0.22))
        mb.box((sx * 10.9, 1.9, 0), (1.2, 1.0, 8.0), 'ColossusBronze', rot=(0, 0, sx * 0.22))
    # front plate (codpiece) and the back's
    mb.box((0, -1.6, 4.4), (6.4, 5.5, 1.3), 'ColossusRust', rot=(-0.18, 0, 0), taper=(1.3, 1.0))
    mb.box((0, -1.0, -4.4), (8.0, 5.0, 1.2), 'ColossusIron', rot=(0.15, 0, 0), taper=(1.2, 1.0))
    # waist bearing under the torso
    mb.cyl((0, 3.4, 0), (0, 4.4, 0), 4.6, 4.2, 12, 'ColossusSoot')
    return finish(mb, 'Colossus_Pelvis')


def build_torso():
    mb = MB()
    # The barrel: a loft up from a narrow ribbed waist to a huge chest, pigeon-chested, then in to the neck.
    prof = [  # y, width, depth, z centre
        (0.0, 10.5, 8.0, 0.0), (1.6, 11.2, 8.6, 0.0), (2.0, 10.2, 7.8, 0.0), (3.6, 11.4, 8.8, 0.1), (4.0, 10.6, 8.2, 0.1),
        (5.6, 14.0, 11.0, 0.3), (7.6, 19.0, 14.6, 0.6), (10.0, 22.5, 16.4, 0.8), (13.5, 24.0, 16.2, 0.5),
        (16.5, 22.5, 14.0, 0.0), (18.6, 16.5, 11.0, 0.0), (19.8, 9.5, 7.6, 0.5),
    ]
    rings = [ring_y(y, w, d, cz=cz) for y, w, d, cz in prof]

    def mf(i, k):
        if i in (1, 3):
            return 'ColossusSoot'  # the waist's grooves
        if i in (0, 2):
            return 'ColossusRust'
        return 'ColossusIron'
    mb.loft(rings, 'ColossusIron', cap0=True, cap1=True, matfn=mf)
    # Ribs: rust bands round the belly.
    for y, w, d in ((5.0, 13.2, 10.6), (6.4, 16.8, 13.0)):
        mb.loft([ring_y(y - 0.35, w + 0.5, d + 0.5, cz=0.4), ring_y(y + 0.35, w + 0.5, d + 0.5, cz=0.4)], 'ColossusRust')

    # The chest furnace: an iron ring round the core (the lens sits in it), a grille of glowing slots round that.
    cx, cy, cz = 0, 9.5, 8.9
    mb.cyl((cx, cy, cz - 1.4), (cx, cy, cz + 0.2), 4.6, 4.4, 14, 'ColossusIron', capmat='ColossusSoot')
    mb.cyl((cx, cy, cz - 0.2), (cx, cy, cz + 0.6), 4.2, 3.8, 14, 'ColossusBronze', cap1=False)
    for k in range(8):
        a = 2 * PI * k / 8 + PI / 8
        px, py = cx + math.cos(a) * 6.2, cy + math.sin(a) * 6.2
        mb.box((px, py, cz - 0.6), (2.4, 0.55, 0.7), 'ColossusGlow', rot=(0, 0, a))
        mb.box((px, py, cz - 0.9), (3.0, 1.1, 0.7), 'ColossusSoot', rot=(0, 0, a))
    # Breastplate brow over the furnace and plates under it.
    mb.box((0, 15.2, 7.9), (17.0, 3.2, 1.6), 'ColossusRust', rot=(0.32, 0, 0), taper=(1.15, 1.0))
    mb.box((0, 16.6, 8.4), (10.0, 0.7, 1.0), 'ColossusBronze', rot=(0.32, 0, 0))
    for sx in (1, -1):
        mb.box((sx * 8.6, 10.0, 7.6), (5.0, 7.5, 1.3), 'ColossusRust', rot=(0.05, sx * 0.48, 0))
        # vents slits under the arms
        for j in range(3):
            mb.box((sx * 11.2, 6.6 + j * 1.3, 3.0), (0.5, 0.45, 4.2), 'ColossusGlow', rot=(0, 0, sx * 0.5))
        mb.box((sx * 11.0, 7.9, 3.0), (0.6, 4.2, 5.0), 'ColossusSoot', rot=(0, 0, sx * 0.5))

    # Shoulders: joint balls under huge layered pauldrons, a spike on each.
    for sx in (1, -1):
        X = sx * 13.5
        mb.sphere((X, 15.5, 0), 3.2, 'ColossusSteel', u=10, v=6)
        M = T(X + sx * 0.8, 17.6, 0) @ Rz(-sx * 0.42) @ Rx(-PI / 2)
        sc = S(1.0, 1.25, 1.0)
        mb.lathe([(0.01, 4.6), (2.6, 4.3), (5.0, 3.0), (6.6, 1.0), (7.1, -1.0)], 12, 'ColossusIron', M=M @ sc,
                 matfn=lambda i: 'ColossusRust' if i == 1 else 'ColossusIron', cap=False)
        mb.lathe([(6.6, 0.0), (7.5, -1.6), (7.8, -3.2)], 12, 'ColossusRust', M=M @ T(0, 0, -0.6) @ sc)
        mb.lathe([(7.4, -2.6), (8.2, -4.0), (8.4, -5.4)], 12, 'ColossusIron', M=M @ T(0, 0, -1.2) @ sc)
        mb.lathe([(8.3, -6.4), (8.5, -5.8)], 12, 'ColossusBronze', M=M @ sc)
        top = (X - sx * 0.6, 22.2, 0)
        mb.cyl(top, (X + sx * 0.8, 28.0, -0.5), 1.3, 0.0, 6, 'ColossusSoot')
        mb.cyl((X - sx * 0.4, 21.6, 3.2), (X + sx * 0.6, 25.2, 3.6), 0.8, 0.0, 6, 'ColossusSoot')
        mb.cyl((X - sx * 0.4, 21.6, -3.2), (X + sx * 0.6, 25.2, -3.8), 0.8, 0.0, 6, 'ColossusSoot')

    # Back: a boiler hump, a spine of plates, the two exhaust stacks (weak points at their throats).
    mb.box((0, 11.5, -7.6), (14.0, 11.0, 4.0), 'ColossusRust', rot=(-0.1, 0, 0), taper=(0.9, 0.8))
    for j in range(5):
        mb.box((0, 4.5 + j * 3.2, -9.2 - 0.1 * j), (2.0, 2.4, 2.4), 'ColossusIron', rot=(0.5, 0, 0))
    for sx in (1, -1):
        base, top = Vector((sx * 5.0, 11.0, -8.4)), Vector((sx * 6.8, 20.5, -12.6))
        d = (top - base).normalized()
        mb.cyl(base, top, 2.3, 2.0, 10, 'ColossusIron', cap1=False)
        mb.cyl(top - d * 0.4, top + d * 0.7, 2.6, 2.5, 10, 'ColossusBronze', cap0=False, cap1=False)
        mb.cyl(top - d * 1.2, top - d * 0.6, 1.95, 1.95, 10, 'ColossusGlow', cap0=True, cap1=False)
        mb.cyl(top - d * 0.6, top + d * 0.6, 2.1, 2.1, 10, 'ColossusSoot', cap0=False, cap1=False)
        mb.cable((sx * 3.0, 6.0, -9.0), (sx * 4.6, 12.6, -9.6), 0.8, 0.5)
    # Gorget round the neck.
    mb.cyl((0, 18.4, 0.6), (0, 20.6, 0.8), 6.0, 4.4, 12, 'ColossusIron', cap0=False, capmat='ColossusSoot')
    mb.cyl((0, 20.3, 0.8), (0, 20.9, 0.8), 4.6, 4.4, 12, 'ColossusBronze', cap0=False, cap1=False)
    return finish(mb, 'Colossus_Torso')


def build_head():
    mb = MB()
    # Hunched helmet: a tapered block jutting forward, a visor with the burning slit, a crest, cheek plates.
    mb.box((0, 2.4, 0.9), (5.6, 4.6, 6.2), 'ColossusIron', taper=(0.78, 0.85))
    mb.box((0, 2.5, 3.85), (4.6, 2.2, 0.6), 'ColossusSoot')
    mb.box((0, 2.6, 4.12), (3.8, 0.55, 0.3), 'ColossusGlow')
    mb.box((0, 3.75, 4.0), (5.2, 0.9, 1.4), 'ColossusRust', rot=(0.35, 0, 0))  # brow
    mb.box((0, 0.9, 3.6), (4.0, 1.8, 1.2), 'ColossusRust', rot=(-0.25, 0, 0))  # jaw
    for k in range(4):
        mb.box((-1.2 + k * 0.8, 0.85, 4.25), (0.25, 1.1, 0.3), 'ColossusSoot', rot=(-0.25, 0, 0))
    mb.box((0, 5.0, 0.4), (0.9, 1.4, 6.4), 'ColossusBronze', taper=(0.5, 0.9))  # crest
    for sx in (1, -1):
        mb.box((sx * 2.9, 2.0, 0.8), (0.7, 3.4, 4.8), 'ColossusRust', rot=(0, 0, -sx * 0.12))
        mb.cyl((sx * 2.0, 4.2, -1.6), (sx * 3.4, 7.0, -3.2), 0.5, 0.0, 5, 'ColossusSoot')
    return finish(mb, 'Colossus_Head')


def build_upper_arm():
    mb = MB()
    mb.cyl((-2.4, 0, 0), (2.4, 0, 0), 2.7, 2.7, 10, 'ColossusSteel')
    rings = [ring_y(-1.0, 5.2, 5.2), ring_y(-3.0, 5.6, 5.4), ring_y(-11.5, 4.4, 4.6), ring_y(-13.0, 3.8, 4.0)]
    mb.loft(list(reversed(rings)), 'ColossusIron', cap0=True, cap1=True)
    # outer armour and a bronze band, a piston down the front
    mb.box((1.9, -6.5, 0), (1.1, 8.5, 5.0), 'ColossusRust', rot=(0, 0, 0.05))
    mb.box((0, -3.0, 0), (6.1, 0.8, 5.9), 'ColossusBronze')
    mb.cyl((0, -2.2, 3.0), (0, -10.5, 2.8), 0.8, 0.8, 6, 'ColossusIron')
    mb.cyl((0, -10.5, 2.8), (0, -13.2, 2.4), 0.45, 0.45, 6, 'ColossusSteel')
    mb.cyl((-2.2, -14, 0), (2.2, -14, 0), 2.4, 2.4, 10, 'ColossusSteel')
    return finish(mb, 'Colossus_UpperArm')


def build_forearm():
    mb = MB()
    # Huge forearm, wider towards the fist (a club of a fist with knuckle spikes).
    rings = [ring_y(-0.8, 4.2, 4.4), ring_y(-3.0, 5.6, 5.8), ring_y(-10.0, 6.4, 6.6), ring_y(-12.4, 5.2, 5.4)]
    mb.loft(list(reversed(rings)), 'ColossusIron', cap0=True, cap1=True,
            matfn=lambda i, k: 'ColossusRust' if k in (0, 7) else 'ColossusIron')
    for y in (-4.0, -9.0):
        mb.loft([ring_y(y - 0.4, 6.4 + (y + 4) * -0.12, 6.6), ring_y(y + 0.4, 6.4 + (y + 4) * -0.12, 6.6)], 'ColossusBronze')
    mb.box((2.6, -7.0, 0), (1.2, 7.0, 4.0), 'ColossusRust', rot=(0, 0, -0.06))
    # Fist
    mb.box((0, -14.6, 0.4), (5.6, 4.6, 5.4), 'ColossusIron', taper=(1.05, 1.05))
    mb.box((0, -16.6, 1.6), (5.4, 1.4, 3.4), 'ColossusSoot')
    for k in range(4):
        x = -2.0 + k * 1.33
        mb.box((x, -16.4, 2.9), (1.1, 1.6, 1.4), 'ColossusRust')
        mb.cyl((x, -16.4, 3.5), (x, -16.8, 5.0), 0.45, 0.0, 5, 'ColossusSoot')
    mb.box((3.0, -14.2, 1.6), (1.2, 2.6, 2.4), 'ColossusRust', rot=(0, 0, 0.2))  # thumb
    return finish(mb, 'Colossus_Forearm')


def build_thigh():
    mb = MB()
    # along +Z from hip to knee; +Y = front
    rings = [oct_ring(-1.0, 6.6, 6.8), oct_ring(2.5, 7.6, 8.2, cy=0.3), oct_ring(14.5, 6.0, 6.6, cy=0.2),
             oct_ring(18.0, 4.8, 5.0)]
    mb.loft(rings, 'ColossusIron', cap0=True, cap1=True,
            matfn=lambda i, k: 'ColossusRust' if k in (6, 7, 0) and i == 1 else 'ColossusIron')
    # front armour plate, side plates, a big piston on the outside
    mb.box((0, 4.4, 8.0), (6.2, 1.0, 11.5), 'ColossusRust', rot=(0.04, 0, 0))
    mb.box((0, 5.0, 8.0), (2.2, 0.5, 10.5), 'ColossusBronze', rot=(0.04, 0, 0))
    for sx in (1, -1):
        mb.cyl((sx * 4.0, 0.4, 2.0), (sx * 3.6, 0.2, 12.0), 1.1, 1.1, 8, 'ColossusIron')
        mb.cyl((sx * 3.2, 0.2, 12.0), (sx * 2.6, 0.0, 18.0), 0.55, 0.55, 6, 'ColossusSteel')
    mb.cable((0, -3.0, 2.0), (0, -2.6, 16.0), -0.8, 0.5)
    return finish(mb, 'Colossus_Thigh')


def build_shin():
    mb = MB()
    # knee joint, kneecap, the shin with a swelling calf at the back and the hydraulic rams down it.
    mb.cyl((-3.0, 0, 0), (3.0, 0, 0), 3.0, 3.0, 12, 'ColossusSteel')
    mb.cyl((-3.4, 0, 0), (-2.6, 0, 0), 3.4, 3.4, 12, 'ColossusBronze')
    mb.cyl((2.6, 0, 0), (3.4, 0, 0), 3.4, 3.4, 12, 'ColossusBronze')
    mb.sphere((0, 2.6, -0.8), 3.0, 'ColossusIron', u=10, v=6, scale=(1.15, 0.6, 1.0))  # kneecap dome
    mb.box((0, 3.0, 1.8), (4.4, 1.0, 1.6), 'ColossusSoot', rot=(-0.5, 0, 0))  # the cap's lip over the weak point
    rings = [oct_ring(1.5, 5.6, 5.8), oct_ring(6.0, 6.2, 7.6, cy=-0.8), oct_ring(12.0, 5.4, 6.2, cy=-0.4),
             oct_ring(18.5, 4.4, 4.4), oct_ring(20.2, 3.8, 3.8)]
    mb.loft(rings, 'ColossusIron', cap0=True, cap1=True,
            matfn=lambda i, k: 'ColossusRust' if k in (2, 3) else 'ColossusIron')
    # front greave
    mb.box((0, 3.5, 11.0), (5.4, 0.9, 13.5), 'ColossusRust', rot=(-0.07, 0, 0), taper=(0.85, 1.0))
    mb.box((0, 4.0, 11.0), (1.4, 0.5, 12.5), 'ColossusBronze', rot=(-0.07, 0, 0))
    # hydraulic rams down the back: housings, then polished rods to the ankle
    for sx in (1, -1):
        mb.cyl((sx * 1.9, -4.4, 2.5), (sx * 1.9, -4.1, 11.5), 1.2, 1.2, 8, 'ColossusIron')
        mb.cyl((sx * 1.9, -4.1, 11.0), (sx * 1.9, -4.1, 11.9), 1.4, 1.4, 8, 'ColossusBronze')
        mb.cyl((sx * 1.9, -4.1, 11.9), (sx * 1.6, -2.8, 19.6), 0.6, 0.6, 6, 'ColossusSteel')
    mb.cable((2.6, -1.0, 4.0), (2.2, -1.4, 16.0), 0.6, 0.45)
    mb.cyl((-2.4, 0, 20), (2.4, 0, 20), 2.3, 2.3, 10, 'ColossusSteel')
    return finish(mb, 'Colossus_Shin')


def build_foot():
    mb = MB()
    # A giant flat pad: sole on y = -3, heel at z -3.5, three toe plates to z +7.5.
    mb.sphere((0, 0, 0), 2.5, 'ColossusSteel', u=10, v=6)
    mb.box((0, -2.85, 1.6), (6.4, 0.3, 10.2), 'ColossusSoot')
    mb.box((0, -1.9, 1.0), (5.8, 1.7, 9.0), 'ColossusIron', taper=(0.85, 0.85))
    mb.box((0, -0.7, 0.4), (4.4, 1.6, 5.5), 'ColossusRust', rot=(-0.12, 0, 0), taper=(0.7, 0.8))
    for k, x in enumerate((-2.1, 0.0, 2.1)):
        mb.box((x, -2.2, 6.2), (1.9, 1.5, 3.2), 'ColossusIron', taper=(0.8, 0.7))
        mb.box((x, -1.4, 6.0), (1.5, 0.4, 2.6), 'ColossusBronze', rot=(-0.15, 0, 0))
        mb.cyl((x, -2.6, 7.4), (x, -2.85, 8.4), 0.6, 0.0, 5, 'ColossusSoot')
    mb.box((0, -2.0, -3.6), (3.4, 1.8, 1.4), 'ColossusRust', taper=(0.8, 0.7))  # heel
    for sx in (1, -1):
        mb.cyl((sx * 2.2, -0.2, -1.6), (sx * 2.4, -2.0, -3.2), 0.5, 0.5, 6, 'ColossusSteel')
    return finish(mb, 'Colossus_Foot')


# ================================================================================================= helpers

def finish(mb, name):
    bmesh.ops.transform(mb.bm, matrix=C, verts=mb.bm.verts)
    mb.bm.normal_update()
    mesh = bpy.data.meshes.new(name)
    mb.bm.to_mesh(mesh)
    mb.bm.free()
    for m in mb.mats:
        mesh.materials.append(bpy.data.materials[m])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def export_glb(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                              export_apply=True, export_materials='EXPORT', export_normals=True,
                              export_texcoords=False)


# ================================================================================================= preview

HIP_H, HIP_X, WAIST_Y, THIGH, SHIN, ANKLE_H = 38.5, 6.5, 3.2, 19.0, 20.0, 3.0
SHOULDER = (13.5, 15.5, 0.0)
NECK = (0, 20, 0.5)


def basis_aim(frm, to, pole):
    z = (to - frm).normalized()
    x = pole.cross(z).normalized()
    y = z.cross(x)
    return T(frm) @ Matrix((x, y, z)).transposed().to_4x4()


def place(src, M3, coll, mirror=False):
    o = src.copy()
    o.hide_render = False
    coll.objects.link(o)
    o.matrix_world = C @ M3 @ (S(-1, 1, 1) if mirror else Matrix.Identity(4)) @ C.inverted()
    return o


LENS = {}


def lens(coll, M, r):
    if 'o' not in LENS:
        mb = MB()
        mb.sphere((0, 0, 0), 1.0, 'PreviewLens', u=12, v=8)
        LENS['o'] = finish(mb, 'PreviewLens')
        LENS['o'].hide_render = True
    place(LENS['o'], M @ S(r, r, r), coll)


def assemble(parts, coll, hips, feet, lean=0.0, arm_swing=(0.15, -0.15), yaw=0.0):
    """A pose: hips (x, y, z), feet [(x, y, z) of the sole centre's ankle point] in world, facing +Z turned by yaw."""
    R = Ry(yaw)
    P = T(hips) @ R
    place(parts['Colossus_Pelvis'], P, coll)
    Tor = P @ T(0, WAIST_Y, 0) @ Rx(lean)
    place(parts['Colossus_Torso'], Tor, coll)
    place(parts['Colossus_Head'], Tor @ T(NECK) @ Rx(0.15), coll)
    lens(coll, Tor @ T(CORE), CORE_R)
    lens(coll, Tor @ T(VENT), VENT_R)
    lens(coll, Tor @ T(-VENT[0], VENT[1], VENT[2]), VENT_R)
    for i, sx in enumerate((1, -1)):
        sh = Tor @ T(sx * SHOULDER[0], SHOULDER[1], 0) @ Rx(arm_swing[i]) @ Rz(sx * 0.08)
        place(parts['Colossus_UpperArm'], sh, coll, mirror=sx < 0)
        el = sh @ T(0, -14, 0) @ Rx(-0.25)
        place(parts['Colossus_Forearm'], el, coll, mirror=sx < 0)
        hip = (P @ Vector((sx * HIP_X, 0, 0)))
        ankle = Vector(feet[i])
        fwd = (R @ Vector((0, 0, 1, 0))).to_3d()
        d = (ankle - hip)
        L = min(THIGH + SHIN - 0.01, d.length)
        v = d.normalized()
        pole = (fwd - v * fwd.dot(v)).normalized()
        along = (THIGH ** 2 - SHIN ** 2 + L ** 2) / (2 * L)
        up = math.sqrt(max(0, THIGH ** 2 - along ** 2))
        knee = hip + v * along + pole * up
        place(parts['Colossus_Thigh'], basis_aim(hip, knee, fwd), coll)
        place(parts['Colossus_Shin'], basis_aim(knee, ankle, fwd), coll)
        lens(coll, basis_aim(knee, ankle, fwd) @ T(KNEE), KNEE_R)
        place(parts['Colossus_Foot'], T(ankle) @ R, coll)


def render_previews(parts, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    scene = bpy.context.scene
    for engine in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x, scene.render.resolution_y = 1200, 900
    scene.view_settings.view_transform = 'Standard'
    for o in parts.values():
        o.hide_render = True
    bpy.ops.mesh.primitive_plane_add(size=2000, location=(0, 0, 0))
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
    sun.rotation_euler = (math.radians(90 - 18), 0, math.radians(-140))
    scene.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.clip_end = 5000

    def look(pos3, target3, lens):
        p = C @ Vector(pos3)
        t = C @ Vector(target3)
        cam.location = p
        cam.rotation_euler = (t - p).to_track_quat('-Z', 'Y').to_euler()
        cam.data.lens = lens

    def shoot(name):
        scene.render.filepath = os.path.join(out_dir, name)
        bpy.ops.render.render(write_still=True)

    coll = bpy.data.collections.new('rig')
    scene.collection.children.link(coll)
    # mid-stride: +X foot forward, the other back
    assemble(parts, coll, (0, HIP_H, 0), [(7, ANKLE_H, 9), (-7, ANKLE_H, -9)], lean=0.05, arm_swing=(-0.2, 0.25))
    # a 1.8 m person and a 20 m post (a guardian's body height) for scale
    bpy.ops.mesh.primitive_cube_add(size=1, location=C @ Vector((14, 0.9, 16)))
    human = bpy.context.active_object
    human.scale = (0.5, 0.35, 1.8)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.8, depth=20, location=C @ Vector((-20, 10, 20)))
    look((70, 30, 110), (0, 34, 0), 30)
    shoot('colossus_34.png')
    look((0, 30, 120), (0, 34, 0), 28)
    shoot('colossus_front.png')
    look((-60, 50, -90), (0, 40, 0), 30)
    shoot('colossus_back.png')
    look((110, 18, 0), (0, 34, 0), 26)
    shoot('colossus_side.png')
    look((20, 2, 40), (0, 40, 0), 18)
    shoot('colossus_low.png')
    look((10, 58, 40), (0, 54, 2), 35)
    shoot('colossus_upper.png')
    look((20, 12, 30), (4, 8, 6), 30)
    shoot('colossus_feet.png')
    bg.inputs['Color'].default_value = (*lin(0xf7a440), 1)
    bg.inputs['Strength'].default_value = 1.4
    sd.energy = 0.5
    look((-140, 6, 160), (0, 36, 0), 30)
    shoot('colossus_dusk.png')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models'))
    ap.add_argument('--preview', default=None, help='directory for PNG previews')
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in MATERIALS.items():
        make_material(name, *spec)
    parts = {}
    for fn in (build_pelvis, build_torso, build_head, build_upper_arm, build_forearm, build_thigh, build_shin,
               build_foot):
        o = fn()
        parts[o.name] = o
    os.makedirs(args.out, exist_ok=True)
    export_glb(list(parts.values()), os.path.join(args.out, 'colossus.glb'))
    total = 0
    for o in parts.values():
        bb = [C.inverted() @ Vector(c) for c in o.bound_box]
        lo = [min(v[i] for v in bb) for i in range(3)]
        hi = [max(v[i] for v in bb) for i in range(3)]
        n = tri_count(o)
        total += n * (1 if o.name in ('Colossus_Pelvis', 'Colossus_Torso', 'Colossus_Head') else 2)
        print(f'{o.name}: tris={n} bbox x {lo[0]:.1f}..{hi[0]:.1f} y {lo[1]:.1f}..{hi[1]:.1f} z {lo[2]:.1f}..{hi[2]:.1f}')
    print(f'assembled colossus tris: {total}')
    if args.preview:
        render_previews(parts, os.path.abspath(args.preview))


main()
