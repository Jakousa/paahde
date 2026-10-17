# First-person viewmodel: gloved hands + wrapped forearm sleeves, same materials as the scavenger.
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/models/hands.py
#
# Output public/models/hands.glb: clips Idle, Dig, Walk (bob). Parent it to the camera at the origin; it
# extends along the camera's -Z (forward) with the hands ~0.45 m in front, below the eye line.
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
for pb in rig.pose.bones:
    pb.rotation_quaternion = Quaternion()

import bake  # noqa: E402

bake.bake_atlas(body, 1024, S.OUT_DIR, tint_name='Tint', small=0, prefix='hands')
bake.export(rig, [body], OUT)
print('TRIS_FINAL', tri_count(body))
