"""Shared helpers for the machine models (tools/blender/machines/<machine>.py).

A machine script builds the model's geometry AND records its steps and parts, then writes both:

    public/models/machines/<model>.glb      the geometry: a `Shell` node (what never comes off), one `Mod_<id>` node per
                                            module (a sub-assembly that may be missing from a given machine, and that
                                            comes off as one piece when its steps are done), and a `Dress` node (earth,
                                            scorch marks and scattered debris, which stay)
    shared/machines/<kind>.ts               the layout: for each module its chance of still being there, its steps
                                            (kind, label, position and facing) and its parts. The server reads this
                                            too, so it knows what every step is without trusting a client.

Everything is built in three.js coordinates (Y up, +Z forward, metres) under a transform stack and turned into Blender's
Z-up frame just before export, like tools/blender/colossus.py. One node per piece, no parenting, identity transforms.
Run through tools/blender/run.sh:  tools/blender/run.sh -b --python tools/blender/machines/<machine>.py [-- --preview dir]
"""

import argparse
import json
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
PI = math.pi
C = Matrix.Rotation(PI / 2, 4, 'X')  # three.js (Y up) -> Blender (Z up)


# ================================================================================================= basics

def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lin(hex_color):
    return [srgb_to_linear(((hex_color >> s) & 0xFF) / 255) for s in (16, 8, 0)]


def make_material(name, hex_color, metallic, roughness, emission=None):
    mat = bpy.data.materials.new(name)
    rgb = lin(hex_color)
    mat.diffuse_color = (*rgb, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    if emission:
        bsdf.inputs['Emission Color'].default_value = (*rgb, 1)
        bsdf.inputs['Emission Strength'].default_value = emission
    mat.use_backface_culling = False
    return mat


def T(x, y=None, z=None):
    if y is None:
        return Matrix.Translation(Vector(x))
    return Matrix.Translation(Vector((x, y, z)))


def S(x, y, z):
    return Matrix.Diagonal((x, y, z, 1))


def Rx(a):
    return Matrix.Rotation(a, 4, 'X')


def Ry(a):
    return Matrix.Rotation(a, 4, 'Y')


def Rz(a):
    return Matrix.Rotation(a, 4, 'Z')


def aim(p, d):
    """Matrix putting local +Z along d at point p."""
    d = Vector(d).normalized()
    up = Vector((0, 1, 0)) if abs(d.y) < 0.95 else Vector((1, 0, 0))
    x = up.cross(d).normalized()
    y = d.cross(x)
    m = Matrix((x, y, d)).transposed().to_4x4()
    return T(p) @ m


def around(axis_point, axis_dir, angle):
    """Rotation by `angle` about the line through axis_point along axis_dir."""
    p = Vector(axis_point)
    return T(p) @ Matrix.Rotation(angle, 4, Vector(axis_dir).normalized()) @ T(-p)


# ================================================================================================= mesh builder

class MB:
    """bmesh built in three.js coordinates under a transform stack, one material per face."""

    def __init__(self, base=None):
        self.bm = bmesh.new()
        self.mats = []
        self.stack = [base if base is not None else Matrix.Identity(4)]

    def push(self, m):
        self.stack.append(self.stack[-1] @ m)

    def pop(self):
        self.stack.pop()

    def mi(self, name):
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    def V(self, p):
        return self.bm.verts.new(self.stack[-1] @ Vector(p))

    def F(self, vs, mat):
        f = self.bm.faces.new(vs)
        f.material_index = self.mi(mat)
        f.smooth = False
        return f

    def fix(self, faces):
        if faces:
            bmesh.ops.recalc_face_normals(self.bm, faces=faces)

    def tag(self, verts, mat):
        faces = {f for v in verts for f in v.link_faces}
        for f in faces:
            f.material_index = self.mi(mat)
            f.smooth = False
        return list(faces)

    def loft(self, rings, mat, cap0=False, cap1=False, matfn=None, capmat=None, closed=True):
        vr = [[self.V(p) for p in r] for r in rings]
        n = len(rings[0])
        faces = []
        for i in range(len(vr) - 1):
            for k in range(n if closed else n - 1):
                j = (k + 1) % n
                m = matfn(i, k) if matfn else mat
                faces.append(self.F([vr[i][k], vr[i][j], vr[i + 1][j], vr[i + 1][k]], m))
        if cap0:
            faces.append(self.F(list(reversed(vr[0])), capmat or mat))
        if cap1:
            faces.append(self.F(vr[-1], capmat or mat))
        self.fix(faces)
        return faces

    def fan(self, ring_pts, tip, mat):
        vs = [self.V(p) for p in ring_pts]
        t = self.V(tip)
        faces = [self.F([vs[k], vs[(k + 1) % len(vs)], t], mat) for k in range(len(vs))]
        self.fix(faces)
        return faces

    def cyl(self, a, b, r1, r2=None, segs=10, mat='Steel', cap0=True, cap1=True, phase=0.0, capmat=None):
        """Cylinder/cone from a to b. r2 == 0 makes a spike."""
        a, b = Vector(a), Vector(b)
        d = b - a
        r2 = r1 if r2 is None else r2
        self.push(aim(a, d))
        ring = [(math.cos(phase + 2 * PI * k / segs), math.sin(phase + 2 * PI * k / segs)) for k in range(segs)]
        r0 = [(c * r1, s * r1, 0) for c, s in ring]
        if r2 <= 1e-6:
            faces = self.fan(r0, (0, 0, d.length), mat)
            if cap0:
                faces.append(self.F([self.V(p) for p in reversed(r0)], mat))
        else:
            faces = self.loft([r0, [(c * r2, s * r2, d.length) for c, s in ring]], mat, cap0, cap1, capmat=capmat)
        self.pop()
        return faces

    def lathe(self, profile, segs, mat, M=None, matfn=None, phase=0.0, cap=False, a0=0.0, a1=2 * PI):
        """Revolve an (r, z) profile about local Z (then M). matfn(profile index, segment index) picks a face's material.
        a0..a1 revolves only that arc (an open shell: a cowl half)."""
        full = abs((a1 - a0) - 2 * PI) < 1e-6
        n = segs if full else segs + 1
        rings = [[(r * math.cos(phase + a0 + (a1 - a0) * i / segs), r * math.sin(phase + a0 + (a1 - a0) * i / segs), z)
                  for i in range(n)] for r, z in profile]
        self.push(M if M is not None else Matrix.Identity(4))
        f = self.loft(rings, mat, matfn=matfn, cap1=cap and full, closed=full)
        self.pop()
        return f

    def box(self, c, size, mat, rot=(0, 0, 0), taper=(1, 1), M=None):
        """Box centred on c. taper scales the top (+Y) face in x and z."""
        verts = bmesh.ops.create_cube(self.bm, size=1)['verts']
        for v in verts:
            x, y, z = v.co
            if y > 0:
                x *= taper[0]
                z *= taper[1]
            v.co = Vector((x * size[0], y * size[1], z * size[2]))
        mm = self.stack[-1] @ (M if M is not None else Matrix.Identity(4)) @ T(c) @ Euler(rot).to_matrix().to_4x4()
        bmesh.ops.transform(self.bm, matrix=mm, verts=verts)
        return self.tag(verts, mat)

    def beam(self, a, b, w, h, mat, up=(0, 1, 0)):
        a, b = Vector(a), Vector(b)
        d = (b - a)
        z = d.normalized()
        y = Vector(up)
        y = (y - z * y.dot(z)).normalized()
        x = y.cross(z)
        m = Matrix((x, y, z)).transposed().to_4x4()
        return self.box((0, 0, d.length / 2), (w, h, d.length), mat, M=T(a) @ m)

    def sphere(self, c, r, mat, u=8, v=5, scale=(1, 1, 1), M=None):
        self.push((M if M is not None else Matrix.Identity(4)) @ T(c) @ S(*scale))
        rings = []
        for j in range(1, v):
            sj, cj = math.sin(PI * j / v), math.cos(PI * j / v)
            rings.append([(r * sj * math.cos(2 * PI * i / u), r * sj * math.sin(2 * PI * i / u), -r * cj)
                          for i in range(u)])
        faces = self.loft(rings, mat)
        faces += self.fan(list(reversed(rings[0])), (0, 0, -r), mat)
        faces += self.fan(rings[-1], (0, 0, r), mat)
        self.pop()
        return faces

    def sweep(self, pts, r, mat, segs=5):
        """Tube through a polyline, capped."""
        pts = [Vector(p) for p in pts]
        n = len(pts)
        rings = []
        ref = Vector((1, 0, 0))
        for i, p in enumerate(pts):
            t = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
            if abs(t.dot(ref)) > 0.9:
                ref = Vector((0, 1, 0)) if abs(t.y) < 0.9 else Vector((1, 0, 0))
            u = (ref - t * ref.dot(t)).normalized()
            w = t.cross(u)
            rings.append([tuple(p + (u * math.cos(a) + w * math.sin(a)) * r)
                          for a in (2 * PI * (k + 0.5) / segs for k in range(segs))])
            ref = u
        return self.loft(rings, mat, True, True)

    def deform(self, fn):
        """Move every vertex built so far: fn(Vector) -> Vector (in the model's three.js coordinates)."""
        for v in self.bm.verts:
            v.co = fn(v.co.copy())

    def bolt_heads(self, pts, nrm, r, mat='Steel', h=None):
        """Hex bolt heads that do nothing but make a flange look like a flange (the ones you can work are steps)."""
        h = h or r * 0.8
        n = Vector(nrm).normalized()
        for p in pts:
            self.cyl(Vector(p), Vector(p) + n * h, r, r, segs=6, mat=mat)


def shell_solid(mb, prof, t, segs, mat, inner_mat=None, a0=0.0, a1=2 * PI, matfn=None):
    """A lathed shell with wall thickness `t`: outer skin, inner skin, the rims and (for an arc) the cut faces, so nothing in it
    is see-through. prof is (radius, z) of the outer skin; a0..a1 an arc about Z (as MB.lathe)."""
    full = abs((a1 - a0) - 2 * PI) < 1e-6
    inner = [(r - t, z) for r, z in prof]
    mb.lathe(prof, segs, mat, a0=a0, a1=a1, matfn=matfn)
    mb.lathe(inner, segs, inner_mat or mat, a0=a0, a1=a1)
    for k in (0, len(prof) - 1):
        mb.lathe([prof[k], inner[k]], segs, mat, a0=a0, a1=a1)
    if not full:
        for ang in (a0, a1):
            o = [(r * math.cos(ang), r * math.sin(ang), z) for r, z in prof]
            i = [(r * math.cos(ang), r * math.sin(ang), z) for r, z in inner]
            mb.loft([o, i], mat, closed=False)


def swing(hinge_phi, free_phi, radius, angle):
    """Matrix swinging a half-shell open about its hinge line (parallel to Z at angle hinge_phi, our angles) so that its free edge
    moves away from the axis."""
    h = Vector((radius * math.sin(hinge_phi), radius * math.cos(hinge_phi), 0))
    e = Vector((radius * math.sin(free_phi), radius * math.cos(free_phi), 0))
    best = None
    for sgn in (1, -1):
        m = around(h, (0, 0, 1), sgn * angle)
        d = (m @ e).length
        if best is None or d > best[0]:
            best = (d, m)
    return best[1]


# ================================================================================================= damage

def crush(mb, centre, radius, depth, toward=None):
    """A dent: vertices within `radius` of `centre` are pushed `depth` toward `toward` (default: the model's axis)."""
    c = Vector(centre)
    tw = Vector(toward) if toward is not None else None

    def f(p):
        d = (p - c).length
        if d >= radius:
            return p
        k = (1 - d / radius) ** 2 * depth
        direction = (tw - p).normalized() if tw is not None else (Vector((0, 0, p.z)) - p).normalized()
        return p + direction * k

    mb.deform(f)


def ripple(mb, seed, amount, scale=6.0):
    """Cheap crumple: a deterministic noise displacement along each vertex's own direction from the axis."""
    rnd = random.Random(seed)
    ph = [rnd.random() * 100 for _ in range(6)]

    def f(p):
        n = (math.sin(p.x * scale + ph[0]) * math.sin(p.y * scale + ph[1]) * math.sin(p.z * scale * 0.8 + ph[2])
             + 0.5 * math.sin(p.x * scale * 2.3 + ph[3]) * math.sin(p.z * scale * 2.1 + ph[4]))
        d = Vector((p.x, p.y, 0))
        if d.length < 1e-4:
            return p
        return p + d.normalized() * n * amount

    mb.deform(f)


# ================================================================================================= machine recorder

class Module:
    """A sub-assembly that comes off as one piece when its steps are done. `chance`: how likely it is still on a given machine."""

    def __init__(self, machine, mid, chance, pop):
        self.machine = machine
        self.id = mid
        self.chance = chance
        self.pop = pop
        self.steps = []
        self.parts = []
        self.mb = MB()
        self.local = Matrix.Identity(4)
        self.n = 0
        self.in_inner = False

    def inside(self, on=True):
        """Steps and parts made from now on are *inner*: they belong to the piece once it has come off (it lies on the ground and
        is taken apart further), not to the machine it came from."""
        self.in_inner = on

    def place(self, local):
        """This module sits displaced from where it was built (hanging off its pad, swung open): everything of it, geometry,
        steps and parts, is built in the engine's own frame and moved by `local` at the end."""
        self.local = local

    def _m(self):
        return self.machine.pose @ self.local

    def _tx(self, p):
        return list(self._m() @ Vector(p))

    def _tn(self, n):
        v = self._m().to_3x3() @ Vector(n)
        return list(v.normalized())

    def step(self, kind, label, pos, nrm, after=(), need=None, players=1):
        """A fastener (screw, bolt, clip, pry, lift) at `pos` facing `nrm`. `after`: step ids or module ids that must be done first."""
        self.n += 1
        sid = f'{self.id}.{label}{self.n}'
        d = {'id': sid, 'kind': kind, 'label': label, 'pos': self._tx(pos), 'nrm': self._tn(nrm), 'after': list(after)}
        if need is not None:
            d['need'] = need
        if players != 1:
            d['players'] = players
        if self.in_inner:
            d['inner'] = True
        self.steps.append(d)
        return sid

    def ring(self, kind, label, centre, nrm, r, n, after=(), phase=0.0, need=None):
        """A bolt circle on a round flange (facing `nrm`), n fasteners at radius r."""
        nrm = Vector(nrm).normalized()
        u = Vector((0, 1, 0)).cross(nrm)
        if u.length < 0.1:
            u = Vector((1, 0, 0)).cross(nrm)
        u.normalize()
        w = nrm.cross(u)
        ids = []
        for i in range(n):
            a = phase + 2 * PI * i / n
            ids.append(self.step(kind, label, Vector(centre) + (u * math.cos(a) + w * math.sin(a)) * r, nrm, after, need))
        return ids

    def rring(self, kind, label, z, r, n, after=(), phase=0.0, need=None, tilt=0.0):
        """A ring of fasteners round an axis (Z) at axial position z and radius r, each facing outward (the engine's skin)."""
        ids = []
        for i in range(n):
            a = phase + 2 * PI * i / n
            d = Vector((math.sin(a), math.cos(a), tilt)).normalized()
            ids.append(self.step(kind, label, Vector((r * math.sin(a), r * math.cos(a), z)), d, after, need))
        return ids

    def row(self, kind, label, a, b, n, nrm, after=(), need=None):
        """n fasteners evenly from a to b (a split-line or edge flange)."""
        a, b = Vector(a), Vector(b)
        return [self.step(kind, label, a.lerp(b, 0.5 if n == 1 else i / (n - 1)), nrm, after, need) for i in range(n)]

    def wire(self, label, pts, key='black', after=(), r=0.012):
        self.n += 1
        sid = f'{self.id}.{label}{self.n}'
        d = {'id': sid, 'kind': 'wire', 'label': label, 'pts': [self._tx(p) for p in pts], 'key': key, 'r': r, 'after': list(after)}
        if self.in_inner:
            d['inner'] = True
        self.steps.append(d)
        return sid

    def mash(self, label, outline, after=(), need=10):
        """A part to be prised away by mashing the use button on it: its whole edge (`outline`, a closed path round the part) glows."""
        self.n += 1
        sid = f'{self.id}.{label}{self.n}'
        d = {'id': sid, 'kind': 'mash', 'label': label, 'pts': [self._tx(p) for p in outline], 'after': list(after), 'need': need}
        if self.in_inner:
            d['inner'] = True
        self.steps.append(d)
        return sid

    def grind(self, label, pts, after=(), only_with=()):
        """A seam to be ground open with the grinder: followed along `pts`. It joins this module to `only_with` (module ids): it is
        only there when those are all on the machine too (a seam against a half that is gone is not a seam)."""
        self.n += 1
        sid = f'{self.id}.{label}{self.n}'
        d = {'id': sid, 'kind': 'grind', 'label': label, 'pts': [self._tx(p) for p in pts], 'after': list(after)}
        if only_with:
            d['with'] = list(only_with)
        if self.in_inner:
            d['inner'] = True
        self.steps.append(d)
        return sid

    def part(self, part, pos, rot=(0, 0, 0), chance=1.0, holds=None):
        """A collectable part sitting at `pos` inside this module (revealed when the module's steps are done)."""
        q = (self._m().to_3x3() @ Euler(rot).to_matrix()).to_quaternion()
        d = {'part': part, 'pos': self._tx(pos), 'quat': [q.x, q.y, q.z, q.w], 'chance': chance}
        if self.in_inner:
            d['inner'] = True
        self.parts.append(d)


class Machine:
    def __init__(self, kind, model, pose=None):
        self.kind = kind
        self.model = model
        self.pose = pose if pose is not None else Matrix.Identity(4)
        self.shell = MB()
        self.dress = MB(Matrix.Identity(4))
        self.modules = []
        self.hits = []
        self.meta = {}

    def hit(self, z0, z1, r, mods=()):
        """A stretch of solid, a cylinder of radius r about the axis (Z) between z0 and z1 (the machine's own frame): there while any of
        `mods` is still on the machine, always when there are none. The players collide with these (shared/machineBoxes.ts)."""
        self.hits.append({'z0': round(z0, 3), 'z1': round(z1, 3), 'r': round(r, 3), 'mods': list(mods)})

    def module(self, mid, chance=1.0, pop=(0, 1, 0)):
        m = Module(self, mid, chance, [round(x, 3) for x in Vector(pop).normalized()])
        self.modules.append(m)
        return m

    # ---- output ---------------------------------------------------------------------------------------------

    def _object(self, mb, name, M=None):
        bmesh.ops.transform(mb.bm, matrix=C @ (M if M is not None else Matrix.Identity(4)), verts=mb.bm.verts)
        mb.bm.normal_update()
        mesh = bpy.data.meshes.new(name)
        mb.bm.to_mesh(mesh)
        mb.bm.free()
        for m in mb.mats:
            mesh.materials.append(bpy.data.materials[m])
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        return obj

    def build(self):
        """Turn the builders into objects. Returns {node name: object}."""
        out = {'Shell': self._object(self.shell, 'Shell', self.pose), 'Dress': self._object(self.dress, 'Dress')}
        for m in self.modules:
            out[f'Mod_{m.id}'] = self._object(m.mb, f'Mod_{m.id}', m._m())
        return out

    def layout_ts(self, rel_model):
        """The layout as TypeScript (shared/machines/<kind>.ts), read by the server and the client."""
        r3 = lambda v: [round(x, 4) for x in v]
        mods = []
        for m in self.modules:
            steps = []
            for s in m.steps:
                d = dict(s)
                for k in ('pos', 'nrm'):
                    if k in d:
                        d[k] = r3(d[k])
                if 'pts' in d:
                    d['pts'] = [r3(p) for p in d['pts']]
                steps.append(d)
            parts = [{**p, 'pos': r3(p['pos']), 'quat': [round(x, 4) for x in p['quat']]} for p in m.parts]
            pop = [round(x, 3) for x in (m._m().to_3x3() @ Vector(m.pop)).normalized()]  # in the posed machine's frame
            mods.append({'id': m.id, 'chance': m.chance, 'pop': pop, 'steps': steps, 'parts': parts})
        rows = ',\n  '.join(json.dumps(m, separators=(',', ':')) for m in mods)
        hits = ',\n  '.join(json.dumps(h, separators=(',', ':')) for h in self.hits)
        pose = json.dumps({k: round(v, 4) for k, v in self.meta.items()}, separators=(',', ':'))
        body = f'{{\n  kind: {json.dumps(self.kind)},\n  model: {json.dumps(self.model)},\n  pose: {pose},\n  hits: [\n  {hits},\n  ],\n  modules: [\n  {rows},\n  ],\n}}'
        return (f"// Generated by tools/blender/machines/{self.model}.py from the model: do not edit by hand.\n"
                f"// {self.kind}'s layout: its modules with the chance each is still on a machine, their steps (what holds\n"
                f"// them, where, facing which way) and the parts inside. Read by the server (what a step is, what is\n"
                f"// inside) and by src/teardown/glbMachine.ts (what to build).\n"
                f"import type {{ MachineLayout }} from '../machines.ts';\n\n"
                f"export const LAYOUT: MachineLayout = {body};\n")


# ================================================================================================= export / checks

def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def export_glb(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                              export_apply=True, export_materials='EXPORT', export_normals=True,
                              export_texcoords=False)


def finish(machine, materials, out_dir, ts_dir, preview=None, previewer=None):
    """Make the materials, build the objects, write the glb and the layout, report, and render previews on request."""
    for o in list(bpy.data.objects):  # the startup scene's cube, light and camera
        bpy.data.objects.remove(o)
    for name, spec in materials.items():
        make_material(name, *spec)
    objs = machine.build()
    os.makedirs(out_dir, exist_ok=True)
    export_glb(list(objs.values()), os.path.join(out_dir, f'{machine.model}.glb'))
    os.makedirs(ts_dir, exist_ok=True)
    with open(os.path.join(ts_dir, f'{machine.model}.ts'), 'w', encoding='utf8', newline='\n') as f:
        f.write(machine.layout_ts(machine.model))
    total = 0
    for name, o in objs.items():
        n = tri_count(o)
        total += n
        d = o.dimensions
        print(f'{name}: tris={n} size={d.x:.2f} x {d.z:.2f} x {d.y:.2f} m (w x h x d)')
    steps = sum(len(m.steps) for m in machine.modules)
    parts = sum(len(m.parts) for m in machine.modules)
    print(f'{machine.model}: {len(machine.modules)} modules, {steps} steps, {parts} parts, {total} tris')
    if preview and previewer:
        previewer(objs, os.path.abspath(preview))


def args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--preview', default=None, help='directory for PNG previews')
    return ap.parse_args(argv)


# ================================================================================================= previews

def preview_scene(ground_y_blender=0.0, sun_deg=(72, 0, -140)):
    """A sand-coloured ground, a low warm sun and a camera; returns (scene, cam, look, shoot)."""
    scene = bpy.context.scene
    for engine in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x, scene.render.resolution_y = 1200, 800
    scene.view_settings.view_transform = 'Standard'
    bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, ground_y_blender))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new('ground')
    gm.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (*lin(0xc46a24), 1)
    gm.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value = 1.0
    ground.data.materials.append(gm)
    world = scene.world or bpy.data.worlds.new('world')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (*lin(0xcfd6dc), 1)
    bg.inputs['Strength'].default_value = 1.1
    sd = bpy.data.lights.new('sun', 'SUN')
    sd.energy = 3.2
    sd.color = (1.0, 0.9, 0.78)
    sun = bpy.data.objects.new('sun', sd)
    sun.rotation_euler = (math.radians(sun_deg[0]), math.radians(sun_deg[1]), math.radians(sun_deg[2]))
    scene.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.clip_end = 2000

    def look(pos3, target3, lens):
        p = C @ Vector(pos3)
        t = C @ Vector(target3)
        cam.location = p
        cam.rotation_euler = (t - p).to_track_quat('-Z', 'Y').to_euler()
        cam.data.lens = lens

    def shoot(path):
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)

    return scene, cam, look, shoot
