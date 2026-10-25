# Procedural "scavenger" player character: build → rig → skin → animate → bake PBR atlas → export GLB.
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/models/scavenger.py
#   ... -- --fast        skip baking (procedural materials, no export), save tools/models/out/scavenger_fast.blend
#   ... -- --tex 1024     atlas size (default 2048 baked, colour kept at 2048, normal/ORM downscaled to 1024)
#
# Output: public/models/scavenger.glb (skinned meshes Scavenger_Body, Scavenger_Backpack (hidden without one), the carried
# gear (GEAR_MESH) and every piece a player can choose for their look (LOOK_MESH, shared/look.ts), materials Scavenger /
# PlayerTint / DyeRobe / DyeCape / DyeWrap (cloth baked pale, dyed by the game) / Lens,
# clips Idle, Walk, Run, Jump, Dig, Slide, Powerslide, Crouch, CrouchWalk). Faces -Y in Blender = +Z in three.js.
import math
import os
import random
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scmats  # noqa: E402
from sclib import (V, catmull, circle_profile, cylinder, fbm, frame_from, join, link, loft,  # noqa: E402
                   rect_profile, reset_scene, ring, rounded_box, select_only, sweep, tri_count)

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
FAST = '--fast' in ARGS
TEX = int(ARGS[ARGS.index('--tex') + 1]) if '--tex' in ARGS else 2048
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT_GLB = os.path.join(ROOT, 'public', 'models', 'scavenger.glb')
OUT_DIR = os.path.join(HERE, 'out')
os.makedirs(OUT_DIR, exist_ok=True)

random.seed(11)
reset_scene()

# --------------------------------------------------------------------------------------- materials
M = {
    # the robe, the hood and cape, and the wraps are dyed by the game (shared/look.ts DYES): baked in pale greys with
    # the light and dark of the old dyes, the game multiplies them by the dye
    'robe': scmats.cloth('Robe', '#f2f2f2', '#aeaeae', dust=1.0, bleach='#ffffff', bleach_amt=0.45),
    'cape': scmats.cloth('Cape', '#f2f2f2', '#949494', dust=0.9, bleach='#ffffff', bleach_amt=0.3, wrinkle=0.6),
    'wrap': scmats.cloth('Wrap', '#f2f2f2', '#9c9c9c', dust=0.8, weave=0.7, wrinkle=0.3, bleach='#ffffff', bleach_amt=0.3),
    'trousers': scmats.cloth('Trousers', '#4a3e33', '#2b231c', dust=1.2, bleach='#7a6a58', bleach_amt=0.25),
    'tint': scmats.cloth('Tint', '#cfc6b8', '#958c80', dust=0.55, stains=0.3, bleach='#f0ebe2', bleach_amt=0.2,
                         wrinkle=0.7),
    'leather': scmats.leather('Leather', '#4a3020', '#24160d', rough=0.52),
    'leather2': scmats.leather('LeatherTan', '#7a5534', '#3f2a19', scuff='#a8845e', rough=0.6),
    'brass': scmats.metal('Brass', '#b08a46', '#3d4a32', rough=0.36),
    'steel': scmats.metal('Steel', '#6d6a66', '#3b2a1e', rough=0.45, scratches=0.7),
    'paint': scmats.metal('PaintedSteel', '#6d6a66', '#4a2a16', rough=0.45, paint='#5b6247'),
    'rubber': scmats.plain('Rubber', '#1c1917', rough=0.75),
    'canvas': scmats.cloth('Canvas', '#6b6247', '#3d3828', dust=1.0, weave=0.8, bleach='#9a916f', bleach_amt=0.3),
    'wood': scmats.wood('Wood'),
    'lens': scmats.lens('Lens', glow='#ff9a2e', strength=1.6),
}

# ---------------------------------------------------------------------------------- skeleton layout
SH_L = V((0.17, 0.02, 1.45))
UPPER_DIR = V((math.cos(math.radians(62)), 0, -math.sin(math.radians(62))))
ELB_L = SH_L + UPPER_DIR * 0.29
FORE_DIR = V((0.42, -0.2, -0.885)).normalized()
WR_L = ELB_L + FORE_DIR * 0.26
KNU_L = WR_L + FORE_DIR * 0.088

B = {  # name: (head, tail, parent)   Left = +X (character faces -Y)
    'Hips': ((0, 0.0, 0.98), (0, 0.0, 1.08), None),
    'Spine': ((0, 0.0, 1.08), (0, 0.005, 1.20), 'Hips'),
    'Spine1': ((0, 0.005, 1.20), (0, 0.005, 1.32), 'Spine'),
    'Spine2': ((0, 0.005, 1.32), (0, 0.005, 1.50), 'Spine1'),
    'Neck': ((0, 0.005, 1.50), (0, -0.005, 1.60), 'Spine2'),
    'Head': ((0, -0.005, 1.60), (0, -0.005, 1.80), 'Neck'),
}


def add_side(sign, pre):
    def m(p):
        return (p[0] * sign, p[1], p[2])
    B[pre + 'Shoulder'] = (m((0.03, 0.0, 1.46)), m(tuple(SH_L)), 'Spine2')
    B[pre + 'Arm'] = (m(tuple(SH_L)), m(tuple(ELB_L)), pre + 'Shoulder')
    B[pre + 'ForeArm'] = (m(tuple(ELB_L)), m(tuple(WR_L)), pre + 'Arm')
    B[pre + 'Hand'] = (m(tuple(WR_L)), m(tuple(KNU_L)), pre + 'ForeArm')
    B[pre + 'HandIndex1'] = (m(tuple(KNU_L)), m(tuple(KNU_L + FORE_DIR * 0.04)), pre + 'Hand')
    B[pre + 'HandIndex2'] = (m(tuple(KNU_L + FORE_DIR * 0.04)), m(tuple(KNU_L + FORE_DIR * 0.08)), pre + 'HandIndex1')
    th0 = WR_L + FORE_DIR * 0.02 + V((0, -0.03, 0))
    B[pre + 'HandThumb1'] = (m(tuple(th0)), m(tuple(th0 + V((0.0, -0.03, -0.045)))), pre + 'Hand')
    B[pre + 'UpLeg'] = (m((0.095, 0.0, 0.94)), m((0.10, -0.01, 0.51)), 'Hips')
    B[pre + 'Leg'] = (m((0.10, -0.01, 0.51)), m((0.105, 0.02, 0.09)), pre + 'UpLeg')
    B[pre + 'Foot'] = (m((0.105, 0.02, 0.09)), m((0.11, -0.10, 0.025)), pre + 'Leg')
    B[pre + 'ToeBase'] = (m((0.11, -0.10, 0.025)), m((0.11, -0.175, 0.025)), pre + 'Foot')


add_side(1, 'Left')
add_side(-1, 'Right')


def seg_dist(p, a, b):
    a, b = V(a), V(b)
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (p - (a + ab * t)).length


PARTS = []  # (obj, weight spec)
# Gear pieces split into their own meshes, by vertex group → glb mesh: the backpack (shown only with one equipped) and
# the things carried on the body (shown only while in the bag: src/models/scavenger.ts CARRIED).
GEAR = {'GearBack': [], 'GearShovel': [], 'GearCanteen': [], 'GearSidearm': [], 'GearScrap': []}
GEAR_MESH = {'GearBack': 'Scavenger_Backpack', 'GearShovel': 'Scavenger_Shovel', 'GearCanteen': 'Scavenger_Canteen',
             'GearSidearm': 'Scavenger_Sidearm', 'GearScrap': 'Scavenger_Scrap'}


# The pieces a player chooses between (shared/look.ts, src/models/scavenger.ts LOOK_PIECES), each split into its own
# mesh the same way: vertex group → glb mesh.
LOOK = {}
LOOK_MESH = {}


def tagged(group, fn, *args):
    """Build fn(*args) as the look piece `group`: every part it adds becomes the mesh Scavenger_<group>."""
    n = len(PARTS)
    out = fn(*args)
    LOOK.setdefault(group, []).extend(o for o, _ in PARTS[n:])
    LOOK_MESH['Look' + group] = 'Scavenger_' + group
    return out


def part(obj, bones=None, rigid=None, fn=None, bias=None, power=4.0):
    PARTS.append((obj, dict(bones=bones, rigid=rigid, fn=fn, bias=bias or {}, power=power)))
    return obj


def apply_weights(obj, spec):
    groups = {}

    def g(name):
        if name not in groups:
            groups[name] = obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name)
        return groups[name]

    for v in obj.data.vertices:
        if spec['rigid']:
            w = {spec['rigid']: 1.0}
        elif spec['fn']:
            w = spec['fn'](v.co)
        else:
            w = {}
            for bn in spec['bones']:
                h, t, _ = B[bn]
                d = seg_dist(v.co, h, t)
                w[bn] = spec['bias'].get(bn, 1.0) / (d + 0.004) ** spec['power']
        tot = sum(w.values())
        items = sorted(((k, x / tot) for k, x in w.items()), key=lambda kv: -kv[1])[:4]
        items = [(k, x) for k, x in items if x > 0.02]
        tot = sum(x for _, x in items)
        for k, x in items:
            g(k).add([v.index], x / tot, 'REPLACE')


def smooth01(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


# ------------------------------------------------------------------------------------------ helpers

def superellipse(p):
    def fn(t, i):
        return 1.0 / (abs(math.cos(t)) ** p + abs(math.sin(t)) ** p) ** (1.0 / p)
    return fn


def tattered(pts, amount=0.05, seed=0.0, freq=11.0):
    for p in pts:
        n = fbm((p.x * freq, p.y * freq, seed), 2)
        p.z -= amount * (0.5 + n) + amount * 0.6 * max(0.0, math.sin(p.x * 61 + p.y * 37 + seed * 7)) ** 8


def fold_back(pts, center_xy, inset=0.97, lift=0.03):
    out = []
    for p in pts:
        d = V((p.x - center_xy[0], p.y - center_xy[1], 0)) * inset
        out.append(V((center_xy[0] + d.x, center_xy[1] + d.y, p.z + lift)))
    return out


# =============================================================================== CLOTHING / BODY

def build_torso():
    zs = [0.90, 1.00, 1.10, 1.21, 1.31, 1.39, 1.45, 1.50, 1.545, 1.585]
    rx = [0.172, 0.166, 0.158, 0.168, 0.178, 0.178, 0.162, 0.115, 0.074, 0.064]
    ry = [0.132, 0.126, 0.118, 0.124, 0.132, 0.128, 0.115, 0.088, 0.068, 0.062]
    yo = [0.0, 0.0, 0.005, 0.0, -0.008, -0.005, 0.0, 0.005, 0.0, 0.006]
    rings = []
    for i, z in enumerate(zs):
        def fn(t, k, i=i):
            back = 0.96 if math.sin(t) > 0 else 1.0
            return back * (1 + 0.015 * math.sin(7 * t + i * 1.3))
        rings.append(ring((0, yo[i], z), rx[i], ry[i], 24, fn=fn))
    return part(loft('Torso', rings, M['robe']),
                bones=['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'LeftShoulder', 'RightShoulder'])


# the capelet: close over the chest and back (depth), wide enough over the arms
CAPE_T = ([1.585, 1.555, 1.525, 1.485, 1.435, 1.385, 1.335, 1.285],
          [0.078, 0.120, 0.180, 0.232, 0.262, 0.282, 0.296, 0.304],
          [0.073, 0.104, 0.130, 0.150, 0.160, 0.166, 0.170, 0.174])
SKIRT_Z = [1.03, 0.93, 0.82, 0.70, 0.58, 0.47, 0.37]
SKIRT_RX = [0.180, 0.196, 0.215, 0.232, 0.246, 0.256, 0.262]
SKIRT_RY = [0.140, 0.158, 0.178, 0.194, 0.206, 0.214, 0.220]


def skirt_weights(side):
    pre = 'Left' if side > 0 else 'Right'
    other = 'Right' if side > 0 else 'Left'

    def fn(co):
        t = smooth01(1.0, 0.62, co.z)
        hips = 1.0 - 0.85 * t
        leg = 0.3 * smooth01(0.55, 0.3, co.z)
        # near the front/back centre seam a little of the other leg keeps the halves from tearing apart
        seam = max(0.0, 1.0 - abs(co.x) / 0.06) * 0.25
        up = (0.85 * t) * (1 - seam)
        return {'Hips': hips, pre + 'UpLeg': max(up - leg * 0.5, 0.001), pre + 'Leg': leg + 1e-4,
                other + 'UpLeg': 0.85 * t * seam + 1e-4}
    return fn


def build_skirt(side):
    n = 26
    if side > 0:
        a0, a1 = -math.pi / 2 - 0.14, math.pi / 2 + 0.14
        over = 1.0
    else:
        a0, a1 = math.pi / 2 - 0.14, 3 * math.pi / 2 + 0.14
        over = 0.982
    rings = []
    for i, z in enumerate(SKIRT_Z):
        depth = (SKIRT_Z[0] - z) / (SKIRT_Z[0] - SKIRT_Z[-1])

        def fn(t, k, depth=depth):
            fold = 0.05 * depth * math.sin(t * 9 + side) + 0.025 * depth * math.sin(t * 17 + 2)
            return over * (1 + fold + 0.035 * depth * fbm((math.cos(t) * 2, math.sin(t) * 2, depth * 2)))
        rings.append(ring((0, 0.012, z), SKIRT_RX[i], SKIRT_RY[i], n, fn=fn, a0=a0, a1=a1, closed=False))
    # longer at the back
    for r in rings[-3:]:
        for p in r:
            if p.y > 0:
                p.z -= 0.13 * (p.y / 0.22) ** 1.5
    tattered(rings[-1], 0.045, seed=side)
    rings.append(fold_back(rings[-1], (0, 0.012), 0.975, 0.035))
    return part(loft('Skirt' + ('L' if side > 0 else 'R'), rings, M['robe'], closed=False), fn=skirt_weights(side))


# the poncho: the capelet carried on down to the waist, wider over the arms
PONCHO_T = (CAPE_T[0] + [1.235, 1.185, 1.135, 1.085], CAPE_T[1] + [0.318, 0.33, 0.338, 0.342],
            CAPE_T[2] + [0.180, 0.186, 0.190, 0.193])


def build_cape(shape=CAPE_T, name='Cape'):
    zs, rx, ry = shape
    n = 44
    rings = []
    for i, z in enumerate(zs):
        depth = i / (len(zs) - 1)

        def fn(t, k, depth=depth):
            return 1 + depth ** 1.5 * (0.05 * math.sin(t * 13 + 0.5) + 0.025 * math.sin(t * 27)) \
                + 0.03 * depth * fbm((math.cos(t) * 3, math.sin(t) * 3, 5.0))
        rings.append(ring((0, 0.008, z), rx[i], ry[i], n, fn=fn))
    for r in rings[-4:]:
        for p in r:
            if p.y > 0:  # longer at the back
                p.z -= 0.16 * (p.y / 0.2) ** 1.5
    tattered(rings[-1], 0.04, seed=3.0)
    rings.append(fold_back(rings[-1], (0, 0.008), 0.99, 0.012))  # a thin hem
    return part(loft(name, rings, M['cape']),
                bones=['Spine1', 'Spine2', 'Neck', 'LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm'],
                bias={'LeftArm': 0.35, 'RightArm': 0.35, 'Spine2': 1.5}, power=3.0)


def build_hood(size=0.83, front=0.0, point=0.0, drape=0.35, ragged=0.0, name='Hood'):
    """The hood, scaled about the head (size), with a deeper front, a pointed peak at the back, how far it spreads onto
    the shoulders (drape), and a torn opening (ragged)."""
    ys = [-0.100, -0.136, -0.112, -0.060, 0.000, 0.060, 0.110, 0.152, 0.186, 0.208]
    rx = [0.128, 0.138, 0.146, 0.153, 0.156, 0.152, 0.142, 0.122, 0.090, 0.045]
    rz = [0.282, 0.300, 0.308, 0.312, 0.306, 0.292, 0.268, 0.228, 0.165, 0.085]
    zc = [1.535, 1.530, 1.530, 1.530, 1.522, 1.505, 1.488, 1.470, 1.458, 1.455]
    n = 34
    rings = []
    for i, y in enumerate(ys):
        y -= front * max(0.0, 1 - i / 3)
        back = max(0.0, (i - 4) / 5)
        pts = []
        for k in range(n):
            s = -0.42 + (math.pi + 0.84) * k / (n - 1)
            c, sn = math.cos(s), math.sin(s)
            p = 2.6
            x = rx[i] * math.copysign(abs(c) ** (2 / p), c)
            z = zc[i] + rz[i] * math.copysign(abs(sn) ** (2 / p), sn)
            if sn < 0:  # drape outward onto the shoulders
                x *= 1 + drape * (-sn)
            # the peak: the top of the back rings pulled up and back into a point
            z += point * back ** 1.5 * max(0.0, sn) ** 6
            yy = y + point * 0.6 * back ** 2 * max(0.0, sn) ** 6
            wob = 0.012 * fbm((x * 12, y * 12, z * 12))
            pts.append(V((x * (1 + wob), yy + 0.01 * math.sin(s * 5 + i), z + wob * 0.3)))
        rings.append(pts)
    # brim droops a little at the top centre of the opening
    for p in rings[1]:
        p.z -= 0.012 * max(0.0, (p.z - 1.75) / 0.08)
    if ragged:
        for r in rings[:2]:
            for p in r:
                p.y -= ragged * (0.4 + fbm((p.x * 30, p.z * 30, 3.0), 2)) * (0.6 + max(0.0, math.sin(p.z * 90)) ** 4)
    c = V((0, 0.01, 1.71))  # about the brow, so the crown keeps clear of the skull
    for r in rings:
        for p in r:
            p[:] = c + (p - c) * size
    return part(loft(name, rings, M['cape'], closed=False),
                bones=['Head', 'Neck', 'Spine2'], bias={'Head': 3.0, 'Spine2': 0.6}, power=3.0)


def build_headwrap():
    zs = [1.50, 1.545, 1.585, 1.625, 1.665, 1.705, 1.740, 1.762, 1.776]
    r = [0.058, 0.070, 0.084, 0.092, 0.095, 0.093, 0.084, 0.062, 0.03]
    rings = []
    for i, z in enumerate(zs):
        def fn(t, k, i=i, z=z):
            front = max(0.0, -math.sin(t))  # -Y half
            m = 1.0 + 0.012 * fbm((math.cos(t) * 4, math.sin(t) * 4, z * 30))
            if 1.53 < z < 1.62:
                m += 0.10 * front ** 3  # chin / jaw under the mask
            if z > 1.68:
                m -= 0.12 * max(0.0, math.sin(t))  # the back of the skull, kept inside the hood
            return m
        rings.append(ring((0, 0.008, z), r[i], r[i] * 1.12, 20, fn=fn))
    part(loft('HeadWrap', rings, M['wrap'], cap_end=True), bones=['Head', 'Neck'], bias={'Head': 2.0})
    # scarf pulled up over the lower face (player colour), under the goggles and respirator
    mrings = []
    for z, r in ((1.535, 0.088), (1.565, 0.094), (1.60, 0.102), (1.635, 0.104), (1.652, 0.101), (1.66, 0.096)):
        def fn(t, k, z=z):
            front = max(0.0, -math.sin(t))
            m = 1.0 + 0.02 * math.sin(t * 9 + z * 80)
            if z < 1.62:
                m += 0.08 * front ** 3
            return m
        mrings.append(ring((0, 0.006, z), r, r * 1.12, 22, fn=fn, a0=math.radians(200), a1=math.radians(340),
                           closed=False))
    for p in mrings[-1]:  # sag under the nose bridge
        p.z -= 0.012 * math.cos(math.atan2(p.y, p.x) + math.pi / 2) ** 2
    part(loft('FaceMask', mrings, M['tint'], closed=False), bones=['Head', 'Neck'], bias={'Head': 3.0})


def build_goggles():
    objs, lenses = [], []
    for s in (1, -1):
        E = V((s * 0.036, -0.096, 1.676))
        d = V((s * 0.20, -1.0, 0.03)).normalized()
        fr = frame_from(d, V((0, 0, 1)))
        def rr(t, r, n=16):
            return ring(E + d * t, r, r, n, fr)
        objs.append(loft('GogCushion', [rr(-0.006, 0.024), rr(0.004, 0.0275), rr(0.012, 0.026)],
                         M['leather']))
        objs.append(loft('GogCup', [rr(0.010, 0.0235), rr(0.024, 0.024), rr(0.028, 0.0258), rr(0.033, 0.0255),
                                    rr(0.0345, 0.0235), rr(0.034, 0.0195), rr(0.027, 0.0192)], M['brass']))
        lenses.append(loft('GogLens', [rr(0.026, 0.0196), rr(0.0285, 0.013), rr(0.0295, 0.004)],
                           M['lens'], cap_end=True))
        # little hinge screw
        objs.append(cylinder('GogScrew', E + d * 0.022 + fr.col[0] * s * 0.026,
                             E + d * 0.022 + fr.col[0] * s * 0.032, 0.004, M['brass'], n=6))
    objs.append(sweep('GogBridge', catmull([(0.012, -0.123, 1.678), (0, -0.126, 1.682), (-0.012, -0.123, 1.678)], 3),
                      circle_profile(0.0035, 6), M['brass']))
    # strap around the head
    pts = []
    for k in range(25):
        a = math.radians(-62 + (360 - 56) * k / 24)  # from left lens round the back to right lens
        pts.append(V((math.cos(a + math.pi / 2) * -0.1 * -1, 0, 0)))
    path = []
    for k in range(25):
        a = math.radians(-58) + (2 * math.pi - math.radians(124)) * k / 24  # around back
        ang = -math.pi / 2 + math.radians(58) + (2 * math.pi - math.radians(116)) * k / 24
        path.append(V((math.cos(ang) * 0.103, 0.008 + math.sin(ang) * 0.115, 1.68 + 0.006 * math.sin(ang))))
    objs.append(sweep('GogStrap', path, rect_profile(0.004, 0.022), M['leather2'], up=V((0, 0, 1))))
    body = join(objs, 'Goggles')
    part(body, rigid='Head')
    lens = join(lenses, 'Lenses')
    return lens


def build_respirator():
    objs = []
    base = V((0, -0.103, 1.603))
    d = V((0, -0.88, -0.47)).normalized()
    fr = frame_from(d, V((1, 0, 0)))
    prof = [(-0.004, 0.030), (0.010, 0.032), (0.014, 0.0345), (0.018, 0.031), (0.024, 0.0335), (0.028, 0.029),
            (0.038, 0.026), (0.044, 0.024), (0.046, 0.019), (0.044, 0.010)]
    objs.append(loft('RespSnout', [ring(base + d * t, r, r * 0.9, 14, fr) for t, r in prof], M['steel'],
                     cap_end=True))
    # grille bars on the front
    for k in (-1, 0, 1):
        a = base + d * 0.045 + fr.col[0] * k * 0.008
        objs.append(rounded_box('Grille', a, (0.003, 0.004, 0.03), M['brass'], bevel=0.0,
                                rot=Matrix((fr.col[0], fr.col[2], fr.col[1])).transposed()))
    for s in (1, -1):
        c = V((s * 0.052, -0.094, 1.585))
        cd = V((s * 0.65, -0.62, -0.42)).normalized()
        objs.append(cylinder('Canister', c, c + cd * 0.05, 0.019, M['paint'], n=12,
                             rings_extra=[(0.08, 1.0), (0.12, 1.08), (0.2, 1.08), (0.24, 1.0), (0.85, 1.0),
                                          (0.9, 0.85)]))
        objs.append(cylinder('CanCap', c + cd * 0.048, c + cd * 0.056, 0.014, M['brass'], n=10))
    resp = join(objs, 'Respirator')
    part(resp, rigid='Head')
    # corrugated hose from the snout down to the chest gauge
    hp = catmull([(0, -0.136, 1.578), (0.022, -0.152, 1.535), (0.058, -0.172, 1.475), (0.098, -0.205, 1.405),
                  (0.12, -0.232, 1.352)], 5)
    hose = sweep('Hose', hp, circle_profile(0.0078, 8), M['rubber'],
                 scale_fn=lambda i, f: ((1 + 0.12 * (i % 2)),) * 2)
    part(hose, bones=['Head', 'Neck', 'Spine2'], bias={'Spine2': 1.5})


def build_scarf():
    objs = []
    for zc, tilt, rx, ry, w, ph in ((1.535, 0.05, 0.122, 0.128, 0.066, 0.0), (1.58, 0.04, 0.108, 0.118, 0.058, 1.7)):
        path = []
        for k in range(36):
            a = 2 * math.pi * k / 36
            front = -math.sin(a)  # +1 at front (-Y)
            path.append(V((math.cos(a) * rx, 0.004 + math.sin(a) * ry, zc - tilt * front)))
        objs.append(sweep('ScarfLoop', path, [(-w / 2, 0.0), (-w / 4, 0.012), (0, 0.016), (w / 4, 0.012),
                                               (w / 2, 0.0), (w / 4, -0.006), (0, -0.007), (-w / 4, -0.006)],
                          M['tint'], closed_path=True, up=V((0, 0, 1)),
                          scale_fn=lambda i, f, ph=ph: (1 + 0.18 * math.sin(i * 1.3 + ph), 1 + 0.35 * math.sin(i * 0.9 + ph))))
    loops = join(objs, 'ScarfLoops')
    part(loops, bones=['Neck', 'Spine2', 'Head'], bias={'Neck': 2.0})
    # hanging tail over the chest
    tp = catmull([(0.035, -0.105, 1.545), (0.065, -0.17, 1.48), (0.10, -0.228, 1.39), (0.118, -0.248, 1.29),
                  (0.128, -0.255, 1.18)], 4)
    tail = sweep('ScarfTail', tp, rect_profile(0.012, 0.085, 0.004), M['tint'],
                 up_fn=lambda i: V((0, -1, 0.15)),
                 scale_fn=lambda i, f: (1.0, 0.85 + 0.25 * f + 0.06 * math.sin(i * 2.1)),
                 twist_fn=lambda i, f: 0.25 * math.sin(f * 4))
    for v in tail.data.vertices:
        if v.co.z < 1.20:
            v.co.z -= 0.03 * (0.5 + fbm((v.co.x * 60, 0, 0)))
    part(tail, bones=['Spine2', 'Spine1', 'Neck'], bias={'Spine2': 2.0})


def arm_path(sign):
    m = V((sign, 1, 1))
    s = V((SH_L.x * 0.85, SH_L.y, SH_L.z + 0.005))
    pts = [s - UPPER_DIR * 0.03, s, SH_L + UPPER_DIR * 0.145, ELB_L, ELB_L + FORE_DIR * 0.13, WR_L,
           WR_L + FORE_DIR * 0.015]
    return [V((p.x * sign, p.y, p.z)) for p in pts]


def build_sleeve(sign):
    pre = 'Left' if sign > 0 else 'Right'
    ctrl = arm_path(sign)
    path = catmull(ctrl, 3)
    frames = __import__('sclib').path_frames(path, V((0, -1, 0)))
    total = len(path) - 1
    rings = []
    for i, (p, (t, nr, bn)) in enumerate(zip(path, frames)):
        f = i / total
        r = [0.070, 0.068, 0.064, 0.062, 0.060, 0.050, 0.044, 0.042]
        rr = r[min(int(f * 7), 6)] + (r[min(int(f * 7) + 1, 7)] - r[min(int(f * 7), 6)]) * (f * 7 - int(f * 7))
        fr = Matrix((nr, bn, t)).transposed()

        def fn(a, k, f=f):
            bunch = 0.06 * math.exp(-((f - 0.5) / 0.09) ** 2) * math.sin(a * 5 + f * 30)
            return 1 + bunch + 0.03 * fbm((math.cos(a) * 3, math.sin(a) * 3, f * 9))
        rings.append(ring(p, rr, rr * 0.92, 14, fr, fn=fn))
    sl = loft(pre + 'Sleeve', rings, M['robe'])
    part(sl, bones=[pre + 'Shoulder', pre + 'Arm', pre + 'ForeArm', pre + 'Hand'],
         bias={pre + 'Shoulder': 0.5})
    # bandage wraps on the forearm
    a, b = V((ELB_L.x * sign, ELB_L.y, ELB_L.z)) + V((FORE_DIR.x * sign, FORE_DIR.y, FORE_DIR.z)) * 0.10, \
        V((WR_L.x * sign, WR_L.y, WR_L.z)) + V((FORE_DIR.x * sign, FORE_DIR.y, FORE_DIR.z)) * 0.005
    ax = (b - a).normalized()
    fr = frame_from(ax, V((0, -1, 0)))
    hp = []
    turns, steps = 5.5, 66
    for k in range(steps + 1):
        f = k / steps
        ang = 2 * math.pi * turns * f * sign
        rad = 0.047 - 0.007 * f + 0.002 * math.sin(k)
        hp.append(a.lerp(b, f) + fr @ V((math.cos(ang) * rad, math.sin(ang) * rad, 0)))
    wr = sweep(pre + 'Wraps', hp, rect_profile(0.004, 0.03), M['wrap'], up_fn=lambda i: (hp[i] - a.lerp(b, i / steps)))
    part(wr, bones=[pre + 'Arm', pre + 'ForeArm', pre + 'Hand'], bias={pre + 'Hand': 0.4})
    if sign > 0:  # player-colour armband on the left upper arm
        c = V((SH_L + UPPER_DIR * 0.16))
        fr2 = frame_from(UPPER_DIR, V((0, -1, 0)))
        ap = [c + fr2 @ V((math.cos(a_) * 0.070, math.sin(a_) * 0.066, 0.004 * math.sin(a_ * 3))) for a_ in
              [2 * math.pi * k / 20 for k in range(20)]]
        band = sweep('Armband', ap, rect_profile(0.006, 0.04), M['tint'], closed_path=True,
                     up_fn=lambda i: ap[i] - c)
        part(band, bones=['LeftArm'], rigid='LeftArm')


def hand_frame(sign):
    a = V((FORE_DIR.x * sign, FORE_DIR.y, FORE_DIR.z))
    fwd = V((0, -1, 0))
    pn = a.cross(fwd) * sign  # palm normal, towards the thigh
    pn.normalize()
    t = (fwd - a * fwd.dot(a) - pn * fwd.dot(pn)).normalized()  # thumb side
    return a, pn, t


def build_glove(sign):
    pre = 'Left' if sign > 0 else 'Right'
    W = V((WR_L.x * sign, WR_L.y, WR_L.z))
    a, pn, t = hand_frame(sign)
    fr = Matrix((t, pn, a)).transposed()  # ring x → thumb side, ring y → palm side, z → fingers

    def P(u, v, w):
        return W + t * u + pn * v + a * w

    secs = [(-0.058, 0.049, 0.046, 0.0), (-0.052, 0.050, 0.047, 0.0), (-0.044, 0.044, 0.041, 0.0),
            (-0.01, 0.037, 0.031, 0.0), (0.004, 0.033, 0.024, 0.002), (0.03, 0.041, 0.022, 0.004),
            (0.06, 0.046, 0.019, 0.003), (0.084, 0.046, 0.017, 0.002), (0.097, 0.043, 0.012, 0.0)]
    rings = [ring(P(0, off, w), rx, ry, 14, fr, fn=superellipse(2.6)) for w, rx, ry, off in secs]
    objs = [loft('Palm', rings, M['leather'], cap_start=True, cap_end=True)]
    fingers = [(0.029, 0.072, 0.0115), (0.0095, 0.079, 0.0120), (-0.0095, 0.075, 0.0115), (-0.028, 0.061, 0.0105)]
    fobjs = []
    for u, ln, r in fingers:
        pts = [P(u, 0.002, 0.088)]
        d = a.copy()
        for k, bend in enumerate((8, 16, 16)):
            d = Quaternion(t, math.radians(-bend) * sign) @ d  # curl towards palm (mirrored frame flips sense)
            pts.append(pts[-1] + d * (ln / 3))
        fp = catmull(pts, 2)
        fobjs.append(sweep('Finger', fp, circle_profile(r, 7), M['leather'],
                           scale_fn=lambda i, f: (1 - 0.15 * f, 1 - 0.15 * f)))
    th = [P(0.036, 0.010, 0.012)]
    d = (t * 0.55 + pn * 0.45 + a * 0.70).normalized()
    for bend in (10, 25):
        th.append(th[-1] + d * 0.032)
        d = Quaternion(pn.cross(d).normalized(), math.radians(bend) * sign) @ d
    thumb = sweep('Thumb', catmull(th, 2), circle_profile(0.011, 7), M['leather'],
                  scale_fn=lambda i, f: (1 - 0.2 * f, 1 - 0.2 * f))
    # brass rivets on the cuff
    for k in range(3):
        ang = -0.6 + k * 0.6
        c = P(math.cos(ang + math.pi / 2) * 0.05 * 0, -0.047, -0.048 + k * 0.0)
    rv = cylinder('Rivet', P(0, -0.047, -0.05), P(0, -0.052, -0.05), 0.006, M['brass'], n=8)
    palm = join(objs + [rv], pre + 'Glove')
    part(palm, bones=[pre + 'ForeArm', pre + 'Hand'], bias={pre + 'Hand': 3.0})
    fing = join(fobjs, pre + 'Fingers')
    part(fing, bones=[pre + 'Hand', pre + 'HandIndex1', pre + 'HandIndex2'], bias={pre + 'Hand': 0.5})
    part(thumb, bones=[pre + 'Hand', pre + 'HandThumb1'], bias={pre + 'Hand': 0.5})


def build_leg(sign):
    pre = 'Left' if sign > 0 else 'Right'
    pts = [V((0.095 * sign, 0.0, 0.97)), V((0.098 * sign, -0.005, 0.75)), V((0.10 * sign, -0.01, 0.51)),
           V((0.103 * sign, 0.005, 0.30)), V((0.105 * sign, 0.02, 0.14))]
    path = catmull(pts, 3)
    fr_ = __import__('sclib').path_frames(path, V((0, -1, 0)))
    rads = [0.096, 0.090, 0.074, 0.068, 0.056]
    rings = []
    for i, (p, (tg, nr, bn)) in enumerate(zip(path, fr_)):
        f = i / (len(path) - 1)
        k = min(int(f * 4), 3)
        r = rads[k] + (rads[k + 1] - rads[k]) * (f * 4 - k)
        fr = Matrix((nr, bn, tg)).transposed()
        rings.append(ring(p, r, r * 1.05, 14, fr, fn=lambda a_, j, f=f: 1 + 0.05 * math.sin(a_ * 4 + f * 20) * f))
    leg = loft(pre + 'Trousers', rings, M['trousers'])
    part(leg, bones=['Hips', pre + 'UpLeg', pre + 'Leg', pre + 'Foot'], bias={'Hips': 0.5})
    # shin wraps between boot and hem
    c0, c1 = V((0.104 * sign, 0.012, 0.28)), V((0.101 * sign, -0.004, 0.50))
    hp = []
    steps = 54
    for k in range(steps + 1):
        f = k / steps
        ang = 2 * math.pi * 5.0 * f * sign
        rad = 0.062 + 0.012 * f
        hp.append(c0.lerp(c1, f) + V((math.cos(ang) * rad, math.sin(ang) * rad * 1.05, 0.012 * math.sin(ang))))
    wr = sweep(pre + 'ShinWraps', hp, rect_profile(0.004, 0.04), M['wrap'],
               up_fn=lambda i: hp[i] - c0.lerp(c1, i / steps))
    part(wr, bones=[pre + 'Leg', pre + 'UpLeg'], bias={pre + 'Leg': 2.0})


def build_boot(sign):
    pre = 'Left' if sign > 0 else 'Right'
    x0 = 0.106 * sign
    objs = []
    shaft = []
    for z, r in ((0.08, 0.059), (0.14, 0.061), (0.22, 0.064), (0.30, 0.069), (0.315, 0.077), (0.335, 0.076),
                 (0.332, 0.067)):
        shaft.append(ring((x0, 0.022, z), r, r * 1.08, 16,
                          fn=lambda a_, k, z=z: 1 + 0.02 * fbm((math.cos(a_) * 3, math.sin(a_) * 3, z * 20))))
    objs.append(loft('BootShaft', shaft, M['leather']))
    ys = [0.085, 0.060, 0.020, -0.030, -0.080, -0.125, -0.155, -0.175, -0.184]
    hw = [0.036, 0.046, 0.049, 0.049, 0.050, 0.048, 0.041, 0.030, 0.014]
    top = [0.105, 0.135, 0.130, 0.098, 0.076, 0.066, 0.058, 0.048, 0.036]
    fr = Matrix((V((1, 0, 0)), V((0, 0, 1)), V((0, -1, 0)))).transposed()
    rings = []
    for y, w, tz in zip(ys, hw, top):
        bot = 0.018
        rings.append(ring((x0 + sign * 0.004 * (y < -0.1), y, (bot + tz) / 2), w, (tz - bot) / 2, 16, fr,
                          fn=superellipse(3.0)))
    objs.append(loft('BootFoot', rings, M['leather'], cap_start=True, cap_end=True))
    # sole
    outline = []
    for y, w in zip(ys, hw):
        outline.append((y, w + 0.006))
    pts = [V((x0 + w, y, 0)) for y, w in outline] + [V((x0 - w, y, 0)) for y, w in reversed(outline)]
    sole = [[p.copy() for p in pts], [V((p.x, p.y, 0.024)) for p in pts]]
    objs.append(loft('Sole', sole, M['rubber'], cap_start=True, cap_end=True))
    boot = join(objs, pre + 'Boot')
    part(boot, bones=[pre + 'Leg', pre + 'Foot', pre + 'ToeBase'], bias={pre + 'Foot': 1.5})
    straps = []
    for z in (0.15, 0.245):
        path = [V((x0 + math.cos(a_) * 0.068, 0.022 + math.sin(a_) * 0.073, z + 0.008 * math.cos(a_)))
                for a_ in [2 * math.pi * k / 20 for k in range(20)]]
        straps.append(sweep('BootStrap', path, rect_profile(0.018, 0.005), M['leather2'], closed_path=True))
        straps.append(rounded_box('Buckle', (x0 + sign * 0.073, 0.022, z + 0.008), (0.006, 0.026, 0.024), M['brass'],
                                  bevel=0.002, segments=1))
    st = join(straps, pre + 'BootStraps')
    part(st, bones=[pre + 'Leg', pre + 'Foot'], bias={pre + 'Leg': 2.0})


# ------------------------------------------------------------------------------------- belt + gear

BELT_RX, BELT_RY, BELT_Z, BELT_YC = 0.190, 0.150, 1.00, 0.012


def belt_frame(t, rx=BELT_RX, ry=BELT_RY):
    p = V((math.cos(t) * rx, BELT_YC + math.sin(t) * ry, BELT_Z))
    n = V((math.cos(t) / rx, math.sin(t) / ry, 0)).normalized()
    tg = V((-math.sin(t) * rx, math.cos(t) * ry, 0)).normalized()
    return p, n, tg


def build_belt():
    objs = []
    path = [V((math.cos(a) * BELT_RX, BELT_YC + math.sin(a) * BELT_RY, BELT_Z)) for a in
            [2 * math.pi * k / 48 for k in range(48)]]
    objs.append(sweep('Belt', path, rect_profile(0.052, 0.008, 0.002), M['leather'], closed_path=True))
    objs.append(rounded_box('BuckleB', (0, BELT_YC - BELT_RY - 0.006, BELT_Z), (0.064, 0.010, 0.06), M['brass'],
                            bevel=0.004))
    objs.append(rounded_box('BuckleC', (0, BELT_YC - BELT_RY - 0.011, BELT_Z), (0.036, 0.006, 0.032),
                            M['steel'], bevel=0.003))
    # slung second belt
    path2 = [V((math.cos(a) * 0.205, BELT_YC + math.sin(a) * 0.165, 0.945 + 0.04 * math.cos(a)))
             for a in [2 * math.pi * k / 40 for k in range(40)]]
    objs.append(sweep('Belt2', path2, rect_profile(0.038, 0.007, 0.002), M['leather2'], closed_path=True))
    # sash (player colour) under the belt
    path3 = [V((math.cos(a) * 0.184, BELT_YC + math.sin(a) * 0.144, 1.005 + 0.006 * math.sin(a * 3)))
             for a in [2 * math.pi * k / 40 for k in range(40)]]
    sash = sweep('Sash', path3, [(-0.05, 0), (0, 0.006), (0.05, 0), (0, -0.002)], M['tint'], closed_path=True,
                 scale_fn=lambda i, f: (1 + 0.15 * math.sin(i * 1.7), 1 + 0.5 * math.sin(i * 2.3)))
    sash_tail = sweep('SashTail', catmull([(-0.13, -0.10, 1.0), (-0.155, -0.12, 0.93), (-0.165, -0.13, 0.84),
                                           (-0.17, -0.135, 0.76)], 3), rect_profile(0.008, 0.06, 0.003),
                      M['tint'], up_fn=lambda i: V((-0.6, -1, 0)), twist_fn=lambda i, f: 0.3 * math.sin(f * 5))
    part(join([sash, sash_tail], 'Sash'), bones=['Hips', 'RightUpLeg'], bias={'Hips': 4.0})

    def pouch(t, size, mat, flap_mat, z=BELT_Z, out=0.0):
        p, n, tg = belt_frame(t)
        R = Matrix((tg, n, V((0, 0, 1)))).transposed()
        c = p + n * (size[1] / 2 + 0.006 + out) + V((0, 0, z - BELT_Z))
        res = [rounded_box('Pouch', c, size, mat, bevel=0.012, segments=2, rot=R)]
        fc = c + n * (size[1] / 2 - 0.004) + V((0, 0, size[2] * 0.28))
        res.append(rounded_box('Flap', fc, (size[0] * 1.04, 0.012, size[2] * 0.5), flap_mat, bevel=0.005,
                               segments=2, rot=R @ Matrix.Rotation(math.radians(-6), 3, 'X')))
        sn = fc + n * 0.007 + V((0, 0, -size[2] * 0.15))
        res.append(cylinder('Snap', sn, sn + n * 0.005, 0.007, M['brass'], n=8))
        return res

    objs += pouch(-1.05, (0.085, 0.045, 0.095), M['canvas'], M['leather2'])
    objs += pouch(-0.25, (0.07, 0.05, 0.11), M['leather'], M['leather'])
    objs += pouch(-2.05, (0.085, 0.045, 0.095), M['canvas'], M['leather2'])
    objs += pouch(2.0, (0.10, 0.05, 0.08), M['canvas'], M['canvas'])
    # canteen on the right back hip, hanging from belt2
    p, n, tg = belt_frame(2.75, 0.205, 0.165)
    R = Matrix((tg, n, V((0, 0, 1)))).transposed()
    cc = p + n * 0.045 + V((0, 0, -0.10))
    can = []
    can.append(rounded_box('Canteen', cc, (0.12, 0.05, 0.15), M['brass'], bevel=0.022, segments=3, rot=R))
    can.append(rounded_box('CanteenWrap', cc + V((0, 0, -0.02)), (0.125, 0.054, 0.07), M['canvas'], bevel=0.02,
                            segments=2, rot=R))
    can.append(cylinder('CanteenNeck', cc + V((0, 0, 0.074)), cc + V((0, 0, 0.098)), 0.012, M['steel'], n=10))
    GEAR['GearCanteen'].append(part(join(can, 'HipCanteen'), rigid='Hips'))
    # holstered tool (right hip): salvaged cutter / scanner
    p, n, tg = belt_frame(3.35, 0.205, 0.165)
    hc = p + n * 0.03 + V((0, 0, -0.13))
    objs.append(rounded_box('Holster', hc, (0.05, 0.035, 0.17), M['leather'], bevel=0.012,
                            rot=Matrix((tg, n, V((0, 0, 1)))).transposed()))
    tool = [cylinder('ToolBody', hc + V((0, 0, 0.07)), hc + V((0, 0, 0.16)), 0.017, M['steel'], n=10,
                         rings_extra=[(0.3, 1.15), (0.4, 1.15), (0.45, 1.0)]),
            cylinder('ToolGrip', hc + V((0, 0, 0.15)) + n * 0.0, hc + V((0, 0, 0.15)) + n * 0.06 + V((0, 0, 0.02)),
                     0.013, M['wood'], n=8)]
    GEAR['GearSidearm'].append(part(join(tool, 'Sidearm'), rigid='Hips'))
    gear = join(objs, 'BeltGear')
    part(gear, rigid='Hips')
    # hanging vacuum-tube trinket on the left hip
    p, n, tg = belt_frame(-0.65)
    tc = p + n * 0.02 + V((0, 0, -0.085))
    cage = [cylinder('TubeCapB', tc + V((0, 0, -0.03)), tc + V((0, 0, -0.022)), 0.016, M['brass'], n=10),
            cylinder('TubeCapT', tc + V((0, 0, 0.025)), tc + V((0, 0, 0.034)), 0.016, M['brass'], n=10)]
    for k in range(3):
        a_ = 2 * math.pi * k / 3
        o = V((math.cos(a_) * 0.015, math.sin(a_) * 0.015, 0))
        cage.append(cylinder('Bar', tc + o + V((0, 0, -0.025)), tc + o + V((0, 0, 0.03)), 0.0018, M['brass'], n=4))
    cage.append(sweep('Chain', [tc + V((0, 0, 0.034)), p + n * 0.012 + V((0, 0, -0.03))], circle_profile(0.002, 4),
                      M['steel']))
    part(join(cage, 'TubeCage'), rigid='Hips')
    glass = cylinder('TubeGlass', tc + V((0, 0, -0.022)), tc + V((0, 0, 0.025)), 0.010, M['lens'], n=10,
                     rings_extra=[(0.85, 0.9), (0.97, 0.5)])
    return glass


def env_front(x, z, table, off=0.012):
    zs, rxs, rys = table
    for i in range(len(zs) - 1):
        if zs[i] >= z >= zs[i + 1]:
            f = (zs[i] - z) / (zs[i] - zs[i + 1])
            rx = rxs[i] + (rxs[i + 1] - rxs[i]) * f
            ry = rys[i] + (rys[i + 1] - rys[i]) * f
            return -ry * math.sqrt(max(0.0, 1 - (x / rx) ** 2)) * 1.04 - off
    return -0.2




def build_straps():
    objs = []
    for s in (1, -1):
        ctrl = [V((s * 0.115, 0.215, 1.47)), V((s * 0.12, 0.12, 1.545)), V((s * 0.12, 0.03, 1.565))]
        for z in (1.53, 1.47, 1.40, 1.33, 1.25):
            x = s * (0.12 + 0.01 * (1.53 - z))
            ctrl.append(V((x, env_front(x, z, CAPE_T), z)))
        path = catmull(ctrl, 3)
        objs.append(sweep('PackStrap', path, rect_profile(0.008, 0.05, 0.002), M['leather2'],
                          up_fn=lambda i, path=path: V((path[i].x * 2.5, path[i].y - 0.005, path[i].z - 1.38))))
        bz = 1.36
        bx = s * (0.12 + 0.01 * (1.53 - bz))
        objs.append(rounded_box('StrapBuckle', (bx, env_front(bx, bz, CAPE_T, 0.02), bz), (0.056, 0.012, 0.03),
                                M['brass'], bevel=0.003, rot=Matrix.Rotation(math.radians(-14), 3, 'X')))
    # sternum strap
    z = 1.40
    pts = [V((x, env_front(x, z, CAPE_T, 0.018), z)) for x in [0.125 - 0.25 * k / 8 for k in range(9)]]
    objs.append(sweep('Sternum', pts, rect_profile(0.025, 0.006), M['leather'], up=V((0, 0, 1))))
    st = join(objs, 'Straps')
    GEAR['GearBack'].append(st)
    part(st, bones=['Spine1', 'Spine2', 'LeftShoulder', 'RightShoulder'], bias={'Spine2': 2.5}, power=3)
    # chest pressure gauge on the left strap (the hose ends here)
    gx, gz = 0.125, 1.33
    gy = env_front(gx, gz, CAPE_T, 0.025)
    gc = V((gx, gy, gz))
    gd = V((0.15, -1, 0.25)).normalized()
    g = [cylinder('Gauge', gc, gc + gd * 0.022, 0.029, M['brass'], n=16, rings_extra=[(0.8, 1.0), (0.9, 0.9)]),
         cylinder('GaugeFace', gc + gd * 0.019, gc + gd * 0.023, 0.023, M['steel'], n=16)]
    GEAR['GearBack'].append(part(join(g, 'Gauge'), rigid='Spine2'))


def build_backpack():
    objs = []
    lens = []
    bag_c = V((0, 0.315, 1.21))
    bag = rounded_box('Bag', bag_c, (0.30, 0.17, 0.38), M['canvas'], bevel=0.05, segments=3)
    for v in bag.data.vertices:  # soft, saggy canvas
        v.co += V((0, 0.012, 0)) * fbm(v.co * 9) + V((0, 0, -0.008)) * max(0, (v.co.z - 1.2) * 4)
    objs.append(bag)
    objs.append(rounded_box('BagFlap', bag_c + V((0, 0.01, 0.17)), (0.315, 0.185, 0.07), M['leather'], bevel=0.025,
                            segments=2))
    objs.append(rounded_box('BagPocket', bag_c + V((0, 0.092, -0.06)), (0.2, 0.05, 0.16), M['canvas'], bevel=0.02,
                            segments=2))
    for x in (-0.085, 0.085):
        objs.append(rounded_box('BagStrapV', bag_c + V((x, 0.09, 0.05)), (0.03, 0.012, 0.30), M['leather2'],
                                bevel=0.003, segments=1))
        objs.append(rounded_box('BagBuckle', bag_c + V((x, 0.098, -0.02)), (0.036, 0.008, 0.03), M['brass'],
                                bevel=0.003, segments=1))
    # tubular frame
    for x in (-0.165, 0.165):
        fp = catmull([(x, 0.225, 0.97), (x, 0.222, 1.15), (x, 0.226, 1.40), (x, 0.25, 1.52), (x, 0.31, 1.565)], 3)
        objs.append(sweep('FrameRail', fp, circle_profile(0.011, 8), M['steel']))
    for z in (1.0, 1.48):
        objs.append(cylinder('FrameBar', (-0.165, 0.228, z), (0.165, 0.228, z), 0.009, M['steel'], n=8))
    # bedroll
    objs.append(cylinder('Bedroll', (-0.235, 0.30, 1.52), (0.235, 0.30, 1.52), 0.072, M['cape'], n=16,
                         rings_extra=[(0.02, 0.85), (0.3, 1.04), (0.7, 1.03), (0.98, 0.86)]))
    for x in (-0.13, 0.13):
        objs.append(cylinder('RollStrap', (x - 0.013, 0.30, 1.52), (x + 0.013, 0.30, 1.52), 0.076, M['leather2'],
                             n=16))
    # side tank (right)
    tc = V((-0.215, 0.30, 1.04))
    objs.append(cylinder('Tank', tc, tc + V((0, 0, 0.32)), 0.055, M['brass'], n=16,
                         rings_extra=[(0.03, 1.0), (0.05, 1.06), (0.1, 1.06), (0.12, 1.0), (0.85, 1.0), (0.95, 0.75)]))
    objs.append(cylinder('TankValve', tc + V((0, 0, 0.32)), tc + V((0, 0, 0.36)), 0.013, M['steel'], n=8))
    wheel = [tc + V((math.cos(a) * 0.024, math.sin(a) * 0.024, 0.365)) for a in [2 * math.pi * k / 12 for k in range(12)]]
    objs.append(sweep('ValveWheel', wheel, circle_profile(0.004, 5), M['paint'], closed_path=True))
    for z in (0.08, 0.25):
        objs.append(cylinder('TankBand', tc + V((0, 0, z)), tc + V((0, 0, z + 0.02)), 0.058, M['leather2'], n=16))
    pipe = catmull([tc + V((0.0, -0.05, 0.25)), tc + V((0.05, -0.08, 0.3)), V((-0.12, 0.23, 1.42))], 4)
    objs.append(sweep('TankPipe', pipe, circle_profile(0.006, 6), M['brass']))
    # gizmo box (left) with vacuum tubes and an antenna
    gc = V((0.205, 0.31, 1.18))
    objs.append(rounded_box('Gizmo', gc, (0.07, 0.13, 0.17), M['paint'], bevel=0.008, segments=2))
    objs.append(rounded_box('GizmoPlate', gc + V((0.036, 0, 0.0)), (0.006, 0.10, 0.12), M['brass'], bevel=0.003,
                            segments=1))
    for k, dy in enumerate((-0.03, 0.03)):
        cb = gc + V((0.0, dy, 0.085))
        objs.append(cylinder('TubeSock', cb, cb + V((0, 0, 0.012)), 0.014, M['brass'], n=10))
        lens.append(cylinder('PackTube', cb + V((0, 0, 0.012)), cb + V((0, 0, 0.055)), 0.0095, M['lens'], n=10,
                             rings_extra=[(0.85, 0.9), (0.97, 0.45)]))
        for j in range(3):
            a = 2 * math.pi * j / 3 + 0.4
            o = V((math.cos(a) * 0.013, math.sin(a) * 0.013, 0))
            objs.append(cylinder('TubeBar', cb + o + V((0, 0, 0.01)), cb + o + V((0, 0, 0.058)), 0.0016, M['brass'], n=4))
    for k in range(2):
        dc = gc + V((0.04, -0.03 + 0.06 * k, -0.045))
        objs.append(cylinder('Dial', dc, dc + V((0.012, 0, 0)), 0.011, M['steel'], n=10))
    ant = catmull([gc + V((0.0, 0.04, 0.085)), gc + V((0.01, 0.05, 0.35)), gc + V((0.025, 0.07, 0.62)),
                   gc + V((0.04, 0.10, 0.76))], 3)
    objs.append(sweep('Antenna', ant, circle_profile(0.004, 5), M['steel'],
                      scale_fn=lambda i, f: (1 - 0.5 * f, 1 - 0.5 * f)))
    objs.append(cylinder('AntTip', ant[-1], ant[-1] + V((0.003, 0.004, 0.012)), 0.007, M['brass'], n=6))
    # coiled cable on the gizmo side
    coil = []
    for k in range(48):
        a = 2 * math.pi * k / 16
        coil.append(gc + V((0.03 + 0.012 * math.cos(a) * 0, -0.06 + 0.035 * math.cos(a), -0.15 + 0.035 * math.sin(a)))
                    + V((0.006 * k / 16, 0, 0)))
    objs.append(sweep('Coil', coil, circle_profile(0.0045, 5), M['rubber']))
    # dented scrap plate hanging on the right
    sp = rounded_box('Scrap', V((-0.12, 0.41, 1.03)), (0.15, 0.008, 0.11), M['paint'], bevel=0.004, segments=1,
                     rot=Matrix.Rotation(math.radians(12), 3, 'Y'))
    GEAR['GearScrap'].append(part(join([sp], 'ScrapPlate'), rigid='Spine2'))
    # shovel strapped diagonally, blade up behind the left shoulder
    shovel = []
    h0, h1 = V((-0.17, 0.425, 0.98)), V((0.16, 0.425, 1.50))
    hd = (h1 - h0).normalized()
    shovel.append(cylinder('ShovelHandle', h0, h1, 0.0145, M['wood'], n=8))
    shovel.append(cylinder('ShovelGrip', h0 - hd * 0.02, h0 + hd * 0.08, 0.017, M['leather'], n=8))
    blade_c = h1 + hd * 0.11
    bx = hd.cross(V((0, 1, 0))).normalized()
    Rb = Matrix((bx, V((0, 1, 0)), hd)).transposed()
    blade = rounded_box('ShovelBlade', blade_c, (0.15, 0.006, 0.20), M['steel'], bevel=0.003, segments=1, rot=Rb)
    for v in blade.data.vertices:  # dish the blade and taper the tip
        lc = Rb.transposed() @ (v.co - blade_c)
        lc.y -= 0.025 * (1 - (lc.x / 0.075) ** 2)
        lc.x *= 1 - 0.35 * max(0.0, lc.z / 0.1) ** 2
        v.co = blade_c + Rb @ lc
    shovel.append(blade)
    shovel.append(cylinder('ShovelSocket', h1 - hd * 0.03, h1 + hd * 0.02, 0.019, M['steel'], n=8))
    for z in (1.14, 1.34):
        f = (z - h0.z) / (h1.z - h0.z)
        c = h0.lerp(h1, f)
        shovel.append(cylinder('ShovelStrap', c - hd * 0.012, c + hd * 0.012, 0.022, M['leather2'], n=8))
    GEAR['GearShovel'].append(part(join(shovel, 'Shovel'), rigid='Spine2'))
    pack = join(objs, 'Backpack')
    part(pack, rigid='Spine2')
    GEAR['GearBack'].append(pack)
    tubes = join(lens, 'PackTubes')
    GEAR['GearBack'].append(tubes)
    return tubes


# ====================================================================================== BUILD ALL

# ------------------------------------------------------------------------------ the look's other pieces
def goggle_cup(E, d, scale, objs, lenses):
    fr = frame_from(d, V((0, 0, 1)))

    def rr(t, r, n=16):
        return ring(E + d * t * scale, r * scale, r * scale, n, fr)
    objs.append(loft('GogCushion', [rr(-0.006, 0.024), rr(0.004, 0.0275), rr(0.012, 0.026)], M['leather']))
    objs.append(loft('GogCup', [rr(0.010, 0.0235), rr(0.024, 0.024), rr(0.028, 0.0258), rr(0.033, 0.0255),
                                rr(0.0345, 0.0235), rr(0.034, 0.0195), rr(0.027, 0.0192)], M['brass']))
    lenses.append(loft('GogLens', [rr(0.026, 0.0196), rr(0.0285, 0.013), rr(0.0295, 0.004)], M['lens'],
                       cap_end=True))


def goggle_strap(objs):
    path = []
    for k in range(25):
        ang = -math.pi / 2 + math.radians(58) + (2 * math.pi - math.radians(116)) * k / 24
        path.append(V((math.cos(ang) * 0.103, 0.008 + math.sin(ang) * 0.115, 1.68 + 0.006 * math.sin(ang))))
    objs.append(sweep('GogStrap', path, rect_profile(0.004, 0.022), M['leather2'], up=V((0, 0, 1))))


def build_monocle():
    """One big lens over the right eye on a strap, a leather patch over the other."""
    objs, lenses = [], []
    goggle_cup(V((-0.040, -0.098, 1.678)), V((-0.22, -1.0, 0.03)).normalized(), 1.3, objs, lenses)
    E = V((0.036, -0.096, 1.676))
    d = V((0.20, -1.0, 0.03)).normalized()
    fr = frame_from(d, V((0, 0, 1)))
    objs.append(loft('Patch', [ring(E + d * t, r, r * 0.85, 14, fr) for t, r in
                               ((-0.004, 0.024), (0.006, 0.026), (0.010, 0.02), (0.012, 0.004))], M['leather'],
                     cap_end=True))
    goggle_strap(objs)
    part(join(objs, 'Monocle'), rigid='Head')
    return join(lenses, 'MonocleLens')


def build_side_mask():
    """A lighter respirator: a short snout and one big filter canister on the left cheek, no hose."""
    objs = []
    base = V((0, -0.103, 1.603))
    d = V((0, -0.88, -0.47)).normalized()
    fr = frame_from(d, V((1, 0, 0)))
    prof = [(-0.004, 0.028), (0.010, 0.030), (0.016, 0.031), (0.026, 0.026), (0.030, 0.018), (0.028, 0.008)]
    objs.append(loft('RespSnout', [ring(base + d * t, r, r * 0.9, 14, fr) for t, r in prof], M['steel'],
                     cap_end=True))
    for k in (-1, 1):
        a = base + d * 0.03 + fr.col[0] * k * 0.007
        objs.append(rounded_box('Grille', a, (0.003, 0.004, 0.022), M['brass'], bevel=0.0,
                                rot=Matrix((fr.col[0], fr.col[2], fr.col[1])).transposed()))
    c = V((0.055, -0.090, 1.582))
    cd = V((0.75, -0.5, -0.42)).normalized()
    objs.append(cylinder('Canister', c, c + cd * 0.075, 0.027, M['paint'], n=14,
                         rings_extra=[(0.06, 1.0), (0.1, 1.07), (0.18, 1.07), (0.22, 1.0), (0.88, 1.0), (0.93, 0.85)]))
    objs.append(cylinder('CanCap', c + cd * 0.073, c + cd * 0.082, 0.02, M['brass'], n=12))
    part(join(objs, 'SideMask'), rigid='Head')


def build_round_specs():
    """Small round wire-rimmed lenses on a bridge, the arms running back under the wrap."""
    objs, lenses = [], []
    for s in (1, -1):
        E = V((s * 0.037, -0.112, 1.678))
        fr = frame_from(V((s * 0.12, -1.0, 0.02)).normalized(), V((0, 0, 1)))
        rim = [E + fr @ V((math.cos(a) * 0.021, math.sin(a) * 0.021, 0)) for a in [2 * math.pi * k / 20 for k in range(20)]]
        objs.append(sweep('SpecRim', rim, circle_profile(0.0026, 6), M['brass'], closed_path=True))
        lenses.append(loft('SpecLens', [ring(E + fr.col[2] * -0.001, 0.0195, 0.0195, 16, fr),
                                        ring(E + fr.col[2] * -0.003, 0.004, 0.004, 16, fr)], M['lens'], cap_end=True))
        arm = catmull([(s * 0.058, -0.108, 1.68), (s * 0.098, -0.06, 1.682), (s * 0.106, 0.0, 1.676)], 3)
        objs.append(sweep('SpecArm', arm, circle_profile(0.0022, 5), M['brass']))
    objs.append(sweep('SpecBridge', catmull([(0.016, -0.118, 1.68), (0, -0.124, 1.686), (-0.016, -0.118, 1.68)], 3),
                      circle_profile(0.0024, 5), M['brass']))
    part(join(objs, 'RoundSpecs'), rigid='Head')
    return join(lenses, 'SpecLenses')


def build_welder():
    """Boxy welding goggles: square steel cups with flat dark-glass fronts, a hinged bridge, a broad strap."""
    objs, lenses = [], []
    for s in (1, -1):
        rot = Matrix.Rotation(s * 0.2, 3, 'Z')
        c = V((s * 0.04, -0.112, 1.676))
        objs.append(rounded_box('WeldCup', c, (0.046, 0.03, 0.036), M['paint'], bevel=0.005, rot=rot))
        objs.append(rounded_box('WeldRim', c + rot @ V((0, -0.016, 0)), (0.05, 0.006, 0.04), M['steel'], bevel=0.002,
                                rot=rot))
        lenses.append(rounded_box('WeldGlass', c + rot @ V((0, -0.0195, 0)), (0.036, 0.003, 0.026), M['lens'],
                                  bevel=0.001, segments=1, rot=rot))
    objs.append(rounded_box('WeldHinge', (0, -0.124, 1.678), (0.016, 0.012, 0.012), M['brass'], bevel=0.002))
    goggle_strap(objs)
    part(join(objs, 'Welder'), rigid='Head')
    return join(lenses, 'WeldLenses')


def build_big_goggles():
    """Oversized goggles: the old cups a third bigger, set wider."""
    objs, lenses = [], []
    for s in (1, -1):
        goggle_cup(V((s * 0.044, -0.094, 1.678)), V((s * 0.26, -1.0, 0.03)).normalized(), 1.35, objs, lenses)
    objs.append(sweep('GogBridge', catmull([(0.016, -0.128, 1.68), (0, -0.132, 1.684), (-0.016, -0.128, 1.68)], 3),
                      circle_profile(0.004, 6), M['brass']))
    goggle_strap(objs)
    part(join(objs, 'BigGoggles'), rigid='Head')
    return join(lenses, 'BigLenses')


def face_cover(name, mat, half=70, extra=0.012, z0=1.545, z1=1.636):
    """A cover over the lower face, a little proud of the scarf mask (build_headwrap's FaceMask), under the goggles."""
    zs = [z0 + (z1 - z0) * k / 5 for k in range(6)]
    mr = ((1.535, 0.088), (1.565, 0.094), (1.60, 0.102), (1.635, 0.104), (1.652, 0.101))
    rings = []
    for z in zs:
        r = next(r0 + (r1 - r0) * (z - a) / (b - a) for (a, r0), (b, r1) in zip(mr, mr[1:]) if a <= z <= b + 1e-9) + extra

        def fn(t, k, z=z):
            front = max(0.0, -math.sin(t))
            return 1.0 + (0.08 * front ** 3 if z < 1.62 else 0.0)
        rings.append(ring((0, 0.006, z), r, r * 1.12, 17, fn=fn, a0=math.radians(270 - half),
                          a1=math.radians(270 + half), closed=False))
    return loft(name, rings, mat, closed=False)


def on_cover(t, z, half_out=0.0):
    """A point on face_cover's surface at angle t (rad, 270° = front) and height z, and its outward normal."""
    r = 0.098 + 0.012 + half_out
    front = max(0.0, -math.sin(t))
    m = 1.0 + (0.08 * front ** 3 if z < 1.62 else 0.0)
    p = V((math.cos(t) * r * m, 0.006 + math.sin(t) * r * 1.12 * m, z))
    n = V((math.cos(t), math.sin(t) * 1.12, 0)).normalized()
    return p, n


def build_filter_mask():
    """A cloth dust mask over nose and mouth, one round filter at the front."""
    objs = [face_cover('DustMask', M['canvas'], half=72)]
    p, n = on_cover(math.radians(270), 1.582)
    objs.append(cylinder('Filter', p - n * 0.004, p + n * 0.022, 0.026, M['paint'], n=16,
                         rings_extra=[(0.15, 1.0), (0.2, 0.92), (0.8, 0.92), (0.85, 1.0)]))
    objs.append(cylinder('FilterCap', p + n * 0.02, p + n * 0.026, 0.02, M['brass'], n=14))
    part(join(objs, 'FilterMask'), rigid='Head')


def build_muzzle():
    """A stitched leather muzzle over the lower face, rows of brass breathing rivets."""
    objs = [face_cover('Muzzle', M['leather'], half=78, extra=0.014)]
    for z in (1.565, 1.59, 1.615):
        for deg in range(246, 296, 12):
            p, n = on_cover(math.radians(deg), z, 0.002)
            objs.append(cylinder('Rivet', p - n * 0.002, p + n * 0.004, 0.0035, M['brass'], n=6))
    part(join(objs, 'MuzzleMask'), rigid='Head')


def build_grille():
    """A steel mouth plate with breathing slots."""
    objs = [face_cover('Grille', M['steel'], half=62, extra=0.014)]
    for z in (1.562, 1.578, 1.594, 1.61):
        p, n = on_cover(math.radians(270), z, 0.003)
        objs.append(rounded_box('Slot', p + n * 0.002, (0.058, 0.012, 0.008), M['rubber'], bevel=0.002, segments=1))
    for s in (1, -1):
        p, n = on_cover(math.radians(270 + s * 52), 1.59, 0.002)
        objs.append(cylinder('Bolt', p - n * 0.002, p + n * 0.006, 0.005, M['brass'], n=6))
    part(join(objs, 'GrillePlate'), rigid='Head')


def scarf_loops(specs, name='ScarfLoops'):
    """Loops of cloth round the neck: (height, tilt down at the front, radius x, radius y, width, phase)."""
    objs = []
    for zc, tilt, rx, ry, w, ph in specs:
        path = [V((math.cos(a) * rx, 0.004 + math.sin(a) * ry, zc + tilt * math.sin(a)))
                for a in [2 * math.pi * k / 36 for k in range(36)]]
        objs.append(sweep('ScarfLoop', path, [(-w / 2, 0.0), (-w / 4, 0.012), (0, 0.016), (w / 4, 0.012),
                                               (w / 2, 0.0), (w / 4, -0.006), (0, -0.007), (-w / 4, -0.006)],
                          M['tint'], closed_path=True, up=V((0, 0, 1)),
                          scale_fn=lambda i, f, ph=ph: (1 + 0.18 * math.sin(i * 1.3 + ph),
                                                        1 + 0.35 * math.sin(i * 0.9 + ph))))
    part(join(objs, name), bones=['Neck', 'Spine2', 'Head'], bias={'Neck': 2.0})


def scarf_tail(pts, width=0.085, name='ScarfTail', twist=0.25):
    tail = sweep(name, catmull(pts, 4), rect_profile(0.012, width, 0.004), M['tint'],
                 up_fn=lambda i: V((0, -1, 0.15)),
                 scale_fn=lambda i, f: (1.0, 0.85 + 0.25 * f + 0.06 * math.sin(i * 2.1)),
                 twist_fn=lambda i, f: twist * math.sin(f * 4))
    part(tail, bones=['Spine2', 'Spine1', 'Neck'], bias={'Spine2': 2.0})


SCARF_LOOPS = ((1.535, 0.05, 0.122, 0.128, 0.066, 0.0), (1.58, 0.04, 0.108, 0.118, 0.058, 1.7))


def build_scarf_long():
    """Wound twice, both ends hanging long down the chest."""
    scarf_loops(SCARF_LOOPS)
    scarf_tail([(0.035, -0.105, 1.545), (0.065, -0.17, 1.48), (0.10, -0.228, 1.39), (0.118, -0.25, 1.25),
                (0.125, -0.26, 1.10), (0.13, -0.262, 0.98)])
    scarf_tail([(-0.03, -0.11, 1.55), (-0.06, -0.18, 1.47), (-0.075, -0.236, 1.37), (-0.07, -0.252, 1.26),
                (-0.06, -0.258, 1.16)], width=0.075, name='ScarfTail2', twist=-0.3)


def build_bib():
    """Knotted at the neck, its point hanging over the chest like a bandana."""
    scarf_loops(SCARF_LOOPS[1:])
    rings = []
    for z, r, half in ((1.565, 0.112, 75), (1.52, 0.128, 62), (1.47, 0.142, 46), (1.42, 0.15, 28), (1.375, 0.153, 6)):
        rings.append(ring((0, 0.004, z), r, r * 1.04, 15, a0=math.radians(270 - half), a1=math.radians(270 + half),
                          closed=False, fn=lambda t, k, z=z: 1 + 0.03 * math.sin(t * 9 + z * 50)))
    tattered(rings[-1], 0.01, seed=5.0)
    part(loft('Bib', rings, M['tint'], closed=False), bones=['Spine2', 'Neck'], bias={'Spine2': 2.0})


def build_veil():
    """The scarf's end pulled up over the head wrap, hanging as a veil across the face under the goggles."""
    scarf_loops(SCARF_LOOPS)
    rings = []
    for z, r, half, fwd in ((1.66, 0.104, 80, 0.0), (1.62, 0.112, 78, 0.006), (1.575, 0.124, 74, 0.016),
                            (1.53, 0.134, 68, 0.024), (1.49, 0.14, 60, 0.03)):
        rings.append(ring((0, 0.004 - fwd, z), r, r * 1.12, 17, a0=math.radians(270 - half),
                          a1=math.radians(270 + half), closed=False,
                          fn=lambda t, k, z=z: 1 + 0.025 * math.sin(t * 11 + z * 60)))
    tattered(rings[-1], 0.012, seed=8.0)
    part(loft('Veil', rings, M['tint'], closed=False), bones=['Head', 'Neck'], bias={'Head': 2.5})


def build_shoulder_plate():
    """Scrap pauldron on the left shoulder: a domed cap and two overlapping bands down the upper arm."""
    fr = frame_from(UPPER_DIR, V((0, 1, 0)))
    objs = []
    for t0, t1, r in ((0.02, 0.075, 0.094), (0.065, 0.12, 0.088)):
        objs.append(loft('PlateBand', [ring(SH_L + UPPER_DIR * t0, r, r * 0.95, 20, fr),
                                       ring(SH_L + UPPER_DIR * t1, r * 0.97, r * 0.92, 20, fr),
                                       ring(SH_L + UPPER_DIR * t1, r * 0.9, r * 0.86, 20, fr)], M['paint']))
    cap = []
    for k in range(6):
        a = math.radians(90 * k / 5)
        rr = 0.105 * math.cos(a) + 0.003
        cap.append(ring(SH_L + V((0.0, 0.0, 0.01 + 0.05 * math.sin(a))), rr, rr * 0.92, 20))
    objs.append(loft('PlateCap', cap, M['steel'], cap_end=True))
    for o in objs:
        part(o, bones=['LeftArm', 'LeftShoulder'], bias={'LeftArm': 1.6}, power=4.0)


def in_cloth(fn):
    """fn built in the wrap cloth where it had leather (wrapped gloves, wrapped boots)."""
    def g(*args):
        saved = {k: M[k] for k in ('leather', 'leather2')}
        M['leather'] = M['leather2'] = M['wrap']
        try:
            fn(*args)
        finally:
            M.update(saved)
    return g


def build_gauntlet(sign):
    """Over the glove: a flared leather cuff up the forearm and a steel plate on the back of the hand."""
    pre = 'Left' if sign > 0 else 'Right'
    W = V((WR_L.x * sign, WR_L.y, WR_L.z))
    a, pn, t = hand_frame(sign)
    fr = Matrix((t, pn, a)).transposed()

    def P(u, v, w):
        return W + t * u + pn * v + a * w
    cuff = [ring(P(0, 0, w), r, r * 0.92, 18, fr) for w, r in
            ((-0.03, 0.054), (-0.07, 0.060), (-0.11, 0.066), (-0.135, 0.071), (-0.14, 0.064))]
    part(loft(pre + 'Cuff', cuff, M['leather2']), bones=[pre + 'ForeArm', pre + 'Hand'], bias={pre + 'ForeArm': 2.0})
    part(rounded_box('HandPlate', P(0, -0.028, 0.045), (0.062, 0.007, 0.052), M['steel'], bevel=0.003, segments=1,
                     rot=fr), rigid=pre + 'Hand')


def build_boot_top(sign):
    """The boot carried on up to below the knee, with a turned-down cuff."""
    x0 = 0.106 * sign
    rings = [ring((x0, 0.022, z), r, r * 1.08, 16,
                  fn=lambda a_, k, z=z: 1 + 0.025 * fbm((math.cos(a_) * 3, math.sin(a_) * 3, z * 20)))
             for z, r in ((0.30, 0.071), (0.36, 0.074), (0.42, 0.077), (0.455, 0.08), (0.47, 0.088), (0.475, 0.09),
                          (0.44, 0.088), (0.43, 0.08))]
    part(loft(('Left' if sign > 0 else 'Right') + 'BootTop', rings, M['leather']), rigid=('Left' if sign > 0 else 'Right') + 'Leg')


def build_shin_guard(sign):
    """A curved steel plate strapped over the front of the shin."""
    x0 = 0.106 * sign
    rings = [ring((x0, 0.016, z), r, r * 1.1, 14, a0=math.radians(205), a1=math.radians(335), closed=False)
             for z, r in ((0.17, 0.074), (0.25, 0.077), (0.34, 0.08), (0.42, 0.083), (0.46, 0.081))]
    part(loft(('Left' if sign > 0 else 'Right') + 'ShinGuard', rings, M['paint'], closed=False),
         rigid=('Left' if sign > 0 else 'Right') + 'Leg')


def both(fn):
    def g():
        fn(1)
        fn(-1)
    return g


def build_character():
    build_torso()
    build_skirt(1)
    build_skirt(-1)
    build_headwrap()
    lens_objs = []
    # the look (shared/look.ts): every option of every slot, each its own mesh
    tagged('Cape', build_cape)
    tagged('Poncho', build_cape, PONCHO_T, 'Poncho')
    tagged('Hood', build_hood)
    tagged('Cowl', build_hood, 0.82, 0.035, 0.11, 0.3, 0.0, 'Cowl')
    tagged('HoodRagged', build_hood, 0.81, 0.0, 0.0, 0.25, 0.03, 'HoodRagged')
    lens = tagged('Goggles', build_goggles)
    lens_objs.append((lens, 'Head'))
    LOOK['Goggles'].append(lens)
    lens = tagged('Monocle', build_monocle)
    lens_objs.append((lens, 'Head'))
    LOOK['Monocle'].append(lens)
    for group, fn in (('RoundSpecs', build_round_specs), ('Welder', build_welder), ('BigGoggles', build_big_goggles)):
        lens = tagged(group, fn)
        lens_objs.append((lens, 'Head'))
        LOOK[group].append(lens)
    tagged('Respirator', build_respirator)
    tagged('FilterMask', build_filter_mask)
    tagged('MuzzleMask', build_muzzle)
    tagged('GrillePlate', build_grille)
    tagged('SideMask', build_side_mask)
    tagged('Scarf', build_scarf)
    tagged('ScarfLong', build_scarf_long)
    tagged('Bib', build_bib)
    tagged('Veil', build_veil)
    tagged('ShoulderPlate', build_shoulder_plate)
    tagged('Gloves', both(build_glove))
    tagged('GlovesWrapped', both(in_cloth(build_glove)))
    tagged('Gauntlets', both(build_gauntlet))
    tagged('Boots', both(build_boot))
    tagged('BootsWrapped', both(in_cloth(build_boot)))
    tagged('ShinGuards', both(build_shin_guard))
    tagged('BootTops', both(build_boot_top))
    for s in (1, -1):
        build_sleeve(s)
        build_leg(s)
    lens_objs.append((build_belt(), 'Hips'))
    build_straps()
    lens_objs.append((build_backpack(), 'Spine2'))

    # weights
    for obj, spec in PARTS:
        apply_weights(obj, spec)

    # lens objects: rigid on the head (goggles, monocle), hips (hip tube), chest (pack tubes)
    for lo, bone in lens_objs:
        apply_weights(lo, dict(bones=None, rigid=bone, fn=None, bias={}, power=4))

    # tag the gear's and the look's vertices, to split them off after the joins (main)
    for group, objs in list(GEAR.items()) + [('Look' + k, v) for k, v in LOOK.items()]:
        for o in objs:
            o.vertex_groups.new(name=group).add(list(range(len(o.data.vertices))), 1.0, 'REPLACE')

    body_parts = [o for o, _ in PARTS]
    total = sum(tri_count(o) for o in body_parts) + sum(tri_count(o) for o, _ in lens_objs)
    print('TRIS', total, {o.name: tri_count(o) for o in body_parts})

    body = join(body_parts, 'Scavenger_Body')
    lens = join([o for o, _ in lens_objs], 'Scavenger_Lens')

    return body, lens


# ========================================================================================= RIG

RIG = None


def make_rig(meshes, name='Scavenger', bones=None):
    global RIG
    bones = bones or B
    arm_data = bpy.data.armatures.new('ScavengerRig')
    rig = bpy.data.objects.new(name, arm_data)
    link(rig)
    select_only([rig])
    bpy.ops.object.mode_set(mode='EDIT')
    for name, (h, t, parent) in bones.items():
        eb = arm_data.edit_bones.new(name)
        eb.head, eb.tail = V(h), V(t)
    for name, (h, t, parent) in bones.items():
        eb = arm_data.edit_bones[name]
        if parent:
            eb.parent = arm_data.edit_bones[parent]
            eb.use_connect = (V(arm_data.edit_bones[parent].tail) - V(h)).length < 1e-4
        d = (V(t) - V(h)).normalized()
        if 'Foot' in name or 'Toe' in name:
            eb.align_roll(V((0, 0, 1)))
        elif 'Hand' in name and 'Hand' != name[-4:]:
            eb.align_roll(V((0, 0, 1)))
        else:
            eb.align_roll(V((0, -1, 0)) if abs(d.y) < 0.9 else V((0, 0, 1)))
    bpy.ops.object.mode_set(mode='OBJECT')

    for o in meshes:
        o.parent = rig
        mod = o.modifiers.new('Armature', 'ARMATURE')
        mod.object = rig

    RIG = rig
    return rig


# ===================================================================================== ANIMATION

FPS = 30
bpy.context.scene.render.fps = FPS
X, Y, Z = V((1, 0, 0)), V((0, 1, 0)), V((0, 0, 1))


def rot(*pairs):
    """Compose armature-space rotations [(axis, degrees), ...] applied in order."""
    q = Quaternion()
    for axis, deg in pairs:
        q = Quaternion(axis, math.radians(deg)) @ q
    return q


def key_pose(frame, pose, hips=(0, 0, 0)):
    rig = RIG
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        R = pb.bone.matrix_local.to_quaternion()
        q = pose.get(pb.name, Quaternion())
        pb.rotation_quaternion = R.inverted() @ q @ R
        pb.keyframe_insert('rotation_quaternion', frame=frame)
    hp = rig.pose.bones.get('Hips')
    if hp is None:
        return
    hp.location = hp.bone.matrix_local.to_3x3().inverted() @ V(hips)
    hp.keyframe_insert('location', frame=frame)


def arms_down(pose, l_down=18, r_down=18, l_swing=0, r_swing=0, l_elbow=12, r_elbow=12, l_out=0.0, r_out=0.0):
    pose['LeftArm'] = rot((Y, l_down), (X, -l_swing), (Z, l_out))
    pose['RightArm'] = rot((Y, -r_down), (X, -r_swing), (Z, -r_out))
    pose['LeftForeArm'] = rot((X, -l_elbow))
    pose['RightForeArm'] = rot((X, -r_elbow))
    pose['LeftHandIndex1'] = rot((V(hand_frame(1)[2]), -15))
    pose['LeftHandIndex2'] = rot((V(hand_frame(1)[2]), -15))
    pose['RightHandIndex1'] = rot((V(hand_frame(-1)[2]), 15))
    pose['RightHandIndex2'] = rot((V(hand_frame(-1)[2]), 15))


def legs(pose, lt, lk, lf, rt, rk, rf, l_out=0.0, r_out=0.0):
    """Thigh forward angle (deg, + = forward), knee flex (+ = bend), foot (+ = toes down),
    thigh spread (deg, + = away from the other leg; the foot rolls back so the sole stays flat)."""
    pose['LeftUpLeg'] = rot((X, -lt), (Y, -l_out))
    pose['RightUpLeg'] = rot((X, -rt), (Y, r_out))
    pose['LeftLeg'] = rot((X, lk))
    pose['RightLeg'] = rot((X, rk))
    pose['LeftFoot'] = rot((X, lf), (Y, l_out))
    pose['RightFoot'] = rot((X, rf), (Y, -r_out))


def pos(x):
    return max(0.0, x)


def clip(name, frames, fn):
    rig = RIG
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    rig.animation_data_create()
    rig.animation_data.action = act
    for f in range(frames + 1):
        p = (f % frames) / frames
        pose, hips = fn(p)
        key_pose(f, pose, hips)
    track = rig.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 0, act)
    track.mute = True
    rig.animation_data.action = None
    return act


def idle(p):
    w = 2 * math.pi * p
    br = math.sin(w * 2)  # two breaths per loop (3 s)
    pose = {
        'Spine': rot((X, 2 + 0.5 * br), (Y, 1.5 * math.sin(w))),
        'Spine1': rot((X, 1.0 * br)),
        'Spine2': rot((X, -1.0 * br)),
        'Neck': rot((X, 3), (Z, 6 * math.sin(w + 0.6))),
        'Head': rot((X, 2 + 2 * math.sin(w * 2 + 1)), (Z, 8 * math.sin(w + 0.3))),
    }
    arms_down(pose, 17 + 1.5 * br, 18 - 1.5 * br, l_elbow=14, r_elbow=12, l_swing=3, r_swing=-2)
    legs(pose, 3, 4, -1, -2, 2, 0, l_out=2.5, r_out=3)
    # Legs are FK, so the pelvis must stay put or the feet skate: no hip roll/yaw, only the breathing dip.
    return pose, (0, 0, -0.006 + 0.003 * br)


def walk(p):
    w = 2 * math.pi * p
    c, s = math.cos(w), math.sin(w)
    lt, rt = 24 * c, -24 * c
    lk = 6 + 52 * pos(-s) ** 1.3 + 14 * pos(math.sin(2 * w)) * (w < math.pi)
    rk = 6 + 52 * pos(s) ** 1.3 + 14 * pos(math.sin(2 * w - 2 * math.pi)) * (w >= math.pi)
    lf = -lt * 0.4 + 18 * pos(-math.sin(w - 0.6)) * pos(-c) - 10 * pos(c) * 0.5
    rf = -rt * 0.4 + 18 * pos(math.sin(w - 0.6)) * pos(c) - 10 * pos(-c) * 0.5
    pose = {'Hips': rot((Z, -6 * c), (Y, 2.5 * math.sin(2 * w))),
            'Spine': rot((X, 4), (Z, 3 * c)), 'Spine1': rot((Z, 3 * c)), 'Spine2': rot((Z, 2 * c), (X, 2)),
            'Neck': rot((X, -2)), 'Head': rot((Z, -2 * c), (X, 1))}
    legs(pose, lt, lk, lf, rt, rk, rf, l_out=2, r_out=2)
    arms_down(pose, 19, 19, l_swing=-20 * c, r_swing=20 * c, l_elbow=16 + 10 * pos(-c), r_elbow=16 + 10 * pos(c))
    return pose, (0, 0, -0.025 - 0.018 * math.cos(2 * w))


def run(p):
    w = 2 * math.pi * p
    c, s = math.cos(w), math.sin(w)
    lt, rt = 12 + 42 * c, 12 - 42 * c
    # Heel kick peaks at ~90° knee flex (shin about level behind) with the thigh near vertical.
    lk = 22 + 68 * pos(-math.sin(w + 0.35)) ** 1.2 + 12 * pos(math.sin(w + 0.35))
    rk = 22 + 68 * pos(math.sin(w + 0.35)) ** 1.2 + 12 * pos(-math.sin(w + 0.35))
    lf = 10 + 25 * pos(-math.sin(w - 0.4)) - 12 * pos(c)
    rf = 10 + 25 * pos(math.sin(w - 0.4)) - 12 * pos(-c)
    pose = {'Hips': rot((X, 8), (Z, -9 * c)), 'Spine': rot((X, 6), (Z, 5 * c)), 'Spine1': rot((X, 2), (Z, 5 * c)),
            'Spine2': rot((Z, 3 * c)), 'Neck': rot((X, -8)), 'Head': rot((X, -4), (Z, -3 * c))}
    legs(pose, lt, lk, lf, rt, rk, rf, l_out=2.5, r_out=2.5)
    arms_down(pose, 22, 22, l_swing=-42 * c + 10, r_swing=42 * c + 10, l_elbow=75 + 15 * c, r_elbow=75 - 15 * c,
              l_out=-8, r_out=-8)
    return pose, (0, -0.04, -0.07 + 0.035 * math.cos(2 * w + 0.7))


def jump(p):
    w = 2 * math.pi * p
    s = math.sin(w)
    pose = {'Hips': rot((X, -6)), 'Spine': rot((X, 8 + s)), 'Spine1': rot((X, 4)), 'Neck': rot((X, -6)),
            'Head': rot((X, -4))}
    legs(pose, 55 + 3 * s, 85 + 4 * s, 25, 25 - 3 * s, 70 - 4 * s, 30, l_out=4, r_out=4)
    arms_down(pose, -15 + 4 * s, -15 - 4 * s, l_swing=25, r_swing=10, l_elbow=40, r_elbow=55, l_out=10, r_out=10)
    return pose, (0, 0, 0.12)


def dig(p):
    w = 2 * math.pi * p
    s, c = math.sin(w), math.cos(w)
    pose = {'Hips': rot((X, 12)), 'Spine': rot((X, 18 + 2 * s), (Z, 6 * s)), 'Spine1': rot((X, 14), (Z, 5 * s)),
            'Spine2': rot((X, 10)), 'Neck': rot((X, 8)), 'Head': rot((X, 14), (Z, -6 * s))}
    # kneel: left foot planted forward, right knee on the ground
    legs(pose, 82, 98, 6, -8, 98, -40, l_out=5, r_out=3)
    # alternating scooping: hand reaches forward-down then pulls sand back between the knees
    lr, rr = 0.5 + 0.5 * math.sin(w), 0.5 + 0.5 * math.sin(w + math.pi)
    arms_down(pose, 6, 6, l_swing=35 + 45 * lr, r_swing=35 + 45 * rr, l_elbow=40 - 30 * lr, r_elbow=40 - 30 * rr,
              l_out=-14, r_out=-14)
    pose['LeftHand'] = rot((X, -25 + 30 * lr))
    pose['RightHand'] = rot((X, -25 + 30 * rr))
    return pose, (0.0, 0.02, -0.47)


def slide(p):
    w = 2 * math.pi * p
    s = math.sin(w)
    pose = {'Hips': rot((Z, 28 + 3 * s), (X, 6)), 'Spine': rot((Z, -14), (X, 12 + 2 * s), (Y, 4 * s)),
            'Spine1': rot((Z, -10), (X, 6)), 'Spine2': rot((Z, -4)), 'Neck': rot((Z, -10), (X, -6)),
            'Head': rot((Z, -6 - 3 * s), (X, -4))}
    legs(pose, 48, 78 + 3 * s, 25, -6, 48 - 3 * s, 32, l_out=6, r_out=7)
    arms_down(pose, -38 + 6 * s, -32 - 6 * s, l_swing=18, r_swing=-10, l_elbow=30, r_elbow=24, l_out=-10, r_out=12)
    return pose, (0.03 * s, 0.0, -0.30 + 0.01 * math.sin(2 * w))


def crouch(p):
    """Ctrl held at a standstill/slow: knees bent, torso forward, arms ready."""
    w = 2 * math.pi * p
    br = math.sin(w * 2)
    pose = {'Hips': rot((X, 10)), 'Spine': rot((X, 10 + 0.5 * br)), 'Spine1': rot((X, 6)), 'Spine2': rot((X, 2)),
            'Neck': rot((X, -14)), 'Head': rot((X, -6 + 2 * math.sin(w * 2 + 1)), (Z, 5 * math.sin(w + 0.3)))}
    legs(pose, 52, 104, -14, 46, 98, -14, l_out=7, r_out=7)
    arms_down(pose, 20, 20, l_swing=14, r_swing=10, l_elbow=40, r_elbow=36)
    return pose, (0, 0, -0.33 + 0.003 * br)


def crouchwalk(p):
    w = 2 * math.pi * p
    c, s = math.cos(w), math.sin(w)
    lt, rt = 52 + 20 * c, 52 - 20 * c
    lk = 104 + 30 * pos(-s) ** 1.3
    rk = 98 + 30 * pos(s) ** 1.3
    lf = -14 - lt * 0.15 + 10 * pos(-s)
    rf = -14 - rt * 0.15 + 10 * pos(s)
    pose = {'Hips': rot((X, 10), (Z, -4 * c)), 'Spine': rot((X, 10), (Z, 3 * c)), 'Spine1': rot((X, 6), (Z, 2 * c)),
            'Spine2': rot((X, 2)), 'Neck': rot((X, -14)), 'Head': rot((X, -6), (Z, -2 * c))}
    legs(pose, lt, lk, lf, rt, rk, rf, l_out=7, r_out=7)
    arms_down(pose, 20, 20, l_swing=14 - 14 * c, r_swing=10 + 14 * c, l_elbow=40, r_elbow=36)
    return pose, (0, 0, -0.33 - 0.012 * math.cos(2 * w))


def powerslide(p):
    """Intentional (Ctrl) slide: lying back on the hips, one leg driven out forward, the other knee tucked,
    arms out for balance. The game tilts the whole body to the slope; this clip is the flat-ground pose."""
    w = 2 * math.pi * p
    s = math.sin(w)
    pose = {'Hips': rot((X, -12), (Z, 3 * s)), 'Spine': rot((X, -10), (Z, -4)), 'Spine1': rot((X, -6)),
            'Spine2': rot((X, -3)), 'Neck': rot((X, 14)), 'Head': rot((X, 8 + s), (Z, 2 * s))}
    legs(pose, 64, 6 + 2 * s, -22, 40, 118 + 3 * s, 38, l_out=4, r_out=14)
    arms_down(pose, -30 + 4 * s, -26 - 4 * s, l_swing=48, r_swing=30, l_elbow=28, r_elbow=40, l_out=22, r_out=26)
    return pose, (0.0, 0.0, -0.62 + 0.008 * math.sin(2 * w))


def split_group(obj, group, name):
    """Move the vertices in vertex group `group` of `obj` into a new mesh object `name`; drop the group."""
    select_only([obj], obj)
    obj.vertex_groups.active_index = obj.vertex_groups[group].index
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_mode(type='VERT')
    bpy.ops.mesh.select_all(action='DESELECT')
    bpy.ops.object.vertex_group_select()
    bpy.ops.mesh.separate(type='SELECTED')
    bpy.ops.object.mode_set(mode='OBJECT')
    new = next(o for o in bpy.context.selected_objects if o is not obj)
    new.name = new.data.name = name
    for o in (obj, new):
        o.vertex_groups.remove(o.vertex_groups[group])
    return new


def main():
    body, lens = build_character()
    rig = make_rig([body, lens])
    CLIPS = [('Idle', 90, idle), ('Walk', 34, walk), ('Run', 22, run), ('Jump', 30, jump), ('Dig', 48, dig),
             ('Slide', 40, slide), ('Powerslide', 40, powerslide),
             ('Crouch', 90, crouch), ('CrouchWalk', 34, crouchwalk)]
    for name, frames, fn in CLIPS:
        clip(name, frames, fn)

    # rest pose for previews/baking
    for pb in RIG.pose.bones:
        pb.rotation_quaternion = Quaternion()
        pb.location = V()

    if FAST:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_DIR, 'scavenger_fast.blend'))
        print('SAVED FAST')
        sys.exit(0)

    # =========================================================================================== BAKE
    import bake

    final = bake.bake_atlas(body, TEX, OUT_DIR, tint_name='Tint', dyes=('Robe', 'Cape', 'Wrap'))
    lens.data.uv_layers['Detail'].name = 'Atlas'
    lens.modifiers.clear()
    body.modifiers.clear()
    body = join([body, lens], 'Scavenger_Body')
    gear = [split_group(body, group, name) for group, name in list(GEAR_MESH.items()) + list(LOOK_MESH.items())]
    for m in [body, *gear]:
        mod = m.modifiers.new('Armature', 'ARMATURE')
        mod.object = rig
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_DIR, 'scavenger.blend'))
    bake.export(rig, [body, *gear], OUT_GLB)
    print('TRIS_FINAL', tri_count(body))


if __name__ == '__main__':
    main()
