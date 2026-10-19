"""The hardware of the machines: the bolts, screws, latches, clamps, pins and connectors the disassembly works (src/teardown/hardware.ts
puts them on the steps of a model-built machine, src/teardown/glbMachine.ts says which goes where).

Every piece is a node of public/models/machines/hardware.glb, in metres, +Y out of the surface it sits on, and its origin is where it
turns or slides: a `<Name>` node is the seat that never moves (washer, boss, plate, socket), a `<Name>_Spin` node the part that
does (head, lever, T-bolt, pin), placed in the file at its pivot. Chunky on purpose (a bolt head is 5 cm across flats): hardware
the player can aim at from three metres. Each comes in a clean and a worn variant (`...B`) so a flange does not look stamped.

    tools/blender/run.sh -b --python tools/blender/machines/hardware.py [-- --preview dir]
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bmesh  # noqa: E402
import bpy  # noqa: E402
import kit  # noqa: E402
from kit import MB, Matrix, Vector, PI, make_material  # noqa: E402

OUT = os.path.join(kit.ROOT, 'public', 'models', 'machines')

MATERIALS = {
    'Zinc': (0x8f9296, 0.85, 0.45),
    'Oxide': (0x34373b, 0.8, 0.5),
    'Rust': (0x7a4426, 0.5, 0.9),
    'Steel': (0xa4a8ab, 0.9, 0.35),
    'Brass': (0xa98443, 0.9, 0.4),
    'Rubber': (0x16171a, 0.1, 0.7),
    'Orange': (0xc8661e, 0.2, 0.6),
    'Red': (0xa82a22, 0.1, 0.6),
    'Blue': (0x2e5aa8, 0.1, 0.6),
    'Yellow': (0xcfa326, 0.1, 0.6),
    'Green': (0x4f8a3a, 0.1, 0.6),
    'Dark': (0x17181a, 0.4, 0.7),
}

objects = []


def lathe_y(mb, profile, segs, mat, **kw):
    """MB.lathe turns about Z (the engine's axis); the hardware stands on +Y."""
    return mb.lathe(profile, segs, mat, M=kit.Rx(-PI / 2), **kw)


def emit(mb, name, pivot=(0, 0, 0)):
    """Make the object: the geometry (built in the node's own frame, three.js axes, origin at the seat) with its origin moved to `pivot`."""
    p = Vector(pivot)
    bmesh.ops.translate(mb.bm, vec=-p, verts=mb.bm.verts)
    bmesh.ops.transform(mb.bm, matrix=kit.C, verts=mb.bm.verts)
    mb.bm.normal_update()
    mesh = bpy.data.meshes.new(name)
    mb.bm.to_mesh(mesh)
    mb.bm.free()
    for m in mb.mats:
        mesh.materials.append(bpy.data.materials[m])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = kit.C @ p
    objects.append(obj)
    return obj


def hexhead(mb, r, h, mat, top=0.88, base=0.0, phase=0.0):
    """A hex head (r: corner radius) with its top chamfered in."""
    lathe_y(mb, [(r, base), (r, h * 0.8), (r * top, h)], 6, mat, phase=phase, cap=True)
    lathe_y(mb, [(0, base), (r, base)], 6, mat, phase=phase)


def bolt(variant):
    worn = variant == 'B'
    body = 'Rust' if worn else 'Oxide'
    head = 'Rust' if worn else 'Zinc'
    # seat: a washer on a raised boss, the paint worn round it
    s = MB()
    s.cyl((0, -0.004, 0), (0, 0.0, 0), 0.046, 0.046, segs=20, mat='Dark')
    s.cyl((0, 0, 0), (0, 0.005, 0), 0.037, 0.037, segs=20, mat=body)
    emit(s, f'Bolt{variant}')
    h = MB()
    hexhead(h, 0.031, 0.02, head, phase=0.2)
    h.box((0, 0.012, 0), (0.006, 0.006, 0.07), 'Dark')  # the cross-drilled hole for safety wire
    h.cyl((0, 0.02, 0), (0, 0.0215, 0), 0.012, 0.012, segs=8, mat='Dark')
    emit(h, f'Bolt{variant}_Spin', (0, 0.005, 0))


def screw(variant):
    worn = variant == 'B'
    s = MB()
    s.cyl((0, -0.003, 0), (0, 0.002, 0), 0.032, 0.032, segs=18, mat='Dark')
    emit(s, f'Screw{variant}')
    h = MB()
    lathe_y(h, [(0.027, 0.0), (0.027, 0.007), (0.02, 0.013), (0.0, 0.0145)], 14, 'Rust' if worn else 'Steel', cap=True)
    h.box((0, 0.0138, 0), (0.034, 0.003, 0.006), 'Dark')
    h.box((0, 0.0138, 0), (0.006, 0.003, 0.034), 'Dark')
    emit(h, f'Screw{variant}_Spin', (0, 0.002, 0))


def latch(variant):
    worn = variant == 'B'
    s = MB()
    s.box((0, 0.006, 0), (0.115, 0.012, 0.06), 'Rust' if worn else 'Oxide')
    s.box((0.045, 0.026, 0), (0.014, 0.03, 0.044), 'Zinc')  # the keeper the lever hooks over
    s.box((-0.045, 0.02, 0.026), (0.016, 0.02, 0.008), 'Zinc')  # the hinge cheeks
    s.box((-0.045, 0.02, -0.026), (0.016, 0.02, 0.008), 'Zinc')
    emit(s, f'Latch{variant}')
    h = MB()  # the lever, hinged at (-0.045, 0.02, 0) and lying toward +X (built where it sits: emit() moves the origin to the hinge)
    h.box((0.0, 0.02, 0), (0.095, 0.011, 0.038), 'Steel')
    h.box((0.048, 0.02, 0), (0.026, 0.018, 0.046), 'Orange')  # the grip end
    h.cyl((-0.045, 0.02, -0.022), (-0.045, 0.02, 0.022), 0.009, 0.009, segs=10, mat='Zinc')
    emit(h, f'Latch{variant}_Spin', (-0.045, 0.02, 0))


def clamp(variant):
    worn = variant == 'B'
    s = MB()
    s.box((0, 0.007, 0), (0.15, 0.014, 0.05), 'Rust' if worn else 'Zinc')  # the band, lying over the flange
    s.box((-0.055, 0.025, 0), (0.026, 0.04, 0.05), 'Oxide')  # the trunnion blocks the T-bolt passes through
    s.box((0.055, 0.025, 0), (0.026, 0.04, 0.05), 'Oxide')
    emit(s, f'Clamp{variant}')
    h = MB()  # the T-bolt and its wing nut, turned to open the band
    h.cyl((0, -0.01, 0), (0, 0.058, 0), 0.008, 0.008, segs=10, mat='Zinc')
    lathe_y(h, [(0.021, 0.045), (0.021, 0.062), (0.015, 0.066)], 8, 'Steel', cap=True)
    h.box((0, 0.056, 0), (0.07, 0.012, 0.014), 'Steel')  # the wings
    h.box((0, 0.062, 0), (0.014, 0.014, 0.014), 'Steel')
    emit(h, f'Clamp{variant}_Spin', (0, 0.0, 0))


def pin(variant):
    worn = variant == 'B'
    s = MB()
    s.cyl((0, 0.0, 0), (0, 0.006, 0), 0.034, 0.034, segs=16, mat='Rust' if worn else 'Oxide')
    s.box((0.03, 0.02, 0), (0.012, 0.03, 0.03), 'Zinc')  # ears the pin passes through
    s.box((-0.03, 0.02, 0), (0.012, 0.03, 0.03), 'Zinc')
    emit(s, f'Pin{variant}')
    h = MB()  # a quick-release pin: the shaft, a thumb button, a ring to pull it by
    h.cyl((0, -0.03, 0), (0, 0.062, 0), 0.0085, 0.0085, segs=10, mat='Steel')
    lathe_y(h, [(0.019, 0.05), (0.019, 0.066), (0.012, 0.072)], 10, 'Brass', cap=True)
    ring = h.sweep([(0.0, 0.074, 0.0), (0.03, 0.09, 0.0), (0.045, 0.1, 0.0), (0.03, 0.112, 0.0), (0.0, 0.094, 0.0)], 0.0032, 'Zinc')
    emit(h, f'Pin{variant}_Spin', (0, 0.006, 0))


def fitting(variant):
    worn = variant == 'B'
    s = MB()
    s.cyl((0, 0, 0), (0, 0.012, 0), 0.036, 0.036, segs=14, mat='Rust' if worn else 'Oxide')
    s.cyl((0, 0.012, 0), (0, 0.06, 0), 0.015, 0.015, segs=12, mat='Zinc')  # the stub the hose is on
    emit(s, f'Fitting{variant}')
    h = MB()
    hexhead(h, 0.032, 0.024, 'Rust' if worn else 'Brass', top=0.92, base=0.0, phase=0.1)  # the B-nut
    emit(h, f'Fitting{variant}_Spin', (0, 0.012, 0))


def plug():
    """A circular multi-pin connector's plug: a knurled coupling ring, a body, a backshell the cable leaves by (+Y), a strain relief."""
    p = MB()
    p.cyl((0, 0.0, 0), (0, 0.028, 0), 0.027, 0.027, segs=16, mat='Zinc')
    lathe_y(p, [(0.034, 0.002), (0.034, 0.02), (0.03, 0.024)], 16, 'Oxide', cap=True)  # the coupling ring
    for i in range(12):
        a = 2 * PI * i / 12
        p.box((0.034 * math.cos(a), 0.012, 0.034 * math.sin(a)), (0.006, 0.016, 0.006), 'Steel', rot=(0, -a, 0))
    lathe_y(p, [(0.026, 0.028), (0.022, 0.05), (0.013, 0.07)], 14, 'Oxide')
    p.cyl((0, 0.07, 0), (0, 0.098, 0), 0.013, 0.01, segs=10, mat='Rubber')
    emit(p, 'Plug')


def socket():
    s = MB()
    s.cyl((0, 0, 0), (0, 0.012, 0), 0.044, 0.044, segs=18, mat='Dark')
    s.cyl((0, 0.012, 0), (0, 0.032, 0), 0.031, 0.031, segs=16, mat='Zinc')
    s.cyl((0, 0.032, 0), (0, 0.034, 0), 0.02, 0.02, segs=12, mat='Dark')
    for i in range(4):
        a = 2 * PI * i / 4 + 0.4
        s.box((0.034 * math.cos(a), 0.011, 0.034 * math.sin(a)), (0.012, 0.01, 0.012), 'Zinc', rot=(0, -a, 0))
    emit(s, 'Socket')


def previews(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    scene, cam, look, shoot = kit.preview_scene()
    # lay the pieces out in a row for a look (the preview only: copies at offsets)
    names = ['BoltA', 'BoltB', 'ScrewA', 'LatchA', 'ClampA', 'PinA', 'FittingA']
    x = -0.55
    for n in names:
        for suffix in ('', '_Spin'):
            o = bpy.data.objects.get(n + suffix)
            if not o:
                continue
            o.location.x += x
        x += 0.18
    pl = bpy.data.objects['Plug']
    pl.location.x += 0.5
    so = bpy.data.objects['Socket']
    so.location.x += 0.7
    for i, (pos, tgt, lens) in enumerate((((-0.2, 0.55, 0.75), (-0.2, 0.02, 0.0), 32), ((0.45, 0.45, 0.6), (0.45, 0.03, 0.0), 40), ((0.05, 0.9, 0.05), (0.05, 0.0, 0.0), 28))):
        look(pos, tgt, lens)
        shoot(os.path.join(out_dir, f'hw_{i}.png'))


def main():
    a = kit.args()
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    for name, spec in MATERIALS.items():
        make_material(name, *spec)
    for v in ('A', 'B'):
        bolt(v)
        screw(v)
        latch(v)
        clamp(v)
        pin(v)
        fitting(v)
    plug()
    socket()
    os.makedirs(OUT, exist_ok=True)
    kit.export_glb(objects, os.path.join(OUT, 'hardware.glb'))
    for o in objects:
        print(f'{o.name}: tris={kit.tri_count(o)} at ({o.location.x:.3f}, {o.location.y:.3f}, {o.location.z:.3f})')
    if a.preview:
        previews(os.path.abspath(a.preview))


main()
