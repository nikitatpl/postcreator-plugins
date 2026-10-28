import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './process.mjs';
import { outputPath } from './safety.mjs';

export const BLENDER_OPS = {
  status: {}, 'scene.inspect': {}, 'project.open': { path: 'absolute .blend input; auto-execution disabled' }, 'project.save': { path: 'new .blend under output root' },
  'object.create': { kind: 'cube|sphere|plane|cylinder|torus', name: 'string', location: '[x,y,z]', scale: '[x,y,z]' },
  'object.transform': { name: 'existing object', location: '[x,y,z]', rotation: 'degrees [x,y,z]', scale: '[x,y,z]' },
  'material.apply': { name: 'mesh', material: 'name', color: '[r,g,b,a] 0..1', roughness: '0..1', metallic: '0..1', style: 'principled|toon (Eevee)' },
  'material.inspect': { name: 'mesh object name', slot: 'optional 0-based slot; reports actual shader properties and connections' },
  'material.set_color': { name: 'mesh object name', slot: '0-based slot required when multiple slots exist', color: 'RGB/RGBA 0..1; RGB preserves alpha; connected/custom shader colors are refused' },
  'camera.create': { name: 'name', location: '[x,y,z]', target: '[x,y,z]', lens: 'mm' }, 'light.create': { name: 'name', location: '[x,y,z]', target: '[x,y,z]', energy: 'watts', size: 'meters' },
  'animation.explode': { names: 'object names[]', offset: '[x,y,z] per object', start: 'frame', end: 'frame' },
  'simulation.blocks': { name: 'prefix', columns: '1..12', rows: '1..20', size: 'meters; creates editable rigid body stack, not fracture' },
  'scene.frame': { frame: 'integer' }, 'render.frame': { path: 'new .png under output root', width: '16..2048', height: '16..2048' },
  'mesh.fracture': { name:'closed convex source mesh <=5000 faces',cells:'2..48 Voronoi cells',seed:'integer',gap:'0..0.1 proportion; preserved source hidden in isolated session' },
  'simulation.body': { name:'mesh',type:'ACTIVE|PASSIVE',mass:'positive' },
  'simulation.bake': { start:'1..250',end:'start+1..250; <=256 bodies; native point cache bake' },
  'asset.import_glb':{path:'existing absolute .glb/.gltf; native geometry import, not Python execution'},'asset.export_glb':{path:'new .glb under output root; visible native scene objects/materials/cameras/lights'},
};
export class BlenderAdapter {
  constructor(executable, outputRoot) { this.executable = executable; this.outputRoot = outputRoot; }
  async call(operation, args = {}) {
    if (!Object.hasOwn(BLENDER_OPS, operation)) throw new Error('Unknown Blender operation');
    if (!this.executable) throw new Error('Blender not installed; set POSTCREATOR_BLENDER to an installed executable');
    if (!this.dir) this.dir = await mkdtemp(path.join(os.tmpdir(), 'postcreator-blender-'));
    const input = { ...args };
    if(['material.inspect','material.set_color'].includes(operation)){
      if(typeof input.name!=='string'||!input.name||input.name.length>200)throw new Error('Material operations require a bounded mesh object name');
      if(input.slot!==undefined&&(!Number.isInteger(input.slot)||input.slot<0||input.slot>63))throw new Error('Material slot must be an integer from 0 through 63');
      if(operation==='material.set_color'&&(!Array.isArray(input.color)||![3,4].includes(input.color.length)||input.color.some(x=>typeof x!=='number'||!Number.isFinite(x)||x<0||x>1)))throw new Error('Color requires three or four finite channels from 0 through 1');
    }
    if (['project.save', 'render.frame','asset.export_glb'].includes(operation)) input.path = await outputPath(this.outputRoot, input.path, operation === 'project.save' ? '.blend' : operation==='asset.export_glb'?'.glb':'.png');
    if(operation==='asset.import_glb'&&(!path.isAbsolute(input.path||'')||!['.glb','.gltf'].includes(path.extname(input.path).toLowerCase())))throw new Error('Expected existing absolute .glb/.gltf');
    if (operation === 'project.open' && (!path.isAbsolute(input.path || '') || !input.path.toLowerCase().endsWith('.blend'))) throw new Error('Expected absolute .blend input');
    const request = path.join(this.dir, 'request.json');
    await writeFile(request, JSON.stringify({ operation, args: input, state: path.join(this.dir, 'session.blend') }));
    const script = fileURLToPath(new URL('../native/blender.py', import.meta.url));
    const { stdout } = await run(this.executable, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', script, '--', request], { timeout: operation === 'render.frame' ? 180000 : 60000 });
    const result = stdout.split(/\r?\n/).find(line => line.startsWith('POSTCREATOR_RESULT:'));
    if (!result) throw new Error('Blender returned no structured result');
    return JSON.parse(result.slice('POSTCREATOR_RESULT:'.length));
  }
}
