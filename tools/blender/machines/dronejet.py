"""The fixed-wing drone, one of the two jets (shared/jets.ts; the other is the flying wing, plane.py): an unmanned recon/strike plane,
MQ-9 / Bayraktar-like (the first jet model, tools/blender/jet.py of 9e9e251, cut into pieces for the crash). A slim fuselage with a satcom
bulge over the nose and a sensor ball under the chin, the intake hump over the back running into the jet nozzle, long straight wings with
ailerons and flaps and two pylons a wing with a missile on each, a V tail and a ventral fin, worn sand camo blotches on top. No engine to
salvage: its wreck drops parts instead (shared/tables.ts DRONE_JET_SPOILS).

    tools/blender/run.sh -b --python tools/blender/machines/dronejet.py [-- --preview dir]     # writes public/models/dronejet.glb

Three.js frame (Y up, +Z the nose, span along X), origin about the centre of mass, turned into Blender's Z-up just before export like the
other models. An 18 m span (shared/jets.ts JET_SPAN.drone), 11.4 m long; metres.

  Jet_Body     the whole plane as it flies
  P_<id>       the pieces it breaks into when it comes in (shared/dronejetpieces.ts, generated with this): nose, front (the wing roots),
               rear, tail (the V tail and the nozzle), the wings (with their missiles), skin panels and spars, each about its own pivot
               (the node's position) as it sat on the whole plane
  Tail         an empty at the nozzle exit, where the smoke streams from (src/world/jets.ts LOOKS.drone.tail)
"""

import math
import os
import random
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kit  # noqa: E402
from kit import MB, PI, T, Rx, Rz, aim  # noqa: E402

OUT = os.path.join(kit.ROOT, 'public', 'models')

MATERIALS = {
    'JetHull': (0x3a332d, 0.45, 0.6),      # the old jets' grey-brown
    'JetSand': (0x8a7556, 0.25, 0.75),     # worn sand camo blotches on top
    'JetFlap': (0x2a2420, 0.45, 0.6),      # control surfaces, a shade darker
    'JetDark': (0x15110f, 0.6, 0.45),      # intake, nozzle inside, panel lines, rubber
    'JetSteel': (0x6a6158, 0.8, 0.35),     # nozzle, intake lip, rails, probes
    'JetBurnt': (0x3b2a22, 0.7, 0.5),      # heat-stained nozzle band
    'JetGlass': (0x0c0d10, 0.3, 0.1),      # sensor windows
    'JetMissile': (0x8b8574, 0.3, 0.55),   # pale grey missile bodies
    'JetBand': (0xa8823a, 0.2, 0.6),       # yellow-brown warhead band
}

TAIL = (0, 0.5, -5.8)


def lerp(a, b, t):
    return a + (b - a) * t


def disc(mb, c, n, r, segs, mat):
    """A flat polygon at c facing n."""
    mb.push(aim(Vector(c), n))
    f = [mb.F([mb.V((r * math.cos(2 * PI * k / segs), r * math.sin(2 * PI * k / segs), 0)) for k in range(segs)], mat)]
    mb.pop()
    return f


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
NOSE_TIP = (0, 0.03, 5.62)
# intake hump over the back into the nozzle: z, half width, half height, centre y
HUMP = [(0.78, 0.25, 0.17, 0.68), (0.98, 0.33, 0.25, 0.68), (0.92, 0.36, 0.29, 0.68), (0.4, 0.4, 0.33, 0.67),
        (-0.8, 0.43, 0.37, 0.65), (-2.4, 0.42, 0.38, 0.6), (-3.8, 0.39, 0.37, 0.54), (-4.9, 0.37, 0.37, 0.5)]


def fuse_at(z):
    for a, b in zip(FUSE, FUSE[1:]):
        if a[0] <= z <= b[0]:
            t = (z - a[0]) / (b[0] - a[0])
            return [lerp(a[i], b[i], t) for i in range(1, 5)]
    return list(FUSE[-1][1:5]) if z > 0 else list(FUSE[0][1:5])


def fuse_top(z):
    hw, ht, hb, cy = fuse_at(z)
    return cy + ht


def fuse_bot(z):
    hw, ht, hb, cy = fuse_at(z)
    return cy - hb


def hump_at(z):
    """The hump's half width, half height and centre height at z (its swept part, behind the intake lip)."""
    hs = HUMP[2:]
    for a, b in zip(hs, hs[1:]):
        if b[0] <= z <= a[0]:
            t = (a[0] - z) / (a[0] - b[0])
            return [lerp(a[i], b[i], t) for i in range(1, 4)]
    return list(hs[0][1:4]) if z > 0 else list(hs[-1][1:4])


def surface(mb, sections, M, top_camo=True, flap_from=0.0, cap_tip=True, mirror=False, cap_root=False):
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
    if cap_root:
        faces.append(mb.F(list(reversed(vr[0])), 'JetDark'))
    mb.fix(faces)
    mb.pop()
    return faces


def missile(mb, x, y, z0, z1, r=0.09):
    """A Hellfire-ish missile from z0 (tail) to z1 (nose) along +Z at (x, y)."""
    prof = [(0.0, z0 - 0.02), (r * 0.8, z0), (r, z0 + 0.06), (r, z1 - 0.42), (r, z1 - 0.28), (r * 0.96, z1 - 0.26),
            (r * 0.7, z1 - 0.1), (r * 0.25, z1), (0.0, z1 + 0.01)]
    mats = ['JetDark', 'JetMissile', 'JetMissile', 'JetBand', 'JetMissile', 'JetMissile', 'JetGlass', 'JetGlass']
    mb.lathe(prof, 8, 'JetMissile', M=T(x, y, 0), matfn=lambda k, _: mats[min(k, len(mats) - 1)], phase=PI / 8)
    for a in range(4):
        R = T(x, y, 0) @ Rz(PI / 4 + a * PI / 2)
        mb.box((0, r + 0.06, z0 + 0.16), (0.012, 0.13, 0.22), 'JetMissile', M=R, taper=(1, 0.5))
        mb.box((0, r + 0.03, z1 - 0.62), (0.01, 0.07, 0.1), 'JetMissile', M=R)


# ---- the parts of the plane, each usable whole or for a piece --------------------------------------------------------------------

def fuselage(mb):
    """The whole fuselage, with dark panel-line bands, and the satcom radome."""
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
    tip = mb.V(NOSE_TIP)
    faces += [mb.F([vr[-1][k], vr[-1][(k + 1) % SEGS], tip], 'JetHull') for k in range(SEGS)]
    faces.append(mb.F(list(reversed(vr[0])), 'JetHull'))
    mb.fix(faces)
    radome(mb)


def radome(mb):
    mb.sphere((0, 0.6, 3.6), 0.5, 'JetFlap', 10, 5, scale=(0.92, 0.66, 1.7))


def noise(a, b):
    return 0.5 + 0.5 * math.sin(a * 1.7 + math.sin(b * 2.3) * 2.0) * math.sin(b * 1.9 + a * 0.7)


def fuse_section(mb, z0, z1, ragged=(True, True), seed=0):
    """The fuselage between z0 and z1 (broken off: its torn ends ragged and dark inside), the same skin as the whole; it runs into the nose
    tip if z1 is the nose."""
    zs = sorted({z0, z1, *[f[0] for f in FUSE if z0 < f[0] < z1]})
    rings = []
    for i, z in enumerate(zs):
        hw, ht, hb, cy = fuse_at(z)
        r = ring_pts(z, hw, ht, hb, cy, SEGS)
        if (i == 0 and ragged[0]) or (i == len(zs) - 1 and ragged[1]):
            r = [(x * (0.82 + 0.26 * noise(k * 1.7 + seed, z)), cy + (y - cy) * (0.82 + 0.26 * noise(k * 2.3 + seed, z + 1)), z + 0.25 * (noise(k + seed, 5) - 0.5))
                 for k, (x, y, _) in enumerate(r)]
        rings.append(r)

    def mat(i, k):
        m = next((f[5] for f in FUSE if abs(f[0] - zs[i]) < 1e-6), None)
        if m is not None and i < len(zs) - 1 and zs[i + 1] - zs[i] < 0.1:
            return m
        p = rings[i][k]
        return camo(p[0] * 3, p[2]) if 0 < k < SEGS // 2 else 'JetHull'

    nose_end = z1 >= FUSE[-1][0]
    mb.loft(rings, 'JetHull', cap0=True, cap1=not nose_end, matfn=mat, capmat='JetDark')
    if nose_end:
        mb.fan(rings[-1], NOSE_TIP, 'JetHull')


def hump(mb, z0=-4.9, z1=0.98, ragged=(False, False), seed=0):
    """The intake hump between z0 and z1: with z1 at its front, the dark intake and its steel lip."""
    if z1 >= HUMP[1][0]:
        rows = [h for h in HUMP if h[0] >= z0]
        if rows[-1][0] > z0:
            rows.append((z0, *hump_at(z0)))
        lip = True
    else:
        rows = [(z1, *hump_at(z1))] + [h for h in HUMP[2:] if z0 < h[0] < z1] + [(z0, *hump_at(z0))]
        lip = False
    hr = []
    for i, (z, rx, ry, cy) in enumerate(rows):
        r = ring_pts(z, rx, ry, ry, cy, SEGS, 2.0)
        if (i == len(rows) - 1 and ragged[0]) or (i == 0 and not lip and ragged[1]):
            r = [(x * (0.85 + 0.2 * noise(k * 1.3 + seed, z)), cy + (y - cy) * (0.85 + 0.2 * noise(k * 2.9 + seed, z)), z) for k, (x, y, _) in enumerate(r)]
        hr.append(r)

    def hump_mat(i, k):
        if lip and i == 0:
            return 'JetDark'
        if lip and i == 1:
            return 'JetSteel'
        p = hr[i][k]
        return camo(p[0] * 3, p[2]) if 0 < k < SEGS // 2 else 'JetHull'

    mb.loft(hr, 'JetHull', cap0=True, cap1=ragged[0], capmat='JetDark', matfn=hump_mat)


def nozzle(mb):
    """Outer shell, heat band, lip, dark inside, turbine cone."""
    noz = [(0.37, -4.9), (0.365, -5.2), (0.35, -5.45), (0.32, -5.78), (0.27, -5.8), (0.255, -5.55), (0.2, -5.4),
           (0.1, -5.36), (0.0, -5.5)]
    nm = ['JetSteel', 'JetBurnt', 'JetBurnt', 'JetSteel', 'JetDark', 'JetDark', 'JetDark', 'JetDark']
    mb.lathe(noz, SEGS, 'JetSteel', M=T(0, 0.5, 0), matfn=lambda k, _: nm[min(k, len(nm) - 1)])


def dorsal(mb, zs):
    """Blade antennas over the back at these z."""
    for z, h in ((-1.2, 0.32), (-2.9, 0.22)):
        if z in zs:
            mb.box((0, 0.65 + 0.36 + h / 2, z), (0.03, h, 0.3), 'JetDark', taper=(1, 0.45))


def chin(mb):
    """The sensor ball under the chin, and a pitot probe off the nose."""
    zb = 3.95
    yb = fuse_bot(zb)
    mb.cyl((0, yb + 0.1, zb), (0, yb - 0.14, zb), 0.2, 0.17, 10, 'JetHull')
    mb.sphere((0, yb - 0.38, zb), 0.29, 'JetHull', 12, 7)
    d = Vector((0, -0.45, 1)).normalized()
    c = Vector((0, yb - 0.38, zb)) + d * 0.27
    mb.cyl(tuple(c - d * 0.02), tuple(c + d * 0.04), 0.17, 0.15, 10, 'JetDark')
    disc(mb, tuple(c + d * 0.045), d, 0.12, 10, 'JetGlass')
    d2 = Vector((0.45, -0.35, 1)).normalized()
    c2 = Vector((0, yb - 0.38, zb)) + d2 * 0.28
    disc(mb, tuple(c2), d2, 0.05, 6, 'JetGlass')
    mb.cyl((0.3, 0.05, 4.7), (0.33, 0.06, 5.4), 0.018, 0.01, 4, 'JetSteel')


def belly(mb, z0, z1):
    """Blade antennas, a whip and gear-door outlines under the belly, those between z0 and z1."""
    for z, h in ((0.6, 0.28), (-2.6, 0.2)):
        if z0 <= z <= z1:
            mb.box((0, fuse_bot(z) - h / 2 + 0.02, z), (0.03, h, 0.26), 'JetDark', taper=(1, 1.6))
    if z0 <= -1.6 <= z1:
        mb.cyl((0.0, fuse_bot(-1.6) + 0.02, -1.6), (0.0, fuse_bot(-1.6) - 0.5, -1.75), 0.012, 0.008, 4, 'JetDark')
    for a, b in ((2.6, 3.5), (-0.6, 0.4)):
        if not (z0 <= a and b <= z1):
            continue
        for s in (-1, 1):
            mb.box((s * 0.17, fuse_bot((a + b) / 2) + 0.005, (a + b) / 2), (0.025, 0.03, b - a), 'JetDark')
        for z in (a, b):
            mb.box((0, fuse_bot(z) + 0.005, z), (0.36, 0.03, 0.025), 'JetDark')
    if z0 <= 1.8 <= z1:
        mb.lathe([(0.12, 0), (0.1, 0.05), (0.0, 0.07)], 8, 'JetSteel', M=T(0, fuse_top(1.8) - 0.01, 1.8) @ Rx(-PI / 2))


WING_S = (0.3, 1.4, 2.8, 4.2, 5.6, 7.0, 8.2, 9.0)
PYLONS = (2.6, 4.3)


def wing_secs(a=0.3, b=9.0):
    """A wing's sections (s, le_z, chord, thick, y) from s = a out to b."""
    out = []
    for s in sorted({a, b, *[t for t in WING_S if a < t < b]}):
        u = s / 9
        out.append((s, 1.15 - 0.05 * s, lerp(1.55, 0.62, u), lerp(0.13, 0.06, u), 0.12 + 0.035 * s))
    return out


def wing(mb, mirror, a=0.3, b=9.0, stores=True):
    """A wing (s from a to b) with its pylons and missiles."""
    sg = -1 if mirror else 1
    surface(mb, wing_secs(a, b), Matrix.Identity(4), mirror=mirror, flap_from=0.6, cap_root=a > 0.3)
    if not stores:
        return
    for s in PYLONS:
        y = 0.12 + 0.035 * s
        le = 1.15 - 0.05 * s
        x = sg * s
        mb.box((x, y - 0.17, le - 0.55), (0.07, 0.2, 0.8), 'JetHull', taper=(1, 1.25))
        mb.box((x, y - 0.29, le - 0.55), (0.05, 0.04, 0.9), 'JetSteel')
        missile(mb, x, y - 0.4, le - 1.45, le + 0.2)


def tail_fins(mb):
    """The V tail (fins 43 degrees off vertical) and a small ventral fin."""
    for mirror in (False, True):
        sg = -1 if mirror else 1
        secs = [(0.0, -3.65, 1.35, 0.075, 0.0), (1.2, -3.95, 1.0, 0.06, 0.0), (2.35, -4.27, 0.58, 0.04, 0.0)]
        surface(mb, secs, T(sg * 0.18, 0.5, 0) @ Rz(sg * 0.75), mirror=mirror, flap_from=0.3)
    secs = [(0.0, -4.0, 1.0, 0.05, 0.0), (0.55, -4.25, 0.65, 0.035, 0.0)]
    surface(mb, secs, T(0, fuse_bot(-4.4) + 0.05, 0) @ Rz(-PI / 2), top_camo=False, flap_from=9)


def build_body():
    mb = MB()
    fuselage(mb)
    hump(mb)
    nozzle(mb)
    dorsal(mb, (-1.2, -2.9))
    chin(mb)
    belly(mb, -9, 9)
    for mirror in (False, True):
        wing(mb, mirror)
    tail_fins(mb)
    return mb


# ---- the pieces it breaks into -------------------------------------------------------------------------------------------------

def pieces():
    """What the plane breaks into when it comes in (src/world/jets.ts flies them apart with shared/jetbreak.ts): each piece is cut from the whole
    plane (ragged where it tore), built about its own pivot, and has its own simple hitboxes (capsules, centre and axis about the pivot).
    Returns [{id, pivot, mb, caps, hit, f, ...}]: `f` is how much of the plane's speed it keeps (heavy things less), `hit`
    whether it is solid for the players once it lies."""
    rnd = random.Random(7)
    out = []

    def add(pid, pivot, build, caps, hit=True, f=0.2, skip=(), extra=()):
        mb = MB()
        mb.push(T(-pivot[0], -pivot[1], -pivot[2]))
        build(mb)
        mb.pop()
        out.append({'id': pid, 'pivot': pivot, 'mb': mb, 'hit': hit, 'f': f, 'skip': skip,
                    'extra': [tuple(e[i] - pivot[i] for i in range(3)) for e in extra],
                    'caps': [{'c': tuple(c[i] - pivot[i] for i in range(3)), 'a': a, 'half': h, 'r': r, 'hv': (cp[4] if len(cp) > 4 else r)}
                             for cp in caps for (c, a, h, r) in [cp[:4]]]})

    def fus_caps(z0, z1, n):
        """The fuselage between z0 and z1 as n capsules along it, each as fat as the skin there."""
        out_ = []
        for i in range(n):
            za, zb = z0 + (z1 - z0) * i / n, z0 + (z1 - z0) * (i + 1) / n
            zm = (za + zb) / 2
            hw, ht, hb, cy = fuse_at(zm)
            out_.append(((0, cy + (ht - hb) / 2, zm), (0, 0, 1), (zb - za) / 2, hw * 0.97, (ht + hb) / 2 * 0.97))
        return out_

    def hump_cap(z0, z1):
        rx, ry, cy = hump_at((z0 + z1) / 2)
        return ((0, cy, (z0 + z1) / 2), (0, 0, 1), (z1 - z0) / 2, rx, ry)

    def wing_caps(sg, a, b):
        """A wing between s = a and b, slab capsules a section long: as wide as the chord there, as thick as the wing."""
        secs = wing_secs(a, b)
        out_ = []
        for (s0, le0, c0, t0, y0), (s1, le1, c1, t1, y1) in zip(secs, secs[1:]):
            ch, th = (c0 + c1) / 2, (t0 + t1) / 2
            out_.append(((sg * (s0 + s1) / 2, (y0 + y1) / 2 + th * 0.3, (le0 + le1) / 2 - ch / 2), (1, 0, 0), (s1 - s0) / 2, ch / 2, th / 2 + 0.03))
        return out_

    def wing_pts(sg, a, b):
        # the wing really is thin: it touches the sand with its own edges, and the missiles under it
        pts = []
        for (s, le, ch, th, y) in wing_secs(a, b):
            pts += [(sg * s, y - th * 0.42, le - ch * 0.25), (sg * s, y, le - ch), (sg * s, y, le)]
        for s in PYLONS:
            y, le = 0.12 + 0.035 * s, 1.15 - 0.05 * s
            pts += [(sg * s, y - 0.5, le - 1.4), (sg * s, y - 0.5, le + 0.1)]
        return pts

    # the cuts along the fuselage
    Z_NOSE, Z_FRONT, Z_REAR = 2.1, -1.0, -3.4

    def nose(mb):
        fuse_section(mb, Z_NOSE, FUSE[-1][0], (True, False), 11)
        radome(mb)
        chin(mb)

    def front(mb):
        fuse_section(mb, Z_FRONT, Z_NOSE, (True, True), 3)
        hump(mb, Z_FRONT, 0.98, (True, False), 3)
        belly(mb, Z_FRONT, Z_NOSE)
        for mirror in (False, True):
            wing(mb, mirror, 0.3, 1.4, stores=False)

    def rear(mb):
        fuse_section(mb, Z_REAR, Z_FRONT, (True, True), 8)
        hump(mb, Z_REAR, Z_FRONT, (True, True), 8)
        dorsal(mb, (-1.2, -2.9))
        belly(mb, Z_REAR, Z_FRONT)

    def tail(mb):
        fuse_section(mb, FUSE[0][0], Z_REAR, (False, True), 5)
        hump(mb, -4.9, Z_REAR, (False, True), 5)
        nozzle(mb)
        tail_fins(mb)

    add('nose', (0, 0.15, 3.6), nose, fus_caps(Z_NOSE, 5.3, 3) + [((0, yb, 3.95), (0, 1, 0), 0.0, 0.3, 0.35) for yb in [fuse_bot(3.95) - 0.3]], f=0.2)
    add('front', (0, 0.2, 0.5), front, fus_caps(Z_FRONT, Z_NOSE, 2) + [hump_cap(Z_FRONT, 0.9)] + wing_caps(1, 0.3, 1.4) + wing_caps(-1, 0.3, 1.4), f=0.1)
    add('rear', (0, 0.3, -2.2), rear, fus_caps(Z_REAR, Z_FRONT, 2) + [hump_cap(Z_REAR, Z_FRONT)], f=0.14)
    # the V tail's fins: slabs out and up 43 degrees, as wide as their chord; the ventral fin a little slab down
    fin_d = lambda sg: (sg * math.cos(0.75), math.sin(0.75), 0)
    fin_caps = [((sg * (0.18 + 1.17 * math.cos(0.75)), 0.5 + 1.17 * math.sin(0.75), -4.45), fin_d(sg), 1.17, 0.5, 0.06) for sg in (1, -1)]
    add('tail', (0, 0.45, -4.4), tail, fus_caps(-5.3, Z_REAR, 2) + [hump_cap(-4.9, Z_REAR)] + fin_caps
        + [((0, fuse_bot(-4.4) - 0.22, -4.5), (0, 0, 1), 0.2, 0.06, 0.3)], f=0.2)
    wl, wr = wing_caps(-1, 1.4, 9.0), wing_caps(1, 1.4, 9.0)
    add('wingL', (-5.0, 0.3, 0.6), lambda mb: wing(mb, True, 1.4, 9.0), wl, f=0.22, skip=tuple(range(len(wl))), extra=wing_pts(-1, 1.4, 9.0))
    add('wingR', (5.0, 0.3, 0.6), lambda mb: wing(mb, False, 1.4, 9.0), wr, f=0.22, skip=tuple(range(len(wr))), extra=wing_pts(1, 1.4, 9.0))
    # skin panels, doors and spars that came off the body
    for i in range(7):
        sx, sy, sz = rnd.uniform(0.35, 1.0), rnd.uniform(0.04, 0.09), rnd.uniform(0.35, 0.8)
        ang, z = rnd.uniform(0.3, PI - 0.3) * (1 if i % 2 else -1), rnd.uniform(-4.5, 4.0)
        hw, ht, hb, cy = fuse_at(z)
        pos = (hw * 1.05 * math.sin(ang), cy + ht * 1.05 * math.cos(ang), z)
        add(f'panel{i}', pos, lambda mb, p=pos, sx=sx, sy=sy, sz=sz, i=i: mb.box(p, (sx, sy, sz), ['JetHull', 'JetSand', 'JetFlap', 'JetDark'][i % 4]),
            [(pos, (1, 0, 0), max(0.02, sx / 2 - sz / 2), sz / 2, sy / 2 + 0.02)], f=rnd.uniform(0.3, 0.45), skip=(0,),
            extra=[(pos[0] + a * sx / 2, pos[1] - sy / 2, pos[2] + b * sz / 2) for a in (-1, 1) for b in (-1, 1)])
    for i in range(3):
        z = rnd.uniform(-3.5, 3.5)
        hw, ht, hb, cy = fuse_at(z)
        pos = (rnd.choice([-1, 1]) * hw, cy + 0.15, z)
        d = (rnd.uniform(-1, 1), rnd.uniform(-0.3, 0.3), rnd.uniform(-1, 1))
        n = math.sqrt(sum(v * v for v in d))
        d = tuple(v / n for v in d)
        add(f'beam{i}', pos, lambda mb, p=pos, d=d: mb.beam(tuple(p[k] - d[k] * 0.8 for k in range(3)), tuple(p[k] + d[k] * 0.8 for k in range(3)), 0.1, 0.1, 'JetSteel'),
            [(pos, d, 0.8, 0.13)], f=rnd.uniform(0.35, 0.5))
    return out


def pieces_ts(ps):
    """shared/dronejetpieces.ts: what shared/jetbreak.ts needs of each piece, and src/world/jets.ts which node it is."""
    import json

    def r(v):
        return [round(x, 3) for x in v]

    rows = []
    for p in ps:
        pts = []
        for ci, cp in enumerate(p['caps']):
            if ci in p['skip']:
                continue
            c, a, h, rad = Vector(cp['c']), Vector(cp['a']).normalized(), cp['half'], cp['r']
            for sgn in (-1, 1):
                e = c + a * h * sgn
                for off in ((0, -cp['hv'], 0), (rad, 0, 0), (-rad, 0, 0), (0, 0, rad), (0, 0, -rad), (0, cp['hv'], 0)):
                    pts.append(r(e + Vector(off)))
        pts += [r(e) for e in p['extra']]
        caps = [{'c': r(cp['c']), 'a': [round(x, 3) for x in Vector(cp['a']).normalized()], 'half': round(cp['half'], 3), 'r': round(cp['r'], 3),
                 'hv': round(cp['hv'], 3)} for cp in p['caps']]
        rows.append(json.dumps({'id': p['id'], 'pivot': r(p['pivot']), 'f': round(p['f'], 3), 'hit': p['hit'], 'caps': caps, 'pts': pts}, separators=(',', ':')))
    body = ',\n  '.join(rows)
    return ('// Generated by tools/blender/machines/dronejet.py from the model: do not edit by hand.\n'
            "// The pieces a downed jet breaks into (public/models/dronejet.glb nodes `P_<id>`, origin at the pivot): where each was on the whole plane\n"
            '// (the plane\'s frame: x across, y up, z the nose), its simple hitboxes (capsules about the pivot: `r` the footprint radius, `hv` the half height), the points it touches the sand with, how much of\n'
            "// the plane's speed it keeps (`f`) and whether it is solid once it lies. Read by shared/jetbreak.ts.\n\n"
            "import type { JetPieceDef } from './jetpieces.ts';\n\n"
            f'export const DRONE_JET_PIECES: JetPieceDef[] = [\n  {body},\n];\n')


def make(mb, name, loc=None):
    import bmesh
    bmesh.ops.transform(mb.bm, matrix=kit.C, verts=mb.bm.verts)
    bmesh.ops.recalc_face_normals(mb.bm, faces=mb.bm.faces)
    mb.bm.normal_update()
    mesh = bpy.data.meshes.new(name)
    mb.bm.to_mesh(mesh)
    mb.bm.free()
    for m in mb.mats:
        mesh.materials.append(bpy.data.materials[m])
    obj = bpy.data.objects.new(name, mesh)
    if loc is not None:
        obj.location = kit.C @ Vector(loc)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def preview(objs, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    scene, cam, look, shoot = kit.preview_scene(ground_y_blender=-20)
    for name, pos, tgt, lens in (
        ('side', (20, 2, 2), (0, 0, 0), 38),
        ('34', (11, 8, 15), (0, 0, 0), 36),
        ('below', (3, -17, 4), (0, 0, 0), 32),
        ('rear', (-8, 3, -15), (0, 0.5, -2), 36),
        ('wreck', (15, 8, 13), (0, -0.5, 0), 36),
        ('wreck_rear', (-7, 3, -10), (0, 0, -2), 34),
    ):
        broken = name.startswith('wreck')
        for k, o in objs.items():
            o.hide_render = (k.startswith('P_') != broken) if k.startswith('P_') else broken
        if broken:  # spread a little so the cuts show
            for k, o in objs.items():
                if k.startswith('P_'):
                    o.location = kit.C @ (Vector(o['pivot3']) * 1.25)
        look(pos, tgt, lens)
        shoot(os.path.join(out_dir, f'dronejet_{name}.png'))


def main():
    a = kit.args()
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    for name, spec in MATERIALS.items():
        kit.make_material(name, *spec)
    ps = pieces()
    objs = [make(build_body(), 'Jet_Body')] + [make(q['mb'], 'P_' + q['id'], q['pivot']) for q in ps]
    tail = bpy.data.objects.new('Tail', None)
    tail.location = kit.C @ Vector(TAIL)
    bpy.context.scene.collection.objects.link(tail)
    os.makedirs(OUT, exist_ok=True)
    kit.export_glb(objs + [tail], os.path.join(OUT, 'dronejet.glb'))
    with open(os.path.join(kit.ROOT, 'shared', 'dronejetpieces.ts'), 'w', encoding='utf8', newline='\n') as f:
        f.write(pieces_ts(ps))
    for o in objs:
        print(f'{o.name}: tris={kit.tri_count(o)} size={o.dimensions.x:.1f} x {o.dimensions.z:.1f} x {o.dimensions.y:.1f} m')
    if a.preview:
        pv = {q['id']: q['pivot'] for q in ps}
        for o in objs:
            if o.name.startswith('P_'):
                o['pivot3'] = list(pv[o.name[2:]])
        preview({o.name: o for o in objs}, os.path.abspath(a.preview))


main()
