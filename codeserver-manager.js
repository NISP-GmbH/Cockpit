'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

// Extra PATH so we find Node/curl/code-server even when Cockpit is launched from
// Finder/dock (GUI apps get a minimal PATH on macOS).
const EXTRA_PATH = ':/usr/local/bin:/opt/homebrew/bin:/usr/bin:' + path.join(os.homedir(), '.local/bin');
function withPath(env) {
  return { ...(env || process.env), PATH: (process.env.PATH || '') + EXTRA_PATH };
}

// Runs a local code-server (full VS Code in the browser) and hands back its URL so
// the renderer can open it in a web tab. Auto-installs code-server on first use.
class CodeServerManager {
  constructor() {
    this.proc = null;
    this.url = null;
    this.port = 8899;
    this._starting = null;
  }

  _candidates(configured) {
    const home = os.homedir();
    return [
      configured,
      path.join(home, '.local/bin/code-server'),
      '/opt/homebrew/bin/code-server',
      '/usr/local/bin/code-server',
      '/usr/bin/code-server',
    ].filter(Boolean);
  }

  locate(configured) {
    for (const p of this._candidates(configured)) {
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch (_) {
        /* keep looking */
      }
    }
    try {
      const out = execSync('command -v code-server 2>/dev/null', { encoding: 'utf8', env: withPath() }).trim();
      if (out) return out.split('\n')[0];
    } catch (_) {
      /* not on PATH */
    }
    return null;
  }

  install(onLog) {
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        resolve({ ok: false, error: 'Auto-install is not supported on Windows — run code-server inside WSL.' });
        return;
      }
      if (onLog) onLog('Installing code-server (first run only — this can take a minute)…\n');
      const child = spawn('sh', ['-c', 'curl -fsSL https://code-server.dev/install.sh | sh'], { env: withPath() });
      child.stdout.on('data', (d) => onLog && onLog(d.toString()));
      child.stderr.on('data', (d) => onLog && onLog(d.toString()));
      child.on('error', (e) => resolve({ ok: false, error: e.message || String(e) }));
      child.on('exit', (code) => resolve({ ok: code === 0, error: code === 0 ? null : 'installer exited ' + code }));
    });
  }

  /** Start (or reuse) code-server and return { ok, url }. */
  async start(opts, onLog) {
    opts = opts || {};
    if (this.proc && this.url) return { ok: true, url: this._url(opts.folder), reused: true };
    if (this._starting) return this._starting;
    this._starting = this._start(opts, onLog).finally(() => {
      this._starting = null;
    });
    return this._starting;
  }

  _url(folder) {
    const f = folder || os.homedir();
    return `http://127.0.0.1:${this.port}/?folder=${encodeURIComponent(f)}`;
  }

  async _start(opts, onLog) {
    let bin = this.locate(opts.binPath);
    if (!bin) {
      const inst = await this.install(onLog);
      if (!inst.ok) return inst;
      bin = this.locate(opts.binPath);
      if (!bin) return { ok: false, error: 'code-server installed but could not be located on PATH.' };
    }
    const folder = opts.folder || os.homedir();
    this.port = opts.port || this.port;
    const url = this._url(folder);
    if (onLog) onLog(`Starting code-server on 127.0.0.1:${this.port} …\n`);
    const child = spawn(
      bin,
      [
        '--bind-addr', `127.0.0.1:${this.port}`,
        '--auth', 'none',
        '--disable-telemetry',
        '--disable-update-check',
        folder,
      ],
      { env: withPath() }
    );
    this.proc = child;

    return await new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      };
      const onData = (d) => {
        const s = d.toString();
        if (onLog) onLog(s);
        if (/HTTP server listening on|listening on https?:\/\//i.test(s)) {
          this.url = url;
          finish({ ok: true, url });
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (e) => {
        this.proc = null;
        finish({ ok: false, error: e.message || String(e) });
      });
      child.on('exit', (c) => {
        this.proc = null;
        this.url = null;
        finish({ ok: false, error: 'code-server exited (' + c + ')' });
      });
      // Fallback: assume it's up after a while even if we didn't match the log line.
      const timer = setTimeout(() => {
        if (this.proc) {
          this.url = url;
          finish({ ok: true, url });
        }
      }, 20000);
    });
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch (_) {
        /* ignore */
      }
      this.proc = null;
    }
    this.url = null;
  }

  status() {
    return { running: !!this.proc, url: this.url, port: this.port };
  }
}

module.exports = { CodeServerManager };
