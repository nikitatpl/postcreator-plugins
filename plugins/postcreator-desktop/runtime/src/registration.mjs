import path from 'node:path';
import os from 'node:os';
import { readFile, realpath } from 'node:fs/promises';
import { exists } from './discovery.mjs';
import { run } from './process.mjs';

const registrationFailure = (message,error) => Object.assign(new Error(message+' Исходная диагностика: '+error.message,{cause:error}),error.code === undefined ? {} : {code:error.code});

export async function discoverClient(name,{env=process.env,node=process.execPath,home=os.homedir()}={}) {
  if (!['codex','claude'].includes(name)) throw new Error('В --client выберите codex или claude.');
  const explicit = env[`POSTCREATOR_${name.toUpperCase()}_CLI`];
  if (explicit) {
    if (!path.isAbsolute(explicit) || !await exists(explicit) || /\.(cmd|ps1|bat)$/i.test(explicit)) throw new Error('Путь CLI должен быть абсолютным и указывать на установленный исполняемый файл или файл запуска JavaScript; файлы .cmd, .ps1 и .bat не подходят.');
    const file = await realpath(explicit);return /\.m?js$/i.test(file)?{command:node,args:[file]}:{command:file,args:[]};
  }
  const paths=(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of paths) {const executable=path.join(dir,process.platform==='win32'?`${name}.exe`:name);if(await exists(executable))return {command:await realpath(executable),args:[]};}
  const packageName = name==='codex'?'@openai/codex':'@anthropic-ai/claude-code';
  const npmRoots = [path.join(env.APPDATA || '', 'npm','node_modules'),path.join(home,'.npm-global','lib','node_modules'),'/usr/local/lib/node_modules','/opt/homebrew/lib/node_modules',...paths.flatMap(dir=>[path.join(dir,'node_modules'),path.resolve(dir,'../lib/node_modules')])];
  for(const root of npmRoots) {
    const packageRoot=path.join(root,...packageName.split('/'));const manifest=path.join(packageRoot,'package.json');if(!await exists(manifest))continue;
    const pkg=JSON.parse(await readFile(manifest,'utf8'));const bin=typeof pkg.bin==='string'?pkg.bin:pkg.bin?.[name];if(typeof bin!=='string')continue;
    const entry=path.resolve(packageRoot,bin), relative=path.relative(packageRoot,entry);
    if(relative.startsWith('..')||path.isAbsolute(relative)||!await exists(entry))continue;
    return {command:node,args:[await realpath(entry)]};
  }
  throw new Error(`CLI ${name} не найден. Используйте созданную конфигурацию с абсолютными путями или задайте POSTCREATOR_${name.toUpperCase()}_CLI с путём к установленному CLI.`);
}

// Client CLIs perform their own atomic config updates. We only add an absent named server.
// Any existing enabled/disabled/conflicting registration is preserved verbatim.
export async function registerClient(name,{node=process.execPath,entry,env={},cliEnv=process.env,runner=run,client}={}) {
  if(!entry || !path.isAbsolute(entry) || !await exists(entry))throw new Error('Для регистрации нужен существующий постоянный файл запуска дополнения с абсолютным путём. Сначала выполните setup в новом каталоге.');
  const runtime=await realpath(entry), executable=await realpath(node);
  client ||= await discoverClient(name,{env:cliEnv,node:executable});
  const invoke = args=>runner(client.command,[...client.args,...args],{env:cliEnv,timeout:20000});
  const get=['mcp','get','postcreator-desktop',...(name==='codex'?['--json']:[])];
  try {
    await invoke(get);
    return {client:name,state:'preserved',reason:'Существующая регистрация сохранена. Проверьте её перед намеренным обновлением.'};
  } catch(error) {
    // A missing binary, malformed config, access error or unknown CLI command is not absence.
    if(!/No MCP server (?:named|found)/i.test(error.message))throw registrationFailure('Не удалось прочитать регистрацию MCP в клиенте. Проверьте его конфигурацию и доступность CLI.',error);
  }
  const add=name==='codex'?['mcp','add']:['mcp','add','--scope','user'];
  if(name==='codex')for(const [key,value]of Object.entries(env))add.push('--env',`${key}=${value}`);
  add.push('postcreator-desktop');
  if(name==='claude')for(const [key,value]of Object.entries(env))add.push('--env',`${key}=${value}`);
  add.push('--',executable,runtime,'serve');
  try {await invoke(add);await invoke(get);} catch(error) {throw registrationFailure('Не удалось зарегистрировать или проверить дополнение в клиенте. Проверьте его состояние через mcp get postcreator-desktop.',error);}
  return {client:name,state:'registered',command:executable,entry:runtime,tools:'Обновите клиент и проверьте наличие pc_desktop_*. Регистрация через CLI сама по себе не подтверждает доступность инструментов в текущем чате.'};
}
