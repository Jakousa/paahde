"""The work stations, the chest and the hand pump: the models (bmesh builders, materials and the glTF export) that
tools/blender/stations.py writes. They were the starting bunker's furniture; the bunker is gone, these stayed: the
workbench, the dismantling bench and the chest are buildings now (shared/placed.ts), and the pump stands in the shelters
(src/world/shelters.ts). Runs nothing on import.

Geometry is written in game coordinates (x, y up, z; the front is game +Z) and converted by G(): Blender is Z-up, the
exporter converts to Y-up, game +Z = Blender -Y. Units are metres. Each model's origin is the centre of its base.
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True  # no __pycache__ next to the scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from coplanar import separate_coplanar  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

TABLE_HW, TABLE_TOP = 1.0, 0.8  # the dismantling bench's half size and top (shared/placed.ts TABLE_HW, TABLE_TOP)
SMOOTH_ANGLE = math.radians(40)  # edges sharper than this stay hard; gentler ones are shaded smooth


# name: (sRGB hex, roughness, metallic, double_sided)
MATERIALS = {
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
