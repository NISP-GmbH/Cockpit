'use strict';

const { spawn } = require('child_process');

// Tracks the foreground application so time can be attributed to whatever you're actually
// using OUTSIDE Electron (VS Code, a browser, a PDF, …). Uses OS helpers only - no native
// module and no build step (which matters here: node-pty already can't compile due to the
// space in the repo path):
//   - Windows: a persistent PowerShell loop that P/Invokes user32.dll.
//   - macOS:   a shell loop calling `osascript` / System Events for the frontmost app name
//              (needs a one-time Automation permission grant; no Screen Recording needed
//              because we never read window titles).
// Other platforms are a graceful no-op. It reports { app, title } (title is empty on macOS);
// the caller decides what to store.
class AppTracker {
  constructor() {
    this.proc = null;
    this.onSample = null; // ({ app, title }) => void
    this.intervalSec = 5;
    this._buf = '';
  }
  get supported() {
    return process.platform === 'win32' || process.platform === 'darwin';
  }

  start(intervalSec) {
    if (intervalSec) this.intervalSec = Math.max(2, intervalSec | 0);
    if (!this.supported || this.proc) return;
    let cmd;
    let args;
    if (process.platform === 'win32') {
      const enc = Buffer.from(this._winScript(this.intervalSec), 'utf16le').toString('base64');
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc];
    } else if (process.platform === 'darwin') {
      cmd = '/bin/sh';
      args = ['-c', this._macScript(this.intervalSec)];
    } else {
      return;
    }
    try {
      this.proc = spawn(cmd, args, { windowsHide: true });
    } catch (_) {
      this.proc = null;
      return;
    }
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    if (this.proc.stderr) this.proc.stderr.on('data', () => {});
    this.proc.on('close', () => {
      this.proc = null;
    });
    this.proc.on('error', () => {
      this.proc = null;
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
    this._buf = '';
  }

  setInterval(sec) {
    const s = Math.max(2, sec | 0);
    if (s === this.intervalSec) return;
    this.intervalSec = s;
    if (this.proc) {
      this.stop();
      this.start();
    }
  }

  _onData(chunk) {
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      // Windows emits a JSON object per line; macOS emits the plain app name per line.
      let obj = null;
      if (line[0] === '{') {
        try {
          obj = JSON.parse(line);
        } catch (_) {
          continue;
        }
      } else {
        obj = { app: line, title: '' };
      }
      if (obj && this.onSample) {
        try {
          this.onSample({ app: String(obj.app || '').slice(0, 60), title: String(obj.title || '').slice(0, 200) });
        } catch (_) {
          /* consumer error */
        }
      }
    }
  }

  // A self-contained PowerShell loop: emit one compact JSON line per interval with the
  // foreground window's process name and title.
  _winScript(sec) {
    return `
$src = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
Add-Type -TypeDefinition $src
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
while ($true) {
  try {
    $h = [FgWin]::GetForegroundWindow()
    $procId = 0
    [void][FgWin]::GetWindowThreadProcessId($h, [ref]$procId)
    $sb = New-Object System.Text.StringBuilder 512
    [void][FgWin]::GetWindowText($h, $sb, 512)
    $title = $sb.ToString()
    $name = ""
    try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
    $o = New-Object psobject -Property @{ app = $name; title = $title }
    Write-Output ($o | ConvertTo-Json -Compress)
  } catch {}
  Start-Sleep -Seconds ${sec}
}
`;
  }

  // macOS: print the frontmost application's name once per interval. Uses System Events
  // (needs a one-time Automation grant); errors before the grant go to stderr and are
  // swallowed, so we simply emit nothing until permission is given.
  _macScript(sec) {
    const osa = "osascript -e 'tell application \"System Events\" to get name of first application process whose frontmost is true' 2>/dev/null";
    return `while true; do ${osa}; sleep ${sec}; done`;
  }
}

module.exports = { AppTracker };
