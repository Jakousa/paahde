"""Home base: a minimal underground bunker, exported as one glTF binary.

    blender -b --python tools/blender/base/bunker.py                        # writes public/models/base/bunker.glb
    blender -b --python tools/blender/base/bunker.py -- --preview out.png   # also renders preview shots

Top-level nodes (origin = the entrance hut's floor on the doorway's centre line, door facing game +Z):
    hut     outside of the small entrance hut on the surface, the skylight's collar + glass (lit by the sky)
    bunker  everything indoors: the hut's inside, stairs, tunnel, hallway, main room (sandstone pilasters and ribs,
            arched alcoves for the workbench, the pump and the chest), skylight shaft
    pump    hand water pump, origin at its base centre (placed in the room's east alcove by shared/base.ts)
    workbench    crafting bench with a pegboard behind it, origin at its base centre, front +Z
    disassembly  square steel disassembly table (clear top) with a vise, bolt tray, grinder, tool rail and scrap bin
                 round its sides, origin at its base centre, front +Z (placed in the room's middle)
    chest        iron-banded wooden storage chest (shared/storage.ts), origin at its base centre, front +Z

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
W = 1.35
HUT_Z0, HUT_Z1, HUT_H, DOOR = -4.0, 2.0, 2.3, 0.85
DOOR_S, DOOR_H = 1.75, 2.15  # the doorway's low arch: springing line, crown (shared/base.ts HUT.doorS, HUT.doorH)
HUT_T, HUT_TOP = 0.6, 2.75  # the entrance's wall thickness and outer height (shared/base.ts HUT.t, HUT.top)
HUT_FILLET = 0.4  # its rounded-over top edge
ST_Z, ST_N, ST_RISE, ST_RUN = 0.6, 48, 0.25, 0.3
FLOOR = -ST_N * ST_RISE
HALL_Z, HALL_H = -17.8, 3.3  # HALL_H: the hallway vault's crown above the floor
ROOM_W, ROOM_Z0, ROOM_H = 8.0, -36.8, 6.0
ROOM_Z = (HALL_Z + ROOM_Z0) / 2
# Arched alcoves in the walls (shared/base.ts ALCOVE, ALCOVES): half width, depth, springing line above the floor;
# where (x, z on the wall's inner face, outward normal): the workbench's (west), the pump's (east), the chest's (back).
ALC_HW, ALC_D, ALC_SPRING = 1.3, 1.2, 2.3
ALCOVES = ((-ROOM_W, ROOM_Z, -1, 0), (ROOM_W, ROOM_Z, 1, 0), (0.0, ROOM_Z0, 0, -1))
PUMP_X = ROOM_W + ALC_D - 1.0  # the pump stands in the east alcove, facing -X (shared/base.ts BASE_PIECES)
# Sandstone pilasters (shared/base.ts PILLAR): width, how far they stand out; offsets along the side walls from the
# room's centre, and along the front and back walls from the middle. Arch frames: width and how far they stand out.
PIL_W, PIL_D = 0.6, 0.3
PIL_SIDES, PIL_ENDS = (2.0, 4.7, 7.4), (2.0, 4.7)
JAMB_W, JAMB_D = 0.32, 0.12
SKY_W, SKY_COLLAR, SKY_H = 1.4, 1.8, 0.5
SKY_BEAM = 0.22  # depth of the steel beam across the skylight's opening (the table's lamp hangs from it; src/world/base.ts)
TABLE_HW, TABLE_TOP = 1.0, 0.8  # the disassembly table's half size and top (shared/base.ts BASE_PIECES)
HUT_R, SKY_R = 0.8, 0.6  # outer corner radii of the hut and the skylight collar (shared/base.ts HUT_R, SKY_R)
ROOM_R = 1.5  # the room's inside corners (shared/base.ts ROOM_R)
VAULT_HEADROOM, VAULT_K = 3.3, 1.5  # crown over the stair line, softening of its bends (shared/base.ts VAULT)
COVE, SKIRT = 0.9, 0.12  # the room's rounded wall-ceiling and wall-floor junctions
ALC_TOP = FLOOR + ALC_SPRING + ALC_HW + WT + 0.25  # the room's lining is cut for the alcoves up to here
SMOOTH_ANGLE = math.radians(40)  # edges sharper than this stay hard; gentler ones are shaded smooth
BURIED_TOP = -0.3
CEIL = FLOOR + ROOM_H
BULB = (0, 1.95, HUT_Z0 + 0.25)  # the hut's bulb (src/world/base.ts puts a light there)

# name: (sRGB hex, roughness, metallic, double_sided)
MATERIALS = {
    'Bunker': (0xb09f86, 0.97, 0.0, False),
    'BunkerDark': (0x8c7c66, 0.97, 0.0, False),
    'Concrete': (0x9a8f80, 0.92, 0.0, False),
    'ConcreteDark': (0x6f675d, 0.95, 0.0, False),
    'Steel': (0x5c5a56, 0.5, 0.6, False),
    'Iron': (0x3a3430, 0.7, 0.3, False),
    'Rust': (0x7a3d1e, 0.95, 0.0, False),
    'PumpPaint': (0x3f5a48, 0.6, 0.1, False),
    'Water': (0x3f7f8c, 0.1, 0.0, False),
    'Wood': (0x8a5a34, 0.85, 0.0, False),
    'WoodDark': (0x5a3a22, 0.9, 0.0, False),
    'Peg': (0xa08868, 0.9, 0.0, False),
    'Hazard': (0xd8a028, 0.7, 0.1, False),
    'Sandstone': (0xc49a68, 0.95, 0.0, False),
    'SandstoneLight': (0xd2ab7c, 0.95, 0.0, False),
    'SandstoneDark': (0x8a6644, 0.97, 0.0, False),
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
        self.fixed = set()  # open surfaces wound by hand: recalc_face_normals would guess their side

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

    def loft(self, loops, mat, bottom=True, top=True, skip=()):
        """Solid through loops [([(x, z), ...], y), ...] of equal length, bottom to top, capped on top (and
        bottom). `skip` leaves holes: (k, i) is the face between loops k and k+1 from point i to i+1."""
        rings = [[self.bm.verts.new(G(x, y, z)) for x, z in pts] for pts, y in loops]
        idx = self.mi(mat)
        fs = [self.bm.faces.new(list(reversed(rings[-1])))] if top else []
        if bottom:
            fs.append(self.bm.faces.new(rings[0]))
        n = len(rings[0])
        for k, (a, b) in enumerate(zip(rings, rings[1:])):
            for i in range(n):
                if (k, i) in skip:
                    continue
                j = (i + 1) % n
                fs.append(self.bm.faces.new([a[i], a[j], b[j], b[i]]))
        for f in fs:
            f.material_index = idx
            f.smooth = False
        return fs

    def sweep(self, rings, mat):
        """Open tube through closed rings [[(x, y, z), ...], ...] of equal length; faces [a_i, a_j, b_j, b_i]
        (their side is kept as wound)."""
        rings = [[self.bm.verts.new(G(*p)) for p in r] for r in rings]
        idx = self.mi(mat)
        n = len(rings[0])
        for a, b in zip(rings, rings[1:]):
            for i in range(n):
                j = (i + 1) % n
                f = self.bm.faces.new([a[i], a[j], b[j], b[i]])
                f.material_index = idx
                self.fixed.add(f)

    def prism(self, pts, d, mat):
        """Solid: the polygon through game points [(x, y, z), ...] swept along the game vector d."""
        a = [self.bm.verts.new(G(*p)) for p in pts]
        b = [self.bm.verts.new(G(p[0] + d[0], p[1] + d[1], p[2] + d[2])) for p in pts]
        idx = self.mi(mat)
        fs = [self.bm.faces.new(a), self.bm.faces.new(list(reversed(b)))]
        n = len(pts)
        for i in range(n):
            j = (i + 1) % n
            fs.append(self.bm.faces.new([a[i], a[j], b[j], b[i]]))
        for f in fs:
            f.material_index = idx
            f.smooth = False

    def poly(self, pts, mat, normal):
        """One flat face through game points [(x, y, z), ...], turned to face game direction `normal`."""
        f = self.bm.faces.new([self.bm.verts.new(G(*p)) for p in pts])
        f.normal_update()
        if f.normal.dot(G(*normal)) < 0:
            f.normal_flip()
        f.material_index = self.mi(mat)
        self.fixed.add(f)

    def corner(self, ix, iz, ox, oz, r, y0, y1, sx, sz, zc, mat, seg=6):
        """Rounded outer corner of a wall ring: fills the quadrant (sx, sz) between the inner corner
        (ix, iz) and the outer corner (ox, oz), rounded with radius r (>= the wall thickness), around zc."""
        cx, cz = ox - r, oz - r
        pts = [(cx, iz), (ix, iz), (ix, cz), (ox, cz)]
        pts += [(cx + r * math.cos(a), cz + r * math.sin(a)) for a in (math.pi / 2 * k / seg for k in range(1, seg))]
        pts.append((cx, oz))
        self.profile_y([(sx * x, zc + sz * z) for x, z in pts], y0, y1, mat)

    def build(self, name):
        bmesh.ops.recalc_face_normals(self.bm, faces=[f for f in self.bm.faces if f not in self.fixed])
        separate_coplanar(self.bm)
        # Shade smooth across gentle bends (round corners, vaults, coves, cylinders); box edges stay hard.
        for f in self.bm.faces:
            f.smooth = True
        for e in self.bm.edges:
            e.smooth = len(e.link_faces) == 2 and e.calc_face_angle(math.pi) < SMOOTH_ANGLE
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


def smax(a, b, k):
    h = max(k - abs(a - b), 0) / k
    return max(a, b) + h * h * k / 4


def crown(z):
    """The vault's crown over the stairs and the hallway (shared/base.ts vaultCrown)."""
    line = -(ST_Z - z) * (ST_RISE / ST_RUN) - ST_RISE / 2 + VAULT_HEADROOM
    return smax(line, FLOOR + HALL_H, VAULT_K)


def arch(r, spring, seg=12, a0=0.0, a1=math.pi):
    """Half circle [(x, y), ...] of radius r over the springing line, from angle a0 to a1."""
    return [(r * math.cos(a0 + (a1 - a0) * k / seg), spring + r * math.sin(a0 + (a1 - a0) * k / seg)) for k in range(seg + 1)]


def arch_wall(mb, z, top, normal, mat='Concrete'):
    """A wall across the tunnel at z, from the vault's springing line up to `top`, with the arch cut out."""
    spring = crown(z) - W
    pts = [(x, y, z) for x, y in arch(W, spring)] + [(-W, top, z), (W, top, z)]
    mb.poly(pts, mat, normal)


def rounded_rect(hx, hz, r, zc, seg=6):
    """Outline [(x, z), ...] of a rectangle (half extents hx, hz, centred on x 0, z zc), corners rounded."""
    pts = []
    for cx, cz, a0 in ((hx - r, hz - r, 0), (r - hx, hz - r, 1), (r - hx, r - hz, 2), (hx - r, r - hz, 3)):
        for k in range(seg + 1):
            a = math.pi / 2 * (a0 + k / seg)
            pts.append((cx + r * math.cos(a), zc + cz + r * math.sin(a)))
    return pts


class Wall:
    """A frame on a wall's inner face at (x, z), outward normal (nx, nz) along X or Z: u runs along the wall, v out
    through it (negative: into the room), y is the game's."""

    def __init__(self, x, z, nx, nz):
        self.x, self.z, self.nx, self.nz = x, z, nx, nz

    def p(self, u, y, v):
        return (self.x + self.nx * v - self.nz * u, y, self.z + self.nz * v + self.nx * u)

    def box(self, mb, u0, u1, y0, y1, v0, v1, mat):
        a, b = self.p(u0, y0, v0), self.p(u1, y1, v1)
        mb.box(a[0], b[0], y0, y1, a[2], b[2], mat)

    def band(self, mb, r0, r1, spring, v0, v1, mat, seg=12):
        """Arch band between radii r0 and r1 over the springing line, from v0 to v1."""
        pts = [self.p(u, y, v0) for u, y in arch(r0, spring, seg) + arch(r1, spring, seg, a0=math.pi, a1=0.0)]
        mb.prism(pts, (self.nx * (v1 - v0), 0, self.nz * (v1 - v0)), mat)


def with_alcoves(pts, seg, hx, hz, zc, u):
    """rounded_rect(hx, hz, ..., zc, seg) with two more points on its west, back and east edges, ±u either side of
    each alcove's centre (ALCOVES); returns them and the indices of the edges between (the openings)."""
    ins = {2 * seg + 1: [(-hx, zc + u), (-hx, zc - u)], 3 * seg + 2: [(-u, zc - hz), (u, zc - hz)],
           4 * seg + 3: [(hx, zc - u), (hx, zc + u)]}
    out, gaps = [], []
    for i, p in enumerate(pts):
        out.append(p)
        if i in ins:
            gaps.append(len(out))
            out += ins[i]
    return out, gaps


def arch_frame(mb, wall, r, spring):
    """Sandstone frame round an arched opening (radius r, springing at `spring`) on the wall's face: jambs, imposts,
    the arch and its keystone."""
    o = r + JAMB_W
    for s in (-1, 1):
        wall.box(mb, s * r, s * o, FLOOR, spring - 0.14, -JAMB_D, 0, 'Sandstone')
        wall.box(mb, s * r, s * (o + 0.05), spring - 0.14, spring, -JAMB_D - 0.04, 0, 'SandstoneLight')
    wall.band(mb, r, o, spring, -JAMB_D, 0, 'Sandstone')
    wall.box(mb, -0.16, 0.16, spring + r - 0.06, spring + o + 0.1, -JAMB_D - 0.04, 0, 'SandstoneLight')


def build_alcove(mb, wall):
    """A recess through the room's wall: floor, walls and a barrel vault of concrete, the wall over its arch (the
    room's lining is cut away under ALC_TOP) and a sandstone frame round the opening."""
    hw, r1, sp = ALC_HW, ALC_HW + WT, FLOOR + ALC_SPRING
    under = FLOOR - 0.3
    wall.box(mb, -r1, r1, under, FLOOR, WT, ALC_D + WT, 'ConcreteDark')
    for s in (-1, 1):
        wall.box(mb, s * hw, s * r1, under, sp, 0, ALC_D, 'Concrete')
    wall.box(mb, -r1, r1, under, sp + r1, ALC_D, ALC_D + WT, 'Concrete')
    wall.band(mb, hw, r1, sp, 0, ALC_D, 'Concrete')
    a = math.acos(hw / r1)
    pts = [wall.p(u, y, 0) for u, y in arch(r1, sp, 8, a, math.pi - a)] + [wall.p(-hw, ALC_TOP, 0), wall.p(hw, ALC_TOP, 0)]
    mb.poly(pts, 'Concrete', (-wall.nx, 0, -wall.nz))
    arch_frame(mb, wall, hw, sp)


def build_pillar(mb, wall):
    """A sandstone pilaster from the floor to the cove: plinth, a shaft of courses with sunk joints, stepped capital."""
    e, top, h = 0.005, CEIL - COVE, PIL_W / 2
    wall.box(mb, -h - 0.08, h + 0.08, FLOOR, FLOOR + 0.3, -PIL_D - 0.1, e, 'Sandstone')
    wall.box(mb, -h - 0.04, h + 0.04, FLOOR + 0.3, FLOOR + 0.38, -PIL_D - 0.05, e, 'SandstoneLight')
    y0, y1, n = FLOOR + 0.38, top - 0.3, 7
    wall.box(mb, -h + 0.01, h - 0.01, y0, y1, -PIL_D + 0.01, e, 'SandstoneDark')
    c = (y1 - y0) / n
    for k in range(n):
        wall.box(mb, -h, h, y0 + k * c + 0.006, y0 + (k + 1) * c - 0.006, -PIL_D, e, 'SandstoneLight' if k % 2 else 'Sandstone')
    wall.box(mb, -h - 0.06, h + 0.06, top - 0.3, top - 0.12, -PIL_D - 0.06, e, 'SandstoneLight')
    wall.box(mb, -h - 0.12, h + 0.12, top - 0.12, top, -PIL_D - 0.12, e, 'Sandstone')


def build_rib(mb, z):
    """A sandstone rib across the room at z, from capital to capital: up the cove, along the ceiling, down."""
    t, e, hw, cy, cx = PIL_D, 0.005, 0.25, CEIL - COVE, ROOM_W - COVE
    q = [math.pi / 2 * k / 6 for k in range(7)]
    r0, r1 = COVE - t, COVE + e
    pts = [(cx + r0 * math.cos(a), cy + r0 * math.sin(a)) for a in q]
    pts += [(-cx - r0 * math.cos(a), cy + r0 * math.sin(a)) for a in reversed(q)]
    pts += [(-cx - r1 * math.cos(a), cy + r1 * math.sin(a)) for a in q]
    pts += [(cx + r1 * math.cos(a), cy + r1 * math.sin(a)) for a in reversed(q)]
    mb.prism([(x, y, z - hw) for x, y in pts], (0, 0, 2 * hw), 'Sandstone')


# =================================================================================================
def front_ring(hx, hz, r, zc, door):
    """rounded_rect() with two more points on its front (+Z) edge at x = ±door; returns it and the index of
    its doorway edge (from +door to -door)."""
    pts = rounded_rect(hx, hz, r, zc)
    seg = len(pts) // 4 - 1
    pts[seg + 1:seg + 1] = [(door, zc + hz), (-door, zc + hz)]
    return pts, seg + 1


def door_arch(dr=0.0, seg=10):
    """The doorway's segmental arch [(x, y), ...] from +DOOR to -DOOR (shared/base.ts doorTop), its radius grown by dr."""
    rise = DOOR_H - DOOR_S
    r = (DOOR * DOOR + rise * rise) / (2 * rise)
    cy, a0 = DOOR_H - r, math.atan2(DOOR_S - (DOOR_H - r), DOOR)
    return [((r + dr) * math.cos(a), cy + (r + dr) * math.sin(a))
            for a in (a0 + (math.pi - 2 * a0) * k / seg for k in range(seg + 1))]


def door_head(mb, z0, z1, mat):
    """The wall over the doorway from z0 to z1: its underside is the arch, its top HUT_H."""
    pts = [(x, y, z0) for x, y in door_arch()] + [(-DOOR, HUT_H, z0), (DOOR, HUT_H, z0)]
    mb.prism(pts, (0, 0, z1 - z0), mat)


def build_hut():
    """The entrance: one squat block of poured concrete, thick walls, rounded corners and top edge, the
    doorway sunk into its front wall. Hollow and open at the bottom (the stairs go down inside)."""
    mb = MB()
    front, back = HUT_Z1, HUT_Z0
    zc, hz = (front + back) / 2, (front - back) / 2 + HUT_T
    xo, fo = W + HUT_T, front + HUT_T  # outer half width, outer front
    base = -0.3  # a little under the sand
    f = HUT_FILLET
    prof = [(0, base), (0, 0), (0, DOOR_S), (0, HUT_TOP - f)]
    prof += [(-f + f * math.cos(a), HUT_TOP - f + f * math.sin(a)) for a in (math.pi / 2 * k / 5 for k in range(1, 6))]
    loops = []
    for d, y in prof:
        pts, door = front_ring(xo + d, hz + d, HUT_R + d, zc, DOOR)
        loops.append((pts, y))
    mb.loft(loops, 'Bunker', bottom=False, skip={(1, door), (2, door)})
    # The front over the doorway's arch, and a plain cast lip round the arch.
    pts = [(x, y, fo) for x, y in door_arch()] + [(-DOOR, HUT_TOP - f, fo), (DOOR, HUT_TOP - f, fo)]
    mb.poly(pts, 'Bunker', (0, 0, 1))
    lip = door_arch(0.04) + list(reversed(door_arch(0.26)))
    mb.prism([(x, y, fo - 0.01) for x, y in lip], (0, 0, 0.09), 'Bunker')
    # Formwork seams round it (broken by the doorway), and a vision slit in each side.
    for y in (0.85, 1.7):
        band = [front_ring(xo + 0.008, hz + 0.008, HUT_R + 0.008, zc, DOOR)[0]]
        mb.loft([(band[0], y), (band[0], y + 0.03)], 'BunkerDark', bottom=False, top=False, skip={(0, door)})
    for s in (-1, 1):
        mb.box(s * (xo - 0.02), s * (xo + 0.01), 1.3, 1.4, zc - 0.5, zc + 0.5, 'Iron')
    # The doorway's reveal through the wall (faces just inside the shell, so they don't z-fight it).
    e = 0.005
    for s in (-1, 1):
        mb.box(s * (DOOR + 0.2), s * DOOR, 0, HUT_H, front, fo - e, 'Bunker')  # clear of the rounded corners
    door_head(mb, front, fo - e, 'Bunker')
    # Steel frame round the outside of the doorway, following its arch, a steel threshold through it.
    g = 0.07
    for s in (-1, 1):
        mb.box(s * DOOR - g / 2, s * DOOR + g / 2, 0, DOOR_S, fo - 0.05, fo + 0.02, 'Steel')
    band = door_arch(-g / 2) + list(reversed(door_arch(g / 2)))
    mb.prism([(x, y, fo - 0.05) for x, y in band], (0, 0, 0.07), 'Steel')
    # Landing floor, the threshold, and the nosing of the top step.
    mb.box(-W, W, -0.25, 0, ST_Z, front, 'Concrete')
    mb.box(-DOOR, DOOR, -0.25, 0.01, front, fo, 'Steel')
    mb.box(-W, W, -0.06, 0.005, ST_Z, ST_Z + 0.05, 'Steel')
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
    door_head(mb, HUT_Z1 - li, HUT_Z1, 'Concrete')
    arch_wall(mb, HUT_Z0 + li, HUT_H, (0, 0, 1))
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
    # Barrel vault over the stairs and the hallway, following the stair line down and easing into the flat.
    z0, n = HUT_Z0 + li, 40
    rings = []
    for k in range(n + 1):
        z = z0 + (HALL_Z - z0) * k / n
        spring = crown(z) - W
        ring = [(x, y, z) for x, y in arch(W, spring)]
        ring += [(x, y, z) for x, y in arch(W + WT, spring, a0=math.pi, a1=0.0)]
        rings.append(ring)
    mb.sweep(rings, 'Concrete')
    # Hallway and room floors.
    mb.box(-W, W, under, FLOOR, hz, ST_Z - ST_RUN * ST_N, 'ConcreteDark')
    rx, rz = ROOM_W + WT, ROOM_Z0 - WT
    mb.box(-rx, rx, under, FLOOR, rz, hz, 'ConcreteDark')
    # Room shell: solid walls and ceiling round the skylight, their insides a hair behind the lining below.
    ct, e = CEIL + 0.3, 0.01
    w, z = SKY_W, ROOM_Z
    # The alcoves go through them (ALCOVES: one in the middle of each side and of the back wall).
    c, ac = ALC_HW + WT, FLOOR + ALC_SPRING + ALC_HW + WT
    mb.box(-rx, -c, under, ct, rz, ROOM_Z0 - e, 'Concrete')
    mb.box(c, rx, under, ct, rz, ROOM_Z0 - e, 'Concrete')
    mb.box(-c, c, ac, ct, rz, ROOM_Z0 - e, 'Concrete')
    for s in (-1, 1):
        mb.box(s * (ROOM_W + e), s * rx, under, ct, ROOM_Z0, ROOM_Z - c, 'Concrete')
        mb.box(s * (ROOM_W + e), s * rx, under, ct, ROOM_Z + c, hz, 'Concrete')
        mb.box(s * (ROOM_W + e), s * rx, ac, ct, ROOM_Z - c, ROOM_Z + c, 'Concrete')
        mb.box(s * W, s * ROOM_W, under, ct, HALL_Z, hz, 'Concrete')
    mb.box(-ROOM_W, ROOM_W, CEIL + e, ct, ROOM_Z0, z - w, 'Concrete')
    mb.box(-ROOM_W, ROOM_W, CEIL + e, ct, z + w, HALL_Z, 'Concrete')
    mb.box(-ROOM_W, -w, CEIL + e, ct, z - w, z + w, 'Concrete')
    mb.box(w, ROOM_W, CEIL + e, ct, z - w, z + w, 'Concrete')
    # Lining: rounded corners, a cove into the ceiling and a small one into the floor, the ceiling running
    # into the skylight. Its front wall is left out (the hallway arch is cut into it below), and so are the
    # alcoves' openings up to ALC_TOP.
    hd, seg = (HALL_Z - ROOM_Z0) / 2, 6
    ring = lambda d: with_alcoves(rounded_rect(ROOM_W - d, hd - d, ROOM_R - d, ROOM_Z, seg), seg,  # noqa: E731
                                  ROOM_W - d, hd - d, ROOM_Z, ALC_HW)
    gaps = ring(0)[1]
    loops = []
    for k in range(seg + 1):
        a = math.pi / 2 * k / seg
        loops.append((ring(SKIRT - SKIRT * math.sin(a))[0], FLOOR + SKIRT - SKIRT * math.cos(a)))
    loops.append((ring(0)[0], ALC_TOP))
    for k in range(seg + 1):
        a = math.pi / 2 * k / seg
        loops.append((ring(COVE - COVE * math.cos(a))[0], CEIL - COVE + COVE * math.sin(a)))
    loops.append((with_alcoves(rounded_rect(w, w, 1e-3, ROOM_Z, seg), seg, w, w, ROOM_Z, w / 2)[0], CEIL))
    skip = {(k, seg) for k in range(seg + 2)} | {(k, g) for k in range(seg + 1) for g in gaps}
    mb.fixed.update(mb.loft(loops, 'Concrete', bottom=False, top=False, skip=skip))
    for a in ALCOVES:
        build_alcove(mb, Wall(*a))
    # Sandstone: a frame round the hallway's arch, pilasters round the walls, ribs across between the side ones.
    arch_frame(mb, Wall(0, HALL_Z, 0, 1), W - 0.01, crown(HALL_Z) - W)
    pillars = [(s * ROOM_W, ROOM_Z + t * o, s, 0) for s in (-1, 1) for o in PIL_SIDES for t in (-1, 1)]
    pillars += [(t * o, zw, 0, n) for o in PIL_ENDS for t in (-1, 1) for zw, n in ((HALL_Z, 1), (ROOM_Z0, -1))]
    for p in pillars:
        build_pillar(mb, Wall(*p))
    for o in PIL_SIDES:
        for t in (-1, 1):
            build_rib(mb, ROOM_Z + t * o)
    # The front wall round the hallway's arch, and the floor's cove along it.
    ex, wt = ROOM_W - ROOM_R, CEIL - COVE
    for s in (-1, 1):
        mb.poly([(s * ex, FLOOR, HALL_Z), (s * ex, wt, HALL_Z), (s * W, wt, HALL_Z), (s * W, FLOOR, HALL_Z)],
                'Concrete', (0, 0, -1))
        cove = [(HALL_Z - SKIRT + SKIRT * math.sin(a), FLOOR + SKIRT - SKIRT * math.cos(a))
                for a in (math.pi / 2 * k / seg for k in range(seg + 1))]
        mb.profile_x([(HALL_Z, FLOOR)] + cove, s * W, s * ex, 'Concrete')
    arch_wall(mb, HALL_Z, wt, (0, 0, -1))
    sw = w + WT
    mb.box(-sw, sw, ct, BURIED_TOP, z - sw, z - w, 'Concrete')
    mb.box(-sw, sw, ct, BURIED_TOP, z + w, z + sw, 'Concrete')
    mb.box(-sw, -w, ct, BURIED_TOP, z - w, z + w, 'Concrete')
    mb.box(w, sw, ct, BURIED_TOP, z - w, z + w, 'Concrete')
    # A steel I-beam across the skylight's opening, resting under the ceiling either side; the table's lamp hangs
    # from a plate under its middle.
    bx, by, f = w + 0.45, CEIL - SKY_BEAM, 0.09
    mb.box(-bx, bx, CEIL - 0.025, CEIL + e, z - f, z + f, 'Steel')
    mb.box(-bx, bx, by + 0.012, CEIL - 0.025, z - 0.012, z + 0.012, 'Steel')
    mb.box(-bx, bx, by, by + 0.025, z - f, z + f, 'Steel')
    mb.box(-0.1, 0.1, by - 0.012, by, z - 0.1, z + 0.1, 'Iron')
    # A drain grate in front of the pump (against the east wall, facing the room).
    gx = PUMP_X - 0.9
    mb.box(gx - 0.15, gx + 0.15, FLOOR, FLOOR + 0.006, z - 0.25, z + 0.25, 'Iron')
    for k in range(5):
        zz = z - 0.2 + k * 0.1
        mb.box(gx - 0.13, gx + 0.13, FLOOR + 0.006, FLOOR + 0.012, zz - 0.012, zz + 0.012, 'Steel')
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


def build_workbench():
    """2 x 0.8 m wooden bench (top at 0.92) with a shelf, a pegboard on the wall behind and a few tools."""
    mb = MB()
    hx, hz, top = 1.0, 0.4, 0.92
    mb.box(-hx, hx, top - 0.08, top, -hz + 0.04, hz, 'Wood')
    for sx in (-1, 1):
        for sz in (-1, 1):
            x, z = sx * (hx - 0.1), sz * (hz - 0.1) + 0.02
            mb.box(x - 0.05, x + 0.05, 0, top - 0.08, z - 0.05, z + 0.05, 'WoodDark')
        mb.box(sx * (hx - 0.1) - 0.04, sx * (hx - 0.1) + 0.04, 0.18, 0.24, -hz + 0.1, hz - 0.06, 'WoodDark')
    mb.box(-hx + 0.05, hx - 0.05, 0.24, 0.28, -hz + 0.1, hz - 0.06, 'Wood')  # shelf
    mb.box(-0.7, -0.2, 0.28, 0.5, -0.15, 0.2, 'Rust')  # a crate of parts on it
    mb.box(0.2, 0.6, 0.28, 0.4, -0.1, 0.15, 'Steel')
    # Pegboard on two uprights behind the top, tools hanging on it.
    mb.box(-hx, hx, top, 2.0, -hz, -hz + 0.03, 'Peg')
    for sx in (-1, 1):
        mb.box(sx * hx - 0.04, sx * hx + 0.04, top, 2.05, -hz, -hz + 0.05, 'WoodDark')
    mb.beam((-0.7, 1.75, -hz + 0.06), (-0.7, 1.35, -hz + 0.06), 0.03, 'WoodDark')  # hammer
    mb.box(-0.78, -0.62, 1.72, 1.79, -hz + 0.03, -hz + 0.09, 'Iron')
    mb.beam((-0.35, 1.75, -hz + 0.06), (-0.3, 1.4, -hz + 0.06), 0.025, 'Steel')  # wrench
    mb.box(0.0, 0.5, 1.55, 1.6, -hz + 0.03, -hz + 0.08, 'Iron')  # shelf for jars
    for k in range(4):
        x = 0.06 + k * 0.12
        mb.cyl((x, 1.6, -hz + 0.055), (x, 1.72, -hz + 0.055), 0.04, 'Glass' if k % 2 else 'Rust', seg=8)
    mb.cyl((0.75, 1.3, -hz + 0.06), (0.75, 1.75, -hz + 0.06), 0.012, 'Steel', seg=6)  # screwdriver
    mb.cyl((0.75, 1.3, -hz + 0.06), (0.75, 1.42, -hz + 0.06), 0.025, 'Hazard', seg=6)
    # On the top: a lamp, a half-built gadget, a coil of wire.
    mb.cyl((0.75, top, -0.25), (0.75, top + 0.03, -0.25), 0.09, 'Iron', seg=10)
    mb.beam((0.75, top + 0.03, -0.25), (0.7, top + 0.45, -0.15), 0.025, 'Iron')
    mb.cyl((0.7, top + 0.45, -0.15), (0.62, top + 0.38, 0.0), 0.04, 'Iron', r1=0.1, seg=10)
    mb.cyl((0.63, top + 0.385, -0.02), (0.62, top + 0.38, 0.0), 0.06, 'EmitWarm', seg=10)
    mb.box(-0.2, 0.2, top, top + 0.12, -0.05, 0.2, 'Steel')
    mb.cyl((-0.05, top + 0.12, 0.08), (-0.05, top + 0.2, 0.08), 0.04, 'Rust', seg=8)
    mb.cyl((-0.6, top, 0.1), (-0.6, top + 0.06, 0.1), 0.12, 'Rust', seg=12)
    return mb.build('workbench')


def build_disassembly():
    """2 m square steel table (top at TABLE_TOP) with a slatted top. The top is left clear for the machine being taken
    apart; the tools stay round its sides, none sticking out more than about 0.3 m, each bolted to the apron (flush
    with the top's edge) or standing on the floor: a vise and a bolt tray on the west side, a grinder on a bracket
    and the scrap bin on the east side, a tool rail on the back (-Z) and hazard stripes on the front (+Z)."""
    mb = MB()
    hx = hz = TABLE_HW
    top = TABLE_TOP
    mb.box(-hx, hx, top - 0.06, top - 0.03, -hz, hz, 'Iron')  # plate under the slats
    for k in range(11):
        z = -hz + 0.05 + k * (2 * hz - 0.1) / 10
        mb.box(-hx, hx, top - 0.03, top, z - 0.035, z + 0.035, 'Steel')
    # Apron round the edge (the tools are bolted to it), legs, and a low frame.
    t = 0.0
    mb.box(-hx + t, hx - t, top - 0.15, top - 0.06, hz - 0.05, hz - t, 'Iron')
    mb.box(-hx + t, hx - t, top - 0.15, top - 0.06, -hz + t, -hz + 0.05, 'Iron')
    mb.box(hx - 0.05, hx - t, top - 0.15, top - 0.06, -hz + 0.05, hz - 0.05, 'Iron')
    mb.box(-hx + t, -hx + 0.05, top - 0.15, top - 0.06, -hz + 0.05, hz - 0.05, 'Iron')
    for sx in (-1, 1):
        for sz in (-1, 1):
            x, z = sx * (hx - 0.07), sz * (hz - 0.07)
            mb.box(x - 0.045, x + 0.045, 0, top - 0.06, z - 0.045, z + 0.045, 'Iron')
    for sz in (-1, 1):
        mb.box(-hx + 0.07, hx - 0.07, 0.15, 0.2, sz * (hz - 0.07) - 0.03, sz * (hz - 0.07) + 0.03, 'Iron')
    mb.box(-0.03, 0.03, 0.15, 0.2, -hz + 0.07, hz - 0.07, 'Iron')
    # Hazard stripes along the front edge.
    for k in range(10):
        x = -hx + 0.1 + k * 0.2
        mb.box(x - 0.05, x + 0.05, top - 0.08, top - 0.02, hz, hz + 0.01, 'Hazard')

    # West side: a bench vise bolted to the edge (its jaws open outwards) and a bolt tray on a bracket.
    vz = 0.25
    mb.box(-hx - 0.04, -hx, top - 0.12, top - 0.02, vz - 0.12, vz + 0.12, 'Iron')  # mounting plate
    mb.box(-hx - 0.2, -hx - 0.04, top - 0.1, top, vz - 0.1, vz + 0.1, 'PumpPaint')  # body
    mb.box(-hx - 0.2, -hx - 0.14, top, top + 0.1, vz - 0.1, vz + 0.1, 'PumpPaint')  # fixed jaw
    mb.box(-hx - 0.1, -hx - 0.04, top, top + 0.1, vz - 0.1, vz + 0.1, 'PumpPaint')  # sliding jaw
    mb.cyl((-hx - 0.04, top - 0.05, vz), (-hx - 0.3, top - 0.05, vz), 0.015, 'Steel', seg=6)  # screw
    mb.cyl((-hx - 0.3, top - 0.05, vz - 0.1), (-hx - 0.3, top - 0.05, vz + 0.1), 0.012, 'Steel', seg=6)  # handle
    tz = -0.35
    mb.box(-hx - 0.2, -hx, top - 0.2, top - 0.17, tz - 0.14, tz + 0.14, 'Iron')  # bracket under the tray
    mb.box(-hx - 0.02, -hx, top - 0.2, top - 0.06, tz - 0.14, tz + 0.14, 'Iron')  # hung from the apron
    mb.box(-hx - 0.21, -hx - 0.01, top - 0.17, top - 0.15, tz - 0.15, tz + 0.15, 'Steel')  # tray floor
    mb.box(-hx - 0.21, -hx - 0.19, top - 0.15, top - 0.08, tz - 0.15, tz + 0.15, 'Steel')  # its walls
    for z in (tz - 0.15, tz + 0.15):
        mb.box(-hx - 0.21, -hx - 0.01, top - 0.15, top - 0.08, z - 0.01, z + 0.01, 'Steel')
    for x, z in ((-0.09, -0.08), (-0.14, 0.02), (-0.06, 0.08), (-0.16, -0.03), (-0.1, 0.05)):
        mb.cyl((-hx + x, top - 0.15, tz + z), (-hx + x, top - 0.13, tz + z), 0.015, 'Iron', seg=6)  # loose bolts
    mb.cyl((-hx - 0.12, top - 0.14, tz + 0.04), (-hx - 0.08, top - 0.14, tz - 0.05), 0.02, 'Hazard', seg=6)

    # East side: an angle grinder on a bracket shelf, the scrap bin on the floor.
    gz = -0.3
    mb.box(hx, hx + 0.26, top - 0.35, top - 0.32, gz - 0.12, gz + 0.12, 'Iron')  # shelf
    mb.box(hx, hx + 0.02, top - 0.35, top - 0.06, gz - 0.12, gz + 0.12, 'Iron')  # its back, up the apron
    mb.cyl((hx + 0.04, top - 0.29, gz), (hx + 0.2, top - 0.29, gz), 0.04, 'Hazard', seg=8)  # body
    mb.cyl((hx + 0.2, top - 0.29, gz), (hx + 0.25, top - 0.29, gz), 0.05, 'Iron', seg=8)  # gear head
    mb.cyl((hx + 0.22, top - 0.28, gz - 0.015), (hx + 0.22, top - 0.28, gz + 0.015), 0.1, 'Steel', seg=12)  # disc
    bz = 0.35
    mb.cyl((hx + 0.1, 0.0, bz), (hx + 0.1, 0.55, bz), 0.2, 'Rust', r1=0.23, seg=12)
    mb.box(hx - 0.02, hx + 0.2, 0.45, 0.6, bz - 0.12, bz + 0.12, 'Steel')  # a part in it
    mb.cyl((hx + 0.1, 0.53, bz), (hx + 0.1, 0.56, bz), 0.19, 'ConcreteDark', seg=12)  # scrap in the mouth

    # Back side: a tool rail on two brackets, with a hammer, a wrench and a screwdriver hanging from it.
    rz = -hz - 0.05
    for x in (-0.7, 0.7):
        mb.box(x - 0.02, x + 0.02, top - 0.2, top - 0.06, rz - 0.02, -hz, 'Iron')
    ry = top - 0.1
    mb.cyl((-0.8, ry, rz - 0.01), (0.8, ry, rz - 0.01), 0.012, 'Steel', seg=6)
    mb.beam((-0.4, ry, rz - 0.03), (-0.4, ry - 0.32, rz - 0.03), 0.03, 'WoodDark')  # hammer
    mb.box(-0.48, -0.32, ry - 0.06, ry + 0.01, rz - 0.07, rz + 0.01, 'Iron')
    mb.beam((-0.05, ry, rz - 0.03), (-0.03, ry - 0.28, rz - 0.03), 0.025, 'Steel')  # wrench
    mb.cyl((0.3, ry - 0.28, rz - 0.03), (0.3, ry, rz - 0.03), 0.012, 'Steel', seg=6)  # screwdriver
    mb.cyl((0.3, ry - 0.2, rz - 0.03), (0.3, ry - 0.08, rz - 0.03), 0.025, 'Hazard', seg=6)
    return mb.build('disassembly')


def build_chest():
    """1.2 x 0.7 m plank chest (0.62 tall, lid from 0.45) with iron bands, corner caps, side handles and a hasp."""
    mb = MB()
    hx, hz, lid, top = 0.6, 0.35, 0.45, 0.62
    # Body planks: three courses with dark gaps between them, and the lid in two.
    for k, (y0, y1) in enumerate(((0.04, 0.17), (0.18, 0.31), (0.32, lid))):
        mb.box(-hx, hx, y0, y1, -hz, hz, 'Wood' if k % 2 == 0 else 'WoodDark')
    mb.box(-hx + 0.02, hx - 0.02, 0, 0.04, -hz + 0.02, hz - 0.02, 'WoodDark')
    mb.box(-hx + 0.01, hx - 0.01, lid, lid + 0.01, -hz + 0.01, hz - 0.01, 'Iron')  # the lid's seam
    mb.box(-hx - 0.01, hx + 0.01, lid + 0.01, top - 0.07, -hz - 0.01, hz + 0.01, 'Wood')
    mb.box(-hx - 0.01, hx + 0.01, top - 0.07, top, -hz + 0.03, hz - 0.03, 'WoodDark')
    # Iron bands wrapping body and lid, and corner caps.
    for x in (-hx + 0.18, hx - 0.18):
        mb.box(x - 0.035, x + 0.035, 0.02, lid, -hz - 0.012, hz + 0.012, 'Iron')
        mb.box(x - 0.035, x + 0.035, lid + 0.01, top + 0.008, -hz - 0.022, hz + 0.022, 'Iron')
    for sx in (-1, 1):
        for sz in (-1, 1):
            x, z = sx * hx, sz * hz
            mb.box(min(x, x - sx * 0.08) - 0.012, max(x, x - sx * 0.08) + 0.012, 0, top - 0.06,
                   min(z, z - sz * 0.08) - 0.012, max(z, z - sz * 0.08) + 0.012, 'Iron')
        # Rope-grip handle on each end.
        mb.box(sx * (hx + 0.012) - 0.015, sx * (hx + 0.012) + 0.015, 0.27, 0.32, -0.12, 0.12, 'Iron')
        mb.cyl((sx * (hx + 0.06), 0.24, -0.1), (sx * (hx + 0.06), 0.24, 0.1), 0.018, 'Steel', seg=6)
    # Brass hasp and lock on the front.
    mb.box(-0.06, 0.06, lid - 0.05, top - 0.04, hz + 0.012, hz + 0.03, 'Hazard')
    mb.box(-0.05, 0.05, lid - 0.16, lid - 0.04, hz, hz + 0.04, 'Hazard')
    mb.cyl((0, lid - 0.1, hz + 0.04), (0, lid - 0.1, hz + 0.045), 0.015, 'Iron', seg=6)
    return mb.build('chest')


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
    """Shots: the surface from the front, a cutaway from above, inside the room, down the stairs, the benches."""
    hut, bunker, pump, bench, dis, chest = objs
    chest.location = G(0, FLOOR, ROOM_Z0 - ALC_D + 0.5)
    pump.location = G(PUMP_X, FLOOR, ROOM_Z)
    pump.rotation_euler = (0, 0, -math.pi / 2)
    bench.location = G(-ROOM_W - ALC_D + 0.42, FLOOR, ROOM_Z)
    bench.rotation_euler = (0, 0, math.pi / 2)
    dis.location = G(0, FLOOR, ROOM_Z)
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
    for x0, x1, z0, z1 in ((-14, -1.25, -43, 14), (1.25, 14, -43, 14), (-1.25, 1.25, 2.15, 14),
                           (-1.25, 1.25, ROOM_Z + 1.6, HUT_Z0 - 0.15), (-1.25, 1.25, -43, ROOM_Z - 1.6)):
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
    lamp_data = bpy.data.lights.new('room lamp', 'POINT')  # the skylight's sun doesn't reach the whole room
    lamp_data.energy = 1500
    lamp = bpy.data.objects.new('room lamp', lamp_data)
    lamp.location = G(0, FLOOR + 3.5, ROOM_Z)
    scene.collection.objects.link(lamp)
    shot('room', G(3.8, FLOOR + 1.65, HALL_Z - 1.0), G(0, FLOOR + 0.8, ROOM_Z), lens=20)
    shot('stairs', G(0, 1.65, 1.8), G(0, FLOOR + 1.0, -9), lens=22)
    shot('pump', G(PUMP_X - 2.2, FLOOR + 1.3, ROOM_Z + 1.4), G(PUMP_X, FLOOR + 0.7, ROOM_Z), lens=35)
    bg.inputs['Strength'].default_value = 0.6
    lamp.hide_render = True
    hut.hide_render = bunker.hide_render = sand.hide_render = True
    shot('bench', G(-ROOM_W + 3.2, FLOOR + 1.7, ROOM_Z + 1.6), G(-ROOM_W + 0.4, FLOOR + 1.0, ROOM_Z), lens=28)
    shot('disassembly', G(-2.6, FLOOR + 1.9, ROOM_Z + 2.4), G(0, FLOOR + 0.5, ROOM_Z), lens=28)
    shot('disassembly_back', G(2.6, FLOOR + 1.9, ROOM_Z - 2.4), G(0, FLOOR + 0.5, ROOM_Z), lens=28)
    shot('chest', G(1.4, FLOOR + 1.4, ROOM_Z0 + 2.4), G(0, FLOOR + 0.35, ROOM_Z0 - ALC_D + 0.5), lens=35)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'models', 'base', 'bunker.glb'))
    ap.add_argument('--preview', default=None)
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    make_materials()
    objs = [build_hut(), build_bunker(), build_pump(), build_workbench(), build_disassembly(), build_chest()]
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    export(objs, args.out)
    for o in objs:
        print(f'NODE {o.name}: tris={tri_count(o)}')
    print(f'WROTE {args.out} {os.path.getsize(args.out) / 1024:.1f} KiB')
    if args.preview:
        render_preview(objs, os.path.abspath(args.preview))


if __name__ == '__main__':
    main()
