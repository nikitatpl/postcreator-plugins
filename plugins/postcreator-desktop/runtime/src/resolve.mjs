import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { run } from './process.mjs';
import { outputPath } from './safety.mjs';

export const RESOLVE_OPS={status:{},'context.inspect':{},'project.create':{context:'inspected active project identity',name:'new Postcreator-prefixed name'},'project.restore':{context:'owned current project identity',name:'previously inspected name'},'project.save':{context:'active identity'},'media.import':{context:'active identity',paths:'existing absolute media paths[]'},'timeline.create':{context:'active identity',name:'new name'},'timeline.append':{context:'active project/timeline IDs',mediaIds:'imported media IDs[]'},'timeline.inspect':{},'color.inspect':{},'color.set_cdl':{context:'active IDs',itemId:'timeline item ID',node:'1-based',slope:'3 channels',offset:'3 channels',power:'3 channels',saturation:'0..10'},'color.set_lut':{context:'active IDs',itemId:'timeline item ID',node:'1-based',path:'existing registered native LUT'},'render.formats':{format:'format key'},'render.queue':{context:'active IDs',path:'new mp4/mov under output root',format:'native key',codec:'native key',width:'16..4096',height:'16..4096'},'render.start':{context:'active IDs',jobId:'companion-created job'},'render.status':{context:'active IDs',jobId:'companion-created job'}};

export function resolveLibrary(executable, platform=process.platform) {
  if(platform==='win32')return path.join(path.dirname(executable),'fusionscript.dll');
  if(platform==='darwin'){
    const bundle=executable.match(/^.*?\.app(?:[\\/]|$)/i)?.[0].replace(/[\\/]$/,'');
    if(!bundle)throw Error('Resolve macOS path must identify its installed .app bundle');
    return path.join(bundle,'Contents','Libraries','Fusion','fusionscript.so');
  }
  return path.resolve(path.dirname(executable),'../libs/Fusion/fusionscript.so');
}

export class ResolveAdapter {
  constructor(host,outputRoot,{runner=run,platform=process.platform}={}) { this.host = host;this.outputRoot=outputRoot;this.jobs=new Set();this.inspected=new Map();this.restoreTargets=new Map();this.runner=runner;this.platform=platform; }
  async call(operation,args={}) {
    if (!Object.hasOwn(RESOLVE_OPS,operation)) throw new Error('Unknown Resolve operation');
    if (!this.host.resolve || !this.host.resolveModule || !this.host.python) throw new Error('Resolve installation, official scripting module and Python runtime required');
    const restoreTarget=operation==='project.restore'?this.restoreTargets.get(args.context?.projectId):null;
    if(operation==='project.restore'&&(!restoreTarget||args.name!==restoreTarget.projectName))throw Error('Restore requires this session’s created active project and its previously inspected original project');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'postcreator-resolve-')); const request = path.join(dir, 'request.json');
    const input={...args};
    if(operation==='render.queue') {
      if(!['mp4','mov'].includes(input.format))throw new Error('Safe render output supports mp4/mov formats');
      input.path=await outputPath(this.outputRoot,input.path,'.'+input.format);
    }
    await writeFile(request, JSON.stringify({ operation, module: this.host.resolveModule,args:input,ownedJobs:[...this.jobs],restoreTarget }));
    const library = resolveLibrary(this.host.resolve,this.platform);
    const timeout=['project.create','project.restore'].includes(operation)?90000:['status','context.inspect','timeline.inspect','color.inspect','render.formats','render.status'].includes(operation)?15000:60000;
    const { stdout } = await this.runner(this.host.python, [fileURLToPath(new URL('../native/resolve.py', import.meta.url)), request], { timeout, env: { ...process.env, RESOLVE_SCRIPT_LIB: process.env.RESOLVE_SCRIPT_LIB || library } });
    const result = stdout.split(/\r?\n/).find(line => line.startsWith('POSTCREATOR_RESULT:')); if (!result) throw new Error('Resolve returned no structured response');
    const data=JSON.parse(result.slice('POSTCREATOR_RESULT:'.length));if(operation==='render.queue')this.jobs.add(data.jobId);
    if(['status','context.inspect','timeline.inspect','color.inspect'].includes(operation)&&data.context?.projectId)this.inspected.set(data.context.projectId,data.context);
    if(operation==='project.create'&&data.context?.projectId){const previous=this.inspected.get(input.context?.projectId);if(previous)this.restoreTargets.set(data.context.projectId,previous);}
    if(operation==='project.restore'){if(data.context?.projectId!==restoreTarget.projectId)throw Error('Restored native project identity differs from the previously inspected original');this.restoreTargets.delete(input.context.projectId);}
    return data;
  }
}
