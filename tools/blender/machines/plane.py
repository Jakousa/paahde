"""The jets (shared/jets.ts): a big twin-engined unmanned plane, 32 m span and 30 m long, flown over the desert and brought down by the
rifle. Its engines are the crashed turbofan's (tools/blender/machines/turbofan.py) as they were on the wing: the same cowls, the same
fan case, the same nozzle, with a simple mock of the fan and its spinner behind the intake lip. When one comes down the right engine
is torn off and lies beside the wreck as the real thing, to be taken apart (src/teardown).

    tools/blender/run.sh -b --python tools/blender/machines/plane.py [-- --preview dir]     # writes public/models/jet.glb

Three.js frame (Y up, +Z the nose, span along X), origin about the centre of mass, metres, turned into Blender's Z-up just before
export like the other models.

  Jet_Body     the fuselage, wings, tail and the left engine (what stays in the wreck)
  Jet_EngineR  the right engine on its pylon (not in the wreck: it lies on the ground as a machine)
  P_<id>_x     an engine wrecked in the landing (instead of P_engineL / P_engineR)
  P_<id>       the pieces it breaks into when it comes in (shared/jetpieces.ts, generated with this): nose, front, rear, tail, the wings, the right engine,
               panels and beams, each about its own pivot (the node's position) as it sat on the whole plane
  Tail         an empty at the left engine's exit, where the smoke streams from (src/world/jets.ts TAIL)
"""

import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

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

# the engine's centre line on the wing (the turbofan's frame: axis Z, fan towards +Z)
ENG_X, ENG_Y, ENG_Z = 5.6, -2.05, 1.6
TAIL = (-ENG_X, ENG_Y, ENG_Z - 1.4)


def noise(x, z):
    return 0.5 + 0.5 * math.sin(x * 0.9 + math.sin(z * 0.4) * 2.0) * math.sin(z * 0.55 + x * 0.3)


def ring(rx, ry, z, cy=0.0, n=20, p=2.4):
    """A superellipse ring of half-width rx and half-height ry at z."""
    out = []
    for k in range(n):
        a = 2 * PI * k / n
        c, s = math.cos(a), math.sin(a)
        out.append((rx * math.copysign(abs(c) ** (2 / p), c), cy + ry * math.copysign(abs(s) ** (2 / p), s), z))
    return out


def fuselage(mb):
    st = ST
    rings = [ring(rx, ry, z, cy) for z, rx, ry, cy in st]
    nk = len(rings[0])

    def mat(i, k):
        z = st[i][0]
        a = 2 * PI * k / nk
        top = math.sin(a) > 0.2
        return 'JetSand' if top and noise(math.cos(a) * 3, z) < 0.42 else 'JetHull'

    mb.loft(rings, 'JetHull', cap0=True, cap1=True, matfn=mat)
    # a sensor ball under the chin, a satcom bulge over the shoulders, a chin radome in dark glass
    mb.sphere((0, -1.6, 11.8), 0.55, 'JetGlass', u=12, v=7)
    mb.sphere((0, 1.75, 8.5), 1.0, 'JetHull', u=14, v=7, scale=(1.0, 0.55, 2.2))
    mb.sphere((0, 0.2, 14.4), 0.52, 'JetDark', u=12, v=7, scale=(1, 0.9, 1.4))
    # panel lines round the fuselage
    for z in (12.2, 6.0, 0.0, -6.0, -10.0):
        i = min(range(len(st)), key=lambda q: abs(st[q][0] - z))
        _, rx, ry, cy = st[i]
        mb.loft([ring(rx * 1.004, ry * 1.004, z - 0.04, cy, 24), ring(rx * 1.004, ry * 1.004, z + 0.04, cy, 24)], 'JetDark')
    # antennas and probes
    mb.cyl((0, 1.9, 2.0), (0, 2.9, 2.0), 0.04, 0.02, segs=5, mat='JetSteel')
    mb.cyl((0, 1.9, -3.0), (0, 2.6, -3.1), 0.04, 0.02, segs=5, mat='JetSteel')
    mb.cyl((0.4, 0.0, 14.7), (0.4, 0.0, 17.0), 0.05, 0.015, segs=5, mat='JetSteel')


def surface(mb, sections, mat='JetHull', mirror=False, camo=True):
    """A wing or fin: sections (x, y, z of the leading edge, chord, thickness) from root to tip, flat on the bottom, with a flap strip."""
    rings = []
    for (x, y, z, ch, th) in sections:
        pts = [(x, y, z), (x, y + th * 0.9, z - ch * 0.18), (x, y + th, z - ch * 0.45), (x, y + th * 0.4, z - ch), (x, y - th * 0.3, z - ch), (x, y - th * 0.45, z - ch * 0.4)]
        rings.append(pts)
    if mirror:
        rings = [[(-p[0], p[1], p[2]) for p in reversed(r)] for r in rings]

    def m(i, k):
        if camo and k in (1, 2) and noise(i * 3.1 + rings[i][1][0], rings[i][1][2]) < 0.4:
            return 'JetSand'
        return 'JetFlap' if k in (3,) else mat
    mb.loft(rings, mat, cap0=True, cap1=True, matfn=m)


def wings(mb):
    for sgn in (1, -1):
        secs = wing_secs()
        surface(mb, secs, mirror=sgn < 0)
        # winglet
        tip = secs[-1]
        surface(mb, [(tip[0], tip[1] - 0.05, tip[2] - 0.2, 1.6, 0.12), (tip[0], tip[1] + 1.7, tip[2] - 1.5, 0.9, 0.08)], mirror=sgn < 0)
        # tail plane
        surface(mb, [(1.2, 0.9, -11.2, 3.4, 0.45), (3.0, 1.15, -12.6, 2.2, 0.3), (5.6, 1.5, -14.3, 1.2, 0.18)], mirror=sgn < 0)
    # the fin and a ventral fin
    fin = [(0.0, 1.4, -8.2, 5.2, 0.4), (0.0, 4.2, -11.0, 3.4, 0.3), (0.0, 7.0, -13.2, 2.0, 0.2)]
    # a fin stands up in Y and is thin in X: its rings run along Y, so build it with the sections turned
    rings = []
    for (_, y, z, ch, th) in fin:
        rings.append([(0, y, z), (th * 0.9, y, z - ch * 0.18), (th, y, z - ch * 0.45), (th * 0.4, y, z - ch), (-th * 0.3, y, z - ch), (-th * 0.45, y, z - ch * 0.4)])
    mb.loft(rings, 'JetHull', cap0=True, cap1=True)


# (z, half width, half height, centre y): a round tube with a drooped nose and a tail cone swept up
ST = [(15.0, 0.02, 0.02, -0.25), (14.6, 0.5, 0.5, -0.25), (13.4, 1.0, 1.05, -0.2), (11.0, 1.45, 1.5, -0.1), (7.0, 1.7, 1.75, 0.0),
      (0.0, 1.8, 1.85, 0.0), (-6.0, 1.7, 1.75, 0.05), (-10.0, 1.4, 1.45, 0.3), (-13.0, 0.9, 1.0, 0.7), (-15.0, 0.4, 0.5, 1.0)]


def fus_at(z):
    """The fuselage's half width, half height and centre height at z."""
    for (za, *a), (zb, *b) in zip(ST, ST[1:]):
        if zb <= z <= za:
            t = (za - z) / (za - zb)
            return tuple(x + (y - x) * t for x, y in zip(a, b))
    return ST[0][1:] if z > 0 else ST[-1][1:]


def fus_section(mb, z0, z1, ragged=(True, True), seed=0):
    """The stretch of fuselage between z0 and z1 (broken off: its ends torn, dark inside), the same skin as the whole."""
    n = max(3, int((z1 - z0) / 1.2))
    zs = [z1 - (z1 - z0) * i / n for i in range(n + 1)]
    rings = []
    for i, z in enumerate(zs):
        rx, ry, cy = fus_at(z)
        r = ring(rx, ry, z, cy)
        if (i == 0 and ragged[1]) or (i == n and ragged[0]):
            r = [(x * (0.8 + 0.28 * noise(k * 1.7 + seed, z)), cy + (y - cy) * (0.8 + 0.28 * noise(k * 2.3 + seed, z + 1)), z + 0.5 * (noise(k + seed, 5) - 0.5))
                 for k, (x, y, _) in enumerate(r)]
        rings.append(r)
    nk = len(rings[0])

    def mat(i, k):
        a = 2 * PI * k / nk
        return 'JetSand' if math.sin(a) > 0.2 and noise(math.cos(a) * 3, zs[i]) < 0.42 else 'JetHull'

    mb.loft(rings, 'JetHull', cap0=True, cap1=True, matfn=mat, capmat='JetDark')


def wing_secs(a=0.0, b=1.0):
    """A wing's sections from the fraction a of its span to b."""
    out = []
    for s in sorted({a, b, *[t for t in (0.0, 0.18, 0.5, 0.82, 1.0) if a < t < b]}):
        out.append((1.5 + s * 14.6, -0.5 + 1.1 * s, 3.2 - 6.0 * s, 7.2 - 5.0 * s, 0.95 - 0.65 * s))
    return out


def about(pivot, M):
    """M turned about `pivot` instead of the origin."""
    return T(*pivot) @ M @ T(-pivot[0], -pivot[1], -pivot[2])


def tail_group(mb):
    """The tail section's fittings: the tail planes and the fin."""
    for sgn in (1, -1):
        surface(mb, [(1.2, 0.9, -11.2, 3.4, 0.45), (3.0, 1.15, -12.6, 2.2, 0.3), (5.6, 1.5, -14.3, 1.2, 0.18)], mirror=sgn < 0)
    fin = [(1.4, -8.2, 5.2, 0.4), (4.2, -11.0, 3.4, 0.3), (7.0, -13.2, 2.0, 0.2)]
    mb.loft([[(0, y, z), (th * 0.9, y, z - ch * 0.18), (th, y, z - ch * 0.45), (th * 0.4, y, z - ch), (-th * 0.3, y, z - ch), (-th * 0.45, y, z - ch * 0.4)]
             for (y, z, ch, th) in fin], 'JetHull', cap0=True, cap1=True)


def pieces():
    """What the plane breaks into when it comes in (src/world/jets.ts flies them apart with shared/jetbreak.ts): each piece is cut from the whole
    plane (ragged where it tore), built about its own pivot, and has its own simple hitboxes (capsules, centre and axis about the pivot).
    Returns [{id, pivot, mb, caps, hit, f}]: `f` is how much of the plane's speed it keeps (heavy things less), `hit` whether it is solid for
    the players once it lies (the right engine is not: it lies on as a machine)."""
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

    def fus_caps(z0, z1, n):
        """The fuselage between z0 and z1 as n capsules along it, each as fat as the skin there."""
        out_ = []
        for i in range(n):
            za, zb = z1 - (z1 - z0) * i / n, z1 - (z1 - z0) * (i + 1) / n
            zm = (za + zb) / 2
            rx, ry, cy = fus_at(zm)
            out_.append(((0, cy, zm), (0, 0, 1), (za - zb) / 2, rx * 0.97, ry * 0.97))
        return out_

    def wing_caps(sgn, a, b):
        """A wing between the fractions a and b of its span, a slab capsule a section long: as wide as the chord there, as thick as the wing."""
        secs = wing_secs(a, b)
        out_ = []
        for (x0, y0, z0, c0, t0), (x1, y1, z1, c1, t1) in zip(secs, secs[1:]):
            ch, th = (c0 + c1) / 2, (t0 + t1) / 2
            out_.append((((x0 + x1) / 2 * sgn, (y0 + y1) / 2 + th * 0.2, (z0 + z1) / 2 - ch / 2), (1, 0, 0), abs(x1 - x0) / 2, ch / 2, th / 2 + 0.06))
        return out_

    def nose(mb):
        fus_section(mb, 7.0, 15.0, (True, False), 11)
        mb.sphere((0, -1.6, 11.8), 0.55, 'JetGlass', u=12, v=7)
        mb.sphere((0, 0.2, 14.4), 0.52, 'JetDark', u=12, v=7, scale=(1, 0.9, 1.4))
        mb.cyl((0.4, 0.0, 14.7), (0.4, 0.0, 17.0), 0.05, 0.015, segs=5, mat='JetSteel')

    def front(mb):
        fus_section(mb, -2.0, 7.0, (True, True), 3)
        mb.sphere((0, 1.75, 2.5), 1.0, 'JetHull', u=14, v=7, scale=(1.0, 0.55, 2.2))
        mb.cyl((0, 1.9, 2.0), (0, 2.9, 2.0), 0.04, 0.02, segs=5, mat='JetSteel')
        surface(mb, wing_secs(0.0, 0.2))
        surface(mb, wing_secs(0.0, 0.2), mirror=True)

    def rear(mb):
        fus_section(mb, -9.0, -2.0, (True, True), 8)
        mb.cyl((0, 1.9, -3.0), (0, 2.6, -3.1), 0.04, 0.02, segs=5, mat='JetSteel')

    def tail(mb):
        fus_section(mb, -15.0, -9.0, (False, True), 5)
        tail_group(mb)

    def wing_l(mb):
        surface(mb, wing_secs(0.2, 1.0), mirror=True)

    def wing_r(mb):
        surface(mb, wing_secs(0.2, 1.0))

    add('nose', (0, -0.2, 11), nose, fus_caps(7.0, 14.9, 4) + [((0, 0.2, 14.4), (0, 0, 1), 0.3, 0.45, 0.4)], f=0.2)
    add('front', (0, 0, 2.5), front, fus_caps(-2.0, 7.0, 3) + [((0, 1.9, 2.5), (0, 0, 1), 1.4, 0.8, 0.45)] + wing_caps(1, 0.0, 0.2) + wing_caps(-1, 0.0, 0.2), f=0.1)
    add('rear', (0, 0.1, -5.5), rear, fus_caps(-9.0, -2.0, 3), f=0.14)
    # the fin: slabs thin across and as long as the chord there, as tall as its stretch; the tail planes: thin slabs out each side
    fin_caps = [((0, 2.8, -10.8), (0, 0, 1), 1.9, 0.36, 1.4), ((0, 5.6, -12.1), (0, 0, 1), 1.0, 0.3, 1.4)]
    plane_caps = [((sgn * 2.1, 1.05, -12.4), (1, 0, 0), 0.95, 1.1, 0.3) for sgn in (1, -1)] + [((sgn * 4.3, 1.4, -13.4), (1, 0, 0), 1.3, 0.75, 0.22) for sgn in (1, -1)]
    add('tail', (0, 1.5, -12), tail, fus_caps(-15.0, -9.0, 3) + fin_caps + plane_caps, f=0.2)
    def engine_pts(sgn):
        # the nacelle's underside and sides (and the pylon's foot)
        return [(sgn * ENG_X + dx, ENG_Y + dy, ENG_Z + dz) for dz in (-1.2, 0, 1.1) for (dx, dy) in ((0, -0.95), (0.9, 0), (-0.9, 0))]

    def wing_pts(sgn):
        # the wing really is thin: it touches the sand with its own corners (not the fat capsule it is hit with)
        pts = []
        for (x, y, z, ch, th) in wing_secs(0.2, 1.0):
            pts += [(sgn * x, y - th * 0.45, z - ch * 0.4), (sgn * x, y - th * 0.3, z - ch), (sgn * x, y, z)]
        return pts

    wl, wr = wing_caps(-1, 0.2, 1.0), wing_caps(1, 0.2, 1.0)
    pylon = lambda sgn: ((sgn * ENG_X, ENG_Y + 1.0, ENG_Z - 0.4), (0, 0, 1), 1.2, 0.2, 0.7)
    add('wingL', (-9.5, -0.8, 1.0), wing_l, wl, f=0.22, skip=tuple(range(len(wl))), extra=wing_pts(-1))
    add('wingR', (10.2, 0.3, -0.3), wing_r, wr, f=0.22, skip=tuple(range(len(wr))), extra=wing_pts(1))
    # the engines: each on its wing (parent) unless it tears off; a torn-off one may be wrecked in the landing (the husk: crushed and burnt)
    for sgn, name in ((-1, 'engineL'), (1, 'engineR')):
        ex = sgn * ENG_X
        add(name, (ex, ENG_Y, ENG_Z), lambda mb, ex=ex, sgn=sgn: engine(mb, ex, ENG_Y, ENG_Z, sgn),
            [((ex, ENG_Y, ENG_Z), (0, 0, 1), 1.3, 0.95), pylon(sgn)], f=0.32, parent='wingL' if sgn < 0 else 'wingR',
            husk=lambda mb, ex=ex: engine_husk(mb, ex, ENG_Y, ENG_Z))
    # skin panels, doors and ribs that came off the body
    for i in range(8):
        sx, sy, sz = rnd.uniform(0.8, 2.6), rnd.uniform(0.1, 0.24), rnd.uniform(0.8, 2.0)
        ang, z = rnd.uniform(0.3, PI - 0.3) * (1 if i % 2 else -1), rnd.uniform(-10, 10)
        rx, ry, cy = fus_at(z)
        pos = (rx * 1.05 * math.sin(ang), cy + ry * 1.05 * math.cos(ang), z)
        add(f'panel{i}', pos, lambda mb, p=pos, sx=sx, sy=sy, sz=sz, i=i: mb.box(p, (sx, sy, sz), ['JetHull', 'JetSand', 'JetFlap', 'JetDark'][i % 4]),
            [(pos, (1, 0, 0), max(0.05, sx / 2 - sz / 2), sz / 2, sy / 2 + 0.03)], f=rnd.uniform(0.3, 0.45), skip=(0,),
            extra=[(pos[0] + a * sx / 2, pos[1] - sy / 2, pos[2] + b * sz / 2) for a in (-1, 1) for b in (-1, 1)])
    for i in range(3):
        z = rnd.uniform(-8, 8)
        rx, ry, cy = fus_at(z)
        pos = (rnd.choice([-1, 1]) * rx, cy + 0.3, z)
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
    mb.box((cx, cy + 1.2, cz - 0.4), (0.38, 0.5, 1.6), 'JetHull')
    crush(mb, (cx + 0.9, cy + 0.3, cz + 0.6), 0.9, 0.5, toward=(cx, cy, cz))
    crush(mb, (cx - 0.5, cy - 0.7, cz - 0.4), 0.8, 0.45, toward=(cx, cy, cz))
    ripple(mb, 5, 0.04, 5.0)


def engine(mb, cx, cy, cz, side):
    """The turbofan as it hung on the wing: the turbofan.py cowls and nozzle in one skin, a fan and its spinner in the intake, the pylon to the wing."""
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
    # the pylon up into the wing, a fairing along it
    top = 0.92
    mb.box((cx, cy + top + 0.55, cz - 0.4), (0.38, 1.35, 3.2), 'JetHull', taper=(1.0, 0.7))
    # the nacelle's own mounting ring where it meets the pylon
    mb.lathe([(0.915, 0.18), (0.94, 0.18), (0.94, 0.05), (0.915, 0.05)], 36, 'Dark', M=M)


def build():
    body, eng = MB(), MB()
    fuselage(body)
    wings(body)
    engine(body, -ENG_X, ENG_Y, ENG_Z, -1)
    engine(eng, ENG_X, ENG_Y, ENG_Z, 1)
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
        ('side', (40, 4, 6), (0, 0, 0), 38),
        ('front', (6, 3, 42), (0, -1, 0), 38),
        ('top', (3, 52, 6), (0, 0, 0), 38),
        ('engine', (-12, -2, 12), (-5.6, -2, 1.6), 40),
        ('wreck', (34, 12, 30), (3, -2, 0), 42),
    ):
        broken = name.startswith('wreck')
        for k, o in objs.items():
            o.hide_render = (k.startswith('P_') != broken) if k.startswith('P_') else broken
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
    if a.preview:
        preview({o.name: o for o in objs}, os.path.abspath(a.preview))


main()
