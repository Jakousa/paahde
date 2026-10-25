"""Placeable things crafted at the workbench (GitHub issues #22-#24): the plant bed and the UV lamp stand, and the
buildings (shared/gear.ts built): the windmill and the battery station.

    blender -b --python tools/blender/placeables.py                       # models + icons
    blender -b --python tools/blender/placeables.py -- --preview out.png  # also a perspective preview render
    blender -b --python tools/blender/placeables.py -- --preview-buildings out.png  # the windmill and battery station

Writes public/models/placeables/<kind>.glb and public/icons/items/<kind>.png (at the item's grid shape, the same
camera and lighting as the part icons of tools/blender/items.py, whose helpers this imports; docs/icons.md).

plant_bed.glb holds three objects: `plant_bed` (the scrap-metal trough with soil) and the growth stages
`plant_bed_sprouts` and `plant_bed_grown`, which src/world/placed.ts shows or hides (shared/garden.ts stages).
uv_lamp.glb is a gantry whose legs straddle a bed's short ends (shared/placed.ts footprints match these
sizes); its tube's material is named Emit* so the bunker's material conversion keeps it glowing.
windmill.glb is a farm windmill of scrap on the sand: `windmill` (the lattice tower), `windmill_head` (child of the
tower, origin on the yaw axis at the tower's top: the generator, the tail) and `windmill_rotor` (child of the head,
origin at the hub, turning about glTF Z, its front). src/world/placed.ts turns the head into the wind and spins the rotor.
battery_station.glb: `battery_station` (skid, rack, charger box with its coils) and `battery_station_cell0`..`5`, one
per battery slot, shown only while that slot holds a battery.
power_pole.glb: a pole of welded scrap pipe on a concrete foot, crossarm and insulators up top.
Every electric thing has a connector: an insulator whose top is the socket the power lines hang from (shared/wires.ts
CONNECTORS: glTF (x, y, z) is Blender (x, -z, y)): the windmill's on a bracket off the tower, the battery station's on a
mast of pipe, the pole's on top.

Blender is Z-up; the glTF exporter converts to Y-up. Units are metres, origin at the centre of the footprint on
the floor, long side along X (glTF X). Output is deterministic.
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import items as it  # noqa: E402  (helpers only; items.py runs nothing on import)

ROOT = it.ROOT

MATERIALS = {
    'soil': (0x3b2416, 0.0, 1.0, 0),
    'soil_dark': (0x2a180e, 0.0, 1.0, 0),
    'leaf': (0x6d9a35, 0.0, 0.7, 0),
    'leaf_dark': (0x3e6b26, 0.0, 0.75, 0),
    'leaf_light': (0x9cc24a, 0.0, 0.65, 0),
    'stem_red': (0x8e3a3a, 0.0, 0.7, 0),
    'cable': (0x1c1c1e, 0.0, 0.6, 0),
    'EmitUV': (0xd25cff, 0.0, 0.3, 5),
    'EmitLed': (0x6cff7a, 0.0, 0.4, 3),
    'wood': (0x6e5236, 0.0, 0.9, 0),
    'wood_dark': (0x4a3522, 0.0, 0.95, 0),
    'concrete': (0x8d877c, 0.0, 0.95, 0),
    'paint_red_faded': (0x8a4636, 0.1, 0.85, 0),
    'paint_cream': (0xb9ad8e, 0.1, 0.85, 0),
    'insulator': (0x6d8a74, 0.0, 0.25, 0),
    'insulator_brown': (0x6b3f24, 0.0, 0.25, 0),
}


def insulator(mb, x, y, top, mat='insulator'):
    """A glass insulator on a steel pin, its top (the socket, a lug with a bolt) at height `top`."""
    mb.cyl(0.018, 0.018, 0.1, 6, (x, y, top - 0.17), 'steel_dull')
    for k, (r, z) in enumerate(((0.07, top - 0.115), (0.06, top - 0.075), (0.045, top - 0.04))):
        mb.cyl(r, r * 0.55, 0.035, 12, (x, y, z), mat)
    mb.cyl(0.03, 0.03, 0.03, 10, (x, y, top - 0.015), mat)
    mb.box((0.05, 0.012, 0.03), (x, y, top + 0.008), 'steel_dull')
    mb.cyl(0.007, 0.007, 0.05, 6, (x, y, top + 0.01), 'steel', rot=it.X90)

# Plant bed: outer size and soil height (shared/placed.ts uses BED = 1.6 x 0.8, 0.5 high).
BED_X, BED_Y, BED_H, SOIL = 1.6, 0.8, 0.5, 0.44
# UV lamp: legs at +-LEG_X straddle the bed's short ends; the tube hangs at about TUBE_Z.
LEG_X, LAMP_TOP, TUBE_Z = 0.94, 1.98, 1.86


def patch_wall(mb, rng, length, along_x, offset, mats):
    """One side of the trough from two or three overlapping sheets of different scrap, riveted at the seams,
    with stamped ribs across them."""
    n = len(mats)
    t = 0.025
    seg = length / n
    for i, m in enumerate(mats):
        c = -length / 2 + seg * (i + 0.5)
        w = seg + 0.04  # overlap the neighbour
        h = BED_H - 0.05 - rng(0, 0.03)
        size = (w, t, h) if along_x else (t, w, h)
        loc = (c, offset, 0.04 + h / 2) if along_x else (offset, c, 0.04 + h / 2)
        v = mb.box(size, loc, m, rot=(0, 0, rng(-0.01, 0.01)))
        if m.startswith('rust'):
            mb.jitter(v, rng, 0.004)
        # Two pressed ribs across each sheet.
        for z in (0.17, 0.33):
            rs = (w - 0.06, 0.012, 0.022) if along_x else (0.012, w - 0.06, 0.022)
            o = 0.012 if offset > 0 else -0.012
            rl = (c, offset + o, z) if along_x else (offset + o, c, z)
            mb.box(rs, rl, m)
        # Rivets down the seam to the next sheet.
        if i < n - 1:
            s = c + seg / 2
            for z in (0.1, 0.25, 0.4):
                o = 0.016 if offset > 0 else -0.016
                p = (s, offset + o, z) if along_x else (offset + o, s, z)
                mb.cyl(0.009, 0.007, 0.01, 6, p, 'steel_dull', rot=it.X90 if along_x else it.Y90)


def build_bed(mb, rng):
    hx, hy = BED_X / 2, BED_Y / 2
    patch_wall(mb, rng, BED_X - 0.06, True, -hy + 0.0125, ['paint_faded', 'rust', 'steel_dull'])
    patch_wall(mb, rng, BED_X - 0.06, True, hy - 0.0125, ['steel_dull', 'paint_faded_blue', 'rust_dark'])
    patch_wall(mb, rng, BED_Y - 0.06, False, -hx + 0.0125, ['rust', 'paint_faded'])
    patch_wall(mb, rng, BED_Y - 0.06, False, hx - 0.0125, ['paint_faded_blue', 'steel_dull'])
    # Angle-iron corner posts on little feet, and a rolled lip round the top.
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box((0.06, 0.06, BED_H + 0.02), (sx * (hx - 0.03), sy * (hy - 0.03), (BED_H + 0.02) / 2), 'rust_dark')
            mb.box((0.09, 0.09, 0.02), (sx * (hx - 0.03), sy * (hy - 0.03), 0.01), 'steel_dull')
    for sy in (-1, 1):
        mb.box((BED_X, 0.04, 0.025), (0, sy * (hy - 0.02), BED_H), 'steel_dull')
    for sx in (-1, 1):
        mb.box((0.04, BED_Y, 0.025), (sx * (hx - 0.02), 0, BED_H), 'steel_dull')
    # Soil, with a few clods.
    mb.box((BED_X - 0.08, BED_Y - 0.08, SOIL - 0.06), (0, 0, 0.06 + (SOIL - 0.06) / 2), 'soil')
    for i in range(9):
        x = -hx + 0.15 + (BED_X - 0.3) * rng()
        y = -hy + 0.12 + (BED_Y - 0.24) * rng()
        mb.blob(rng(0.02, 0.035), (x, y, SOIL - 0.005), 'soil_dark')


ROWS = (-0.2, 0.0, 0.2)


def build_sprouts(mb, rng):
    for y in ROWS:
        for i in range(7):
            x = -0.62 + i * 0.205 + rng(-0.03, 0.03)
            yy = y + rng(-0.02, 0.02)
            h = rng(0.05, 0.08)
            mb.cyl(0.004, 0.003, h, 4, (x, yy, SOIL + h / 2), 'leaf_dark')
            a = rng(0, math.pi)
            for s in (-1, 1):
                ca, sa = math.cos(a), math.sin(a)
                mb.box((0.045, 0.022, 0.004), (x + s * 0.02 * ca, yy + s * 0.02 * sa, SOIL + h),
                       'leaf_light', rot=(s * 0.35 * -sa, s * 0.35 * ca, a))


def build_grown(mb, rng):
    """Leafy greens: a rosette of tilted leaves per plant, alternating dark and light rows, red-stemmed chard
    in the middle row."""
    for r, y in enumerate(ROWS):
        for i in range(5):
            x = -0.58 + i * 0.29 + rng(-0.03, 0.03)
            yy = y + rng(-0.02, 0.02)
            n = 6
            for k in range(n):
                a = k / n * 2 * math.pi + rng(-0.3, 0.3)
                ca, sa = math.cos(a), math.sin(a)
                L = rng(0.1, 0.14)
                tilt = rng(0.55, 0.85)
                mat = 'leaf_dark' if (k + r) % 2 else ('leaf' if r != 1 else 'leaf_light')
                mb.box((L, 0.06, 0.008), (x + ca * L * 0.42, yy + sa * L * 0.42, SOIL + 0.06 + math.sin(tilt) * L * 0.4),
                       mat, rot=(0, -tilt, a))
                if r == 1:
                    mb.cyl(0.005, 0.005, 0.08, 4, (x + ca * 0.02, yy + sa * 0.02, SOIL + 0.04), 'stem_red',
                           rot=(-sa * 0.4, ca * 0.4, 0))
            # A tight heart in the middle.
            v = mb.blob(0.035, (x, yy, SOIL + 0.07), 'leaf_light')
            for p in v:
                p.co.z = SOIL + 0.07 + (p.co.z - SOIL - 0.07) * 1.4


def build_lamp(mb, rng):
    for sx in (-1, 1):
        x = sx * LEG_X
        # Square-tube leg on a flat foot with two braces.
        mb.box((0.05, 0.05, LAMP_TOP - 0.02), (x, 0, (LAMP_TOP - 0.02) / 2 + 0.02), 'paint_faded_blue' if sx < 0 else 'steel_dull')
        mb.box((0.08, 0.52, 0.03), (x, 0, 0.015), 'rust_dark')
        for sy in (-1, 1):
            it.wire(mb, [(x, sy * 0.24, 0.03), (x, sy * 0.02, 0.42)], 0.012, 6, 'steel_dull')
        mb.box((0.1, 0.1, 0.05), (x, 0, LAMP_TOP - 0.02), 'steel_dull')
    # Crossbar and the lamp hanging from it on two rods.
    mb.box((2 * LEG_X + 0.1, 0.06, 0.05), (0, 0, LAMP_TOP + 0.02), 'steel_dull')
    for sx in (-1, 1):
        mb.cyl(0.006, 0.006, LAMP_TOP - TUBE_Z - 0.03, 5, (sx * 0.6, 0, (LAMP_TOP + TUBE_Z) / 2), 'steel')
    mb.box((1.52, 0.2, 0.06), (0, 0, TUBE_Z + 0.03), 'plastic_dark', bevel=0.01)
    mb.box((1.48, 0.17, 0.02), (0, 0, TUBE_Z - 0.005), 'alu')
    # Two UV tubes under the reflector, in sight from the side, and a glowing slot along both faces.
    for sy in (-1, 1):
        mb.cyl(0.024, 0.024, 1.42, 8, (0, sy * 0.045, TUBE_Z - 0.035), 'EmitUV', rot=it.Y90)
        mb.box((1.4, 0.006, 0.014), (0, sy * 0.1, TUBE_Z + 0.03), 'EmitUV')
    for sx in (-1, 1):
        mb.box((0.04, 0.22, 0.09), (sx * 0.76, 0, TUBE_Z + 0.025), 'paint_faded')
    # Ballast box on the left leg with a green lamp; the wiring runs up to the tube and down to the floor,
    # where the spare cable lies coiled.
    bx = -LEG_X + 0.075
    mb.box((0.1, 0.09, 0.17), (bx, -0.02, 1.15), 'paint_faded', bevel=0.008)
    mb.cyl(0.011, 0.011, 0.01, 8, (bx + 0.051, -0.02, 1.2), 'EmitLed', rot=it.Y90)
    it.wire(mb, [(bx, -0.02, 1.24), (bx + 0.01, -0.04, 1.5), (-LEG_X + 0.04, -0.045, LAMP_TOP - 0.06),
                 (-0.7, -0.05, TUBE_Z + 0.07)], 0.008, 5, 'cable')
    it.wire(mb, [(bx, -0.02, 1.06), (bx + 0.02, -0.045, 0.6), (bx + 0.03, -0.06, 0.12), (bx + 0.08, -0.12, 0.012)],
            0.008, 5, 'cable')
    cx, cy = bx + 0.2, -0.2
    pts = [(cx + 0.11 * math.cos(a), cy + 0.08 * math.sin(a), 0.012 + 0.004 * k)
           for k in range(3) for a in [j / 8 * 2 * math.pi for j in range(9)]]
    it.wire(mb, [(bx + 0.08, -0.12, 0.012)] + pts, 0.008, 5, 'cable')


# ------------------------------------------------------------------------------------------------ windmill
# Tower: legs splay from +-LEG_FOOT at the sand to +-LEG_TOP at TOWER_H (shared/placed.ts: feet at +-0.95).
TOWER_H, LEG_FOOT, LEG_TOP = 6.8, 0.95, 0.28
# The rotor's hub, from the head's origin: out in front (Blender -Y, glTF +Z) and up.
HUB = (0.0, -0.78, 0.36)
ROTOR_R = 1.75


def leg_at(z, sx, sy):
    k = z / TOWER_H
    h = LEG_FOOT + (LEG_TOP - LEG_FOOT) * k
    return (sx * h, sy * h, z)


def build_tower(mb, rng):
    corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    mats = ['rust_dark', 'steel_dull', 'rust', 'paint_faded']
    for (sx, sy), m in zip(corners, mats):
        # Each leg: two lengths of scrap tube, joined by a sleeve a third of the way up.
        j = 2.3 + rng(-0.2, 0.2)
        it.wire(mb, [leg_at(0.05, sx, sy), leg_at(j, sx, sy)], 0.045, 6, m)
        it.wire(mb, [leg_at(j, sx, sy), leg_at(TOWER_H, sx, sy)], 0.04, 6, 'rust' if m != 'rust' else 'steel_dull')
        mb.cyl(0.06, 0.06, 0.16, 6, leg_at(j, sx, sy), 'steel_dull')
        # Footing: a lump of poured concrete with a bolted plate.
        x, y, _ = leg_at(0, sx, sy)
        v = mb.box((0.34, 0.34, 0.22), (x, y, 0.04), 'concrete', rot=(0, 0, rng(-0.2, 0.2)))
        mb.jitter(v, rng, 0.02)
        mb.box((0.2, 0.2, 0.02), (x, y, 0.16), 'rust_dark')
        for bx, by in ((-1, -1), (1, 1), (-1, 1), (1, -1)):
            mb.cyl(0.012, 0.012, 0.03, 6, (x + bx * 0.07, y + by * 0.07, 0.18), 'steel_dull')
    # Girts round the tower, and X braces of thin rod in each bay (one missing, one bent).
    levels = [0.35, 2.3, 4.2, 5.7, TOWER_H - 0.05]
    for z in levels:
        for i in range(4):
            a, b = corners[i], corners[(i + 1) % 4]
            it.wire(mb, [leg_at(z, *a), leg_at(z, *b)], 0.022, 5, 'steel_dull' if i % 2 else 'rust')
    for z0, z1 in zip(levels, levels[1:]):
        for i in range(4):
            a, b = corners[i], corners[(i + 1) % 4]
            if (z0, i) == (2.3, 1):
                continue
            it.wire(mb, [leg_at(z0 + 0.04, *a), leg_at(z1 - 0.04, *b)], 0.011, 4, 'rust_dark')
            mid = [(p + q) / 2 + (0.05 if (z0, i) == (4.2, 3) else 0) for p, q in zip(leg_at((z0 + z1) / 2, *a), leg_at((z0 + z1) / 2, *b))]
            it.wire(mb, [leg_at(z0 + 0.04, *b), mid, leg_at(z1 - 0.04, *a)], 0.011, 4, 'rust_dark')
    # A ladder up the south face (Blender -Y): two rails and rungs.
    for sx in (-1, 1):
        it.wire(mb, [(sx * 0.2, -LEG_FOOT - 0.02, 0.0), (sx * 0.16, -LEG_TOP - 0.06, TOWER_H - 0.2)], 0.016, 5, 'steel_dull')
    for k in range(1, 20):
        z = k * 0.33
        if z > TOWER_H - 0.3:
            break
        y = -(LEG_FOOT + (LEG_TOP - LEG_FOOT) * z / TOWER_H) - 0.02 + 0.04 * z / TOWER_H
        w = 0.2 - 0.04 * z / TOWER_H
        mb.cyl(0.012, 0.012, 2 * w, 5, (0, y, z), 'rust' if k % 3 else 'steel_dull', rot=it.Y90)
    # The top: a plate for the head's turntable to sit on.
    mb.box((2 * LEG_TOP + 0.14, 2 * LEG_TOP + 0.14, 0.05), (0, 0, TOWER_H), 'rust_dark')
    # The generator's cable (wound off a coil) spirals down one leg to a junction box at the foot, then into the sand.
    pts = []
    for k in range(29):
        z = TOWER_H - 0.1 - k * (TOWER_H - 1.0) / 28
        x, y, _ = leg_at(z, 1, 1)
        a = k * 1.3
        pts.append((x + 0.06 * math.cos(a) - 0.03, y + 0.06 * math.sin(a) - 0.03, z))
    it.wire(mb, pts, 0.012, 4, 'cable')
    x, y, _ = leg_at(0.8, 1, 1)
    mb.box((0.26, 0.14, 0.32), (x - 0.12, y - 0.18, 0.75), 'paint_faded', bevel=0.01)
    mb.box((0.22, 0.02, 0.06), (x - 0.12, y - 0.255, 0.86), 'label')
    it.wire(mb, [pts[-1], (x - 0.05, y - 0.12, 0.92)], 0.012, 4, 'cable')
    it.wire(mb, [(x - 0.12, y - 0.18, 0.58), (x - 0.14, y - 0.3, 0.25), (x - 0.25, y - 0.55, -0.05)], 0.014, 4, 'cable')
    # The connector (shared/wires.ts: glTF (0.98, 3.2, 0)): an arm of angle iron off a girt between the +X legs, an
    # insulator on its end, and the generator's line from it down to the junction box's cable.
    zc = 3.03
    h = LEG_FOOT + (LEG_TOP - LEG_FOOT) * zc / TOWER_H
    it.wire(mb, [(h, -h, zc), (h, h, zc)], 0.02, 5, 'rust_dark')
    mb.box((0.98 - h + 0.05, 0.05, 0.04), ((0.98 + h) / 2, 0, zc), 'steel_dull')
    it.wire(mb, [(h, 0.25, zc - 0.35), (0.9, 0.0, zc - 0.01)], 0.012, 4, 'rust_dark')
    insulator(mb, 0.98, 0.0, 3.2)
    it.wire(mb, [(0.98, 0.0, 3.205), (0.9, 0.08, 3.1), (h + 0.02, 0.2, 2.95), (h + 0.03, h - 0.05, 2.2)], 0.01, 4, 'cable')


def build_head(mb, rng):
    """About its own origin on the yaw axis: turntable, generator drum along the rotor's axis (Blender Y), tail."""
    mb.cyl(0.26, 0.24, 0.12, 12, (0, 0, 0.06), 'steel_dull')
    mb.cyl(0.2, 0.2, 0.05, 12, (0, 0, 0.14), 'rust_dark')
    # A riser up to the generator.
    mb.box((0.18, 0.3, 0.2), (0, 0, 0.24), 'rust')
    # The generator: a drum with cooling ribs and end caps, bolted to a saddle.
    gy = 0.0
    mb.cyl(0.21, 0.21, 0.78, 14, (0, gy - 0.12, HUB[2]), 'paint_faded_blue', rot=it.X90)
    for k in range(7):
        mb.cyl(0.225, 0.225, 0.025, 14, (0, gy - 0.44 + k * 0.1, HUB[2]), 'steel_dull', rot=it.X90)
    mb.cyl(0.17, 0.21, 0.08, 14, (0, gy - 0.55, HUB[2]), 'rust_dark', rot=it.X90)
    mb.cyl(0.21, 0.15, 0.1, 14, (0, gy + 0.32, HUB[2]), 'rust', rot=it.X90)
    # Its shaft out to the hub, through a bearing block.
    mb.box((0.18, 0.12, 0.18), (0, HUB[1] + 0.2, HUB[2]), 'steel_dull', bevel=0.01)
    mb.cyl(0.045, 0.045, 0.3, 8, (0, HUB[1] + 0.12, HUB[2]), 'steel', rot=it.X90)
    # A hand-painted number plate on the drum.
    mb.box((0.02, 0.22, 0.1), (0.215, -0.1, HUB[2] + 0.05), 'label', rot=(0, 0, 0))
    # Tail boom (two rods, braced) back to the vane: a patched sheet, faded paint and a rust panel.
    it.wire(mb, [(0, 0.3, HUB[2] + 0.08), (0, 2.25, HUB[2] + 0.22)], 0.03, 6, 'rust_dark')
    it.wire(mb, [(0, 0.3, HUB[2] - 0.12), (0, 1.8, HUB[2] + 0.12)], 0.022, 6, 'steel_dull')
    for y in (0.8, 1.3):
        it.wire(mb, [(0, y, HUB[2] - 0.08 + (y - 0.3) * 0.16), (0, y + 0.05, HUB[2] + 0.1 + (y - 0.3) * 0.075)], 0.012, 4, 'rust')
    mb.box((0.018, 0.75, 0.82), (0, 2.0, HUB[2] + 0.3), 'paint_cream')
    # The patches stand a clear 8 mm proud of the sheet on both faces: flush, they z-fight at range.
    mb.box((0.034, 0.32, 0.4), (0, 2.18, HUB[2] + 0.48), 'rust', rot=(0.05, 0, 0))
    mb.box((0.034, 0.3, 0.1), (0, 1.85, HUB[2] + 0.12), 'paint_red_faded')
    for y in (1.66, 2.34):
        for z in (0.0, 0.3, 0.6):
            mb.cyl(0.012, 0.012, 0.046, 6, (0, y, HUB[2] + z), 'steel_dull', rot=it.Y90)


def build_rotor(mb, rng):
    """About the hub, turning about Blender Y: a hub, two rings of strap, twelve pitched sheet-metal blades."""
    from mathutils import Matrix
    mb.cyl(0.13, 0.13, 0.16, 12, (0, 0, 0), 'rust_dark', rot=it.X90)
    mb.cyl(0.08, 0.05, 0.12, 12, (0, -0.13, 0), 'steel_dull', rot=it.X90)
    for r in (0.75, 1.45):
        mb.torus(r, 0.014, 32, 4, (0, 0.01, 0), 'steel_dull', rot=it.X90)
    n = 12
    for k in range(n):
        a = 2 * math.pi * k / n + rng(-0.02, 0.02)
        r0, r1 = 0.22, ROTOR_R - rng(0, 0.08)
        L = r1 - r0
        mat = ['paint_faded', 'rust', 'paint_red_faded', 'steel_dull'][k % 4]
        # A blade: a sheet widening to its tip, pitched about its own length, then swung round the hub.
        sec = []
        for t, w in ((0.0, 0.12), (1.0, 0.36)):
            z = r0 + L * t
            sec.append([(-w / 2, -0.006, z), (w / 2, -0.006, z), (w / 2, 0.006, z), (-w / 2, 0.006, z)])
        v = mb.loft(sec, mat)
        if mat.startswith('rust'):
            mb.jitter(v, rng, 0.004)
        m = Matrix.Rotation(a, 4, 'Y') @ Matrix.Rotation(0.42, 4, 'Z')
        bmesh.ops.transform(mb.bm, matrix=m, verts=v)
        # Its arm, a strip of flat bar from the hub to the outer ring.
        arm = mb.box((0.03, 0.012, 1.3), (0, 0.02, 0.15 + 0.65), 'rust_dark')
        bmesh.ops.transform(mb.bm, matrix=Matrix.Rotation(a, 4, 'Y'), verts=arm)


# ---------------------------------------------------------------------------------------------- battery station
# Footprint 1.5 x 0.8 m, 1.35 m high (shared/placed.ts). Cells on two shelves, three each (slots 0-2 low, 3-5 high).
BS_X, BS_Y = 1.5, 0.8
SHELVES = (0.2, 0.62)
CELL = (0.4, 0.5, 0.3)


def cell_at(i):
    return (-0.46 + (i % 3) * 0.46, -0.04, SHELVES[i // 3] + CELL[2] / 2 + 0.02)


def build_station(mb, rng):
    hx, hy = BS_X / 2, BS_Y / 2
    # The skid: three planks across two beams.
    for y in (-0.25, 0.25):
        mb.box((BS_X, 0.1, 0.08), (0, y, 0.04), 'wood_dark')
    for k, x in enumerate((-0.5, 0.0, 0.5)):
        v = mb.box((0.46, BS_Y, 0.035), (x, 0, 0.098), 'wood' if k != 1 else 'wood_dark', rot=(0, 0, rng(-0.01, 0.01)))
        mb.jitter(v, rng, 0.003)
    # Angle-iron corner posts and shelf rails, welded (lumps at the joints).
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box((0.05, 0.05, 1.0), (sx * (hx - 0.05), sy * (hy - 0.05), 0.115 + 0.5), 'rust_dark' if sx * sy > 0 else 'steel_dull')
    for z in (SHELVES[0], SHELVES[1], 1.1):
        for sy in (-1, 1):
            mb.box((BS_X - 0.06, 0.05, 0.04), (0, sy * (hy - 0.05), z), 'rust' if z != 1.1 else 'steel_dull')
        for sx in (-1, 1):
            mb.box((0.05, BS_Y - 0.06, 0.04), (sx * (hx - 0.05), 0, z), 'rust_dark')
            for sy in (-1, 1):
                mb.blob(0.03, (sx * (hx - 0.05), sy * (hy - 0.05), z), 'steel_dull')
    # Shelves: patched sheet.
    for z in SHELVES:
        mb.box((BS_X - 0.1, BS_Y - 0.1, 0.02), (0, 0, z + 0.01), 'steel_dull')
    # Top: a plate, the charger box (a repurposed ammo-box green cabinet), a gauge, a breaker lever.
    mb.box((BS_X - 0.04, BS_Y - 0.04, 0.03), (0, 0, 1.12), 'rust_dark')
    mb.box((0.72, 0.46, 0.2), (-0.2, 0.0, 1.235), 'paint_faded', bevel=0.012)
    mb.box((0.66, 0.02, 0.05), (-0.2, -0.235, 1.3), 'label')
    mb.cyl(0.06, 0.06, 0.02, 14, (0.0, -0.24, 1.22), 'steel_dull', rot=it.X90)
    mb.cyl(0.05, 0.05, 0.01, 14, (0.0, -0.252, 1.22), 'paint_cream', rot=it.X90)
    mb.box((0.004, 0.004, 0.04), (0.008, -0.258, 1.23), 'plastic_black', rot=(0, 0.6, 0))
    mb.box((0.04, 0.04, 0.1), (-0.45, -0.24, 1.2), 'plastic_black')
    mb.box((0.02, 0.02, 0.1), (-0.45, -0.27, 1.27), 'wire_red', rot=(0.5, 0, 0))
    # The charger's two coils (the wiring coils it was made with), lying on the plate by the box.
    for k, y in enumerate((-0.17, 0.17)):
        x = 0.46
        mb.cyl(0.11, 0.11, 0.02, 14, (x - 0.08, y, 1.24), 'rust_dark', rot=it.Y90)
        mb.cyl(0.11, 0.11, 0.02, 14, (x + 0.08, y, 1.24), 'rust_dark', rot=it.Y90)
        mb.cyl(0.085, 0.085, 0.15, 14, (x, y, 1.24), 'copper', rot=it.Y90)
        mb.box((0.18, 0.04, 0.02), (x, y, 1.145), 'steel_dull')
    it.wire(mb, [(0.46, -0.17, 1.33), (0.3, -0.12, 1.36), (0.14, -0.05, 1.3)], 0.01, 4, 'wire_red')
    it.wire(mb, [(0.46, 0.17, 1.33), (0.3, 0.12, 1.36), (0.14, 0.05, 1.3)], 0.01, 4, 'cable')
    # Bus cables down the back to each shelf, and a fat lead off the back for the windmill's line.
    for z in SHELVES:
        it.wire(mb, [(-0.66, 0.3, z + 0.36), (0.66, 0.3, z + 0.36)], 0.013, 5, 'wire_red')
        it.wire(mb, [(-0.66, 0.26, z + 0.33), (0.66, 0.26, z + 0.33)], 0.013, 5, 'cable')
    it.wire(mb, [(0.66, 0.3, SHELVES[0] + 0.36), (0.7, 0.32, 0.9), (0.62, 0.3, 1.15)], 0.013, 5, 'wire_red')
    it.wire(mb, [(-0.1, 0.24, 1.15), (-0.2, 0.36, 0.9), (-0.25, 0.39, 0.4), (-0.4, 0.38, 0.13)], 0.018, 5, 'cable')
    # The connector (shared/wires.ts: glTF (0.6, 3.25, -0.3)): a mast of two lengths of pipe clamped to the rack's back
    # corner post, an insulator on top, the line down it to the charger.
    mx, my = 0.6, 0.3
    mb.cyl(0.035, 0.035, 1.2, 8, (mx, my, 1.13 + 0.6), 'rust')
    mb.cyl(0.028, 0.028, 0.8, 8, (mx, my, 2.33 + 0.4), 'steel_dull')
    mb.cyl(0.045, 0.045, 0.08, 8, (mx, my, 2.33), 'rust_dark')
    for z in (0.5, 0.95):
        mb.box((0.16, 0.06, 0.04), (mx + 0.06, my + 0.02, z), 'steel_dull')
    it.wire(mb, [(mx, my, 1.13), (hx - 0.05, hy - 0.05, 1.0)], 0.02, 5, 'rust_dark')
    insulator(mb, mx, my, 3.25)
    pts = [(mx, my, 3.255), (mx + 0.06, my - 0.02, 3.15)]
    for k in range(8):
        z = 3.0 - k * 0.24
        pts.append((mx + 0.05 * (1 if k % 2 else -1), my - 0.045, z))
    pts += [(0.3, 0.1, 1.33), (0.14, 0.0, 1.32)]
    it.wire(mb, pts, 0.01, 4, 'cable')


# ---------------------------------------------------------------------------------------------- power pole
POLE_H, SOCKET_H = 4.4, 4.5


def build_pole(mb, rng):
    """Welded scrap pipe on a concrete foot, guy-braced, a crossarm with an insulator on top of the pole (the socket,
    shared/wires.ts: glTF (0, 4.5, 0)) and two spare ones on its ends."""
    v = mb.box((0.5, 0.5, 0.3), (0, 0, 0.05), 'concrete', rot=(0, 0, rng(-0.3, 0.3)))
    mb.jitter(v, rng, 0.02)
    for k, (z0, z1, r, m) in enumerate(((0.15, 1.6, 0.07, 'rust_dark'), (1.6, 3.0, 0.06, 'paint_faded'), (3.0, POLE_H, 0.05, 'rust'))):
        mb.cyl(r, r, z1 - z0, 10, (rng(-0.005, 0.005), 0, (z0 + z1) / 2), m)
        if k:
            mb.cyl(r + 0.02, r + 0.02, 0.1, 10, (0, 0, z0), 'steel_dull')
            mb.blob(0.035, (r + 0.01, 0, z0 + 0.05), 'steel_dull')
    # Three braces of rod from the foot up a metre.
    for a in (0.3, 2.4, 4.5):
        it.wire(mb, [(0.55 * math.cos(a), 0.55 * math.sin(a), 0.02), (0.07 * math.cos(a), 0.07 * math.sin(a), 1.1)], 0.015, 5, 'rust_dark')
        mb.box((0.12, 0.12, 0.04), (0.55 * math.cos(a), 0.55 * math.sin(a), 0.0), 'rust_dark')
    # Crossarm (angle iron), two braces, the insulators, a hand-painted plate and footholds.
    mb.box((1.2, 0.06, 0.06), (0, 0, 4.22), 'steel_dull')
    for s in (-1, 1):
        it.wire(mb, [(s * 0.45, 0, 4.2), (0, 0, 3.75)], 0.012, 4, 'rust_dark')
        insulator(mb, s * 0.55, 0, 4.4, 'insulator_brown')
    mb.cyl(0.05, 0.05, 0.06, 10, (0, 0, POLE_H), 'steel_dull')
    insulator(mb, 0, 0, SOCKET_H)
    mb.box((0.02, 0.18, 0.24), (0.06, 0, 2.2), 'hazard_yellow')
    mb.box((0.022, 0.12, 0.03), (0.062, 0, 2.25), 'plastic_black', rot=(0.5, 0, 0))
    for k in range(5):
        z = 1.4 + k * 0.45
        a = 1.0 + (k % 2) * math.pi
        mb.cyl(0.012, 0.012, 0.22, 5, (0.15 * math.cos(a), 0.15 * math.sin(a), z), 'steel_dull', rot=(0, math.pi / 2, a))


def build_cell(i):
    def fn(mb, rng):
        x, y, z = cell_at(i)
        w, d, h = CELL
        body = ['paint_blue', 'plastic_dark', 'red_deep', 'plastic_black', 'paint_faded_blue', 'plastic_dark'][i]
        mb.box((w - 0.04, d, h), (x, y, z), body, bevel=0.01)
        mb.box((w - 0.03, d + 0.01, 0.03), (x, y, z + h / 2 - 0.03), 'plastic_black')
        mb.box((w * 0.6, 0.01, 0.08), (x, y - d / 2 - 0.004, z), 'label')
        for sx, m in ((-1, 'term_red'), (1, 'term_black')):
            mb.cyl(0.022, 0.018, 0.04, 8, (x + sx * 0.12, y + 0.12, z + h / 2 + 0.02), m)
            # Strapped onto the bus behind.
            it.wire(mb, [(x + sx * 0.12, y + 0.12, z + h / 2 + 0.04), (x + sx * 0.12, y + 0.24, z + h / 2 + 0.05),
                         (x + sx * 0.14, y + 0.3 - (0.04 if sx > 0 else 0), z + h / 2 + 0.06)],
                    0.009, 4, 'wire_red' if sx < 0 else 'cable')
        # Its charge lamp on the front.
        mb.cyl(0.014, 0.014, 0.012, 8, (x + w / 2 - 0.07, y - d / 2 - 0.004, z + 0.08), 'EmitLed', rot=it.X90)
    return fn


def build_with_parent(name, fn, seed, parent=None, loc=(0, 0, 0)):
    obj = build(name, fn, seed)
    if parent:
        obj.parent = parent
    obj.location = loc
    return obj


def finish(mb, name):
    bmesh.ops.recalc_face_normals(mb.bm, faces=mb.bm.faces)
    mesh = bpy.data.meshes.new(name)
    mb.bm.normal_update()
    mb.bm.to_mesh(mesh)
    mb.bm.free()
    for m in mb.mats:
        mesh.materials.append(bpy.data.materials[m])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build(name, fn, seed):
    mb = it.MeshBuilder()
    fn(mb, it.Rng(seed))
    return finish(mb, name)


def export(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                              export_apply=True, export_materials='EXPORT', export_normals=True,
                              export_texcoords=False)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    preview = argv[argv.index('--preview') + 1] if '--preview' in argv else None
    preview_b = argv[argv.index('--preview-buildings') + 1] if '--preview-buildings' in argv else None
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in {**it.MATERIALS, **MATERIALS}.items():
        it.make_material(name, *spec)

    out = os.path.join(ROOT, 'public', 'models', 'placeables')
    icons = os.path.join(ROOT, 'public', 'icons', 'items')
    os.makedirs(out, exist_ok=True)
    bed = build('plant_bed', build_bed, 1)
    sprouts = build('plant_bed_sprouts', build_sprouts, 2)
    grown = build('plant_bed_grown', build_grown, 3)
    lamp = build('uv_lamp', build_lamp, 4)
    export([bed, sprouts, grown], os.path.join(out, 'plant_bed.glb'))
    export([lamp], os.path.join(out, 'uv_lamp.glb'))
    tower = build('windmill', build_tower, 5)
    head = build_with_parent('windmill_head', build_head, 6, tower, (0, 0, TOWER_H + 0.025))
    rotor = build_with_parent('windmill_rotor', build_rotor, 7, head, HUB)
    export([tower, head, rotor], os.path.join(out, 'windmill.glb'))
    station = build('battery_station', build_station, 8)
    cells = [build(f'battery_station_cell{i}', build_cell(i), 9 + i) for i in range(6)]
    export([station, *cells], os.path.join(out, 'battery_station.glb'))
    pole = build('power_pole', build_pole, 15)
    export([pole], os.path.join(out, 'power_pole.glb'))
    for o in (bed, sprouts, grown, lamp, tower, head, rotor, station, *cells, pole):
        d = o.dimensions
        print(f'{o.name}: tris={it.tri_count(o)} size={d.x:.3f} x {d.y:.3f} x {d.z:.3f} m')

    # Icons at each item's grid shape (shared/items.ts ITEMS sizes).
    cam = it.setup_render(bpy.context.scene, 128, 128)
    it.render_grid_icon(cam, [bed, grown], (3, 2), os.path.join(icons, 'plant_bed.png'))
    lamp.rotation_euler.z = math.radians(-60)  # end-on, so the wide gantry fits its tall 1 x 2 icon
    it.render_grid_icon(cam, [lamp], (1, 2), os.path.join(icons, 'uv_lamp.png'))
    lamp.rotation_euler.z = 0
    it.render_grid_icon(cam, [tower, head, rotor], (2, 3), os.path.join(icons, 'windmill.png'))
    it.render_grid_icon(cam, [station, *cells], (2, 2), os.path.join(icons, 'battery_station.png'))
    it.render_grid_icon(cam, [pole], (1, 3), os.path.join(icons, 'power_pole.png'))

    if preview_b:
        scene = bpy.context.scene
        for o in bpy.data.objects:
            o.hide_render = o not in (tower, head, rotor, station, *cells, pole)
        pole.location = (-3.0, -1.5, 0)
        cells[4].hide_render = True  # one slot empty
        station.location = (2.6, -1.2, 0)
        for c in cells:
            c.location = station.location
        head.rotation_euler = (0, 0, 0.5)
        rotor.rotation_euler = (0, 0.2, 0)
        scene.render.resolution_x, scene.render.resolution_y = 1200, 1400
        scene.render.film_transparent = False
        scene.render.use_freestyle = False
        bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
        bpy.context.active_object.data.materials.append(it.make_material('ground', 0xc2a27a, 0, 0.95, 0))
        cam.data.type = 'PERSP'
        cam.data.lens = 35
        cam.data.clip_end = 100
        it.aim(cam, Vector((1.0, 0, 3.4)), 13)
        scene.render.filepath = os.path.abspath(preview_b)
        bpy.ops.render.render(write_still=True)

    if preview:
        scene = bpy.context.scene
        for o in bpy.data.objects:
            o.hide_render = False
        sprouts.hide_render = True
        # The lamp over the bed, and a second bed beside it with sprouts.
        bed2 = bed.copy()
        sp2 = sprouts.copy()
        scene.collection.objects.link(bed2)
        scene.collection.objects.link(sp2)
        bed2.location = sp2.location = (0, 1.4, 0)
        sp2.hide_render = False
        scene.render.resolution_x, scene.render.resolution_y = 1400, 900
        scene.render.film_transparent = False
        scene.render.use_freestyle = False
        bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))
        bpy.context.active_object.data.materials.append(it.make_material('ground', 0x8a8378, 0, 0.9, 0))
        cam.data.type = 'PERSP'
        cam.data.lens = 40
        it.aim(cam, Vector((0, 0.6, 0.7)), 5.2)
        scene.render.filepath = os.path.abspath(preview)
        bpy.ops.render.render(write_still=True)


if __name__ == '__main__':  # (tools/blender/well.py imports the helpers)
    main()
