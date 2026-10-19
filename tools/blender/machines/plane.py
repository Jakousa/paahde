"""The jets (shared/jets.ts): a big unmanned flying wing, 32 m span and 16 m nose to tail, flown over the desert and brought down by the
rifle. No fuselage and no tail: one thick blended body that thins out into swept wings, a double-W trailing edge with elevons along it and
split drag rudders at the tips (the B-2 / B-21 and the sixth-generation fighter studies). Its two engines are not buried in the wing but ride
in pods on short pylons over its back (as on the X-48): the crashed turbofan's own (tools/blender/machines/turbofan.py), the same cowls,
fan case and nozzle, with a simple mock of the fan and its spinner behind the intake lip. When it comes down they tear off and lie beside the
wreck as the real thing, to be taken apart (src/teardown).

    tools/blender/run.sh -b --python tools/blender/machines/plane.py [-- --preview dir]     # writes public/models/jet.glb

Three.js frame (Y up, +Z the nose, span along X), origin about the centre of mass, metres, turned into Blender's Z-up just before
export like the other models.

  Jet_Body     the wing, its fittings and the left engine (what flies)
  Jet_EngineR  the right engine on its pylon
  P_<id>       the pieces it breaks into when it comes in (shared/jetpieces.ts, generated with this): the centre body, the inner, middle and
               outer wing panels each side, the engines, skin panels and spars, each about its own pivot (the node's position) as it sat on the
               whole plane
  P_<id>_x     an engine wrecked in the landing (instead of P_engineL / P_engineR)
  Tail         an empty at the left engine's exit, where the smoke streams from (src/world/jets.ts TAIL)
"""

import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kit  # noqa: E402
from kit import MB, PI, T, Rz, crush, ripple  # noqa: E402

OUT = os.path.join(kit.ROOT, 'public', 'models')

MATERIALS = {
    'JetHull': (0x3a332d, 0.45, 0.6),
    'JetSand': (0x8a7556, 0.25, 0.75),
    'JetFlap': (0x2a2420, 0.45, 0.6),
    'JetDark': (0x15110f, 0.6, 0.45),
    'JetSteel': (0x6a6158, 0.8, 0.35),
    'JetBurnt': (0x3b2a22, 0.7, 0.5),
    'JetGlass': (0x0c0d10, 0.3, 0.1),
    'Paint': (0xbdb8a8, 0.15, 0.7),     # the engine's cowls, as turbofan.py
    'Steel': (0x8d8f91, 0.85, 0.42),
    'Dark': (0x3d3f43, 0.8, 0.5),
    'Burnt': (0x5b4a3e, 0.7, 0.55),
    'Blade': (0xa3a4a6, 0.9, 0.35),
}


def noise(x, z):
    return 0.5 + 0.5 * math.sin(x * 0.9 + math.sin(z * 0.4) * 2.0) * math.sin(z * 0.55 + x * 0.3)


# ---- the wing: a planform and an airfoil at every station across the span -----------------------------------------------------------

HALF = 16.0          # half span
NOSE = 8.5           # the leading edges meet here (z)
SWEEP = 0.65         # leading edge: back this far (m) per metre out (33 degrees)
# the trailing edge, |x| -> z: the double W (a point at the middle, notches at 4 m, points again at 8 m, then straight out to the tip)
TE = [(0.0, -7.5), (4.0, -5.0), (8.0, -7.5), (HALF, -3.7)]
UP = 0.6             # the share of a section's thickness above its chord line
N = 12               # points along each of the upper and lower surfaces
# where sections are taken (|x|); the pieces are cut at 2.5, 8 and 12.5
STATIONS = [0.0, 0.6, 1.3, 2.0, 2.5, 3.2, 4.0, 4.6, 5.25, 6.0, 7.0, 8.0, 9.5, 11.0, 12.5, 13.6, 14.6, 15.4, 15.8, HALF]
# the elevons along the trailing edge and the split drag rudders at the tips (|x| from, to)
ELEVONS = [(4.6, 7.6), (8.4, 13.3)]
RUDDER = (13.6, 15.5)


def lerp_te(ax):
    for (xa, za), (xb, zb) in zip(TE, TE[1:]):
        if ax <= xb:
            return za + (zb - za) * (ax - xa) / (xb - xa)
    return TE[-1][1]


def station(x):
    """At span position x: the leading edge (z), the chord, the thickness and the chord line's height."""
    ax = min(abs(x), HALF)
    le = NOSE - SWEEP * (math.sqrt(ax * ax + 0.25) - 0.5)   # (the apex a little rounded)
    ch = le - lerp_te(ax)
    t = 0.14 + 1.9 * math.exp(-(ax / 2.8) ** 2) + 0.55 * (1 - ax / HALF)   # the blended centre body, thinning out to the tips
    t *= min(1.0, (HALF + 0.05 - ax) / 0.6) ** 0.5
    return le, ch, t, 0.0


def foil(u):
    """A section's thickness at u (0 the leading edge, 1 the trailing edge) as a share of its greatest (NACA 4-digit, closed trailing edge)."""
    u = min(max(u, 0.0), 1.0)
    return (0.2969 * math.sqrt(u) - 0.1260 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4) / 0.1002


US = [(1 - math.cos(PI * k / N)) / 2 for k in range(N + 1)]


def section(x):
    """The section ring at x: the upper surface from the trailing edge to the leading edge, then the lower one back (2N points)."""
    le, ch, t, y0 = station(x)
    up = [(x, y0 + t * UP * foil(u), le - u * ch) for u in reversed(US)]
    lo = [(x, y0 - t * (1 - UP) * foil(u), le - u * ch) for u in US[1:-1]]
    return up + lo


def surf_y(x, z, upper=True):
    """The wing's upper (or lower) surface height at (x, z)."""
    le, ch, t, y0 = station(x)
    f = foil((le - z) / ch)
    return y0 + t * UP * f if upper else y0 - t * (1 - UP) * f


def all_stations():
    return [-s for s in reversed(STATIONS[1:])] + STATIONS


def wing_mat(rings):
    """A face's material from where it is: burnt behind the engines, the elevons and leading edge darker, sand patches on top."""
    def m(i, k):
        a, b = rings[i], rings[i + 1]
        j = (k + 1) % len(a)
        x = (a[k][0] + a[j][0] + b[k][0] + b[j][0]) / 4
        z = (a[k][2] + a[j][2] + b[k][2] + b[j][2]) / 4
        upper = k < N
        le, ch, _, _ = station(x)
        u = (le - z) / ch
        ax = abs(x)
        if upper and abs(ax - ENG_X) < 0.75 and z < ENG_Z - 1.2:
            return 'JetBurnt'
        if u < 0.035 or (u > 0.82 and any(a0 <= ax <= a1 for a0, a1 in ELEVONS)):
            return 'JetFlap'
        if upper and noise(x * 0.7, z * 0.9) < 0.3:
            return 'JetSand'
        return 'JetHull'
    return m


def wing_loft(mb, x0, x1, ragged=(False, False), seed=0):
    """The wing between x0 and x1 (x0 < x1): sections at every station between and at both ends; a broken-off end is torn, dark inside."""
    xs = [x0] + [s for s in all_stations() if x0 + 1e-6 < s < x1 - 1e-6] + [x1]
    rings = [section(x) for x in xs]
    for end, (i, rag) in enumerate(((0, ragged[0]), (len(rings) - 1, ragged[1]))):
        if not rag:
            continue
        x = xs[i]
        _, _, _, y0 = station(x)
        rings[i] = [(px + 0.45 * (noise(k * 1.7 + seed, end * 3.0) - 0.5), y0 + (py - y0) * (0.7 + 0.35 * noise(k * 2.3 + seed, x)),
                     pz + 0.3 * (noise(k + seed, 5 + end) - 0.5)) for k, (px, py, pz) in enumerate(rings[i])]
    mb.loft(rings, 'JetHull', cap0=True, cap1=True, matfn=wing_mat(rings), capmat='JetDark' if any(ragged) else 'JetHull')


def rudders(mb, sgn):
    """The split drag rudders at a tip: an upper and a lower plate hinged on the trailing edge, a little open."""
    x0, x1 = RUDDER
    xm = (x0 + x1) / 2
    zte = lerp_te(xm)
    yaw = math.atan2(lerp_te(x1) - lerp_te(x0), x1 - x0)   # along the swept trailing edge
    for s in (1, -1):
        mb.box((sgn * xm, s * 0.1, zte + 0.42), (x1 - x0, 0.04, 0.9), 'JetFlap', rot=(s * 0.3, sgn * -yaw, 0))


def body_fittings(mb):
    """On the centre body: a sensor ball under the nose, a dark sensor visor up front, a satcom hump, blade antennas."""
    mb.sphere((0, surf_y(0, 6.0, False) - 0.05, 6.0), 0.38, 'JetGlass', u=12, v=7)
    mb.sphere((0, surf_y(0, 5.2) - 0.12, 5.2), 1.0, 'JetGlass', u=14, v=6, scale=(1.15, 0.22, 0.75))
    mb.sphere((0, surf_y(0, 0.4) - 0.28, 0.4), 1.0, 'JetHull', u=14, v=7, scale=(1.0, 0.4, 2.0))
    for x, z, h in ((0.0, -2.6, 0.7), (1.4, 3.0, 0.45), (0.0, -1.5, -0.5)):
        y = surf_y(x, z, h > 0)
        mb.box((x, y + h / 2, z), (0.04, abs(h), 0.5), 'JetSteel', taper=(1.0, 0.5) if h > 0 else (1.0, 1.0))
    # underneath (what the players see of it): the weapon bay doors and the gear doors, darker panels with sawtooth ends
    for x, z0, z1, w in ((0.85, 3.4, -1.6, 1.5), (-0.85, 3.4, -1.6, 1.5), (2.7, 2.6, -0.4, 1.0), (-2.7, 2.6, -0.4, 1.0)):
        zs = [z0 - (z0 - z1) * i / 6 for i in range(7)]
        dxs = [-1 + 2 * k / 6 for k in range(7)]   # (across it too: the skin is straight between its sections, the door must not dip under it)
        rings = [[(x + dx * w / 2, surf_y(x + dx * w / 2, z, False) - lift, z + (0.25 if i == 0 else -0.25 if i == 6 else 0) * dx)
                  for lift, d in ((0.015, dxs), (0.06, dxs[::-1])) for dx in d] for i, z in enumerate(zs)]
        mb.loft(rings, 'JetFlap', cap0=True, cap1=True)


# the engines: centre lines over the wing's back (the turbofan's frame: axis Z, fan towards +Z), the fan case's bottom GAP above the skin
ENG_X, ENG_Z = 4.3, -2.6
GAP = 0.55
ENG_Y = max(surf_y(ENG_X + dx, ENG_Z + dz) for dx in (-0.9, 0, 0.9) for dz in (-1.4, 0, 1.2)) + GAP + 0.93
TAIL = (-ENG_X, ENG_Y, ENG_Z - 1.45)


def engine(mb, cx, cy, cz):
    """The turbofan as it rides on the wing: the turbofan.py cowls and nozzle in one skin, a fan and its spinner in the intake, the pylon down
    into the wing."""
    M = T(cx, cy, cz)
    outer = [(0.80, 1.10), (0.835, 1.20), (0.885, 1.14), (0.915, 0.94), (0.925, 0.75), (0.905, 0.52), (0.86, -0.05), (0.80, -0.30), (0.70, -0.62),
             (0.50, -0.85), (0.37, -1.12), (0.35, -1.20), (0.27, -1.34), (0.255, -1.40)]
    mb.lathe(outer, 36, 'Paint', M=M)
    # inside the lip: the dark intake, the fan disc with its blades, the spinner
    mb.lathe([(0.0, 0.93), (0.78, 0.93), (0.78, 0.96), (0.0, 0.96)], 28, 'Dark', M=M)
    mb.lathe([(0.0, 0.96), (0.1, 0.99), (0.21, 1.06), (0.23, 1.1), (0.205, 1.18), (0.0, 1.24)], 20, 'Steel', M=M)
    for i in range(24):
        a = 2 * PI * i / 24
        mb.push(M @ Rz(a))
        mb.box((0.5, 0.0, 0.97), (0.55, 0.012, 0.13), 'Blade', rot=(0, 0.0, 0.5))
        mb.pop()
    # the burnt nozzle ring and the plug
    mb.lathe([(0.255, -1.40), (0.255, -1.43), (0.27, -1.43), (0.27, -1.34)], 18, 'Burnt', M=M)
    mb.lathe([(0.0, -1.12), (0.12, -1.12), (0.13, -1.25), (0.0, -1.46)], 16, 'Burnt', M=M)
    # the pylon down into the wing (its foot a little under the skin), narrowing up to the nacelle
    lo, hi = surf_y(cx, cz - 0.3) - 0.2, cy - 0.84
    mb.box((cx, (lo + hi) / 2, cz - 0.3), (0.36, hi - lo, 2.8), 'JetHull', taper=(0.8, 0.75))
    # the nacelle's own mounting ring where it meets the pylon
    mb.lathe([(0.915, 0.18), (0.94, 0.18), (0.94, 0.05), (0.915, 0.05)], 36, 'Dark', M=M)


def engine_husk(mb, cx, cy, cz):
    """An engine wrecked in the landing: the cowl crushed and burnt, no fan, the nozzle torn, the pylon snapped."""
    M = T(cx, cy, cz)
    outer = [(0.80, 1.10), (0.835, 1.20), (0.885, 1.14), (0.915, 0.94), (0.925, 0.75), (0.905, 0.52), (0.86, -0.05), (0.80, -0.30), (0.70, -0.62),
             (0.50, -0.85), (0.37, -1.12), (0.35, -1.20), (0.27, -1.34), (0.255, -1.40)]
    mb.lathe(outer, 24, 'Burnt', M=M)
    mb.lathe([(0.0, 0.93), (0.78, 0.93), (0.78, 0.96), (0.0, 0.96)], 20, 'JetDark', M=M)
    mb.lathe([(0.0, 0.96), (0.1, 0.99), (0.21, 1.06), (0.2, 1.1), (0.0, 1.12)], 14, 'JetDark', M=M)
    for i in range(6):  # stumps of fan blades
        mb.push(M @ Rz(2 * PI * i / 6 + 0.3))
        mb.box((0.3, 0.0, 0.97), (0.22, 0.012, 0.12), 'Steel')
        mb.pop()
    mb.box((cx, cy - 1.1, cz - 0.4), (0.36, 0.45, 1.6), 'JetHull')
    crush(mb, (cx + 0.9, cy + 0.3, cz + 0.6), 0.9, 0.5, toward=(cx, cy, cz))
    crush(mb, (cx - 0.5, cy - 0.7, cz - 0.4), 0.8, 0.45, toward=(cx, cy, cz))
    ripple(mb, 5, 0.04, 5.0)


def pieces():
    """What the plane breaks into when it comes in (src/world/jets.ts flies them apart with shared/jetbreak.ts): each piece is cut from the whole
    plane (ragged where it tore), built about its own pivot, and has its own simple hitboxes (capsules, centre and axis about the pivot).
    Returns [{id, pivot, mb, caps, hit, f}]: `f` is how much of the plane's speed it keeps (heavy things less), `hit` whether it is solid for
    the players once it lies."""
    import random
    rnd = random.Random(7)
    out = []

    def add(pid, pivot, build, caps, hit=True, f=0.2, skip=(), extra=(), parent=None, husk=None):
        mb = MB()
        mb.push(T(-pivot[0], -pivot[1], -pivot[2]))
        build(mb)
        mb.pop()
        out.append({'id': pid, 'pivot': pivot, 'mb': mb, 'hit': hit, 'f': f, 'skip': skip, 'parent': parent, 'husk': husk,
                    'extra': [tuple(e[i] - pivot[i] for i in range(3)) for e in extra],
                    'caps': [{'c': tuple(c[i] - pivot[i] for i in range(3)), 'a': a, 'half': h, 'r': r, 'hv': (cp[4] if len(cp) > 4 else r)}
                             for cp in caps for (c, a, h, r) in [cp[:4]]]})

    def slab_caps(x0, x1, n):
        """The wing between x0 and x1 as n slab capsules across it: as wide as the chord there, as thick as the wing."""
        caps = []
        for i in range(n):
            xa, xb = x0 + (x1 - x0) * i / n, x0 + (x1 - x0) * (i + 1) / n
            xm = (xa + xb) / 2
            le, ch, t, y0 = station(xm)
            caps.append(((xm, y0 + t * (UP - 0.5), le - ch * 0.45), (1, 0, 0), abs(xb - xa) / 2, ch / 2, t / 2 + 0.06))
        return caps

    def body_caps():
        """The centre body as runs of capsules along it, each as thick as the body there."""
        le, ch, _, _ = station(0)
        caps = []
        for i in range(4):
            za, zb = le - ch * (0.06 + 0.22 * i), le - ch * (0.06 + 0.22 * (i + 1))
            zm = (za + zb) / 2
            t = (surf_y(1.25, zm) - surf_y(1.25, zm, False))
            caps.append(((0, (surf_y(1.25, zm) + surf_y(1.25, zm, False)) / 2, zm), (0, 0, 1), (za - zb) / 2, 2.3, t / 2 + 0.05))
        return caps

    def outline(x0, x1):
        """The points the wing between x0 and x1 touches the sand with: its real outline (it is thin: not the fat capsules it is hit with)."""
        pts = []
        for x in sorted({x0, (x0 + x1) / 2, x1}):
            le, ch, t, y0 = station(x)
            for u in (0.0, 0.3, 0.65, 1.0):
                pts.append((x, surf_y(x, le - u * ch, False), le - u * ch))
                pts.append((x, surf_y(x, le - u * ch), le - u * ch))
        return pts

    def centre(x0, x1):
        le, ch, t, _ = station((x0 + x1) / 2)
        return ((x0 + x1) / 2, t * (UP - 0.5), le - ch * 0.5)

    def front(mb):
        wing_loft(mb, -2.5, 2.5, (True, True), 3)
        body_fittings(mb)

    bc = body_caps()
    add('front', (0, 0.2, 0.5), front, bc, f=0.1, skip=tuple(range(len(bc))), extra=outline(-2.5, 2.5) + [(0, surf_y(0, 0.4) + 0.12, 0.4)])
    # the wing panels each side, root to tip: they keep more of the plane's speed the lighter they are; the tips take the drag rudders
    for (pid, a, b, f, n) in (('inner', 2.5, 8.0, 0.16, 2), ('mid', 8.0, 12.5, 0.22, 2), ('tip', 12.5, HALF, 0.28, 1)):
        for sgn, side in ((-1, 'L'), (1, 'R')):
            x0, x1 = (a, b) if sgn > 0 else (-b, -a)
            rag = (True, b < HALF) if sgn > 0 else (b < HALF, True)

            def build(mb, x0=x0, x1=x1, rag=rag, sgn=sgn, tip=pid == 'tip'):
                wing_loft(mb, x0, x1, rag, int(abs(x0) * 3))
                if tip:
                    rudders(mb, sgn)
            caps = slab_caps(x0, x1, n)
            add(pid + side, centre(x0, x1), build, caps, f=f, skip=tuple(range(len(caps))), extra=outline(x0, x1))
    # the engines: each on its inner wing (parent) unless it tears off; a torn-off one may be wrecked in the landing (the husk: crushed and burnt)
    for sgn, name in ((-1, 'engineL'), (1, 'engineR')):
        ex = sgn * ENG_X
        pylon = ((ex, ENG_Y - 1.25, ENG_Z - 0.3), (0, 0, 1), 1.0, 0.2, 0.45)
        add(name, (ex, ENG_Y, ENG_Z), lambda mb, ex=ex: engine(mb, ex, ENG_Y, ENG_Z),
            [((ex, ENG_Y, ENG_Z), (0, 0, 1), 1.3, 0.95), pylon], f=0.32, parent='innerL' if sgn < 0 else 'innerR',
            husk=lambda mb, ex=ex: engine_husk(mb, ex, ENG_Y, ENG_Z))
    # skin panels and access doors that came off, top and bottom
    for i in range(8):
        sx, sy, sz = rnd.uniform(0.8, 2.6), rnd.uniform(0.1, 0.2), rnd.uniform(0.8, 2.0)
        x = rnd.uniform(-10, 10)
        le, ch, _, _ = station(x)
        z = le - ch * rnd.uniform(0.15, 0.75)
        top = i % 3 != 2
        pos = (x, surf_y(x, z, top) + (sy / 2 if top else -sy / 2), z)
        add(f'panel{i}', pos, lambda mb, p=pos, sx=sx, sy=sy, sz=sz, i=i: mb.box(p, (sx, sy, sz), ['JetHull', 'JetSand', 'JetFlap', 'JetDark'][i % 4]),
            [(pos, (1, 0, 0), max(0.05, sx / 2 - sz / 2), sz / 2, sy / 2 + 0.03)], f=rnd.uniform(0.3, 0.45), skip=(0,),
            extra=[(pos[0] + a * sx / 2, pos[1] - sy / 2, pos[2] + b * sz / 2) for a in (-1, 1) for b in (-1, 1)])
    # spars and ribs torn out of the body
    for i in range(3):
        x = rnd.uniform(-6, 6)
        le, ch, _, _ = station(x)
        z = le - ch * rnd.uniform(0.25, 0.6)
        pos = (x, (surf_y(x, z) + surf_y(x, z, False)) / 2, z)
        d = (rnd.uniform(-1, 1), rnd.uniform(-0.3, 0.3), rnd.uniform(-1, 1))
        n = math.sqrt(sum(v * v for v in d))
        d = tuple(v / n for v in d)
        add(f'beam{i}', pos, lambda mb, p=pos, d=d: mb.beam(tuple(p[k] - d[k] * 1.4 for k in range(3)), tuple(p[k] + d[k] * 1.4 for k in range(3)), 0.2, 0.2, 'JetSteel'),
            [(pos, d, 1.4, 0.25)], f=rnd.uniform(0.35, 0.5))
    return out


def pieces_ts(ps):
    """shared/jetpieces.ts: what shared/jetbreak.ts needs of each piece, and src/world/jets.ts which node it is."""
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
        caps = [{'c': r(cp['c']), 'a': r(Vector(cp['a']).normalized()), 'half': round(cp['half'], 3), 'r': round(cp['r'], 3), 'hv': round(cp['hv'], 3)} for cp in p['caps']]
        rows.append(json.dumps({'id': p['id'], 'pivot': r(p['pivot']), 'f': round(p['f'], 3), 'hit': p['hit'], **({'parent': p['parent']} if p['parent'] else {}), 'caps': caps, 'pts': pts}, separators=(',', ':')))
    body = ',\n  '.join(rows)
    return ('// Generated by tools/blender/machines/plane.py from the model: do not edit by hand.\n'
            "// The pieces a downed jet breaks into (public/models/jet.glb nodes `P_<id>`, origin at the pivot): where each was on the whole plane\n"
            '// (the plane\'s frame: x across, y up, z the nose), its simple hitboxes (capsules about the pivot: `r` the footprint radius, `hv` the half height), the points it touches the sand with, how much of\n'
            "// the plane's speed it keeps (`f`) and whether it is solid once it lies. Read by shared/jetbreak.ts.\n\n"
            'export interface JetPieceDef {\n  id: string;\n  pivot: [number, number, number];\n  f: number;\n  hit: boolean;\n  /** An engine: the wing piece it rides on if it does not tear off. */\n  parent?: string;\n'
            '  caps: { c: [number, number, number]; a: [number, number, number]; half: number; r: number; hv: number }[];\n  pts: [number, number, number][];\n}\n\n'
            f'export const JET_PIECES: JetPieceDef[] = [\n  {body},\n];\n')


def build():
    body, eng = MB(), MB()
    wing_loft(body, -HALF, HALF)
    body_fittings(body)
    for sgn in (1, -1):
        rudders(body, sgn)
    engine(body, -ENG_X, ENG_Y, ENG_Z)
    engine(eng, ENG_X, ENG_Y, ENG_Z)
    return body, eng


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
        ('side', (30, 3, 2), (0, 0.5, 0), 38),
        ('front', (5, 3, 34), (0, 0.5, 0), 38),
        ('top', (2, 46, 3), (0, 0, 0), 38),
        ('below', (12, -14, 16), (0, 0, 0), 38),
        ('belly', (0.5, -17, 0.5), (0, 0, 0), 30),
        ('rear', (-20, 9, -26), (0, 0.5, -1), 38),
        ('engine', (-11, 4, -9), (-ENG_X, ENG_Y - 0.4, ENG_Z), 40),
        ('wreck', (28, 14, 26), (0, -1, 0), 40),
    ):
        broken = name.startswith('wreck')
        for k, o in objs.items():
            o.hide_render = (not broken or k.endswith('_x')) if k.startswith('P_') else broken
        look(pos, tgt, lens)
        shoot(os.path.join(out_dir, f'plane_{name}.png'))


def main():
    a = kit.args()
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    for name, spec in MATERIALS.items():
        kit.make_material(name, *spec)
    body, eng = build()
    ps = pieces()
    objs = [make(body, 'Jet_Body'), make(eng, 'Jet_EngineR')] + [make(q['mb'], 'P_' + q['id'], q['pivot']) for q in ps]
    for q in ps:
        if q['husk']:
            hm = MB()
            hm.push(T(-q['pivot'][0], -q['pivot'][1], -q['pivot'][2]))
            q['husk'](hm)
            hm.pop()
            objs.append(make(hm, 'P_' + q['id'] + '_x', q['pivot']))
    tail = bpy.data.objects.new('Tail', None)
    tail.location = kit.C @ Vector(TAIL)
    bpy.context.scene.collection.objects.link(tail)
    os.makedirs(OUT, exist_ok=True)
    kit.export_glb(objs + [tail], os.path.join(OUT, 'jet.glb'))
    with open(os.path.join(kit.ROOT, 'shared', 'jetpieces.ts'), 'w', encoding='utf8', newline='\n') as f:
        f.write(pieces_ts(ps))
    for o in objs:
        print(f'{o.name}: tris={kit.tri_count(o)} size={o.dimensions.x:.1f} x {o.dimensions.z:.1f} x {o.dimensions.y:.1f} m')
    print(f'ENG_Y={ENG_Y:.3f} TAIL={tuple(round(v, 3) for v in TAIL)}')
    if a.preview:
        preview({o.name: o for o in objs}, os.path.abspath(a.preview))


main()
