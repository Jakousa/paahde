"""The crashed escape pods the players arrive in (shared/pods.ts), exported as one glTF binary + a generated TS table.

    blender -b --python tools/blender/pod.py                       # writes the glb + shared/podModel.ts
    blender -b --python tools/blender/pod.py -- --preview <dir>    # also renders PNG previews into <dir>

A one-person drop pod, ~3.9 m from its rounded nose to the lips of its rocket bells and 2.5 m across, in the manner
of a classic sci-fi model kit: a squat barrel of off-white and grey hull panels with recessed seams (the panels stand
proud of a dark core), small hatch outlines, an orange band and red trim; at the back a ring of dense machinery
round four big flared nozzles (tanks, valves, boxes, pipes and conduit, a yellow hose snaking through it); a small
sensor dish on top. Its side hatch is blown open.

One model (node Pod), posed four ways (POSES: pitch, roll and how deep it lies), each yawed per world by shared/
podSpot.ts. Pod_Chute is the drogue canopy trailing on the sand behind pose 2, in that pose's ground frame.

Built with the crash sites' kit (tools/blender/crashsites.py: MeshBuilder, materials, weathering). Blender is Z-up;
the nose points along Blender -Y, which is three.js +Z (three = (x, z, -y)). The Pod node's mesh lies flat with its
axis AXIS_Z over its origin; a pose turns it about the axis's middle and sets it down (the matrix goes to
shared/podModel.ts, three.js space, so the client draws exactly what the collision was read off).

shared/podModel.ts gets each pose's matrix, its capsules (in the pose's ground frame: three.js x/z, top h above the
sand), where the hatch is and where a player stands beside it.
"""

import argparse
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crashsites as cs  # noqa: E402
from crashsites import (BRASS, BRASS_DK, COPPER, DARK, GLOW, IRON, PI, R, REDLIGHT, RUBBER, RUST, SOOT, STEEL,  # noqa: E402
                        T, MeshBuilder, Rng, aim)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

# Palette (sRGB): the hull's off-whites and greys, its orange band and red trim.
HULL = 0xe4dfd3
TANK = 0xc9c3b2
WATER = 0x8fc3cf
HULL_LT = 0xe8e3d6
HULL_GREY = 0xaeaba3
HULL_DK = 0x86837c
SEAM = 0x2b2826
ORANGE = 0xd2622a
RED = 0xa8362a
YELLOW = 0xd9a92a
CLOTH_W = 0xe2d9c6
CLOTH_O = 0xd8642c

AXIS_Z = 1.2          # the axis's height over the mesh origin (lying flat on its belly)
SEGS = 24             # round the hull
GAP = 0.028           # the seams between hull panels (m)
CORE = 0.045          # how far under the panels the dark core lies

# The hull's profile, nose to back: (y, radius). The nose is a dome; the barrel bulges a little; the service ring at
# the back is the core only (the machinery stands on it), then the rear bulkhead.
NOSE = [(-1.86, 0.0), (-1.85, 0.26), (-1.79, 0.5), (-1.66, 0.76), (-1.44, 1.0), (-1.12, 1.15), (-0.72, 1.22)]
BARREL = [(-0.72, 1.22), (-0.12, 1.25), (0.42, 1.24), (0.68, 1.21)]
RING_Y = (0.68, 1.26)  # the service ring (machinery)
RING_R = 1.06
REAR_Y = 1.26

# The panels: axial bands (y0, y1) and how many hull segments each panel spans round the hull.
BANDS = [(-1.86, -1.44, 24), (-1.44, -1.12, 4), (-1.12, -0.72, 3), (-0.72, -0.56, 2), (-0.56, -0.12, 3),
         (-0.12, 0.42, 3), (0.42, 0.68, 4)]
# The hatch: on the left flank (round the hull from +X, counter-clockwise seen from +Y: 180 deg is -X), a little up.
HATCH_A = math.radians(196)
HATCH_HALF_A = math.radians(24)
HATCH_Y = (-0.62, 0.36)
# The water tanks: (angle round the hull, y from, y to, which way round its tap points: towards the hatch). One above
# the hatch, one low ahead of it.
TANKS = [(math.radians(148), 0.02, 0.58, 1), (math.radians(232), -1.1, -0.68, -1)]

# The poses: (name, pitch about +X (nose down), roll about the axis (+: right side down), axis height over the sand).
POSES = [
    ('ploughed', 0.13, 0.2, 0.92),
    ('side', 0.05, 1.42, 1.0),
    ('dug', 0.3, -0.14, 0.86),
    ('rolled', 0.18, -0.5, 0.86),
]
CHUTE_POSE = 2


def radius_at(y):
    prof = NOSE + BARREL[1:]
    for (y0, r0), (y1, r1) in zip(prof, prof[1:]):
        if y0 <= y <= y1:
            t = (y - y0) / (y1 - y0)
            return r0 + (r1 - r0) * t
    return prof[-1][1] if y > 0 else 0.0


def slope(y):
    """dy along the hull's surface per metre (1 on the barrel, less over the nose)."""
    dr = radius_at(y + 0.01) - radius_at(y - 0.01)
    return 0.02 / math.sqrt(0.02 * 0.02 + dr * dr)


def on_hull(a, y, r_add=0.0):
    """The point on the panels' surface at angle a (from +X, counter-clockwise seen from +Y... towards +Z), y."""
    r = radius_at(y) + r_add
    return Vector((math.cos(a) * r, y, AXIS_Z + math.sin(a) * r))


def normal_at(a, y):
    return Vector((math.cos(a), 0.0, math.sin(a)))


def in_hatch(a, y, pad=0.0):
    d = (a - HATCH_A + PI) % (2 * PI) - PI
    return abs(d) < HATCH_HALF_A + pad and HATCH_Y[0] - pad < y < HATCH_Y[1] + pad


def build_hull(mb, rng, info):
    seg_a = 2 * PI / SEGS
    # The dark core under the panels: nose to the back of the service ring.
    ys = [y for y, _ in NOSE] + [y for y, _ in BARREL[1:]] + [RING_Y[1]]
    rs = [max(0.0, r - CORE) for _, r in NOSE] + [r - CORE for _, r in BARREL[1:]] + [RING_R]
    rings = []
    for y, r in zip(ys, rs):
        rings.append([Vector((math.cos(k * seg_a) * r, y, AXIS_Z + math.sin(k * seg_a) * r)) for k in range(SEGS)])
    # (The ring from the barrel's end down to the service ring's core: the step the machinery stands on.)
    rings.insert(len(rings) - 1, [Vector((math.cos(k * seg_a) * RING_R, BARREL[-1][0], AXIS_Z + math.sin(k * seg_a) * RING_R))
                                  for k in range(SEGS)])
    mb.loft(rings[1:], 'CrashMetal', SEAM, cap0=True, cap1=True)

    # The panels, each a little patch standing proud of the core, the seams between them dark.
    for bi, (y0, y1, span) in enumerate(BANDS):
        n = SEGS // span
        for j in range(n):
            a0 = j * span * seg_a + (seg_a * 0.5 if bi % 2 else 0.0)
            a1 = a0 + span * seg_a
            mid = (a0 + a1) / 2
            if in_hatch(mid, (y0 + y1) / 2):
                continue
            g0 = GAP / 2 / max(0.3, radius_at(y0))
            g1 = GAP / 2 / max(0.3, radius_at(y1))
            ya, yb = y0 + GAP / 2 * slope(y0), y1 - GAP / 2 * slope(y1)
            if bi == 0:
                ya = y0
            # Colour: off-white mostly, a few grey panels, the orange band, red under the nose.
            h = (bi * 7 + j * 5) % 11
            if bi == 3:
                col = ORANGE
            elif h in (2, 7):
                col = HULL_GREY
            elif h == 4:
                col = HULL_LT
            elif h == 9 and bi > 3:
                col = HULL_DK
            else:
                col = HULL
            steps = span
            ring_a = [on_hull(a0 + g0 + (a1 - a0 - 2 * g0) * t / steps, ya) for t in range(steps + 1)]
            ring_b = [on_hull(a0 + g1 + (a1 - a0 - 2 * g1) * t / steps, yb) for t in range(steps + 1)]
            # (Over the nose, a ring at each step of the profile, so the dome stays round.)
            mids = [y for y, _ in NOSE if ya + 0.02 < y < yb - 0.02]
            rows = [ring_a] + [[on_hull(a0 + g0 + (a1 - a0 - 2 * g0) * t / steps, y) for t in range(steps + 1)]
                               for y in mids] + [ring_b]
            before = set(mb.bm.faces)
            mb.loft(rows, 'CrashPaint', col, closed=False)
            # Facing out (the loft's guess can turn a lone strip inside out).
            for f in mb.bm.faces:
                if f not in before:
                    c = f.calc_center_median()
                    if f.normal.dot(c - Vector((0, -0.4, AXIS_Z))) < 0:
                        f.normal_flip()
            # Panel edges: a thin skirt down to the core so the seams read as recessed from the side.
            for rr in (ring_a,):
                inner = [p - normal_at(math.atan2(p.z - AXIS_Z, p.x), p.y) * CORE for p in rr]
                mb.loft([rr, inner], 'CrashPaint', col, closed=False)
    # A red pinstripe ring behind the orange band.
    for y in (-0.56,):
        mb.sweep([on_hull(k * seg_a, y, -0.01) for k in range(SEGS)], 0.018, 'CrashPaint', RED, segs=3, closed=True)

    # Small hatch outlines and access plates: a dark frame with a lid in it, flush with the panels.
    for a, y, w, h in ((math.radians(60), -0.3, 0.42, 0.34), (math.radians(118), 0.2, 0.3, 0.3),
                       (math.radians(330), -0.35, 0.5, 0.36), (math.radians(300), 0.55, 0.3, 0.22),
                       (math.radians(250), -0.95, 0.34, 0.28), (math.radians(20), 0.62, 0.26, 0.2)):
        p, nrm = on_hull(a, y), normal_at(a, y)
        M = aim(p, nrm) @ R(z=PI / 2)
        mb.box((w + 0.05, h + 0.05, 0.018), (0, 0, 0.004), 'CrashMetal', SEAM, m=M)
        mb.box((w, h, 0.02), (0, 0, 0.012), 'CrashPaint', HULL_GREY if a > 3 else HULL_LT, m=M)
        mb.box((0.06, 0.03, 0.03), (w * 0.3, 0, 0.028), 'CrashMetal', IRON, m=M)    # latch
    # Grab rails by the hatch and along the top, stencil blocks.
    for a, y0, y1 in ((HATCH_A + HATCH_HALF_A + 0.16, -0.5, 0.25), (math.radians(96), -0.6, 0.3)):
        p0, p1 = on_hull(a, y0, 0.0), on_hull(a, y1, 0.0)
        mb.sweep([p0, on_hull(a, y0 + 0.05, 0.09), on_hull(a, y1 - 0.05, 0.09), p1], 0.022, 'CrashMetal', STEEL,
                 segs=4)
    for a, y in ((math.radians(40), 0.05), (math.radians(140), -0.2)):
        M = aim(on_hull(a, y), normal_at(a, y)) @ R(z=PI / 2)
        for k in range(3):
            mb.box((0.06, 0.16, 0.012), (k * 0.09 - 0.09, 0, 0.006), 'CrashPaint', SEAM, m=M)
    # Reaction-control quads: four little blocks with four nozzles each, round the barrel's front.
    for a in (math.radians(45), math.radians(135), math.radians(225 + 18), math.radians(315)):
        p, nrm = on_hull(a, -0.42), normal_at(a, -0.42)
        M = aim(p, nrm)
        mb.box((0.2, 0.2, 0.12), (0, 0, 0.05), 'CrashMetal', HULL_DK, m=M)
        for d in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            mb.cyl(0.03, 0.045, 0.07, 4, (d[0] * 0.12, d[1] * 0.12, 0.06), 'CrashMetal', DARK,
                   rot=(d[1] * PI / 2, -d[0] * PI / 2, 0), m=M)
    # A docking collar on the nose: a ring and a dark port.
    nose = Vector((0, NOSE[0][0], AXIS_Z))
    mb.cyl(0.34, 0.3, 0.1, 12, nose + Vector((0, 0.02, 0)), 'CrashMetal', HULL_DK, rot=(PI / 2, 0, 0))
    mb.cyl(0.2, 0.2, 0.08, 10, nose + Vector((0, -0.03, 0)), 'CrashDark', SOOT, rot=(PI / 2, 0, 0))
    mb.burn(nose + Vector((0, -0.1, -0.9)), 0.8, 0.5)

    # The hatch, blown open: the opening (a dark cabin behind it: a seat back, a lamp), its red frame, and the door
    # hanging off its lower hinge, scorched.
    ya, yb = HATCH_Y
    a0, a1 = HATCH_A - HATCH_HALF_A, HATCH_A + HATCH_HALF_A
    frame = [on_hull(a0, ya), on_hull(a1, ya), on_hull(a1, yb), on_hull(a0, yb)]
    for i in range(4):
        mb.tube(frame[i], frame[(i + 1) % 4], 0.05, 'CrashPaint', RED, segs=4)
    hn = normal_at(HATCH_A, (ya + yb) / 2)
    hc = on_hull(HATCH_A, (ya + yb) / 2)
    mb.box((0.7, 0.92, 0.6), (0, 0, -0.3), 'CrashDark', DARK, m=aim(hc - hn * 0.05, hn) @ R(z=PI / 2))
    mb.box((0.5, 0.12, 0.5), (0, 0.35, -0.42), 'CrashDark', RUBBER, m=aim(hc - hn * 0.05, hn) @ R(z=PI / 2))  # seat
    mb.box((0.12, 0.05, 0.05), (0.2, -0.3, -0.12), 'CrashGlow', GLOW, m=aim(hc - hn * 0.05, hn) @ R(z=PI / 2))
    mb.beacon_at(hc - hn * 0.15)
    info['hatch'] = mb.W(hc)
    info['hatch_n'] = (mb.stack[-1].to_3x3() @ hn).normalized()
    # The door: the hull patch, turned out about its lower edge (the hinge line along y at angle a0).
    hinge_p = on_hull(a1, 0.0)
    hinge_axis = Vector((0, 1, 0))
    door = (T(hinge_p) @ Matrix.Rotation(-1.75, 4, hinge_axis) @ T(-hinge_p))
    mb.push(door)
    steps = 4
    ring_a = [on_hull(a0 + (a1 - a0) * t / steps, ya + 0.03) for t in range(steps + 1)]
    ring_b = [on_hull(a0 + (a1 - a0) * t / steps, yb - 0.03) for t in range(steps + 1)]
    mb.loft([ring_a, ring_b], 'CrashPaint', HULL)
    inner_a = [p - normal_at(a0 + (a1 - a0) * t / steps, 0) * 0.07 for t, p in enumerate(ring_a)]
    inner_b = [p - normal_at(a0 + (a1 - a0) * t / steps, 0) * 0.07 for t, p in enumerate(ring_b)]
    mb.loft([inner_a, inner_b], 'CrashMetal', HULL_DK)
    for ra, rb in ((ring_a, inner_a), (ring_b, inner_b)):
        mb.loft([ra, rb], 'CrashPaint', RED, closed=False)
    mb.loft([[ring_a[-1], ring_b[-1]], [inner_a[-1], inner_b[-1]]], 'CrashPaint', RED, closed=False)
    mid_in = on_hull(HATCH_A, (ya + yb) / 2, -0.08)
    mb.cyl(0.13, 0.13, 0.04, 8, (0, 0, 0), 'CrashMetal', IRON, m=aim(mid_in, -hn))  # the wheel boss
    mb.burn(on_hull(a1, (ya + yb) / 2), 0.7, 0.7)
    mb.pop()
    for y in (ya + 0.12, yb - 0.12):
        mb.cyl(0.06, 0.06, 0.16, 6, on_hull(a1, y, 0.02), 'CrashMetal', IRON, rot=(PI / 2, 0, 0))   # hinges
    mb.burn(hc, 1.0, 0.9)

    # The sensor dish on top: a short mast, the dish turned up and aft, its feed horn; a whip antenna; the beacon.
    top_y = 0.25
    base = on_hull(PI / 2, top_y)
    mb.cyl(0.12, 0.14, 0.08, 8, base + Vector((0, 0, 0.02)), 'CrashMetal', HULL_DK)
    mb.tube(base, base + Vector((0, 0, 0.42)), 0.04, 'CrashMetal', STEEL, segs=6)
    dish = T(base + Vector((0, 0, 0.46))) @ R(x=-0.75, y=0.35)
    mb.lathe([(0.0, 0.05), (0.12, 0.06), (0.24, 0.1), (0.32, 0.17), (0.3, 0.18), (0.2, 0.12), (0.0, 0.08)], 12,
             'CrashMetal', HULL_LT, m=dish, closed=True)
    mb.tube(dish @ Vector((0, 0, 0.08)), dish @ Vector((0, 0, 0.36)), 0.014, 'CrashMetal', STEEL, segs=4)
    mb.cyl(0.03, 0.02, 0.06, 6, (0, 0, 0.38), 'CrashMetal', DARK, m=dish)
    whip = on_hull(math.radians(110), -0.3)
    mb.tube(whip, whip + Vector((-0.12, 0.25, 0.85)), 0.012, 'CrashMetal', STEEL, segs=3)
    lamp = on_hull(math.radians(70), 0.65)
    ln = normal_at(math.radians(70), 0)
    mb.cyl(0.07, 0.07, 0.05, 8, (0, 0, 0), 'CrashMetal', IRON, m=aim(lamp, ln))
    mb.cyl(0.05, 0.035, 0.07, 8, (0, 0, 0.05), 'CrashGlow', REDLIGHT, m=aim(lamp, ln))
    info['light'] = mb.W(lamp + normal_at(math.radians(70), 0) * 0.08)

    # The emergency water tanks: two squat drums strapped to the flank, one above the hatch, one low ahead of it (one of
    # them is in reach however the pod lies), each with two straps, a feed pipe to a tap with a red wheel, its spout
    # dripping (shared/pods.ts atPodTap: the canteen fills there, shared/wells.ts waterAt).
    info['taps'] = []
    for ta, t0, t1, sgn in TANKS:
        tn = normal_at(ta, 0)
        side = Vector((-math.sin(ta), 0, math.cos(ta))) * sgn   # round the hull, towards the hatch
        c = Vector((0, (t0 + t1) / 2, AXIS_Z)) + tn * (radius_at((t0 + t1) / 2) + 0.23)
        mb.cyl(0.22, 0.22, t1 - t0, 10, c, 'CrashPaint', TANK, rot=(PI / 2, 0, 0))
        for y in (t0 - 0.005, t1 + 0.005):
            mb.cyl(0.15, 0.15, 0.03, 10, Vector((c.x, y, c.z)), 'CrashMetal', HULL_DK, rot=(PI / 2, 0, 0))
        for y in (t0 + 0.1, t1 - 0.1):
            mb.cyl(0.235, 0.235, 0.045, 10, Vector((c.x, y, c.z)), 'CrashMetal', IRON, rot=(PI / 2, 0, 0))
        mb.box((0.16, 0.12, 0.02), (0, 0.05, 0.2), 'CrashPaint', 0x2f6f8f, m=aim(c, tn))  # stencil
        p0 = Vector((c.x, t0 - 0.02, c.z)) + side * 0.12
        p1 = p0 + Vector((0, -0.16, 0)) + side * 0.1
        p2 = p1 + side * 0.18 + tn * 0.04
        mb.sweep([p0, p1, p2], 0.025, 'CrashMetal', STEEL, segs=5)
        mb.cyl(0.045, 0.045, 0.12, 8, p2, 'CrashBrass', BRASS, rot=(PI / 2, 0, 0))          # valve body
        wheel = p2 + Vector((0, 0.09, 0))
        mb.sweep([wheel + (tn * math.cos(t * PI / 3) + side * math.sin(t * PI / 3)) * 0.06 for t in range(6)], 0.01,
                 'CrashPaint', RED, segs=3, closed=True)
        spout = p2 + side * 0.13
        mb.tube(p2, spout, 0.018, 'CrashMetal', STEEL, segs=5)
        for k, d in enumerate((0.06, 0.2, 0.36)):
            mb.cyl(0.03 - 0.005 * k, 0.0, 0.09, 5, (0, 0, 0), 'CrashGlass', WATER, m=aim(spout + side * d, side))
        info['taps'].append(mb.W(spout))


def build_rear(mb, rng, info):
    """The service ring and the engine: machinery packed round the back, four flared nozzles."""
    y0, y1 = RING_Y
    seg_a = 2 * PI / SEGS
    # Two conduit hoops round the ring, ribs across it.
    for y, r, col in ((y0 + 0.06, RING_R + 0.08, IRON), (y1 - 0.05, RING_R + 0.1, HULL_DK)):
        mb.sweep([Vector((math.cos(k * seg_a) * r, y, AXIS_Z + math.sin(k * seg_a) * r)) for k in range(SEGS)], 0.035,
                 'CrashMetal', col, segs=3, closed=True)
    # The rear bulkhead: a rim lip, a flat dark plate, a raised centre.
    mb.cyl(RING_R + 0.12, RING_R + 0.12, 0.08, SEGS, (0, REAR_Y + 0.0, AXIS_Z), 'CrashPaint', HULL_GREY, rot=(PI / 2, 0, 0))
    mb.cyl(0.42, 0.38, 0.22, 10, (0, REAR_Y + 0.12, AXIS_Z), 'CrashMetal', IRON, rot=(PI / 2, 0, 0))

    # The machinery, a slot at a time round the ring (24 slots), each something different; the hatch side keeps its
    # big tanks low.
    def frame_at(a, y, out=0.0):
        p = Vector((math.cos(a) * (RING_R + out), y, AXIS_Z + math.sin(a) * (RING_R + out)))
        return aim(p, normal_at(a, y)) @ R(z=PI / 2)

    kinds = ['tank', 'box', 'valve', 'cyl', 'box2', 'pipes', 'tank', 'box', 'cyl', 'valve', 'box2', 'grille']
    ym = (y0 + y1) / 2
    for k in range(28):
        a = k * 2 * PI / 28 + 0.07
        kind = kinds[(k * 5 + 3) % len(kinds)]
        M = frame_at(a, ym + (0.12 if k % 2 else -0.12)) @ Matrix.Diagonal((1.3, 1.3, 1.3, 1))
        if kind == 'tank':
            mb.lathe([(0.0, -0.17), (0.12, -0.13), (0.17, 0.0), (0.12, 0.13), (0.0, 0.17)],
                     6, 'CrashPaint', HULL_LT if k % 3 else ORANGE, m=M @ T(0, 0, 0.13))
            mb.cyl(0.07, 0.07, 0.06, 6, (0, 0, 0.32), 'CrashBrass', BRASS, m=M)
        elif kind == 'cyl':
            mb.cyl(0.1, 0.1, 0.32, 8, (0, 0, 0.11), 'CrashMetal', STEEL, rot=(0, PI / 2, 0), m=M)
            for s in (-1, 1):
                mb.cyl(0.11, 0.11, 0.025, 8, (s * 0.12, 0, 0.11), 'CrashMetal', DARK, rot=(0, PI / 2, 0), m=M)
        elif kind == 'box':
            mb.box((0.24, 0.3, 0.16), (0, 0, 0.08), 'CrashMetal', HULL_DK, m=M)
            mb.box((0.14, 0.18, 0.05), (0, 0.02, 0.18), 'CrashMetal', IRON, m=M)
        elif kind == 'box2':
            mb.box((0.2, 0.26, 0.24), (0, -0.02, 0.12), 'CrashPaint', HULL_GREY, m=M)
            mb.box((0.21, 0.04, 0.08), (0, 0.1, 0.17), 'CrashPaint', RED, m=M)
        elif kind == 'valve':
            mb.cyl(0.045, 0.045, 0.22, 6, (0, 0, 0.11), 'CrashMetal', IRON, m=M)
            mb.cyl(0.07, 0.07, 0.08, 8, (0, 0, 0.16), 'CrashBrass', BRASS_DK, m=M)
            wheel = M @ T(0, 0, 0.24)
            mb.sweep([wheel @ Vector((math.cos(t * PI / 3) * 0.08, math.sin(t * PI / 3) * 0.08, 0)) for t in range(6)],
                     0.012, 'CrashPaint', RED, segs=3, closed=True)
        elif kind == 'pipes':
            for s in (-0.07, 0.0, 0.07):
                mb.box((0.035, 0.34, 0.035), (s, 0, 0.06 + abs(s)), 'CrashBrass', COPPER, m=M)
        elif kind == 'grille':
            mb.box((0.26, 0.28, 0.05), (0, 0, 0.025), 'CrashMetal', DARK, m=M)
            for s in range(4):
                mb.box((0.25, 0.025, 0.02), (0, -0.1 + s * 0.065, 0.06), 'CrashMetal', STEEL, m=M)
    # Pipes along the ring, from under the barrel's panels back over the bulkhead's rim and into the nozzles' manifolds.
    for k in range(0, SEGS, 3):
        a = k * seg_a + 0.21
        r = RING_R + 0.18
        p0 = Vector((math.cos(a) * (r + 0.02), y0 - 0.06, AXIS_Z + math.sin(a) * (r + 0.02)))
        p1 = Vector((math.cos(a) * r, y1 + 0.05, AXIS_Z + math.sin(a) * r))
        p2 = Vector((math.cos(a) * 0.82, REAR_Y + 0.12, AXIS_Z + math.sin(a) * 0.82))
        mb.sweep([p0, p1, p2], 0.024, 'CrashBrass' if k % 2 else 'CrashMetal', COPPER if k % 2 else STEEL, segs=4)
    # The yellow hose, snaking round the ring between the machinery, in and out, then off over the bulkhead.
    pts = []
    for i in range(30):
        a = 0.3 + i * (2 * PI * 0.92) / 30
        y = (y0 + y1) / 2 + 0.13 * math.sin(i * 1.3)
        r = RING_R + 0.26 + 0.07 * math.sin(i * 2.1 + 0.5)
        pts.append(Vector((math.cos(a) * r, y, AXIS_Z + math.sin(a) * r)))
    pts.append(Vector((math.cos(0.3 + 2 * PI * 0.92) * 0.7, REAR_Y + 0.16, AXIS_Z + math.sin(0.3 + 2 * PI * 0.92) * 0.7)))
    mb.sweep(pts, 0.04, 'CrashDark', YELLOW, segs=4)
    for p in (pts[0], pts[14]):
        mb.box((0.1, 0.1, 0.1), p, 'CrashMetal', IRON)   # its couplings

    # The four nozzles, set two by two round the axis: a collar, the bell flaring out, sooted inside; a turbopump in
    # the middle, feed lines out to each throat, struts back to the rim.
    off = 0.48
    for sx, sz in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
        c = Vector((sx * off, REAR_Y, AXIS_Z + sz * off))
        M = T(c) @ R(x=-PI / 2)   # local +Z = Blender +Y (aft)
        mb.cyl(0.2, 0.2, 0.18, 8, (0, 0, 0.09), 'CrashMetal', IRON, m=M)
        mb.cyl(0.23, 0.23, 0.05, 8, (0, 0, 0.17), 'CrashBrass', BRASS, m=M)
        prof = [(0.17, 0.16), (0.22, 0.38), (0.32, 0.6), (0.45, 0.8), (0.41, 0.8), (0.29, 0.6), (0.19, 0.38),
                (0.14, 0.2)]
        mb.lathe(prof, 12, 'CrashMetal', HULL_GREY, m=M, closed=True,
                 colfn=lambda i, k: SOOT if k >= 4 else (STEEL if k == 3 else None))
        mb.lathe([(0.0, 0.3), (0.16, 0.3)], 10, 'CrashDark', SOOT, m=M)
        mb.burn(c + Vector((0, 0.8, 0)), 0.55, 0.6)
        # Feed line from the middle to the throat, a valve on it.
        mb.sweep([Vector((sx * 0.12, REAR_Y + 0.22, AXIS_Z + sz * 0.12)), Vector((sx * 0.3, REAR_Y + 0.3, AXIS_Z + sz * 0.3)),
                  c + Vector((-sx * 0.12, 0.26, -sz * 0.12))], 0.03, 'CrashBrass', COPPER, segs=3)
        mb.cyl(0.05, 0.05, 0.08, 6, Vector((sx * 0.3, REAR_Y + 0.3, AXIS_Z + sz * 0.3)), 'CrashPaint', RED)
        # A strut from the bulkhead's rim to the collar.
        rim = Vector((sx * 0.78, REAR_Y + 0.02, AXIS_Z + sz * 0.78))
        mb.tube(rim, c + Vector((sx * 0.2, 0.2, sz * 0.2)), 0.028, 'CrashMetal', STEEL, segs=4)
    # Spherical tanks and boxes between the nozzles, on the bulkhead.
    for i, (sx, sz) in enumerate(((1, 0), (0, 1), (-1, 0), (0, -1))):
        c = Vector((sx * 0.74, REAR_Y + 0.17, AXIS_Z + sz * 0.74))
        if i % 2 == 0:
            mb.lathe([(0.0, -0.17), (0.12, -0.13), (0.17, 0.0), (0.12, 0.13), (0.0, 0.17)], 8, 'CrashPaint',
                     HULL_LT if i else ORANGE, m=T(c) @ R(x=PI / 2))
        else:
            mb.box((0.3, 0.26, 0.22), c, 'CrashMetal', HULL_DK, rot=(0, 0, 0))
            mb.box((0.18, 0.04, 0.1), c + Vector((0, 0.14, 0)), 'CrashPaint', RED)
    # Gimbal actuators on two of them, the pump housing.
    mb.cyl(0.16, 0.18, 0.3, 8, (0, REAR_Y + 0.3, AXIS_Z), 'CrashMetal', HULL_DK, rot=(PI / 2, 0, 0))
    mb.cyl(0.1, 0.1, 0.12, 8, (0, REAR_Y + 0.48, AXIS_Z), 'CrashBrass', BRASS, rot=(PI / 2, 0, 0))
    for sx in (-1, 1):
        mb.tube(Vector((sx * 0.25, REAR_Y + 0.15, AXIS_Z)), Vector((sx * 0.45, REAR_Y + 0.4, AXIS_Z + 0.42)), 0.035,
                'CrashMetal', IRON, segs=5)
    mb.burn(Vector((0, REAR_Y + 0.6, AXIS_Z)), 1.3, 0.55)
    info['rear'] = mb.W(Vector((0, REAR_Y + 0.25, AXIS_Z + 0.55)))


def build_chute(mb, rng, rear):
    """The drogue canopy trailing on the sand behind the pod (pose CHUTE_POSE's ground frame): gores of orange and
    off-white, crumpled and half-collapsed, one lobe still holding some air; the shroud lines run back to the pod."""
    c = Vector((0.9, 7.6, 0.0))   # its middle on the sand, behind and a little to the right
    segs, rings = 16, 6
    rad = 2.3

    def z_at(i, k):
        a = 2 * PI * i / segs
        t = k / rings
        fold = 0.12 * math.sin(a * 5 + k * 0.7) * t
        lobe = 0.75 * max(0.0, math.cos(a - 2.2)) ** 2 * math.sin(PI * min(1.0, t * 1.1))
        return 0.05 + fold + lobe * (1 - t * 0.3)

    grid = []
    for k in range(rings + 1):
        t = k / rings
        row = []
        for i in range(segs):
            a = 2 * PI * i / segs
            r = rad * t * (1 + 0.12 * math.sin(a * 3 + 1))
            # Stretched out away from the pod, drawn in towards it.
            x, y = math.cos(a) * r * 0.82, math.sin(a) * r * 1.15
            row.append(Vector((c.x + x, c.y + y, z_at(i, k))))
        grid.append(row)
    rows = [grid[0]] + grid[1:]
    mb.loft(rows, 'PodCloth', CLOTH_W, colfn=lambda k, i: CLOTH_O if i % 2 else CLOTH_W)
    # The skirt's hem: a slightly darker band.
    hem = [p + Vector((0, 0, -0.02)) for p in grid[-1]]
    mb.loft([grid[-1], hem], 'PodCloth', 0xb24f22)
    # The shroud lines from the hem's near half to a riser, then to the pod's back.
    riser = Vector((0.45, 4.2, 0.06))
    for i in range(segs):
        a = 2 * PI * i / segs
        if math.sin(a) > 0.35:
            continue
        p = grid[-1][i]
        mid = p.lerp(riser, 0.5) + Vector((0, 0, 0.03))
        mb.sweep([p, mid, riser], 0.011, 'PodCloth', 0xcfc6b0, segs=3)
    mb.sweep([riser, riser.lerp(rear, 0.4) + Vector((0, 0, 0.05)), rear], 0.025, 'PodCloth', YELLOW, segs=4)


def pose_matrix(pitch, roll, h):
    """Blender-space pose: turn about the axis's middle, then set the axis h over the sand."""
    return T(0, 0, h) @ R(x=pitch) @ R(y=roll) @ T(0, 0, -AXIS_Z)


def to_three(M):
    """A Blender-space affine matrix as three.js space (three = (x, z, -y))."""
    C = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))
    return C @ M @ C.inverted()


def capsules_for(obj, M, caps):
    """The pose's capsules in its ground frame (three.js x/z), each with its top read off the posed mesh."""
    verts = [M @ v.co for v in obj.data.vertices]
    out = []
    for a, b, r in caps:
        a, b = M @ Vector(a), M @ Vector(b)
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


# The pod's solid shape, in its mesh frame: the hull's barrel and nose, the nozzles.
BODY_CAPS = [((0, -1.05, AXIS_Z), (0, 0.6, AXIS_Z), 1.24), ((0, 1.45, AXIS_Z), (0, 1.75, AXIS_Z), 0.95)]


def write_ts(poses, path, tris):
    f = cs.fmt
    lines = [
        '// Generated by tools/blender/pod.py — do not edit by hand. three.js coords (Y up, metres; the nose is +Z).',
        'export type PodCapsule = { x: number; z: number; ax: number; az: number; half: number; r: number; h: number };',
        '/** How a pod lies (public/models/pod.glb, node Pod): `m` the pose (three.js, row-major 3×4: the mesh into the',
        ' *  ground frame, origin on the sand under the pod\'s middle, +Z the way it was going), its solid capsules in that',
        ' *  frame (top h above the sand), the hatch (a point and the way it faces), where a player stands beside it, and',
' *  its beacon, and the spouts of its water tanks (where the canteen fills: shared/pods.ts atPodTap). */',
        'export type PodPose = { name: string; m: number[]; caps: PodCapsule[]; hatch: [number, number, number];',
        '  hatchN: [number, number, number]; stand: [number, number]; light: [number, number, number]; taps: [number, number, number][] };',
        f'/** {tris} triangles. */',
        'export const POD_POSES: PodPose[] = [',
    ]
    for p in poses:
        m = [f(p['m'][r][c], 4) for r in range(3) for c in range(4)]
        caps = ', '.join('{ ' + ', '.join(f'{n}: {f(c[n], 3 if n in ("ax", "az") else 2)}'
                                           for n in ('x', 'z', 'ax', 'az', 'half', 'r', 'h')) + ' }' for c in p['caps'])
        v3 = lambda v: '[' + ', '.join(f(x) for x in cs.three(v)) + ']'  # noqa: E731
        lines.append(f"  {{ name: '{p['name']}', m: [{', '.join(m)}], caps: [{caps}],")
        lines.append(f"    hatch: {v3(p['hatch'])}, hatchN: {v3(p['hatch_n'])}, stand: [{f(p['stand'][0])}, {f(p['stand'][1])}],"
                     f" light: {v3(p['light'])}, taps: [{', '.join(v3(t) for t in p['taps'])}] }},")
    lines.append('];')
    lines.append(f'/** The pose the drogue chute (node Pod_Chute, in that pose\'s ground frame) trails behind. */')
    lines.append(f'export const POD_CHUTE_POSE = {CHUTE_POSE};')
    lines.append('')
    with open(path, 'w') as fh:
        fh.write('\n'.join(lines))


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models', 'pod.glb'))
    ap.add_argument('--ts', default=os.path.join(ROOT, 'shared', 'podModel.ts'))
    ap.add_argument('--preview', default=None, help='directory for PNG previews')
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in cs.MATERIALS.items():
        cs.make_material(name, *spec)
    cs.make_material('PodCloth', 0.0, 0.95, True, None)

    info = {}
    mb = MeshBuilder()
    build_hull(mb, Rng(5), info)
    build_rear(mb, Rng(9), info)
    pod = cs.make_object('Pod', mb)
    zs = [v.co.z for v in pod.data.vertices]
    ys = [v.co.y for v in pod.data.vertices]
    xs = [v.co.x for v in pod.data.vertices]
    print(f'Pod: tris={cs.tri_count(pod)} x {min(xs):.2f}..{max(xs):.2f} y {min(ys):.2f}..{max(ys):.2f} z {min(zs):.2f}..{max(zs):.2f}')

    poses = []
    for name, pitch, roll, h in POSES:
        M = pose_matrix(pitch, roll, h)
        caps = capsules_for(pod, M, BODY_CAPS)
        hatch, hn = M @ info['hatch'], (M.to_3x3() @ info['hatch_n']).normalized()
        centre = M @ Vector((0, -0.2, AXIS_Z))
        # Where a player stands: beside the tap nearest to hand height (so new players arrive at water), else the hatch.
        taps = [M @ t for t in info['taps']]
        tap = min(taps, key=lambda t: abs(t.z - 1.3))
        c2 = Vector((centre.x, centre.y))
        d = Vector((tap.x, tap.y)) - c2
        if d.length < 0.3:
            d = Vector((hn.x, hn.y)) if Vector((hn.x, hn.y)).length > 0.35 else Vector((-1, 0))
        d.normalize()
        stand = c2 + d * (1.24 + 1.3)
        # (Close enough to the tap to fill: shared/pods.ts POD_TAP_REACH.)
        if (stand - Vector((tap.x, tap.y))).length > 1.4:
            stand = Vector((tap.x, tap.y)) + (stand - Vector((tap.x, tap.y))).normalized() * 1.4
        poses.append({'name': name, 'm': to_three(M), 'M': M, 'caps': caps, 'hatch': hatch, 'hatch_n': hn,
                      'stand': (stand.x, -stand.y), 'light': M @ info['light'], 'taps': taps})
        zz = [(M @ v.co).z for v in pod.data.vertices]
        print(f'pose {name}: z {min(zz):.2f}..{max(zz):.2f} caps {[(round(c["half"], 2), round(c["h"], 2)) for c in caps]} stand {stand}')

    mb = MeshBuilder()
    rear = poses[CHUTE_POSE]['M'] @ info['rear']
    build_chute(mb, Rng(3), rear)
    chute = cs.make_object('Pod_Chute', mb)
    print(f'Pod_Chute: tris={cs.tri_count(chute)}')
    tris = cs.tri_count(pod)

    bpy.context.view_layer.update()
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    cs.export_glb([pod, chute], args.out)
    write_ts(poses, args.ts, tris)
    if args.preview:
        render(pod, chute, poses, os.path.abspath(args.preview))


def render(pod, chute, poses, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    scene, cam, ground = cs.setup_scene()
    scene.render.resolution_x, scene.render.resolution_y = 1600, 900

    def shoot(name, target, az, el, dist, lens=35):
        cs.look(cam, target, math.radians(az), math.radians(el), dist, lens)
        scene.render.filepath = os.path.join(out_dir, name)
        bpy.ops.render.render(write_still=True)

    # The model alone, lying flat, from round about.
    chute.hide_render = True
    shoot('pod_front34.png', (0, 0, 1.2), -60, 18, 8.5)
    shoot('pod_back34.png', (0, 0.6, 1.2), 50, 20, 8)
    shoot('pod_back.png', (0, 1.4, 1.2), 90, 8, 6.5)
    shoot('pod_side.png', (0, 0.2, 1.2), 180, 10, 8.5)
    shoot('pod_top.png', (0, 0.2, 1.2), 200, 55, 8)
    shoot('pod_rear_close.png', (0.6, 1.2, 1.6), 30, 25, 3.2)
    shoot('pod_tank.png', (-1.0, 0.1, 1.9), 165, 22, 3.0)
    # The four poses side by side, as they lie.
    copies = []
    for i, p in enumerate(poses):
        o = pod.copy()
        o.data = pod.data
        bpy.context.scene.collection.objects.link(o)
        off = T(i * 6.5 - 9.75, 0, 0)
        o.matrix_world = off @ p['M']
        copies.append(o)
        if i == CHUTE_POSE:
            c = chute.copy()
            bpy.context.scene.collection.objects.link(c)
            c.matrix_world = off
            c.hide_render = False
            copies.append(c)
    pod.hide_render = True
    shoot('poses.png', (0, 2, 0.8), -70, 22, 22)
    shoot('poses_back.png', (0, 2, 0.8), 110, 18, 22)
    for i in range(len(poses)):
        shoot(f'pose_{poses[i]["name"]}.png', (i * 6.5 - 9.75, 1.0, 0.8), -50, 18, 9)


if __name__ == '__main__':
    main()
