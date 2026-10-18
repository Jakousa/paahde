"""Boss relics: one-of-a-kind parts taken off the bosses and their kin, exported as glTF binaries + inventory icons.

    blender -b --python tools/blender/relics.py                              # every relic
    blender -b --python tools/blender/relics.py -- --kind queen_eye          # just one (repeatable)
    blender -b --python tools/blender/relics.py -- --preview out.png         # also an overview render on sand
    blender -b --python tools/blender/relics.py -- --no-icons                # models only

Writes public/models/items/<kind>.glb and public/icons/items/<kind>.png (128x128, transparent, the part icons'
orthographic 3/4 camera, lighting and outline from tools/blender/items.py; each relic framed on its own).

Unlike the parts in items.py these have no tiers: each is a single trophy, 12-20 cm, in its source's palette
(tools/blender/carrier.py, queen.py, colossus.py, worm.py; the guardians' red weak points):
  drone_transponder  night searchlight drones and jets: olive/grey box, stub antenna, little dish, amber lamp
  brood_gland        spider-like crawlers: a glowing resin pod in a cage of dark chitin plates
  servo_heart        guardian walkers: a chunky iron leg servo with a red glowing core
  hive_core          the carrier: a hexagonal honeycomb block glowing in its cells
  queen_eye          the brood queen: a big faceted glowing lens in a dark iron socket
  furnace_heart      the colossus: an iron cage sphere with the furnace glowing inside
  worm_tooth         the worm (trophy only): a big curved serrated tooth on a torn root plate

Blender is Z-up; the glTF exporter converts to Y-up. Units are metres, origin at the centre of the base.
Output is deterministic (fixed seeds, no Blender randomness).
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
Y90, X90 = it.Y90, it.X90

KINDS = ['drone_transponder', 'brood_gland', 'servo_heart', 'hive_core', 'queen_eye', 'furnace_heart', 'worm_tooth']

# name -> (sRGB hex, metallic, roughness, emission strength), on top of items.py's MATERIALS.
MATERIALS = {
    # drones / jets
    'drone_olive': (0x5d5a46, 0.25, 0.7, 0),
    'drone_grey': (0x6e6d68, 0.5, 0.55, 0),
    'drone_ceramic': (0xc9b48f, 0.1, 0.65, 0),  # carrier.py CarrierCeramic: the drones' sand-bleached plates
    'lamp_amber': (0xffa040, 0.0, 0.4, 4.0),
    # crawlers
    'chitin': (0x1f1a16, 0.35, 0.35, 0),
    'chitin_edge': (0x4a3a2c, 0.35, 0.4, 0),
    'resin': (0xff8414, 0.0, 0.35, 2.2),
    'resin_hot': (0xffc050, 0.0, 0.3, 6.0),
    # guardians
    'guard_iron': (0x2e2723, 0.6, 0.6, 0),
    'guard_steel': (0x5c544b, 0.75, 0.42, 0),
    'guard_rust': (0x6e3218, 0.45, 0.75, 0),
    'weak_red': (0xff2010, 0.0, 0.4, 6.0),
    # carrier (carrier.py)
    'CarrierIron': (0x26211e, 0.6, 0.55, 0),
    'CarrierPlate': (0x3a332d, 0.55, 0.55, 0),
    'CarrierDark': (0x120e0c, 0.3, 0.8, 0),
    'CarrierRust': (0x6a2f17, 0.45, 0.7, 0),
    'CarrierCeramic': (0xc9b48f, 0.1, 0.65, 0),
    'CarrierHazard': (0xc8641e, 0.3, 0.6, 0),
    'CarrierEye': (0xff4a14, 0.0, 0.4, 8.0),
    'CarrierEyeDim': (0xff4a14, 0.0, 0.4, 2.5),
    # queen (queen.py)
    'QueenIron': (0x2a2420, 0.6, 0.62, 0),
    'QueenSteel': (0x564e46, 0.7, 0.45, 0),
    'QueenRust': (0x642b15, 0.45, 0.78, 0),
    'QueenDark': (0x14100e, 0.2, 0.85, 0),
    'QueenEye': (0xff4a14, 0.0, 0.4, 3.0),  # facets lit less than queen.py's 8 so they still shade
    'QueenEyeHot': (0xff7a30, 0.0, 0.3, 9.0),
    # colossus (colossus.py)
    'ColossusIron': (0x2e2723, 0.6, 0.6, 0),
    'ColossusRust': (0x6e3218, 0.45, 0.75, 0),
    'ColossusSoot': (0x161210, 0.2, 0.85, 0),
    'ColossusBronze': (0x6f5532, 0.7, 0.5, 0),
    'ColossusGlow': (0xff4a14, 0.0, 0.4, 8.0),
    'ColossusEmber': (0xffb040, 0.0, 0.4, 10.0),
    # worm (worm.py)
    'WormIron': (0x2e2520, 0.6, 0.6, 0),
    'WormRust': (0x6a2f17, 0.45, 0.75, 0),
    'WormSteel': (0x5c534b, 0.75, 0.4, 0),
    'WormEdge': (0x9c958a, 0.85, 0.3, 0),  # the honed cutting edge
}


def track(d):
    """Euler that turns local +Z onto direction d."""
    return Vector(d).to_track_quat('Z', 'Y').to_euler()


def hex_pts(r, cx=0.0, cy=0.0, phase=0.0):
    return [(cx + r * math.cos(phase + k * math.pi / 3), cy + r * math.sin(phase + k * math.pi / 3)) for k in range(6)]


def hex_prism(mb, r, z0, z1, mat, cx=0.0, cy=0.0):
    pts = hex_pts(r, cx, cy)
    return mb.loft([[(x, y, z0) for x, y in pts], [(x, y, z1) for x, y in pts]], mat)


# ------------------------------------------------------------------------------------------------ transponder

def build_drone_transponder(mb, rng):
    """A ruggedised box (12 x 8 x 6 cm) torn off a drone: ceramic lid, a stub antenna at the back, a little dish
    on top, an amber lamp at the front, torn bracket and cable stubs underneath."""
    W, D, H = 0.12, 0.08, 0.055
    mb.box((W, D, H), (0, 0, H / 2 + 0.006), 'drone_olive', bevel=0.005)
    mb.box((W * 0.9, D * 0.85, 0.008), (0, 0, H + 0.008), 'drone_ceramic', bevel=0.002)
    mb.box((W + 0.004, D + 0.004, 0.01), (0, 0, 0.012), 'drone_grey')  # bumper band round the base
    for sx in (-1, 1):  # side cooling ribs
        for k in range(3):
            mb.box((0.006, D + 0.006, 0.026), (sx * 0.025 + k * 0.012 * sx, 0, H * 0.6), 'drone_grey')
    # Torn mounting bracket and its bolts, bent cable stubs out of the back.
    mb.box((0.05, 0.02, 0.006), (0.0, D / 2 + 0.006, 0.003), 'rust', rot=(0.3, 0, 0.1))
    for x in (-0.04, 0.04):
        mb.cyl(0.005, 0.005, 0.006, 6, (x, -D / 2 - 0.002, H * 0.3), 'steel_dull', rot=X90)
    it.wire(mb, [(-W / 2, 0.015, 0.02), (-W / 2 - 0.02, 0.02, 0.012), (-W / 2 - 0.03, 0.03, 0.004)], 0.003, 5,
            'wire_red')
    it.wire(mb, [(-W / 2, 0.0, 0.02), (-W / 2 - 0.016, -0.004, 0.006)], 0.003, 5, 'plastic_black')
    top = H + 0.012
    # Stub antenna at the back corner.
    mb.cyl(0.007, 0.007, 0.012, 8, (-0.04, 0.022, top + 0.006), 'plastic_black')
    mb.cyl(0.0035, 0.0025, 0.06, 6, (-0.04, 0.022, top + 0.04), 'drone_grey')
    mb.ball(0.005, (-0.04, 0.022, top + 0.07), 'plastic_black', u=8, v=5)
    # Little dish tilted up and to the front, on a stalk, with its feed.
    dish_c = Vector((0.015, 0.012, top + 0.03))
    n = Vector((0.35, -0.45, 1)).normalized()
    rot = track(n)
    mb.cyl(0.005, 0.005, 0.03, 6, (0.015, 0.012, top + 0.012), 'drone_grey')
    mb.lathe([(0.0, 0.0), (0.03, 0.012), (0.03, 0.015), (0.0, 0.004)], 14, dish_c, 'drone_grey', rot=rot)
    mb.lathe([(0.0, 0.002), (0.027, 0.0125), (0.0, 0.0045)], 14, dish_c, 'alu', rot=rot)
    feed = dish_c + n * 0.028
    it.wire(mb, [dish_c, feed], 0.0018, 5, 'steel')
    mb.ball(0.004, feed, 'plastic_black', u=8, v=5)
    # Amber lamp at the front on a dark collar, a little label.
    mb.cyl(0.011, 0.011, 0.006, 10, (0.042, -0.02, top + 0.003), 'plastic_black')
    mb.ball(0.008, (0.042, -0.02, top + 0.007), 'lamp_amber', u=10, v=6)
    mb.box((0.04, 0.002, 0.018), (0.01, -D / 2 - 0.001, H * 0.55), 'label')


# ------------------------------------------------------------------------------------------------ brood gland

def build_brood_gland(mb, rng):
    """An egg-shaped glowing resin pod (13 cm tall) in a cage of five curved chitin plates meeting in a crown on
    top, sitting in an iron collar with torn feed tubes."""
    cz, rx, rz = 0.078, 0.042, 0.056
    pod = mb.ball(1.0, (0, 0, 0), 'resin', u=12, v=8)
    for v in pod:
        v.co = Vector((v.co.x * rx, v.co.y * rx, v.co.z * rz * (1.0 + 0.12 * v.co.z) + cz))
    mb.ball(0.016, (0.012, -0.018, cz + 0.012), 'resin_hot', u=8, v=6)
    # Chitin plates: lofted strips along the pod's meridians, wide at the waist, pointed at both ends.
    n_pl = 5
    for k in range(n_pl):
        a = 2 * math.pi * k / n_pl + 0.3
        ca, sa = math.cos(a), math.sin(a)
        secs = []
        for j in range(9):
            t = j / 8
            phi = -1.25 + 2.65 * t  # elevation along the meridian, bottom to past the top
            r = (rx + 0.008) * math.cos(phi) + 0.002
            z = cz + (rz + 0.008) * math.sin(phi)
            w = 0.006 + 0.03 * math.sin(math.pi * min(1.0, t * 1.1)) ** 0.8  # half width across
            th = 0.005
            ta = Vector((-sa, ca, 0))  # tangent across the plate
            out = Vector((ca * math.cos(phi), sa * math.cos(phi), math.sin(phi)))
            c = Vector((r * ca, r * sa, z))
            hw = w / 2
            sec = [c + ta * hw, c + out * th + ta * hw * 0.6, c + out * th * 1.4, c + out * th - ta * hw * 0.6,
                   c - ta * hw, c - out * 0.002]
            secs.append([tuple(p) for p in sec])
        mb.loft(secs, 'chitin')
        # A pale ridge down the middle of each plate.
        mid = [Vector(((rx + 0.016) * math.cos(-0.9 + 1.9 * j / 5) * ca, (rx + 0.016) * math.cos(-0.9 + 1.9 * j / 5) * sa,
                       cz + (rz + 0.016) * math.sin(-0.9 + 1.9 * j / 5))) for j in range(6)]
        it.wire(mb, mid, 0.0022, 4, 'chitin_edge')
    # Crown where the plates meet on top: a dark knob with three short spikes.
    top = cz + rz + 0.01
    mb.cyl(0.014, 0.006, 0.016, 7, (0, 0, top + 0.004), 'chitin')
    for k in range(3):
        a = 2 * math.pi * k / 3
        mb.cyl(0.004, 0.0, 0.026, 5, (0.008 * math.cos(a), 0.008 * math.sin(a), top + 0.018), 'chitin',
               rot=track((0.5 * math.cos(a), 0.5 * math.sin(a), 1)))
    # Collar at the base and torn feed tubes.
    mb.lathe([(0.018, 0.0), (0.04, 0.0), (0.036, 0.022), (0.026, 0.026), (0.018, 0.022)], 10, (0, 0, 0),
             'guard_iron')
    for a, l in ((0.9, 0.045), (2.6, 0.035), (4.4, 0.05)):
        d = Vector((math.cos(a), math.sin(a), -0.1))
        p0 = Vector((0.034 * math.cos(a), 0.034 * math.sin(a), 0.012))
        it.wire(mb, [p0, p0 + d * l * 0.6, p0 + d * l + Vector((0, 0, -0.008))], 0.005, 6, 'chitin_edge')
        mb.cyl(0.0062, 0.0062, 0.006, 6, p0 + d * l + Vector((0, 0, -0.008)), 'resin', rot=track(d))


# ------------------------------------------------------------------------------------------------ servo heart

def build_servo_heart(mb, rng):
    """A guardian's knee servo (19 cm long) lying along X on its mounting foot: ribbed iron housing split by a
    glowing red seam, a red core lens behind a cross guard on the +X end cap, the output flange with its stub of
    leg lever on -X, a cable bundle torn off the top."""
    R, L = 0.05, 0.12
    cz = R + 0.016
    mb.box((L * 0.8, R * 1.6, 0.016), (0, 0, 0.008), 'guard_rust', bevel=0.003)
    mb.box((L * 0.5, R * 1.0, cz - 0.02), (0, 0, 0.016 + (cz - 0.02) / 2 - 0.004), 'guard_iron')
    for sx in (-1, 1):  # foot bolts
        for sy in (-1, 1):
            mb.cyl(0.006, 0.006, 0.006, 6, (sx * L * 0.33, sy * R * 0.62, 0.018), 'guard_steel')
    # Housing in two halves with a glowing seam between them.
    for sx in (-1, 1):
        mb.cyl(R, R, L / 2 - 0.006, 12, (sx * (L / 4 + 0.003), 0, cz), 'guard_iron', rot=Y90)
    mb.cyl(R * 0.94, R * 0.94, 0.008, 12, (0, 0, cz), 'weak_red', rot=Y90)
    for x in (-0.045, -0.03, 0.03, 0.045):  # cooling ribs
        mb.cyl(R * 1.1, R * 1.1, 0.006, 12, (x, 0, cz), 'guard_iron', rot=Y90)
    # +X end: steel cap ring, red core lens, a cross guard over it.
    ex = L / 2
    mb.cyl(R * 1.04, R * 0.9, 0.016, 12, (ex + 0.008, 0, cz), 'guard_steel', rot=Y90)
    mb.cyl(R * 0.62, R * 0.62, 0.008, 12, (ex + 0.018, 0, cz), 'weak_red', rot=Y90)
    mb.lathe([(0.0, 0.0), (R * 0.42, 0.0), (R * 0.3, 0.01), (0.0, 0.014)], 12, (ex + 0.02, 0, cz), 'weak_red',
             rot=Y90)
    for a in (math.pi / 4, -math.pi / 4):
        mb.box((0.006, R * 1.5, 0.008), (ex + 0.026, 0, cz), 'guard_iron', rot=(a, 0, 0))
    # -X end: output flange with bolt heads, a splined hub and the torn lever.
    fx = -L / 2
    mb.cyl(R * 1.18, R * 1.18, 0.014, 12, (fx - 0.007, 0, cz), 'guard_steel', rot=Y90)
    for k in range(6):
        a = 2 * math.pi * k / 6 + 0.26
        mb.cyl(0.0055, 0.0055, 0.008, 6, (fx - 0.016, R * 0.95 * math.cos(a), cz + R * 0.95 * math.sin(a)),
               'guard_iron', rot=Y90)
    mb.cyl(R * 0.45, R * 0.45, 0.02, 10, (fx - 0.022, 0, cz), 'guard_iron', rot=Y90)
    lever = mb.box((0.016, 0.03, 0.075), (fx - 0.034, 0, cz - 0.022), 'guard_rust', rot=(0.5, 0, 0))
    mb.jitter(lever, rng, 0.002)
    mb.cyl(0.012, 0.012, 0.02, 8, (fx - 0.034, 0, cz), 'guard_steel', rot=Y90)
    # Cable bundle out of a gland on top, torn short.
    mb.cyl(0.012, 0.014, 0.014, 8, (0.025, 0, cz + R + 0.004), 'guard_steel')
    for dy, m in ((-0.005, 'plastic_black'), (0.005, 'wire_red'), (0.0, 'plastic_black')):
        it.wire(mb, [(0.025, dy, cz + R + 0.01), (0.03 + dy, dy * 2, cz + R + 0.03), (0.05 + dy * 3, dy * 3,
                                                                                      cz + R + 0.035)],
                0.0035, 5, m)


# ------------------------------------------------------------------------------------------------ hive core

def build_hive_core(mb, rng):
    """The carrier's hive core: a hexagonal iron block (15 cm across) whose top is a honeycomb of seven cells,
    most glowing in the carrier's fire, two capped with ceramic; glowing slits and hazard stripes on the flanks."""
    RB, HB = 0.072, 0.075
    hex_prism(mb, RB + 0.005, 0.0, 0.012, 'CarrierRust')
    hex_prism(mb, RB, 0.012, HB, 'CarrierIron')
    hex_prism(mb, RB + 0.003, HB - 0.006, HB + 0.004, 'CarrierPlate')  # top rim
    # Flanks: faces sit at 30 + 60k degrees. Alternate a glowing slit and a ceramic plate, one with hazard stripes.
    ri = RB * math.cos(math.pi / 6)
    for k in range(6):
        a = math.pi / 6 + k * math.pi / 3
        ca, sa = math.cos(a), math.sin(a)
        if k % 2 == 0:
            mb.box((0.004, 0.012, 0.04), ((ri + 0.001) * ca, (ri + 0.001) * sa, 0.042), 'CarrierEye', rot=(0, 0, a))
            mb.box((0.005, 0.03, 0.05), ((ri - 0.0005) * ca, (ri - 0.0005) * sa, 0.042), 'CarrierDark', rot=(0, 0, a))
        else:
            mb.box((0.004, 0.05, 0.046), ((ri + 0.001) * ca, (ri + 0.001) * sa, 0.042), 'CarrierCeramic',
                   rot=(0, 0, a))
            if k == 5:
                for j in range(3):
                    mb.box((0.003, 0.008, 0.05), ((ri + 0.0025) * ca - (j - 1) * 0.016 * sa,
                                                 (ri + 0.0025) * sa + (j - 1) * 0.016 * ca, 0.042),
                           'CarrierHazard', rot=(0.0, 0.5, a))
    # Honeycomb: seven cells, raised dark walls round recessed glowing floors.
    rc, wall = 0.02, 0.0035
    centres = [(0.0, 0.0)] + [(math.sqrt(3) * rc * math.cos(math.pi / 6 + k * math.pi / 3),
                               math.sqrt(3) * rc * math.sin(math.pi / 6 + k * math.pi / 3)) for k in range(6)]
    for i, (cx, cy) in enumerate(centres):
        mb.ring_prism(hex_pts(rc, cx, cy), hex_pts(rc - wall, cx, cy), HB - 0.002, HB + 0.016, 'CarrierPlate')
        if i in (2, 5):  # capped cells
            hex_prism(mb, rc - wall, HB + 0.008, HB + 0.014, 'CarrierCeramic', cx, cy)
        else:
            hex_prism(mb, rc - wall, HB - 0.002, HB + 0.007 + (0.003 if i == 0 else 0), 'CarrierEye' if i != 4 else
                      'CarrierEyeDim', cx, cy)
    # A stub of the fan arm the core hung from, torn off.
    mb.box((0.03, 0.022, 0.016), (-RB - 0.006, 0, 0.03), 'CarrierPlate', rot=(0, 0, 0.1))
    it.wire(mb, [(-RB - 0.02, 0.006, 0.028), (-RB - 0.035, 0.012, 0.012)], 0.0035, 5, 'CarrierDark')


# ------------------------------------------------------------------------------------------------ queen eye

def build_queen_eye(mb, rng):
    """The queen's eye: a big faceted lens (11 cm) glowing in her colour, held in a dark iron socket by four claws,
    a hot pupil at its heart; cables torn from the back of the socket."""
    cz = 0.052
    mb.lathe([(0.0, 0.0), (0.06, 0.0), (0.066, 0.016), (0.062, 0.05), (0.054, 0.058), (0.045, 0.04), (0.0, 0.03)],
             12, (0, 0, 0), 'QueenIron')
    mb.torus(0.058, 0.006, 12, 5, (0, 0, 0.056), 'QueenSteel', smooth=False)
    lens = mb.blob(0.05, (0, 0, cz), 'QueenEye')
    for v in lens:
        v.co.z = cz + (v.co.z - cz) * 0.85
    pupil = mb.blob(0.022, (0.006, -0.012, cz + 0.026), 'QueenEyeHot')
    for v in pupil:
        v.co.z = cz + 0.026 + (v.co.z - cz - 0.026) * 0.6
    # Claws: four curved iron fingers from the rim over the lens.
    for k in range(4):
        a = 2 * math.pi * k / 4 + math.pi / 4
        ca, sa = math.cos(a), math.sin(a)
        pts = [(0.062 * ca, 0.062 * sa, 0.05), (0.058 * ca, 0.058 * sa, 0.07), (0.044 * ca, 0.044 * sa, 0.084),
               (0.032 * ca, 0.032 * sa, 0.088)]
        it.wire(mb, pts, 0.006, 5, 'QueenIron')
        mb.cyl(0.004, 0.0, 0.01, 5, pts[-1], 'QueenSteel', rot=track((-ca, -sa, -0.3)))
    # Rust streaks and torn cables at the back.
    mb.box((0.03, 0.004, 0.02), (-0.03, 0.058, 0.03), 'QueenRust', rot=(0, 0, 0.5))
    for a, m in ((2.4, 'QueenDark'), (2.8, 'QueenDark'), (3.2, 'QueenRust')):
        p = Vector((0.06 * math.cos(a), 0.06 * math.sin(a), 0.012))
        d = Vector((math.cos(a), math.sin(a), 0))
        it.wire(mb, [p, p + d * 0.02 + Vector((0, 0, -0.006)), p + d * 0.04 + Vector((0.004, 0, -0.008))], 0.005, 5, m)


# ------------------------------------------------------------------------------------------------ furnace heart

def build_furnace_heart(mb, rng):
    """The colossus' furnace heart: an iron cage sphere (15 cm) of meridian straps and latitude hoops with a
    bronze belt, the furnace glowing orange inside, embers bright at its core; a sooty grate foot and a flue stub."""
    R, cz = 0.068, 0.084
    mb.ball(R * 0.86, (0, 0, cz), 'ColossusGlow', u=12, v=8)
    mb.blob(0.03, (0.01, -0.02, cz + 0.01), 'ColossusEmber')
    for k in range(4):  # meridian straps: four vertical hoops
        mb.torus(R, 0.0055, 16, 4, (0, 0, cz), 'ColossusIron', rot=(math.pi / 2, 0, k * math.pi / 4 + 0.2),
                 smooth=False)
    for dz in (-0.036, 0.036):
        r = math.sqrt(R * R - dz * dz)
        mb.torus(r, 0.005, 16, 4, (0, 0, cz + dz), 'ColossusIron', smooth=False)
    mb.torus(R + 0.002, 0.008, 16, 4, (0, 0, cz), 'ColossusBronze', smooth=False)
    # Rivets on the belt.
    for k in range(8):
        a = 2 * math.pi * k / 8 + 0.2
        mb.cyl(0.004, 0.004, 0.006, 6, ((R + 0.01) * math.cos(a), (R + 0.01) * math.sin(a), cz), 'ColossusSoot',
               rot=track((math.cos(a), math.sin(a), 0)))
    # Foot: a sooty grate collar the sphere sits in.
    mb.lathe([(0.0, 0.0), (0.05, 0.0), (0.046, 0.014), (0.036, 0.024), (0.0, 0.024)], 10, (0, 0, 0), 'ColossusSoot')
    mb.lathe([(0.045, 0.0), (0.055, 0.0), (0.055, 0.008), (0.045, 0.008)], 10, (0, 0, 0), 'ColossusRust')
    # Flue stub on top, glowing at the mouth.
    mb.cyl(0.016, 0.014, 0.03, 8, (0, 0, cz + R + 0.008), 'ColossusIron')
    mb.cyl(0.011, 0.011, 0.004, 8, (0, 0, cz + R + 0.022), 'ColossusGlow')
    mb.cyl(0.019, 0.019, 0.006, 8, (0, 0, cz + R + 0.022), 'ColossusRust')


# ------------------------------------------------------------------------------------------------ worm tooth

def build_worm_tooth(mb, rng):
    """One of the worm's teeth: a big hooked blade (18 cm) curving forward (+X) off a torn iron root plate, its
    concave edge honed and serrated with backward hooks."""
    Rc, sweep, z0 = 0.17, 1.05, 0.022
    n = 12

    def frame(t):
        phi = sweep * t
        p = Vector((Rc - Rc * math.cos(phi), 0, z0 + Rc * math.sin(phi)))
        inward = Vector((math.cos(phi), 0, -math.sin(phi)))  # towards the centre of curvature: the cutting edge
        return p, inward

    secs = []
    for j in range(n + 1):
        t = j / n
        p, nn = frame(t)
        w = 0.052 * (1 - t) ** 0.85 + 0.003
        th = 0.02 * (1 - t) + 0.0015
        y = Vector((0, 1, 0))
        shape = [(0.5, 0.0), (0.25, 0.35), (-0.1, 0.5), (-0.42, 0.32), (-0.5, 0.0), (-0.42, -0.32), (-0.1, -0.5),
                 (0.25, -0.35)]
        secs.append([tuple(p + nn * (u * w) + y * (v * th)) for u, v in shape])
    mb.loft(secs, 'WormSteel')
    # Honed edge strip and serrations along the concave edge, hooked back towards the root.
    edge = []
    for j in range(n):
        t = j / n
        p, nn = frame(t)
        w = 0.052 * (1 - t) ** 0.85 + 0.003
        edge.append(p + nn * (w * 0.47))
    it.wire(mb, edge, 0.0022, 4, 'WormEdge')
    for j in range(1, 9):
        t = 0.06 + j * 0.085
        p, nn = frame(t)
        w = 0.052 * (1 - t) ** 0.85 + 0.003
        tang = Vector((math.sin(sweep * t), 0, math.cos(sweep * t)))
        base = p + nn * (w * 0.45)
        d = (nn - tang * 0.6).normalized()
        sz = 0.012 * (1 - t * 0.6)
        mb.cyl(sz * 0.6, 0.0, sz * 1.4, 4, base + d * sz * 0.6, 'WormEdge', rot=track(d))
    # Root: the socket block it was torn from, bolted, with a rusted torn lip.
    mb.box((0.07, 0.042, z0 + 0.004), (0.004, 0, (z0 + 0.004) / 2), 'WormIron', bevel=0.004)
    mb.box((0.074, 0.046, 0.007), (0.004, 0, 0.0035), 'WormRust')
    for x in (-0.022, 0.03):
        for y in (-0.013, 0.013):
            mb.cyl(0.0045, 0.0045, 0.006, 6, (x, y, z0 + 0.005), 'WormSteel')
    lip = mb.box((0.03, 0.05, 0.006), (-0.042, 0, 0.012), 'WormRust', rot=(0, -0.5, 0.15))
    mb.jitter(lip, rng, 0.002)


# ------------------------------------------------------------------------------------------------ table

BUILDERS = {'drone_transponder': build_drone_transponder, 'brood_gland': build_brood_gland,
            'servo_heart': build_servo_heart, 'hive_core': build_hive_core, 'queen_eye': build_queen_eye,
            'furnace_heart': build_furnace_heart, 'worm_tooth': build_worm_tooth}


def build_relic(kind):
    mb = it.MeshBuilder()
    BUILDERS[kind](mb, it.Rng(KINDS.index(kind) * 13 + 5))
    # Origin at the centre of the base: centre x/y, lowest point on z = 0.
    bmesh.ops.recalc_face_normals(mb.bm, faces=mb.bm.faces)
    xs = [v.co.x for v in mb.bm.verts]
    ys = [v.co.y for v in mb.bm.verts]
    zmin = min(v.co.z for v in mb.bm.verts)
    shift = Vector((-(min(xs) + max(xs)) / 2, -(min(ys) + max(ys)) / 2, -zmin))
    bmesh.ops.translate(mb.bm, vec=shift, verts=mb.bm.verts)
    mesh = bpy.data.meshes.new(kind)
    mb.bm.normal_update()
    mb.bm.to_mesh(mesh)
    mb.bm.free()
    for m in mb.mats:
        mesh.materials.append(bpy.data.materials[m])
    obj = bpy.data.objects.new(kind, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--kind', choices=KINDS, action='append', help='only this relic (repeatable)')
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models', 'items'))
    ap.add_argument('--icons', default=os.path.join(ROOT, 'public', 'icons', 'items'))
    ap.add_argument('--icon-size', type=int, default=128)
    ap.add_argument('--no-icons', action='store_true')
    ap.add_argument('--preview', default=None, help='render a PNG of every built relic side by side')
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in {**it.MATERIALS, **MATERIALS}.items():
        it.make_material(name, *spec)

    os.makedirs(args.out, exist_ok=True)
    objs = {}
    for kind in args.kind or KINDS:
        obj = build_relic(kind)
        it.export_glb(obj, os.path.join(args.out, kind + '.glb'))
        d = obj.dimensions
        print(f'{kind}: tris={it.tri_count(obj)} size={d.x:.3f} x {d.y:.3f} x {d.z:.3f} m')
        objs[kind] = [obj]

    if not args.no_icons:
        it.render_icons(objs, args.icons, args.icon_size)
    if args.preview:
        # One row on the sand.
        flat = {k: v for k, v in objs.items()}
        scene = bpy.context.scene
        cam = scene.camera or it.setup_render(scene, 1600, 900)
        scene.render.resolution_x, scene.render.resolution_y = 1600, 900
        scene.render.film_transparent = False
        scene.render.use_freestyle = False
        bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))
        bpy.context.active_object.data.materials.append(it.make_material('ground', 0xd9a066, 0, 0.9, 0))
        for i, (kind, (obj,)) in enumerate(flat.items()):
            obj.location = ((i - (len(flat) - 1) / 2) * 0.24, 0, 0)
        cam.data.type = 'PERSP'
        cam.data.lens = 50
        it.aim(cam, Vector((0, 0, 0.06)), 0.32 * len(flat) + 0.4)
        scene.render.filepath = os.path.abspath(args.preview)
        bpy.ops.render.render(write_still=True)


main()
