'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Local terminal backend. Prefers requiring node-pty in-process (works when it's
// been rebuilt for Electron's ABI, e.g. in a packaged build). If that fails — the
// common run-from-source case where node-pty was built for the system Node — it
// falls back to a child "pty-host" process launched with the system Node.
class LocalPty {
  constructor(send) {
    this.send = send; // (channel, payload) => webContents.send
    this.mode = null; // 'inproc' | 'host'
    this.ptyMod = null; // node-pty module (in-proc mode)
    this.inproc = new Map(); // tabId -> IPty
    this.host = null; // child process (host mode)
    this._hostBuf = '';
    this._lastError = null;
  }

  _init() {
    if (this.mode) return this.mode;
    try {
      this.ptyMod = require('node-pty');
      // Touch a property so a broken/ABI-mismatched binary throws here, not later.
      if (typeof this.ptyMod.spawn !== 'function') throw new Error('node-pty has no spawn()');
      this.mode = 'inproc';
    } catch (err) {
      this._lastError = err.message || String(err);
      this.mode = 'host';
    }
    return this.mode;
  }

  _ensureHost() {
    if (this.host) return true;
    const script = path.join(__dirname, 'pty-host.js');
    // GUI-launched apps (Finder/dock) get a minimal PATH, so `node` may not resolve.
    // Prefer the npm-launched Node, then the first Node that actually exists on disk,
    // and only fall back to a bare `node` (PATH lookup) as a last resort.
    const abs = ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'];
    let nodeBin = process.env.npm_node_execpath && fs.existsSync(process.env.npm_node_execpath)
      ? process.env.npm_node_execpath
      : abs.find((p) => fs.existsSync(p)) || 'node';
    try {
      this.host = spawn(nodeBin, [script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: (process.env.PATH || '') + ':/usr/local/bin:/opt/homebrew/bin:/usr/bin' },
      });
    } catch (err) {
      this._lastError = 'Could not start the local-terminal helper: ' + (err.message || err);
      return false;
    }
    this.host.stdout.on('data', (c) => this._onHostData(c));
    this.host.stderr.on('data', () => {});
    this.host.on('error', (err) => {
      this._lastError = err.message || String(err);
    });
    this.host.on('exit', () => {
      this.host = null;
    });
    return true;
  }

  _hostSend(obj) {
    if (this.host && this.host.stdin.writable) this.host.stdin.write(JSON.stringify(obj) + '\n');
  }

  _onHostData(chunk) {
    this._hostBuf += chunk.toString('utf8');
    let idx;
    while ((idx = this._hostBuf.indexOf('\n')) >= 0) {
      const line = this._hostBuf.slice(0, idx);
      this._hostBuf = this._hostBuf.slice(idx + 1);
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (m.type === 'data') this.send('pty:data', { tabId: m.id, data: m.data });
      else if (m.type === 'exit') this.send('pty:exit', { tabId: m.id, exitCode: m.exitCode });
      else if (m.type === 'error' || m.type === 'fatal') {
        this._lastError = m.error;
        this.send('pty:exit', { tabId: m.id, exitCode: -1, error: m.error });
      }
    }
  }

  spawn(tabId, opts) {
    opts = opts || {};
    const mode = this._init();
    const shell = opts.shell || defaultShell();
    if (mode === 'inproc') {
      try {
        const p = this.ptyMod.spawn(shell, [], {
          name: 'xterm-256color',
          cols: opts.cols || 80,
          rows: opts.rows || 24,
          cwd: opts.cwd || os.homedir(),
          env: process.env,
        });
        this.inproc.set(tabId, p);
        p.onData((d) => this.send('pty:data', { tabId, data: d }));
        p.onExit((e) => {
          this.send('pty:exit', { tabId, exitCode: e.exitCode });
          this.inproc.delete(tabId);
        });
        return { ok: true, pid: p.pid, shell, backend: 'inproc' };
      } catch (err) {
        // In-process node-pty loaded but couldn't launch the shell (common on macOS
        // when its native spawn-helper is quarantined/unsigned). Fall back to the
        // host subprocess, which uses the system Node's (freshly-installed) node-pty.
        this._lastError = err.message || String(err);
        this.mode = 'host';
      }
    }
    // Host mode
    if (!this._ensureHost()) {
      return { ok: false, error: this._lastError || 'pty host unavailable' };
    }
    this._hostSend({ type: 'spawn', id: tabId, shell, cols: opts.cols, rows: opts.rows, cwd: opts.cwd });
    return { ok: true, shell, backend: 'host' };
  }

  write(tabId, data) {
    if (this.mode === 'inproc') {
      const p = this.inproc.get(tabId);
      if (p) p.write(data);
    } else {
      this._hostSend({ type: 'write', id: tabId, data });
    }
  }

  resize(tabId, cols, rows) {
    if (this.mode === 'inproc') {
      const p = this.inproc.get(tabId);
      if (p) {
        try {
          p.resize(Math.max(1, cols | 0), Math.max(1, rows | 0));
        } catch (_) {
          /* ignore */
        }
      }
    } else {
      this._hostSend({ type: 'resize', id: tabId, cols, rows });
    }
  }

  kill(tabId) {
    if (this.mode === 'inproc') {
      const p = this.inproc.get(tabId);
      if (p) {
        try {
          p.kill();
        } catch (_) {
          /* ignore */
        }
        this.inproc.delete(tabId);
      }
    } else {
      this._hostSend({ type: 'kill', id: tabId });
    }
  }

  disposeAll() {
    for (const p of this.inproc.values()) {
      try {
        p.kill();
      } catch (_) {
        /* ignore */
      }
    }
    this.inproc.clear();
    if (this.host) {
      try {
        this.host.kill();
      } catch (_) {
        /* ignore */
      }
      this.host = null;
    }
  }
}

function defaultShell() {
  if (process.platform === 'win32') return process.env.COMSPEC ? 'powershell.exe' : 'cmd.exe';
  if (process.platform === 'darwin') return process.env.SHELL || '/bin/zsh';
  return process.env.SHELL || '/bin/bash';
}

module.exports = { LocalPty, defaultShell };
