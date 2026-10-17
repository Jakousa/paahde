# Render preview images of a model under the game's warm low sun (and a neutral overcast light).
#
#   Blender -b --factory-startup -P tools/models/render_preview.py -- <model.glb|.blend> <out_prefix> [options]
#   options: --clips (render a contact strip per animation clip)  --samples N  --size N
import math
import os
import sys

import bpy
from mathutils import Vector

ARGS = sys.argv[sys.argv.index('--') + 1:]
SRC, PREFIX = ARGS[0], ARGS[1]
CLIPS = '--clips' in ARGS
SAMPLES = int(ARGS[ARGS.index('--samples') + 1]) if '--samples' in ARGS else 48
SIZE = int(ARGS[ARGS.index('--size') + 1]) if '--size' in ARGS else 900
os.makedirs(os.path.dirname(os.path.abspath(PREFIX)), exist_ok=True)

if SRC.endswith('.blend'):
    bpy.ops.wm.open_mainfile(filepath=SRC)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=SRC)

sc = bpy.context.scene
sc.render.engine = 'CYCLES'
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
    sc.cycles.device = 'GPU'
except Exception as e:  # noqa: BLE001
    print('GPU unavailable', e)
sc.cycles.samples = SAMPLES
sc.cycles.use_denoising = True
sc.render.resolution_x = SIZE
sc.render.resolution_y = SIZE
sc.render.film_transparent = False
sc.view_settings.view_transform = 'AgX'
sc.view_settings.look = 'AgX - Medium High Contrast'

arm = next((o for o in sc.objects if o.type == 'ARMATURE'), None)

# world: warm dusky sky
world = bpy.data.worlds.new('W')
sc.world = world
world.use_nodes = True
bg = world.node_tree.nodes['Background']

# ground
bpy.ops.mesh.primitive_plane_add(size=60)
ground = bpy.context.active_object
gm = bpy.data.materials.new('Sand')
gm.use_nodes = True
gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.62, 0.30, 0.10, 1)
gm.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.95
ground.data.materials.append(gm)

sun_data = bpy.data.lights.new('Sun', 'SUN')
sun = bpy.data.objects.new('Sun', sun_data)
sc.collection.objects.link(sun)

cam_data = bpy.data.cameras.new('Cam')
cam_data.lens = 70
cam = bpy.data.objects.new('Cam', cam_data)
sc.collection.objects.link(cam)
sc.camera = cam


def look_at(obj, target):
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def light(mode):
    if mode == 'desert':
        bg.inputs['Color'].default_value = (0.55, 0.28, 0.13, 1)
        bg.inputs['Strength'].default_value = 0.55
        sun_data.color = (1.0, 0.72, 0.42)
        sun_data.energy = 5.0
        sun_data.angle = math.radians(1.5)
        sun.rotation_euler = (math.radians(74), 0, math.radians(35))  # ~16° elevation, front-left
    else:
        bg.inputs['Color'].default_value = (0.8, 0.8, 0.8, 1)
        bg.inputs['Strength'].default_value = 1.0
        sun_data.energy = 1.5
        sun_data.color = (1, 1, 1)
        sun_data.angle = math.radians(20)
        sun.rotation_euler = (math.radians(40), 0, math.radians(30))


def shot(path, az, dist=4.6, height=1.05, target_z=0.95, lens=None):
    a = math.radians(az)
    # character faces -Y in Blender (imported glTF: also -Y after Y-up conversion)
    cam.location = (math.sin(a) * dist, -math.cos(a) * dist, height)
    look_at(cam, (0, 0, target_z))
    if lens:
        cam_data.lens = lens
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


def set_action(name, frame):
    if not arm:
        return
    act = bpy.data.actions.get(name)
    if not arm.animation_data:
        arm.animation_data_create()
    for t in arm.animation_data.nla_tracks:
        t.mute = True
    arm.animation_data.action = act
    if act and hasattr(arm.animation_data, 'action_slot') and act.slots:
        arm.animation_data.action_slot = act.slots[0]
    sc.frame_set(frame)


if arm and arm.animation_data:
    for t in arm.animation_data.nla_tracks:
        t.mute = True
    arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)

if not CLIPS:
    set_action('Idle', 0)
    light('desert')
    shot(PREFIX + '_front34.png', -30)
    shot(PREFIX + '_back34.png', 150)
    shot(PREFIX + '_side.png', 90)
    shot(PREFIX + '_face.png', -20, dist=1.6, height=1.65, target_z=1.62)
    light('studio')
    shot(PREFIX + '_studio_front.png', 0)
    shot(PREFIX + '_studio_back.png', 180)
else:
    light('studio')
    sc.render.resolution_x = 420
    sc.render.resolution_y = 520
    sc.cycles.samples = 16
    for name in ['Idle', 'Walk', 'Run', 'Jump', 'Dig', 'Slide']:
        act = bpy.data.actions.get(name)
        if not act:
            # imported glTF actions are named e.g. 'Idle' or 'Idle_Scavenger'
            act = next((a for a in bpy.data.actions if a.name.startswith(name)), None)
        if not act:
            continue
        f0, f1 = act.frame_range
        for k in range(4):
            fr = int(f0 + (f1 - f0) * k / 4)
            set_action(act.name, fr)
            shot(f'{PREFIX}_{name}_{k}.png', 75, dist=5.0, height=1.0, target_z=0.85, lens=60)
print('RENDER DONE')
