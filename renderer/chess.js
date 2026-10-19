// ---- Chess: a 3D board in a tab (three.js) ----
// The rules and the opponent are chess-engine.js; the opponent thinks in chess-worker.js so
// the window never freezes. This file is the tab: the scene (a wooden board, turned pieces -
// all generated here, no model or image files), the mouse, the side panel, and the game's
// place in settings. It is loaded BEFORE renderer.js and only touches renderer globals
// (tabs, createTabChrome, api, ...) inside functions, which run later.
const chessSt = {
  rec: null,
  game: null,
  moves: [], // { uci, san, cap } - cap = the piece code that move took, for the trays
  human: 'w', // 'w' | 'b' | 'both' (two players at one screen)
  level: 3,
  flipped: false,
  sound: true,
  sel: -1,
  targets: [],
  hint: null, // { from, to }
  thinking: false,
  animating: false,
  status: null,
  seq: 0, // bumps on every new position: an answer for an older one is dropped
  saved: null,
  review: null, // looking back: the number of moves shown (null = the game as it stands)
  analysis: null, // { key, running, progress, total } while it runs, then { key, moves, evals }
  analyser: null, // its own worker, so the computer's next move never waits behind it
  cam: { az: 0, pol: 0.6, r: 16 },
  worker: null,
  workerBroken: false,
  pending: new Map(),
  saveTimer: null,
};
let chess3d = null;
// The standard view looks down at about 55 degrees. Flatter looks grander, but then a king
// hides most of the pawn behind it and a pawn's head covers the square behind - you could not
// see, or click, what you wanted.
const CHESS_VIEW = { az: 0, pol: 0.6, r: 16 };
const CHESS_GLYPH = { 1: '♟', 2: '♞', 3: '♝', 4: '♜', 5: '♛', 6: '♚' };
const CHESS_RESULT = {
  checkmate: (w) => 'Checkmate - ' + (w === 0 ? 'White' : 'Black') + ' wins',
  stalemate: () => 'Stalemate - a draw',
  'draw-material': () => 'Draw - not enough pieces to mate',
  'draw-50': () => 'Draw - fifty moves without progress',
  'draw-repetition': () => 'Draw - the same position three times',
};

// Called from the boot restore in renderer.js, before the tabs come back.
function chessRestoreSettings(s) {
  if (!s || typeof s !== 'object') return;
  const out = {};
  if (Array.isArray(s.moves)) {
    // up to the first entry that is not a move: what follows a hole is another game
    out.moves = [];
    for (const m of s.moves.slice(0, 1000)) {
      if (typeof m !== 'string' || !/^[a-h][1-8][a-h][1-8][nbrq]?$/.test(m)) break;
      out.moves.push(m);
    }
  }
  if (['w', 'b', 'both'].includes(s.human)) out.human = s.human;
  if (Number.isInteger(s.level) && s.level >= 1 && s.level <= 5) out.level = s.level;
  if (typeof s.flipped === 'boolean') out.flipped = s.flipped;
  if (typeof s.sound === 'boolean') out.sound = s.sound;
  if (s.cam && [s.cam.az, s.cam.pol, s.cam.r].every(Number.isFinite)) {
    out.cam = { az: s.cam.az % (Math.PI * 2), pol: Math.max(0.12, Math.min(1.38, s.cam.pol)), r: Math.max(9, Math.min(26, s.cam.r)) };
  }
  chessSt.saved = out;
}
function chessSave() {
  // kept in memory at once: closing the tab and opening it again continues THIS game, not the
  // one from the last start of Cockpit
  chessSt.saved = { moves: chessSt.moves.map((m) => m.uci), human: chessSt.human, level: chessSt.level, flipped: chessSt.flipped, sound: chessSt.sound, cam: { ...chessSt.cam } };
  clearTimeout(chessSt.saveTimer);
  chessSt.saveTimer = setTimeout(() => api.saveSettings({ chess: chessSt.saved }), 300);
}

function createChessTab() {
  for (const [tid, r] of tabs) {
    if (r.kind === 'chess') {
      activateTab(tid);
      return tid;
    }
  }
  const id = newTabId();
  const { tabEl, paneEl } = createTabChrome(id, 'Chess', 'chess');
  paneEl.classList.remove('term-pane');
  paneEl.classList.add('chess-pane');
  paneEl.tabIndex = -1;
  const levels = Object.entries(ChessEngine.LEVELS)
    .map(([k, v]) => `<option value="${k}">${v.name}</option>`)
    .join('');
  paneEl.innerHTML =
    '<div class="chess-stage"><canvas class="chess-canvas"></canvas>' +
    '<div class="chess-banner hidden"></div><div class="chess-promo hidden"></div>' +
    '<div class="chess-tip">Click a piece, then a square · drag to turn the board · wheel to zoom</div></div>' +
    '<div class="chess-side">' +
    '<div class="chess-status"></div>' +
    '<div class="chess-row"><select class="chess-as" title="Who plays"><option value="w">You play White</option><option value="b">You play Black</option><option value="both">Two players</option></select>' +
    `<select class="chess-level" title="How strong the computer plays">${levels}</select></div>` +
    '<div class="chess-row chess-btns">' +
    '<button data-c="new" title="New game (n)">New game</button>' +
    '<button data-c="undo" title="Take the last move back (u)">↶ Undo</button>' +
    '<button data-c="hint" title="Show a good move (h)">💡 Hint</button>' +
    '<button data-c="analyse" title="Go through the game: mark the blunders and mistakes, show the better move"></button>' +
    '<button data-c="flip" title="Turn the board round (f)">⇅ Flip</button>' +
    '<button data-c="view" title="Back to the standard view">⟲ View</button>' +
    '<button data-c="sound" title="Sound on / off"></button>' +
    '</div>' +
    '<div class="chess-cap"></div>' +
    '<div class="chess-review hidden"></div>' +
    '<div class="chess-graph hidden"></div>' +
    '<div class="chess-moves"></div>' +
    '</div>';
  const rec = { id, kind: 'chess', paneEl, tabEl, status: 'connected', profile: { name: 'Chess' } };
  tabs.set(id, rec);
  chessSt.rec = rec;
  // the game: the saved one, or a new one
  const s = chessSt.saved || {};
  chessSt.human = s.human || 'w';
  chessSt.level = s.level || 3;
  chessSt.sound = s.sound !== false;
  chessSt.flipped = typeof s.flipped === 'boolean' ? s.flipped : chessSt.human === 'b';
  if (s.cam) chessSt.cam = { ...s.cam };
  chessSt.game = new ChessEngine.Chess();
  chessSt.moves = [];
  for (const u of s.moves || []) {
    const m = chessSt.game.findUci(u);
    if (!m) break;
    chessRecord(m);
  }
  chessSt.sel = -1;
  chessSt.targets = [];
  chessSt.hint = null;
  chessSt.thinking = false;
  chessSt.animating = false;
  chessSt.review = null;
  chessSt.analysis = null;
  chessWire(rec);
  activateTab(id);
  bbTabOpen(rec);
  persistTabOrder();
  const stage = paneEl.querySelector('.chess-stage');
  try {
    chess3d = chessBuild3d(stage);
  } catch (err) {
    chess3d = null;
    stage.innerHTML = '<div class="chess-no3d">The 3D board could not start on this computer (no WebGL).<br /><span></span></div>';
    stage.querySelector('span').textContent = String((err && err.message) || err);
  }
  chessSyncPieces();
  chessUpdate();
  chessResize();
  chessMaybeThink();
  return id;
}
// Make a move in the game and write it down. Returns what the animation needs.
function chessRecord(m) {
  const E = ChessEngine;
  const g = chessSt.game;
  const legal = g.legal();
  const san = g.san(m, legal);
  const from = E.mFrom(m);
  const to = E.mTo(m);
  const flag = E.mFlag(m);
  const us = g.turn;
  const capSq = flag === E.F_EP ? to + (us === E.WHITE ? -16 : 16) : to;
  const cap = g.board[capSq];
  g.make(m);
  chessSt.moves.push({ uci: E.uci(m), san, cap });
  return { from, to, flag, capSq, cap, us, promo: E.mPromo(m) };
}
function chessOnShow() {
  if (!chessSt.rec) return;
  chessResize();
  chessRender();
}
function chessOnClose() {
  chessSt.seq++;
  clearTimeout(chessSt.saveTimer);
  if (chessSt.worker) {
    try {
      chessSt.worker.terminate();
    } catch (_) {
      /* gone already */
    }
    chessSt.worker = null;
  }
  chessSt.pending.clear();
  if (chessSt.analyser) {
    try {
      chessSt.analyser.terminate();
    } catch (_) {
      /* gone already */
    }
    chessSt.analyser = null;
  }
  chessSt.analysis = null;
  chessSt.review = null;
  if (chess3d) {
    cancelAnimationFrame(chess3d.raf);
    if (chess3d.ro) chess3d.ro.disconnect();
    try {
      chess3d.renderer.dispose();
      chess3d.renderer.forceContextLoss();
    } catch (_) {
      /* the context is gone with the canvas anyway */
    }
    chess3d = null;
  }
  chessSt.rec = null;
}

// ---- the side panel, the buttons, the keys ----
function chessWire(rec) {
  const p = rec.paneEl;
  gameKeepFocus(p); // the review panel is redrawn on every click in it
  p.querySelector('.chess-side').addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    const c = b.dataset.c;
    if (c === 'new') chessNew();
    else if (c === 'undo') chessUndo();
    else if (c === 'hint') chessHint();
    else if (c === 'analyse') chessAnalyse();
    else if (c === 'flip') chessFlip();
    else if (c === 'view') chessResetView();
    else if (c === 'sound') {
      chessSt.sound = !chessSt.sound;
      chessSave();
      chessUpdate();
    }
  });
  // a move in the list, the arrows of the review bar, a point of the graph: look at that moment
  p.querySelector('.chess-moves').addEventListener('click', (e) => {
    const m = e.target.closest('[data-ply]');
    if (m) chessReview(+m.dataset.ply + 1);
  });
  p.querySelector('.chess-review').addEventListener('click', (e) => {
    const b = e.target.closest('[data-r]');
    if (!b) return;
    const n = chessSt.moves.length;
    const k = chessSt.review == null ? n : chessSt.review;
    const r = b.dataset.r;
    if (r === 'exit') chessReview(null);
    else if (r === 'first') chessReview(0);
    else if (r === 'prev') chessReview(k - 1);
    else if (r === 'next') chessReview(k + 1);
    else if (r === 'worst') chessReview(+b.dataset.k);
  });
  p.querySelector('.chess-graph').addEventListener('click', (e) => {
    const svg = e.target.closest('svg');
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    chessReview(Math.round(((e.clientX - r.left) / r.width) * chessSt.moves.length));
  });
  p.querySelector('.chess-as').addEventListener('change', (e) => {
    chessSt.human = e.target.value;
    chessSt.seq++;
    chessSt.thinking = false;
    chessSave();
    chessUpdate();
    chessMaybeThink(); // the computer takes over the other side at once
  });
  p.querySelector('.chess-level').addEventListener('change', (e) => {
    chessSt.level = parseInt(e.target.value, 10) || 3;
    chessSave();
  });
  p.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'SELECT' || t.tagName === 'INPUT')) return;
    const k = e.key.toLowerCase();
    const n = chessSt.moves.length;
    const at = chessSt.review == null ? n : chessSt.review;
    if (k === 'arrowleft') chessReview(at - 1);
    else if (k === 'arrowright') chessReview(at + 1);
    else if (k === 'home') chessReview(0);
    else if (k === 'end') chessReview(null);
    else if (k === 'escape' && chessSt.review != null) chessReview(null);
    else if (k === 'u') chessUndo();
    else if (k === 'f') chessFlip();
    else if (k === 'h') chessHint();
    else if (k === 'n') chessNew();
    else if (k === 'escape') chessSelect(-1);
    else return;
    e.preventDefault();
  });
  p.querySelector('.chess-banner').addEventListener('click', (e) => {
    if (e.target.closest('[data-c="new"]')) chessNew(true);
  });
}
function chessHumanTurn() {
  if (chessSt.human === 'both') return true;
  return chessSt.game.turn === (chessSt.human === 'w' ? ChessEngine.WHITE : ChessEngine.BLACK);
}
// One painter for everything that is not the 3D scene.
function chessUpdate() {
  const rec = chessSt.rec;
  if (!rec) return;
  const E = ChessEngine;
  const g = chessSt.game;
  const p = rec.paneEl;
  const st = (chessSt.status = g.status());
  const side = g.turn === E.WHITE ? 'White' : 'Black';
  // an analysis belongs to the game it was made of: one more move, and it is of another game
  const gameKey = chessSt.moves.map((m) => m.uci).join(' ');
  if (chessSt.analysis && chessSt.analysis.key !== gameKey) chessAnalyseStop(true);
  if (chessSt.review != null && chessSt.review >= chessSt.moves.length) chessSt.review = null;
  const an = chessSt.analysis && chessSt.analysis.moves ? chessSt.analysis : null;
  const rv = chessSt.review;
  let text;
  if (rv != null) text = 'Looking back: move ' + rv + ' of ' + chessSt.moves.length;
  else if (st.over) text = CHESS_RESULT[st.result](st.winner);
  else if (chessSt.thinking && !chessHumanTurn()) text = side + ' is thinking…';
  else text = side + ' to move' + (st.check ? ' - check!' : '');
  const statusEl = p.querySelector('.chess-status');
  statusEl.textContent = text;
  statusEl.classList.toggle('over', st.over && rv == null);
  statusEl.classList.toggle('check', !st.over && st.check && rv == null);
  const anBtn = p.querySelector('[data-c="analyse"]');
  const running = !!(chessSt.analysis && chessSt.analysis.running);
  anBtn.textContent = running ? '⏹ ' + chessSt.analysis.progress + ' / ' + chessSt.analysis.total : an ? '🔍 Analysed' : '🔍 Analyse';
  anBtn.disabled = !running && (chessSt.moves.length < 2 || !!an);
  anBtn.classList.toggle('on', running);
  p.querySelector('.chess-as').value = chessSt.human;
  p.querySelector('.chess-level').value = String(chessSt.level);
  p.querySelector('.chess-level').disabled = chessSt.human === 'both';
  p.querySelector('[data-c="sound"]').textContent = chessSt.sound ? '🔊' : '🔇';
  p.querySelector('[data-c="undo"]').disabled = !chessSt.moves.length;
  p.querySelector('[data-c="hint"]').disabled = st.over || !chessHumanTurn() || chessSt.thinking;
  // what was taken, and who is ahead
  const val = [0, 1, 3, 3, 5, 9, 0];
  const took = [[], []]; // took[colour] = the pieces that colour captured
  for (const m of chessSt.moves) if (m.cap) took[(m.cap >> 3) ^ 1].push(m.cap & 7);
  let lead = 0;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) continue;
    const pc = g.board[sq];
    if (pc) lead += (pc >> 3 === E.WHITE ? 1 : -1) * val[pc & 7];
  }
  const row = (c) =>
    `<div class="chess-capr"><span class="chess-capn">${c === E.WHITE ? 'White' : 'Black'}</span><span class="chess-capp ${c === E.WHITE ? 'tw' : 'tb'}">${took[c]
      .sort((a, b) => b - a)
      .map((t) => CHESS_GLYPH[t])
      .join('')}</span>${(c === E.WHITE ? lead : -lead) > 0 ? `<span class="chess-lead">+${Math.abs(lead)}</span>` : ''}</div>`;
  p.querySelector('.chess-cap').innerHTML = row(E.WHITE) + row(E.BLACK);
  // the moves, in pairs
  const mv = p.querySelector('.chess-moves');
  let html = '';
  const cur = rv != null ? rv - 1 : chessSt.moves.length - 1;
  const one = (i) => {
    const m = chessSt.moves[i];
    if (!m) return '<span class="chess-mvs"></span>';
    const tag = an && an.moves[i] ? an.moves[i].tag : '';
    return `<span class="chess-mvs${i === cur ? ' cur' : ''}${CHESS_TAG[tag] ? ' tag-' + tag : ''}" data-ply="${i}" title="Look at this move">${escapeHtml(m.san)}${CHESS_TAG[tag] ? CHESS_TAG[tag].mark : ''}</span>`;
  };
  for (let i = 0; i < chessSt.moves.length; i += 2) html += `<div class="chess-mv"><span class="chess-mvn">${i / 2 + 1}.</span>${one(i)}${one(i + 1)}</div>`;
  mv.innerHTML = html || '<div class="chess-mvnone">No moves yet.</div>';
  const curEl = mv.querySelector('.chess-mvs.cur');
  if (rv != null && curEl) curEl.scrollIntoView({ block: 'nearest' });
  else mv.scrollTop = mv.scrollHeight;
  chessReviewPaint(p, an, rv);
  const banner = p.querySelector('.chess-banner');
  banner.classList.toggle('hidden', !st.over || rv != null);
  if (st.over) banner.innerHTML = `<b>${escapeHtml(text)}</b><button data-c="new">New game</button>`;
  chessMarks();
}

// ---- looking back, and the analysis ----
const CHESS_TAG = {
  inaccuracy: { mark: '?!', word: 'an inaccuracy' },
  mistake: { mark: '?', word: 'a mistake' },
  blunder: { mark: '??', word: 'a blunder' },
};
// What the board shows: the game as it stands, or (looking back) as it stood after k moves.
function chessView() {
  const st = chessSt;
  if (st.review == null) return { game: st.game, moves: st.moves, live: true };
  const moves = st.moves.slice(0, st.review);
  return { game: ChessEngine.replay(ChessEngine.START_FEN, moves.map((m) => m.uci)), moves, live: false };
}
// k = how many moves to show; null (or past the end) = back to the game itself.
function chessReview(k) {
  const st = chessSt;
  if (st.animating) return;
  const n = st.moves.length;
  if (k != null) k = Math.max(0, Math.min(n, k));
  st.review = k == null || k >= n ? null : k;
  st.sel = -1;
  st.targets = [];
  st.hint = null;
  chessSyncPieces();
  chessUpdate();
}
function chessMoveLabel(ply, san) {
  return Math.floor(ply / 2) + 1 + (ply % 2 ? '… ' : '. ') + san;
}
// The bar under the taken pieces: the arrows and what the analysis says about the move shown;
// with nothing shown, the summary of the whole game. And the curve of who stood better.
function chessReviewPaint(p, an, rv) {
  const st = chessSt;
  const box = p.querySelector('.chess-review');
  const graph = p.querySelector('.chess-graph');
  const n = st.moves.length;
  let html = '';
  if (rv != null) {
    html +=
      '<div class="chess-rvnav"><button data-r="first" title="To the start (Home)">⏮</button><button data-r="prev" title="One move back (←)">◀</button>' +
      '<button data-r="next" title="One move on (→)">▶</button><button data-r="exit" class="chess-rvexit" title="Back to the game (Esc or End)">Back to the game</button></div>';
    const m = rv > 0 ? st.moves[rv - 1] : null;
    const a = an && rv > 0 ? an.moves[rv - 1] : null;
    if (!m) html += '<div class="chess-rvtext">The starting position.</div>';
    else if (!a) html += `<div class="chess-rvtext"><b>${escapeHtml(chessMoveLabel(rv - 1, m.san))}</b></div>`;
    else {
      const T = CHESS_TAG[a.tag];
      const cost = a.why === 'allows-mate' ? 'it allows mate' : a.why === 'misses-mate' ? 'it misses a forced mate' : 'it gives away about ' + (a.loss / 100).toFixed(1) + ' pawns';
      const what = a.tag === 'best' ? 'the best move' : T ? T.word + ' - ' + cost : 'a good move';
      html +=
        `<div class="chess-rvtext${T ? ' tag-' + a.tag : ''}"><b>${escapeHtml(chessMoveLabel(rv - 1, m.san))}${T ? T.mark : ''}</b> ${what}.` +
        (T && a.bestSan ? ` Better: <b>${escapeHtml(a.bestSan)}</b> (in blue).` : '') +
        '</div>';
    }
  } else if (an) {
    const sum = (c) => {
      const mine = an.moves.filter((m) => m.mover === c);
      const cnt = (tag) => mine.filter((m) => m.tag === tag).length;
      const part = (tag, one, many) => (cnt(tag) ? cnt(tag) + ' ' + (cnt(tag) === 1 ? one : many) : '');
      return [part('blunder', 'blunder', 'blunders'), part('mistake', 'mistake', 'mistakes'), part('inaccuracy', 'inaccuracy', 'inaccuracies')].filter(Boolean).join(', ') || 'no mistakes';
    };
    let worst = -1;
    an.moves.forEach((m, i) => {
      if (CHESS_TAG[m.tag] && (worst === -1 || m.loss > an.moves[worst].loss)) worst = i;
    });
    html +=
      `<div class="chess-rvtext"><b>White:</b> ${sum(ChessEngine.WHITE)}<br /><b>Black:</b> ${sum(ChessEngine.BLACK)}</div>` +
      (worst >= 0
        ? `<div class="chess-rvnav"><button data-r="worst" data-k="${worst + 1}" title="Show it on the board">The biggest slip: ${escapeHtml(chessMoveLabel(worst, st.moves[worst].san))}${CHESS_TAG[an.moves[worst].tag].mark}</button></div>`
        : '') +
      '<div class="chess-rvhint">Click a move (or ← →) to look at it.</div>';
  } else if (st.analysis && st.analysis.running) {
    html += `<div class="chess-rvtext">Going through the game… position ${st.analysis.progress} of ${st.analysis.total}.</div>`;
  }
  box.innerHTML = html;
  box.classList.toggle('hidden', !html);
  // the curve: White's advantage after every move, up = good for White
  if (an && an.evals.length > 1) {
    const W = 226;
    const H = 44;
    const y = (e) => H / 2 - (Math.max(-800, Math.min(800, e)) / 800) * (H / 2 - 3);
    const x = (i) => (i / (an.evals.length - 1)) * W;
    const pts = an.evals.map((e, i) => x(i).toFixed(1) + ',' + y(e).toFixed(1)).join(' ');
    const dots = an.moves
      .map((m, i) => (CHESS_TAG[m.tag] ? `<circle cx="${x(i + 1).toFixed(1)}" cy="${y(an.evals[i + 1]).toFixed(1)}" r="${m.tag === 'blunder' ? 3 : 2.2}" class="tag-${m.tag}" />` : ''))
      .join('');
    const at = rv != null ? rv : n;
    graph.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" title="Who stood better, move by move"><rect width="${W}" height="${H / 2}" class="g-white" /><rect y="${H / 2}" width="${W}" height="${H / 2}" class="g-black" />` +
      `<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" class="g-zero" /><polyline points="${pts}" class="g-line" />${dots}` +
      `<line x1="${x(at).toFixed(1)}" y1="0" x2="${x(at).toFixed(1)}" y2="${H}" class="g-now" /></svg>`;
    graph.classList.remove('hidden');
  } else {
    graph.innerHTML = '';
    graph.classList.add('hidden');
  }
}
// Go through the whole game in a worker of its own. A second press stops it.
function chessAnalyse() {
  const st = chessSt;
  if (st.analysis && st.analysis.running) return chessAnalyseStop();
  if (st.moves.length < 2 || (st.analysis && st.analysis.moves)) return;
  const E = ChessEngine;
  const ucis = st.moves.map((m) => m.uci);
  const key = ucis.join(' ');
  const opts = { ms: 300, depth: 5 };
  st.analysis = { key, running: true, progress: 0, total: ucis.length + 1 };
  chessUpdate();
  const mine = () => st.rec && st.analysis && st.analysis.key === key && st.analysis.running;
  const progress = (i, total) => {
    if (!mine()) return;
    st.analysis.progress = i;
    st.analysis.total = total;
    chessUpdate();
  };
  const finish = (res) => {
    if (!mine()) return;
    st.analysis = res ? { key, running: false, moves: res.moves, evals: res.evals } : null;
    chessUpdate();
  };
  // without a worker: one position per turn of the event loop, so the window stays alive
  const local = () => {
    const a = new E.Analysis(E.START_FEN, ucis, opts);
    const loop = () => {
      if (!mine()) return;
      const done = a.step();
      progress(a.i, a.total);
      if (done) finish(a.result());
      else setTimeout(loop, 0);
    };
    setTimeout(loop, 0);
  };
  if (st.workerBroken) return local();
  try {
    const w = new Worker('chess-worker.js');
    st.analyser = w;
    const end = () => {
      try {
        w.terminate();
      } catch (_) {
        /* gone already */
      }
      if (st.analyser === w) st.analyser = null;
    };
    w.onmessage = (e) => {
      const d = e.data || {};
      if (d.analysis) {
        end();
        finish(d.analysis);
      } else if (d.error) {
        end();
        finish(null);
      } else progress(d.progress, d.total);
    };
    w.onerror = () => {
      end();
      st.workerBroken = true;
      if (mine()) local();
    };
    w.postMessage({ id: 'analysis', type: 'analyse', fen: E.START_FEN, moves: ucis, ms: opts.ms, depth: opts.depth });
  } catch (_) {
    local();
  }
}
// quiet: called from the painter itself (the game moved on) - it must not paint again
function chessAnalyseStop(quiet) {
  const st = chessSt;
  if (st.analyser) {
    try {
      st.analyser.terminate();
    } catch (_) {
      /* gone already */
    }
    st.analyser = null;
  }
  st.analysis = null;
  if (!quiet) chessUpdate();
}

// ---- playing ----
function chessSelect(sq) {
  const g = chessSt.game;
  chessSt.sel = sq;
  chessSt.targets = sq < 0 ? [] : g.legal().filter((m) => ChessEngine.mFrom(m) === sq);
  if (chess3d) {
    for (const [s, grp] of chess3d.pieces) grp.position.y = s === sq ? 0.28 : 0;
  }
  chessMarks();
}
// sq: what was clicked (the piece in front, if one is). ground: the board square on that line
// of sight - with a piece chosen, a click that lands on a piece standing in front of a marked
// square still means that square.
function chessClickSquare(sq, ground) {
  const E = ChessEngine;
  const g = chessSt.game;
  if (chessSt.review != null) return; // looking back: the board is a picture, not the game
  if (chessSt.animating || chessSt.thinking || (chessSt.status && chessSt.status.over) || !chessHumanTurn()) return;
  if (chessSt.sel >= 0) {
    let hits = chessSt.targets.filter((m) => E.mTo(m) === sq);
    // (not when the thing in front is one of your own pieces: that click picks it up instead)
    const own = g.board[sq] && g.board[sq] >> 3 === g.turn;
    if (!hits.length && !own && Number.isInteger(ground) && ground >= 0 && ground !== sq) hits = chessSt.targets.filter((m) => E.mTo(m) === ground);
    if (hits.length === 1) return chessPlay(hits[0]);
    if (hits.length > 1) return chessAskPromotion(hits); // four ways to promote
  }
  const pc = g.board[sq];
  if (pc && pc >> 3 === g.turn && sq !== chessSt.sel) chessSelect(sq);
  else chessSelect(-1);
}
function chessAskPromotion(moves) {
  const E = ChessEngine;
  const box = chessSt.rec.paneEl.querySelector('.chess-promo');
  const white = chessSt.game.turn === E.WHITE;
  const glyph = white ? { 5: '♕', 4: '♖', 3: '♗', 2: '♘' } : { 5: '♛', 4: '♜', 3: '♝', 2: '♞' };
  box.innerHTML =
    '<span>Promote to</span>' +
    [5, 4, 3, 2].map((t) => `<button data-p="${t}" title="${['', '', 'Knight', 'Bishop', 'Rook', 'Queen'][t]}">${glyph[t]}</button>`).join('') +
    '<button data-p="0" class="chess-promo-x" title="Cancel">✕</button>';
  box.classList.remove('hidden');
  box.onclick = (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    box.classList.add('hidden');
    const t = +b.dataset.p;
    const m = moves.find((x) => E.mPromo(x) === t);
    if (m) chessPlay(m);
    else chessSelect(-1);
  };
}
function chessPlay(m) {
  const g = chessSt.game;
  if (!g.legal().includes(m)) return;
  chessSt.seq++;
  if (chessSt.review != null) {
    // the computer answers while you look back: return to the game first, or its piece would
    // move on a board that shows another moment
    chessSt.review = null;
    chessSyncPieces();
  }
  const info = chessRecord(m);
  chessSt.sel = -1;
  chessSt.targets = [];
  chessSt.hint = null;
  chessSt.animating = true;
  chessUpdate();
  chessAnimate(info, () => {
    chessSt.animating = false;
    chessSyncPieces();
    chessUpdate();
    chessSound(chessSt.status.over ? 'end' : chessSt.status.check ? 'check' : info.cap ? 'capture' : 'move');
    chessSave();
    chessMaybeThink();
  });
}
function chessNew(force) {
  if (!force && chessSt.moves.length && !(chessSt.status && chessSt.status.over) && !window.confirm('Start a new game? This one will be lost.')) return;
  chessSt.seq++;
  chessSt.thinking = false;
  chessSt.animating = false;
  chessSt.review = null;
  chessSt.game = new ChessEngine.Chess();
  chessSt.moves = [];
  chessSt.sel = -1;
  chessSt.targets = [];
  chessSt.hint = null;
  const flip = chessSt.human === 'b';
  if (flip !== chessSt.flipped) chessFlip();
  chessSyncPieces();
  chessUpdate();
  chessSave();
  chessMaybeThink();
}
function chessUndo() {
  if (chessSt.animating || !chessSt.moves.length) return;
  chessSt.seq++;
  chessSt.thinking = false;
  chessSt.hint = null;
  chessSt.review = null;
  // against the computer: back to YOUR last move (its answer goes too)
  let n = chessSt.human === 'both' ? 1 : chessHumanTurn() ? 2 : 1;
  n = Math.min(n, chessSt.moves.length);
  for (let i = 0; i < n; i++) {
    chessSt.game.undo();
    chessSt.moves.pop();
  }
  chessSt.sel = -1;
  chessSt.targets = [];
  chessSyncPieces();
  chessUpdate();
  chessSave();
  chessMaybeThink();
}
function chessMaybeThink() {
  if (!chessSt.rec || chessSt.human === 'both' || chessHumanTurn()) return;
  if (chessSt.game.status().over) return;
  chessThink(false);
}
// Ask the engine for a move: the computer's own, or a hint for you.
function chessThink(forHint) {
  const E = ChessEngine;
  const seq = ++chessSt.seq;
  chessSt.thinking = true;
  chessUpdate();
  const t0 = Date.now();
  const level = forHint ? Math.max(3, chessSt.level) : chessSt.level;
  chessAsk({ fen: E.START_FEN, moves: chessSt.moves.map((m) => m.uci), level }).then((r) => {
    if (seq !== chessSt.seq || !chessSt.rec) return; // the position moved on: not wanted any more
    // never answer in a blink - a move that lands the instant yours does is hard to follow
    setTimeout(() => {
      if (seq !== chessSt.seq || !chessSt.rec) return;
      chessSt.thinking = false;
      const m = r && r.uci ? chessSt.game.findUci(r.uci) : 0;
      if (!m) return chessUpdate();
      if (forHint) {
        chessSt.hint = { from: E.mFrom(m), to: E.mTo(m) };
        chessUpdate();
      } else chessPlay(m);
    }, Math.max(0, (forHint ? 0 : 450) - (Date.now() - t0)));
  });
}
function chessHint() {
  if (chessSt.review != null) return;
  if (chessSt.thinking || chessSt.animating || !chessHumanTurn() || (chessSt.status && chessSt.status.over)) return;
  chessThink(true);
}
// The worker, or - where a worker cannot start - the same search on this thread.
function chessAsk(req) {
  return new Promise((resolve) => {
    const local = () =>
      setTimeout(() => {
        try {
          const E = ChessEngine;
          const g = E.replay(req.fen, req.moves);
          const r = E.bestMove(g, req.level, { uciHistory: req.moves });
          resolve(r ? { uci: E.uci(r.move), score: r.score, depth: r.depth, book: r.book } : null);
        } catch (_) {
          resolve(null);
        }
      }, 30);
    if (chessSt.workerBroken) return local();
    try {
      if (!chessSt.worker) {
        const w = new Worker('chess-worker.js');
        w.onmessage = (e) => {
          const d = e.data || {};
          const cb = chessSt.pending.get(d.id);
          if (!cb) return;
          chessSt.pending.delete(d.id);
          cb(d.error ? null : d);
        };
        w.onerror = () => {
          // it could not load: finish what is waiting here, and stay here from now on
          chessSt.workerBroken = true;
          chessSt.worker = null;
          const waiting = [...chessSt.pending.values()];
          chessSt.pending.clear();
          waiting.forEach((cb) => cb('retry'));
        };
        chessSt.worker = w;
      }
      const id = 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      chessSt.pending.set(id, (d) => (d === 'retry' ? local() : resolve(d)));
      chessSt.worker.postMessage({ id, fen: req.fen, moves: req.moves, level: req.level });
    } catch (_) {
      chessSt.workerBroken = true;
      local();
    }
  });
}

function chessSound(kind) {
  if (chessSt.sound) gameSound(kind); // games.js
}

// ---- the scene ----
const chessRng = gameRng; // games.js
// Wood, drawn: a base colour, broad bands of tone, a few hundred wavy grain lines, pores.
// The waves use whole periods across the width, so the texture tiles along the grain.
function chessWood(o) {
  const w = o.w || 512;
  const h = o.h || 512;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const rnd = chessRng(o.seed || 1);
  const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
  g.fillStyle = o.base;
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 16; i++) {
    g.fillStyle = rgba(i % 2 ? o.grain : o.light || o.base, 0.05 + rnd() * 0.09);
    g.fillRect(0, rnd() * h, w, 14 + rnd() * 70);
  }
  for (let i = 0; i < (o.lines || 240); i++) {
    const y0 = rnd() * h;
    const amp = 1 + rnd() * 5;
    const k1 = 1 + Math.floor(rnd() * 3);
    const k2 = 2 + Math.floor(rnd() * 5);
    const p1 = rnd() * 6.283;
    const p2 = rnd() * 6.283;
    g.strokeStyle = rgba(o.grain, (o.alpha || 0.05) + rnd() * (o.alpha2 || 0.16));
    g.lineWidth = 0.6 + rnd() * 1.7;
    g.beginPath();
    for (let x = 0; x <= w; x += 6) {
      const y = y0 + Math.sin((x / w) * 6.283 * k1 + p1) * amp + Math.sin((x / w) * 6.283 * k2 + p2) * amp * 0.35;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  for (let i = 0; i < (o.pores || 1500); i++) {
    g.fillStyle = rgba(o.grain, 0.05 + rnd() * 0.12);
    g.fillRect(rnd() * w, rnd() * h, 3 + rnd() * 11, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.encoding = THREE.sRGBEncoding;
  tex.anisotropy = 8;
  return tex;
}
function chessLabelStrip(chars, vertical) {
  const c = document.createElement('canvas');
  c.width = vertical ? 64 : 1024;
  c.height = vertical ? 1024 : 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(232, 204, 150, 0.9)';
  g.font = '600 38px Georgia, "Times New Roman", serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  chars.forEach((ch, i) => {
    if (vertical) g.fillText(ch, 32, 64 + i * 128);
    else g.fillText(ch, 64 + i * 128, 34);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  tex.anisotropy = 8;
  return tex;
}
const chessSqPos = (sq) => ({ x: (sq & 7) - 3.5, z: 3.5 - (sq >> 4) });

// The pieces, turned on a lathe: each is a profile (radius, height) spun round its axis,
// plus the few parts no lathe makes - battlements, the bishop's cut, a crown, a cross, and the
// knight's head (a silhouette, extruded and rounded).
function chessPieceParts(type) {
  const V = (pts) => pts.map(([x, y]) => new THREE.Vector2(x, y));
  const arc = (cy, rx, ry, a0, a1, n) => {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      out.push([Math.max(0, rx * Math.cos(a)), cy + ry * Math.sin(a)]);
    }
    return out;
  };
  const lathe = (pts) => new THREE.LatheGeometry(V(pts), 48);
  const foot = (r) => [
    [0, 0],
    [r, 0],
    [r + 0.02, 0.05],
    [r - 0.01, 0.1],
    [r - 0.09, 0.15],
  ];
  const parts = [];
  if (type === 1) {
    parts.push({ geo: lathe([...foot(0.29), [0.15, 0.24], [0.115, 0.38], [0.105, 0.45], [0.19, 0.48], [0.19, 0.51], [0.105, 0.54], ...arc(0.66, 0.155, 0.155, -0.9, Math.PI / 2, 14)]) });
  } else if (type === 4) {
    parts.push({ geo: lathe([...foot(0.34), [0.225, 0.3], [0.21, 0.58], [0.25, 0.63], [0.3, 0.66], [0.3, 0.8], [0.215, 0.8], [0.215, 0.73], [0, 0.73]]) });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      parts.push({ geo: new THREE.BoxGeometry(0.085, 0.09, 0.13), pos: [Math.cos(a) * 0.2575, 0.845, Math.sin(a) * 0.2575], rotY: -a });
    }
  } else if (type === 3) {
    parts.push({ geo: lathe([...foot(0.33), [0.155, 0.3], [0.115, 0.52], [0.1, 0.6], [0.205, 0.63], [0.205, 0.67], [0.1, 0.7], ...arc(0.9, 0.165, 0.23, -1.05, Math.PI / 2, 16)]) });
    parts.push({ geo: new THREE.SphereGeometry(0.05, 16, 12), pos: [0, 1.165, 0] });
    parts.push({ geo: new THREE.BoxGeometry(0.03, 0.2, 0.36), pos: [0.085, 1.0, 0], rotZ: -0.6, dark: true }); // the cut in the mitre
  } else if (type === 5) {
    parts.push({ geo: lathe([...foot(0.36), [0.175, 0.34], [0.125, 0.64], [0.11, 0.76], [0.225, 0.79], [0.225, 0.83], [0.12, 0.86], [0.14, 0.94], [0.25, 1.08], [0.27, 1.13], [0.2, 1.12], [0.16, 1.06], [0, 1.06]]) });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      parts.push({ geo: new THREE.SphereGeometry(0.048, 12, 10), pos: [Math.cos(a) * 0.25, 1.15, Math.sin(a) * 0.25] });
    }
    parts.push({ geo: new THREE.SphereGeometry(0.15, 20, 14), pos: [0, 1.08, 0] });
    parts.push({ geo: new THREE.SphereGeometry(0.055, 14, 10), pos: [0, 1.26, 0] });
  } else if (type === 6) {
    parts.push({ geo: lathe([...foot(0.37), [0.185, 0.36], [0.135, 0.72], [0.12, 0.84], [0.235, 0.87], [0.235, 0.91], [0.13, 0.94], [0.15, 1.02], [0.245, 1.18], [0.255, 1.23], [0.18, 1.26], [0.09, 1.28], [0, 1.285]]) });
    parts.push({ geo: new THREE.BoxGeometry(0.075, 0.27, 0.075), pos: [0, 1.4, 0] });
    parts.push({ geo: new THREE.BoxGeometry(0.21, 0.07, 0.075), pos: [0, 1.43, 0] });
  } else if (type === 2) {
    parts.push({ geo: lathe([...foot(0.34), [0.25, 0.2], [0.27, 0.25], [0.2, 0.3], [0, 0.3]]) });
    const s = new THREE.Shape();
    s.moveTo(-0.2, 0.27);
    s.lineTo(0.19, 0.27);
    s.bezierCurveTo(0.3, 0.33, 0.27, 0.5, 0.13, 0.6); // the chest, in to the throat
    s.quadraticCurveTo(0.2, 0.6, 0.31, 0.535); // under the jaw
    s.quadraticCurveTo(0.4, 0.5, 0.42, 0.58); // the lips
    s.quadraticCurveTo(0.44, 0.66, 0.38, 0.72); // the nose
    s.quadraticCurveTo(0.3, 0.84, 0.21, 0.92); // up the face to the brow
    s.lineTo(0.2, 1.08); // an ear, pricked
    s.lineTo(0.1, 0.97);
    s.bezierCurveTo(-0.08, 0.98, -0.25, 0.86, -0.27, 0.62); // the arch of the neck
    s.bezierCurveTo(-0.28, 0.46, -0.24, 0.36, -0.2, 0.27);
    // a small bevel keeps the outline crisp; the faces round off enough not to look sawn out
    const head = new THREE.ExtrudeGeometry(s, { depth: 0.15, bevelEnabled: true, bevelThickness: 0.045, bevelSize: 0.022, bevelSegments: 5, curveSegments: 24, steps: 1 });
    head.translate(0, 0, -0.075);
    parts.push({ geo: head });
    // a mane ridge down the back of the neck, eyes, nostrils
    const mane = new THREE.TorusGeometry(0.31, 0.022, 8, 20, 1.5);
    parts.push({ geo: mane, pos: [0.04, 0.66, 0], rotZ: 1.95 });
    for (const z of [-0.121, 0.121]) {
      parts.push({ geo: new THREE.SphereGeometry(0.024, 10, 8), pos: [0.245, 0.8, z], dark: true });
      parts.push({ geo: new THREE.SphereGeometry(0.014, 8, 6), pos: [0.385, 0.62, z * 0.92], dark: true });
    }
  }
  return parts;
}
function chessMakePiece(code) {
  const t = code & 7;
  const white = code >> 3 === ChessEngine.WHITE;
  const grp = new THREE.Group();
  const parts = chess3d.parts[t] || (chess3d.parts[t] = chessPieceParts(t));
  for (const p of parts) {
    const mesh = new THREE.Mesh(p.geo, p.dark ? chess3d.mat.cut : white ? chess3d.mat.white : chess3d.mat.black);
    if (p.pos) mesh.position.set(p.pos[0], p.pos[1], p.pos[2]);
    if (p.rotY) mesh.rotation.y = p.rotY;
    if (p.rotZ) mesh.rotation.z = p.rotZ;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    grp.add(mesh);
  }
  // Knights stand almost in profile, turned a little towards the other side: seen edge-on
  // (facing straight ahead) a horse's head is only a slab.
  if (t === 2) grp.rotation.y = white ? 0.55 : 0.55 + Math.PI;
  grp.userData = { code, sq: -1 };
  return grp;
}
function chessBuild3d(stage) {
  const canvas = stage.querySelector('.chess-canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.86; // ACES in three brightens by 1/0.6: 1.0 washed the boxwood out
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  {
    // a dark room, a little lighter behind the board
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(128, 118, 10, 128, 128, 190);
    grad.addColorStop(0, '#2b2f35');
    grad.addColorStop(1, '#101214');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const bg = new THREE.CanvasTexture(c);
    bg.encoding = THREE.sRGBEncoding;
    scene.background = bg;
  }
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 120);

  // Something for the lacquer to reflect: a dim room with three soft lights, blurred.
  {
    const env = new THREE.Scene();
    env.add(new THREE.Mesh(new THREE.SphereGeometry(60, 16, 12), new THREE.MeshBasicMaterial({ color: 0x100e0c, side: THREE.BackSide })));
    const panel = (w, h, color, pos) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      m.position.set(pos[0], pos[1], pos[2]);
      m.lookAt(0, 0, 0);
      env.add(m);
    };
    panel(34, 22, 0x9a9184, [0, 42, 12]);
    panel(22, 22, 0x4f5868, [-42, 12, -12]);
    panel(18, 18, 0x77634a, [36, 9, 22]);
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(env, 0.03).texture;
    pm.dispose();
  }
  scene.add(new THREE.HemisphereLight(0xfff2e0, 0x2c241c, 0.3));
  const key = new THREE.DirectionalLight(0xfff0dd, 1.2);
  key.position.set(-6, 13, 7);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -9;
  key.shadow.camera.right = 9;
  key.shadow.camera.top = 9;
  key.shadow.camera.bottom = -9;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 40;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 4;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.2);
  fill.position.set(8, 6, -7);
  scene.add(fill);

  // the table
  const table = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), new THREE.ShadowMaterial({ opacity: 0.45 }));
  table.rotation.x = -Math.PI / 2;
  table.position.y = -0.63;
  table.receiveShadow = true;
  scene.add(table);

  // the board: a walnut frame, a maple line, and 64 squares cut from two planks
  const maple = chessWood({ base: '#e6cc9c', grain: '#b98f55', light: '#f3e2bd', seed: 11, lines: 220 });
  const walnut = chessWood({ base: '#6f4527', grain: '#3a2110', light: '#8a5a36', seed: 23, lines: 260, alpha: 0.08, alpha2: 0.22 });
  const frameTex = chessWood({ base: '#4c2c17', grain: '#24130a', light: '#643c22', seed: 37, lines: 300, alpha: 0.08, alpha2: 0.22 });
  frameTex.repeat.set(2, 2);
  const frameMat = new THREE.MeshStandardMaterial({ map: frameTex, roughness: 0.5, envMapIntensity: 0.7 });
  const frame = new THREE.Mesh(new THREE.BoxGeometry(9.4, 0.5, 9.4), frameMat);
  frame.position.y = -0.25;
  frame.castShadow = true;
  frame.receiveShadow = true;
  scene.add(frame);
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(9.8, 0.13, 9.8), frameMat);
  plinth.position.y = -0.565;
  plinth.castShadow = true;
  plinth.receiveShadow = true;
  scene.add(plinth);
  const flat = (geo, mat, y) => {
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = y;
    m.receiveShadow = true;
    return m;
  };
  scene.add(flat(new THREE.PlaneGeometry(8.18, 8.18), new THREE.MeshStandardMaterial({ color: 0xe9d3a6, roughness: 0.5 }), 0.0015));
  const sqMat = [
    new THREE.MeshStandardMaterial({ map: walnut, roughness: 0.46, envMapIntensity: 0.75 }), // dark squares
    new THREE.MeshStandardMaterial({ map: maple, roughness: 0.42, envMapIntensity: 0.75 }), // light squares
  ];
  const rnd = chessRng(5);
  const squares = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const geo = new THREE.PlaneGeometry(1, 1);
      // each square takes its own piece of the plank, so no two look alike
      const uv = geo.attributes.uv;
      const ox = rnd();
      const oy = rnd();
      for (let i = 0; i < uv.count; i++) uv.setXY(i, ox + uv.getX(i) * 0.34, oy + uv.getY(i) * 0.34);
      const sq = r * 16 + f;
      const m = flat(geo, sqMat[(r + f) & 1], 0.003);
      const p = chessSqPos(sq);
      m.position.x = p.x;
      m.position.z = p.z;
      m.userData = { sq };
      scene.add(m);
      squares.push(m);
    }
  }
  // a..h and 1..8 on the frame, readable from both sides
  const labelMat = (tex) => new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const files = 'abcdefgh'.split('');
  const ranks = '12345678'.split('');
  const near = flat(new THREE.PlaneGeometry(8, 0.5), labelMat(chessLabelStrip(files, false)), 0.004);
  near.position.z = 4.38;
  const far = flat(new THREE.PlaneGeometry(8, 0.5), labelMat(chessLabelStrip(files.slice().reverse(), false)), 0.004);
  far.position.z = -4.38;
  far.rotation.z = Math.PI;
  const left = flat(new THREE.PlaneGeometry(0.5, 8), labelMat(chessLabelStrip(ranks.slice().reverse(), true)), 0.004);
  left.position.x = -4.38;
  const right = flat(new THREE.PlaneGeometry(0.5, 8), labelMat(chessLabelStrip(ranks, true)), 0.004);
  right.position.x = 4.38;
  right.rotation.z = Math.PI;
  scene.add(near, far, left, right);
  const labels = { near, far, left, right };

  // boxwood and ebony, lacquered; one faint grain for both
  const fine = chessWood({ base: '#ffffff', grain: '#7a6a58', light: '#ffffff', seed: 51, lines: 150, alpha: 0.03, alpha2: 0.07, pores: 400 });
  const mat = {
    white: new THREE.MeshPhysicalMaterial({ color: 0xd9c08c, map: fine, roughness: 0.46, clearcoat: 0.45, clearcoatRoughness: 0.32, envMapIntensity: 0.9 }),
    black: new THREE.MeshPhysicalMaterial({ color: 0x25150c, map: fine, roughness: 0.4, clearcoat: 0.65, clearcoatRoughness: 0.25, envMapIntensity: 0.85 }),
    cut: new THREE.MeshStandardMaterial({ color: 0x120c08, roughness: 0.6 }),
  };
  const marks = new THREE.Group();
  scene.add(marks);
  const three = {
    stage,
    canvas,
    renderer,
    scene,
    camera,
    squares,
    pieces: new Map(), // square -> the piece standing on it
    loose: [], // pieces in the trays
    parts: {},
    mat,
    marks,
    labels,
    tweens: [],
    raf: 0,
    flipA: chessSt.flipped ? Math.PI : 0,
    raycaster: new THREE.Raycaster(),
    ro: null,
  };
  // the mouse: a click plays, a drag turns the board, the wheel zooms
  let down = null;
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, az: chessSt.cam.az, pol: chessSt.cam.pol, moved: false, button: e.button };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (_) {
      /* a pointer the browser does not know (a test) */
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    if (!down.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
    down.moved = true;
    chessSt.cam.az = down.az - dx * 0.006;
    chessSt.cam.pol = Math.max(0.12, Math.min(1.38, down.pol - dy * 0.005));
    chessCamApply();
    chessRender();
  });
  const up = (e) => {
    if (!down) return;
    const d = down;
    down = null;
    if (d.moved) return chessSave();
    if (d.button !== 0) return;
    const hit = chessPick(e.clientX, e.clientY);
    if (hit.top >= 0 || hit.ground >= 0) chessClickSquare(hit.top >= 0 ? hit.top : hit.ground, hit.ground);
    else chessSelect(-1);
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', () => (down = null));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey) return;
      e.preventDefault();
      chessSt.cam.r = Math.max(9, Math.min(26, chessSt.cam.r * (e.deltaY > 0 ? 1.08 : 0.926)));
      chessCamApply();
      chessRender();
      chessSave();
    },
    { passive: false }
  );
  three.ro = new ResizeObserver(() => chessResize());
  three.ro.observe(stage);
  return three;
}
function chessCamApply() {
  if (!chess3d) return;
  const c = chessSt.cam;
  const az = c.az + chess3d.flipA;
  // a narrow pane needs the camera further back to keep the whole board in view
  const r = c.r / Math.min(1, Math.max(0.45, (chess3d.aspect || 1.4) / 1.25));
  chess3d.camera.position.set(r * Math.sin(c.pol) * Math.sin(az), r * Math.cos(c.pol), r * Math.sin(c.pol) * Math.cos(az));
  // aim a little in FRONT of the centre: the near half of the board is drawn larger, so the
  // middle of what you see is nearer than the middle of the board (aimed at the centre, the
  // board sat low in the frame with empty room above)
  chess3d.camera.lookAt(Math.sin(az) * 0.75, 0, Math.cos(az) * 0.75);
  // the letters and numbers on the two edges that read the right way up from here
  const fromWhite = chess3d.camera.position.z >= 0;
  chess3d.labels.near.visible = chess3d.labels.left.visible = fromWhite;
  chess3d.labels.far.visible = chess3d.labels.right.visible = !fromWhite;
}
function chessResize() {
  if (!chess3d) return;
  const w = chess3d.stage.clientWidth;
  const h = chess3d.stage.clientHeight;
  if (!w || !h) return; // hidden: nothing to measure (and never save a zero size)
  chess3d.renderer.setSize(w, h, false);
  chess3d.aspect = w / h;
  chess3d.camera.aspect = w / h;
  chess3d.camera.updateProjectionMatrix();
  chessCamApply();
  chessRender();
}
function chessRender() {
  if (!chess3d || chess3d.raf) return;
  chess3d.raf = requestAnimationFrame(chessTick);
}
function chessTick() {
  if (!chess3d) return;
  chess3d.raf = 0;
  const now = performance.now();
  for (const tw of chess3d.tweens.slice()) chessTweenStep(tw, now);
  chess3d.renderer.render(chess3d.scene, chess3d.camera);
  if (chess3d.tweens.length) chessRender();
}
function chessTweenStep(tw, now) {
  if (tw.finished) return;
  const t = Math.min(1, (now - tw.t0) / tw.dur);
  tw.apply(t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  if (t >= 1) {
    tw.finished = true;
    const i = chess3d.tweens.indexOf(tw);
    if (i !== -1) chess3d.tweens.splice(i, 1);
    if (tw.done) tw.done();
  }
}
// A timed change. Frames drive it while the window paints; a timer finishes it regardless,
// so the GAME never waits on a frame that does not come (a hidden or minimised window).
function chessTween(dur, apply, done) {
  if (!chess3d) {
    apply(1);
    if (done) done();
    return;
  }
  const tw = { t0: performance.now(), dur, apply, done, finished: false };
  chess3d.tweens.push(tw);
  chessRender();
  setTimeout(() => {
    if (!chess3d || tw.finished) return;
    chessTweenStep(tw, tw.t0 + tw.dur);
    chessRender();
  }, dur + 60);
}
function chessFlip() {
  chessSt.flipped = !chessSt.flipped;
  chessSave();
  if (!chess3d) return;
  const from = chess3d.flipA;
  const to = chessSt.flipped ? Math.PI : 0;
  chessTween(700, (t) => {
    chess3d.flipA = from + (to - from) * t;
    chessCamApply();
  });
}
function chessResetView() {
  const from = { ...chessSt.cam };
  const to = CHESS_VIEW;
  // the short way round
  let d = (to.az - from.az) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  chessTween(
    500,
    (t) => {
      chessSt.cam.az = from.az + d * t;
      chessSt.cam.pol = from.pol + (to.pol - from.pol) * t;
      chessSt.cam.r = from.r + (to.r - from.r) * t;
      chessCamApply();
    },
    () => {
      chessSt.cam.az = 0;
      chessSave();
    }
  );
}
// What is under the pointer. top: the square of the nearest thing hit (a piece stands in front
// of the squares behind it). ground: the square of the board itself on that line of sight,
// through any piece. -1 for neither.
function chessPick(clientX, clientY) {
  const none = { top: -1, ground: -1 };
  if (!chess3d) return none;
  const r = chess3d.canvas.getBoundingClientRect();
  if (!r.width || !r.height) return none;
  const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  const rc = chess3d.raycaster;
  rc.setFromCamera(ndc, chess3d.camera);
  let top = -1;
  for (const h of rc.intersectObjects([...chess3d.squares, ...chess3d.pieces.values()], true)) {
    let o = h.object;
    while (o && !(o.userData && Number.isInteger(o.userData.sq))) o = o.parent;
    if (o && o.userData.sq >= 0) {
      top = o.userData.sq;
      break;
    }
  }
  let ground = -1;
  const d = rc.ray.direction;
  if (d.y < -1e-6) {
    const k = -rc.ray.origin.y / d.y;
    const f = Math.floor(rc.ray.origin.x + d.x * k + 4);
    const rank = Math.floor(4 - (rc.ray.origin.z + d.z * k));
    if (f >= 0 && f < 8 && rank >= 0 && rank < 8) ground = rank * 16 + f;
  }
  return { top, ground };
}
// Where a square is on screen (client pixels), at height y above it - for the tests, which
// click like a person: on the board for an empty square, on the piece for a taken one.
function chessSquareClient(sq, y) {
  if (!chess3d) return null;
  const p = chessSqPos(sq);
  const v = new THREE.Vector3(p.x, y || 0, p.z).project(chess3d.camera);
  const r = chess3d.canvas.getBoundingClientRect();
  return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
}
function chessTraySlot(color, i) {
  // the pieces a side has taken stand beside the board, at that side's right hand
  const side = color === ChessEngine.WHITE ? 1 : -1;
  return { x: side * (5.55 + Math.floor(i / 8) * 0.66), z: side * (3.3 - (i % 8) * 0.62), y: -0.63 };
}
// Put every piece where the game says it is (after a move has landed, an undo, a new game).
function chessSyncPieces() {
  if (!chess3d) return;
  const E = ChessEngine;
  for (const g of chess3d.pieces.values()) chess3d.scene.remove(g);
  for (const g of chess3d.loose) chess3d.scene.remove(g);
  chess3d.pieces.clear();
  chess3d.loose = [];
  const view = chessView();
  const b = view.game.board;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88 || !b[sq]) continue;
    const g = chessMakePiece(b[sq]);
    const p = chessSqPos(sq);
    g.position.set(p.x, sq === chessSt.sel ? 0.28 : 0, p.z);
    g.userData.sq = sq;
    chess3d.scene.add(g);
    chess3d.pieces.set(sq, g);
  }
  const n = [0, 0];
  for (const m of view.moves) {
    if (!m.cap) continue;
    const taker = (m.cap >> 3) ^ 1;
    const g = chessMakePiece(m.cap);
    const s = chessTraySlot(taker, n[taker]++);
    g.position.set(s.x, s.y, s.z);
    g.scale.setScalar(0.82);
    chess3d.scene.add(g);
    chess3d.loose.push(g);
  }
  chessRender();
}
// The move, shown: the piece travels (a knight jumps), a taken piece goes to its tray, a
// castling rook comes along. `done` runs when everything has landed.
function chessAnimate(info, done) {
  if (!chess3d) return done();
  const E = ChessEngine;
  const mover = chess3d.pieces.get(info.from);
  if (!mover) return done();
  const a = { x: mover.position.x, z: mover.position.z };
  const b = chessSqPos(info.to);
  const dist = Math.hypot(b.x - a.x, b.z - a.z);
  const hop = (mover.userData.code & 7) === E.N ? 0.95 : 0.22;
  const dur = Math.min(520, 240 + dist * 45);
  let left = 1;
  const landed = () => {
    if (--left === 0) done();
  };
  const victim = info.cap ? chess3d.pieces.get(info.capSq) : null;
  if (victim) {
    left++;
    chess3d.pieces.delete(info.capSq);
    chess3d.loose.push(victim); // still in the scene: the next sync must find it to remove it
    victim.userData.sq = -1;
    const taker = info.us;
    const taken = chessSt.moves.filter((m) => m.cap && ((m.cap >> 3) ^ 1) === taker).length - 1;
    const s = chessTraySlot(taker, Math.max(0, taken));
    const v0 = victim.position.clone();
    chessTween(
      dur + 120,
      (t) => {
        victim.position.set(v0.x + (s.x - v0.x) * t, v0.y + (s.y - v0.y) * t + Math.sin(t * Math.PI) * 1.2, v0.z + (s.z - v0.z) * t);
        victim.scale.setScalar(1 - 0.18 * t);
      },
      landed
    );
  }
  if (info.flag === E.F_CK || info.flag === E.F_CQ) {
    const rFrom = info.flag === E.F_CK ? info.to + 1 : info.to - 2;
    const rTo = info.flag === E.F_CK ? info.to - 1 : info.to + 1;
    const rook = chess3d.pieces.get(rFrom);
    if (rook) {
      left++;
      const r0 = rook.position.x;
      const r1 = chessSqPos(rTo).x;
      chessTween(
        dur,
        (t) => {
          rook.position.x = r0 + (r1 - r0) * t;
          rook.position.y = Math.sin(t * Math.PI) * 0.5; // over the king
        },
        landed
      );
    }
  }
  chessTween(
    dur,
    (t) => {
      mover.position.set(a.x + (b.x - a.x) * t, Math.sin(t * Math.PI) * hop, a.z + (b.z - a.z) * t);
    },
    landed
  );
}
// The signs on the board: the last move, the chosen piece and where it may go, a king in
// check, a hint.
function chessMarks() {
  if (!chess3d) return;
  const E = ChessEngine;
  const g = chessSt.game;
  const marks = chess3d.marks;
  while (marks.children.length) {
    const m = marks.children.pop();
    m.geometry.dispose();
    m.material.dispose();
  }
  const add = (geo, sq, color, opacity, y) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    const p = chessSqPos(sq);
    m.position.set(p.x, y, p.z);
    marks.add(m);
  };
  const plane = () => new THREE.PlaneGeometry(1, 1);
  const view = chessView();
  const last = view.moves[view.moves.length - 1];
  if (last) {
    add(plane(), E.sqFromName(last.uci.slice(0, 2)), 0xf5d142, 0.3, 0.0045);
    add(plane(), E.sqFromName(last.uci.slice(2, 4)), 0xf5d142, 0.4, 0.0045);
  }
  if (!view.live) {
    // looking back: the move that was better, in blue (the piece is where it stood - or it is
    // the very piece that moved, and then its square of that moment is marked)
    const vg = view.game;
    if (vg.inCheck()) add(plane(), vg.kings[vg.turn], 0xff3b30, 0.55, 0.005);
    const a = chessSt.analysis && chessSt.analysis.moves && view.moves.length ? chessSt.analysis.moves[view.moves.length - 1] : null;
    if (a && CHESS_TAG[a.tag] && a.best) {
      add(plane(), E.sqFromName(a.best.slice(0, 2)), 0x3aa0ff, 0.45, 0.0055);
      add(plane(), E.sqFromName(a.best.slice(2, 4)), 0x3aa0ff, 0.6, 0.0055);
    }
    return chessRender();
  }
  if (chessSt.status && chessSt.status.check) add(plane(), g.kings[g.turn], 0xff3b30, 0.55, 0.005);
  if (chessSt.hint) {
    add(plane(), chessSt.hint.from, 0x3aa0ff, 0.45, 0.0055);
    add(plane(), chessSt.hint.to, 0x3aa0ff, 0.6, 0.0055);
  }
  if (chessSt.sel >= 0) {
    add(plane(), chessSt.sel, 0x4cd964, 0.45, 0.006);
    const seen = new Set();
    for (const m of chessSt.targets) {
      const to = E.mTo(m);
      if (seen.has(to)) continue; // the four promotions share a square
      seen.add(to);
      const takes = !!g.board[to] || E.mFlag(m) === E.F_EP;
      add(takes ? new THREE.RingGeometry(0.39, 0.48, 40) : new THREE.CircleGeometry(0.15, 28), to, takes ? 0xff6b3a : 0x2fbf5a, takes ? 0.9 : 0.75, 0.007);
    }
  }
  chessRender();
}

document.getElementById('chess-btn')?.addEventListener('click', () => createChessTab());
gameTabs.chess = { title: 'Chess', glyph: '♟', color: '#c9a66b', create: createChessTab, onShow: chessOnShow, onClose: chessOnClose, restore: chessRestoreSettings };
