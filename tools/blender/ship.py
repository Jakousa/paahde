"""The crashed ship the players arrive at (shared/ship.ts), exported as one glTF binary + a generated TS table.

    blender -b --python tools/blender/ship.py                       # writes the glb + shared/shipModel.ts
    blender -b --python tools/blender/ship.py -- --preview <dir>    # also renders PNG previews into <dir>

A mid-size cargo lander, ~28 m from nose to engine bells, come down on its belly at the origin of the world: nose
ploughed into the sand, rolled onto its right side, the right wing's tip dug in, the left wing torn off and lying back
along the furrow it made with a hull plate and a landing leg. A tall swept tail fin with a red lamp on top is what
you see of it from far off. The cargo door on the left flank is down as a ramp onto the sand (the players walked out of
it); the upper right flank is torn open over the hold, ribs showing.

Built with the crash sites' kit (tools/blender/crashsites.py: MeshBuilder, the materials, palette and weathering), so
it reads as one of them, only bigger and newer. Blender is Z-up; the nose points along Blender -Y, which is three.js +Z
(three = (x, z, -y)). Every node sits at the scene origin with identity transform, its origin on the ground at the
piece's centre; the hull's belly and the debris go 0.5-1 m under it, so nothing floats on uneven sand.

shared/shipModel.ts gets each node's collision capsules (model-local three.js x/z, top h above the origin), its radius,
where the debris lies along the furrow (ship-local), and a few points (the spawn at the foot of the ramp, the fin's lamp).
"""

import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crashsites as cs  # noqa: E402
from crashsites import (BRASS, BRASS_DK, CABLE_RED, CABLE_YEL, COPPER, CREAM, CREAM_DK, DARK, GLOW, IRON, OLIVE,  # noqa: E402
                        PI, R, RED, REDLIGHT, RUBBER, RUST, SOOT, STEEL, TEAL, T, MeshBuilder, Rng, se_ring)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

# The hull's pose: its centre line this high over the ground, pitched nose-down, rolled onto its right (+X) side.
HULL_Z = 1.75
PITCH = 0.1
ROLL = 0.14

# Fuselage sections, tail -> nose: (y, width, height, centre z).
SECTIONS = [(12.6, 3.6, 2.8, 0.5), (11.6, 5.0, 3.7, 0.35), (10.0, 5.9, 4.2, 0.2), (8.0, 6.3, 4.4, 0.1),
            (5.0, 6.6, 4.6, 0.0), (2.0, 6.7, 4.6, 0.0), (-1.0, 6.7, 4.6, 0.0), (-4.0, 6.5, 4.4, -0.05),
            (-6.5, 6.0, 4.1, -0.15), (-8.5, 5.2, 3.6, -0.25), (-10.5, 4.0, 2.9, -0.4), (-12.2, 2.4, 1.8, -0.55),
            (-13.3, 0.7, 0.6, -0.7)]
SEGS = 20
N_TOP, N_BOT = 2.6, 2.0


def ring(i, scale=1.0, segs=SEGS):
    y, w, h, zc = SECTIONS[i]
    return se_ring(y, w * scale, h * scale, segs, zc, n=N_TOP, nb=N_BOT)


def at_y(y, scale=1.0, segs=SEGS):
    """A section at any y, interpolated between SECTIONS."""
    for a, b in zip(SECTIONS, SECTIONS[1:]):
        if b[0] <= y <= a[0]:
            t = (a[0] - y) / (a[0] - b[0])
            w, h, zc = (a[k] + (b[k] - a[k]) * t for k in (1, 2, 3))
            return se_ring(y, w * scale, h * scale, segs, zc, n=N_TOP, nb=N_BOT)
    raise ValueError(y)


def slab(mb, pts, t0, t1, axis, mat, col):
    """A thin tapered slab (a fin, a wing): four mid-plane corners (root LE, tip LE, tip TE, root TE), thickness t0 at
    the root and t1 at the tip along unit `axis`."""
    ax = Vector(axis).normalized()
    th = [t0, t1, t1, t0]
    lo = [Vector(p) - ax * (t / 2) for p, t in zip(pts, th)]
    hi = [Vector(p) + ax * (t / 2) for p, t in zip(pts, th)]
    return mb.poly_prism(lo, hi, mat, col)


class Ship:
    """Records named points (in the model's own space) next to the MeshBuilder's capsules."""

    def __init__(self):
        self.points = {}
        self.steps = []  # (a, b, r, h): capsules with a given top (the ramp's treads), not one read off the mesh

    def point(self, mb, name, p):
        self.points[name] = mb.W(p)


def build_hull(mb, rng, ship):
    mb.push(T(0, 0, HULL_Z) @ R(x=PITCH) @ R(y=ROLL))
    rings = [ring(i) for i in range(len(SECTIONS))]
    # The tear over the hold: upper right flank, between y +5 and -1.
    hole = {(4, 2), (4, 3), (5, 2), (5, 3), (5, 4), (4, 1)}

    def colfn(i, k):
        if i >= 10:
            return RED if k not in (14, 15, 16) else CREAM_DK          # red nose
        if 12 <= k <= 18:
            return CREAM_DK                                           # belly
        if k in (1, 9) and 2 <= i <= 9:
            return TEAL                                               # side bands
        if i <= 1:
            return OLIVE if k % 3 else CREAM_DK                       # tail cone
        if (i * 7 + k * 3) % 13 == 0:
            return OLIVE
        return CREAM

    mb.loft(rings, 'CrashPaint', CREAM, colfn=colfn, cap0=True, cap1=True, skip=lambda i, k: (i, k) in hole)
    # The hold behind the tear: dark inner skin, a deck, crates, ribs across the gap.
    inner = [at_y(y, 0.95, 16) for y in (6.0, 3.5, -2.0)]
    mb.loft(inner, 'CrashDark', DARK, cap0=True, cap1=True)
    mb.box((5.0, 6.5, 0.12), (0, 2.2, -1.25), 'CrashMetal', IRON)
    for y in (4.2, 2.6, 1.0, -0.6):
        r_ = [p for k, p in enumerate(at_y(y, 0.985, 20)) if k <= 6]
        mb.sweep(r_, 0.1, 'CrashMetal', IRON, segs=4)
    for k in (2, 3):
        a = at_y(4.6, 1.0, 20)[k]
        mb.sweep([a, a + Vector((0.5, -0.4, 0.5)), a + Vector((0.9, -1.2, 0.6))], 0.05, 'CrashMetal', STEEL, segs=4)
    for p, flap_col in ((at_y(4.9, 1.0, 20)[3], CREAM), (at_y(-0.9, 1.0, 20)[2], TEAL)):
        mb.push(T(p) @ R(z=0.3, y=-0.8))
        mb.box((1.2, 1.0, 0.05), (0.4, 0, 0.3), 'CrashPaint', flap_col)
        mb.pop()
    cs.crate(mb, (1.2, 3.0, -0.6), (1.2, 1.2, 1.2), (0, 0, 0.2), OLIVE, rng)
    cs.crate(mb, (1.6, 1.4, -0.75), (1.0, 1.0, 1.0), (0.1, 0, -0.4), TEAL, rng)
    mb.burn((2.6, 2.0, 1.6), 3.2, 1.0)
    ship.point(mb, 'hole', (2.6, 2.0, 1.4))

    # Seam bands with rivets, portholes along both flanks, a red stripe down each side.
    for y in (8.0, 2.0, -4.0, -8.5):
        mb.sweep(at_y(y, 1.012, 16), 0.06, 'CrashBrass', BRASS, segs=4, closed=True)
        top = [p for p in at_y(y + 0.18, 1.006, 14) if p.z > 0.3]
        mb.rivets(top, [Vector((p.x, 0, p.z)) for p in top], 0.05)
    for side in (1, -1):
        for y in (7.0, 5.6, -5.5, -7.0):
            if side > 0 and 1 < y < 6:
                continue
            p = at_y(y, 1.0, 20)[1 if side > 0 else 9]
            mb.porthole(p, (side, 0, 0.35), 0.3, rng=rng)
        mb.box((0.06, 14.0, 0.28), (side * 3.33, 1.0, -0.65), 'CrashPaint', RED)

    # The cargo door on the left flank, down: a dark opening in a red frame, a lamp inside; the ramp is built below.
    W2 = 3.36
    mb.box((0.1, 3.0, 2.3), (-W2 + 0.02, -2.4, 0.0), 'CrashDark', SOOT)
    for z in (1.2, -1.15):
        mb.box((0.14, 3.3, 0.16), (-W2, -2.4, z), 'CrashPaint', RED)
    for y in (-0.8, -4.0):
        mb.box((0.14, 0.16, 2.5), (-W2, y, 0.0), 'CrashPaint', RED)
    mb.box((0.06, 0.6, 0.16), (-W2 + 0.1, -2.4, 0.9), 'CrashGlow', GLOW)
    mb.beacon_at((-W2 + 0.2, -2.4, 0.9))
    hinge = [mb.W((-W2, y, -1.15)) for y in (-0.95, -3.85)]

    # Cockpit glazing over the nose: a band of dark panes in brass frames, one smashed.
    lo, hi = at_y(-9.0, 1.015, 20), at_y(-11.3, 1.015, 20)
    panes = [(lo[k], lo[k + 1], hi[k + 1], hi[k]) for k in range(3, 7)]
    for j, q in enumerate(panes):
        if j == 2:
            continue
        mb.poly_prism([q[0], q[1], q[2], q[3]], [p + Vector((0, 0, 0.03)) for p in q], 'CrashGlass', cs.GLASS)
    mb.sweep([lo[k] for k in range(3, 8)], 0.05, 'CrashBrass', BRASS, segs=4)
    mb.sweep([hi[k] for k in range(3, 8)], 0.05, 'CrashBrass', BRASS, segs=4)
    for k in range(3, 8):
        mb.tube(lo[k], hi[k], 0.04, 'CrashBrass', BRASS_DK, segs=4)
    mb.burn((0, -12.5, -0.4), 2.6, 0.7)

    # Dorsal spine: a raised fairing with vents, a dish, an antenna mast.
    mb.box((1.2, 9.0, 0.45), (0, -2.0, 2.4), 'CrashMetal', IRON)
    for y, s in ((-5.5, (0.9, 1.2, 0.4)), (-3.2, (0.6, 0.8, 0.6)), (-0.5, (0.9, 1.4, 0.3))):
        mb.box(s, (rng(-0.2, 0.2), y, 2.62 + s[2] / 2), 'CrashMetal', STEEL)
    mb.cyl(0.9, 0.35, 0.35, 12, (0.4, -6.8, 2.85), 'CrashBrass', BRASS, rot=(0.5, -0.3, 0))
    mb.tube((-0.3, -1.6, 2.6), (-0.4, -1.4, 4.6), 0.05, 'CrashMetal', STEEL, segs=4)
    for k in range(4):
        mb.tube((-0.36, -1.5, 3.2 + k * 0.4), (-0.75 + k * 0.05, -1.5, 3.2 + k * 0.4), 0.025, 'CrashMetal', STEEL, segs=3)

    # The tail fin: tall, swept, cream with a teal band and a red tip, the lamp on top.
    X = (1, 0, 0)
    slab(mb, [(0, 5.2, 2.1), (0, 9.9, 7.2), (0, 12.2, 7.0), (0, 12.6, 1.4)], 0.6, 0.4, X, 'CrashPaint', CREAM)
    slab(mb, [(0, 9.9, 7.2), (0, 10.4, 7.9), (0, 12.4, 7.7), (0, 12.2, 7.0)], 0.4, 0.38, X, 'CrashPaint', TEAL)
    slab(mb, [(0, 10.4, 7.9), (0, 12.4, 10.6), (0, 13.6, 10.5), (0, 12.4, 7.7)], 0.38, 0.26, X, 'CrashPaint', CREAM)
    slab(mb, [(0, 12.4, 10.6), (0, 12.8, 11.2), (0, 13.9, 11.1), (0, 13.6, 10.5)], 0.26, 0.24, X, 'CrashPaint', RED)
    for z in (3.0, 4.6, 6.2):
        mb.box((0.66, 0.08, 0.08), (0, 7.0 + (z - 2.0) * 0.9, z), 'CrashBrass', BRASS_DK)
    mb.box((0.3, 0.6, 0.12), (0, 13.3, 11.2), 'CrashMetal', IRON)
    mb.cyl(0.14, 0.14, 0.24, 8, (0, 13.3, 11.4), 'CrashGlow', REDLIGHT)
    ship.point(mb, 'light', (0, 13.3, 11.45))
    # A bite out of the fin's trailing edge (a dark gash with a bent stringer).
    mb.box((0.62, 0.9, 0.6), (0, 12.1, 5.0), 'CrashDark', SOOT, rot=(0.3, 0, 0))
    mb.tube((0, 11.8, 4.8), (0.6, 12.8, 5.3), 0.04, 'CrashMetal', STEEL, segs=4)

    # Stabilisers: the left one up, the right torn to a stump.
    Z = (0, 0, 1)
    slab(mb, [(-2.4, 9.0, 0.6), (-6.2, 11.6, 1.1), (-6.2, 12.6, 1.1), (-2.2, 12.5, 0.6)], 0.35, 0.18, Z, 'CrashPaint', CREAM)
    slab(mb, [(-6.0, 11.6, 1.1), (-6.4, 11.8, 1.15), (-6.4, 12.7, 1.15), (-6.0, 12.6, 1.1)], 0.2, 0.2, Z, 'CrashPaint', RED)
    slab(mb, [(2.4, 9.2, 0.6), (3.6, 10.4, 0.7), (3.4, 12.0, 0.7), (2.2, 12.5, 0.6)], 0.35, 0.3, Z, 'CrashPaint', CREAM_DK)
    mb.tube((3.4, 10.6, 0.7), (4.3, 10.9, 0.5), 0.05, 'CrashMetal', IRON, segs=4)

    # Engines: two nacelles low on the tail, copper bells sooted inside.
    for sx in (-1, 1):
        x = sx * 2.1
        mb.cyl(1.05, 0.95, 5.0, 14, (x, 10.6, -0.5), 'CrashMetal', IRON, rot=(PI / 2, 0, 0))
        for y in (9.0, 11.2, 12.8):
            mb.cyl(1.1, 1.1, 0.14, 14, (x, y, -0.5), 'CrashBrass', BRASS, rot=(PI / 2, 0, 0))
        bell = T(x, 13.1, -0.5) @ R(x=-PI / 2)
        mb.lathe([(0.9, 0.0), (0.72, -0.3), (0.8, -0.7), (1.05, -1.2), (0.95, -1.2), (0.7, -0.7), (0.62, -0.3),
                  (0.8, 0.0)], 14, 'CrashBrass', COPPER, m=bell, closed=True)
        mb.lathe([(0.0, -0.4), (0.65, -0.4)], 10, 'CrashDark', SOOT, m=bell)
        mb.burn((x, 13.8, -0.5), 1.6, 0.8)
    mb.burn((0, 13.0, 0.2), 2.0, 0.5)
    ship.point(mb, 'engine', (2.1, 13.8, -0.5))

    # The right wing, still on: drooping, its tip ploughed into the sand by the roll.
    slab(mb, [(3.0, 0.5, -0.9), (9.8, 5.0, -1.5), (9.6, 7.4, -1.5), (3.0, 7.8, -0.9)], 0.55, 0.22, Z, 'CrashPaint', CREAM)
    slab(mb, [(7.0, 3.1, -1.31), (9.8, 5.0, -1.48), (9.6, 7.4, -1.48), (7.0, 7.55, -1.31)], 0.36, 0.26, Z, 'CrashPaint', RED)
    for y in (2.4, 5.0):
        mb.box((3.0, 0.1, 0.06), (5.0, y + 0.3, -0.7), 'CrashBrass', BRASS_DK, rot=(0, -0.09, 0.0))
    mb.cyl(0.32, 0.32, 2.2, 8, (6.0, 6.4, -1.5), 'CrashMetal', IRON, rot=(PI / 2, 0, 0))   # flap actuator pod
    # The left wing's root: torn off, spars and cables out of the stump.
    slab(mb, [(-3.0, 0.5, -0.9), (-4.6, 2.0, -1.0), (-4.4, 7.0, -1.0), (-3.0, 7.8, -0.9)], 0.55, 0.45, Z, 'CrashPaint', CREAM_DK)
    for y, d in ((2.4, (-1.2, -0.2, 0.4)), (4.4, (-1.0, 0.3, -0.3)), (6.2, (-1.4, 0.1, 0.1))):
        mb.tube((-4.4, y, -1.0), Vector((-4.4, y, -1.0)) + Vector(d), 0.07, 'CrashMetal', STEEL, segs=5)
    stump = [mb.W((-4.5, y, -1.05)) for y in (3.0, 4.0, 5.2)]
    mb.burn((-4.4, 4.0, -1.0), 2.0, 1.0)

    # Capsules (the hull's frame) with their tops over the ground: the hull's back (not the fin, which has its own thin
    # one: they shade too, shared/shade.ts), the engines across the tail, the wing, the left stabiliser.
    def cap(a, b_, r, h):
        ship.steps.append((mb.W(a), mb.W(b_), r, h))
    cap((0, -12.8, 0), (0, 12.0, 0), 3.25, 4.7)
    cap((0, 6.5, 0), (0, 13.6, 0), 0.4, 14.4)
    cap((-2.1, 13.2, 0), (2.1, 13.2, 0), 1.1, 3.4)
    cap((4.6, 3.8, 0), (8.8, 6.0, 0), 1.6, 1.6)
    cap((-5.4, 11.5, 0), (-3.4, 11.2, 0), 0.9, 3.4)
    mb.pop()

    # The ramp, from the door's sill down onto the sand, out to the left; treads, two rails.
    a, b = hinge
    out = Vector((-1, 0, 0))
    foot = [p + out * 2.6 for p in (a, b)]
    for p in foot:
        p.z = -0.12
    rail = []
    for p0, p1 in ((a, foot[0]), (b, foot[1])):
        inward = (b - a).normalized() * (0.12 if p0 is a else -0.12)
        rail.append((p0 + inward, p1 + inward))
    n = Vector((0, 0, 1))
    pts = [a, b, foot[1], foot[0]]
    mb.poly_prism(pts, [p + n * 0.1 for p in pts], 'CrashMetal', STEEL)
    for k in range(1, 6):
        t = k / 6
        p0, p1 = a.lerp(foot[0], t), b.lerp(foot[1], t)
        mb.tube(p0 + n * 0.12, p1 + n * 0.12, 0.035, 'CrashMetal', IRON, segs=4)
    for p0, p1 in rail:
        mb.tube(p0 + n * 0.15, p1 + n * 0.15, 0.06, 'CrashPaint', RED, segs=4)
    for p in (a, b):
        mb.cyl(0.12, 0.12, 0.3, 8, p, 'CrashMetal', IRON, rot=(PI / 2, 0, 0))   # hinge
    # The ramp's treads as steps to stand on (their tops as they rise to the sill).
    mid0, mid1 = (a + b) / 2, (foot[0] + foot[1]) / 2
    half = (b - a).length / 2
    for k in range(3):
        t = (k + 0.5) / 3
        c = mid1.lerp(mid0, t)
        ship.steps.append((c + Vector((0, -half, 0)), c + Vector((0, half, 0)), 0.42, max(0.15, c.z + 0.1)))
    ship.points['spawn'] = mid1 + out * 1.6
    ship.points['spawn'].z = 0.0

    # Cables hanging out of the left wing's stump.
    for k, p in enumerate(stump):
        end = p + Vector((-0.4 - 0.3 * k, 0.2 * k, -p.z - 0.3))
        mb.cable(p, end, 0.15, 0.04, (RUBBER, CABLE_RED, CABLE_YEL)[k], n=5)


def build_wing(mb, rng, ship):
    """The left wing, torn off on the way down: flat on the sand, its root jagged, leading edge dug in."""
    mb.push(T(0, 0, 0.05) @ R(x=0.06, y=-0.08, z=0.0))
    Z = (0, 0, 1)
    slab(mb, [(-3.4, -3.6, 0.0), (3.4, 0.9, -0.2), (3.2, 3.2, -0.2), (-3.4, 3.8, 0.0)], 0.5, 0.22, Z, 'CrashPaint', CREAM)
    slab(mb, [(0.6, -0.95, -0.12), (3.4, 0.9, -0.19), (3.2, 3.2, -0.19), (0.6, 3.4, -0.12)], 0.34, 0.26, Z, 'CrashPaint', RED)
    for y in (-1.0, 1.4):
        mb.box((5.0, 0.1, 0.06), (-0.6, y, 0.25), 'CrashBrass', BRASS_DK, rot=(0, 0, 0.05))
    jr = Rng(17)
    for k in range(5):
        y = -3.2 + k * 1.6
        mb.tube((-3.4, y, 0.0), (-3.4 - jr(0.4, 1.2), y + jr(-0.3, 0.3), jr(-0.1, 0.4)), 0.07, 'CrashMetal', STEEL, segs=5)
    mb.cyl(0.32, 0.32, 2.2, 8, (1.0, 2.4, -0.2), 'CrashMetal', IRON, rot=(PI / 2, 0, 0))
    mb.burn((-3.2, 0.0, 0.0), 2.4, 1.0)
    mb.cap((-3.0, 0.0, 0), (3.0, 1.6, 0), 2.3)
    mb.pop()


def build_panel(mb, rng, ship):
    """A curved hull plate ripped off the top of the hull, lying on the sand like a shell, one edge dug in, ribs under it."""
    mb.push(T(0, 0, -1.75) @ R(y=0.22))
    sec = [p for k, p in enumerate(at_y(0.0, 1.0, 20)) if 3 <= k <= 7]
    rings = [[Vector((p.x, y, p.z)) for p in sec] for y in (-1.8, 0.0, 1.9)]
    mb.loft(rings, 'CrashPaint', CREAM, closed=False, colfn=lambda i, k: TEAL if k == 2 else None)
    inner = [[Vector((p.x * 0.97, y, p.z * 0.97)) for p in sec] for y in (-1.8, 1.9)]
    mb.loft(inner, 'CrashDark', DARK, closed=False)
    for y in (-1.2, 0.6):
        mb.sweep([Vector((p.x * 0.96, y, p.z * 0.96)) for p in sec], 0.08, 'CrashMetal', IRON, segs=4)
    mb.burn((1.5, 1.9, 2.2), 2.0, 0.9)
    mb.pop()
    mb.cap((0, -1.2, 0), (0, 1.3, 0), 2.4)


def build_strut(mb, rng, ship):
    """A landing leg torn out of the belly: oleo and drag strut bent, the foot pad on its side."""
    mb.push(T(0, 0, 0.35) @ R(x=0.0, y=-1.35, z=0.0))
    mb.cyl(0.2, 0.2, 3.0, 10, (0, 0, 1.2), 'CrashMetal', STEEL)
    mb.cyl(0.28, 0.28, 1.6, 10, (0, 0, 2.6), 'CrashMetal', IRON)
    mb.cyl(0.32, 0.32, 0.18, 10, (0, 0, 3.4), 'CrashBrass', BRASS)
    mb.sweep([(0, 0, 0.6), (0.6, 0.1, 1.4), (1.2, 0.4, 2.0), (1.5, 0.3, 2.9)], 0.09, 'CrashMetal', IRON, segs=5)
    mb.cyl(0.9, 0.8, 0.22, 12, (0, 0, -0.2), 'CrashMetal', IRON)
    mb.cyl(0.4, 0.4, 0.3, 10, (0, 0, 0.0), 'CrashBrass', BRASS_DK)
    mb.cable(Vector((0.2, 0.1, 3.2)), Vector((0.7, 0.4, 1.0)), 0.2, 0.035, CABLE_RED, n=5)
    mb.burn((0, 0, 3.6), 1.0, 0.8)
    mb.pop()
    mb.cap((-0.4, 0, 0), (-3.2, 0, 0), 0.5)


NODES = [('Ship_Hull', build_hull, 7), ('Ship_Wing', build_wing, 11), ('Ship_Panel', build_panel, 13),
         ('Ship_Strut', build_strut, 19)]
# Where the debris lies, ship-local three.js (x across, z along: the nose is +z), yaw (rad, about +y), behind the hull
# along its furrow.
DEBRIS = [('Ship_Wing', -7.5, -24.0, 0.5), ('Ship_Panel', 4.5, -33.0, -0.9), ('Ship_Strut', -2.0, -42.0, 2.1)]


def capsule_data(obj, caps, steps):
    out = []
    verts = [v.co for v in obj.data.vertices]
    for a, b, r in caps:
        out.append(cap_dict(a, b, r, verts=verts))
    for a, b, r, h in steps:
        out.append(cap_dict(a, b, r, h=h))
    return out


def cap_dict(a, b, r, verts=None, h=None):
    a2, b2 = Vector((a.x, a.y)), Vector((b.x, b.y))
    d = b2 - a2
    half = d.length / 2
    c = (a2 + b2) / 2
    u = d.normalized() if half > 1e-4 else Vector((1, 0))
    if h is None:
        h = 0.0
        for v in verts:
            p = Vector((v.x, v.y)) - c
            t = max(-half, min(half, p.dot(u)))
            if (p - u * t).length <= r:
                h = max(h, v.z)
    return {'x': c.x, 'z': -c.y, 'ax': u.x, 'az': -u.y, 'half': half, 'r': r, 'h': max(0.3, h)}


def write_ts(nodes, points, path):
    f = cs.fmt
    lines = [
        '// Generated by tools/blender/ship.py — do not edit by hand. Model-local three.js coords (Y up, metres; the nose is +Z).',
        'export type ShipCapsule = { x: number; z: number; ax: number; az: number; half: number; r: number; h: number };',
        '/** Each node of public/models/ship.glb: its radius round its origin (m) and its solid capsules (top h above the origin). */',
        'export const SHIP_NODES: { node: string; radius: number; capsules: ShipCapsule[] }[] = [',
    ]
    for k in nodes:
        caps = ', '.join('{ ' + ', '.join(f'{n}: {f(c[n], 3 if n in ("ax", "az") else 2)}'
                                           for n in ('x', 'z', 'ax', 'az', 'half', 'r', 'h')) + ' }' for c in k['caps'])
        lines.append(f"  {{ node: '{k['node']}', radius: {f(k['radius'])}, capsules: [{caps}] }},")
    lines.append('];')
    lines.append('/** The pieces lying back along the furrow, ship-local: node, x, z, and the cosine and sine of its turn about +Y (no trig')
    lines.append(' *  at run time: shared/ship.ts collides with them). */')
    lines.append('export const SHIP_DEBRIS: [string, number, number, number, number][] = [')
    for n, x, z, yaw in DEBRIS:
        lines.append(f"  ['{n}', {f(x)}, {f(z)}, {f(math.cos(yaw), 4)}, {f(math.sin(yaw), 4)}],")
    lines.append('];')
    lines.append('/** Points on the hull, ship-local [x, y, z]: where new players appear (the foot of the ramp), the fin\'s lamp, the tear')
    lines.append(' *  over the hold, the engines, the cargo door\'s lamp. */')
    lines.append('export const SHIP_POINTS = {')
    for name, p in points.items():
        q = cs.three(p)
        lines.append(f"  {name}: [{', '.join(f(v) for v in q)}] as [number, number, number],")
    lines.append('};')
    lines.append('')
    with open(path, 'w') as fh:
        fh.write('\n'.join(lines))


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models', 'ship.glb'))
    ap.add_argument('--ts', default=os.path.join(ROOT, 'shared', 'shipModel.ts'))
    ap.add_argument('--preview', default=None, help='directory for PNG previews')
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in cs.MATERIALS.items():
        cs.make_material(name, *spec)
    nodes, objs, ship = [], [], Ship()
    for name, fn, seed in NODES:
        mb = MeshBuilder()
        ship.steps = []
        fn(mb, Rng(seed), ship)
        caps, steps = mb.caps, ship.steps
        if name == 'Ship_Hull':
            ship.points['door'] = Vector(mb.beacon)
        obj = cs.make_object(name, mb)
        cd = capsule_data(obj, caps, steps)
        radius = max(math.hypot(v.co.x, v.co.y) for v in obj.data.vertices)
        nodes.append({'node': name, 'radius': radius, 'caps': cd, 'obj': obj})
        objs.append(obj)
        zs = [v.co.z for v in obj.data.vertices]
        print(f'{name}: tris={cs.tri_count(obj)} radius={radius:.2f} z {min(zs):.2f}..{max(zs):.2f} caps={len(cd)}')
    print('total tris', sum(cs.tri_count(o) for o in objs))
    bpy.context.view_layer.update()
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    cs.export_glb(objs, args.out)
    write_ts(nodes, ship.points, args.ts)
    if args.preview:
        render(nodes, ship, os.path.abspath(args.preview))


def render(nodes, ship, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    scene, cam, ground = cs.setup_scene()
    scene.render.resolution_x, scene.render.resolution_y = 1600, 900
    by = {k['node']: k for k in nodes}
    for n, x, z, yaw in DEBRIS:
        o = by[n]['obj']
        o.location = (x, -z, 0)
        o.rotation_euler = (0, 0, yaw)

    def shoot(name, target, az, el, dist, lens=35):
        cs.look(cam, target, math.radians(az), math.radians(el), dist, lens)
        scene.render.filepath = os.path.join(out_dir, name)
        bpy.ops.render.render(write_still=True)

    shoot('ship_left.png', (0, 2, 3), 200, 14, 42)
    shoot('ship_right.png', (0, 0, 3), -20, 16, 42)
    shoot('ship_front.png', (0, -8, 3), -95, 10, 40)
    shoot('ship_trail.png', (0, 18, 2), 60, 28, 75)
    shoot('ship_far.png', (0, 0, 5), 160, 3, 260, lens=50)
    sp = ship.points['spawn']
    cs.look(cam, (0, 0, 3), 0, 0, 1)
    cam.location = (sp.x - 1.0, sp.y - 6, 1.7)
    cam.rotation_euler = (Vector((0, 2, 3.5)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 24
    scene.render.filepath = os.path.join(out_dir, 'ship_spawn.png')
    bpy.ops.render.render(write_still=True)
    # Capsules from above.
    wm = bpy.data.materials.new('wire')
    wb = wm.node_tree.nodes.get('Principled BSDF')
    wb.inputs['Emission Color'].default_value = (0.1, 1.0, 0.3, 1)
    wb.inputs['Emission Strength'].default_value = 3.0
    for k in nodes:
        o = k['obj']
        w = cs.capsule_wire(k, (0, 0, 0), wm)
        w.location = o.location
        w.rotation_euler = o.rotation_euler
    shoot('ship_caps.png', (0, 14, 0), -90, 80, 90)


if __name__ == '__main__':
    main()
