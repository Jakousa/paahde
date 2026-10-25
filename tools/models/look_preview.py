# Preview a look: open scavenger_fast.blend (scavenger.py --fast: every look piece at once, cloth baked pale), keep only
# the look pieces named (and everything that isn't a look piece), dye the pale cloth, save a .blend for render_preview.py.
#
#   Blender -b --factory-startup -P tools/models/scavenger.py -- --fast
#   Blender -b --factory-startup -P tools/models/look_preview.py -- tools/models/out/scavenger_fast.blend out.blend \
#       Hood,Goggles,FaceWrap,Mantle,Gloves,Boots Robe=d8cdb6,Cape=5a4a3a,Wrap=c8a57a,Tint=7a5a3a
#   Blender -b --factory-startup -P tools/models/render_preview.py -- out.blend <prefix>
#
# Piece names are the LOOK groups of scavenger.py (tagged(...)); dyes multiply the materials named (sRGB hex).
import sys

import bmesh
import bpy

a = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.open_mainfile(filepath=a[0])
keep = {'Look' + k for k in a[2].split(',')} | {'GearBack', 'GearShovel', 'GearCanteen', 'GearSidearm', 'GearScrap'}
for o in bpy.data.objects:
    if o.type != 'MESH':
        continue
    drop = {g.index for g in o.vertex_groups if g.name.startswith('Look') and g.name not in keep}
    if not drop:
        continue
    bm = bmesh.new()
    bm.from_mesh(o.data)
    dl = bm.verts.layers.deform.active
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if any(g in v[dl] for g in drop)], context='VERTS')
    bm.to_mesh(o.data)
    bm.free()
bpy.ops.wm.save_as_mainfile(filepath=a[1])

# optional 4th arg: dyes, e.g. Robe=d8cdb6,Cape=5a4a3a,Wrap=c8a57a,Tint=7a2a20 (multiplied into the pale cloth)
if len(a) > 3 and a[3]:
    def lin(h):
        c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
        return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    for kv in a[3].split(','):
        name, hx = kv.split('=')
        m = bpy.data.materials.get(name)
        if not m:
            continue
        nt = m.node_tree
        p = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
        sock = p.inputs['Base Color']
        src = sock.links[0].from_socket if sock.links else None
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs['Factor'].default_value = 1.0
        A = next(i for i in mix.inputs if i.identifier == 'A_Color')
        Bc = next(i for i in mix.inputs if i.identifier == 'B_Color')
        out = next(o for o in mix.outputs if o.identifier == 'Result_Color')
        if src:
            nt.links.new(src, A)
        Bc.default_value = (*lin(hx), 1)
        nt.links.new(out, sock)
    bpy.ops.wm.save_as_mainfile(filepath=a[1])
