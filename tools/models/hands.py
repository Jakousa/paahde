# First-person viewmodel: gloved hands + wrapped forearm sleeves, same materials as the scavenger.
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/models/hands.py
#
# Output public/models/hands.glb. Parent it to the camera at the origin; it extends along the camera's -Z
# (forward) with the hands ~0.45 m in front, below the eye line. 30 fps clips:
#   Idle (3 s loop), Walk (0.73 s loop, bob), Dig (1.2 s loop)
#   CanteenIdle (3 s loop)  canteen held low-right in the right hand, left arm lowered out of view
#   CanteenWalk (0.73 s loop)  the same hold with the walk bob
#   Drink (1.2 s one-shot)  raise the neck to the mouth, tip it up, two gulps, lower
#   Fill (1.5 s one-shot)   canteen lowered forward and tipped, left palm under it, back
#   TelescopeIdle (3 s loop)  collapsed spyglass in a power grip in the right fist, low right, eyepiece up
#     out of the top of the fist; left arm lowered out of view (the game slides the draw tubes out while
#     raising, see telescope.py)
#   TelescopeWalk (0.73 s loop)  the same hold with the walk bob
#   TelescopeRaise (0.35 s one-shot)  from the TelescopeIdle pose up to the eye (play clamped; ends with
#     the eyepiece ~10 cm ahead of the eye, just past the game's near plane after the viewmodel scale)
# The canteen one-shots start and end on the CanteenIdle pose (frame 0) so they cross-fade cleanly;
# TelescopeRaise starts on the TelescopeIdle frame-0 pose. Fingers are posed by closing them on the held
# object (see "grasping"), so a new prop only needs its placement in the hand and a distance function.
# Mesh nodes `Canteen` (tools/models/canteen.py, own material 'Canteen') and `Telescope`
# (tools/models/telescope.py, own material 'Telescope') are children of the `RightHand` bone, so they
# follow every clip; both are visible by default, the game toggles `.visible`. The script also writes the
# standalone public/models/canteen.glb (origin at the bottom centre, front +Z) and
# public/models/telescope.glb (origin at the grip on the axis, objective -Z, eyepiece +Z).
import math
import os
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scavenger as S  # noqa: E402  (creates materials; the character itself is only built by its main())
from sclib import V, join, tri_count  # noqa: E402

OUT = os.path.join(S.ROOT, 'public', 'models', 'hands.glb')

# Arm layout relative to the eye (origin), built in the character's frame (facing -Y) then turned 180°
# about Z so the viewmodel faces +Y (= -Z in three.js) like the camera.
S.SH_L = V((0.22, 0.06, -0.31))
S.ELB_L = V((0.25, -0.20, -0.27))
S.WR_L = V((0.165, -0.48, -0.195))
S.UPPER_DIR = (S.ELB_L - S.SH_L).normalized()
S.FORE_DIR = (S.WR_L - S.ELB_L).normalized()
S.KNU_L = S.WR_L + S.FORE_DIR * 0.088


def hand_frame(sign):
    a = V((S.FORE_DIR.x * sign, S.FORE_DIR.y, S.FORE_DIR.z))
    pn = V((-0.6 * sign, 0.0, -0.8))  # palms face down and a little inward
    pn = (pn - a * pn.dot(a)).normalized()
    t = a.cross(pn) * -sign  # thumb side (towards the centre line)
    t = (t - a * t.dot(a)).normalized()
    if t.x * sign > 0:
        t = -t
    return a, pn, t


S.hand_frame = hand_frame
S.B.clear()
S.add_side(1, 'Left')
S.add_side(-1, 'Right')
for pre, sign in (('Left', 1), ('Right', -1)):
    h, t, _ = S.B[pre + 'Shoulder']
    S.B[pre + 'Shoulder'] = ((sign * 0.06, 0.12, -0.28), t, 'Root')
    for k in ('UpLeg', 'Leg', 'Foot', 'ToeBase', 'HandIndex1', 'HandIndex2', 'HandThumb1'):
        del S.B[pre + k]
S.B['Root'] = ((0, 0.15, -0.25), (0, 0.15, -0.15), None)
S.B = {'Root': S.B.pop('Root'), **S.B}

# ============================================================================== glove
# The character's glove (scavenger.build_glove) has one shared two-bone finger and a fixed thumb. Seen up
# close that can't hold anything, so the viewmodel gets a real hand skeleton: four fingers with three
# phalanges each (MCP, PIP, DIP joints) and a three-bone thumb (CMC, MCP, IP). Phalanx lengths are the
# Buchholz, Armstrong & Goldstein (1992) fractions of hand length, on a slightly stubby glove.
FINGER_L = 0.165  # "hand length" the fractions are taken of
FINGERS = (  # name, offset towards the thumb, knuckle distance from the wrist, radius, phalanx fractions
    ('Index', 0.029, 0.088, 0.0115, (0.245, 0.143, 0.097)),
    ('Middle', 0.0095, 0.090, 0.0120, (0.266, 0.170, 0.108)),
    ('Ring', -0.0095, 0.086, 0.0115, (0.244, 0.165, 0.107)),
    ('Pinky', -0.028, 0.078, 0.0105, (0.204, 0.117, 0.093)),
)
REST_CURL = (6, 12, 8)  # relaxed flexion modelled into the fingers at MCP, PIP, DIP (deg)
THUMB_R = 0.0125
THUMB_FR = (0.22, 0.196, 0.158)  # metacarpal (its base is buried in the palm), proximal, distal phalanx fractions
CHAINS = {}  # bone prefix -> dict(pts=[joint positions in rest armature space], axes=[flexion axis per joint], r)
PALMS = {}


def flex_chain(base, d, lengths, bends, axis):
    pts = [V(base)]
    for ln, bend in zip(lengths, bends):
        d = Quaternion(axis, math.radians(bend)) @ d
        pts.append(pts[-1] + d * ln)
    return pts


def digit_mesh(name, pts, r, taper):
    """Glove finger along the joint polyline, tapering, with a rounded tip."""
    d = (pts[-1] - pts[-2]).normalized()
    path = S.catmull(pts, 3) + [pts[-1] + d * r * 0.45, pts[-1] + d * r * 0.8]
    n = len(path)

    def scale(i, f):
        k = (1 - taper * min(1.0, i / (n - 3))) * (0.86 if i == n - 2 else 0.45 if i == n - 1 else 1.0)
        return k, k * 0.92  # a touch flatter across the nail

    return S.sweep(name, path, S.circle_profile(r, 8), S.M['leather'], scale_fn=scale)


def build_glove(sign):
    pre = 'Left' if sign > 0 else 'Right'
    W = V((S.WR_L.x * sign, S.WR_L.y, S.WR_L.z))
    a, pn, t = hand_frame(sign)
    fr = Matrix((t, pn, a)).transposed()  # ring x -> thumb side, ring y -> palm side, z -> fingers

    def P(u, v, w):
        return W + t * u + pn * v + a * w

    secs = [(-0.058, 0.049, 0.046, 0.0), (-0.052, 0.050, 0.047, 0.0), (-0.044, 0.044, 0.041, 0.0),
            (-0.01, 0.037, 0.031, 0.0), (0.004, 0.033, 0.024, 0.002), (0.03, 0.041, 0.022, 0.004),
            (0.06, 0.046, 0.019, 0.003), (0.084, 0.046, 0.017, 0.002), (0.097, 0.043, 0.012, 0.0)]
    rings = [S.ring(P(0, off, w), rx, ry, 14, fr, fn=S.superellipse(2.6)) for w, rx, ry, off in secs]
    palm = S.loft('Palm', rings, S.M['leather'], cap_start=True, cap_end=True)
    rv = S.cylinder('Rivet', P(0, -0.047, -0.05), P(0, -0.052, -0.05), 0.006, S.M['brass'], n=8)
    palm = join([palm, rv], pre + 'Glove')
    S.part(palm, bones=[pre + 'ForeArm', pre + 'Hand'], bias={pre + 'Hand': 3.0})
    PALMS[pre] = [v.co.copy() for v in palm.data.vertices]
    k = a.cross(pn).normalized()  # + flexes towards the palm
    for name, u, w, r, frac in FINGERS:
        pts = flex_chain(P(u, 0.002, w), a.copy(), [f * FINGER_L for f in frac], REST_CURL, k)
        bn = pre + 'Hand' + name
        for i in range(3):
            S.B[f'{bn}{i + 1}'] = (tuple(pts[i]), tuple(pts[i + 1]), pre + 'Hand' if i == 0 else f'{bn}{i}')
        CHAINS[bn] = dict(pts=pts, axes=[k] * 3, r=r)
        S.part(digit_mesh(name, pts, r, 0.15), bones=[pre + 'Hand', bn + '1', bn + '2', bn + '3'],
               bias={pre + 'Hand': 0.4})
    # thumb: the metacarpal starts deep in the heel of the hand and leans out of the palm towards the fingers
    d = (t * 0.32 + pn * 0.5 + a * 0.80).normalized()  # relaxed: resting along the side of the index finger
    kt = d.cross(pn - t * 0.6).normalized()
    pts = flex_chain(P(0.022, 0.006, 0.0), d, [f * FINGER_L for f in THUMB_FR], (0, 12, 15), kt)
    bn = pre + 'HandThumb'
    for i in range(3):
        S.B[f'{bn}{i + 1}'] = (tuple(pts[i]), tuple(pts[i + 1]), pre + 'Hand' if i == 0 else f'{bn}{i}')
    CHAINS[bn] = dict(pts=pts, axes=[kt] * 3, r=THUMB_R * 0.85)
    tm = [pts[0].lerp(pts[1], 0.35)] + pts[1:]
    S.part(digit_mesh('Thumb', tm, THUMB_R, 0.22), bones=[pre + 'Hand', bn + '1', bn + '2', bn + '3'],
           bias={pre + 'Hand': 0.6})


for s in (1, -1):
    S.build_sleeve(s)
    build_glove(s)
for obj, spec in S.PARTS:
    S.apply_weights(obj, spec)
body = join([o for o, _ in S.PARTS], 'Hands_Body')
print('TRIS', tri_count(body))
rig = S.make_rig([body], name='Hands', bones=S.B)
rig.rotation_euler = (0, 0, math.pi)

X, Y, Z = S.X, S.Y, S.Z
rot = S.rot


FINGER_NAMES = [f[0] for f in FINGERS]


def curl(pose, pre, c, thumb=0.0):
    """Relaxed curl of the four fingers, about `c` degrees at each joint: the middle joint flexes most and
    the end joint follows it at about 2/3 (the PIP-DIP coupling of tendon-driven fingers, as in Rijpkema &
    Girard 1991). `thumb` tucks the thumb in towards the palm."""
    for name in FINGER_NAMES:
        bn = pre + 'Hand' + name
        k = CHAINS[bn]['axes'][0]
        for i, f in enumerate((0.9, 1.1, 0.73)):
            pose[f'{bn}{i + 1}'] = Quaternion(k, math.radians(c * f))
    if thumb:
        k = CHAINS[pre + 'HandThumb']['axes'][0]
        for i, f in enumerate((0.5, 0.8, 1.0)):
            pose[f'{pre}HandThumb{i + 1}'] = Quaternion(k, math.radians(thumb * f))


def fingers(pose, c):
    for pre in ('Left', 'Right'):
        curl(pose, pre, c, thumb=c * 1.2)


def idle(p):
    w = 2 * math.pi * p
    b = math.sin(w)
    pose = {'Root': rot((X, 0.8 * b), (Z, 0.5 * math.sin(w + 1)))}
    pose['LeftForeArm'] = rot((X, -2 * b))
    pose['RightForeArm'] = rot((X, -2 * math.sin(w + 0.5)))
    fingers(pose, 12 + 3 * b)
    return pose, (0, 0, 0)


def walk(p):
    w = 2 * math.pi * p
    pose = {'Root': rot((X, 2.5 * math.sin(2 * w)), (Y, 2.0 * math.sin(w)))}
    pose['LeftArm'] = rot((X, 3 * math.sin(w)))
    pose['RightArm'] = rot((X, -3 * math.sin(w)))
    fingers(pose, 14)
    return pose, (0, 0, 0)


def dig(p):
    # alternating scoops: reach forward-down, claw, pull back and up
    w = 2 * math.pi * p
    pose = {'Root': rot((X, 6 + 3 * math.sin(2 * w)))}
    for pre, sign, ph in (('Left', 1, 0.0), ('Right', -1, math.pi)):
        r = 0.5 + 0.5 * math.sin(w + ph)  # 1 = reached out
        pose[pre + 'Arm'] = rot((X, 30 * r - 10), (Z, -sign * 8 * r))
        pose[pre + 'ForeArm'] = rot((X, 25 * r - 15))
        pose[pre + 'Hand'] = rot((X, 30 - 40 * r))
        curl(pose, pre, 10 + 50 * (1 - r), thumb=10 + 20 * (1 - r))
    return pose, (0, 0, 0)


for name, frames, fn in (('Idle', 90, idle), ('Walk', 22, walk), ('Dig', 36, dig)):
    S.clip(name, frames, fn)

# ============================================================================== canteen clips
# Posed by placing the canteen (and the left palm) in view space and solving each arm with analytic
# two-bone IK. View space = the viewmodel's space in Blender: eye at the origin, +Y forward, +Z up,
# +X right. Rig space is that turned 180° about Z. Pose deltas are armature-space rotations relative to
# the parent's (see scavenger.key_pose), so the IK result is converted with q = D_parent⁻¹ · D_bone.
import canteen as CT  # noqa: E402

bpy.context.view_layer.update()
MW = rig.matrix_world.copy()
MWi = MW.inverted()
BONES = rig.data.bones
CAN_MID = 0.085  # grip height on the canteen body (from its bottom)
GRIP = (0.034, 0.086, 0.0)  # canteen grip centre from the wrist: along the fingers, off the palm, to the thumb


def frame_cols(a, b, c):
    return Matrix((a, b, c)).transposed()


def canteen_in_hand():
    """Canteen matrix relative to the RightHand bone (head origin), held like a flask: palm against its
    right edge, fingers reaching back and curling round the back face, thumb up by the shoulder."""
    a, pn, t = hand_frame(-1)
    W = V(S.B['RightHand'][0])
    xc, yc = -pn, a  # width axis (palm on the +X edge), thickness axis (fingers towards the back)
    zc = xc.cross(yc)
    print('GRIP neck·thumb', round(zc.dot(t), 3))
    centre = W + a * GRIP[0] + pn * GRIP[1] + t * GRIP[2]
    m = frame_cols(xc, yc, zc).to_4x4()
    m.translation = centre - zc * CAN_MID
    return BONES['RightHand'].matrix_local.inverted() @ m


C_HAND = canteen_in_hand()


def view_canteen(centre, yaw=0.0, tilt=0.0, roll=0.0, pitch=0.0):
    """Canteen world matrix from its grip centre: roll about its thickness axis, yaw about Z (0 = front
    faces the eye), tilt about world X (+ = neck towards the eye), pitch about world Y (+ = top right)."""
    r = (Matrix.Rotation(math.radians(pitch), 4, 'Y') @ Matrix.Rotation(math.radians(tilt), 4, 'X') @
         Matrix.Rotation(math.radians(yaw), 4, 'Z') @ Matrix.Rotation(math.radians(roll), 4, 'Y'))
    return Matrix.Translation(V(centre)) @ r @ Matrix.Translation((0, 0, -CAN_MID))


def twist_angle(q, axis):
    d = V((q.x, q.y, q.z)).dot(axis)
    a = 2 * math.atan2(d, q.w)
    return (a + math.pi) % (2 * math.pi) - math.pi


ELBOW = {}  # last solved elbow per arm (view space)


def solve_arm(pre, hand_world, pole_world, twist=0.75):
    """Pose deltas for <pre>Arm/ForeArm/Hand so the hand bone ends at `hand_world` (view space, head
    origin). The elbow bends towards `pole_world`; `twist` of the roll about the forearm goes to the forearm
    (the rest stays in the wrist), so the glove cuff doesn't candy-wrap."""
    Hr = MWi @ hand_world
    sh, el, wr = V(S.B[pre + 'Arm'][0]), V(S.B[pre + 'ForeArm'][0]), V(S.B[pre + 'Hand'][0])
    l1, l2 = (el - sh).length, (wr - el).length
    dv = Hr.translation - sh
    if dv.length > (l1 + l2) * 0.999:
        print('WARN out of reach', pre, round(dv.length, 3), round(l1 + l2, 3))
    d = min(dv.length, (l1 + l2) * 0.999)
    dv.normalize()
    a1 = (l1 * l1 + d * d - l2 * l2) / (2 * d)
    h = math.sqrt(max(0.0, l1 * l1 - a1 * a1))
    pole = MWi @ V(pole_world) - sh
    perp = (pole - dv * pole.dot(dv)).normalized()
    e2 = sh + dv * a1 + perp * h
    w2 = sh + dv * d
    ELBOW[pre] = MW @ e2
    d_arm = (el - sh).rotation_difference(e2 - sh)
    d_fore = (d_arm @ (wr - el)).rotation_difference(w2 - e2) @ d_arm
    d_hand = Hr.to_quaternion() @ BONES[pre + 'Hand'].matrix_local.to_quaternion().inverted()
    ax = (wr - el).normalized()
    d_fore = d_fore @ Quaternion(ax, twist_angle(d_fore.inverted() @ d_hand, ax) * twist)
    return {pre + 'Arm': d_arm, pre + 'ForeArm': d_arm.inverted() @ d_fore, pre + 'Hand': d_fore.inverted() @ d_hand}


def left_hand_world(palm, fingers, palm_normal):
    """Left hand bone matrix (view space) from the palm centre, the finger direction and the way the palm
    faces."""
    a0, pn0, t0 = hand_frame(1)
    k = 1 if t0.dot(a0.cross(pn0)) > 0 else -1
    a = V(fingers).normalized()
    pn = (V(palm_normal) - a * V(palm_normal).dot(a)).normalized()
    m3 = MW.to_3x3()
    rest = frame_cols(m3 @ a0, m3 @ pn0, m3 @ (a0.cross(pn0) * k))
    want = frame_cols(a, pn, a.cross(pn) * k)
    r3 = want @ rest.inverted()
    m = r3.to_4x4() @ MW @ BONES['LeftHand'].matrix_local
    m.translation = V(palm) - r3 @ m3 @ (a0 * 0.045 + pn0 * 0.028)  # palm centre relative to the wrist
    return m


def lerp(a, b, f):
    return [x + (y - x) * f for x, y in zip(a, b)]


def keys(track, p):
    """Smooth (Catmull-Rom / Hermite) interpolation of parameter tuples through track = [(p, values), ...],
    starting and ending at rest so one-shots blend cleanly with the hold pose."""
    n = len(track)

    def tangent(i):
        if i == 0 or i == n - 1:
            return [0.0] * len(track[i][1])
        (pa, va), (pb, vb) = track[i - 1], track[i + 1]
        return [(b - a) / (pb - pa) for a, b in zip(va, vb)]

    for i in range(n - 1):
        (p0, v0), (p1, v1) = track[i], track[i + 1]
        if p <= p1:
            h = p1 - p0
            u = max(0.0, min(1.0, (p - p0) / h))
            h00, h10, h01, h11 = 2 * u ** 3 - 3 * u ** 2 + 1, u ** 3 - 2 * u ** 2 + u, -2 * u ** 3 + 3 * u ** 2, u ** 3 - u ** 2
            return [h00 * a + h10 * h * ma + h01 * b + h11 * h * mb
                    for a, b, ma, mb in zip(v0, v1, tangent(i), tangent(i + 1))]
    return list(track[-1][1])


# ============================================================================== grasping
# A held object is a signed distance function in rest armature space (the hand at rest). Each digit closes
# on it like GraspIt!'s auto-grasp (Miller & Allen 2004): all joints of a chain flex together, a phalanx
# that touches stops the joints proximal to it, and the joints past it keep closing until their own
# phalanges touch or reach the joint limits. Fingers close first; the thumb then closes over the object
# and the fingers. The result is the per-joint deltas for key_pose, the same in every pose of the clip.
FLEX_MAX = (90, 105, 75)  # finger MCP, PIP, DIP range (deg)
THUMB_MAX = (30, 55, 70)  # thumb CMC, MCP, IP
SQUISH = 0.75  # how far the glove leather may press in (fraction of the digit radius kept)


def chain_fk(pts, axes, angles):
    pts, axes = [V(q) for q in pts], [V(k) for k in axes]
    for i, ang in enumerate(angles):
        r = Matrix.Rotation(math.radians(ang), 3, axes[i])
        for j in range(i + 1, len(pts)):
            pts[j] = pts[i] + r @ (pts[j] - pts[i])
        for j in range(i + 1, len(axes)):
            axes[j] = r @ axes[j]
    return pts


def capsule_sdf(a, b, r):
    return lambda p: S.seg_dist(p, a, b) - r


def close_chain(ch, sdf, limits, rates, axis=None, links=(0, 1, 2)):
    """Joint angles (deg) that close chain `ch` on `sdf` (one function, or one per phalanx, None = passes
    through); only phalanges in `links` collide. A digit that starts inside the object is first opened
    (its base joint swung back) until it is clear."""
    axes = [axis] * 3 if axis else ch['axes']
    ang, live = [0.0] * 3, [True] * 3
    clear = ch['r'] * SQUISH
    sdfs = sdf if isinstance(sdf, (list, tuple)) else [sdf] * 3

    def touching(pts):
        return [i in links and sdfs[i] is not None and
                min(sdfs[i](pts[i].lerp(pts[i + 1], f)) for f in (0.15, 0.4, 0.65, 0.9, 1.0)) < clear
                for i in range(3)]

    while any(touching(chain_fk(ch['pts'], axes, ang))) and ang[0] > -60:
        ang[0] -= 1
    for _ in range(800):
        if not any(live):
            break
        prev = ang[:]
        for i in range(3):
            if live[i]:
                ang[i] = min(limits[i], ang[i] + rates[i] * 0.5)
                live[i] = ang[i] < limits[i]
        for i, hit in enumerate(touching(chain_fk(ch['pts'], axes, ang))):
            if hit:
                for j in range(i + 1):
                    ang[j], live[j] = prev[j], False
    return ang, axes, chain_fk(ch['pts'], axes, ang)


def grasp(pre, sdf, wrap=None):
    """Close the hand on `sdf`; returns the pose deltas of the finger and thumb bones. With `wrap` (the
    axis of a held cylinder) the thumb opposes: its metacarpal swings across the barrel and the thumb
    curls round it over the fingers, as in a fist; otherwise it just closes onto the object's side."""
    pose, caps = {}, []
    for name in FINGER_NAMES:
        bn = pre + 'Hand' + name
        ang, axes, pts = close_chain(CHAINS[bn], sdf, FLEX_MAX, (1.0, 1.1, 0.75))
        print('GRASP', name, [round(x) for x in ang])
        for i in range(3):
            pose[f'{bn}{i + 1}'] = Quaternion(axes[i], math.radians(ang[i]))
            caps.append(capsule_sdf(pts[i], pts[i + 1], CHAINS[bn]['r']))
    th = CHAINS[pre + 'HandThumb']
    both = lambda p: min(sdf(p), *(c(p) for c in caps))  # noqa: E731
    p0, tip, e = th['pts'][0], th['pts'][-1], 1e-4
    grad = V([(sdf(tip + V(d) * e) - sdf(tip - V(d) * e)) for d in ((e, 0, 0), (0, e, 0), (0, 0, e))])
    d0 = (th['pts'][1] - p0).normalized()
    if wrap is None:  # rests against the object's side, relaxed
        ang, axes, opp = [0.0, 10.0, 15.0], th['axes'], Quaternion()
    else:
        u = V(wrap).normalized()
        a, pn, t = hand_frame(1 if pre == 'Left' else -1)
        to = (t * 0.55 + pn * 0.45 + a * 0.70).normalized()  # abducted out of the palm, then square to the barrel
        opp = d0.rotation_difference((to - u * to.dot(u) * 0.9).normalized())
        ch = dict(pts=[p0] + [p0 + opp @ (q - p0) for q in th['pts'][1:]], r=th['r'])
        k = u if u.dot(d0.cross(-grad)) > 0 else -u  # + curls the tip in over the fingers
        # the proximal phalanx rides on the barrel, the distal one comes down on the fingers
        ang, axes, _ = close_chain(ch, [None, sdf, both], (0,) + THUMB_MAX[1:], (0, 1.0, 0.9), axis=k)
        axes = [opp.inverted() @ k] * 3
    print('GRASP Thumb', [round(x) for x in ang], 'opposed', round(math.degrees(opp.angle)))
    for i in range(3):
        pose[f'{pre}HandThumb{i + 1}'] = Quaternion(axes[i], math.radians(ang[i])) @ (opp if i == 0 else Quaternion())
    return pose


def cylinder_sdf(c, u, r):
    def f(p):
        d = p - c
        return (d - u * d.dot(u)).length - r
    return f


# canteen poses: (grip centre x, y, z, yaw, tilt, roll, pitch)
HOLD = (0.18, 0.40, -0.19, -28, 0, 0, -6)
R_POLE = (0.7, -0.05, -0.35)
L_LOW = ((-0.20, 0.22, -0.62), (0.15, 0.6, -0.5), (0.6, 0.0, 0.1))  # palm, fingers, palm normal: out of view
L_POLE = (-0.7, -0.05, -0.35)


def canteen_sdf():
    """The canteen body (an elliptic flask, canteen.py RX/RY) in rest armature space."""
    inv = (BONES['RightHand'].matrix_local @ C_HAND).inverted()

    def f(p):
        q = inv @ p
        e = math.hypot(q.x / CT.RX, q.y / CT.RY)
        return (e - 1) * CT.RY * (1.0 if e > 1 else 0.7)
    return f


C_GRIP = grasp('Right', canteen_sdf())


def canteen_pose(cpose, lhand=L_LOW, l_curl=12, sway=None):
    cm = view_canteen(cpose[:3], *cpose[3:])
    pose = solve_arm('Right', cm @ C_HAND.inverted(), R_POLE)
    pose.update(solve_arm('Left', left_hand_world(*lhand), L_POLE, twist=0.6))
    curl(pose, 'Left', l_curl)
    pose.update(C_GRIP)
    if sway:
        pose['Root'] = sway
    return pose


def canteen_idle(p):
    w = 2 * math.pi * p
    return canteen_pose(HOLD, sway=rot((X, 0.9 * math.sin(w)), (Z, 0.6 * math.sin(w + 1)))), (0, 0, 0)


def canteen_walk(p):
    w = 2 * math.pi * p
    return canteen_pose(HOLD, sway=rot((X, 2.5 * math.sin(2 * w)), (Y, 2.0 * math.sin(w)))), (0, 0, 0)


# drink: raise the neck to the mouth (below the eye, ≥ 12 cm from it), tip it up, two gulps, lower
DRINK = [(0.0, HOLD), (0.13, (0.11, 0.31, -0.11, -18, 50, 0, 0)), (0.30, (0.01, 0.232, -0.05, -10, 108, 0, 0)),
         (0.45, (0.0, 0.215, -0.045, -10, 118, 0, 0)), (0.55, (0.0, 0.218, -0.048, -10, 114, 0, 0)),
         (0.70, (0.0, 0.215, -0.045, -10, 120, 0, 0)), (0.84, (0.13, 0.33, -0.18, -22, 45, 0, 0)), (1.0, HOLD)]


def drink(p):
    return canteen_pose(keys(DRINK, p)), (0, 0, 0)


# fill: canteen lowered and forward, neck tipped forward under a tap, left palm under the bottom
FILL = [(0.0, HOLD), (0.28, (0.01, 0.44, -0.11, -10, -30, 0, -10)), (0.72, (0.01, 0.442, -0.12, -10, -34, 0, -10)),
        (1.0, HOLD)]


def fill_left(cpose):
    cm = view_canteen(cpose[:3], *cpose[3:])
    return cm @ V((0, 0, -0.012)), cm.to_3x3() @ V((1, 0, 0)), cm.to_3x3() @ V((0, 0, 1))


def fill(p):
    c = keys(FILL, p)
    lw = keys([(0, (0,)), (0.3, (1,)), (0.7, (1,)), (1, (0,))], p)[0]
    lh = [lerp(lo, f, lw) for lo, f in zip(L_LOW, fill_left(c))]
    return canteen_pose(c, lhand=lh, l_curl=12 + 18 * lw), (0, 0, 0)


for name, frames, fn in (('CanteenIdle', 90, canteen_idle), ('CanteenWalk', 22, canteen_walk), ('Drink', 36, drink),
                         ('Fill', 45, fill)):
    S.clip(name, frames, fn)

# ============================================================================== telescope clips
# Held in a power grip (Napier 1956): the barrel lies obliquely across the palm, from the heel of the
# hand on the little-finger side to the base of the index finger, about 20° off square to the hand; the
# fingers wrap round it and the thumb closes over it. The eyepiece sticks out by the thumb, the objective
# past the little finger, so the same grip brings it to the eye without changing hands (forearm up under
# the tube, thumb towards the face). The left arm stays lowered out of view.
import telescope as TS  # noqa: E402

T_OBLIQUE = 20  # barrel angle off square across the palm (deg)
T_GRIP_Y = 0.032  # telescope y (its local axis) under the middle of the hand: mid-leather


def telescope_in_hand():
    """Telescope matrix relative to the RightHand bone (head origin), and the barrel's sdf in rest
    armature space. The barrel is pushed into the palm until it just presses the glove."""
    a, pn, t = hand_frame(-1)
    W = V(S.B['RightHand'][0])
    b = math.radians(T_OBLIQUE)
    u = (t * math.cos(b) + a * math.sin(b)).normalized()  # towards the eyepiece: radial end sits distal
    v = 0.05
    for _ in range(6):  # palm contact: the deepest glove vertex sits 2 mm inside the leather
        c = W + a * 0.058 + pn * v
        f = cylinder_sdf(c, u, TS.GRIP_R)
        v -= min(f(p) for p in PALMS['Right']) + 0.002
    c = W + a * 0.058 + pn * v
    f = cylinder_sdf(c, u, TS.GRIP_R)
    print('TELESCOPE palm offset', round(v, 4))
    yt = -u
    zt = (pn - yt * pn.dot(yt)).normalized()
    m = frame_cols(yt.cross(zt), yt, zt).to_4x4()
    m.translation = c - yt * T_GRIP_Y
    return BONES['RightHand'].matrix_local.inverted() @ m, f, u


T_HAND, T_SDF, T_AXIS = telescope_in_hand()
T_GRIP = grasp('Right', T_SDF, wrap=T_AXIS)


def view_telescope(centre, yaw=0.0, tilt=0.0, roll=0.0):
    """Telescope world matrix from its origin: roll about the tube, yaw about Z (+ = objective left), tilt
    about world X (+ = objective up)."""
    return (Matrix.Translation(V(centre)) @ Matrix.Rotation(math.radians(tilt), 4, 'X') @
            Matrix.Rotation(math.radians(yaw), 4, 'Z') @ Matrix.Rotation(math.radians(roll), 4, 'Y'))


def right_hand_world(wrist, fingers, thumb):
    """RightHand bone matrix (view space, head at `wrist`) with the hand pointing along `fingers` and its
    thumb side towards `thumb`."""
    a0, _, t0 = hand_frame(-1)
    m3 = MW.to_3x3()
    rest = frame_cols(m3 @ a0, m3 @ t0, m3 @ a0.cross(t0))
    a = V(fingers).normalized()
    t = (V(thumb) - a * V(thumb).dot(a)).normalized()
    m = (frame_cols(a, t, a.cross(t)) @ rest.inverted()).to_4x4() @ MW @ BONES['RightHand'].matrix_local
    m.translation = V(wrist)
    return m


def carry_hand(wrist, thumb, ulnar):
    """Right hand at `wrist` in line with the forearm (the IK's elbow), bent `ulnar` degrees towards the
    little finger (tipping the eyepiece forward), thumb side towards `thumb`."""
    fingers = V((-0.2, 0.8, -0.5))
    for _ in range(4):
        m = right_hand_world(wrist, fingers, thumb)
        solve_arm('Right', m, R_POLE)
        fa = (V(wrist) - ELBOW['Right']).normalized()
        t = (V(thumb) - fa * V(thumb).dot(fa)).normalized()
        fingers = fa * math.cos(math.radians(ulnar)) - t * math.sin(math.radians(ulnar))
    return right_hand_world(wrist, fingers, thumb)


# carry: fist low right in line with the forearm, thumb up and in, so the eyepiece points up and forward
# out of the top of the fist and the objective down out of the bottom
T_CARRY = carry_hand((0.15, 0.28, -0.12), (-0.35, 0.55, 0.75), 28)
# at the eye: eyepiece ~0.095 m ahead (the game scales the viewmodel 0.55 about the eye, near plane 0.05),
# fist under the tube with the forearm rising to it from an elbow below
R_POLE_EYE = (0.4, 0.1, -0.9)


def eye_hand(roll):
    return view_telescope((0.0, -TS.EYE_Y + 0.095, -0.004), 0, 0, roll) @ T_HAND.inverted()


def wrist_bend(pose):
    q = pose['RightHand']
    return math.degrees(2 * math.acos(min(1.0, abs(q.w))))


# roll about the tube that leaves the wrist straightest with the elbow down under it
def eye_cost(roll):
    hand = eye_hand(roll)
    reach = (MWi @ hand.translation - V(S.B['RightArm'][0])).length
    return wrist_bend(solve_arm('Right', hand, R_POLE_EYE)) + (1e3 if reach > 0.55 else 0)


T_EYE = eye_hand(min(range(0, 360, 5), key=eye_cost))


def wrist_report(name, pose):
    print('WRIST', name, round(wrist_bend(pose)))


def telescope_pose(hand, pole=R_POLE, sway=None):
    pose = solve_arm('Right', hand, pole)
    pose.update(solve_arm('Left', left_hand_world(*L_LOW), L_POLE, twist=0.6))
    curl(pose, 'Left', 12)
    pose.update(T_GRIP)
    if sway:
        pose['Root'] = sway
    return pose


def telescope_idle(p):
    w = 2 * math.pi * p
    return telescope_pose(T_CARRY, sway=rot((X, 0.9 * math.sin(w)), (Z, 0.6 * math.sin(w + 1)))), (0, 0, 0)


def telescope_walk(p):
    w = 2 * math.pi * p
    return telescope_pose(T_CARRY, sway=rot((X, 2.5 * math.sin(2 * w)), (Y, 2.0 * math.sin(w)))), (0, 0, 0)


def mat_lerp(m0, m1, f):
    m = m0.to_quaternion().slerp(m1.to_quaternion(), f).to_matrix().to_4x4()
    m.translation = m0.translation.lerp(m1.translation, f)
    return m


def telescope_raise(p):
    f = p * p * (3 - 2 * p)
    hand = mat_lerp(T_CARRY, T_EYE, f)
    hand.translation += V((0, 0.03, -0.04)) * math.sin(math.pi * p)  # swing out and up, not through the chin
    pole = V(R_POLE).lerp(V(R_POLE_EYE), f)
    sway = rot((Z, 0.6 * math.sin(1) * (1 - p)))  # TelescopeIdle frame 0 -> still
    return telescope_pose(hand, pole, sway), (0, 0, 0)


wrist_report('carry', telescope_pose(T_CARRY))
wrist_report('eye', telescope_pose(T_EYE, R_POLE_EYE))


def clip_once(name, frames, fn):
    """Like scavenger.clip, but a one-shot that ends on p = 1 (clip() wraps its last key back to p = 0)."""
    S.clip(name, frames, lambda p: fn(1.0))  # creates the action + NLA strip; keys rewritten below
    act = bpy.data.actions[name]
    rig.animation_data.action = act
    if hasattr(rig.animation_data, 'action_slot') and act.slots:
        rig.animation_data.action_slot = act.slots[0]
    for f in range(frames + 1):
        pose, hips = fn(f / frames)
        S.key_pose(f, pose, hips)
    rig.animation_data.action = None


for name, frames, fn in (('TelescopeIdle', 90, telescope_idle), ('TelescopeWalk', 22, telescope_walk)):
    S.clip(name, frames, fn)
clip_once('TelescopeRaise', 10, telescope_raise)  # 11 keys, 0.33 s
for pb in rig.pose.bones:
    pb.rotation_quaternion = Quaternion()

# canteen: built far from the hands so neither bake shades the other, baked after the hands so they keep
# the 'PlayerTint' material name, exported alone, then parented to the right hand.
CAN_AT = V((5.0, 0.0, 0.9))
can = CT.build(CAN_AT)
TEL_AT = V((-5.0, 0.0, 0.9))
tel = TS.build(TEL_AT)

import bake  # noqa: E402

bake.bake_atlas(body, 1024, S.OUT_DIR, tint_name='Tint', small=0, prefix='hands')
CT.bake_and_export(can, S.OUT_DIR, os.path.join(S.ROOT, 'public', 'models', 'canteen.glb'), CAN_AT)
tel_parts = TS.bake_and_export(tel, S.OUT_DIR, os.path.join(S.ROOT, 'public', 'models', 'telescope.glb'), TEL_AT)
bpy.context.view_layer.update()
can.parent = rig
can.parent_type = 'BONE'
can.parent_bone = 'RightHand'
can.matrix_parent_inverse = Matrix.Identity(4)
can.matrix_basis = Matrix.Translation((0, -BONES['RightHand'].length, 0)) @ C_HAND  # bone parent space = tail
tel.parent = rig
tel.parent_type = 'BONE'
tel.parent_bone = 'RightHand'
tel.matrix_parent_inverse = Matrix.Identity(4)
tel.matrix_basis = Matrix.Translation((0, -BONES['RightHand'].length, 0)) @ T_HAND
bake.export(rig, [body, can, *tel_parts], OUT)
print('TRIS_FINAL', tri_count(body), 'CANTEEN', tri_count(can), 'TELESCOPE', tri_count(tel))
