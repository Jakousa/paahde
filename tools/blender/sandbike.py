"""Scavenged desert dirt bike ("sand bike"), exported as a glTF binary with animatable parts.

    blender -b --python tools/blender/sandbike.py                         # writes public/models/sandbike.glb
    blender -b --python tools/blender/sandbike.py -- --preview out.png    # also renders out.png (3/4) + out_side.png

A junkyard sand-skimmer: balloon tyres with paddle treads, exposed finned single-cylinder engine, a low
exhaust running along the right side to a dented muffler, faded teal tank with rusty patch plates,
mismatched side panels, a jerry can strapped to the rear rack and a crooked number-plate fairing.

Blender is Z-up and the bike faces Blender +Y; the glTF exporter (Y-up) turns that into three.js -Z, so in
the game the bike's FRONT points along -Z and its right side along +X. Units are metres; the origin is on
the ground, midway between the two tyre contact patches.

Node hierarchy (all node rotations are identity, scale 1):
    Sandbike             empty at the origin
      Body               frame, engine, tank, seat, exhaust, swingarm, fenders, rack (origin at ground)
      RearWheel          origin at the rear axle; spin about local X
      Handlebar          origin at the steering-head pivot; steer by rotating about STEER_AXIS
        FrontWheel       origin at the front axle; spin about local X (it follows the steering)
Rolling forward (towards three.js -Z) is a negative rotation about X: wheel.rotation.x -= distance / radius.

Output is deterministic (fixed seeds, no Blender randomness).
"""

import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

# ----------------------------------------------------------------------------------------------- layout
# Blender coordinates: +X right, +Y forward, +Z up.
WHEEL_R = 0.37            # overall radius, paddle tips included (= axle height)
CARCASS_R = 0.335         # tyre body radius under the paddles
RIM_R = 0.16
WHEELBASE = 1.36
REAR_W = 0.30             # rear tyre width
FRONT_W = 0.25
REAR_AXLE = Vector((0, -WHEELBASE / 2, WHEEL_R))
FRONT_AXLE = Vector((0, WHEELBASE / 2, WHEEL_R))
RAKE = math.radians(24)
STEER_AXIS = Vector((0, -math.sin(RAKE), math.cos(RAKE)))  # up along the fork
PIVOT = FRONT_AXLE + STEER_AXIS * ((0.98 - WHEEL_R) / math.cos(RAKE))  # steering head, z = 0.98
SEAT_TOP = 0.86
SEAT_Y = (-0.62, 0.0)

# Materials: name -> (sRGB hex, metallic, roughness, emission strength).
MATERIALS = {
    'tyre': (0x2b2420, 0.0, 0.95, 0),
    'tyre_side': (0x3a302a, 0.0, 0.95, 0),
    'rim': (0xc0782e, 0.3, 0.6, 0),          # faded orange paint
    'hub': (0x7d776e, 0.6, 0.6, 0),
    'frame': (0x3b3633, 0.5, 0.6, 0),        # dark painted tube, scuffed
    'rust': (0x8a4a24, 0.3, 0.9, 0),
    'rust_dark': (0x5a2f18, 0.3, 0.95, 0),
    'teal': (0x3f8a84, 0.15, 0.7, 0),        # faded tank paint, contrasts the orange desert
    'teal_dark': (0x2c625e, 0.15, 0.75, 0),
    'cream': (0xd8c49a, 0.05, 0.8, 0),       # mismatched panels / plate
    'red': (0xa8382a, 0.1, 0.7, 0),
    'olive': (0x6b6a35, 0.1, 0.8, 0),        # jerry can
    'steel': (0x9a958c, 0.75, 0.45, 0),
    'engine': (0x8c8880, 0.6, 0.55, 0),
    'engine_dark': (0x4a4744, 0.5, 0.6, 0),
    'exhaust': (0x5e4636, 0.6, 0.7, 0),      # heat-blued / burnt pipe
    'seat': (0x3a2a20, 0.0, 0.8, 0),
    'tape': (0x9a9890, 0.0, 0.8, 0),
    'spring': (0xd8962c, 0.3, 0.5, 0),
    'lamp': (0xffd890, 0.0, 0.3, 4),
    'tail': (0xff3a20, 0.0, 0.4, 2),
    'grip': (0x1e1c1a, 0.0, 0.9, 0),
}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def make_material(name, hex_color, metallic, roughness, emission):
    mat = bpy.data.materials.new(name)
    rgb = [srgb_to_linear(((hex_color >> s) & 0xFF) / 255) for s in (16, 8, 0)]
    mat.diffuse_color = (*rgb, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    if emission:
        bsdf.inputs['Emission Color'].default_value = (*rgb, 1)
        bsdf.inputs['Emission Strength'].default_value = emission
    mat.use_backface_culling = True
    return mat


class Rng:
    """Tiny deterministic LCG so re-running the script gives identical models."""

    def __init__(self, seed):
        self.s = seed * 2654435761 % 2**32 or 1

    def __call__(self, a=0.0, b=1.0):
        self.s = (1664525 * self.s + 1013904223) % 2**32
        return a + (b - a) * self.s / 2**32


class MeshBuilder:
    """One bmesh per node, built in world space; every primitive gets its own material."""

    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []

    def mat(self, name):
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    def _finish(self, verts, mat, m=None):
        if m is not None:
            bmesh.ops.transform(self.bm, matrix=m, verts=verts)
        idx = self.mat(mat)
        for f in {f for v in verts for f in v.link_faces}:
            f.material_index = idx
            f.smooth = False
        return verts

    def box(self, size, loc, mat, rot=(0, 0, 0), taper=None):
        """Box centred on loc. taper=(sx, sy) scales the top face (local +Z) for wedge shapes."""
        verts = bmesh.ops.create_cube(self.bm, size=1)['verts']
        for v in verts:
            if taper and v.co.z > 0:
                v.co.x *= taper[0]
                v.co.y *= taper[1]
            v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
        m = Matrix.Translation(Vector(loc)) @ Euler(rot).to_matrix().to_4x4()
        return self._finish(verts, mat, m)

    def cyl(self, r1, r2, depth, segs, loc, mat, rot=(0, 0, 0)):
        """Cylinder/cone along local Z, centred on loc."""
        verts = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segs,
                                      radius1=r1, radius2=r2, depth=depth)['verts']
        m = Matrix.Translation(Vector(loc)) @ Euler(rot).to_matrix().to_4x4()
        return self._finish(verts, mat, m)

    def tube(self, a, b, r, mat, segs=6, r2=None):
        """Straight tube (or cone) from point a to point b."""
        a, b = Vector(a), Vector(b)
        d = b - a
        verts = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segs,
                                      radius1=r, radius2=r if r2 is None else r2, depth=d.length)['verts']
        q = d.normalized().to_track_quat('Z', 'Y')
        m = Matrix.Translation((a + b) / 2) @ q.to_matrix().to_4x4()
        return self._finish(verts, mat, m)

    def sweep(self, pts, r, mat, segs=7, radii=None):
        """Bent tube through a polyline with shared rings at the joints (exhaust, bars)."""
        pts = [Vector(p) for p in pts]
        rings = []
        ref = Vector((1, 0, 0))
        for i, p in enumerate(pts):
            t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
            if abs(t.dot(ref)) > 0.9:
                ref = Vector((0, 0, 1))
            u = (ref - t * ref.dot(t)).normalized()
            w = t.cross(u)
            rr = radii[i] if radii else r
            rings.append([self.bm.verts.new(p + (u * math.cos(a) + w * math.sin(a)) * rr)
                          for a in (2 * math.pi * k / segs for k in range(segs))])
            ref = u
        faces = []
        for lo, hi in zip(rings, rings[1:]):
            for k in range(segs):
                j = (k + 1) % segs
                faces.append(self.bm.faces.new([lo[k], lo[j], hi[j], hi[k]]))
        faces.append(self.bm.faces.new(list(reversed(rings[0]))))
        faces.append(self.bm.faces.new(rings[-1]))
        verts = [v for ring in rings for v in ring]
        return self._finish(verts, mat)

    def arc_band(self, center, r_in, r_out, width, a0, a1, segs, mat, x=0.0):
        """Curved strip around an X-axis line (fenders). Angles in the YZ plane, 0 = +Y (front), 90 = up."""
        c = Vector(center)
        secs = []
        for i in range(segs + 1):
            a = math.radians(a0 + (a1 - a0) * i / segs)
            d = Vector((0, math.cos(a), math.sin(a)))
            secs.append([self.bm.verts.new(c + Vector((x + sx * width / 2, 0, 0)) + d * r)
                         for sx, r in ((-1, r_out), (1, r_out), (1, r_in), (-1, r_in))])
        for s0, s1 in zip(secs, secs[1:]):
            for k in range(4):
                j = (k + 1) % 4
                self.bm.faces.new([s0[k], s1[k], s1[j], s0[j]])
        self.bm.faces.new(list(reversed(secs[0])))
        self.bm.faces.new(secs[-1])
        verts = [v for s in secs for v in s]
        bmesh.ops.recalc_face_normals(self.bm, faces=list({f for v in verts for f in v.link_faces}))
        return self._finish(verts, mat)

    def lathe(self, profile, segs, center, mat):
        """Revolve a closed (x, r) profile about the X axis through center (tyres)."""
        c = Vector(center)
        rings = []
        for i in range(segs):
            a = 2 * math.pi * (i + 0.5) / segs
            rings.append([self.bm.verts.new(c + Vector((x, math.cos(a) * r, math.sin(a) * r)))
                          for x, r in profile])
        n = len(profile)
        for i in range(segs):
            r0, r1 = rings[i], rings[(i + 1) % segs]
            for k in range(n):
                j = (k + 1) % n
                self.bm.faces.new([r0[k], r1[k], r1[j], r0[j]])
        verts = [v for r in rings for v in r]
        bmesh.ops.recalc_face_normals(self.bm, faces=list({f for v in verts for f in v.link_faces}))
        return self._finish(verts, mat)

    def jitter(self, verts, rng, amount):
        for v in verts:
            v.co += Vector((rng(-amount, amount), rng(-amount, amount), rng(-amount, amount)))

    def dent(self, verts, center, radius, depth):
        c = Vector(center)
        mid = sum((v.co for v in verts), Vector()) / len(verts)
        for v in verts:
            d = (v.co - c).length
            if d < radius:
                v.co += (mid - v.co).normalized() * depth * (1 - d / radius)


Y90 = (0, math.pi / 2, 0)  # turns a Z-axis cylinder to lie along X (axles)
X90 = (math.pi / 2, 0, 0)  # ... along Y


# ------------------------------------------------------------------------------------------------ wheels

def build_wheel(mb, axle, width, paddles, rng, front):
    """Balloon tyre (lathed) + paddle treads + rim and hub, centred on `axle`."""
    h = width / 2
    # Closed cross-section, (axial x, radius): fat rounded balloon, tucked in at the rim.
    profile = [
        (-h * 0.72, RIM_R + 0.01), (-h, RIM_R + 0.06), (-h * 0.9, CARCASS_R - 0.03), (-h * 0.45, CARCASS_R),
        (h * 0.45, CARCASS_R), (h * 0.9, CARCASS_R - 0.03), (h, RIM_R + 0.06), (h * 0.72, RIM_R + 0.01),
    ]
    segs = 16
    mb.lathe(profile, segs, axle, 'tyre')

    # Treads: the rear gets full-width paddles (sand scoops), the front staggered chunky knobs.
    depth = WHEEL_R - CARCASS_R + 0.012
    for i in range(paddles):
        a = 2 * math.pi * i / paddles
        d = Vector((0, math.cos(a), math.sin(a)))
        if front:
            for sx in ((-0.5, 0.5) if i % 2 == 0 else (0.0,)):
                c = axle + Vector((sx * width * 0.62, 0, 0)) + d * (CARCASS_R + depth / 2 - 0.012)
                mb.box((width * 0.34, 0.075, depth), c, 'tyre_side', rot=(a - math.pi / 2, 0, 0))
        else:
            c = axle + d * (CARCASS_R + depth / 2 - 0.012)
            # Slightly chevroned: the paddle leans back so it bites.
            mb.box((width * 1.04, 0.045, depth), c, 'tyre_side', rot=(a - math.pi / 2 + 0.25, 0, 0))

    # Rim: a fat painted drum (the inner faces read as the wheel disc), with a hub and bolts.
    mb.cyl(RIM_R + 0.012, RIM_R + 0.012, width * 0.74, 14, axle, 'rim', rot=Y90)
    for sx in (-1, 1):
        mb.cyl(0.07, 0.055, 0.05, 8, axle + Vector((sx * (width * 0.37 + 0.02), 0, 0)), 'hub',
               rot=(0, sx * math.pi / 2, 0))
    # A rust-patched rim section on one side for the scrap look.
    mb.box((0.012, 0.13, 0.08), axle + Vector((-(width * 0.37 + 0.004), 0.07, -0.08)), 'rust', rot=(0.5, 0, 0))


# -------------------------------------------------------------------------------------------- handlebar

def build_handlebar(mb, rng):
    """Fork, triple clamps, bars, headlight, number-plate fairing and front fender (all steer together)."""
    u = STEER_AXIS
    fwd = Vector((0, math.cos(RAKE), math.sin(RAKE)))  # perpendicular to the steering axis, forwards
    top = PIVOT + u * 0.12
    bot = PIVOT - u * 0.1
    fx = FRONT_W / 2 + 0.04
    # Fork: fat stanchions with rubber gaiters, sliders down to the axle.
    for sx in (-1, 1):
        o = Vector((sx * fx, 0, 0))
        mb.tube(top + o + u * 0.04, bot + o, 0.03, 'steel', 6)
        mid = FRONT_AXLE + o + u * 0.32
        mb.tube(bot + o, mid, 0.036, 'grip', 6)                       # gaiter
        mb.tube(mid, FRONT_AXLE + o - u * 0.02, 0.042, 'frame', 6)    # slider
        mb.box((0.03, 0.08, 0.05), FRONT_AXLE + o, 'frame')         # axle lug
    mb.tube(FRONT_AXLE + Vector((-fx - 0.03, 0, 0)), FRONT_AXLE + Vector((fx + 0.03, 0, 0)), 0.018, 'steel', 6)
    # Triple clamps.
    for p, t in ((top, 0.04), (bot, 0.05)):
        mb.box((fx * 2 + 0.1, 0.11, t), p, 'rust_dark', rot=(RAKE, 0, 0))
    # Risers and a wide swept bar, chunky grips, levers.
    riser_top = top + Vector((0, -0.03, 0.05))
    mb.tube(top, riser_top, 0.022, 'steel', 6)
    bar = [Vector((-0.38, riser_top.y - 0.09, riser_top.z + 0.03)),
           Vector((-0.2, riser_top.y - 0.02, riser_top.z + 0.01)),
           Vector((0.0, riser_top.y, riser_top.z)),
           Vector((0.2, riser_top.y - 0.02, riser_top.z + 0.01)),
           Vector((0.38, riser_top.y - 0.09, riser_top.z + 0.03))]
    mb.sweep(bar, 0.016, 'steel', segs=6)
    for sx in (-1, 1):
        a, b = bar[0 if sx < 0 else 4], bar[1 if sx < 0 else 3]
        d = (a - b).normalized()
        mb.tube(a - d * 0.11, a + d * 0.02, 0.024, 'grip', 7)
        mb.tube(a - d * 0.13 + Vector((0, 0.03, 0)), a - d * 0.02 + Vector((0, 0.09, -0.02)), 0.008, 'steel', 4)
    mb.cyl(0.035, 0.035, 0.03, 8, riser_top + Vector((0.08, 0.0, 0.03)), 'engine_dark', rot=(0.4, 0, 0))  # gauge
    mb.box((0.15, 0.015, 0.05), riser_top + Vector((0, 0.03, 0.035)), 'red', rot=(0.3, 0, 0))   # bar pad

    # Number-plate fairing: a crooked cream plate with a red stripe and a tape patch, headlight in front.
    plate_c = PIVOT + fwd * 0.13 + u * 0.0
    mb.box((0.32, 0.025, 0.3), plate_c, 'cream', rot=(RAKE, 0, 0.04), taper=(0.7, 1))
    mb.box((0.345, 0.03, 0.05), plate_c + u * 0.1, 'red', rot=(RAKE, 0, 0.04))
    mb.box((0.06, 0.032, 0.16), plate_c + Vector((0.1, 0, -0.07)), 'tape', rot=(RAKE, 0, 0.5))
    lamp_c = plate_c + fwd * 0.07 - u * 0.03
    lamp = mb.cyl(0.085, 0.07, 0.11, 10, lamp_c, 'rust', rot=(RAKE - math.pi / 2, 0, 0))
    mb.cyl(0.07, 0.07, 0.02, 10, lamp_c + fwd * 0.055, 'lamp', rot=(RAKE - math.pi / 2, 0, 0))
    del lamp
    # Wire-guard over the lamp.
    mb.tube(lamp_c + fwd * 0.07 + u * 0.08, lamp_c + fwd * 0.07 - u * 0.08, 0.006, 'steel', 4)

    # Front fender: high mudguard over the tyre, on the fork brace.
    fend = mb.arc_band(FRONT_AXLE, WHEEL_R + 0.03, WHEEL_R + 0.045, FRONT_W + 0.06, 20, 125, 7, 'teal')
    mb.dent(fend, FRONT_AXLE + Vector((0.1, 0.25, 0.3)), 0.12, 0.012)
    mb.box((fx * 2 + 0.08, 0.06, 0.03), FRONT_AXLE + u * (WHEEL_R + 0.06), 'frame', rot=(RAKE, 0, 0))


# ------------------------------------------------------------------------------------------------- body

def build_body(mb, rng):
    u = STEER_AXIS
    head_top = PIVOT + u * 0.12
    head_bot = PIVOT - u * 0.1
    mb.tube(head_bot - u * 0.02, head_top + u * 0.02, 0.045, 'frame', 8)   # steering head

    # Frame: backbone, twin cradle under the engine, rear subframe.
    seat_front = Vector((0, -0.05, 0.74))
    mb.sweep([PIVOT + u * 0.05, Vector((0, 0.15, 0.82)), seat_front], 0.032, 'frame', segs=6)
    for sx in (-1, 1):
        x = sx * 0.085
        cradle = [head_bot, Vector((x, 0.32, 0.45)), Vector((x, 0.26, 0.2)), Vector((x, -0.12, 0.2)),
                  Vector((x, -0.18, 0.4)), Vector((x, -0.1, 0.74))]
        mb.sweep(cradle, 0.022, 'frame', segs=5)
        mb.tube(Vector((x, -0.08, 0.74)), Vector((sx * 0.11, -0.78, 0.8)), 0.017, 'frame', 6)  # seat rail
        mb.tube(Vector((x, -0.17, 0.42)), Vector((sx * 0.11, -0.6, 0.79)), 0.016, 'frame', 6)  # strut
    # Skid plate under the engine (rusty, dented).
    skid = mb.box((0.24, 0.5, 0.025), (0, 0.06, 0.18), 'rust', rot=(0.06, 0, 0))
    mb.jitter(skid, rng, 0.006)

    # Swingarm: two box arms from the pivot to the rear axle, cross brace, shock.
    pivot_sa = Vector((0, -0.16, 0.42))
    sax = REAR_W / 2 + 0.04
    for sx in (-1, 1):
        a = Vector((sx * 0.1, pivot_sa.y, pivot_sa.z))
        b = Vector((sx * sax, REAR_AXLE.y, REAR_AXLE.z))
        mb.sweep([a, Vector((sx * sax, -0.32, 0.42)), b], 0.028, 'rust_dark', segs=5)
        mb.box((0.03, 0.09, 0.06), b, 'frame')
    mb.tube(Vector((-0.12, -0.16, 0.42)), Vector((0.12, -0.16, 0.42)), 0.03, 'steel', 8)  # pivot bolt
    mb.tube(Vector((-sax, -0.36, 0.43)), Vector((sax, -0.36, 0.43)), 0.022, 'rust_dark', 6)
    mb.tube(Vector((-sax - 0.03, REAR_AXLE.y, REAR_AXLE.z)), Vector((sax + 0.03, REAR_AXLE.y, REAR_AXLE.z)),
            0.018, 'steel', 6)
    sh_a, sh_b = Vector((0, -0.36, 0.44)), Vector((0, -0.18, 0.74))
    mb.tube(sh_a, sh_b, 0.022, 'steel', 6)
    mb.tube(sh_a.lerp(sh_b, 0.2), sh_a.lerp(sh_b, 0.85), 0.042, 'spring', 8)
    mb.cyl(0.04, 0.04, 0.1, 8, sh_b + Vector((0.07, 0.0, -0.02)), 'engine_dark', rot=X90)  # reservoir

    # Engine: crankcase, finned barrel tilted forward, head, side covers, carb + air filter.
    mb.box((0.25, 0.36, 0.22), (0, 0.04, 0.34), 'engine', taper=(1, 0.85))
    mb.cyl(0.11, 0.11, 0.05, 10, (-0.14, -0.0, 0.34), 'engine_dark', rot=Y90)      # clutch cover
    mb.cyl(0.07, 0.07, 0.04, 8, (0.135, 0.08, 0.33), 'engine', rot=Y90)            # stator cover
    tilt = (-0.35, 0, 0)  # barrel leans forward
    axis = Vector((0, math.sin(0.35), math.cos(0.35)))
    base = Vector((0, 0.1, 0.45))
    mb.box((0.15, 0.15, 0.24), base + axis * 0.12, 'engine_dark', rot=tilt)
    for k in range(5):
        mb.box((0.23 - k * 0.006, 0.21 - k * 0.006, 0.014), base + axis * (0.03 + k * 0.045), 'engine', rot=tilt)
    head_c = base + axis * 0.27
    mb.box((0.22, 0.2, 0.07), head_c, 'engine', rot=tilt)
    mb.box((0.16, 0.14, 0.04), head_c + axis * 0.05, 'red', rot=tilt)               # valve cover
    mb.cyl(0.012, 0.012, 0.06, 5, head_c + axis * 0.07 + Vector((0, -0.05, 0.02)), 'grip', rot=(-0.9, 0, 0))
    carb = Vector((0, -0.04, 0.6))
    mb.tube(head_c + Vector((0, -0.08, -0.02)), carb, 0.03, 'steel', 6)
    filt = mb.cyl(0.075, 0.075, 0.13, 9, carb + Vector((-0.07, -0.06, -0.01)), 'tape', rot=(0, 1.2, 0.5))
    mb.jitter(filt, rng, 0.006)
    # Spark-plug wire.
    mb.sweep([head_c + axis * 0.07 + Vector((0, -0.07, 0.03)), Vector((-0.1, 0.0, 0.72)), Vector((-0.12, -0.08, 0.7))],
             0.006, 'red', segs=4)

    # Chain run on the left side.
    chain_x = -0.165
    for (y0, z0), (y1, z1) in (((-0.02, 0.4), (REAR_AXLE.y, REAR_AXLE.z + 0.1)),
                               ((-0.02, 0.29), (REAR_AXLE.y, REAR_AXLE.z - 0.1))):
        mb.tube(Vector((chain_x, y0, z0)), Vector((chain_x, y1, z1)), 0.009, 'grip', 4)
    mb.cyl(0.11, 0.11, 0.015, 12, (chain_x, REAR_AXLE.y, REAR_AXLE.z), 'steel', rot=Y90)  # rear sprocket

    # Exhaust: out of the head, down in front of the engine, along the right side low, up to the muffler.
    port = head_c + Vector((0.02, 0.09, -0.02))
    pipe = [port, port + Vector((0.06, 0.06, -0.08)), Vector((0.14, 0.3, 0.42)), Vector((0.16, 0.25, 0.26)),
            Vector((0.19, 0.06, 0.22)), Vector((0.21, -0.12, 0.3)), Vector((0.23, -0.3, 0.52))]
    mb.sweep(pipe, 0.03, 'exhaust', segs=7)
    muf_a, muf_b = Vector((0.23, -0.28, 0.55)), Vector((0.24, -0.82, 0.72))
    muffler = mb.tube(muf_a, muf_b, 0.07, 'steel', 9, r2=0.062)
    mb.dent(muffler, muf_a.lerp(muf_b, 0.4) + Vector((0.06, 0, 0.03)), 0.09, 0.02)
    mb.tube(muf_b - (muf_b - muf_a).normalized() * 0.02, muf_b + (muf_b - muf_a).normalized() * 0.06, 0.03,
            'rust_dark', 7)
    mb.box((0.012, 0.22, 0.1), muf_a.lerp(muf_b, 0.55) + Vector((0.07, 0, 0)), 'rust',
           rot=(math.atan2(muf_b.z - muf_a.z, muf_b.y - muf_a.y) * -1 + math.pi, 0, 0))  # heat shield
    for t in (0.2, 0.8):  # hose-clamp bands
        mb.tube(muf_a.lerp(muf_b, t - 0.02), muf_a.lerp(muf_b, t + 0.02), 0.075, 'rust_dark', 9)

    # Fuel tank: tapered teal box over the backbone, rusty patch plates, filler cap, knee dents.
    tank = mb.box((0.36, 0.42, 0.22), (0, 0.13, 0.87), 'teal', rot=(0.12, 0, 0), taper=(0.75, 0.85))
    mb.dent(tank, (0.18, 0.05, 0.86), 0.1, 0.02)
    mb.jitter(tank, rng, 0.004)
    mb.box((0.38, 0.12, 0.06), (0, 0.27, 0.78), 'teal_dark', rot=(0.25, 0, 0))     # lower lip
    mb.box((0.015, 0.14, 0.1), (-0.175, 0.1, 0.85), 'rust', rot=(0.1, 0.15, 0.2))   # patch, left
    mb.box((0.015, 0.1, 0.08), (0.165, 0.2, 0.88), 'cream', rot=(-0.2, -0.2, 0.05))  # patch, right
    for p in ((-0.184, 0.06, 0.82), (-0.184, 0.15, 0.9), (0.174, 0.16, 0.85), (0.174, 0.24, 0.92)):
        mb.box((0.012, 0.015, 0.015), p, 'steel')                                  # rivets
    mb.cyl(0.04, 0.035, 0.03, 8, (0, 0.14, 1.0), 'steel', rot=(0.12, 0, 0))         # filler cap

    # Seat: thick slab, patched with tape.
    sy0, sy1 = SEAT_Y
    seat = mb.box((0.27, sy1 - sy0, 0.1), (0, (sy0 + sy1) / 2, SEAT_TOP - 0.05), 'seat', taper=(0.85, 0.97))
    mb.jitter(seat, rng, 0.004)
    mb.box((0.276, 0.07, 0.102), (0, -0.4, SEAT_TOP - 0.05), 'tape', rot=(0, 0, 0.06))
    mb.box((0.12, 0.05, 0.102), (0.04, -0.15, SEAT_TOP - 0.046), 'tape', rot=(0, 0, -0.5))
    mb.box((0.24, 0.12, 0.08), (0, 0.02, SEAT_TOP - 0.07), 'seat', rot=(-0.4, 0, 0))   # nose up the tank

    # Side panels: mismatched, one faded cream with a number, one rusty orange sheet; rivets.
    for sx, mat in ((-1, 'cream'), (1, 'rim')):
        pnl = mb.box((0.02, 0.36, 0.2), (sx * 0.15, -0.3, 0.66), mat, rot=(0.25, 0, 0), taper=(1, 0.7))
        mb.jitter(pnl, rng, 0.006)
    mb.box((0.022, 0.1, 0.1), (-0.155, -0.28, 0.66), 'red', rot=(0.25, 0, 0))       # number roundel
    mb.box((0.02, 0.025, 0.07), (0.16, -0.36, 0.66), 'rust_dark', rot=(0.3, 0, 0.0))

    # Rear fender + tail light.
    rf = mb.arc_band(REAR_AXLE, WHEEL_R + 0.03, WHEEL_R + 0.045, REAR_W + 0.04, 55, 168, 7, 'rust')
    mb.dent(rf, REAR_AXLE + Vector((-0.12, -0.25, 0.32)), 0.12, 0.015)
    mb.box((0.1, 0.04, 0.05), (0, -1.0, 0.68), 'tail', rot=(0.5, 0, 0))

    # Rear rack with a strapped jerry can and a coil of rope.
    rack_y0, rack_y1, rack_z = -0.62, -0.95, 0.82
    for sx in (-1, 1):
        mb.tube(Vector((sx * 0.11, -0.6, 0.79)), Vector((sx * 0.13, rack_y1, rack_z)), 0.013, 'steel', 5)
        mb.tube(Vector((sx * 0.13, rack_y1, rack_z)), Vector((sx * 0.13, -0.88, 0.62)), 0.012, 'steel', 5)
    for y in (rack_y0, -0.78, rack_y1):
        mb.tube(Vector((-0.14, y, rack_z)), Vector((0.14, y, rack_z)), 0.011, 'steel', 5)
    can_c = Vector((0, -0.8, rack_z + 0.13))
    can = mb.box((0.17, 0.3, 0.24), can_c, 'olive', rot=(0, 0, math.pi / 2 * 0 + 0.05))
    mb.dent(can, can_c + Vector((0.09, 0.05, 0.03)), 0.08, 0.015)
    mb.box((0.06, 0.04, 0.05), can_c + Vector((0, 0.12, 0.13)), 'olive')           # spout
    mb.box((0.04, 0.12, 0.03), can_c + Vector((0, 0.0, 0.135)), 'olive')           # handle
    mb.box((0.19, 0.035, 0.26), can_c + Vector((0, 0.06, -0.005)), 'red', rot=(0, 0, 0.05))  # strap
    mb.box((0.19, 0.035, 0.26), can_c + Vector((0, -0.08, -0.005)), 'red', rot=(0, 0, 0.05))

    # Footpegs.
    for sx in (-1, 1):
        mb.box((0.11, 0.04, 0.03), (sx * 0.2, -0.12, 0.34), 'steel')


# ------------------------------------------------------------------------------------------------ build

def make_object(name, mb, origin, parent=None):
    """Turn a world-space MeshBuilder into an object whose origin sits at `origin` (world)."""
    bmesh.ops.translate(mb.bm, vec=-Vector(origin), verts=mb.bm.verts)
    # Drop zero-size placeholder geometry, merge nothing else (flat-shaded pieces stay separate).
    bmesh.ops.dissolve_degenerate(mb.bm, dist=1e-5, edges=mb.bm.edges)
    loose = [v for v in mb.bm.verts if not v.link_faces]
    bmesh.ops.delete(mb.bm, geom=loose, context='VERTS')
    mb.bm.normal_update()
    mesh = bpy.data.meshes.new(name)
    mb.bm.to_mesh(mesh)
    mb.bm.free()
    for m in mb.mats:
        mesh.materials.append(bpy.data.materials[m])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    if parent is not None:
        obj.parent = parent
        obj.location = Vector(origin) - parent_world_origin(parent)
    else:
        obj.location = origin
    return obj


def parent_world_origin(obj):
    p = Vector((0, 0, 0))
    while obj is not None:
        p += obj.location
        obj = obj.parent
    return p


def build():
    root = bpy.data.objects.new('Sandbike', None)
    bpy.context.scene.collection.objects.link(root)

    mb = MeshBuilder()
    build_body(mb, Rng(5))
    body = make_object('Body', mb, (0, 0, 0), root)

    mb = MeshBuilder()
    build_wheel(mb, REAR_AXLE, REAR_W, 14, Rng(11), front=False)
    rear = make_object('RearWheel', mb, REAR_AXLE, root)

    mb = MeshBuilder()
    build_handlebar(mb, Rng(17))
    bars = make_object('Handlebar', mb, PIVOT, root)

    mb = MeshBuilder()
    build_wheel(mb, FRONT_AXLE, FRONT_W, 12, Rng(23), front=True)
    front = make_object('FrontWheel', mb, FRONT_AXLE, bars)

    return root, [body, rear, bars, front]


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def export_glb(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_materials='EXPORT',
        export_normals=True,
        export_texcoords=False,
    )


# ------------------------------------------------------------------------------------------------ render

def render_preview(path):
    scene = bpy.context.scene
    for engine in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
    scene.view_settings.view_transform = 'Standard'
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    ground = bpy.context.active_object
    ground.data.materials.append(make_material('ground', 0xd9a066, 0, 0.9, 0))

    world = scene.world or bpy.data.worlds.new('world')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (0.75, 0.45, 0.25, 1)
    bg.inputs['Strength'].default_value = 0.7
    for name, energy, rot in (('key', 4.0, (55, 0, 35)), ('fill', 1.0, (70, 0, -120))):
        data = bpy.data.lights.new(name, 'SUN')
        data.energy = energy
        data.angle = math.radians(3)
        light = bpy.data.objects.new(name, data)
        light.rotation_euler = tuple(math.radians(a) for a in rot)
        scene.collection.objects.link(light)

    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    target = Vector((0, 0, 0.55))
    shots = [
        ('', Vector((2.2, 2.6, 1.3)), 40),              # front-right 3/4
        ('_side', Vector((3.6, 0, 0.6)), 40),           # right side
        ('_rear', Vector((-2.4, -2.6, 1.6)), 40),       # left-rear 3/4
    ]
    for suffix, offset, lens in shots:
        cam.data.lens = lens
        cam.location = target + offset
        cam.rotation_euler = (-offset).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = path.replace('.png', suffix + '.png')
        bpy.ops.render.render(write_still=True)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models', 'sandbike.glb'))
    ap.add_argument('--preview', default=None, help='render PNG previews (3/4, side, rear 3/4)')
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in MATERIALS.items():
        make_material(name, *spec)

    root, objs = build()
    bpy.context.view_layer.update()
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    export_glb([root] + objs, args.out)
    total = 0
    for o in objs:
        t = tri_count(o)
        total += t
        w = o.matrix_world.translation
        print(f'{o.name}: tris={t} origin(blender)=({w.x:.3f}, {w.y:.3f}, {w.z:.3f})')
    lo = [min((o.matrix_world @ v.co)[i] for o in objs for v in o.data.vertices) for i in range(3)]
    hi = [max((o.matrix_world @ v.co)[i] for o in objs for v in o.data.vertices) for i in range(3)]
    print(f'total tris={total} bounds x {lo[0]:.3f}..{hi[0]:.3f} y {lo[1]:.3f}..{hi[1]:.3f} z {lo[2]:.3f}..{hi[2]:.3f}')
    print(f'steer axis (blender) = {tuple(round(c, 4) for c in STEER_AXIS)}')

    if args.preview:
        render_preview(os.path.abspath(args.preview))


main()
