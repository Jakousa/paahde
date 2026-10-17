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
#   BinocularsIdle (3 s loop)  binoculars held in both hands at lower chest height, eyepieces to the eye
#   BinocularsWalk (0.73 s loop)  the same hold with the walk bob
#   BinocularsRaise (0.35 s one-shot)  from the BinocularsIdle pose up to the eyes (play clamped; ends with
#     the eyepieces ~10 cm ahead of the eye, just past the game's near plane after the viewmodel scale)
# The canteen one-shots start and end on the CanteenIdle pose (frame 0) so they cross-fade cleanly;
# BinocularsRaise starts on the BinocularsIdle frame-0 pose.
# Mesh nodes `Canteen` (tools/models/canteen.py, own material 'Canteen') and `Binoculars`
# (tools/models/binoculars.py, own material 'Binoculars') are children of the `RightHand` bone, so they
# follow every clip; both are visible by default, the game toggles `.visible`. The script also writes the
# standalone public/models/canteen.glb (origin at the bottom centre, front +Z) and
# public/models/binoculars.glb (origin at the centre, objectives -Z, eyepieces +Z).
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
    for k in ('UpLeg', 'Leg', 'Foot', 'ToeBase'):
        del S.B[pre + k]
S.B['Root'] = ((0, 0.15, -0.25), (0, 0.15, -0.15), None)
S.B = {'Root': S.B.pop('Root'), **S.B}

for s in (1, -1):
    S.build_sleeve(s)
    S.build_glove(s)
for obj, spec in S.PARTS:
    S.apply_weights(obj, spec)
body = join([o for o, _ in S.PARTS], 'Hands_Body')
print('TRIS', tri_count(body))
rig = S.make_rig([body], name='Hands', bones=S.B)
rig.rotation_euler = (0, 0, math.pi)

X, Y, Z = S.X, S.Y, S.Z
rot = S.rot


def fingers(pose, curl):
    for pre, sign in (('Left', 1), ('Right', -1)):
        t = V(hand_frame(sign)[2])
        pose[pre + 'HandIndex1'] = rot((t, -curl * sign))
        pose[pre + 'HandIndex2'] = rot((t, -curl * 1.2 * sign))


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
        t = V(hand_frame(sign)[2])
        curl = 10 + 50 * (1 - r)
        pose[pre + 'HandIndex1'] = rot((t, -curl * sign))
        pose[pre + 'HandIndex2'] = rot((t, -curl * 1.2 * sign))
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


# canteen poses: (grip centre x, y, z, yaw, tilt, roll, pitch)
HOLD = (0.18, 0.40, -0.19, -28, 0, 0, -6)
R_POLE = (0.7, -0.05, -0.35)
L_LOW = ((-0.20, 0.22, -0.62), (0.15, 0.6, -0.5), (0.6, 0.0, 0.1))  # palm, fingers, palm normal: out of view
L_POLE = (-0.7, -0.05, -0.35)


def canteen_pose(cpose, lhand=L_LOW, r_curl=48, l_curl=12, sway=None):
    cm = view_canteen(cpose[:3], *cpose[3:])
    pose = solve_arm('Right', cm @ C_HAND.inverted(), R_POLE)
    pose.update(solve_arm('Left', left_hand_world(*lhand), L_POLE, twist=0.6))
    for pre, sign, curl in (('Left', 1, l_curl), ('Right', -1, r_curl)):
        t = V(hand_frame(sign)[2])
        pose[pre + 'HandIndex1'] = rot((t, -curl * sign))
        pose[pre + 'HandIndex2'] = rot((t, -curl * 1.1 * sign))
    pose['RightHandThumb1'] = rot((V(hand_frame(-1)[0]), 10))
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
    curl = keys([(0, (48,)), (0.3, (55,)), (0.75, (55,)), (1, (48,))], p)[0]
    return canteen_pose(keys(DRINK, p), r_curl=curl), (0, 0, 0)


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

# ============================================================================== binocular clips
# Held like opera glasses: each hand round the outside of its barrel, palm low on the outer side, fingers
# wrapping up and over the top, thumbs underneath. The binoculars ride on the right hand (like the
# canteen); the left hand is placed on the mirrored grip on the left barrel.
import binoculars as BN  # noqa: E402

B_GRIP_R = BN.leather_r(0.0) + 0.007  # barrel axis → palm centre (leather + glove)
B_GRIP_Y = -0.004  # grip point along the barrel (local y, between the two bands)
B_PHI = math.radians(32)  # palm this far below the barrel's side, fingers wrapping up over the top


def binoculars_grip(sign):
    """Palm centre, finger direction and palm normal in the binoculars' local frame for the right (sign = 1)
    or left (sign = -1) hand."""
    c, s_ = math.cos(B_PHI), math.sin(B_PHI)
    palm = V((sign * (BN.BX + B_GRIP_R * c), B_GRIP_Y, -B_GRIP_R * s_))
    return palm, V((sign * s_, 0, c)), V((-sign * c, 0, s_))


def binoculars_in_hand():
    """Binoculars matrix relative to the RightHand bone (head origin)."""
    a, pn, t = hand_frame(-1)
    W = V(S.B['RightHand'][0])
    palm_l, a_l, n_l = binoculars_grip(1)
    c, s_ = math.cos(B_PHI), math.sin(B_PHI)
    xb, zb = -c * pn + s_ * a, s_ * pn + c * a  # from n_l = (-c, 0, s), a_l = (s, 0, c)
    yb = zb.cross(xb)
    print('BINO forward·thumb', round(yb.dot(t), 3))
    m = frame_cols(xb, yb, zb).to_4x4()
    m.translation = (W + a * 0.045 + pn * 0.028) - m.to_3x3() @ palm_l
    return BONES['RightHand'].matrix_local.inverted() @ m


B_HAND = binoculars_in_hand()


def view_binoculars(centre, yaw=0.0, tilt=0.0, roll=0.0):
    """Binoculars world matrix from their centre: roll about the barrels (+ = right side down), yaw about
    Z, tilt about world X (+ = objectives up)."""
    return (Matrix.Translation(V(centre)) @ Matrix.Rotation(math.radians(tilt), 4, 'X') @
            Matrix.Rotation(math.radians(yaw), 4, 'Z') @ Matrix.Rotation(math.radians(roll), 4, 'Y'))


# binocular poses: (centre x, y, z, yaw, tilt, roll)
B_HOLD = (0.0, 0.36, -0.17, 0, -4, 0)
# up to the eyes: eyepieces ~0.095 m ahead (the game scales the viewmodel 0.55 about the eye, near plane 0.05)
B_EYES = (0.0, -BN.EYE_Y + 0.095, -0.012, 0, 0, 0)
B_R_POLE = (0.6, -0.1, -0.5)
B_L_POLE = (-0.6, -0.1, -0.5)


def binoculars_pose(bpose, curl=58, sway=None):
    bm = view_binoculars(bpose[:3], *bpose[3:])
    pose = solve_arm('Right', bm @ B_HAND.inverted(), B_R_POLE)
    palm, fing, nrm = binoculars_grip(-1)
    r3 = bm.to_3x3()
    pose.update(solve_arm('Left', left_hand_world(bm @ palm, r3 @ fing, r3 @ nrm), B_L_POLE, twist=0.6))
    for pre, sign in (('Left', 1), ('Right', -1)):
        t = V(hand_frame(sign)[2])
        pose[pre + 'HandIndex1'] = rot((t, -curl * sign))
        pose[pre + 'HandIndex2'] = rot((t, -curl * 1.1 * sign))
    if sway:
        pose['Root'] = sway
    return pose


def binoculars_idle(p):
    w = 2 * math.pi * p
    return binoculars_pose(B_HOLD, sway=rot((X, 0.9 * math.sin(w)), (Z, 0.6 * math.sin(w + 1)))), (0, 0, 0)


def binoculars_walk(p):
    w = 2 * math.pi * p
    return binoculars_pose(B_HOLD, sway=rot((X, 2.5 * math.sin(2 * w)), (Y, 2.0 * math.sin(w)))), (0, 0, 0)


B_RAISE = [(0.0, B_HOLD), (0.45, (0.0, 0.25, -0.075, 0, 5, 0)), (1.0, B_EYES)]


def binoculars_raise(p):
    sway = rot((Z, 0.6 * math.sin(1) * (1 - p)))  # BinocularsIdle frame 0 → still
    return binoculars_pose(keys(B_RAISE, p), sway=sway), (0, 0, 0)


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


for name, frames, fn in (('BinocularsIdle', 90, binoculars_idle), ('BinocularsWalk', 22, binoculars_walk)):
    S.clip(name, frames, fn)
clip_once('BinocularsRaise', 10, binoculars_raise)  # 11 keys, 0.33 s
for pb in rig.pose.bones:
    pb.rotation_quaternion = Quaternion()

# canteen: built far from the hands so neither bake shades the other, baked after the hands so they keep
# the 'PlayerTint' material name, exported alone, then parented to the right hand.
CAN_AT = V((5.0, 0.0, 0.9))
can = CT.build(CAN_AT)
BINO_AT = V((-5.0, 0.0, 0.9))
bino = BN.build(BINO_AT)

import bake  # noqa: E402

bake.bake_atlas(body, 1024, S.OUT_DIR, tint_name='Tint', small=0, prefix='hands')
CT.bake_and_export(can, S.OUT_DIR, os.path.join(S.ROOT, 'public', 'models', 'canteen.glb'), CAN_AT)
BN.bake_and_export(bino, S.OUT_DIR, os.path.join(S.ROOT, 'public', 'models', 'binoculars.glb'), BINO_AT)
bpy.context.view_layer.update()
can.parent = rig
can.parent_type = 'BONE'
can.parent_bone = 'RightHand'
can.matrix_parent_inverse = Matrix.Identity(4)
can.matrix_basis = Matrix.Translation((0, -BONES['RightHand'].length, 0)) @ C_HAND  # bone parent space = tail
bino.parent = rig
bino.parent_type = 'BONE'
bino.parent_bone = 'RightHand'
bino.matrix_parent_inverse = Matrix.Identity(4)
bino.matrix_basis = Matrix.Translation((0, -BONES['RightHand'].length, 0)) @ B_HAND
bake.export(rig, [body, can, bino], OUT)
print('TRIS_FINAL', tri_count(body), 'CANTEEN', tri_count(can), 'BINOCULARS', tri_count(bino))
