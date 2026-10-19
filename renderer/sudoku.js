// ---- Sudoku: a tab with a 9 x 9 grid ----
// The puzzles, their rating and the hints come from sudoku-engine.js; this file is the tab:
// the grid, the number pad, pencil marks, undo, the clock, and the game's place in settings.
// Loaded before renderer.js: it only touches renderer globals inside functions.
const sudokuSt = {
  rec: null,
  puzzle: null, // the givens
  solution: null,
  values: null, // what stands in the grid now (givens + yours)
  notes: null, // pencil marks: a bit mask per cell
  level: 2,
  sel: 40,
  noteMode: false,
  autoCheck: false,
  sound: true,
  noteGrid: false, // notes as a 3 x 3 grid (each digit in its own place) instead of in the corner
  notePop: null, // the cell whose note picker is open (right-click)
  elapsed: 0,
  done: false,
  undo: [],
  hint: null, // { cell, digit, text } - the hint that is showing
  wrong: new Set(), // cells marked by Check
  saved: null,
  saveTimer: null,
  tick: null,
  making: false,
};

function sudokuRestoreSettings(s) {
  if (!s || typeof s !== 'object') return;
  const grid = (v) => (typeof v === 'string' && /^[0-9]{81}$/.test(v) ? v.split('').map(Number) : null);
  const out = {};
  out.puzzle = grid(s.puzzle);
  out.solution = grid(s.solution);
  out.values = grid(s.values);
  if (Array.isArray(s.notes) && s.notes.length === 81 && s.notes.every((n) => Number.isInteger(n) && n >= 0 && n <= 0x3fe)) out.notes = s.notes.slice();
  if (Number.isInteger(s.level) && s.level >= 1 && s.level <= 4) out.level = s.level;
  if (Number.isFinite(s.elapsed) && s.elapsed >= 0) out.elapsed = Math.floor(s.elapsed);
  out.autoCheck = s.autoCheck === true;
  out.noteGrid = s.noteGrid === true;
  out.sound = s.sound !== false;
  out.done = s.done === true;
  // only a game that hangs together: a full solution, givens that agree with it
  if (out.puzzle && out.solution && out.values && !out.solution.includes(0) && out.puzzle.every((d, i) => !d || d === out.solution[i]) && out.puzzle.every((d, i) => !d || out.values[i] === d)) {
    sudokuSt.saved = out;
  } else sudokuSt.saved = { level: out.level, autoCheck: out.autoCheck, noteGrid: out.noteGrid, sound: out.sound };
}
function sudokuSave() {
  const st = sudokuSt;
  st.saved = {
    puzzle: st.puzzle.join(''),
    solution: st.solution.join(''),
    values: st.values.join(''),
    notes: st.notes.slice(),
    level: st.level,
    elapsed: st.elapsed,
    autoCheck: st.autoCheck,
    noteGrid: st.noteGrid,
    sound: st.sound,
    done: st.done,
  };
  clearTimeout(st.saveTimer);
  st.saveTimer = setTimeout(() => api.saveSettings({ sudoku: st.saved }), 400);
}

function createSudokuTab() {
  for (const [tid, r] of tabs) {
    if (r.kind === 'sudoku') {
      activateTab(tid);
      return tid;
    }
  }
  const id = newTabId();
  const { tabEl, paneEl } = createTabChrome(id, 'Sudoku', 'sudoku');
  paneEl.classList.remove('term-pane');
  paneEl.classList.add('sudoku-pane');
  paneEl.tabIndex = -1;
  const levels = Object.entries(SudokuEngine.LEVELS)
    .map(([k, v]) => `<option value="${k}">${v.name}</option>`)
    .join('');
  let cells = '';
  for (let i = 0; i < 81; i++) cells += `<div class="sdk-cell" data-i="${i}"></div>`;
  let pad = '';
  for (let d = 1; d <= 9; d++) pad += `<button class="sdk-key" data-d="${d}"><b>${d}</b><i></i></button>`;
  paneEl.innerHTML =
    '<div class="sdk-stage"><div class="sdk-board"><div class="sdk-grid">' +
    cells +
    '</div><div class="sdk-notepop hidden"></div><div class="sdk-banner hidden"></div></div></div>' +
    '<div class="sdk-side">' +
    '<div class="sdk-status"><span class="sdk-level"></span><span class="sdk-time"></span></div>' +
    `<div class="sdk-row"><select class="sdk-newlevel" title="How hard the next puzzle is">${levels}</select><button data-s="new" title="A new puzzle">New puzzle</button></div>` +
    `<div class="sdk-pad">${pad}</div>` +
    '<div class="sdk-row sdk-btns">' +
    '<button data-s="notes" title="Pencil marks: digits go in as small notes (n, or hold Shift). Or right-click a cell.">✎ Notes</button>' +
    '<button data-s="erase" title="Clear the cell (Backspace)">⌫ Erase</button>' +
    '<button data-s="undo" title="Undo (u or Ctrl+Z)">↶ Undo</button>' +
    '<button data-s="hint" title="Show the next step - press again to fill it in (h)">💡 Hint</button>' +
    '<button data-s="check" title="Mark the entries that are not right (c)">✓ Check</button>' +
    '<button data-s="autonotes" title="Pencil in every digit that is still possible, in every empty cell">✎ All notes</button>' +
    '</div>' +
    '<label class="sdk-opt"><input type="checkbox" class="sdk-auto" /> Show mistakes as I type</label>' +
    '<label class="sdk-opt" title="Off: notes are small digits in the corner of the cell. On: each digit has its own place in a 3 x 3 grid."><input type="checkbox" class="sdk-notegrid" /> Notes as a 3 × 3 grid</label>' +
    '<label class="sdk-opt" title="A soft tick when a digit goes in (never during a meeting)"><input type="checkbox" class="sdk-sound" /> 🔊 Sound</label>' +
    '<div class="sdk-msg"></div>' +
    '<div class="sdk-keys">Arrows move · 1-9 enter · Backspace clears · h hint · u undo<br />Notes: right-click a cell (or a digit on the pad), Shift+digit, or n</div>' +
    '</div>';
  const rec = { id, kind: 'sudoku', paneEl, tabEl, status: 'connected', profile: { name: 'Sudoku' } };
  tabs.set(id, rec);
  const st = sudokuSt;
  st.rec = rec;
  const s = st.saved || {};
  st.level = s.level || 2;
  st.autoCheck = !!s.autoCheck;
  st.noteGrid = !!s.noteGrid;
  st.sound = s.sound !== false;
  st.notePop = null;
  st.undo = [];
  st.hint = null;
  st.wrong = new Set();
  st.noteMode = false;
  st.sel = 40;
  sudokuWire(rec);
  activateTab(id);
  bbTabOpen(rec);
  persistTabOrder();
  if (s.puzzle) {
    st.puzzle = s.puzzle.slice();
    st.solution = s.solution.slice();
    st.values = s.values.slice();
    st.notes = s.notes ? s.notes.slice() : new Array(81).fill(0);
    st.elapsed = s.elapsed || 0;
    st.done = !!s.done;
    sudokuRender();
  } else sudokuNew(st.level, true);
  clearInterval(st.tick);
  st.tick = setInterval(sudokuTick, 1000);
  setTimeout(() => paneEl.focus(), 0);
  return id;
}
function sudokuOnShow() {
  if (sudokuSt.rec) sudokuSt.rec.paneEl.focus({ preventScroll: true });
}
function sudokuOnClose() {
  clearInterval(sudokuSt.tick);
  clearTimeout(sudokuSt.saveTimer);
  if (sudokuSt.puzzle) api.saveSettings({ sudoku: sudokuSt.saved }); // the clock, up to now
  sudokuSt.rec = null;
}
// The clock runs while you are looking at the puzzle, and stops when it is solved.
function sudokuTick() {
  const st = sudokuSt;
  if (!st.rec || st.done || st.making || !st.puzzle) return;
  if (activeTabId !== st.rec.id || document.hidden) return;
  st.elapsed++;
  const t = st.rec.paneEl.querySelector('.sdk-time');
  if (t) t.textContent = gameClock(st.elapsed);
  if (st.elapsed % 15 === 0) sudokuSave();
}
function sudokuNew(level, force) {
  const st = sudokuSt;
  if (!st.rec || st.making) return;
  const started = st.puzzle && !st.done && st.values.some((d, i) => d && !st.puzzle[i]);
  if (!force && started && !window.confirm('Start a new puzzle? This one will be lost.')) return;
  st.level = level;
  st.making = true;
  sudokuMsg('Making a ' + SudokuEngine.LEVELS[level].name.toLowerCase() + ' puzzle…');
  // on the next turn of the loop, so "Making…" is on screen first (a Hard one takes most of a second)
  setTimeout(() => {
    const p = SudokuEngine.generate(level);
    st.making = false;
    if (!st.rec) return;
    st.puzzle = p.puzzle;
    st.solution = p.solution;
    st.values = p.puzzle.slice();
    st.notes = new Array(81).fill(0);
    st.elapsed = 0;
    st.done = false;
    st.undo = [];
    st.hint = null;
    st.wrong = new Set();
    st.sel = Math.max(0, st.values.indexOf(0));
    sudokuMsg('');
    sudokuRender();
    sudokuSave();
  }, 20);
}
function sudokuMsg(text, kind) {
  const el = sudokuSt.rec && sudokuSt.rec.paneEl.querySelector('.sdk-msg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'sdk-msg' + (kind ? ' ' + kind : '');
}
function sudokuWire(rec) {
  const p = rec.paneEl;
  gameKeepFocus(p);
  p.querySelector('.sdk-grid').addEventListener('mousedown', (e) => {
    const c = e.target.closest('.sdk-cell');
    if (!c) return;
    // The redraw below replaces the very element that was pressed (a note digit), and the
    // browser's own focus step would then find nothing to focus: take the focus here, and
    // keep the browser from moving it again.
    e.preventDefault();
    p.focus({ preventScroll: true });
    sudokuSt.sel = +c.dataset.i;
    if (e.button === 0) sudokuSt.notePop = null; // a right press is followed by contextmenu, which decides
    sudokuRender();
  });
  // Right-click a cell: its note picker - nine small digits to switch on and off, as many as you
  // like, without leaving the mouse. On a cell that holds a digit there is nothing to note.
  p.querySelector('.sdk-grid').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const c = e.target.closest('.sdk-cell');
    if (!c) return;
    const st = sudokuSt;
    const i = +c.dataset.i;
    st.sel = i;
    if (!st.puzzle || st.done || st.making) st.notePop = null;
    else if (st.puzzle[i] || st.values[i]) {
      st.notePop = null;
      sudokuMsg(st.puzzle[i] ? 'This digit came with the puzzle - notes go into empty cells.' : 'Notes go into empty cells - clear this one first (Backspace).');
    } else st.notePop = st.notePop === i ? null : i; // a second right-click puts it away
    sudokuRender();
  });
  p.querySelector('.sdk-notepop').addEventListener('mousedown', (e) => e.preventDefault()); // the pane keeps the keys
  p.querySelector('.sdk-notepop').addEventListener('contextmenu', (e) => e.preventDefault());
  p.querySelector('.sdk-notepop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-n]');
    if (!b || sudokuSt.notePop == null) return;
    sudokuSt.sel = sudokuSt.notePop;
    if (b.dataset.n === 'x') sudokuSt.notePop = null;
    else if (b.dataset.n === '0') sudokuEnter(0, false); // no value here, so this clears the notes
    else sudokuEnter(+b.dataset.n, true);
    sudokuRender();
  });
  // a left press anywhere else puts the picker away
  p.addEventListener('mousedown', (e) => {
    if (sudokuSt.notePop == null || e.button !== 0 || e.target.closest('.sdk-notepop, .sdk-grid')) return;
    sudokuSt.notePop = null;
    sudokuRender();
  });
  p.querySelector('.sdk-pad').addEventListener('click', (e) => {
    const b = e.target.closest('[data-d]');
    if (b) sudokuEnter(+b.dataset.d, sudokuSt.noteMode);
    p.focus({ preventScroll: true });
  });
  // right-click a digit on the pad: that digit as a note in the chosen cell
  p.querySelector('.sdk-pad').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const b = e.target.closest('[data-d]');
    if (b) sudokuEnter(+b.dataset.d, true);
    p.focus({ preventScroll: true });
  });
  p.querySelector('.sdk-sound').addEventListener('change', (e) => {
    sudokuSt.sound = e.target.checked;
    sudokuSave();
    p.focus({ preventScroll: true });
  });
  p.querySelector('.sdk-notegrid').addEventListener('change', (e) => {
    sudokuSt.noteGrid = e.target.checked;
    sudokuRender();
    sudokuSave();
    p.focus({ preventScroll: true });
  });
  p.querySelector('.sdk-side').addEventListener('click', (e) => {
    const b = e.target.closest('[data-s]');
    if (!b) return;
    const s = b.dataset.s;
    if (s === 'new') sudokuNew(parseInt(p.querySelector('.sdk-newlevel').value, 10) || 2);
    else if (s === 'notes') {
      sudokuSt.noteMode = !sudokuSt.noteMode;
      sudokuRender();
    } else if (s === 'erase') sudokuEnter(0, false);
    else if (s === 'undo') sudokuUndo();
    else if (s === 'hint') sudokuHint();
    else if (s === 'check') sudokuCheck();
    else if (s === 'autonotes') sudokuAutoNotes();
    p.focus({ preventScroll: true });
  });
  p.querySelector('.sdk-auto').addEventListener('change', (e) => {
    sudokuSt.autoCheck = e.target.checked;
    sudokuSt.wrong = new Set();
    sudokuRender();
    sudokuSave();
  });
  p.querySelector('.sdk-banner').addEventListener('click', (e) => {
    if (e.target.closest('[data-s="new"]')) sudokuNew(parseInt(p.querySelector('.sdk-newlevel').value, 10) || 2, true);
  });
  p.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'SELECT' || t.tagName === 'INPUT')) return;
    const st = sudokuSt;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') {
      e.preventDefault();
      return sudokuUndo();
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'Escape' && st.notePop != null) {
      e.preventDefault();
      st.notePop = null;
      return sudokuRender();
    }
    const picking = st.notePop != null; // digits typed now are notes for that cell
    if (picking && /^Arrow/.test(k)) st.notePop = null; // moving on
    let used = true;
    // e.code, so Shift+3 is still "3" (e.key would be "#" or "§")
    const dm = /^(?:Digit|Numpad)([0-9])$/.exec(e.code || '');
    if (dm) sudokuEnter(+dm[1], dm[1] !== '0' && (picking || st.noteMode !== e.shiftKey)); // Shift flips the mode for one digit
    else if (/^[1-9]$/.test(k)) sudokuEnter(+k, picking || st.noteMode);
    else if (k === 'Backspace' || k === 'Delete' || k === '0') sudokuEnter(0, false);
    else if (k === 'ArrowUp') st.sel = (st.sel + 72) % 81;
    else if (k === 'ArrowDown') st.sel = (st.sel + 9) % 81;
    else if (k === 'ArrowLeft') st.sel = st.sel % 9 === 0 ? st.sel + 8 : st.sel - 1;
    else if (k === 'ArrowRight') st.sel = st.sel % 9 === 8 ? st.sel - 8 : st.sel + 1;
    else if (k === 'n' || k === 'N') st.noteMode = !st.noteMode;
    else if (k === 'h' || k === 'H') sudokuHint();
    else if (k === 'u' || k === 'U') sudokuUndo();
    else if (k === 'c' || k === 'C') sudokuCheck();
    else used = false;
    if (!used) return;
    e.preventDefault();
    if (/^Arrow/.test(k) || k === 'n' || k === 'N') sudokuRender();
  });
}
// A digit into the chosen cell (0 clears it). asNote: a pencil mark instead.
function sudokuEnter(d, asNote) {
  const st = sudokuSt;
  const i = st.sel;
  if (!st.puzzle || st.done || st.making || st.puzzle[i]) return;
  const before = { cell: i, value: st.values[i], notes: st.notes[i], peers: [] };
  if (asNote) {
    if (st.values[i] || !d) return;
    st.notes[i] ^= SudokuEngine.bit(d);
  } else if (!d) {
    if (!st.values[i] && !st.notes[i]) return;
    st.values[i] = 0;
    st.notes[i] = 0;
  } else {
    st.values[i] = st.values[i] === d ? 0 : d; // the same digit again takes it out
    if (st.values[i]) {
      st.notes[i] = 0;
      // a digit placed can no longer be anywhere it sees: take it out of those notes
      for (const p of SudokuEngine.PEERS[i]) {
        if (st.notes[p] & SudokuEngine.bit(d)) {
          before.peers.push([p, st.notes[p]]);
          st.notes[p] &= ~SudokuEngine.bit(d);
        }
      }
    }
  }
  st.undo.push(before);
  if (st.undo.length > 500) st.undo.shift();
  st.hint = null;
  st.wrong.delete(i);
  sudokuMsg('');
  if (!st.values.includes(0) && st.values.every((v, k) => v === st.solution[k])) {
    st.done = true;
    if (st.sound) gameSound('end');
  } else if (!asNote && d && st.sound) gameSound('tick');
  sudokuRender();
  sudokuSave();
}
function sudokuUndo() {
  const st = sudokuSt;
  const u = st.undo.pop();
  if (!u || st.done) return;
  if (u.allNotes) {
    st.notes = u.allNotes.slice();
    st.hint = null;
    sudokuMsg('');
    sudokuRender();
    return sudokuSave();
  }
  st.values[u.cell] = u.value;
  st.notes[u.cell] = u.notes;
  for (const [p, m] of u.peers) st.notes[p] = m;
  st.sel = u.cell;
  st.hint = null;
  sudokuMsg('');
  sudokuRender();
  sudokuSave();
}
function sudokuCheck() {
  const st = sudokuSt;
  if (!st.puzzle || st.done) return;
  st.wrong = new Set();
  for (let i = 0; i < 81; i++) if (st.values[i] && !st.puzzle[i] && st.values[i] !== st.solution[i]) st.wrong.add(i);
  const left = st.values.filter((v) => !v).length;
  sudokuMsg(st.wrong.size ? st.wrong.size + (st.wrong.size === 1 ? ' entry is' : ' entries are') + ' not right.' : 'All correct so far - ' + left + ' to go.', st.wrong.size ? 'bad' : 'good');
  sudokuRender();
}
function sudokuAutoNotes() {
  const st = sudokuSt;
  if (!st.puzzle || st.done) return;
  const cand = SudokuEngine.candidatesOf(st.values);
  // one undo step for the lot: the notes as they were, yours among them. (It used to empty the
  // undo list instead, so one click wiped hand-made notes for good AND everything before it.)
  const before = st.notes.slice();
  for (let i = 0; i < 81; i++) if (!st.values[i]) st.notes[i] = cand[i];
  if (st.notes.every((n, i) => n === before[i])) return sudokuMsg('The notes are already complete.');
  st.undo.push({ allNotes: before });
  if (st.undo.length > 500) st.undo.shift();
  st.hint = null;
  sudokuMsg('Every possible digit is pencilled in - Undo (u) takes it back.');
  sudokuRender();
  sudokuSave();
}
// First press: where to look and why. Second press: the digit goes in.
function sudokuHint() {
  const st = sudokuSt;
  if (!st.puzzle || st.done || st.making) return;
  if (st.hint && st.hint.digit && st.sel === st.hint.cell && !st.values[st.hint.cell]) {
    const h = st.hint;
    sudokuEnter(h.digit, false);
    return;
  }
  const h = SudokuEngine.hint(st.values, st.solution);
  if (h.kind === 'wrong') {
    st.sel = h.cell;
    st.wrong.add(h.cell);
    st.hint = null;
    sudokuMsg('This entry is not right - fix it first.', 'bad');
  } else if (h.kind === 'place') {
    st.sel = h.cell;
    st.hint = { cell: h.cell, digit: h.digit };
    const name = h.tech === 'advanced' ? 'A hard step' : h.tech[0].toUpperCase() + h.tech.slice(1);
    sudokuMsg(name + ': ' + h.why + '.' + (h.first.length ? ' (After: ' + h.first.join(', ') + '.)' : '') + ' Press Hint again to fill it in.', 'hint');
  }
  sudokuRender();
}
// One painter for the grid, the pad and the panel.
function sudokuRender() {
  const st = sudokuSt;
  if (!st.rec || !st.puzzle) return;
  const S = SudokuEngine;
  const p = st.rec.paneEl;
  const clash = new Set(S.conflicts(st.values));
  const selV = st.values[st.sel];
  const peers = new Set(S.PEERS[st.sel]);
  const cells = p.querySelectorAll('.sdk-cell');
  for (let i = 0; i < 81; i++) {
    const el = cells[i];
    const v = st.values[i];
    const wrong = st.wrong.has(i) || (st.autoCheck && v && !st.puzzle[i] && v !== st.solution[i]);
    el.className =
      'sdk-cell' +
      (st.puzzle[i] ? ' given' : '') +
      (i === st.sel ? ' sel' : peers.has(i) ? ' peer' : '') +
      (v && selV && v === selV && i !== st.sel ? ' same' : '') +
      (clash.has(i) ? ' clash' : '') +
      (wrong ? ' wrong' : '') +
      (st.hint && st.hint.cell === i ? ' hint' : '') +
      (i % 9 === 2 || i % 9 === 5 ? ' br' : '') +
      (Math.floor(i / 9) === 2 || Math.floor(i / 9) === 5 ? ' bb' : '');
    if (v) el.textContent = v;
    else if (st.notes[i]) {
      // in the corner: only the digits noted, small, from the top left. As a grid: nine places.
      let h = `<div class="sdk-notes${st.noteGrid ? '' : ' corner'}">`;
      for (let d = 1; d <= 9; d++) {
        const on = st.notes[i] & S.bit(d);
        if (on || st.noteGrid) h += `<span${on && selV === d ? ' class="same"' : ''}>${on ? d : ''}</span>`;
      }
      el.innerHTML = h + '</div>';
    } else el.textContent = '';
  }
  // the pad: how many of each digit are still to place
  const placed = new Array(10).fill(0);
  for (const v of st.values) placed[v]++;
  p.querySelectorAll('.sdk-key').forEach((b) => {
    const d = +b.dataset.d;
    b.querySelector('i').textContent = placed[d] >= 9 ? '' : String(9 - placed[d]);
    b.classList.toggle('full', placed[d] >= 9);
    b.classList.toggle('cur', selV === d);
  });
  p.querySelector('.sdk-level').textContent = S.LEVELS[st.level].name;
  p.querySelector('.sdk-time').textContent = gameClock(st.elapsed);
  p.querySelector('.sdk-newlevel').value = String(st.level);
  p.querySelector('.sdk-auto').checked = st.autoCheck;
  p.querySelector('.sdk-notegrid').checked = st.noteGrid;
  p.querySelector('.sdk-sound').checked = st.sound;
  sudokuNotePop();
  p.querySelector('[data-s="notes"]').classList.toggle('on', st.noteMode);
  p.querySelector('[data-s="undo"]').disabled = !st.undo.length || st.done;
  p.classList.toggle('sdk-notemode', st.noteMode);
  const banner = p.querySelector('.sdk-banner');
  banner.classList.toggle('hidden', !st.done);
  if (st.done) banner.innerHTML = `<b>Solved in ${gameClock(st.elapsed)}</b><span>${S.LEVELS[st.level].name}</span><button data-s="new">New puzzle</button>`;
}

// The note picker beside its cell. Painted from sudokuRender, so it can never show a state
// the grid does not have; it goes away by itself when its cell is no longer an empty, chosen one.
function sudokuNotePop() {
  const st = sudokuSt;
  const p = st.rec.paneEl;
  const pop = p.querySelector('.sdk-notepop');
  const i = st.notePop;
  if (i == null || i !== st.sel || st.done || st.making || st.puzzle[i] || st.values[i]) {
    st.notePop = null;
    pop.classList.add('hidden');
    return;
  }
  let h = '<div class="sdk-np-title">Notes</div><div class="sdk-np-grid">';
  for (let d = 1; d <= 9; d++) h += `<button data-n="${d}"${st.notes[i] & SudokuEngine.bit(d) ? ' class="on"' : ''}>${d}</button>`;
  h += `</div><div class="sdk-np-foot"><button data-n="0"${st.notes[i] ? '' : ' disabled'} title="Take all notes out of this cell">Clear</button><button data-n="x" title="Close (Esc)">Done</button></div>`;
  pop.innerHTML = h;
  pop.classList.remove('hidden');
  // beside the cell: to its right, or to its left where the board ends; never over the cell itself
  const board = p.querySelector('.sdk-board').getBoundingClientRect();
  const cell = p.querySelectorAll('.sdk-cell')[i].getBoundingClientRect();
  const w = pop.offsetWidth;
  const hh = pop.offsetHeight;
  let left = cell.right - board.left + 6;
  if (left + w > board.width) left = cell.left - board.left - w - 6;
  const top = Math.max(0, Math.min(board.height - hh, cell.top - board.top));
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(top) + 'px';
}

document.getElementById('sudoku-btn')?.addEventListener('click', () => createSudokuTab());
tabKinds.sudoku = { title: 'Sudoku', glyph: '🔢', color: '#7fb7ff', create: createSudokuTab, onShow: sudokuOnShow, onClose: sudokuOnClose, restore: sudokuRestoreSettings };
