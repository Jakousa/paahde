"""Strip obsolete embedded tools from hands.glb without changing bone/node indices or retained animation data."""
import json
import struct
import sys
from pathlib import Path


def prune_hands(filename):
    path = Path(filename)
    raw = path.read_bytes()
    magic, version, total = struct.unpack_from('<III', raw)
    if magic != 0x46546C67 or version != 2 or total != len(raw):
        raise ValueError('Expected a complete glTF 2 binary')
    json_size, kind = struct.unpack_from('<II', raw, 12)
    if kind != 0x4E4F534A:
        raise ValueError('Missing glTF JSON chunk')
    doc = json.loads(raw[20:20 + json_size])
    bin_start = 20 + json_size
    bin_size, kind = struct.unpack_from('<II', raw, bin_start)
    if kind != 0x004E4942 or len(doc['buffers']) != 1:
        raise ValueError('Expected one embedded binary buffer')
    binary = raw[bin_start + 8:bin_start + 8 + bin_size]
    nodes = doc.get('nodes', [])
    def remove_mesh(index):
        node = nodes[index]
        node.pop('mesh', None)
        for child in node.get('children', []):
            remove_mesh(child)
    for index, node in enumerate(nodes):
        if node.get('name') in ('Shovel', 'Detector'):
            remove_mesh(index)
    doc['animations'] = [a for a in doc.get('animations', []) if not a.get('name', '').startswith(('Shovel', 'Detector'))]

    def compact(table, used):
        old = doc.get(table, [])
        kept = sorted(used)
        mapping = {before: after for after, before in enumerate(kept)}
        doc[table] = [old[i] for i in kept]
        return mapping

    remap = compact('meshes', {n['mesh'] for n in nodes if 'mesh' in n})
    for n in nodes:
        if 'mesh' in n:
            n['mesh'] = remap[n['mesh']]
    primitives = [p for mesh in doc['meshes'] for p in mesh['primitives']]
    remap = compact('materials', {p['material'] for p in primitives if 'material' in p})
    for p in primitives:
        if 'material' in p:
            p['material'] = remap[p['material']]

    texture_infos = []
    def find_textures(value, key=''):
        if isinstance(value, dict):
            if key.endswith('Texture') and 'index' in value:
                texture_infos.append(value)
            for name, child in value.items():
                find_textures(child, name)
        elif isinstance(value, list):
            for child in value:
                find_textures(child)
    find_textures(doc['materials'])
    remap = compact('textures', {info['index'] for info in texture_infos})
    for info in texture_infos:
        info['index'] = remap[info['index']]
    sources = []
    for tex in doc['textures']:
        if 'source' in tex:
            sources.append(tex)
        for ext in tex.get('extensions', {}).values():
            if 'source' in ext:
                sources.append(ext)
    remap = compact('images', {source['source'] for source in sources})
    for source in sources:
        source['source'] = remap[source['source']]

    accessor_refs = []
    for primitive in primitives:
        accessor_refs.extend((primitive['attributes'], k) for k in primitive['attributes'])
        if 'indices' in primitive:
            accessor_refs.append((primitive, 'indices'))
        for target in primitive.get('targets', []):
            accessor_refs.extend((target, k) for k in target)
    for skin in doc.get('skins', []):
        if 'inverseBindMatrices' in skin:
            accessor_refs.append((skin, 'inverseBindMatrices'))
    for animation in doc['animations']:
        for sampler in animation['samplers']:
            accessor_refs.extend(((sampler, 'input'), (sampler, 'output')))
    remap = compact('accessors', {obj[key] for obj, key in accessor_refs})
    for obj, key in accessor_refs:
        obj[key] = remap[obj[key]]
    views = []
    for obj in doc['accessors'] + doc['images']:
        if 'bufferView' in obj:
            views.append(obj)
        if 'sparse' in obj:
            views.extend((obj['sparse']['indices'], obj['sparse']['values']))
    remap = compact('bufferViews', {obj['bufferView'] for obj in views})
    for obj in views:
        obj['bufferView'] = remap[obj['bufferView']]
    packed = bytearray()
    for view in doc['bufferViews']:
        packed.extend(b'\0' * (-len(packed) % 4))
        start = view.get('byteOffset', 0)
        data = binary[start:start + view['byteLength']]
        view['buffer'] = 0
        view['byteOffset'] = len(packed)
        packed.extend(data)
    doc['buffers'][0]['byteLength'] = len(packed)
    encoded = json.dumps(doc, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    packed.extend(b'\0' * (-len(packed) % 4))
    result = struct.pack('<III', magic, 2, 28 + len(encoded) + len(packed))
    result += struct.pack('<II', len(encoded), 0x4E4F534A) + encoded
    result += struct.pack('<II', len(packed), 0x004E4942) + packed
    path.write_bytes(result)
    print(f'{path.name}: {len(raw):,} -> {len(result):,} bytes; {len(doc["images"])} retained images')


if __name__ == '__main__':
    prune_hands(sys.argv[1])
