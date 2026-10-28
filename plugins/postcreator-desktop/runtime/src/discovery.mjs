import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export async function exists(file) { try { await access(file, constants.F_OK); return true; } catch { return false; } }
async function children(root) { try { return (await readdir(root, { withFileTypes: true })).filter(x => x.isDirectory()).map(x => path.join(root, x.name)).sort().reverse(); } catch { return []; } }
async function first(paths) { for (const candidate of paths.filter(Boolean)) if (await exists(candidate)) return path.resolve(candidate); return null; }
async function fromPath(name, env) { return first((env.PATH || '').split(path.delimiter).map(dir => path.join(dir, name))); }

// All paths are discovered at startup on this host. Overrides take precedence.
export async function discover({ env = process.env, platform = process.platform, home = os.homedir(), applications = '/Applications' } = {}) {
  const windows = platform === 'win32';
  // macOS installs every Creative Cloud app in its own "Adobe <App> <year>" folder; take the newest stable one.
  const macAdobe = windows ? [] : (await children(applications)).filter(dir => /[\\/]Adobe /.test(dir) && !/Beta/i.test(dir));
  const macBundle = (pattern, bundle, inner = '') => macAdobe.filter(dir => pattern.test(path.basename(dir))).flatMap(dir => [path.join(dir, `${path.basename(dir)}.app`), path.join(dir, bundle)].map(app => inner ? path.join(app, inner) : app));
  const program = env.ProgramFiles || 'C:/Program Files';
  const adobe = await children(path.join(program, 'Adobe'));
  const blenderDirs = await children(path.join(program, 'Blender Foundation'));
  const tdDirs = [...await children(path.join(program, 'Derivative')), ...await children(program)].filter(x => /TouchDesigner|Derivative/i.test(x));
  const app = async (key, candidates) => first([env[key], ...candidates]);
  const aeRoots = [env.POSTCREATOR_AE_PACKAGE, path.join(env.LOCALAPPDATA || '', 'Postcreator', 'adapters', 'node_modules', 'fnf-after-effects-mcp'), path.join(env.LOCALAPPDATA || '', 'Higgsfield', 'ae-mcp', 'node_modules', 'fnf-after-effects-mcp'), path.join(home, '.higgsfield', 'ae-mcp', 'node_modules', 'fnf-after-effects-mcp')];
  return {
    node: process.execPath,
    blender: await app('POSTCREATOR_BLENDER', windows ? blenderDirs.map(dir => path.join(dir, 'blender.exe')) : ['/Applications/Blender.app/Contents/MacOS/Blender', await fromPath('blender', env)]),
    afterEffects: await app('POSTCREATOR_AFTER_EFFECTS', windows ? adobe.filter(x => /After Effects/.test(x)).map(dir => path.join(dir, 'Support Files', 'AfterFX.exe')) : [...macBundle(/^Adobe After Effects \d{4}$/, 'Adobe After Effects.app', 'Contents/MacOS/After Effects'), '/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects', '/Applications/Adobe After Effects 2025/Adobe After Effects 2025.app/Contents/MacOS/After Effects']),
    aeServer: await first(aeRoots.map(root => root && path.join(root, 'dist', 'index.js'))),
    photoshop: await app('POSTCREATOR_PHOTOSHOP', windows ? adobe.filter(x => /Photoshop/.test(x) && !/Beta/.test(x)).map(dir => path.join(dir, 'Photoshop.exe')) : [...macBundle(/^Adobe Photoshop \d{4}$/, 'Adobe Photoshop.app'), '/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app', '/Applications/Adobe Photoshop 2025/Adobe Photoshop 2025.app']),
    illustrator: await app('POSTCREATOR_ILLUSTRATOR', windows ? adobe.filter(x => /Illustrator/.test(x)).map(dir => path.join(dir, 'Support Files', 'Contents', 'Windows', 'Illustrator.exe')) : [...macBundle(/^Adobe Illustrator \d{4}$/, 'Adobe Illustrator.app'), '/Applications/Adobe Illustrator 2026/Adobe Illustrator.app', '/Applications/Adobe Illustrator 2025/Adobe Illustrator.app']),
    premiere: await app('POSTCREATOR_PREMIERE', windows ? adobe.filter(x => /Premiere Pro/.test(x)).map(dir => path.join(dir, 'Adobe Premiere Pro.exe')) : [...macBundle(/^Adobe Premiere Pro \d{4}$/, 'Adobe Premiere Pro.app'), '/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app', '/Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro 2025.app']),
    touchdesigner: await app('POSTCREATOR_TOUCHDESIGNER', windows ? tdDirs.flatMap(dir => [path.join(dir, 'bin', 'TouchDesigner.exe'), path.join(dir, 'TouchDesigner.exe')]) : ['/Applications/TouchDesigner.app/Contents/MacOS/TouchDesigner']),
    resolve: await app('POSTCREATOR_RESOLVE', windows ? [path.join(program, 'Blackmagic Design', 'DaVinci Resolve', 'Resolve.exe')] : ['/Applications/DaVinci Resolve/DaVinci Resolve.app']),
    resolveModule: await app('POSTCREATOR_RESOLVE_MODULE', windows ? [path.join(env.PROGRAMDATA || 'C:/ProgramData', 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Developer', 'Scripting', 'Modules', 'DaVinciResolveScript.py')] : ['/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules/DaVinciResolveScript.py']),
    python: await app('POSTCREATOR_PYTHON', windows ? [path.join(program, 'Python312', 'python.exe'), await fromPath('python.exe', env)] : [await fromPath('python3', env)]),
  };
}
