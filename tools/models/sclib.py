# Shared helpers for the procedural model generators (run inside Blender 5.x, headless).
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/models/scavenger.py
#
# Conventions: Blender Z-up, metres, characters face -Y (Blender "front"). The glTF exporter converts
# to three.js Y-up, so -Y here becomes +Z in three.js. All meshes are built in world space with identity
# object transforms so object coordinates == world coordinates (procedural textures rely on this).
import math
import random

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector, noise

V = Vector


# ----------------------------------------------------------------------------------------------- scene

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for c in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.actions):
        for d in list(c):
            c.remove(d)


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def select_only(objs, active=None):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or objs[0]


# ----------------------------------------------------------------------------------------- mesh build

class MeshBuilder:
    """Accumulates verts/faces with per-corner UVs (in metres, 'Detail' map) and builds an object."""

    def __init__(self):
        self.verts = []
        self.faces = []  # (indices tuple, uvs tuple, material index)

    def add_vert(self, co):
        self.verts.append(V(co))
        return len(self.verts) - 1

    def add_face(self, idx, uvs=None, mat=0):
        if uvs is None:
            uvs = [(0, 0)] * len(idx)
        self.faces.append((tuple(idx), tuple(uvs), mat))

    def build(self, name, materials, smooth=True, auto_smooth=None):
        me = bpy.data.meshes.new(name)
        bm = bmesh.new()
        bv = [bm.verts.new(c) for c in self.verts]
        bm.verts.ensure_lookup_table()
        uvl = bm.loops.layers.uv.new('Detail')
        for idx, uvs, mi in self.faces:
            try:
                f = bm.faces.new([bv[i] for i in idx])
            except ValueError:
                continue  # duplicate face
            f.material_index = mi
            f.smooth = smooth
            for loop, uv in zip(f.loops, uvs):
                loop[uvl].uv = uv
        bm.normal_update()
        bm.to_mesh(me)
        bm.free()
        obj = bpy.data.objects.new(name, me)
        for m in materials:
            me.materials.append(m)
        link(obj)
        if auto_smooth is not None:
            # sharp edges above angle (flat-shaded hard surface where it matters)
            for e in me.edges:
                pass
            me.shade_smooth_by_angle(angle=math.radians(auto_smooth)) if hasattr(me, 'shade_smooth_by_angle') else None
        return obj


def loft(name, rings, mat, closed=True, cap_start=False, cap_end=False, smooth=True, mb=None, mi=0,
         flip=False, uv_scale=1.0):
    """Skin a list of rings (each a list of Vectors, equal length). UV u = arc length around the ring,
    v = distance along the loft, both in metres. Returns the object (or adds to `mb` when given)."""
    own = mb is None
    if own:
        mb = MeshBuilder()
    n = len(rings[0])
    base = len(mb.verts)
    for r in rings:
        for p in r:
            mb.add_vert(p)
    # u coordinates per ring (arc length), v by centroid distance
    us = []
    for r in rings:
        u = [0.0]
        cnt = n if closed else n - 1
        for j in range(cnt):
            u.append(u[-1] + (r[(j + 1) % n] - r[j]).length)
        us.append(u)
    vs = [0.0]
    cents = [sum(r, V()) / n for r in rings]
    for i in range(1, len(rings)):
        # mean point distance is more robust than centroid distance for open/flat rings
        d = sum((rings[i][j] - rings[i - 1][j]).length for j in range(n)) / n
        vs.append(vs[-1] + max(d, 1e-5))
    cols = n if closed else n - 1
    for i in range(len(rings) - 1):
        for j in range(cols):
            j1 = (j + 1) % n
            a, b, c, d = base + i * n + j, base + i * n + j1, base + (i + 1) * n + j1, base + (i + 1) * n + j
            ua, ub = us[i][j], us[i][j + 1]
            uc, ud = us[i + 1][j + 1], us[i + 1][j]
            uv = [(ua * uv_scale, vs[i] * uv_scale), (ub * uv_scale, vs[i] * uv_scale),
                  (uc * uv_scale, vs[i + 1] * uv_scale), (ud * uv_scale, vs[i + 1] * uv_scale)]
            idx = [a, b, c, d]
            if flip:
                idx.reverse()
                uv.reverse()
            mb.add_face(idx, uv, mi)
    if closed:
        for which, do in ((0, cap_start), (len(rings) - 1, cap_end)):
            if not do:
                continue
            c = cents[which]
            ci = mb.add_vert(c)
            off = base + which * n
            rr = rings[which]
            nrm = V()
            for j in range(n):  # Newell normal → planar basis for the cap UVs
                a_, b_ = rr[j] - c, rr[(j + 1) % n] - c
                nrm += a_.cross(b_)
            if nrm.length < 1e-9:
                nrm = V((0, 0, 1))
            fr = frame_from(nrm)
            ex, ey = fr.col[0], fr.col[1]

            def puv(p):
                d = p - c
                return (d.dot(ex) + 5, d.dot(ey) + 5)

            for j in range(n):
                j1 = (j + 1) % n
                p0, p1 = rr[j], rr[j1]
                uv = [puv(p0), puv(p1), (5, 5)]
                idx = [off + j, off + j1, ci]
                rev = (which == 0) != flip
                if rev:
                    idx.reverse()
                    uv.reverse()
                mb.add_face(idx, uv, mi)
    if own:
        return mb.build(name, [mat] if not isinstance(mat, list) else mat, smooth)
    return None


def frame_from(z_axis, x_hint=V((1, 0, 0))):
    """Orthonormal frame (3x3 matrix with columns x, y, z) whose z column is `z_axis`."""
    z = V(z_axis).normalized()
    x = V(x_hint) - z * V(x_hint).dot(z)
    if x.length < 1e-4:
        x = V((0, 1, 0)) - z * z.y
    x.normalize()
    y = z.cross(x)
    return Matrix((x, y, z)).transposed()


def ring(center, rx, ry, n=16, frame=None, fn=None, a0=0.0, a1=None, closed=True):
    """Ellipse ring. `fn(theta, i)` -> radius multiplier (folds/noise). For open arcs pass a0/a1."""
    frame = frame or Matrix.Identity(3)
    pts = []
    if a1 is None:
        a1 = a0 + 2 * math.pi
    cnt = n if closed else n
    for i in range(cnt):
        t = a0 + (a1 - a0) * (i / n if closed else i / (n - 1))
        m = fn(t, i) if fn else 1.0
        pts.append(V(center) + frame @ V((math.cos(t) * rx * m, math.sin(t) * ry * m, 0)))
    return pts


def path_frames(path, up=V((0, 0, 1)), closed=False):
    """Parallel-transport frames along a polyline. Returns list of (tangent, normal, binormal)."""
    n = len(path)
    tans = []
    for i in range(n):
        if closed:
            t = path[(i + 1) % n] - path[i - 1]
        elif i == 0:
            t = path[1] - path[0]
        elif i == n - 1:
            t = path[-1] - path[-2]
        else:
            t = path[i + 1] - path[i - 1]
        tans.append(t.normalized())
    frames = []
    nrm = V(up) - tans[0] * V(up).dot(tans[0])
    if nrm.length < 1e-4:
        nrm = V((1, 0, 0)) - tans[0] * tans[0].x
    nrm.normalize()
    for i in range(n):
        if i > 0:
            q = tans[i - 1].rotation_difference(tans[i])
            nrm = q @ nrm
            nrm = (nrm - tans[i] * nrm.dot(tans[i])).normalized()
        frames.append((tans[i], nrm, tans[i].cross(nrm)))
    return frames


def sweep(name, path, profile, mat, closed_path=False, closed_profile=True, up=V((0, 0, 1)),
          scale_fn=None, twist_fn=None, cap=True, mb=None, mi=0, up_fn=None):
    """Sweep a 2D profile (list of (x, y) in the normal/binormal plane) along a 3D polyline.
    scale_fn(i, t) -> (sx, sy); twist_fn(i, t) -> radians; up_fn(i) -> per-point up vector (no transport)."""
    frames = path_frames(path, up, closed_path)
    rings = []
    n = len(path)
    for i, (p, (t, nr, bn)) in enumerate(zip(path, frames)):
        if up_fn is not None:
            u = up_fn(i)
            nr = (u - t * u.dot(t)).normalized()
            bn = t.cross(nr)
        f = i / max(1, n - 1)
        sx, sy = scale_fn(i, f) if scale_fn else (1, 1)
        tw = twist_fn(i, f) if twist_fn else 0.0
        c, s = math.cos(tw), math.sin(tw)
        r = []
        for (x, y) in profile:
            x2, y2 = (x * c - y * s) * sx, (x * s + y * c) * sy
            r.append(p + nr * x2 + bn * y2)
        rings.append(r)
    if closed_path:
        rings.append(rings[0])
    return loft(name, rings, mat, closed=closed_profile, cap_start=cap and not closed_path,
                cap_end=cap and not closed_path, mb=mb, mi=mi)


def circle_profile(r, n=8, ry=None):
    ry = r if ry is None else ry
    return [(math.cos(2 * math.pi * i / n) * r, math.sin(2 * math.pi * i / n) * ry) for i in range(n)]


def rect_profile(w, h, bevel=0.0):
    w2, h2 = w / 2, h / 2
    if bevel <= 0:
        return [(-w2, -h2), (w2, -h2), (w2, h2), (-w2, h2)]
    b = bevel
    return [(-w2 + b, -h2), (w2 - b, -h2), (w2, -h2 + b), (w2, h2 - b), (w2 - b, h2), (-w2 + b, h2),
            (-w2, h2 - b), (-w2, -h2 + b)]


def catmull(points, per_seg=4, closed=False):
    """Catmull-Rom resample of control points."""
    pts = [V(p) for p in points]
    out = []
    n = len(pts)
    segs = n if closed else n - 1
    for i in range(segs):
        p0 = pts[(i - 1) % n] if (closed or i > 0) else pts[0] * 2 - pts[1]
        p1 = pts[i]
        p2 = pts[(i + 1) % n]
        p3 = pts[(i + 2) % n] if (closed or i + 2 < n) else pts[-1] * 2 - pts[-2]
        for k in range(per_seg):
            t = k / per_seg
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
                              (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    if not closed:
        out.append(pts[-1])
    return out


def rounded_box(name, center, size, mat, bevel=0.01, segments=2, rot=None, mb_obj=True):
    """Bevelled box with box-projected Detail UVs (metres). rot: Matrix 3x3 or Euler."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = V((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=segments, profile=0.5,
                        affect='EDGES', clamp_overlap=True)
    R = rot.to_matrix() if hasattr(rot, 'to_matrix') else (rot or Matrix.Identity(3))
    for v in bm.verts:
        v.co = V(center) + R @ v.co
    bm.normal_update()
    uvl = bm.loops.layers.uv.new('Detail')
    for f in bm.faces:
        n = R.transposed() @ f.normal
        ax = max(range(3), key=lambda k: abs(n[k]))
        for l in f.loops:
            lc = R.transposed() @ (l.vert.co - V(center))
            u, w = [(1, 2), (0, 2), (0, 1)][ax]
            l[uvl].uv = (lc[u] + 3, lc[w] + 3)
        f.smooth = True
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    me.materials.append(mat)
    link(obj)
    return obj


def cylinder(name, a, b, r, mat, n=12, r2=None, cap=True, rings_extra=None):
    """Cylinder from a to b (radius r → r2). rings_extra: list of (t, radius_mult) for ribs/bevels."""
    a, b = V(a), V(b)
    fr = frame_from(b - a)
    r2 = r if r2 is None else r2
    ts = [(0.0, 1.0), (1.0, 1.0)]
    if rings_extra:
        ts = sorted([(0.0, 1.0)] + list(rings_extra) + [(1.0, 1.0)])
    rings = [ring(a.lerp(b, t), (r + (r2 - r) * t) * m, (r + (r2 - r) * t) * m, n, fr) for t, m in ts]
    return loft(name, rings, mat, cap_start=cap, cap_end=cap)


def displace(obj, fn):
    for v in obj.data.vertices:
        v.co = fn(v.co.copy())


def join(objs, name=None):
    objs = [o for o in objs if o is not None]
    select_only(objs, objs[0])
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    if name:
        o.name = name
        o.data.name = name
    return o


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def fbm(p, octaves=3):
    return noise.fractal(V(p), 0.5, 2.0, octaves, noise_basis='PERLIN_NEW')


# ----------------------------------------------------------------------------------- shader node DSL

class NB:
    """Tiny helper for building node trees."""

    def __init__(self, mat):
        mat.use_nodes = True
        self.mat = mat
        self.nt = mat.node_tree
        self.nt.nodes.clear()
        self.x = 0

    def n(self, kind, **props):
        node = self.nt.nodes.new(kind)
        node.location = (self.x, 0)
        self.x += 30
        for k, v in props.items():
            setattr(node, k, v)
        return node

    def put(self, sock_in, value):
        if value is None:
            return
        if hasattr(value, 'is_output'):
            self.nt.links.new(value, sock_in)
        else:
            if isinstance(value, (tuple, list)) and len(sock_in.default_value) == 4 and len(value) == 3:
                value = (*value, 1.0)
            sock_in.default_value = value

    @staticmethod
    def sock(node, ident, out=False):
        for s in (node.outputs if out else node.inputs):
            if s.identifier == ident or s.name == ident:
                if s.enabled or True:
                    return s
        raise KeyError(ident)

    # coordinates
    def obj(self):
        return self.n('ShaderNodeTexCoord').outputs['Object']

    def uv(self, name='Detail'):
        return self.n('ShaderNodeUVMap', uv_map=name).outputs['UV']

    def mapping(self, vec, scale=(1, 1, 1), loc=(0, 0, 0), rot=(0, 0, 0)):
        m = self.n('ShaderNodeMapping')
        self.put(m.inputs['Vector'], vec)
        m.inputs['Scale'].default_value = scale
        m.inputs['Location'].default_value = loc
        m.inputs['Rotation'].default_value = rot
        return m.outputs['Vector']

    def geo(self, out):
        return self.n('ShaderNodeNewGeometry').outputs[out]

    def sep(self, vec):
        s = self.n('ShaderNodeSeparateXYZ')
        self.put(s.inputs[0], vec)
        return s.outputs

    # textures
    def noise(self, vec=None, scale=5.0, detail=4.0, rough=0.5, distortion=0.0, out='Fac', dims='3D', w=0.0):
        t = self.n('ShaderNodeTexNoise', noise_dimensions=dims)
        self.put(t.inputs['Vector'], vec)
        t.inputs['Scale'].default_value = scale
        t.inputs['Detail'].default_value = detail
        t.inputs['Roughness'].default_value = rough
        t.inputs['Distortion'].default_value = distortion
        if dims == '4D':
            t.inputs['W'].default_value = w
        return t.outputs[out]

    def voronoi(self, vec=None, scale=5.0, feature='F1', out='Distance', rand=1.0):
        t = self.n('ShaderNodeTexVoronoi', feature=feature)
        self.put(t.inputs['Vector'], vec)
        t.inputs['Scale'].default_value = scale
        t.inputs['Randomness'].default_value = rand
        return t.outputs[out]

    def wave(self, vec=None, scale=5.0, direction='X', distortion=0.0, detail=2.0, profile='SIN', kind='BANDS'):
        t = self.n('ShaderNodeTexWave', wave_type=kind, wave_profile=profile)
        if kind == 'BANDS':
            t.bands_direction = direction
        else:
            t.rings_direction = direction
        self.put(t.inputs['Vector'], vec)
        t.inputs['Scale'].default_value = scale
        t.inputs['Distortion'].default_value = distortion
        t.inputs['Detail'].default_value = detail
        return t.outputs['Fac']

    def ao(self, distance=0.05, samples=8, inside=False):
        a = self.n('ShaderNodeAmbientOcclusion', samples=samples, inside=inside)
        a.inputs['Distance'].default_value = distance
        return a.outputs['AO']

    # math
    def math(self, op, a, b=0.0, clamp=False):
        m = self.n('ShaderNodeMath', operation=op, use_clamp=clamp)
        self.put(m.inputs[0], a)
        self.put(m.inputs[1], b)
        return m.outputs[0]

    def mr(self, v, fmin, fmax, tmin=0.0, tmax=1.0, clamp=True, smooth=False):
        m = self.n('ShaderNodeMapRange', clamp=clamp, interpolation_type='SMOOTHSTEP' if smooth else 'LINEAR')
        self.put(m.inputs['Value'], v)
        m.inputs['From Min'].default_value = fmin
        m.inputs['From Max'].default_value = fmax
        m.inputs['To Min'].default_value = tmin
        m.inputs['To Max'].default_value = tmax
        return m.outputs['Result']

    def mix(self, fac, a, b, blend='MIX', clamp=True):
        m = self.n('ShaderNodeMix', data_type='RGBA', blend_type=blend, clamp_result=clamp)
        self.put(self.sock(m, 'Factor_Float'), fac)
        self.put(self.sock(m, 'A_Color'), a)
        self.put(self.sock(m, 'B_Color'), b)
        return self.sock(m, 'Result_Color', out=True)

    def mixf(self, fac, a, b):
        m = self.n('ShaderNodeMix', data_type='FLOAT')
        self.put(self.sock(m, 'Factor_Float'), fac)
        self.put(self.sock(m, 'A_Float'), a)
        self.put(self.sock(m, 'B_Float'), b)
        return self.sock(m, 'Result_Float', out=True)

    def add(self, *vals):
        acc = vals[0]
        for v in vals[1:]:
            acc = self.math('ADD', acc, v)
        return acc

    def mul(self, a, b):
        return self.math('MULTIPLY', a, b)

    def bump(self, height, strength=0.3, distance=0.01, normal=None):
        b = self.n('ShaderNodeBump')
        self.put(b.inputs['Height'], height)
        b.inputs['Strength'].default_value = strength
        b.inputs['Distance'].default_value = distance
        self.put(b.inputs['Normal'], normal)
        return b.outputs['Normal']

    def principled(self, color, rough, metal=0.0, normal=None, emission=None, emission_strength=0.0):
        p = self.n('ShaderNodeBsdfPrincipled')
        self.put(p.inputs['Base Color'], color)
        self.put(p.inputs['Roughness'], rough)
        self.put(p.inputs['Metallic'], metal)
        self.put(p.inputs['Normal'], normal)
        if emission is not None:
            self.put(p.inputs['Emission Color'], emission)
            p.inputs['Emission Strength'].default_value = emission_strength
        out = self.n('ShaderNodeOutputMaterial')
        self.nt.links.new(p.outputs['BSDF'], out.inputs['Surface'])
        return p


def srgb(h):
    """'#rrggbb' -> linear RGB tuple."""
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def new_mat(name):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    return m
