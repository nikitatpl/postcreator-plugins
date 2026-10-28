import { run } from './process.mjs';
import { outputPath } from './safety.mjs';
import{mkdtemp,writeFile,readFile,link,unlink}from'node:fs/promises';import{randomUUID}from'node:crypto';import os from'node:os';import path from'node:path';import{fileURLToPath}from'node:url';import{PS_PANEL_OPS}from'./adobe-panel.mjs';

const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const asciiScript = source => source.replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
// Apple Events route for macOS: the documented "do javascript" command of the installed Adobe app, driven through JXA.
// Scripts arrive as argv items (never interpolated into the JXA source) and results come back as a JSON array of strings.
// Photoshop and Illustrator both name the command "do javascript"; each script runs exactly once (no retry that could repeat a mutation).
const MAC_JXA = 'function run(argv){var app=Application(argv[0]);var out=[];for(var i=1;i<argv.length;i++){var value=app.doJavascript(argv[i]);out.push(value===null||value===undefined?"":String(value));}return JSON.stringify(out);}';
// A modal dialog raised by a script that arrived over Apple Events cannot be dismissed by the caller and freezes the app.
// Suppress dialogs for the call and restore the user's setting afterwards. ExtendScript globals survive between calls,
// so the result slot is reset explicitly instead of relying on a re-declaration.
export function macDialogGuard(app, script) {
  const [read, off, restore] = app === 'photoshop'
    ? ['app.displayDialogs', 'app.displayDialogs=DialogModes.NO', 'app.displayDialogs=__pcPrev']
    : ['app.userInteractionLevel', 'app.userInteractionLevel=UserInteractionLevel.DONTDISPLAYALERTS', 'app.userInteractionLevel=__pcPrev'];
  return `var __pcPrev=${read};${off};var __pcOut=undefined;try{__pcOut=eval(${JSON.stringify(script).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')});}finally{${restore};}__pcOut;`;
}
// Photoshop 27 on macOS deadlocks inside any externally scripted save (saveAs or executeAction 'save'): the file is created
// empty and the app stops answering until it is force-quit. Save for Web export is unaffected, so PNG uses it and PSD is refused.
export const MAC_PSD_SAVE_UNSUPPORTED = 'На macOS Photoshop зависает при сохранении PSD из внешнего скрипта, поэтому document.save здесь не выполняется. Экспортируйте результат через asset.export_png или сохраните документ вручную: Файл → Сохранить как.';
export function macAppBundle(executable) {
  const bundle = String(executable || '').match(/^.*?\.app(?=[\\/]|$)/i)?.[0];
  if (!bundle) throw new Error('На macOS путь к Photoshop/Illustrator должен указывать на установленный пакет .app');
  return bundle;
}
export function macScriptingError(error, label) {
  const text = String(error?.message ?? error);
  const wrap = message => Object.assign(new Error(`${message} Исходная диагностика: ${text}`, { cause: error }), error?.code === undefined ? {} : { code: error.code });
  if (/\(-1743\)/.test(text)) return wrap(`macOS не разрешила управлять ${label}. Откройте Системные настройки → Конфиденциальность и безопасность → Автоматизация и включите ${label} для программы, из которой запущен ассистент; настройки безопасности дополнение само не меняет.`);
  if (/\(-600\)|\(-10810\)|\(-1728\)/.test(text)) return wrap(`${label} не запущен или ещё запускается. Дождитесь окна приложения и повторите проверку.`);
  if (/\(-1712\)/.test(text)) return wrap(`${label} не ответил вовремя. Проверьте, нет ли в программе открытого диалога, и убедитесь в состоянии перед повтором.`);
  return error;
}
export const ADOBE_OPS = {
  status: {}, 'document.inspect': {},
  'document.create': { name: 'name', width: 'pixels Photoshop / points Illustrator', height: 'pixels / points' },
  'document.text': { text: 'string', x: 'pixels/points', y: 'pixels/points', size: 'points; only companion-created documents' },
  'document.save': { path: 'new .psd/.ai under output root; only companion-created documents' },
  'raster.trace':{path:'existing PNG/JPEG',width:'points',height:'points',colors:'2..64; native Image Trace expanded to editable paths in new owned document'},
  'asset.export_svg':{document:'owned document name',path:'new .svg under output root'},
};
export class AdobeAdapter {
  constructor(app, executable, outputRoot, { platform = process.platform, runner = run } = {}) { this.app = app; this.executable = executable; this.outputRoot = outputRoot; this.owned = new Set();this.ownedPsIds=new Set();this.platform = platform;this.runner = runner; }
  get label() { return this.app === 'photoshop' ? 'Adobe Photoshop' : 'Adobe Illustrator'; }
  async macScripts(scripts, timeout) {
    const bundle = macAppBundle(this.executable);
    try {
      const { stdout } = await this.runner('osascript', ['-l', 'JavaScript', '-e', MAC_JXA, bundle, ...scripts.map(script => asciiScript(macDialogGuard(this.app, script)))], { timeout });
      const values = JSON.parse(stdout.trim());
      if (!Array.isArray(values) || values.length !== scripts.length) throw new Error('Native macOS response had an unexpected shape');
      return values;
    } catch (error) { throw macScriptingError(error, this.label); }
  }
  async call(operation, args = {}) {
    if (this.platform !== 'win32' && this.platform !== 'darwin') throw new Error('Native Photoshop/Illustrator adapter requires Windows COM or macOS Apple Events');
    if (!this.executable) throw new Error(`${this.app} not installed`);
    if(this.app==='photoshop')return this.photoshopScript(operation,args);
    if (!Object.hasOwn(ADOBE_OPS, operation)) throw new Error('Unknown Adobe operation');
    const number = (key, fallback) => { const v = args[key] ?? fallback; if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 32768) throw new Error(`Invalid ${key}`); return v; };
    let jsx;
    if(operation==='raster.trace'){
      if(!path.isAbsolute(args.path||'')||!['.png','.jpg','.jpeg'].includes(path.extname(args.path).toLowerCase())||!(await(await import('node:fs/promises')).stat(args.path)).isFile())throw Error('Expected existing absolute raster image');
      const colors=number('colors',8);if(colors<2||colors>64||!Number.isInteger(colors))throw Error('Trace colors must be 2..64');
      jsx=`var d=app.documents.add(DocumentColorSpace.RGB,${number('width',640)},${number('height',360)});var placed=d.placedItems.add();placed.file=new File(${JSON.stringify(args.path)});placed.position=[0,d.height];var traced=placed.trace();traced.tracing.tracingOptions.tracingMode=TracingModeType.TRACINGMODECOLOR;traced.tracing.tracingOptions.maxColors=${colors};app.redraw();traced.tracing.expandTracing();d.name;`;
    }else if(operation==='asset.export_svg'){
      if(!this.owned.has(args.document))throw Error('SVG export requires an owned document');const file=await outputPath(this.outputRoot,args.path,'.svg');
      jsx=`if(app.activeDocument.name!==${JSON.stringify(args.document)})throw Error('Select the owned document');var output=new File(${JSON.stringify(file)});if(output.exists)throw Error('Output already exists');var options=new ExportOptionsSVG();options.embedRasterImages=false;options.fontType=SVGFontType.OUTLINEFONT;app.activeDocument.exportFile(output,ExportType.SVG,options);encodeURIComponent(app.activeDocument.name)+'\\t'+encodeURIComponent(${JSON.stringify(file)});`;
    }else if (operation === 'document.create') {
      const name = `Postcreator ${String(args.name || 'Untitled').slice(0,80)}`;
      const width = number('width', 1920), height = number('height', 1080);
      if (!width || !height) throw new Error('Dimensions must be positive');
      jsx = this.app === 'photoshop' ? `app.documents.add(UnitValue(${width},'px'),UnitValue(${height},'px'),72,${JSON.stringify(name)}); app.activeDocument.name;` : `var d=app.documents.add(DocumentColorSpace.RGB,${width},${height}); d.name;`;
    } else if (operation === 'document.text') {
      if (typeof args.document !== 'string' || !this.owned.has(args.document)) throw new Error('Text edits require a companion-created document name');
      const text = JSON.stringify(String(args.text || '').slice(0,10000));
      jsx = `if(app.activeDocument.name!==${JSON.stringify(args.document)}) throw new Error('Select the companion document first'); ` + (this.app === 'photoshop' ? `var l=app.activeDocument.artLayers.add(); l.kind=LayerKind.TEXT; l.textItem.contents=${text}; l.textItem.position=[${number('x',100)},${number('y',100)}]; l.textItem.size=${number('size',48)}; l.name;` : `var t=app.activeDocument.textFrames.add(); t.contents=${text}; t.position=[${number('x',100)},${number('y',100)}]; t.textRange.characterAttributes.size=${number('size',48)}; t.name;`);
    } else if (operation === 'document.save') {
      if (typeof args.document !== 'string' || !this.owned.has(args.document)) throw new Error('Save requires a companion-created document');
      const file = await outputPath(this.outputRoot, args.path, this.app === 'photoshop' ? '.psd' : '.ai');
      jsx = `if(app.activeDocument.name!==${JSON.stringify(args.document)}) throw new Error('Select the companion document first'); var output=new File(${JSON.stringify(file)});if(output.exists)throw Error('Output already exists');app.activeDocument.saveAs(output,new ${this.app === 'photoshop' ? 'PhotoshopSaveOptions' : 'IllustratorSaveOptions'}()); ${JSON.stringify(file)};`;
    }
    const inspect = 'var out=app.version+"\\n"; for(var i=0;i<app.documents.length;i++){out+=encodeURIComponent(app.documents[i].name)+"\\t"+app.documents[i].layers.length+"\\n";} out;';
    let result;
    if (this.platform === 'darwin') {
      // A genuine native script response is required before advertising connectivity, exactly as on the Windows COM route.
      const [version, value] = await this.macScripts(['app.version', jsx || inspect], 45000);
      if (!version) throw new Error('Native application returned no version');
      result = jsx ? { result: value, version } : { inspection: value, version };
    } else {
      const program = this.app === 'photoshop' ? 'Photoshop.Application' : 'Illustrator.Application';
      // COM property reads can silently return null when the host type library is broken.
      // A genuine native script response is required before advertising connectivity.
      const script = `$ErrorActionPreference='Stop'\n$app=New-Object -ComObject ${quote(program)}\n$version=[string]$app.DoJavaScript('app.version')\nif(-not $version){throw 'Native application returned no version'}\n` + (jsx ? `$result=$app.DoJavaScript(${quote(jsx)})\n@{result=[string]$result; version=$version}|ConvertTo-Json -Compress` : `$result=[string]$app.DoJavaScript(${quote(inspect)})\n@{inspection=$result;version=$version}|ConvertTo-Json -Compress`);
      const { stdout } = await this.runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 45000 });
      result = JSON.parse(stdout.trim());
    }
    if (operation === 'document.create'||operation==='raster.trace') {if (!result.result) throw new Error('Native document creation returned no identity'); this.owned.add(result.result);}
    if(operation==='asset.export_svg'){const[name,file]=result.result.split('\t').map(decodeURIComponent);this.owned.add(name);result.result=file;result.document=name;}
    if (result.inspection) {
      result.documents = result.inspection.trim().split(/\r?\n/).slice(1).filter(Boolean).map(line=>{const [name,layers]=line.split('\t');return {name:decodeURIComponent(name),layers:Number(layers)};});
      delete result.inspection;
    }
    return result;
  }
  async photoshopScript(operation,args={}){
    if(!Object.hasOwn(PS_PANEL_OPS,operation))throw Error('Unknown original Photoshop operation');const input={...args};
    delete input.webExport;
    if(this.platform==='darwin'&&operation==='document.save')throw Error(MAC_PSD_SAVE_UNSUPPORTED);
    if(operation==='document.save'||operation==='asset.export_png')input.path=await outputPath(this.outputRoot,input.path,operation==='document.save'?'.psd':'.png');
    let webTarget=null;
    // Save for Web rewrites spaces in file names, so export under a plain ASCII name next to the validated target
    // and move it into place without overwriting.
    if(this.platform==='darwin'&&operation==='asset.export_png'){webTarget=input.path;input.path=path.join(path.dirname(webTarget),`postcreator-export-${randomUUID()}.png`);input.webExport=true;}
    if(operation==='document.open_copy'&&(!path.isAbsolute(input.path||'')||!['.png','.jpg','.jpeg','.psd'].includes(path.extname(input.path).toLowerCase())||!(await(await import('node:fs/promises')).stat(input.path)).isFile()))throw Error('Expected existing absolute raster/PSD file');
    const host=await readFile(fileURLToPath(new URL('../native/photoshop/host.jsx',import.meta.url)),'utf8');
    const script=host+'\nPostcreator.restoreOwned('+JSON.stringify([...this.ownedPsIds])+');\nPostcreator.dispatch('+JSON.stringify({operation,args:input}).replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029')+');';
    let stdout;
    if (this.platform === 'darwin') {
      [stdout] = await this.macScripts([script], operation==='cleanup.fill'?120000:45000);
    } else {
      const ascii=asciiScript(script);
      const vbs='Option Explicit\r\nDim app\r\nSet app = CreateObject("Photoshop.Application")\r\nWScript.Echo app.DoJavaScript("'+ascii.replaceAll('"','""').replaceAll('\r','').split('\n').join('" & vbLf & "')+'")\r\n';
      const dir=await mkdtemp(path.join(os.tmpdir(),'postcreator-photoshop-script-'));const file=path.join(dir,'request.vbs');await writeFile(file,vbs,'ascii');
      ({stdout}=await this.runner(path.join(process.env.WINDIR||'C:/Windows','System32','cscript.exe'),['//NoLogo',file],{timeout:operation==='cleanup.fill'?120000:45000}));
    }
    const response=JSON.parse(stdout.trim());
    if(webTarget){
      try{if(!response.error){await link(input.path,webTarget);response.result.path=webTarget;}}
      finally{await unlink(input.path).catch(()=>{});}
    }
    if(response.error)throw Error(response.error);const result=response.result;
    if(['document.create','document.open_copy'].includes(operation)){this.ownedPsIds.add(result.context.documentId);result.result=result.name;}
    result.channel=this.platform==='darwin'?'original-apple-events':'original-vbscript-com';return result;
  }
}
