import { spawn } from 'node:child_process';
import{StringDecoder}from'node:string_decoder';

export function run(command, args, { env = process.env, timeout = 60000, maxBytes = 8 * 1024 * 1024,encoding='utf8' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '', settled = false;
    const outDecoder=new StringDecoder(encoding),errDecoder=new StringDecoder(encoding);
    const fail = error => { if (!settled) { settled = true; clearTimeout(timer); child.kill(); reject(error); } };
    const timer = setTimeout(() => fail(new Error(`Native call timed out after ${timeout}ms; inspect state before retrying`)), timeout);
    child.on('error', fail);
    child.stdout.on('data', data => { stdout += outDecoder.write(data); if (stdout.length + stderr.length > maxBytes) fail(new Error('Native response exceeds size limit')); });
    child.stderr.on('data', data => { stderr += errDecoder.write(data); if (stdout.length + stderr.length > maxBytes) fail(new Error('Native response exceeds size limit')); });
    child.on('close', code => {
      if (settled) return; settled = true; clearTimeout(timer);
      stdout+=outDecoder.end();stderr+=errDecoder.end();
      if (code !== 0) {
        const xmlErrors = [...stderr.matchAll(/<S S="Error">([^<]*)<\/S>/g)].map(match=>match[1].replaceAll('_x000D__x000A_','\n').replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&')).join('');
        reject(new Error(`Native process exited ${code}: ${(xmlErrors || stderr).slice(-2000)} ${stdout.slice(-2000)}`));
      } else resolve({ stdout, stderr });
    });
  });
}
