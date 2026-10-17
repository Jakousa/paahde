"""Crashed spacecraft wrecks for desert crash sites, exported as one glTF binary + a generated TS table.

    blender -b --python tools/blender/crashsites.py                       # writes the glb + shared/crashKinds.ts
    blender -b --python tools/blender/crashsites.py -- --preview <dir>    # also renders PNG previews into <dir>

Steampunk crossed with used-future junk: riveted brass/copper panels, faded paint (cream, rust-red, teal,
olive), exposed pipes, cracked portholes, greebles, torn hulls with ribs showing, soot and bent struts.

public/models/crashsites.glb has one top-level node per variant (Crash_Fighter, Crash_Freighter, Crash_Pod,
Crash_Nacelle, Crash_Shuttle, Crash_Probe, Crash_Debris_1..7). Every node sits at the scene origin with
identity transform; its mesh origin is on the ground at the piece's centre. Hulls continue 0.5-1.5 m below
the origin plane, so the wrecks look dug in and nothing floats when the ground is +-0.5 m off.

Colours are per-face vertex colours (COLOR_0) on a small shared set of materials whose base colour factor is
white; the materials only differ in metalness/roughness. CrashGlow is the emissive one (the game animates it).

shared/crashKinds.ts gets, per piece, collision capsules, the enclosing radius, smoke points and the beacon
point, in model-local three.js coordinates (x = Blender x, y = Blender z, z = -Blender y).

Blender is Z-up; the glTF exporter converts to Y-up. Units are metres. Output is deterministic.
"""

import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.dont_write_bytecode = True  # no __pycache__ next to the shared helper
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'base'))
from coplanar import separate_coplanar  # noqa: E402

# Materials: name -> (metallic, roughness, double-sided, emission (sRGB hex, strength) or None).
MATERIALS = {
    'CrashPaint': (0.15, 0.75, True, None),   # faded painted hull plating
    'CrashBrass': (0.55, 0.42, True, None),   # brass / copper fittings, bells, rings
    'CrashMetal': (0.4, 0.65, True, None),    # iron, steel, ribs, struts, greebles
    'CrashDark': (0.0, 0.9, True, None),      # rubber, cables, interiors, burnt seat, holes
    'CrashGlass': (0.3, 0.12, True, None),    # portholes and canopy
    'CrashGlow': (0.0, 0.5, False, (0xff5a2a, 2.5)),  # console glow + warning lights (animated in game)
    'CrashSand': (0.0, 1.0, False, None),     # ploughed-up sand mounds, matches the terrain #c46a24
}

# Palette (sRGB hex).
CREAM = 0xd6c398
CREAM_DK = 0xb9a67e
RED = 0xa03c26
TEAL = 0x3d8079
OLIVE = 0x6f6c38
BRASS = 0xc39a45
BRASS_DK = 0x8f6c2e
COPPER = 0xc0703f
IRON = 0x5c5650
STEEL = 0x8c877e
RUST = 0x7c3e1e
DARK = 0x2a2420
RUBBER = 0x1c1917
GLASS = 0x2a4a4c
GLOW = 0xff8a4a
REDLIGHT = 0xff3020
SAND = 0xc46a24
SOOT = 0x16110e
SCORCH = 0x4a2c18
DUST = 0xb2723c
CABLE_RED = 0x8e2a1e
CABLE_YEL = 0xb08a2a

PI = math.pi


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lin(hex_color):
    return Vector([srgb_to_linear(((hex_color >> s) & 0xFF) / 255) for s in (16, 8, 0)])


def make_material(name, metallic, roughness, double, emission):
    """Flat Principled BSDF; base colour = vertex colour 'Col' x white, so the glTF gets COLOR_0."""
    mat = bpy.data.materials.new(name)
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    vc = nt.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = 'Col'
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    mix.inputs['Factor'].default_value = 1.0
    mix.inputs['B'].default_value = (1, 1, 1, 1)
    nt.links.new(vc.outputs['Color'], mix.inputs['A'])
    nt.links.new(mix.outputs['Result'], bsdf.inputs['Base Color'])
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    if emission:
        e = lin(emission[0])
        bsdf.inputs['Emission Color'].default_value = (*e, 1)
        bsdf.inputs['Emission Strength'].default_value = emission[1]
    mat.diffuse_color = (0.8, 0.8, 0.8, 1)
    mat.use_backface_culling = not double
    return mat


class Rng:
    """Tiny deterministic LCG so re-running the script gives identical models."""

    def __init__(self, seed):
        self.s = seed * 2654435761 % 2**32 or 1

    def __call__(self, a=0.0, b=1.0):
        self.s = (1664525 * self.s + 1013904223) % 2**32
        return a + (b - a) * self.s / 2**32


def R(x=0.0, y=0.0, z=0.0):
    """Rotation matrix: X first, then Y, then Z (yaw last)."""
    return Euler((x, y, z), 'XYZ').to_matrix().to_4x4()


def T(x, y=None, z=None):
    if y is None:
        return Matrix.Translation(Vector(x))
    return Matrix.Translation(Vector((x, y, z)))


def S(x, y, z):
    return Matrix.Diagonal((x, y, z, 1))


def aim(p, n):
    """Matrix putting local +Z along n at point p."""
    q = Vector(n).normalized().to_track_quat('Z', 'Y')
    return T(p) @ q.to_matrix().to_4x4()


class MeshBuilder:
    """One bmesh per variant, built in world space under a transform stack; per-face colour + material."""

    def __init__(self):
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.float_color.new('Col')
        self.mats = []
        self.stack = [Matrix.Identity(4)]
        self.burns = []
        self.caps = []
        self.smoke = []
        self.beacon = (0, 0, 0)

    # -- transforms
    def push(self, m):
        self.stack.append(self.stack[-1] @ m)

    def pop(self):
        self.stack.pop()

    def W(self, p):
        return self.stack[-1] @ Vector(p)

    # -- bookkeeping
    def mat(self, name):
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    def _tag(self, faces, mat, col):
        idx = self.mat(mat)
        for f, c in faces:
            f.material_index = idx
            f.smooth = False
            cc = lin(c if c is not None else col)
            for lp in f.loops:
                lp[self.col] = (*cc, 1)

    def _finish(self, verts, mat, col, m=None):
        mm = self.stack[-1] @ (m if m is not None else Matrix.Identity(4))
        bmesh.ops.transform(self.bm, matrix=mm, verts=verts)
        faces = {f for v in verts for f in v.link_faces}
        self._tag([(f, None) for f in faces], mat, col)
        return verts

    # -- primitives
    def box(self, size, loc, mat, col, rot=(0, 0, 0), taper=None, m=None):
        """Box centred on loc. taper=(sx, sy) scales the top face (local +Z)."""
        verts = bmesh.ops.create_cube(self.bm, size=1)['verts']
        for v in verts:
            if taper and v.co.z > 0:
                v.co.x *= taper[0]
                v.co.y *= taper[1]
            v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
        mm = T(loc) @ Euler(rot).to_matrix().to_4x4()
        if m is not None:
            mm = m @ mm
        return self._finish(verts, mat, col, mm)

    def cyl(self, r1, r2, depth, segs, loc, mat, col, rot=(0, 0, 0), m=None):
        verts = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segs,
                                      radius1=r1, radius2=r2, depth=depth)['verts']
        mm = T(loc) @ Euler(rot).to_matrix().to_4x4()
        if m is not None:
            mm = m @ mm
        return self._finish(verts, mat, col, mm)

    def tube(self, a, b, r, mat, col, segs=6, r2=None):
        a, b = Vector(a), Vector(b)
        d = b - a
        verts = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segs,
                                      radius1=r, radius2=r if r2 is None else r2, depth=d.length)['verts']
        q = d.normalized().to_track_quat('Z', 'Y')
        return self._finish(verts, mat, col, T((a + b) / 2) @ q.to_matrix().to_4x4())

    def sweep(self, pts, r, mat, col, segs=6, radii=None, closed=False):
        """Bent tube through a polyline (closed=True joins the ends into a ring)."""
        pts = [Vector(p) for p in pts]
        n = len(pts)
        rings = []
        ref = Vector((0, 0, 1)) if closed else Vector((1, 0, 0))
        for i, p in enumerate(pts):
            if closed:
                t = (pts[(i + 1) % n] - pts[i - 1]).normalized()
            else:
                t = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
            if abs(t.dot(ref)) > 0.9:
                ref = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
            u = (ref - t * ref.dot(t)).normalized()
            w = t.cross(u)
            rr = radii[i] if radii else r
            rings.append([self.bm.verts.new(p + (u * math.cos(a) + w * math.sin(a)) * rr)
                          for a in (2 * PI * (k + 0.5) / segs for k in range(segs))])
            if not closed:
                ref = u
        faces = []
        pairs = list(zip(rings, rings[1:])) + ([(rings[-1], rings[0])] if closed else [])
        for lo, hi in pairs:
            for k in range(segs):
                j = (k + 1) % segs
                faces.append(self.bm.faces.new([lo[k], lo[j], hi[j], hi[k]]))
        if not closed:
            faces.append(self.bm.faces.new(list(reversed(rings[0]))))
            faces.append(self.bm.faces.new(rings[-1]))
        verts = [v for ring in rings for v in ring]
        bmesh.ops.recalc_face_normals(self.bm, faces=faces)
        return self._finish(verts, mat, col)

    def lathe(self, profile, segs, mat, col, m=None, closed=False, a0=0.0, a1=2 * PI, colfn=None, skip=None,
              jag=None):
        """Revolve an (r, z) profile about local Z. r == 0 points become poles. colfn(i_angle, k_profile)."""
        full = (a1 - a0) >= 2 * PI - 1e-6
        nang = segs if full else segs + 1
        grid = []
        poles = {}
        for i in range(nang):
            a = a0 + (a1 - a0) * i / segs
            row = []
            for k, (r, z) in enumerate(profile):
                if r < 1e-6:
                    if k not in poles:
                        poles[k] = self.bm.verts.new((0, 0, z))
                    row.append(poles[k])
                else:
                    dz = jag(i, k) if jag else 0.0
                    row.append(self.bm.verts.new((r * math.cos(a), r * math.sin(a), z + dz)))
            grid.append(row)
        faces = []
        np_ = len(profile)
        kr = range(np_) if closed else range(np_ - 1)
        for i in range(segs):
            r0, r1 = grid[i], grid[(i + 1) % nang]
            for k in kr:
                if skip and skip(i, k):
                    continue
                kk = (k + 1) % np_
                q = [r0[k], r1[k], r1[kk], r0[kk]]
                u = []
                for v in q:
                    if v not in u:
                        u.append(v)
                if len(u) < 3:
                    continue
                faces.append((self.bm.faces.new(u), colfn(i, k) if colfn else None))
        verts = list({v for row in grid for v in row})
        verts.sort(key=lambda v: v.index if v.index >= 0 else 0)
        mm = self.stack[-1] @ (m if m is not None else Matrix.Identity(4))
        allv = [v for row in grid for v in row]
        seen = set()
        uniq = [v for v in allv if not (v in seen or seen.add(v))]
        bmesh.ops.transform(self.bm, matrix=mm, verts=uniq)
        bmesh.ops.recalc_face_normals(self.bm, faces=[f for f, _ in faces])
        self._tag(faces, mat, col)
        return uniq

    def loft(self, rings, mat, col, colfn=None, cap0=False, cap1=False, skip=None, closed=True):
        """Skin a list of equal-length point rings (local coords). colfn(i_ring, k_seg)."""
        T_ = self.stack[-1]
        vr = [[self.bm.verts.new(T_ @ Vector(p)) for p in ring] for ring in rings]
        n = len(rings[0])
        faces = []
        for i in range(len(vr) - 1):
            for k in range(n if closed else n - 1):
                if skip and skip(i, k):
                    continue
                j = (k + 1) % n
                faces.append((self.bm.faces.new([vr[i][k], vr[i][j], vr[i + 1][j], vr[i + 1][k]]),
                              colfn(i, k) if colfn else None))
        if cap0:
            faces.append((self.bm.faces.new(list(reversed(vr[0]))), None))
        if cap1:
            faces.append((self.bm.faces.new(vr[-1]), None))
        bmesh.ops.recalc_face_normals(self.bm, faces=[f for f, _ in faces])
        self._tag(faces, mat, col)
        return [v for r in vr for v in r]

    def poly_prism(self, bottom, top, mat, col):
        """Hexahedron from 4 bottom + 4 top points (local), e.g. wings and fins."""
        T_ = self.stack[-1]
        vb = [self.bm.verts.new(T_ @ Vector(p)) for p in bottom]
        vt = [self.bm.verts.new(T_ @ Vector(p)) for p in top]
        fs = [self.bm.faces.new(list(reversed(vb))), self.bm.faces.new(vt)]
        for k in range(4):
            j = (k + 1) % 4
            fs.append(self.bm.faces.new([vb[k], vb[j], vt[j], vt[k]]))
        bmesh.ops.recalc_face_normals(self.bm, faces=fs)
        self._tag([(f, None) for f in fs], mat, col)
        return vb + vt

    def rivets(self, pts, normals, size=0.035, col=BRASS):
        """Little pyramids (6 tris each)."""
        for p, n in zip(pts, normals):
            self.cyl(size, 0.0, size * 0.8, 4, (0, 0, size * 0.2), 'CrashBrass', col, m=aim(p, n))

    def porthole(self, p, n, r, frame_col=BRASS, cracked=True, rng=None, depth=0.08):
        """Brass ring, dark backing and a glass fan with a shattered wedge, at local p facing local n."""
        M = aim(p, n)
        self.lathe([(r * 0.76, -depth), (r, -depth * 0.2), (r * 0.82, depth)], 10, 'CrashBrass', frame_col, m=M,
                   closed=True)
        self.lathe([(0.0, -depth * 0.5), (r * 0.8, -depth * 0.5)], 10, 'CrashDark', SOOT, m=M)
        h = int(rng() * 10) if rng else 3
        hole = {h, (h + 1) % 10} if cracked else set()
        frost = {(h + 2) % 10, (h + 9) % 10, (h + 5) % 10} if cracked else set()
        self.lathe([(0.0, depth * 0.35), (r * 0.8, depth * 0.3)], 10, 'CrashGlass', GLASS, m=M,
                   skip=lambda i, k: i in hole, colfn=lambda i, k: 0x6e8f8c if i in frost else None)
        for k in range(4):
            a = 2 * PI * k / 4 + 0.4
            q = M @ Vector((math.cos(a) * r * 0.9, math.sin(a) * r * 0.9, depth * 0.5))
            self.rivets([q], [M.to_3x3() @ Vector((0, 0, 1))], 0.028, BRASS_DK)

    def cable(self, a, b, sag, r=0.025, col=RUBBER, n=6, segs=4):
        """Dangling cable from a to b (world/local, same frame), sagging by `sag` in -Z."""
        a, b = Vector(a), Vector(b)
        pts = [a.lerp(b, t) - Vector((0, 0, sag * 4 * t * (1 - t))) for t in (i / n for i in range(n + 1))]
        self.sweep(pts, r, 'CrashDark', col, segs=segs)

    def sand(self, cx, cy, rx, ry, height, yaw=0.0, res=(10, 10), fn=None, sink=0.5, colfn=None):
        """Sand mound patch (CrashSand) centred on (cx, cy); edges sink below the ground so it never floats.
        colfn(u, v) -> sRGB hex tints a face by its patch coords in [-1, 1] (scorched sand)."""
        cs, sn = math.cos(yaw), math.sin(yaw)
        nx, ny = res
        grid = []
        for j in range(ny + 1):
            row = []
            for i in range(nx + 1):
                u = -1 + 2 * i / nx
                v = -1 + 2 * j / ny
                d = math.sqrt(u * u + v * v)
                z = fn(u, v) if fn else height * max(0.0, 1 - d * d) ** 1.5
                w = min(1.0, max(0.0, (1 - d) / 0.4))
                w = w * w * (3 - 2 * w)
                z = z * w - sink * (1 - w)
                x, y = u * rx, v * ry
                row.append(self.bm.verts.new(self.W((cx + x * cs - y * sn, cy + x * sn + y * cs, z))))
            grid.append(row)
        faces = []
        for j in range(ny):
            for i in range(nx):
                c = colfn(-1 + 2 * (i + 0.5) / nx, -1 + 2 * (j + 0.5) / ny) if colfn else None
                faces.append((self.bm.faces.new([grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]]),
                              c))
        bmesh.ops.recalc_face_normals(self.bm, faces=[f for f, _ in faces])
        for f, _ in faces:
            if f.normal.z < 0:
                f.normal_flip()
        self._tag(faces, 'CrashSand', SAND)

    def jitter(self, verts, rng, amount):
        for v in verts:
            v.co += Vector((rng(-amount, amount), rng(-amount, amount), rng(-amount, amount)))

    # -- gameplay data, recorded in world (variant) space
    def burn(self, p, r, s=1.0):
        self.burns.append((self.W(p), r, s))

    def cap(self, a, b, r):
        self.caps.append((self.W(a), self.W(b), r))

    def smoke_at(self, p):
        self.smoke.append(self.W(p))

    def beacon_at(self, p):
        self.beacon = self.W(p)

    # -- weathering pass (world space, after everything is built)
    def weather(self, rng):
        dust = lin(DUST)
        soot = lin(SOOT)
        scorch = lin(SCORCH)
        rust = lin(RUST)
        copper = lin(COPPER)
        brass_dk = lin(BRASS_DK)
        for f in self.bm.faces:
            m = self.mats[f.material_index]
            c = Vector(f.loops[0][self.col][:3])
            if m in ('CrashGlow',):
                continue
            if m == 'CrashSand':
                c = c * rng(0.93, 1.04)
            else:
                p = f.calc_center_median()
                if m == 'CrashPaint':
                    c = c * rng(0.86, 1.04)
                    if rng() < 0.06:
                        c = c.lerp(rust, 0.75)
                elif m == 'CrashBrass':
                    c = c * rng(0.85, 1.05)
                    r = rng()
                    if r < 0.18:
                        c = c.lerp(copper, 0.8)
                    elif r < 0.3:
                        c = c.lerp(brass_dk, 0.7)
                elif m == 'CrashMetal':
                    c = c * rng(0.85, 1.08)
                    if rng() < 0.2:
                        c = c.lerp(rust, 0.6)
                if m != 'CrashGlass':
                    t = min(1.0, max(0.0, (0.55 - p.z) / 0.9))
                    c = c.lerp(dust, t * 0.7)
                f_burn = 0.0
                for bc, br, bs in self.burns:
                    d = (p - bc).length
                    if d < br:
                        f_burn = max(f_burn, (1 - d / br) * bs * rng(0.7, 1.4))
                f_burn = min(1.0, f_burn * 1.3)
                if f_burn > 0:
                    if f_burn < 0.5:
                        c = c.lerp(scorch, f_burn * 2 * 0.65)
                    else:
                        c = c.lerp(scorch, 0.65).lerp(soot, (f_burn - 0.5) * 2 * 0.9)
            for lp in f.loops:
                lp[self.col] = (*c, 1)


# --------------------------------------------------------------------------------------------- shapes

def se_ring(y, w, h, segs, zc=0.0, n=2.6, nb=None, x0=0.0, rot=0.0):
    """Superellipse cross-section in the XZ plane at y (k=0 at +X, counter-clockwise seen from +Y)."""
    pts = []
    for k in range(segs):
        a = 2 * PI * k / segs + rot
        c, s = math.cos(a), math.sin(a)
        e = n if (s >= 0 or nb is None) else nb
        x = math.copysign(abs(c) ** (2 / e), c) * w / 2
        z = math.copysign(abs(s) ** (2 / e), s) * h / 2
        pts.append(Vector((x0 + x, y, zc + z)))
    return pts


def wing(mb, root_le, root_te, tip_le, tip_te, t0, t1, mat, col):
    """Thin tapered wing/fin slab; points are the mid-plane corners, thickness along local Z."""
    bottom = [Vector(root_le) - Vector((0, 0, t0 / 2)), Vector(tip_le) - Vector((0, 0, t1 / 2)),
              Vector(tip_te) - Vector((0, 0, t1 / 2)), Vector(root_te) - Vector((0, 0, t0 / 2))]
    top = [Vector(root_le) + Vector((0, 0, t0 / 2)), Vector(tip_le) + Vector((0, 0, t1 / 2)),
           Vector(tip_te) + Vector((0, 0, t1 / 2)), Vector(root_te) + Vector((0, 0, t0 / 2))]
    return mb.poly_prism(bottom, top, mat, col)


def crate(mb, c, size, rot, col, rng):
    mb.push(T(c) @ R(*rot))
    v = mb.box(size, (0, 0, 0), 'CrashPaint', col)
    mb.jitter(v, rng, 0.02)
    for sx in (-0.32, 0.32):
        mb.box((0.08, size[1] + 0.04, size[2] + 0.04), (sx * size[0], 0, 0), 'CrashMetal', IRON)
    mb.box((size[0] * 0.5, 0.02, size[2] * 0.3), (0, -size[1] / 2 - 0.012, 0), 'CrashPaint',
           CREAM if col != CREAM else RED)
    mb.pop()


# ------------------------------------------------------------------------------------------- fighter

def build_fighter(mb, rng):
    """Single-seat starfighter, ~9 m, nose ploughed into the sand, left wing snapped off nearby."""
    pose = T(0.2, -0.9, 0.62) @ R(z=0.35, y=0.24, x=-0.42)
    mb.push(pose)
    segs = 12
    sections = [(4.7, 0.14, 0.12, -0.05), (4.0, 0.66, 0.5, 0.0), (2.9, 1.18, 0.92, 0.08), (1.6, 1.48, 1.16, 0.15),
                (0.3, 1.62, 1.26, 0.18), (-1.2, 1.72, 1.2, 0.15), (-2.6, 1.98, 1.1, 0.12), (-3.7, 1.92, 1.0, 0.12),
                (-4.3, 1.58, 0.82, 0.12)]
    rings = [se_ring(y, w, h, segs, zc, n=3.0) for y, w, h, zc in reversed(sections)]  # tail -> nose

    def colfn(i, k):
        ii = len(rings) - 2 - i  # 0 = nose segment
        if ii <= 1:
            return RED if k not in (8, 9) else CREAM_DK
        if k in (1, 4) and ii < 6:
            return TEAL
        if k in (7, 8, 9, 10):
            return CREAM_DK
        if (ii * 7 + k * 3) % 11 == 0:
            return OLIVE
        return CREAM

    mb.loft(rings, 'CrashPaint', CREAM, colfn=colfn, cap0=True, cap1=True)
    mb.box((1.3, 0.06, 0.62), (0, -4.33, 0.12), 'CrashMetal', STEEL)  # rear plate
    for x in (-0.3, 0.0, 0.3):
        mb.box((0.12, 0.08, 0.5), (x, -4.37, 0.12), 'CrashBrass', BRASS_DK)  # exhaust grille
    # Seam bands with rivets.
    for y, w, h, zc in ((-1.2, 1.72, 1.2, 0.15), (1.6, 1.48, 1.16, 0.15)):
        ring = se_ring(y, w * 1.02, h * 1.02, 16, zc, n=3.0)
        mb.sweep(ring, 0.035, 'CrashBrass', BRASS, segs=4, closed=True)
        top = [p for p in se_ring(y + 0.09, w * 1.01, h * 1.01, 14, zc, n=3.0) if p.z > zc - 0.1]
        mb.rivets(top, [Vector((p.x, 0, p.z - zc)) for p in top], 0.03)

    # Cockpit: dark tub, coaming, seat, glowing console, canopy hinged open with cracked glass.
    mb.box((0.92, 1.6, 0.34), (0, 1.15, 0.7), 'CrashDark', DARK)
    for sx in (-1, 1):
        mb.box((0.08, 1.7, 0.1), (sx * 0.5, 1.15, 0.86), 'CrashBrass', BRASS)
    mb.box((1.06, 0.08, 0.1), (0, 2.0, 0.86), 'CrashBrass', BRASS)
    mb.box((0.5, 0.18, 0.62), (0, 0.55, 0.98), 'CrashDark', 0x4a3426, rot=(-0.2, 0, 0))   # seat back
    mb.box((0.7, 0.35, 0.22), (0, 1.75, 0.92), 'CrashMetal', IRON, rot=(0.5, 0, 0))     # console
    mb.box((0.5, 0.02, 0.12), (0, 1.62, 0.99), 'CrashGlow', GLOW, rot=(0.5 + PI / 2, 0, 0))
    mb.box((0.08, 0.08, 0.08), (0.27, 1.62, 1.04), 'CrashGlow', REDLIGHT)
    mb.beacon_at((0, 1.7, 0.95))
    prof = [(math.sin(t) * 1.0, math.cos(t) * 1.0) for t in (PI / 2 * k / 5 for k in range(6))]
    prof.reverse()  # rim -> apex
    canopy_m = T(0, 0.4, 0.9) @ R(x=0.62) @ T(0, 0.75, 0) @ S(0.47, 0.75, 0.36)
    crack = {(2, 1), (3, 1), (3, 2), (7, 0)}
    mb.lathe([(r, z) for r, z in prof], 10, 'CrashGlass', GLASS, m=canopy_m, skip=lambda i, k: (i, k) in crack)
    rim = [canopy_m @ Vector((math.cos(a), math.sin(a), 0)) for a in (2 * PI * k / 12 for k in range(12))]
    mb.sweep(rim, 0.04, 'CrashBrass', BRASS, segs=4, closed=True)
    mb.sweep([canopy_m @ Vector((0, -1, 0)), canopy_m @ Vector((0, -0.6, 0.8)), canopy_m @ Vector((0, 0, 1)),
              canopy_m @ Vector((0, 0.6, 0.8)), canopy_m @ Vector((0, 1, 0))], 0.035, 'CrashBrass', BRASS, segs=4)
    mb.tube((0.3, 1.0, 0.86), (0.3, 1.0, 1.42), 0.03, 'CrashMetal', STEEL)  # canopy strut

    # Right wing (attached, its tip ploughed into the sand by the roll).
    wing(mb, (0.75, 0.5, 0.05), (0.75, -2.2, 0.05), (2.8, -1.1, -0.04), (2.8, -2.45, -0.04), 0.24, 0.14,
         'CrashPaint', CREAM)
    wing(mb, (2.78, -1.1, -0.04), (2.78, -2.45, -0.04), (4.0, -1.75, -0.1), (4.0, -2.65, -0.1), 0.14, 0.08,
         'CrashPaint', RED)
    mb.tube((4.05, -0.2, -0.1), (4.05, -2.8, -0.1), 0.09, 'CrashBrass', BRASS, segs=6)  # wing-tip cannon
    mb.tube((4.05, 0.6, -0.1), (4.05, -0.2, -0.1), 0.04, 'CrashMetal', IRON, segs=5)
    mb.box((0.7, 0.5, 0.04), (1.6, -0.9, 0.12), 'CrashBrass', BRASS_DK, rot=(0, -0.03, 0))  # panel
    # Left wing stump: jagged root, spars sticking out, dangling cables.
    wing(mb, (-0.75, 0.4, 0.05), (-0.75, -2.2, 0.05), (-1.6, -0.6, 0.03), (-1.5, -2.0, 0.03), 0.24, 0.2,
         'CrashPaint', CREAM)
    for a, b in (((-1.4, -0.9, 0.05), (-2.3, -1.1, 0.25)), ((-1.4, -1.6, 0.05), (-2.1, -1.8, -0.15))):
        mb.tube(a, b, 0.05, 'CrashMetal', IRON, segs=5)
    for k in range(3):
        y0 = -0.8 - k * 0.45
        mb.box((0.4, 0.22, 0.03), (-1.68, y0, 0.06 + 0.05 * k), 'CrashPaint', CREAM, rot=(0.4 * k - 0.3, 0.5, 0.3))
    stump_pts = [mb.W((-1.5, -1.0 - 0.35 * k, 0.0)) for k in range(3)]
    mb.burn((-1.3, -1.3, 0.1), 1.6, 1.0)
    mb.smoke_at((-1.2, -1.3, 0.3))

    # Engines: twin rust-red pods with brass bands and copper bells.
    for sx in (-1, 1):
        x = sx * 0.9
        mb.cyl(0.42, 0.36, 2.6, 12, (x, -3.1, 0.1), 'CrashPaint', RED, rot=(PI / 2, 0, 0))
        for y in (-2.1, -3.0, -3.9):
            mb.cyl(0.45, 0.45, 0.12, 12, (x, y, 0.1), 'CrashBrass', BRASS, rot=(PI / 2, 0, 0))
        bell = T(x, -4.35, 0.1) @ R(x=-PI / 2)
        mb.lathe([(0.3, 0.05), (0.24, -0.12), (0.27, -0.3), (0.36, -0.5), (0.31, -0.5), (0.22, -0.3),
                  (0.19, -0.12), (0.24, 0.05)], 10, 'CrashBrass', COPPER, m=bell, closed=True)
        mb.lathe([(0.0, -0.1), (0.21, -0.1)], 8, 'CrashDark', SOOT, m=bell)
        mb.cyl(0.38, 0.3, 0.3, 10, (x, -1.7, 0.1), 'CrashDark', DARK, rot=(PI / 2, 0, 0))  # intake
        # Exhaust pipes along the side into the pod.
        mb.sweep([(sx * 0.8, 0.6, -0.05), (sx * 0.9, -0.6, 0.0), (sx * 0.98, -1.4, 0.3), (sx * 0.9, -2.0, 0.55)],
                 0.06, 'CrashBrass', COPPER, segs=5)
    mb.burn((0, -4.7, 0.1), 1.3, 0.55)
    mb.smoke_at((0.9, -4.6, 0.2))
    # Tail fin, bent over at the top, warning light on the tip.
    wing(mb, (0, -2.4, 0.62), (0, -4.2, 0.55), (0.0, -3.7, 1.35), (0.0, -4.35, 1.3), 0.14, 0.12,
         'CrashPaint', RED)
    mb.push(T(0, -3.9, 1.32) @ R(y=0.55) @ T(0, 3.9, -1.32))
    wing(mb, (0.0, -3.7, 1.32), (0.0, -4.35, 1.28), (0.0, -3.95, 1.95), (0.0, -4.4, 1.92), 0.12, 0.1,
         'CrashPaint', CREAM)
    mb.box((0.14, 0.14, 0.12), (0, -4.2, 2.0), 'CrashGlow', REDLIGHT)
    mb.pop()
    for y in (-3.0, -3.6):
        mb.rivets([Vector((0.08, y, 0.9)), Vector((0.08, y + 0.3, 1.1))], [Vector((1, 0, 0))] * 2, 0.03)
    # Spine greebles.
    for y, s in ((-0.6, (0.5, 0.6, 0.18)), (-1.6, (0.36, 0.5, 0.22)), (-0.1, (0.2, 0.3, 0.12))):
        mb.box(s, (0.05, y, 0.78), 'CrashMetal', IRON)
    mb.cyl(0.1, 0.1, 0.4, 6, (-0.25, -1.1, 0.85), 'CrashBrass', BRASS, rot=(PI / 2, 0, 0))
    for sx in (-1, 1):
        mb.box((0.05, 0.6, 0.18), (sx * 0.86, 2.0, 0.1), 'CrashDark', DARK)  # side vents
    # Bent landing strut hanging out of the belly.
    mb.sweep([(0.4, -1.0, -0.4), (0.55, -1.0, -0.95), (1.1, -1.3, -1.15)], 0.06, 'CrashMetal', STEEL, segs=5)
    mb.cyl(0.22, 0.22, 0.06, 8, (1.15, -1.3, -1.18), 'CrashMetal', IRON, rot=(0, 1.0, 0))
    mb.box((0.36, 0.5, 0.06), (0.2, -1.0, -0.5), 'CrashDark', DARK, rot=(0, 0.6, 0))  # strut door

    # Capsules (ship space).
    mb.cap((0, 3.4, 0), (0, 0.4, 0), 0.75)
    mb.cap((0, 0.4, 0), (0, -4.4, 0), 1.35)
    mb.cap((1.4, -1.0, 0), (3.9, -2.0, 0), 0.75)
    nose = mb.W((0, 2.6, 0))  # roughly where the fuselage enters the sand
    mb.pop()

    # Cables hanging off the stump (world space).
    for k, p in enumerate(stump_pts):
        end = p + Vector((-0.3 - 0.2 * k, 0.1 * k, -p.z - 0.4))
        mb.cable(p, end, 0.1, 0.03, (RUBBER, CABLE_RED, CABLE_YEL)[k], n=5)
    # Sand ploughed up around the nose.
    mb.sand(nose.x, nose.y - 0.2, 2.4, 2.6, 0.0, yaw=0.35, res=(12, 12),
            fn=lambda u, v: 0.4 * math.exp(-((math.hypot(u, v * 0.9) - 0.34) / 0.26) ** 2) * (0.75 + 0.35 * v))

    # The snapped-off left wing, lying a few metres away with its leading edge dug in.
    m = T(-4.6, 0.8, 0.05) @ R(x=0.0, y=-0.32, z=-0.9)
    mb.push(m)
    wing(mb, (0.0, 0.6, 0.0), (0.0, -1.7, 0.0), (1.9, -0.7, -0.06), (1.9, -2.0, -0.06), 0.2, 0.14,
         'CrashPaint', CREAM)
    wing(mb, (1.88, -0.7, -0.06), (1.88, -2.0, -0.06), (3.1, -1.35, -0.1), (3.1, -2.2, -0.1), 0.14, 0.08,
         'CrashPaint', RED)
    mb.tube((3.15, 0.2, -0.1), (3.15, -2.4, -0.1), 0.09, 'CrashBrass', BRASS, segs=6)
    for a, b in (((0.0, -0.3, 0.0), (-0.5, -0.4, 0.05)), ((0.0, -1.1, 0.0), (-0.4, -1.2, -0.1))):
        mb.tube(a, b, 0.05, 'CrashMetal', IRON, segs=5)
    mb.box((0.8, 0.6, 0.04), (1.0, -0.7, 0.12), 'CrashBrass', BRASS_DK)
    mb.burn((0.0, -0.6, 0.0), 1.3, 0.9)
    mb.cap((0.2, -0.6, 0), (3.0, -1.6, 0), 0.8)
    mb.pop()


# ----------------------------------------------------------------------------------------- freighter

def build_freighter(mb, rng):
    """Broken-off section of a big round-bellied freighter: torn end with ribs, crates, brass engine bell."""
    pose = T(0.0, -2.2, 1.55) @ R(z=0.25, y=0.24, x=-0.035)
    mb.push(pose)
    segs = 20
    W_, H_ = 6.4, 5.6
    sections = [(-5.0, 5.0, 4.4), (-4.0, 6.0, 5.2), (-2.0, W_, H_), (0.5, W_ + 0.1, H_ + 0.1), (3.0, W_ + 0.1, H_ + 0.1),
                (5.0, W_, H_), (6.6, W_, H_), (8.0, W_, H_)]
    rings = [se_ring(y, w, h, segs, 0.0, n=2.7, nb=2.0) for y, w, h in sections]
    # Torn end: jag the last ring along Y and pull it out of round.
    jr = Rng(91)
    last = rings[-1]
    for k, p in enumerate(last):
        bottom = p.z < -1.6
        p.y -= 0.0 if bottom else jr(0.0, 1.5) * (1.0 if k % 2 else 0.5)
        p.x *= jr(0.97, 1.06)
        p.z *= jr(0.97, 1.05)
    for k, p in enumerate(rings[-2]):
        if p.z > -1.6:
            p.y -= jr(0.0, 0.4)

    holes = set()
    for k in range(segs):
        if k >= 11 and k <= 18:   # belly stays (it is buried)
            continue
        if jr() < 0.5:
            holes.add((6, k))
        if jr() < 0.18:
            holes.add((5, k))

    def colfn(i, k):
        if 11 <= k <= 19 or k == 0 and False:
            return RED if k not in (11, 19) else CREAM_DK
        if k in (2, 8) or k == 10 and False:
            return TEAL
        if (i * 5 + k * 3) % 13 == 0:
            return OLIVE
        return CREAM

    mb.loft(rings, 'CrashPaint', CREAM, colfn=colfn, skip=lambda i, k: (i, k) in holes)
    # Dark inner skin near the torn end (so the inside reads as a hold), bulkhead at y = 1.8.
    inner = [se_ring(y, w * 0.95, h * 0.95, 14, 0.0, n=2.7, nb=2.0) for y, w, h in
             ((1.8, W_, H_), (5.0, W_, H_), (6.8, W_, H_))]
    mb.loft(inner, 'CrashDark', DARK, cap0=True)
    mb.box((5.0, 5.8, 0.12), (0, 4.6, -1.7), 'CrashMetal', IRON)                     # deck
    for x in (-1.6, 0.0, 1.6):
        mb.box((0.08, 5.8, 0.1), (x, 4.6, -1.6), 'CrashMetal', STEEL)                 # deck rails
    # Ribs: square-section rings inside the skin, the outer ones bare past the torn edge.
    for y, frac in ((5.0, 1.0), (6.0, 1.0), (7.0, 1.0), (7.9, 0.7)):
        ring = se_ring(y, W_ * 0.985, H_ * 0.985, 16, 0.0, n=2.7, nb=2.0)
        if frac < 1.0:
            ring = [p for k, p in enumerate(ring) if k <= 8 or k >= 14]  # arc over the top, ends bent
            ring = ring[9:] + ring[:9]
            ring[0] = ring[0] + Vector((0.3, 0.6, 0.4))
            ring[-1] = ring[-1] + Vector((-0.5, 0.5, 0.2))
            mb.sweep(ring, 0.11, 'CrashMetal', IRON, segs=4)
        else:
            mb.sweep(ring, 0.11, 'CrashMetal', IRON, segs=4, closed=True)
    # Stringers poking out of the torn end, some bent outwards.
    for k in (1, 3, 5, 7, 9, 10, 18):
        a = 2 * PI * k / 20
        p0 = Vector((math.cos(a) * W_ * 0.47, 4.8, math.sin(a) * H_ * 0.47))
        L = jr(3.6, 4.6)
        p1 = p0 + Vector((0, L, 0))
        bend = Vector((math.cos(a), 0, math.sin(a))) * jr(0.0, 0.9)
        mb.sweep([p0, p0.lerp(p1, 0.7), p1 + bend], 0.06, 'CrashMetal', STEEL, segs=4)
    # Peeled skin flaps at the torn edge.
    for k in (2, 6, 9):
        a = 2 * PI * (k + 0.5) / 20
        base = Vector((math.cos(a) * W_ * 0.5, 7.6, math.sin(a) * H_ * 0.5))
        out = Vector((math.cos(a), 0, math.sin(a)))
        mb.push(aim(base, out) @ R(x=-0.9))
        mb.box((1.0, 1.4, 0.05), (0, 0.6, 0.15), 'CrashPaint', CREAM if k != 6 else TEAL)
        mb.pop()
    # Seam bands with rivets.
    for y in (-2.0, 0.5, 3.0):
        ring = se_ring(y, W_ * 1.025, H_ * 1.025, 16, 0.0, n=2.7, nb=2.0)
        mb.sweep(ring, 0.06, 'CrashBrass', BRASS, segs=4, closed=True)
        pts = [p for p in se_ring(y + 0.16, W_ * 1.012, H_ * 1.012, 14, 0.0, n=2.7, nb=2.0) if p.z > -0.5]
        mb.rivets(pts, [Vector((p.x, 0, p.z)) for p in pts], 0.05)
    # Portholes along both flanks.
    for side in (1, -1):
        for y in (-3.2, 0.2, 3.6):
            a = 0.2 if side > 0 else PI - 0.2
            p = Vector((math.cos(a) * W_ * 0.5 * 1.0, y, math.sin(a) * H_ * 0.5 * 0.9))
            p.x = side * (W_ / 2 * 0.985)
            mb.porthole(p, (side, 0, 0.15), 0.34, rng=rng)
    # Pipes along the upper flank.
    for k, (a, r, col) in enumerate(((0.75, 0.14, COPPER), (0.88, 0.1, BRASS), (2.35, 0.12, BRASS))):
        x = math.cos(a) * W_ * 0.53
        z = math.sin(a) * H_ * 0.53
        pts = [(x * 0.92, -4.6, z * 0.92), (x, -3.9, z), (x, 3.0 + k * 0.5, z), (x * 1.04, 5.4 + k * 0.4, z * 1.02)]
        mb.sweep(pts, r, 'CrashBrass', col, segs=6)
        for y in (-2.8, 0.0, 2.6):
            mb.box((0.3, 0.12, 0.3), (x, y, z), 'CrashMetal', IRON)
    # Dorsal spine with greebles, a vent stack and the beacon.
    mb.box((1.3, 8.5, 0.5), (0, -0.6, H_ / 2 + 0.1), 'CrashMetal', IRON)
    for y, s in ((-3.6, (0.9, 1.2, 0.5)), (-1.7, (0.6, 0.7, 0.7)), (1.0, (1.0, 1.4, 0.35)), (2.6, (0.5, 0.5, 0.45))):
        mb.box(s, (rng(-0.2, 0.2), y, H_ / 2 + 0.35 + s[2] / 2), 'CrashMetal', STEEL)
    mb.cyl(0.25, 0.3, 1.2, 8, (0.35, -1.7, H_ / 2 + 1.0), 'CrashBrass', BRASS)
    mb.cyl(0.32, 0.32, 0.12, 8, (0.35, -1.7, H_ / 2 + 1.6), 'CrashBrass', BRASS_DK)
    mb.cyl(0.18, 0.18, 0.3, 8, (-0.3, 0.2, H_ / 2 + 0.5), 'CrashMetal', IRON)
    mb.box((0.22, 0.22, 0.22), (-0.3, 0.2, H_ / 2 + 0.75), 'CrashGlow', REDLIGHT)
    mb.beacon_at((-0.3, 0.2, H_ / 2 + 0.8))
    # Cargo door outline on the left flank (rust-red frame) + hazard stripe.
    for z, w in ((1.3, 3.2), (-1.0, 3.2)):
        mb.box((0.1, w, 0.16), (-W_ / 2 - 0.02, -0.6, z), 'CrashPaint', RED)
    for y in (-2.15, 0.95):
        mb.box((0.1, 0.16, 2.4), (-W_ / 2 - 0.02, y, 0.15), 'CrashPaint', RED)
    mb.box((0.1, 0.5, 0.5), (-W_ / 2 - 0.03, 0.6, 0.2), 'CrashMetal', IRON)   # door handle box
    # Engine collar and big riveted brass bell.
    mb.cyl(2.1, 2.1, 0.8, 18, (0, -5.2, 0.0), 'CrashMetal', IRON, rot=(PI / 2, 0, 0))
    bell = T(0, -5.55, 0.0) @ R(x=-PI / 2)
    prof = [(2.0, 0.0), (1.5, -0.5), (1.45, -1.0), (1.75, -1.7), (2.15, -2.3), (2.5, -2.85), (2.34, -2.85),
            (2.02, -2.3), (1.62, -1.7), (1.32, -1.0), (1.36, -0.5), (1.85, 0.0)]
    mb.lathe(prof, 18, 'CrashBrass', BRASS, m=bell, closed=True,
             colfn=lambda i, k: COPPER if k in (2, 3) and i % 2 else None)
    for z, r in ((-1.0, 1.45), (-2.3, 2.15)):
        mb.lathe([(r, z - 0.14), (r + 0.08, z - 0.07), (r + 0.08, z + 0.07), (r, z + 0.14)], 18, 'CrashBrass',
                 BRASS_DK, m=bell, closed=True)
    mb.lathe([(0.0, -0.75), (1.37, -0.75)], 12, 'CrashDark', SOOT, m=bell)
    mb.cyl(0.3, 0.5, 0.5, 8, (0, 0, -1.0), 'CrashMetal', IRON, m=bell)   # injector
    rv = [bell @ Vector((math.cos(a) * 2.43, math.sin(a) * 2.43, -2.7)) for a in (2 * PI * k / 16 for k in range(16))]
    rn = [bell.to_3x3() @ Vector((math.cos(a), math.sin(a), -0.4)) for a in (2 * PI * k / 16 for k in range(16))]
    mb.rivets(rv, rn, 0.07)
    rv = [Vector((math.cos(a) * 2.12, -5.2, math.sin(a) * 2.37)) for a in (2 * PI * (k + 0.5) / 12 for k in range(12))]
    mb.rivets(rv, [Vector((p.x, 0, p.z)) for p in rv], 0.06)
    # Burns + smoke.
    mb.burn((0, 7.8, 0.8), 4.2, 1.0)
    mb.burn((0, -6.0, 0.0), 1.5, 0.6)
    mb.burn((2.8, -1.0, 1.5), 1.8, 0.7)
    mb.smoke_at((0.3, 6.6, 0.8))
    mb.smoke_at((0.0, -7.2, 0.6))
    # Crates still in the hold.
    crate(mb, (1.0, 5.2, -1.0), (1.2, 1.2, 1.2), (0, 0, 0.15), OLIVE, rng)
    crate(mb, (-1.1, 6.4, -0.95), (1.3, 1.1, 1.3), (0.1, 0, -0.3), TEAL, rng)
    crate(mb, (0.9, 5.4, 0.25), (1.0, 1.0, 1.0), (0.0, 0.2, 0.5), RED, rng)
    mb.cap((0, -8.2, 0), (0, -4.0, 0), 3.35)
    mb.cap((0, -4.0, 0), (0, 7.8, 0), 3.4)
    mb.pop()

    # Crates spilled out across the sand (world space), half buried.
    spill = [((1.0, 7.6, 0.05), (1.3, 1.2, 1.1), (0.25, -0.3, 0.6), OLIVE),
             ((-2.0, 8.2, 0.0), (1.1, 1.1, 1.1), (-0.4, 0.2, -0.3), RED),
             ((0.0, 9.4, -0.1), (1.0, 1.4, 0.9), (0.1, 0.5, 1.2), TEAL),
             ((2.5, 9.0, -0.15), (0.9, 0.9, 0.9), (0.7, 0.3, 0.2), CREAM),
             ((-1.2, 10.4, -0.3), (1.2, 1.0, 1.0), (0.3, -0.6, 0.4), OLIVE)]
    for c, s, r, col in spill:
        crate(mb, c, s, r, col, rng)
    mb.cyl(0.35, 0.35, 1.1, 10, (-2.8, 9.9, 0.15), 'CrashBrass', COPPER, rot=(1.3, 0.2, 0.6))  # barrel
    mb.cyl(0.35, 0.35, 1.1, 10, (1.5, 10.8, 0.05), 'CrashPaint', RED, rot=(1.5, 0.0, -0.4))
    mb.sand(0.0, 8.8, 3.6, 3.0, 0.4, yaw=0.25, res=(8, 8))
    mb.cap((1.0, 7.7, 0), (-2.0, 8.2, 0), 0.75)
    mb.cap((0.0, 9.4, 0), (2.5, 9.0, 0), 0.7)
    mb.cap((-1.2, 10.4, 0), (-2.8, 9.9, 0), 0.6)


# ----------------------------------------------------------------------------------------------- pod

def build_pod(mb, rng):
    """Brass escape pod: egg capsule with portholes, blown hatch, retro rockets, sand drag-furrow ahead."""
    pose = T(0, -0.6, 0.45) @ R(x=-0.32, y=0.18, z=0.0)
    mb.push(pose)
    prof = [(0.0, -1.2), (0.5, -1.13), (0.85, -0.85), (1.02, -0.4), (1.05, 0.1), (0.98, 0.55), (0.8, 0.95),
            (0.5, 1.25), (0.2, 1.4), (0.0, 1.43)]
    hatch_i = {(13, 3), (13, 4), (14, 3), (14, 4)}

    def colfn(i, k):
        if k == 3:
            return BRASS_DK
        return None

    mb.lathe(prof, 16, 'CrashBrass', BRASS, colfn=colfn, skip=lambda i, k: (i, k) in hatch_i)
    # Painted bands (cream with teal) around the waist and shoulders.
    mb.lathe([(1.0, -0.42), (1.07, -0.36), (1.09, -0.08), (1.07, 0.02)], 16, 'CrashPaint', CREAM,
             skip=lambda i, k: i in (13, 14))
    mb.lathe([(0.99, 0.5), (1.02, 0.56), (0.92, 0.82), (0.86, 0.86)], 16, 'CrashPaint', TEAL,
             skip=lambda i, k: i in (13, 14) and k == 0)
    mb.lathe([(0.52, 1.24), (0.6, 1.21), (0.3, 1.4), (0.2, 1.42)], 16, 'CrashPaint', RED)
    # Rivet rows along the seams.
    for z, r in ((-0.85, 0.87), (0.95, 0.82)):
        pts = [Vector((math.cos(a) * r, math.sin(a) * r, z)) for a in (2 * PI * (k + 0.3) / 14 for k in range(14))]
        mb.rivets(pts, [Vector((p.x, p.y, 0.3 * (1 if z > 0 else -1))) for p in pts], 0.04)
    # Hatch opening (dark interior), frame, and the blown door hanging off its hinge.
    ha = 2 * PI * 14 / 16
    hn = Vector((math.cos(ha), math.sin(ha), 0.15))
    hp = Vector((math.cos(ha) * 0.86, math.sin(ha) * 0.86, -0.1))
    mb.cyl(0.55, 0.55, 0.6, 10, (0, 0, -0.1), 'CrashDark', SOOT, m=aim(hp - hn * 0.15, hn))
    mb.lathe([(0.52, -0.06), (0.66, -0.06), (0.66, 0.08), (0.52, 0.08)], 12, 'CrashBrass', BRASS_DK,
             m=aim(hp + hn * 0.12, hn), closed=True)
    mb.box((0.18, 0.14, 0.12), (0, 0.6, 0), 'CrashGlow', GLOW, m=aim(hp - hn * 0.15, hn))  # glow inside
    side = hn.cross(Vector((0, 0, 1))).normalized()
    hinge = hp + hn * 0.15 + side * 0.66
    mb.box((0.12, 0.12, 0.5), hinge, 'CrashMetal', STEEL)                     # torn hinge
    door_at = mb.W(hp + hn * 1.3)                                             # blown door lands in the sand
    mb.burn(hp, 1.1, 1.0)
    # Portholes.
    for a, z in ((0.9, 0.3), (2.4, 0.3), (3.9, 0.3)):
        n = Vector((math.cos(a), math.sin(a), 0.25))
        mb.porthole(Vector((math.cos(a) * 1.0, math.sin(a) * 1.0, z)), n, 0.24, rng=rng, depth=0.07)
    # Top: warning light, antenna stub, grab rails; retro rockets at the bottom.
    mb.cyl(0.18, 0.2, 0.15, 8, (0, 0, 1.47), 'CrashMetal', IRON)
    mb.cyl(0.11, 0.08, 0.16, 8, (0, 0, 1.6), 'CrashGlow', REDLIGHT)
    mb.beacon_at((0, 0, 1.6))
    mb.sweep([(0.3, 0.1, 1.3), (0.5, 0.25, 1.9), (0.9, 0.6, 2.25)], 0.02, 'CrashMetal', STEEL, segs=4)
    for a in (0.4, 3.4):
        p0 = Vector((math.cos(a) * 0.62, math.sin(a) * 0.62, 1.12))
        p1 = Vector((math.cos(a + 0.6) * 0.62, math.sin(a + 0.6) * 0.62, 1.12))
        mb.sweep([p0, (p0 + p1) / 2 * 1.18 + Vector((0, 0, 0.08)), p1], 0.03, 'CrashBrass', COPPER, segs=4)
    for k in range(3):
        a = 2 * PI * k / 3 + 0.4
        p = Vector((math.cos(a) * 0.7, math.sin(a) * 0.7, -0.98))
        mb.cyl(0.2, 0.12, 0.4, 8, (0, 0, 0), 'CrashMetal', IRON, m=aim(p, (math.cos(a), math.sin(a), -1.6)))
    # Pipes over the shoulder.
    mb.sweep([(-0.92, -0.3, -0.3), (-1.06, -0.2, 0.3), (-0.82, -0.1, 0.9), (-0.4, 0.0, 1.32)], 0.05,
             'CrashBrass', COPPER, segs=5)
    mb.burn((0, 0, -1.2), 1.6, 0.9)
    mb.smoke_at((0.3, 0.6, 0.0))
    mb.pop()
    mb.cap((0, -0.75, 0), (0, -0.25, 0), 1.15)
    door = T(door_at.x, door_at.y, 0.12) @ R(x=0.45, y=-0.3, z=0.8)
    mb.cyl(0.6, 0.56, 0.12, 12, (0, 0, 0), 'CrashBrass', BRASS, m=door)
    mb.cyl(0.4, 0.4, 0.15, 10, (0, 0, -0.04), 'CrashDark', DARK, m=door)
    mb.box((0.9, 0.1, 0.12), (0, 0, 0.1), 'CrashMetal', IRON, m=door)         # locking bar
    mb.cyl(0.1, 0.1, 0.06, 6, (0.25, 0.2, 0.09), 'CrashPaint', RED, m=door)  # wheel boss
    mb.box((0.16, 0.1, 0.5), (0, 0, -0.12), 'CrashMetal', IRON, m=door @ T(0, 0, -0.35) @ R(x=PI / 2))
    mb.burn(Vector((door_at.x, door_at.y, 0.2)), 0.6, 0.35)
    # Drag furrow ahead of the pod: twin berms with a trough between, piled up against the pod.
    def furrow(u, v):
        t = (v + 1) / 2  # 0 at the pod, 1 at the far end
        berm = 0.32 * (1 - 0.7 * t) * math.exp(-((abs(u) - 0.5) / 0.3) ** 2)
        trough = -0.1 * math.exp(-(u / 0.3) ** 2) * min(1, t * 3)
        pile = 0.55 * math.exp(-(t / 0.25) ** 2) * math.exp(-(u / 0.55) ** 2)
        return berm + trough + pile
    mb.sand(0, 2.55, 1.9, 2.5, 0.0, res=(12, 16), fn=furrow)
    mb.cap((0, 0.8, 0), (0, 0.8, 0), 0.9)


# ------------------------------------------------------------------------------------------- nacelle

def build_nacelle(mb, rng):
    """Detached engine nacelle on its side: open cowling peeled back, bent fan blades, torn pylon."""
    pose = T(0.0, 0.3, 0.72) @ R(y=PI / 2 + 0.18, z=0.45) @ R(x=PI / 2 + 0.07)  # nacelle axis (local Z) ~ horizontal
    mb.push(pose)
    segs = 16
    # Rear cowling: closed-profile shell from the nozzle up to z = 0.9.
    prof = [(1.0, -2.4), (1.3, -1.9), (1.38, -0.6), (1.38, 0.9), (1.22, 0.9), (1.22, -0.6), (1.12, -1.9), (0.88, -2.4)]

    def colfn(i, k):
        if k == 2 and i % 4 == 1:
            return TEAL
        return OLIVE if i % 5 == 2 else CREAM

    mb.lathe(prof, segs, 'CrashPaint', CREAM, closed=True, colfn=colfn)
    mb.lathe([(1.37, -0.05), (1.46, 0.0), (1.46, 0.18), (1.37, 0.22)], segs, 'CrashBrass', BRASS, closed=True)
    mb.lathe([(1.37, -1.4), (1.44, -1.35), (1.44, -1.2), (1.37, -1.15)], segs, 'CrashBrass', BRASS_DK, closed=True)
    pts = [Vector((math.cos(a) * 1.46, math.sin(a) * 1.46, 0.09)) for a in (2 * PI * (k + 0.5) / 16 for k in range(16))]
    mb.rivets(pts, [Vector((p.x, p.y, 0)) for p in pts], 0.045)
    # Front cowling: intact segments as one shell; peeled ones as thin strips curling outwards.
    peeled = {1: 1.1, 2: 1.7, 6: 0.8, 11: 1.4, 12: 0.9}
    front = [(1.38, 0.9), (1.37, 2.2), (1.3, 2.62), (1.2, 2.62), (1.22, 0.9)]
    mb.lathe(front, segs, 'CrashPaint', CREAM, closed=True, skip=lambda i, k: i in peeled,
             colfn=lambda i, k: RED if i % 4 == 0 else (OLIVE if i == 9 else None))
    mb.lathe([(1.3, 2.45), (1.42, 2.5), (1.4, 2.68), (1.26, 2.68)], segs, 'CrashBrass', BRASS, closed=True,
             skip=lambda i, k: i in peeled)
    for k, ang in sorted(peeled.items()):
        a = 2 * PI * (k + 0.5) / segs
        w = 2 * PI * 1.33 / segs
        base = Vector((math.cos(a) * 1.3, math.sin(a) * 1.3, 0.9))
        # Strip frame: x along the tangent, y along the nacelle axis, z outwards.
        frame = Matrix((
            (-math.sin(a), 0, math.cos(a), base.x),
            (math.cos(a), 0, math.sin(a), base.y),
            (0, 1, 0, base.z),
            (0, 0, 0, 1)))
        col = RED if k % 4 == 0 else CREAM
        L = rng(0.5, 0.65)
        m = frame
        for j in range(3):
            m = m @ R(x=ang / 3, y=rng(-0.15, 0.15))
            mb.box((w * (1 - 0.12 * j), L, 0.04), (0, L / 2, 0), 'CrashPaint', col, m=m)
            m = m @ T(0, L, 0)
    # Inner duct (dark), fan with bent blades, brass spinner, stator ring.
    mb.lathe([(1.2, 2.6), (1.2, -1.9)], segs, 'CrashDark', DARK)
    mb.cyl(1.18, 1.18, 0.1, 14, (0, 0, -0.3), 'CrashDark', SOOT)
    hub_z = 1.2
    mb.lathe([(0.0, hub_z + 0.9), (0.18, hub_z + 0.75), (0.36, hub_z + 0.35), (0.42, hub_z - 0.2), (0.0, hub_z - 0.2)],
             10, 'CrashBrass', BRASS)
    for k in range(11):
        a = 2 * PI * k / 11
        bent = k in (2, 3, 7)
        missing = k == 9
        if missing:
            continue
        L = 0.78 if not bent else 0.5
        m = R(z=a) @ T(0.42, 0, hub_z) @ R(x=0.6)
        mb.box((L, 0.32, 0.04), (L / 2, 0, 0), 'CrashMetal', STEEL, m=m)
        if bent:
            m2 = m @ T(L, 0, 0) @ R(y=-0.9 if k != 7 else 0.8, z=0.4)
            mb.box((0.3, 0.28, 0.04), (0.15, 0, 0), 'CrashMetal', STEEL, m=m2)
    mb.lathe([(1.15, 0.2), (1.2, 0.2), (1.2, 0.35), (1.15, 0.35)], 14, 'CrashMetal', IRON, closed=True)
    for k in range(6):
        a = 2 * PI * k / 6 + 0.2
        mb.box((0.8, 0.06, 0.12), (0.75, 0, 0.27), 'CrashMetal', IRON, m=R(z=a))
    # Nozzle: copper cone, soot inside, burnt.
    mb.lathe([(0.98, -2.4), (0.86, -3.0), (0.7, -3.45), (0.62, -3.45), (0.78, -3.0), (0.88, -2.4)], 14,
             'CrashBrass', COPPER, closed=True)
    mb.lathe([(0.25, -3.1), (0.12, -3.5), (0.0, -3.6)], 8, 'CrashMetal', IRON)
    mb.burn((0, 0, -3.2), 2.2, 1.0)
    mb.burn((0, 0, 1.5), 1.3, 0.6)
    mb.smoke_at((0, 0, -3.0))
    mb.smoke_at((0, 0, 1.6))
    # Torn pylon on top (+X of the nacelle frame) with jagged plates and dangling cables.
    mb.box((0.5, 2.6, 0.5), (1.45, 0, -0.6), 'CrashMetal', IRON, rot=(PI / 2, 0, 0))
    mb.box((0.7, 0.35, 2.4), (1.75, 0, -0.6), 'CrashPaint', RED, taper=(0.8, 0.9), rot=(0, PI / 2, 0))
    for k, (dz, rr) in enumerate(((0.3, 0.3), (-0.4, -0.4), (-1.2, 0.5))):
        mb.box((0.6, 0.04, 0.5), (2.1, 0.0, -0.6 + dz), 'CrashMetal', STEEL, rot=(rr, 0.4 * k, 0.6))
    for k in range(4):
        mb.tube((2.0, -0.12 + 0.08 * k, -0.6 + 0.4 * k - 0.6), (2.45, -0.2 + 0.1 * k, -0.4 + 0.5 * k - 0.6), 0.04,
                'CrashBrass', COPPER, segs=5)
    mb.box((0.3, 0.4, 0.3), (1.9, 0.1, 0.4), 'CrashGlow', GLOW)          # sparking junction box
    mb.beacon_at((1.95, 0.1, 0.4))
    mb.burn((2.1, 0, -0.6), 1.3, 1.0)
    cab = [mb.W((2.2, -0.1 + 0.1 * k, -0.9 + 0.35 * k)) for k in range(3)]
    mb.cap((0, 0, -3.5), (0, 0, 2.6), 1.45)
    mb.pop()
    for k, p in enumerate(cab):
        mb.cable(p, Vector((p.x + 0.3 + 0.2 * k, p.y - 0.4 * k, -0.25)), 0.15, 0.035,
                 (RUBBER, CABLE_RED, CABLE_YEL)[k], n=5)
    mb.sand(0.0, 0.0, 3.6, 2.4, 0.3, yaw=0.45 + PI / 2, res=(8, 6),
            fn=lambda u, v: 0.45 * max(0.0, 1 - (abs(u) * 0.8) ** 2) * math.exp(-((abs(v) - 0.62) / 0.2) ** 2))


# ------------------------------------------------------------------------------------------- shuttle

def shuttle_ring(y, w, h, zc=0.0, ch=0.45):
    """Chamfered box section (octagon), 8 points, k=0 at +X lower corner going counter-clockwise."""
    x, z = w / 2, h / 2
    c = min(ch, x * 0.6, z * 0.6)
    pts = [(x, -z + c), (x, z - c), (x - c, z), (-x + c, z), (-x, z - c), (-x, -z + c), (-x + c, -z), (x - c, -z)]
    return [Vector((px, y, zc + pz)) for px, pz in pts]


def build_shuttle(mb, rng):
    """Boxy shuttle on its belly, broken in two: cockpit half with porthole, rear half with bent strut."""
    Wd, Hd = 3.2, 2.6

    def colfn_front(i, k):
        if i <= 1:
            return TEAL if k not in (6, 7) else CREAM_DK
        return CREAM if (i + k) % 5 else CREAM_DK

    def colfn_rear(i, k):
        if k in (6, 7):
            return CREAM_DK
        return OLIVE if (i * 3 + k) % 4 == 1 else CREAM

    # ---- front half (cockpit), y = 0 .. 5.6 in its own frame; torn end at y = 0
    mb.push(T(0.55, 1.15, 0.65) @ R(x=-0.07, y=-0.08, z=0.2))
    jr = Rng(55)
    rings = [shuttle_ring(5.8, 2.0, 1.0, -0.4, 0.3), shuttle_ring(5.0, 3.0, 2.3, -0.12), shuttle_ring(4.0, Wd, Hd, 0.0),
             shuttle_ring(1.0, Wd, Hd, 0.0), shuttle_ring(0.0, Wd, Hd, 0.0)]
    for p in rings[-1]:
        if p.z > -1.0:
            p.y += jr(-0.6, 0.3)
    mb.loft(rings, 'CrashPaint', CREAM, colfn=lambda i, k: colfn_front(i, k), cap0=True,
            skip=lambda i, k: i == 3 and k in (2, 4))
    mb.loft([shuttle_ring(0.5, Wd * 0.94, Hd * 0.94, 0.0), shuttle_ring(3.8, Wd * 0.94, Hd * 0.94, 0.0)],
            'CrashDark', DARK, cap1=True)
    for y in (0.4, 1.3):
        mb.sweep(shuttle_ring(y, Wd * 0.98, Hd * 0.98, 0.0), 0.08, 'CrashMetal', IRON, segs=4, closed=True)
    mb.box((1.4, 0.4, 0.8), (-0.5, 1.2, -0.6), 'CrashMetal', IRON)               # junction box in the hold
    mb.box((0.4, 0.05, 0.3), (-0.5, 0.98, -0.5), 'CrashGlow', GLOW)
    mb.beacon_at((-0.5, 0.95, -0.5))
    # Cockpit: big round porthole on the sloped nose, side portholes, brass trims.
    nose_n = Vector((0, 0.93, 0.8))
    mb.porthole(Vector((0, 5.42, 0.6)), nose_n, 0.42, rng=rng)
    for sx in (-1, 1):
        mb.porthole(Vector((sx * 1.6, 4.3, 0.5)), (sx, 0.0, 0.0), 0.26, rng=rng)
        mb.box((0.12, 3.6, 0.14), (sx * 1.64, 2.2, -0.25), 'CrashBrass', BRASS)
        mb.box((0.04, 3.8, 0.3), (sx * 1.615, 2.1, 0.12), 'CrashPaint', RED)          # side stripe
    mb.box((1.6, 0.6, 0.3), (0, 2.6, 1.42), 'CrashMetal', IRON)
    mb.cyl(0.42, 0.2, 0.2, 8, (0.7, 2.0, 1.65), 'CrashBrass', BRASS, rot=(0.7, 0.4, 0))   # radar dish
    mb.tube((0.7, 2.0, 1.3), (0.7, 2.0, 1.6), 0.04, 'CrashMetal', STEEL)
    mb.box((0.5, 0.5, 0.18), (-0.6, 3.6, 1.36), 'CrashMetal', STEEL)
    mb.cyl(0.08, 0.08, 0.2, 6, (-0.6, 3.6, 1.55), 'CrashGlow', REDLIGHT)
    pts = [Vector((x, 4.0, Hd / 2 + 0.01)) for x in (-1.1, -0.6, -0.1, 0.4, 0.9)]
    mb.rivets(pts, [Vector((0, 0, 1))] * 5, 0.04)
    mb.burn((0, 0.0, 0.3), 2.4, 1.0)
    mb.smoke_at((0.2, 0.3, 0.6))
    mb.cap((0, 5.0, 0), (0, 0.0, 0), 1.75)
    tornA = [mb.W((x, 0.1, 0.9)) for x in (-0.9, 0.2, 1.0)]
    mb.pop()

    # ---- rear half, y = -6 .. 0 in its own frame; torn end at y = 0
    mb.push(T(-0.3, -1.0, 0.68) @ R(x=0.05, y=0.1, z=-0.28))
    rings = [shuttle_ring(-6.0, Wd * 0.92, Hd * 0.9, 0.05), shuttle_ring(-5.4, Wd, Hd, 0.0),
             shuttle_ring(-1.0, Wd, Hd, 0.0), shuttle_ring(0.0, Wd, Hd, 0.0)]
    for p in rings[-1]:
        if p.z > -1.0:
            p.y += jr(-0.3, 0.6)
    mb.loft(rings, 'CrashPaint', CREAM, colfn=lambda i, k: colfn_rear(i, k), cap0=True,
            skip=lambda i, k: i == 2 and k in (1, 3))
    mb.loft([shuttle_ring(-4.5, Wd * 0.94, Hd * 0.94, 0.0), shuttle_ring(-0.3, Wd * 0.94, Hd * 0.94, 0.0)],
            'CrashDark', DARK, cap0=True)
    for y in (-0.3, -1.4):
        mb.sweep(shuttle_ring(y, Wd * 0.98, Hd * 0.98, 0.0), 0.08, 'CrashMetal', IRON, segs=4, closed=True)
    for k in (1, 3, 6):
        p = shuttle_ring(-0.9, Wd * 0.96, Hd * 0.96, 0.0)[k]
        mb.tube(p, p + Vector((rng(-0.3, 0.3), 1.2, rng(-0.2, 0.3))), 0.05, 'CrashMetal', STEEL, segs=4)
    # Engines: two boxy thrusters with copper bells.
    for sx in (-1, 1):
        mb.box((1.0, 1.4, 1.0), (sx * 0.9, -6.3, 0.15), 'CrashMetal', IRON)
        m = T(sx * 0.9, -7.0, 0.15) @ R(x=-PI / 2)
        mb.lathe([(0.35, 0.0), (0.42, -0.3), (0.55, -0.7), (0.48, -0.7), (0.36, -0.32), (0.28, 0.0)], 12,
                 'CrashBrass', COPPER, m=m, closed=True)
        mb.cyl(0.3, 0.3, 0.04, 10, (sx * 0.9, -7.02, 0.15), 'CrashDark', SOOT, rot=(PI / 2, 0, 0))
    mb.box((0.25, 1.6, 0.9), (0, -5.0, 1.75), 'CrashPaint', RED, taper=(1, 0.6))         # dorsal fin
    for k in range(3):
        mb.box((0.6, 0.35, 0.12), (rng(-0.8, 0.8), -2.0 - k * 1.1, Hd / 2 + 0.06), 'CrashMetal', STEEL)
    mb.sweep([(1.45, -5.5, 0.6), (1.7, -5.0, 0.7), (1.7, -1.6, 0.7), (1.55, -1.2, 0.5)], 0.08, 'CrashBrass', BRASS)
    mb.sweep([(-1.55, -5.6, 0.2), (-1.75, -5.0, 0.3), (-1.75, -2.4, 0.3), (-1.6, -2.0, 0.1)], 0.1, 'CrashBrass',
             COPPER)
    for y in (-4.6, -3.0):
        for dz in (-0.18, 0.0, 0.18):
            mb.box((0.06, 0.8, 0.08), (-1.62, y, 0.75 + dz), 'CrashMetal', IRON)         # vent slats
    mb.porthole(Vector((1.6, -2.6, 0.4)), (1, 0, 0.0), 0.24, rng=rng)
    for sx in (-1, 1):
        mb.box((0.04, 4.8, 0.3), (sx * 1.615, -3.2, -0.25), 'CrashPaint', RED)        # side stripe
    # Bent landing strut folded out of the right flank, foot pad in the sand.
    a = Vector((1.5, -4.0, -0.9))
    mb.sweep([a, a + Vector((0.6, 0.0, -0.1)), a + Vector((1.2, 0.5, -0.05)), a + Vector((1.5, 1.0, -0.5))], 0.1,
             'CrashMetal', STEEL, segs=6)
    mb.tube(a + Vector((0.0, -0.4, 0.2)), a + Vector((0.6, 0.0, -0.1)), 0.06, 'CrashMetal', IRON, segs=5)
    mb.cyl(0.38, 0.3, 0.12, 10, (0, 0, 0), 'CrashMetal', IRON, m=T(a + Vector((1.55, 1.1, -0.55))) @ R(x=0.4, y=0.3))
    mb.box((0.06, 1.0, 0.7), (1.62, -4.2, -0.35), 'CrashDark', DARK, rot=(0, 0.5, 0))    # strut bay door
    mb.burn((0, -6.8, 0.2), 2.2, 0.9)
    mb.burn((0, 0.0, 0.4), 2.2, 1.0)
    mb.smoke_at((0.9, -7.2, 0.3))
    mb.cap((0, -7.4, 0), (0, 0.2, 0), 1.75)
    mb.cap((1.6, -4.0, 0), (3.0, -3.0, 0), 0.4)
    tornB = [mb.W((x, -0.1, 0.9)) for x in (-1.0, 0.0, 0.9)]
    mb.pop()
    # Cables spanning the break, sagging into the sand.
    for k in range(3):
        mb.cable(tornA[k], tornB[2 - k] if k != 1 else tornB[1], 1.0 + 0.2 * k, 0.04,
                 (RUBBER, CABLE_RED, CABLE_YEL)[k], n=6)
    mb.sand(0.2, 0.0, 2.6, 1.6, 0.45, yaw=0.0, res=(8, 6))


# --------------------------------------------------------------------------------------------- probe

def build_probe(mb, rng):
    """Crashed probe: brass sphere core half-buried, bent dishes, solar vanes, periscope, beacon."""
    mb.push(T(0, 0, 0.32) @ R(x=0.25, y=-0.2, z=0.3))
    rr = 0.85
    prof = [(math.sin(t) * rr, -math.cos(t) * rr) for t in (PI * k / 8 for k in range(9))]
    prof[0] = (0.0, -rr)
    prof[-1] = (0.0, rr)
    mb.lathe(prof, 14, 'CrashBrass', BRASS, colfn=lambda i, k: BRASS_DK if (i + k) % 6 == 0 else None)
    mb.lathe([(0.84, -0.12), (0.9, -0.08), (0.9, 0.08), (0.84, 0.12)], 14, 'CrashPaint', TEAL, closed=True)
    mb.lathe([(0.58, 0.6), (0.64, 0.62), (0.56, 0.72), (0.5, 0.7)], 14, 'CrashPaint', CREAM, closed=True)
    pts = [Vector((math.cos(a) * 0.86, math.sin(a) * 0.86, 0.18)) for a in (2 * PI * k / 12 for k in range(12))]
    mb.rivets(pts, [Vector((p.x, p.y, 0.2)) for p in pts], 0.035)
    for a in (0.5, 2.2, 3.9):
        n = Vector((math.cos(a), math.sin(a), -0.2))
        mb.box((0.35, 0.28, 0.25), (0, 0, 0.8), 'CrashMetal', IRON, m=aim(Vector(), n))   # equipment boxes
    mb.porthole(Vector((math.cos(5.3) * 0.8, math.sin(5.3) * 0.8, 0.28)), (math.cos(5.3), math.sin(5.3), 0.35),
                0.2, rng=rng, depth=0.06)
    # Big dish, bent and dented, on a strut.
    dm = aim(Vector((0.4, 0.5, 1.2)), (0.4, 0.9, 0.6)) @ R(x=0.35)
    mb.tube((0.25, 0.3, 0.75), dm @ Vector((0, 0, 0)), 0.06, 'CrashMetal', STEEL)
    dish = mb.lathe([(0.12, 0.02), (0.4, 0.08), (0.72, 0.25), (0.75, 0.28)], 12, 'CrashPaint', CREAM, m=dm,
                    jag=lambda i, k: (0.18 if i in (3, 4, 5) and k >= 2 else 0.0))
    mb.lathe([(0.0, 0.0), (0.12, 0.02)], 12, 'CrashBrass', BRASS, m=dm)
    mb.tube(dm @ Vector((0, 0, 0.0)), dm @ Vector((0.05, 0.0, 0.55)), 0.025, 'CrashMetal', STEEL)
    mb.cyl(0.06, 0.04, 0.12, 6, (0.05, 0, 0.58), 'CrashBrass', COPPER, m=dm)
    # Small dish, snapped and hanging.
    sm = aim(Vector((-0.75, -0.2, 0.75)), (-1, -0.2, -0.7))
    mb.tube((-0.55, -0.15, 0.55), sm @ Vector(), 0.04, 'CrashMetal', STEEL)
    mb.lathe([(0.05, 0.0), (0.3, 0.07), (0.4, 0.14)], 10, 'CrashPaint', RED, m=sm)
    # Solar vanes on booms: one intact, one bent down, one snapped and dug into the sand.
    for k, (a, droop, twist, snap) in enumerate(((0.2, 0.15, 0.2, False), (2.3, 0.7, -0.5, False),
                                                  (4.2, 0.0, 0.3, True))):
        d = Vector((math.cos(a), math.sin(a), 0))
        base = d * 0.8 + Vector((0, 0, 0.05))
        if snap:
            mb.cap(base + d * 1.6, base + d * 1.6, 0.7)
            mb.tube(base, base + d * 0.5, 0.05, 'CrashMetal', IRON)
            mb.push(T(base + d * 1.6 + Vector((0, 0, -0.35))) @ R(z=a) @ R(x=0.3, y=-0.9))
        else:
            tip = base + d * 0.9 - Vector((0, 0, droop * 0.5))
            mb.cap(base + d * 0.4, tip + d * 1.6, 0.55)
            mb.tube(base, tip, 0.05, 'CrashMetal', IRON)
            mb.push(T(tip) @ R(z=a) @ R(y=droop, x=twist) @ T(0.95, 0, 0))
        mb.box((1.9, 0.9, 0.04), (0, 0, 0), 'CrashGlass', 0x253a4a)
        for s in (-1, 1):
            mb.box((1.95, 0.05, 0.07), (0, s * 0.46, 0), 'CrashBrass', BRASS)
        for x in (-0.95, 0.0, 0.95):
            mb.box((0.05, 0.9, 0.07), (x, 0, 0), 'CrashBrass', BRASS_DK)
        mb.pop()
    # Periscope: tube up with an elbow and a lens, slightly bent.
    mb.sweep([(-0.15, 0.2, 0.75), (-0.2, 0.25, 1.4), (-0.3, 0.3, 1.75), (-0.6, 0.35, 1.85)], 0.07, 'CrashMetal',
             IRON, segs=6)
    mb.cyl(0.11, 0.11, 0.2, 8, (-0.65, 0.35, 1.86), 'CrashBrass', BRASS, rot=(0, PI / 2, 0))
    mb.cyl(0.08, 0.08, 0.03, 8, (-0.76, 0.35, 1.86), 'CrashGlass', GLASS, rot=(0, PI / 2, 0))
    # Whip antenna, beacon.
    mb.sweep([(0.2, -0.3, 0.75), (0.25, -0.4, 1.6), (0.5, -0.6, 2.1)], 0.02, 'CrashMetal', STEEL, segs=4)
    mb.cyl(0.12, 0.14, 0.14, 8, (0.0, -0.15, 0.86), 'CrashMetal', IRON)
    mb.cyl(0.08, 0.06, 0.12, 8, (0.0, -0.15, 0.98), 'CrashGlow', REDLIGHT)
    mb.beacon_at((0.0, -0.15, 1.0))
    mb.burn((0.3, -0.6, -0.3), 1.3, 1.0)
    mb.smoke_at((0.4, -0.6, 0.3))
    mb.cap((0, 0, 0), (0, 0, 0), 0.95)
    mb.pop()
    mb.sand(-0.2, -0.4, 1.8, 1.6, 0.35, yaw=0.3, res=(8, 8),
            fn=lambda u, v: 0.4 * max(0.0, 1 - (u * u + v * v)) * (0.4 + 0.6 * max(0.0, -v)))


# -------------------------------------------------------------------------------------------- debris

def debris_plate(mb, rng):
    """Curved hull plate with a rib on the back, stuck into the sand at an angle (~2.2 m)."""
    mb.push(T(0, -0.3, 0.0) @ R(x=1.0, z=0.3))
    rings = [[Vector((math.sin(t) * 1.6, y, (math.cos(t) - 1) * 1.6 + 0.4)) for t in (-0.55 + 1.1 * k / 6 for k in range(7))]
             for y in (-0.5, 0.3, 1.1, 1.8)]
    for p in rings[-1]:
        p.y += rng(-0.25, 0.1)
    mb.loft(rings, 'CrashPaint', CREAM, closed=False,
            colfn=lambda i, k: RED if i == 0 else (TEAL if k == 3 else CREAM))
    mb.sweep([Vector((math.sin(t) * 1.55, 0.9, (math.cos(t) - 1) * 1.55 - 0.05)) for t in (-0.5, -0.2, 0.2, 0.5)],
             0.05, 'CrashMetal', IRON, segs=4)
    pts = [Vector((math.sin(t) * 1.61, 0.15, (math.cos(t) - 1) * 1.61)) for t in (-0.4, -0.2, 0.0, 0.2, 0.4)]
    mb.rivets(pts, [Vector((math.sin(t), 0, math.cos(t))) for t in (-0.4, -0.2, 0.0, 0.2, 0.4)], 0.035)
    mb.burn((0.4, 2.0, 0), 1.0, 1.0)
    mb.cap((-0.8, 0.4, 0), (0.8, 0.4, 0), 0.45)
    mb.pop()


def debris_fin(mb, rng):
    """Bent tail fin, rust-red with a cream band, its root torn (~1.8 m)."""
    mb.push(T(0, 0, -0.25) @ R(x=0.25, y=0.15, z=0.9))
    wing(mb, (0, 0.7, 0.0), (0, -0.7, 0.0), (0, 0.0, 0.9), (0, -0.75, 0.9), 0.12, 0.1, 'CrashPaint', RED)
    mb.push(T(0, 0, 0.9) @ R(y=0.6) @ T(0, 0, -0.9))
    wing(mb, (0, 0.0, 0.9), (0, -0.75, 0.9), (0, -0.4, 1.6), (0, -0.85, 1.55), 0.1, 0.08, 'CrashPaint', CREAM)
    mb.pop()
    mb.box((0.18, 1.5, 0.15), (0, 0.0, 0.05), 'CrashMetal', IRON)
    mb.rivets([Vector((0.07, y, 0.3)) for y in (-0.5, -0.2, 0.1, 0.4)], [Vector((1, 0, 0))] * 4, 0.03)
    mb.burn((0, 0.6, 0.2), 0.9, 1.0)
    mb.cap((0, 0.6, 0), (0.3, -0.7, 0), 0.4)
    mb.pop()


def debris_pipes(mb, rng):
    """Bundle of bent brass/copper pipes with clamp bands, lying half in the sand (~2.2 m)."""
    mb.push(T(0, 0, 0.0) @ R(z=0.2))
    for k, (dx, dz, r, col) in enumerate(((0, 0.1, 0.11, BRASS), (0.24, 0.12, 0.09, COPPER), (-0.22, 0.14, 0.08, BRASS),
                                          (0.05, 0.32, 0.07, COPPER))):
        pts = [(dx - 0.1, -1.1, dz - 0.1), (dx, -0.5, dz), (dx + 0.1, 0.4, dz + 0.05),
               (dx + 0.25 + 0.1 * k, 0.9, dz + 0.2 + 0.05 * k), (dx + 0.45 + 0.2 * k, 1.1, dz + 0.5)]
        mb.sweep(pts, r, 'CrashBrass', col, segs=6)
    for y in (-0.6, 0.3):
        mb.box((0.7, 0.12, 0.45), (0.02, y, 0.18), 'CrashMetal', IRON)
    mb.cyl(0.16, 0.16, 0.1, 8, (0.2, -1.1, 0.0), 'CrashBrass', BRASS_DK, rot=(PI / 2, 0, 0))  # flange
    mb.burn((0.3, 1.1, 0.4), 0.8, 0.8)
    mb.cap((0.0, -0.9, 0), (0.3, 0.9, 0), 0.35)
    mb.pop()


def debris_seat(mb, rng):
    """Burnt pilot seat on its frame, tipped over (~1.2 m)."""
    mb.push(T(0, 0, 0.0) @ R(y=0.3, z=0.4))
    mb.box((0.6, 0.6, 0.14), (0, 0, 0.4), 'CrashDark', 0x5a3a26)              # cushion
    mb.box((0.6, 0.14, 0.75), (0, -0.33, 0.8), 'CrashDark', 0x5a3a26, rot=(-0.2, 0, 0))
    mb.box((0.36, 0.12, 0.2), (0, -0.4, 1.3), 'CrashDark', 0x4a3020)          # headrest
    for sx in (-1, 1):
        mb.box((0.06, 0.6, 0.06), (sx * 0.33, 0, 0.3), 'CrashMetal', IRON)
        mb.box((0.06, 0.06, 0.95), (sx * 0.33, -0.38, 0.75), 'CrashMetal', IRON, rot=(-0.2, 0, 0))
        mb.box((0.06, 0.45, 0.06), (sx * 0.35, 0.05, 0.62), 'CrashBrass', BRASS)  # armrest
    mb.tube((0, 0, 0.35), (0, 0, -0.2), 0.07, 'CrashMetal', STEEL)
    mb.cyl(0.32, 0.32, 0.06, 8, (0, 0, -0.18), 'CrashMetal', IRON)
    mb.box((0.05, 0.4, 0.02), (0.15, 0.1, 0.48), 'CrashPaint', RED, rot=(0, 0, 0.3))  # harness strap
    mb.burn((0.1, 0.0, 0.7), 1.0, 0.75)
    mb.cap((0, -0.1, 0), (0, -0.1, 0), 0.5)
    mb.pop()


def debris_porthole(mb, rng):
    """Cracked porthole ring torn out with a patch of hull, standing half-sunk (~1 m)."""
    mb.push(T(0, 0, 0.35) @ R(x=-1.25, z=0.4))
    mb.box((1.2, 1.15, 0.06), (0, 0, -0.06), 'CrashPaint', TEAL, rot=(0, 0, 0.2))
    mb.porthole(Vector((0, 0, 0.0)), (0, 0, 1), 0.45, rng=rng, depth=0.1)
    pts = [Vector((math.cos(a) * 0.6, math.sin(a) * 0.6, -0.02)) for a in (2 * PI * k / 8 for k in range(8))]
    mb.rivets(pts, [Vector((0, 0, 1))] * 8, 0.03)
    mb.burn((0.5, -0.5, 0), 0.8, 1.0)
    mb.cap((0, 0, 0), (0, 0, 0), 0.6)
    mb.pop()


def debris_boiler(mb, rng):
    """Small riveted copper boiler tank on its side with dome cap, valve wheel and pipe stubs (~1.5 m)."""
    mb.push(T(0, 0, 0.35) @ R(y=PI / 2 + 0.12, z=0.3))
    mb.cyl(0.52, 0.52, 1.2, 12, (0, 0, 0), 'CrashBrass', COPPER)
    mb.lathe([(0.52, 0.6), (0.42, 0.78), (0.2, 0.88), (0.0, 0.9)], 12, 'CrashBrass', BRASS)
    mb.lathe([(0.0, -0.75), (0.3, -0.7), (0.52, -0.6)], 12, 'CrashBrass', BRASS_DK)
    for z in (-0.35, 0.35):
        mb.cyl(0.55, 0.55, 0.08, 12, (0, 0, z), 'CrashMetal', IRON)
        pts = [Vector((math.cos(a) * 0.53, math.sin(a) * 0.53, z + 0.07)) for a in (2 * PI * k / 10 for k in range(10))]
        mb.rivets(pts, [Vector((p.x, p.y, 0)) for p in pts], 0.03)
    mb.tube((0.45, 0, 0.1), (0.75, 0, 0.1), 0.06, 'CrashMetal', STEEL)
    mb.cyl(0.16, 0.16, 0.03, 8, (0.78, 0, 0.1), 'CrashPaint', RED, rot=(0, PI / 2, 0))  # valve wheel
    mb.sweep([(-0.2, 0.45, 0.4), (-0.2, 0.7, 0.4), (-0.4, 0.8, 0.0)], 0.05, 'CrashBrass', BRASS, segs=5)
    mb.cyl(0.12, 0.12, 0.06, 8, (0, 0, 0.92), 'CrashMetal', IRON)
    mb.burn((0, -0.3, -0.5), 0.9, 0.9)
    mb.cap((0, 0, -0.7), (0, 0, 0.8), 0.55)
    mb.pop()


def debris_gear(mb, rng):
    """Gear housing jutting out of the sand: drum with a half-exposed toothed gear and an axle (~1.2 m)."""
    mb.push(T(0, 0, 0.0) @ R(x=0.3, y=0.2))
    mb.cyl(0.55, 0.55, 0.5, 12, (0, 0, 0.2), 'CrashMetal', IRON, rot=(PI / 2, 0, 0))
    mb.cyl(0.58, 0.58, 0.08, 12, (0, -0.26, 0.2), 'CrashBrass', BRASS, rot=(PI / 2, 0, 0))
    gm = T(0.15, 0.3, 0.5) @ R(x=PI / 2)
    mb.cyl(0.5, 0.5, 0.12, 14, (0, 0, 0), 'CrashBrass', BRASS_DK, m=gm)
    for k in range(14):
        a = 2 * PI * k / 14
        mb.box((0.14, 0.1, 0.11), (math.cos(a) * 0.55, math.sin(a) * 0.55, 0), 'CrashBrass', BRASS, rot=(0, 0, a),
               m=gm)
    mb.cyl(0.1, 0.1, 0.9, 6, (0.15, 0.25, 0.5), 'CrashMetal', STEEL, rot=(PI / 2, 0, 0))
    mb.box((0.5, 0.6, 0.3), (-0.45, -0.05, 0.55), 'CrashPaint', OLIVE, rot=(0, 0.3, 0))
    pts = [Vector((math.cos(a) * 0.5, -0.31, math.sin(a) * 0.5 + 0.2)) for a in (2 * PI * k / 8 for k in range(8))]
    mb.rivets(pts, [Vector((0, -1, 0))] * 8, 0.03)
    mb.burn((0.3, 0, 0.8), 0.8, 0.7)
    mb.cap((-0.3, 0, 0), (0.3, 0.1, 0), 0.6)
    mb.pop()


# ------------------------------------------------------------------------------------------ dressing
# Ground dressing around the machines that lie at each site (shared/crashsites.ts `machines`, taken apart in
# src/teardown). The origin is the machine's centre; the machine was thrown along three.js +Z (Blender -Y), so
# sand is shoved up ahead of it and what it fell out of lies behind (+Y). Kept clear of the ring where players
# stand to work on it (3.2 m), and low, so walking across the edges doesn't look wrong. No hitboxes.

def mix_hex(a, b, t):
    t = max(0.0, min(1.0, t))
    ca = [(a >> s) & 255 for s in (16, 8, 0)]
    cb = [(b >> s) & 255 for s in (16, 8, 0)]
    r, g, bl = (round(x + (y - x) * t) for x, y in zip(ca, cb))
    return (r << 16) | (g << 8) | bl


def strap(mb, pts, w=0.07, col=CABLE_YEL):
    """Flat cargo strap lying on the ground through pts (x, y): thin boxes end to end."""
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        dx, dy = bx - ax, by - ay
        mb.box((w, math.hypot(dx, dy) + 0.02, 0.02), ((ax + bx) / 2, (ay + by) / 2, 0.03), 'CrashDark', col,
               rot=(0, 0, math.atan2(-dx, dy)))


def dress_cradle(mb, rng):
    """Where a big machine landed: a berm shoved up ahead of it, sand thrown out to the sides, and the torn
    cargo cradle it was strapped into lying behind (~4.5 m out) with snapped straps and ripped-out cables."""
    # The berm it ploughed up on landing, ahead of it.
    mb.sand(0.1, -1.65, 1.9, 0.6, 0.42, yaw=0.06, res=(12, 6))
    mb.sand(-1.9, -0.9, 0.7, 0.45, 0.22, yaw=0.7, res=(6, 5))
    mb.sand(1.95, -0.8, 0.6, 0.4, 0.2, yaw=-0.6, res=(6, 5))
    # Torn cargo cradle: two rails with cross members, tipped up on its back edge, one corner post bent over.
    mb.push(T(0.2, 4.45, 0.02) @ R(x=-0.32, z=0.08))
    for y in (-0.42, 0.42):
        mb.box((3.2, 0.14, 0.16), (0, y, 0.08), 'CrashMetal', IRON)
        mb.box((3.2, 0.05, 0.05), (0, y, 0.19), 'CrashBrass', BRASS_DK)
    for x in (-1.45, -0.5, 0.5, 1.45):
        mb.box((0.12, 0.9, 0.1), (x, 0, 0.06), 'CrashMetal', STEEL)
    for x, y, lean in ((-1.5, -0.42, 0.0), (1.5, -0.42, 0.9), (-1.5, 0.42, 0.25)):
        mb.box((0.1, 0.1, 0.62), (x, y, 0.45), 'CrashMetal', IRON, rot=(lean, 0, 0))
    mb.box((0.1, 0.1, 0.2), (1.5, 0.42, 0.25), 'CrashMetal', IRON)  # snapped-off post stub
    mb.box((0.9, 0.04, 0.5), (-1.0, -0.47, 0.42), 'CrashPaint', RED, rot=(0, 0.05, 0))  # bent side panel
    mb.box((0.35, 0.03, 0.14), (-1.0, -0.5, 0.5), 'CrashPaint', CREAM)                   # stencil band
    mb.rivets([Vector((x, -0.5, 0.2)) for x in (-1.3, -0.7, 0.7, 1.3)], [Vector((0, -1, 0))] * 4, 0.03)
    mb.burn((0.6, 0, 0.3), 1.4, 0.9)
    mb.pop()
    # Snapped straps: from the cradle towards the machine, and one still hooked over a rail, flapping loose.
    strap(mb, [(-1.1, 4.0), (-1.0, 3.5), (-1.25, 3.0), (-1.1, 2.6)])
    strap(mb, [(1.2, 4.0), (1.35, 3.4), (1.1, 3.1)])
    strap(mb, [(0.3, 4.9), (0.55, 5.5), (0.4, 6.0)], col=CABLE_RED)
    mb.box((0.14, 0.1, 0.06), (-1.1, 2.6, 0.05), 'CrashBrass', BRASS, rot=(0, 0, 0.3))  # ratchet buckle
    # Power and data lines torn out with it, trailing back towards the wreck.
    mb.sweep([(-0.4, 4.6, 0.25), (-0.7, 5.4, 0.04), (-0.5, 6.4, 0.02), (-1.1, 7.3, 0.02), (-0.9, 7.9, -0.05)],
             0.04, 'CrashDark', RUBBER, segs=5)
    mb.sweep([(0.9, 4.7, 0.3), (1.2, 5.6, 0.04), (1.7, 6.5, 0.03), (1.6, 7.2, -0.05)], 0.03, 'CrashDark',
             CABLE_RED, segs=4)
    mb.cyl(0.07, 0.05, 0.12, 6, (1.6, 7.2, 0.0), 'CrashBrass', COPPER, rot=(PI / 2, 0, 0.2))  # frayed plug
    # Bolts and a sheared bracket thrown out on the way.
    for x, y in ((-2.1, 1.4), (2.3, 2.0), (0.6, 2.4)):
        mb.cyl(0.05, 0.05, 0.1, 6, (x, y, 0.03), 'CrashMetal', STEEL, rot=(PI / 2, 0, rng(0, PI)))
    mb.box((0.4, 0.08, 0.3), (2.4, 1.2, 0.1), 'CrashMetal', IRON, rot=(0.6, 0.2, 0.9))
    # Smouldering: the scorched ground right beside the machine smokes until it is stripped.
    mb.smoke_at((0.9, -0.4, 0.15))


def dress_skid(mb, rng):
    """Where a small machine came to rest: a furrow mound ahead of it, a snapped strap and a bracket."""
    mb.sand(0, -1.8, 1.15, 0.45, 0.3, yaw=-0.08, res=(8, 5))
    strap(mb, [(0.6, 1.4), (0.75, 2.0), (0.55, 2.5)])
    mb.box((0.35, 0.08, 0.25), (-1.3, 1.6, 0.06), 'CrashMetal', IRON, rot=(0.3, 0.1, 0.7))
    mb.box((0.12, 0.09, 0.05), (0.55, 2.5, 0.04), 'CrashBrass', BRASS, rot=(0, 0, 0.4))


# (node, label, builder, seed, flip). The game wants each wreck's nose (direction of travel) along three.js +Z
# = Blender -Y; builders that model the nose along +Y are turned 180 degrees about Z after building.
MAIN = [
    ('Crash_Fighter', 'Crashed starfighter', build_fighter, 3, True),
    ('Crash_Freighter', 'Freighter hull section', build_freighter, 7, True),   # torn end + spilled crates lead
    ('Crash_Pod', 'Escape pod', build_pod, 11, True),                          # furrow pile is ahead of it
    ('Crash_Nacelle', 'Engine nacelle', build_nacelle, 13, False),             # intake already faces -Y
    ('Crash_Shuttle', 'Broken shuttle', build_shuttle, 17, True),
    ('Crash_Probe', 'Crashed probe', build_probe, 19, False),
]
DEBRIS = [
    ('Hull plate', debris_plate), ('Bent fin', debris_fin), ('Pipe bundle', debris_pipes),
    ('Burnt seat', debris_seat), ('Porthole ring', debris_porthole), ('Boiler tank', debris_boiler),
    ('Gear housing', debris_gear),
]
# Dressing under the machines (never picked as debris). Appended last so the kind indexes above don't move.
DRESSING = [
    ('Crash_Cradle', 'Machine landing (large)', dress_cradle, 211),
    ('Crash_Skid', 'Machine landing (small)', dress_skid, 223),
]


# ------------------------------------------------------------------------------------------------ build

def make_object(name, mb):
    mb.weather(Rng(len(name) * 31 + 7))
    bmesh.ops.dissolve_degenerate(mb.bm, dist=1e-5, edges=mb.bm.edges)
    loose = [v for v in mb.bm.verts if not v.link_faces]
    bmesh.ops.delete(mb.bm, geom=loose, context='VERTS')
    separate_coplanar(mb.bm)
    mb.bm.normal_update()
    mesh = bpy.data.meshes.new(name)
    mb.bm.to_mesh(mesh)
    mb.bm.free()
    for m in mb.mats:
        mesh.materials.append(bpy.data.materials[m])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def capsule_data(obj, caps):
    """Capsules (Blender world, origin = mesh origin) -> dicts in three.js coords; h from the mesh."""
    verts = [v.co for v in obj.data.vertices]
    out = []
    for a, b, r in caps:
        a2, b2 = Vector((a.x, a.y)), Vector((b.x, b.y))
        d = b2 - a2
        half = d.length / 2
        c = (a2 + b2) / 2
        u = d.normalized() if half > 1e-4 else Vector((1, 0))
        top = 0.0
        for v in verts:
            p = Vector((v.x, v.y)) - c
            t = max(-half, min(half, p.dot(u)))
            if (p - u * t).length <= r:
                top = max(top, v.z)
        out.append({'x': c.x, 'z': -c.y, 'ax': u.x, 'az': -u.y, 'half': half, 'r': r, 'h': max(0.3, top)})
    return out


def coverage(obj, caps):
    """Fraction of mesh area at player height (0.3-1.8 m) that lies inside some capsule footprint."""
    me = obj.data
    tot = inside = 0.0
    for p in me.polygons:
        c = p.center
        if not (0.3 < c.z < 1.8) or me.materials[p.material_index].name == 'CrashSand':
            continue
        tot += p.area
        for k in caps:
            q = Vector((c.x - k['x'], -c.y - k['z']))
            u = Vector((k['ax'], k['az']))
            t = max(-k['half'], min(k['half'], q.dot(u)))
            if (q - u * t).length <= k['r'] + 0.05:
                inside += p.area
                break
    return inside / tot if tot else 1.0


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def fmt(x, nd=2):
    s = f'{x:.{nd}f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '', '0') else s


def three(p):
    return [p.x, p.z, -p.y]


def write_ts(kinds, path):
    lines = [
        '// Generated by tools/blender/crashsites.py — do not edit by hand. Model-local three.js coords (Y up, metres).',
        'export type CrashCapsule = { x: number; z: number; ax: number; az: number; half: number; r: number; h: number };',
        'export type CrashKind = {',
        '  /** glTF node name in public/models/crashsites.glb */ node: string;',
        '  /** Short human name */ label: string;',
        '  /** true for a main wreck, false for scatter debris */ main: boolean;',
        '  /** Ground dressing under a machine (shared/crashsites.ts `machines`), never picked as debris */ dressing: boolean;',
        '  /** Horizontal radius (m) enclosing the whole piece */ radius: number;',
        '  capsules: CrashCapsule[];',
        '  /** Where smoke rises from (main wrecks; 1–2 points, e.g. engine, torn hull) */ smoke: [number, number, number][];',
        '  /** Where the electronic beeping comes from (main wrecks; a console, a beacon) */ beacon: [number, number, number];',
        '};',
        'export const CRASH_KINDS: CrashKind[] = [',
    ]
    for k in kinds:
        caps = ', '.join('{ ' + ', '.join(f'{n}: {fmt(c[n], 3 if n in ("ax", "az") else 2)}'
                                           for n in ('x', 'z', 'ax', 'az', 'half', 'r', 'h')) + ' }' for c in k['caps'])
        smoke = ', '.join('[' + ', '.join(fmt(v) for v in three(p)) + ']' for p in k['smoke'])
        beacon = '[' + ', '.join(fmt(v) for v in three(Vector(k['beacon']))) + ']'
        lines.append('  {')
        lines.append(f"    node: '{k['node']}',")
        lines.append(f"    label: '{k['label']}',")
        lines.append(f"    main: {'true' if k['main'] else 'false'},")
        lines.append(f"    dressing: {'true' if k['dressing'] else 'false'},")
        lines.append(f"    radius: {fmt(k['radius'])},")
        lines.append(f'    capsules: [{caps}],')
        lines.append(f'    smoke: [{smoke}],')
        lines.append(f'    beacon: {beacon},')
        lines.append('  },')
    lines.append('];')
    lines.append('')
    with open(path, 'w') as f:
        f.write('\n'.join(lines))


def build_all():
    kinds = []
    objs = []
    entries = [(n, l, fn, s, True, f, False) for n, l, fn, s, f in MAIN] + \
              [(f'Crash_Debris_{i + 1}', l, fn, 101 + i * 7, False, False, False) for i, (l, fn) in enumerate(DEBRIS)] + \
              [(n, l, fn, s, False, False, True) for n, l, fn, s in DRESSING]
    for name, label, fn, seed, main, flip, dressing in entries:
        mb = MeshBuilder()
        fn(mb, Rng(seed))
        if flip:
            rz = R(z=PI)
            bmesh.ops.transform(mb.bm, matrix=rz, verts=mb.bm.verts)
            mb.burns = [(rz @ c, r, st) for c, r, st in mb.burns]
            mb.caps = [(rz @ a, rz @ b, r) for a, b, r in mb.caps]
            mb.smoke = [rz @ q for q in mb.smoke]
            mb.beacon = rz @ Vector(mb.beacon)
        caps, smoke, beacon = mb.caps, mb.smoke, mb.beacon
        obj = make_object(name, mb)
        cd = capsule_data(obj, caps)
        radius = max(math.hypot(v.co.x, v.co.y) for v in obj.data.vertices)
        kinds.append({'node': name, 'label': label, 'main': main, 'dressing': dressing, 'radius': radius, 'caps': cd,
                      'smoke': smoke if main or dressing else [], 'beacon': beacon if main else (0, 0, 0), 'obj': obj})
        objs.append(obj)
    return kinds, objs


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


# ------------------------------------------------------------------------------------------------ render

def setup_scene():
    scene = bpy.context.scene
    for engine in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x, scene.render.resolution_y = 1400, 900
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.exposure = 0.0
    bpy.ops.mesh.primitive_plane_add(size=600, location=(0, 0, 0))
    ground = bpy.context.active_object
    ground.name = 'ground'
    gm = bpy.data.materials.new('ground')
    b = gm.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*lin(SAND), 1)
    b.inputs['Roughness'].default_value = 1.0
    ground.data.materials.append(gm)
    world = scene.world or bpy.data.worlds.new('world')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (0.55, 0.27, 0.13, 1)
    bg.inputs['Strength'].default_value = 0.55
    data = bpy.data.lights.new('sun', 'SUN')
    data.energy = 5.0
    data.color = (1.0, 0.74, 0.48)
    data.angle = math.radians(1.5)
    sun = bpy.data.objects.new('sun', data)
    sun.rotation_euler = (math.radians(90 - 17), 0, math.radians(-30))  # 17 deg elevation
    scene.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.clip_end = 1000
    return scene, cam, ground


def look(cam, target, az, el, dist, lens=40):
    target = Vector(target)
    d = Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
    cam.location = target + d * dist
    cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = lens


def capsule_wire(k, offset, mat):
    bm = bmesh.new()
    for c in k['caps']:
        cx, cy = c['x'], -c['z']
        ux, uy = c['ax'], -c['az']
        pts = []
        for s in (1, -1):
            ex, ey = cx + ux * c['half'] * s, cy + uy * c['half'] * s
            base = math.atan2(uy, ux) * 1.0 + (0 if s > 0 else PI)
            for j in range(9):
                a = base - PI / 2 + PI * j / 8
                pts.append((ex + math.cos(a) * c['r'], ey + math.sin(a) * c['r']))
        lo = [bm.verts.new((x, y, 0.02)) for x, y in pts]
        hi = [bm.verts.new((x, y, c['h'])) for x, y in pts]
        n = len(pts)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new([lo[i], lo[j], hi[j], hi[i]])
    me = bpy.data.meshes.new('caps_' + k['node'])
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new('caps_' + k['node'], me)
    o.location = offset
    bpy.context.scene.collection.objects.link(o)
    me.materials.append(mat)
    mod = o.modifiers.new('wire', 'WIREFRAME')
    mod.thickness = 0.05
    return o


def render_previews(kinds, out_dir, only=None):
    os.makedirs(out_dir, exist_ok=True)
    scene, cam, ground = setup_scene()
    objs = [k['obj'] for k in kinds]

    def shoot(path):
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)

    # Per-wreck 3/4 views (each alone at the origin).
    for k in kinds:
        if not k['main'] or (only and k['node'] not in only):
            continue
        for o in objs:
            o.hide_render = o is not k['obj']
        r = k['radius']
        az = {'Crash_Nacelle': -15}.get(k['node'], -60)
        look(cam, (0, 0, r * 0.12), math.radians(az), math.radians(20), r * 1.45 + 2.5, lens=35)
        shoot(os.path.join(out_dir, k['node'] + '.png'))
        look(cam, (0, 0, r * 0.12), math.radians(az + 180), math.radians(24), r * 1.45 + 2.5, lens=35)
        shoot(os.path.join(out_dir, k['node'] + '_back.png'))
    # Machine landings, each with a grey stand-in box of the machine (pump housing / robot arm size) and a ring
    # where players stand to work (3.2 m), then the big one beside a wreck as the game places it.
    stand_mat = bpy.data.materials.new('standin')
    stand_mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (0.25, 0.27, 0.3, 1)
    extra = []
    for k in kinds:
        if not k['dressing'] or (only and k['node'] not in only):
            continue
        for o in objs + extra:
            o.hide_render = True
        k['obj'].hide_render = False
        big = k['node'] == 'Crash_Cradle'
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.6 if big else 0.55))
        box = bpy.context.active_object
        box.scale = (2.8, 0.9, 1.25) if big else (2.0, 2.5, 1.1)
        box.data.materials.append(stand_mat)
        bpy.ops.mesh.primitive_torus_add(major_radius=3.2, minor_radius=0.03, location=(0, 0, 0.05))
        ring = bpy.context.active_object
        ring.data.materials.append(stand_mat)
        extra += [box, ring]
        look(cam, (0, 1.5, 0.3), math.radians(-50), math.radians(28), 13, lens=35)
        shoot(os.path.join(out_dir, k['node'] + '.png'))
        look(cam, (0, 1.5, 0.3), math.radians(130), math.radians(24), 13, lens=35)
        shoot(os.path.join(out_dir, k['node'] + '_back.png'))
        ring.hide_render = True
        if big:
            fighter = next(q for q in kinds if q['node'] == 'Crash_Fighter')
            fighter['obj'].hide_render = False
            fighter['obj'].location = (0, 0, 0)
            # Machine 9 m off the wreck's left side, thrown away from it (its +Y, the cradle side, faces the wreck).
            for o in (k['obj'], box):
                o.location = (o.location.x - 9.5, o.location.y, o.location.z)
                o.rotation_euler = (0, 0, -PI / 2)
            look(cam, (-5, 0, 0.5), math.radians(-120), math.radians(30), 24, lens=35)
            shoot(os.path.join(out_dir, 'site_fighter.png'))
            for o in (k['obj'], box):
                o.location = (0, 0, o.location.z)
                o.rotation_euler = (0, 0, 0)
        box.hide_render = True
    for k in kinds:
        k['obj'].hide_render = False
    if only:
        return
    # Debris lineup.
    for o in objs:
        o.hide_render = True
    deb = [k for k in kinds if not k['main'] and not k['dressing']]
    for i, k in enumerate(deb):
        k['obj'].hide_render = False
        k['obj'].location = (i * 3.2 - (len(deb) - 1) * 1.6, 0, 0)
    look(cam, (0, 0, 0.4), math.radians(-90), math.radians(22), 25, lens=45)
    shoot(os.path.join(out_dir, 'debris.png'))
    # Overview: mains in a 3x2 grid, debris in a row in front.
    layout = {}
    mains = [k for k in kinds if k['main']]
    for i, k in enumerate(mains):
        layout[k['node']] = Vector(((i % 3 - 1) * 21, (1 - i // 3) * 22 + 4, 0))
    for i, k in enumerate(deb):
        layout[k['node']] = Vector((i * 4.5 - (len(deb) - 1) * 2.25, -18, 0))
    for k in kinds:
        k['obj'].hide_render = k['node'] not in layout
        k['obj'].location = layout.get(k['node'], Vector((0, 0, 0)))
    look(cam, (0, 4, 0), math.radians(-80), math.radians(32), 66, lens=35)
    shoot(os.path.join(out_dir, 'overview.png'))
    # Low ground: the terrain half a metre below every origin; nothing should float.
    ground.location.z = -0.5
    look(cam, (0, 4, 0), math.radians(-100), math.radians(14), 66, lens=35)
    shoot(os.path.join(out_dir, 'overview_lowground.png'))
    ground.location.z = 0.0
    # Capsule debug: wireframes over the overview, from above.
    wm = bpy.data.materials.new('wire')
    wb = wm.node_tree.nodes.get('Principled BSDF')
    wb.inputs['Base Color'].default_value = (0.1, 1.0, 0.3, 1)
    wb.inputs['Emission Color'].default_value = (0.1, 1.0, 0.3, 1)
    wb.inputs['Emission Strength'].default_value = 3.0
    for k in kinds:
        if k['node'] in layout:
            capsule_wire(k, layout[k['node']], wm)
    look(cam, (0, 7, 0), math.radians(-90), math.radians(80), 90, lens=35)
    shoot(os.path.join(out_dir, 'capsules.png'))
    for k in mains:
        if True:
            p = layout[k['node']]
            look(cam, p, math.radians(-60), math.radians(62), k['radius'] * 2.2 + 5, lens=35)
            shoot(os.path.join(out_dir, 'capsules_' + k['node'] + '.png'))
    for k in kinds:
        k['obj'].location = (0, 0, 0)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models', 'crashsites.glb'))
    ap.add_argument('--ts', default=os.path.join(ROOT, 'shared', 'crashKinds.ts'))
    ap.add_argument('--preview', default=None, help='directory for PNG previews')
    ap.add_argument('--only', default=None, help='comma-separated node names: render just their 3/4 views')
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in MATERIALS.items():
        make_material(name, *spec)
    kinds, objs = build_all()
    bpy.context.view_layer.update()
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    export_glb(objs, args.out)
    write_ts(kinds, args.ts)
    for k in kinds:
        o = k['obj']
        zs = [v.co.z for v in o.data.vertices]
        print(f"{o.name}: tris={tri_count(o)} mats={[m.name for m in o.data.materials]} radius={k['radius']:.2f} "
              f"z {min(zs):.2f}..{max(zs):.2f} caps={len(k['caps'])} coverage={coverage(o, k['caps']):.2f}")
    print('total tris', sum(tri_count(o) for o in objs))
    if args.preview:
        render_previews(kinds, os.path.abspath(args.preview), args.only.split(',') if args.only else None)


main()
