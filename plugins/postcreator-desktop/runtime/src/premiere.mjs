import {createServer} from 'node:http';import {readFile,stat,realpath}from'node:fs/promises';import {timingSafeEqual,randomUUID}from'node:crypto';import path from'node:path';
import {outputPath}from'./safety.mjs';
export const PREMIERE_OPS={status:{},'project.inspect':{},'bin.create':{context:'inspected projectId',name:'bin name',parentId:'optional bin nodeId'},'bin.move':{context:'projectId',itemId:'nodeId',parentId:'bin nodeId'},'media.import':{context:'projectId',paths:'absolute existing media[]',binId:'optional native bin nodeId'},'sequence.create':{context:'projectId',name:'sequence name',itemIds:'native media nodeIds[]'},'sequence.insert_clip':{context:'projectId/sequenceId',itemId:'native media nodeId',time:'seconds',videoTrack:'0-based',audioTrack:'0-based'},'project.save_as':{context:'projectId',path:'new .prproj under output root'},'render.export':{context:'projectId/sequenceId',path:'new .mp4 under output root',preset:'existing absolute .epr export preset'}};
const OUTPUT_OPS=new Set(['project.save_as','render.export','project.save','render.frame','document.save','asset.export_png']);
export class PanelUncertainExecutionError extends Error{
 constructor(pending,label){super(`${label} has not returned a correlated native receipt. Recover the dispatched request before submitting another operation`);this.code='native_execution_uncertain';this.requestId=pending.id;this.operation=pending.operation;this.expiresAt=pending.expiresAt;}
}
export class PremiereAdapter{
 constructor(configFile,outputRoot,label='Premiere',{timeoutMs}={}){this.configFile=configFile;this.outputRoot=outputRoot;this.label=label;this.pending=new Map();this.queue=[];this.calls=Promise.resolve();this.uncertain=null;this.completed=new Set();this.timeoutMs=timeoutMs;}
 async start(){
  if(this.server)return;if(!this.configFile)throw new Error(`Original ${this.label} panel requires a signed native installation and private pairing config. No unsigned security settings are changed`);
  const config=JSON.parse(await readFile(this.configFile,'utf8'));if(!/^[a-f0-9]{64}$/.test(config.token)||!Number.isInteger(config.port)||config.port<1024||config.port>65535)throw new Error('Invalid private Premiere config');
  this.config=config;this.server=createServer(async(req,res)=>{
   res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
   const supplied=String(req.headers['x-postcreator-token']||'');if(!/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(config.token))){res.writeHead(401);res.end('{"error":"Unauthorized"}');return;}
   try{
    if(req.method==='GET'&&req.url==='/next'){const request=this.queue.shift()||null;if(request)this.pending.get(request.id).dispatched=true;res.end(JSON.stringify({request}));return;}
    if(req.method==='POST'&&req.url==='/result'){
     let bytes=0,body='';for await(const chunk of req){bytes+=chunk.length;if(bytes>1024*1024)throw Error('Panel response too large');body+=chunk;}
     const data=JSON.parse(body),pending=this.pending.get(data.id);if(!pending){if(this.completed.has(data.id)){res.end('{"ok":true}');return;}throw Error('Unknown or expired request');}if(!pending.dispatched)throw Error('Request was not dispatched');if(!pending.receipt)pending.receipt={result:data.result,error:data.error};clearTimeout(pending.timer);if(!pending.timedOut)pending.resolve(pending.receipt);res.end('{"ok":true}');return;
    }
    res.writeHead(404);res.end('{"error":"Unknown endpoint"}');
   }catch(error){res.writeHead(400);res.end(JSON.stringify({error:error.message}));}
  });
  try{await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(config.port,'127.0.0.1',resolve);});}catch(error){this.server=null;throw error;}
 }
 async call(operation,args={}){
  if(!Object.hasOwn(PREMIERE_OPS,operation))throw Error('Unknown Premiere operation');
  if(this.uncertain)return this.request(operation,args);
  const input={...args};
  if(operation==='project.save_as')input.path=await outputPath(this.outputRoot,input.path,'.prproj');
  if(operation==='render.export'){
   input.path=await outputPath(this.outputRoot,input.path,'.mp4');if(!path.isAbsolute(input.preset||'')||!input.preset.toLowerCase().endsWith('.epr')||!(await stat(input.preset)).isFile())throw Error('Export requires an existing native .epr preset');input.preset=await realpath(input.preset);
  }
  if(operation==='media.import'){
   if(!Array.isArray(input.paths)||!input.paths.length||input.paths.length>50)throw Error('Supply 1..50 native media paths');
   for(const file of input.paths)if(!path.isAbsolute(file)||!['.mp4','.mov','.mkv','.wav','.mp3','.png','.jpg','.jpeg'].includes(path.extname(file).toLowerCase())||!(await stat(file)).isFile())throw Error('Expected existing absolute media files');
  }
  return this.request(operation,input);
 }
 fingerprint(operation,input){const args={...input};if(OUTPUT_OPS.has(operation)&&typeof args.path==='string')args.path=path.resolve(this.outputRoot,args.path);return JSON.stringify({operation,args});}
 async finish(pending){
  const receipt=pending.receipt;if(receipt.error){this.forget(pending);throw Error(receipt.error);}
  if(OUTPUT_OPS.has(pending.operation)){try{const file=await stat(pending.args.path);if(!file.isFile()||!file.size)throw Error('Absent/empty output');}catch{this.uncertain=pending;pending.timedOut=true;throw new PanelUncertainExecutionError(pending,this.label);}}
  this.forget(pending);return receipt.result;
 }
 forget(pending){this.pending.delete(pending.id);this.completed.add(pending.id);if(this.completed.size>256)this.completed.delete(this.completed.values().next().value);if(this.uncertain===pending)this.uncertain=null;}
 request(operation,input={}){
  const call=this.calls.then(()=>this.executeRequest(operation,input));this.calls=call.catch(()=>{});return call;
 }
 async executeRequest(operation,input){
  const fingerprint=this.fingerprint(operation,input);let recovered;
  if(this.uncertain){const previous=this.uncertain;if(!previous.receipt)throw new PanelUncertainExecutionError(previous,this.label);const value=await this.finish(previous);if(fingerprint===previous.fingerprint)return value;if(!['status','project.inspect','document.inspect'].includes(operation))throw Error('Previous native request recovered; inspect its completion before a different operation');recovered={requestId:previous.id,operation:previous.operation,state:'completed'};}
  await this.start();const id=randomUUID(),timeout=this.timeoutMs??(operation.startsWith('render.')||operation==='cleanup.fill'?180000:15000),expiresAt=Date.now()+timeout;
  const pending={id,operation,args:input,fingerprint,expiresAt,dispatched:false,receipt:null,timedOut:false};
  await new Promise((resolve,reject)=>{pending.resolve=resolve;pending.reject=reject;pending.timer=setTimeout(()=>{if(pending.dispatched){pending.timedOut=true;this.uncertain=pending;reject(new PanelUncertainExecutionError(pending,this.label));}else{this.pending.delete(id);this.queue=this.queue.filter(r=>r.id!==id);reject(Error(`${this.label} panel request expired before native dispatch; verify signed panel installation/open state`));}},timeout);this.pending.set(id,pending);this.queue.push({id,operation,args:input,expiresAt});});
  const value=await this.finish(pending);return recovered?{...value,recoveredRequest:recovered}:value;
 }
 close(){for(const p of this.pending.values()){clearTimeout(p.timer);if(p.dispatched){p.timedOut=true;this.uncertain=p;p.reject(new PanelUncertainExecutionError(p,this.label));}else{p.reject(Error('Companion closed'));this.pending.delete(p.id);}}this.queue=[];this.server?.close();this.server=null;}
}
