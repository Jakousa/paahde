"""The electric well (shared/wells.ts): a borehole with a submersible pump, put up with the wrench (shared/gear.ts built).

    blender -b --python tools/blender/well.py                     # model + icon
    blender -b --python tools/blender/well.py -- --preview out.png  # also a perspective preview render

Writes public/models/placeables/well.glb and public/icons/items/well.png (docs/icons.md), with the helpers of
tools/blender/placeables.py and tools/blender/items.py.

A cracked concrete pad; the steel bore casing with its bolted cap, the pump's cable going down through a gland in it;
the riser pipe up to a galvanised header tank on an angle-iron stand, and from its belly a downpipe with a valve to the
spigot over a drain in the pad. The pump's control box on a post with its lamp on top, the post carrying on up as a mast
for the power line (its insulator is the socket, shared/wires.ts CONNECTORS.well: glTF (x, y, z) is Blender (x, -z, y)).

Objects: `well` (all that), `well_lamp` (the lamp's lit glass, shown while the well has power), `well_drop` (a drop of
water at the spigot's mouth, which src/world/placed.ts lets fall again and again while it runs) and `well_wet` (the wet
patch on the pad under the spigot, shown while it runs). Sizes match shared/placed.ts PLACEABLES.well and
shared/wells.ts SPIGOT.

Blender is Z-up; the glTF exporter converts to Y-up. Units are metres, origin at the centre of the footprint on the
ground, long side along X. Output is deterministic.
"""

import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import items as it  # noqa: E402
import placeables as pl  # noqa: E402  (helpers only: it runs nothing on import)

MATERIALS = {
    'galv': (0x9aa2a2, 0.7, 0.5, 0),
    'galv_dark': (0x6f7676, 0.7, 0.6, 0),
    'paint_grey': (0x7c8380, 0.15, 0.7, 0),
    'lamp_off': (0x24382a, 0.0, 0.2, 0),
    'water': (0x8fd0e8, 0.0, 0.05, 0.6),
    'wet': (0x4a4640, 0.0, 0.25, 0),
    'drain': (0x2e2a26, 0.3, 0.8, 0),
    'crack': (0x5e5a52, 0.0, 1.0, 0),
}

# Footprint (shared/placed.ts PLACEABLES.well): 1.8 x 1.2 m, the pad.
PAD_X, PAD_Y, PAD_H = 1.8, 1.2, 0.14
CASING = (-0.2, 0.15)      # the bore casing's axis
CAP_Z = 0.62               # its cap's top
TANK = (0.5, 0.18, 1.5)    # the header tank's centre (lies along X)
TANK_R, TANK_L = 0.27, 0.66
STAND_Z = 1.2              # top of the tank's stand
SPIGOT = (0.6, -0.46, 0.78)  # the spigot's mouth (shared/wells.ts SPIGOT: glTF (0.6, 0.78, 0.46))
POST = (-0.68, -0.28)      # the control box's post, carrying on up as the mast
BOX_Z = 1.25               # the control box's centre
SOCKET_Z = 3.2             # the connector (shared/wires.ts CONNECTORS.well: glTF (-0.68, 3.2, 0.28))
LAMP = (POST[0], POST[1] - 0.02, BOX_Z + 0.27)  # the lamp's dome


def build_well(mb, rng):
    # The pad: poured round the casing, its edges crumbled, a crack across, a drain under the spigot.
    v = mb.box((PAD_X, PAD_Y, PAD_H), (0, 0, PAD_H / 2 - 0.04), 'concrete', bevel=0.03)
    mb.jitter(v, rng, 0.012)
    for k in range(3):
        x = rng(-0.8, 0.8)
        mb.box((0.008, rng(0.15, 0.3), 0.003), (x, rng(-0.3, 0.3), PAD_H - 0.039), 'crack', rot=(0, 0, rng(-0.8, 0.8)))
    mb.cyl(0.11, 0.11, 0.01, 12, (SPIGOT[0], SPIGOT[1], PAD_H - 0.035), 'drain')
    for k in range(4):
        mb.box((0.18, 0.012, 0.012), (SPIGOT[0], SPIGOT[1] - 0.06 + k * 0.04, PAD_H - 0.03), 'steel_dull')

    # The bore casing: a fat steel pipe out of the pad, a flange, the bolted cap; the pump's cable down through a gland.
    cx, cy = CASING
    mb.cyl(0.11, 0.11, CAP_Z - 0.08, 14, (cx, cy, (CAP_Z - 0.08) / 2), 'rust_dark')
    mb.cyl(0.15, 0.15, 0.04, 16, (cx, cy, CAP_Z - 0.06), 'steel_dull')
    mb.cyl(0.14, 0.13, 0.05, 16, (cx, cy, CAP_Z - 0.02), 'paint_faded_blue')
    for k in range(6):
        a = k * math.pi / 3 + 0.2
        mb.cyl(0.012, 0.012, 0.03, 6, (cx + 0.125 * math.cos(a), cy + 0.125 * math.sin(a), CAP_Z - 0.03), 'steel')
    mb.cyl(0.025, 0.02, 0.05, 8, (cx - 0.06, cy - 0.04, CAP_Z + 0.02), 'plastic_black')
    mb.box((0.1, 0.02, 0.06), (cx, cy + 0.15, 0.3), 'label')
    # The riser: up out of the cap, a check valve, up beside the stand, over and down into the tank's top.
    rz = TANK[2] + TANK_R + 0.16
    mb.cyl(0.035, 0.035, rz - CAP_Z, 10, (cx + 0.04, cy, (CAP_Z + rz) / 2), 'galv')
    mb.cyl(0.05, 0.05, 0.1, 10, (cx + 0.04, cy, CAP_Z + 0.2), 'brass')
    mb.cyl(0.045, 0.045, 0.06, 8, (cx + 0.04, cy, rz), 'galv_dark')
    mb.cyl(0.035, 0.035, TANK[0] - cx - 0.04, 10, ((cx + 0.04 + TANK[0]) / 2, cy, rz), 'galv', rot=it.Y90)
    mb.cyl(0.045, 0.045, 0.06, 8, (TANK[0], cy, rz), 'galv_dark')
    mb.cyl(0.035, 0.035, 0.16, 10, (TANK[0], cy, rz - 0.08), 'galv')
    for z in (0.95, 1.6):
        mb.box((0.08, 0.08, 0.03), (cx + 0.04, cy, z), 'steel_dull')

    # The tank's stand: four angle-iron legs, braced, a cradle on top.
    tx, ty, tz = TANK
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = tx + sx * 0.24, ty + sy * 0.2
            mb.box((0.045, 0.045, STAND_Z), (x, y, STAND_Z / 2 + 0.05), 'rust' if sx * sy > 0 else 'rust_dark')
            mb.box((0.1, 0.1, 0.012), (x, y, PAD_H - 0.03), 'steel_dull')
        it.wire(mb, [(tx + sx * 0.24, ty - 0.2, 0.25), (tx + sx * 0.24, ty + 0.2, 0.95)], 0.012, 4, 'rust_dark')
    for z in (0.6, STAND_Z):
        for sy in (-1, 1):
            mb.box((0.5, 0.04, 0.04), (tx, ty + sy * 0.2, z), 'rust_dark')
        for sx in (-1, 1):
            mb.box((0.04, 0.42, 0.04), (tx + sx * 0.24, ty, z), 'rust')
    for sx in (-1, 1):
        mb.box((0.05, 0.4, 0.08), (tx + sx * 0.2, ty, STAND_Z + 0.06), 'steel_dull')
    # The tank: a galvanised drum lying on the cradle, two straps, ribs, a filler cap.
    mb.cyl(TANK_R, TANK_R, TANK_L, 18, (tx, ty, tz), 'galv', rot=it.Y90)
    for sx in (-1, 1):
        mb.cyl(TANK_R + 0.01, TANK_R + 0.01, 0.03, 18, (tx + sx * (TANK_L / 2 - 0.03), ty, tz), 'galv_dark', rot=it.Y90)
        mb.cyl(TANK_R + 0.012, TANK_R + 0.012, 0.025, 18, (tx + sx * 0.2, ty, tz), 'rust_dark', rot=it.Y90)
    mb.box((0.25, 0.012, 0.12), (tx - 0.05, ty - TANK_R - 0.005, tz + 0.02), 'paint_faded_blue')
    mb.box((0.22, 0.014, 0.025), (tx - 0.05, ty - TANK_R - 0.008, tz + 0.03), 'label')
    # Its downpipe from the belly to the spigot, a valve with a red wheel on the way.
    sx_, sy_, sz_ = SPIGOT
    bz = tz - TANK_R
    mb.cyl(0.028, 0.028, bz - (sz_ + 0.12), 8, (sx_, ty, (bz + sz_ + 0.12) / 2), 'galv')
    mb.cyl(0.04, 0.04, 0.05, 8, (sx_, ty, sz_ + 0.12), 'galv_dark')
    mb.cyl(0.028, 0.028, ty - sy_ - 0.02, 8, (sx_, (ty + sy_) / 2, sz_ + 0.12), 'galv', rot=it.X90)
    mb.box((0.07, 0.08, 0.07), (sx_, sy_ + 0.25, sz_ + 0.12), 'brass')
    mb.cyl(0.006, 0.006, 0.08, 6, (sx_, sy_ + 0.25, sz_ + 0.19), 'steel')
    mb.torus(0.05, 0.008, 14, 6, (sx_, sy_ + 0.25, sz_ + 0.23), 'red_deep')
    mb.box((0.1, 0.012, 0.012), (sx_, sy_ + 0.25, sz_ + 0.23), 'red_deep')
    # The spigot: a bend down, its brass mouth.
    mb.cyl(0.04, 0.04, 0.05, 8, (sx_, sy_, sz_ + 0.12), 'galv_dark')
    mb.cyl(0.026, 0.022, 0.1, 8, (sx_, sy_, sz_ + 0.05), 'brass')
    mb.cyl(0.03, 0.03, 0.02, 8, (sx_, sy_, sz_ + 0.005), 'brass')

    # The control box's post: pipe in a concrete-filled foot, carrying on up as the mast, braced.
    px, py = POST
    mb.cyl(0.04, 0.04, 1.8, 10, (px, py, 0.9), 'paint_faded')
    mb.cyl(0.032, 0.032, SOCKET_Z - 1.8, 10, (px, py, (1.8 + SOCKET_Z) / 2), 'steel_dull')
    mb.cyl(0.05, 0.05, 0.08, 10, (px, py, 1.8), 'rust_dark')
    mb.cyl(0.09, 0.09, 0.06, 10, (px, py, PAD_H - 0.01), 'concrete')
    it.wire(mb, [(px + 0.25, py + 0.12, PAD_H - 0.04), (px, py, 0.7)], 0.012, 4, 'rust_dark')
    pl.insulator(mb, px, py, SOCKET_Z)
    # The control box: a grey steel cabinet with a hazard stripe, a label, a switch, its lamp's dome on top.
    mb.box((0.36, 0.18, 0.46), (px, py - 0.07, BOX_Z), 'paint_grey', bevel=0.012)
    mb.box((0.3, 0.012, 0.4), (px, py - 0.165, BOX_Z), 'paint_grey', bevel=0.004)
    mb.box((0.3, 0.013, 0.05), (px, py - 0.168, BOX_Z - 0.16), 'hazard_yellow')
    for k in range(4):
        mb.box((0.02, 0.014, 0.06), (px - 0.11 + k * 0.075, py - 0.17, BOX_Z - 0.16), 'plastic_black', rot=(0, 0.6, 0))
    mb.box((0.16, 0.014, 0.06), (px - 0.03, py - 0.17, BOX_Z + 0.1), 'label')
    mb.cyl(0.035, 0.035, 0.03, 12, (px + 0.09, py - 0.18, BOX_Z - 0.03), 'plastic_black', rot=it.X90)
    mb.box((0.012, 0.03, 0.06), (px + 0.09, py - 0.2, BOX_Z - 0.03), 'red_deep', rot=(0, 0.5, 0))
    mb.box((0.012, 0.03, 0.2), (px - 0.18, py - 0.16, BOX_Z), 'steel_dull')
    lx, ly, lz = LAMP
    mb.cyl(0.045, 0.05, 0.03, 12, (lx, ly, lz - 0.025), 'plastic_black')
    mb.lathe([(0, 0.0), (0.035, 0.0), (0.034, 0.03), (0.024, 0.06), (0, 0.07)], 12, (lx, ly, lz - 0.01), 'lamp_off')
    # Cables: the line down the mast into the box's top, the pump's cable out of its bottom in a loop to the gland.
    pts = [(px, py, SOCKET_Z + 0.005), (px + 0.05, py - 0.03, SOCKET_Z - 0.1)]
    for k in range(4):
        pts.append((px + 0.045 * (1 if k % 2 else -1), py - 0.045, SOCKET_Z - 0.35 - k * 0.32))
    pts.append((px + 0.08, py - 0.05, BOX_Z + 0.23))
    it.wire(mb, pts, 0.01, 4, 'cable')
    it.wire(mb, [(px + 0.1, py - 0.05, BOX_Z - 0.23), (px + 0.14, py - 0.03, 0.6), (px + 0.3, py + 0.1, 0.25),
                 (cx - 0.25, cy - 0.1, 0.2), (cx - 0.12, cy - 0.06, 0.45), (cx - 0.06, cy - 0.04, CAP_Z + 0.04)], 0.016, 6, 'cable')


def build_lamp(mb, rng):
    lx, ly, lz = LAMP
    mb.lathe([(0, 0.0), (0.038, 0.0), (0.037, 0.032), (0.026, 0.063), (0, 0.074)], 12, (lx, ly, lz - 0.012), 'EmitLed')


def build_drop(mb, rng):
    mb.lathe([(0, -0.018), (0.013, -0.009), (0.01, 0.009), (0, 0.024)], 8, (0, 0, -0.02), 'water')


def build_wet(mb, rng):
    sx, sy, _ = SPIGOT
    pts = []
    for k in range(10):
        a = k * 2 * math.pi / 10
        r = 0.17 + rng(-0.04, 0.05)
        pts.append((sx + r * math.cos(a) * 1.3, sy + 0.05 + r * math.sin(a)))
    vs = [mb.bm.verts.new((x, y, PAD_H - 0.032)) for x, y in pts]
    f = mb.bm.faces.new(vs)
    f.material_index = mb.mat('wet')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    preview = argv[argv.index('--preview') + 1] if '--preview' in argv else None
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in {**it.MATERIALS, **pl.MATERIALS, **MATERIALS}.items():
        it.make_material(name, *spec)
    out = os.path.join(it.ROOT, 'public', 'models', 'placeables')
    icons = os.path.join(it.ROOT, 'public', 'icons', 'items')
    os.makedirs(out, exist_ok=True)
    well = pl.build('well', build_well, 21)
    lamp = pl.build('well_lamp', build_lamp, 22)
    drop = pl.build('well_drop', build_drop, 23)  # (its origin at the spigot's mouth: it swells and falls from there)
    wet = pl.build('well_wet', build_wet, 24)
    for o in (lamp, drop, wet):
        o.parent = well
    drop.location = SPIGOT
    pl.export([well, lamp, drop, wet], os.path.join(out, 'well.glb'))
    for o in (well, lamp, drop, wet):
        d = o.dimensions
        print(f'{o.name}: tris={it.tri_count(o)} size={d.x:.3f} x {d.y:.3f} x {d.z:.3f} m')

    cam = it.setup_render(bpy.context.scene, 128, 128)
    it.render_grid_icon(cam, [well, lamp], (2, 2), os.path.join(icons, 'well.png'))

    if preview:
        scene = bpy.context.scene
        for o in bpy.data.objects:
            o.hide_render = False
        scene.render.resolution_x, scene.render.resolution_y = 1200, 1000
        scene.render.film_transparent = False
        scene.render.use_freestyle = False
        bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
        bpy.context.active_object.data.materials.append(it.make_material('ground', 0xc2a27a, 0, 0.95, 0))
        cam.data.type = 'PERSP'
        cam.data.lens = 35
        cam.data.clip_end = 100
        close = '--close' in argv
        it.aim(cam, Vector((0.3, -0.3, 0.9)) if close else Vector((0, 0, 1.4)), 3.2 if close else 6.5)
        scene.render.filepath = os.path.abspath(preview)
        bpy.ops.render.render(write_still=True)


main()
