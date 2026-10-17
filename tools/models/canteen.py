# Old military water canteen: flattened kidney-shaped painted-steel body, short neck with a pale washer
# and a dark wooden stopper, wrapped in a khaki webbing cradle (band, bottom rim, cradle strap, front
# loop, side straps with buckles and D-rings for a carry strap). ~1.45k tris, stylised.
#
# Used by hands.py (held in the right hand of the first-person viewmodel, node `Canteen`), which also
# bakes it and exports public/models/canteen.glb. Standalone (bake + canteen.glb only):
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/models/canteen.py
#
# Local frame: origin at the bottom centre, +Z up (neck), width along X, thickness along Y with the
# convex front facing -Y (= +Z in three.js) and the concave back (worn against the hip) facing +Y.
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scmats  # noqa: E402
from sclib import NB, V, circle_profile, cylinder, join, loft, rect_profile, new_mat, rounded_box, srgb, sweep  # noqa: E402

RX, RY = 0.068, 0.034  # half width / half thickness of the body
KID = 0.011  # how far the back is pushed in (kidney shape)
N = 20  # ring resolution
# body profile: (z, x scale, y scale)
PROFILE = [(0.000, 0.70, 0.66), (0.006, 0.90, 0.88), (0.020, 0.97, 0.97), (0.050, 1.0, 1.0), (0.085, 1.0, 1.0),
           (0.108, 0.96, 0.98), (0.128, 0.86, 0.91), (0.145, 0.68, 0.77), (0.156, 0.47, 0.60),
           (0.163, 0.30, 0.47), (0.166, 0.215, 0.41)]
NECK_R = 0.0142
NECK_TOP = 0.181
HEIGHT = 0.209  # top of the stopper


def painted_steel(name='CanteenPaint', paint='#5c5236', bleach='#8f8462', steel='#6a665f'):
    """Olive-brown enamel over steel: mottled and sun-bleached, chipped to bare steel in scattered flecks
    and scratches, grime in the creases, a little desert dust."""
    m = new_mat(name)
    nb = NB(m)
    o = nb.obj()
    mott = nb.noise(o, scale=11.0, detail=5.0, rough=0.6)
    col = nb.mix(nb.mr(mott, 0.3, 0.75, 0.0, 1.0), srgb(paint), srgb('#463a26'))
    # sun bleaching: broad blotches, stronger on up-facing surfaces
    up = nb.mr(nb.sep(nb.geo('Normal'))['Z'], -0.3, 1.0, 0.15, 0.8)
    bl = nb.mr(nb.noise(o, scale=3.0, detail=2.0), 0.3, 0.8, 0.0, 0.55)
    col = nb.mix(nb.mul(bl, up), col, srgb(bleach))
    # chips: scattered flecks (the low-poly body is convex everywhere, so no Pointiness edge term)
    chips = nb.noise(o, scale=38.0, detail=6.0, rough=0.7)
    bare = nb.mr(chips, 0.655, 0.685, 0.0, 1.0)
    sc = nb.noise(nb.mapping(o, scale=(400.0, 20.0, 20.0), rot=(0.3, 0.7, 0.2)), scale=1.0, detail=1.0)
    scr = nb.mr(sc, 0.63, 0.69, 0.0, 0.6)
    col = nb.mix(nb.math('MAXIMUM', bare, scr), col, srgb(steel))
    ao = nb.ao(distance=0.02, samples=16)
    cav = nb.mr(ao, 0.3, 1.0, 1.0, 0.0)
    col = nb.mix(nb.mul(cav, 0.6), col, srgb('#2a1d12'), blend='MULTIPLY')
    z = nb.sep(o)['Z']
    low = nb.mr(z, 0.95, 0.9, 0.0, 1.0, smooth=True)
    dpatch = nb.mr(nb.noise(o, scale=9.0, detail=6.0, rough=0.65), 0.45, 0.75, 0.0, 0.35)
    dust = nb.mul(nb.math('MAXIMUM', low, nb.mul(up, 0.3)), dpatch)
    col = nb.mix(dust, col, srgb('#b3804f'))
    metal = nb.mixf(dust, nb.mul(nb.math('MAXIMUM', bare, scr), 0.9), 0.0)
    r = nb.add(nb.mixf(bare, 0.62, 0.38), nb.mr(mott, 0.0, 1.0, -0.06, 0.08), nb.mul(dust, 0.3))
    h = nb.add(nb.mul(nb.noise(o, scale=120.0, detail=2.0), 0.1), nb.mul(bare, -0.25))
    nb.principled(col, r, metal, nb.bump(h, strength=0.3, distance=0.002))
    return m


def materials():
    return {
        # sun-bleached olive-brown paint chipped to dark steel at the edges
        'paint': painted_steel(),
        'web': scmats.cloth('Webbing', '#a48d64', '#77654a', dust=0.8, weave=0.9, wrinkle=0.15, stains=0.4,
                            bleach='#c9b58e', bleach_amt=0.35),
        'cork': scmats.wood('Stopper', base='#4a2f1c', dark='#24150c'),
        'washer': scmats.plain('Washer', '#c9ad80', rough=0.7, dust=0.3),
        'steel': scmats.metal('Buckle', '#7a746a', '#3b2a1e', rough=0.42, scratches=0.7, dust=0.4),
    }


def _prof(z):
    for (z0, sx0, sy0), (z1, sx1, sy1) in zip(PROFILE, PROFILE[1:]):
        if z <= z1:
            f = (z - z0) / (z1 - z0)
            return sx0 + (sx1 - sx0) * f, sy0 + (sy1 - sy0) * f
    return PROFILE[-1][1:]


def _surf(theta, z, sx=None, sy=None):
    """Body surface point (local, before offset) at angle theta (0 = +X, -90° = front) and height z."""
    if sx is None:
        sx, sy = _prof(z)
    c, s = math.cos(theta), math.sin(theta)
    # slightly squarer than an ellipse
    c2 = math.copysign(abs(c) ** 0.92, c)
    s2 = math.copysign(abs(s) ** 0.92, s)
    x, y = c2 * RX * sx, s2 * RY * sy
    if s > 0:  # concave back, fading out towards the round neck
        k = KID * max(0.0, min(1.0, (0.15 - z) / 0.04)) * min(1.0, sx)
        y -= k * s ** 2
    return V((x, y, z))


def _surf_off(theta, z, off):
    """Surface point pushed outwards along the (numerical) surface normal."""
    p = _surf(theta, z)
    dt = _surf(theta + 0.01, z) - _surf(theta - 0.01, z)
    z0, z1 = max(0.0, z - 0.004), min(PROFILE[-1][0], z + 0.004)
    dz = _surf(theta, z1) - _surf(theta, z0)
    n = dt.cross(dz)
    if n.length < 1e-9:
        n = V((p.x, p.y, 0))
    return p + n.normalized() * off


def _band(name, z, h, mat, n=22, off=0.0022):
    pts = [_surf_off(2 * math.pi * k / n, z, off) for k in range(n)]
    c = V((0, 0, z))
    return sweep(name, pts, rect_profile(0.0032, h), mat, closed_path=True,
                 up_fn=lambda i: (pts[i] - c) * V((1, 1, 0)))


def build(offset=V((0, 0, 0))):
    """Build the canteen (one joined mesh, procedural materials, 'Detail' UVs) at `offset` (its bottom
    centre) with identity transform, as the bake expects. Returns the object."""
    M = materials()
    objs = []
    # ---- body + neck (one loft)
    rings = []
    for z, sx, sy in PROFILE:
        rings.append([_surf(2 * math.pi * k / N, z, sx, sy) for k in range(N)])
    for z, r in ((0.172, NECK_R), (NECK_TOP, NECK_R * 1.04)):
        rings.append([V((math.cos(2 * math.pi * k / N) * r, math.sin(2 * math.pi * k / N) * r, z)) for k in range(N)])
    objs.append(loft('CanteenBody', rings, M['paint'], cap_start=True, cap_end=True))
    # ---- washer ring + stopper
    objs.append(cylinder('Washer', (0, 0, NECK_TOP - 0.004), (0, 0, NECK_TOP + 0.004), 0.0178, M['washer'], n=14,
                         rings_extra=[(0.5, 1.05)]))
    objs.append(cylinder('Stopper', (0, 0, NECK_TOP + 0.003), (0, 0, HEIGHT), 0.0138, M['cork'], n=12, r2=0.0158,
                         rings_extra=[(0.85, 1.0), (0.97, 0.93)]))
    # ---- webbing harness
    objs.append(_band('Band', 0.056, 0.022, M['web']))
    objs.append(_band('Rim', 0.011, 0.019, M['web']))
    # cradle strap: front band → under the bottom → up the back to the band
    cr = []
    for z in (0.066, 0.045, 0.025, 0.008):
        cr.append(_surf_off(-math.pi / 2, z, 0.0038))
    cr.append(V((0, -RY * 0.55, -0.0035)))
    cr.append(V((0, RY * 0.55, -0.0035)))
    for z in (0.008, 0.025, 0.045, 0.066):
        cr.append(_surf_off(math.pi / 2, z, 0.0038))
    # (the strap runs in the YZ plane, so its width can simply follow X)
    objs.append(sweep('Cradle', cr, rect_profile(0.021, 0.0032), M['web'], up_fn=lambda i: V((1, 0, 0))))
    # front loop (a short tab folded into a loop above the band)
    lp = [_surf_off(-math.pi / 2, 0.06, 0.0060), _surf_off(-math.pi / 2, 0.085, 0.0055),
          _surf_off(-math.pi / 2, 0.104, 0.0062), _surf_off(-math.pi / 2, 0.111, 0.0085),
          _surf_off(-math.pi / 2, 0.106, 0.0115), _surf_off(-math.pi / 2, 0.094, 0.0105)]
    objs.append(sweep('Loop', lp, rect_profile(0.014, 0.0028), M['web'], up_fn=lambda i: V((1, 0, 0))))
    # side straps up to the shoulders, buckles, D-rings for the carry strap
    for sgn in (1, -1):
        th = 0.0 if sgn > 0 else math.pi
        sp = [_surf_off(th, z, 0.0042) for z in (0.045, 0.075, 0.100, 0.118, 0.130)]
        objs.append(sweep('SideStrap', sp, rect_profile(0.0032, 0.019), M['web'],
                          up_fn=lambda i, sp=sp: sp[i] * V((1, 1, 0)) + V((0, 0, 0.0))))
        top = _surf_off(th, 0.133, 0.006)
        objs.append(rounded_box('Buckle', top, (0.007, 0.027, 0.008), M['steel'], bevel=0.0))
        u = V((sgn * 0.55, 0, 1)).normalized()
        base = top + V((0, 0, 0.004))
        dp = [base + V((0, 0.0125 * math.cos(math.pi * k / 7), 0)) + u * (0.015 * math.sin(math.pi * k / 7))
              for k in range(8)]
        objs.append(sweep('DRing', dp, circle_profile(0.0019, 5), M['steel'], closed_path=True,
                          up_fn=lambda i: V((sgn, 0, 0))))
    can = join(objs, 'Canteen')
    for v in can.data.vertices:
        v.co += V(offset)
    return can


def bake_and_export(can, out_dir, path, offset, size=512):
    """Bake the canteen's materials into its own small atlas (material 'Canteen'), move the mesh so its
    origin is the bottom centre, and export it alone."""
    import bake
    import bpy
    bake.bake_atlas(can, size, out_dir, tint_name='__none__', small=0, prefix='canteen')
    me = can.data
    while len(me.materials) > 1:  # bake_atlas always adds a PlayerTint slot; the canteen has no tint faces
        m = me.materials.pop(index=len(me.materials) - 1)
        if m and m.users == 0:
            bpy.data.materials.remove(m)
    lo = min(v.co.z for v in me.vertices)
    for v in me.vertices:
        v.co -= V((offset[0], offset[1], lo))
    me.update()
    can.location = (0, 0, 0)
    bake.export(None, [can], path)
    return can


if __name__ == '__main__':
    import bpy  # noqa: F401
    from sclib import reset_scene, tri_count
    reset_scene()
    ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
    can = build(V((0, 0, 0.9)))
    print('CANTEEN TRIS', tri_count(can))
    bake_and_export(can, os.path.join(HERE, 'out'), os.path.join(ROOT, 'public', 'models', 'canteen.glb'),
                    (0, 0, 0.9))
