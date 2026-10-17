# Close-up renders of the first-person viewmodel's right hand, to check grips (see docs/viewmodel-hands.md).
#
#   Blender -b --factory-startup -P tools/models/render_hand.py -- public/models/hands.glb <out_prefix> \
#       TelescopeIdle:0,TelescopeRaise:5,CanteenIdle:0 [distance_scale]
#
# For each Clip:frame writes <out_prefix>_<Clip><frame>_<view>.png: `fp` from the eye (game FOV) and the
# hand seen from `eye`, `above`, `out`, `front`, `low`. Eevee, a few seconds per frame. Props not used by
# the clip are hidden. Tile them with ffmpeg xstack and look at one image.
import math, sys, bpy
from mathutils import Vector
A = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=A[0])
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x, sc.render.resolution_y = 640, 480
sc.view_settings.view_transform = 'AgX'
w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.45, 0.35, 0.28, 1)
sd = bpy.data.lights.new('S', 'SUN'); sd.energy = 4; s = bpy.data.objects.new('S', sd); sc.collection.objects.link(s)
s.rotation_euler = (math.radians(50), 0, math.radians(200))
cd = bpy.data.cameras.new('C'); cam = bpy.data.objects.new('C', cd); sc.collection.objects.link(cam); sc.camera = cam
cd.clip_start = 0.01
arm = next(o for o in sc.objects if o.type == 'ARMATURE')
for t in arm.animation_data.nla_tracks: t.mute = True
def hand_pos():
    pb = arm.pose.bones['RightHand']
    return arm.matrix_world @ pb.tail
for spec in A[2].split(','):
    name, fr = spec.split(':')
    act = next(a for a in bpy.data.actions if a.name.startswith(name))
    arm.animation_data.action = act
    if act.slots: arm.animation_data.action_slot = act.slots[0]
    for o in sc.objects:
        if o.name.startswith('Canteen'): o.hide_render = not (name.startswith('Canteen') or name in ('Drink', 'Fill'))
        if o.name.startswith('Telescope'): o.hide_render = not name.startswith('Telescope')
        if o.name.startswith('Rifle'): o.hide_render = not name.startswith('Rifle')
    sc.frame_set(int(fr)); bpy.context.view_layer.update()
    h = hand_pos()
    views = {'fp': None, 'eye': Vector((-0.15, -0.2, 0.1)), 'above': Vector((0.02, 0.0, 0.25)), 'out': Vector((0.25, -0.05, 0.05)), 'front': Vector((-0.05, 0.28, 0.0)), 'low': Vector((0.12, 0.12, -0.2))}
    for vn, off in views.items():
        if off is None:
            cam.location = (0, 0, 0); cam.rotation_euler = (math.radians(90), 0, 0)
            cd.sensor_fit = 'VERTICAL'; cd.sensor_height = 20.25; cd.lens = 17.5
        else:
            cd.lens = 35; cam.location = h + off * float(A[3] if len(A) > 3 else 1)
            cam.rotation_euler = (h - cam.location).to_track_quat('-Z', 'Z').to_euler()
        sc.render.filepath = f'{A[1]}_{name}{fr}_{vn}.png'
        bpy.ops.render.render(write_still=True)
