import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AEPanelAdapter, AE_NATIVE_OPS } from './adobe-panel.mjs';

// Adobe documents AfterFX.exe -r <absolute JSX> for the existing application instance (Windows); macOS uses the DoScriptFile Apple Event.
export const AE_SCRIPT_DOCUMENTATION = 'https://helpx.adobe.com/after-effects/desktop/automate-in-after-effects/automate-animation/scripts.html';
const HOST = fileURLToPath(new URL('../native/after-effects/host.jsx', import.meta.url));
const MAX_REQUEST = 64 * 1024, MAX_RECEIPT = 1024 * 1024;
const ALLOWED = new Set([...Object.keys(AE_NATIVE_OPS), 'project.inspect', 'project.save', 'render.frame']);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// The host dispatches only after writing its `started` receipt and re-checking the deadline, so a request
// without any receipt this long after its deadline never ran and never will: it is released, not retried.
export const AE_EXPIRY_GRACE_MS = 5000;
const literal = value => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export class AEUncertainExecutionError extends Error {
  constructor(pending, graceMs = AE_EXPIRY_GRACE_MS) {
    const releaseAt = pending.expiresAt + graceMs;
    super(`After Effects has not returned a correlated native receipt. Inspect/recover the pending request before any new operation; no app was killed or scripting security changed. If After Effects never starts the script, enable Settings > Scripting & Expressions > "Allow Scripts to Write Files and Access Network" (Preferences on macOS); the companion never changes it. A request that never started is released after ${new Date(releaseAt).toISOString()}.`);
    this.name = 'AEUncertainExecutionError'; this.code = 'ae_execution_uncertain';
    this.requestId = pending.nonce; this.operation = pending.request.operation; this.expiresAt = pending.expiresAt; this.releaseAt = releaseAt;
  }
}
function validatePlain(value, depth = 0) {
  if (depth > 12) throw Error('AE request nesting exceeds limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { if (value.length > 1000) throw Error('AE request array exceeds limit'); for (const entry of value) validatePlain(entry, depth + 1); return; }
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('AE requests must contain plain finite JSON values');
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:__proto__|prototype|constructor|code|script|expression|eval)$/i.test(key)) throw Error('Executable/prototype request fields are forbidden');
    validatePlain(entry, depth + 1);
  }
}

/** Only the installed original closed host and a quoted data request enter the generated JSX. */
export function generateAeRequestScript({ hostSource, request, nonce, expiresAt, receiptPath }) {
  if (!ALLOWED.has(request.operation)) throw Error('Unknown original AE operation');
  validatePlain(request);
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST) throw Error('AE request exceeds size limit');
  if (!/^[a-f0-9-]{36}$/.test(nonce) || !Number.isSafeInteger(expiresAt) || !path.isAbsolute(receiptPath)) throw Error('Invalid internal script request');
  return `#target aftereffects\n${hostSource}\n(function(){
var request=${literal(request)}, nonce=${literal(nonce)}, expiresAt=${expiresAt}, destination=${literal(receiptPath)};
function receipt(phase,body){var text='{"nonce":"'+nonce+'","expiresAt":'+expiresAt+',"phase":"'+phase+'","bodyEncoded":"'+encodeURIComponent(body||'')+'"}';if(text.length>262144)throw Error('Native response exceeds receipt limit');var f=new File(destination);f.encoding='UTF-8';if(!f.open('w'))throw Error('Scripting file-write permission required');try{if(!f.write(text))throw Error('Receipt write failed');}finally{f.close();}}
try{
if(new Date().getTime()>expiresAt){receipt('expired','');return;}
// This must succeed before dispatch; settings are never changed to make it succeed.
receipt('started','');
if(new Date().getTime()>expiresAt){receipt('expired','');return;}
var body=Postcreator.dispatch(request);receipt('completed',body);
}catch(error){try{receipt('failed','{"error":"Native closed dispatch failed; inspect state before retry"}');}catch(ignored){}}
})();\n`;
}

const appleScriptText = value => {
  if (/[\u0000-\u001f]/.test(value)) throw Error('Control characters are not allowed in an AppleScript path');
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
};
// Apple Event error numbers that prove the event was never delivered to After Effects.
const MAC_NOT_DELIVERED = /\((?:-1743|-600|-10810|-1728)\)/;
export function macAeBundle(executable) {
  const bundle = String(executable).match(/^.*?\.app(?=[\\/]|$)/i)?.[0];
  if (!bundle) throw Error('На macOS путь к After Effects должен находиться внутри установленного пакета .app');
  return bundle;
}
export const macAeAppleScript = (executable, script) => `tell application "${appleScriptText(macAeBundle(executable))}" to DoScriptFile "${appleScriptText(script)}"`;
export function macAeNotDeliveredMessage(stderr) {
  if (/\(-1743\)/.test(stderr)) return 'macOS не разрешила управлять After Effects. Включите его в Системные настройки → Конфиденциальность и безопасность → Автоматизация для программы, из которой запущен ассистент; настройки безопасности дополнение само не меняет.';
  return 'After Effects не принял команду запуска скрипта (приложение не найдено или не стартовало).';
}

// Windows documents AfterFX.exe -r <JSX>; macOS takes the same JSX through the DoScriptFile Apple Event.
function launch(executable, script, platform = process.platform) {
  let child;
  try {
    if (platform === 'darwin') {
      child = spawn('osascript', ['-e', macAeAppleScript(executable, script)], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } else child = spawn(executable, ['-r', script], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { return { startError: error }; }
  let startError = null, bytes = 0, diagnostics = '';
  child.on('error', error => { if (!child.pid) startError = error; });
  // Output is consumed without retaining native/private text; only a bounded tail of osascript errors is classified.
  const discard = data => { bytes += data.length; };
  child.stdout?.on('data', discard);
  child.stderr?.on('data', data => { bytes += data.length; if (platform === 'darwin' && diagnostics.length < 4096) diagnostics += data.toString('utf8'); });
  if (platform === 'darwin') child.on('close', code => { if (code !== 0 && MAC_NOT_DELIVERED.test(diagnostics)) startError = Error(macAeNotDeliveredMessage(diagnostics)); });
  return { get startError() { return startError; }, child };
}

export class AEScriptTransport {
  constructor(executable, { timeoutMs = 15000, pollMs = 100, platform = process.platform, launchProcess = (exe, script) => launch(exe, script, platform), now = Date.now, expiryGraceMs = AE_EXPIRY_GRACE_MS } = {}) {
    if (typeof executable !== 'string' || !path.isAbsolute(executable)) throw Error('Discovered absolute AfterFX executable required');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 180000) throw Error('Invalid AE receipt timeout');
    if (!Number.isSafeInteger(expiryGraceMs) || expiryGraceMs < 1000) throw Error('Invalid AE expiry grace');
    this.executable = executable; this.timeoutMs = timeoutMs; this.pollMs = pollMs; this.launchProcess = launchProcess; this.now = now; this.platform = platform; this.expiryGraceMs = expiryGraceMs; this.pending = null; this.closed = false;
  }
  async request(operation, args = {}) {
    if (this.closed) throw Error('AE script transport is closed');
    if (this.platform !== 'win32' && this.platform !== 'darwin') throw Error('Native After Effects scripting is supported on Windows (AfterFX.exe -r) and macOS (DoScriptFile Apple Event) only; use an actually configured native platform bridge.');
    if (this.pending) throw new AEUncertainExecutionError(this.pending, this.expiryGraceMs);
    if (!ALLOWED.has(operation)) throw Error('Unknown original AE operation');
    const request = { operation, args }; validatePlain(request);
    const nonce = randomUUID(), directory = await mkdtemp(path.join(tmpdir(), 'postcreator-ae-script-'));
    const receiptPath = path.join(directory, 'receipt.json'), scriptPath = path.join(directory, 'request.jsx');
    const expiresAt = this.now() + (operation === 'render.frame' ? Math.max(this.timeoutMs, 60000) : this.timeoutMs);
    const pending = { nonce, request, expiresAt, directory, receiptPath, scriptPath };
    this.pending = pending;
    try {
      const hostSource = await readFile(HOST, 'utf8');
      const source = generateAeRequestScript({ hostSource, request, nonce, expiresAt, receiptPath });
      await writeFile(scriptPath, source, { encoding: 'utf8', mode: 0o600 });
      pending.launch = this.launchProcess(this.executable, scriptPath, pending);
      while (this.now() <= expiresAt && !this.closed) {
        if (pending.launch?.startError) { await this.cleanup(pending); this.pending = null; throw Error(`AfterFX executable could not be started; native execution was not submitted. ${pending.launch.startError.message}`); }
        const recovered = await this.recover();
        if (recovered.state !== 'pending') return this.result(recovered);
        await wait(this.pollMs);
      }
      throw new AEUncertainExecutionError(pending, this.expiryGraceMs);
    } catch (error) {
      // Before launch, non-execution is proven; after launch, retain uncertainty and files.
      if (!pending.launch && this.pending === pending) { this.pending = null; await this.cleanup(pending); }
      throw error;
    }
  }
  async recover() {
    const pending = this.pending;
    if (!pending) return { state: 'idle' };
    let receipt;
    try {
      const info = await stat(pending.receiptPath);
      if (!info.isFile() || info.size > MAX_RECEIPT) throw Error('Invalid bounded AE receipt');
      receipt = JSON.parse((await readFile(pending.receiptPath, 'utf8')).replace(/^\uFEFF/, ''));
    } catch (error) {
      // No receipt at all well past the deadline: the script never wrote `started`, so it never dispatched,
      // and a late run stops at its own deadline check. A half-written receipt is still being written: wait.
      if (error?.code === 'ENOENT' && this.now() > pending.expiresAt + this.expiryGraceMs) {
        this.pending = null;
        await this.cleanup(pending);
        return { state: 'expired', requestId: pending.nonce, operation: pending.request.operation, expiresAt: pending.expiresAt, released: true };
      }
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return { state: 'pending', requestId: pending.nonce, operation: pending.request.operation, expiresAt: pending.expiresAt };
      throw error;
    }
    if (receipt.nonce !== pending.nonce || receipt.expiresAt !== pending.expiresAt) throw Error('Uncorrelated AE receipt; pending execution retained');
    if (receipt.phase === 'started') return { state: 'pending', requestId: pending.nonce, operation: pending.request.operation, expiresAt: pending.expiresAt, nativeStarted: true };
    if (!['completed', 'failed', 'expired'].includes(receipt.phase)) throw Error('Invalid native receipt phase');
    let response = {};
    if (receipt.bodyEncoded) response = JSON.parse(decodeURIComponent(receipt.bodyEncoded));
    if (receipt.phase === 'completed' && !Object.hasOwn(response, 'result') && !Object.hasOwn(response, 'error')) throw Error('Invalid native completion');
    if (receipt.phase === 'completed' && !response.error && ['project.save', 'render.frame'].includes(pending.request.operation)) {
      const output = await stat(pending.request.args.path);
      if (!output.isFile() || output.size === 0) throw Error('Native operation returned but output is absent/empty; inspect pending state');
    }
    this.pending = null;
    await this.cleanup(pending);
    return { state: receipt.phase, requestId: pending.nonce, operation: pending.request.operation, response };
  }
  result(receipt) {
    if (receipt.state === 'expired') throw Error('AE request expired before dispatch; no late native mutation was permitted');
    if (receipt.response?.error || receipt.state === 'failed') throw Error(receipt.response?.error || 'Native AE script failed');
    return receipt.response.result;
  }
  async cleanup(pending) {
    if (path.dirname(pending.directory) !== path.resolve(tmpdir()) || !path.basename(pending.directory).startsWith('postcreator-ae-script-')) throw Error('Invalid private AE staging directory');
    await rm(pending.scriptPath, { force: true }); await rm(pending.receiptPath, { force: true }); await rmdir(pending.directory).catch(() => {});
  }
  close() { this.closed = true; } // Never kill After Effects or discard an uncertain receipt.
}

/** Inherits the original closed operation/media/fresh-output preflight; changes only transport. */
export class AEScriptAdapter extends AEPanelAdapter {
  constructor(executable, outputRoot, options = {}) { super(null, outputRoot); this.transport = new AEScriptTransport(executable, options); this.queue = Promise.resolve(); this.pendingCall = null; }
  call(operation, args = {}) {
    const queued = this.queue.then(async () => {
      const fingerprint = JSON.stringify({ operation, args });
      if (this.transport.pending) {
        const receipt = await this.transport.recover();
        if (receipt.state === 'pending') throw new AEUncertainExecutionError(this.transport.pending, this.transport.expiryGraceMs);
        if (operation === 'status') {
          if (receipt.state === 'failed' || receipt.response?.error) this.transport.result(receipt);
          // A recovered mutation receipt is not proof of a fresh native status handshake.
          this.pendingCall = fingerprint;
          const status = await super.call('status', args);
          return { ...status, recoveredRequest: { requestId: receipt.requestId, operation: receipt.operation, state: receipt.state } };
        }
        // An expired request provably never dispatched: there is nothing to inspect, the new call goes ahead.
        if (receipt.state !== 'expired') {
          if (fingerprint === this.pendingCall) return this.transport.result(receipt);
          throw Error('Previous native request recovered; inspect its completion before a different operation');
        }
      }
      this.pendingCall = fingerprint;
      const result = await super.call(operation, args);
      if (operation === 'native.catalog') result.structuredContent.source = 'postcreator-original-afterfx-script';
      return result;
    });
    this.queue = queued.catch(() => {});
    return queued;
  }
}
