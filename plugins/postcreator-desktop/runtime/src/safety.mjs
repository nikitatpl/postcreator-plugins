import path from 'node:path';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { exists } from './discovery.mjs';

export async function outputPath(root, value, extension) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Expected an output file path');
  const target = path.resolve(root, value);
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Output must stay inside POSTCREATOR_OUTPUT_ROOT');
  if (extension && !target.toLowerCase().endsWith(extension)) throw new Error(`Output must end in ${extension}`);
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  let cursor = path.resolve(root);
  for (const part of relative.split(path.sep).slice(0, -1)) {
    cursor = path.join(cursor, part);
    if (await exists(cursor)) {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Output ancestors cannot be links');
      const resolved = path.relative(canonicalRoot, await realpath(cursor));
      if (resolved === '..' || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) throw new Error('Output ancestor escapes root');
    } else await mkdir(cursor);
  }
  // lstat also finds dangling links, which access() would treat as an absent file.
  try { await lstat(target); } catch(error) { if(error.code==='ENOENT')return target;throw error; }
  throw new Error('Output already exists; choose a new filename');
}

export function validateAeOperation(operation, args = {}) {
  const categories = new Set(['comp', 'effect', 'footage', 'item', 'keyframe', 'layer', 'marker', 'mask', 'property', 'shape', 'text', 'timeline', 'transform', 'viewer']);
  const blocked = new Set(['layer.apply_preset', 'footage.set_proxy', 'footage.replace', 'footage.reload', 'property.add', 'property.set']);
  if (!categories.has(operation?.split('.')[0]) || blocked.has(operation) || /(?:delete|remove|set_renderer)/.test(operation)) throw new Error('Operation is outside the Postcreator safe native allowlist');
  // Expressions, raw scripts, project replacement, menu commands and preferences are excluded.
  if (Object.keys(args).some(key => /code|script|expression|path|file/i.test(key))) throw new Error('Executable or file parameters are not accepted by this adapter');
}
