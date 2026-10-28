import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Optional native bridge only. Offline proprietary skill tools are never forwarded.
export class StdioClient {
  constructor(command, args, env) { this.command = command; this.args = args; this.env = env; this.pending = new Map(); this.next = 0; }
  async connect() {
    if (this.child) return;
    this.child = spawn(this.command, this.args, { env: this.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.child.stderr.on('data', () => {});
    this.child.on('error', error => this.abort(error));
    this.child.on('exit', () => { this.abort(new Error('Native bridge exited')); this.child = null; });
    createInterface({ input: this.child.stdout }).on('line', line => {
      try { const response = JSON.parse(line); const p = this.pending.get(response.id); if (p) { this.pending.delete(response.id); clearTimeout(p.timer); response.error ? p.reject(new Error(response.error.message)) : p.resolve(response.result); } } catch { /* non-protocol startup line */ }
    });
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'postcreator-desktop', version: '1.1.0' } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  abort(error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  request(method, params, timeout = 90000) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Bridge request timed out; inspect state before retrying')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  close() { this.abort(new Error('Bridge closed')); this.child?.kill(); this.child = null; }
}
