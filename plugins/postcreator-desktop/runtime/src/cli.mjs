#!/usr/bin/env node
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { discover, exists } from './discovery.mjs';
import { Companion, serve, serializeDesktopError } from './server.mjs';
import { registerClient } from './registration.mjs';

export const RUNTIME_FILES = ['src/bootstrap.mjs','src/cli.mjs','src/server.mjs','src/discovery.mjs','src/process.mjs','src/safety.mjs','src/stdio-client.mjs','src/blender.mjs','src/after-effects.mjs','src/ae-script.mjs','src/adobe.mjs','src/resolve.mjs','src/touchdesigner.mjs','src/registration.mjs','src/premiere.mjs','src/adobe-panel.mjs','native/blender.py','native/resolve.py','native/touchdesigner_bootstrap.py','native/touchdesigner_callbacks.py',...['premiere','after-effects','photoshop'].flatMap(app=>['CSXS/manifest.xml','index.html','panel.js','host.jsx'].map(file=>`native/${app}/${file}`))];
export function clientConfig(node,entry,format = 'json',env = {}) {
  const config = {mcpServers:{'postcreator-desktop':{command:node,args:[entry,'serve'],env}}};
  if (format !== 'toml') return JSON.stringify(config,null,2);
  const q = JSON.stringify;
  return `[mcp_servers.postcreator-desktop]\ncommand = ${q(node)}\nargs = [${q(entry)}, "serve"]\n` + (Object.keys(env).length ? `[mcp_servers.postcreator-desktop.env]\n${Object.entries(env).map(([key,value])=>`${key} = ${q(value)}`).join('\n')}\n` : '');
}

async function main() {
  if (+process.versions.node.split('.')[0] < 24) throw new Error('Локальному дополнению Postcreator нужен Node 24+. Запустите его через bootstrap.mjs с POSTCREATOR_NODE, указывающим на установленный Node 24+; глобальная среда не изменяется.');
  const [command = 'serve',...args] = process.argv.slice(2);
  const option = (name,fallback) => args.includes(name) ? args[args.indexOf(name)+1] : fallback;
  if (command === 'serve') return serve();
  if (command === 'doctor') { const companion = new Companion(await discover()); try {const result = await companion.tool('pc_desktop_status',{app:option('--app'),live:args.includes('--live')}); process.stdout.write(result.content[0].text+'\n'); if (result.isError) process.exitCode = 1;} finally {companion.close();} return; }
  if (command === 'call') { const companion = new Companion(await discover()); try {const result = await companion.call(args[0],args[1],JSON.parse(option('--json','{}'))); process.stdout.write(JSON.stringify(result,null,2)+'\n'); if (result?.isError) process.exitCode = 1;} finally {companion.close();} return; }
  if (command === 'config') {process.stdout.write(clientConfig(process.execPath,fileURLToPath(import.meta.url),option('--format','json'),{POSTCREATOR_OUTPUT_ROOT:option('--output-root',path.join(os.homedir(),'Postcreator','outputs'))})+'\n'); return;}
  if (command === 'register') {
    const entry = await (await import('node:fs/promises')).realpath(fileURLToPath(import.meta.url));
    const env = {POSTCREATOR_OUTPUT_ROOT:option('--output-root',process.env.POSTCREATOR_OUTPUT_ROOT || path.join(os.homedir(),'Postcreator','outputs'))};
    if(process.env.POSTCREATOR_TD_CONFIG)env.POSTCREATOR_TD_CONFIG=process.env.POSTCREATOR_TD_CONFIG;
    if(process.env.POSTCREATOR_PREMIERE_CONFIG)env.POSTCREATOR_PREMIERE_CONFIG=process.env.POSTCREATOR_PREMIERE_CONFIG;
    for(const key of ['POSTCREATOR_AE_CONFIG','POSTCREATOR_PS_CONFIG'])if(process.env[key])env[key]=process.env[key];
    if(process.env.POSTCREATOR_AE_TRANSPORT)env.POSTCREATOR_AE_TRANSPORT=process.env.POSTCREATOR_AE_TRANSPORT;
    if(process.env.POSTCREATOR_PS_TRANSPORT)env.POSTCREATOR_PS_TRANSPORT=process.env.POSTCREATOR_PS_TRANSPORT;
    process.stdout.write(JSON.stringify(await registerClient(option('--client','codex'),{entry,env}),null,2)+'\n');return;
  }
  if (command === 'setup') {
    const root = path.resolve(option('--install-root',path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'.local','share'),'Postcreator','desktop')));
    const source = fileURLToPath(new URL('../',import.meta.url));
    if (await exists(root)) throw new Error('Каталог установки уже существует. Укажите новый пустой путь в --install-root; существующие установка и настройки клиента не перезаписываются.');
    await mkdir(root,{recursive:true});
    for (const file of RUNTIME_FILES) {await mkdir(path.dirname(path.join(root,file)),{recursive:true}); await cp(path.join(source,file),path.join(root,file));}
    const localSkills = fileURLToPath(new URL('../skills/',import.meta.url));
    const pluginSkills = fileURLToPath(new URL('../../skills/',import.meta.url));
    const repoSkills = fileURLToPath(new URL('../../plugins/postcreator-desktop/skills/',import.meta.url));
    const skills = await exists(localSkills) ? localSkills : await exists(pluginSkills) ? pluginSkills : repoSkills;
    if (await exists(skills)) await cp(skills,path.join(root,'skills'),{recursive:true});
    const env = {POSTCREATOR_OUTPUT_ROOT:option('--output-root',path.join(os.homedir(),'Postcreator','outputs'))};
    if (args.includes('--touchdesigner')) {
      const configFile = path.join(root,'touchdesigner-private.json');
      await writeFile(configFile,JSON.stringify({token:randomBytes(32).toString('hex'),port:9982,callbacks:path.join(root,'native','touchdesigner_callbacks.py'),outputRoot:env.POSTCREATOR_OUTPUT_ROOT}),{mode:0o600,flag:'wx'});
      env.POSTCREATOR_TD_CONFIG = configFile;
      const bootstrap = `POSTCREATOR_TD_CONFIG=${JSON.stringify(configFile.replaceAll('\\','/'))}; exec(compile(open(${JSON.stringify(path.join(root,'native','touchdesigner_bootstrap.py').replaceAll('\\','/'))},encoding='utf-8').read(),'postcreator_bootstrap','exec'))`;
      await writeFile(path.join(root,'touchdesigner-bootstrap.txt'),bootstrap+'\n');
      process.stderr.write(`Файл запуска моста TouchDesigner: ${path.join(root,'touchdesigner-bootstrap.txt')}. Выполните его в явно выбранном проекте задачи; команда setup не устанавливает само приложение.\n`);
    }
    if(args.includes('--premiere')) {
      const configFile=path.join(root,'premiere-private.json');await writeFile(configFile,JSON.stringify({token:randomBytes(32).toString('hex'),port:9983}),{mode:0o600,flag:'wx'});env.POSTCREATOR_PREMIERE_CONFIG=configFile;
      process.stderr.write(`Исходники оригинального расширения Premiere: ${path.join(root,'native','premiere')}. Нужны подпись и поддержанная Adobe установка. Подключите панель к ${configFile}; параметры безопасности и ключи реестра не изменяются.\n`);
    }
    for(const [flag,key,port]of[['--after-effects','POSTCREATOR_AE_CONFIG',9984],['--photoshop','POSTCREATOR_PS_CONFIG',9985]])if(args.includes(flag)){
      const app=flag.slice(2),configFile=path.join(root,app+'-private.json');await writeFile(configFile,JSON.stringify({token:randomBytes(32).toString('hex'),port}),{mode:0o600,flag:'wx'});env[key]=configFile;
      process.stderr.write(`Исходники оригинального расширения ${app}: ${path.join(root,'native',app)}. Нужны подписанная установка и поддержка скриптов приложения. Подключите панель к ${configFile}; безопасность и настройки приложения не изменяются.\n`);
    }
    const entry = path.join(root,'src','cli.mjs');
    await writeFile(path.join(root,'codex.toml'),clientConfig(process.execPath,entry,'toml',env));
    await writeFile(path.join(root,'claude.json'),clientConfig(process.execPath,entry,'json',env));
    const registration = args.includes('--register') ? await registerClient(option('--register','codex'),{entry,env}) : 'Регистрация не изменена. Выполните register --client codex|claude или добавьте созданную конфигурацию с абсолютными путями.';
    process.stdout.write(JSON.stringify({installed:root,codex:path.join(root,'codex.toml'),claude:path.join(root,'claude.json'),clientRegistration:registration},null,2)+'\n'); return;
  }
  throw new Error('Команды: serve | doctor [--app APP --live] | call APP OP [--json JSON] | config [--format toml] | setup [--install-root DIR --touchdesigner --register codex|claude] | register --client codex|claude');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error=>{process.stderr.write(serializeDesktopError(error).content.map(item=>item.text).join('\n')+'\n');process.exitCode=1;});
