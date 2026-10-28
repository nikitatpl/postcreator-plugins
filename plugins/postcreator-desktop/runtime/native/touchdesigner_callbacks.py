"""Original authenticated loopback TD bridge. Only owned workspace operations."""
import json, hmac, re, math, os

NODE_TYPES = ('constantTOP','noiseTOP','nullTOP','levelTOP','compositeTOP','feedbackTOP','transformTOP','renderTOP','textTOP','constantCHOP','noiseCHOP','nullCHOP','mathCHOP','lfoCHOP','boxSOP','sphereSOP','nullSOP','transformSOP','geometryCOMP','cameraCOMP','lightCOMP')
PARAMS = ('value0','value1','value2','value3','amp','freq','period','seed','opacity','brightness1','gamma1','contrast','tx','ty','tz','rx','ry','rz','sx','sy','sz','sizex','sizey','sizez','resx','resy','resolutionw','resolutionh','text','fontsize','r','g','b','alpha','colorr','colorg','colorb','coloralpha','fov','near','far')

def _owned(name):
    if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', name): raise ValueError('Invalid node name')
    node = parent().op('workspace/' + name)
    if node is None: raise ValueError('Owned node not found')
    return node

def onHTTPRequest(dat, request, response):
    response['content-type'] = 'application/json'
    response['Cache-Control'] = 'no-store'
    try:
        if request.get('method') != 'POST' or request.get('uri') != '/postcreator': raise PermissionError('POST /postcreator required')
        headers = {str(k).lower(): str(v) for k,v in request.items()}
        expected = 'Bearer ' + parent().fetch('postcreator_token')
        if not hmac.compare_digest(headers.get('authorization',''), expected): raise PermissionError('Unauthorized')
        data = request.get('data','')
        if len(data) > 65536: raise ValueError('Request too large')
        req = json.loads(data); operation = req['operation']; a = req.get('args',{})
        workspace = parent().op('workspace')
        if operation == 'status': result = {'build': app.build, 'version': app.version, 'workspace': workspace.path, 'bridge': 'postcreator-original-v1'}
        elif operation == 'node.inspect': result = {'nodes': [{'name': n.name, 'type': n.opType, 'inputs': [i.name for i in n.inputs]} for n in workspace.children]}
        elif operation == 'node.create':
            kind = a.get('type'); name = a.get('name')
            if kind not in NODE_TYPES: raise ValueError('Unsupported native node type')
            if len(workspace.children) >= 256: raise ValueError('Owned workspace node limit reached')
            if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}',name): raise ValueError('Invalid node name')
            if workspace.op(name): raise ValueError('Node exists')
            node = workspace.create(kind,name); result = {'path':node.path}
        elif operation == 'node.set_parameter':
            node = _owned(a.get('name')); key = a.get('parameter'); value = a.get('value')
            if key not in PARAMS: raise ValueError('Unsupported parameter')
            if key == 'text':
                if not isinstance(value,str) or len(value)>10000: raise ValueError('Text parameter requires bounded string')
            elif not isinstance(value,(int,float)) or isinstance(value,bool) or not math.isfinite(value) or abs(value)>100000: raise ValueError('Parameter requires bounded finite number')
            if key in ('resx','resy','resolutionw','resolutionh') and (not isinstance(value,int) or not 16 <= value <= 2048): raise ValueError('Resolution must be 16..2048')
            parameter = getattr(node.par,key,None)
            if parameter is None: raise ValueError('Parameter not found')
            parameter.val = value; result = {'path':node.path,'parameter':key,'value':parameter.eval()}
        elif operation == 'node.connect':
            source = _owned(a.get('source')); target = _owned(a.get('target')); index = a.get('input',0)
            if not isinstance(index,int) or not 0 <= index < len(target.inputConnectors): raise ValueError('Invalid input index')
            target.inputConnectors[index].connect(source); result = {'source':source.path,'target':target.path,'input':index}
        elif operation == 'workspace.export':
            root=parent().fetch('postcreator_output_root');file=a.get('path','')
            if not isinstance(root,str) or not isinstance(file,str) or not os.path.isabs(file) or not file.lower().endswith('.tox'):raise ValueError('Paired output root and .tox path required')
            root=os.path.realpath(root);target=os.path.realpath(file)
            if os.path.commonpath([root,target])!=root or os.path.exists(file):raise ValueError('New export must stay inside paired output root')
            workspace.save(file)
            if not os.path.isfile(file):raise ValueError('Native component save produced no file')
            result={'path':file,'component':workspace.path,'format':'tox','openProjectSaved':False}
        else: raise ValueError('Unsupported operation')
        response.update(statusCode=200,statusReason='OK',data=json.dumps({'ok':True,'result':result}))
    except Exception as error:
        response.update(statusCode=401 if isinstance(error,PermissionError) else 400,statusReason='Rejected',data=json.dumps({'ok':False,'error':str(error)}))
    return response
