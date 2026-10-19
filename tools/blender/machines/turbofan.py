"""The crashed turbofan (docs/machines/turbofan.md): a CFM56-sized engine (fan 1.74 m, 2.43 m long) lying torn off its pylon,
nose in the sand, one fan cowl half hanging open, the core casings split open on the side that faces up so the rotors show.

Model frame: engine axis = Z, fan at +Z, gearbox on top (+Y, local angle 0), angles run from +Y toward +X. The finished engine
is posed (rolled, nose down, sunk) and everything is written in world axes with the model origin on the ground.

    tools/blender/run.sh -b --python tools/blender/machines/turbofan.py [-- --preview dir]
"""

import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kit  # noqa: E402
from kit import (MB, Machine, Matrix, Vector, PI, T, Rx, Rz, S, around, crush, ripple)  # noqa: E402

OUT = os.path.join(kit.ROOT, 'public', 'models', 'machines')
TS = os.path.join(kit.ROOT, 'shared', 'machines')

MATERIALS = {
    'Steel': (0x8d8f91, 0.85, 0.42),
    'Dark': (0x3d3f43, 0.8, 0.5),
    'Paint': (0xbdb8a8, 0.15, 0.7),
    'Rust': (0x84492a, 0.5, 0.9),
    'Scorch': (0x1c1917, 0.4, 0.8),
    'Blade': (0xa3a4a6, 0.9, 0.35),
    'Burnt': (0x5b4a3e, 0.7, 0.55),
    'Brass': (0xa98443, 0.9, 0.4),
    'Copper': (0xb4693b, 0.9, 0.35),
    'Rubber': (0x16171a, 0.1, 0.7),
    'Oil': (0x241709, 0.2, 0.6),
    'Sand': (0xc46a24, 0.0, 1.0),
    'Orange': (0xc8661e, 0.2, 0.6),
}


def polar(phi, r, z):
    """Point at angle phi (from +Y toward +X), radius r, along-axis z."""
    return Vector((r * math.sin(phi), r * math.cos(phi), z))


def radial(phi):
    return Vector((math.sin(phi), math.cos(phi), 0))


def arc(p0, p1):
    """lathe a0/a1 for an arc from angle p0 to p1 (our angles)."""
    return PI / 2 - p1, PI / 2 - p0


def noise(i, k, seed=0):
    return (math.sin(i * 12.9898 + k * 78.233 + seed) * 43758.5453) % 1.0


def blob(i, k, seed):
    """Smooth 0..1 noise over (ring i, segment k): patches several faces across."""
    a = math.sin(i * 0.9 + seed * 1.7) * math.sin(k * 0.55 + seed * 2.3)
    b = math.sin(i * 0.35 + k * 0.4 + seed * 0.9)
    return 0.5 + 0.35 * a + 0.3 * b


def weathered(seed, scorch=0.25, rust=0.3, base='Paint'):
    def f(i, k):
        n = blob(i, k, seed)
        if n < scorch:
            return 'Scorch'
        if n < scorch + rust:
            return 'Rust'
        return base
    return f


def blade(mb, r0, r1, z, chord0, chord1, tw0, tw1, thick, mat, bend=0.0, stations=4):
    """One blade along local +X (root at r0, tip at r1), centred at axial z, twisting from tw0 to tw1; `bend` pushes the tip sideways."""
    rings = []
    for i in range(stations):
        s = i / (stations - 1)
        c = chord0 + (chord1 - chord0) * s
        tw = tw0 + (tw1 - tw0) * s
        x = r0 + (r1 - r0) * s
        off = bend * s * s
        ring = []
        for (u, v) in ((-0.5, 0.0), (-0.1, thick), (0.5, 0.0), (-0.1, -thick)):
            cz, cy = u * c, v
            ring.append((x, cy * math.cos(tw) - cz * math.sin(tw) + off, z + cy * math.sin(tw) + cz * math.cos(tw)))
        rings.append(ring)
    mb.loft(rings, mat, True, True)


def blade_row(mb, n, r0, r1, z, chord, tw, thick, mat, rnd=None, broken=0, bent=0, phase=0.0):
    """n blades round the axis. `broken` of them snapped off short, `bent` of them bent over."""
    idx = list(range(n))
    if rnd:
        rnd.shuffle(idx)
    snapped = set(idx[:broken])
    folded = set(idx[broken:broken + bent])
    for i in range(n):
        a = phase + 2 * PI * i / n
        mb.push(Rz(a))
        if i in snapped:
            blade(mb, r0, r0 + (r1 - r0) * (0.15 + 0.35 * (rnd.random() if rnd else 0.3)), z, chord, chord * 0.9, tw, tw, thick, mat)
        elif i in folded:
            blade(mb, r0, r1, z, chord, chord * 0.8, tw, tw, thick, mat, bend=(0.12 + 0.2 * (rnd.random() if rnd else 0.5)))
        else:
            blade(mb, r0, r1, z, chord, chord * 0.8, tw, tw * 0.5, thick, mat)
        mb.pop()


def pad(mb, centre, nrm, w, h, mat='Dark'):
    """A mounting pad: a flat plate with a ring of stud heads, facing nrm."""
    n = Vector(nrm).normalized()
    mb.push(kit.aim(centre, n))
    mb.cyl((0, 0, 0), (0, 0, 0.018), w / 2, w / 2, segs=14, mat=mat)
    mb.pop()


def build(pose, rnd_seed=11):
    rnd = random.Random(rnd_seed)
    m = Machine('jet_engine', 'turbofan', pose)
    sh = m.shell

    # ======================================================================= shell: what never comes off
    # fan case (inlet lip crumpled, one dent)
    fan_case = [(0.80, 0.50), (0.80, 1.10), (0.835, 1.20), (0.885, 1.14), (0.875, 0.90), (0.857, 0.50), (0.80, 0.50)]
    sh.lathe(fan_case, 48, 'Paint', matfn=weathered(2, 0.3, 0.35))
    crush(sh, polar(math.radians(110), 0.88, 1.12), 0.55, 0.16)
    crush(sh, polar(math.radians(-40), 0.88, 1.15), 0.4, 0.09)
    ripple(sh, 4, 0.012, 7.0)
    # fan frame: hub ring, outlet guide vanes and struts
    sh.lathe([(0.26, 0.40), (0.28, 0.40), (0.28, 0.54), (0.26, 0.54), (0.26, 0.40)], 32, 'Dark')
    for i in range(30):
        a = 2 * PI * i / 30
        sh.push(Rz(a))
        blade(sh, 0.28, 0.80, 0.50, 0.11, 0.1, 0.35, 0.35, 0.008, 'Dark', stations=2)
        sh.pop()
    for i in range(8):
        a = 2 * PI * i / 8 + 0.2
        sh.push(Rz(a))
        sh.box((0.54, 0, 0.47), (0.5, 0.03, 0.09), 'Steel')
        sh.pop()
    # bleed / bypass splitter ring and core cowl remains (torn arcs hanging off the core)
    sh.lathe([(0.52, 0.34), (0.56, 0.34), (0.56, 0.52), (0.52, 0.52), (0.52, 0.34)], 40, 'Steel')
    for (p0, p1, z0, z1, sd) in ((-150, -30, -0.05, -0.85, 5), (35, 105, 0.0, -0.62, 8), (190, 235, -0.1, -0.55, 3)):
        a0, a1 = arc(math.radians(p0), math.radians(p1))
        sh.lathe([(0.575, z0), (0.60, (z0 + z1) / 2), (0.57, z1)], 18, 'Paint', matfn=weathered(sd, 0.35, 0.3), a0=a0, a1=a1)
    # core casings: split open on the side that faces up (local 25..150 deg), rotors show through; flanges at the joints
    open0, open1 = math.radians(150), math.radians(385)
    a0, a1 = arc(open0, open1)
    casing = [  # (radius, z)
        (0.345, 0.46), (0.33, 0.20), (0.30, -0.08),   # booster + compressor
        (0.37, -0.10), (0.37, -0.40),                  # combustor
        (0.33, -0.42), (0.33, -0.60),                  # HP turbine
        (0.43, -0.62), (0.40, -1.00),                  # LP turbine
        (0.36, -1.02), (0.36, -1.12),                  # rear frame
    ]
    sh.lathe(casing, 40, 'Steel', matfn=weathered(6, 0.3, 0.3, 'Steel'), a0=a0, a1=a1)
    sh.lathe([(r - 0.012, z) for r, z in casing], 40, 'Dark', a0=a0, a1=a1)
    for (r, z) in ((0.345, 0.46), (0.30, -0.09), (0.37, -0.41), (0.33, -0.61), (0.40, -1.01)):
        sh.lathe([(r - 0.03, z + 0.012), (r + 0.045, z + 0.012), (r + 0.045, z - 0.012), (r - 0.03, z - 0.012), (r - 0.03, z + 0.012)],
                 40, 'Dark', a0=a0, a1=a1)
    # main shaft
    sh.cyl((0, 0, 1.0), (0, 0, -1.12), 0.055, 0.055, segs=14, mat='Dark')
    sh.cyl((0, 0, 0.95), (0, 0, 0.45), 0.095, 0.095, segs=14, mat='Steel')
    # rear nozzle bare mount ring and plug cone stub
    sh.lathe([(0.36, -1.12), (0.37, -1.12), (0.37, -1.14), (0.36, -1.14), (0.36, -1.12)], 32, 'Dark', a0=a0, a1=a1)
    # gearbox housing on top of the core, between the fan frame and the compressor
    sh.box((0, 0.435, 0.22), (0.36, 0.12, 0.54), 'Steel')
    sh.box((0, 0.345, 0.22), (0.46, 0.04, 0.52), 'Dark')
    for z in (0.40, 0.20, 0.00):
        for sx in (-1, 1):
            sh.box((sx * 0.19, 0.435, z), (0.03, 0.115, 0.15), 'Dark')
    # gearbox drive shaft up the radial strut from the core
    sh.cyl((0, 0.30, 0.40), (0, 0.50, 0.40), 0.03, 0.03, segs=8, mat='Dark')
    # pylon mount lugs and links on top, torn
    for dz, tilt in ((0.28, 0.1), (-0.58, -0.22)):
        sh.box((0, 0.88, dz), (0.1, 0.05, 0.16), 'Dark', rot=(0, 0, tilt))
        sh.box((0.09, 0.78, dz), (0.03, 0.14, 0.12), 'Steel')
        sh.box((-0.09, 0.78, dz), (0.03, 0.14, 0.12), 'Steel')
    # harness trunks along the fan case and core (the ones you can pull are wires)
    sh.sweep([polar(math.radians(20), 0.87, 0.70), polar(math.radians(20), 0.75, 0.52), polar(math.radians(10), 0.52, 0.45), polar(0, 0.46, 0.38)],
             0.02, 'Rubber')
    sh.sweep([polar(math.radians(-25), 0.45, 0.30), polar(math.radians(-35), 0.52, 0.12), polar(math.radians(-70), 0.60, -0.15), polar(math.radians(-110), 0.55, -0.4)],
             0.018, 'Rubber')
    # oil and burn on the casing
    sh.sphere(polar(math.radians(200), 0.82, 0.62), 0.12, 'Oil', scale=(1, 1, 0.35))

    # ======================================================================= modules
    # --- fan cowl half: swung open about its hinge line (local 340 deg)
    hinge = polar(math.radians(340), 0.93, 0)
    cowl = m.module('cowl', 0.75, pop=(-0.6, 0.8, 0.2))
    cowl.place(around(hinge, (0, 0, 1), -1.15))
    ca0, ca1 = arc(math.radians(180), math.radians(340))
    cowl.mb.lathe([(0.915, 0.56), (0.93, 0.8), (0.915, 1.08), (0.88, 1.14)], 16, 'Paint', matfn=weathered(9, 0.3, 0.3), a0=ca0, a1=ca1)
    cowl.mb.lathe([(0.89, 0.56), (0.905, 0.8), (0.89, 1.08), (0.86, 1.14)], 16, 'Dark', a0=ca0, a1=ca1)
    crush(cowl.mb, polar(math.radians(235), 0.93, 1.1), 0.4, 0.1)
    for z in (0.62, 0.84, 1.04):
        cowl.mb.box(polar(math.radians(180), 0.925, z), (0.04, 0.05, 0.09), 'Steel', rot=(0, 0, -math.radians(180)))
    for z in (0.62, 0.85, 1.05):
        cowl.mb.box(polar(math.radians(340), 0.92, z), (0.05, 0.05, 0.1), 'Dark')
    latches = [cowl.step('clip', 'cowlLatch', polar(math.radians(180), 0.945, z), polar(math.radians(180), 1, 0).normalized()) for z in (0.62, 0.84, 1.04)]
    cowl.step('bolt', 'hingePin', polar(math.radians(340), 0.95, 0.62), radial(math.radians(340)), after=latches)
    cowl.step('bolt', 'hingePin', polar(math.radians(340), 0.95, 1.05), radial(math.radians(340)), after=latches)

    # --- fan: disc, blades (some snapped, some folded), retaining ring
    spinner = m.module('spinner', 0.6, pop=(0, 0.3, 1))
    spinner.mb.lathe([(0.0, 1.22), (0.06, 1.215), (0.15, 1.19), (0.205, 1.12), (0.23, 1.0)], 24, 'Paint', matfn=weathered(13, 0.35, 0.2))
    crush(spinner.mb, Vector((0.05, 0.1, 1.22)), 0.2, 0.05)
    spinner.ring('bolt', 'spinnerBolt', (0, 0, 1.19), (0, 0, 1), 0.12, 3, phase=0.4)

    fan = m.module('fan', 0.8, pop=(0, 0.4, 1))
    fan.mb.lathe([(0.0, 1.0), (0.205, 1.0), (0.23, 0.97), (0.23, 0.85), (0.0, 0.85)], 24, 'Dark', cap=True)
    fan.mb.lathe([(0.09, 1.005), (0.15, 1.005), (0.15, 1.02), (0.09, 1.02)], 18, 'Steel')
    blade_row(fan.mb, 28, 0.20, 0.785, 0.93, 0.19, 0.55, 0.014, 'Blade', rnd, broken=5, bent=4)
    fan.ring('bolt', 'fanBolt', (0, 0, 1.02), (0, 0, 1), 0.13, 6, after=['spinner'])
    fan.step('lift', 'fanLift', (0, 0, 1.0), (0, 0, 1), after=['fanBolt'], need=3.5)
    fan.part('bearing', (0.0, 0.0, 0.9), (PI / 2, 0, 0), chance=0.85)

    # --- compressor: rotor drum with its blade rows, bleed valve and variable-vane linkage on the (open) casing
    comp = m.module('compressor', 0.75, pop=(0.4, 1, 0.3))
    comp.mb.lathe([(0.10, 0.44), (0.19, 0.44), (0.24, 0.20), (0.255, -0.08), (0.10, -0.08)], 24, 'Dark')
    for j in range(7):
        z = 0.40 - j * 0.07
        rr = 0.19 + 0.045 * j
        blade_row(comp.mb, 34, rr, 0.30 + 0.0 * j, z, 0.045, 0.5, 0.006, 'Blade', rnd, broken=1 if j in (2, 5) else 0, bent=1 if j == 3 else 0, phase=j * 0.07)
    comp.mb.sweep([polar(math.radians(120), 0.36, 0.30), polar(math.radians(130), 0.42, 0.3), polar(math.radians(150), 0.47, 0.26)], 0.012, 'Copper')
    comp.mb.cyl(polar(math.radians(95), 0.36, 0.05), polar(math.radians(95), 0.47, 0.05), 0.05, 0.05, segs=10, mat='Brass')
    comp.ring('bolt', 'flangeBolt', (0, 0, 0.46), (0, 0, 1), 0.22, 8, after=['fan'])
    comp.step('clip', 'linkagePin', polar(math.radians(130), 0.42, 0.3), radial(math.radians(130)), after=['flangeBolt'])
    comp.step('clip', 'linkagePin', polar(math.radians(105), 0.40, 0.18), radial(math.radians(105)), after=['flangeBolt'])
    comp.step('lift', 'coreLift', (0, 0.25, 0.46), (0, 1, 0), after=['flangeBolt'], need=3.5)
    comp.part('relay', polar(math.radians(120), 0.38, 0.3), (0, 0, 0), chance=0.8)
    comp.part('valve', polar(math.radians(95), 0.5, 0.05), (0, 0, 0), chance=0.7)

    # --- combustor: annular liner with fuel nozzles, igniters in the casing
    comb = m.module('combustor', 0.7, pop=(0.3, 1, 0))
    comb.mb.lathe([(0.26, -0.10), (0.30, -0.14), (0.31, -0.35), (0.26, -0.40), (0.20, -0.40), (0.20, -0.12), (0.26, -0.10)], 30, 'Burnt',
                  matfn=lambda i, k: 'Scorch' if blob(i, k, 3) < 0.45 else 'Burnt')
    for j in range(16):
        a = 2 * PI * j / 16
        comb.mb.cyl(polar(a, 0.2, -0.09), polar(a, 0.31, -0.09), 0.012, 0.012, segs=6, mat='Brass')
    comb.mb.cyl(polar(math.radians(70), 0.31, -0.25), polar(math.radians(70), 0.45, -0.25), 0.028, 0.028, segs=8, mat='Dark')
    comb.mb.cyl(polar(math.radians(105), 0.31, -0.25), polar(math.radians(105), 0.45, -0.25), 0.028, 0.028, segs=8, mat='Dark')
    comb.ring('bolt', 'flangeBolt', (0, 0, -0.09), (0, 0, 1), 0.30, 8, after=['compressor'])
    comb.wire('igniterLead', [polar(math.radians(70), 0.45, -0.25), polar(math.radians(60), 0.6, -0.18), polar(math.radians(30), 0.52, 0.02), polar(math.radians(15), 0.47, 0.1)],
              key='black', after=['flangeBolt'], r=0.01)
    comb.wire('igniterLead', [polar(math.radians(105), 0.45, -0.25), polar(math.radians(90), 0.6, -0.2), polar(math.radians(50), 0.55, 0.0), polar(math.radians(20), 0.47, 0.1)],
              key='black', after=['flangeBolt'], r=0.01)
    comb.step('lift', 'coreLift', (0, 0.28, -0.10), (0, 1, 0), after=['igniterLead', 'flangeBolt'], need=3.5)
    comb.part('coil', polar(math.radians(70), 0.4, -0.25), (0, 0, 0), chance=0.8)
    comb.part('coil', polar(math.radians(105), 0.4, -0.25), (0, 0, 0), chance=0.6)
    comb.part('valve', polar(math.radians(88), 0.33, -0.12), (0, 0, 0), chance=0.7)

    # --- turbine: HP and LP discs with burnt blades
    turb = m.module('turbine', 0.7, pop=(0.4, 1, -0.3))
    turb.mb.lathe([(0.06, -0.42), (0.20, -0.42), (0.22, -0.60), (0.06, -0.60)], 20, 'Dark')
    blade_row(turb.mb, 40, 0.20, 0.31, -0.50, 0.07, 0.6, 0.008, 'Burnt', rnd, broken=3, bent=2)
    for j in range(4):
        z = -0.70 - j * 0.07
        blade_row(turb.mb, 54, 0.12, 0.30 + 0.025 * j, z, 0.05, 0.4, 0.006, 'Burnt', rnd, broken=2 if j in (1, 3) else 0, bent=2 if j == 2 else 0, phase=j * 0.05)
        turb.mb.cyl((0, 0, z + 0.015), (0, 0, z - 0.015), 0.16 + 0.015 * j, 0.16 + 0.015 * j, segs=24, mat='Dark')
    turb.ring('bolt', 'flangeBolt', (0, 0, -0.62), (0, 0, 1), 0.33, 8, after=['combustor'])
    turb.step('lift', 'coreLift', (0, 0.3, -0.62), (0, 1, 0), after=['flangeBolt'], need=3.5)
    turb.part('bearing', (0, 0.0, -0.9), (PI / 2, 0, 0), chance=0.8)

    # --- rear nozzle and plug
    noz = m.module('nozzle', 0.8, pop=(0, 0.3, -1))
    noz.mb.lathe([(0.37, -1.12), (0.35, -1.20), (0.27, -1.34), (0.255, -1.40)], 28, 'Steel', matfn=weathered(21, 0.3, 0.3, 'Steel'))
    noz.mb.lathe([(0.12, -1.12), (0.13, -1.25), (0.0, -1.42)], 20, 'Burnt')
    ripple(noz.mb, 8, 0.01, 8.0)
    noz.ring('bolt', 'nozzleBolt', (0, 0, -1.14), (0, 0, -1), 0.345, 8)
    noz.step('lift', 'nozzleLift', (0, 0.3, -1.2), (0, 1, 0), after=['nozzleBolt'], need=3.5)

    # --- accessories on the gearbox: starter, generator, PMA (+x side); hydraulic, fuel, oil pump (-x side)
    def accessory(mid, chance, sx, z, r, ln, tilt, body, parts_at):
        a = m.module(mid, chance, pop=(sx, 0.5, 0))
        L = around((sx * 0.2, 0.435, z), (0, 0, 1), -sx * tilt)
        a.place(L)
        a.mb.cyl((sx * 0.2, 0.435, z), (sx * (0.2 + ln), 0.435, z), r, r, segs=14, mat=body)
        a.mb.cyl((sx * 0.2, 0.435, z), (sx * 0.23, 0.435, z), r * 1.15, r * 1.15, segs=14, mat='Dark')
        a.mb.cyl((sx * (0.2 + ln), 0.435, z), (sx * (0.2 + ln + 0.03), 0.435, z), r * 0.6, r * 0.6, segs=10, mat='Dark')
        return a

    st = accessory('starter', 0.85, +1, 0.40, 0.07, 0.30, 0.25, 'Orange', None)
    cl = st.step('clip', 'vClamp', (0.215, 0.435 + 0.075, 0.40), (0, 1, 0))
    st.wire('harness', [(0.46, 0.50, 0.40), (0.42, 0.62, 0.44), (0.30, 0.66, 0.50), (0.12, 0.60, 0.55)], key='black', after=[cl], r=0.014)
    st.part('motor', (0.38, 0.435, 0.40), (0, 0, -PI / 2), chance=0.9)

    ge = accessory('generator', 0.85, +1, 0.20, 0.105, 0.30, 0.15, 'Steel', None)
    gb = ge.ring('bolt', 'padBolt', (0.22, 0.435, 0.20), (1, 0, 0), 0.115, 4, phase=0.78)
    ge.wire('harness', [(0.48, 0.50, 0.20), (0.40, 0.66, 0.16), (0.24, 0.70, 0.12), (0.10, 0.62, 0.10)], key='red', after=gb, r=0.016)
    ge.wire('harness', [(0.48, 0.43, 0.14), (0.38, 0.60, 0.08), (0.22, 0.66, 0.02), (0.08, 0.60, 0.0)], key='black', after=gb, r=0.012)
    ge.part('motor', (0.40, 0.435, 0.20), (0, 0, -PI / 2), chance=0.8)
    ge.part('coil', (0.36, 0.52, 0.20), (0, 0, 0), chance=0.7)

    pm = accessory('pma', 0.7, +1, 0.00, 0.05, 0.20, 0.0, 'Brass', None)
    pm.ring('screw', 'padScrew', (0.215, 0.435, 0.0), (1, 0, 0), 0.065, 3, phase=0.4)
    pm.part('coil', (0.32, 0.435, 0.0), (0, 0, -PI / 2), chance=0.8)

    hy = accessory('hydpump', 0.7, -1, 0.40, 0.075, 0.28, 0.2, 'Steel', None)
    hb = hy.ring('bolt', 'padBolt', (-0.215, 0.435, 0.40), (-1, 0, 0), 0.085, 4, phase=0.78)
    hy.wire('hoseFitting', [(-0.46, 0.45, 0.40), (-0.55, 0.30, 0.42), (-0.60, 0.1, 0.46), (-0.58, -0.1, 0.5)], key='black', after=hb, r=0.022)
    hy.part('valve', (-0.36, 0.435, 0.40), (0, 0, PI / 2), chance=0.8)

    fp = m.module('fuelpump', 0.75, pop=(-1, 0.5, 0))
    fp.place(around((-0.2, 0.435, 0.20), (0, 0, 1), 0.18))
    fp.mb.box((-0.34, 0.435, 0.20), (0.26, 0.15, 0.15), 'Steel')
    fp.mb.cyl((-0.34, 0.435, 0.20), (-0.34, 0.55, 0.20), 0.05, 0.05, segs=10, mat='Brass')
    fb = fp.ring('bolt', 'padBolt', (-0.215, 0.435, 0.20), (-1, 0, 0), 0.075, 4, phase=0.78)
    fp.wire('harness', [(-0.4, 0.55, 0.20), (-0.36, 0.68, 0.14), (-0.2, 0.72, 0.1), (-0.1, 0.62, 0.08)], key='black', after=fb, r=0.014)
    fp.part('valve', (-0.34, 0.435, 0.20), (0, 0, PI / 2), chance=0.85)

    op = accessory('oilpump', 0.6, -1, 0.00, 0.06, 0.20, 0.1, 'Dark', None)
    op.ring('bolt', 'padBolt', (-0.215, 0.435, 0.0), (-1, 0, 0), 0.07, 3, phase=0.4)
    op.part('bearing', (-0.32, 0.435, 0.0), (0, 0, PI / 2), chance=0.8)

    # --- gearbox train: cover, gears and bearings (always there)
    gt = m.module('gearbox', 1.0, pop=(0, 1, 0))
    gt.mb.box((0, 0.51, 0.22), (0.37, 0.02, 0.55), 'Steel')
    gt.row('bolt', 'coverBolt', (-0.16, 0.525, 0.0), (-0.16, 0.525, 0.44), 4, (0, 1, 0), after=['starter', 'generator', 'pma', 'hydpump', 'fuelpump', 'oilpump'])
    gt.row('bolt', 'coverBolt', (0.16, 0.525, 0.0), (0.16, 0.525, 0.44), 4, (0, 1, 0), after=['starter', 'generator', 'pma', 'hydpump', 'fuelpump', 'oilpump'])
    gt.part('gear', (0.0, 0.40, 0.30), (0, 0, 0), chance=1.0)
    gt.part('gear', (0.0, 0.40, 0.08), (0, 0, 0), chance=0.7)

    # --- FADEC (on the fan case, left), oil cooler (right), oil tank
    fd = m.module('fadec', 0.85, pop=(-1, 0.3, 0))
    pos = polar(math.radians(262), 0.90, 0.82)
    fd.mb.push(kit.aim(pos, radial(math.radians(262))))
    fd.mb.box((0, 0, 0.04), (0.42, 0.28, 0.08), 'Steel')
    fd.mb.box((0.13, 0.0, 0.1), (0.1, 0.16, 0.05), 'Dark')
    fd.mb.pop()
    fd.ring('screw', 'mountScrew', pos + radial(math.radians(262)) * 0.085, radial(math.radians(262)), 0.17, 4, phase=0.78)
    fd.step('clip', 'connectorLatch', pos + radial(math.radians(262)) * 0.16, radial(math.radians(262)))
    fd.wire('harness', [pos + radial(math.radians(262)) * 0.12, polar(math.radians(250), 0.96, 0.95), polar(math.radians(220), 0.9, 1.0), polar(math.radians(190), 0.88, 0.8)],
            key='black', after=['connectorLatch'], r=0.016)
    fd.part('compute', pos + radial(math.radians(262)) * 0.06, (0, 0, 0), chance=0.9)

    oc = m.module('oilcooler', 0.6, pop=(1, 0.5, 0.2))
    pos = polar(math.radians(115), 0.90, 0.72)
    oc.mb.push(kit.aim(pos, radial(math.radians(115))))
    oc.mb.box((0, 0, 0.05), (0.32, 0.2, 0.1), 'Copper')
    for j in range(8):
        oc.mb.box((-0.14 + j * 0.04, 0, 0.11), (0.012, 0.18, 0.03), 'Steel')
    oc.mb.pop()
    oc.row('bolt', 'coolerBolt', pos + radial(math.radians(115)) * 0.1 + Vector((0, 0, -0.1)), pos + radial(math.radians(115)) * 0.1 + Vector((0, 0, 0.1)), 2, radial(math.radians(115)))
    oc.wire('hoseFitting', [pos + radial(math.radians(115)) * 0.1 + Vector((0, 0, 0.14)), polar(math.radians(135), 0.98, 0.9), polar(math.radians(150), 0.9, 0.6), polar(math.radians(160), 0.5, 0.45)],
            key='black', after=['coolerBolt'], r=0.02)
    oc.part('heatsink', pos + radial(math.radians(115)) * 0.07, (0, 0, 0), chance=0.9)

    tk = m.module('tank', 0.55, pop=(0.2, 1, 0))
    pos = polar(math.radians(60), 0.90, 0.78)
    tk.mb.cyl(pos + Vector((0, 0, -0.2)), pos + Vector((0, 0, 0.2)), 0.1, 0.1, segs=14, mat='Paint')
    tk.mb.cyl(pos + Vector((0, 0.0, -0.2)), pos + Vector((0, 0, -0.22)), 0.12, 0.12, segs=14, mat='Dark')
    tk.step('clip', 'strapClip', pos + radial(math.radians(60)) * 0.1 + Vector((0, 0, -0.1)), radial(math.radians(60)))
    tk.step('clip', 'strapClip', pos + radial(math.radians(60)) * 0.1 + Vector((0, 0, 0.1)), radial(math.radians(60)))

    # ======================================================================= dress: earth, scorch, debris (not posed)
    return m


def finish_dress(m, low, rnd):
    """Sand heaped round the nose and along the slide, plus what flew off: loose blades, panel scraps, a hose."""
    d = m.dress
    # the nose sits in a bulldozed bank
    for i in range(14):
        a = 2 * PI * i / 14 + rnd.random() * 0.4
        r = 1.0 + rnd.random() * 0.5
        d.sphere((math.cos(a) * r * 0.9, 0.0, 1.5 + math.sin(a) * r * 0.6), 0.55 + rnd.random() * 0.35, 'Sand', u=7, v=4, scale=(1.4, 0.5, 1.0))
    # furrow ridges trailing back
    for j in range(6):
        for sx in (-1, 1):
            d.sphere((sx * (0.9 + j * 0.05), 0.0, -0.4 - j * 0.9), 0.35, 'Sand', u=6, v=4, scale=(0.8, 0.35, 2.0))
    # loose fan blades lying on the ground
    for (x, z, ya) in ((1.9, 1.6, 0.6), (-2.2, 2.4, 2.1), (2.6, -0.6, 1.2), (-1.7, -2.0, 0.2)):
        d.push(T(x, 0.03, z) @ kit.Ry(ya))
        blade(d, 0.0, 0.58, 0.0, 0.19, 0.15, 1.25, 1.25, 0.014, 'Blade', stations=3)
        d.pop()
    # torn cowl panel scraps
    for (x, z, ya, w, h) in ((-2.0, -1.2, 0.5, 0.9, 0.5), (3.0, 1.0, 2.5, 0.7, 0.4), (-3.0, 0.6, 1.0, 0.5, 0.35)):
        d.box((x, 0.04, z), (w, 0.03, h), 'Paint', rot=(0.08, ya, 0.1))
    # a scorch smear and a spill
    d.sphere((0.2, 0.0, -2.8), 0.9, 'Scorch', u=8, v=3, scale=(1.4, 0.04, 1.0))
    d.sphere((-0.9, 0.0, 0.2), 0.7, 'Oil', u=8, v=3, scale=(1.0, 0.03, 1.4))
    # a hose snaking away
    d.sweep([(1.2, 0.04, -1.0), (1.8, 0.04, -1.8), (2.6, 0.04, -2.0), (3.2, 0.04, -2.8)], 0.025, 'Rubber')


def min_y(m):
    ys = [(m.pose @ v.co).y for v in m.shell.bm.verts]
    return min(ys)


def preview(objs, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    for n in os.environ.get('HIDE', '').split(','):
        if n in objs:
            objs[n].hide_render = True
    scene, cam, look, shoot = kit.preview_scene()
    for name, pos, tgt, lens in (
        ('side', (6.5, 2.6, 4.2), (0, 0.8, 0.2), 34),
        ('front', (1.5, 1.6, 6.5), (0, 0.8, 0.5), 34),
        ('top', (0.5, 6.5, 0.8), (0, 0.5, 0.3), 36),
        ('rear', (-2.5, 2.4, -5.8), (0, 0.8, -0.3), 34),
        ('close', (2.2, 1.9, 2.1), (0, 0.8, 0.3), 36),
    ):
        look(pos, tgt, lens)
        shoot(os.path.join(out_dir, f'turbofan_{name}.png'))


def main():
    a = kit.args()
    pitch, roll = 0.20, 0.9
    base = Rx(pitch) @ Rz(roll)
    probe = build(T(0, 0, 0) @ base)
    lift = -min_y(probe) - 0.28  # the nose is dug in this far
    m = build(T(0, lift, 0) @ base)
    finish_dress(m, lift, random.Random(5))
    kit.finish(m, MATERIALS, OUT, TS, preview=a.preview, previewer=preview)


main()
