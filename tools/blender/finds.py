"""Gear found broken on the sand (GitHub issue #8): world models and inventory icons.

    blender -b --python tools/blender/finds.py                        # models + icons
    blender -b --python tools/blender/finds.py -- --kind jammer       # just one (repeatable)
    blender -b --python tools/blender/finds.py -- --preview out.png   # also a perspective render of them on sand

Writes public/models/finds/<kind>.glb for the gear that had only a code-built stand-in (backpack,
storm detector, wrist computer, jammer, grinder) and the boss receivers (receiver_<boss>), each already in the pose it lies in on the sand; src/world/loot.ts
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
    # The grinder (src/models/grinder.ts): blue motor housing, cutting disc.
    'grinder_blue': (0x35558f, 0.3, 0.65, 0),
    'disc': (0x232225, 0.2, 0.85, 0),
    'orange_paint': (0xc4652a, 0.2, 0.6, 0),
    'rubber': (0x1e1c1a, 0.0, 0.9, 0),
    'detector_yellow': (0xd2a12c, 0.1, 0.55, 0),
    'glass_dark': (0x1a2a2c, 0.3, 0.2, 0),
    'EmitScreen': (0x5fe0b8, 0.0, 0.4, 1.2),
    'EmitAmber': (0xffa040, 0.0, 0.4, 1.5),
    # The shield plate: weathered hull plating off a crashed ship, its livery stripe, and the emitter's lens (src/tierLook.ts
    # colours `ShieldLens` by tier).
    'hull': (0x8e8b7f, 0.55, 0.62, 0),
    'hull_dark': (0x4d4a43, 0.6, 0.7, 0),
    'ShieldLens': (0xffb04a, 0.0, 0.3, 2.0),
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
    'wristpad': (1, 1), 'laser_rifle': (4, 1), 'laser_pistol': (2, 1),
    'jammer': (2, 1), 'grinder': (2, 1), 'shield': (2, 2), 'receiver_carrier': (2, 1), 'receiver_queen': (2, 1), 'receiver_colossus': (2, 1),
    'receiver_worm': (2, 1),
}
CELL, GAP = 54, 4  # src/inventory.ts


def span(n):
    return n * CELL + (n - 1) * GAP


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


# ------------------------------------------------------------------------------------------------ grinder

def build_grinder(mb, rng):
    """Lying on the sand, disc up: an angle grinder like src/models/grinder.ts, housing along +X (blue motor, dark
    caps, tapering neck), the gear head at the front with the spindle up and the cutting disc under a half guard,
    the side handle lying out towards -Y."""
    z = 0.032
    mb.cyl(0.03, 0.03, 0.15, 14, (0.005, 0, z), 'grinder_blue', rot=it.Y90)
    mb.cyl(0.031, 0.031, 0.04, 14, (-0.05, 0, z), 'plastic_black', rot=it.Y90)
    mb.cyl(0.03, 0.03, 0.03, 14, (0.095, 0, z), 'plastic_black', rot=it.Y90)
    mb.cyl(0.03, 0.026, 0.05, 14, (0.135, 0, z), 'grinder_blue', rot=it.Y90)
    for k in range(4):  # vent slots on the flank
        mb.box((0.012, 0.004, 0.012), (-0.01 + k * 0.02, -0.0295, z + 0.004), 'plastic_black')
    mb.box((0.04, 0.003, 0.016), (0.04, -0.03, z - 0.006), 'label')
    # Gear head: a steel casing carrying the spindle, up to the disc.
    hx = 0.225
    mb.box((0.07, 0.056, 0.056), (hx, 0, z), 'steel_dull', bevel=0.004)
    mb.box((0.05, 0.05, 0.03), (hx, 0, z + 0.04), 'steel_dull', bevel=0.004)
    dz = z + 0.07
    mb.cyl(0.018, 0.018, 0.012, 12, (hx, 0, dz - 0.004), 'plastic_black')
    # Disc, flange and nut, a printed ring, and the half guard over the back of it.
    mb.cyl(0.056, 0.056, 0.004, 28, (hx - 0.045, 0, dz + 0.006), 'disc')
    mb.cyl(0.034, 0.034, 0.0012, 20, (hx - 0.045, 0, dz + 0.0085), 'accent_orange')
    mb.cyl(0.016, 0.016, 0.006, 8, (hx - 0.045, 0, dz + 0.011), 'steel')
    mb.lathe([(0.062, 0.0), (0.062, 0.022), (0.059, 0.022), (0.059, 0.0)], 16, (hx - 0.045, 0, dz - 0.002),
             'steel_dull', arc=math.pi, phase=-D90 - math.pi / 4)
    # Side handle, lying out to -Y with its knob, a rubber grip near the end.
    it.wire(mb, [(hx, -0.028, z - 0.004), (hx - 0.002, -0.07, z - 0.002), (hx - 0.004, -0.115, z + 0.004)], 0.013, 8,
            'plastic_black')
    mb.ball(0.017, (hx - 0.004, -0.122, z + 0.006), 'plastic_black', u=10, v=7)
    # Trigger switch under the body and the cable stub at the back.
    mb.box((0.03, 0.018, 0.008), (0.03, 0, z - 0.032), 'rust')
    it.wire(mb, [(-0.07, 0, z), (-0.12, 0.02, 0.012), (-0.17, 0.05, 0.008), (-0.2, 0.09, 0.007)], 0.006, 6, 'rubber')


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

# ------------------------------------------------------------------------------------------------ shield plate

SH_R = 0.25  # the plate is a piece of a cylinder this round (m), its axis behind it: it wraps the chest
SH_T = 0.012


def sh_at(a, z, out=0.0, b=0.0):
    """A point on the plate's front at angle `a` round the chest (0 straight ahead, + to the wearer's left), `out` m
    proud of it, `b` its bulge there."""
    r = SH_R + b + out
    return (r * math.sin(a), SH_R - r * math.cos(a), z)


def sh_bulge(t):
    return 0.014 * (1 - (2 * t - 1) ** 2)  # bowed forward a little top to bottom, like a breastplate


def sh_patch(mb, a0, a1, z0, z1, out, th, mat, n=8, rows=6, edge=None):
    """A curved slab on the plate (out .. out + th proud of it) from angle a0 to a1 and height z0 to z1; `edge(t)`
    gives (a0, a1) per row (t 0 at z0 .. 1 at z1) for cut edges."""
    secs = []
    for i in range(rows + 1):
        t = i / rows
        z = z0 + (z1 - z0) * t
        lo, hi = edge(t) if edge else (a0, a1)
        b = sh_bulge((z + 0.13) / 0.26)
        outer = [sh_at(lo + (hi - lo) * j / n, z, out + th, b) for j in range(n + 1)]
        inner = [sh_at(lo + (hi - lo) * j / n, z, out, b) for j in reversed(range(n + 1))]
        secs.append(outer + inner)
    return mb.loft(secs, mat)


def build_shield(mb, rng):
    """Upright, as worn (the wearer's front is -Y, origin at the plate's middle): a shard of hull plating torch-cut
    off a crashed ship, wrapped round the chest on canvas padding, strapped on, its livery stripe and stencils
    still on it; at the sternum a copper-coil emitter with a lens, wired to a cell clamped to its side."""
    a0, a1 = -0.66, 0.4

    def cut(t):  # the torch cut: the top left corner sliced off at a slant, the right edge a little ragged
        return (a0 + 0.05 * max(0.0, t - 0.7) / 0.3 + 0.015 * math.sin(t * 23), a1 - 0.3 * max(0.0, t - 0.5) / 0.5)

    # Padding first, peeking out round the plate.
    sh_patch(mb, a0 - 0.05, a1 + 0.05, -0.145, 0.12, -0.03, 0.026, 'canvas_dark', n=10, rows=4)
    plate = sh_patch(mb, a0, a1, -0.13, 0.13, 0.0, SH_T, 'hull', n=14, rows=10, edge=cut)
    mb.jitter(plate, rng, 0.0015)
    mb.dent(plate, sh_at(0.25, -0.07, SH_T), 0.05, 0.006)
    mb.dent(plate, sh_at(-0.5, 0.06, SH_T), 0.04, 0.005)
    # The ship's livery: a faded orange band across, a dark one under it, stencil blocks of its hull number.
    sh_patch(mb, a0 + 0.01, 0.2, 0.035, 0.07, SH_T, 0.0012, 'orange_paint', edge=lambda t: (a0 + 0.01, 0.2 - 0.05 * t))
    sh_patch(mb, a0 + 0.01, 0.12, 0.02, 0.03, SH_T, 0.0012, 'hull_dark')
    for k, (w, h) in enumerate(((0.018, 0.03), (0.012, 0.03), (0.018, 0.03))):
        a = -0.56 + k * 0.08
        sh_patch(mb, a, a + w / SH_R, -0.105, -0.105 + h, SH_T, 0.001, 'hull_dark', n=2, rows=1)
    # Rivets along the edges.
    for i in range(9):
        t = i / 8
        lo, hi = cut(min(t, 0.999))
        z = -0.115 + 0.23 * t
        b = sh_bulge((z + 0.13) / 0.26)
        for a in (lo + 0.03, hi - 0.03):
            mb.blob(0.0045, sh_at(a, z, SH_T, b), 'steel_dull')
    for j in range(7):
        a = a0 + 0.06 + (a1 - a0 - 0.12) * j / 6
        mb.blob(0.0045, sh_at(a, -0.117, SH_T, sh_bulge(0.05)), 'steel_dull')
    # The emitter at the sternum: a brass collar, three copper windings stepping in, the lens.
    ea, ez = -0.06, -0.015
    eb = sh_bulge((ez + 0.13) / 0.26)
    rot = (D90, 0, ea)
    mb.cyl(0.042, 0.042, 0.012, 18, sh_at(ea, ez, SH_T + 0.006, eb), 'brass', rot=rot)
    for k, (R, r) in enumerate(((0.034, 0.007), (0.028, 0.006), (0.022, 0.005))):
        mb.torus(R, r, 18, 6, sh_at(ea, ez, SH_T + 0.016 + k * 0.008, eb), 'copper', rot=rot)
    mb.cyl(0.018, 0.016, 0.01, 16, sh_at(ea, ez, SH_T + 0.03, eb), 'ShieldLens', rot=rot)
    for k in range(4):  # the collar's bolts
        ang = k * D90 + 0.4
        a = ea + 0.038 * math.cos(ang) / SH_R
        mb.blob(0.004, sh_at(a, ez + 0.038 * math.sin(ang), SH_T + 0.013, eb), 'steel')
    # The cell, clamped on lying across the plate's right side, wired up to the emitter.
    ca, cz = -0.5, -0.06
    cb = sh_bulge((cz + 0.13) / 0.26)
    cc = sh_at(ca, cz, SH_T + 0.02, cb)
    mb.cyl(0.017, 0.017, 0.085, 12, cc, 'paint_faded_blue', rot=(0, D90, ca))
    for dx in (-0.03, 0.03):
        p = (cc[0] + dx * math.cos(ca), cc[1] + dx * math.sin(ca), cc[2])
        mb.cyl(0.0185, 0.0185, 0.008, 12, p, 'steel_dull', rot=(0, D90, ca))
    mb.cyl(0.008, 0.008, 0.012, 8, (cc[0] + 0.047 * math.cos(ca), cc[1] + 0.047 * math.sin(ca), cc[2]), 'term_red',
           rot=(0, D90, ca))
    it.wire(mb, [(cc[0] + 0.05 * math.cos(ca), cc[1] + 0.05 * math.sin(ca), cc[2]),
                 sh_at(-0.36, -0.02, SH_T + 0.008, cb), sh_at(-0.2, 0.0, SH_T + 0.01, eb),
                 sh_at(ea - 0.16, ez, SH_T + 0.015, eb)], 0.0035, 5, 'wire_red')
    # Straps: up over the shoulders from the top corners, round the ribs from the bottom ones, buckled.
    for a, z, d in ((a0 + 0.08, 0.1, (0.0, 0.1, 0.09)), (a1 - 0.18, 0.1, (0.0, 0.1, 0.09)),
                    (a0 + 0.02, -0.1, (-0.06, 0.14, -0.02)), (a1 - 0.02, -0.1, (0.06, 0.14, -0.02))):
        p = sh_at(a, z, SH_T, sh_bulge((z + 0.13) / 0.26))
        q = (p[0] + d[0] * 0.5, p[1] + d[1] * 0.4, p[2] + d[2] * 0.6)
        r = (p[0] + d[0], p[1] + d[1], p[2] + d[2])
        it.wire(mb, [p, q, r], 0.009, 5, 'leather')
        mb.box((0.024, 0.008, 0.02), (p[0], p[1] - 0.006, p[2]), 'brass', rot=(0, 0, a))


# kind: (builder, pose on the sand (Euler, rad), icon pose, icon camera direction (from the object))
SIDE = Vector((0.18, -1, 0.32)).normalized()
THREE_Q = Vector((0.55, -1, 0.42)).normalized()
BUILT = {
    'storm_detector': (build_storm_detector, (-D90, 0, 0.4), (0, 0, -0.35), THREE_Q),
    'wristpad': (build_wristpad, (D90, -D90, 0), (0, 0, -D90 - 0.3), THREE_Q),
    'backpack': (build_backpack, (-D90, 0, 0), (0, 0, -0.35), THREE_Q),
    'jammer': (build_jammer, (D90, 0, 0), (0, 0, 0), SIDE),
    'grinder': (build_grinder, (0, 0, 0), (0, 0, 0), THREE_Q),
    # Exported upright, as worn (src/models/scavenger.ts straps it on; src/world/loot.ts lays it down).
    'shield': (build_shield, (0, 0, 0), (0, 0, 0.2), Vector((0.2, -1, 0.15)).normalized()),
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
