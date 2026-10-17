# Salvage props: crashed-ship hull debris, salvage crate, old-tech CRT/vacuum-tube console.
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/models/props.py [-- debris crate console]
#
# Each → public/models/<name>.glb: one mesh, origin at ground level, baked 1024 PBR atlas (material named after
# the prop) + an unbaked emissive material for glass/screens. ≤ 5k triangles each.
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bake  # noqa: E402
import scavenger as S  # noqa: E402  (materials)
import scmats  # noqa: E402
from sclib import (V, catmull, circle_profile, cylinder, fbm, join, loft, rect_profile, ring,  # noqa: E402
                   rounded_box, sweep, tri_count)

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
M = S.M
M['hull'] = scmats.metal('Hull', '#6e665a', '#5a3a22', rough=0.5, paint='#a39a86', scratches=0.6, dust=1.0)
M['crate'] = scmats.metal('CratePaint', '#5f5a52', '#4f321c', rough=0.5, paint='#7d6a45', dust=1.0)
M['screen'] = scmats.lens('Screen', glow='#9ccf7a', strength=0.8)


def finish(name, objs, glow=()):
    body = join(objs, name)
    bake.bake_atlas(body, 1024, S.OUT_DIR, tint_name='__none__', small=0, prefix=name)
    # PlayerTint slot is unused for props: drop it
    if len(body.data.materials) > 1 and body.data.materials[1].name.startswith('PlayerTint'):
        body.data.materials.pop(index=1)
    if glow:
        g = join(list(glow), name + '_glow')
        g.data.uv_layers['Detail'].name = 'Atlas'
        body = join([body, g], name)
    print('TRIS', name, tri_count(body))
    bake.export(None, [body], os.path.join(S.ROOT, 'public', 'models', name + '.glb'))
    bpy.data.objects.remove(body)


# --------------------------------------------------------------------------------------------- debris

def debris():
    objs = []
    R, L, ang = 1.7, 3.0, math.radians(95)
    zc = -1.05  # cylinder axis below ground → only the top of the hull section sticks out
    n_len, n_arc = 14, 22
    rings = []
    for i in range(n_len + 1):
        x = -L / 2 + L * i / n_len
        ring_pts = []
        # arc extent varies along the length (torn edges)
        a0 = math.radians(-8) + 0.12 * fbm((x * 1.3, 0.2, 0)) + (0.25 if x > 0.9 else 0.0) * (x - 0.9)
        a1 = ang + 0.15 * fbm((x * 1.7, 4.0, 0))
        prof = []
        for k in range(n_arc):
            a = a0 + (a1 - a0) * k / (n_arc - 1)
            dent = 1 - 0.06 * math.exp(-((x - 0.3) ** 2 + (a - 0.9) ** 2) / 0.15)  # impact dent
            prof.append((a, R * dent))
        for a, r in prof:  # outer skin
            ring_pts.append(V((x, math.cos(a) * r, zc + math.sin(a) * r)))
        for a, r in reversed(prof):  # inner skin
            ring_pts.append(V((x, math.cos(a) * (r - 0.05), zc + math.sin(a) * (r - 0.05))))
        rings.append(ring_pts)
    # torn ends
    for idx in (0, -1):
        for j, p in enumerate(rings[idx]):
            p.x += (0.18 if idx == -1 else -0.12) * fbm((p.y * 4, p.z * 4, idx)) + (0.1 if idx == -1 else 0) * math.sin(j)
    # close the torn ends by collapsing outer/inner skins onto their mid-line (a thin ragged edge)
    def mid(r):
        m = len(r)
        return [(r[j] + r[m - 1 - j]) / 2 for j in range(m)]
    rings = [mid(rings[0])] + rings + [mid(rings[-1])]
    hull = loft('Hull', rings, M['hull'], closed=True)
    objs.append(hull)
    # frame ribs on the inside
    for x in (-1.0, -0.2, 0.6):
        pts = [V((x, math.cos(a) * (R - 0.09), zc + math.sin(a) * (R - 0.09)))
               for a in [math.radians(-5 + 100 * k / 16) for k in range(17)]]
        objs.append(sweep('Rib', pts, rect_profile(0.08, 0.12, 0.01), M['steel'], up=V((1, 0, 0))))
    # stringer
    a = math.radians(55)
    objs.append(cylinder('Stringer', (-1.4, math.cos(a) * (R - 0.12), zc + math.sin(a) * (R - 0.12)),
                         (1.1, math.cos(a) * (R - 0.12), zc + math.sin(a) * (R - 0.12)), 0.035, M['steel'], n=6))
    # pipes and cables spilling out of the torn end
    for k, (dy, dz, mat, r) in enumerate(((0.9, 0.35, M['brass'], 0.035), (0.6, 0.5, M['steel'], 0.045),
                                          (1.2, 0.15, M['brass'], 0.028))):
        p0 = V((1.0, dy, dz))
        pts = catmull([p0, p0 + V((0.45, 0.05 * k, 0.05)), p0 + V((0.8, 0.15 - 0.1 * k, -0.15)),
                       p0 + V((1.0, 0.25, -0.45 - 0.1 * k))], 4)
        objs.append(sweep('Pipe', pts, circle_profile(r, 8), mat))
        objs.append(cylinder('Flange', pts[-1] - (pts[-1] - pts[-2]).normalized() * 0.02, pts[-1], r * 1.5, M['steel'],
                             n=8))
    for k in range(4):
        p0 = V((1.0, 0.4 + 0.12 * k, 0.6 - 0.05 * k))
        pts = catmull([p0, p0 + V((0.3, 0.1, -0.1)), p0 + V((0.5, 0.2 * k - 0.2, -0.45)),
                       p0 + V((0.6 + 0.1 * k, 0.3, -0.62 + 0.05 * k))], 4)
        objs.append(sweep('Cable', pts, circle_profile(0.014, 6), M['rubber']))
    # avionics box bolted inside, panel with dials
    bc = V((-0.6, 0.55, 0.35))
    objs.append(rounded_box('Avionics', bc, (0.5, 0.25, 0.3), M['paint'], bevel=0.015, segments=1,
                            rot=Matrix.Rotation(math.radians(-35), 3, 'X')))
    glow = []
    for k in range(3):
        c = bc + V((-0.15 + 0.15 * k, -0.08, 0.13))
        objs.append(cylinder('Bezel', c, c + V((0, -0.03, 0.04)), 0.04, M['brass'], n=10))
        if k == 1:
            glow.append(cylinder('Lamp', c + V((0, -0.025, 0.035)), c + V((0, -0.035, 0.05)), 0.028, M['lens'], n=10))
    # a few rivets along the skin edge
    for k in range(10):
        x = -1.2 + 0.25 * k
        a = math.radians(30)
        p = V((x, math.cos(a) * (R + 0.003), zc + math.sin(a) * (R + 0.003)))
        nrm = V((0, math.cos(a), math.sin(a)))
        objs.append(cylinder('Rivet', p - nrm * 0.005, p + nrm * 0.012, 0.018, M['steel'], n=6))
    for o in objs + glow:  # crashed tilt
        o.data.transform(Matrix.Rotation(math.radians(9), 4, 'Y') @ Matrix.Rotation(math.radians(-6), 4, 'X'))
    finish('debris', objs, glow)


# ---------------------------------------------------------------------------------------------- crate

def crate():
    objs = []
    w, d, h = 0.9, 0.6, 0.52
    objs.append(rounded_box('CrateBody', (0, 0, h * 0.42), (w, d, h * 0.84), M['crate'], bevel=0.03, segments=2))
    objs.append(rounded_box('CrateLid', (0, 0, h * 0.92), (w + 0.02, d + 0.02, h * 0.16), M['crate'], bevel=0.03,
                            segments=2))
    # reinforcing ribs around body
    for z in (0.12, 0.30):
        objs.append(rounded_box('Band', (0, 0, z), (w + 0.012, d + 0.012, 0.04), M['steel'], bevel=0.008, segments=1))
    # corner caps
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz, z in ((0, 0.05), (1, h - 0.03)):
                objs.append(rounded_box('Corner', (sx * (w / 2 - 0.02), sy * (d / 2 - 0.02), z), (0.09, 0.09, 0.1),
                                        M['steel'], bevel=0.015, segments=2))
    # latches on the front (-Y)
    for x in (-0.25, 0.25):
        objs.append(rounded_box('LatchBase', (x, -d / 2 - 0.012, h * 0.82), (0.07, 0.02, 0.09), M['brass'],
                                bevel=0.006, segments=1))
        objs.append(rounded_box('LatchArm', (x, -d / 2 - 0.022, h * 0.88), (0.04, 0.012, 0.09), M['brass'],
                                bevel=0.004, segments=1, rot=Matrix.Rotation(math.radians(-8), 3, 'X')))
    # side handles
    for sx in (-1, 1):
        pts = [V((sx * (w / 2 + 0.005), -0.12, h * 0.6)), V((sx * (w / 2 + 0.05), -0.1, h * 0.6)),
               V((sx * (w / 2 + 0.065), 0, h * 0.6)), V((sx * (w / 2 + 0.05), 0.1, h * 0.6)),
               V((sx * (w / 2 + 0.005), 0.12, h * 0.6))]
        objs.append(sweep('Handle', catmull(pts, 3), circle_profile(0.012, 6), M['steel']))
        objs.append(rounded_box('Plate', (sx * (w / 2 + 0.004), 0, h * 0.5), (0.008, 0.18, 0.12), M['paint'],
                                bevel=0.003, segments=1))
    # strap with canvas tarp folded on top
    objs.append(rounded_box('Tarp', (0.12, 0.02, h + 0.035), (0.5, 0.42, 0.05), M['canvas'], bevel=0.02, segments=2))
    tarp = objs[-1]
    for v in tarp.data.vertices:
        v.co.z += 0.015 * fbm(v.co * 12)
    pts = [V((0.0, -d / 2 - 0.02, 0.05)), V((0.0, -d / 2 - 0.02, h + 0.07)), V((0.0, d / 2 + 0.02, h + 0.07)),
           V((0.0, d / 2 + 0.02, 0.05))]
    objs.append(sweep('Strap', pts, rect_profile(0.006, 0.05), M['leather2'], up_fn=lambda i: V((1, 0, 0)) if False else V((0, 0, 1))))
    for o in objs:  # slight settle into the sand
        o.data.transform(Matrix.Translation((0, 0, -0.03)) @ Matrix.Rotation(math.radians(3), 4, 'Y'))
    finish('crate', objs)


# -------------------------------------------------------------------------------------------- console

def console():
    objs, glow = [], []
    w, d, h = 0.52, 0.42, 0.44
    objs.append(rounded_box('Case', (0, 0, h / 2 + 0.03), (w, d, h), M['paint'], bevel=0.035, segments=3))
    # CRT bezel and bulging screen on the front (-Y)
    sc = V((-0.06, -d / 2, 0.29))
    fr = Matrix((V((1, 0, 0)), V((0, 0, 1)), V((0, -1, 0)))).transposed()
    bezel = [ring(sc + V((0, 0.01, 0)), 0.16, 0.13, 20, fr, fn=S.superellipse(4)),
             ring(sc + V((0, -0.018, 0)), 0.16, 0.13, 20, fr, fn=S.superellipse(4)),
             ring(sc + V((0, -0.02, 0)), 0.135, 0.108, 20, fr, fn=S.superellipse(4)),
             ring(sc + V((0, -0.005, 0)), 0.13, 0.104, 20, fr, fn=S.superellipse(4))]
    objs.append(loft('Bezel', bezel, M['brass']))
    screen = [ring(sc + V((0, -0.004, 0)), 0.131, 0.105, 20, fr, fn=S.superellipse(4)),
              ring(sc + V((0, -0.022, 0)), 0.10, 0.08, 20, fr, fn=S.superellipse(3.5)),
              ring(sc + V((0, -0.03, 0)), 0.05, 0.04, 20, fr, fn=S.superellipse(3))]
    glow.append(loft('Screen', screen, M['screen'], cap_end=True))
    # control column with knobs
    for k in range(3):
        c = V((0.17, -d / 2, 0.36 - 0.09 * k))
        objs.append(cylinder('KnobBase', c, c + V((0, -0.008, 0)), 0.026, M['steel'], n=10))
        objs.append(cylinder('Knob', c + V((0, -0.008, 0)), c + V((0, -0.035, 0)), 0.018, M['rubber'], n=8,
                             rings_extra=[(0.8, 1.0), (0.95, 0.8)]))
    # speaker grille
    for k in range(6):
        z = 0.085 + 0.012 * k
        objs.append(rounded_box('Slat', (-0.06, -d / 2 - 0.004, z), (0.26, 0.008, 0.006), M['steel'], bevel=0.0))
    # vacuum tubes on top in brass sockets, with a cage
    for k, (x, y) in enumerate(((-0.13, 0.05), (-0.04, 0.08), (0.05, 0.05), (0.14, 0.09))):
        b = V((x, y, h + 0.03))
        objs.append(cylinder('Socket', b, b + V((0, 0, 0.02)), 0.024, M['brass'], n=10))
        glow.append(cylinder('Tube', b + V((0, 0, 0.02)), b + V((0, 0, 0.1 + 0.02 * (k % 2))), 0.016, M['lens'], n=10,
                             rings_extra=[(0.85, 0.9), (0.97, 0.45)]))
    for x in (-0.2, 0.2):
        pts = [V((x, -0.05, h + 0.03)), V((x, -0.05, h + 0.16)), V((x, 0.16, h + 0.16)), V((x, 0.16, h + 0.03))]
        objs.append(sweep('Cage', pts, circle_profile(0.006, 5), M['steel']))
    objs.append(cylinder('CageBar', (-0.2, 0.055, h + 0.16), (0.2, 0.055, h + 0.16), 0.006, M['steel'], n=5))
    # side vents, carry handle, feet, cable stub
    for k in range(5):
        objs.append(rounded_box('Vent', (w / 2 + 0.002, -0.08 + 0.04 * k, 0.28), (0.008, 0.02, 0.14), M['steel'],
                                bevel=0.003, segments=1))
    for sx in (-1, 1):
        for sy in (-1, 1):
            objs.append(cylinder('Foot', (sx * 0.2, sy * 0.15, 0.0), (sx * 0.2, sy * 0.15, 0.035), 0.025, M['rubber'],
                                 n=8))
    pts = catmull([(0.1, d / 2, 0.1), (0.12, d / 2 + 0.12, 0.08), (0.2, d / 2 + 0.25, 0.02),
                   (0.35, d / 2 + 0.3, 0.015)], 4)
    objs.append(sweep('Cord', pts, circle_profile(0.012, 6), M['rubber']))
    objs.append(cylinder('Plug', pts[-1], pts[-1] + (pts[-1] - pts[-2]).normalized() * 0.05, 0.02, M['brass'], n=8))
    # dented/cracked: push a dent into the left side
    case = objs[0]
    for v in case.data.vertices:
        dd = (v.co - V((-w / 2, 0.08, 0.2))).length
        if dd < 0.12:
            v.co.x += 0.025 * (1 - dd / 0.12)
    for o in objs + glow:
        o.data.transform(Matrix.Rotation(math.radians(-7), 4, 'Z') @ Matrix.Rotation(math.radians(4), 4, 'X'))
    finish('console', objs, glow)


for name in (ARGS or ['debris', 'crate', 'console']):
    globals()[name]()
