// Terminal presets: a named terminal with a sequence of steps typed into it - a command, a
// pause, "wait until this text shows", a tab title. Written as plain text in Settings:
//
//   [Prod tmux]
//   start: local              (or the name of a saved connection; local is the default)
//   title: Prod
//   ssh admin@db1
//   sleep 3
//   tmux attach -t main
//
// One preset = one tab. Started from ＋ New > Presets. A preset tab that was open at quit comes
// back with a "Run preset" button - nothing is typed at launch without a click.
// Loaded BEFORE renderer.js: it only touches renderer globals inside functions.

let termPresets = []; // parsed, see presetParse
let termPresetsText = ''; // what the user wrote (the saved setting)
let presetPending = null; // a preset waiting for the connection dialog's Connect

const PRESET_SLEEP_MAX = 600; // seconds
const PRESET_WAIT_DEFAULT = 30; // seconds a "wait:" gives the text to show up
const PRESET_GAP_MS = 400; // between two commands with nothing in between

// Text -> { presets, errors }. A preset: { name, start, cwd, steps }, a step one of
//   { k: 'cmd', text } | { k: 'sleep', ms } | { k: 'wait', text, ms } | { k: 'title', text }
function presetParse(text) {
  const presets = [];
  const errors = [];
  let cur = null;
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    const at = 'line ' + (idx + 1) + ': ';
    if (!line || line.startsWith('#')) return;
    const head = /^\[(.*)\]$/.exec(line); // (a command that is all in brackets needs "run:")
    if (head) {
      const name = head[1].trim();
      if (!name) return errors.push(at + 'a preset needs a name between the brackets');
      if (presets.some((p) => p.name.toLowerCase() === name.toLowerCase())) errors.push(at + 'there are two presets called "' + name + '"');
      cur = { name, start: 'local', cwd: '', steps: [] };
      presets.push(cur);
      return;
    }
    if (!cur) return errors.push(at + 'this comes before any [Preset name] line');
    let m;
    if ((m = /^start\s*:\s*(.*)$/i.exec(line))) {
      cur.start = /^local$/i.test(m[1].trim()) || !m[1].trim() ? 'local' : m[1].trim();
    } else if ((m = /^cwd\s*:\s*(.*)$/i.exec(line))) {
      cur.cwd = m[1].trim();
    } else if ((m = /^title\s*:\s*(.+)$/i.exec(line))) {
      cur.steps.push({ k: 'title', text: m[1].trim() });
    } else if ((m = /^sleep\s*:?\s*(\d+(?:\.\d+)?)\s*s?$/i.exec(line))) {
      // "sleep 3" is a pause made by Cockpit, not the shell's sleep: nothing is typed, so it
      // also works where a shell is not listening yet. "run: sleep 3" types the real one.
      const sec = Math.min(PRESET_SLEEP_MAX, parseFloat(m[1]));
      cur.steps.push({ k: 'sleep', ms: Math.round(sec * 1000) });
    } else if ((m = /^wait(?:\s+(\d+(?:\.\d+)?))?\s*:\s*(.+)$/i.exec(line))) {
      const sec = Math.min(PRESET_SLEEP_MAX, m[1] ? parseFloat(m[1]) : PRESET_WAIT_DEFAULT);
      cur.steps.push({ k: 'wait', text: m[2].trim(), ms: Math.round(sec * 1000) });
    } else if ((m = /^run\s*:\s*(.+)$/i.exec(line))) {
      cur.steps.push({ k: 'cmd', text: m[1] });
    } else {
      cur.steps.push({ k: 'cmd', text: line });
    }
  });
  for (const p of presets) if (!p.steps.some((s) => s.k === 'cmd')) errors.push('"' + p.name + '" has no command to run');
  return { presets, errors };
}

function presetFind(name) {
  const n = String(name || '').toLowerCase();
  return termPresets.find((p) => p.name.toLowerCase() === n) || null;
}
// The title a preset's tab starts with: a "title:" before the first command, else its name.
function presetFirstTitle(p) {
  for (const s of p.steps) {
    if (s.k === 'title') return s.text;
    if (s.k === 'cmd') break;
  }
  return p.name;
}
function presetStepText(s) {
  if (s.k === 'cmd') return s.text;
  if (s.k === 'sleep') return 'pause ' + s.ms / 1000 + ' s';
  if (s.k === 'wait') return 'waiting for "' + s.text + '"';
  return 'title: ' + s.text;
}

// ---- the setting ----
function presetSetText(text, save) {
  termPresetsText = String(text || '');
  const r = presetParse(termPresetsText);
  termPresets = r.presets;
  presetMenuRender();
  if (save) api.saveSettings({ termPresets: termPresetsText });
  return r;
}

// ---- the menu: ＋ New > Presets ----
function presetMenuRender() {
  const box = document.getElementById('presets-menu');
  if (!box) return;
  box.innerHTML = '';
  for (const p of termPresets) {
    const b = document.createElement('button');
    b.textContent = '⚡ ' + p.name;
    const cmds = p.steps.filter((s) => s.k === 'cmd').map((s) => s.text);
    b.title =
      (p.start === 'local' ? 'A new local terminal' : 'A new tab connected to ' + p.start) + ', then: ' + cmds.join('  →  ') +
      '\nShift+click: type it into the terminal you are in instead (or hover that tab: Presets)';
    b.dataset.preset = p.name;
    b.addEventListener('click', (e) => {
      const cur = activeTabId ? tabs.get(activeTabId) : null;
      if (e.shiftKey && cur && (cur.kind === 'local' || cur.kind === 'ssh')) presetApply(cur, p.name);
      else presetStart(p.name);
    });
    box.appendChild(b);
  }
  if (termPresets.length) {
    const sep = document.createElement('div');
    sep.className = 'tab-menu-sep';
    box.appendChild(sep);
  }
  const edit = document.createElement('button');
  edit.textContent = termPresets.length ? '✎ Edit presets…' : '✎ Make a preset…';
  edit.title = 'Presets are written in Settings: a name, where it starts, and the commands';
  edit.dataset.preset = '';
  edit.addEventListener('click', () => presetOpenSettings());
  box.appendChild(edit);
}
function presetOpenSettings() {
  openSettings();
  const ta = document.getElementById('set-term-presets');
  if (!ta) return;
  ta.scrollIntoView({ block: 'center' });
  ta.focus();
}
function presetWireMenu() {
  const btn = document.getElementById('presets-btn');
  if (!btn) return;
  // like Games: the click must not reach the main menu, which closes on any click inside it
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    btn.parentElement.classList.toggle('open');
  });
  presetMenuRender();
}

// ---- starting one ----
function presetNote(text) {
  // no terminal to write into yet: the status line of the connect dialog is the wrong place too
  window.alert(text);
}
function presetStart(name) {
  const p = presetFind(name);
  if (!p) return null;
  if (p.start === 'local') {
    const id = createLocalTab({ title: presetFirstTitle(p), cwd: p.cwd || undefined });
    const rec = tabs.get(id);
    if (rec) presetAttach(rec, p, true);
    return id;
  }
  const want = p.start.toLowerCase();
  const s = (savedSessions || []).find((x) => String(x.name || '').toLowerCase() === want || (x.username + '@' + x.host).toLowerCase() === want);
  if (!s) {
    presetNote('Preset "' + p.name + '" starts in the saved connection "' + p.start + '", and there is none with that name.\n\nSaved connections: ' + ((savedSessions || []).map((x) => x.name).join(', ') || 'none'));
    return null;
  }
  if (s.authMethod === 'password') {
    // a password is typed at connect time and never stored: the dialog, filled in, asks for it
    fillForm(s);
    openDialog();
    presetPending = p.name; // after openDialog, which forgets an older one
    if (els.dialogError) els.dialogError.textContent = 'Preset "' + p.name + '": enter the password, then Connect - the commands follow.';
    return null;
  }
  const id = createTab({ ...s });
  const rec = tabs.get(id);
  if (rec) presetAttach(rec, p, true);
  return id;
}
// Run a preset in a terminal that is ALREADY open - one that came back at launch, or one whose
// ssh logged out again. Its commands are typed here ("start:" and "cwd:" are about a new tab
// and do not apply); the tab keeps its title unless the preset has a "title:" step, and from now
// on it belongs to the preset (the strip, the Run button after a restart).
// A shell that has ended or a connection that dropped is started again first; the steps wait.
function presetApply(rec, name) {
  const p = presetFind(name);
  if (!rec || !p || (rec.kind !== 'local' && rec.kind !== 'ssh') || !rec.term) return false;
  let full = false;
  try {
    full = rec.term.buffer.active.type !== 'normal';
  } catch (_) {
    /* no buffer yet */
  }
  // tmux, vim, a pager: the commands would be typed into that program, not a shell
  if (full && !window.confirm('This terminal is showing a full-screen program (tmux, vim, less ...).\n\nType the preset "' + p.name + '" into it anyway?')) return false;
  rec.preset = { name: p.name };
  persistTabOrder();
  if (rec.status === 'closed' || rec.status === 'error') {
    if (rec.kind === 'local') startLocalShell(rec);
    else {
      setTabStatus(rec.id, 'connecting', 'Connecting…'); // reconnect() only says so a frame later
      reconnect(rec.id);
    }
  }
  presetRun(rec);
  return true;
}
// The tab's hover sheet: a "Presets ▸" button among the actions at the top; the presets open
// in a small list to its right, and a click runs one in THIS terminal.
// The list is its own element on the page, not a child of the sheet: the sheet scrolls
// (overflow), and that would cut off anything hanging out of its side.
let presetFlyTimer = null;
function presetFly() {
  let fly = document.getElementById('tab-help-fly');
  if (fly) return fly;
  fly = document.createElement('div');
  fly.id = 'tab-help-fly';
  fly.className = 'hidden';
  document.body.appendChild(fly);
  fly.addEventListener('mouseenter', () => {
    clearTimeout(tabHelpTimer); // still "on the sheet"
    clearTimeout(presetFlyTimer);
  });
  // Pointing at anything else on the sheet puts the list away - a moment later, because the
  // way from the button to the list leads across the sheet's own edge.
  els.tabHelp.addEventListener('mouseover', (e) => {
    clearTimeout(presetFlyTimer);
    if (e.target.closest && e.target.closest('.th-presets')) return;
    presetFlyTimer = setTimeout(presetFlyHide, 220);
  });
  fly.addEventListener('mouseleave', (e) => {
    const to = e.relatedTarget;
    presetFlyHide();
    // back onto the sheet: only the list goes. Anywhere else: the sheet goes too.
    if (!(to && els.tabHelp.contains(to))) els.tabHelp.classList.add('hidden');
  });
  // whatever hides the sheet hides the list with it
  new MutationObserver(() => {
    if (els.tabHelp.classList.contains('hidden')) presetFlyHide();
  }).observe(els.tabHelp, { attributes: true, attributeFilter: ['class'] });
  return fly;
}
function presetFlyHide() {
  clearTimeout(presetFlyTimer);
  const fly = document.getElementById('tab-help-fly');
  if (fly) fly.classList.add('hidden');
  const b = els.tabHelp.querySelector('.th-presets');
  if (b) b.classList.remove('on');
}
function presetFlyShow(btn, rec) {
  const fly = presetFly();
  fly.innerHTML = '';
  const cap = document.createElement('div');
  cap.className = 'th-title';
  cap.textContent = termPresets.length ? 'Run in this terminal' : 'No presets yet';
  fly.appendChild(cap);
  for (const p of termPresets) {
    const b = document.createElement('button');
    b.className = 'th-cmd th-plain';
    b.textContent = '⚡ ' + p.name;
    b.dataset.preset = p.name;
    b.title = 'Types into THIS terminal: ' + p.steps.filter((s) => s.k === 'cmd').map((s) => s.text).join('  →  ');
    b.addEventListener('click', () => {
      els.tabHelp.classList.add('hidden');
      presetApply(rec, p.name);
      if (rec.term) rec.term.focus();
    });
    fly.appendChild(b);
  }
  const edit = document.createElement('button');
  edit.className = 'th-cmd th-plain';
  edit.textContent = termPresets.length ? '✎ Edit presets…' : '✎ Make a preset…';
  edit.dataset.preset = '';
  edit.addEventListener('click', () => {
    els.tabHelp.classList.add('hidden');
    presetOpenSettings();
  });
  fly.appendChild(edit);
  clearTimeout(presetFlyTimer);
  fly.classList.remove('hidden');
  btn.classList.add('on');
  // to the right of the sheet, level with the button; on the left when the right has no room
  const sheet = els.tabHelp.getBoundingClientRect();
  const br = btn.getBoundingClientRect();
  const w = fly.offsetWidth;
  const h = fly.offsetHeight;
  const right = sheet.right - 2; // a hair of overlap: no gap for the pointer to fall into
  fly.style.left = (right + w <= window.innerWidth - 8 ? right : Math.max(8, sheet.left - w + 2)) + 'px';
  fly.style.top = Math.max(8, Math.min(br.top - 6, window.innerHeight - h - 8)) + 'px';
}
// Called while the sheet is being built: puts the button into the action grid at the top.
function presetHelpRender(grid, rec) {
  presetFlyHide();
  if (!grid || !rec || (rec.kind !== 'local' && rec.kind !== 'ssh') || !rec.term) return;
  const btn = document.createElement('button');
  btn.className = 'th-cmd th-plain th-presets';
  btn.innerHTML = '⚡ Presets <span class="th-arrow">▸</span>';
  btn.title = 'Run a preset in this terminal: its commands are typed here';
  btn.addEventListener('mouseenter', () => presetFlyShow(btn, rec));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const fly = document.getElementById('tab-help-fly');
    if (fly && !fly.classList.contains('hidden')) presetFlyHide();
    else presetFlyShow(btn, rec);
  });
  grid.insertBefore(btn, grid.children[1] || null); // first row, right of Paste
}

// The connection dialog just made a tab (doConnect): was a preset waiting for it?
function presetAfterConnect(id, name) {
  const p = name && presetFind(name);
  const rec = p && tabs.get(id);
  if (rec) presetAttach(rec, p, true);
}

// ---- a tab that belongs to a preset ----
function presetAttach(rec, p, run) {
  rec.preset = { name: p.name };
  const t = presetFirstTitle(p);
  if (t && rec.customTitle !== t) applyTabRename(rec, t);
  persistTabOrder();
  if (run) presetRun(rec);
  else presetBar(rec, 'idle');
}
// Which preset a tab title belongs to: the preset's own name, or any "title:" line of it
// (a tab called "pen" and a preset that titles its tab "pen" are a match). Case does not matter.
function presetMatch(title) {
  const t = String(title || '').trim().toLowerCase();
  if (!t) return null;
  return termPresets.find((p) => p.name.toLowerCase() === t || p.steps.some((s) => s.k === 'title' && s.text.toLowerCase() === t)) || null;
}
// At launch, for every terminal tab that comes back. Its preset is the one it was started
// with (saved with the tab), else the one its TITLE matches. With "run at launch" on (the
// default) the preset is typed by itself once the shell or the connection is there; off, the
// tab gets the strip with a Run button and nothing is typed without a click.
let presetAutoRun = true; // saved
function presetAtLaunch(id, saved) {
  const rec = tabs.get(id);
  if (!rec || (rec.kind !== 'local' && rec.kind !== 'ssh')) return null;
  const el = rec.tabEl && rec.tabEl.querySelector('.title');
  const p = presetFind(saved) || presetMatch(rec.customTitle || (el && el.textContent) || '');
  if (!p) return null;
  rec.preset = { name: p.name };
  if (presetAutoRun) presetRun(rec);
  else presetBar(rec, 'idle');
  return p.name;
}

// The small strip in the pane's corner: what the preset is doing, Stop, Run.
function presetBar(rec, state, text) {
  let bar = rec.paneEl.querySelector('.preset-bar');
  if (state === 'gone') {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'preset-bar';
    bar.addEventListener('mousedown', (e) => e.preventDefault()); // the terminal keeps the keyboard
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pb]');
      if (!b) return;
      if (b.dataset.pb === 'run') presetRun(rec);
      else if (b.dataset.pb === 'stop') presetStop(rec, 'Stopped');
      else presetBar(rec, 'gone');
      if (rec.term) rec.term.focus();
    });
    rec.paneEl.appendChild(bar);
  }
  const name = rec.preset ? rec.preset.name : '';
  bar.className = 'preset-bar ' + state;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  bar.innerHTML =
    '<span class="pb-name">⚡ ' + esc(name) + '</span>' +
    (text ? '<span class="pb-text">' + esc(text) + '</span>' : '') +
    (state === 'run'
      ? '<button data-pb="stop" title="Stop: nothing more is typed">Stop</button>'
      : '<button data-pb="run" title="Type the preset\'s commands into this terminal">▶ Run' + (state === 'idle' ? ' preset' : ' again') + '</button><button data-pb="x" title="Hide">✕</button>');
}

// ---- running the steps ----
function presetStop(rec, why) {
  const st = rec._presetRun;
  if (!st) return;
  st.stopped = true;
  clearTimeout(st.timer);
  st.wait = null;
  rec._presetRun = null;
  presetBar(rec, 'stopped', why + ' at step ' + Math.min(st.i + 1, st.p.steps.length) + ' of ' + st.p.steps.length);
}
function presetRun(rec) {
  const p = rec.preset && presetFind(rec.preset.name);
  if (!p) return presetBar(rec, 'gone');
  if (rec._presetRun) presetStop(rec, 'Restarted');
  const st = (rec._presetRun = { p, i: 0, stopped: false, timer: null, wait: null, lastCmdAt: 0, since: Date.now() });
  const alive = () => !st.stopped && rec._presetRun === st && tabs.get(rec.id) === rec;
  const later = (ms, fn) => {
    st.timer = setTimeout(() => alive() && fn(), ms);
  };
  const show = () => {
    const s = p.steps[st.i];
    presetBar(rec, 'run', 'step ' + (st.i + 1) + ' of ' + p.steps.length + ' · ' + presetStepText(s));
  };
  const done = () => {
    rec._presetRun = null;
    presetBar(rec, 'done', 'done');
    st.timer = setTimeout(() => {
      const bar = rec.paneEl.querySelector('.preset-bar.done');
      if (bar && !rec._presetRun) bar.remove();
    }, 2500);
  };
  // A command is typed only into a shell that is there and has gone quiet, and never into
  // the middle of one of Cockpit's own silent conversations with it (their echo is swallowed).
  const typeWhenReady = (text, then) => {
    const t0 = Date.now();
    const tryNow = () => {
      if (!alive()) return;
      if (rec.status !== 'connected') {
        if ((rec.status === 'closed' || rec.status === 'error') && Date.now() - t0 > 1500) return presetStop(rec, 'The terminal is not connected');
        if (Date.now() - t0 > 90000) return presetStop(rec, 'Not connected after 90 s');
        presetBar(rec, 'run', 'waiting for the terminal to connect');
        return later(250, tryNow);
      }
      // A shell that has printed nothing yet (it was only just started) gets a moment to show
      // its banner and prompt; one that has, only needs to have gone quiet.
      const quiet = Date.now() - (rec._lastDataAt || 0);
      const settled = (rec._lastDataAt ? quiet > 300 : false) || Date.now() - t0 > 2500;
      const gap = Date.now() - st.lastCmdAt >= PRESET_GAP_MS;
      if (!settled || !gap) return later(120, tryNow);
      whenInBandFree(
        rec,
        () => {
          if (!alive()) return;
          show();
          tmuxNoteTyping(rec); // this counts as typing: no tmux card on top of it
          termSend(rec, text + '\r');
          st.lastCmdAt = Date.now();
          rec._probeAt = Date.now(); // and no where-am-I probe for its half minute after this
          then();
        },
        () => alive() && presetStop(rec, 'The terminal was busy with a transfer')
      );
    };
    tryNow();
  };
  const next = () => {
    if (!alive()) return;
    if (st.i >= p.steps.length) return done();
    const s = p.steps[st.i];
    const go = () => {
      st.i++;
      next();
    };
    show();
    if (s.k === 'title') {
      applyTabRename(rec, s.text);
      go();
    } else if (s.k === 'sleep') {
      later(s.ms, go);
    } else if (s.k === 'wait') {
      // the text may already be on screen from the step before
      const want = s.text.toLowerCase();
      st.wait = { want, buf: (st.seen || '').slice(-4000), go };
      if (st.wait.buf.includes(want)) {
        st.wait = null;
        st.seen = '';
        return go();
      }
      later(s.ms, () => presetStop(rec, '"' + s.text + '" did not show up in ' + s.ms / 1000 + ' s'));
    } else {
      st.seen = ''; // a wait after this command looks at what comes from here on
      typeWhenReady(s.text, go);
    }
  };
  next();
}
// Output of the tab, as text: what a "wait:" step looks through. Called from both data routers.
function presetFeed(rec, text) {
  const st = rec._presetRun;
  if (!st || !text) return;
  // colours and cursor moves are not part of what a person would call "the text"
  const plain = String(text).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '').toLowerCase();
  st.seen = ((st.seen || '') + plain).slice(-4000);
  const w = st.wait;
  if (!w) return;
  w.buf = (w.buf + plain).slice(-4000);
  if (!w.buf.includes(w.want)) return;
  clearTimeout(st.timer);
  st.wait = null;
  st.seen = '';
  w.go();
}

if (typeof module !== 'undefined' && module.exports) module.exports = { presetParse, presetFirstTitle, presetStepText };
