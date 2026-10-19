'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ensurePtyHelperExecutable, ptyHelpFor } = require('./pty-fix');

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
    // The fallback only runs because the in-process shell failed; if it cannot start either,
    // that first reason is the useful one ("posix_spawnp failed" + how to fix it), so keep it.
    const why = (err) =>
      'Could not start the local-terminal helper (' + (err.message || err) + ')' +
      (this._inprocError ? '. The shell itself failed with: ' + this._inprocError : '');
    try {
      this.host = spawn(nodeBin, [script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: (process.env.PATH || '') + ':/usr/local/bin:/opt/homebrew/bin:/usr/bin' },
      });
    } catch (err) {
      this._lastError = why(err);
      return false;
    }
    this._hostTabs = new Set();
    this.host.stdout.on('data', (c) => this._onHostData(c));
    this.host.stderr.on('data', () => {});
    // A missing `node` arrives HERE, after spawn() already returned: without this the tabs
    // waiting on the helper would just stay blank.
    this.host.on('error', (err) => {
      this._lastError = why(err);
      for (const id of this._hostTabs || []) this.send('pty:exit', { tabId: id, exitCode: -1, error: this._lastError });
      if (this._hostTabs) this._hostTabs.clear();
      this.host = null;
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
      if (m.type !== 'data' && this._hostTabs) this._hostTabs.delete(m.id); // it answered
      if (m.type === 'data') this.send('pty:data', { tabId: m.id, data: m.data });
      else if (m.type === 'exit') this.send('pty:exit', { tabId: m.id, exitCode: m.exitCode });
      else if (m.type === 'error' || m.type === 'fatal') {
        this._lastError = withHelp(m.error);
        this.send('pty:exit', { tabId: m.id, exitCode: -1, error: this._lastError });
      }
    }
  }

  spawn(tabId, opts) {
    opts = opts || {};
    // Once per run, before the first shell: node-pty 1.1.0 ships its macOS helper without
    // the executable bit, which is what "posix_spawnp failed" means (see pty-fix.js).
    if (!this._helperChecked) {
      this._helperChecked = true;
      this.helperFix = ensurePtyHelperExecutable();
    }
    const mode = this._init();
    const shell = usableShell(opts.shell || defaultShell());
    const cwd = usableCwd(opts.cwd);
    if (mode === 'inproc') {
      try {
        const p = this.ptyMod.spawn(shell, [], {
          name: 'xterm-256color',
          cols: opts.cols || 80,
          rows: opts.rows || 24,
          cwd,
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
        this._lastError = withHelp(err.message || String(err));
        this._inprocError = this._lastError;
        this.mode = 'host';
      }
    }
    // Host mode
    if (!this._ensureHost()) {
      return { ok: false, error: this._lastError || 'pty host unavailable' };
    }
    if (this._hostTabs) this._hostTabs.add(tabId);
    this._hostSend({ type: 'spawn', id: tabId, shell, cols: opts.cols, rows: opts.rows, cwd });
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

// A $SHELL that points at a shell since uninstalled (fish, a Homebrew bash) fails the very
// same way as a broken helper - posix_spawnp - so fall back to one that exists.
function usableShell(shell) {
  if (process.platform === 'win32' || !path.isAbsolute(shell || '')) return shell;
  if (fs.existsSync(shell)) return shell;
  return ['/bin/zsh', '/bin/bash', '/bin/sh'].find((s) => fs.existsSync(s)) || shell;
}
// A remembered folder that is gone (deleted, an unplugged drive, another machine's path):
// start at home rather than not start at all.
function usableCwd(cwd) {
  try {
    if (cwd && fs.statSync(cwd).isDirectory()) return cwd;
  } catch (_) {
    /* gone */
  }
  return os.homedir();
}
function withHelp(msg) {
  const hint = ptyHelpFor(msg);
  return hint ? msg + ' ' + hint : msg;
}

module.exports = { LocalPty, defaultShell, usableShell, usableCwd };
