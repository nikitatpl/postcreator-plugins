import { readFile } from 'node:fs/promises';
import{outputPath}from'./safety.mjs';
export const TD_OPS = { status: {}, 'node.inspect': {}, 'node.create': { type: 'supported TOP/CHOP/SOP/COMP; see bridge source', name: 'new name' }, 'node.set_parameter': { name: 'owned node', parameter: 'safe numeric/text parameter', value: 'constant (no expression)' }, 'node.connect': { source: 'owned name', target: 'owned name', input: 'connector index' },'workspace.export':{path:'new owned .tox under paired output root; preserves open .toe'} };
export class TouchDesignerAdapter {
  constructor(configFile) { this.configFile = configFile; }
  async call(operation, args = {}) {
    if (!Object.hasOwn(TD_OPS, operation)) throw new Error('Unknown TouchDesigner operation');
    if (!this.configFile) throw new Error('TouchDesigner bridge has not been bootstrapped; run companion setup --touchdesigner then bootstrap in a task-owned .toe');
    const config = JSON.parse(await readFile(this.configFile,'utf8'));
    if(operation==='workspace.export')args={...args,path:await outputPath(config.outputRoot,args.path,'.tox')};
    if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid private TD config');
    const response = await fetch(`http://127.0.0.1:${config.port}/postcreator`, { method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${config.token}`}, body:JSON.stringify({operation,args}), signal:AbortSignal.timeout(5000), redirect:'error' });
    const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.error || 'TD bridge rejected request'); return result.result;
  }
}
