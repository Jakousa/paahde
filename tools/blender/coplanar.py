"""Pull apart coplanar, overlapping faces that face the same way, so they don't z-fight in game.

The generators build pieces from flush boxes (a crate's rim band level with its lid, a bracket flush with a
plank), and two faces sharing a plane flicker in squares and stripes as the camera moves. For each such
pair the smaller face (the trim, the label) is pushed out along its normal by GAP, which moves its
vertices and so stretches its own box a hair. Faces back to back (opposite normals) are hidden anyway and
left alone.

    from coplanar import separate_coplanar
    separate_coplanar(bm)  # before bm.to_mesh()
"""

from collections import defaultdict

from mathutils import Vector

GAP = 0.0015  # metres: resolves in the depth buffer across the hall, small enough not to show
PLANE_EPS = 0.001  # faces nearer than this fight too, at a distance
MIN_OVERLAP = 1e-6  # m^2


def _area(poly):
    return 0.5 * sum(poly[i - 1][0] * poly[i][1] - poly[i][0] * poly[i - 1][1] for i in range(len(poly)))


def _clip(poly, a, b):
    """The part of convex `poly` left of the edge a->b (Sutherland-Hodgman, one edge)."""
    out = []
    side = lambda p: (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])  # noqa: E731
    for i in range(len(poly)):
        p, q = poly[i - 1], poly[i]
        sp, sq = side(p), side(q)
        if (sp >= 0) != (sq >= 0):
            t = sp / (sp - sq)
            out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
        if sq >= 0:
            out.append(q)
    return out


def _overlap(fa, fb, n):
    u = n.orthogonal().normalized()
    w = n.cross(u)
    pa = [(v.co.dot(u), v.co.dot(w)) for v in fa.verts]
    pb = [(v.co.dot(u), v.co.dot(w)) for v in fb.verts]
    if _area(pa) < 0:
        pa.reverse()
    if _area(pb) < 0:
        pb.reverse()
    poly = pa
    for i in range(len(pb)):
        if len(poly) < 3:
            return 0.0
        poly = _clip(poly, pb[i - 1], pb[i])
    return abs(_area(poly)) if len(poly) >= 3 else 0.0


def separate_coplanar(bm, passes=8):
    """Returns how many faces were pushed. Repeats until no pair is left (a push can land on a new plane)."""
    pushed = 0
    for _ in range(passes):
        bm.normal_update()
        bm.faces.index_update()
        planes = defaultdict(list)
        for f in bm.faces:
            if f.calc_area() < 1e-6:
                continue
            n = f.normal
            d = n.dot(f.calc_center_median())
            planes[(round(n.x, 2), round(n.y, 2), round(n.z, 2), round(d / PLANE_EPS))].append((f, d))
        small = set()
        for (nx, ny, nz, k), fs in planes.items():
            near = fs + planes.get((nx, ny, nz, k + 1), [])  # a plane can straddle two buckets
            same = {f for f, _ in fs}
            for fa, da in fs:
                for fb, db in near:
                    if fb.index <= fa.index and fb in same:
                        continue
                    if abs(da - db) > PLANE_EPS or fa.normal.dot(fb.normal) < 0.9999:
                        continue
                    if _overlap(fa, fb, fa.normal) < MIN_OVERLAP:
                        continue
                    small.add(min((fa, fb), key=lambda f: (f.calc_area(), f.index)))
        if not small:
            break
        # A vertex on two pushed faces (a box's lid and side) moves out along both, but only once per
        # direction, so neighbouring pushed faces on one plane stay flat.
        moves = defaultdict(dict)
        for f in sorted(small, key=lambda f: f.index):  # fixed order keeps the output byte-identical
            for v in f.verts:
                moves[v].setdefault(tuple(round(c, 3) for c in f.normal), f.normal.copy())
        for v, ns in moves.items():
            v.co += sum(ns.values(), Vector()) * GAP
        pushed += len(small)
    bm.normal_update()
    return pushed
