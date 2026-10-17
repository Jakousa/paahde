# Scavenged laser rifle: an old AK-pattern rifle rebuilt to fire a beam. Grey stamped-steel receiver and
# barrel, warm reddish-brown wooden stock, pistol grip and handguard, a cylindrical scope on a side mount
# over the receiver, a stubby curved energy cell where the magazine was, and a heavy finned emitter with a
# copper focusing coil instead of the muzzle and front sight. Scuffed and repaired: tape round the stock
# wrist and the handguard, a red and a black cable run from the cell along the handguard to the emitter,
# a canvas sling is tied up along the stock. ~0.92 m long, stylised.
#
# Used by hands.py (held in both hands of the first-person viewmodel, node `Rifle`, a child of the right
# hand bone), which also bakes it and exports public/models/rifle.glb. Standalone (bake + rifle.glb only):
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/models/rifle.py
#
# Modelling frame ("natural", used for every constant below): origin at the pistol grip (the middle of the
# grip, where the fist closes), +Y forward along the bore towards the muzzle, +Z up, +X to the rifle's
# right. build() turns the mesh 180° about Z, so the mesh itself has the muzzle at -Y, which the glTF
# exporter turns into +Z (glTF: muzzle +Z, up +Y, the rifle's right -X). FLIP maps between the two.
#
# Materials are procedural and baked into one atlas (material 'Rifle'), except the emissive 'RifleGlow'
# (the emitter core between the fins, the lens in the muzzle and the charge strip on the cell), which is
# left unbaked so the game can pulse it.
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scmats  # noqa: E402
from sclib import NB, V, catmull, circle_profile, cylinder, join, loft, new_mat, rect_profile, rounded_box, srgb, sweep  # noqa: E402
from mathutils import Matrix  # noqa: E402

FLIP = Matrix.Rotation(math.pi, 4, 'Z')

BZ = 0.087  # bore height above the grip origin
RAKE = 20  # pistol grip rake (deg): its top leans forward
GRIP_R = 0.0135  # radius of the cylinder the hand closes on
GRIP_TOP, GRIP_BOT = 0.05, -0.058  # grip extent along its axis from the origin
REC_Y0, REC_Y1 = -0.100, 0.170  # receiver
REC_Z0, REC_Z1 = 0.047, BZ + 0.028
REC_W = 0.034
BUTT_Y = -0.335
HG_Y0, HG_Y1 = 0.172, 0.355  # lower handguard (wood)
HG_R = 0.0205  # handguard radius the support hand closes on (axis on the bore, a little low)
HG_Z = BZ - 0.004
EMIT_Y0, MUZZLE_Y = 0.468, 0.588
SCOPE_Z = BZ + 0.064  # scope axis height
SCOPE_EYE_Y = -0.068  # back face of the eyepiece
SCOPE_OBJ_Y = 0.150
TN = 16  # ring resolution

TRIGGER = ((0, 0.052, REC_Z0 + 0.001), (0, 0.050, REC_Z0 - 0.010), (0, 0.045, REC_Z0 - 0.019))
GRIP_AXIS = V((0, math.sin(math.radians(RAKE)), math.cos(math.radians(RAKE))))  # bottom -> top


def wood(name='RifleWood', base='#7e3a20', dark='#441a0c', light='#a85c34'):
    """Varnished hardwood, warm reddish brown: long grain along the part (Detail v), darker heartwood
    streaks, the varnish worn through to paler wood on the edges and where hands rub, grime in the
    creases and a little dust."""
    m = new_mat(name)
    nb = NB(m)
    uv, o = nb.uv(), nb.obj()
    g = nb.wave(nb.mapping(uv, scale=(1.0, 0.07, 1.0)), scale=55.0, direction='X', distortion=5.0, detail=4.0,
                profile='SAW')
    streak = nb.noise(nb.mapping(uv, scale=(30.0, 1.5, 1.0)), scale=2.0, detail=4.0)
    col = nb.mix(nb.mr(g, 0.0, 1.0, 0.0, 0.55), srgb(base), srgb(dark))
    col = nb.mix(nb.mr(streak, 0.4, 0.75, 0.0, 0.6), col, srgb(dark))
    edge = nb.mr(nb.geo('Pointiness'), 0.5, 0.56, 0.0, 1.0)
    wn = nb.noise(o, scale=40.0, detail=5.0, rough=0.65)
    worn = nb.mul(nb.math('MAXIMUM', edge, nb.mr(wn, 0.6, 0.72, 0.0, 0.6)), nb.mr(wn, 0.3, 0.6, 0.3, 1.0))
    col = nb.mix(nb.mul(worn, 0.75), col, srgb(light))
    dents = nb.noise(o, scale=90.0, detail=3.0)
    col = nb.mix(nb.mr(dents, 0.68, 0.74, 0.0, 0.5), col, srgb('#2a120a'), blend='MULTIPLY')
    col, cav = scmats._grime(nb, col, 0.75, 0.02)
    col, dfac = scmats._dust(nb, col, o, 0.5)
    r = nb.add(0.42, nb.mul(worn, 0.3), nb.mul(g, 0.08), nb.mul(dfac, 0.3))
    h = nb.add(nb.mul(g, 0.25), nb.mr(dents, 0.68, 0.74, 0.0, -0.6))
    nb.principled(col, r, 0.0, nb.bump(h, strength=0.2, distance=0.0015))
    return m


def glow(name='RifleGlow', hex_='#ff5a1f', strength=5.0):
    """Unbaked emissive: the beam's red-orange glow (the game pulses it)."""
    m = new_mat(name)
    nb = NB(m)
    nb.principled(srgb('#3a0d04'), 0.3, 0.0, None, emission=srgb(hex_), emission_strength=strength)
    return m


def materials():
    return {
        'steel': scmats.metal('RifleSteel', '#9a9b96', '#55524c', rough=0.36, dust=0.45, dirt=0.9, scratches=0.8),
        'dark': scmats.metal('RifleDark', '#55575a', '#2a2826', rough=0.42, dust=0.4, dirt=0.8, scratches=0.6),
        'wood': wood(),
        'copper': scmats.metal('RifleCopper', '#c87a45', '#5e3a22', rough=0.3, dust=0.3, scratches=0.4),
        'cell': scmats.metal('RifleCell', '#7a7458', '#3a3628', rough=0.5, dust=0.5, paint='#5c5a3c'),
        'tape': scmats.cloth('RifleTape', '#4a4844', '#2c2a28', dust=0.6, rough=0.75, weave=0.6, wrinkle=0.4,
                             stains=0.3, bleach='#6a665e', bleach_amt=0.2),
        'tantape': scmats.cloth('RifleTanTape', '#a88a5e', '#7a6040', dust=0.7, rough=0.8, weave=0.6, wrinkle=0.5,
                                stains=0.5, bleach='#c8b088', bleach_amt=0.3),
        'sling': scmats.cloth('RifleSling', '#6e6444', '#4a4230', dust=0.9, weave=0.9, wrinkle=0.2, stains=0.5,
                              bleach='#a89a72', bleach_amt=0.35),
        'red': scmats.plain('RifleWireRed', '#8a2216', rough=0.55, dust=0.4),
        'black': scmats.plain('RifleWireBlack', '#1e1c1a', rough=0.5, dust=0.4),
        'rubber': scmats.plain('RifleRubber', '#262422', rough=0.85, dust=0.6),
        'glass': _glass(),
        'glow': glow(),
    }


def _glass():
    import telescope
    return telescope.glass('RifleLens', tint='#0a1714', edge='#1c3440')


# ------------------------------------------------------------------------------------------- shapes
def se(c, s, p):
    """Superellipse point on the unit 'circle' (p = 2 ellipse, larger = boxier)."""
    e = 2.0 / p
    return math.copysign(abs(c) ** e, c), math.copysign(abs(s) ** e, s)


XZ = Matrix(((1, 0, 0), (0, 0, 1), (0, 1, 0))).transposed()  # ring x -> X, ring y -> Z, normal -> Y


def yring(y, cx, cz, rx, rz, p=2.0, n=TN, bot=None):
    """Ring across the bore at `y`: centre (cx, cz), half sizes rx (width) / rz (height), superellipse
    exponent p. `bot` (optional) is a separate half height for the lower half."""
    pts = []
    for k in range(n):
        t = 2 * math.pi * k / n
        u, w = se(math.cos(t), math.sin(t), p)
        pts.append(V((cx + rx * u, y, cz + (rz if w >= 0 or bot is None else bot) * w)))
    return pts


def aring(c, axis, side, rx, ry, p=2.0, n=TN):
    """Ring round `axis` at c; rx along `side`, ry along axis x side."""
    a = V(axis).normalized()
    sx = (V(side) - a * V(side).dot(a)).normalized()
    sy = a.cross(sx)
    out = []
    for k in range(n):
        t = 2 * math.pi * k / n
        u, w = se(math.cos(t), math.sin(t), p)
        out.append(V(c) + sx * (rx * u) + sy * (ry * w))
    return out


def tube(name, prof, mat, n=TN, cz=0.0, cap0=True, cap1=True, cx=0.0):
    """Lathe along Y: prof = [(y, r)]."""
    return loft(name, [yring(y, cx, cz, r, r, 2.0, n) for y, r in prof], mat, cap_start=cap0, cap_end=cap1)


def lerp_prof(prof, y):
    prof = sorted(prof)
    y = max(prof[0][0], y)
    for (y0, *a), (y1, *b) in zip(prof, prof[1:]):
        if y <= y1:
            f = (y - y0) / max(1e-9, y1 - y0)
            return [x + (z - x) * f for x, z in zip(a, b)]
    return list(prof[-1][1:])


# stock side profile: (y, top z, bottom z, half width)
STOCK = [(REC_Y0 + 0.004, BZ + 0.003, 0.054, 0.0165), (-0.118, BZ + 0.001, 0.050, 0.0160),
         (-0.150, BZ - 0.003, 0.034, 0.0155), (-0.200, BZ - 0.009, 0.006, 0.0165),
         (-0.260, BZ - 0.014, -0.022, 0.0180), (-0.315, BZ - 0.020, -0.046, 0.0195), (BUTT_Y + 0.006, BZ - 0.021, -0.052, 0.0198)]


def stock_ring(y, grow=0.0, n=TN):
    top, bot, hw = lerp_prof(STOCK, y)
    return yring(y, 0.0, (top + bot) / 2, hw + grow, (top - bot) / 2 + grow, 2.6, n)


def build_parts(M):
    objs, glows = [], []
    # ---- receiver: stamped box, rounded dust cover on top, flat sides
    rec = []
    for y, top in ((REC_Y0, REC_Z1 - 0.006), (REC_Y0 + 0.006, REC_Z1 - 0.001), (REC_Y0 + 0.02, REC_Z1),
                   (REC_Y1 - 0.01, REC_Z1), (REC_Y1, REC_Z1 - 0.004)):
        zc = (top + REC_Z0) / 2
        rec.append(yring(y, 0, zc, REC_W / 2, (top - REC_Z0) / 2, 3.4, 20))
    objs.append(loft('Receiver', rec, M['steel'], cap_start=True, cap_end=True))
    # dust cover ribs, rivets, charging handle and selector on the right
    for y in (-0.05, 0.02, 0.09):
        objs.append(loft('Rib', [yring(y + d, 0, REC_Z1 - 0.012, REC_W / 2 + 0.0008, 0.0125 + 0.0008, 2.2, 14)
                                 for d in (-0.003, 0.003)], M['steel'], closed=True))
    for y, z in ((-0.085, 0.060), (0.155, 0.060), (0.155, 0.098), (0.062, 0.056)):
        for sx in (1, -1):
            objs.append(cylinder('Rivet', (sx * REC_W / 2, y, z), (sx * (REC_W / 2 + 0.0016), y, z), 0.0026,
                                 M['steel'], n=6))
    objs.append(cylinder('ChargeRod', (REC_W / 2, 0.135, REC_Z1 - 0.016), (REC_W / 2 + 0.012, 0.137, REC_Z1 - 0.016),
                         0.0035, M['dark'], n=8))
    objs.append(rounded_box('ChargeKnob', (REC_W / 2 + 0.015, 0.138, REC_Z1 - 0.016), (0.008, 0.012, 0.009),
                            M['dark'], bevel=0.003, segments=1))
    sel = [V((REC_W / 2 + 0.0015, y, z)) for y, z in ((-0.06, 0.098), (0.02, 0.097), (0.07, 0.093), (0.085, 0.083))]
    objs.append(sweep('Selector', catmull(sel, 2), rect_profile(0.0025, 0.012, 0.001), M['dark'],
                      up_fn=lambda i: V((1, 0, 0))))
    # rear trunnion where the stock goes in
    objs.append(loft('Trunnion', [stock_ring(REC_Y0 - 0.002, 0.0015), stock_ring(REC_Y0 - 0.012, 0.0015)],
                     M['dark'], cap_start=True))
    # ---- stock (wood) + steel butt plate, tape round the wrist
    ys = [REC_Y0 - 0.010, -0.118, -0.135, -0.150, -0.175, -0.200, -0.230, -0.260, -0.290, -0.315, BUTT_Y + 0.006]
    objs.append(loft('Stock', [stock_ring(y) for y in ys], M['wood']))
    b = BUTT_Y + 0.006
    objs.append(loft('ButtPlate', [stock_ring(b, 0.0008), stock_ring(BUTT_Y, 0.0008), stock_ring(BUTT_Y - 0.002, -0.004)],
                     M['steel'], cap_end=True))
    objs.append(loft('StockTape', [stock_ring(y, g) for y, g in ((-0.128, 0.0002), (-0.130, 0.0016), (-0.152, 0.0016),
                                                                    (-0.154, 0.0002))], M['tape'], closed=True))
    # ---- pistol grip (wood), along GRIP_AXIS, finger swells at the front
    side = V((1, 0, 0))
    gr = []
    for t, rx, ry in ((GRIP_TOP + 0.004, 0.0118, 0.0158), (GRIP_TOP - 0.004, 0.0122, 0.0160), (0.03, 0.0122, 0.0158),
                      (0.0, 0.0124, 0.0162), (-0.03, 0.0127, 0.0168), (GRIP_BOT + 0.006, 0.0130, 0.0174),
                      (GRIP_BOT, 0.0118, 0.0160)):
        gr.append(aring(GRIP_AXIS * t, -GRIP_AXIS, side, rx, ry, 2.4, 14))
    objs.append(loft('Grip', gr, M['wood'], cap_start=True, cap_end=True))
    objs.append(loft('GripCap', [aring(GRIP_AXIS * (GRIP_BOT + 0.001), -GRIP_AXIS, side, 0.0132, 0.0176, 2.4, 14),
                                 aring(GRIP_AXIS * (GRIP_BOT - 0.004), -GRIP_AXIS, side, 0.0105, 0.014, 2.4, 14)],
                     M['dark'], cap_end=True))
    # ---- trigger guard + trigger
    tg = [V((0, 0.012, REC_Z0 - 0.001)), V((0, 0.015, REC_Z0 - 0.022)), V((0, 0.035, REC_Z0 - 0.031)),
          V((0, 0.064, REC_Z0 - 0.027)), V((0, 0.076, REC_Z0 - 0.004))]
    objs.append(sweep('Guard', catmull(tg, 3), rect_profile(0.009, 0.0028), M['steel'],
                      up_fn=lambda i: V((1, 0, 0))))
    tr = [V(p) for p in TRIGGER]
    objs.append(sweep('Trigger', catmull(tr, 3), rect_profile(0.0055, 0.0032, 0.001), M['dark'],
                      up_fn=lambda i: V((1, 0, 0))))
    # ---- energy cell (stubby curved, where the magazine was), contacts + charge strip
    cell_axis = []
    for k in range(6):
        f = k / 5
        a = math.radians(8 + 22 * f)
        cell_axis.append(V((0, 0.112 + 0.075 * (1 - math.cos(a)) * 1.6 + 0.012 * f, REC_Z0 + 0.004 - 0.085 * f)))
    cr = []
    for i, p in enumerate(cell_axis):
        d = (cell_axis[min(i + 1, 5)] - cell_axis[max(i - 1, 0)]).normalized()
        w = 0.0145 if 0 < i < 5 else 0.0135
        cr.append(aring(p, d, side, w, 0.030 if 0 < i < 5 else 0.028, 3.0, 16))
    objs.append(loft('Cell', cr, M['cell'], cap_start=True, cap_end=True))
    for i in (1, 4):
        p = cell_axis[i]
        d = (cell_axis[i + 1] - cell_axis[i - 1]).normalized()
        objs.append(loft('CellBand', [aring(p + d * o, d, side, 0.0155, 0.0312, 3.0, 16) for o in (-0.003, 0.003)],
                         M['steel'], closed=True))
    objs.append(loft('CellCap', [aring(cell_axis[-1] + V((0, 0, -0.001)), V((0, 0, -1)), side, 0.0125, 0.026, 3.0, 16),
                                 aring(cell_axis[-1] + V((0, 0.003, -0.007)), V((0, 0, -1)), side, 0.0095, 0.02, 3.0, 16)],
                     M['copper'], cap_end=True))
    for sx in (1, -1):  # charge strip on both sides
        a, bb = cell_axis[1], cell_axis[4]
        st = [a.lerp(bb, f) + V((sx * 0.0148, 0.0, 0.0)) for f in (0.1, 0.5, 0.9)]
        glows.append(sweep('CellGlow', st, rect_profile(0.0016, 0.0045), M['glow'], up_fn=lambda i: V((1, 0, 0))))
    # cell latch (steel) at the front of the cell well
    objs.append(rounded_box('Latch', (0, 0.150, REC_Z0 - 0.002), (0.022, 0.012, 0.008), M['steel'], bevel=0.002, segments=1))
    # ---- handguard: lower (wood, round with two shallow finger flutes) and the gas-tube cover above it
    hg = []
    for y in (HG_Y0, HG_Y0 + 0.006, 0.20, 0.23, 0.26, 0.29, 0.32, HG_Y1 - 0.006, HG_Y1):
        end = 0.92 if y in (HG_Y0, HG_Y1) else 1.0
        r = (0.0215 - 0.0025 * (y - HG_Y0) / (HG_Y1 - HG_Y0)) * end

        def fl(t, i, y=y):
            return 1.0 - 0.06 * max(0.0, math.cos(2 * (t + math.pi / 2))) * (0 if y in (HG_Y0, HG_Y1) else 1)
        rg = []
        for k in range(18):
            t = 2 * math.pi * k / 18
            u, w = se(math.cos(t), math.sin(t), 2.3)
            m = fl(t, k)
            rg.append(V((r * 0.95 * u * m, y, HG_Z + r * w * (1.0 if w > 0 else 1.12))))
        hg.append(rg)
    objs.append(loft('Handguard', hg, M['wood'], cap_start=True, cap_end=True))
    gt = [yring(y, 0, BZ + 0.031, r, r * 0.95, 2.2, 14) for y, r in
          ((HG_Y0 - 0.002, 0.0115), (HG_Y0 + 0.006, 0.0128), (0.330, 0.0125), (0.338, 0.0112))]
    objs.append(loft('GasCover', gt, M['wood'], cap_start=True, cap_end=True))
    objs.append(tube('GasTube', [(0.336, 0.0075), (0.372, 0.0075)], M['dark'], n=10, cz=BZ + 0.031))
    for y in (HG_Y0 - 0.004, HG_Y1 + 0.002):  # retainer bands
        objs.append(loft('HGBand', [yring(y + d, 0, HG_Z + 0.006, 0.0215, 0.027, 2.6, 18) for d in (-0.004, 0.004)],
                         M['steel'], cap_start=True, cap_end=True))
    objs.append(loft('HGTape', [yring(y, 0, HG_Z, 0.0207 + g, 0.0222 + g, 2.3, 18) for y, g in
                                ((0.300, 0.0), (0.302, 0.0014), (0.322, 0.0014), (0.324, 0.0))], M['tantape'], closed=True))
    # ---- gas block, barrel
    objs.append(rounded_box('GasBlock', (0, 0.378, BZ + 0.012), (0.024, 0.026, 0.050), M['dark'], bevel=0.004))
    objs.append(tube('Barrel', [(HG_Y1, 0.0095), (EMIT_Y0 + 0.01, 0.0095)], M['dark'], n=12, cz=BZ))
    # ---- emitter: fins round a glowing core, tie rods, copper focusing coil, crown with the lens
    objs.append(tube('EmitBase', [(EMIT_Y0, 0.0150), (EMIT_Y0 + 0.004, 0.0190), (EMIT_Y0 + 0.010, 0.0215),
                                  (EMIT_Y0 + 0.014, 0.0215)], M['dark'], n=16, cz=BZ))
    glows.append(tube('Core', [(EMIT_Y0 + 0.013, 0.0145), (0.552, 0.0145)], M['glow'], n=12, cz=BZ, cap0=False,
                      cap1=False))
    fy = EMIT_Y0 + 0.021
    while fy < 0.548:
        objs.append(tube('Fin', [(fy - 0.0022, 0.0150), (fy - 0.0022, 0.0258), (fy, 0.0270),
                                 (fy + 0.0022, 0.0258), (fy + 0.0022, 0.0150)],
                         M['dark'], n=14, cz=BZ, cap0=False, cap1=False))
        fy += 0.0105
    for k in range(3):
        a = math.radians(90 + 120 * k)
        p = (0.0235 * math.cos(a), 0, BZ + 0.0235 * math.sin(a))
        objs.append(cylinder('TieRod', (p[0], EMIT_Y0 + 0.008, p[2]), (p[0], 0.556, p[2]), 0.0026, M['steel'], n=6))
    hel = []
    for k in range(44):
        f = k / 43
        a = 2 * math.pi * 5.0 * f
        hel.append(V((0.0178 * math.cos(a), 0.553 + 0.021 * f, BZ + 0.0178 * math.sin(a))))
    objs.append(tube('CoilCore', [(0.551, 0.0150), (0.576, 0.0150)], M['dark'], n=12, cz=BZ, cap0=False, cap1=False))
    objs.append(sweep('Coil', hel, circle_profile(0.0026, 4), M['copper'], cap=True))
    objs.append(tube('Crown', [(0.574, 0.0170), (0.577, 0.0222), (0.584, 0.0222), (MUZZLE_Y, 0.0190),
                               (MUZZLE_Y, 0.0125), (MUZZLE_Y - 0.003, 0.0105)], M['dark'], n=16, cz=BZ, cap0=True,
                      cap1=False))
    glows.append(loft('Lens', [yring(MUZZLE_Y - 0.003, 0, BZ, 0.0106, 0.0106, 2, 12),
                               yring(MUZZLE_Y - 0.0045, 0, BZ, 0.004, 0.004, 2, 12)], M['glow'], cap_end=True,
                      flip=True))
    # ---- scope: side-mount plate on the left of the receiver, two rings, tube with turrets
    objs.append(rounded_box('MountRail', (-REC_W / 2 - 0.004, 0.025, REC_Z1 - 0.022), (0.008, 0.115, 0.020),
                            M['dark'], bevel=0.002, segments=1))
    objs.append(rounded_box('MountArm', (-0.006, 0.025, REC_Z1 + 0.010), (0.034, 0.10, 0.012), M['dark'], bevel=0.003, segments=1))
    for y in (-0.012, 0.062):
        objs.append(rounded_box('MountPost', (0, y, (REC_Z1 + 0.016 + SCOPE_Z - 0.013) / 2), (0.014, 0.014,
                                SCOPE_Z - 0.013 - REC_Z1 - 0.012), M['dark'], bevel=0.002, segments=1))
        objs.append(tube('ScopeRing', [(y - 0.007, 0.0155), (y + 0.007, 0.0155)], M['dark'], n=16, cz=SCOPE_Z))
    objs.append(tube('Scope', [(SCOPE_EYE_Y, 0.0150), (SCOPE_EYE_Y + 0.002, 0.0178), (SCOPE_EYE_Y + 0.030, 0.0180),
                               (SCOPE_EYE_Y + 0.040, 0.0130), (0.098, 0.0130), (0.112, 0.0198), (SCOPE_OBJ_Y - 0.004, 0.0212),
                               (SCOPE_OBJ_Y, 0.0198)], M['steel'], n=18, cz=SCOPE_Z, cap0=False, cap1=False))
    objs.append(tube('EyeCup', [(SCOPE_EYE_Y - 0.001, 0.0185), (SCOPE_EYE_Y + 0.012, 0.0190), (SCOPE_EYE_Y + 0.012, 0.0181)],
                     M['rubber'], n=18, cz=SCOPE_Z, cap0=False, cap1=False))
    objs.append(loft('EyeLens', [yring(SCOPE_EYE_Y + 0.001, 0, SCOPE_Z, 0.0152, 0.0152, 2, 14),
                                 yring(SCOPE_EYE_Y + 0.005, 0, SCOPE_Z, 0.006, 0.006, 2, 14)], M['glass'], cap_end=True))
    objs.append(loft('ObjLens', [yring(SCOPE_OBJ_Y, 0, SCOPE_Z, 0.0199, 0.0199, 2, 16),
                                 yring(SCOPE_OBJ_Y - 0.005, 0, SCOPE_Z, 0.008, 0.008, 2, 16)], M['glass'], cap_end=True,
                     flip=True))
    for c, d in (((0, 0.03, SCOPE_Z + 0.011), (0, 0.03, SCOPE_Z + 0.024)), ((0.011, 0.03, SCOPE_Z), (0.024, 0.03, SCOPE_Z))):
        objs.append(cylinder('Turret', c, d, 0.0085, M['steel'], n=12, rings_extra=[(0.9, 1.0), (1.0, 0.85)]))
    objs.append(loft('ScopeTape', [yring(y, 0, SCOPE_Z, 0.0130 + g, 0.0130 + g, 2, 14) for y, g in
                                   ((0.072, 0.0), (0.073, 0.0013), (0.088, 0.0013), (0.089, 0.0))], M['tape'], closed=True))
    # ---- cables: from the cell's front, up the right side, along the handguard, into the emitter base
    for k, (mat, off) in enumerate(((M['red'], 0.0), (M['black'], 0.0055))):
        pts = [V((0.0135, 0.122 + off * 0.3, REC_Z0 - 0.020)), V((0.016 + off * 0.2, 0.150, REC_Z0 - 0.004)),
               V((0.0205, 0.180, HG_Z - 0.010 + off)), V((0.0225, 0.24, HG_Z - 0.006 + off)),
               V((0.0238, 0.31, HG_Z - 0.010 + off)), V((0.0225, 0.37, BZ - 0.016 + off)),
               V((0.020, 0.43, BZ - 0.008 + off)), V((0.0168, EMIT_Y0 + 0.004, BZ - 0.004 + off))]
        objs.append(sweep('Cable', catmull(pts, 2), circle_profile(0.0022, 5), mat))
    # wire ties holding the cables to the handguard and barrel
    for y in (0.24, 0.43):
        objs.append(loft('Tie', [yring(y + d, 0.003, BZ - 0.003 if y > 0.4 else HG_Z, 0.0235 if y < 0.4 else 0.0225,
                                       0.0245 if y < 0.4 else 0.0135, 2.2, 14) for d in (-0.002, 0.002)],
                         M['black'], closed=True))
    # ---- sling: tied up tight along the left side of the stock (swivels behind the wrist tape and by the butt), so it
    # stays clear of both hands
    sl = []
    for k in range(9):
        f = k / 8
        y = -0.165 + (-0.312 + 0.165) * f
        top, bot, hw = lerp_prof(STOCK, y)
        sl.append(V((-hw - 0.0035 - 0.0025 * math.sin(math.pi * f), y, bot + 0.38 * (top - bot) - 0.004 * math.sin(math.pi * f))))
    objs.append(sweep('Sling', sl, rect_profile(0.0028, 0.024), M['sling'], up_fn=lambda i: V((1, 0, 0))))
    for p in (sl[0], sl[-1]):
        objs.append(rounded_box('Swivel', p + V((0.0015, 0, 0)), (0.006, 0.010, 0.026), M['steel'], bevel=0.002, segments=1))
    return objs, glows


def build(at=V((0, 0, 0))):
    """Build the rifle (joined mesh with procedural materials + the separate glow mesh) at `at` with
    identity transforms, turned to the mesh frame (muzzle -Y). Returns (rifle, glow)."""
    M = materials()
    objs, glows = build_parts(M)
    rifle = join(objs, 'Rifle')
    gl = join(glows, 'RifleGlowMesh')
    for o in (rifle, gl):
        for v in o.data.vertices:
            v.co = FLIP.to_3x3() @ v.co + V(at)
        o.data.update()
    return rifle, gl


def bake_and_export(rifle, gl, out_dir, path, at, size=1024):
    """Bake the rifle into its own atlas (material 'Rifle'), move the meshes so the origin is the grip,
    join the unbaked glow into it (second material 'RifleGlow') and export it alone. Returns the rifle."""
    import bake
    import bpy
    bake.bake_atlas(rifle, size, out_dir, tint_name='__none__', small=512, prefix='rifle')
    me = rifle.data
    while len(me.materials) > 1:  # bake_atlas always adds a PlayerTint slot; there are no tint faces
        m = me.materials.pop(index=len(me.materials) - 1)
        if m and m.users == 0:
            bpy.data.materials.remove(m)
    for o in (rifle, gl):
        for v in o.data.vertices:
            v.co -= V(at)
        o.data.update()
        o.location = (0, 0, 0)
    uv = gl.data.uv_layers.get('Detail')
    if uv:
        uv.name = 'Atlas'
    rifle = join([rifle, gl], 'Rifle')
    bake.export(None, [rifle], path)
    return rifle


def muzzle_local():
    """Muzzle tip on the bore (natural frame)."""
    return V((0, MUZZLE_Y, BZ))


def eye_local(relief):
    """Where the eye goes: on the scope axis, `relief` behind the eyepiece (natural frame)."""
    return V((0, SCOPE_EYE_Y - relief, SCOPE_Z))


if __name__ == '__main__':
    import bpy  # noqa: F401
    from sclib import reset_scene, tri_count
    reset_scene()
    ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
    AT = V((0, 0, 0.9))
    r, g = build(AT)
    print('RIFLE TRIS', tri_count(r), 'GLOW', tri_count(g))
    bake_and_export(r, g, os.path.join(HERE, 'out'), os.path.join(ROOT, 'public', 'models', 'rifle.glb'), AT)
