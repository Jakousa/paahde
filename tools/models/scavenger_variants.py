# Character customization study: the scavenger (scavenger.py) rebuilt with other pieces in each slot and other
# cloth dyes, for preview renders only (procedural materials, no bake, no glb).
#
#   Blender -b --factory-startup -P tools/models/scavenger_variants.py -- <variant> <out.blend>
#   Blender -b --factory-startup -P tools/models/render_preview.py -- <out.blend> <prefix>
#
# Slots: head (hood | wrap | hat | turban | helmet), face (respirator | mask), coat (long | short),
# cape (cape | none | poncho), shoulder (none | plate). The player colour (scarf, mask, sash, armband, hat band)
# is the tint the game already sets per player.
import math
import os
import sys

ARGS = sys.argv[sys.argv.index('--') + 1:]
NAME, OUT = ARGS[0], ARGS[1]
SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scavenger.py')
sys.argv = [sys.argv[0], '--', '--fast']

ns = {'__file__': SRC, '__name__': 'scavenger_variant'}
exec(compile(open(SRC).read(), SRC, 'exec'), ns)
scmats = ns['scmats']
M = ns['M']
V, ring, loft, part, fbm, frame_from = ns['V'], ns['ring'], ns['loft'], ns['part'], ns['fbm'], ns['frame_from']

# dyes: (base, dark, sun-bleached)
INDIGO = ('#3d4a6e', '#222a40', '#6a7698')
NIGHT = ('#2b2f42', '#16182a', '#4a4e66')
BONE = ('#d8cdb6', '#a3967c', '#f2ead8')
RUST = ('#8a3e22', '#4e1f10', '#b0603c')
OLIVE = ('#5d6140', '#383a24', '#7e8260')
SOOT = ('#3b3734', '#1d1b19', '#5a5450')
OXBLOOD = ('#6e1f1a', '#3a0e0b', '#8f3a30')
SAND = ('#c8a57a', '#8f6f4c', '#e2c7a0')
DUNE = ('#b8946a', '#7d5f40', '#d6b68e')

VARIANTS = {
    'original': dict(head='hood', face='respirator', coat='long', cape='cape', tint='#c0392b'),
    'nomad': dict(head='turban', face='mask', coat='long', cape='poncho', tint='#e0a526',
                  robe=INDIGO, cape_dye=NIGHT, wrap=BONE),
    'pilgrim': dict(head='wrap', face='mask', coat='long', cape='cape', tint='#2f7f8a',
                    robe=BONE, cape_dye=RUST, wrap=BONE),
    'mechanic': dict(head='hat', face='respirator', coat='short', cape='none', shoulder='plate', tint='#d9762b',
                     robe=OLIVE, wrap=('#5a4a3a', '#33281e', '#7a6a58'), trousers=('#3a3530', '#1e1b18', '#5a524a')),
    'raider': dict(head='helmet', face='respirator', coat='short', cape='cape', shoulder='plate', tint='#e8d23a',
                   robe=SOOT, cape_dye=OXBLOOD, wrap=SOOT, trousers=('#2a2522', '#141110', '#45403b')),
    'ghost': dict(head='hood', face='mask', coat='long', cape='poncho', tint='#9a8a70',
                  robe=SAND, cape_dye=DUNE, wrap=SAND, trousers=('#8a6e50', '#5a4632', '#a88c6c')),
}
v = VARIANTS[NAME]

# ------------------------------------------------------------------------------------------- dyes
for key, label in (('robe', 'Robe'), ('cape_dye', 'Cape'), ('wrap', 'Wrap'), ('trousers', 'Trousers')):
    if key in v:
        base, dark, bleach = v[key]
        M[key.replace('_dye', '')] = scmats.cloth(label + 'V', base, dark, dust=0.9, bleach=bleach, bleach_amt=0.35)
# the player colour as the game would set it (the glb has a pale cloth the client recolours)
M['tint'] = scmats.cloth('TintV', v['tint'], v['tint'], dust=0.55, stains=0.3, bleach='#f0ebe2', bleach_amt=0.15,
                         wrinkle=0.7)


def skip(*a, **k):
    return None


# ------------------------------------------------------------------------------------------- head
def build_hat():
    # wide-brimmed leather hat over the head wrap: dented crown, drooping wavy brim, band in the player colour
    crown = []
    for z, r in ((1.70, 0.108), (1.74, 0.106), (1.78, 0.101), (1.815, 0.094), (1.835, 0.082), (1.845, 0.05),
                 (1.847, 0.01)):
        def fn(t, k, z=z):
            dent = 0.08 * max(0.0, math.cos(t - math.pi / 2)) ** 4 if z > 1.80 else 0.0
            return 1.0 - dent + 0.01 * fbm((math.cos(t) * 3, math.sin(t) * 3, z * 20))
        crown.append(ring((0, 0.008, z), r, r * 1.1, 28, fn=fn))
    objs = [loft('HatCrown', crown, M['leather2'], cap_end=True)]
    brim = []
    for r, dz in ((0.104, 0.0), (0.16, -0.006), (0.215, -0.022), (0.222, -0.032), (0.21, -0.03), (0.15, -0.012),
                  (0.10, -0.01)):
        pts = ring((0, 0.008, 1.705), r, r * 1.08, 28)
        for p in pts:
            a = math.atan2(p.y - 0.008, p.x)
            wave = 0.012 * math.sin(a * 3 + 0.6) * (r - 0.1) / 0.12
            p.z += dz + wave + 0.028 * math.cos(2 * a) * max(0.0, r - 0.12) / 0.1  # sides curl up
        brim.append(pts)
    objs.append(loft('HatBrim', brim + [brim[0]], M['leather2']))
    objs.append(loft('HatBand', [ring((0, 0.008, 1.722), 0.1095, 0.120, 28),
                                 ring((0, 0.008, 1.742), 0.1075, 0.118, 28)], M['tint']))
    for o in objs:
        part(o, rigid='Head')


def build_turban():
    # a tall wound turban: lumpy cloth dome with spiralling folds, and a tail hanging down the back
    rings = []
    zs = [1.70, 1.725, 1.75, 1.775, 1.795, 1.81, 1.818]
    rs = [0.108, 0.122, 0.126, 0.122, 0.106, 0.075, 0.03]
    for i, z in enumerate(zs):
        def fn(t, k, z=z):
            return 1.0 + 0.02 * fbm((math.cos(t) * 4, math.sin(t) * 4, z * 25))
        rings.append(ring((0, 0.016, z), rs[i], rs[i] * 1.1, 30, fn=fn))
    part(loft('Turban', rings, M['wrap'], cap_end=True), rigid='Head')
    # the wound layers: thick tilted loops crossing over the forehead
    bands = []
    for zc, tilt, rr, w, ph in ((1.712, 0.022, 0.118, 0.034, 0.0), (1.738, -0.03, 0.127, 0.036, 1.4),
                                (1.765, 0.035, 0.126, 0.034, 2.6), (1.79, -0.02, 0.112, 0.030, 4.0)):
        path = [V((math.cos(a) * rr, 0.016 + math.sin(a) * rr * 1.1, zc + tilt * math.sin(a + ph)))
                for a in [2 * math.pi * k / 32 for k in range(32)]]
        bands.append(ns['sweep']('TurbanBand', path, [(-w / 2, 0), (0, 0.012), (w / 2, 0), (0, -0.003)], M['wrap'],
                                 closed_path=True, up_fn=lambda i, path=path: V((path[i].x, path[i].y - 0.016, 0)),
                                 scale_fn=lambda i, f, ph=ph: (1 + 0.15 * math.sin(i * 1.7 + ph), 1 + 0.3 * math.sin(i * 1.1))))
    part(ns['join'](bands, 'TurbanBands'), rigid='Head')
    tp = ns['catmull']([(0.03, 0.12, 1.72), (0.05, 0.15, 1.62), (0.06, 0.16, 1.52), (0.07, 0.165, 1.42)], 4)
    tail = ns['sweep']('TurbanTail', tp, ns['rect_profile'](0.008, 0.07, 0.003), M['wrap'],
                       up_fn=lambda i: V((0, 1, 0.1)),
                       scale_fn=lambda i, f: (1.0, 0.9 + 0.3 * f), twist_fn=lambda i, f: 0.2 * math.sin(f * 3))
    part(tail, bones=['Head', 'Neck', 'Spine2'], bias={'Head': 1.5})


def build_helmet():
    # a dented steel pot helmet with a flared rim and a riveted crest strip
    rings = []
    for k in range(9):
        a = math.radians(90 * k / 8)
        r, z = 0.122 * math.cos(a) + 0.002, 1.69 + 0.155 * math.sin(a)

        def fn(t, kk, k=k):
            return 1.0 - 0.025 * max(0.0, math.cos(t - 0.8)) ** 6 * (k > 2) + 0.004 * fbm((math.cos(t) * 5, math.sin(t) * 5, k))
        rings.append(ring((0, 0.01, z), max(r, 0.005), max(r, 0.005) * 1.08, 30, fn=fn))
    rim = [ring((0, 0.01, 1.682), 0.138, 0.152, 30), ring((0, 0.01, 1.676), 0.142, 0.156, 30),
           ring((0, 0.01, 1.672), 0.124, 0.136, 30)]
    objs = [loft('Helmet', rings, M['paint'], cap_end=True), loft('HelmetRim', rim + [rim[0]], M['steel'])]
    crest = [V((0, 0.01 + math.sin(a) * 0.168, 1.69 + math.cos(a) * 0.157))
             for a in [math.radians(-70 + 150 * k / 14) for k in range(15)]]
    objs.append(ns['sweep']('HelmetCrest', crest, ns['rect_profile'](0.022, 0.008), M['brass'], up=V((1, 0, 0))))
    for o in objs:
        part(o, rigid='Head')


HEAD = {'hood': None, 'wrap': skip, 'hat': build_hat, 'turban': build_turban, 'helmet': build_helmet}
if v['head'] != 'hood':
    ns['build_hood'] = skip
if v['face'] == 'mask':
    ns['build_respirator'] = skip

# ------------------------------------------------------------------------------------------- coat / cape
if v['coat'] == 'short':  # a hip-length coat: the skirt rings pulled up towards the waist
    ns['SKIRT_Z'][:] = [1.03, 0.98, 0.93, 0.88, 0.84, 0.80, 0.77]
if v['cape'] == 'none':
    ns['build_cape'] = skip
elif v['cape'] == 'poncho':  # the capelet carried on down to the waist, wider over the arms
    zs, rx, ry = ns['CAPE_T']
    ns['CAPE_T'] = (zs + [1.235, 1.185, 1.135, 1.085], rx + [0.318, 0.33, 0.338, 0.342],
                    ry + [0.212, 0.220, 0.226, 0.230])


# ------------------------------------------------------------------------------------------- shoulder
def build_plate():
    # scrap pauldron on the left shoulder: a domed cap and two overlapping bands down the upper arm
    sh, up = ns['SH_L'], ns['UPPER_DIR']
    fr = frame_from(up, V((0, 1, 0)))
    objs = []
    for i, (t0, t1, r) in enumerate(((0.02, 0.075, 0.094), (0.065, 0.12, 0.088))):
        objs.append(loft('PlateBand', [ring(sh + up * t0, r, r * 0.95, 20, fr), ring(sh + up * t1, r * 0.97, r * 0.92, 20, fr),
                                       ring(sh + up * t1, r * 0.9, r * 0.86, 20, fr)], M['paint']))
    cap = []
    for k in range(6):
        a = math.radians(90 * k / 5)
        rr = 0.105 * math.cos(a) + 0.003
        cap.append(ring(sh + V((0.0, 0.0, 0.01 + 0.05 * math.sin(a))), rr, rr * 0.92, 20))
    objs.append(loft('PlateCap', cap, M['steel'], cap_end=True))
    for o in objs:
        part(o, bones=['LeftArm', 'LeftShoulder'], bias={'LeftArm': 1.6}, power=4.0)


# extras built alongside the scarf (any build step after the head works)
extras = [f for f in (HEAD[v['head']], build_plate if v.get('shoulder') == 'plate' else None) if f]
orig_scarf = ns['build_scarf']


def build_scarf():
    orig_scarf()
    for f in extras:
        f()


ns['build_scarf'] = build_scarf

import bpy  # noqa: E402

body, lens = ns['build_character']()
ns['make_rig']([body, lens])
ns['clip']('Idle', 90, ns['idle'])
for pb in ns['RIG'].pose.bones:
    pb.rotation_quaternion = ns['Quaternion']()
    pb.location = V()
bpy.ops.wm.save_as_mainfile(filepath=OUT)
print('SAVED', OUT)
