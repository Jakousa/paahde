"""The harvester (shared/harvester.ts): a tracked sand crawler the size of a building, exported as a glTF binary.

    tools/blender/run.sh -b --python tools/blender/harvester.py                     # writes public/models/harvester.glb
    tools/blender/run.sh -b --python tools/blender/harvester.py -- --preview <dir>  # also renders PNG previews

All coordinates are three.js (Y up, +Z forward = the maw, +X its left side), built in three.js space and turned into
Blender's Z-up frame just before export (as tools/blender/jet.py does). The origin is on the sand under the middle
of the four track units (shared/harvester.ts: TRACK 21 apart across, WHEELBASE 18 along). It is one monolith: a
single low slab-sided wedge 28 m wide, 54 m from the stern to the lip of its maw and 14.5 m high, its back running
down in one long rake to the hood over the maw, its full-length skirts hiding all but the bottom of its treads. Every detail on it is small (hand-sized grilles, ladders, rails, lamps,
hairline seams), so the eye reads the bulk by them.

  Harvester_Hull     everything that doesn't move: the hull, the hood over the maw, its cheeks, the throat with the
                     cores' sockets, skirts, keel, wheels, grilles, rails, ladders, hatches, seams
  Harvester_Drum     the cutter drum in the maw, about its axle (local X) at DRUM
  Harvester_Core0..3 the four glowing intake cores in the throat behind the drum (emissive; the game darkens the
                     dead ones): its only weak points (shared/harvester.ts CORES)
  Harvester_Lamps    the small red lamps on its hood, cheeks and flanks (emissive)
  Harvester_Link     one track shoe (grouser on +Y): the game lays LINKS round each track unit's loop and runs them

Materials are flat Principled BSDF colours (no textures). Units are metres. Deterministic.
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
    'HarvIron': (0x2a2420, 0.6, 0.62, None),     # rust-black slab iron
    'HarvDeck': (0x3a2c22, 0.5, 0.7, None),      # the top, sand-scoured lighter
    'HarvRust': (0x5a2c18, 0.45, 0.75, None),    # undersides, keel, ribs
    'HarvDark': (0x100c0a, 0.3, 0.8, None),      # seams, throat, grille recesses, wheels
    'HarvSteel': (0x6a6158, 0.8, 0.4, None),     # worn steel: treads, teeth, rails, ladders, slats
    'HarvSand': (0x9a6a3c, 0.0, 0.95, None),     # caked sand
    'HarvHazard': (0xb08a3a, 0.2, 0.6, None),    # faded yellow-ochre bands on the cheeks
    'HarvVent': (0xff5a10, 0.0, 0.5, 1.6),       # the faint glow deep in a few of the grilles
    'HarvCore': (0xffc070, 0.0, 0.3, 16.0),       # the intake cores (src/world/harvesters.ts darkens dead ones)
    'HarvLamp': (0xff2a12, 0.0, 0.3, 8.0),       # the small lamps, red
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

    def cyl(self, a, b, r1, r2=None, segs=8, mat='HarvIron', cap0=True, cap1=True, phase=0.0, matfn=None):
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

    def cable(self, a, b, sag, r, mat='HarvDark', n=6, segs=5):
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


# ================================================================================================= harvester

# keep in step with shared/harvester.ts and src/world/harvesters.ts
TRACK_X = 10.5         # TRACK / 2
TRACK_Z = 9.0          # WHEELBASE / 2 (the front units end just behind the throat)
TRACK_W = 5.0
LOOP_HALF = 4.6        # straight run half length between the end wheels' centres
LOOP_R = 2.4           # end wheel radius to the belt's centre line
LOOP_Y = 2.6           # end wheels' axle height
DRUM = (0, 1.9, 25.6)  # its teeth's tips reach just under the sand
DRUM_R = 2.1
CORES = [(-9.0, 5.6, 17.7), (-3.0, 5.6, 17.7), (3.0, 5.6, 17.7), (9.0, 5.6, 17.7)]
THROAT = 16.6          # the throat wall's z: the back of the maw
BOW = 28.6             # the lip of the maw
CORE_HALF = 1.6
HW, HWT = 14.0, 11.2   # half width at the sides, at the top edges
MAW_X = 12.0           # the cheeks' inner faces: the maw is this wide either side of the middle
HOOD = 7.8             # the hood's underside: the top of the maw
BOT, TOP = 5.6, 14.5
MID = BOT + (TOP - BOT) * 0.45  # where the upright flanks give way to the slope (ring)
RAKE = 4.0             # the back starts running down to the hood here
HOOD_TOP = 12.0        # the top at the throat, running on down to LIP at the hood's front
LIP = 9.4
# keep in step with src/world/harvesters.ts EXHAUSTS / CHUTE
EXHAUSTS = [(-7.5, -19.5), (-4.0, -19.5), (4.0, -19.5), (7.5, -19.5)]
CHUTE = (0, 6.2, -25.6)


def ring(z, bot, top, hwb, hwt, ch=0.9, c=0.5):
    """The hull's section at z: upright sides to `mid`, sloping in to the top edges, chamfered. Faces of a loft:
    0 lower +X side, 1 its upper slope, 3 top, 5 upper -X slope, 6 lower -X side, 8 bottom, others chamfers."""
    mid = bot + (top - bot) * 0.45
    return [(hwb, bot + c, z), (hwb, mid, z), (hwt, top - ch, z), (hwt - ch, top, z), (-hwt + ch, top, z),
            (-hwt, top - ch, z), (-hwb, mid, z), (-hwb, bot + c, z), (-hwb + c, bot, z), (hwb - c, bot, z)]


def hull_mat(i, k):
    if k in (7, 8, 9):
        return 'HarvRust'
    return 'HarvDeck' if k == 3 else 'HarvIron'


def grille(mb, x, y, z, w, h, glow=False):
    """A small louvered grille on a flank at local x (its outward sign), w long along Z and h high."""
    s = 1 if x > 0 else -1
    mb.box((x - s * 0.02, y, z), (0.08, h, w), 'HarvVent' if glow else 'HarvDark')
    n = max(2, int(h / 0.16))
    for k in range(n):
        yy = y - h / 2 + (k + 0.5) * h / n
        mb.box((x + s * 0.03, yy, z), (0.08, 0.04, w - 0.06), 'HarvSteel', rot=(0, 0, -0.5 * s))
    for dz in (-w / 2, w / 2):
        mb.box((x + s * 0.04, y, z + dz), (0.06, h + 0.06, 0.05), 'HarvSteel')


def ladder(mb, x, z, y0, y1, along_x=False):
    """A ladder 0.45 m wide on a face at x (or, along_x, on the stern at z), rungs every 0.3 m."""
    s = 1 if (z if along_x else x) > 0 else -1
    n = int((y1 - y0) / 0.3)
    for k in range(n + 1):
        y = y0 + k * 0.3
        if along_x:
            mb.box((x, y, z + s * 0.18), (0.45, 0.035, 0.035), 'HarvSteel')
        else:
            mb.box((x + s * 0.18, y, z), (0.035, 0.035, 0.45), 'HarvSteel')
    for d in (-0.24, 0.24):
        if along_x:
            mb.box((x + d, (y0 + y1) / 2, z + s * 0.12), (0.04, y1 - y0, 0.04), 'HarvSteel')
        else:
            mb.box((x + s * 0.12, (y0 + y1) / 2, z + d), (0.04, y1 - y0, 0.04), 'HarvSteel')


def build_hull():
    mb = MB()
    # --- the monolith: one loft from the bevelled stern to the start of the front slope, then the hood over the maw.
    sections = [
        (-25.4, 7.2, 12.0, HW - 0.6, HWT - 0.7),
        (-24.4, BOT, 13.4, HW, HWT),
        (-21.4, BOT, TOP, HW, HWT),
        (RAKE, BOT, TOP, HW, HWT),
        (THROAT, BOT, HOOD_TOP, HW, HWT),
    ]
    mb.loft([ring(*sec) for sec in sections], 'HarvIron', cap0=True, cap1=True, matfn=hull_mat, capmat='HarvDark')
    mb.loft([ring(THROAT - 0.1, HOOD, HOOD_TOP, HW, HWT), ring(BOW - 0.2, HOOD + 0.2, LIP, HW - 0.2, HWT + 0.3, ch=0.5, c=0.3)],
            'HarvIron', cap1=True, matfn=hull_mat, capmat='HarvIron')
    # The maw's cheeks, flush with the flanks, and the throat behind the drum.
    for s in (1, -1):
        cx = s * (MAW_X + HW) / 2
        mb.prism_x([(0.6, THROAT), (0.6, BOW - 1.2), (1.4, BOW), (HOOD + 0.4, BOW), (HOOD + 0.4, THROAT)], s * MAW_X, s * HW, 'HarvIron')
        for i in range(4):  # hazard bands on the cheek's front face
            mb.box((cx, 1.3 + i * 0.7, BOW + 0.01), (HW - MAW_X - 0.1, 0.3, 0.02), 'HarvHazard')
        mb.box((cx, 0.9, (THROAT + BOW) / 2), (HW - MAW_X + 0.06, 0.5, BOW - THROAT - 0.8), 'HarvSteel')  # wear strip
        # ribs down the cheeks' inner faces, lit by the cores
        for z in (THROAT + (BOW - THROAT) * k / 4 for k in (1, 2, 3)):
            mb.box((s * (MAW_X - 0.08), (0.6 + HOOD) / 2, z), (0.16, HOOD - 0.8, 0.3), 'HarvRust')
    mb.box((0, (0.6 + HOOD) / 2, THROAT), (2 * MAW_X, HOOD - 0.4, 0.3), 'HarvDark')
    for x in [i * 1.2 - (MAW_X - 0.6) for i in range(int((2 * MAW_X - 1.2) / 1.2) + 1)]:  # intake bars up the throat
        if all(abs(x - c[0]) > CORE_HALF + 0.4 for c in CORES):
            mb.box((x, (0.6 + HOOD) / 2, THROAT + 0.2), (0.12, HOOD - 0.6, 0.12), 'HarvSteel')
    for cx, cy, cz in CORES:  # the cores' sockets
        # a hex housing standing out of the throat wall, the core set in its face
        mb.cyl((cx, cy, THROAT + 0.1), (cx, cy, cz + 0.05), CORE_HALF + 0.4, segs=6, mat='HarvSteel', phase=PI / 6)
        mb.cyl((cx, cy, THROAT + 0.15), (cx, cy, cz + 0.1), CORE_HALF + 0.12, segs=6, mat='HarvDark', phase=PI / 6)
    # --- skirts down the whole length of both sides, the keel between the tracks, the wheels under them.
    for s in (1, -1):
        mb.prism_x([(1.6, -23.4), (1.6, THROAT - 0.6), (2.4, THROAT), (6.0, THROAT), (6.0, -24.6), (2.4, -24.6)],
                   s * (HW - 0.15), s * (HW + 0.2), 'HarvIron')
        mb.box((s * (HW + 0.2), 1.75, (THROAT - 0.6 - 23.6) / 2), (0.06, 0.3, THROAT - 0.6 + 23.6), 'HarvSand')
        for z in range(-21, int(THROAT), 6):
            mb.box((s * (HW + 0.21), 3.9, z), (0.02, 4.2, 0.05), 'HarvDark')
    mb.box((0, 4.0, (THROAT - 0.6 - 23.2) / 2), (15.0, 3.4, THROAT - 0.6 + 23.2), 'HarvRust')
    for sx in (1, -1):
        for sz in (1, -1):
            cx, cz = sx * TRACK_X, sz * TRACK_Z
            for ez in (cz - LOOP_HALF, cz + LOOP_HALF):
                mb.cyl((cx - 2.2, LOOP_Y, ez), (cx + 2.2, LOOP_Y, ez), 2.1, segs=14, mat='HarvSteel', phase=0.2)
                mb.cyl((cx - 2.3, LOOP_Y, ez), (cx + 2.3, LOOP_Y, ez), 0.7, segs=8, mat='HarvDark')
            for rz in (-2.9, -1.0, 1.0, 2.9):
                mb.cyl((cx - 2.0, 1.15, cz + rz), (cx + 2.0, 1.15, cz + rz), 0.85, segs=10, mat='HarvDark')
            mb.box((cx, 5.0, cz), (4.0, 1.4, 9.0), 'HarvRust')

    # --- small details: they tell its size.
    for s in (1, -1):
        x = s * (HW + 0.01)
        # a row of louvered grilles high on each flank, every third one glowing faintly deep inside
        for i, z in enumerate(range(-21, 14, 3)):
            grille(mb, x, MID - 1.2, z + 0.5, 1.1, 0.6, glow=(i % 3 == 1))
        # little vents low down in threes
        for z0 in (-16, -4, 8):
            for k in range(3):
                grille(mb, x, 6.9, z0 + k * 0.7, 0.45, 0.35)
        # hairline seams: plates 6 m long, a belt line under the slope
        for z in range(-21, 18, 6):
            mb.box((x, (BOT + MID) / 2, z + 1.5), (0.02, MID - BOT - 0.2, 0.05), 'HarvDark')
        mb.box((x, MID - 0.1, -3.0), (0.02, 0.06, 43.0), 'HarvDark')
        # a ladder up the flank near the stern, rails along the top edges as far as the rake
        ladder(mb, s * (HW + 0.02), -22.6, 1.7, MID)
        for z in range(-21, int(RAKE), 2):
            mb.cyl((s * (HWT - 0.3), TOP, z), (s * (HWT - 0.3), TOP + 1.05, z), 0.035, segs=4, mat='HarvSteel')
        mb.sweep([(s * (HWT - 0.3), TOP + 1.05, -21), (s * (HWT - 0.3), TOP + 1.05, 3)], 0.035, 'HarvSteel', segs=4)
        mb.sweep([(s * (HWT - 0.3), TOP + 0.55, -21), (s * (HWT - 0.3), TOP + 0.55, 3)], 0.03, 'HarvSteel', segs=4)
    # The top: hairline seams across, flush exhaust grilles at the back, a couple of hatches, a whip antenna or two.
    for z in range(-21, int(RAKE), 6):
        mb.box((0, TOP + 0.005, z), (2 * (HWT - 1), 0.02, 0.05), 'HarvDark')
    mb.box((0, TOP + 0.005, (RAKE - 22) / 2), (0.05, 0.02, RAKE + 22), 'HarvDark')
    for x, z in EXHAUSTS:
        mb.box((x, TOP + 0.03, z), (1.6, 0.06, 1.0), 'HarvDark')
        for k in range(5):
            mb.box((x, TOP + 0.07, z - 0.4 + k * 0.2), (1.6, 0.04, 0.04), 'HarvSteel')
    for x, z in ((-4.0, -8.0), (5.0, -1.0)):
        mb.box((x, TOP + 0.1, z), (1.2, 0.2, 1.2), 'HarvIron')
        mb.box((x + 0.45, TOP + 0.26, z), (0.08, 0.12, 0.6), 'HarvSteel')
    for x, z, h in ((-10.2, -21.0, 4.0), (-9.6, -21.0, 2.6)):
        mb.cyl((x, TOP, z), (x, TOP + h, z), 0.03, segs=4, mat='HarvSteel')
    # The stern: the slot it lets the sifted sand out of, ladder, seams.
    cx, cy, cz = CHUTE
    mb.box((cx, cy, -25.42), (8.0, 0.6, 0.1), 'HarvDark')
    mb.box((cx, cy - 0.4, -25.5), (8.4, 0.12, 0.3), 'HarvSteel')
    ladder(mb, 6.5, -25.43, 7.6, 11.8, along_x=True)
    for x in (-8, -3, 3, 8):
        mb.box((x, 9.8, -25.41), (0.05, 4.4, 0.02), 'HarvDark')
    return finish(mb, 'Harvester_Hull')


def build_drum():
    """The cutter drum in the maw, about its axle (local X): a core with helical rows of small teeth from both ends."""
    mb = MB()
    w = MAW_X - 0.4
    mb.cyl((-w, 0, 0), (w, 0, 0), DRUM_R - 0.7, segs=16, mat='HarvRust')
    for x in (-w, 0, w):
        mb.cyl((x - 0.12, 0, 0), (x + 0.12, 0, 0), DRUM_R - 0.4, segs=16, mat='HarvSteel')
    n = 30
    for k in range(n):
        x = -(w - 0.4) + k * (2 * (w - 0.4) / (n - 1))
        for j in range(6):
            a = j * (2 * PI / 6) + (abs(x) * 0.35) * (1 if x > 0 else -1)
            d = Vector((0, math.cos(a), math.sin(a)))
            p = d * (DRUM_R - 0.75)
            tip = d * DRUM_R + Vector((0, -math.sin(a), math.cos(a))) * 0.3
            mb.cyl((x, p.y, p.z), (x, tip.y, tip.z), 0.14, 0.0, segs=4, mat='HarvSteel')
    return finish(mb, 'Harvester_Drum', DRUM)


def build_cores():
    out = []
    for i, c in enumerate(CORES):
        mb = MB()
        mb.cyl((0, 0, -0.2), (0, 0, 0.15), CORE_HALF, segs=6, mat='HarvCore', phase=PI / 6)
        out.append(finish(mb, f'Harvester_Core{i}', c))
    return out


def build_lamps():
    mb = MB()
    for s in (1, -1):
        mb.box((s * (MAW_X + HW) / 2, HOOD + 0.55, BOW - 0.2), (0.35, 0.22, 0.25), 'HarvLamp')
        mb.box((s * 6.5, HOOD + 1.1, BOW - 0.12), (0.3, 0.18, 0.2), 'HarvLamp')
        mb.box((s * (HW + 0.06), MID - 0.6, 14.0), (0.1, 0.18, 0.3), 'HarvLamp')
    return finish(mb, 'Harvester_Lamps')


def build_link():
    """One track shoe, centred, its grouser on +Y (the side out against the sand), running along Z."""
    mb = MB()
    mb.box((0, 0, 0), (TRACK_W, 0.28, 0.76), 'HarvSteel')
    mb.box((0, 0.22, -0.14), (TRACK_W, 0.18, 0.16), 'HarvSteel')
    for x in (-0.8, 0.8):
        mb.box((x, -0.28, 0), (0.2, 0.32, 0.44), 'HarvSteel')
    return finish(mb, 'Harvester_Link')


def loop_at(d):
    """Along a track loop d m from the bottom run's rear end, going forward: (y, z) of the belt's centre line and the
    shoe's turn about X (π on the bottom run, its grouser down; 0 on the top)."""
    L = 2 * LOOP_HALF
    a = PI * LOOP_R
    d %= 2 * L + 2 * a
    if d < L:
        return (LOOP_Y - LOOP_R, -LOOP_HALF + d), PI
    d -= L
    if d < a:
        t = d / LOOP_R
        return (LOOP_Y - LOOP_R * math.cos(t), LOOP_HALF + LOOP_R * math.sin(t)), PI - t
    d -= a
    if d < L:
        return (LOOP_Y + LOOP_R, LOOP_HALF - d), 0.0
    d -= L
    t = d / LOOP_R
    return (LOOP_Y + LOOP_R * math.cos(t), -LOOP_HALF - LOOP_R * math.sin(t)), -t


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
    world = scene.world or bpy.data.worlds.new('world')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (*lin(0xe07b28), 1)
    bg.inputs['Strength'].default_value = 0.6
    sd = bpy.data.lights.new('sun', 'SUN')
    sd.energy = 4.0
    sd.color = (1.0, 0.72, 0.45)
    sun = bpy.data.objects.new('sun', sd)
    sun.rotation_euler = (math.radians(90 - 18), 0, math.radians(-130))
    scene.collection.objects.link(sun)
    bpy.ops.mesh.primitive_plane_add(size=800, location=(0, 0, 0))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new('ground')
    gm.use_nodes = True
    gm.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (*lin(0xc46a24), 1)
    gm.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value = 1.0
    ground.data.materials.append(gm)
    link = bpy.data.objects['Harvester_Link']
    loop = 2 * (2 * LOOP_HALF) + 2 * PI * LOOP_R
    n = 40
    for sx in (1, -1):
        for sz in (1, -1):
            for k in range(n):
                p, ang = loop_at(k * loop / n)
                o = link.copy()
                scene.collection.objects.link(o)
                o.matrix_world = C @ T(sx * TRACK_X, p[0], sz * TRACK_Z + p[1]) @ Rx(ang)
    link.hide_render = True
    # a person for scale, 1.8 m, in front of it
    bpy.ops.mesh.primitive_cylinder_add(radius=0.25, depth=1.8, location=tuple(C @ Vector((3, 0.9, 34))))
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

    look((60, 8, 75), (0, 9, 0), 30, 'harvester_34.png')
    look((0, 1.7, 75), (0, 8, 20), 32, 'harvester_front.png')
    look((4, 1.7, 40), (0, 6, 22), 26, 'harvester_maw.png')
    look((80, 10, -6), (0, 9, -2), 30, 'harvester_side.png')
    look((-50, 30, -70), (0, 9, 0), 30, 'harvester_rear34.png')
    look((14.5, 12, -18), (12.2, 10, -8), 30, 'harvester_detail.png')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--preview', default=None)
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models'))
    args = ap.parse_args(argv)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in MATERIALS.items():
        make_material(name, *spec)
    objs = [build_hull(), build_drum(), *build_cores(), build_lamps(), build_link()]
    os.makedirs(args.out, exist_ok=True)
    export_glb(objs, os.path.join(args.out, 'harvester.glb'))
    for o in objs:
        print(f'{o.name}: tris={tri_count(o)}')
    if args.preview:
        render_previews(objs, os.path.abspath(args.preview))


main()
