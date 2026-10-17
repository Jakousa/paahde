# Bake procedural Cycles materials of one joined mesh into a packed PBR atlas, then export glTF.
#
# Atlas: base colour (AO multiplied in), normal (tangent), ORM (R=AO, G=roughness, B=metallic).
# Faces that used the material named `tint_name` end up in a separate `PlayerTint` material sharing the
# same textures, so the game can recolour it via material.color (it multiplies the near-white cloth).
import os

import bpy
import numpy as np


def _cycles(samples):
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
    sc.cycles.samples = samples
    sc.cycles.use_denoising = False
    if not sc.world:
        sc.world = bpy.data.worlds.new('BakeWorld')
    sc.world.light_settings.distance = 0.12


def _image(name, size, non_color, float_buffer=True):
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, size, size, alpha=False, float_buffer=float_buffer)
    img.colorspace_settings.name = 'Non-Color' if non_color else 'sRGB'
    return img


def _principled(mat):
    return next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')


def _output(mat):
    return next(n for n in mat.node_tree.nodes if n.type == 'OUTPUT_MATERIAL')


def _route(mat, input_name):
    """Wire the principled input's source into an Emission shader → output (or restore when None)."""
    nt = mat.node_tree
    p, out = _principled(mat), _output(mat)
    em = nt.nodes.get('__bake_emit') or nt.nodes.new('ShaderNodeEmission')
    em.name = '__bake_emit'
    if input_name is None:
        nt.links.new(p.outputs['BSDF'], out.inputs['Surface'])
        return
    sock = p.inputs[input_name]
    for l in list(em.inputs['Color'].links):
        nt.links.remove(l)
    if sock.links:
        nt.links.new(sock.links[0].from_socket, em.inputs['Color'])
    else:
        v = sock.default_value
        em.inputs['Color'].default_value = (v[0], v[1], v[2], 1) if hasattr(v, '__len__') else (v, v, v, 1)
    em.inputs['Strength'].default_value = 1.0
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])


def _px(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


def _set_px(img, arr):
    img.pixels.foreach_set(arr.astype(np.float32).ravel())
    img.update()


def pack_uvs(obj, margin=0.003):
    from sclib import select_only
    me = obj.data
    atlas = me.uv_layers.new(name='Atlas', do_init=True)
    me.uv_layers.active = atlas
    atlas.active_render = True
    select_only([obj])
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(rotate=True, margin=margin, shape_method='CONCAVE')
    bpy.ops.object.mode_set(mode='OBJECT')


def bake_atlas(obj, size, out_dir, tint_name='Tint', small=1024):
    from sclib import select_only
    _cycles(16)
    pack_uvs(obj)
    mats = [m for m in obj.data.materials]
    tint_idx = [i for i, m in enumerate(mats) if m and m.name == tint_name]
    face_tint = np.array([p.material_index in tint_idx for p in obj.data.polygons])

    imgs = {k: _image('atlas_' + k, size, k != 'color') for k in ('color', 'rough', 'metal', 'normal', 'ao')}
    for m in mats:
        n = m.node_tree.nodes.new('ShaderNodeTexImage')
        n.name = '__bake_target'
    select_only([obj])
    sc = bpy.context.scene
    sc.render.bake.margin = 6
    sc.render.bake.use_clear = True

    def target(img):
        for m in mats:
            n = m.node_tree.nodes['__bake_target']
            n.image = img
            m.node_tree.nodes.active = n

    for key, inp, samples in (('color', 'Base Color', 32), ('rough', 'Roughness', 8), ('metal', 'Metallic', 8)):
        sc.cycles.samples = samples
        for m in mats:
            _route(m, inp)
        target(imgs[key])
        print('BAKE', key, flush=True)
        bpy.ops.object.bake(type='EMIT')
    for m in mats:
        _route(m, None)
    sc.cycles.samples = 8
    target(imgs['normal'])
    print('BAKE normal', flush=True)
    bpy.ops.object.bake(type='NORMAL', normal_space='TANGENT')
    sc.cycles.samples = 96
    target(imgs['ao'])
    print('BAKE ao', flush=True)
    bpy.ops.object.bake(type='AO')

    col, ao = _px(imgs['color']), _px(imgs['ao'])
    rough, metal = _px(imgs['rough']), _px(imgs['metal'])
    a = ao[..., :1]
    col[..., :3] *= 0.8 + 0.2 * a  # the materials already darken cavities; this only adds contact shadow
    col[..., :3] = np.clip(col[..., :3], 0, 1)
    col[..., 3] = 1
    # byte images: Blender encodes the (linear) float pixels to the image's colour space on write
    final_col = _image('scavenger_color', size, False, float_buffer=False)
    _set_px(final_col, col)
    orm = np.ones_like(col)
    orm[..., 0], orm[..., 1], orm[..., 2] = ao[..., 0], np.clip(rough[..., 0], 0.05, 1), np.clip(metal[..., 0], 0, 1)
    final_orm = _image('scavenger_orm', size, True, float_buffer=False)
    _set_px(final_orm, orm)
    final_nrm = _image('scavenger_normal', size, True, float_buffer=False)
    _set_px(final_nrm, _px(imgs['normal']))
    for img in (final_orm, final_nrm):
        if small and small < size:
            img.scale(small, small)
    # also save PNGs for inspection (gitignored out/)
    for img in (final_col, final_orm, final_nrm):
        img.filepath_raw = os.path.join(out_dir, img.name + '.png')
        img.file_format = 'PNG'
        img.save()

    # final materials
    def make(name):
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        p = nt.nodes.new('ShaderNodeBsdfPrincipled')
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(p.outputs['BSDF'], out.inputs['Surface'])
        tc = nt.nodes.new('ShaderNodeTexImage')
        tc.image = final_col
        nt.links.new(tc.outputs['Color'], p.inputs['Base Color'])
        to = nt.nodes.new('ShaderNodeTexImage')
        to.image = final_orm
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(to.outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs['Green'], p.inputs['Roughness'])
        nt.links.new(sep.outputs['Blue'], p.inputs['Metallic'])
        g = gltf_output_group()
        gn = nt.nodes.new('ShaderNodeGroup')
        gn.node_tree = g
        nt.links.new(sep.outputs['Red'], gn.inputs['Occlusion'])
        tn = nt.nodes.new('ShaderNodeTexImage')
        tn.image = final_nrm
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], p.inputs['Normal'])
        m.use_backface_culling = False  # robes/hood are single-sided cloth
        return m

    sc_mat, tint_mat = make('Scavenger'), make('PlayerTint')
    obj.data.materials.clear()
    obj.data.materials.append(sc_mat)
    obj.data.materials.append(tint_mat)
    idx = face_tint.astype(np.int32)
    obj.data.polygons.foreach_set('material_index', idx)
    # drop the Detail UVs; only the atlas is exported
    det = obj.data.uv_layers.get('Detail')
    if det:
        obj.data.uv_layers.remove(det)
    obj.data.update()
    return sc_mat


def gltf_output_group():
    g = bpy.data.node_groups.get('glTF Material Output')
    if g:
        return g
    g = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
    g.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    g.nodes.new('NodeGroupInput')
    return g


def export(rig, meshes, path, extra=None):
    from sclib import select_only
    for m in meshes:
        uv = m.data.uv_layers.get('Detail')
        if uv and len(m.data.uv_layers) > 1:
            m.data.uv_layers.remove(uv)
        elif uv:
            uv.name = 'Atlas'
    objs = ([rig] if rig else []) + meshes
    select_only(objs, objs[0])
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    opts = dict(filepath=path, export_format='GLB', use_selection=True, export_image_format='WEBP',
                export_image_quality=82, export_animations=bool(rig), export_animation_mode='ACTIONS',
                export_skins=True, export_morph=False, export_yup=True, export_apply=False,
                export_texcoords=True, export_normals=True, export_tangents=False, export_materials='EXPORT',
                export_cameras=False, export_lights=False, export_extras=False, export_def_bones=False,
                export_optimize_animation_size=True, export_anim_single_armature=True,
                export_reset_pose_bones=True, export_force_sampling=True, export_frame_step=1,
                export_vertex_color='NONE', export_all_vertex_colors=False)
    if extra:
        opts.update(extra)
    opts = {k: v for k, v in opts.items() if k in props or k == 'filepath'}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(**opts)
    print('EXPORTED', path, os.path.getsize(path))
