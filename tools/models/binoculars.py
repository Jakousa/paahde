# Old brass-and-leather field binoculars: two short stubby barrels wrapped in worn dark reddish-brown
# leather, polished brass objective rims with dark greenish glass, two thin brass bands per barrel, rounded
# brass eyecups, and a brass centre hinge (two bridges + an axle) with a knurled focus wheel. Stylised.
#
# Used by hands.py (held in both hands of the first-person viewmodel, node `Binoculars`, a child of the
# right hand bone), which also bakes it and exports public/models/binoculars.glb. Standalone (bake +
# binoculars.glb only):
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/models/binoculars.py
#
# Local frame (Blender): origin midway between the two barrel axes at mid-length, barrels along Y with the
# objectives (front) at +Y and the eyepieces at -Y, the barrels side by side along X (right barrel at +X),
# +Z up (focus wheel on top). In the exported glTF (Y up) the objectives face -Z and the eyepieces +Z.
# ~0.11 m long, ~0.12 m across both objective rims, barrels ~0.045 m thick.
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from sclib import NB, V, join, loft, new_mat, rounded_box, srgb  # noqa: E402

BX = 0.0338  # barrel axis offset from the centre (x)
N = 16  # barrel ring resolution
EYE_Y = -0.0553  # eyepiece end (back)
OBJ_Y = 0.0556  # objective rim (front)
# barrel radius profile, back to front: brass eyecup + eyepiece tube + collar (y, r)
EYEPIECE = [(-0.0497, 0.0088), (-0.0533, 0.0107), (-0.0553, 0.0134), (-0.0546, 0.0156), (-0.0505, 0.0166),
            (-0.0445, 0.0163), (-0.0400, 0.0152), (-0.0368, 0.0152), (-0.0364, 0.0196), (-0.0318, 0.0199)]
LEATHER = [(-0.0335, 0.0189), (-0.010, 0.0204), (0.012, 0.0215), (0.027, 0.0221)]
OBJECTIVE = [(0.0250, 0.0226), (0.0340, 0.0237), (0.0455, 0.0251), (0.0522, 0.0262), (0.0556, 0.0253),
             (0.0556, 0.0229), (0.0512, 0.0214)]
BANDS = (-0.0165, 0.0105)  # thin brass bands round the leather
HINGE_Z = 0.0045  # axle height


def leather_r(y):
    for (y0, r0), (y1, r1) in zip(LEATHER, LEATHER[1:]):
        if y <= y1:
            return r0 + (r1 - r0) * (y - y0) / (y1 - y0)
    return LEATHER[-1][1]


def brass(name='Brass', base='#d9ad55', patina='#8a6a2c', dark='#2a1c0e'):
    """Polished brass at binocular scale: bright and warm, a soft darker patina in patches, grime only in
    the tight creases, fine scratches and a few dull dents."""
    m = new_mat(name)
    nb = NB(m)
    o = nb.obj()
    pat = nb.noise(o, scale=70.0, detail=5.0, rough=0.6)
    col = nb.mix(nb.mr(pat, 0.5, 0.75, 0.0, 0.6), srgb(base), srgb(patina))
    ao = nb.ao(distance=0.006, samples=16)
    cav = nb.mr(ao, 0.4, 1.0, 1.0, 0.0)
    col = nb.mix(nb.mul(cav, 0.75), col, srgb(dark), blend='MULTIPLY')
    sc = nb.noise(nb.mapping(o, scale=(2400.0, 120.0, 120.0), rot=(0.3, 0.7, 0.2)), scale=1.0, detail=1.0)
    scr = nb.mr(sc, 0.63, 0.7, 0.0, 0.5)
    col = nb.mix(scr, col, srgb('#f3d48c'), blend='LIGHTEN')
    r = nb.add(0.24, nb.mr(pat, 0.4, 0.8, 0.0, 0.18), nb.mul(cav, 0.3))
    metal = nb.mixf(cav, 1.0, 0.5)
    h = nb.add(nb.mul(nb.noise(o, scale=500.0, detail=2.0), 0.12), nb.mul(scr, -0.3))
    nb.principled(col, r, metal, nb.bump(h, strength=0.2, distance=0.0008))
    return m


def leather(name='BinoLeather', base='#5a2f22', dark='#3b1d14', worn='#8a5236'):
    """Dark reddish-brown pebbled leather, worn lighter and smoother in scattered rubbed patches, a little
    dark grime at the brass seams."""
    m = new_mat(name)
    nb = NB(m)
    o = nb.obj()
    mott = nb.noise(o, scale=60.0, detail=5.0, rough=0.6)
    col = nb.mix(nb.mr(mott, 0.3, 0.72), srgb(dark), srgb(base))
    grain = nb.voronoi(o, scale=2600.0, feature='DISTANCE_TO_EDGE', out='Distance')
    wear = nb.mr(nb.noise(o, scale=140.0, detail=4.0, rough=0.65), 0.55, 0.72, 0.0, 0.7)
    col = nb.mix(wear, col, srgb(worn))
    ao = nb.ao(distance=0.005, samples=16)
    cav = nb.mr(ao, 0.4, 1.0, 1.0, 0.0)
    col = nb.mix(nb.mul(cav, 0.7), col, srgb('#1a0c07'), blend='MULTIPLY')
    r = nb.add(0.66, nb.mul(wear, -0.22), nb.mr(mott, 0, 1, -0.05, 0.05))
    h = nb.add(nb.mr(grain, 0.0, 0.1, 0.0, 0.3), nb.mul(wear, -0.15))
    nb.principled(col, r, 0.0, nb.bump(h, strength=0.4, distance=0.0006))
    return m


def glass(name='LensGlass', tint='#0a1d19', edge='#163a44'):
    """Dark coated lens glass with a faint green-blue tint, a little bluer towards the rim."""
    m = new_mat(name)
    nb = NB(m)
    o = nb.obj()
    # the lenses are lofted rim → centre, so Detail v is the distance in from the rim
    v = nb.sep(nb.uv())['Y']
    col = nb.mix(nb.mr(v, 0.0, 0.004, 1.0, 0.0), srgb(tint), srgb(edge))
    col = nb.mix(nb.mr(nb.noise(o, scale=60.0, detail=3.0), 0.6, 0.85, 0.0, 0.08), col, srgb('#6b6a58'))  # smudges
    r = nb.add(0.05, nb.mr(nb.noise(o, scale=60.0, detail=3.0), 0.6, 0.85, 0.0, 0.12))
    nb.principled(col, r, 0.0)
    return m


def materials():
    return {
        'leather': leather(),
        'brass': brass(),
        'glass': glass(),
    }


def _ring(cx, y, r, n=N, fn=None):
    """Ring round a barrel axis (along Y) at x = cx."""
    pts = []
    for k in range(n):
        t = 2 * math.pi * k / n
        m = fn(t, k) if fn else 1.0
        pts.append(V((cx + math.cos(t) * r * m, y, math.sin(t) * r * m)))
    return pts


def _barrel(cx, M):
    objs = []
    # eyecup + eyepiece tube + collar; the eye lens fills the cup's inner lip
    objs.append(loft('Eyepiece', [_ring(cx, y, r) for y, r in EYEPIECE], M['brass']))
    objs.append(loft('EyeLens', [_ring(cx, EYEPIECE[0][0], EYEPIECE[0][1] * 1.02, 10),
                                 _ring(cx, EYEPIECE[0][0] - 0.0012, 0.005, 10)], M['glass'], cap_end=True))
    objs.append(loft('Leather', [_ring(cx, y, r) for y, r in LEATHER], M['leather']))
    for y in BANDS:
        r = leather_r(y)
        objs.append(loft('Band', [_ring(cx, y - 0.0017, r - 0.0004), _ring(cx, y, r + 0.0010),
                                  _ring(cx, y + 0.0017, r - 0.0004)], M['brass']))
    objs.append(loft('Objective', [_ring(cx, y, r) for y, r in OBJECTIVE], M['brass']))
    ly, lr = OBJECTIVE[-1]
    objs.append(loft('ObjLens', [_ring(cx, ly, lr * 1.02), _ring(cx, ly + 0.0022, lr * 0.55)], M['glass'],
                     cap_end=True, flip=True))
    return objs


def build(at=V((0, 0, 0))):
    """Build the binoculars (one joined mesh, procedural materials, 'Detail' UVs) centred on `at` with
    identity transform, as the bake expects. Returns the object."""
    M = materials()
    objs = []
    for cx in (BX, -BX):
        objs += _barrel(cx, M)
    # centre hinge: axle along Y with domed ends, two bridges to the barrels, knurled focus wheel
    ax = [(-0.0420, 0.0), (-0.0418, 0.0035), (-0.0405, 0.0058), (-0.0385, 0.0066), (0.0285, 0.0066),
          (0.0305, 0.0058), (0.0318, 0.0035), (0.0320, 0.0)]
    objs.append(loft('Axle', [[V((math.cos(2 * math.pi * k / 10) * r, y, HINGE_Z + math.sin(2 * math.pi * k / 10) * r))
                               for k in range(10)] for y, r in ax], M['brass']))
    for y, w, h in ((0.0215, 0.035, 0.0105), (-0.0280, 0.036, 0.0095)):
        objs.append(rounded_box('Bridge', (0, y, HINGE_Z - 0.0005), (w, 0.0065, h), M['brass'], bevel=0.0016,
                                segments=1))
    wheel = []
    for y, rm in ((-0.0150, 0.80), (-0.0142, 1.0), (-0.0038, 1.0), (-0.0030, 0.80)):
        wheel.append([V((math.cos(2 * math.pi * k / 20) * 0.0108 * rm * (1.0 if k % 2 else 0.9), y,
                         HINGE_Z + math.sin(2 * math.pi * k / 20) * 0.0108 * rm * (1.0 if k % 2 else 0.9)))
                      for k in range(20)])
    objs.append(loft('FocusWheel', wheel, M['brass'], cap_start=True, cap_end=True))
    bino = join(objs, 'Binoculars')
    for v in bino.data.vertices:
        v.co += V(at)
    return bino


def bake_and_export(bino, out_dir, path, at, size=512):
    """Bake the binoculars' materials into their own small atlas (material 'Binoculars'), move the mesh so
    its origin is the centre (see the local frame above), and export it alone."""
    import bake
    import bpy
    bake.bake_atlas(bino, size, out_dir, tint_name='__none__', small=0, prefix='binoculars')
    me = bino.data
    while len(me.materials) > 1:  # bake_atlas always adds a PlayerTint slot; there are no tint faces
        m = me.materials.pop(index=len(me.materials) - 1)
        if m and m.users == 0:
            bpy.data.materials.remove(m)
    for v in me.vertices:
        v.co -= V(at)
    me.update()
    bino.location = (0, 0, 0)
    bake.export(None, [bino], path)
    return bino


if __name__ == '__main__':
    import bpy  # noqa: F401
    from sclib import reset_scene, tri_count
    reset_scene()
    ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
    AT = V((0, 0, 0.9))
    b = build(AT)
    print('BINOCULARS TRIS', tri_count(b))
    bake_and_export(b, os.path.join(HERE, 'out'), os.path.join(ROOT, 'public', 'models', 'binoculars.glb'), AT)
