"""Gear found broken on the sand (GitHub issue #8): world models and inventory icons.

    blender -b --python tools/blender/finds.py                        # models + icons
    blender -b --python tools/blender/finds.py -- --kind shovel       # just one (repeatable)
    blender -b --python tools/blender/finds.py -- --preview out.png   # also a perspective render of them on sand

Writes public/models/finds/<kind>.glb for the gear that had only a code-built stand-in (backpack, shovel, metal
detector, storm detector, wrist computer, jammer) and the boss receivers (receiver_<boss>), each already in the pose it lies in on the sand; src/world/loot.ts
sits it on the ground. The water bottle, telescope, laser rifle, laser pistol and motorcycle keep their models
(public/models/canteen.glb, telescope.glb, rifle.glb, pistol.glb, sandbike.glb): they are imported here only to
render their icons.

Icons: public/icons/items/<kind>.png for every piece of gear, at the item's grid shape (shared/items.ts sizes, two
pixels per CSS pixel of the Tab inventory's cells), transparent, with the part icons' lighting and outline
(tools/blender/items.py helpers), long things along the long side.

Blender is Z-up; the glTF exporter converts to Y-up. Units are metres. Output is deterministic.
"""

import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import items as it  # noqa: E402  (helpers only; items.py runs nothing on import)

ROOT = it.ROOT
D90 = math.pi / 2

MATERIALS = {
    'wood': (0x7a5434, 0.0, 0.85, 0),
    'wood_dark': (0x55361f, 0.0, 0.9, 0),
    'canvas': (0x8f7449, 0.0, 0.95, 0),
    'canvas_dark': (0x6b5434, 0.0, 0.95, 0),
    'canvas_green': (0x5f6446, 0.0, 0.95, 0),
    'blanket': (0x8a3f2c, 0.0, 0.95, 0),
    'leather': (0x5e3a22, 0.0, 0.7, 0),
    'strap': (0x3b2a1c, 0.0, 0.8, 0),
    'olive': (0x5a5440, 0.25, 0.75, 0),
    'olive_dark': (0x3e3a2c, 0.25, 0.8, 0),
    'orange_paint': (0xc4652a, 0.2, 0.6, 0),
    'rubber': (0x1e1c1a, 0.0, 0.9, 0),
    'detector_yellow': (0xd2a12c, 0.1, 0.55, 0),
    'glass_dark': (0x1a2a2c, 0.3, 0.2, 0),
    'EmitScreen': (0x5fe0b8, 0.0, 0.4, 1.2),
    'EmitAmber': (0xffa040, 0.0, 0.4, 1.5),
    # receivers' bodies, one per boss
    'rcv_carrier': (0x5a7272, 0.25, 0.65, 0),
    'rcv_carrier_dark': (0x2c3a3a, 0.3, 0.7, 0),
    'rcv_queen': (0x5c1a17, 0.2, 0.6, 0),
    'rcv_queen_dark': (0x2a0d0b, 0.25, 0.7, 0),
    'rcv_colossus': (0xa0521f, 0.35, 0.7, 0),
    'rcv_colossus_dark': (0x55280f, 0.4, 0.75, 0),
    'rcv_worm': (0xc9a556, 0.15, 0.7, 0),
    'rcv_worm_dark': (0x2e2520, 0.4, 0.7, 0),
}

# Grid cells (w, h) per kind: shared/items.ts ITEMS sizes. The icon has this shape.
CELLS = {
    'canteen': (1, 2), 'spyglass': (2, 1), 'motorcycle': (4, 3), 'backpack': (2, 2), 'storm_detector': (1, 2),
    'wristpad': (1, 1), 'metal_detector': (1, 3), 'shovel': (1, 3), 'laser_rifle': (4, 1), 'laser_pistol': (2, 1),
    'jammer': (2, 1), 'receiver_carrier': (2, 1), 'receiver_queen': (2, 1), 'receiver_colossus': (2, 1),
    'receiver_worm': (2, 1),
}
CELL, GAP = 54, 4  # src/inventory.ts


def span(n):
    return n * CELL + (n - 1) * GAP


# ------------------------------------------------------------------------------------------------ shovel

def build_shovel(mb, rng):
    """A long-handled spade lying flat: blade at +X, dished face up, D-grip at -X. About 1 m long."""
    z = 0.017
    mb.cyl(0.017, 0.016, 0.74, 8, (-0.02, 0, z), 'wood', rot=it.Y90)
    for x in (-0.12, -0.05):
        mb.cyl(0.0195, 0.0195, 0.045, 8, (x, 0, z), 'tape', rot=(0, D90, rng(-0.1, 0.1)))
    # D-grip: a bent steel loop with a wooden crossbar.
    it.wire(mb, [(-0.37, -0.012, z), (-0.43, -0.055, z), (-0.51, -0.056, z), (-0.51, 0.056, z), (-0.43, 0.055, z),
                 (-0.37, 0.012, z)], 0.009, 6, 'rust_dark')
    mb.cyl(0.016, 0.016, 0.1, 8, (-0.51, 0, z), 'wood_dark', rot=it.X90)
    mb.cyl(0.02, 0.02, 0.03, 8, (-0.375, 0, z), 'steel_dull', rot=it.Y90)
    # Socket: a cone from the shaft into the blade, riveted.
    mb.cyl(0.02, 0.028, 0.11, 8, (0.395, 0, z - 0.002), 'rust', rot=it.Y90)
    mb.cyl(0.004, 0.004, 0.06, 5, (0.38, 0, z), 'steel_dull')
    # Blade: a dished plate, square shoulders with a tread lip, pointed tip.
    x0, L, hw0, t = 0.44, 0.32, 0.115, 0.006
    secs = []
    for i in range(9):
        s = i / 8
        hw = hw0 if s < 0.5 else max(0.006, hw0 * math.sqrt(max(0.0, 1 - ((s - 0.5) / 0.5) ** 2)))
        n = 7
        top, bot = [], []
        for j in range(n):
            u = -1 + 2 * j / (n - 1)
            dz = 0.022 * u * u * (hw / hw0)
            top.append((x0 + s * L, u * hw, 0.004 + dz + t / 2))
            bot.append((x0 + s * L, u * hw, 0.004 + dz - t / 2))
        secs.append(top + bot[::-1])
    v = mb.loft(secs, 'steel_dull')
    mb.jitter(v, rng, 0.0015)
    mb.box((0.02, 2 * hw0 + 0.01, 0.01), (x0 + 0.005, 0, 0.027), 'rust_dark')
    # A rust bloom and a ridge down the middle of the blade.
    mb.box((0.15, 0.012, 0.008), (x0 + 0.08, 0, 0.007), 'rust')
    for x, y, r in ((0.6, 0.05, 0.03), (0.52, -0.07, 0.025)):
        mb.cyl(r, r * 0.8, 0.003, 7, (x, y, 0.009 + 0.022 * (y / hw0) ** 2), 'rust')


# ------------------------------------------------------------------------------------------------ metal detector

def oval_ring(mb, R, r, sy, loc, mat):
    v = mb.torus(R, r, 16, 6, (0, 0, 0), mat, smooth=True)
    for p in v:
        p.co.y *= sy
    bmesh.ops.translate(mb.bm, vec=Vector(loc), verts=v)
    return v


def build_metal_detector(mb, rng):
    """Lying on the sand: the search coil flat at +X, the shaft running back to the grip, control box and arm cuff."""
    cx = 0.52
    oval_ring(mb, 0.125, 0.017, 0.78, (cx, 0, 0.018), 'plastic_black')
    v = mb.cyl(0.12, 0.12, 0.012, 16, (0, 0, 0), 'detector_yellow')
    for p in v:
        p.co.y *= 0.78
    bmesh.ops.translate(mb.bm, vec=Vector((cx, 0, 0.016)), verts=v)
    mb.box((0.06, 0.02, 0.004), (cx, 0, 0.024), 'label')
    # Yoke: two ears on the coil, a bolt through them and the lower shaft.
    for sy in (-1, 1):
        mb.box((0.05, 0.008, 0.04), (cx - 0.07, sy * 0.016, 0.042), 'plastic_black')
    mb.cyl(0.006, 0.006, 0.05, 6, (cx - 0.07, 0, 0.05), 'steel', rot=it.X90)
    mb.cyl(0.007, 0.007, 0.012, 6, (cx - 0.07, 0.026, 0.05), 'plastic_dark', rot=it.X90)
    zs = 0.05
    mb.cyl(0.011, 0.011, 0.42, 8, (0.24, 0, zs), 'alu', rot=it.Y90)
    mb.cyl(0.016, 0.016, 0.04, 8, (0.03, 0, zs), 'plastic_black', rot=it.Y90)  # twist lock
    mb.cyl(0.013, 0.013, 0.36, 8, (-0.15, 0, zs), 'steel_dull', rot=it.Y90)
    # Grip, control box on top of the shaft, arm cuff at the back.
    mb.cyl(0.019, 0.019, 0.13, 8, (-0.27, 0, zs), 'rubber', rot=it.Y90)
    mb.box((0.15, 0.075, 0.055), (-0.1, 0, zs + 0.035), 'plastic_dark', bevel=0.008)
    mb.box((0.06, 0.04, 0.004), (-0.07, 0, zs + 0.064), 'glass_dark')
    mb.cyl(0.016, 0.016, 0.006, 10, (-0.14, -0.01, zs + 0.064), 'label')
    mb.box((0.012, 0.002, 0.002), (-0.135, -0.008, zs + 0.068), 'term_red', rot=(0, 0, 0.6))
    for y in (-0.025, 0.025):
        mb.cyl(0.008, 0.008, 0.012, 8, (-0.165, y, zs + 0.066), 'plastic_black')
    mb.cyl(0.006, 0.006, 0.004, 8, (-0.05, 0.026, zs + 0.064), 'EmitAmber')
    mb.lathe([(0.045, -0.035), (0.052, -0.035), (0.052, 0.035), (0.045, 0.035)], 8, (-0.38, 0, zs + 0.05),
             'plastic_black', rot=(0, D90, 0), arc=math.pi, phase=-D90)
    mb.box((0.03, 0.02, 0.05), (-0.38, 0, zs + 0.02), 'plastic_black')
    mb.box((0.05, 0.05, 0.006), (-0.38, 0, zs + 0.05), 'strap')
    # Coil cable wound round the shaft from the coil to the box.
    pts = []
    for k in range(25):
        x = cx - 0.09 - k * 0.022
        a = k * 1.1
        pts.append((x, 0.016 * math.cos(a), zs + 0.016 * math.sin(a)))
    it.wire(mb, [(cx - 0.05, 0.0, 0.03)] + pts + [(-0.03, 0.02, zs + 0.03)], 0.0035, 5, 'plastic_black')


# ------------------------------------------------------------------------------------------------ storm detector

def build_storm_detector(mb, rng):
    """Upright: an orange handheld weather box with a barometer dial on the front (-Y), a three-cup anemometer and
    a whip aerial on top."""
    W, D, H = 0.11, 0.07, 0.17
    mb.box((W, D, H), (0, 0, H / 2), 'orange_paint', bevel=0.008)
    for sx in (-1, 1):
        for sz in (0, 1):
            mb.box((0.026, D + 0.008, 0.03), (sx * (W / 2 - 0.006), 0, 0.012 + sz * (H - 0.024)), 'rubber', bevel=0.004)
    # Dial: brass bezel, cream face, red needle, a few ticks.
    dz = 0.105
    mb.cyl(0.04, 0.04, 0.012, 16, (0, -D / 2 - 0.004, dz), 'brass', rot=it.X90)
    mb.cyl(0.034, 0.034, 0.004, 16, (0, -D / 2 - 0.009, dz), 'label', rot=it.X90)
    for k in range(7):
        a = -2.2 + k * 4.4 / 6
        mb.box((0.002, 0.002, 0.008), (0.028 * math.sin(a), -D / 2 - 0.0115, dz + 0.028 * math.cos(a)), 'plastic_black',
               rot=(0, a, 0))
    mb.box((0.003, 0.002, 0.028), (0.006, -D / 2 - 0.0125, dz + 0.01), 'term_red', rot=(0, 0.55, 0))
    mb.cyl(0.004, 0.004, 0.004, 8, (0, -D / 2 - 0.0125, dz), 'plastic_black', rot=it.X90)
    # Speaker grille, two toggles and the warning lamp.
    for k in range(4):
        mb.box((0.05, 0.003, 0.004), (-0.012, -D / 2 - 0.001, 0.035 + k * 0.009), 'plastic_black')
    for x in (0.03, 0.042):
        mb.box((0.008, 0.006, 0.008), (x, -D / 2 - 0.003, 0.05), 'steel')
        mb.cyl(0.002, 0.002, 0.014, 5, (x, -D / 2 - 0.009, 0.054), 'steel', rot=(1.1, 0, 0))
    mb.cyl(0.008, 0.008, 0.006, 10, (-0.035, -D / 2 - 0.002, 0.152), 'EmitAmber', rot=it.X90)
    # Anemometer: mast, hub, three arms with cups.
    mx = 0.022
    mb.cyl(0.005, 0.005, 0.06, 6, (mx, 0, H + 0.03), 'steel')
    mb.cyl(0.01, 0.01, 0.012, 8, (mx, 0, H + 0.062), 'plastic_black')
    for k in range(3):
        a = k * 2 * math.pi / 3 + 0.3
        ca, sa = math.cos(a), math.sin(a)
        it.wire(mb, [(mx, 0, H + 0.062), (mx + 0.045 * ca, 0.045 * sa, H + 0.062)], 0.0018, 4, 'steel')
        mb.cyl(0.012, 0.003, 0.016, 8, (mx + 0.05 * ca, 0.05 * sa, H + 0.062), 'alu',
               rot=(0, D90, a + D90))
    # Whip aerial, bent a little from a hard life.
    ax = -0.035
    mb.cyl(0.006, 0.006, 0.02, 6, (ax, 0.012, H + 0.01), 'plastic_black')
    it.wire(mb, [(ax, 0.012, H + 0.02), (ax - 0.004, 0.012, H + 0.12), (ax - 0.02, 0.014, H + 0.2)], 0.0018, 4, 'steel')
    mb.blob(0.004, (ax - 0.02, 0.014, H + 0.2), 'plastic_black')
    # A strap loop on the side.
    it.wire(mb, [(W / 2, -0.02, 0.13), (W / 2 + 0.02, -0.02, 0.1), (W / 2 + 0.02, -0.02, 0.05), (W / 2, -0.02, 0.03)],
            0.005, 5, 'strap')


# ------------------------------------------------------------------------------------------------ wrist computer

def build_wristpad(mb, rng):
    """Upright cuff round local Z with a chunky screen module facing +X, straps and a buckle on the far side."""
    mb.lathe([(0.042, -0.045), (0.05, -0.045), (0.051, 0.0), (0.05, 0.045), (0.042, 0.045)], 14, (0, 0, 0),
             'leather', smooth=True)
    for z in (-0.034, 0.034):
        mb.lathe([(0.0505, -0.008), (0.054, -0.008), (0.054, 0.008), (0.0505, 0.008)], 14, (0, 0, z), 'strap')
        mb.box((0.006, 0.026, 0.02), (-0.056, 0, z), 'steel')
    # Module: bevelled box, bezel, screen, buttons along one edge, a stub aerial.
    mb.box((0.03, 0.08, 0.075), (0.064, 0, 0), 'plastic_dark', bevel=0.007)
    mb.box((0.004, 0.064, 0.056), (0.0795, 0, 0.002), 'plastic_black')
    mb.box((0.002, 0.054, 0.044), (0.0815, 0, 0.002), 'EmitScreen')
    for y in (-0.02, 0.0, 0.02):
        mb.box((0.012, 0.01, 0.006), (0.07, y, -0.0405), 'steel_dull')
    mb.cyl(0.004, 0.004, 0.03, 6, (0.064, 0.035, 0.045), 'plastic_black')
    for y, z in ((-0.035, 0.032), (0.035, -0.032), (-0.035, -0.032), (0.035, 0.032)):
        mb.cyl(0.003, 0.003, 0.004, 6, (0.0795, y, z), 'steel', rot=it.Y90)
    mb.box((0.018, 0.06, 0.012), (0.03, 0, 0.0), 'tape', rot=(0, 0, 0.0))


# ------------------------------------------------------------------------------------------------ backpack

def pillow(mb, size, loc, mat, bulge=0.12, n=16, k=6):
    """A stuffed canvas shape: a rounded box whose sides swell out between its top and bottom (a loft of
    superellipse rings), flat-capped."""
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    secs = []
    for i in range(k + 1):
        t = i / k
        sw = 1 - bulge + bulge * math.sin(math.pi * (0.08 + 0.84 * t))
        ring = []
        for j in range(n):
            a = 2 * math.pi * j / n + math.pi / n
            c, s_ = math.cos(a), math.sin(a)
            ring.append((hx * sw * math.copysign(abs(c) ** 0.5, c), hy * sw * math.copysign(abs(s_) ** 0.5, s_),
                         -hz + 2 * hz * t))
        secs.append(ring)
    return mb.loft(secs, mat, loc)


def build_backpack(mb, rng):
    """Upright canvas rucksack: back panel (+Y) with shoulder straps, flap and pockets on the front (-Y), a bedroll
    strapped on top, a tin cup on the side."""
    W, D, H = 0.3, 0.17, 0.38
    v = pillow(mb, (W + 0.04, D + 0.05, H), (0, 0, 0.03 + H / 2), 'canvas')
    mb.jitter(v, rng, 0.003)
    mb.box((W + 0.02, D + 0.02, 0.05), (0, 0, 0.03), 'leather', bevel=0.012)
    # Flap over the top, hanging down the front.
    pillow(mb, (W + 0.05, D + 0.07, 0.05), (0, -0.005, 0.42), 'canvas_dark', bulge=0.05, k=2)
    mb.box((W * 0.9, 0.02, 0.13), (0, -D / 2 - 0.045, 0.37), 'canvas_dark', rot=(-0.12, 0, 0), bevel=0.006)
    for x in (-0.08, 0.08):
        mb.box((0.026, 0.006, 0.17), (x, -D / 2 - 0.058, 0.3), 'leather', rot=(-0.1, 0, 0))
        mb.box((0.034, 0.008, 0.022), (x, -D / 2 - 0.062, 0.29), 'brass')
    # Front pocket and a patch.
    pillow(mb, (0.21, 0.08, 0.15), (0, -D / 2 - 0.03, 0.13), 'canvas_green', k=4)
    mb.box((0.2, 0.065, 0.03), (0, -D / 2 - 0.037, 0.195), 'canvas_dark')
    mb.box((0.07, 0.004, 0.05), (0.08, -D / 2 - 0.02, 0.29), 'tape', rot=(0, 0.3, 0))
    # Side pockets, the cup hanging from one.
    for sx in (-1, 1):
        pillow(mb, (0.07, 0.13, 0.14), (sx * (W / 2 + 0.035), 0, 0.12), 'canvas_dark', k=4)
    mb.lathe([(0.0, 0.0), (0.03, 0.0), (0.034, 0.055), (0.03, 0.055), (0.026, 0.004), (0.0, 0.004)], 10,
             (-W / 2 - 0.1, 0.0, 0.18), 'steel', rot=(0, 0, 0))
    it.wire(mb, [(-W / 2 - 0.066, 0, 0.23), (-W / 2 - 0.08, 0, 0.26), (-W / 2 - 0.068, 0, 0.27)], 0.003, 4, 'steel')
    # Bedroll on top, two straps round it.
    mb.cyl(0.065, 0.065, 0.4, 12, (0, 0.01, 0.51), 'blanket', rot=it.Y90)
    mb.cyl(0.03, 0.03, 0.402, 8, (0, 0.01, 0.51), 'canvas_dark', rot=it.Y90)
    for x in (-0.12, 0.12):
        mb.torus(0.067, 0.006, 12, 4, (x, 0.01, 0.51), 'leather', rot=it.Y90, smooth=False)
    # Shoulder straps on the back, padded.
    for sx in (-1, 1):
        pts = [(sx * 0.07, D / 2, 0.42), (sx * 0.08, D / 2 + 0.05, 0.36), (sx * 0.09, D / 2 + 0.06, 0.2),
               (sx * 0.12, D / 2 + 0.02, 0.06)]
        it.wire(mb, pts, 0.014, 6, 'leather')
    mb.box((W * 0.8, 0.012, H * 0.8), (0, D / 2 + 0.01, 0.23), 'canvas_dark')


# ------------------------------------------------------------------------------------------------ jammer

def build_jammer(mb, rng):
    """Upright, antenna forward (+X): the shape of src/models/jammer.ts (the held one), a raked grip under a squat
    olive body, a yagi (boom and four elements), a whip aerial at the back and the lamp on top."""
    mb.box((0.036, 0.03, 0.095), (-0.004, 0, 0.004), 'rubber', rot=(0, 0.49, 0), bevel=0.004)
    for k in range(4):
        mb.box((0.038, 0.032, 0.004), (-0.014 + k * 0.01 * 0.47, 0, -0.03 + k * 0.018), 'olive_dark', rot=(0, 0.49, 0))
    it.wire(mb, [(0.012, 0, 0.044), (0.03, 0, 0.022), (0.05, 0, 0.026), (0.052, 0, 0.044)], 0.003, 5, 'plastic_black')
    mb.box((0.15, 0.05, 0.046), (0.035, 0, 0.066), 'olive', bevel=0.006)
    mb.box((0.11, 0.052, 0.008), (0.045, 0, 0.044), 'olive_dark')
    for k in range(5):  # cooling ribs on the flank
        mb.box((0.006, 0.052, 0.026), (0.0 + k * 0.016, 0, 0.068), 'olive_dark')
    mb.box((0.006, 0.04, 0.03), (0.112, 0, 0.066), 'olive_dark')
    mb.box((0.05, 0.003, 0.025), (0.06, -0.026, 0.07), 'label')
    mb.box((0.03, 0.054, 0.012), (0.08, 0, 0.088), 'rust', rot=(0, 0.1, 0))
    it.wire(mb, [(0.112, 0, 0.066), (0.31, 0, 0.066)], 0.0035, 6, 'steel')
    for x, w in ((0.14, 0.12), (0.19, 0.1), (0.24, 0.088), (0.29, 0.078)):
        it.wire(mb, [(x, -w / 2, 0.066), (x, w / 2, 0.066)], 0.0022, 5, 'steel')
        mb.box((0.008, 0.008, 0.008), (x, 0, 0.066), 'plastic_black')
    mb.cyl(0.0045, 0.0045, 0.012, 6, (-0.03, -0.016, 0.094), 'plastic_black')
    it.wire(mb, [(-0.03, -0.016, 0.1), (-0.055, -0.016, 0.2)], 0.0016, 4, 'steel')
    mb.box((0.018, 0.018, 0.004), (-0.02, 0.012, 0.09), 'plastic_black')
    mb.ball(0.0065, (-0.02, 0.012, 0.094), 'EmitAmber', u=8, v=5)
    mb.cyl(0.007, 0.007, 0.008, 8, (0.005, 0.0, 0.092), 'plastic_black')


# ------------------------------------------------------------------------------------------------ receivers

# Distress-signal receivers: each calls one boss, fed by a uranium cell (items.py) pushed into the slot in its
# side. Same frame as the jammer (+X forward, +Z up, grip where the hand closes at the origin) and EXACTLY the
# jammer's grip and trigger guard, so the game holds them with the jammer's hand clips. A held model built to
# match in three.js maps Blender (x, y, z) to three.js (-y, z, x).
RECV_BODY = ((0.13, 0.06, 0.056), (0.03, 0.0, 0.071))  # size, centre: x -0.035..0.095, z 0.043..0.099
DIAL_TILT = 0.4  # the dial face leans back (towards the eye) by this much from facing straight up
DIAL_FACE = Vector((0.035, 0.0, 0.111))  # centre of the dial's face plane
DIAL_R = 0.0225  # face radius; light rim to 0.0285, dark drum behind it
RECV_COLOURS = {  # body, dark (underside, ribs, drum, bands)
    'carrier': ('rcv_carrier', 'rcv_carrier_dark'),
    'queen': ('rcv_queen', 'rcv_queen_dark'),
    'colossus': ('rcv_colossus', 'rcv_colossus_dark'),
    'worm': ('rcv_worm', 'rcv_worm_dark'),
}


def make_receiver(boss):
    body, dark = RECV_COLOURS[boss]

    def build_receiver(mb, rng):
        """Upright, antenna forward (+X): the jammer's raked grip under a squat body, a round analogue dial on top
        leaning back towards the eye, a stubby antenna at the front, the lamp at the back, the cell slot in the -Y
        side."""
        # Grip and trigger guard: build_jammer's, unchanged.
        mb.box((0.036, 0.03, 0.095), (-0.004, 0, 0.004), 'rubber', rot=(0, 0.49, 0), bevel=0.004)
        for k in range(4):
            mb.box((0.038, 0.032, 0.004), (-0.014 + k * 0.01 * 0.47, 0, -0.03 + k * 0.018), dark, rot=(0, 0.49, 0))
        it.wire(mb, [(0.012, 0, 0.044), (0.03, 0, 0.022), (0.05, 0, 0.026), (0.052, 0, 0.044)], 0.003, 5,
                'plastic_black')
        # Squat body, dark underside and nose plate.
        (sx, sy, sz), c = RECV_BODY
        mb.box((sx, sy, sz), c, body, bevel=0.006)
        mb.box((0.1, sy + 0.002, 0.008), (0.035, 0, 0.045), dark)
        mb.box((0.006, sy - 0.012, sz - 0.016), (c[0] + sx / 2, 0, c[2]), dark)
        if boss == 'worm':  # dark bands round the body, like the worm's
            for x in (-0.018, 0.078):
                mb.box((0.012, sy + 0.003, sz + 0.003), (x, 0, c[2]), dark)
        # Cell slot in the -Y side: a steel frame round a dark opening, a hazard tab above it.
        y = -sy / 2
        mb.box((0.048, 0.002, 0.024), (0.03, y - 0.0005, 0.07), 'plastic_black')
        for dz in (-0.014, 0.014):
            mb.box((0.056, 0.004, 0.004), (0.03, y - 0.0015, 0.07 + dz), 'steel')
        for dx in (-0.026, 0.026):
            mb.box((0.004, 0.004, 0.032), (0.03 + dx, y - 0.0015, 0.07), 'steel')
        mb.box((0.02, 0.003, 0.005), (0.03, y - 0.001, 0.0915), 'hazard_yellow')
        for dx in (-0.01, 0.01):  # contacts deep in the slot
            mb.cyl(0.0025, 0.0025, 0.002, 6, (0.03 + dx, y - 0.001, 0.07), 'brass', rot=it.X90)
        # Dial: dark drum sunk into the top, light rim, dark face, cream ticks, orange needle on a steel pivot.
        tilt = Euler((0, -DIAL_TILT, 0)).to_matrix()
        n = tilt @ Vector((0, 0, 1))  # face normal (up and back)
        u = tilt @ Vector((1, 0, 0))  # the dial's 12 o'clock (forward and up)
        rot = (0, -DIAL_TILT, 0)
        F = DIAL_FACE
        mb.cyl(0.028, 0.028, 0.022, 16, F - n * 0.011, dark, rot=rot)
        mb.lathe([(DIAL_R, 0.0), (0.0285, 0.0), (0.0285, 0.005), (DIAL_R, 0.005)], 16, F, 'alu', rot=rot)
        mb.cyl(DIAL_R, DIAL_R, 0.002, 16, F, 'plastic_black', rot=rot)
        for k in range(7):
            a = -2.1 + k * 4.2 / 6
            p = F + n * 0.0015 + (u * math.cos(a) + Vector((0, 1, 0)) * math.sin(a)) * 0.0175
            r = (tilt @ Euler((0, 0, a)).to_matrix()).to_euler()
            mb.box((0.006 if k % 3 == 0 else 0.004, 0.0016, 0.001), p, 'label', rot=tuple(r))
        a = -0.6  # needle at rest, left of 12 o'clock
        d = u * math.cos(a) + Vector((0, 1, 0)) * math.sin(a)
        r = (tilt @ Euler((0, 0, a)).to_matrix()).to_euler()
        mb.box((0.017, 0.0024, 0.0012), F + n * 0.0025 + d * 0.0075, 'accent_orange', rot=tuple(r))
        mb.cyl(0.003, 0.003, 0.004, 8, F + n * 0.003, 'steel', rot=rot)
        # Stubby antenna at the front, raked forward a little.
        a0 = Vector((0.08, 0, 0.099))
        mb.cyl(0.0075, 0.0075, 0.01, 8, a0 + Vector((0, 0, 0.005)), 'plastic_black')
        it.wire(mb, [a0 + Vector((0, 0, 0.01)), a0 + Vector((0.012, 0, 0.055))], 0.0042, 6, 'rubber')
        mb.ball(0.0058, a0 + Vector((0.012, 0, 0.057)), 'rubber', u=8, v=5)
        # The lamp at the back, like the jammer's.
        mb.box((0.018, 0.018, 0.004), (-0.02, 0.012, 0.1), 'plastic_black')
        mb.ball(0.0065, (-0.02, 0.012, 0.104), 'EmitAmber', u=8, v=5)

    return build_receiver


# ------------------------------------------------------------------------------------------------ table

# kind: (builder, pose on the sand (Euler, rad), icon pose, icon camera direction (from the object))
SIDE = Vector((0.18, -1, 0.32)).normalized()
THREE_Q = Vector((0.55, -1, 0.42)).normalized()
UPRIGHT = Vector((0.3, -1, 0.25)).normalized()
BUILT = {
    'shovel': (build_shovel, (0, 0, 0), (0, D90, -D90 + 0.25), UPRIGHT),
    'metal_detector': (build_metal_detector, (0, 0, 0), (0, D90, -D90 + 0.25), UPRIGHT),
    'storm_detector': (build_storm_detector, (-D90, 0, 0.4), (0, 0, -0.35), THREE_Q),
    'wristpad': (build_wristpad, (D90, -D90, 0), (0, 0, -D90 - 0.3), THREE_Q),
    'backpack': (build_backpack, (-D90, 0, 0), (0, 0, -0.35), THREE_Q),
    'jammer': (build_jammer, (D90, 0, 0), (0, 0, 0), SIDE),
}
RECV_VIEW = Vector((-0.3, -1, 0.75)).normalized()  # from behind and above, so the dial (leaning back) shows
for _boss in RECV_COLOURS:  # lying on the slot-less side, slot and dial up to the sky
    BUILT['receiver_' + _boss] = (make_receiver(_boss), (-D90, 0, 0), (0, 0, 0), RECV_VIEW)
# The existing models: file in public/models/, icon pose, camera direction.
IMPORTED = {
    'canteen': ('canteen.glb', (0, 0, -0.4), THREE_Q),
    'spyglass': ('telescope.glb', (0, 0, D90 + 0.15), SIDE),
    'laser_rifle': ('rifle.glb', (0, 0, D90), SIDE),
    'laser_pistol': ('pistol.glb', (0, 0, D90), SIDE),
    'motorcycle': ('sandbike.glb', (0, 0, -D90 + 0.35), Vector((0.3, -1, 0.35)).normalized()),
}


def build(kind):
    mb = it.MeshBuilder()
    BUILT[kind][0](mb, it.Rng(len(kind) * 7 + 3))
    bmesh.ops.recalc_face_normals(mb.bm, faces=mb.bm.faces)
    mesh = bpy.data.meshes.new(kind)
    mb.bm.normal_update()
    mb.bm.to_mesh(mesh)
    mb.bm.free()
    for m in mb.mats:
        mesh.materials.append(bpy.data.materials[m])
    obj = bpy.data.objects.new(kind, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def import_glb(kind):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT, 'public', 'models', IMPORTED[kind][0]))
    new = [o for o in bpy.data.objects if o not in before]
    root = bpy.data.objects.new(kind, None)
    bpy.context.scene.collection.objects.link(root)
    for o in new:
        if o.parent is None:
            o.parent = root
    return root


def meshes(root):
    return [root] if root.type == 'MESH' else [o for o in root.children_recursive if o.type == 'MESH']


def render_icon(cam, root, rot, dirv, kind, out_dir):
    """Ortho camera along `dirv`, the item (turned to `rot`) filling an icon of its grid shape."""
    scene = bpy.context.scene
    w, h = CELLS[kind]
    rx, ry = 2 * span(w), 2 * span(h)
    scene.render.resolution_x, scene.render.resolution_y = rx, ry
    root.rotation_euler = Euler(rot)
    bpy.context.view_layer.update()
    show = meshes(root)
    for o in bpy.data.objects:
        if o.type == 'MESH':
            o.hide_render = o not in show
    pts = [o.matrix_world @ v.co for o in show for v in o.data.vertices]
    lo = Vector([min(p[i] for p in pts) for i in range(3)])
    hi = Vector([max(p[i] for p in pts) for i in range(3)])
    cam.location = (lo + hi) / 2 + dirv * 3
    cam.rotation_euler = (-dirv).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.view_layer.update()
    inv = cam.matrix_world.inverted()
    loc = [inv @ p for p in pts]
    x0, x1 = min(p.x for p in loc), max(p.x for p in loc)
    y0, y1 = min(p.y for p in loc), max(p.y for p in loc)
    cam.location = cam.matrix_world @ Vector(((x0 + x1) / 2, (y0 + y1) / 2, 0))
    cam.data.type = 'ORTHO'
    pad = 1.1
    cam.data.ortho_scale = pad * (max(x1 - x0, (y1 - y0) * rx / ry) if rx >= ry else max(y1 - y0, (x1 - x0) * ry / rx))
    cam.data.clip_start, cam.data.clip_end = 0.01, 10
    scene.render.filepath = os.path.join(out_dir, kind + '.png')
    bpy.ops.render.render(write_still=True)


def export(obj, path):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                              export_apply=True, export_materials='EXPORT', export_normals=True,
                              export_texcoords=False)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--kind', choices=list(BUILT) + list(IMPORTED), action='append')
    ap.add_argument('--preview', default=None)
    ap.add_argument('--no-icons', action='store_true')
    args = ap.parse_args(argv)
    kinds = args.kind or list(BUILT) + list(IMPORTED)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in {**it.MATERIALS, **MATERIALS}.items():
        it.make_material(name, *spec)
    out = os.path.join(ROOT, 'public', 'models', 'finds')
    icons = os.path.join(ROOT, 'public', 'icons', 'items')
    os.makedirs(out, exist_ok=True)

    roots = {}
    for kind in kinds:
        if kind in BUILT:
            obj = build(kind)
            obj.rotation_euler = Euler(BUILT[kind][1])
            export(obj, os.path.join(out, kind + '.glb'))
            d = obj.dimensions
            print(f'{kind}: tris={it.tri_count(obj)} mats={len(obj.data.materials)} size={d.x:.3f} x {d.y:.3f} x {d.z:.3f} m')
        else:
            obj = import_glb(kind)
        roots[kind] = obj

    if not args.no_icons:
        cam = it.setup_render(bpy.context.scene, 128, 128)
        for kind, obj in roots.items():
            rot, dirv = (BUILT[kind][2], BUILT[kind][3]) if kind in BUILT else IMPORTED[kind][1:]
            render_icon(cam, obj, rot, dirv, kind, icons)

    if args.preview:
        # Everything in its pose on the sand (the imported ones as src/world/loot.ts lays them), side by side.
        scene = bpy.context.scene
        cam = scene.camera or it.setup_render(scene, 1600, 900)
        for o in bpy.data.objects:
            o.hide_render = False
        lay = {'canteen': (-D90, 0, 0), 'spyglass': (0, 0, 0), 'laser_rifle': (0, D90, 0), 'laser_pistol': (0, D90, 0),
               'motorcycle': (0, 1.3, 0)}
        xs = 0.0
        for kind, obj in roots.items():
            obj.rotation_euler = Euler(BUILT[kind][1] if kind in BUILT else lay[kind])
            bpy.context.view_layer.update()
            pts = [o.matrix_world @ v.co for o in meshes(obj) for v in o.data.vertices]
            x0 = min(p.x for p in pts)
            x1 = max(p.x for p in pts)
            zmin = min(p.z for p in pts)
            cy = (min(p.y for p in pts) + max(p.y for p in pts)) / 2
            obj.location = (xs - x0, -cy, -zmin)
            xs += x1 - x0 + 0.15
        for o in roots.values():
            o.location.x -= xs / 2
        scene.render.resolution_x, scene.render.resolution_y = 1800, 900
        scene.render.film_transparent = False
        scene.render.use_freestyle = False
        bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
        bpy.context.active_object.data.materials.append(it.make_material('ground', 0xd9a066, 0, 0.9, 0))
        cam.data.type = 'PERSP'
        cam.data.lens = 50
        it.aim(cam, Vector((0, 0, 0.1)), xs * 0.9)
        scene.render.filepath = os.path.abspath(args.preview)
        bpy.ops.render.render(write_still=True)


main()
