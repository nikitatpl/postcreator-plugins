import { StdioClient } from './stdio-client.mjs';
import { outputPath, validateAeOperation } from './safety.mjs';
import{AEPanelAdapter}from'./adobe-panel.mjs';
import{AEScriptAdapter}from'./ae-script.mjs';
export class AfterEffectsAdapter {
  constructor(host, outputRoot) { this.host = host; this.outputRoot = outputRoot;this.mode=process.env.POSTCREATOR_AE_TRANSPORT||'script';this.panel=this.mode==='panel'?new AEPanelAdapter(process.env.POSTCREATOR_AE_CONFIG,outputRoot):null;this.script=null; }
  async client() {
    if (!this.host.aeServer || !this.host.afterEffects) throw new Error('AE application and separately licensed local native bridge required. Set POSTCREATOR_AE_PACKAGE and POSTCREATOR_AFTER_EFFECTS');
    if (!this.bridge) this.bridge = new StdioClient(this.host.node, [this.host.aeServer], { ...process.env, AE_MCP_EXE:this.host.afterEffects, AE_MCP_ENABLE_EVAL:'0' });
    await this.bridge.connect(); return this.bridge;
  }
  async call(operation,args = {}) {
    if(this.mode==='script'){
      if(operation==='native.catalog'&&!this.host.afterEffects){const data=await new AEPanelAdapter(null,this.outputRoot).call(operation,args);data.structuredContent.source='postcreator-original-afterfx-script';return data;}
      if(!this.host.afterEffects)throw Error('After Effects application not installed; set POSTCREATOR_AFTER_EFFECTS to its existing executable');
      this.script ||=new AEScriptAdapter(this.host.afterEffects,this.outputRoot);return this.script.call(operation,args);
    }
    if(this.panel)return this.panel.call(operation,args);
    if(this.mode!=='legacy')throw Error('AE transport must be script, panel or explicit legacy');
    if (operation === 'native.do') validateAeOperation(args.operation,args.args);
    const bridge = await this.client();
    if (operation === 'status' || operation === 'project.inspect') return bridge.request('tools/call',{name:'ae_project_info',arguments:{}});
    if (operation === 'native.catalog') {
      const result = await bridge.request('tools/call',{name:'ae_catalog',arguments:args});
      if (result.isError) return result;
      let data = result.structuredContent;
      if (!data) { try { data = JSON.parse(result.content?.find(x => x.type === 'text')?.text); } catch { return result; } }
      if (data?.categories) {
        data = {...data, categories:data.categories.map(cat => {
          const operations = cat.operations.filter(op => {try {validateAeOperation(typeof op === 'string' ? op : op.name); return true;} catch{return false;}});
          return {...cat,operations,operationCount:operations.length};
        }).filter(cat => cat.operations.length)};
        data.totalOperations = data.categories.reduce((sum,cat)=>sum+cat.operations.length,0);
        data.policy = 'Postcreator safe native allowlist'; delete data.undo;
      }
      if (data?.operations) data = {...data,operations:data.operations.filter(op => {try {validateAeOperation(op.name); return true;} catch{return false;}})};
      return {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};
    }
    if (operation === 'native.do') return bridge.request('tools/call',{name:'ae_do',arguments:{operation:args.operation,args:args.args || {}}});
    if (operation === 'project.save') return bridge.request('tools/call',{name:'ae_save_project',arguments:{path:await outputPath(this.outputRoot,args.path,'.aep')}});
    if (operation === 'render.frame') return bridge.request('tools/call',{name:'ae_render_frame',arguments:{compNameOrId:args.comp,time:args.time ?? 0,outPath:await outputPath(this.outputRoot,args.path,'.png')}});
    throw new Error('Unknown After Effects operation');
  }
  close() { this.bridge?.close();this.panel?.close();this.script?.close(); }
}
