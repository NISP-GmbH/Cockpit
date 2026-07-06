'use strict';

// Standalone PTY host. Runs under the system Node (where node-pty's native binary
// matches the ABI), bridged to the Electron main process over stdio with a simple
// newline-delimited JSON protocol. This sidesteps rebuilding node-pty for Electron.
//
// In → { type:'spawn', id, shell?, cols, rows, cwd }
//      { type:'write', id, data }
//      { type:'resize', id, cols, rows }
//      { type:'kill', id }
// Out → { type:'ready', id, pid, shell }
//      { type:'data', id, data }
//      { type:'exit', id, exitCode, signal }
//      { type:'error', id, error }

const os = require('os');
let pty;
try {
  pty = require('node-pty');
} catch (err) {
  process.stdout.write(JSON.stringify({ type: 'fatal', error: err.message || String(err) }) + '\n');
  process.exit(1);
}

const sessions = new Map();

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function defaultShell() {
  if (process.platform === 'win32') return process.env.COMSPEC ? 'powershell.exe' : 'cmd.exe';
  if (process.platform === 'darwin') return process.env.SHELL || '/bin/zsh';
  return process.env.SHELL || '/bin/bash';
}

function handle(msg) {
  const id = msg.id;
  if (msg.type === 'spawn') {
    try {
      const shell = msg.shell || defaultShell();
      const p = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: msg.cols || 80,
        rows: msg.rows || 24,
        cwd: msg.cwd || os.homedir(),
        env: process.env,
      });
      sessions.set(id, p);
      p.onData((d) => out({ type: 'data', id, data: d }));
      p.onExit((e) => {
        out({ type: 'exit', id, exitCode: e.exitCode, signal: e.signal });
        sessions.delete(id);
      });
      out({ type: 'ready', id, pid: p.pid, shell });
    } catch (err) {
      out({ type: 'error', id, error: err.message || String(err) });
    }
  } else if (msg.type === 'write') {
    const p = sessions.get(id);
    if (p) p.write(msg.data);
  } else if (msg.type === 'resize') {
    const p = sessions.get(id);
    if (p) {
      try {
        p.resize(Math.max(1, msg.cols | 0), Math.max(1, msg.rows | 0));
      } catch (_) {
        /* ignore transient resize errors */
      }
    }
  } else if (msg.type === 'kill') {
    const p = sessions.get(id);
    if (p) {
      try {
        p.kill();
      } catch (_) {
        /* ignore */
      }
      sessions.delete(id);
    }
  }
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      continue;
    }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('exit', () => {
  for (const p of sessions.values()) {
    try {
      p.kill();
    } catch (_) {
      /* ignore */
    }
  }
});
