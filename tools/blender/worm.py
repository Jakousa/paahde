"""The Borer: a mechanical sand worm about a hundred metres long (shared/worm.ts), exported as a glTF binary.

    tools/blender/run.sh -b --python tools/blender/worm.py                     # writes public/models/worm.glb
    tools/blender/run.sh -b --python tools/blender/worm.py -- --preview <dir>  # also renders PNG previews into <dir>

public/models/worm.glb has one top-level node per part, no parenting; the game lays them along the body's path
(src/world/worm.ts). Coordinates below are three.js (Y up, +Z forward = towards the head); every mesh is built in
three.js coordinates and turned into Blender's Z-up frame just before export, so the exporter gives these back.

  Worm_Segment    one body ring, SEG_LEN 4.4 long, centred on its origin, radius 3.6 (shared/worm.ts RADIUS). Armour
                  band over a dark core, two ribs, rakes on the lower flanks, glowing vents on the sides, and a
                  raised dorsal plate with a socket on top at (0, 4.35, 0) for the weak point lens.
  Worm_Head       the maw: origin = head centre, the collar flaring forward to the rim at z = 2.2 (radius 4.6), a
                  throat glowing deep inside. The jaws hinge on the rim.
  Worm_Grinder    rings of teeth inside the throat, origin on the axis; spins about Z.
  Worm_Jaw        one of three jaw petals; origin = its hinge on the rim, built for the top one (hinge at
                  (0, 4.3, 2.0) on the head, so place it there turned 0, 120, 240 degrees about Z). Closed it
                  reaches forward and in to a point ahead of the maw; it opens by turning about its local X axis
                  (negative angle: the tip swings up and out).
  Worm_Tail       the spike behind the last segment; origin at its root, pointing back (-Z), radius 1.6 at the root
                  (for a segment of scale 1: the game scales it with the last one).

Flat Principled BSDF colours, no textures. WormGlow is emissive (vents, throat, collar lamps). Metres.
Deterministic output.
"""

import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PI = math.pi

SEG_LEN = 4.4
R = 3.6
HINGE = (0, 4.3, 2.0)

# name -> (sRGB hex, metallic, roughness, emission strength or None)
MATERIALS = {
    'WormIron': (0x2e2520, 0.6, 0.6, None),       # dark weathered plate
    'WormRust': (0x6a2f17, 0.45, 0.75, None),     # rust on the lower plates and rakes
    'WormSteel': (0x5c534b, 0.75, 0.4, None),     # ribs, teeth, worn edges
    'WormCeramic': (0xc4ad86, 0.1, 0.7, None),    # sand-bleached back plates (the guardians' armour)
    'WormDark': (0x130f0d, 0.2, 0.85, None),      # the core between bands, recesses
    'WormGlow': (0xff4a14, 0.0, 0.4, 7.0),        # vents, throat, lamps
}

C = Matrix.Rotation(PI / 2, 4, 'X')  # three.js (Y up) -> Blender (Z up)


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lin(h):
    return [srgb_to_linear(((h >> s) & 0xFF) / 255) for s in (16, 8, 0)]


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


def T(x, y=0.0, z=0.0):
    return Matrix.Translation(Vector((x, y, z)))


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
    return T(*p) @ Matrix((x, y, d)).transposed().to_4x4()


class MB:
    """bmesh in three.js coordinates under a transform stack, one material per face."""

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

    def loft(self, rings, mat, cap0=False, cap1=False, matfn=None, closed=True):
        """Quads between consecutive rings (lists of points); matfn(i, k) picks per face (None skips it)."""
        vr = [[self.V(p) for p in r] for r in rings]
        n = len(rings[0])
        for i in range(len(vr) - 1):
            for k in range(n if closed else n - 1):
                j = (k + 1) % n
                m = matfn(i, k) if matfn else mat
                if m is not None:
                    self.F([vr[i][k], vr[i][j], vr[i + 1][j], vr[i + 1][k]], m)
        if cap0:
            self.F(list(reversed(vr[0])), mat)
        if cap1:
            self.F(vr[-1], mat)

    def box(self, c, h, mat, m=None):
        """Box at centre c with half sizes h, under extra matrix m."""
        if m is not None:
            self.push(m)
        x, y, z = c
        a, b, d = h
        p = [(x + sx * a, y + sy * b, z + sz * d) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
        v = [self.V(q) for q in p]
        for f in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            self.F([v[i] for i in f], mat)
        if m is not None:
            self.pop()

    def cyl(self, a, b, r1, r2=None, segs=8, mat='WormSteel', cap=True):
        """Cylinder or cone (r2 0: a spike) from a to b."""
        a, b = Vector(a), Vector(b)
        d = b - a
        r2 = r1 if r2 is None else r2
        self.push(aim(a, d))
        ring = [(math.cos(2 * PI * k / segs), math.sin(2 * PI * k / segs)) for k in range(segs)]
        v0 = [self.V((c * r1, s * r1, 0)) for c, s in ring]
        if r2 <= 1e-6:
            t = self.V((0, 0, d.length))
            for k in range(segs):
                self.F([v0[k], v0[(k + 1) % segs], t], mat)
        else:
            v1 = [self.V((c * r2, s * r2, d.length)) for c, s in ring]
            for k in range(segs):
                j = (k + 1) % segs
                self.F([v0[k], v0[j], v1[j], v1[k]], mat)
            if cap:
                self.F(list(reversed(v0)), mat)
                self.F(v1, mat)
        self.pop()


def ring(z, r, n, phase=0.0, sx=1.0, sy=1.0):
    return [(math.sin(phase + 2 * PI * k / n) * r * sx, math.cos(phase + 2 * PI * k / n) * r * sy, z) for k in range(n)]


def finish(mb, name):
    bmesh.ops.recalc_face_normals(mb.bm, faces=mb.bm.faces)
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


# ================================================================================================= parts

N = 16  # sides around the body


def build_segment():
    mb = MB()
    h = SEG_LEN / 2
    # Dark core, a little longer than the segment so neighbours overlap at bends.
    mb.loft([ring(-h - 0.5, 3.05, N), ring(h + 0.5, 3.05, N)], 'WormDark', cap0=True, cap1=True)

    # The armour band: flared at the front, tucking under the next band behind. Plates by angle: the top third
    # bleached ceramic, the flanks iron, the belly rust; the rings: front lip, crown, tail skirt.
    prof = [(h + 0.05, 3.15), (h - 0.15, 3.68), (h - 1.0, 3.78), (-h + 1.2, 3.6), (-h + 0.2, 3.36), (-h - 0.1, 3.12)]

    def band(i, k):
        a = (k + 0.5) / N  # 0 = top, clockwise seen from behind
        top = a < 0.17 or a > 0.83
        belly = 0.36 < a < 0.64
        if i == 0:
            return 'WormSteel'
        return 'WormCeramic' if top else 'WormRust' if belly else 'WormIron'

    mb.loft([ring(z, r, N, PI / N) for z, r in prof], 'WormIron', matfn=band)
    # Seams between plates: thin dark grooves along the band, every other side.
    for k in range(0, N, 2):
        a = 2 * PI * k / N
        mb.push(Rz(-a))
        mb.box((0, 3.74, 0.1), (0.06, 0.06, h - 0.9), 'WormDark')
        mb.pop()
    # Two steel ribs proud of the band.
    for z, r in ((h - 0.55, 3.86), (-h + 1.6, 3.72)):
        inner = ring(z - 0.18, r - 0.2, N, PI / N)
        mb.loft([ring(z - 0.18, r - 0.25, N, PI / N), ring(z - 0.1, r, N, PI / N), ring(z + 0.1, r, N, PI / N), ring(z + 0.18, r - 0.25, N, PI / N)], 'WormSteel')
        del inner

    # Dorsal plate and the lens socket on top (the lens sits at (0, 4.35, 0) when the segment carries one).
    mb.box((0, 3.95, -0.1), (1.05, 0.28, 1.45), 'WormIron')
    mb.box((0, 4.18, -1.25), (0.8, 0.12, 0.4), 'WormSteel')
    for s in (-1, 1):
        mb.box((s * 0.95, 4.15, 0.1), (0.14, 0.2, 0.95), 'WormSteel')
    mb.cyl((0, 4.0, 0), (0, 4.42, 0), 1.25, 1.18, segs=12, mat='WormDark')

    # Rakes on the lower flanks: a strut out and down, a claw raked back (they comb the sand as it swims).
    for s in (-1, 1):
        for z in (0.9, -0.9):
            a = s * 2.2  # ~126 degrees from the top
            base = Vector((math.sin(a) * 3.55, math.cos(a) * 3.55, z))
            out = Vector((math.sin(a) * 5.1, math.cos(a) * 5.1 - 0.5, z - 0.4))
            tip = out + Vector((0, -0.7, -1.4))
            mb.cyl(base, out, 0.32, 0.24, segs=6, mat='WormRust')
            mb.cyl(out, tip, 0.26, 0.0, segs=6, mat='WormSteel')
    # Glowing vents on the sides: three slats each.
    for s in (-1, 1):
        for j in range(3):
            m = T(s * 3.7, 0.9 - j * 0.6, -0.35) @ Ry(s * PI / 2)
            mb.box((0, 0, 0), (0.75, 0.09, 0.08), 'WormGlow', m)
        mb.box((s * 3.62, 0.3, -0.35), (0.12, 1.0, 0.9), 'WormDark')
    return finish(mb, 'Worm_Segment')


def build_head():
    mb = MB()
    n = 18
    # Collar: from the neck flaring forward to the rim; then the lip turns in and the throat runs back.
    outer = [(-2.6, 3.5), (-1.6, 3.85), (0.0, 4.15), (1.4, 4.45), (2.0, 4.6), (2.25, 4.5)]
    inner = [(2.3, 3.75), (1.8, 3.35), (0.6, 2.75), (-0.6, 2.05), (-1.3, 1.4)]
    rings = [ring(z, r, n, PI / n) for z, r in outer + inner]

    def mat(i, k):
        if i < 3:
            return 'WormIron' if k % 3 else 'WormRust'
        if i < 5:
            return 'WormSteel'
        if i == 5:
            return 'WormSteel'
        return 'WormDark'

    mb.loft(rings, 'WormIron', matfn=mat, cap0=True)
    # The glow deep in the throat.
    mb.loft([ring(-1.25, 1.35, n), ring(-1.25, 0.01, n)], 'WormGlow')
    # Armour plates over the collar: overlapping scales, and steel bolts.
    for k in range(6):
        a = 2 * PI * (k + 0.5) / 6
        mb.push(Rz(-a))
        mb.box((0, 4.05, -0.6), (1.3, 0.2, 1.5), 'WormCeramic' if k in (0, 5) else 'WormIron', Rx(-0.17))
        mb.cyl((0, 4.35, -1.5), (0, 4.55, -1.5), 0.22, 0.18, segs=6, mat='WormSteel')
        mb.pop()
    # A ring of small lamps round the neck.
    for k in range(8):
        a = 2 * PI * (k + 0.25) / 8
        p = Vector((math.sin(a) * 3.75, math.cos(a) * 3.75, -2.0))
        mb.cyl(p, p * 1.03 + Vector((0, 0, -0.1)), 0.2, 0.2, segs=6, mat='WormGlow')
    # Hinge blocks for the three jaws on the rim.
    for k in range(3):
        mb.push(Rz(-2 * PI * k / 3))
        mb.box((0, 4.45, 1.75), (1.1, 0.35, 0.55), 'WormSteel')
        mb.cyl((-1.2, 4.3, 2.0), (1.2, 4.3, 2.0), 0.32, segs=8, mat='WormDark')
        mb.pop()
    return finish(mb, 'Worm_Head')


def build_grinder():
    mb = MB()
    # Rings of teeth pointing in towards the axis and forward, on steel hoops; three hoops down the throat.
    for z, r, n, l in ((1.7, 3.45, 16, 1.5), (0.7, 2.75, 13, 1.2), (-0.3, 2.05, 10, 0.9)):
        mb.loft([ring(z - 0.15, r + 0.05, n * 2), ring(z + 0.15, r + 0.05, n * 2)], 'WormSteel', closed=True)
        for k in range(n):
            a = 2 * PI * (k + (0.5 if z < 1 else 0)) / n
            base = Vector((math.sin(a) * r, math.cos(a) * r, z))
            tip = Vector((math.sin(a + 0.25) * (r - l), math.cos(a + 0.25) * (r - l), z + l * 0.45))
            mb.cyl(base, tip, 0.3, 0.0, segs=4, mat='WormSteel' if k % 2 else 'WormIron')
    return finish(mb, 'Worm_Grinder')


def build_jaw():
    """The top petal, in its own frame: origin at the hinge (0, 4.3, 2.0 on the head), closed pose."""
    mb = MB()
    # A curved shell spanning ~110 degrees of the rim at its root, narrowing to a hooked point ahead of the maw.
    rows = 7
    cols = 7
    pts = []
    for i in range(rows + 1):
        t = i / rows
        z = 2.0 + t * 4.4                      # forward from the rim (head frame)
        rr = 4.45 * (1 - t) ** 0.9 + 0.35 * t  # radius from the axis, closing in
        half = math.radians(56) * (1 - 0.85 * t)
        row = []
        for j in range(cols + 1):
            a = -half + 2 * half * j / cols
            bulge = 0.35 * math.sin(PI * t) * math.cos(a / max(half, 1e-3) * PI / 2)
            row.append((math.sin(a) * (rr + bulge), math.cos(a) * (rr + bulge), z))
        pts.append(row)
    hx, hy, hz = HINGE
    mb.push(T(-hx, -hy, -hz))
    outer = [[mb.V(p) for p in row] for row in pts]
    inner = [[mb.V((p[0] * 0.9, p[1] * 0.9 - 0.15, p[2] - 0.2)) for p in row] for row in pts]
    for i in range(rows):
        for j in range(cols):
            m = 'WormSteel' if i >= rows - 2 else 'WormCeramic' if j in (cols // 2 - 1, cols // 2) else 'WormRust' if i == 0 else 'WormIron'
            mb.F([outer[i][j], outer[i][j + 1], outer[i + 1][j + 1], outer[i + 1][j]], m)
            mb.F([inner[i][j], inner[i + 1][j], inner[i + 1][j + 1], inner[i][j + 1]], 'WormDark')
    for i in range(rows):
        for j in (0, cols):
            mb.F([outer[i][j], outer[i + 1][j], inner[i + 1][j], inner[i][j]], 'WormSteel')
    for j in range(cols):
        mb.F([outer[0][j], inner[0][j], inner[0][j + 1], outer[0][j + 1]], 'WormSteel')
        mb.F([outer[rows][j], outer[rows][j + 1], inner[rows][j + 1], inner[rows][j]], 'WormSteel')
    # Teeth along the inside edges of the petal.
    for i in range(1, rows):
        for j in (0, cols):
            p = Vector(pts[i][j]) * 0.92
            q = p + Vector((0, -0.9, 0.3))
            q.x += -0.5 if j == cols else 0.5
            mb.cyl(p, q, 0.22, 0.0, segs=4, mat='WormSteel')
    # A rib down the spine.
    for i in range(rows - 1):
        a, b = Vector(pts[i][cols // 2]), Vector(pts[i + 1][cols // 2])
        mb.cyl(a * 1.04, b * 1.04, 0.28, 0.24, segs=6, mat='WormSteel')
    mb.pop()
    return finish(mb, 'Worm_Jaw')


def build_tail():
    mb = MB()
    mb.loft([ring(0.4, 1.7, 10), ring(-1.0, 1.6, 10), ring(-3.0, 1.0, 10), ring(-5.0, 0.35, 10)], 'WormIron', matfn=lambda i, k: 'WormRust' if k % 2 else 'WormIron', cap0=True)
    mb.cyl((0, 0, -5.0), (0, 0, -7.2), 0.35, 0.0, segs=8, mat='WormSteel')
    for k in range(3):
        mb.push(Rz(-2 * PI * k / 3))
        mb.box((0, 1.5, -2.6), (0.12, 0.7, 1.6), 'WormSteel', Rx(0.25))
        mb.pop()
    return finish(mb, 'Worm_Tail')


# ================================================================================================= preview

def place(src, M3):
    o = src.copy()
    o.hide_render = False
    bpy.context.scene.collection.objects.link(o)
    o.matrix_world = C @ M3 @ C.inverted()
    return o


def render_previews(parts, out_dir, open_jaw):
    os.makedirs(out_dir, exist_ok=True)
    scene = bpy.context.scene
    for engine in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x, scene.render.resolution_y = 1400, 900
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
    sun.rotation_euler = (math.radians(90 - 16), 0, math.radians(-140))
    scene.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.clip_end = 3000

    # The body along an arch out of the sand, the head coming down at the far end; positions by arc length back
    # from the head, like the game.
    pts = [Vector((math.sin(u * 3) * 5, 42 * math.sin(PI * u * 0.86), -45 + 80 * u)) for u in (i / 600 for i in range(601))]
    pts.reverse()

    def path(s):
        acc = 0.0
        for i in range(len(pts) - 1):
            d = (pts[i + 1] - pts[i]).length
            if acc + d >= s:
                return pts[i].lerp(pts[i + 1], (s - acc) / d)
            acc += d
        return pts[-1]

    def frame(p, ahead):
        d = (ahead - p).normalized()
        return aim(p, d)

    segs = 22
    taper = 7
    head_p = path(0)
    head_M = frame(head_p, head_p + (head_p - path(1.0)))
    place(parts['Worm_Head'], head_M)
    place(parts['Worm_Grinder'], head_M @ Rz(0.3))
    for k in range(3):
        a = 2 * PI * k / 3
        place(parts['Worm_Jaw'], head_M @ Rz(a) @ T(*HINGE) @ Rx(-math.radians(62) if open_jaw else 0))
    for i in range(segs):
        s = (i + 1) * SEG_LEN
        p, q = path(s), path(s - 1.0)
        kk = i - (segs - taper)
        sc = 1 if kk < 0 else 1 - 0.6 * ((kk + 1) / taper)
        M = frame(p, q) @ Rz(i * 0.21) @ Matrix.Diagonal((sc, sc, 1, 1))
        place(parts['Worm_Segment'], M)
        last = (p, q, sc)
    p, q, sc = last
    d = (q - p).normalized()
    place(parts['Worm_Tail'], aim(p - d * SEG_LEN * 0.5, d) @ Matrix.Diagonal((sc, sc, sc, 1)))
    # A person for scale beside the hole.
    bpy.ops.mesh.primitive_cube_add(size=1)
    human = bpy.context.active_object
    human.scale = (0.5, 0.35, 1.8)
    human.location = C @ Vector((9, 0.9, 20))

    def look(pos, target, lens, name):
        p = C @ Vector(pos)
        t = C @ Vector(target)
        cam.location = p
        cam.rotation_euler = (t - p).to_track_quat('-Z', 'Y').to_euler()
        cam.data.lens = lens
        scene.render.filepath = os.path.join(out_dir, name)
        bpy.ops.render.render(write_still=True)

    look((95, 14, 60), (0, 20, 5), 26, 'worm_side.png')
    look(head_p + Vector((14, 4, 22)), head_p, 30, 'worm_head.png')
    look((-30, 50, -40), (0, 15, 10), 24, 'worm_back.png')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--preview', default=None)
    ap.add_argument('--open', action='store_true')
    args = ap.parse_args(argv)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in MATERIALS.items():
        make_material(name, *spec)
    parts = {o.name: o for o in (build_segment(), build_head(), build_grinder(), build_jaw(), build_tail())}
    for name, o in parts.items():
        print(f'{name}: {sum(len(p.vertices) - 2 for p in o.data.polygons)} triangles')
    out = os.path.join(ROOT, 'public', 'models', 'worm.glb')
    bpy.ops.object.select_all(action='DESELECT')
    for o in parts.values():
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts['Worm_Head']
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_yup=True, export_apply=True,
                              export_materials='EXPORT', export_normals=True, export_texcoords=False)
    print('wrote', out)
    if args.preview:
        render_previews(parts, args.preview, args.open)


main()
