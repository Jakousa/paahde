# Hand tools for the first-person viewmodel (tools/models/hands.py): the shovel, the metal detector and a piece of
# scrap to throw. Only built and baked by hands.py, which parents them to the right hand bone (nodes `Shovel`,
# `Detector`, `ScrapChunk`) and solves the grips on the shapes described here.
#
# Each is modelled in its own "natural" frame (Blender, +Z up) with the origin where the right hand closes:
#   shovel    origin on the shaft under the T grip, +Y down the shaft to the blade, +Z the scoop's hollow face
#   detector  origin at the middle of the raked grip, +Y forward (the shaft runs forward and down), +Z up
#   scrap     origin in the middle of the held leg of a bent angle-iron offcut, +Y along it, +Z up
# Materials are procedural (scmats), baked by bake_and_export into one atlas per tool.
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scmats  # noqa: E402
from sclib import V, circle_profile, cylinder, join, loft, rect_profile, rounded_box, sweep  # noqa: E402
from rifle import aring, wood  # noqa: E402

# ---------------------------------------------------------------- shovel
SH_R = 0.0165  # shaft radius (where both hands close)
SH_TOP = -0.075  # T grip, above the right fist
SH_SOCKET = 0.40  # steel socket starts; the blade below it
BLADE_Y0, BLADE_Y1 = 0.455, 0.68  # blade shoulders .. tip
BLADE_W = 0.082  # half width at the shoulders
BLADE_DISH = 2.2  # z = DISH · x² across the blade (the hollow faces +Z)
SH_LEFT = 0.17  # where the left hand holds the shaft (y)


def blade_half(y):
    """Half width of the blade at y: straight sides, then a rounded point."""
    f = (y - BLADE_Y0) / (BLADE_Y1 - BLADE_Y0)
    return BLADE_W * (1.0 if f < 0.55 else math.sqrt(max(0.0, 1 - ((f - 0.55) / 0.45) ** 2)) * 0.97 + 0.03)


def blade_ring(y, n=12, t=0.0028):
    """Closed section across the blade at y: the dished top edge out and the underside back."""
    w = max(blade_half(y), 0.004)
    top = [V((x, y, BLADE_DISH * x * x)) for x in (w * (2 * k / (n - 1) - 1) for k in range(n))]
    return top + [V((p.x, p.y, p.z - t)) for p in reversed(top)]


def build_shovel(at=V((0, 0, 0))):
    M = {
        'wood': wood('ShovelWood', base='#8a5a32', dark='#4a2c14', light='#b88a58'),
        'steel': scmats.metal('ShovelSteel', '#8e8e88', '#5a4632', rough=0.45, dust=0.7, dirt=0.9, scratches=0.9,
                              paint='#3c4a36'),
        'dark': scmats.metal('ShovelDark', '#4a4844', '#2a2420', rough=0.5, dust=0.6),
    }
    objs = []
    objs.append(cylinder('Shaft', (0, SH_TOP, 0), (0, SH_SOCKET + 0.02, 0), SH_R, M['wood'], n=12))
    # T grip: a short crossbar with rounded ends, over a steel cap on the shaft
    objs.append(cylinder('TBar', (-0.045, SH_TOP - 0.014, 0), (0.045, SH_TOP - 0.014, 0), 0.013, M['wood'], n=12,
                         rings_extra=[(0.03, 1.0), (0.97, 1.0)]))
    objs.append(cylinder('TCap', (0, SH_TOP + 0.012, 0), (0, SH_TOP - 0.006, 0), SH_R * 1.12, M['dark'], n=12))
    # socket: steel sleeve round the shaft end, flaring into the blade, with two rivets
    objs.append(cylinder('Socket', (0, SH_SOCKET, 0), (0, BLADE_Y0 + 0.012, 0.004), SH_R * 1.15, M['steel'], n=12,
                         r2=SH_R * 1.45, rings_extra=[(0.04, 1.12)]))
    for y in (SH_SOCKET + 0.016, SH_SOCKET + 0.038):
        objs.append(cylinder('Rivet', (0, y, SH_R * 1.1), (0, y, SH_R * 1.32), 0.0035, M['dark'], n=8))
    # blade: dished, a rolled step on top of each shoulder for the boot
    rings = [blade_ring(y) for y in [BLADE_Y0 + (BLADE_Y1 - BLADE_Y0) * k / 14 for k in range(15)]]
    objs.append(loft('Blade', rings, M['steel'], cap_start=True, cap_end=True))
    for s in (1, -1):
        x0, x1 = s * 0.02, s * BLADE_W
        objs.append(cylinder('Tread', (x0, BLADE_Y0 + 0.004, BLADE_DISH * x0 * x0 - 0.001),
                             (x1, BLADE_Y0 + 0.004, BLADE_DISH * x1 * x1 - 0.001), 0.0045, M['steel'], n=8))
    sh = join(objs, 'Shovel')
    for v in sh.data.vertices:
        v.co += V(at)
    return sh


# ---------------------------------------------------------------- metal detector
DT_RAKE = 16  # grip rake (deg): its top leans forward
DT_GRIP_R = 0.0158
DT_GRIP_TOP, DT_GRIP_BOT = 0.048, -0.052
DT_GRIP_AXIS = V((0, math.sin(math.radians(DT_RAKE)), math.cos(math.radians(DT_RAKE))))
DT_BOX = ((-0.022, -0.06, 0.048), (0.022, 0.07, 0.084))  # control box over the grip (lo, hi)
DT_SHAFT0 = V((0, 0.06, 0.056))  # where the shaft leaves the box
DT_DOWN = 22  # shaft angle below the grip's forward (deg)
DT_LEN = 0.60
DT_SHAFT = V((0, math.cos(math.radians(DT_DOWN)), -math.sin(math.radians(DT_DOWN))))
DT_COIL = (0.105, 0.082)  # coil half sizes (across, along)
DT_COIL_TILT = 12  # coil plane tilted up at the back (deg) from level with the grip's forward


def coil_centre():
    return DT_SHAFT0 + DT_SHAFT * (DT_LEN + 0.03) + V((0, 0, -0.03))


def build_detector(at=V((0, 0, 0))):
    M = {
        'olive': scmats.plain('DetOlive', '#4e5236', rough=0.6, dust=0.7),
        'dark': scmats.plain('DetDark', '#1e1d1b', rough=0.7, dust=0.5),
        'steel': scmats.metal('DetSteel', '#a4a6a0', '#5a5650', rough=0.35, dust=0.5, scratches=0.7),
        'brass': scmats.metal('DetBrass', '#c9a050', '#6a5228', rough=0.35, dust=0.4),
        'coil': scmats.plain('DetCoil', '#6a3e24', rough=0.65, dust=0.8),
    }
    objs = []
    side, fwd = V((1, 0, 0)), (V((0, 1, 0)) - DT_GRIP_AXIS * DT_GRIP_AXIS.y).normalized()
    # grip: rubber, finger ridges on the front
    gr = []
    for t in (DT_GRIP_BOT, DT_GRIP_BOT + 0.006, -0.02, 0.015, DT_GRIP_TOP):
        gr.append(aring(DT_GRIP_AXIS * t, DT_GRIP_AXIS, side, 0.0135, 0.0175, 2.4, 16))
    objs.append(loft('Grip', gr, M['dark'], cap_start=True, cap_end=True))
    for t in (-0.034, -0.012, 0.010, 0.032):
        c = DT_GRIP_AXIS * t + fwd * 0.0165
        objs.append(cylinder('Ridge', c - side * 0.011, c + side * 0.011, 0.0028, M['dark'], n=8))
    # control box with a dial, a speaker grille and a little red lamp
    lo, hi = V(DT_BOX[0]), V(DT_BOX[1])
    objs.append(rounded_box('Box', (lo + hi) / 2, hi - lo, M['olive'], bevel=0.007, segments=2))
    objs.append(cylinder('Dial', (0.010, -0.038, hi.z - 0.002), (0.010, -0.038, hi.z + 0.010), 0.008, M['dark'], n=14,
                         rings_extra=[(0.8, 1.0), (1.0, 0.8)]))
    objs.append(cylinder('Grille', (-0.004, 0.028, hi.z - 0.002), (-0.004, 0.028, hi.z + 0.0015), 0.014, M['dark'],
                         n=18))
    objs.append(cylinder('Lamp', (-0.012, -0.044, hi.z - 0.002), (-0.012, -0.044, hi.z + 0.004), 0.0035,
                         M['brass'], n=8))
    # shaft, a collar where it telescopes, and a coiled cable round it
    end = DT_SHAFT0 + DT_SHAFT * DT_LEN
    objs.append(cylinder('Shaft', DT_SHAFT0 - DT_SHAFT * 0.02, end, 0.0095, M['steel'], n=10,
                         rings_extra=[(0.38, 1.0), (0.39, 1.25), (0.43, 1.25), (0.44, 1.0)]))
    ax = DT_SHAFT
    s1 = side
    s2 = ax.cross(s1)
    helix = [DT_SHAFT0 + ax * (0.02 + 0.53 * k / 90) + (s1 * math.cos(k * 0.45) + s2 * math.sin(k * 0.45)) * 0.0118
             for k in range(91)]
    objs.append(sweep('Cable', helix, circle_profile(0.0022, 6), M['dark']))
    # coil: a flat racetrack ring on a yoke, tilted to lie near level in the hand
    c = coil_centre()
    tilt = math.radians(DT_COIL_TILT)
    u = V((0, math.cos(tilt), math.sin(tilt)))  # along the coil (forward)
    n = V((0, -math.sin(tilt), math.cos(tilt)))  # coil normal (up)
    ring_pts = [c + side * (DT_COIL[0] * math.cos(2 * math.pi * k / 40)) + u * (DT_COIL[1] * math.sin(2 * math.pi * k / 40))
                for k in range(40)]
    objs.append(sweep('Coil', ring_pts, rect_profile(0.022, 0.016, 0.004), M['coil'], closed_path=True,
                      up_fn=lambda i: n))
    objs.append(rounded_box('Spoke', c + n * 0.0, (0.012, DT_COIL[1] * 2 - 0.01, 0.010), M['coil'], bevel=0.003,
                            segments=1, rot=_rot_x(tilt)))
    for s in (1, -1):  # yoke cheeks from the shaft end down to the coil
        objs.append(rounded_box('Yoke', (end + c) / 2 + side * s * 0.011, (0.005, 0.03, (end - c).length + 0.02),
                                M['dark'], bevel=0.0015, segments=1, rot=_rot_x(math.atan2((end - c).y, (end - c).z))))
    dt = join(objs, 'Detector')
    for v in dt.data.vertices:
        v.co += V(at)
    return dt


def _rot_x(a):
    from mathutils import Matrix
    return Matrix.Rotation(a, 3, 'X')


# ---------------------------------------------------------------- scrap
SC_LEG, SC_T = 0.032, 0.0042  # angle-iron leg width and thickness
SC_Y0, SC_BEND = -0.07, 0.045  # held leg from SC_Y0 to the bend
SC_BENT = 0.07  # length past the bend
SC_ANGLE = 45  # bend (deg), the end kinked up and away from the thumb
# The section is an L with its corner at (x, z) = (SC_CX, SC_CZ): one leg out along +X, one up along +Z.
SC_CX, SC_CZ = -0.010, -0.010


def scrap_dir():
    a = math.radians(SC_ANGLE)
    return V((math.sin(a) * 0.4, math.cos(a), math.sin(a) * 0.9)).normalized()


def scrap_section(p, d, flip=False):
    """L section (closed loop) at p across direction d (straight leg: d = +Y)."""
    up = V((0, 0, 1))
    x = d.cross(up).normalized()  # +X for d = +Y
    z = x.cross(d).normalized()
    pts = [(0, 0), (SC_LEG, 0), (SC_LEG, SC_T), (SC_T, SC_T), (SC_T, SC_LEG), (0, SC_LEG)]
    c = p + x * SC_CX + z * SC_CZ
    return [c + x * u + z * w for u, w in pts]


def build_scrap(at=V((0, 0, 0))):
    M = {
        'rust': scmats.metal('ScrapRust', '#7a4a2e', '#3e2414', rough=0.75, dust=0.8, dirt=1.0, scratches=0.6,
                             paint='#5d6a5a'),
        'dark': scmats.metal('ScrapDark', '#55524c', '#2a2622', rough=0.5, dust=0.6),
    }
    objs = []
    d = scrap_dir()
    bend = V((0, SC_BEND, 0))
    rings = [scrap_section(V((0, y, 0)), V((0, 1, 0))) for y in (SC_Y0, -0.02, 0.02, SC_BEND - 0.008)]
    mid = (V((0, 1, 0)) + d).normalized()
    rings.append(scrap_section(bend + mid * 0.004, mid))
    rings += [scrap_section(bend + d * s, d) for s in (0.016, 0.05, SC_BENT)]
    objs.append(loft('Angle', rings, M['rust'], cap_start=True, cap_end=True, smooth=False))
    # a bolt with its nut through the bent end, and a torn tab of sheet still welded on
    c = bend + d * 0.06
    x = d.cross(V((0, 0, 1))).normalized()
    z = x.cross(d).normalized()
    p = c + x * (SC_CX + SC_LEG * 0.55) + z * SC_CZ
    objs.append(cylinder('Bolt', p - z * 0.012, p + z * 0.014, 0.0035, M['dark'], n=8))
    objs.append(cylinder('Nut', p + z * 0.004, p + z * 0.011, 0.0068, M['dark'], n=6))
    objs.append(cylinder('Head', p - z * 0.012, p - z * 0.008, 0.0068, M['dark'], n=6))
    tab = V((SC_CX, SC_Y0 + 0.008, SC_CZ + SC_LEG * 0.5))
    objs.append(rounded_box('Tab', tab + V((-0.011, 0.0, 0.0)), (0.002, 0.03, 0.024), M['rust'], bevel=0.0006,
                            segments=1, rot=_rot_x(0.3)))
    sc = join(objs, 'ScrapChunk')
    for v in sc.data.vertices:
        v.co += V(at)
    return sc


def scrap_boxes():
    """The straight held leg as two boxes (lo, hi) in the natural frame, for the grip's sdf."""
    y0, y1 = SC_Y0, SC_BEND
    return [((SC_CX, y0, SC_CZ), (SC_CX + SC_LEG, y1, SC_CZ + SC_T)),
            ((SC_CX, y0, SC_CZ), (SC_CX + SC_T, y1, SC_CZ + SC_LEG))]


# ---------------------------------------------------------------- bake
def bake_and_export(obj, out_dir, at, prefix, size=512):
    """Bake into its own atlas (material named prefix.capitalize()), origin back at the grip. Returns the object."""
    import bake
    import bpy
    bake.bake_atlas(obj, size, out_dir, tint_name='__none__', small=256, prefix=prefix)
    me = obj.data
    while len(me.materials) > 1:  # bake_atlas always adds a PlayerTint slot; there are no tint faces
        m = me.materials.pop(index=len(me.materials) - 1)
        if m and m.users == 0:
            bpy.data.materials.remove(m)
    unplace(obj, at)
    return obj


def unplace(obj, at):
    for v in obj.data.vertices:
        v.co -= V(at)
    obj.data.update()
    obj.location = (0, 0, 0)


if __name__ == '__main__':
    from sclib import reset_scene, tri_count
    reset_scene()
    for f in (build_shovel, build_detector, build_scrap):
        o = f()
        print(o.name, 'TRIS', tri_count(o))
