// Terminal presets: a named terminal with a sequence of steps typed into it - a command, a
// pause, "wait until this text shows", "wait until the shell is back at its prompt", a tab
// title, a value asked for at the start. Written as plain text in Settings:
//
//   [Prod tmux]
//   ask: host = db1           (asked when the preset starts; {host} below is the answer)
//   start: local              (or the name of a saved connection; local is the default)
//   title: Prod {host}
//   ssh admin@{host}
//   wait-prompt
//   tmux attach -t main
//
// One preset = one tab. Started from ＋ New > Presets, run in an open terminal from its tab's
// hover menu, recorded from what you type (the hover menu again), or run by itself at launch
// in every terminal that belongs to it.
// Loaded BEFORE renderer.js: it only touches renderer globals inside functions.

let termPresets = []; // parsed, see presetParse
let termPresetsText = ''; // what the user wrote (the saved setting)
let presetPending = null; // the NAME of a preset waiting for the connection dialog's Connect
let presetPendingVars = null; // ...and its answers
let presetLastVars = {}; // preset name -> the answers given last time (saved): the next ask starts there

const PRESET_SLEEP_MAX = 600; // seconds
const PRESET_WAIT_DEFAULT = 30; // seconds a "wait:" gives the text to show up
const PRESET_PROMPT_DEFAULT = 120; // seconds a "wait-prompt" waits (a password may be typed in between)
const PRESET_GAP_MS = 400; // between two commands with nothing in between
const PRESET_QUIET_MS = 400; // output that has stopped this long, ending in a prompt, is a prompt
const PRESET_VAR = /\{([A-Za-z_][\w-]*)\}/g;
// The end of a line a shell asks a secret on (ssh, sudo, a key's passphrase, a code).
const PRESET_SECRET = /\b(password|passphrase|passcode|pin|verification code|one-time code|otp)\b[^\n]{0,80}:\s*$/i;

// Text -> { presets, errors }. A preset: { name, start, cwd, asks, steps }, an ask
// { name, def }, a step one of
//   { k: 'cmd', text } | { k: 'sleep', ms } | { k: 'wait', text, ms } | { k: 'prompt', ms } | { k: 'title', text }
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
      cur = { name, start: 'local', cwd: '', asks: [], steps: [] };
      presets.push(cur);
      return;
    }
    if (!cur) return errors.push(at + 'this comes before any [Preset name] line');
    let m;
    if ((m = /^start\s*:\s*(.*)$/i.exec(line))) {
      cur.start = /^local$/i.test(m[1].trim()) || !m[1].trim() ? 'local' : m[1].trim();
    } else if ((m = /^cwd\s*:\s*(.*)$/i.exec(line))) {
      cur.cwd = m[1].trim();
    } else if ((m = /^ask\s*:\s*(.*)$/i.exec(line))) {
      const a = /^([A-Za-z_][\w-]*)\s*(?:=\s*(.*))?$/.exec(m[1].trim());
      if (!a) errors.push(at + 'ask: needs a name (letters, digits, _ or -), e.g. "ask: host" or "ask: host = db1"');
      else if (cur.asks.some((x) => x.name.toLowerCase() === a[1].toLowerCase())) errors.push(at + '"' + a[1] + '" is asked twice');
      else cur.asks.push({ name: a[1], def: (a[2] || '').trim() });
    } else if ((m = /^title\s*:\s*(.+)$/i.exec(line))) {
      cur.steps.push({ k: 'title', text: m[1].trim() });
    } else if ((m = /^sleep\s*:?\s*(\d+(?:\.\d+)?)\s*s?$/i.exec(line))) {
      // "sleep 3" is a pause made by Cockpit, not the shell's sleep: nothing is typed, so it
      // also works where a shell is not listening yet. "run: sleep 3" types the real one.
      const sec = Math.min(PRESET_SLEEP_MAX, parseFloat(m[1]));
      cur.steps.push({ k: 'sleep', ms: Math.round(sec * 1000) });
    } else if ((m = /^wait[- ]?prompt\s*:?\s*(?:(\d+(?:\.\d+)?)\s*s?)?$/i.exec(line))) {
      const sec = Math.min(PRESET_SLEEP_MAX, m[1] ? parseFloat(m[1]) : PRESET_PROMPT_DEFAULT);
      cur.steps.push({ k: 'prompt', ms: Math.round(sec * 1000) });
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

// {name} -> its answer. Only names the preset ASKS for: "{print $1}" in an awk line, or a
// shell's {a,b}, stays as it is.
function presetFill(text, p, vars) {
  const asked = new Set(((p && p.asks) || []).map((a) => a.name.toLowerCase()));
  const v = {};
  for (const k of Object.keys(vars || {})) v[k.toLowerCase()] = vars[k];
  return String(text || '').replace(PRESET_VAR, (all, n) => (asked.has(n.toLowerCase()) && v[n.toLowerCase()] != null ? String(v[n.toLowerCase()]) : all));
}
// Are all the preset's questions answered?
function presetVarsDone(p, vars) {
  return ((p && p.asks) || []).every((a) => vars && vars[a.name] != null && String(vars[a.name]) !== '');
}

function presetFind(name) {
  const n = String(name || '').toLowerCase();
  return termPresets.find((p) => p.name.toLowerCase() === n) || null;
}
// The title a preset's tab starts with: a "title:" before the first command, else its name.
function presetFirstTitle(p, vars) {
  for (const s of p.steps) {
    if (s.k === 'title') return presetFill(s.text, p, vars);
    if (s.k === 'cmd') break;
  }
  return p.name;
}
function presetStepText(s, p, vars) {
  if (s.k === 'cmd') return presetFill(s.text, p, vars);
  if (s.k === 'sleep') return 'pause ' + s.ms / 1000 + ' s';
  if (s.k === 'wait') return 'waiting for "' + presetFill(s.text, p, vars) + '"';
  if (s.k === 'prompt') return 'waiting for the prompt';
  return 'title: ' + presetFill(s.text, p, vars);
}
// A title written with {name} in it, against a real tab title: the answers it was made with,
// or null. "pen-{host}" and "pen-db1" give { host: 'db1' }; case does not matter.
function presetTitleVars(pattern, title, p) {
  const asked = ((p && p.asks) || []).map((a) => a.name);
  const names = [];
  const src = String(pattern || '')
    .split(PRESET_VAR)
    .map((part, i) => {
      if (i % 2 === 0) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const real = asked.find((a) => a.toLowerCase() === part.toLowerCase());
      if (!real) return ('{' + part + '}').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(real);
      return '(.+?)';
    })
    .join('');
  const m = new RegExp('^' + src + '$', 'i').exec(String(title || '').trim());
  if (!m) return null;
  const vars = {};
  names.forEach((n, i) => (vars[n] = m[i + 1]));
  return vars;
}
// What the line the cursor is on says: 'prompt' (a shell waits for a command), 'secret' (it
// asks for a password or code), 'question' (a yes/no, say ssh's first-time host key) or 'other'.
function presetLineState(text) {
  const t = String(text || '').replace(/\s+$/, '');
  if (!t) return 'other';
  if (PRESET_SECRET.test(t)) return 'secret';
  // zsh ends in "%", but so does a progress line ("loading 50%"): a % right after a digit is not a prompt
  if (/(?:[$#>❯›»]|(?:^|[^\d])%)$/.test(t)) return 'prompt';
  if (/\?$/.test(t) || /\((yes\/no[^)]*)\)\s*\??$/i.test(t)) return 'question';
  return 'other';
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

// ---- a small dialog: the questions of a preset, saving a recording ----
// fields: [{ key, label, value, multiline, hint }]. Resolves with { key: value } or null.
// check(values) may return a message - the dialog then stays open and shows it.
function presetDialog(opts) {
  return new Promise((resolve) => {
    document.getElementById('preset-dlg')?.remove();
    const back = document.activeElement;
    const ov = document.createElement('div');
    ov.id = 'preset-dlg';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    ov.innerHTML =
      '<div class="pd-box" role="dialog">' +
      '<div class="pd-title">' + esc(opts.title) + '</div>' +
      (opts.text ? '<div class="pd-text">' + esc(opts.text) + '</div>' : '') +
      opts.fields
        .map(
          (f, i) =>
            '<label class="pd-field"><span>' + esc(f.label) + '</span>' +
            (f.multiline
              ? '<textarea data-i="' + i + '" rows="' + (f.rows || 10) + '" spellcheck="false">' + esc(f.value) + '</textarea>'
              : '<input data-i="' + i + '" type="text" spellcheck="false" value="' + esc(f.value) + '" />') +
            (f.hint ? '<em>' + esc(f.hint) + '</em>' : '') +
            '</label>'
        )
        .join('') +
      '<div class="pd-err"></div>' +
      '<div class="pd-foot"><button class="pd-ok primary">' + esc(opts.ok || 'OK') + '</button><button class="pd-cancel">Cancel</button></div>' +
      '</div>';
    document.body.appendChild(ov);
    const inputs = [...ov.querySelectorAll('[data-i]')];
    const done = (val) => {
      ov.remove();
      if (back && back.focus && document.contains(back)) back.focus();
      resolve(val);
    };
    const ok = () => {
      const vals = {};
      inputs.forEach((el) => (vals[opts.fields[+el.dataset.i].key] = el.tagName === 'TEXTAREA' ? el.value : el.value.trim()));
      const err = opts.check ? opts.check(vals) : '';
      if (err) {
        ov.querySelector('.pd-err').textContent = err;
        return;
      }
      done(vals);
    };
    ov.querySelector('.pd-ok').addEventListener('click', ok);
    ov.querySelector('.pd-cancel').addEventListener('click', () => done(null));
    ov.addEventListener('mousedown', (e) => {
      if (e.target === ov) done(null);
    });
    ov.addEventListener('keydown', (e) => {
      e.stopPropagation(); // the app's own keys are not for this
      if (e.key === 'Escape') {
        e.preventDefault();
        done(null);
      } else if (e.key === 'Enter' && (e.target.tagName === 'INPUT' || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        ok();
      }
    });
    const first = inputs[0];
    if (first) {
      first.focus();
      if (first.tagName === 'INPUT') first.select();
    }
  });
}
// The questions a preset asks, answered: { name: value }, or null when cancelled.
// `start` = answers to begin with (the tab's own last ones); then the last answers given
// for this preset anywhere; then the defaults.
async function presetAsk(p, start) {
  if (!p.asks.length) return {};
  const last = presetLastVars[p.name] || {};
  const vals = await presetDialog({
    title: 'Preset "' + p.name + '"',
    ok: 'Start',
    fields: p.asks.map((a) => ({ key: a.name, label: a.name, value: (start && start[a.name]) ?? last[a.name] ?? a.def })),
    check: (v) => {
      const empty = p.asks.find((a) => !v[a.name]);
      return empty ? 'Please fill in "' + empty.name + '".' : '';
    },
  });
  if (!vals) return null;
  presetLastVars = { ...presetLastVars, [p.name]: vals };
  api.saveSettings({ presetLastVars });
  return vals;
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
      (p.asks.length ? '\nAsks first: ' + p.asks.map((a) => a.name).join(', ') : '') +
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
// A preset that asks questions asks them first (and returns null at once); one that does not
// opens its tab right away and returns the tab id.
function presetStart(name) {
  const p = presetFind(name);
  if (!p) return null;
  if (p.asks.length) {
    presetAsk(p).then((vars) => vars && presetStartWith(p, vars));
    return null;
  }
  return presetStartWith(p, {});
}
function presetStartWith(p, vars) {
  if (p.start === 'local') {
    const id = createLocalTab({ title: presetFirstTitle(p, vars), cwd: presetFill(p.cwd, p, vars) || undefined });
    const rec = tabs.get(id);
    if (rec) presetAttach(rec, p, true, vars);
    return id;
  }
  const want = presetFill(p.start, p, vars).toLowerCase();
  const s = (savedSessions || []).find((x) => String(x.name || '').toLowerCase() === want || (x.username + '@' + x.host).toLowerCase() === want);
  if (!s) {
    presetNote('Preset "' + p.name + '" starts in the saved connection "' + presetFill(p.start, p, vars) + '", and there is none with that name.\n\nSaved connections: ' + ((savedSessions || []).map((x) => x.name).join(', ') || 'none'));
    return null;
  }
  if (s.authMethod === 'password') {
    // a password is typed at connect time and never stored: the dialog, filled in, asks for it
    fillForm(s);
    openDialog();
    presetPending = p.name; // after openDialog, which forgets an older one
    presetPendingVars = vars;
    if (els.dialogError) els.dialogError.textContent = 'Preset "' + p.name + '": enter the password, then Connect - the commands follow.';
    return null;
  }
  const id = createTab({ ...s });
  const rec = tabs.get(id);
  if (rec) presetAttach(rec, p, true, vars);
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
  const go = (vars) => {
    rec.preset = { name: p.name, vars };
    persistTabOrder();
    if (rec.status === 'closed' || rec.status === 'error') {
      if (rec.kind === 'local') startLocalShell(rec);
      else {
        setTabStatus(rec.id, 'connecting', 'Connecting…'); // reconnect() only says so a frame later
        reconnect(rec.id);
      }
    }
    presetRun(rec);
  };
  if (!p.asks.length) {
    go({});
    return true;
  }
  const mine = rec.preset && rec.preset.name === p.name ? rec.preset.vars : null;
  presetAsk(p, mine).then((vars) => vars && go(vars));
  return true;
}
// The strip's Run button: answers the tab already has are used again; missing ones are asked.
function presetRerun(rec) {
  const p = rec.preset && presetFind(rec.preset.name);
  if (!p) return presetBar(rec, 'gone');
  const vars = rec.preset.vars || {};
  if (presetVarsDone(p, vars)) return presetRun(rec);
  presetAsk(p, vars).then((v) => {
    if (!v) return;
    rec.preset = { name: p.name, vars: v };
    persistTabOrder();
    presetRun(rec);
  });
}

// ---- the tab's hover sheet ----
// A "Presets ▸" button among the actions at the top; the presets open in a small list to its
// right, and a click runs one in THIS terminal. Next to it, recording one.
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
  // which preset this tab is linked to (it runs at launch), and the way out
  const linked = rec.preset && presetFind(rec.preset.name);
  if (linked) {
    const note = document.createElement('div');
    note.className = 'th-linked';
    note.textContent = 'Linked: runs "' + linked.name + '" when Cockpit starts';
    fly.appendChild(note);
    const un = document.createElement('button');
    un.className = 'th-cmd th-plain';
    un.textContent = '⛓ Unlink';
    un.dataset.preset = '';
    un.title = 'This tab runs no preset at launch any more (a tab whose name matches a preset is linked to it again at the next start)';
    un.addEventListener('click', () => {
      els.tabHelp.classList.add('hidden');
      presetUnlink(rec);
      if (rec.term) rec.term.focus();
    });
    fly.appendChild(un);
  }
  for (const p of termPresets) {
    const b = document.createElement('button');
    b.className = 'th-cmd th-plain' + (linked === p ? ' on' : '');
    b.textContent = (linked === p ? '● ' : '⚡ ') + p.name;
    b.dataset.preset = p.name;
    b.title = 'Types into THIS terminal: ' + p.steps.filter((s) => s.k === 'cmd').map((s) => s.text).join('  →  ') + (p.asks.length ? '\nAsks first: ' + p.asks.map((a) => a.name).join(', ') : '');
    b.addEventListener('click', () => {
      els.tabHelp.classList.add('hidden');
      presetApply(rec, p.name);
      if (rec.term && !p.asks.length) rec.term.focus();
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
// Called while the sheet is being built: puts the buttons into the action grid at the top.
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
  const rb = document.createElement('button');
  rb.className = 'th-cmd th-plain th-record';
  rb.textContent = rec._presetRec ? '⏹ Stop recording…' : '⏺ Record a preset';
  rb.title = rec._presetRec
    ? 'Stop recording and save what you typed as a preset'
    : 'Type your commands as usual - each one you run is noted. Stop, and they become a preset (you can edit it before it is saved). What a shell does not show (a password) is never noted.';
  rb.addEventListener('click', () => {
    els.tabHelp.classList.add('hidden');
    if (rec._presetRec) presetRecSave(rec);
    else presetRecStart(rec);
    if (rec.term) rec.term.focus();
  });
  grid.appendChild(rb);
}

// The connection dialog just made a tab (doConnect): was a preset waiting for it?
function presetAfterConnect(id, name) {
  const p = name && presetFind(name);
  const rec = p && tabs.get(id);
  const vars = presetPendingVars || {};
  presetPendingVars = null;
  if (rec) presetAttach(rec, p, true, vars);
}

// ---- a tab that belongs to a preset ----
function presetAttach(rec, p, run, vars) {
  rec.preset = { name: p.name, vars: vars || {} };
  const t = presetFirstTitle(p, vars);
  if (t && rec.customTitle !== t) applyTabRename(rec, t);
  persistTabOrder();
  if (run) presetRun(rec);
  else presetBar(rec, 'idle');
}
// Which preset a tab title belongs to: the preset's own name, or any "title:" line of it (a tab
// called "pen" and a preset that titles its tab "pen" are a match). A title with {name} in it
// matches any value there, and gives that value back: "pen-{host}" and a tab "pen-db1" are a
// match with host = db1. Case does not matter. -> { p, vars } or null.
function presetMatch(title) {
  const t = String(title || '').trim();
  if (!t) return null;
  for (const p of termPresets) {
    if (p.name.toLowerCase() === t.toLowerCase()) return { p, vars: null };
    for (const s of p.steps) {
      if (s.k !== 'title') continue;
      const vars = presetTitleVars(s.text, t, p);
      if (vars) return { p, vars: Object.keys(vars).length ? vars : null };
    }
  }
  return null;
}
// At launch, for every terminal tab that comes back. The tab's TITLE decides first: a title
// that matches a preset is that preset. Only a title that matches none falls back to the
// preset the tab was linked to (saved with it: one applied to a shell with a title of its own).
// The other way round was a trap: a tab once linked to "Pen" and called "crm" again ran Pen at
// every launch - and Pen's own "title:" step renamed it back to "pen" a few seconds later.
// With "run at launch" on (the default) the preset is typed by itself once the shell or the
// connection is there - but only when every question has an answer; otherwise, and with the
// setting off, the tab gets the strip with a Run button and nothing is typed without a click.
let presetAutoRun = true; // saved
function presetAtLaunch(id, saved, savedVars) {
  const rec = tabs.get(id);
  if (!rec || (rec.kind !== 'local' && rec.kind !== 'ssh')) return null;
  const el = rec.tabEl && rec.tabEl.querySelector('.title');
  const m = presetMatch(rec.customTitle || (el && el.textContent) || '');
  let p = m ? m.p : presetFind(saved);
  if (!p) return null;
  const sv = savedVars && typeof savedVars === 'object' && presetFind(saved) === p ? { ...savedVars } : null;
  let vars = (m && m.vars) || sv;
  if (!vars) vars = { ...(presetLastVars[p.name] || {}) };
  rec.preset = { name: p.name, vars };
  if (presetAutoRun && presetVarsDone(p, vars)) {
    presetLaunchAdd(rec, p, 'run');
    presetRun(rec);
  } else {
    const missing = p.asks.filter((a) => !vars[a.name]).map((a) => a.name);
    presetLaunchAdd(rec, p, 'idle', !presetAutoRun ? 'waits for a click - running at launch is off' : 'waits for a click - no answer yet for ' + missing.join(', '));
    presetBar(rec, 'idle');
  }
  return p.name;
}

// ---- the launch report: one note after a restart, how the preset tabs did ----
// presetAtLaunch adds every tab it looks after; the end of a run (done / stopped, with why)
// notes it here. Once the restore is over (presetLaunchArm, from renderer.js) and nothing is
// running any more - or after PRESET_REPORT_MS, whatever still runs is then "still running" -
// one note: each tab, its preset, and how it went. All went through: it goes by itself after
// a while. Anything else: it stays until it is closed. A row is a way to that tab.
const PRESET_REPORT_MS = 180000;
const PRESET_REPORT_OK_MS = 15000;
let presetLaunch = null; // { items: Map tabId -> { id, name, state, why }, armed, timer }
function presetLaunchAdd(rec, p, state, why) {
  if (!presetLaunch) presetLaunch = { items: new Map(), armed: false, timer: null };
  presetLaunch.items.set(rec.id, { id: rec.id, name: p.name, state, why: why || '' });
}
function presetLaunchNote(rec, state, why) {
  const L = presetLaunch;
  const it = L && L.items.get(rec.id);
  if (!it || it.state !== 'run') return;
  if (state === 'stopped' && /^Restarted\b/.test(why || '')) return; // Run again: the new run is the one that counts
  it.state = state;
  it.why = why || '';
  presetLaunchCheck();
}
function presetLaunchArm() {
  const L = presetLaunch;
  if (!L || !L.items.size) {
    presetLaunch = null;
    return;
  }
  L.armed = true;
  L.timer = setTimeout(() => presetLaunchShow(), PRESET_REPORT_MS);
  presetLaunchCheck();
}
function presetLaunchCheck() {
  const L = presetLaunch;
  if (!L || !L.armed) return;
  for (const it of L.items.values()) if (it.state === 'run' && tabs.has(it.id)) return; // still at it
  presetLaunchShow();
}
function presetLaunchShow() {
  const L = presetLaunch;
  if (!L) return;
  clearTimeout(L.timer);
  presetLaunch = null;
  const items = [...L.items.values()];
  for (const it of items) if (!tabs.has(it.id)) Object.assign(it, { state: 'closed', why: 'the tab was closed' });
  const n = (s) => items.filter((x) => x.state === s).length;
  const parts = [];
  if (n('done')) parts.push(n('done') + ' ran through');
  if (n('stopped')) parts.push(n('stopped') + ' stopped');
  if (n('run')) parts.push(n('run') + ' still running');
  if (n('idle')) parts.push(n('idle') + ' waiting for you');
  if (n('closed')) parts.push(n('closed') + ' closed');
  const ok = items.every((x) => x.state === 'done');
  document.getElementById('preset-report')?.remove();
  const box = document.createElement('div');
  box.id = 'preset-report';
  box.className = ok ? 'ok' : 'bad';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const ICON = { done: '✓', stopped: '✗', run: '…', idle: '⏸', closed: '·' };
  const SAY = { done: 'ran through', run: 'still running', closed: 'closed' };
  box.innerHTML =
    '<div class="prr-head"><b>⚡ Presets at launch</b><span>' + esc(parts.join(' · ')) + '</span><button class="prr-x" title="Close">✕</button></div>' +
    items
      .map((it) => {
        const rec = tabs.get(it.id);
        const el = rec && rec.tabEl && rec.tabEl.querySelector('.title');
        const title = (el && el.textContent) || it.name;
        return (
          '<div class="prr-row ' + it.state + '" data-id="' + esc(it.id) + '"' + (rec ? ' title="Go to this tab"' : '') + '>' +
          '<i>' + ICON[it.state] + '</i><b>' + esc(title) + '</b><span class="prr-p">' + esc(it.name) + '</span>' +
          '<span class="prr-why">' + esc(it.why || SAY[it.state] || '') + '</span></div>'
        );
      })
      .join('');
  document.body.appendChild(box);
  box.addEventListener('click', (e) => {
    if (e.target.closest('.prr-x')) return box.remove();
    const row = e.target.closest('.prr-row');
    if (row && tabs.has(row.dataset.id)) activateTab(row.dataset.id);
  });
  if (ok) {
    let t = setTimeout(() => box.remove(), PRESET_REPORT_OK_MS);
    box.addEventListener('mouseenter', () => clearTimeout(t));
    box.addEventListener('mouseleave', () => (t = setTimeout(() => box.remove(), 4000)));
  }
  if (typeof logEvent === 'function') logEvent('system', { title: 'Presets at launch', detail: parts.join(' · ') });
}

// You renamed a tab: its link to a preset follows the new name. A name that matches a preset
// links the tab to it (shown with the strip's Run button - nothing is typed now); a name that
// matches none unlinks it. A preset's own "title:" step renames through applyTabRename and
// never comes here.
function presetRenamed(rec, name) {
  if (!rec || (rec.kind !== 'local' && rec.kind !== 'ssh')) return;
  if (rec._presetRun) return; // a run in progress keeps its preset
  const m = presetMatch(name);
  const cur = rec.preset && presetFind(rec.preset.name);
  if (m && m.p !== cur) {
    rec.preset = { name: m.p.name, vars: m.vars || { ...(presetLastVars[m.p.name] || {}) } };
    presetBar(rec, 'idle');
  } else if (!m && cur) {
    rec.preset = null;
    presetBar(rec, 'gone');
  }
  persistTabOrder();
}
// The link, undone by hand (the hover sheet's list): this tab runs no preset at launch.
function presetUnlink(rec) {
  if (rec._presetRun) presetStop(rec, 'Unlinked');
  rec.preset = null;
  presetBar(rec, 'gone');
  persistTabOrder();
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
      if (b.dataset.pb === 'run') presetRerun(rec);
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
  const at = why + ' at step ' + Math.min(st.i + 1, st.p.steps.length) + ' of ' + st.p.steps.length;
  presetBar(rec, 'stopped', at);
  presetLaunchNote(rec, 'stopped', at);
}
// The text on the cursor's line, left of the cursor (or all of it): what a prompt check, and a
// recording, look at. A long line that wrapped is joined with the rows it continues.
function presetCursorText(rec, whole) {
  try {
    const buf = rec.term.buffer.active;
    const y = buf.baseY + buf.cursorY;
    const row = buf.getLine(y);
    if (!row) return '';
    let text = whole ? row.translateToString(true) : row.translateToString(false, 0, buf.cursorX);
    for (let k = y; k > 0 && buf.getLine(k) && buf.getLine(k).isWrapped && text.length < 4000; k--) {
      text = buf.getLine(k - 1).translateToString(false) + text;
    }
    return text;
  } catch (_) {
    return '';
  }
}
// Where the terminal is now, for a "wait-prompt": 'prompt', 'secret', 'question' or 'busy'.
function presetPromptState(rec, st) {
  if (rec.status !== 'connected' || !rec.term) return 'busy';
  try {
    if (rec.term.buffer.active.type !== 'normal') return 'busy'; // a full-screen program is no prompt
  } catch (_) {
    return 'busy';
  }
  if (st.lastCmdAt && !st.outSince) return 'busy'; // nothing came since the command: the old prompt still shows
  if (Date.now() - (rec._lastDataAt || 0) < PRESET_QUIET_MS) return 'busy';
  const s = presetLineState(presetCursorText(rec, false));
  return s === 'other' ? 'busy' : s;
}
function presetRun(rec) {
  const p = rec.preset && presetFind(rec.preset.name);
  if (!p) return presetBar(rec, 'gone');
  const vars = (rec.preset && rec.preset.vars) || {};
  if (rec._presetRun) presetStop(rec, 'Restarted');
  const st = (rec._presetRun = { p, i: 0, stopped: false, timer: null, wait: null, lastCmdAt: 0, outSince: 0, since: Date.now() });
  const alive = () => !st.stopped && rec._presetRun === st && tabs.get(rec.id) === rec;
  const later = (ms, fn) => {
    st.timer = setTimeout(() => alive() && fn(), ms);
  };
  const show = (extra) => {
    const s = p.steps[st.i];
    presetBar(rec, 'run', 'step ' + (st.i + 1) + ' of ' + p.steps.length + ' · ' + (extra || presetStepText(s, p, vars)));
  };
  const done = () => {
    rec._presetRun = null;
    presetBar(rec, 'done', 'done');
    presetLaunchNote(rec, 'done');
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
          st.outSince = 0;
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
      applyTabRename(rec, presetFill(s.text, p, vars));
      go();
    } else if (s.k === 'sleep') {
      later(s.ms, go);
    } else if (s.k === 'prompt') {
      // until the shell is back at a prompt - whatever the prompt looks like. A password or a
      // yes/no on the way is said on the strip: you answer it, the preset goes on after.
      const t0 = Date.now();
      const check = () => {
        if (Date.now() - t0 > s.ms) return presetStop(rec, 'No prompt within ' + s.ms / 1000 + ' s');
        const now = presetPromptState(rec, st);
        if (now === 'prompt') return go();
        show(now === 'secret' ? 'a password is asked for - type it, the preset goes on after' : now === 'question' ? 'a question is asked - answer it, the preset goes on after' : 'waiting for the prompt');
        later(150, check);
      };
      check();
    } else if (s.k === 'wait') {
      // the text may already be on screen from the step before
      const want = presetFill(s.text, p, vars).toLowerCase();
      st.wait = { want, buf: (st.seen || '').slice(-4000), go };
      if (st.wait.buf.includes(want)) {
        st.wait = null;
        st.seen = '';
        return go();
      }
      later(s.ms, () => presetStop(rec, '"' + presetFill(s.text, p, vars) + '" did not show up in ' + s.ms / 1000 + ' s'));
    } else {
      st.seen = ''; // a wait after this command looks at what comes from here on
      typeWhenReady(presetFill(s.text, p, vars), go);
    }
  };
  next();
}
// Output of the tab, as text: what a "wait:" step looks through. Called from both data routers.
function presetFeed(rec, text) {
  const st = rec._presetRun;
  if (!st || !text) return;
  st.outSince += String(text).length;
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

// ---- recording one ----
// While recording, every command line you run in the tab is noted - read from the SCREEN at the
// moment you press Enter, because that is what the shell really got (tab completion, a line
// from history). What was typed but does not show on the screen was not echoed: a password.
// That is never noted, and neither is anything typed on a line that asks for one.
// -> { cmd } | { secret: true } | null (nothing to note)
function presetRecCmd(screen, typed) {
  const s = String(screen || '').replace(/\s+$/, '');
  const t = String(typed || '').trim();
  if (PRESET_SECRET.test(s)) return t ? { secret: true } : null;
  if (t) {
    const head = t.slice(0, Math.min(8, t.length));
    const i = s.lastIndexOf(head);
    if (i !== -1) return { cmd: s.slice(i).trim() };
  }
  // a line from history (arrow up) or one edited in the middle: the text after the prompt
  const m = /^(.*?[$#%>❯›»])\s+(\S.*)$/.exec(s);
  if (m) return { cmd: m[2].trim() };
  return t ? { secret: true } : null; // typed, but nowhere on the screen: not echoed
}
function presetRecStart(rec) {
  presetRecStop(rec);
  rec._presetRec = { cmds: [], hidden: 0, t0: Date.now() };
  presetRecBar(rec);
}
function presetRecStop(rec) {
  rec._presetRec = null;
  rec.paneEl.querySelector('.preset-recbar')?.remove();
}
// Called from both typed-input capturers when Enter is pressed, BEFORE the line is cleared.
function presetRecordEnter(rec, typed) {
  const r = rec._presetRec;
  if (!r) return;
  const got = presetRecCmd(presetCursorText(rec, true), typed);
  if (!got) return;
  if (got.secret) r.hidden++;
  else r.cmds.push(got.cmd);
  presetRecBar(rec);
}
function presetRecBar(rec) {
  const r = rec._presetRec;
  let bar = rec.paneEl.querySelector('.preset-recbar');
  if (!r) return bar && bar.remove();
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'preset-recbar';
    bar.addEventListener('mousedown', (e) => e.preventDefault()); // the terminal keeps the keyboard
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pr]');
      if (!b) return;
      if (b.dataset.pr === 'save') presetRecSave(rec);
      else presetRecStop(rec);
      if (rec.term) rec.term.focus();
    });
    rec.paneEl.appendChild(bar);
  }
  const n = r.cmds.length;
  bar.innerHTML =
    '<span class="pr-dot"></span><span class="pb-name">Recording a preset</span>' +
    '<span class="pb-text">' + n + ' command' + (n === 1 ? '' : 's') + (r.hidden ? ' · ' + r.hidden + ' hidden input (a password?) left out' : '') + '</span>' +
    '<button data-pr="save" title="Stop and save the commands as a preset - you see it before it is saved"' + (n ? '' : ' disabled') + '>Save…</button>' +
    '<button data-pr="cancel" title="Stop recording, keep nothing">Cancel</button>';
}
// The recording as preset text: where the tab started, its title, the commands - each one
// waiting for the prompt of the one before.
function presetRecText(rec, name) {
  const r = rec._presetRec;
  const cmds = (r && r.cmds) || [];
  const lines = ['[' + name + ']'];
  const pre = [];
  if (rec.kind === 'ssh' && rec.profile) {
    const pr = rec.profile;
    const saved = (savedSessions || []).find((x) => (x.name && x.name === pr.name) || (x.host === pr.host && x.username === pr.username && String(x.port || 22) === String(pr.port || 22)));
    if (saved) lines.push('start: ' + (saved.name || saved.username + '@' + saved.host));
    else {
      lines.push('start: local');
      pre.push('ssh ' + (pr.port && String(pr.port) !== '22' ? '-p ' + pr.port + ' ' : '') + pr.username + '@' + pr.host);
    }
  } else {
    lines.push('start: local');
    if (rec.cwd) lines.push('cwd: ' + rec.cwd);
  }
  lines.push('title: ' + name);
  pre.concat(cmds).forEach((c, i) => {
    if (i) lines.push('wait-prompt');
    lines.push(/^\[.*\]$/.test(c) || /^(start|cwd|ask|title|run|sleep|wait)\b/i.test(c) || c.startsWith('#') ? 'run: ' + c : c);
  });
  return lines.join('\n');
}
async function presetRecSave(rec) {
  const r = rec._presetRec;
  if (!r || !r.cmds.length) return;
  const el = rec.tabEl && rec.tabEl.querySelector('.title');
  let name = String(rec.customTitle || (el && el.textContent) || 'Recorded').trim() || 'Recorded';
  for (let i = 2; presetFind(name); i++) name = name.replace(/ \d+$/, '') + ' ' + i;
  const vals = await presetDialog({
    title: 'Save as a preset',
    text: r.cmds.length + ' command' + (r.cmds.length === 1 ? '' : 's') + ' recorded' + (r.hidden ? ', ' + r.hidden + ' hidden input left out' : '') + '. Change anything you like - the name is the first line. It is added to your presets.',
    ok: 'Save preset',
    fields: [{ key: 'text', label: 'Preset', value: presetRecText(rec, name), multiline: true, rows: Math.min(18, r.cmds.length * 2 + 5) }],
    check: (v) => {
      const res = presetParse(v.text);
      if (res.errors.length) return res.errors.join(' · ');
      if (res.presets.length !== 1) return 'Keep it to one preset (one [Name] line).';
      if (presetFind(res.presets[0].name)) return 'There is a preset called "' + res.presets[0].name + '" already - change the name in the first line.';
      return '';
    },
  });
  if (!vals) return; // still recording: nothing is lost
  const block = vals.text.replace(/\s+$/, '');
  const all = (termPresetsText.replace(/\s+$/, '') ? termPresetsText.replace(/\s+$/, '') + '\n\n' : '') + block + '\n';
  presetSetText(all, true);
  const ta = document.getElementById('set-term-presets');
  if (ta) ta.value = termPresetsText;
  const saved = presetParse(block).presets[0];
  presetRecStop(rec);
  // the tab now belongs to the preset it was recorded in
  rec.preset = { name: saved.name, vars: {} };
  persistTabOrder();
  presetBar(rec, 'done', 'saved as a preset');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { presetParse, presetFirstTitle, presetStepText, presetFill, presetVarsDone, presetTitleVars, presetLineState, presetRecCmd };
}
