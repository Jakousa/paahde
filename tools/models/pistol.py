# Scavenged laser pistol: an old .22 target pistol (Ruger-pattern) rebuilt into a blaster. Black steel frame and
# boxy upper with a round knurled bolt cap at the back, a steeply raked grip with checkered brown panels and a
# round medallion, a slim barrel into a ribbed black emitter shroud with a glowing red tip, a silver rod and
# cell tube along the top left, a long silver focusing rod down the right side, a small charge window on the
# left. Iron sights on top (a notched rear block, a blade on the shroud). ~0.28 m long, stylised.
#
# Used by hands.py (held in the right hand of the first-person viewmodel, node `Pistol`, a child of the right
# hand bone), which also bakes it and exports public/models/pistol.glb. Standalone (bake + pistol.glb only):
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/models/pistol.py
#
# Same frames as rifle.py: modelled in the "natural" frame (origin at the middle of the grip, where the fist
# closes, +Y forward along the bore, +Z up, +X the pistol's right); build() turns the mesh 180° about Z (FLIP),
# so in glTF the muzzle is +Z, up +Y. Materials are baked into one atlas ('Pistol'), except the emissive
# 'PistolGlow' (the tip, the lens and the charge window), which the game pulses.
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scmats  # noqa: E402
from sclib import NB, V, catmull, cylinder, join, loft, new_mat, rect_profile, rounded_box, srgb, sweep  # noqa: E402
from mathutils import Matrix  # noqa: E402
from rifle import aring, glow, tube, yring  # noqa: E402

FLIP = Matrix.Rotation(math.pi, 4, 'Z')

BZ = 0.064  # bore height above the grip origin
RAKE = 28  # grip rake (deg): its top leans forward
GRIP_R = 0.0155  # radius of the capsule the hand closes on (the grip is a little oval, 27 × 38 mm)
GRIP_TOP, GRIP_BOT = 0.046, -0.054  # grip extent along its axis from the origin
REC_Y0, REC_Y1 = -0.052, 0.104  # upper receiver
REC_Z0, REC_Z1 = 0.045, 0.081
REC_W = 0.023
EMIT_Y0, MUZZLE_Y = 0.142, 0.205  # ribbed shroud, red tip
SHROUD_R = 0.0135
REAR_Y = -0.040  # back face of the rear sight
SIGHT_Z = REC_Z1 + 0.0085  # the sight line: rear notch bottom, front blade top
TN = 16

TRIGGER = ((0, 0.040, REC_Z0 - 0.002), (0, 0.039, REC_Z0 - 0.012), (0, 0.034, REC_Z0 - 0.021))
GRIP_AXIS = V((0, math.sin(math.radians(RAKE)), math.cos(math.radians(RAKE))))  # bottom -> top


def grips(name='PistolGrips', base='#6a3a22', dark='#2e160a', light='#94603e'):
    """Checkered brown grip panels: a fine diamond knurl (two crossed wave bands), worn smooth and paler where
    the palm rubs, grime in the grooves."""
    m = new_mat(name)
    nb = NB(m)
    o = nb.obj()
    a = nb.wave(nb.mapping(o, rot=(math.radians(45), 0, 0)), scale=110.0, direction='Y', profile='SIN')
    b = nb.wave(nb.mapping(o, rot=(math.radians(-45), 0, 0)), scale=110.0, direction='Y', profile='SIN')
    knurl = nb.mul(nb.mr(a, 0.15, 0.6), nb.mr(b, 0.15, 0.6))
    wn = nb.noise(o, scale=30.0, detail=4.0, rough=0.6)
    worn = nb.mr(wn, 0.55, 0.75, 0.0, 0.7)
    col = nb.mix(nb.mr(knurl, 0.0, 1.0, 0.0, 0.6), srgb(dark), srgb(base))
    col = nb.mix(worn, col, srgb(light))
    col, cav = scmats._grime(nb, col, 0.7, 0.015)
    col, dfac = scmats._dust(nb, col, o, 0.4)
    r = nb.add(0.5, nb.mul(worn, -0.15), nb.mul(dfac, 0.3))
    h = nb.mul(knurl, nb.mr(worn, 0.0, 0.7, 1.0, 0.3))
    nb.principled(col, r, 0.0, nb.bump(h, strength=0.35, distance=0.0008))
    return m


def materials():
    return {
        'black': scmats.metal('PistolBlack', '#3a3b3d', '#1c1b1a', rough=0.4, dust=0.45, dirt=0.8, scratches=0.7),
        'steel': scmats.metal('PistolSteel', '#a9aaa6', '#5c5952', rough=0.3, dust=0.35, dirt=0.8, scratches=0.6),
        'grips': grips(),
        'rubber': scmats.plain('PistolRubber', '#1e1c1b', rough=0.75, dust=0.5),
        'glow': glow('PistolGlow', '#ff2e14', 5.0),
    }


def grip_ring(t, grow=0.0, n=TN):
    """Grip cross-section at `t` along GRIP_AXIS: oval, longer fore and aft, a little fuller low down."""
    f = (t - GRIP_BOT) / (GRIP_TOP - GRIP_BOT)
    rx = 0.0128 + 0.0012 * (1 - f) + grow
    ry = 0.0180 + 0.0012 * (1 - f) + grow
    side = V((1, 0, 0))
    fwd = (V((0, 1, 0)) - GRIP_AXIS * GRIP_AXIS.y).normalized()
    c = GRIP_AXIS * t
    return [c + side * (rx * math.cos(2 * math.pi * k / n)) + fwd * (ry * math.sin(2 * math.pi * k / n)) for k in range(n)]


def build_parts(M):
    objs, glows = [], []
    side = V((1, 0, 0))
    fwd = (V((0, 1, 0)) - GRIP_AXIS * GRIP_AXIS.y).normalized()
    # ---- grip: brown checkered panels, with a black frame round them (front and back straps, the heel)
    gr = [grip_ring(t) for t in (GRIP_BOT + 0.004, GRIP_BOT + 0.012, -0.02, 0.01, GRIP_TOP - 0.006, GRIP_TOP + 0.004)]
    objs.append(loft('Grip', gr, M['grips'], cap_start=True, cap_end=True))
    for s in (1, -1):  # front strap (fingers) and back strap (palm), proud of the panels
        pts = [GRIP_AXIS * t + fwd * (s * (0.0176 + 0.0012 * (1 - (t - GRIP_BOT) / (GRIP_TOP - GRIP_BOT))))
               for t in (GRIP_BOT + 0.002, -0.02, 0.01, GRIP_TOP + 0.004)]
        objs.append(sweep('Strap', catmull(pts, 2), rect_profile(0.021, 0.004, 0.0015), M['black'],
                          up_fn=lambda i: V((1, 0, 0))))
    objs.append(loft('Heel', [grip_ring(GRIP_BOT + 0.004, 0.0012), grip_ring(GRIP_BOT - 0.002, 0.0012),
                              grip_ring(GRIP_BOT - 0.005, -0.003)], M['black'], cap_end=True))
    for sx in (1, -1):  # medallion and the panel screw on both sides
        c = GRIP_AXIS * 0.012 + fwd * 0.002
        objs.append(cylinder('Medallion', c + side * sx * 0.012, c + side * sx * 0.0148, 0.0068, M['black'], n=14,
                             rings_extra=[(0.7, 1.0), (1.0, 0.8)]))
        c = GRIP_AXIS * -0.036 + fwd * -0.004
        objs.append(cylinder('Screw', c + side * sx * 0.012, c + side * sx * 0.0142, 0.0026, M['steel'], n=8))
    # ---- frame under the receiver, from the top of the grip forward under the barrel
    fr = [yring(y, 0, zc, 0.0108, hz, 3.0, TN) for y, zc, hz in
          ((-0.034, 0.044, 0.008), (-0.026, 0.043, 0.010), (0.085, 0.047, 0.010), (0.110, 0.052, 0.006),
           (0.116, 0.054, 0.003))]
    objs.append(loft('Frame', fr, M['black'], cap_start=True, cap_end=True))
    # ---- upper receiver: a box with rounded edges, bolt cap at the back, ejection port on the right
    rec = [yring(y, 0, (REC_Z0 + top) / 2, REC_W / 2, (top - REC_Z0) / 2, 4.0, 20) for y, top in
           ((REC_Y0, REC_Z1 - 0.004), (REC_Y0 + 0.004, REC_Z1), (REC_Y1 - 0.004, REC_Z1), (REC_Y1, REC_Z1 - 0.005))]
    objs.append(loft('Receiver', rec, M['black'], cap_start=True, cap_end=True))
    cz = BZ + 0.004
    objs.append(cylinder('BoltCap', (0, REC_Y0 + 0.002, cz), (0, REC_Y0 - 0.017, cz), 0.0105, M['steel'], n=16,
                         rings_extra=[(0.1, 1.03), (0.2, 1.0), (0.3, 1.03), (0.4, 1.0), (0.5, 1.03), (0.6, 1.0),
                                      (0.85, 0.98), (1.0, 0.75)]))
    objs.append(rounded_box('Port', (REC_W / 2 + 0.0004, 0.030, BZ + 0.004), (0.0016, 0.038, 0.011), M['rubber'],
                            bevel=0.0006, segments=1))
    for y in (-0.030, 0.088):  # pins through the frame
        for sx in (1, -1):
            objs.append(cylinder('Pin', (sx * 0.0105, y, REC_Z0 - 0.004), (sx * 0.0118, y, REC_Z0 - 0.004), 0.0022,
                                 M['steel'], n=6))
    # ---- iron sights: rear block with a notch, front blade on the shroud
    for sx in (1, -1):
        objs.append(rounded_box('RearSight', (sx * 0.0058, REAR_Y + 0.006, (REC_Z1 + SIGHT_Z + 0.004) / 2),
                                (0.0055, 0.012, SIGHT_Z + 0.004 - REC_Z1 + 0.002), M['black'], bevel=0.001, segments=1))
    objs.append(rounded_box('RearBase', (0, REAR_Y + 0.006, (REC_Z1 - 0.001 + SIGHT_Z) / 2),
                            (0.017, 0.012, SIGHT_Z - REC_Z1 + 0.001), M['black'], bevel=0.001, segments=1))
    ft = BZ + SHROUD_R
    objs.append(rounded_box('FrontSight', (0, MUZZLE_Y - 0.020, (ft + SIGHT_Z) / 2 - 0.001), (0.003, 0.010,
                            SIGHT_Z - ft + 0.002), M['black'], bevel=0.0008, segments=1))
    # ---- trigger guard + trigger
    tg = [V((0, 0.006, REC_Z0 - 0.002)), V((0, 0.012, REC_Z0 - 0.024)), V((0, 0.034, REC_Z0 - 0.034)),
          V((0, 0.060, REC_Z0 - 0.028)), V((0, 0.070, REC_Z0 - 0.004))]
    objs.append(sweep('Guard', catmull(tg, 3), rect_profile(0.008, 0.0028), M['black'], up_fn=lambda i: V((1, 0, 0))))
    objs.append(sweep('Trigger', catmull([V(p) for p in TRIGGER], 3), rect_profile(0.005, 0.003, 0.001), M['steel'],
                      up_fn=lambda i: V((1, 0, 0))))
    # ---- barrel, ribbed emitter shroud, red tip
    objs.append(tube('Barrel', [(REC_Y1 - 0.004, 0.0085), (EMIT_Y0 + 0.004, 0.0085)], M['black'], n=12, cz=BZ))
    objs.append(tube('Collar', [(EMIT_Y0 - 0.006, 0.0105), (EMIT_Y0 - 0.002, 0.0118), (EMIT_Y0 + 0.002, 0.0118)],
                     M['black'], n=16, cz=BZ))
    prof = [(EMIT_Y0, SHROUD_R - 0.002)]
    y = EMIT_Y0 + 0.002
    while y < MUZZLE_Y - 0.010:
        prof += [(y, SHROUD_R - 0.0015), (y + 0.0018, SHROUD_R), (y + 0.0042, SHROUD_R), (y + 0.006, SHROUD_R - 0.0015)]
        y += 0.0068
    prof.append((MUZZLE_Y - 0.008, SHROUD_R - 0.0015))
    objs.append(tube('Shroud', prof, M['rubber'], n=18, cz=BZ))
    glows.append(tube('Tip', [(MUZZLE_Y - 0.008, SHROUD_R - 0.0012), (MUZZLE_Y - 0.003, SHROUD_R - 0.0004),
                              (MUZZLE_Y, SHROUD_R - 0.0025), (MUZZLE_Y, 0.006)], M['glow'], n=18, cz=BZ, cap1=False))
    glows.append(loft('Lens', [yring(MUZZLE_Y, 0, BZ, 0.006, 0.006, 2, 12),
                               yring(MUZZLE_Y - 0.004, 0, BZ, 0.0025, 0.0025, 2, 12)], M['glow'], cap_end=True,
                      flip=True))
    # ---- top left: a silver cell tube on two clamps, and a thin rod beside it
    tz, tx = REC_Z1 + 0.004, -0.0105
    objs.append(cylinder('CellTube', (tx, -0.030, tz), (tx, 0.072, tz), 0.0058, M['steel'], n=12,
                         rings_extra=[(0.03, 1.12), (0.08, 1.12), (0.1, 1.0), (0.5, 1.0), (0.52, 0.85), (0.56, 0.85),
                                      (0.58, 1.0), (0.9, 1.0), (0.95, 0.8)]))
    for y in (-0.012, 0.050):
        objs.append(rounded_box('Clamp', (tx + 0.002, y, REC_Z1 + 0.001), (0.012, 0.008, 0.008), M['black'],
                                bevel=0.0015, segments=1))
    objs.append(cylinder('TopRod', (tx - 0.0055, 0.004, tz - 0.004), (tx - 0.0055, 0.098, tz - 0.004), 0.0022,
                         M['black'], n=8))
    # charge window on the left side of the receiver
    glows.append(rounded_box('Charge', (-REC_W / 2 - 0.0002, 0.050, BZ - 0.006), (0.0012, 0.026, 0.0045), M['glow'],
                             bevel=0.0004, segments=1))
    # ---- right side: a long silver focusing rod from over the grip to under the shroud, with a pointed tip
    a, b = V((0.0145, -0.012, REC_Z0 + 0.006)), V((0.0125, MUZZLE_Y - 0.035, BZ - 0.016))
    objs.append(cylinder('SideRod', a, b, 0.0034, M['steel'], n=10,
                         rings_extra=[(0.02, 1.15), (0.06, 1.15), (0.08, 1.0), (0.7, 1.0), (0.72, 1.2), (0.76, 1.2),
                                      (0.78, 0.9)]))
    objs.append(cylinder('RodTip', b, b + (b - a).normalized() * 0.018, 0.0030, M['steel'], n=10, r2=0.0004))
    for y in (0.0, 0.115):  # brackets holding it
        p = a.lerp(b, (y - a.y) / (b.y - a.y))
        objs.append(rounded_box('RodClip', (p.x - 0.002, y, p.z), (0.006, 0.006, 0.009), M['black'], bevel=0.0012,
                                segments=1))
    return objs, glows


def build(at=V((0, 0, 0))):
    """Build the pistol (joined mesh + the separate glow mesh) at `at`, turned to the mesh frame (muzzle -Y).
    Returns (pistol, glow)."""
    M = materials()
    objs, glows = build_parts(M)
    pistol = join(objs, 'Pistol')
    gl = join(glows, 'PistolGlowMesh')
    for o in (pistol, gl):
        for v in o.data.vertices:
            v.co = FLIP.to_3x3() @ v.co + V(at)
        o.data.update()
    return pistol, gl


def bake_and_export(pistol, gl, out_dir, path, at, size=1024):
    """Bake into its own atlas (material 'Pistol'), origin at the grip, join the unbaked glow (material
    'PistolGlow') and export it alone. Returns the pistol."""
    import bake
    import bpy
    bake.bake_atlas(pistol, size, out_dir, tint_name='__none__', small=512, prefix='pistol')
    me = pistol.data
    while len(me.materials) > 1:  # bake_atlas always adds a PlayerTint slot; there are no tint faces
        m = me.materials.pop(index=len(me.materials) - 1)
        if m and m.users == 0:
            bpy.data.materials.remove(m)
    for o in (pistol, gl):
        for v in o.data.vertices:
            v.co -= V(at)
        o.data.update()
        o.location = (0, 0, 0)
    uv = gl.data.uv_layers.get('Detail')
    if uv:
        uv.name = 'Atlas'
    pistol = join([pistol, gl], 'Pistol')
    bake.export(None, [pistol], path)
    return pistol


def muzzle_local():
    """Muzzle tip on the bore (natural frame)."""
    return V((0, MUZZLE_Y, BZ))


def eye_local(relief):
    """Where the eye goes: on the sight line, `relief` behind the rear sight (natural frame)."""
    return V((0, REAR_Y - relief, SIGHT_Z))


if __name__ == '__main__':
    import bpy  # noqa: F401
    from sclib import reset_scene, tri_count
    reset_scene()
    ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
    AT = V((0, 0, 0.9))
    p, g = build(AT)
    print('PISTOL TRIS', tri_count(p), 'GLOW', tri_count(g))
    bake_and_export(p, g, os.path.join(HERE, 'out'), os.path.join(ROOT, 'public', 'models', 'pistol.glb'), AT)
