"""The harvester (shared/harvester.ts): a tracked sand crawler the size of a building, exported as a glTF binary.

    tools/blender/run.sh -b --python tools/blender/harvester.py                     # writes public/models/harvester.glb
    tools/blender/run.sh -b --python tools/blender/harvester.py -- --preview <dir>  # also renders PNG previews

All coordinates are three.js (Y up, +Z forward = the maw, +X its left side), built in three.js space and turned into
Blender's Z-up frame just before export (as tools/blender/machines/plane.py does). The origin is on the sand under the middle
of the four track units (shared/harvester.ts: TRACK 12 apart across, WHEELBASE 18 along); it is 15 m wide, 34 m from
the stern to the drum's cheeks and 19.5 m to the top of its stacks. Monolithic on purpose: big flat slabs of
rust-black iron, few openings, the scale told by the deck rails, the ladder and the hazard bands on the maw.

  Harvester_Hull     everything that doesn't move: the slab hull with its glacis and keel, four armoured track
                     units (fenders, skirts, wheels, bogies), the maw's cheeks and hood, the ore hopper heaped with
                     ore, the sieve tower with the eye's brow, the bucket elevator, the stacks, the stern chute
  Harvester_Drum     the cutter drum in the maw, about its axle (local X) at DRUM
  Harvester_Turret   the turret on the tower, turning about its pivot (TURRET)
  Harvester_Guns     its twin barrels along +Z, pitching about the same pivot
  Harvester_Eye      the slit eye across the tower's face (emissive; the game recolours it)
  Harvester_Vent0..3 the four glowing heat vents on its flanks (emissive; the game darkens the dead ones)
  Harvester_Link     one track shoe (grouser on +Y): the game lays 30 round each track unit's loop and runs them

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
    'HarvDeck': (0x3a2c22, 0.5, 0.7, None),      # the decks, sand-scoured lighter
    'HarvRust': (0x5a2c18, 0.45, 0.75, None),    # undersides, ribs, bogies
    'HarvDark': (0x100c0a, 0.3, 0.8, None),      # seams, throat, grilles, wheels
    'HarvSteel': (0x6a6158, 0.8, 0.4, None),     # worn steel: treads, teeth, rails
    'HarvBurnt': (0x1c1612, 0.5, 0.6, None),     # soot on stack tops and above the vents
    'HarvSand': (0x9a6a3c, 0.0, 0.95, None),     # caked sand
    'HarvOre': (0x4f6a62, 0.7, 0.35, None),      # a glint of the ore it sifts out
    'HarvHazard': (0xb08a3a, 0.2, 0.6, None),    # faded yellow-ochre bands on the maw
    'HarvEye': (0xffb040, 0.0, 0.4, 10.0),       # the slit eye (src/world/harvesters.ts tints it red when it hunts)
    'HarvVent': (0xff5a10, 0.0, 0.5, 3.5),       # heat vents' glow
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

# keep in step with shared/harvester.ts
TRACK_X = 6.0          # TRACK / 2
TRACK_Z = 9.0          # WHEELBASE / 2
TRACK_W = 3.4
LOOP_HALF = 3.2        # straight run half length between the end wheels' centres
LOOP_R = 1.8           # end wheel radius to the belt's centre line
LOOP_Y = 1.98          # end wheels' axle height
DRUM = (0, 1.9, 16.2)
DRUM_R = 1.6
TURRET = (0, 18.6, -5)
BARREL = 4.2
EYE = (0, 15.4, 1.1)
VENTS = [(7.65, 7.4, 5.5), (7.65, 7.4, -6.5), (-7.65, 7.4, 5.5), (-7.65, 7.4, -6.5)]
VENT_HZ, VENT_HY = 2.1, 1.3
# keep in step with src/world/harvesters.ts STACKS / CHUTE
STACKS = [(-5.4, -13.0), (-5.4, -10.6), (-5.4, -8.2)]
STACK_TOP = 21.0
CHUTE_END = (2.5, 5.0, -18.2)


def hull_mat(i, k):
    """oct_ring loft faces: the underside and its chamfers rust, the top the deck, the rest the iron."""
    if k in (1, 2, 3):
        return 'HarvRust'
    return 'HarvDeck' if k == 6 else 'HarvIron'


def build_hull():
    mb = MB()
    # --- the slab: lofted along Z, its glacis sloping down to the prow over the maw, a bevel at the stern.
    sections = [  # (z, top, bottom, half width, chamfer)
        (-15.5, 10.0, 5.4, 7.0, 0.9),
        (-14.8, 11.0, 4.8, 7.5, 1.2),
        (8.0, 11.0, 4.8, 7.5, 1.2),
        (14.0, 8.4, 4.8, 7.5, 1.0),
        (15.2, 7.4, 5.3, 7.2, 0.7),
    ]
    rings = [oct_ring(z, hw * 2, top - bot, ch, cy=(top + bot) / 2) for z, top, bot, hw, ch in sections]
    mb.loft(rings, 'HarvIron', cap0=True, cap1=True, matfn=hull_mat, capmat='HarvIron')
    # Belly keel between the tracks, a sieve grate under it.
    mb.box((0, 3.9, -0.5), (8.4, 2.2, 25), 'HarvRust')
    for z in range(-12, 12, 2):
        mb.box((0, 2.75, z), (7.6, 0.12, 0.35), 'HarvDark')
    # Seams down the flanks and a belt line along them, the hull plates' joins.
    for side in (1, -1):
        for z in (-11.5, -2.5, 1.5, 9.5):
            mb.box((side * 7.52, 7.9, z), (0.06, 6.0, 0.14), 'HarvDark')
        mb.box((side * 7.53, 9.6, -3.5), (0.08, 0.16, 22.6), 'HarvDark')
    # Armour ribs on the glacis.
    for x in (-5.2, -1.8, 1.8, 5.2):
        mb.beam((x, 11.05, 8.2), (x, 8.45, 14.0), 0.5, 0.35, 'HarvRust')
    # Deck edge rails: posts and a pipe along each side, ladder up the stern quarter (scale).
    for side in (1, -1):
        posts = [(side * 7.0, 11.0, z) for z in range(-14, 8, 3)]
        for x, y, z in posts:
            mb.cyl((x, y, z), (x, y + 1.1, z), 0.05, segs=5, mat='HarvSteel')
        mb.sweep([(side * 7.0, 12.1, -14), (side * 7.0, 12.1, 7)], 0.05, 'HarvSteel', segs=5)
    for i in range(26):
        y = 1.2 + i * 0.38
        mb.box((7.75, y, -13.4), (0.06, 0.06, 0.8), 'HarvSteel')
    for z in (-13.8, -13.0):
        mb.box((7.75, 6.1, z), (0.08, 9.8, 0.08), 'HarvSteel')

    # --- vent frames (the glowing grilles are Harvester_Vent0..3)
    for x, y, z in VENTS:
        s = 1 if x > 0 else -1
        mb.box((s * 7.45, y, z), (0.3, VENT_HY * 2 + 0.2, VENT_HZ * 2 + 0.2), 'HarvDark')
        for dy in (VENT_HY + 0.18, -VENT_HY - 0.18):
            mb.box((s * 7.62, y + dy, z), (0.34, 0.24, VENT_HZ * 2 + 0.6), 'HarvSteel')
        for dz in (VENT_HZ + 0.18, -VENT_HZ - 0.18):
            mb.box((s * 7.62, y, z + dz), (0.34, VENT_HY * 2 + 0.6, 0.24), 'HarvSteel')
        # heat scorch above it
        mb.box((s * 7.53, y + VENT_HY + 1.0, z), (0.04, 1.2, VENT_HZ * 2), 'HarvBurnt')

    # --- the track units: armoured fenders over the top run, a skirt plate down the outside, wheels under them,
    # a bogie block up into the hull.
    for sx in (1, -1):
        for sz in (1, -1):
            cx, cz = sx * TRACK_X, sz * TRACK_Z
            # fender: a chamfered box over the top run and the ends
            mb.loft([oct_ring(cz - 5.3, 3.9, 1.6, 0.5, cx=cx, cy=4.2), oct_ring(cz + 5.3, 3.9, 1.6, 0.5, cx=cx, cy=4.2)],
                    'HarvIron', cap0=True, cap1=True, matfn=lambda i, k: 'HarvRust' if k == 2 else 'HarvIron')
            # outer skirt plate, low, its ends cut back
            ox = cx + sx * 1.88
            mb.prism_x([(1.15, cz - 4.3), (1.15, cz + 4.3), (2.2, cz + 5.0), (4.9, cz + 5.0), (4.9, cz - 5.0), (2.2, cz - 5.0)],
                       ox - 0.14, ox + 0.14, 'HarvIron')
            for z in (cz - 2.6, cz, cz + 2.6):
                mb.box((ox + sx * 0.16, 3.0, z), (0.06, 3.2, 0.12), 'HarvDark')
            # caked sand along the skirt's foot
            mb.box((ox + sx * 0.02, 1.45, cz), (0.34, 0.6, 8.4), 'HarvSand')
            # inner skirt (towards the keel)
            ix = cx - sx * 1.88
            mb.prism_x([(1.4, cz - 4.3), (1.4, cz + 4.3), (2.4, cz + 5.0), (4.9, cz + 5.0), (4.9, cz - 5.0), (2.4, cz - 5.0)],
                       ix - 0.12, ix + 0.12, 'HarvRust')
            # end wheels (sprocket at the back unit's rear, idler elsewhere) and road wheels, along X
            for ez in (cz - LOOP_HALF, cz + LOOP_HALF):
                mb.cyl((cx - 1.5, LOOP_Y, ez), (cx + 1.5, LOOP_Y, ez), 1.55, segs=12, mat='HarvSteel', phase=0.26)
                mb.cyl((cx - 1.6, LOOP_Y, ez), (cx + 1.6, LOOP_Y, ez), 0.5, segs=8, mat='HarvDark')
            for rz in (-2.0, -0.7, 0.7, 2.0):
                mb.cyl((cx - 1.3, 0.95, cz + rz), (cx + 1.3, 0.95, cz + rz), 0.62, segs=10, mat='HarvDark')
            # bogie block up into the hull, a big hydraulic ram either side of it
            mb.box((cx, 5.4, cz), (2.6, 1.6, 3.6), 'HarvRust')
            for dz in (-2.6, 2.6):
                mb.cyl((cx - sx * 0.6, 4.3, cz + dz), (cx - sx * 0.6, 6.0, cz + dz * 0.8), 0.32, segs=8, mat='HarvSteel')

    # --- the maw: thick cheek plates either side of the drum, a hood over it sloping down to the prow, a dark throat.
    for s in (1, -1):
        mb.prism_x([(0.5, 12.5), (0.5, 17.6), (1.6, 18.6), (4.6, 18.6), (6.8, 15.2), (6.8, 12.5)], s * 6.3 - 0.6, s * 6.3 + 0.6, 'HarvIron')
        # hazard bands on the cheek's leading edge
        for i in range(3):
            mb.box((s * 6.3, 1.25 + i * 1.05, 18.62), (1.24, 0.5, 0.06), 'HarvHazard')
        # wear plate where the cheek meets the sand
        mb.box((s * 6.3, 0.75, 15.5), (1.3, 0.5, 6.0), 'HarvSteel')
    mb.prism_x([(4.4, 18.6), (4.9, 18.6), (7.4, 15.2), (7.4, 13.0), (6.6, 13.0)], -5.7, 5.7, 'HarvIron')
    mb.box((0, 3.2, 13.2), (11.4, 5.6, 0.6), 'HarvDark')  # throat
    # the ore elevator up from the throat: a sloped casing into the hull
    mb.beam((0, 2.0, 13.4), (0, 6.0, 11.0), 3.0, 1.6, 'HarvRust')

    # --- deck: the ore hopper, the sieve tower, the stacks, the chute out the stern.
    # Hopper: an open-topped bin with ribs, ore heaped in it.
    hb, ht = 11.0, 12.9
    for s in (1, -1):
        mb.box((s * 5.6, (hb + ht) / 2, 6.0), (0.4, ht - hb, 6.6), 'HarvIron')
        for z in (3.4, 6.0, 8.6):
            mb.box((s * 5.86, (hb + ht) / 2, z), (0.16, ht - hb, 0.3), 'HarvRust')
    for z in (2.7, 9.3):
        mb.box((0, (hb + ht) / 2, z), (11.6, ht - hb, 0.4), 'HarvIron')
    mb.box((0, ht + 0.08, 2.7), (11.8, 0.16, 0.6), 'HarvSteel')
    mb.box((0, ht + 0.08, 9.3), (11.8, 0.16, 0.6), 'HarvSteel')
    rng = Rng(7)
    ore = []
    for i in range(9):
        for j in range(6):
            x = -4.6 + i * 1.15
            z = 3.6 + j * 1.0
            ore.append((x, z, 12.25 + 0.3 * math.sin(i * 0.9) * math.cos(j * 1.1) + rng(-0.1, 0.1)))
    for x, z, y in ore:
        mb.box((x, y, z), (1.1, 0.6, 0.9), 'HarvOre' if rng() < 0.12 else 'HarvSand', rot=(rng(-0.2, 0.2), rng(-0.4, 0.4), rng(-0.2, 0.2)))

    # Sieve tower: a block with a sloped face, the slit eye across it under a heavy brow.
    tower = [
        (-11.0, 17.4, 11.0, 3.8, 0.6),
        (0.4, 17.4, 11.0, 3.8, 0.6),
        (2.0, 12.2, 11.0, 3.8, 0.5),
    ]
    mb.loft([oct_ring(z, hw * 2, top - bot, ch, cy=(top + bot) / 2) for z, top, bot, hw, ch in tower], 'HarvIron',
            cap0=True, cap1=True, matfn=lambda i, k: 'HarvDeck' if k == 6 else 'HarvIron', capmat='HarvIron')
    # brow over the eye, cheek blinkers either side
    mb.box((0, 16.05, 1.05), (6.8, 0.5, 1.4), 'HarvRust', rot=(-0.25, 0, 0))
    for s in (1, -1):
        mb.box((s * 3.2, 15.3, 1.35), (0.4, 1.5, 1.1), 'HarvRust')
    mb.box((0, EYE[1], 0.95), (5.6, 0.55, 0.2), 'HarvDark', rot=(-0.3, 0, 0))  # the slit's socket
    # turret ring on the roof
    mb.cyl((TURRET[0], 17.3, TURRET[2]), (TURRET[0], 17.85, TURRET[2]), 2.3, segs=16, mat='HarvSteel')
    # bucket elevator casing up the right flank, from the hull side to the tower
    mb.box((6.6, 11.0, -3.2), (1.6, 12.0, 2.0), 'HarvRust')
    mb.box((6.6, 17.2, -3.2), (1.9, 0.6, 2.3), 'HarvIron')
    mb.beam((6.6, 16.7, -3.2), (3.8, 16.2, -3.2), 1.2, 1.0, 'HarvRust')
    for y in range(6, 16, 2):
        mb.box((7.42, y, -3.2), (0.06, 0.14, 2.0), 'HarvDark')
    # antenna mast with a small dish
    mb.cyl((-2.8, 17.4, -9.6), (-2.8, 23.0, -9.6), 0.08, segs=5, mat='HarvSteel')
    mb.cyl((-2.8, 21.7, -9.6), (-2.8, 21.7, -9.0), 0.7, 0.2, segs=10, mat='HarvSteel')
    # exhaust stacks, soot-black at the top, each on a plinth
    for x, z in STACKS:
        mb.box((x, 11.6, z), (1.8, 1.2, 1.8), 'HarvRust')
        mb.beam((x, 11.0, z), (x, STACK_TOP - 1.2, z), 1.25, 1.25, 'HarvIron')
        mb.beam((x, STACK_TOP - 1.2, z), (x, STACK_TOP, z), 1.4, 1.4, 'HarvBurnt')
        mb.box((x, STACK_TOP + 0.02, z), (1.0, 0.04, 1.0), 'HarvDark')
    # the chute out of the stern, sand spilling from its end
    cx, cy, cz = CHUTE_END
    mb.beam((cx, 8.2, -14.6), (cx, cy + 0.2, cz), 3.0, 0.3, 'HarvSteel')
    for s in (1, -1):
        mb.beam((cx + s * 1.5, 8.7, -14.6), (cx + s * 1.5, cy + 0.7, cz), 0.2, 1.0, 'HarvIron')
    mb.box((cx, 8.6, -15.0), (3.6, 1.6, 1.0), 'HarvRust')
    # pipes along the deck from the stacks to the tower
    for i, x in enumerate((-6.4, -6.0)):
        mb.sweep([(x, 11.3, -13.8), (x, 11.3, -4.0), (-3.8, 11.8 + i * 0.4, -2.0)], 0.22, 'HarvRust', segs=6)
    # sand caked on the hull's lower edges and the stern
    for s in (1, -1):
        mb.box((s * 7.3, 5.05, -0.5), (0.5, 0.5, 29), 'HarvSand')
    return finish(mb, 'Harvester_Hull')


def build_drum():
    """The cutter drum, about its axle (local X): a core with helical rows of teeth winding in from both ends."""
    mb = MB()
    mb.cyl((-5.6, 0, 0), (5.6, 0, 0), 1.1, segs=14, mat='HarvRust')
    for x in (-5.6, 5.6):
        mb.cyl((x - 0.12, 0, 0), (x + 0.12, 0, 0), 1.45, segs=14, mat='HarvSteel')
    n = 14
    for k in range(n):
        x = -5.2 + k * (10.4 / (n - 1))
        for j in range(5):
            a = j * (2 * PI / 5) + (abs(x) * 0.55) * (1 if x > 0 else -1)
            d = Vector((0, math.cos(a), math.sin(a)))
            p = d * 1.05
            tip = d * DRUM_R + Vector((0, -math.sin(a), math.cos(a))) * 0.25
            mb.cyl((x, p.y, p.z), (x, tip.y, tip.z), 0.17, 0.0, segs=5, mat='HarvSteel')
    return finish(mb, 'Harvester_Drum', DRUM)


def build_turret():
    """The turret on the tower: a low faceted wedge turning about its pivot."""
    mb = MB()
    mb.loft([oct_ring(-2.6, 3.8, 1.5, 0.4, cy=-0.1), oct_ring(1.6, 4.4, 1.7, 0.5, cy=0.0), oct_ring(2.6, 3.4, 1.2, 0.4, cy=0.05)],
            'HarvIron', cap0=True, cap1=True, matfn=lambda i, k: 'HarvDeck' if k == 6 else 'HarvIron', capmat='HarvIron')
    mb.box((0, -0.9, 0), (4.0, 0.3, 4.6), 'HarvRust')
    # its own small sensor, a dim slit
    mb.box((1.3, 0.55, 2.2), (0.8, 0.18, 0.5), 'HarvDark')
    # ammunition boxes on the back
    for s in (1, -1):
        mb.box((s * 1.2, 0.2, -2.9), (0.9, 0.9, 0.7), 'HarvRust')
    return finish(mb, 'Harvester_Turret', TURRET)


def build_guns():
    """Its twin barrels, pitching about the pivot (local X), along +Z."""
    mb = MB()
    mb.box((0, 0, 2.4), (2.2, 1.0, 0.8), 'HarvRust')  # mantlet
    for s in (1, -1):
        x = s * 0.6
        mb.cyl((x, 0, 2.6), (x, 0, BARREL - 0.4), 0.2, segs=8, mat='HarvSteel')
        mb.cyl((x, 0, BARREL - 0.6), (x, 0, BARREL), 0.3, segs=8, mat='HarvBurnt')
        mb.cyl((x, 0, 2.6), (x, 0, 3.2), 0.32, segs=8, mat='HarvIron')
    return finish(mb, 'Harvester_Guns', TURRET)


def build_eye():
    mb = MB()
    mb.box((0, 0, 0), (5.0, 0.3, 0.12), 'HarvEye', rot=(-0.3, 0, 0))
    return finish(mb, 'Harvester_Eye', EYE)


def build_vents():
    out = []
    for i, (x, y, z) in enumerate(VENTS):
        mb = MB()
        s = 1 if x > 0 else -1
        mb.box((-s * 0.05, 0, 0), (0.08, VENT_HY * 2, VENT_HZ * 2), 'HarvVent')
        for k in range(7):
            yy = -VENT_HY + 0.18 + k * (2 * VENT_HY - 0.36) / 6
            mb.box((s * 0.06, yy, 0), (0.3, 0.1, VENT_HZ * 2), 'HarvDark', rot=(0, 0, -0.6 * s))
        out.append(finish(mb, f'Harvester_Vent{i}', (x, y, z)))
    return out


def build_link():
    """One track shoe, centred, its grouser on +Y (the side out against the sand), running along Z."""
    mb = MB()
    mb.box((0, 0, 0), (TRACK_W, 0.24, 0.72), 'HarvSteel')
    mb.box((0, 0.2, -0.12), (TRACK_W, 0.18, 0.16), 'HarvSteel')
    for x in (-0.55, 0.55):
        mb.box((x, -0.24, 0), (0.18, 0.3, 0.42), 'HarvSteel')  # one material: the game instances it
    return finish(mb, 'Harvester_Link')


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
    bpy.ops.mesh.primitive_plane_add(size=600, location=(0, 0, 0))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new('ground')
    gm.use_nodes = True
    gm.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (*lin(0xc46a24), 1)
    gm.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value = 1.0
    ground.data.materials.append(gm)
    # lay the tread links round each loop, as the game does
    link = bpy.data.objects['Harvester_Link']
    loop = 2 * (2 * LOOP_HALF) + 2 * PI * LOOP_R
    n = 30
    for sx in (1, -1):
        for sz in (1, -1):
            for k in range(n):
                p, ang = loop_at(k * loop / n)
                o = link.copy()
                scene.collection.objects.link(o)
                o.matrix_world = C @ T(sx * TRACK_X, p[0], sz * TRACK_Z + p[1]) @ Rx(ang)
    link.hide_render = True
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

    look((38, 6, 46), (0, 8, 0), 30, 'harvester_34.png')
    look((0, 1.8, 70), (0, 9, 0), 30, 'harvester_front.png')
    look((10, 1.7, 40), (0, 9, 0), 24, 'harvester_low_front.png')
    look((52, 8, -6), (0, 7, 0), 35, 'harvester_side.png')
    look((-30, 22, -42), (0, 8, 0), 32, 'harvester_rear34.png')
    look((9, 2.2, 20.5), (2, 2, 15.5), 22, 'harvester_maw.png')


def loop_at(d):
    """Along a track loop d m from the bottom run's rear end, going forward: (y, z) of the belt's centre line and the
    shoe's turn about X (0 on the bottom run, its grouser down: the link's +Y outwards)."""
    L = 2 * LOOP_HALF
    a = PI * LOOP_R
    d %= 2 * L + 2 * a
    if d < L:  # bottom run, rear to front, grouser down
        return (LOOP_Y - LOOP_R, -LOOP_HALF + d), PI
    d -= L
    if d < a:  # round the front wheel, going up
        t = d / LOOP_R
        return (LOOP_Y - LOOP_R * math.cos(t), LOOP_HALF + LOOP_R * math.sin(t)), PI - t
    d -= a
    if d < L:  # top run, front to rear
        return (LOOP_Y + LOOP_R, LOOP_HALF - d), 0.0
    d -= L
    t = d / LOOP_R
    return (LOOP_Y + LOOP_R * math.cos(t), -LOOP_HALF - LOOP_R * math.sin(t)), -t


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--preview', default=None)
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models'))
    args = ap.parse_args(argv)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in MATERIALS.items():
        make_material(name, *spec)
    objs = [build_hull(), build_drum(), build_turret(), build_guns(), build_eye(), *build_vents(), build_link()]
    os.makedirs(args.out, exist_ok=True)
    export_glb(objs, os.path.join(args.out, 'harvester.glb'))
    for o in objs:
        print(f'{o.name}: tris={tri_count(o)}')
    if args.preview:
        render_previews(objs, os.path.abspath(args.preview))


main()
