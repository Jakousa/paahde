"""The jets (shared/jets.ts): a big twin-engined unmanned plane, 32 m span and 30 m long, flown over the desert and brought down by the
rifle. Its engines are the crashed turbofan's (tools/blender/machines/turbofan.py) as they were on the wing: the same cowls, the same
fan case, the same nozzle, with a simple mock of the fan and its spinner behind the intake lip. When one comes down the right engine
is torn off and lies beside the wreck as the real thing, to be taken apart (src/teardown).

    tools/blender/run.sh -b --python tools/blender/machines/plane.py [-- --preview dir]     # writes public/models/jet.glb

Three.js frame (Y up, +Z the nose, span along X), origin about the centre of mass, metres, turned into Blender's Z-up just before
export like the other models.

  Jet_Body     the fuselage, wings, tail and the left engine (what stays in the wreck)
  Jet_EngineR  the right engine on its pylon (hidden in the wreck: it lies on the ground as a machine)
  Tail         an empty at the left engine's exit, where the smoke streams from (src/world/jets.ts TAIL)
"""

import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kit  # noqa: E402
from kit import MB, PI, T, Rz  # noqa: E402

OUT = os.path.join(kit.ROOT, 'public', 'models')

MATERIALS = {
    'JetHull': (0x3a332d, 0.45, 0.6),
    'JetSand': (0x8a7556, 0.25, 0.75),
    'JetFlap': (0x2a2420, 0.45, 0.6),
    'JetDark': (0x15110f, 0.6, 0.45),
    'JetSteel': (0x6a6158, 0.8, 0.35),
    'JetBurnt': (0x3b2a22, 0.7, 0.5),
    'JetGlass': (0x0c0d10, 0.3, 0.1),
    'Paint': (0xbdb8a8, 0.15, 0.7),     # the engine's cowls, as turbofan.py
    'Steel': (0x8d8f91, 0.85, 0.42),
    'Dark': (0x3d3f43, 0.8, 0.5),
    'Burnt': (0x5b4a3e, 0.7, 0.55),
    'Blade': (0xa3a4a6, 0.9, 0.35),
}

# the engine's centre line on the wing (the turbofan's frame: axis Z, fan towards +Z)
ENG_X, ENG_Y, ENG_Z = 5.6, -2.05, 1.6
TAIL = (-ENG_X, ENG_Y, ENG_Z - 1.4)


def noise(x, z):
    return 0.5 + 0.5 * math.sin(x * 0.9 + math.sin(z * 0.4) * 2.0) * math.sin(z * 0.55 + x * 0.3)


def ring(rx, ry, z, cy=0.0, n=20, p=2.4):
    """A superellipse ring of half-width rx and half-height ry at z."""
    out = []
    for k in range(n):
        a = 2 * PI * k / n
        c, s = math.cos(a), math.sin(a)
        out.append((rx * math.copysign(abs(c) ** (2 / p), c), cy + ry * math.copysign(abs(s) ** (2 / p), s), z))
    return out


def fuselage(mb):
    # (z, half width, half height, centre y): a round tube with a drooped nose and a tail cone swept up
    st = [(15.0, 0.02, 0.02, -0.25), (14.6, 0.5, 0.5, -0.25), (13.4, 1.0, 1.05, -0.2), (11.0, 1.45, 1.5, -0.1), (7.0, 1.7, 1.75, 0.0),
          (0.0, 1.8, 1.85, 0.0), (-6.0, 1.7, 1.75, 0.05), (-10.0, 1.4, 1.45, 0.3), (-13.0, 0.9, 1.0, 0.7), (-15.0, 0.4, 0.5, 1.0)]
    rings = [ring(rx, ry, z, cy) for z, rx, ry, cy in st]
    nk = len(rings[0])

    def mat(i, k):
        z = st[i][0]
        a = 2 * PI * k / nk
        top = math.sin(a) > 0.2
        return 'JetSand' if top and noise(math.cos(a) * 3, z) < 0.42 else 'JetHull'

    mb.loft(rings, 'JetHull', cap0=True, cap1=True, matfn=mat)
    # a sensor ball under the chin, a satcom bulge over the shoulders, a chin radome in dark glass
    mb.sphere((0, -1.6, 11.8), 0.55, 'JetGlass', u=12, v=7)
    mb.sphere((0, 1.75, 8.5), 1.0, 'JetHull', u=14, v=7, scale=(1.0, 0.55, 2.2))
    mb.sphere((0, 0.2, 14.4), 0.52, 'JetDark', u=12, v=7, scale=(1, 0.9, 1.4))
    # panel lines round the fuselage
    for z in (12.2, 6.0, 0.0, -6.0, -10.0):
        i = min(range(len(st)), key=lambda q: abs(st[q][0] - z))
        _, rx, ry, cy = st[i]
        mb.loft([ring(rx * 1.004, ry * 1.004, z - 0.04, cy, 24), ring(rx * 1.004, ry * 1.004, z + 0.04, cy, 24)], 'JetDark')
    # antennas and probes
    mb.cyl((0, 1.9, 2.0), (0, 2.9, 2.0), 0.04, 0.02, segs=5, mat='JetSteel')
    mb.cyl((0, 1.9, -3.0), (0, 2.6, -3.1), 0.04, 0.02, segs=5, mat='JetSteel')
    mb.cyl((0.4, 0.0, 14.7), (0.4, 0.0, 17.0), 0.05, 0.015, segs=5, mat='JetSteel')


def surface(mb, sections, mat='JetHull', mirror=False, camo=True):
    """A wing or fin: sections (x, y, z of the leading edge, chord, thickness) from root to tip, flat on the bottom, with a flap strip."""
    rings = []
    for (x, y, z, ch, th) in sections:
        pts = [(x, y, z), (x, y + th * 0.9, z - ch * 0.18), (x, y + th, z - ch * 0.45), (x, y + th * 0.4, z - ch), (x, y - th * 0.3, z - ch), (x, y - th * 0.45, z - ch * 0.4)]
        rings.append(pts)
    if mirror:
        rings = [[(-p[0], p[1], p[2]) for p in reversed(r)] for r in rings]

    def m(i, k):
        if camo and k in (1, 2) and noise(i * 3.1 + rings[i][1][0], rings[i][1][2]) < 0.4:
            return 'JetSand'
        return 'JetFlap' if k in (3,) else mat
    mb.loft(rings, mat, cap0=True, cap1=True, matfn=m)


def wings(mb):
    for sgn in (1, -1):
        secs = []
        for s in (0.0, 0.18, 0.5, 0.82, 1.0):
            x = 1.5 + s * 14.6
            ch = 7.2 - 5.0 * s
            secs.append((x, -0.5 + 1.1 * s, 3.2 - 6.0 * s, ch, 0.95 - 0.65 * s))
        surface(mb, secs, mirror=sgn < 0)
        # winglet
        tip = secs[-1]
        surface(mb, [(tip[0], tip[1] - 0.05, tip[2] - 0.2, 1.6, 0.12), (tip[0], tip[1] + 1.7, tip[2] - 1.5, 0.9, 0.08)], mirror=sgn < 0)
        # tail plane
        surface(mb, [(1.2, 0.9, -11.2, 3.4, 0.45), (3.0, 1.15, -12.6, 2.2, 0.3), (5.6, 1.5, -14.3, 1.2, 0.18)], mirror=sgn < 0)
    # the fin and a ventral fin
    fin = [(0.0, 1.4, -8.2, 5.2, 0.4), (0.0, 4.2, -11.0, 3.4, 0.3), (0.0, 7.0, -13.2, 2.0, 0.2)]
    # a fin stands up in Y and is thin in X: its rings run along Y, so build it with the sections turned
    rings = []
    for (_, y, z, ch, th) in fin:
        rings.append([(0, y, z), (th * 0.9, y, z - ch * 0.18), (th, y, z - ch * 0.45), (th * 0.4, y, z - ch), (-th * 0.3, y, z - ch), (-th * 0.45, y, z - ch * 0.4)])
    mb.loft(rings, 'JetHull', cap0=True, cap1=True)


def engine(mb, cx, cy, cz, side):
    """The turbofan as it hung on the wing: the turbofan.py cowls and nozzle in one skin, a fan and its spinner in the intake, the pylon to the wing."""
    M = T(cx, cy, cz)
    outer = [(0.80, 1.10), (0.835, 1.20), (0.885, 1.14), (0.915, 0.94), (0.925, 0.75), (0.905, 0.52), (0.86, -0.05), (0.80, -0.30), (0.70, -0.62),
             (0.50, -0.85), (0.37, -1.12), (0.35, -1.20), (0.27, -1.34), (0.255, -1.40)]
    mb.lathe(outer, 36, 'Paint', M=M)
    # inside the lip: the dark intake, the fan disc with its blades, the spinner
    mb.lathe([(0.0, 0.93), (0.78, 0.93), (0.78, 0.96), (0.0, 0.96)], 28, 'Dark', M=M)
    mb.lathe([(0.0, 0.96), (0.1, 0.99), (0.21, 1.06), (0.23, 1.1), (0.205, 1.18), (0.0, 1.24)], 20, 'Steel', M=M)
    for i in range(24):
        a = 2 * PI * i / 24
        mb.push(M @ Rz(a))
        mb.box((0.5, 0.0, 0.97), (0.55, 0.012, 0.13), 'Blade', rot=(0, 0.0, 0.5))
        mb.pop()
    # the burnt nozzle ring and the plug
    mb.lathe([(0.255, -1.40), (0.255, -1.43), (0.27, -1.43), (0.27, -1.34)], 18, 'Burnt', M=M)
    mb.lathe([(0.0, -1.12), (0.12, -1.12), (0.13, -1.25), (0.0, -1.46)], 16, 'Burnt', M=M)
    # the pylon up into the wing, a fairing along it
    top = 0.92
    mb.box((cx, cy + top + 0.55, cz - 0.4), (0.38, 1.35, 3.2), 'JetHull', taper=(1.0, 0.7))
    # the nacelle's own mounting ring where it meets the pylon
    mb.lathe([(0.915, 0.18), (0.94, 0.18), (0.94, 0.05), (0.915, 0.05)], 36, 'Dark', M=M)


def build():
    body, eng = MB(), MB()
    fuselage(body)
    wings(body)
    engine(body, -ENG_X, ENG_Y, ENG_Z, -1)
    engine(eng, ENG_X, ENG_Y, ENG_Z, 1)
    return body, eng


def make(mb, name):
    import bmesh
    bmesh.ops.transform(mb.bm, matrix=kit.C, verts=mb.bm.verts)
    bmesh.ops.recalc_face_normals(mb.bm, faces=mb.bm.faces)
    mb.bm.normal_update()
    mesh = bpy.data.meshes.new(name)
    mb.bm.to_mesh(mesh)
    mb.bm.free()
    for m in mb.mats:
        mesh.materials.append(bpy.data.materials[m])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def preview(objs, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    scene, cam, look, shoot = kit.preview_scene(ground_y_blender=-20)
    for name, pos, tgt, lens in (
        ('side', (40, 4, 6), (0, 0, 0), 38),
        ('front', (6, 3, 42), (0, -1, 0), 38),
        ('top', (3, 52, 6), (0, 0, 0), 38),
        ('engine', (-12, -2, 12), (-5.6, -2, 1.6), 40),
    ):
        look(pos, tgt, lens)
        shoot(os.path.join(out_dir, f'plane_{name}.png'))


def main():
    a = kit.args()
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    for name, spec in MATERIALS.items():
        kit.make_material(name, *spec)
    body, eng = build()
    objs = [make(body, 'Jet_Body'), make(eng, 'Jet_EngineR')]
    tail = bpy.data.objects.new('Tail', None)
    tail.location = kit.C @ Vector(TAIL)
    bpy.context.scene.collection.objects.link(tail)
    os.makedirs(OUT, exist_ok=True)
    kit.export_glb(objs + [tail], os.path.join(OUT, 'jet.glb'))
    for o in objs:
        print(f'{o.name}: tris={kit.tri_count(o)} size={o.dimensions.x:.1f} x {o.dimensions.z:.1f} x {o.dimensions.y:.1f} m')
    if a.preview:
        preview({o.name: o for o in objs}, os.path.abspath(a.preview))


main()
