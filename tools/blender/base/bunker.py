"""Home base: a minimal underground bunker, exported as one glTF binary.

    blender -b --python tools/blender/base/bunker.py                        # writes public/models/base/bunker.glb
    blender -b --python tools/blender/base/bunker.py -- --preview out.png   # also renders preview shots

Top-level nodes (origin = the entrance hut's floor on the doorway's centre line, door facing game +Z):
    hut     outside of the small entrance hut on the surface, the skylight's collar + glass (lit by the sky)
    bunker  everything indoors: the hut's inside, stairs, tunnel, hallway, main room, skylight shaft
    pump    hand water pump, origin at its base centre (placed in the room's middle by shared/base.ts)

Every dimension mirrors shared/base.ts (the physics): change both together.
Blender is Z-up; the exporter converts to Y-up. Game +Z ("front") = Blender -Y. Units are metres.
Geometry is written here in game coordinates (x, y up, z) and converted by G().
"""

import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True  # no __pycache__ next to the scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from coplanar import separate_coplanar  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))

# --- layout (shared/base.ts) ---------------------------------------------------------------------
WT = 0.3
W = 1.1
HUT_Z0, HUT_Z1, HUT_H, DOOR, DOOR_H = -3.0, 2.0, 2.7, 0.7, 2.2
ST_Z, ST_N, ST_RISE, ST_RUN = 0.6, 22, 0.25, 0.3
FLOOR = -ST_N * ST_RISE
HALL_Z, HALL_H = -12.0, 2.6
ROOM_W, ROOM_Z0, ROOM_H = 8.0, -28.0, 4.0
ROOM_Z = (HALL_Z + ROOM_Z0) / 2
SKY_W, SKY_COLLAR, SKY_H = 1.4, 1.8, 0.5
HUT_R, SKY_R = 0.5, 0.6  # outer corner radii of the hut and the skylight collar (shared/base.ts HUT_R, SKY_R)
TUNNEL_HEADROOM, TUNNEL_TOP = 2.5, -0.6
BURIED_TOP = -0.3
CEIL = FLOOR + ROOM_H
BULB = (0, 2.25, HUT_Z0 + 0.25)  # the hut's bulb (src/world/base.ts puts a light there)

# name: (sRGB hex, roughness, metallic, double_sided)
MATERIALS = {
    'Plaster': (0xc9a77c, 0.95, 0.0, False),
    'Concrete': (0x9a8f80, 0.92, 0.0, False),
    'ConcreteDark': (0x6f675d, 0.95, 0.0, False),
    'Steel': (0x5c5a56, 0.5, 0.6, False),
    'Iron': (0x3a3430, 0.7, 0.3, False),
    'Rust': (0x7a3d1e, 0.95, 0.0, False),
    'PumpPaint': (0x3f5a48, 0.6, 0.1, False),
    'Water': (0x3f7f8c, 0.1, 0.0, False),
}
EMIT = {'EmitWarm': 0xffb060}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgb(h):
    return [srgb_to_linear(((h >> s) & 0xFF) / 255) for s in (16, 8, 0)]


def make_materials():
    for name, (hx, rough, metal, ds) in MATERIALS.items():
        m = bpy.data.materials.new(name)
        rgb = hex_rgb(hx)
        m.diffuse_color = (*rgb, 1)
        m.use_nodes = True
        b = m.node_tree.nodes.get('Principled BSDF')
        b.inputs['Base Color'].default_value = (*rgb, 1)
        b.inputs['Roughness'].default_value = rough
        b.inputs['Metallic'].default_value = metal
        m.use_backface_culling = not ds
    for name, hx in EMIT.items():
        m = bpy.data.materials.new(name)
        rgb = hex_rgb(hx)
        m.diffuse_color = (*rgb, 1)
        m.use_nodes = True
        b = m.node_tree.nodes.get('Principled BSDF')
        b.inputs['Base Color'].default_value = (*rgb, 1)
        b.inputs['Emission Color'].default_value = (*rgb, 1)
        b.inputs['Emission Strength'].default_value = 4.0
        m.use_backface_culling = True
    m = bpy.data.materials.new('Glass')
    rgb = hex_rgb(0xcfe6e0)
    m.diffuse_color = (*rgb, 0.3)
    m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = 0.05
    b.inputs['Alpha'].default_value = 0.3
    m.use_backface_culling = False
    try:
        m.surface_render_method = 'BLENDED'
    except AttributeError:
        m.blend_method = 'BLEND'


def G(x, y, z):
    """Game coordinates → Blender."""
    return Vector((x, -z, y))


class MB:
    """bmesh builder with named material slots, taking game coordinates."""

    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []

    def mi(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def tag(self, verts, mat):
        idx = self.mi(mat)
        for f in {f for v in verts for f in v.link_faces}:
            f.material_index = idx
            f.smooth = False

    def box(self, x0, x1, y0, y1, z0, z1, mat):
        """Axis-aligned box between game-space corners."""
        c = G((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
        m = Matrix.Translation(c) @ Matrix.Diagonal((abs(x1 - x0), abs(z1 - z0), abs(y1 - y0), 1))
        res = bmesh.ops.create_cube(self.bm, size=1.0, matrix=m)
        self.tag(res['verts'], mat)

    def cyl(self, p0, p1, r0, mat, r1=None, seg=10, caps=True):
        p0, p1 = G(*p0), G(*p1)
        d = p1 - p0
        rot = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
        m = Matrix.Translation((p0 + p1) / 2) @ rot
        res = bmesh.ops.create_cone(self.bm, cap_ends=caps, cap_tris=False, segments=seg,
                                    radius1=r0, radius2=r0 if r1 is None else r1, depth=d.length, matrix=m)
        self.tag(res['verts'], mat)

    def beam(self, p0, p1, w, mat):
        """Square bar of width w between two game points."""
        self.cyl(p0, p1, w * 0.7071, mat, seg=4, caps=True)

    def profile_x(self, pts, x0, x1, mat):
        """Prism: polygon [(z, y), ...] in the game ZY plane, extruded from x0 to x1."""
        a = [self.bm.verts.new(G(x0, y, z)) for z, y in pts]
        b = [self.bm.verts.new(G(x1, y, z)) for z, y in pts]
        idx = self.mi(mat)
        fs = [self.bm.faces.new(a), self.bm.faces.new(list(reversed(b)))]
        n = len(pts)
        for i in range(n):
            j = (i + 1) % n
            fs.append(self.bm.faces.new([a[i], a[j], b[j], b[i]]))
        for f in fs:
            f.material_index = idx
            f.smooth = False

    def profile_y(self, pts, y0, y1, mat):
        """Prism: polygon [(x, z), ...] in the game XZ plane, extruded from height y0 to y1."""
        self.loft([(pts, y0), (pts, y1)], mat)

    def loft(self, loops, mat):
        """Solid through loops [([(x, z), ...], y), ...] of equal length, bottom to top, capped."""
        rings = [[self.bm.verts.new(G(x, y, z)) for x, z in pts] for pts, y in loops]
        idx = self.mi(mat)
        fs = [self.bm.faces.new(rings[0]), self.bm.faces.new(list(reversed(rings[-1])))]
        n = len(rings[0])
        for a, b in zip(rings, rings[1:]):
            for i in range(n):
                j = (i + 1) % n
                fs.append(self.bm.faces.new([a[i], a[j], b[j], b[i]]))
        for f in fs:
            f.material_index = idx
            f.smooth = False

    def corner(self, ix, iz, ox, oz, r, y0, y1, sx, sz, zc, mat, seg=6):
        """Rounded outer corner of a wall ring: fills the quadrant (sx, sz) between the inner corner
        (ix, iz) and the outer corner (ox, oz), rounded with radius r (>= the wall thickness), around zc."""
        cx, cz = ox - r, oz - r
        pts = [(cx, iz), (ix, iz), (ix, cz), (ox, cz)]
        pts += [(cx + r * math.cos(a), cz + r * math.sin(a)) for a in (math.pi / 2 * k / seg for k in range(1, seg))]
        pts.append((cx, oz))
        self.profile_y([(sx * x, zc + sz * z) for x, z in pts], y0, y1, mat)

    def build(self, name):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        separate_coplanar(self.bm)
        mesh = bpy.data.meshes.new(name)
        self.bm.normal_update()
        self.bm.to_mesh(mesh)
        self.bm.free()
        for m in self.mats:
            mesh.materials.append(bpy.data.materials[m])
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        return obj


def stair_y(z):
    """Physics ramp (shared/base.ts stairY)."""
    y = -(ST_Z - z) * (ST_RISE / ST_RUN) - ST_RISE / 2
    return 0.0 if z >= ST_Z else max(FLOOR, min(0.0, y))


def rounded_rect(hx, hz, r, zc, seg=6):
    """Outline [(x, z), ...] of a rectangle (half extents hx, hz, centred on x 0, z zc), corners rounded."""
    pts = []
    for cx, cz, a0 in ((hx - r, hz - r, 0), (r - hx, hz - r, 1), (r - hx, r - hz, 2), (hx - r, r - hz, 3)):
        for k in range(seg + 1):
            a = math.pi / 2 * (a0 + k / seg)
            pts.append((cx + r * math.cos(a), zc + cz + r * math.sin(a)))
    return pts


# =================================================================================================
def build_hut():
    mb = MB()
    xo = W + WT  # outer half width
    front, back = HUT_Z1, HUT_Z0
    top = HUT_H + 0.3
    base = -0.3  # walls go a little under the sand
    # Side walls.
    # Rounded outer corners, like a poured bunker; the straight walls run between them.
    zc, hz = (front + back) / 2, (front - back) / 2
    cx, cz = xo - HUT_R, hz + WT - HUT_R
    for s in (-1, 1):
        mb.box(s * W, s * xo, base, top, zc - cz, zc + cz, 'Plaster')
        for t in (-1, 1):
            mb.corner(W, hz, xo, hz + WT, HUT_R, TUNNEL_TOP, top, s, t, zc, 'Plaster')
    # Front wall with the doorway, and a steel frame round it.
    mb.box(-cx, -DOOR, base, top, front, front + WT, 'Plaster')
    mb.box(DOOR, cx, base, top, front, front + WT, 'Plaster')
    mb.box(-DOOR, DOOR, DOOR_H, top, front, front + WT, 'Plaster')
    f = 0.06
    for s in (-1, 1):
        mb.box(s * DOOR - f / 2, s * DOOR + f / 2, 0, DOOR_H + f, front - 0.02, front + WT + 0.02, 'Steel')
    mb.box(-DOOR - f / 2, DOOR + f / 2, DOOR_H, DOOR_H + f, front - 0.02, front + WT + 0.02, 'Steel')
    # Back wall: stops over the tunnel's ceiling.
    mb.box(-cx, cx, TUNNEL_TOP, top, back - WT, back, 'Plaster')
    # Roof: slab with a small overhang, its top edge rounded over, a vent pipe.
    o, th, f = 0.12, 0.25, 0.12
    rt = top + th
    prof = [(o, top), (o, rt - f)] + [(o - f + f * math.cos(a), rt - f + f * math.sin(a))
                                      for a in (math.pi / 2 * k / 4 for k in range(1, 5))]
    mb.loft([(rounded_rect(xo + d, hz + WT + d, HUT_R + d, zc), y) for d, y in prof], 'Plaster')
    mb.cyl((0.6, rt, back + 0.4), (0.6, rt + 0.57, back + 0.4), 0.09, 'Rust', seg=8)
    mb.cyl((0.6, rt + 0.57, back + 0.4), (0.6, rt + 0.64, back + 0.4), 0.14, 'Rust', seg=8)
    # Landing floor and a steel threshold.
    mb.box(-W, W, -0.25, 0, ST_Z, front, 'Concrete')
    mb.box(-DOOR, DOOR, -0.25, 0.01, front, front + WT, 'Steel')
    mb.box(-W, W, -0.06, 0.005, ST_Z, ST_Z + 0.05, 'Steel')  # nosing of the top step
    # Skylight collar on the room's centre, glass and a steel grid over it.
    c, w = SKY_COLLAR, SKY_W
    z = ROOM_Z
    k = c - SKY_R
    for s in (-1, 1):
        mb.box(-k, k, BURIED_TOP, SKY_H, z + s * w, z + s * c, 'Concrete')
        mb.box(s * w, s * c, BURIED_TOP, SKY_H, z - k, z + k, 'Concrete')
        for t in (-1, 1):
            mb.corner(w, w, c, c, SKY_R, BURIED_TOP, SKY_H, s, t, z, 'Concrete')
    mb.box(-w, w, SKY_H - 0.07, SKY_H - 0.05, z - w, z + w, 'Glass')
    for k in (-2, -1, 0, 1, 2):
        t = k * w / 3
        mb.box(t - 0.03, t + 0.03, SKY_H - 0.05, SKY_H + 0.02, z - w, z + w, 'Steel')
        mb.box(-w, w, SKY_H - 0.05, SKY_H + 0.02, z + t - 0.03, z + t + 0.03, 'Steel')
    return mb.build('hut')


def build_bunker():
    mb = MB()
    xo = W + WT
    under = FLOOR - 0.3
    # The hut's inside: concrete skin a hair inside its plaster walls, ceiling, a bulb over the stairs.
    li = 0.02
    for s in (-1, 1):
        mb.box(s * (W - li), s * W, BURIED_TOP, HUT_H, HUT_Z0, HUT_Z1, 'Concrete')
        mb.box(s * DOOR, s * (W - li), BURIED_TOP, HUT_H, HUT_Z1 - li, HUT_Z1, 'Concrete')
    mb.box(-DOOR, DOOR, DOOR_H, HUT_H, HUT_Z1 - li, HUT_Z1, 'Concrete')
    mb.box(-W + li, W - li, TUNNEL_TOP, HUT_H, HUT_Z0, HUT_Z0 + li, 'Concrete')
    mb.box(-W, W, HUT_H, HUT_H + 0.3, HUT_Z0, HUT_Z1, 'Concrete')
    mb.cyl((0, BULB[1], HUT_Z0), (0, BULB[1], HUT_Z0 + 0.1), 0.06, 'Iron', seg=8)
    mb.cyl((0, BULB[1], HUT_Z0 + 0.1), (0, BULB[1], HUT_Z0 + 0.22), 0.05, 'EmitWarm', seg=8)
    hz = HALL_Z + WT  # the room's front wall is HALL_Z - 0 .. +WT
    # Stairwell and hallway walls: from under the floor to just under the sand.
    for s in (-1, 1):
        mb.box(s * W, s * xo, under, BURIED_TOP, hz, HUT_Z1 + WT, 'Concrete')
    # Steps: solid blocks, the last one level with the floor.
    for k in range(1, ST_N + 1):
        z1 = ST_Z - ST_RUN * (k - 1)
        z0 = z1 - ST_RUN
        mat = 'Concrete' if k < ST_N else 'ConcreteDark'
        mb.box(-W, W, -ST_RISE * k - 0.6, -ST_RISE * k, z0, z1, mat)
        if k < ST_N:
            mb.box(-W, W, -ST_RISE * k - 0.04, -ST_RISE * k + 0.004, z1 - 0.05, z1, 'Steel')
    # Handrail along the right wall, on two posts.
    rail = lambda z: stair_y(z) + 0.95  # noqa: E731
    za, zb = ST_Z - 0.2, ST_Z - ST_RUN * ST_N + 0.3
    mb.cyl((W - 0.1, rail(za), za), (W - 0.1, rail(zb), zb), 0.03, 'Steel', seg=8)
    for zz in (za, zb):
        mb.box(W - 0.13, W, rail(zz) - 0.03, rail(zz) + 0.03, zz - 0.03, zz + 0.03, 'Steel')
    # Tunnel ceiling: from the hut's back wall down along the stairs, then flat over the hallway.
    lo, t = FLOOR + HALL_H, 0.3
    ceil_y = lambda z: max(lo, min(TUNNEL_TOP, stair_y(z) + TUNNEL_HEADROOM))  # noqa: E731
    ze = ST_Z - (TUNNEL_HEADROOM - ST_RISE / 2 - lo) * ST_RUN / ST_RISE
    pts = [(HUT_Z0, ceil_y(HUT_Z0)), (ze, lo), (hz, lo), (hz, lo + t), (ze, lo + t), (HUT_Z0, ceil_y(HUT_Z0) + t)]
    mb.profile_x(pts, -xo, xo, 'Concrete')
    # Hallway and room floors.
    mb.box(-W, W, under, FLOOR, hz, ST_Z - ST_RUN * ST_N, 'ConcreteDark')
    rx, rz = ROOM_W + WT, ROOM_Z0 - WT
    mb.box(-rx, rx, under, FLOOR, rz, hz, 'ConcreteDark')
    # Room walls; the front one opens onto the hallway.
    ct = CEIL + 0.3
    mb.box(-rx, rx, under, ct, rz, ROOM_Z0, 'Concrete')
    for s in (-1, 1):
        mb.box(s * ROOM_W, s * rx, under, ct, ROOM_Z0, hz, 'Concrete')
        mb.box(s * W, s * ROOM_W, under, ct, HALL_Z, hz, 'Concrete')
    mb.box(-W, W, lo, ct, HALL_Z, hz, 'Concrete')
    # Ceiling round the skylight, and the shaft up to the collar.
    w, z = SKY_W, ROOM_Z
    mb.box(-ROOM_W, ROOM_W, CEIL, ct, ROOM_Z0, z - w, 'Concrete')
    mb.box(-ROOM_W, ROOM_W, CEIL, ct, z + w, HALL_Z, 'Concrete')
    mb.box(-ROOM_W, -w, CEIL, ct, z - w, z + w, 'Concrete')
    mb.box(w, ROOM_W, CEIL, ct, z - w, z + w, 'Concrete')
    sw = w + WT
    mb.box(-sw, sw, ct, BURIED_TOP, z - sw, z - w, 'Concrete')
    mb.box(-sw, sw, ct, BURIED_TOP, z + w, z + sw, 'Concrete')
    mb.box(-sw, -w, ct, BURIED_TOP, z - w, z + w, 'Concrete')
    mb.box(w, sw, ct, BURIED_TOP, z - w, z + w, 'Concrete')
    # A drain grate in front of the pump, and a channel from it to the wall.
    mb.box(-0.25, 0.25, FLOOR, FLOOR + 0.006, z + 0.75, z + 1.05, 'Iron')
    for k in range(5):
        x = -0.2 + k * 0.1
        mb.box(x - 0.012, x + 0.012, FLOOR + 0.006, FLOOR + 0.012, z + 0.77, z + 1.03, 'Steel')
    return mb.build('bunker')


def build_pump():
    mb = MB()
    # Plinth with a worn top.
    mb.box(-0.45, 0.45, 0, 0.14, -0.45, 0.45, 'Concrete')
    mb.box(-0.4, 0.4, 0.14, 0.16, -0.4, 0.4, 'ConcreteDark')
    # Standpipe, flange, body, cap.
    mb.cyl((0, 0.16, -0.05), (0, 0.5, -0.05), 0.055, 'Iron', seg=10)
    mb.cyl((0, 0.48, -0.05), (0, 0.54, -0.05), 0.12, 'PumpPaint', seg=12)
    mb.cyl((0, 0.54, -0.05), (0, 1.02, -0.05), 0.1, 'PumpPaint', r1=0.09, seg=12)
    mb.cyl((0, 0.98, -0.05), (0, 1.06, -0.05), 0.12, 'PumpPaint', seg=12)
    mb.cyl((0, 1.06, -0.05), (0, 1.1, -0.05), 0.08, 'Iron', seg=12)
    # Spout, forward and down.
    mb.cyl((0, 0.8, 0.02), (0, 0.76, 0.27), 0.045, 'PumpPaint', r1=0.035, seg=8)
    mb.cyl((0, 0.76, 0.27), (0, 0.7, 0.31), 0.035, 'PumpPaint', seg=8)
    # Handle: pivot bracket at the back, lever up and back, link to the plunger.
    mb.box(-0.05, 0.05, 1.04, 1.2, -0.2, -0.14, 'Iron')
    mb.beam((0, 1.17, 0.02), (0, 1.38, -0.62), 0.045, 'Iron')
    mb.cyl((0, 1.38, -0.62), (0, 1.43, -0.78), 0.03, 'Rust', seg=8)
    mb.beam((0, 1.1, -0.05), (0, 1.2, -0.02), 0.03, 'Steel')
    # Bucket under the spout, a little water in it.
    mb.cyl((0, 0.16, 0.3), (0, 0.42, 0.3), 0.12, 'Steel', r1=0.14, seg=12)
    mb.cyl((0, 0.42, 0.3), (0, 0.425, 0.3), 0.1, 'Water', seg=12)
    return mb.build('pump')


# =================================================================================================
def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def export(objs, path):
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


def look_at(cam, target):
    d = Vector(target) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def render_preview(objs, path):
    """Shots: the surface from the front, a cutaway from above, inside the room, down the stairs."""
    hut, bunker, pump = objs
    pump.location = G(0, FLOOR, ROOM_Z)
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new('cam')
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    sun_data = bpy.data.lights.new('sun', 'SUN')
    sun_data.energy = 5
    sun_data.color = (1.0, 0.85, 0.7)
    sun_data.angle = math.radians(1)
    sun = bpy.data.objects.new('sun', sun_data)
    sun.rotation_euler = (math.radians(20), math.radians(8), 0)
    scene.collection.objects.link(sun)
    world = bpy.data.worlds.new('world')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (0.75, 0.5, 0.32, 1)
    bg.inputs['Strength'].default_value = 0.6
    for engine in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'BLENDER_WORKBENCH'):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.view_settings.view_transform = 'AgX'
    scene.render.resolution_x = 1200
    scene.render.resolution_y = 800

    # A sand slab as the pad, with holes where the game cuts them (entrance, skylight).
    bm = bmesh.new()
    for x0, x1, z0, z1 in ((-14, -1.25, -34, 14), (1.25, 14, -34, 14), (-1.25, 1.25, 2.15, 14),
                           (-1.25, 1.25, ROOM_Z + 1.6, -3.15), (-1.25, 1.25, -34, ROOM_Z - 1.6)):
        m = Matrix.Translation(G((x0 + x1) / 2, -0.06, (z0 + z1) / 2)) @ Matrix.Diagonal((x1 - x0, z1 - z0, 0.001, 1))
        bmesh.ops.create_cube(bm, size=1.0, matrix=m)
    sand_mesh = bpy.data.meshes.new('sand')
    bm.to_mesh(sand_mesh)
    sand = bpy.data.objects.new('sand', sand_mesh)
    gm = bpy.data.materials.new('sandm')
    gm.use_nodes = True
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.62, 0.30, 0.10, 1)
    sand.data.materials.append(gm)
    scene.collection.objects.link(sand)

    def shot(name, loc, target, lens=24):
        cam.location = loc
        cam_data.lens = lens
        look_at(cam, target)
        scene.render.filepath = path.replace('.png', f'_{name}.png')
        bpy.ops.render.render(write_still=True)

    shot('front', G(4, 3.5, 10), G(0, 0.8, -6), lens=24)
    sand.hide_render = True
    shot('cutaway', G(14, 16, 6), G(0, FLOOR, -10), lens=28)
    sand.hide_render = False
    bg.inputs['Strength'].default_value = 0.0
    shot('room', G(3.8, FLOOR + 1.65, HALL_Z - 1.0), G(0, FLOOR + 0.8, ROOM_Z), lens=20)
    shot('stairs', G(0, 1.65, 1.8), G(0, FLOOR + 1.0, -9), lens=22)
    shot('pump', G(1.2, FLOOR + 1.3, ROOM_Z + 1.4), G(0, FLOOR + 0.7, ROOM_Z), lens=35)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models', 'base', 'bunker.glb'))
    ap.add_argument('--preview', default=None)
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    make_materials()
    objs = [build_hut(), build_bunker(), build_pump()]
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    export(objs, args.out)
    for o in objs:
        print(f'NODE {o.name}: tris={tri_count(o)}')
    print(f'WROTE {args.out} {os.path.getsize(args.out) / 1024:.1f} KiB')
    if args.preview:
        render_preview(objs, os.path.abspath(args.preview))


main()
