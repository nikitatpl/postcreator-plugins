import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { discover, exists } from './discovery.mjs';
import { BlenderAdapter, BLENDER_OPS } from './blender.mjs';
import { AfterEffectsAdapter } from './after-effects.mjs';
import { AdobeAdapter, ADOBE_OPS } from './adobe.mjs';
import { ResolveAdapter, RESOLVE_OPS } from './resolve.mjs';
import { TouchDesignerAdapter, TD_OPS } from './touchdesigner.mjs';
import {PremiereAdapter,PREMIERE_OPS}from'./premiere.mjs';
import{PhotoshopPanelAdapter,PS_PANEL_OPS}from'./adobe-panel.mjs';

export const SKILL_NAMES = ['postcreator-desktop','postcreator-ae-scenes','postcreator-ae-cleanup','postcreator-ae-vfx','postcreator-blender-scenes','postcreator-blender-materials','postcreator-blender-destruction','postcreator-blender-assembly','postcreator-touchdesigner','postcreator-adobe-artwork','postcreator-resolve','postcreator-premiere'];
export const CATALOG = {
  blender: BLENDER_OPS,
  afterEffects: { status:{}, 'project.inspect':{}, 'native.catalog':{category:'необязательная допустимая категория операций'}, 'native.do':{operation:'название разрешённой операции из каталога',args:'параметры по каталогу'}, 'project.save':{context:'проверенные экземпляр проекта, файл и версия',path:'новый файл .aep в каталоге результатов'}, 'render.frame':{context:'проверенные экземпляр проекта, файл и версия',compId:'ID композиции в приложении',time:'время в секундах',path:'новый файл .png в каталоге результатов'} },
  photoshop:PS_PANEL_OPS, illustrator:ADOBE_OPS,
  resolve:RESOLVE_OPS, touchdesigner:TD_OPS,
  premiere:PREMIERE_OPS,
};
export const TOOLS = [
  {name:'pc_desktop_status',title:'Состояние локальных приложений',description:'Найти пути к приложениям и необходимым программам на этом компьютере. live:true проверяет живое соединение с одним выбранным приложением без изменений. Обнаруженный путь сам по себе не подтверждает связь.',inputSchema:{type:'object',properties:{app:{type:'string',enum:Object.keys(CATALOG)},live:{type:'boolean'}},additionalProperties:false}},
  {name:'pc_desktop_catalog',title:'Каталог локальных операций',description:'Прочитать доступные операции и параметры для выбранного приложения. Отсутствующие подключения сообщаются явно; облачные сервисы и провайдеры не вызываются.',inputSchema:{type:'object',properties:{app:{type:'string',enum:Object.keys(CATALOG)}},additionalProperties:false}},
  {name:'pc_desktop_do',title:'Выполнить локальную операцию',description:'Выполнить именованную операцию приложения с параметрами по каталогу. Сначала прочитать состояние, использовать каталог результатов задачи и проверить исходную операцию при неопределённом завершении. Произвольные скрипты Python/JavaScript, команды меню и изменения настроек не принимаются.',inputSchema:{type:'object',required:['app','operation'],properties:{app:{type:'string',enum:Object.keys(CATALOG)},operation:{type:'string'},args:{type:'object'}},additionalProperties:false}},
  {name:'pc_desktop_skill',title:'Инструкции для локальной работы',description:'Прочитать оригинальные инструкции Postcreator для работы в локальных редакторах. Закрытые сторонние инструкции не предоставляются.',inputSchema:{type:'object',properties:{name:{type:'string',enum:SKILL_NAMES}},additionalProperties:false}},
];
const textResult = data => ({content:[{type:'text',text:JSON.stringify(data,null,2)}]});

/** Keep recovery identifiers exact and preserve the original native diagnostic separately. */
export function serializeDesktopError(error) {
  const original = typeof error?.message === 'string' ? error.message : String(error);
  if (error?.code === 'ae_execution_uncertain' || error?.code === 'native_execution_uncertain') {
    const released = Number.isFinite(error.releaseAt) ? ` Если приложение так и не начало её выполнять, запрос снимется сам после ${new Date(error.releaseAt).toISOString()}: следующий вызов после этого времени пройдёт.` : '';
    const message = `Приложение ещё не подтвердило результат операции ${error.operation ?? 'исходного запроса'} (requestId: ${error.requestId ?? 'не получен'}). Сохраните requestId и дождитесь её подтверждения; проверьте состояние через pc_desktop_status с live=true и тем же app. Не повторяйте изменение, пока результат исходного запроса не восстановлен и не проверен.${released}`;
    return {content:[{type:'text',text:message},{type:'text',text:'Исходная диагностика приложения: '+original}],isError:true,
      structuredContent:{ok:false,error:{code:error.code,operation:error.operation,requestId:error.requestId,expiresAt:error.expiresAt,...(Number.isFinite(error.releaseAt)?{releaseAt:error.releaseAt}:{}),message}}};
  }
  return {content:[
    {type:'text',text:'Не удалось выполнить операцию локального дополнения. Проверьте подключение и параметры по каталогу; исходная диагностика приведена ниже.'},
    {type:'text',text:'Исходная диагностика: '+original},
  ],isError:true};
}
export class Companion {
  constructor(host, { outputRoot = process.env.POSTCREATOR_OUTPUT_ROOT || path.join(os.homedir(),'Postcreator','outputs'), skillRoot } = {}) {
    this.host = host; this.outputRoot = outputRoot; this.skillRoot = skillRoot;
    this.adapters = {blender:new BlenderAdapter(host.blender,outputRoot),afterEffects:new AfterEffectsAdapter(host,outputRoot),photoshop:new AdobeAdapter('photoshop',host.photoshop,outputRoot),illustrator:new AdobeAdapter('illustrator',host.illustrator,outputRoot),resolve:new ResolveAdapter(host,outputRoot),touchdesigner:new TouchDesignerAdapter(process.env.POSTCREATOR_TD_CONFIG),premiere:new PremiereAdapter(process.env.POSTCREATOR_PREMIERE_CONFIG,outputRoot)};
    if(process.env.POSTCREATOR_PS_TRANSPORT==='panel')this.adapters.photoshop=new PhotoshopPanelAdapter(process.env.POSTCREATOR_PS_CONFIG,outputRoot);
  }
  async call(app,operation,args = {}) {
    if (!Object.hasOwn(CATALOG,app) || !Object.hasOwn(CATALOG[app],operation)) throw new Error('Неизвестное приложение или операция. Выберите app и operation из pc_desktop_catalog.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Параметр args должен быть объектом.');
    if (process.env.POSTCREATOR_DESKTOP_READONLY === '1' && !['status','scene.inspect','material.inspect','project.inspect','document.inspect','timeline.inspect','node.inspect','native.catalog','context.inspect','color.inspect','render.formats','render.status'].includes(operation)) throw new Error('Дополнение настроено только для чтения; изменение проекта недоступно.');
    return this.adapters[app].call(operation,args);
  }
  async tool(name,args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Параметры инструмента должны быть объектом.');
    if (name === 'pc_desktop_catalog') return textResult(args.app ? {app:args.app,operations:CATALOG[args.app] ?? {},limitations:args.app === 'premiere' ? 'Для живого управления через оригинальный мост нужны подписанное расширение и открытая панель Premiere.' : undefined} : CATALOG);
    if (name === 'pc_desktop_status') {
      const data = {host:this.host,outputRoot:this.outputRoot,connectivity:'not tested',message:'Найдены сведения об окружении; соединение с приложениями ещё не проверено. Для проверки укажите app и live=true.',premiere:'Для оригинального моста CEP нужны подписанное расширение и открытая панель Premiere.',touchdesigner:'Нужны установленное приложение и явно запущенный оригинальный локальный мост.',resolve:'Редактирование, цветокоррекция и рендер используют SDK; для изменения нужны проверенные ID активного проекта и таймлайна.'};
      if (args.live) {if (!args.app) throw new Error('Для проверки живого соединения выберите одно приложение в app.'); data.live = await this.call(args.app,'status'); data.connectivity = data.live?.isError ? 'native error' : 'native response received'; data.message = data.live?.isError ? 'Приложение вернуло ошибку. Проверьте исходную диагностику в live.' : 'Получен ответ приложения. Проверьте его состояние в live перед выбранной операцией.';}
      return {...textResult(data),...(data.live?.isError ? {isError:true} : {})};
    }
    if (name === 'pc_desktop_do') {
      const result = await this.call(args.app,args.operation,args.args);
      if (result?.isError && result?.content) return {...result,content:[{type:'text',text:'Приложение вернуло ошибку операции. Исходный ответ приведён ниже; проверьте его перед продолжением.'},...result.content]};
      return result?.content ? result : textResult(result);
    }
    if (name === 'pc_desktop_skill') {
      if (!args.name) return textResult({skills:SKILL_NAMES});
      if (!SKILL_NAMES.includes(args.name)) throw new Error('Неизвестная инструкция. Прочитайте список pc_desktop_skill без name и выберите доступное имя.');
      if (!this.skillRoot) {
        for (const relative of ['../skills/','../../skills/','../../plugins/postcreator-desktop/skills/']) {
          const candidate = fileURLToPath(new URL(relative,import.meta.url));
          if (await exists(path.join(candidate,args.name,'SKILL.md'))) { this.skillRoot = candidate; break; }
        }
      }
      if (!this.skillRoot) throw new Error('В установке отсутствуют оригинальные инструкции. Используйте полный пакет локального дополнения Postcreator.');
      return {content:[{type:'text',text:await readFile(path.join(this.skillRoot,args.name,'SKILL.md'),'utf8')}]};
    }
    throw new Error('Неизвестный инструмент. Выберите имя из tools/list.');
  }
  close() { this.adapters.afterEffects.close();this.adapters.premiere.close();this.adapters.photoshop.close?.(); }
}

export async function serve({ input = process.stdin, output = process.stdout, companion } = {}) {
  companion ||= new Companion(await discover());
  let queue = Promise.resolve();
  const lines = createInterface({input});
  const send = data => output.write(JSON.stringify(data)+'\n');
  lines.on('line',line => { queue = queue.then(async () => {
    let request;
    try { if (line.length > 1024*1024) throw new Error('Сообщение превышает лимит 1 МиБ.'); request = JSON.parse(line); } catch { send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Некорректный JSON-запрос или сообщение больше 1 МиБ.'}}); return; }
    if (!Object.hasOwn(request,'id')) return;
    try {
      let result;
      if (request.method === 'initialize') result = {protocolVersion:request.params?.protocolVersion || '2024-11-05',capabilities:{tools:{}},serverInfo:{name:'postcreator-desktop',version:'1.2.1'}};
      else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list') result = {tools:TOOLS};
      else if (request.method === 'tools/call') {try {result = await companion.tool(request.params?.name,request.params?.arguments);} catch (error) {result = serializeDesktopError(error);}}
      else throw new Error('Метод не найден.');
      send({jsonrpc:'2.0',id:request.id,result});
    } catch (error) {send({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:error.message}});}
  }).catch(error => process.stderr.write(serializeDesktopError(error).content.map(item=>item.text).join('\n')+'\n')); });
  lines.on('close',()=>queue.finally(()=>companion.close()));
}
