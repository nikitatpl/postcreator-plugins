import {PremiereAdapter}from'./premiere.mjs';import{outputPath}from'./safety.mjs';import path from'node:path';import{stat}from'node:fs/promises';
export const AE_NATIVE_OPS={
 'comp.create':{context:'project instance/file/revision',name:'string',width:'16..8192',height:'16..8192',fps:'1..120',duration:'0.01..600 seconds'},'comp.info':{compId:'native item ID'},
 'layer.create_text':{context:'instance/file/revision',compId:'item ID',text:'string',name:'name'},'layer.create_solid':{context:'instance/file/revision',compId:'item ID',color:'RGB 0..1',name:'name'},'layer.create_shape':{context:'instance/file/revision',compId:'item ID',name:'name'},'layer.create_null':{context:'instance/file/revision',compId:'item ID',name:'name'},'layer.create_camera':{context:'instance/file/revision',compId:'item ID',name:'name',position:'3 coordinates'},'layer.create_light':{context:'instance/file/revision',compId:'item ID',name:'name',position:'3 coordinates'},
 'footage.import':{context:'instance/file/revision',path:'absolute media file'},'layer.create_footage':{context:'instance/file/revision',compId:'item ID',itemId:'imported item ID'},'layer.set_parent':{context:'instance/file/revision',compId:'item ID',layerId:'native ID',parentId:'native ID'},'layer.set_blend_mode':{context:'instance/file/revision',compId:'item ID',layerId:'native ID',mode:'NORMAL|ADD|SCREEN|MULTIPLY'},'layer.set_track_matte':{context:'instance/file/revision',compId:'item ID',layerId:'native ID',sourceId:'native ID',mode:'ALPHA|ALPHA_INVERTED|LUMA|LUMA_INVERTED'},
 'transform.set':{context:'instance/file/revision',compId:'item ID',layerId:'native ID',position:'2/3 coords',scale:'2/3 channels',rotation:'degrees'},
 'text.set_content':{context:'instance/file/revision',compId:'item ID',layerId:'native ID',text:'string'},'text.set_style':{context:'instance/file/revision',compId:'item ID',layerId:'native ID',font:'installed font',size:'1..1000',color:'RGB'},
 'shape.add_rect':{context:'instance/file/revision',compId:'item ID',layerId:'native ID',size:'2 px',color:'RGB'},'keyframe.add':{context:'instance/file/revision',compId:'item ID',layerId:'native ID',property:'native property match-name path[]',time:'seconds',value:'number/number[]'},
 'effect.list':{},'effect.add':{context:'instance/file/revision',compId:'item ID',layerId:'native ID',matchName:'installed native effect'},'effect.set_property':{context:'instance/file/revision',compId:'item ID',layerId:'native ID',effectIndex:'1-based',property:'match-name path[]',value:'number/number[]'},
 'mask.add':{context:'instance/file/revision',compId:'item ID',layerId:'native ID',vertices:'2D points[]',mode:'ADD|SUBTRACT',feather:'2px'},'mask.set_path':{context:'instance/file/revision',compId:'item ID',layerId:'native ID',maskIndex:'1-based',vertices:'2D points[]',time:'optional seconds'},
};
export const PS_PANEL_OPS={status:{},'document.inspect':{},'document.open_copy':{path:'existing raster/PSD; opens and duplicates into a companion-owned document'},'document.create':{name:'string',width:'pixels',height:'pixels'},'document.text':{context:'owned documentId',text:'string',x:'pixels',y:'pixels',size:'points'},'layer.duplicate':{context:'owned documentId',layerId:'native ID'},'cleanup.fill':{context:'owned documentId',rectangle:'[left,top,right,bottom] pixels; native Content-Aware Fill'},'document.save':{context:'owned documentId',path:'new .psd under output root'},'asset.export_png':{context:'owned documentId',path:'new preview/output PNG under output root'}};
export class AEPanelAdapter{
 constructor(file,root){this.transport=new PremiereAdapter(file,root,'After Effects');this.root=root;}
 async call(op,args={}){
  if(op==='native.catalog')return {content:[{type:'text',text:JSON.stringify(AE_NATIVE_OPS)}],structuredContent:{source:'postcreator-original-cep',operations:AE_NATIVE_OPS}};
  if(op==='native.do'){
   if(!Object.hasOwn(AE_NATIVE_OPS,args.operation))throw Error('Unknown original AE operation');const input={...args.args};
   if(this.transport.uncertain)return this.transport.request(args.operation,input);
   if(args.operation==='footage.import')await mediaPath(input.path);
   return this.transport.request(args.operation,input);
  }
  if(op==='status'||op==='project.inspect')return this.transport.request('project.inspect',{});
  if(op==='project.save')return this.transport.request('project.save',this.transport.uncertain?args:{...args,path:await outputPath(this.root,args.path,'.aep')});
  if(op==='render.frame')return this.transport.request('render.frame',this.transport.uncertain?args:{...args,path:await outputPath(this.root,args.path,'.png')});
  throw Error('Unknown original AE panel operation');
 }
 close(){this.transport.close();}
}
export class PhotoshopPanelAdapter{
 constructor(file,root){this.transport=new PremiereAdapter(file,root,'Photoshop');this.root=root;}
 async call(op,args={}){if(!Object.hasOwn(PS_PANEL_OPS,op))throw Error('Unknown Photoshop panel operation');if(this.transport.uncertain)return this.transport.request(op,args);const input={...args};if(op==='document.save'||op==='asset.export_png')input.path=await outputPath(this.root,input.path,op==='document.save'?'.psd':'.png');if(op==='document.open_copy')await mediaPath(input.path,true);return this.transport.request(op,input);}
 close(){this.transport.close();}
}
async function mediaPath(file,psd=false){if(typeof file!=='string'||!path.isAbsolute(file)||!['.mp4','.mov','.png','.jpg','.jpeg','.wav','.mp3',...(psd?['.psd']:[])].includes(path.extname(file).toLowerCase())||!(await stat(file)).isFile())throw Error('Expected an existing absolute native media file');}
