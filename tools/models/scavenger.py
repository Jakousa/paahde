# Procedural "scavenger" player character: build → rig → skin → animate → bake PBR atlas → export GLB.
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/models/scavenger.py
#   ... -- --fast        skip baking (procedural materials, no export), save tools/models/out/scavenger_fast.blend
#   ... -- --tex 1024     atlas size (default 2048 baked, colour kept at 2048, normal/ORM downscaled to 1024)
#
# Output: public/models/scavenger.glb (one skinned mesh, materials Scavenger / PlayerTint / Lens,
# clips Idle, Walk, Run, Jump, Dig, Slide). Faces -Y in Blender = +Z in three.js.
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
    'robe': scmats.cloth('Robe', '#9c8a6e', '#6e5c46', dust=1.0, bleach='#c9b391', bleach_amt=0.45),
    'cape': scmats.cloth('Cape', '#6a4430', '#3a2418', dust=0.9, bleach='#8a6448', bleach_amt=0.3, wrinkle=0.6),
    'wrap': scmats.cloth('Wrap', '#7d705e', '#4a4035', dust=0.8, weave=0.7, wrinkle=0.3, bleach='#a39581', bleach_amt=0.3),
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


CAPE_T = ([1.585, 1.555, 1.525, 1.485, 1.435, 1.385, 1.335, 1.285],
          [0.078, 0.122, 0.185, 0.238, 0.266, 0.284, 0.296, 0.304],
          [0.073, 0.108, 0.140, 0.165, 0.180, 0.190, 0.198, 0.204])
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


def build_cape():
    zs, rx, ry = CAPE_T
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
    rings.append(fold_back(rings[-1], (0, 0.008), 0.975, 0.03))
    return part(loft('Cape', rings, M['cape']),
                bones=['Spine1', 'Spine2', 'Neck', 'LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm'],
                bias={'LeftArm': 0.35, 'RightArm': 0.35, 'Spine2': 1.5}, power=3.0)


def build_hood():
    ys = [-0.100, -0.136, -0.112, -0.060, 0.000, 0.060, 0.110, 0.152, 0.186, 0.208]
    rx = [0.128, 0.138, 0.146, 0.153, 0.156, 0.152, 0.142, 0.122, 0.090, 0.045]
    rz = [0.282, 0.300, 0.308, 0.312, 0.306, 0.292, 0.268, 0.228, 0.165, 0.085]
    zc = [1.535, 1.530, 1.530, 1.530, 1.522, 1.505, 1.488, 1.470, 1.458, 1.455]
    n = 34
    rings = []
    for i, y in enumerate(ys):
        pts = []
        for k in range(n):
            s = -0.42 + (math.pi + 0.84) * k / (n - 1)
            c, sn = math.cos(s), math.sin(s)
            p = 2.6
            x = rx[i] * math.copysign(abs(c) ** (2 / p), c)
            z = zc[i] + rz[i] * math.copysign(abs(sn) ** (2 / p), sn)
            if sn < 0:  # drape outward onto the shoulders
                x *= 1 + 0.45 * (-sn)
            wob = 0.012 * fbm((x * 12, y * 12, z * 12))
            pts.append(V((x * (1 + wob), y + 0.01 * math.sin(s * 5 + i), z + wob * 0.3)))
        rings.append(pts)
    # brim droops a little at the top centre of the opening
    for p in rings[1]:
        p.z -= 0.012 * max(0.0, (p.z - 1.75) / 0.08)
    return part(loft('Hood', rings, M['cape'], closed=False),
                bones=['Head', 'Neck', 'Spine2'], bias={'Head': 3.0, 'Spine2': 0.6}, power=3.0)


def build_headwrap():
    zs = [1.50, 1.545, 1.585, 1.625, 1.665, 1.705, 1.742, 1.772, 1.79]
    r = [0.058, 0.070, 0.084, 0.092, 0.095, 0.093, 0.084, 0.062, 0.03]
    rings = []
    for i, z in enumerate(zs):
        def fn(t, k, i=i, z=z):
            front = max(0.0, -math.sin(t))  # -Y half
            m = 1.0 + 0.012 * fbm((math.cos(t) * 4, math.sin(t) * 4, z * 30))
            if 1.53 < z < 1.62:
                m += 0.10 * front ** 3  # chin / jaw under the mask
            return m
        rings.append(ring((0, 0.008, z), r[i], r[i] * 1.12, 20, fn=fn))
    part(loft('HeadWrap', rings, M['wrap'], cap_end=True), bones=['Head', 'Neck'], bias={'Head': 2.0})
    # wrapped bands of cloth over the skull (tilted loops)
    bands = []
    for zc, tilt, rr, w, ph in ((1.735, 0.05, 0.090, 0.030, 0.3), (1.705, -0.04, 0.097, 0.032, 1.1),
                                (1.765, 0.02, 0.070, 0.028, 2.0), (1.645, 0.0, 0.098, 0.028, 0.7)):
        path = []
        for k in range(28):
            a = 2 * math.pi * k / 28
            if zc < 1.66 and -math.sin(a) > 0.55:
                continue  # leave the eyes free
            path.append(V((math.cos(a) * rr, 0.008 + math.sin(a) * rr * 1.12, zc + tilt * math.sin(a + ph))))
        closed = len(path) == 28
        if not closed:  # rotate list so the gap is at the ends
            idx = max(range(len(path)), key=lambda j: (path[j] - path[j - 1]).length)
            path = path[idx:] + path[:idx]
        bands.append(sweep('HeadBand', path, [(-w / 2, 0), (0, 0.006), (w / 2, 0), (0, -0.002)], M['wrap'],
                           closed_path=closed, up_fn=lambda i, path=path: V((path[i].x, path[i].y - 0.008, 0)),
                           scale_fn=lambda i, f, ph=ph: (1 + 0.2 * math.sin(i * 1.9 + ph), 1 + 0.4 * math.sin(i * 1.3))))
    part(join(bands, 'HeadBands'), rigid='Head')
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
    objs.append(rounded_box('Canteen', cc, (0.12, 0.05, 0.15), M['brass'], bevel=0.022, segments=3, rot=R))
    objs.append(rounded_box('CanteenWrap', cc + V((0, 0, -0.02)), (0.125, 0.054, 0.07), M['canvas'], bevel=0.02,
                            segments=2, rot=R))
    objs.append(cylinder('CanteenNeck', cc + V((0, 0, 0.074)), cc + V((0, 0, 0.098)), 0.012, M['steel'], n=10))
    # holstered tool (right hip): salvaged cutter / scanner
    p, n, tg = belt_frame(3.35, 0.205, 0.165)
    hc = p + n * 0.03 + V((0, 0, -0.13))
    objs.append(rounded_box('Holster', hc, (0.05, 0.035, 0.17), M['leather'], bevel=0.012,
                            rot=Matrix((tg, n, V((0, 0, 1)))).transposed()))
    objs.append(cylinder('ToolBody', hc + V((0, 0, 0.07)), hc + V((0, 0, 0.16)), 0.017, M['steel'], n=10,
                         rings_extra=[(0.3, 1.15), (0.4, 1.15), (0.45, 1.0)]))
    objs.append(cylinder('ToolGrip', hc + V((0, 0, 0.15)) + n * 0.0, hc + V((0, 0, 0.15)) + n * 0.06 + V((0, 0, 0.02)),
                         0.013, M['wood'], n=8))
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
    part(st, bones=['Spine1', 'Spine2', 'LeftShoulder', 'RightShoulder'], bias={'Spine2': 2.5}, power=3)
    # chest pressure gauge on the left strap (the hose ends here)
    gx, gz = 0.125, 1.33
    gy = env_front(gx, gz, CAPE_T, 0.025)
    gc = V((gx, gy, gz))
    gd = V((0.15, -1, 0.25)).normalized()
    g = [cylinder('Gauge', gc, gc + gd * 0.022, 0.029, M['brass'], n=16, rings_extra=[(0.8, 1.0), (0.9, 0.9)]),
         cylinder('GaugeFace', gc + gd * 0.019, gc + gd * 0.023, 0.023, M['steel'], n=16)]
    part(join(g, 'Gauge'), rigid='Spine2')


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
    objs.append(sp)
    # shovel strapped diagonally, blade up behind the left shoulder
    h0, h1 = V((-0.17, 0.425, 0.98)), V((0.16, 0.425, 1.50))
    hd = (h1 - h0).normalized()
    objs.append(cylinder('ShovelHandle', h0, h1, 0.0145, M['wood'], n=8))
    objs.append(cylinder('ShovelGrip', h0 - hd * 0.02, h0 + hd * 0.08, 0.017, M['leather'], n=8))
    blade_c = h1 + hd * 0.11
    bx = hd.cross(V((0, 1, 0))).normalized()
    Rb = Matrix((bx, V((0, 1, 0)), hd)).transposed()
    blade = rounded_box('ShovelBlade', blade_c, (0.15, 0.006, 0.20), M['steel'], bevel=0.003, segments=1, rot=Rb)
    for v in blade.data.vertices:  # dish the blade and taper the tip
        lc = Rb.transposed() @ (v.co - blade_c)
        lc.y -= 0.025 * (1 - (lc.x / 0.075) ** 2)
        lc.x *= 1 - 0.35 * max(0.0, lc.z / 0.1) ** 2
        v.co = blade_c + Rb @ lc
    objs.append(blade)
    objs.append(cylinder('ShovelSocket', h1 - hd * 0.03, h1 + hd * 0.02, 0.019, M['steel'], n=8))
    for z in (1.14, 1.34):
        f = (z - h0.z) / (h1.z - h0.z)
        c = h0.lerp(h1, f)
        objs.append(cylinder('ShovelStrap', c - hd * 0.012, c + hd * 0.012, 0.022, M['leather2'], n=8))
    pack = join(objs, 'Backpack')
    part(pack, rigid='Spine2')
    return join(lens, 'PackTubes')


# ====================================================================================== BUILD ALL

def build_character():
    build_torso()
    build_skirt(1)
    build_skirt(-1)
    build_cape()
    build_hood()
    build_headwrap()
    lens_objs = [build_goggles()]
    build_respirator()
    build_scarf()
    for s in (1, -1):
        build_sleeve(s)
        build_glove(s)
        build_leg(s)
        build_boot(s)
    lens_objs.append(build_belt())
    build_straps()
    lens_objs.append(build_backpack())

    # weights
    for obj, spec in PARTS:
        apply_weights(obj, spec)

    # lens objects: goggles → Head, hip tube → Hips, pack tubes → Spine2
    for lo, bone in zip(lens_objs, ['Head', 'Hips', 'Spine2']):
        apply_weights(lo, dict(bones=None, rigid=bone, fn=None, bias={}, power=4))

    body_parts = [o for o, _ in PARTS]
    total = sum(tri_count(o) for o in body_parts) + sum(tri_count(o) for o in lens_objs)
    print('TRIS', total, {o.name: tri_count(o) for o in body_parts})

    body = join(body_parts, 'Scavenger_Body')
    lens = join(lens_objs, 'Scavenger_Lens')

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
    lk = 22 + 95 * pos(-math.sin(w + 0.35)) ** 1.2 + 12 * pos(math.sin(w + 0.35))
    rk = 22 + 95 * pos(math.sin(w + 0.35)) ** 1.2 + 12 * pos(-math.sin(w + 0.35))
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


def main():
    body, lens = build_character()
    rig = make_rig([body, lens])
    CLIPS = [('Idle', 90, idle), ('Walk', 34, walk), ('Run', 22, run), ('Jump', 30, jump), ('Dig', 48, dig),
             ('Slide', 40, slide)]
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

    final = bake.bake_atlas(body, TEX, OUT_DIR, tint_name='Tint')
    lens.data.uv_layers['Detail'].name = 'Atlas'
    lens.modifiers.clear()
    body.modifiers.clear()
    body = join([body, lens], 'Scavenger_Body')
    mod = body.modifiers.new('Armature', 'ARMATURE')
    mod.object = rig
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_DIR, 'scavenger.blend'))
    bake.export(rig, [body], OUT_GLB)
    print('TRIS_FINAL', tri_count(body))


if __name__ == '__main__':
    main()
