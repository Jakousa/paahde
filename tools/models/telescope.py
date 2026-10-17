# Old brass-and-leather spyglass: a leather-wrapped main barrel with brass bands, a flared brass objective
# cap with dark greenish glass at the front, and two polished brass draw tubes stepping down to a small
# eyepiece at the back. Stylised.
#
# Used by hands.py (held in the right hand of the first-person viewmodel, node `Telescope`, a child of the
# right hand bone), which also bakes it and exports public/models/telescope.glb. Standalone (bake +
# telescope.glb only):
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/models/telescope.py
#
# Local frame (Blender): origin on the axis at the grip (middle of the leather), tube along Y with the
# objective (front) at +Y and the eyepiece at -Y, +Z up. In the exported glTF (Y up) the objective faces -Z
# and the eyepiece +Z. ~0.33 m long drawn out, main barrel ~0.045 m thick.
#
# The two draw tubes are child nodes `TelescopeDraw1` (wide tube + its collar) and `TelescopeDraw2` (thin
# tube + eyepiece), modelled drawn out at position 0; moved COLLAPSED[i] along glTF +Z they nest inside the
# barrel (~0.2 m long). The game slides them (src/viewmodel.ts).
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from sclib import NB, V, join, loft, new_mat, srgb  # noqa: E402

TN = 18  # ring resolution
EYE_Y = -0.205  # eyepiece end (back)
# radius profiles (y, r), back to front
EYEPIECE = [(-0.199, 0.0055), (-0.203, 0.0075), (-0.205, 0.0100), (-0.2035, 0.0118), (-0.198, 0.0124),
            (-0.190, 0.0124), (-0.188, 0.0112)]
DRAW2 = [(-0.192, 0.0106), (-0.118, 0.0106)]  # thinnest draw tube
COLLAR2 = [(-0.123, 0.0106), (-0.121, 0.0134), (-0.112, 0.0137), (-0.110, 0.0127)]
DRAW1 = [(-0.114, 0.0136), (-0.046, 0.0136)]
COLLAR1 = [(-0.051, 0.0136), (-0.049, 0.0170), (-0.040, 0.0174), (-0.038, 0.0186), (-0.032, 0.0198),
           (-0.028, 0.0196)]
LEATHER = [(-0.030, 0.0196), (0.020, 0.0206), (0.094, 0.0214)]
OBJECTIVE = [(0.090, 0.0216), (0.093, 0.0232), (0.100, 0.0230), (0.112, 0.0238), (0.124, 0.0252),
             (0.128, 0.0258), (0.130, 0.0246), (0.130, 0.0222), (0.126, 0.0206)]
BANDS = (-0.018, 0.078)
COLLAPSED = (-0.075, -0.140)  # glTF z of TelescopeDraw1 / TelescopeDraw2 when pushed in  # thin brass bands round the leather
GRIP_R = 0.0206  # leather radius at the grip (origin)


def leather_r(y):
    for (y0, r0), (y1, r1) in zip(LEATHER, LEATHER[1:]):
        if y <= y1:
            return r0 + (r1 - r0) * (y - y0) / (y1 - y0)
    return LEATHER[-1][1]


def brass(name='Brass', base='#d9ad55', patina='#8a6a2c', dark='#2a1c0e'):
    """Polished brass at spyglass scale: bright and warm, a soft darker patina in patches, grime only in
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


def leather(name='TeleLeather', base='#5a2f22', dark='#3b1d14', worn='#8a5236'):
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


def _ring(y, r, n=TN):
    """Ring round the tube axis (along Y)."""
    return [V((math.cos(2 * math.pi * k / n) * r, y, math.sin(2 * math.pi * k / n) * r)) for k in range(n)]


def _tag(obj, group):
    obj.vertex_groups.new(name=group).add(list(range(len(obj.data.vertices))), 1.0, 'REPLACE')
    return obj


def build(at=V((0, 0, 0))):
    """Build the spyglass (one joined mesh, procedural materials, 'Detail' UVs) centred on `at` with
    identity transform, as the bake expects. Returns the object."""
    M = materials()
    objs = []
    objs.append(_tag(loft('Eyepiece', [_ring(y, r, 14) for y, r in EYEPIECE], M['brass']), 'Draw2'))
    objs.append(_tag(loft('EyeLens', [_ring(EYEPIECE[0][0], EYEPIECE[0][1] * 1.02, 10),
                                      _ring(EYEPIECE[0][0] + 0.001, 0.003, 10)], M['glass'], cap_end=True),
                      'Draw2'))
    objs.append(_tag(loft('Draw2', [_ring(y, r, 14) for y, r in DRAW2], M['brass']), 'Draw2'))
    objs.append(_tag(loft('Collar2', [_ring(y, r, 14) for y, r in COLLAR2], M['brass']), 'Draw1'))
    objs.append(_tag(loft('Draw1', [_ring(y, r) for y, r in DRAW1], M['brass']), 'Draw1'))
    objs.append(loft('Collar1', [_ring(y, r) for y, r in COLLAR1], M['brass']))
    objs.append(loft('Leather', [_ring(y, r) for y, r in LEATHER], M['leather']))
    for y in BANDS:
        r = leather_r(y)
        objs.append(loft('Band', [_ring(y - 0.002, r - 0.0004), _ring(y, r + 0.0011), _ring(y + 0.002, r - 0.0004)],
                         M['brass']))
    objs.append(loft('Objective', [_ring(y, r) for y, r in OBJECTIVE], M['brass']))
    ly, lr = OBJECTIVE[-1]
    objs.append(loft('ObjLens', [_ring(ly, lr * 1.02), _ring(ly - 0.003, lr * 0.55)], M['glass'],
                     cap_end=True, flip=True))
    tel = join(objs, 'Telescope')
    for v in tel.data.vertices:
        v.co += V(at)
    return tel


def bake_and_export(tel, out_dir, path, at, size=512):
    """Bake the spyglass's materials into its own small atlas (material 'Telescope'), move the mesh so its
    origin is the grip (see the local frame above), split off the draw tubes and export it alone. Returns
    [telescope, draw1, draw2]."""
    import bake
    import bpy
    bake.bake_atlas(tel, size, out_dir, tint_name='__none__', small=0, prefix='telescope')
    me = tel.data
    while len(me.materials) > 1:  # bake_atlas always adds a PlayerTint slot; there are no tint faces
        m = me.materials.pop(index=len(me.materials) - 1)
        if m and m.users == 0:
            bpy.data.materials.remove(m)
    for v in me.vertices:
        v.co -= V(at)
    me.update()
    tel.location = (0, 0, 0)
    parts = [tel] + [_split(tel, g) for g in ('Draw1', 'Draw2')]
    bake.export(None, parts, path)
    return parts


def _split(tel, group):
    """Separate the vertices of `group` into the child node Telescope<group>."""
    import bpy
    from sclib import select_only
    select_only([tel], tel)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='DESELECT')
    tel.vertex_groups.active_index = tel.vertex_groups[group].index
    bpy.ops.object.vertex_group_select()
    bpy.ops.mesh.separate(type='SELECTED')
    bpy.ops.object.mode_set(mode='OBJECT')
    part = next(o for o in bpy.context.selected_objects if o is not tel)
    part.name = part.data.name = 'Telescope' + group
    part.parent = tel
    part.matrix_parent_inverse.identity()
    part.matrix_basis.identity()
    return part


if __name__ == '__main__':
    import bpy  # noqa: F401
    from sclib import reset_scene, tri_count
    reset_scene()
    ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
    AT = V((0, 0, 0.9))
    t = build(AT)
    print('TELESCOPE TRIS', tri_count(t))
    bake_and_export(t, os.path.join(HERE, 'out'), os.path.join(ROOT, 'public', 'models', 'telescope.glb'), AT)
