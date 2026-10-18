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
# Laser rifle (tools/models/rifle.py), held in both hands:
#   RifleIdle (3 s loop)  low ready: right hand on the pistol grip (index on the trigger), left hand under the
#     handguard, rifle low and a little right with its bore on the crosshair (so a hip shot's beam leaves along
#     the barrel)
#   RifleWalk (0.73 s loop)  the same hold with the walk bob
#   RifleAim (0.27 s one-shot)  from the RifleIdle frame-0 pose up to the eye (play clamped): the scope's axis
#     ends exactly on the view axis with the eye EYE_RELIEF behind the eyepiece (the build prints the check)
# Mesh node `Rifle` (materials 'Rifle' and the emissive 'RifleGlow') is a child of the `RightHand` bone,
# visible by default; its child nodes `RifleMuzzle` (tip of the emitter on the bore) and `RifleEye` (on the
# scope axis, where the eye goes) have the rifle's orientation: their +Z points along the bore to the
# muzzle. Also writes public/models/rifle.glb (origin at the pistol grip, muzzle +Z, up +Y).
# Laser pistol (tools/models/pistol.py), one-handed (left arm lowered out of view):
#   PistolIdle (3 s loop)  low ready in the right fist, index on the trigger, muzzle on the crosshair
#   PistolWalk (0.73 s loop)  the same hold with the walk bob
#   PistolAim (0.23 s one-shot)  from the PistolIdle frame-0 pose out at arm's length (play clamped): the iron
#     sights end on the view axis with the eye P_RELIEF behind the rear sight, canted P_CANT so the forearm runs out of
#     the bottom right corner
# Mesh node `Pistol` ('Pistol', emissive 'PistolGlow') with `PistolMuzzle` / `PistolEye` markers, as the rifle's.
# Also writes public/models/pistol.glb (origin at the grip, muzzle +Z, up +Y).
# Jammer (src/models/jammer.ts, drawn by the game on the empty `JammerMount`, in the pistol's frame):
#   JammerIdle / JammerWalk  low right in the right fist like the pistol, antenna on the crosshair
#   JammerAim (0.27 s one-shot, scrubbed)  up in front at chest height, the left palm coming up under its body
# Hand tools (tools/models/handtools.py; nodes `Shovel`, `Detector`, `ScrapChunk` on the right hand, own atlases):
#   ShovelIdle / ShovelWalk  carried in the right fist under the T grip, blade out ahead low in the view
#   ShovelDig (1.2 s loop)  both hands: drive it in, lever, lift the scoop into view, flick it out to the left
#   DetectorIdle (3 s, two sweeps) / DetectorWalk (one sweep)  by its grip, the coil swept low across the view
#   DetectorDig (1.2 s loop)  held up out of the way while the left hand scoops (Dig's left arm)
#   ScrapIdle / ScrapWalk  a bent angle-iron offcut in the fist, low right
#   ScrapThrow (0.5 s one-shot)  cocked by the ear, thrown over the top, let go at SC_RELEASE, back with the next
# HANDS_FAST=1 HANDS_OUT=<path> skips the bakes (flat colours, a stand-in jammer) for quick checks with render_hand.py.
import math
import os
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scavenger as S  # noqa: E402  (creates materials; the character itself is only built by its main())
from sclib import V, cylinder, join, rounded_box, tri_count  # noqa: E402

OUT = os.environ.get('HANDS_OUT') or os.path.join(S.ROOT, 'public', 'models', 'hands.glb')
FAST = bool(os.environ.get('HANDS_FAST'))  # skip the bakes (quick pose checks; write HANDS_OUT elsewhere)

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


def carry_hand(wrist, thumb, ulnar, pole=R_POLE):
    """Right hand at `wrist` in line with the forearm (the IK's elbow), bent `ulnar` degrees towards the
    little finger (tipping the eyepiece forward), thumb side towards `thumb`."""
    fingers = V((-0.2, 0.8, -0.5))
    for _ in range(4):
        m = right_hand_world(wrist, fingers, thumb)
        solve_arm('Right', m, pole)
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

# ============================================================================== rifle clips
# Two-handed. The right hand holds the pistol grip in a power grip like the spyglass (the grip lies
# obliquely across the palm, its top by the thumb), the index finger closing on the trigger; with the
# grip raked forward that leaves the bore running along the back of the hand, so the forearm stays roughly
# in line with it. The left hand supports the handguard from below in a second power grip, palm up and a
# little to the left, thumb forward along it. Each pose places the RIFLE (in view space); both hands follow
# it through fixed hand-relative placements (R_HAND, L_HAND), so one solved grip per hand serves every
# frame. Rifle matrices here are in rifle.py's natural frame (+Y muzzle, +Z up); the mesh is turned by
# RF.FLIP.
import rifle as RF  # noqa: E402

R_OBLIQUE = 20  # grip angle off square across the palm (deg), as the spyglass
R_YAW = 0  # rifle turned about the grip axis relative to the hand (deg); searched below
EYE_RELIEF = 0.125  # eye behind the eyepiece at full aim (model units; ×0.55 in game = 6.9 cm, past the 5 cm near
# plane, and far enough that the near plane (0.091 model units ahead) only cuts the stock, below the view)
L_GRIP_Y = 0.235  # where the support hand holds the handguard (natural y)
L_TWIST = 0.95  # the support hand is turned palm up: the forearm, not the wrist, takes that roll


def box_sdf(lo, hi):
    lo, hi = V(lo), V(hi)
    c, h = (lo + hi) / 2, (hi - lo) / 2

    def f(p):
        q = V([abs(p[i] - c[i]) - h[i] for i in range(3)])
        out = V([max(x, 0.0) for x in q]).length
        return out + min(max(q.x, q.y, q.z), 0.0)
    return f


def rifle_sdf_nat():
    """Rough natural-frame sdf of what the hands can touch: pistol grip, trigger, receiver, handguard."""
    g = capsule_sdf(RF.GRIP_AXIS * RF.GRIP_BOT, RF.GRIP_AXIS * RF.GRIP_TOP, RF.GRIP_R)
    trig = capsule_sdf(V(RF.TRIGGER[0]), V(RF.TRIGGER[-1]), 0.003)
    rec = box_sdf((-RF.REC_W / 2, RF.REC_Y0, RF.REC_Z0), (RF.REC_W / 2, RF.REC_Y1, RF.REC_Z1))
    hg = capsule_sdf(V((0, RF.HG_Y0, RF.HG_Z)), V((0, RF.HG_Y1, RF.HG_Z)), RF.HG_R)
    return lambda p: min(g(p), trig(p), rec(p), hg(p))


R_NAT_SDF = rifle_sdf_nat()


def in_rest(m_nat, f):
    """sdf in rest armature space of a natural-frame sdf, for a rifle at m_nat (rest armature space)."""
    inv = m_nat.inverted()
    return lambda p: f(inv @ p)


def rifle_in_right(yaw=R_YAW):
    return gun_in_right(RF, R_NAT_SDF, yaw, 'RIFLE')


def gun_in_right(G, nat_sdf, yaw, label):
    """Gun (module G: rifle.py or pistol.py, natural frame) relative to the RightHand bone, plus its sdf
    (`nat_sdf`) in rest armature space. The grip axis lies obliquely across the palm (top by the thumb),
    pushed in until it presses the glove; the bore is the hand's finger direction squared to the raked grip,
    turned `yaw` about the grip axis."""
    a, pn, t = hand_frame(-1)
    W = V(S.B['RightHand'][0])
    b = math.radians(R_OBLIQUE)
    u = (t * math.cos(b) + a * math.sin(b)).normalized()  # grip axis, towards the receiver
    fp = (a - u * a.dot(u)).normalized()
    fp = Quaternion(u, math.radians(yaw)) @ fp
    r = math.radians(G.RAKE)
    U = u * math.cos(r) - fp * math.sin(r)
    F = fp * math.cos(r) + u * math.sin(r)
    R = F.cross(U)

    def place(v):
        m = frame_cols(R, F, U).to_4x4()
        m.translation = W + a * 0.058 + pn * v
        return m

    v = 0.05
    for _ in range(6):
        g = in_rest(place(v), capsule_sdf(G.GRIP_AXIS * G.GRIP_BOT, G.GRIP_AXIS * G.GRIP_TOP, G.GRIP_R))
        v -= min(g(p) for p in PALMS['Right']) + 0.002
    m = place(v)
    print(label, 'right palm offset', round(v, 4), 'right·palm', round(R.dot(pn), 2))
    return BONES['RightHand'].matrix_local.inverted() @ m, in_rest(m, nat_sdf), u


def rifle_in_left(alpha):
    """Rifle (natural frame) relative to the LeftHand bone: the handguard lies obliquely across the left
    palm with the muzzle end by the thumb, the palm facing up and `alpha` degrees towards the rifle's
    right (the hand cups it from below-left)."""
    a, pn, t = hand_frame(1)
    W = V(S.B['LeftHand'][0])
    b = math.radians(R_OBLIQUE)
    F = (t * math.cos(b) + a * math.sin(b)).normalized()
    pp = (pn - F * pn.dot(F)).normalized()
    U = Quaternion(F, math.radians(-alpha)) @ pp
    R = F.cross(U)
    hg = capsule_sdf(V((0, RF.HG_Y0, RF.HG_Z)), V((0, RF.HG_Y1, RF.HG_Z)), RF.HG_R)

    def place(v):
        m = frame_cols(R, F, U).to_4x4()
        m.translation = W + a * 0.058 + pn * v - F * L_GRIP_Y - U * RF.HG_Z
        return m

    v = 0.05
    for _ in range(6):
        g = in_rest(place(v), hg)
        v -= min(g(p) for p in PALMS['Left']) + 0.002
    m = place(v)
    return BONES['LeftHand'].matrix_local.inverted() @ m, in_rest(m, R_NAT_SDF), F


def rifle_world(at, yaw=0.0, pitch=0.0, roll=0.0):
    """Rifle matrix (natural frame) in view space: grip origin at `at`, yaw about Z (+ = muzzle left),
    pitch about X (+ = muzzle up), roll about the bore (+ = top to the right)."""
    return (Matrix.Translation(V(at)) @ Matrix.Rotation(math.radians(yaw), 4, 'Z') @
            Matrix.Rotation(math.radians(pitch), 4, 'X') @ Matrix.Rotation(math.radians(roll), 4, 'Y'))


# aim: scope axis on the view axis, the eye EYE_RELIEF behind the eyepiece
R_AIM = Matrix.Translation(-RF.eye_local(EYE_RELIEF))


def rifle_ready(at, roll, dist=45.0):
    """Rifle at the hip with its bore on the crosshair: the line through the muzzle passes `dist` model units
    (×0.55 in game, ~25 m) ahead on the view axis, so a shot's beam (src/rifle.ts: from the drawn muzzle to
    where the crosshair hits) leaves along the barrel. Allows for the game's REST_PITCH (src/viewmodel.ts), which
    tips the whole viewmodel down about the eye."""
    rest = 0.05  # -REST_PITCH
    T = V((0, dist * math.cos(rest), dist * math.sin(rest)))
    rw = rifle_world(at, roll=roll)
    for _ in range(4):
        d = (T - rw @ RF.muzzle_local()).normalized()
        rw = rifle_world(at, math.degrees(math.atan2(-d.x, d.y)), math.degrees(math.asin(d.z)), roll)
    return rw


# hip / low ready: grip low right, bore on the crosshair, canted a touch; close enough in that the left arm
# reaches the handguard with the elbow still bent (further out it stops short, under it)
R_READY = rifle_ready((0.09, 0.16, -0.21), roll=-3)


def wrist_bend_of(pose, pre):
    q = pose[pre + 'Hand']
    return math.degrees(2 * math.acos(min(1.0, abs(q.w))))


def pole_dirs():
    out = []
    for el in range(-80, 41, 15):
        for az in range(0, 360, 20):
            e, z = math.radians(el), math.radians(az)
            out.append(V((math.cos(e) * math.cos(z), math.cos(e) * math.sin(z), math.sin(e))))
    return out


POLE_DIRS = pole_dirs()


def best_pole(pre, hand, twist):
    """Elbow pole (view space point) that leaves the wrist straightest, the elbow kept below the hand."""
    sh = MW @ V(S.B[pre + 'Arm'][0])

    def cost(d):
        b = wrist_bend_of(solve_arm(pre, hand, sh + d, twist), pre)
        return b + (200 if ELBOW[pre].z > hand.translation.z - 0.03 else 0)
    d = min(POLE_DIRS, key=cost)
    return tuple(sh + d), cost(d)


def right_cost(yaw):
    rh = rifle_in_right(yaw)[0]
    return sum(best_pole('Right', rw @ rh.inverted(), 0.75)[1] for rw in (R_READY, R_AIM))


R_YAW = min(range(-40, 41, 5), key=right_cost)
R_HAND, R_SDF, R_AXIS = rifle_in_right(R_YAW)
print('RIFLE right yaw', R_YAW)
R_GRIP = grasp('Right', R_SDF, wrap=R_AXIS)
RR_POLE = best_pole('Right', R_READY @ R_HAND.inverted(), 0.75)[0]
RR_POLE_AIM = best_pole('Right', R_AIM @ R_HAND.inverted(), 0.75)[0]


def left_cost(alpha):
    lh = rifle_in_left(alpha)[0]
    return sum(best_pole('Left', rw @ lh.inverted(), L_TWIST)[1] for rw in (R_READY, R_AIM))


L_ALPHA = min(range(0, 61, 10), key=left_cost)  # palm up, turned towards the rifle's right
L_HAND, L_SDF, L_AXIS = rifle_in_left(L_ALPHA)
print('RIFLE left alpha', L_ALPHA)
L_GRIP = grasp('Left', L_SDF, wrap=L_AXIS)
RL_POLE = best_pole('Left', R_READY @ L_HAND.inverted(), L_TWIST)[0]
RL_POLE_AIM = best_pole('Left', R_AIM @ L_HAND.inverted(), L_TWIST)[0]
print('RIFLE poles', [tuple(round(x, 2) for x in p) for p in (RR_POLE, RR_POLE_AIM, RL_POLE, RL_POLE_AIM)])


def rifle_pose(rw, rpole=None, lpole=None, sway=None):
    rpole, lpole = rpole or RR_POLE, lpole or RL_POLE
    pose = solve_arm('Right', rw @ R_HAND.inverted(), rpole)
    pose.update(solve_arm('Left', rw @ L_HAND.inverted(), lpole, twist=L_TWIST))
    pose.update(R_GRIP)
    pose.update(L_GRIP)
    if sway:
        pose['Root'] = sway
    return pose


def rifle_idle(p):
    w = 2 * math.pi * p
    return rifle_pose(R_READY, sway=rot((X, 0.9 * math.sin(w)), (Z, 0.6 * math.sin(w + 1)))), (0, 0, 0)


def rifle_walk(p):
    w = 2 * math.pi * p
    return rifle_pose(R_READY, sway=rot((X, 2.5 * math.sin(2 * w)), (Y, 2.0 * math.sin(w)))), (0, 0, 0)


def rifle_aim(p):
    f = p * p * (3 - 2 * p)
    rw = mat_lerp(R_READY, R_AIM, f)
    rw.translation += V((0, 0.02, 0.0)) * math.sin(math.pi * p)  # push forward a little so the stock clears
    rp = V(RR_POLE).lerp(V(RR_POLE_AIM), f)
    lp = V(RL_POLE).lerp(V(RL_POLE_AIM), f)
    return rifle_pose(rw, rp, lp, rot((Z, 0.6 * math.sin(1) * (1 - p)))), (0, 0, 0)


for nm, rw, rp, lp in (('rifle ready', R_READY, RR_POLE, RL_POLE), ('rifle aim', R_AIM, RR_POLE_AIM, RL_POLE_AIM)):
    ps = rifle_pose(rw, rp, lp)
    print('WRIST', nm, 'right', round(wrist_bend_of(ps, 'Right')), 'left', round(wrist_bend_of(ps, 'Left')))

for name, frames, fn in (('RifleIdle', 90, rifle_idle), ('RifleWalk', 22, rifle_walk)):
    S.clip(name, frames, fn)
clip_once('RifleAim', 8, rifle_aim)  # 9 keys, 0.27 s

# ============================================================================== pistol clips
# One-handed, like the spyglass: the left arm stays lowered out of view. The right hand holds the grip as it
# holds the rifle's (gun_in_right: the same power grip, index on the trigger); the pistol is placed in view
# space and the hand follows. Aimed, the arm is out straight and the iron sights sit on the view axis.
import pistol as PS  # noqa: E402

P_RELIEF = 0.38  # eye behind the rear sight at full aim (model units; ×0.55 in game = 21 cm)


def pistol_sdf_nat():
    """Rough natural-frame sdf of what the hand can touch: grip, trigger, frame and receiver."""
    g = capsule_sdf(PS.GRIP_AXIS * PS.GRIP_BOT, PS.GRIP_AXIS * PS.GRIP_TOP, PS.GRIP_R)
    trig = capsule_sdf(V(PS.TRIGGER[0]), V(PS.TRIGGER[-1]), 0.003)
    rec = box_sdf((-PS.REC_W / 2, PS.REC_Y0, PS.REC_Z0 - 0.012), (PS.REC_W / 2, PS.REC_Y1, PS.REC_Z1))
    return lambda p: min(g(p), trig(p), rec(p))


P_NAT_SDF = pistol_sdf_nat()


def pistol_ready(at, roll, dist=45.0):
    """Pistol low right with its bore on the crosshair: the line through the muzzle passes `dist` model units
    ahead on the view axis (allowing for the game's REST_PITCH, src/viewmodel.ts), so the beam leaves along it."""
    rest = 0.05  # -REST_PITCH
    T = V((0, dist * math.cos(rest), dist * math.sin(rest)))
    pw = rifle_world(at, roll=roll)
    for _ in range(4):
        d = (T - pw @ PS.muzzle_local()).normalized()
        pw = rifle_world(at, math.degrees(math.atan2(-d.x, d.y)), math.degrees(math.asin(d.z)), roll)
    return pw


# aim: the sight line on the view axis, the eye P_RELIEF behind the rear sight, canted P_CANT about the sight line
# (top to the left), so the hand under it sits off to the right and the forearm runs out of the bottom right corner
# instead of up the middle of the view
P_CANT = -35
P_AIM = Matrix.Rotation(math.radians(P_CANT), 4, 'Y') @ Matrix.Translation(-PS.eye_local(P_RELIEF))
# ready: low right, forearm forward, canted a touch inwards
P_READY = pistol_ready((0.15, 0.30, -0.16), roll=-6)


def pistol_cost(yaw):
    ph = gun_in_right(PS, P_NAT_SDF, yaw, 'PISTOL')[0]
    return sum(best_pole('Right', pw @ ph.inverted(), 0.75)[1] for pw in (P_READY, P_AIM))


P_YAW = min(range(-40, 41, 5), key=pistol_cost)
P_HAND, P_SDF, P_AXIS = gun_in_right(PS, P_NAT_SDF, P_YAW, 'PISTOL')
print('PISTOL yaw', P_YAW)
P_GRIP = grasp('Right', P_SDF, wrap=P_AXIS)
PR_POLE = best_pole('Right', P_READY @ P_HAND.inverted(), 0.75)[0]
PR_POLE_AIM = best_pole('Right', P_AIM @ P_HAND.inverted(), 0.75)[0]


def pistol_pose(pw, pole=None, sway=None):
    pose = solve_arm('Right', pw @ P_HAND.inverted(), pole or PR_POLE)
    pose.update(solve_arm('Left', left_hand_world(*L_LOW), L_POLE, twist=0.6))
    curl(pose, 'Left', 12)
    pose.update(P_GRIP)
    if sway:
        pose['Root'] = sway
    return pose


def pistol_idle(p):
    w = 2 * math.pi * p
    return pistol_pose(P_READY, sway=rot((X, 0.9 * math.sin(w)), (Z, 0.6 * math.sin(w + 1)))), (0, 0, 0)


def pistol_walk(p):
    w = 2 * math.pi * p
    return pistol_pose(P_READY, sway=rot((X, 2.5 * math.sin(2 * w)), (Y, 2.0 * math.sin(w)))), (0, 0, 0)


def pistol_aim(p):
    f = p * p * (3 - 2 * p)
    pw = mat_lerp(P_READY, P_AIM, f)
    pw.translation += V((0, 0.0, 0.02)) * math.sin(math.pi * p)  # up over the line, not through it
    return pistol_pose(pw, V(PR_POLE).lerp(V(PR_POLE_AIM), f), rot((Z, 0.6 * math.sin(1) * (1 - p)))), (0, 0, 0)


for nm, pw, pp in (('pistol ready', P_READY, PR_POLE), ('pistol aim', P_AIM, PR_POLE_AIM)):
    print('WRIST', nm, round(wrist_bend_of(pistol_pose(pw, pp), 'Right')))

for name, frames, fn in (('PistolIdle', 90, pistol_idle), ('PistolWalk', 22, pistol_walk)):
    S.clip(name, frames, fn)
clip_once('PistolAim', 7, pistol_aim)  # 8 keys, 0.23 s

# ============================================================================== held by a bar
# The shovel's shaft, the jammer's body and the scrap offcut are held like the spyglass: the bar lies obliquely
# across the palm (T_OBLIQUE), pushed in until it presses the glove. Each object is placed in view space and the
# hands follow it through these hand-relative placements, as the rifle's do.
from types import SimpleNamespace  # noqa: E402

import handtools as HT  # noqa: E402


def bar_in_hand(pre, contact, axis, ref, roll, grip=(0, 0, 0), label=None):
    """Object (its natural frame) relative to the <pre>Hand bone, and its rest-space matrix. `axis` (natural) lies
    across the palm with its + end by the thumb; `ref` (natural, square to the axis) points out of the palm, turned
    `roll` degrees about the axis; the natural point `grip` sits at the palm, pushed in along the palm normal until
    `contact` (natural-frame sdf) presses the glove 2 mm."""
    a, pn, t = hand_frame(1 if pre == 'Left' else -1)
    W = V(S.B[pre + 'Hand'][0])
    b = math.radians(T_OBLIQUE)
    u = (t * math.cos(b) + a * math.sin(b)).normalized()
    r = Quaternion(u, math.radians(roll)) @ (pn - u * pn.dot(u)).normalized()
    A = V(axis).normalized()
    Rf = (V(ref) - A * V(ref).dot(A)).normalized()
    r3 = frame_cols(u, r, u.cross(r)) @ frame_cols(A, Rf, A.cross(Rf)).inverted()

    def place(v):
        m = r3.to_4x4()
        m.translation = W + a * 0.058 + pn * v - r3 @ V(grip)
        return m

    v = 0.05
    for _ in range(8):
        g = in_rest(place(v), contact)
        v -= min(g(p) for p in PALMS[pre]) + 0.002
    m = place(v)
    if label:
        print(label, pre, 'palm offset', round(v, 4), 'roll', roll)
    return BONES[pre + 'Hand'].matrix_local.inverted() @ m, m


def obj_world(at, d, face):
    """Object matrix (view space) from its origin, its +Y direction and a hint for its +Z."""
    Y = V(d).normalized()
    Z = (V(face) - Y * V(face).dot(Y)).normalized()
    m = frame_cols(Y.cross(Z), Y, Z).to_4x4()
    m.translation = V(at)
    return m


def key_world(k):
    return obj_world(k[0:3], k[3:6], k[6:9])


def held_pose(holds, sway=None):
    """Arms for the objects in `holds` = [(pre, hand-bone matrix in view space, pole, twist, finger pose)]; an arm
    not listed is lowered out of view."""
    pose = {}
    if not any(h[0] == 'Left' for h in holds):
        pose.update(solve_arm('Left', left_hand_world(*L_LOW), L_POLE, twist=0.6))
        curl(pose, 'Left', 12)
    for pre, hw, pole, twist, grip in holds:
        pose.update(solve_arm(pre, hw, pole, twist))
        pose.update(grip)
    if sway:
        pose['Root'] = sway
    return pose


def idle_sway(p):
    w = 2 * math.pi * p
    return rot((X, 0.9 * math.sin(w)), (Z, 0.6 * math.sin(w + 1)))


def walk_sway(p):
    w = 2 * math.pi * p
    return rot((X, 2.5 * math.sin(2 * w)), (Y, 2.0 * math.sin(w)))


def grip_blend(g0, g1, f):
    """Finger pose between two (slerp per bone; a bone missing from one is at rest there)."""
    return {k: g0.get(k, Quaternion()).slerp(g1.get(k, Quaternion()), f) for k in set(g0) | set(g1)}


def curl_pose(pre, c, thumb=0.0):
    p = {}
    curl(p, pre, c, thumb)
    return p


# ============================================================================== shovel clips
# Carried in the right fist under the T grip, the blade out ahead low in the view (the left arm lowered). ShovelDig
# (digging and piling sand back) brings it in close in both hands, the left underhand further down the shaft, both
# thumbs towards the blade: drive the blade down and forward, lever it, lift the scoop into view and flick it out to
# the left.
SV_R_CONTACT = capsule_sdf(V((0, -0.05, 0)), V((0, 0.05, 0)), HT.SH_R)
SV_L_CONTACT = capsule_sdf(V((0, HT.SH_LEFT - 0.05, 0)), V((0, HT.SH_LEFT + 0.05, 0)), HT.SH_R)
SV_SDF_NAT = (lambda sh, tb: lambda p: min(sh(p), tb(p)))(
    capsule_sdf(V((0, HT.SH_TOP, 0)), V((0, HT.SH_SOCKET, 0)), HT.SH_R),
    capsule_sdf(V((-0.045, HT.SH_TOP - 0.014, 0)), V((0.045, HT.SH_TOP - 0.014, 0)), 0.013))
# (shaft origin x y z, towards the blade, scoop face hint) in view space
SV_CARRY = (0.17, 0.34, -0.19, -0.42, 0.82, -0.38, 0, -0.5, 1)
SV_READY = (0.07, 0.25, -0.15, -0.22, 0.90, -0.38, 0, -0.5, 1)
SV_DIG = [(0.0, SV_READY),
          (0.20, (0.06, 0.30, -0.22, -0.12, 0.60, -0.80, 0, 0, 1)),  # blade driven down and forward
          (0.40, (0.10, 0.22, -0.26, -0.15, 0.82, -0.55, 0, -0.3, 1)),  # handle pulled down and back: levered
          (0.62, (0.07, 0.23, -0.13, -0.25, 0.92, -0.30, 0, -0.6, 1)),  # scoop lifted into view
          (0.80, (0.03, 0.26, -0.11, -0.62, 0.74, -0.20, -1, -0.2, 0.5)),  # flicked out to the left
          (1.0, SV_READY)]
SV_KEYS = [k for _, k in SV_DIG[:-1]]


def sv_rel(pre, roll, label=None):
    if pre == 'Right':
        return bar_in_hand(pre, SV_R_CONTACT, (0, 1, 0), (0, 0, 1), roll, label=label)
    return bar_in_hand(pre, SV_L_CONTACT, (0, 1, 0), (0, 0, 1), roll, (0, HT.SH_LEFT, 0), label)


def sv_cost(pre, roll, twist):
    rel = sv_rel(pre, roll)[0]
    return sum(best_pole(pre, key_world(k) @ rel.inverted(), twist)[1]
               for k in SV_KEYS + ([SV_CARRY] if pre == 'Right' else []))


SV_RROLL = min(range(-180, 180, 30), key=lambda r: sv_cost('Right', r, 0.75))
SV_LROLL = min(range(-180, 180, 30), key=lambda r: sv_cost('Left', r, L_TWIST))
SV_RHAND, SV_RM = sv_rel('Right', SV_RROLL, 'SHOVEL')
SV_LHAND, SV_LM = sv_rel('Left', SV_LROLL, 'SHOVEL')
SV_RGRIP = grasp('Right', in_rest(SV_RM, SV_SDF_NAT), wrap=SV_RM.to_3x3() @ V((0, 1, 0)))
SV_LGRIP = grasp('Left', in_rest(SV_LM, SV_SDF_NAT), wrap=SV_LM.to_3x3() @ V((0, 1, 0)))
SV_RPOLES = [best_pole('Right', key_world(k) @ SV_RHAND.inverted(), 0.75)[0] for k in SV_KEYS]
SV_LPOLES = [best_pole('Left', key_world(k) @ SV_LHAND.inverted(), L_TWIST)[0] for k in SV_KEYS]
SV_CPOLE = best_pole('Right', key_world(SV_CARRY) @ SV_RHAND.inverted(), 0.75)[0]


def shovel_pose(k, rp, lp, sway=None):
    sw = key_world(k)
    return held_pose([('Right', sw @ SV_RHAND.inverted(), rp, 0.75, SV_RGRIP),
                      ('Left', sw @ SV_LHAND.inverted(), lp, L_TWIST, SV_LGRIP)], sway)


def shovel_carry(sway):
    return held_pose([('Right', key_world(SV_CARRY) @ SV_RHAND.inverted(), SV_CPOLE, 0.75, SV_RGRIP)], sway)


def shovel_idle(p):
    return shovel_carry(idle_sway(p)), (0, 0, 0)


def shovel_walk(p):
    return shovel_carry(walk_sway(p)), (0, 0, 0)


def shovel_dig(p):
    k = keys(SV_DIG, p)
    rp = keys([(q, tuple(v)) for (q, _), v in zip(SV_DIG, SV_RPOLES + [SV_RPOLES[0]])], p)
    lp = keys([(q, tuple(v)) for (q, _), v in zip(SV_DIG, SV_LPOLES + [SV_LPOLES[0]])], p)
    return shovel_pose(k, V(rp), V(lp), rot((X, 3 * math.sin(2 * math.pi * p)))), (0, 0, 0)


print('WRIST shovel carry', round(wrist_bend_of(shovel_carry(None), 'Right')))
for i, k in enumerate(SV_KEYS):
    ps = shovel_pose(k, SV_RPOLES[i], SV_LPOLES[i])
    print('WRIST shovel', SV_DIG[i][0], 'right', round(wrist_bend_of(ps, 'Right')), 'left',
          round(wrist_bend_of(ps, 'Left')))
for name, frames, fn in (('ShovelIdle', 90, shovel_idle), ('ShovelWalk', 22, shovel_walk), ('ShovelDig', 36, shovel_dig)):
    S.clip(name, frames, fn)

# ============================================================================== metal detector clips
# One-handed by its raked grip (gun_in_right, like the pistol), the shaft running forward and down so the coil sits
# low in the middle of the view. Idle and walking it sweeps side to side; digging, the right hand holds it up out
# of the way while the left hand scoops (the empty-hand Dig clip's left arm).
DTG = SimpleNamespace(RAKE=HT.DT_RAKE, GRIP_AXIS=HT.DT_GRIP_AXIS, GRIP_TOP=HT.DT_GRIP_TOP, GRIP_BOT=HT.DT_GRIP_BOT,
                      GRIP_R=HT.DT_GRIP_R)
DT_SDF_NAT = (lambda g, b: lambda p: min(g(p), b(p)))(
    capsule_sdf(HT.DT_GRIP_AXIS * HT.DT_GRIP_BOT, HT.DT_GRIP_AXIS * HT.DT_GRIP_TOP, HT.DT_GRIP_R),
    box_sdf(*HT.DT_BOX))
DT_AT = (0.15, 0.30, -0.18)
DT_PITCH = -2
DT_YAW0, DT_SWEEP = 9, 17  # middle of the sweep (+ = coil left), half its width (deg)
DT_RAISED = rifle_world((0.21, 0.27, -0.11), -12, 18, 8)  # held up out of the way while digging


def dt_world(yaw, p_off=0.0):
    return rifle_world(DT_AT, yaw, DT_PITCH + p_off, -0.25 * (yaw - DT_YAW0))


def dt_cost(yaw):
    h = gun_in_right(DTG, DT_SDF_NAT, yaw, 'DETECTOR')[0]
    return sum(best_pole('Right', w @ h.inverted(), 0.75)[1]
               for w in (dt_world(DT_YAW0 - DT_SWEEP), dt_world(DT_YAW0 + DT_SWEEP), DT_RAISED))


DT_GYAW = min(range(-60, 61, 10), key=dt_cost)
DT_HAND, DT_SDF, DT_AXIS = gun_in_right(DTG, DT_SDF_NAT, DT_GYAW, 'DETECTOR')
print('DETECTOR yaw', DT_GYAW)
DT_GRIP = grasp('Right', DT_SDF, wrap=DT_AXIS)
DT_POLE = best_pole('Right', dt_world(DT_YAW0) @ DT_HAND.inverted(), 0.75)[0]
DT_POLE_UP = best_pole('Right', DT_RAISED @ DT_HAND.inverted(), 0.75)[0]


def detector_pose(dw, pole=None, sway=None):
    return held_pose([('Right', dw @ DT_HAND.inverted(), pole or DT_POLE, 0.75, DT_GRIP)], sway)


def detector_idle(p):  # two slow sweeps per 3 s
    return detector_pose(dt_world(DT_YAW0 + DT_SWEEP * math.sin(4 * math.pi * p)), sway=idle_sway(p)), (0, 0, 0)


def detector_walk(p):  # one sweep per walk cycle
    w = 2 * math.pi * p
    return detector_pose(dt_world(DT_YAW0 + DT_SWEEP * math.sin(w), 2 * math.sin(2 * w)), sway=walk_sway(p)), (0, 0, 0)


def detector_dig(p):
    d, _ = dig(p)
    pose = detector_pose(DT_RAISED, DT_POLE_UP)
    pose.update({k: q for k, q in d.items() if k.startswith('Left') or k == 'Root'})
    return pose, (0, 0, 0)


for nm, w, pl in (('left', dt_world(DT_YAW0 + DT_SWEEP), None), ('right', dt_world(DT_YAW0 - DT_SWEEP), None),
                  ('raised', DT_RAISED, DT_POLE_UP)):
    print('WRIST detector', nm, round(wrist_bend_of(detector_pose(w, pl), 'Right')))
for name, frames, fn in (('DetectorIdle', 90, detector_idle), ('DetectorWalk', 22, detector_walk),
                         ('DetectorDig', 36, detector_dig)):
    S.clip(name, frames, fn)

# ============================================================================== scrap clips
# A bent offcut of angle iron in the right fist like the spyglass (the bent end out by the thumb), carried low
# right. ScrapThrow: cocked back up by the ear, whipped forward over the top and let go at SC_RELEASE (the game
# hides the piece from there and launches the throw then), following through down and to the left, then back to
# the carry with the next piece.
SC_CONTACT = (lambda bs: lambda p: min(b(p) for b in bs))([box_sdf(lo, hi) for lo, hi in HT.scrap_boxes()])
SC_HAND, SC_M = bar_in_hand('Right', SC_CONTACT, (0, 1, 0), (1, 0, 1), 0, (0.006, 0, 0.006), 'SCRAP')
SC_GRIP = grasp('Right', in_rest(SC_M, SC_CONTACT), wrap=SC_M.to_3x3() @ V((0, 1, 0)))
SC_OPEN = curl_pose('Right', 22, 10)
SC_RELEASE = 0.42
SC_CARRY = carry_hand((0.17, 0.35, -0.17), (-0.35, 0.55, 0.75), 18)
# (p, wrist, thumb side, ulnar bend, elbow pole) in view space, the hand in line with the forearm; None: the carry
SC_THROW = [(0.0, None),
            (0.30, (0.22, 0.27, 0.07), (-0.6, 0.4, 0.1), 10, (0.9, 0.0, -0.1)),  # cocked up by the ear
            (SC_RELEASE, (0.12, 0.40, 0.04), (-0.8, 0.0, 0.6), 0, (0.6, 0.0, -0.5)),  # let go, forward and up
            (0.64, (0.0, 0.36, -0.26), (-0.8, 0.3, 0.3), 10, R_POLE),  # followed through, down left
            (1.0, None)]
SC_HANDS = [SC_CARRY if k[1] is None else carry_hand(*k[1:]) for k in SC_THROW]
SC_POLES = [R_POLE if k[1] is None else k[4] for k in SC_THROW]


def scrap_pose(hw, pole, grip, sway=None):
    return held_pose([('Right', hw, pole, 0.75, grip)], sway)


def scrap_idle(p):
    return scrap_pose(SC_CARRY, SC_POLES[0], SC_GRIP, idle_sway(p)), (0, 0, 0)


def scrap_walk(p):
    return scrap_pose(SC_CARRY, SC_POLES[0], SC_GRIP, walk_sway(p)), (0, 0, 0)


def scrap_throw(p):
    i = next(j for j in range(len(SC_THROW) - 1) if p <= SC_THROW[j + 1][0])
    p0, p1 = SC_THROW[i][0], SC_THROW[i + 1][0]
    f = max(0.0, min(1.0, (p - p0) / (p1 - p0)))
    f = f * f * (3 - 2 * f)
    hw = mat_lerp(SC_HANDS[i], SC_HANDS[i + 1], f)
    pole = V(SC_POLES[i]).lerp(V(SC_POLES[i + 1]), f)
    o = max(0.0, min(1.0, (p - SC_RELEASE) / 0.08))  # the fingers open as it leaves
    c = max(0.0, min(1.0, (p - 0.8) / 0.2))  # and close round the next piece on the way back
    grip = grip_blend(SC_GRIP, SC_OPEN, o * (1 - c))
    return scrap_pose(hw, pole, grip, rot((X, -4 * math.sin(math.pi * p)))), (0, 0, 0)


for i, k in enumerate(SC_THROW[:-1]):
    print('WRIST scrap', k[0], round(wrist_bend_of(scrap_pose(SC_HANDS[i], SC_POLES[i], SC_GRIP), 'Right')))
for name, frames, fn in (('ScrapIdle', 90, scrap_idle), ('ScrapWalk', 22, scrap_walk)):
    S.clip(name, frames, fn)
clip_once('ScrapThrow', 15, scrap_throw)  # 16 keys, 0.5 s

# ============================================================================== jammer clips
# The jammer (src/models/jammer.ts, built in three.js in the pistol's frame) is described here only for its grip:
# the raked grip under a squat body. Natural frame = the pistol's (three.js x, y, z -> natural -x, z, y).
# JammerIdle / JammerWalk carry it low right like the pistol; JammerAim (scrubbed by the use button, src/jammer.ts)
# brings it up in front at chest height in both hands, the left palm under the body, the antenna on the crosshair.
JG = SimpleNamespace(RAKE=28, GRIP_AXIS=V((0, math.sin(math.radians(28)), math.cos(math.radians(28)))),
                     GRIP_TOP=0.044, GRIP_BOT=-0.050, GRIP_R=0.0165)
J_BODY = ((-0.024, -0.04, 0.044), (0.024, 0.11, 0.088))
J_TIP = V((0, 0.31, 0.066))  # end of the yagi boom
J_SDF_NAT = (lambda g, b, u, t: lambda p: min(g(p), b(p), u(p), t(p)))(
    capsule_sdf(JG.GRIP_AXIS * JG.GRIP_BOT, JG.GRIP_AXIS * JG.GRIP_TOP, JG.GRIP_R), box_sdf(*J_BODY),
    box_sdf((-0.025, -0.01, 0.040), (0.025, 0.10, 0.048)), box_sdf((-0.003, 0.02, 0.027), (0.003, 0.05, 0.033)))


def jammer_ready(at, roll, pitch_off=0.0, dist=45.0):
    """Jammer at `at` with its antenna on the crosshair (as pistol_ready, for the boom's tip)."""
    T = V((0, dist * math.cos(0.05), dist * math.sin(0.05)))
    w = rifle_world(at, roll=roll)
    for _ in range(4):
        d = (T - w @ J_TIP).normalized()
        w = rifle_world(at, math.degrees(math.atan2(-d.x, d.y)), math.degrees(math.asin(d.z)) + pitch_off, roll)
    return w


J_READY = jammer_ready((0.15, 0.30, -0.17), -6, -4)
J_AIM = jammer_ready((0.07, 0.33, -0.15), -2)


def j_cost(yaw):
    h = gun_in_right(JG, J_SDF_NAT, yaw, 'JAMMER')[0]
    return sum(best_pole('Right', w @ h.inverted(), 0.75)[1] for w in (J_READY, J_AIM))


J_YAW = min(range(-40, 41, 5), key=j_cost)
J_HAND, J_SDF, J_AXIS = gun_in_right(JG, J_SDF_NAT, J_YAW, 'JAMMER')
print('JAMMER yaw', J_YAW)
J_GRIP = grasp('Right', J_SDF, wrap=J_AXIS)
J_BODY_CONTACT = box_sdf(*J_BODY)


def jl_rel(roll, label=None):
    return bar_in_hand('Left', J_BODY_CONTACT, (0, 1, 0), (0, 0, 1), roll, (0, 0.075, 0.044), label)


JL_ROLL = min(range(-60, 61, 15), key=lambda r: best_pole('Left', J_AIM @ jl_rel(r)[0].inverted(), L_TWIST)[1])
JL_HAND, JL_M = jl_rel(JL_ROLL, 'JAMMER')
JL_GRIP = grasp('Left', in_rest(JL_M, J_SDF_NAT))
J_POLE = best_pole('Right', J_READY @ J_HAND.inverted(), 0.75)[0]
J_POLE_AIM = best_pole('Right', J_AIM @ J_HAND.inverted(), 0.75)[0]
JL_POLE_AIM = best_pole('Left', J_AIM @ JL_HAND.inverted(), L_TWIST)[0]
JL_LOW = left_hand_world(*L_LOW)
JL_REST = curl_pose('Left', 12)


def jammer_pose(jw, pole=None, sway=None):
    return held_pose([('Right', jw @ J_HAND.inverted(), pole or J_POLE, 0.75, J_GRIP)], sway)


def jammer_idle(p):
    return jammer_pose(J_READY, sway=idle_sway(p)), (0, 0, 0)


def jammer_walk(p):
    return jammer_pose(J_READY, sway=walk_sway(p)), (0, 0, 0)


def jammer_aim(p):
    f = p * p * (3 - 2 * p)
    jw = mat_lerp(J_READY, J_AIM, f)
    jw.translation += V((0, 0.0, 0.02)) * math.sin(math.pi * p)
    lf = max(0.0, min(1.0, (p - 0.15) / 0.85))
    lf = lf * lf * (3 - 2 * lf)
    lw = mat_lerp(JL_LOW, J_AIM @ JL_HAND.inverted(), lf)
    lw.translation += V((0, 0.0, -0.06)) * math.sin(math.pi * lf)  # up from below, not through the jammer
    pose = held_pose([('Right', jw @ J_HAND.inverted(), V(J_POLE).lerp(V(J_POLE_AIM), f), 0.75, J_GRIP),
                      ('Left', lw, V(L_POLE).lerp(V(JL_POLE_AIM), lf), 0.6 + (L_TWIST - 0.6) * lf,
                       grip_blend(JL_REST, JL_GRIP, lf))], rot((Z, 0.6 * math.sin(1) * (1 - p))))
    return pose, (0, 0, 0)


print('WRIST jammer ready', round(wrist_bend_of(jammer_pose(J_READY), 'Right')))
ps = jammer_aim(1.0)[0]
print('WRIST jammer aim right', round(wrist_bend_of(ps, 'Right')), 'left', round(wrist_bend_of(ps, 'Left')))
for name, frames, fn in (('JammerIdle', 90, jammer_idle), ('JammerWalk', 22, jammer_walk)):
    S.clip(name, frames, fn)
clip_once('JammerAim', 8, jammer_aim)  # 9 keys, 0.27 s
for pb in rig.pose.bones:
    pb.rotation_quaternion = Quaternion()

# canteen: built far from the hands so neither bake shades the other, baked after the hands so they keep
# the 'PlayerTint' material name, exported alone, then parented to the right hand.
CAN_AT = V((5.0, 0.0, 0.9))
can = CT.build(CAN_AT)
TEL_AT = V((-5.0, 0.0, 0.9))
tel = TS.build(TEL_AT)
RIF_AT = V((0.0, 5.0, 0.9))
rif, rif_glow = RF.build(RIF_AT)
PIS_AT = V((0.0, -5.0, 0.9))
pis, pis_glow = PS.build(PIS_AT)
TOOLS = [(HT.build_shovel, V((5.0, 5.0, 0.9)), 'shovel', SV_RHAND), (HT.build_detector, V((-5.0, 5.0, 0.9)), 'detector', DT_HAND),
         (HT.build_scrap, V((5.0, -5.0, 0.9)), 'scrap', SC_HAND)]
tools = [(f(at), at, pre, m) for f, at, pre, m in TOOLS]

import bake  # noqa: E402

if FAST:  # pose checks only (render_hand.py): flat double-sided colours, no atlases for the body and tools
    def flat(o, rgb):
        m = bpy.data.materials.new('Fast' + o.name)
        m.use_nodes = True
        m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*rgb, 1)
        m.use_backface_culling = False
        o.data.materials.clear()
        o.data.materials.append(m)

    flat(body, (0.45, 0.28, 0.16))
    for (o, at, _, _), rgb in zip(tools, ((0.5, 0.5, 0.45), (0.25, 0.3, 0.15), (0.45, 0.2, 0.1))):
        HT.unplace(o, at)
        flat(o, rgb)
else:
    bake.bake_atlas(body, 1024, S.OUT_DIR, tint_name='Tint', small=0, prefix='hands')
    for o, at, pre, _ in tools:
        HT.bake_and_export(o, S.OUT_DIR, at, pre)
CT.bake_and_export(can, S.OUT_DIR, os.path.join(S.ROOT, 'public', 'models', 'canteen.glb'), CAN_AT)
tel_parts = TS.bake_and_export(tel, S.OUT_DIR, os.path.join(S.ROOT, 'public', 'models', 'telescope.glb'), TEL_AT)
rif = RF.bake_and_export(rif, rif_glow, S.OUT_DIR, os.path.join(S.ROOT, 'public', 'models', 'rifle.glb'), RIF_AT)
pis = PS.bake_and_export(pis, pis_glow, S.OUT_DIR, os.path.join(S.ROOT, 'public', 'models', 'pistol.glb'), PIS_AT)
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
rif.parent = rig
rif.parent_type = 'BONE'
rif.parent_bone = 'RightHand'
rif.matrix_parent_inverse = Matrix.Identity(4)
rif.matrix_basis = Matrix.Translation((0, -BONES['RightHand'].length, 0)) @ R_HAND @ RF.FLIP
pis.parent = rig
pis.parent_type = 'BONE'
pis.parent_bone = 'RightHand'
pis.matrix_parent_inverse = Matrix.Identity(4)
pis.matrix_basis = Matrix.Translation((0, -BONES['RightHand'].length, 0)) @ P_HAND @ PS.FLIP


def on_right_hand(o, m):
    o.parent = rig
    o.parent_type = 'BONE'
    o.parent_bone = 'RightHand'
    o.matrix_parent_inverse = Matrix.Identity(4)
    o.matrix_basis = Matrix.Translation((0, -BONES['RightHand'].length, 0)) @ m


for o, _, _, m in tools:
    on_right_hand(o, m)
# where the jammer (src/models/jammer.ts, in the pistol's glTF frame) goes in the right hand
jmount = bpy.data.objects.new('JammerMount', None)
bpy.context.scene.collection.objects.link(jmount)
on_right_hand(jmount, J_HAND @ PS.FLIP)
extra = [o for o, _, _, _ in tools] + [jmount]
if FAST:  # a stand-in jammer from its boxes, to look at the grip
    jp = join([rounded_box('JammerProxy', c, sz, S.M['brass'], bevel=0.002, segments=1) for c, sz in (
        ((0, 0.035, 0.066), (0.048, 0.15, 0.044)), ((0, 0.045, 0.044), (0.05, 0.11, 0.008)),
        ((0, 0.20, 0.066), (0.12, 0.2, 0.006)))] + [cylinder('JammerProxyGrip', JG.GRIP_AXIS * JG.GRIP_BOT,
                                                               JG.GRIP_AXIS * JG.GRIP_TOP, 0.016, S.M['brass'])],
            'JammerProxy')
    flat(jp, (0.3, 0.32, 0.18))
    on_right_hand(jp, J_HAND)
    extra.append(jp)
# marker nodes on the rifle (mesh frame = natural turned by FLIP; identity rotation, so their glTF +Z is
# the bore direction, towards the muzzle)
marks = []
for nm, p in (('RifleMuzzle', RF.muzzle_local()), ('RifleEye', RF.eye_local(EYE_RELIEF))):
    e = bpy.data.objects.new(nm, None)
    bpy.context.scene.collection.objects.link(e)
    e.parent = rif
    e.matrix_parent_inverse = Matrix.Identity(4)
    e.matrix_basis = Matrix.Translation(RF.FLIP.to_3x3() @ p)
    marks.append(e)
for nm, p in (('PistolMuzzle', PS.muzzle_local()), ('PistolEye', PS.eye_local(P_RELIEF))):
    e = bpy.data.objects.new(nm, None)
    bpy.context.scene.collection.objects.link(e)
    e.parent = pis
    e.matrix_parent_inverse = Matrix.Identity(4)
    e.matrix_basis = Matrix.Translation(PS.FLIP.to_3x3() @ p)
    marks.append(e)


def check_aim(label='RIFLE', clip='RifleAim', muzzle=0, eye=1):
    """Where the eye marker and the bore end up in the last frame of an aim clip (view space: eye at the
    origin, +Y forward)."""
    act = bpy.data.actions[clip]
    rig.animation_data.action = act
    if hasattr(rig.animation_data, 'action_slot') and act.slots:
        rig.animation_data.action_slot = act.slots[0]
    for t in rig.animation_data.nla_tracks:
        t.mute = True
    bpy.context.scene.frame_set(int(act.frame_range[1]))
    bpy.context.view_layer.update()
    fwd = (marks[eye].matrix_world.to_3x3() @ V((0, -1, 0))).normalized()  # mesh -Y = muzzle
    eye = marks[eye].matrix_world.translation
    ang = math.degrees(fwd.angle(V((0, 1, 0))))
    print(label, 'AIM eye offset (model m) right %.4f up %.4f fwd %.4f  lateral %.1f mm  sight axis vs view %.3f deg'
          % (eye.x, eye.z, eye.y, math.hypot(eye.x, eye.z) * 1000, ang))
    mz = marks[muzzle].matrix_world.translation
    print(label, 'AIM muzzle at', tuple(round(x, 3) for x in mz))
    rig.animation_data.action = None
    for pb in rig.pose.bones:
        pb.rotation_quaternion = Quaternion()
    bpy.context.view_layer.update()


check_aim()
check_aim('PISTOL', 'PistolAim', 2, 3)
bake.export(rig, [body, can, *tel_parts, rif, pis, *marks, *extra], OUT)
print('TRIS_FINAL', tri_count(body), 'CANTEEN', tri_count(can), 'TELESCOPE', tri_count(tel), 'RIFLE', tri_count(rif),
      'PISTOL', tri_count(pis))
