"""Original narrow wrapper around the host's official Resolve scripting module."""
import json, sys, os, math
request = json.load(open(sys.argv[1], encoding='utf-8'))
sys.path.insert(0, os.path.dirname(request['module']))
import DaVinciResolveScript
resolve = DaVinciResolveScript.scriptapp('Resolve')
if not resolve: raise RuntimeError('Resolve scripting unavailable. Licensed Studio and enabled local scripting may be required; do not change preferences automatically.')
pm = resolve.GetProjectManager(); project = pm.GetCurrentProject()
a=request.get('args',{});operation=request['operation'];timeline=project.GetCurrentTimeline() if project else None
def context(): return {'projectId':project.GetUniqueId() if project else None,'projectName':project.GetName() if project else None,'timelineId':timeline.GetUniqueId() if timeline else None}
def check(timeline_required=False):
    expected=a.get('context')
    if not isinstance(expected,dict) or 'projectId' not in expected or expected.get('projectId')!=context()['projectId']: raise RuntimeError('Stale or missing active project context; inspect before modifying')
    if timeline_required and (not timeline or expected.get('timelineId')!=timeline.GetUniqueId()):raise RuntimeError('Stale or missing active timeline context')
def require(ok,message):
    if not ok:raise RuntimeError(message)
    return ok
def clips(folder):
    found=list(folder.GetClipList() or [])
    for child in folder.GetSubFolderList() or []:found.extend(clips(child))
    if len(found)>2000:raise ValueError('Media pool exceeds adapter inspection limit')
    return found
def items():
    return [item for track in range(1,timeline.GetTrackCount('video')+1) for item in timeline.GetItemListInTrack('video',track) or []]
def item():
    matches=[item for item in items() if item.GetUniqueId()==a.get('itemId')]
    if len(matches)!=1:raise ValueError('Timeline item identity not found')
    return matches[0]
def numeric(value,low,high):
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not low<=value<=high:raise ValueError('Invalid bounded numeric parameter')
    return value
result = {'version': resolve.GetVersionString(), 'product': resolve.GetProductName(), 'project': project.GetName() if project else None, 'page': resolve.GetCurrentPage(),'context':context()}
if operation in ('status','context.inspect'):pass
elif operation == 'project.create':
    check();name=a.get('name','')
    if not isinstance(name,str) or not name.startswith('Postcreator ') or len(name)>120:raise ValueError('New project name must start Postcreator and be <=120 characters')
    project=pm.CreateProject(name);require(project,'Project creation failed; existing names are never replaced');timeline=project.GetCurrentTimeline();result={'context':context()}
elif operation == 'project.restore':
    check();name=a.get('name');target=request.get('restoreTarget')
    require(isinstance(target,dict) and target.get('projectId') and name==target.get('projectName'),'Restore requires the previously inspected project identity')
    project=require(pm.LoadProject(name),'Previously loaded project could not be restored');timeline=project.GetCurrentTimeline()
    require(project.GetUniqueId()==target['projectId'],'Loaded project does not match the previously inspected identity');result={'restored':name,'context':context()}
elif operation == 'project.save':
    check();require(pm.SaveProject(),'Project save failed');result={'saved':True,'context':context()}
elif operation == 'media.import':
    check();paths=a.get('paths',[])
    if not isinstance(paths,list) or not 1<=len(paths)<=50:raise ValueError('Supply 1..50 media file paths')
    for file in paths:
        if not isinstance(file,str) or not os.path.isabs(file) or not os.path.isfile(file) or os.path.splitext(file)[1].lower() not in ('.mp4','.mov','.mkv','.wav','.mp3','.flac','.png','.jpg','.jpeg'):raise ValueError('Expected existing absolute media file')
    normalized=[file.replace('\\','/') for file in paths]
    pool=project.GetMediaPool();imported=pool.ImportMedia([{'FilePath':file} for file in normalized])
    if not imported:
        # Inspect actual pool state before adapting the native SDK calling convention.
        wanted=set(os.path.normcase(os.path.normpath(file)) for file in paths)
        imported=[clip for clip in clips(pool.GetRootFolder()) if os.path.normcase(os.path.normpath(clip.GetClipProperty('File Path') or '')) in wanted]
    if not imported:imported=pool.ImportMedia(normalized) # Official retained compatibility convention for regular files.
    require(imported,'Native media import failed');result={'media':[{'id':clip.GetUniqueId(),'name':clip.GetName()} for clip in imported],'context':context()}
elif operation == 'timeline.create':
    check();name=a.get('name','Postcreator timeline')
    if not isinstance(name,str) or not name or len(name)>120:raise ValueError('Invalid timeline name')
    timeline=project.GetMediaPool().CreateEmptyTimeline(name);require(timeline,'Timeline creation failed');require(project.SetCurrentTimeline(timeline),'Timeline activation failed');result={'context':context()}
elif operation == 'timeline.append':
    check(True);ids=a.get('mediaIds',[])
    if not isinstance(ids,list) or not 1<=len(ids)<=50:raise ValueError('Supply 1..50 imported media IDs')
    pool={clip.GetUniqueId():clip for clip in clips(project.GetMediaPool().GetRootFolder())}
    if any(i not in pool for i in ids):raise ValueError('Media identity not found in this project')
    appended=project.GetMediaPool().AppendToTimeline([{'mediaPoolItem':pool[i]} for i in ids]);require(appended,'Native timeline append failed');result={'items':[{'id':i.GetUniqueId(),'name':i.GetName(),'start':i.GetStart(),'end':i.GetEnd()} for i in appended],'context':context()}
elif operation in ('timeline.inspect','color.inspect'):
    result['timeline']=None if not timeline else {'name':timeline.GetName(),'start':timeline.GetStartFrame(),'end':timeline.GetEndFrame(),'videoTracks':timeline.GetTrackCount('video'),'audioTracks':timeline.GetTrackCount('audio'),'id':timeline.GetUniqueId()}
    if timeline:result['items']=[{'id':i.GetUniqueId(),'name':i.GetName(),'start':i.GetStart(),'end':i.GetEnd(),'nodes':i.GetNodeGraph().GetNumNodes()} for i in items()]
elif operation in ('color.set_cdl','color.set_lut'):
    check(True);clip=item();graph=clip.GetNodeGraph();node=int(numeric(a.get('node',1),1,graph.GetNumNodes()))
    if operation=='color.set_lut':
        file=a.get('path','')
        if not isinstance(file,str) or not os.path.isabs(file) or not os.path.isfile(file) or not file.lower().endswith(('.cube','.3dl')):raise ValueError('Expected existing absolute LUT file')
        require(graph.SetLUT(node,file.replace('\\','/')),'Native LUT assignment failed; LUT must be discovered by Resolve');result={'itemId':clip.GetUniqueId(),'node':node,'lut':graph.GetLUT(node),'context':context()}
    else:
        values={}
        for key,default,lo,hi in [('slope',[1,1,1],0.01,10),('offset',[0,0,0],-2,2),('power',[1,1,1],0.01,10)]:
            v=a.get(key,default)
            if not isinstance(v,list) or len(v)!=3:raise ValueError('CDL vectors require three channels')
            values[key]=' '.join(str(numeric(x,lo,hi)) for x in v)
        cdl={'NodeIndex':node,'Slope':values['slope'],'Offset':values['offset'],'Power':values['power'],'Saturation':numeric(a.get('saturation',1),0,10)}
        require(clip.SetCDL(cdl),'Native CDL assignment failed');result={'itemId':clip.GetUniqueId(),'cdl':cdl,'context':context()}
elif operation == 'render.formats':
    require(project,'Open project required');result={'formats':project.GetRenderFormats(),'codecs':project.GetRenderCodecs(a.get('format','mp4')),'context':context()}
elif operation == 'render.queue':
    check(True);require(not project.IsRenderingInProgress(),'A render is already running')
    file=a['path'];require(not os.path.lexists(file),'Output already exists');width=int(numeric(a.get('width',640),16,4096));height=int(numeric(a.get('height',360),16,4096))
    require(project.SetCurrentRenderFormatAndCodec(a['format'],a['codec']),'Unsupported native format/codec');require(project.SetCurrentRenderMode(1),'Single-clip render mode unavailable')
    settings={'SelectAllFrames':True,'TargetDir':os.path.dirname(file).replace('\\','/'),'CustomName':os.path.splitext(os.path.basename(file))[0],'ExportVideo':True,'ExportAudio':bool(a.get('audio',False)),'FormatWidth':width,'FormatHeight':height}
    require(project.SetRenderSettings(settings),'Native render settings rejected');job=project.AddRenderJob();require(job,'Native render job creation failed');result={'jobId':job,'path':file,'context':context()}
elif operation in ('render.start','render.status'):
    check(True);job=a.get('jobId')
    if job not in request.get('ownedJobs',[]):raise ValueError('Only jobs created by this companion session are supported')
    if operation=='render.start':require(project.StartRendering([job],False),'Native render did not start')
    result={'jobId':job,'status':project.GetRenderJobStatus(job),'rendering':project.IsRenderingInProgress(),'context':context()}
else:raise ValueError('Unknown Resolve operation')
print('POSTCREATOR_RESULT:' + json.dumps(result))
