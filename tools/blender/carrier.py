"""The hive carrier (shared/carrier.ts): the searchlight drones' mothership, a huge armoured hull hovering on four
ducted fans, exported as a glTF binary.

    tools/blender/run.sh -b --python tools/blender/carrier.py                     # writes public/models/carrier.glb
    tools/blender/run.sh -b --python tools/blender/carrier.py -- --preview <dir>  # also renders PNG previews

All coordinates are three.js (Y up, +Z forward), built in three.js space and turned into Blender's Z-up frame just
before export (as tools/blender/guardians.py does), so the glTF exporter's Y-up conversion gives these numbers back.

  Carrier_Hull    the hull, arms out to the four ducts, masts, sensor pods, bomb bay, nav lamps, searchlight
                  housings. Origin = hull centre. Fan centres at shared/carrier.ts FANS (+-30, 0.6, +-23); bomb bay
                  at BAY (0, -5.6, -2); searchlight lenses at LAMPS below (material CarrierLamp).
  Carrier_Duct    one duct ring with its spokes and the motor pod under the rotor, origin = fan centre; the game
                  clones it to each fan and tilts it. The weak point (a glowing lens the game adds) sits at
                  (0, -3.3, 0), under the motor pod, seen from below and from the side under the ring.
  Carrier_Rotor   five blades and the hub cap, origin = fan centre (spins about local Y).

Materials are flat Principled BSDF colours (no textures); CarrierNavRed / CarrierNavWhite are the nav lamps (the game
blinks them), CarrierLamp the searchlight lenses, CarrierEye the sensor pods' eyes. Units are metres. Deterministic.
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
    'CarrierIron': (0x26211e, 0.6, 0.55, None),      # dark armoured hull
    'CarrierPlate': (0x3a332d, 0.55, 0.55, None),    # the jets' hull grey-brown: raised plates, ducts
    'CarrierSteel': (0x6a6158, 0.7, 0.4, None),      # worn edges, rods, rotor hubs
    'CarrierDark': (0x120e0c, 0.3, 0.8, None),       # recesses, duct insides, bay, cables
    'CarrierRust': (0x6a2f17, 0.45, 0.7, None),      # undersides, flanges
    'CarrierCeramic': (0xc9b48f, 0.1, 0.65, None),   # a few sand-bleached plates (the drones' family look)
    'CarrierHazard': (0xc8641e, 0.3, 0.6, None),     # faded hazard orange stripes, blade tips
    'CarrierLamp': (0xfff0d0, 0.0, 0.3, 12.0),       # searchlight lenses
    'CarrierNavRed': (0xff2010, 0.0, 0.4, 6.0),
    'CarrierNavWhite': (0xfff4e0, 0.0, 0.4, 6.0),
    'CarrierEye': (0xff4a14, 0.0, 0.4, 8.0),
}

# keep in step with shared/carrier.ts
FANS = [(30, 0.6, 23), (-30, 0.6, 23), (-30, 0.6, -23), (30, 0.6, -23)]
DUCT_R = 10.0
BAY = (0, -5.6, -2)
# searchlight lenses (centre of the lens face, pointing down); keep in step with src/world/carrier.ts LAMPS
LAMPS = [(0, -6.6, 21), (-11, -6.4, -17), (11, -6.4, -17)]
HUB_LENS = (0, -3.3, 0)

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

    def cyl(self, a, b, r1, r2=None, segs=8, mat='CarrierIron', cap0=True, cap1=True, phase=0.0, matfn=None):
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

    def cable(self, a, b, sag, r, mat='CarrierDark', n=6, segs=5):
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


# ================================================================================================= carrier

# Hull plan, nose (+Z) to tail: z, width, height, centre height. A flattened hexagonal lozenge.
PLAN = [(-30, 13, 3.6, 0.6), (-27, 21, 5.6, 0.3), (-18, 32, 8.6, 0), (-6, 36, 10, 0), (8, 36, 10, 0),
        (18, 30, 8.6, -0.2), (26, 18, 6, -0.5), (30, 9, 3.2, -0.8)]


def plan_at(z):
    for (z0, w0, h0, c0), (z1, w1, h1, c1) in zip(PLAN, PLAN[1:]):
        if z0 <= z <= z1:
            t = (z - z0) / (z1 - z0)
            return lerp(w0, w1, t), lerp(h0, h1, t), lerp(c0, c1, t)
    return PLAN[-1][1:]


def hull_mat(i, k):
    return {6: 'CarrierIron', 5: 'CarrierPlate', 7: 'CarrierPlate', 0: 'CarrierIron', 4: 'CarrierIron',
            1: 'CarrierIron', 3: 'CarrierIron', 2: 'CarrierPlate'}[k]


def build_hull():
    mb = MB()
    rings = [oct_ring(z, w, h, h * 0.36, cy=cy) for z, w, h, cy in PLAN]
    mb.loft(rings, 'CarrierIron', cap0=True, cap1=True, capmat='CarrierDark', matfn=hull_mat)
    top = lambda z: plan_at(z)[2] + plan_at(z)[1] / 2
    bot = lambda z: plan_at(z)[2] - plan_at(z)[1] / 2
    # dorsal spine and raised armour plates on the back
    mb.box((0, top(0) + 0.7, -2), (6, 1.6, 40), 'CarrierPlate', taper=(0.7, 0.96))
    mb.box((0, top(0) + 1.7, 8), (3.6, 1.2, 12), 'CarrierIron', taper=(0.6, 0.85))
    for x, z, w, d, m in [(-9, -4, 8, 14, 'CarrierPlate'), (9, -4, 8, 14, 'CarrierPlate'), (-7, 12, 6, 8, 'CarrierCeramic'),
                          (8, -18, 6, 6, 'CarrierCeramic'), (7, 13, 6, 7, 'CarrierPlate')]:
        mb.box((x, top(z) + 0.15, z), (w, 0.5, d), m, taper=(0.9, 0.92))
    # faded hazard chevrons on the nose
    for s in (-1, 1):
        mb.beam((s * 1.2, top(24) + 0.05, 24), (s * 6, top(20) + 0.05, 19), 1.0, 0.3, 'CarrierHazard')
    # antenna masts, red lamps on their tips
    for (x, z, hgt, bars) in [(4, -20, 15, 3), (-5, -13, 9, 2), (2.5, 21, 5.5, 1)]:
        y0 = top(z)
        mb.cyl((x, y0 - 0.2, z), (x, y0 + hgt, z), 0.32, 0.14, 6, 'CarrierSteel')
        for b in range(bars):
            yb = y0 + hgt * (0.45 + 0.18 * b)
            ln = 2.6 - b * 0.7
            mb.cyl((x - ln, yb, z), (x + ln, yb, z), 0.09, None, 4, 'CarrierSteel')
        mb.sphere((x, y0 + hgt + 0.25, z), 0.4, 'CarrierNavRed', 6, 3)
    # dish on the back
    mb.lathe([(0.2, 0), (1.8, 0.55), (2.6, 1.2)], 10, 'CarrierSteel', M=T(-9, top(4) + 1.2, 4) @ Rx(-PI / 2 + 0.5))
    mb.cyl((-9, top(4), 4), (-9, top(4) + 1.3, 4), 0.25, None, 5, 'CarrierSteel')

    # ribbed underside, split either side of the bomb bay
    for z in range(-24, 25, 4):
        w, h, cy = plan_at(z)
        y = bot(z) - 0.3
        half = w * 0.42
        if abs(z - BAY[2]) < 6.5:
            for s in (-1, 1):
                mb.box((s * (3.9 + half) / 2, y, z), (half - 3.9, 0.7, 0.8), 'CarrierIron')
        else:
            mb.box((0, y, z), (half * 2, 0.7, 0.8), 'CarrierIron')
    # keel beams along the belly
    for s in (-1, 1):
        mb.box((s * 9, bot(0) - 0.4, 0), (0.9, 0.9, 44), 'CarrierSteel')
    # bomb bay: a dark recess with a hazard frame and two doors hanging open
    bx, by, bz = BAY
    mb.box((bx, by + 0.2, bz), (7, 0.3, 11), 'CarrierDark')
    for s in (-1, 1):
        mb.box((s * 3.6, by + 0.25, bz), (0.5, 0.5, 11.6), 'CarrierHazard')
        mb.box((0, by + 0.25, bz + s * 5.6), (7.6, 0.5, 0.5), 'CarrierHazard')
        mb.box((0, -1.0, 0), (0.25, 2.2, 10.4), 'CarrierIron', M=T(s * 3.5, by + 0.2, bz) @ Rz(s * 0.35) @ T(0, -1.0, 0))
    # bombs racked in the bay
    for i in range(3):
        mb.cyl((-1.2 + i * 1.2, by + 0.0, bz - 3.5), (-1.2 + i * 1.2, by + 0.0, bz + 3.5), 0.42, None, 8, 'CarrierRust')

    # hanging sensor pods under the nose, eyes forward
    for s in (-1, 1):
        x, z = s * 7, 13
        y0 = bot(z)
        mb.cyl((x, y0 + 0.3, z), (x, y0 - 2.4, z), 0.35, 0.3, 6, 'CarrierSteel')
        mb.sphere((x, y0 - 3.2, z), 1.3, 'CarrierPlate', 10, 6, scale=(1, 0.75, 1.5))
        mb.sphere((x, y0 - 3.4, z + 1.75), 0.45, 'CarrierEye', 6, 4)
    mb.sphere((0, bot(26) - 0.8, 26.5), 1.0, 'CarrierDark', 8, 5)
    mb.sphere((0, bot(26) - 0.9, 27.4), 0.3, 'CarrierEye', 6, 3)

    # searchlight housings: a can on a yoke, the lens facing down
    for x, ly, z in LAMPS:
        y0 = bot(z)
        mb.box((x, y0 - 0.3, z), (3.6, 0.6, 3.6), 'CarrierIron')
        mb.cyl((x, y0 - 0.4, z), (x, ly + 0.15, z), 1.45, 1.6, 10, 'CarrierSteel')
        mb.cyl((x, ly + 0.2, z), (x, ly, z), 1.25, 1.25, 10, 'CarrierLamp')

    # arms out to the ducts: a deep box beam and a strut under it
    for fx, fy, fz in FANS:
        sx, sz = math.copysign(1, fx), math.copysign(1, fz)
        a = Vector((sx * 12.5, fy, sz * 18))
        c = Vector((fx, fy, fz))
        d = (c - a).normalized()
        e = c - d * (DUCT_R + 1.6)
        mb.beam(a, e, 2.6, 2.4, 'CarrierIron')
        mb.beam(a + Vector((0, 1.25, 0)), e + Vector((0, 1.25, 0)), 2.0, 0.35, 'CarrierPlate')
        mb.beam(Vector((sx * 10, -3.5, sz * 15)), e + Vector((0, -1.3, 0)), 0.8, 0.8, 'CarrierRust')
        # nav lamps on the outer tips of the arms: red to port, white to starboard
        mb.box(tuple(e + Vector((0, 1.6, 0))), (0.8, 0.5, 0.8), 'CarrierNavRed' if fx > 0 else 'CarrierNavWhite')

    # a row of nav lamps down each side, red and white in turn
    for s in (-1, 1):
        for j, z in enumerate((-12, -6, 0, 6, 12)):
            w, h, cy = plan_at(z)
            mb.box((s * (w / 2 + 0.15), cy + 0.2, z), (0.4, 0.5, 0.9), 'CarrierNavRed' if (j % 2 == 0) else 'CarrierNavWhite')
    # tail lamp
    mb.box((0, PLAN[0][3] + 0.4, -30.2), (1.2, 0.6, 0.4), 'CarrierNavWhite')
    return finish(mb, 'Carrier_Hull')


def build_duct():
    mb = MB()
    prof = [(DUCT_R, -2.2), (DUCT_R, 1.4), (DUCT_R + 0.5, 2.4), (DUCT_R + 1.4, 2.4), (DUCT_R + 1.85, 1.5),
            (DUCT_R + 1.85, 0.7), (DUCT_R + 1.5, -2.2), (DUCT_R, -2.2)]
    mats = ['CarrierDark', 'CarrierSteel', 'CarrierPlate', 'CarrierPlate', 'CarrierHazard', 'CarrierPlate', 'CarrierIron']
    mb.lathe([(r, y) for r, y in prof], 28, 'CarrierPlate', M=Rx(-PI / 2), matfn=lambda k: mats[min(k, len(mats) - 1)])
    # spokes from the ring to the motor pod, under the rotor
    for k in range(4):
        a = PI / 4 + k * PI / 2
        d = Vector((math.cos(a), 0, math.sin(a)))
        mb.beam(d * 1.7 + Vector((0, -1.5, 0)), d * (DUCT_R + 0.2) + Vector((0, -1.2, 0)), 0.7, 0.6, 'CarrierIron')
    # motor pod; its open bottom ring holds the weak point lens
    mb.cyl((0, -3.0, 0), (0, -0.35, 0), 2.1, 1.7, 12, 'CarrierSteel', cap0=False)
    mb.lathe([(2.1, -3.0), (2.25, -3.3), (1.9, -3.4)], 12, 'CarrierDark', M=Rx(-PI / 2))
    return finish(mb, 'Carrier_Duct')


def build_rotor():
    mb = MB()
    mb.cyl((0, -0.35, 0), (0, 0.6, 0), 1.35, 1.0, 10, 'CarrierSteel')
    mb.cyl((0, 0.6, 0), (0, 1.0, 0), 1.0, 0.3, 10, 'CarrierIron')
    for b in range(5):
        a = 2 * PI * b / 5
        M = Ry(a) @ Rz(math.radians(13))
        mb.box((0, 0.15, 5.4), (1.7, 0.2, 7.6), 'CarrierIron', M=M)
        mb.box((0, 0.15, 9.35), (1.72, 0.22, 0.6), 'CarrierHazard', M=M)
    return finish(mb, 'Carrier_Rotor')


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
    hull, duct, rotor = objs
    duct.hide_render = rotor.hide_render = True
    for i, (fx, fy, fz) in enumerate(FANS):
        for src in (duct, rotor):
            o = src.copy()
            o.hide_render = False
            o.location = C @ Vector((fx, fy, fz))
            if src is rotor:
                o.rotation_euler = (0, 0, i * 0.7)
            scene.collection.objects.link(o)
        # the weak point lens the game adds
        bpy.ops.mesh.primitive_uv_sphere_add(radius=1.5, location=C @ Vector((fx + HUB_LENS[0], fy + HUB_LENS[1], fz + HUB_LENS[2])))
        bpy.context.active_object.data.materials.append(bpy.data.materials['CarrierEye'])
    bpy.ops.mesh.primitive_plane_add(size=3000, location=(0, 0, -74))
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

    look((90, -72, 170), (0, 0, 0), 30, 'carrier_ground.png')
    look((130, 50, 120), (0, -3, 0), 32, 'carrier_above.png')
    look((0, -6, 170), (0, -3, 0), 40, 'carrier_side.png')
    look((25, -55, 25), (0, -6, 0), 18, 'carrier_below.png')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--preview', default=None)
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models'))
    args = ap.parse_args(argv)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in MATERIALS.items():
        make_material(name, *spec)
    objs = [build_hull(), build_duct(), build_rotor()]
    os.makedirs(args.out, exist_ok=True)
    export_glb(objs, os.path.join(args.out, 'carrier.glb'))
    for o in objs:
        print(f'{o.name}: tris={tri_count(o)}')
    print('assembled tris:', tri_count(objs[0]) + 4 * (tri_count(objs[1]) + tri_count(objs[2])))
    if args.preview:
        render_previews(objs, os.path.abspath(args.preview))


main()
