"""Original Postcreator structured Blender adapter. No user-supplied Python/eval."""
import bpy, json, sys, math, os, random, bmesh
from mathutils import Vector, Matrix

request = json.load(open(sys.argv[sys.argv.index('--') + 1], encoding='utf-8'))
op, a = request['operation'], request.get('args', {})
state = request['state']
if op in ('project.save','render.frame','asset.export_glb') and os.path.lexists(a['path']):
    raise ValueError('Output already exists; choose a new filename')
if os.path.isfile(state):
    bpy.ops.wm.open_mainfile(filepath=state, load_ui=False)
elif op != 'project.open':
    bpy.ops.wm.read_factory_settings(use_empty=True)

def num(key, default, lo=-100000, hi=100000):
    v = a.get(key, default)
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
        raise ValueError('Invalid ' + key)
    return v

def vec(key, default, size=3):
    v = a.get(key, default)
    if not isinstance(v, list) or len(v) != size or any(isinstance(x, bool) or not isinstance(x, (int,float)) or not math.isfinite(x) or abs(x) > 100000 for x in v):
        raise ValueError('Invalid vector ' + key)
    return v

def obj():
    o = bpy.data.objects.get(a.get('name', ''))
    if o is None: raise ValueError('Object not found')
    return o

def property_animated(data, path):
    animation = getattr(data, 'animation_data', None)
    if not animation: return False
    curves = list(animation.drivers)
    if animation.action: curves.extend(getattr(animation.action, 'fcurves', []))
    for track in animation.nla_tracks:
        for strip in track.strips:
            if strip.action: curves.extend(getattr(strip.action, 'fcurves', []))
    return any(curve.data_path == path for curve in curves)

def socket_animated(tree, socket):
    if not hasattr(socket, 'default_value'): return False
    return property_animated(tree, socket.path_from_id('default_value'))

def color_target(material, alpha=False):
    if not material or not material.use_nodes or not material.node_tree:
        raise ValueError('Color-only editing requires an existing Principled node material')
    if len(material.node_tree.nodes) > 256 or len(material.node_tree.links) > 512:
        raise ValueError('Material exceeds bounded shader inspection limits')
    outputs = [n for n in material.node_tree.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output]
    if len(outputs) != 1:
        raise ValueError('Color-only editing requires one active material output')
    surface = outputs[0].inputs.get('Surface')
    if surface is None or len(surface.links) != 1:
        raise ValueError('Color-only editing requires a directly connected Principled shader')
    shader = surface.links[0].from_node
    if shader.type != 'BSDF_PRINCIPLED' or surface.links[0].from_socket.name != 'BSDF':
        raise ValueError('Custom/toon/mixed shaders require an explicit shader edit; color was not changed')
    base = shader.inputs.get('Base Color')
    opacity = shader.inputs.get('Alpha')
    if base is None or base.is_linked:
        raise ValueError('Connected Base Color cannot be replaced by a constant without changing its texture')
    if socket_animated(material.node_tree, base) or property_animated(material, 'diffuse_color'):
        raise ValueError('Animated/driven color requires an explicit animation edit; color was not changed')
    if alpha and (opacity is None or opacity.is_linked):
        raise ValueError('Connected Alpha cannot be replaced by a constant')
    if alpha and socket_animated(material.node_tree, opacity):
        raise ValueError('Animated/driven Alpha requires an explicit animation edit')
    return shader, base, opacity

def socket_value(socket):
    value = getattr(socket, 'default_value', None)
    if isinstance(value, bool): return value
    if isinstance(value, (int, float)): return value if math.isfinite(value) else None
    if isinstance(value, str): return value[:512]
    try:
        values = list(value)
        if len(values) <= 16 and all(isinstance(x, (int, float)) and math.isfinite(x) for x in values): return values
    except (TypeError, ValueError): pass
    return None

def material_info(o, index):
    slot = o.material_slots[index]; material = slot.material
    data = {'slot':index,'link':slot.link,'material':material.name if material else None,
            'polygonCount':sum(1 for p in o.data.polygons if p.material_index == index)}
    if not material: return dict(data, supportedColorEdit=False, reason='Material slot is empty')
    data.update(users=material.users, diffuseColor=list(material.diffuse_color), useNodes=material.use_nodes)
    try:
        color_target(material)
        data['supportedColorEdit'] = True
    except ValueError as error:
        data.update(supportedColorEdit=False, reason=str(error))
    if material.use_nodes and material.node_tree:
        nodes = material.node_tree.nodes; links = material.node_tree.links
        if len(nodes) > 256 or len(links) > 512: raise ValueError('Material exceeds bounded shader inspection limits')
        data['nodes'] = [{'name':n.name,'type':n.bl_idname,'inputs':[{'name':s.name,'identifier':s.identifier,
                          'linked':s.is_linked,'animated':socket_animated(material.node_tree,s),'value':socket_value(s)} for s in n.inputs]} for n in nodes]
        data['links'] = [{'fromNode':l.from_node.name,'fromSocket':l.from_socket.identifier,
                          'toNode':l.to_node.name,'toSocket':l.to_socket.identifier} for l in links]
    return data

def material_object():
    o = obj()
    if o.type != 'MESH': raise ValueError('Material operations require a mesh')
    if len(o.material_slots) > 64: raise ValueError('Material operation supports at most 64 slots')
    slot = a.get('slot')
    if slot is not None and (isinstance(slot, bool) or not isinstance(slot, int) or not 0 <= slot < len(o.material_slots)):
        raise ValueError('Material slot index is outside the selected mesh')
    return o, slot

def info():
    return {'version': bpy.app.version_string, 'frame': bpy.context.scene.frame_current, 'objects': [{'name': o.name, 'type': o.type, 'location': list(o.location), 'scale': list(o.scale), 'vertices': len(o.data.vertices) if o.type == 'MESH' else None, 'faces': len(o.data.polygons) if o.type == 'MESH' else None, 'rigidBody': o.rigid_body.type if o.rigid_body else None, 'materials': [m.name for m in o.data.materials if m] if hasattr(o.data, 'materials') else []} for o in bpy.context.scene.objects], 'camera': bpy.context.scene.camera.name if bpy.context.scene.camera else None, 'rigidBodyCacheBaked': bool(bpy.context.scene.rigidbody_world and bpy.context.scene.rigidbody_world.point_cache.is_baked)}

def primitive(kind, name, location, scale):
    operations = {'cube': bpy.ops.mesh.primitive_cube_add, 'sphere': bpy.ops.mesh.primitive_uv_sphere_add, 'plane': bpy.ops.mesh.primitive_plane_add, 'cylinder': bpy.ops.mesh.primitive_cylinder_add, 'torus': bpy.ops.mesh.primitive_torus_add}
    if kind not in operations: raise ValueError('Unknown primitive')
    operations[kind](location=location)
    o = bpy.context.object; o.name = name; o.scale = scale
    return o

result = None
if op == 'status' or op == 'scene.inspect': result = info()
elif op == 'project.open':
    bpy.ops.wm.open_mainfile(filepath=a['path'], load_ui=False); result = info()
elif op == 'project.save':
    bpy.ops.wm.save_as_mainfile(filepath=a['path'], check_existing=False); result = {'path': a['path']}
elif op == 'asset.import_glb':
    before=set(bpy.data.objects);bpy.ops.import_scene.gltf(filepath=a['path']);result={'objects':[o.name for o in bpy.data.objects if o not in before]}
elif op == 'asset.export_glb':
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.context.scene.objects:
        if not o.hide_render and not o.hide_get():o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=a['path'],export_format='GLB',use_selection=True,export_cameras=True,export_lights=True);result={'path':a['path'],'format':'GLB'}
elif op == 'object.create':
    o = primitive(a.get('kind', 'cube'), a.get('name', 'Postcreator object'), vec('location', [0,0,0]), vec('scale', [1,1,1])); result = {'name': o.name}
elif op == 'object.transform':
    o = obj()
    if 'location' in a: o.location = vec('location', [0,0,0])
    if 'scale' in a: o.scale = vec('scale', [1,1,1])
    if 'rotation' in a: o.rotation_euler = [math.radians(x) for x in vec('rotation', [0,0,0])]
    result = {'name': o.name}
elif op == 'material.inspect':
    o, slot = material_object()
    indices = range(len(o.material_slots)) if slot is None else [slot]
    result = {'name':o.name,'meshUsers':o.data.users,'slots':[material_info(o,i) for i in indices]}
elif op == 'material.set_color':
    o, slot = material_object()
    if slot is None:
        if len(o.material_slots) != 1: raise ValueError('Supply an explicit material slot when the mesh has multiple or no slots')
        slot = 0
    color = a.get('color')
    if not isinstance(color, list) or len(color) not in (3,4) or any(isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) or not 0 <= x <= 1 for x in color):
        raise ValueError('Color requires RGB or RGBA channels from 0 through 1')
    material = o.material_slots[slot].material
    # Validate the existing shader before copying any datablock or touching its slots.
    color_target(material, len(color) == 4)
    if o.data.users > 1 or o.data.library: o.data = o.data.copy()
    if material.users > 1 or material.library or sum(s.material == material for s in o.material_slots) > 1:
        material = material.copy(); o.material_slots[slot].material = material
    shader, base, opacity = color_target(material, len(color) == 4)
    base_alpha = color[3] if len(color) == 4 else base.default_value[3]
    diffuse_alpha = color[3] if len(color) == 4 else material.diffuse_color[3]
    base.default_value = list(color[:3]) + [base_alpha]
    material.diffuse_color = list(color[:3]) + [diffuse_alpha]
    if len(color) == 4: opacity.default_value = color[3]
    result = {'name':o.name,'slot':slot,'material':material.name,'baseColor':list(base.default_value),
              'alpha':opacity.default_value if opacity else None}
elif op == 'material.apply':
    o = obj()
    if o.type != 'MESH': raise ValueError('Materials require a mesh')
    if o.data.users > 1: o.data = o.data.copy()
    color = vec('color', [0.4,0.2,0.8,1], 4)
    if any(x < 0 or x > 1 for x in color): raise ValueError('Color channels must be 0..1')
    m = bpy.data.materials.new(a.get('material', 'Postcreator material')); m.use_nodes = True; m.diffuse_color = color
    nodes = m.node_tree.nodes; shader = nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = color; shader.inputs['Roughness'].default_value = num('roughness', 0.5, 0, 1); shader.inputs['Metallic'].default_value = num('metallic', 0, 0, 1)
    if a.get('style') == 'toon':
        # Eevee shader-to-RGB stepped ramp; original editable native nodes.
        rgb = nodes.new('ShaderNodeShaderToRGB'); ramp = nodes.new('ShaderNodeValToRGB'); ramp.color_ramp.interpolation = 'CONSTANT'
        ramp.color_ramp.elements[0].position = 0.25; ramp.color_ramp.elements[0].color = [x * 0.2 for x in color[:3]] + [1]
        ramp.color_ramp.elements[1].position = 0.65; ramp.color_ramp.elements[1].color = color
        m.node_tree.links.new(shader.outputs['BSDF'], rgb.inputs[0]); m.node_tree.links.new(rgb.outputs['Color'], ramp.inputs[0]); m.node_tree.links.new(ramp.outputs['Color'], nodes.get('Material Output').inputs['Surface'])
    o.data.materials.clear(); o.data.materials.append(m)
    for polygon in o.data.polygons: polygon.material_index = 0
    result = {'material': m.name}
elif op == 'camera.create':
    bpy.ops.object.camera_add(location=vec('location', [6,-8,5])); o = bpy.context.object; o.name = a.get('name', 'Postcreator camera'); o.data.lens = num('lens', 50, 1, 400)
    o.rotation_euler = (Vector(vec('target', [0,0,0])) - o.location).to_track_quat('-Z','Y').to_euler(); bpy.context.scene.camera = o; result = {'name': o.name}
elif op == 'light.create':
    bpy.ops.object.light_add(type='AREA', location=vec('location', [3,-4,6])); o = bpy.context.object; o.name = a.get('name', 'Postcreator light'); o.data.energy = num('energy', 1500, 0, 100000); o.data.shape = 'DISK'; o.data.size = num('size', 5, 0.01, 1000)
    o.rotation_euler = (Vector(vec('target', [0,0,0])) - o.location).to_track_quat('-Z','Y').to_euler(); result = {'name': o.name}
elif op == 'animation.explode':
    names = a.get('names', [])
    if not names or len(names) > 200: raise ValueError('Supply 1..200 object names')
    offset = Vector(vec('offset', [0,0,3])); start = int(num('start', 1, 1, 100000)); end = int(num('end', 48, start+1, 100000))
    for index, name in enumerate(names):
        o = bpy.data.objects.get(name)
        if o is None: raise ValueError('Object not found: ' + str(name))
        origin = o.location.copy(); o.keyframe_insert(data_path='location', frame=start); o.location = origin + offset * (index+1); o.keyframe_insert(data_path='location', frame=end); o.location = origin
    bpy.context.scene.frame_end = max(bpy.context.scene.frame_end, end); result = {'objects': names, 'start': start, 'end': end}
elif op == 'simulation.blocks':
    cols = int(num('columns', 3, 1, 12)); rows = int(num('rows', 5, 1, 20)); size = num('size', 1, 0.1, 100)
    prefix = a.get('name', 'Postcreator blocks'); created = []
    for row in range(rows):
        for col in range(cols):
            o = primitive('cube', prefix + '_%d_%d' % (row,col), [(col-(cols-1)/2)*size*1.04,0,(row+0.5)*size*1.04], [size/2]*3)
            bpy.context.view_layer.objects.active = o; bpy.ops.rigidbody.object_add(); o.rigid_body.mass = 1; o.rigid_body.collision_shape = 'BOX'; created.append(o.name)
    ground = primitive('cube', prefix + '_ground', [0,0,-0.25], [cols*size,cols*size,0.25]); bpy.ops.rigidbody.object_add(); ground.rigid_body.type = 'PASSIVE'
    bpy.context.scene.rigidbody_world.point_cache.frame_end = 250; result = {'objects': created, 'simulation': 'editable rigid body block stack; no fracture or bake'}
elif op == 'scene.frame':
    bpy.context.scene.frame_set(int(num('frame', 1, 1, 100000))); result = info()
elif op == 'mesh.fracture':
    source = obj()
    if source.type != 'MESH' or len(source.data.polygons) > 5000: raise ValueError('Fracture requires a closed convex mesh with <=5000 faces')
    base = bmesh.new(); base.from_mesh(source.data); bmesh.ops.recalc_face_normals(base, faces=list(base.faces))
    if any(not edge.is_manifold for edge in base.edges): raise ValueError('Fracture requires a closed manifold mesh')
    volume = abs(base.calc_volume(signed=True))
    if volume < 0.0000001: raise ValueError('Source has no closed volume')
    if any((vertex.co - face.calc_center_median()).dot(face.normal) > 0.0001 for face in base.faces for vertex in base.verts): raise ValueError('This adapter fractures convex mesh parts; separate concave building pieces first')
    count = int(num('cells', 12, 2, 48)); seed = int(num('seed', 1, 0, 2147483647)); gap = num('gap', 0.01, 0, 0.1)
    low = Vector([min(v.co[i] for v in base.verts) for i in range(3)]); high = Vector([max(v.co[i] for v in base.verts) for i in range(3)])
    rng = random.Random(seed); points = []
    for attempt in range(count*100):
        point = Vector([rng.uniform(low[i],high[i]) for i in range(3)])
        if all((point-face.calc_center_median()).dot(face.normal) <= 0 for face in base.faces): points.append(point)
        if len(points) == count: break
    if len(points) != count: raise ValueError('Could not sample fracture cells; choose fewer cells or different geometry')
    created = []; cell_volume = 0
    for index, point in enumerate(points):
        cell = base.copy()
        for other in points:
            if other is point: continue
            normal = (other-point).normalized(); center = (other+point)*0.5
            cut = bmesh.ops.bisect_plane(cell,geom=list(cell.verts)+list(cell.edges)+list(cell.faces),dist=0.00001,plane_co=center,plane_no=normal,clear_outer=True,clear_inner=False)
            edges = [g for g in cut['geom_cut'] if isinstance(g,bmesh.types.BMEdge) and g.is_valid and g.is_boundary]
            if edges: bmesh.ops.holes_fill(cell,edges=edges,sides=0)
            if not cell.faces: break
        if not cell.faces: cell.free(); continue
        bmesh.ops.recalc_face_normals(cell,faces=list(cell.faces)); piece_volume = abs(cell.calc_volume(signed=True))
        if piece_volume < 0.0000001: cell.free(); continue
        if any(not edge.is_manifold for edge in cell.edges): raise ValueError('Fracture generated an open cell; no session changes will be saved')
        center = sum((vertex.co for vertex in cell.verts),Vector())/len(cell.verts)
        for vertex in cell.verts: vertex.co = (vertex.co-center)*(1-gap)
        mesh = bpy.data.meshes.new(source.name+'_fracture_mesh'); cell.to_mesh(mesh); cell.free()
        piece = bpy.data.objects.new(source.name+'_cell_%02d'%index,mesh); bpy.context.collection.objects.link(piece); piece.matrix_world = source.matrix_world @ Matrix.Translation(center)
        for material in source.data.materials: mesh.materials.append(material)
        bpy.ops.object.select_all(action='DESELECT'); piece.select_set(True); bpy.context.view_layer.objects.active=piece; bpy.ops.rigidbody.object_add(); piece.rigid_body.collision_shape='CONVEX_HULL'; piece.rigid_body.mass=max(0.01,piece_volume); piece.rigid_body.use_margin=True; piece.rigid_body.collision_margin=0.001
        created.append({'name':piece.name,'volume':piece_volume,'vertices':len(mesh.vertices),'faces':len(mesh.polygons)}); cell_volume += piece_volume
    base.free()
    if len(created)<2 or abs(cell_volume-volume)/volume > 0.02: raise ValueError('Fracture volume validation failed; no session changes will be saved')
    source.hide_render=True; source.hide_set(True)
    result={'source':source.name,'cells':created,'sourceVolume':volume,'cellVolume':cell_volume,'gap':gap,'seed':seed,'geometry':'closed convex Voronoi cells'}
elif op == 'simulation.body':
    o=obj()
    if o.type!='MESH': raise ValueError('Rigid bodies require a mesh')
    kind=a.get('type','ACTIVE')
    if kind not in ('ACTIVE','PASSIVE'): raise ValueError('Rigid body type must be ACTIVE or PASSIVE')
    bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o
    if not o.rigid_body:bpy.ops.rigidbody.object_add()
    o.rigid_body.type=kind;o.rigid_body.mass=num('mass',1,0.01,100000);o.rigid_body.collision_shape='CONVEX_HULL';result={'name':o.name,'type':kind}
elif op == 'simulation.bake':
    scene=bpy.context.scene; world=scene.rigidbody_world
    if not world: raise ValueError('Create rigid bodies before baking')
    start=int(num('start',1,1,250));end=int(num('end',120,start+1,250));cache=world.point_cache
    if cache.is_baked: raise ValueError('Cache already baked; open a new session copy before changing the simulation')
    if len(world.collection.objects)>256: raise ValueError('Bake requires <=256 rigid bodies')
    scene.frame_start=start;scene.frame_end=end;cache.frame_start=start;cache.frame_end=end
    with bpy.context.temp_override(scene=scene,point_cache=cache): bpy.ops.ptcache.bake(bake=True)
    result={'baked':cache.is_baked,'start':start,'end':end,'bodies':len(world.collection.objects)}
    if not cache.is_baked: raise ValueError('Native point cache was not baked')
elif op == 'render.frame':
    scene = bpy.context.scene
    if not scene.camera: raise ValueError('Create a camera first')
    scene.render.engine = 'BLENDER_EEVEE_NEXT' if bpy.app.version >= (4,2,0) else 'BLENDER_EEVEE'; scene.render.resolution_x = int(num('width', 640, 16, 2048)); scene.render.resolution_y = int(num('height', 360, 16, 2048)); scene.render.resolution_percentage = 100; scene.render.image_settings.file_format = 'PNG'; scene.render.filepath = a['path']; scene.world = scene.world or bpy.data.worlds.new('Postcreator world'); scene.world.color = (0.08,0.08,0.08)
    bpy.ops.render.render(write_still=True); result = {'path': a['path'], 'width': scene.render.resolution_x, 'height': scene.render.resolution_y}
else: raise ValueError('Unknown operation')

if op not in ('status', 'scene.inspect', 'material.inspect', 'project.save', 'render.frame','asset.export_glb'):
    bpy.ops.wm.save_as_mainfile(filepath=state, check_existing=False)
print('POSTCREATOR_RESULT:' + json.dumps(result))
