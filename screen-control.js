'use strict';

// Screen control: a program in a Cockpit LOCAL terminal (Claude Code above all) may look at and
// operate the desktop - screenshots, mouse, keyboard, windows - through tools/cockpit-screen.js
// (an MCP server and a CLI in one file). How a request travels:
//
//   program -> cockpit-screen.js -> named pipe (one JSON line per request, with the TOKEN of the
//   terminal it runs in) -> this module: is that terminal granted? -> one queue -> the platform
//   backend (Windows: screen-win.cs compiled by PowerShell; no native module).
//
// The token and the pipe's name are environment variables of ONE terminal's shell (pty:spawn), so
// only programs started in that terminal carry them - which is what makes the grant per terminal.
// SSH tabs never get them: a remote program cannot reach the pipe at all.
//
// Safety, and why:
// - Nothing happens without a grant the USER gave in Cockpit (15 / 60 min / until the tab closes).
// - While any grant question is open, no input is sent: a granted terminal must never be able to
//   click "Allow" for another one.
// - Cockpit's own windows are off limits (setting, default on): a click / key / typing whose
//   target is a Cockpit window is refused - otherwise a program could type into other terminals,
//   change Settings or answer the grant dialog itself.
// - Ctrl+Alt+Esc (a global shortcut, only while a grant exists) and the indicator's Stop revoke
//   everything at once and drop what is queued; long typing is sent in pieces so it stops too.
// - Every action goes to the Black Box; typed text only as its LENGTH (it may be a password).

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ASK_TIMEOUT_MS = 60000;
const DENY_COOLDOWN_MS = 20000; // a refused terminal does not reopen the question at once
const SPACE_TTL_MS = 10 * 60000; // how long a screenshot's coordinate space stays usable
const TYPE_MAX = 4000;
const TYPE_PIECE = 80; // characters per helper call, so Stop takes effect within one piece
const HELPER_TIMEOUT_MS = 20000;
const INPUT_METHODS = new Set(['move', 'click', 'drag', 'scroll', 'type', 'key', 'focus', 'launch', 'uiAct']);
// wait_for polls for up to a minute: it must not hold the ONE queue that long, so it runs beside it
// and puts each single look into the queue.
const OUTSIDE_QUEUE = new Set(['wait']);
const GRID_CELL = 24; // px per cell of the change fingerprint
const GRID_THRESHOLD = 18; // brightness steps a cell must move to count as changed (a caret does not)
const WAIT_MAX_S = 60;
const SCREEN_SPACE = { id: 'screen', ox: 0, oy: 0, scale: 1 }; // real pixels of the virtual desktop

// Which cells of two fingerprints of the same area differ. Changed cells are grouped (8-neighbour);
// a group no bigger than 2x2 cells is a blinking caret or cursor and is left out unless `small`.
// Cells under `mask` (the indicator) never count. Returns the bounding box of the rest, in pixels.
function gridChanges(a, b, rect, o) {
  o = o || {};
  if (!a || !b || a.cols !== b.cols || a.rows !== b.rows) return { changed: true, cells: -1, box: { ...rect } };
  const { cols, rows, cell } = a;
  const thr = o.threshold || GRID_THRESHOLD;
  const m = o.mask;
  const hit = new Uint8Array(cols * rows);
  for (let i = 0; i < hit.length; i++) {
    if (Math.abs(a.v[i] - b.v[i]) <= thr) continue;
    if (m) {
      const cx = rect.x + (i % cols) * cell;
      const cy = rect.y + Math.floor(i / cols) * cell;
      if (cx < m.x + m.width && cx + cell > m.x && cy < m.y + m.height && cy + cell > m.y) continue;
    }
    hit[i] = 1;
  }
  let box = null;
  let cells = 0;
  const seen = new Uint8Array(hit.length);
  for (let i = 0; i < hit.length; i++) {
    if (!hit[i] || seen[i]) continue;
    let c0 = cols, c1 = -1, r0 = rows, r1 = -1, n = 0;
    const todo = [i];
    seen[i] = 1;
    while (todo.length) {
      const j = todo.pop();
      const c = j % cols;
      const r = (j - c) / cols;
      n++;
      c0 = Math.min(c0, c);
      c1 = Math.max(c1, c);
      r0 = Math.min(r0, r);
      r1 = Math.max(r1, r);
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          const k = rr * cols + cc;
          if (hit[k] && !seen[k]) {
            seen[k] = 1;
            todo.push(k);
          }
        }
    }
    if (!o.small && c1 - c0 < 2 && r1 - r0 < 2) continue;
    cells += n;
    const g = { x0: c0, y0: r0, x1: c1, y1: r1 };
    box = box ? { x0: Math.min(box.x0, g.x0), y0: Math.min(box.y0, g.y0), x1: Math.max(box.x1, g.x1), y1: Math.max(box.y1, g.y1) } : g;
  }
  if (!box) return { changed: false, cells: 0, box: null };
  const x = rect.x + box.x0 * cell;
  const y = rect.y + box.y0 * cell;
  return {
    changed: true,
    cells,
    box: { x, y, w: Math.min(rect.x + rect.w, rect.x + (box.x1 + 1) * cell) - x, h: Math.min(rect.y + rect.h, rect.y + (box.y1 + 1) * cell) - y },
  };
}
// Text found in OCR lines: the run of words that holds it (case and spacing ignored), else null.
function findText(lines, what) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const f = norm(what);
  if (!f) return null;
  for (const l of lines) {
    if (!norm(l.text).includes(f)) continue;
    const ws = l.words || [];
    let best = null; // the SHORTEST run of words that holds it
    for (let i = 0; i < ws.length; i++) {
      let s = '';
      for (let j = i; j < ws.length; j++) {
        s = norm(s + ' ' + ws[j].t);
        if (!s.includes(f)) continue;
        if (!best || j - i < best[1] - best[0]) best = [i, j];
        break;
      }
    }
    if (!best) return { text: l.text, line: l.text, x: l.x, y: l.y, w: l.w, h: l.h };
    const run = ws.slice(best[0], best[1] + 1);
    const x0 = Math.min(...run.map((w) => w.x));
    const y0 = Math.min(...run.map((w) => w.y));
    const x1 = Math.max(...run.map((w) => w.x + w.w));
    const y1 = Math.max(...run.map((w) => w.y + w.h));
    return { text: run.map((w) => w.t).join(' '), line: l.text, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  return null;
}
const STOP_ACCELERATOR = 'Ctrl+Alt+Escape';

// ---- the Windows backend: one long-lived PowerShell running screen-win.cs ----
const WIN_BOOT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$first = [Console]::In.ReadLine()',
  'try {',
  '  $src = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($first))',
  '  Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing, System.Web.Extensions, UIAutomationClient, UIAutomationTypes, WindowsBase',
  "  [Console]::Out.WriteLine('{\"ready\":true}')",
  '} catch {',
  "  [Console]::Out.WriteLine('{\"ready\":false,\"error\":' + (ConvertTo-Json ([string]$_.Exception.Message)) + '}')",
  '  exit 1',
  '}',
  '[Console]::Out.Flush()',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($line -eq $null) { break }',
  '  [Console]::Out.WriteLine([CockpitScreen]::Handle($line))',
  '  [Console]::Out.Flush()',
  '}',
].join('\n');

class WinBackend {
  constructor(srcPath) {
    this.srcPath = srcPath;
    this.proc = null;
    this.ready = null;
    this.waiting = new Map();
    this.seq = 0;
    this.buf = '';
  }
  _start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let src;
      try {
        src = fs.readFileSync(this.srcPath, 'utf8');
      } catch (e) {
        this.ready = null;
        return reject(new Error('screen helper source missing: ' + e.message));
      }
      const enc = Buffer.from(WIN_BOOT, 'utf16le').toString('base64');
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true });
      this.proc = p;
      let started = false;
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (c) => {
        this.buf += c;
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          let m;
          try {
            m = JSON.parse(line);
          } catch (_) {
            continue;
          }
          if (!started) {
            started = true;
            if (m.ready) resolve();
            else reject(new Error('screen helper did not start: ' + (m.error || 'unknown')));
            continue;
          }
          const w = this.waiting.get(m.id);
          if (!w) continue;
          this.waiting.delete(m.id);
          clearTimeout(w.timer);
          if (m.ok) w.resolve(m.result);
          else w.reject(new Error(m.error || 'failed'));
        }
      });
      p.stderr.on('data', () => {});
      const gone = (why) => {
        if (this.proc !== p) return;
        this.proc = null;
        this.ready = null;
        if (!started) reject(new Error('screen helper exited: ' + why));
        for (const w of this.waiting.values()) {
          clearTimeout(w.timer);
          w.reject(new Error('screen helper exited'));
        }
        this.waiting.clear();
      };
      p.on('error', (e) => gone(e.message));
      p.on('close', (code) => gone('code ' + code));
      p.stdin.write(Buffer.from(src, 'utf8').toString('base64') + '\n');
    });
    return this.ready;
  }
  async call(op, args) {
    await this._start();
    const id = ++this.seq;
    // ASCII only on the way in, so the console code page cannot touch typed text
    const line = JSON.stringify({ id, op, ...(args || {}) }).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('screen helper did not answer'));
      }, HELPER_TIMEOUT_MS);
      this.waiting.set(id, { resolve, reject, timer });
      this.proc.stdin.write(line + '\n');
    });
  }
  stop() {
    if (this.proc) {
      try {
        this.proc.stdin.end();
        this.proc.kill();
      } catch (_) {
        /* gone */
      }
    }
    this.proc = null;
    this.ready = null;
  }
}

// ---- coordinates ----
// A program sees a screenshot DOWNSCALED to at most maxWidth; every coordinate it gives is in the
// space of a picture it got (a screenshot of a monitor, or a zoom). physical = origin + p / scale.
function toPhysical(space, x, y) {
  return { x: Math.round(space.ox + Number(x) / space.scale), y: Math.round(space.oy + Number(y) / space.scale) };
}
function fitScale(w, maxW) {
  return w > maxW ? maxW / w : 1;
}

class ScreenControl {
  constructor(o) {
    this.userData = o.userData;
    this.appDir = o.appDir; // where screen-win.cs and tools/ ship (may be inside the asar)
    this.send = o.send; // (channel, payload) to the main window
    this.electron = o.electron; // { BrowserWindow, globalShortcut, nativeImage }
    this.getMainWindow = o.getMainWindow;
    this.preload = o.preload;
    this.ownPid = o.ownPid || process.pid;
    this.platform = o.platform || process.platform;
    this.backend = o.backend || (this.platform === 'win32' ? new WinBackend(path.join(this.appDir, 'screen-win.cs')) : null);
    this.enabled = false;
    this.offLimits = true; // Cockpit's own windows
    this.maxWidth = 1280;
    this.server = null;
    this.pipeName = null;
    this.tokens = new Map(); // token -> tabId
    this.tabTokens = new Map(); // tabId -> token
    this.titles = new Map(); // tabId -> title (from the renderer)
    this.grants = new Map(); // tabId -> { until: ms | Infinity, since }
    this.denied = new Map(); // tabId -> ms until which a request is refused without asking
    this.asks = new Map(); // tabId -> { id, promise, resolve, timer }
    this.askSeq = 0;
    this.spaces = new Map(); // token -> { current, mon, list: Map id -> space }
    this.looks = new Map(); // token -> { rect, grid, at }: the last screenshot's area, for what_changed
    this.uiSnaps = new Map(); // token -> Map snap -> items of a ui_elements listing
    this.queue = Promise.resolve();
    this.epoch = 0; // bumped by stop(): queued work of an older epoch is dropped
    this.indicator = null;
    this.tick = null;
    this.shortcut = false;
  }

  get supported() {
    return !!this.backend;
  }
  toolsDir() {
    return path.join(this.userData, 'tools');
  }
  scriptPath() {
    return path.join(this.toolsDir(), 'cockpit-screen.js');
  }
  mcpCommand() {
    return 'claude mcp add cockpit-screen -- node "' + this.scriptPath() + '"';
  }
  status() {
    return {
      supported: this.supported,
      enabled: this.enabled,
      offLimits: this.offLimits,
      maxWidth: this.maxWidth,
      mcpCommand: this.mcpCommand(),
      script: this.scriptPath(),
      stopKey: 'Ctrl+Alt+Esc',
      grants: [...this.grants.entries()].map(([tabId, g]) => ({ tabId, until: g.until === Infinity ? null : g.until, title: this.titles.get(tabId) || '' })),
    };
  }

  // ---- switching on / off ----
  configure(o) {
    if (typeof o.offLimits === 'boolean') this.offLimits = o.offLimits;
    if (Number.isFinite(o.maxWidth)) this.maxWidth = Math.max(640, Math.min(2560, Math.round(o.maxWidth)));
    if (typeof o.enabled === 'boolean' && o.enabled !== this.enabled) {
      if (o.enabled) this._enable();
      else this._disable();
    }
    return this.status();
  }
  _enable() {
    if (!this.supported) return;
    this.enabled = true;
    this._installTools();
    this.pipeName = '\\\\.\\pipe\\cockpit-screen-' + crypto.randomBytes(12).toString('hex');
    this.server = net.createServer((sock) => this._client(sock));
    this.server.on('error', () => {});
    this.server.listen(this.pipeName);
  }
  _disable() {
    this.enabled = false;
    this.stop('Screen control was switched off');
    if (this.server) {
      try {
        this.server.close();
      } catch (_) {
        /* closed */
      }
    }
    this.server = null;
    this.pipeName = null;
    this.tokens.clear();
    this.tabTokens.clear();
    if (this.backend && this.backend.stop) this.backend.stop();
  }
  // The tool lives OUTSIDE the app (asar) in userData/tools: a stable path for `claude mcp add`,
  // and plain node can run it. Rewritten only when it changed.
  _installTools() {
    try {
      fs.mkdirSync(this.toolsDir(), { recursive: true });
      const src = fs.readFileSync(path.join(this.appDir, 'tools', 'cockpit-screen.js'), 'utf8');
      const dest = this.scriptPath();
      let old = null;
      try {
        old = fs.readFileSync(dest, 'utf8');
      } catch (_) {
        /* first time */
      }
      if (old !== src) fs.writeFileSync(dest, src);
      const cmd = path.join(this.toolsDir(), 'cockpit-screen.cmd');
      const shim = '@node "%~dp0cockpit-screen.js" %*\r\n';
      let oldShim = null;
      try {
        oldShim = fs.readFileSync(cmd, 'utf8');
      } catch (_) {
        /* first time */
      }
      if (oldShim !== shim) fs.writeFileSync(cmd, shim);
    } catch (_) {
      /* the tool cannot be installed: requests simply never come */
    }
  }

  // ---- terminals ----
  // Environment for a local shell that is being started. Every start gets a NEW token; the old one
  // of that tab (a shell started again) stops working, and so does its grant.
  envFor(tabId) {
    if (!this.enabled || !this.pipeName || !tabId) return null;
    this.tabGone(tabId, true);
    const token = crypto.randomBytes(32).toString('hex');
    this.tokens.set(token, tabId);
    this.tabTokens.set(tabId, token);
    const sep = this.platform === 'win32' ? ';' : ':';
    const curPath = process.env.PATH || process.env.Path || '';
    return { COCKPIT_SCREEN_PIPE: this.pipeName, COCKPIT_SCREEN_TOKEN: token, PATH: this.toolsDir() + sep + curPath };
  }
  setTitle(tabId, title) {
    if (tabId) this.titles.set(tabId, String(title || '').slice(0, 80));
  }
  // The tab closed, or its shell ended: its token and grant go.
  tabGone(tabId, keepTitle) {
    const tok = this.tabTokens.get(tabId);
    if (tok) {
      this.tokens.delete(tok);
      this.spaces.delete(tok);
      this.looks.delete(tok);
      this.uiSnaps.delete(tok);
    }
    this.tabTokens.delete(tabId);
    if (this.grants.delete(tabId)) this._grantsChanged('closed', tabId);
    const a = this.asks.get(tabId);
    if (a) a.resolve('deny');
    if (!keepTitle) this.titles.delete(tabId);
  }

  // ---- the pipe ----
  _client(sock) {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (c) => {
      buf += c;
      if (buf.length > 1e6) return sock.destroy(); // a request is small; a flood is not one
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m = null;
        try {
          m = JSON.parse(line);
        } catch (_) {
          /* not ours */
        }
        if (!m || typeof m !== 'object') continue;
        this.request(m).then((r) => {
          if (!sock.destroyed) sock.write(JSON.stringify({ id: m.id, ...r }) + '\n');
        });
      }
    });
  }
  // One request: { token, method, args } -> { ok, result | error }.
  async request(m) {
    const tabId = typeof m.token === 'string' ? this.tokens.get(m.token) : null;
    if (!this.enabled || !tabId) return { ok: false, error: 'Not a Cockpit terminal with screen control (switched off, or the tab is gone).' };
    const method = String(m.method || '');
    const args = m.args && typeof m.args === 'object' ? m.args : {};
    if (method === 'hello') return { ok: true, result: { tab: this.titles.get(tabId) || '', granted: this._granted(tabId) } };
    if (!this._methods[method]) return { ok: false, error: 'Unknown method ' + method };
    try {
      if (!this._granted(tabId)) {
        const until = this.denied.get(tabId) || 0;
        if (Date.now() < until) return { ok: false, error: 'Screen control was refused for this terminal a moment ago.' };
        const answer = await this._ask(tabId, method, args);
        if (answer === 'deny') {
          this.denied.set(tabId, Date.now() + DENY_COOLDOWN_MS);
          return { ok: false, error: 'The user did not allow screen control for this terminal.' };
        }
      }
      const epoch = this.epoch;
      const run = () => {
        if (epoch !== this.epoch) throw new Error('Stopped by the user.');
        if (!this._granted(tabId)) throw new Error('Screen control for this terminal ended.');
        return this._methods[method].call(this, m.token, tabId, args, epoch);
      };
      const result = OUTSIDE_QUEUE.has(method) ? await run() : await this._step(run);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  _step(fn) {
    return (this.queue = this.queue.then(fn, fn));
  }

  // ---- grants ----
  _granted(tabId) {
    const g = this.grants.get(tabId);
    if (!g) return false;
    if (Date.now() >= g.until) {
      this.grants.delete(tabId);
      this._grantsChanged('expired', tabId);
      return false;
    }
    return true;
  }
  _ask(tabId, method, args) {
    const open = this.asks.get(tabId);
    if (open) return open.promise;
    const id = ++this.askSeq;
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    const a = { id, promise, resolve: null, timer: null };
    a.resolve = (choice) => {
      if (this.asks.get(tabId) !== a) return;
      this.asks.delete(tabId);
      clearTimeout(a.timer);
      if (choice !== 'deny') {
        const mins = choice === 'tab' ? Infinity : Math.max(1, Math.min(480, Number(choice) || 15));
        this.grants.set(tabId, { until: mins === Infinity ? Infinity : Date.now() + mins * 60000, since: Date.now() });
        this._grantsChanged('granted', tabId, choice);
      } else this._log(tabId, '🖱 Screen control refused', '');
      this.send('screen:asked', { askId: id, tabId, choice });
      resolve(choice);
    };
    a.timer = setTimeout(() => a.resolve('deny'), ASK_TIMEOUT_MS);
    this.asks.set(tabId, a);
    this.send('screen:ask', { askId: id, tabId, title: this.titles.get(tabId) || '', first: this._describe(method, args) });
    this._toFront();
    return promise;
  }
  answer(askId, choice) {
    for (const [, a] of this.asks) if (a.id === askId) return a.resolve(['15', '60', 'tab', 'deny'].includes(String(choice)) ? String(choice) : 'deny');
  }
  revoke(tabId) {
    if (this.grants.delete(tabId)) this._grantsChanged('revoked', tabId);
  }
  // Ctrl+Alt+Esc, the indicator's Stop, switching off: every grant ends, queued work is dropped.
  stop(why) {
    this.epoch++;
    const had = this.grants.size;
    this.grants.clear();
    for (const a of [...this.asks.values()]) a.resolve('deny');
    if (had) this._grantsChanged('stopped', null, why || 'Stopped');
  }
  _grantsChanged(kind, tabId, extra) {
    const title = tabId ? this.titles.get(tabId) || 'a terminal' : '';
    if (kind === 'granted') this._log(tabId, '🖱 Screen control allowed for ' + title, extra === 'tab' ? 'until the tab closes' : extra + ' min');
    else if (kind === 'stopped') this._log(null, '🛑 Screen control stopped', extra || '');
    else this._log(tabId, '🖱 Screen control ended for ' + title, kind);
    this.send('screen:status', this.status());
    this._syncIndicator();
  }

  // ---- what each method does ----
  _space(token, id) {
    if (id === 'screen') return SCREEN_SPACE;
    const s = this.spaces.get(token);
    if (!s) return null;
    const sp = id ? s.list.get(String(id)) : s.list.get(s.current);
    if (!sp || Date.now() - sp.at > SPACE_TTL_MS) return null;
    return sp;
  }
  // A monitor screenshot (m<idx>) and a region screenshot become the CURRENT picture (coordinates
  // without a space mean it); a zoom does not. `mon` is the last monitor shot, the default space
  // for a region's own coordinates.
  _addSpace(token, sp, current) {
    let s = this.spaces.get(token);
    if (!s) this.spaces.set(token, (s = { current: null, mon: null, list: new Map(), n: 0 }));
    sp.at = Date.now();
    if (!sp.id) sp.id = 'z' + ++s.n;
    s.list.set(sp.id, sp);
    if (sp.id.startsWith('m')) s.current = s.mon = sp.id;
    else if (current) s.current = sp.id;
    for (const [k, v] of s.list) if (Date.now() - v.at > SPACE_TTL_MS) s.list.delete(k);
    return sp;
  }
  async _point(token, args, x, y) {
    let sp = this._space(token, args.space);
    if (args.space && !sp) throw new Error('Unknown or old picture "' + args.space + '" - take a new screenshot.');
    if (!sp) {
      // no screenshot yet: the primary monitor, full size
      const mons = await this.backend.call('monitors');
      const p = mons.find((m) => m.primary) || mons[0];
      sp = { ox: p.x, oy: p.y, scale: 1 };
    }
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) throw new Error('x and y must be numbers');
    return toPhysical(sp, x, y);
  }
  async _guardPoint(pt) {
    if (!this.offLimits) return;
    const pid = await this.backend.call('ownerAt', pt);
    if (pid === this.ownPid) throw new Error("That point is on a Cockpit window - Cockpit's own windows are not controlled.");
  }
  async _guardForeground() {
    if (!this.offLimits) return;
    const pid = await this.backend.call('foregroundPid');
    if (pid === this.ownPid) throw new Error("Cockpit has the keyboard focus - Cockpit's own windows are not controlled. Focus the target window first.");
  }
  async _waitForAsks() {
    // no input while ANY grant question is open (a granted terminal could otherwise answer it)
    for (let i = 0; this.asks.size && i < ASK_TIMEOUT_MS / 100; i++) await new Promise((r) => setTimeout(r, 100));
  }
  _describe(method, a) {
    if (method === 'screenshot') return a.window ? 'take a screenshot of a window' : a.width ? 'take a screenshot of a part of the screen' : 'take a screenshot';
    if (method === 'zoom') return 'look closer at a part of the screen';
    if (method === 'click') return (a.double ? 'double-click' : (a.button || 'left') + ' click') + ' at ' + a.x + ',' + a.y;
    if (method === 'type') return 'type ' + String(a.text || '').length + ' characters';
    if (method === 'key') return 'press ' + a.combo;
    if (method === 'launch') return 'start ' + a.target;
    if (method === 'focus') return 'bring a window to the front';
    if (method === 'windows') return 'list the open windows';
    if (method === 'ui') return 'read the buttons and fields of a window';
    if (method === 'uiAct') return (a.action || 'click').replace('_', ' ') + ' a button or field';
    if (method === 'text') return 'read the text on the screen';
    if (method === 'wait') return 'wait for something on the screen';
    if (method === 'changes') return 'look at what changed on the screen';
    return method;
  }
  // Where answers that are not pictures (controls, text, changes) give positions: the current
  // picture's space, so they can be clicked as they are; before any screenshot, real pixels.
  _outSpace(token) {
    return this._space(token) || SCREEN_SPACE;
  }
  _box(sp, r) {
    return {
      x: Math.round((r.x + r.w / 2 - sp.ox) * sp.scale),
      y: Math.round((r.y + r.h / 2 - sp.oy) * sp.scale),
      w: Math.max(1, Math.round(r.w * sp.scale)),
      h: Math.max(1, Math.round(r.h * sp.scale)),
    };
  }
  // A window by handle or part of its title; with none given (and `front`), the top-most window that
  // is not Cockpit's - while Claude runs in a Cockpit terminal, Cockpit is usually the one in front.
  async _findWindow(key, front) {
    const list = await this.backend.call('windows');
    if (key == null || key === '') {
      if (!front) return null;
      const w = list.find((x) => !x.minimized && x.pid !== this.ownPid);
      if (!w) throw new Error('No open window (other than Cockpit).');
      return w;
    }
    const k = String(key);
    const t = k.toLowerCase();
    const w = list.find((x) => String(x.handle) === k) || list.find((x) => x.title.toLowerCase().includes(t));
    if (!w) throw new Error('No open window "' + k + '" - list_windows shows them.');
    return w;
  }
  // The area a read / wait looks at: a window, a region, a monitor - or by default the area of the
  // last screenshot (what the program is looking at), else the primary monitor.
  async _target(token, a) {
    if (a.window != null && a.window !== '') {
      const w = await this._findWindow(a.window);
      if (w.minimized) throw new Error('"' + w.title + '" is minimized - bring it up with focus_window first.');
      return { rect: { x: w.x, y: w.y, w: w.w, h: w.h }, label: 'window "' + w.title.slice(0, 60) + '"', window: w };
    }
    if (a.width != null || a.height != null) {
      const base = await this._regionBase(token, a.space);
      const w = Number(a.width);
      const h = Number(a.height);
      if (!(w > 0) || !(h > 0) || !Number.isFinite(Number(a.x || 0)) || !Number.isFinite(Number(a.y || 0))) throw new Error('A region needs x, y, width and height (numbers, width and height > 0).');
      const p0 = toPhysical(base, a.x || 0, a.y || 0);
      return { rect: { x: p0.x, y: p0.y, w: Math.max(1, Math.round(w / base.scale)), h: Math.max(1, Math.round(h / base.scale)) }, label: 'region' };
    }
    const mons = await this.backend.call('monitors');
    if (Number.isInteger(a.monitor) && mons[a.monitor]) {
      const m = mons[a.monitor];
      return { rect: { x: m.x, y: m.y, w: m.w, h: m.h }, label: 'monitor ' + (a.monitor + 1) };
    }
    const look = this.looks.get(token);
    if (look && Date.now() - look.at < SPACE_TTL_MS) return { rect: { ...look.rect }, label: 'the area of the last screenshot' };
    const p = mons.find((m) => m.primary) || mons[0];
    return { rect: { x: p.x, y: p.y, w: p.w, h: p.h }, label: 'the primary monitor' };
  }
  // The indicator pill in real pixels: its countdown must not count as a change or as text.
  _indicatorRect() {
    const ind = this.indicator;
    if (!ind || ind.isDestroyed() || !ind.isVisible()) return null;
    const b = ind.getBounds();
    const scr = this.electron && this.electron.screen;
    try {
      return scr && scr.dipToScreenRect ? scr.dipToScreenRect(ind, b) : b;
    } catch (_) {
      return b;
    }
  }
  async _ocr(rect) {
    const r = await this.backend.call('ocr', rect);
    const m = this._indicatorRect();
    const inM = (l) => m && l.x + l.w / 2 >= m.x && l.x + l.w / 2 < m.x + m.width && l.y + l.h / 2 >= m.y && l.y + l.h / 2 < m.y + m.height;
    return { lines: (r.lines || []).filter((l) => !inM(l)), lang: r.lang || '' };
  }
  _grid(rect) {
    return this.backend.call('grid', { ...rect, cell: GRID_CELL });
  }
  _log(tabId, title, detail) {
    this.send('screen:event', { tabId, title, detail: detail || '' });
  }
  get _methods() {
    return {
      monitors: async () => this.backend.call('monitors'),
      cursor: async (token) => {
        const c = await this.backend.call('cursor');
        const sp = this._space(token);
        return sp ? { x: Math.round((c.x - sp.ox) * sp.scale), y: Math.round((c.y - sp.oy) * sp.scale), space: sp.id, physical: c } : { ...c, physical: c };
      },
      // The whole monitor, or only a part: a rectangle (width + height given) or one window. A part
      // is captured at full resolution and only shrunk when it is larger than the limit, so a small
      // area is a small picture - fewer pixels to send, and sharper than the same spot of a full shot.
      screenshot: async (token, tabId, a) => {
        const maxW = this._maxW(a.max_width);
        if ((a.window != null && a.window !== '') || a.width != null || a.height != null) {
          const t = await this._target(token, a);
          const r = await this._shootRect(token, tabId, t.rect, maxW, { current: true, look: true, what: t.label });
          const w = t.window;
          return w ? { ...r, window: { handle: w.handle, title: w.title, process: w.process, front: !!w.foreground } } : r;
        }
        const mons = await this.backend.call('monitors');
        const idx = Number.isInteger(a.monitor) && mons[a.monitor] ? a.monitor : Math.max(0, mons.findIndex((m) => m.primary));
        const mon = mons[idx];
        const rect = { x: mon.x, y: mon.y, w: mon.w, h: mon.h };
        const cap = await this._capture(rect, GRID_CELL);
        this.looks.set(token, { rect, grid: cap.grid, at: Date.now() });
        const scale = fitScale(mon.w, maxW);
        const png = this._resize(cap.png, Math.round(mon.w * scale), Math.round(mon.h * scale));
        const sp = this._addSpace(token, { id: 'm' + idx, ox: mon.x, oy: mon.y, scale });
        const cur = await this.backend.call('cursor');
        this._log(tabId, '📷 Screenshot', 'monitor ' + (idx + 1) + ' of ' + mons.length);
        return {
          png: png.toString('base64'),
          width: Math.round(mon.w * scale),
          height: Math.round(mon.h * scale),
          scale,
          space: sp.id,
          monitor: idx,
          monitors: mons.length,
          physical: { x: mon.x, y: mon.y, w: mon.w, h: mon.h },
          cursor: { x: Math.round((cur.x - mon.x) * scale), y: Math.round((cur.y - mon.y) * scale) },
        };
      },
      zoom: async (token, tabId, a) => {
        const base = this._space(token, a.space);
        if (!base) throw new Error('Take a screenshot first - a zoom is a part of one.');
        const w = Math.max(8, Number(a.width) || 0);
        const h = Math.max(8, Number(a.height) || 0);
        const p0 = toPhysical(base, a.x, a.y);
        const rect = { x: p0.x, y: p0.y, w: Math.round(w / base.scale), h: Math.round(h / base.scale) };
        return this._shootRect(token, tabId, rect, this._maxW(a.max_width), { what: 'zoom' });
      },
      move: async (token, tabId, a) => {
        const p = await this._point(token, a, a.x, a.y);
        await this.backend.call('move', p);
        return { physical: p };
      },
      click: async (token, tabId, a) => {
        await this._waitForAsks();
        const p = await this._point(token, a, a.x, a.y);
        await this._guardPoint(p);
        const button = ['left', 'right', 'middle'].includes(a.button) ? a.button : 'left';
        await this.backend.call('click', { ...p, button, count: a.double ? 2 : 1 });
        this._log(tabId, '🖱 ' + (a.double ? 'Double-click' : button === 'left' ? 'Click' : button + ' click'), p.x + ',' + p.y);
        return { physical: p };
      },
      drag: async (token, tabId, a) => {
        await this._waitForAsks();
        const p = await this._point(token, a, a.x, a.y);
        const q = await this._point(token, a, a.to_x, a.to_y);
        await this._guardPoint(p);
        await this._guardPoint(q);
        await this.backend.call('drag', { x: p.x, y: p.y, x2: q.x, y2: q.y });
        this._log(tabId, '🖱 Drag', p.x + ',' + p.y + ' -> ' + q.x + ',' + q.y);
        return { from: p, to: q };
      },
      scroll: async (token, tabId, a) => {
        await this._waitForAsks();
        const p = await this._point(token, a, a.x, a.y);
        await this._guardPoint(p);
        const dy = Math.max(-50, Math.min(50, Math.round(Number(a.down) || 0)));
        const dx = Math.max(-50, Math.min(50, Math.round(Number(a.right) || 0)));
        await this.backend.call('scroll', { ...p, dx, dy });
        this._log(tabId, '🖱 Scroll', (dy ? dy + ' down ' : '') + (dx ? dx + ' right' : ''));
        return { physical: p };
      },
      type: async (token, tabId, a, epoch) => {
        const text = String(a.text == null ? '' : a.text);
        if (text.length > TYPE_MAX) throw new Error('At most ' + TYPE_MAX + ' characters per call.');
        await this._waitForAsks();
        await this._guardForeground();
        for (let i = 0; i < text.length; i += TYPE_PIECE) {
          if (epoch !== this.epoch || !this._granted(tabId)) throw new Error('Stopped by the user after ' + i + ' characters.');
          await this.backend.call('type', { text: text.slice(i, i + TYPE_PIECE) });
        }
        this._log(tabId, '⌨ Typed', text.length + ' characters'); // never the text: it may be a password
        return { typed: text.length };
      },
      key: async (token, tabId, a) => {
        const combo = String(a.combo || '').trim();
        if (!combo || combo.length > 40) throw new Error('A key combination like "ctrl+s" or "enter".');
        await this._waitForAsks();
        await this._guardForeground();
        await this.backend.call('key', { combo });
        this._log(tabId, '⌨ Key', combo);
        return { pressed: combo };
      },
      windows: async (token, tabId) => {
        const list = await this.backend.call('windows');
        return list.map((w) => ({ ...w, cockpit: w.pid === this.ownPid }));
      },
      focus: async (token, tabId, a) => {
        await this._waitForAsks();
        const list = await this.backend.call('windows');
        const t = String(a.title || '').toLowerCase();
        const w = a.handle ? list.find((x) => String(x.handle) === String(a.handle)) : list.find((x) => t && x.title.toLowerCase().includes(t));
        if (!w) throw new Error('No open window ' + (a.handle ? a.handle : '"' + a.title + '"') + '.');
        if (this.offLimits && w.pid === this.ownPid) throw new Error("That is a Cockpit window - Cockpit's own windows are not controlled.");
        const ok = await this.backend.call('focus', { handle: w.handle });
        this._log(tabId, '🪟 Focus', w.title.slice(0, 80));
        return { focused: ok, title: w.title, process: w.process };
      },
      launch: async (token, tabId, a) => {
        const target = String(a.target || '').trim();
        if (!target || target.length > 500) throw new Error('What to start: an app name, a path or a URL.');
        await this.backend.call('launch', { target });
        this._log(tabId, '🚀 Started', target.slice(0, 120));
        return { started: target };
      },

      // ---- the controls of a window (UI Automation) ----
      // Names, kinds, values and what can be done, with positions in the current picture - so a
      // button can be pressed by what it IS, not by where its pixels seem to be.
      ui: async (token, tabId, a) => {
        const w = await this._findWindow(a.window, true);
        if (w.minimized) throw new Error('"' + w.title + '" is minimized - bring it up with focus_window first.');
        if (this.offLimits && w.pid === this.ownPid) throw new Error("That is a Cockpit window - Cockpit's own windows are not read or controlled.");
        const max = Math.max(1, Math.min(500, Math.round(Number(a.max)) || 150));
        const r = await this.backend.call('ui', { handle: w.handle, max, offscreen: !!a.offscreen, filter: String(a.filter || '').slice(0, 100), budget: 4000 });
        let snaps = this.uiSnaps.get(token);
        if (!snaps) this.uiSnaps.set(token, (snaps = new Map()));
        snaps.set(r.snap, r.items);
        for (const k of [...snaps.keys()]) if (k <= r.snap - 8) snaps.delete(k); // the helper keeps eight too
        const sp = this._outSpace(token);
        const items = r.items.map((it) => {
          const o = { id: r.snap + '.' + it.i, type: it.type, name: it.name, ...this._box(sp, it), depth: it.depth, actions: it.actions };
          for (const k of ['aid', 'value', 'state', 'selected', 'focused', 'disabled', 'password']) if (it[k] != null) o[k] = it[k];
          if (it.pid === this.ownPid) o.cockpit = true;
          return o;
        });
        this._log(tabId, '🧩 Controls', w.title.slice(0, 60) + ' (' + items.length + ')');
        return { window: { handle: w.handle, title: w.title, process: w.process, front: !!w.foreground }, items, space: sp.id, cut: !!r.cut };
      },
      uiAct: async (token, tabId, a, epoch) => {
        const m = /^(\d+)\.(\d+)$/.exec(String(a.element || '').trim());
        const snaps = this.uiSnaps.get(token);
        const it = m && snaps && snaps.get(Number(m[1])) && snaps.get(Number(m[1]))[Number(m[2])];
        if (!it) throw new Error('Unknown or old element "' + (a.element || '') + '" - call ui_elements again.');
        const action = String(a.action || 'click');
        if (!['click', 'set_value', 'focus', 'toggle', 'expand', 'collapse', 'select', 'show'].includes(action)) throw new Error('Unknown action "' + action + '".');
        const value = action === 'set_value' ? String(a.value == null ? '' : a.value) : undefined;
        if (value != null && value.length > TYPE_MAX) throw new Error('At most ' + TYPE_MAX + ' characters.');
        if (this.offLimits && it.pid === this.ownPid) throw new Error("That is part of a Cockpit window - Cockpit's own windows are not controlled.");
        await this._waitForAsks();
        const r = await this.backend.call('uiAct', { snap: Number(m[1]), idx: Number(m[2]), action, value });
        let done = r.done;
        if (r.needMouse) {
          // no pattern to press it with: a real click on its middle, guarded like every click
          const p = { x: r.x != null ? r.x : it.x + Math.round(it.w / 2), y: r.y != null ? r.y : it.y + Math.round(it.h / 2) };
          await this._guardPoint(p);
          await this.backend.call('click', { ...p, button: 'left', count: 1 });
          done = 'clicked with the mouse (it has no button behaviour of its own)';
        } else if (r.needType) {
          // a field without a settable value: it has the focus now, so type into it
          await this._methods.type.call(this, token, tabId, { text: value }, epoch);
          done = 'typed (the field cannot be set directly)';
        }
        const what = it.type + (it.name ? ' "' + it.name.slice(0, 40) + '"' : '');
        this._log(tabId, '🧩 ' + action.replace('_', ' '), what + (value != null ? ', ' + value.length + ' characters' : '')); // never the value
        return { done, element: a.element, type: it.type, name: it.name };
      },

      // ---- reading text (Windows OCR) ----
      text: async (token, tabId, a) => {
        const t = await this._target(token, a);
        const r = await this._ocr(t.rect);
        const sp = this._outSpace(token);
        let lines = r.lines;
        let found = null;
        if (a.find) {
          const f = findText(lines, a.find);
          found = f ? { text: f.text, line: f.line, ...this._box(sp, f) } : null;
          const n = String(a.find).toLowerCase().replace(/\s+/g, ' ').trim();
          lines = lines.filter((l) => l.text.toLowerCase().replace(/\s+/g, ' ').includes(n));
        }
        this._log(tabId, '🔤 Read text', t.label + ' (' + r.lines.length + ' lines)');
        const out = { area: t.label, lang: r.lang, space: sp.id, lines: lines.slice(0, 400).map((l) => ({ text: l.text, ...this._box(sp, l) })), more: Math.max(0, lines.length - 400) };
        if (a.find) out.found = found;
        return out;
      },

      // ---- waiting: until text appears / goes, the area changes, or it stops changing ----
      // Runs beside the queue (OUTSIDE_QUEUE); each look goes through it, so other terminals are
      // not held up, and Stop ends it at the next look.
      wait: async (token, tabId, a, epoch) => {
        const mode = a.text ? 'text' : a.gone ? 'gone' : a.settle ? 'settle' : a.change ? 'change' : null;
        if (!mode) throw new Error('Say what to wait for: text (appears), gone (text disappears), change, or settle (stops changing).');
        const limit = Math.max(1, Math.min(WAIT_MAX_S, Number(a.timeout) || 10)) * 1000;
        const quiet = Math.max(200, Math.min(10000, Number(a.quiet_ms) || 800));
        const live = () => {
          if (epoch !== this.epoch) throw new Error('Stopped by the user.');
          if (!this._granted(tabId)) throw new Error('Screen control for this terminal ended.');
        };
        const look = (fn) => this._step(() => (live(), fn()));
        const pause = (ms) => new Promise((res) => setTimeout(res, ms));
        const t = await look(() => this._target(token, a));
        const sp = this._outSpace(token);
        const t0 = Date.now();
        const done = (met, extra) => {
          const s = ((Date.now() - t0) / 1000).toFixed(1);
          this._log(tabId, '⏳ Waited', mode + (met ? ' - yes after ' : ' - not within ') + s + ' s');
          return { met, mode, waited_ms: Date.now() - t0, area: t.label, space: sp.id, ...extra };
        };
        if (mode === 'text' || mode === 'gone') {
          const want = String(mode === 'text' ? a.text : a.gone);
          for (;;) {
            const r = await look(() => this._ocr(t.rect));
            const f = findText(r.lines, want);
            if (mode === 'text' && f) return done(true, { found: { text: f.text, line: f.line, ...this._box(sp, f) } });
            if (mode === 'gone' && !f) return done(true, {});
            if (Date.now() - t0 >= limit) return done(false, {});
            await pause(250);
          }
        }
        const opts = () => ({ mask: this._indicatorRect(), small: !!a.small });
        let prev = await look(() => this._grid(t.rect));
        const base = prev;
        let last = Date.now();
        let union = null;
        for (;;) {
          await pause(mode === 'settle' ? 200 : 250);
          const g = await look(() => this._grid(t.rect));
          if (mode === 'change') {
            const d = gridChanges(base, g, t.rect, opts());
            if (d.changed) return done(true, { changed: this._box(sp, d.box) });
          } else {
            const d = gridChanges(prev, g, t.rect, opts());
            if (d.changed) {
              last = Date.now();
              const b = d.box;
              union = union ? { x: Math.min(union.x, b.x), y: Math.min(union.y, b.y), x1: Math.max(union.x1, b.x + b.w), y1: Math.max(union.y1, b.y + b.h) } : { x: b.x, y: b.y, x1: b.x + b.w, y1: b.y + b.h };
            }
            prev = g;
            if (Date.now() - last >= quiet) return done(true, { changed: union ? this._box(sp, { x: union.x, y: union.y, w: union.x1 - union.x, h: union.y1 - union.y }) : null });
          }
          if (Date.now() - t0 >= limit) return done(false, {});
        }
      },

      // ---- only what changed since the last screenshot ----
      changes: async (token, tabId, a) => {
        const look = this.looks.get(token);
        if (!look || !look.grid || Date.now() - look.at > SPACE_TTL_MS) throw new Error('Take a screenshot first - what_changed compares the screen with the last one.');
        const g = await this._grid(look.rect);
        const d = gridChanges(look.grid, g, look.rect, { mask: this._indicatorRect(), small: !!a.small });
        if (!d.changed) {
          this._log(tabId, '📷 Changes', 'nothing');
          return { changed: false, of: look.rect };
        }
        // a little margin around it, inside the area that was looked at
        const pad = GRID_CELL;
        const R = look.rect;
        const x = Math.max(R.x, d.box.x - pad);
        const y = Math.max(R.y, d.box.y - pad);
        const box = { x, y, w: Math.min(R.x + R.w, d.box.x + d.box.w + pad) - x, h: Math.min(R.y + R.h, d.box.y + d.box.h + pad) - y };
        const shot = await this._shootRect(token, tabId, box, this._maxW(a.max_width), { current: true, what: 'changes' });
        look.grid = g; // the next what_changed reports what changes after THIS
        look.at = Date.now();
        return { ...shot, changed: true, cells: d.cells, of: R };
      },
    };
  }
  // A program may ask for a smaller picture than the setting (never a larger one).
  _maxW(v) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.max(200, Math.min(this.maxWidth, n)) : this.maxWidth;
  }
  // The space a region's own x/y/width/height are read in: the picture named, else the last monitor
  // screenshot, else real screen pixels of the primary monitor (what list_windows speaks).
  async _regionBase(token, id) {
    if (id) {
      const sp = this._space(token, id);
      if (!sp) throw new Error('Unknown or old picture "' + id + '" - take a new screenshot.');
      return sp;
    }
    const s = this.spaces.get(token);
    const sp = s && s.mon ? this._space(token, s.mon) : null;
    if (sp) return sp;
    const mons = await this.backend.call('monitors');
    const p = mons.find((m) => m.primary) || mons[0];
    return { ox: p.x, oy: p.y, scale: 1 };
  }
  // Capture a physical rectangle, cut to the desktop (a part off every monitor would be black),
  // shrunk to fit maxW wide and 3/4 of it high, with a coordinate space of its own.
  // o.current: the picture becomes the current one; o.look: what_changed compares with it later.
  async _shootRect(token, tabId, rect, maxW, o) {
    const { current, look, what } = o;
    const mons = await this.backend.call('monitors');
    let hit = null;
    for (const m of mons) {
      const x0 = Math.max(rect.x, m.x);
      const y0 = Math.max(rect.y, m.y);
      const x1 = Math.min(rect.x + rect.w, m.x + m.w);
      const y1 = Math.min(rect.y + rect.h, m.y + m.h);
      if (x1 <= x0 || y1 <= y0) continue;
      hit = hit ? { x0: Math.min(hit.x0, x0), y0: Math.min(hit.y0, y0), x1: Math.max(hit.x1, x1), y1: Math.max(hit.y1, y1) } : { x0, y0, x1, y1 };
    }
    if (!hit) throw new Error('That area is not on any screen.');
    const r = { x: hit.x0, y: hit.y0, w: hit.x1 - hit.x0, h: hit.y1 - hit.y0 };
    const cap = await this._capture(r, look ? GRID_CELL : 0);
    const raw = cap.png;
    if (look) this.looks.set(token, { rect: r, grid: cap.grid, at: Date.now() });
    const scale = Math.min(fitScale(r.w, maxW), fitScale(r.h, Math.round(maxW * 0.75)));
    const width = Math.max(1, Math.round(r.w * scale));
    const height = Math.max(1, Math.round(r.h * scale));
    const png = scale < 1 ? this._resize(raw, width, height) : raw;
    const sp = this._addSpace(token, { ox: r.x, oy: r.y, scale }, current);
    const cur = await this.backend.call('cursor');
    const inside = cur.x >= r.x && cur.x < r.x + r.w && cur.y >= r.y && cur.y < r.y + r.h;
    if (what) this._log(tabId, what === 'zoom' ? '🔍 Zoom' : '📷 Screenshot', (what === 'zoom' ? '' : what + ' ') + r.w + 'x' + r.h);
    return {
      png: png.toString('base64'),
      width,
      height,
      scale,
      space: sp.id,
      region: true,
      physical: r,
      cursor: inside ? { x: Math.round((cur.x - r.x) * scale), y: Math.round((cur.y - r.y) * scale) } : null,
    };
  }
  // The indicator is hidden for the capture (setContentProtection is not reliable everywhere).
  // With `cell`, the helper also returns the fingerprint of the same pixels (for what_changed).
  async _capture(rect, cell) {
    const ind = this.indicator && !this.indicator.isDestroyed() && this.indicator.isVisible() ? this.indicator : null;
    if (ind) {
      ind.hide();
      await new Promise((r) => setTimeout(r, 120));
    }
    try {
      const cap = await this.backend.call('capture', { x: rect.x, y: rect.y, w: rect.w, h: rect.h, cell: cell || 0 });
      return { png: Buffer.from(cap.png, 'base64'), grid: cap.grid || null };
    } finally {
      if (ind && !ind.isDestroyed() && this.grants.size) ind.showInactive();
    }
  }
  _resize(png, w, h) {
    const { nativeImage } = this.electron || {};
    if (!nativeImage) return png;
    const img = nativeImage.createFromBuffer(png);
    const sz = img.getSize();
    if (sz.width === w && sz.height === h) return png;
    return img.resize({ width: w, height: h, quality: 'best' }).toPNG();
  }

  // ---- the indicator + the stop key ----
  _toFront() {
    const w = this.getMainWindow && this.getMainWindow();
    if (!w || w.isDestroyed()) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.setAlwaysOnTop(true);
    w.focus();
    w.moveTop();
    setTimeout(() => !w.isDestroyed() && w.setAlwaysOnTop(false), 1500);
  }
  _syncIndicator() {
    const on = this.grants.size > 0;
    const gs = this.electron && this.electron.globalShortcut;
    if (gs) {
      if (on && !this.shortcut) {
        try {
          this.shortcut = gs.register(STOP_ACCELERATOR, () => this.stop('Ctrl+Alt+Esc'));
        } catch (_) {
          this.shortcut = false;
        }
      } else if (!on && this.shortcut) {
        try {
          gs.unregister(STOP_ACCELERATOR);
        } catch (_) {
          /* gone */
        }
        this.shortcut = false;
      }
    }
    if (on && !this.tick) this.tick = setInterval(() => this._paintIndicator(), 1000);
    if (!on && this.tick) {
      clearInterval(this.tick);
      this.tick = null;
    }
    if (on) this._paintIndicator();
    else if (this.indicator && !this.indicator.isDestroyed()) this.indicator.hide();
  }
  _paintIndicator() {
    for (const id of [...this.grants.keys()]) this._granted(id); // expire what has run out
    if (!this.grants.size) return;
    const { BrowserWindow, screen } = this.electron || {};
    if (!BrowserWindow) return;
    if (!this.indicator || this.indicator.isDestroyed()) {
      const wa = screen ? screen.getPrimaryDisplay().workArea : { x: 0, y: 0, width: 1200, height: 800 };
      const w = 360;
      this.indicator = new BrowserWindow({
        width: w,
        height: 40,
        x: wa.x + Math.round((wa.width - w) / 2),
        y: wa.y + 6,
        frame: false,
        resizable: false,
        movable: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        focusable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        transparent: true,
        webPreferences: { preload: this.preload, contextIsolation: true, nodeIntegration: false, sandbox: false },
      });
      this.indicator.setAlwaysOnTop(true, 'screen-saver');
      this.indicator.loadFile(path.join(this.appDir, 'renderer', 'screen-indicator.html'));
      this.indicator.once('ready-to-show', () => this.grants.size && this.indicator.showInactive());
    } else if (!this.indicator.isVisible()) this.indicator.showInactive();
    const items = [...this.grants.entries()].map(([tabId, g]) => ({
      title: this.titles.get(tabId) || 'a terminal',
      left: g.until === Infinity ? null : Math.max(0, Math.ceil((g.until - Date.now()) / 60000)),
    }));
    try {
      this.indicator.webContents.send('screen:indicator', { items, stopKey: 'Ctrl+Alt+Esc' });
    } catch (_) {
      /* loading */
    }
  }
  dispose() {
    this.stop('Cockpit quit');
    this._disable();
    if (this.indicator && !this.indicator.isDestroyed()) this.indicator.destroy();
    this.indicator = null;
  }
}

module.exports = { ScreenControl, WinBackend, toPhysical, fitScale, gridChanges, findText, STOP_ACCELERATOR };
