# Character customization study: the scavenger (scavenger.py) rebuilt with other pieces in each slot and other
# cloth dyes, for preview renders only (procedural materials, no bake, no glb).
#
#   Blender -b --factory-startup -P tools/models/scavenger_variants.py -- <variant> <out.blend>
#   Blender -b --factory-startup -P tools/models/render_preview.py -- <out.blend> <prefix>
#
# Slots: head (hood | cowl | ragged | down), eyes (goggles | mono | visor), face (respirator | side | mask),
# coat (long | short), cape (cape | none | poncho), shoulder (none | plate), gloves (leather | wrapped | gauntlet),
# boots (buckled | tall | wrapped | guard), scarf (scarf | long | snood | bib | veil | none). The player colour (scarf, mask, sash, armband) is the tint the game
# already sets per player.
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
    'original': dict(head='hood', eyes='goggles', face='respirator', coat='long', cape='cape', tint='#c0392b'),
    'cowl': dict(head='cowl', eyes='mono', face='mask', coat='long', cape='poncho', gloves='wrapped',
                 boots='wrapped', tint='#e0a526', robe=INDIGO, cape_dye=NIGHT, wrap=BONE),
    'ragged': dict(head='ragged', eyes='goggles', face='side', coat='long', cape='cape', gloves='gauntlet',
                   boots='tall', tint='#2f7f8a', robe=BONE, cape_dye=RUST, wrap=BONE),
    'hooddown': dict(head='down', eyes='visor', face='respirator', coat='short', cape='none', shoulder='plate',
                     gloves='gauntlet', boots='guard', tint='#d9762b', robe=OLIVE,
                     wrap=('#5a4a3a', '#33281e', '#7a6a58'), trousers=('#3a3530', '#1e1b18', '#5a524a')),
    'raider': dict(head='cowl', eyes='visor', face='side', coat='short', cape='cape', shoulder='plate',
                   boots='guard', tint='#e8d23a', robe=SOOT, cape_dye=OXBLOOD, wrap=SOOT,
                   trousers=('#2a2522', '#141110', '#45403b')),
    'ghost': dict(head='ragged', eyes='mono', face='mask', coat='long', cape='poncho', gloves='wrapped',
                  boots='wrapped', tint='#9a8a70', robe=SAND, cape_dye=DUNE, wrap=SAND,
                  trousers=('#8a6e50', '#5a4632', '#a88c6c')),
    # simpler, lighter looks: no pack, no respirator, a wrap tunic
    'rey': dict(head='none', eyes='goggles', face='mask', scarf='none', tunic='cross', coat='long', cape='none',
                carry='light', gloves='wrapped', tint='#7a4a2c', robe=('#b9ad96', '#8a7f6c', '#d8cfbc'),
                wrap=('#d2c8b4', '#a39884', '#ece5d6'), trousers=('#4a4038', '#2a241f', '#6a5e52')),
    'scout': dict(head='none', eyes='goggles', face='mask', scarf='snood', tunic='cross', coat='short', cape='none',
                  carry='light', tint='#c0392b', robe=SAND, wrap=DUNE, trousers=('#6a543e', '#43342a', '#8a7058')),
    'wanderer': dict(head='down', eyes='goggles', face='mask', scarf='bib', coat='long', cape='none',
                     carry='light', tint='#2f7f8a', robe=RUST, cape_dye=RUST, wrap=BONE),
    'veiled': dict(head='none', eyes='goggles', face='mask', mask=False, scarf='veil', tunic='cross', coat='long',
                   cape='none', carry='light', gloves='wrapped', boots='wrapped', tint='#e0a526', robe=INDIGO,
                   wrap=BONE),
    'drifter': dict(head='none', eyes='mono', face='mask', scarf='long', coat='short', cape='none',
                    carry='light', boots='tall', tint='#d9762b', robe=OLIVE, wrap=('#a89a7c', '#6e6450', '#c8bc9e'),
                    trousers=('#3a3530', '#1e1b18', '#5a524a')),
    'hooded': dict(head='ragged', eyes='goggles', face='mask', tunic='cross', coat='long', cape='none',
                   carry='light', tint='#8e44ad', robe=BONE, cape_dye=('#9a8a70', '#6a5c48', '#b8aa90'), wrap=BONE),
}
# scarf_<option>: the original with only the scarf changed
v = dict(VARIANTS['original'], scarf=NAME[6:]) if NAME.startswith('scarf_') else VARIANTS[NAME]

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


# ------------------------------------------------------------------------------------------- hood
def build_hood(size=0.88, front=0.0, point=0.0, drape=0.45, ragged=0.0):
    """scavenger.py's hood with knobs: overall size (about the head), a deeper front, a pointed peak at the back,
    how far it spreads onto the shoulders, a ragged opening."""
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
            x = rx[i] * math.copysign(abs(c) ** (2 / 2.6), c)
            z = zc[i] + rz[i] * math.copysign(abs(sn) ** (2 / 2.6), sn)
            if sn < 0:
                x *= 1 + drape * (-sn)
            # the peak: the top of the back rings pulled up and back into a point
            z += point * back ** 1.5 * max(0.0, sn) ** 6
            yy = y + point * 0.6 * back ** 2 * max(0.0, sn) ** 6
            wob = 0.012 * fbm((x * 12, y * 12, z * 12))
            pts.append(V((x * (1 + wob), yy + 0.01 * math.sin(s * 5 + i), z + wob * 0.3)))
        rings.append(pts)
    for p in rings[1]:
        p.z -= 0.012 * max(0.0, (p.z - 1.75) / 0.08)
    if ragged:
        for r in rings[:2]:
            for p in r:
                p.y -= ragged * (0.4 + fbm((p.x * 30, p.z * 30, 3.0), 2)) * (0.6 + max(0.0, math.sin(p.z * 90)) ** 4)
    # scale about the head, so it sits closer
    c = V((0, 0.01, 1.64))
    for r in rings:
        for p in r:
            p[:] = c + (p - c) * size
    return part(loft('Hood', rings, M['cape'], closed=False),
                bones=['Head', 'Neck', 'Spine2'], bias={'Head': 3.0, 'Spine2': 0.6}, power=3.0)


def build_hood_down():
    # the hood thrown back: a bunched roll of cloth round the back of the neck, a fold hanging between the shoulders
    rings = []
    for z, rx, ry, yo in ((1.42, 0.150, 0.125, 0.045), (1.455, 0.172, 0.150, 0.055), (1.49, 0.176, 0.158, 0.06),
                          (1.525, 0.160, 0.142, 0.055), (1.55, 0.128, 0.112, 0.045)):
        def fn(t, k, z=z):
            return 1.0 + 0.06 * math.sin(t * 7 + z * 40) ** 2 + 0.02 * fbm((math.cos(t) * 3, math.sin(t) * 3, z * 20))
        r = ring((0, yo, z), rx, ry, 26, fn=fn, a0=math.radians(-15), a1=math.radians(195), closed=False)
        for p in r:  # the hood's empty bag hangs low at the back
            p.z -= 0.09 * max(0.0, (p.y - 0.12) / 0.08) ** 2 * (1.55 - z) / 0.13
        rings.append(r)
    return part(loft('HoodDown', rings, M['cape'], closed=False), bones=['Neck', 'Spine2', 'Head'],
                bias={'Spine2': 2.0}, power=3.0)


HOOD = {
    'hood': lambda: build_hood(),
    'cowl': lambda: build_hood(size=0.9, front=0.035, point=0.11, drape=0.4),  # deep, pointed
    'ragged': lambda: build_hood(size=0.84, drape=0.3, ragged=0.03),  # short, torn opening
    'down': build_hood_down,
    'none': skip,
}
ns['build_hood'] = HOOD[v['head']]


# ------------------------------------------------------------------------------------------- eyes
def goggle(E, d, s, scale, objs, lenses):
    fr = frame_from(d, V((0, 0, 1)))

    def rr(t, r, n=16):
        return ring(E + d * t * scale, r * scale, r * scale, n, fr)
    objs.append(loft('GogCushion', [rr(-0.006, 0.024), rr(0.004, 0.0275), rr(0.012, 0.026)], M['leather']))
    objs.append(loft('GogCup', [rr(0.010, 0.0235), rr(0.024, 0.024), rr(0.028, 0.0258), rr(0.033, 0.0255),
                                rr(0.0345, 0.0235), rr(0.034, 0.0195), rr(0.027, 0.0192)], M['brass']))
    lenses.append(loft('GogLens', [rr(0.026, 0.0196), rr(0.0285, 0.013), rr(0.0295, 0.004)], M['lens'],
                       cap_end=True))


def strap(objs):
    path = []
    for k in range(25):
        ang = -math.pi / 2 + math.radians(58) + (2 * math.pi - math.radians(116)) * k / 24
        path.append(V((math.cos(ang) * 0.103, 0.008 + math.sin(ang) * 0.115, 1.68 + 0.006 * math.sin(ang))))
    objs.append(ns['sweep']('GogStrap', path, ns['rect_profile'](0.004, 0.022), M['leather2'], up=V((0, 0, 1))))


def build_mono():
    # one big lens over the right eye on a strap, a leather patch over the other
    objs, lenses = [], []
    goggle(V((-0.040, -0.098, 1.678)), V((-0.22, -1.0, 0.03)).normalized(), -1, 1.3, objs, lenses)
    E = V((0.036, -0.096, 1.676))
    d = V((0.20, -1.0, 0.03)).normalized()
    fr = frame_from(d, V((0, 0, 1)))
    objs.append(loft('Patch', [ring(E + d * t, r, r * 0.85, 14, fr) for t, r in
                               ((-0.004, 0.024), (0.006, 0.026), (0.010, 0.02), (0.012, 0.004))], M['leather'],
                     cap_end=True))
    strap(objs)
    part(ns['join'](objs, 'Goggles'), rigid='Head')
    return ns['join'](lenses, 'Lenses')


def build_visor():
    # a curved steel visor across the eyes with one glowing slit
    def band(z0, z1, r, mat, name):
        return loft(name, [ring((0, 0.008, z), r, r * 1.12, 18, a0=math.radians(198), a1=math.radians(342),
                                closed=False) for z in (z0, z1)], mat, closed=False)
    objs = [band(1.645, 1.669, 0.112, M['paint'], 'VisorLow'), band(1.683, 1.708, 0.112, M['paint'], 'VisorHigh'),
            band(1.669, 1.683, 0.106, M['steel'], 'VisorBack')]
    for s in (1, -1):  # rivets at the hinges
        objs.append(ns['cylinder']('Rivet', V((s * 0.104, -0.035, 1.676)), V((s * 0.112, -0.038, 1.676)), 0.008,
                                   M['brass'], n=8))
    strap(objs)
    part(ns['join'](objs, 'Visor'), rigid='Head')
    return band(1.6695, 1.6825, 0.110, M['lens'], 'VisorSlit')


def goggles_up():
    # the goggles pushed up onto the forehead: the whole set (strap too) turned up about the head
    from mathutils import Matrix
    lens = orig_goggles()
    rot = Matrix.Rotation(-0.62, 3, 'X')
    c = V((0, 0.008, 1.68))
    for o in (ns['PARTS'][-1][0], lens):
        for vt in o.data.vertices:
            vt.co = c + rot @ (vt.co - c) * 1.06
    return lens


orig_goggles = ns['build_goggles']
EYES = {'goggles': None, 'up': goggles_up, 'mono': build_mono, 'visor': build_visor}
if EYES[v['eyes']]:
    ns['build_goggles'] = EYES[v['eyes']]


# ------------------------------------------------------------------------------------------- face
def build_side():
    # a lighter respirator: a short snout and one big filter canister on the left cheek
    from mathutils import Matrix
    objs = []
    base = V((0, -0.103, 1.603))
    d = V((0, -0.88, -0.47)).normalized()
    fr = frame_from(d, V((1, 0, 0)))
    prof = [(-0.004, 0.028), (0.010, 0.030), (0.016, 0.031), (0.026, 0.026), (0.030, 0.018), (0.028, 0.008)]
    objs.append(loft('RespSnout', [ring(base + d * t, r, r * 0.9, 14, fr) for t, r in prof], M['steel'],
                     cap_end=True))
    for k in (-1, 1):
        a = base + d * 0.03 + fr.col[0] * k * 0.007
        objs.append(ns['rounded_box']('Grille', a, (0.003, 0.004, 0.022), M['brass'], bevel=0.0,
                                      rot=Matrix((fr.col[0], fr.col[2], fr.col[1])).transposed()))
    c = V((0.055, -0.090, 1.582))
    cd = V((0.75, -0.5, -0.42)).normalized()
    objs.append(ns['cylinder']('Canister', c, c + cd * 0.075, 0.027, M['paint'], n=14,
                               rings_extra=[(0.06, 1.0), (0.1, 1.07), (0.18, 1.07), (0.22, 1.0), (0.88, 1.0),
                                            (0.93, 0.85)]))
    objs.append(ns['cylinder']('CanCap', c + cd * 0.073, c + cd * 0.082, 0.02, M['brass'], n=12))
    part(ns['join'](objs, 'Respirator'), rigid='Head')


FACE = {'respirator': None, 'mask': skip, 'side': build_side}
if FACE[v['face']]:
    ns['build_respirator'] = FACE[v['face']]

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


# ------------------------------------------------------------------------------------------- hands / feet
def with_mats(fn, **swap):
    """fn built with some materials stood in for others (leather='wrap': cloth where it had leather)."""
    def g(*a):
        saved = {k: M[k] for k in swap}
        M.update({k: M[w] for k, w in swap.items()})
        try:
            fn(*a)
        finally:
            M.update(saved)
    return g


orig_glove, orig_boot = ns['build_glove'], ns['build_boot']


def gauntlet(sign):
    # the glove plus a flared leather cuff up the forearm and a steel plate over the back of the hand
    from mathutils import Matrix
    orig_glove(sign)
    pre = 'Left' if sign > 0 else 'Right'
    wr = ns['WR_L']
    W = V((wr.x * sign, wr.y, wr.z))
    a, pn, t = ns['hand_frame'](sign)
    fr = Matrix((t, pn, a)).transposed()

    def P(u, vv, w):
        return W + t * u + pn * vv + a * w
    cuff = [ring(P(0, 0, w), r, r * 0.92, 18, fr) for w, r in
            ((-0.03, 0.054), (-0.07, 0.060), (-0.11, 0.066), (-0.135, 0.071), (-0.14, 0.064))]
    part(loft(pre + 'Cuff', cuff, M['leather2']), bones=[pre + 'ForeArm', pre + 'Hand'], bias={pre + 'ForeArm': 2.0})
    plate = ns['rounded_box']('HandPlate', P(0, -0.028, 0.045), (0.062, 0.007, 0.052), M['steel'], bevel=0.003,
                              segments=1, rot=fr)
    part(plate, rigid=pre + 'Hand')


def tall(sign):
    # the boot carried on up to below the knee, with a turned-down cuff
    orig_boot(sign)
    pre = 'Left' if sign > 0 else 'Right'
    x0 = 0.106 * sign
    rings = [ring((x0, 0.022, z), r, r * 1.08, 16,
                  fn=lambda a_, k, z=z: 1 + 0.025 * fbm((math.cos(a_) * 3, math.sin(a_) * 3, z * 20)))
             for z, r in ((0.30, 0.071), (0.36, 0.074), (0.42, 0.077), (0.455, 0.08), (0.47, 0.088), (0.475, 0.09),
                          (0.44, 0.088), (0.43, 0.08))]
    part(loft(pre + 'BootTop', rings, M['leather']), bones=[pre + 'Leg'], rigid=pre + 'Leg')


def guard(sign):
    # a curved steel plate strapped over the front of the shin, and a toe cap
    orig_boot(sign)
    pre = 'Left' if sign > 0 else 'Right'
    x0 = 0.106 * sign
    rings = [ring((x0, 0.016, z), r, r * 1.1, 14, a0=math.radians(205), a1=math.radians(335), closed=False)
             for z, r in ((0.17, 0.074), (0.25, 0.077), (0.34, 0.08), (0.42, 0.083), (0.46, 0.081))]
    part(loft(pre + 'ShinGuard', rings, M['paint'], closed=False), bones=[pre + 'Leg'], rigid=pre + 'Leg')


GLOVES = {'leather': None, 'wrapped': with_mats(orig_glove, leather='wrap'), 'gauntlet': gauntlet}
BOOTS = {'buckled': None, 'tall': tall, 'wrapped': with_mats(orig_boot, leather='wrap', leather2='wrap'),
         'guard': guard}
if GLOVES[v.get('gloves', 'leather')]:
    ns['build_glove'] = GLOVES[v['gloves']]
if BOOTS[v.get('boots', 'buckled')]:
    ns['build_boot'] = BOOTS[v['boots']]


# extras built alongside the scarf (any build step after the head works)
# ------------------------------------------------------------------------------------------- scarf
def scarf_loops(specs, name='ScarfLoops'):
    # loops of cloth round the neck: (height, tilt down at the front, radius x, radius y, width, phase)
    objs = []
    for zc, tilt, rx, ry, w, ph in specs:
        path = [V((math.cos(a) * rx, 0.004 + math.sin(a) * ry, zc + tilt * math.sin(a)))
                for a in [2 * math.pi * k / 36 for k in range(36)]]
        objs.append(ns['sweep']('ScarfLoop', path, [(-w / 2, 0.0), (-w / 4, 0.012), (0, 0.016), (w / 4, 0.012),
                                                    (w / 2, 0.0), (w / 4, -0.006), (0, -0.007), (-w / 4, -0.006)],
                                M['tint'], closed_path=True, up=V((0, 0, 1)),
                                scale_fn=lambda i, f, ph=ph: (1 + 0.18 * math.sin(i * 1.3 + ph),
                                                              1 + 0.35 * math.sin(i * 0.9 + ph))))
    part(ns['join'](objs, name), bones=['Neck', 'Spine2', 'Head'], bias={'Neck': 2.0})


def scarf_tail(pts, width=0.085, name='ScarfTail', twist=0.25):
    tail = ns['sweep'](name, ns['catmull'](pts, 4), ns['rect_profile'](0.012, width, 0.004), M['tint'],
                       up_fn=lambda i: V((0, -1, 0.15)),
                       scale_fn=lambda i, f: (1.0, 0.85 + 0.25 * f + 0.06 * math.sin(i * 2.1)),
                       twist_fn=lambda i, f: twist * math.sin(f * 4))
    part(tail, bones=['Spine2', 'Spine1', 'Neck'], bias={'Spine2': 2.0})


# loops sit low at the front (tilt) (the original's values)
LOOPS = ((1.535, 0.05, 0.122, 0.128, 0.066, 0.0), (1.58, 0.04, 0.108, 0.118, 0.058, 1.7))


def scarf_long():
    # wound twice, both ends hanging long down the chest, crossing
    scarf_loops(LOOPS)
    scarf_tail([(0.035, -0.105, 1.545), (0.065, -0.17, 1.48), (0.10, -0.228, 1.39), (0.118, -0.25, 1.25),
                (0.125, -0.26, 1.10), (0.13, -0.262, 0.98)])
    scarf_tail([(-0.03, -0.11, 1.55), (-0.06, -0.18, 1.47), (-0.075, -0.236, 1.37), (-0.07, -0.252, 1.26),
                (-0.06, -0.258, 1.16)], width=0.075, name='ScarfTail2', twist=-0.3)


def scarf_snood():
    # a fat bunched tube collar up to the chin, no ends
    scarf_loops(((1.515, 0.03, 0.135, 0.142, 0.07, 0.0), (1.555, 0.03, 0.128, 0.136, 0.07, 1.1),
                 (1.595, 0.02, 0.116, 0.126, 0.06, 2.3), (1.625, 0.01, 0.104, 0.115, 0.05, 3.1)), 'Snood')


def scarf_bib():
    # a cloth knotted at the neck, its point hanging over the chest like a bandana
    scarf_loops(LOOPS[1:])
    rings = []
    for z, r, half in ((1.565, 0.112, 75), (1.52, 0.128, 62), (1.47, 0.142, 46), (1.42, 0.15, 28), (1.375, 0.153, 6)):
        rr = ring((0, 0.004, z), r, r * 1.04, 15, a0=math.radians(270 - half), a1=math.radians(270 + half),
                  closed=False, fn=lambda t, k, z=z: 1 + 0.03 * math.sin(t * 9 + z * 50))
        rings.append(rr)
    tattered(rings[-1], 0.01, seed=5.0)
    part(loft('Bib', rings, M['tint'], closed=False), bones=['Spine2', 'Neck'], bias={'Spine2': 2.0})


def scarf_veil():
    # the scarf's end pulled up over the head wrap and hanging as a veil across the face, under the goggles
    scarf_loops(LOOPS)
    rings = []
    for z, r, half, fwd in ((1.66, 0.104, 80, 0.0), (1.62, 0.112, 78, 0.006), (1.575, 0.124, 74, 0.016),
                            (1.53, 0.134, 68, 0.024), (1.49, 0.14, 60, 0.03)):
        rings.append(ring((0, 0.004 - fwd, z), r, r * 1.12, 17, a0=math.radians(270 - half),
                          a1=math.radians(270 + half), closed=False,
                          fn=lambda t, k, z=z: 1 + 0.025 * math.sin(t * 11 + z * 60)))
    tattered(rings[-1], 0.012, seed=8.0)
    part(loft('Veil', rings, M['tint'], closed=False), bones=['Head', 'Neck'], bias={'Head': 2.5})


tattered = ns['tattered']
SCARF = {'scarf': ns['build_scarf'], 'long': scarf_long, 'snood': scarf_snood, 'bib': scarf_bib,
         'veil': scarf_veil, 'none': skip}

extras = [build_plate] if v.get('shoulder') == 'plate' else []
orig_scarf = SCARF[v.get('scarf', 'scarf')]


def build_scarf():
    orig_scarf()
    for f in extras:
        f()


ns['build_scarf'] = build_scarf


# ------------------------------------------------------------------------------------------- tunic
def torso_r(z):
    zs = [0.90, 1.00, 1.10, 1.21, 1.31, 1.39, 1.45, 1.50, 1.545, 1.585]
    rx = [0.172, 0.166, 0.158, 0.168, 0.178, 0.178, 0.162, 0.115, 0.074, 0.064]
    ry = [0.132, 0.126, 0.118, 0.124, 0.132, 0.128, 0.115, 0.088, 0.068, 0.062]
    for i in range(len(zs) - 1):
        if zs[i] <= z <= zs[i + 1]:
            f = (z - zs[i]) / (zs[i + 1] - zs[i])
            return rx[i] + (rx[i + 1] - rx[i]) * f, ry[i] + (ry[i + 1] - ry[i]) * f
    return rx[0], ry[0]


def build_cross():
    # a wrap tunic: two broad panels crossing over the chest from each shoulder down to the opposite hip
    for s, lift in ((1, 0.0), (-1, 0.007)):
        path = []
        for k in range(15):
            f = k / 14
            z = 1.53 - 0.48 * f
            rx, ry = torso_r(z)
            off = 0.016 + lift + 0.02 * max(0.0, 1 - f * 4)  # over the shoulder seam at the top
            x = s * (0.085 - 0.25 * f)
            a = -math.acos(max(-0.98, min(0.98, x / (rx + off))))
            path.append(V(((rx + off) * math.cos(a), (ry + off) * math.sin(a), z)))
        band = ns['sweep']('Crossover', path, ns['rect_profile'](0.16, 0.008, 0.002), M['wrap'],
                           up_fn=lambda i, path=path: V((path[i].x, path[i].y, 0)),
                           scale_fn=lambda i, f: (1 - 0.1 * f + 0.05 * math.sin(i * 1.7), 1.0))
        part(band, bones=['Spine', 'Spine1', 'Spine2', 'Hips'], bias={'Spine2': 1.2})


if v.get('tunic') == 'cross':
    extras.append(build_cross)


# ------------------------------------------------------------------------------------------- mask
def headwrap_nomask():
    n = len(ns['PARTS'])
    orig_headwrap()
    for e in [e for e in ns['PARTS'][n:] if e[0].name.startswith('FaceMask')]:
        ns['PARTS'].remove(e)
        bpy.data.objects.remove(e[0])


orig_headwrap = ns['build_headwrap']
if v.get('mask', True) is False:
    ns['build_headwrap'] = headwrap_nomask

import bpy  # noqa: E402

body, lens = ns['build_character']()


def drop_groups(obj, names):
    # what the game hides when you don't carry it: the pack (with its straps and gauge), the shovel, the scrap
    import bmesh
    idx = {obj.vertex_groups[n].index for n in names if n in obj.vertex_groups}
    if not idx:
        return
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    dl = bm.verts.layers.deform.active
    bmesh.ops.delete(bm, geom=[vt for vt in bm.verts if any(g in vt[dl] for g in idx)], context='VERTS')
    bm.to_mesh(obj.data)
    bm.free()


if v.get('carry') == 'light':
    for o in (body, lens):
        drop_groups(o, ['GearBack', 'GearShovel', 'GearScrap'])
ns['make_rig']([body, lens])
ns['clip']('Idle', 90, ns['idle'])
for pb in ns['RIG'].pose.bones:
    pb.rotation_quaternion = ns['Quaternion']()
    pb.location = V()
bpy.ops.wm.save_as_mainfile(filepath=OUT)
print('SAVED', OUT)
