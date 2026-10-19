// ---- Mahjong solitaire: 144 tiles in 3D (three.js) ----
// The layout, the "free" rule and the winnable deals are mahjong-engine.js; this file is the
// tab: the scene (ivory tiles with painted faces on green felt - all drawn here, no image
// files), the mouse, the side panel, and the game's place in settings.
// Loaded before renderer.js: it only touches renderer globals inside functions.
const mahSt = {
  rec: null,
  faces: null, // face per tile of the layout
  gone: new Set(),
  history: [], // the pairs taken, in order
  sel: -1,
  hint: null, // [a, b] being shown
  elapsed: 0,
  shuffles: 0,
  hints: 0,
  showFree: false,
  sound: false, // off until asked for
  done: false,
  stuck: false,
  animating: false,
  saved: null,
  saveTimer: null,
  tick: null,
  hintTimer: null,
  cam: null, // where the camera stands: { az, pol, zoom, px, pz } - see MAH_VIEW
};
let mah3d = null;
// a tile: one wide, 1.34 deep, 0.56 high (0.16 of it the green back)
const MAH = { W: 1, D: 1.34, H: 0.56, BACK: 0.16, COLS: 7, ROWS: 6 };
// The view. az turns the camera around the table, pol tilts it (0 = straight above), zoom
// scales the distance at which the whole turtle fits, px/pz slide the point it looks at.
const MAH_VIEW = { az: 0, pol: 0.55, zoom: 1, px: 0, pz: 0 };
const MAH_POL_MIN = 0.02; // never exactly 0: straight down, "up" has no direction
const MAH_POL_MAX = 1.3; // about 15 degrees above the felt
const MAH_ZOOM_MIN = 0.3;
const MAH_ZOOM_MAX = 1.8;
const MAH_PAN = { x: 9, z: 7 };
const MAH_BOX = { x: 7.6, y: 2.9, z: 5.45 }; // half the turtle's width and depth, and its height
const MAH_AIM_Y = 0.8;
function mahCamClean(c) {
  c = c && typeof c === 'object' ? c : {};
  const num = (v, d, lo, hi) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
  const az = Number.isFinite(c.az) ? Math.atan2(Math.sin(c.az), Math.cos(c.az)) : MAH_VIEW.az; // one turn is enough
  return {
    az,
    pol: num(c.pol, MAH_VIEW.pol, MAH_POL_MIN, MAH_POL_MAX),
    zoom: num(c.zoom, MAH_VIEW.zoom, MAH_ZOOM_MIN, MAH_ZOOM_MAX),
    px: num(c.px, 0, -MAH_PAN.x, MAH_PAN.x),
    pz: num(c.pz, 0, -MAH_PAN.z, MAH_PAN.z),
  };
}

function mahRestoreSettings(s) {
  if (!s || typeof s !== 'object') return;
  const E = MahjongEngine;
  // soundOn, not the older `sound`: that one was written as true by every save without anyone
  // choosing it, so honouring it would keep the sound on for exactly the people who asked for quiet.
  const out = { showFree: s.showFree === true, soundOn: s.soundOn === true, cam: mahCamClean(s.cam) };
  const facesOk = Array.isArray(s.faces) && s.faces.length === E.N && s.faces.every((f) => Number.isInteger(f) && f >= 0 && f < E.FACES);
  if (facesOk && Array.isArray(s.history)) {
    // replay what was taken: every pair must have been free and matching, or the save is not a game
    const gone = new Set();
    const hist = [];
    for (const p of s.history.slice(0, 72)) {
      if (!Array.isArray(p) || p.length !== 2 || !Number.isInteger(p[0]) || !Number.isInteger(p[1])) break;
      const [a, b] = p;
      if (a === b || a < 0 || b < 0 || a >= E.N || b >= E.N || !E.isFree(a, gone) || !E.isFree(b, gone) || !E.matches(s.faces[a], s.faces[b])) break;
      gone.add(a);
      gone.add(b);
      hist.push([a, b]);
    }
    out.faces = s.faces.slice();
    out.history = hist;
    out.elapsed = Number.isFinite(s.elapsed) && s.elapsed >= 0 ? Math.floor(s.elapsed) : 0;
    out.shuffles = Number.isInteger(s.shuffles) && s.shuffles >= 0 ? s.shuffles : 0;
    out.hints = Number.isInteger(s.hints) && s.hints >= 0 ? s.hints : 0;
  }
  mahSt.saved = out;
}
function mahSave() {
  const st = mahSt;
  st.saved = { faces: st.faces.slice(), history: st.history.map((p) => p.slice()), elapsed: st.elapsed, shuffles: st.shuffles, hints: st.hints, showFree: st.showFree, soundOn: st.sound, cam: mahCamClean(st.cam) };
  clearTimeout(st.saveTimer);
  st.saveTimer = setTimeout(() => api.saveSettings({ mahjong: st.saved }), 400);
}

function createMahjongTab() {
  for (const [tid, r] of tabs) {
    if (r.kind === 'mahjong') {
      activateTab(tid);
      return tid;
    }
  }
  const id = newTabId();
  const { tabEl, paneEl } = createTabChrome(id, 'Mahjong', 'mahjong');
  paneEl.classList.remove('term-pane');
  paneEl.classList.add('mah-pane');
  paneEl.tabIndex = -1;
  paneEl.innerHTML =
    '<div class="mah-stage"><canvas class="mah-canvas"></canvas><div class="mah-banner hidden"></div>' +
    '<div class="mah-tip">Take two free tiles with the same face · free = nothing on it, and its left or right side open<br />Drag to turn the table · right-drag to move it · wheel to zoom · double-click the felt for the standard view</div></div>' +
    '<div class="mah-side">' +
    '<div class="mah-status"></div>' +
    '<div class="mah-stats"></div>' +
    '<div class="mah-row mah-btns">' +
    '<button data-m="new" title="A new game (n)">New game</button>' +
    '<button data-m="undo" title="Put the last pair back (u)">↶ Undo</button>' +
    '<button data-m="hint" title="Show a pair you can take (h)">💡 Hint</button>' +
    '<button data-m="shuffle" title="Mix the tiles that are left (s)">🔀 Shuffle</button>' +
    '<button data-m="free" title="Dim the tiles that cannot be taken yet (f)">◐ Free tiles</button>' +
    '</div>' +
    '<div class="mah-row mah-btns mah-viewbtns">' +
    '<button data-m="left" title="Turn the table (left arrow)">↺</button>' +
    '<button data-m="right" title="Turn the table (right arrow)">↻</button>' +
    '<button data-m="zin" title="Closer (+, or the wheel)">＋</button>' +
    '<button data-m="zout" title="Further away (-, or the wheel)">－</button>' +
    '<button data-m="top" title="Straight from above, and back (t)">⬓ Top</button>' +
    '<button data-m="view" title="The standard view (v, or double-click the felt)">⌂ View</button>' +
    '</div>' +
    '<label class="mah-opt" title="A soft knock when tiles are taken. Off unless you switch it on, and never during a meeting. (m)"><input type="checkbox" class="mah-sound" /> 🔊 Sound</label>' +
    '<div class="mah-keys">Flowers match flowers, seasons match seasons.<br />n new · u undo · h hint · s shuffle · f free tiles · m sound<br />arrows turn and tilt · + - zoom · t from above · v standard view</div>' +
    '</div>';
  const rec = { id, kind: 'mahjong', paneEl, tabEl, status: 'connected', profile: { name: 'Mahjong' } };
  tabs.set(id, rec);
  const st = mahSt;
  st.rec = rec;
  const s = st.saved || {};
  st.showFree = !!s.showFree;
  st.sound = s.soundOn === true;
  st.cam = mahCamClean(s.cam);
  st.sel = -1;
  st.hint = null;
  st.animating = false;
  if (s.faces) {
    st.faces = s.faces.slice();
    st.history = s.history.map((p) => p.slice());
    st.gone = new Set(st.history.flat());
    st.elapsed = s.elapsed || 0;
    st.shuffles = s.shuffles || 0;
    st.hints = s.hints || 0;
  } else mahDeal();
  mahWire(rec);
  activateTab(id);
  bbTabOpen(rec);
  persistTabOrder();
  const stage = paneEl.querySelector('.mah-stage');
  try {
    mah3d = mahBuild3d(stage);
  } catch (err) {
    mah3d = null;
    stage.innerHTML = '<div class="chess-no3d">The 3D table could not start on this computer (no WebGL).<br /><span></span></div>';
    stage.querySelector('span').textContent = String((err && err.message) || err);
  }
  mahSync();
  mahUpdate();
  mahResize();
  clearInterval(st.tick);
  st.tick = setInterval(mahTick, 1000);
  return id;
}
function mahDeal() {
  const st = mahSt;
  st.faces = MahjongEngine.deal().faces;
  st.gone = new Set();
  st.history = [];
  st.elapsed = 0;
  st.shuffles = 0;
  st.hints = 0;
  st.sel = -1;
  st.hint = null;
}
function mahOnShow() {
  if (!mahSt.rec) return;
  mahResize();
  mahRender();
}
function mahOnClose() {
  const st = mahSt;
  clearInterval(st.tick);
  clearTimeout(st.saveTimer);
  clearTimeout(st.hintTimer);
  if (st.faces) api.saveSettings({ mahjong: st.saved });
  if (mah3d) {
    cancelAnimationFrame(mah3d.raf);
    if (mah3d.ro) mah3d.ro.disconnect();
    try {
      mah3d.renderer.dispose();
      mah3d.renderer.forceContextLoss();
    } catch (_) {
      /* gone with the canvas */
    }
    mah3d = null;
  }
  st.rec = null;
}
function mahTick() {
  const st = mahSt;
  if (!st.rec || st.done || activeTabId !== st.rec.id || document.hidden) return;
  st.elapsed++;
  const t = st.rec.paneEl.querySelector('.mah-time');
  if (t) t.textContent = gameClock(st.elapsed);
  if (st.elapsed % 15 === 0) mahSave();
}
function mahWire(rec) {
  const p = rec.paneEl;
  gameKeepFocus(p);
  const act = (m) => {
    if (m === 'new') mahNew();
    else if (m === 'undo') mahUndo();
    else if (m === 'hint') mahHint();
    else if (m === 'shuffle') mahShuffle();
    else if (m === 'free') {
      mahSt.showFree = !mahSt.showFree;
      mahSave();
      mahUpdate();
    } else if (m === 'sound') {
      mahSt.sound = !mahSt.sound;
      mahSave();
      mahUpdate();
    } else mahViewAct(m);
  };
  p.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (b) act(b.dataset.m);
  });
  p.querySelector('.mah-sound').addEventListener('change', (e) => {
    mahSt.sound = e.target.checked;
    mahSave();
    mahUpdate();
    if (mahSt.sound) gameSound('capture'); // what you have just switched on
    p.focus({ preventScroll: true });
  });
  p.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const m =
      { n: 'new', u: 'undo', h: 'hint', s: 'shuffle', f: 'free', m: 'sound', v: 'view', t: 'top', '+': 'zin', '=': 'zin', '-': 'zout' }[e.key.toLowerCase()] ||
      { ArrowLeft: 'kleft', ArrowRight: 'kright', ArrowUp: 'kup', ArrowDown: 'kdown' }[e.key];
    if (!m) return;
    e.preventDefault();
    act(m);
  });
}
function mahUpdate() {
  const st = mahSt;
  if (!st.rec) return;
  const E = MahjongEngine;
  const p = st.rec.paneEl;
  const left = E.N - st.gone.size;
  const moves = E.pairs(st.faces, st.gone).length;
  st.done = left === 0;
  st.stuck = !st.done && moves === 0;
  // Stuck for good? Some shapes no order of faces can solve (two tiles, one on the other),
  // and offering Shuffle there would be offering nothing. Only asked when stuck.
  st.dead = st.stuck && E.reshuffle(st.faces, st.gone).winnable === false;
  const status = p.querySelector('.mah-status');
  status.textContent = st.done ? 'Cleared!' : st.stuck ? 'No more moves' : left + ' tiles left';
  status.classList.toggle('over', st.done);
  status.classList.toggle('stuck', st.stuck);
  p.querySelector('.mah-stats').innerHTML =
    `<div><span>Time</span><b class="mah-time">${gameClock(st.elapsed)}</b></div>` +
    `<div><span>Pairs you can take</span><b>${moves}</b></div>` +
    `<div><span>Shuffles · hints</span><b>${st.shuffles} · ${st.hints}</b></div>`;
  // the side panel's OWN buttons: the banner comes first in the pane and keeps its buttons while
  // hidden, so a query on the pane found those and left these stale
  const side = p.querySelector('.mah-side');
  side.querySelector('[data-m="undo"]').disabled = !st.history.length;
  side.querySelector('[data-m="hint"]').disabled = st.done || st.stuck;
  side.querySelector('[data-m="shuffle"]').disabled = st.done || st.dead || left < 4;
  side.querySelector('[data-m="free"]').classList.toggle('on', st.showFree);
  side.querySelector('.mah-sound').checked = st.sound;
  const banner = p.querySelector('.mah-banner');
  banner.classList.toggle('hidden', !st.done && !st.stuck);
  if (st.done) {
    banner.innerHTML = `<b>Cleared in ${gameClock(st.elapsed)}</b><span>${st.shuffles} shuffles · ${st.hints} hints</span><button data-m="new">New game</button>`;
  } else if (st.stuck) {
    banner.innerHTML = st.dead
      ? '<b>No more moves</b><span>No shuffle can free these tiles - undo a few moves, or start again.</span><button data-m="undo">↶ Undo</button><button data-m="new">New game</button>'
      : '<b>No more moves</b><button data-m="shuffle">🔀 Shuffle</button><button data-m="undo">↶ Undo</button><button data-m="new">New game</button>';
  }
  mahMarks();
}
function mahNew(force) {
  const st = mahSt;
  if (!force && st.history.length && !st.done && !window.confirm('Start a new game? This one will be lost.')) return;
  mahDeal();
  mahSync();
  mahUpdate();
  mahSave();
}
function mahUndo() {
  const st = mahSt;
  if (st.animating || !st.history.length) return;
  const [a, b] = st.history.pop();
  st.gone.delete(a);
  st.gone.delete(b);
  st.sel = -1;
  st.hint = null;
  mahSync();
  mahUpdate();
  mahSave();
}
function mahHint() {
  const st = mahSt;
  if (st.animating || st.done) return;
  const ps = MahjongEngine.pairs(st.faces, st.gone);
  if (!ps.length) return;
  // not the same pair every time
  st.hint = ps[(st.hints + st.history.length) % ps.length];
  st.hints++;
  st.sel = -1;
  mahUpdate();
  mahSave();
  clearTimeout(st.hintTimer);
  st.hintTimer = setTimeout(() => {
    st.hint = null;
    mahMarks();
  }, 3500);
}
function mahShuffle() {
  const st = mahSt;
  if (st.animating || st.done || st.dead) return;
  const r = MahjongEngine.reshuffle(st.faces, st.gone);
  st.faces = r.faces;
  st.shuffles++;
  st.sel = -1;
  st.hint = null;
  // the history names PLACES, and those are as they were: undo still works after a shuffle
  mahSync();
  mahUpdate();
  mahSave();
  if (st.sound) gameSound('capture');
}
function mahClick(i) {
  const st = mahSt;
  const E = MahjongEngine;
  if (st.animating || st.done || i < 0 || st.gone.has(i)) return;
  st.hint = null;
  if (!E.isFree(i, st.gone)) {
    mahShake(i); // it is held: by a tile on it, or one on each side
    return;
  }
  if (st.sel === i) st.sel = -1;
  else if (st.sel >= 0 && E.matches(st.faces[st.sel], st.faces[i])) return mahTake(st.sel, i);
  else st.sel = i;
  if (st.sound) gameSound('tick');
  mahMarks();
}
function mahTake(a, b) {
  const st = mahSt;
  st.sel = -1;
  st.gone.add(a);
  st.gone.add(b);
  st.history.push([a, b]);
  st.animating = true;
  if (st.sound) gameSound('capture');
  mahMarks();
  mahAnimateOut([a, b], () => {
    st.animating = false;
    mahSync();
    mahUpdate();
    mahSave();
    if (st.done && st.sound) gameSound('end');
  });
}

// ---- the scene ----
const mahPos = (i) => {
  const t = MahjongEngine.LAYOUT[i];
  return { x: ((t.x - 14) / 2) * MAH.W, y: t.z * MAH.H, z: ((t.y - 7) / 2) * MAH.D };
};
// All 42 faces on one sheet: 7 across, 6 down. Painted like the classic set, with a small
// index in the corner (1-9, E S W N, ...) for anyone who does not read the characters.
function mahAtlas() {
  const CW = 192;
  const CH = 256;
  const c = document.createElement('canvas');
  c.width = CW * MAH.COLS;
  c.height = CH * MAH.ROWS;
  const g = c.getContext('2d');
  const RED = '#c0271f';
  const GREEN = '#17803d';
  const BLUE = '#1f4fa8';
  const INK = '#1c1c1c';
  const CJK = '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", "SimHei", sans-serif';
  const cell = (f, draw, index, indexColor) => {
    const x0 = (f % MAH.COLS) * CW;
    const y0 = Math.floor(f / MAH.COLS) * CH;
    g.save();
    g.translate(x0, y0);
    g.fillStyle = '#f7f0dc';
    g.fillRect(0, 0, CW, CH);
    draw();
    if (index) {
      g.fillStyle = indexColor || '#6d6656';
      g.font = '700 30px Georgia, serif';
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillText(index, 10, 6);
    }
    g.restore();
  };
  const dot = (x, y, r, color) => {
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#f7f0dc';
    g.beginPath();
    g.arc(x, y, r * 0.62, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, r * 0.34, 0, Math.PI * 2);
    g.fill();
  };
  const stick = (x, y, h, color) => {
    const w = 15;
    g.fillStyle = color;
    g.beginPath();
    g.roundRect(x - w / 2, y - h / 2, w, h, 6);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.fillRect(x - w / 2 + 2, y - 2, w - 4, 4);
    g.fillRect(x - w / 2 + 2, y - h / 2 + 7, w - 4, 3);
    g.fillRect(x - w / 2 + 2, y + h / 2 - 10, w - 4, 3);
  };
  // where the pips of 1..9 go, on a 3 x 3 grid of the cell's lower part
  const X = [56, 96, 136];
  const Y = [86, 146, 206];
  const PIPS = {
    1: [[1, 1]],
    2: [[1, 0], [1, 2]],
    3: [[0, 0], [1, 1], [2, 2]],
    4: [[0, 0], [2, 0], [0, 2], [2, 2]],
    5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
    6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
    7: [[0, 0], [1, 0.5], [2, 1], [0, 1.5], [2, 1.5], [0, 2.3], [2, 2.3]],
    8: [[0, 0], [2, 0], [0, 0.75], [2, 0.75], [0, 1.5], [2, 1.5], [0, 2.25], [2, 2.25]],
    9: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]],
  };
  const at = ([cx, cy]) => [X[0] + (X[2] - X[0]) * (cx / 2), Y[0] + (Y[2] - Y[0]) * (cy / 2.3)];
  for (let n = 1; n <= 9; n++) {
    // dots
    cell(n - 1, () => {
      if (n === 1) return dot(96, 146, 52, RED);
      PIPS[n].forEach((p, k) => {
        const [x, y] = at(p);
        dot(x, y, n <= 4 ? 25 : n <= 6 ? 22 : 18, n === 5 && k === 2 ? RED : k % 2 ? GREEN : BLUE);
      });
    }, String(n), BLUE);
    // bamboo
    cell(9 + n - 1, () => {
      if (n === 1) {
        stick(96, 150, 130, GREEN);
        stick(70, 150, 90, RED);
        stick(122, 150, 90, RED);
        return;
      }
      PIPS[n].forEach((p, k) => {
        const [x, y] = at(p);
        stick(x, y, n <= 4 ? 62 : n <= 6 ? 52 : 40, (n === 5 && k === 2) || (n === 7 && k === 1) || (n === 9 && k % 3 === 1) ? RED : GREEN);
      });
    }, String(n), GREEN);
    // characters: the number, then the "ten thousand" sign in red
    cell(18 + n - 1, () => {
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = INK;
      g.font = '700 96px ' + CJK;
      g.fillText('一二三四五六七八九'[n - 1], 104, 96);
      g.fillStyle = RED;
      g.font = '700 92px ' + CJK;
      g.fillText('萬', 104, 192);
    }, String(n), RED);
  }
  const big = (ch, color) => () => {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = color;
    g.font = '700 150px ' + CJK;
    g.fillText(ch, 100, 146);
  };
  ['東', '南', '西', '北'].forEach((ch, k) => cell(27 + k, big(ch, INK), 'ESWN'[k], INK));
  cell(31, big('中', RED), 'C', RED);
  cell(32, big('發', GREEN), 'F', GREEN);
  cell(33, () => {
    g.strokeStyle = BLUE;
    g.lineWidth = 10;
    g.strokeRect(38, 56, 116, 164);
    g.lineWidth = 4;
    g.strokeRect(54, 72, 84, 132);
  });
  // flowers: five petals; seasons: a leaf - each in its own colour, numbered
  const PETAL = ['#d6336c', '#e8590c', '#9c36b5', '#1c7ed6'];
  for (let k = 0; k < 4; k++) {
    cell(34 + k, () => {
      g.fillStyle = PETAL[k];
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        g.beginPath();
        g.ellipse(96 + Math.cos(a) * 34, 138 + Math.sin(a) * 34, 30, 19, a, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = '#f2c230';
      g.beginPath();
      g.arc(96, 138, 17, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = GREEN;
      g.lineWidth = 7;
      g.beginPath();
      g.moveTo(96, 178);
      g.quadraticCurveTo(84, 212, 100, 240);
      g.stroke();
    }, '✿' + (k + 1), PETAL[k]);
    const LEAF = ['#2f9e44', '#e67700', '#c92a2a', '#1971c2'];
    cell(38 + k, () => {
      g.fillStyle = LEAF[k];
      g.beginPath();
      g.moveTo(96, 62);
      g.bezierCurveTo(168, 96, 160, 196, 96, 234);
      g.bezierCurveTo(32, 196, 24, 96, 96, 62);
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(96, 76);
      g.lineTo(96, 224);
      for (const y of [110, 146, 182]) {
        g.moveTo(96, y);
        g.lineTo(62, y - 22);
        g.moveTo(96, y);
        g.lineTo(130, y - 22);
      }
      g.stroke();
    }, '❖' + (k + 1), LEAF[k]);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  tex.anisotropy = 8;
  return tex;
}
function mahFelt() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#1d5a3c';
  g.fillRect(0, 0, 256, 256);
  const rnd = gameRng(9);
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = `rgba(${rnd() < 0.5 ? '255,255,255' : '0,0,0'},${0.03 + rnd() * 0.05})`;
    g.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 2, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(70, 70);
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}
function mahBuild3d(stage) {
  const canvas = stage.querySelector('.mah-canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f2a1d);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 500);
  // the felt fades into the dark before it ends: seen flat, its edge would be a line on the horizon
  scene.fog = new THREE.Fog(0x0f2a1d, 60, 200);
  scene.add(new THREE.HemisphereLight(0xfff6e6, 0x1c3a2a, 0.55));
  const key = new THREE.DirectionalLight(0xfff2dd, 1.15);
  key.position.set(-7, 16, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -11;
  key.shadow.camera.right = 11;
  key.shadow.camera.top = 9;
  key.shadow.camera.bottom = -9;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 45;
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  scene.add(key);
  const table = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ map: mahFelt(), roughness: 1, metalness: 0 }));
  table.rotation.x = -Math.PI / 2;
  table.receiveShadow = true;
  scene.add(table);
  // a tile: a green back and an ivory body, both with rounded corners
  const slab = (h) => {
    const w = MAH.W - 0.05;
    const d = MAH.D - 0.05;
    const r = 0.11;
    const s = new THREE.Shape();
    s.moveTo(-w / 2 + r, -d / 2);
    s.lineTo(w / 2 - r, -d / 2);
    s.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r);
    s.lineTo(w / 2, d / 2 - r);
    s.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2);
    s.lineTo(-w / 2 + r, d / 2);
    s.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r);
    s.lineTo(-w / 2, -d / 2 + r);
    s.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2);
    const bevel = 0.03;
    const geo = new THREE.ExtrudeGeometry(s, { depth: h - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 6, steps: 1 });
    geo.rotateX(-Math.PI / 2); // the thickness stands up
    geo.translate(0, bevel, 0);
    return geo;
  };
  const three = {
    stage,
    canvas,
    renderer,
    scene,
    camera,
    geoBack: slab(MAH.BACK),
    geoBody: slab(MAH.H - MAH.BACK),
    geoFace: {},
    mat: {
      back: new THREE.MeshStandardMaterial({ color: 0x1f7a4a, roughness: 0.55 }),
      body: new THREE.MeshStandardMaterial({ color: 0xf2e9d0, roughness: 0.42 }),
      face: new THREE.MeshStandardMaterial({ map: mahAtlas(), roughness: 0.45 }),
    },
    tiles: new Map(), // tile index -> its group
    flying: [],
    marks: new THREE.Group(),
    tweens: [],
    raf: 0,
    raycaster: new THREE.Raycaster(),
    ro: null,
    dist: 30, // camera to the point it looks at
    camSeq: 0, // a newer view change or a drag overrides a running one
    topBtn: stage.parentElement.querySelector('.mah-side [data-m="top"]'),
  };
  scene.add(three.marks);
  // One press is either a click on a tile or a drag of the view - decided by whether it moved.
  // Left drag turns and tilts; right, middle or Shift+drag slides the table.
  let down = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button > 2) return;
    const c = mahSt.cam;
    down = { x: e.clientX, y: e.clientY, az: c.az, pol: c.pol, px: c.px, pz: c.pz, moved: false, button: e.button, pan: e.button !== 0 || e.shiftKey };
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
    if (!down.moved && Math.abs(dx) + Math.abs(dy) < 6) return; // a hand is never perfectly still
    if (!down.moved) {
      down.moved = true;
      three.camSeq++; // the hand takes over from a view that was still gliding
      canvas.classList.add('turning');
    }
    const c = mahSt.cam;
    if (down.pan) {
      // the table follows the pointer: units of felt per pixel at the point looked at
      const k = (2 * three.dist * Math.tan((camera.fov * Math.PI) / 360)) / (canvas.clientHeight || 1);
      const deep = (dy * k) / Math.max(0.3, Math.cos(down.pol)); // the felt lies tilted away
      c.px = Math.max(-MAH_PAN.x, Math.min(MAH_PAN.x, down.px - dx * k * Math.cos(down.az) - deep * Math.sin(down.az)));
      c.pz = Math.max(-MAH_PAN.z, Math.min(MAH_PAN.z, down.pz + dx * k * Math.sin(down.az) - deep * Math.cos(down.az)));
    } else {
      c.az = down.az - dx * 0.006;
      c.pol = Math.max(MAH_POL_MIN, Math.min(MAH_POL_MAX, down.pol - dy * 0.005));
    }
    mahCamApply();
  });
  const up = (e) => {
    if (!down) return;
    const d = down;
    down = null;
    canvas.classList.remove('turning');
    if (d.moved) mahSave();
    else if (d.button === 0 && !d.pan) mahClick(mahPick(e.clientX, e.clientY));
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', () => {
    down = null;
    canvas.classList.remove('turning');
  });
  canvas.addEventListener('dblclick', (e) => {
    if (mahPick(e.clientX, e.clientY) === -1) mahCamTo(MAH_VIEW); // on the felt, not on a tile
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey) return;
      e.preventDefault();
      three.camSeq++;
      const c = mahSt.cam;
      c.zoom = Math.max(MAH_ZOOM_MIN, Math.min(MAH_ZOOM_MAX, c.zoom * (e.deltaY > 0 ? 1.1 : 1 / 1.1)));
      mahCamApply();
      mahSave();
    },
    { passive: false }
  );
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  three.ro = new ResizeObserver(() => mahResize());
  three.ro.observe(stage);
  return three;
}
// The picture on a tile: a plane on its top, cut from the sheet of faces.
function mahFaceGeo(f) {
  if (mah3d.geoFace[f]) return mah3d.geoFace[f];
  const geo = new THREE.PlaneGeometry(MAH.W * 0.84, MAH.D * 0.86);
  const col = f % MAH.COLS;
  const row = Math.floor(f / MAH.COLS);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (col + uv.getX(i)) / MAH.COLS, 1 - (row + 1 - uv.getY(i)) / MAH.ROWS);
  }
  geo.rotateX(-Math.PI / 2);
  return (mah3d.geoFace[f] = geo);
}
function mahMakeTile(i) {
  const grp = new THREE.Group();
  const back = new THREE.Mesh(mah3d.geoBack, mah3d.mat.back);
  const body = new THREE.Mesh(mah3d.geoBody, mah3d.mat.body);
  body.position.y = MAH.BACK;
  const face = new THREE.Mesh(mahFaceGeo(mahSt.faces[i]), mah3d.mat.face);
  face.position.y = MAH.H + 0.002;
  for (const m of [back, body]) {
    m.castShadow = true;
    m.receiveShadow = true;
  }
  face.receiveShadow = true;
  grp.add(back, body, face);
  const p = mahPos(i);
  grp.position.set(p.x, p.y, p.z);
  grp.userData = { i };
  return grp;
}
// Put on the table exactly the tiles the game says are there.
function mahSync() {
  if (!mah3d) return;
  for (const g of mah3d.tiles.values()) mah3d.scene.remove(g);
  for (const g of mah3d.flying) mah3d.scene.remove(g);
  mah3d.tiles.clear();
  mah3d.flying = [];
  for (let i = 0; i < MahjongEngine.N; i++) {
    if (mahSt.gone.has(i)) continue;
    const g = mahMakeTile(i);
    mah3d.scene.add(g);
    mah3d.tiles.set(i, g);
  }
  mahMarks();
}
function mahResize() {
  if (!mah3d) return;
  const w = mah3d.stage.clientWidth;
  const h = mah3d.stage.clientHeight;
  if (!w || !h) return;
  mah3d.renderer.setSize(w, h, false);
  mah3d.camera.aspect = w / h;
  mah3d.camera.updateProjectionMatrix();
  mahCamApply();
}
// Put the camera where mahSt.cam says. The distance is worked out so that the WHOLE turtle
// fits from this side and in a pane of this shape (zoom 1), by asking of each corner of its
// box how far back the camera must stand to keep that corner inside the picture.
function mahCamApply() {
  if (!mah3d) return;
  const c = mahSt.cam || (mahSt.cam = mahCamClean(null));
  const cam = mah3d.camera;
  const sp = Math.sin(c.pol);
  const dir = new THREE.Vector3(sp * Math.sin(c.az), Math.cos(c.pol), sp * Math.cos(c.az)); // from the table to the camera
  const right = new THREE.Vector3(Math.cos(c.az), 0, -Math.sin(c.az));
  const upv = new THREE.Vector3().crossVectors(dir, right);
  const tanV = Math.tan((cam.fov * Math.PI) / 360);
  const tanH = tanV * cam.aspect;
  let fit = 0;
  const v = new THREE.Vector3();
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      for (const y of [0, MAH_BOX.y]) {
        v.set(sx * MAH_BOX.x, y - MAH_AIM_Y, sz * MAH_BOX.z);
        const along = v.dot(dir); // a corner nearer the camera needs the camera further back
        fit = Math.max(fit, along + Math.abs(v.dot(right)) / tanH, along + Math.abs(v.dot(upv)) / tanV);
      }
    }
  }
  const dist = fit * 1.05 * c.zoom;
  mah3d.dist = dist;
  cam.position.set(c.px + dir.x * dist, MAH_AIM_Y + dir.y * dist, c.pz + dir.z * dist);
  cam.lookAt(c.px, MAH_AIM_Y, c.pz);
  // a click can arrive before the first frame is painted, and the ray is cast from these
  cam.updateMatrixWorld();
  mah3d.scene.fog.near = dist + 40;
  mah3d.scene.fog.far = dist + 190;
  if (mah3d.topBtn) mah3d.topBtn.classList.toggle('on', c.pol < 0.08);
  mahRender();
}
// Glide to another view (the short way round), instead of jumping there.
function mahCamTo(to, ms) {
  if (!mah3d) return;
  const from = Object.assign({}, mahSt.cam);
  const goal = Object.assign({}, from, to);
  goal.pol = Math.max(MAH_POL_MIN, Math.min(MAH_POL_MAX, goal.pol));
  goal.zoom = Math.max(MAH_ZOOM_MIN, Math.min(MAH_ZOOM_MAX, goal.zoom));
  const daz = Math.atan2(Math.sin(goal.az - from.az), Math.cos(goal.az - from.az));
  const id = ++mah3d.camSeq;
  mahTween(
    ms || 380,
    (t) => {
      if (!mah3d || id !== mah3d.camSeq) return; // a drag or a newer change took over
      const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const c = mahSt.cam;
      c.az = from.az + daz * k;
      for (const f of ['pol', 'zoom', 'px', 'pz']) c[f] = from[f] + (goal[f] - from[f]) * k;
      mahCamApply();
    },
    () => {
      if (!mah3d || id !== mah3d.camSeq) return;
      mahSt.cam = mahCamClean(mahSt.cam);
      mahSave();
    }
  );
}
// The view buttons and keys. Turning by a button goes an eighth of a turn, by a key a
// twenty-fourth; "Top" squares the table up as well, since a top view at an odd angle reads badly.
function mahViewAct(m) {
  const c = mahSt.cam;
  if (!c || !mah3d) return;
  const Q = Math.PI / 2;
  if (m === 'view') mahCamTo(MAH_VIEW);
  else if (m === 'top') mahCamTo(c.pol < 0.08 ? { pol: MAH_VIEW.pol } : { pol: MAH_POL_MIN, az: Math.round(c.az / Q) * Q });
  else if (m === 'left') mahCamTo({ az: c.az + Math.PI / 4 });
  else if (m === 'right') mahCamTo({ az: c.az - Math.PI / 4 });
  else if (m === 'kleft') mahCamTo({ az: c.az + Math.PI / 12 }, 140);
  else if (m === 'kright') mahCamTo({ az: c.az - Math.PI / 12 }, 140);
  else if (m === 'kup') mahCamTo({ pol: c.pol + 0.12 }, 140);
  else if (m === 'kdown') mahCamTo({ pol: c.pol - 0.12 }, 140);
  else if (m === 'zin') mahCamTo({ zoom: c.zoom / 1.2 }, 140);
  else if (m === 'zout') mahCamTo({ zoom: c.zoom * 1.2 }, 140);
}
function mahRender() {
  if (!mah3d || mah3d.raf) return;
  mah3d.raf = requestAnimationFrame(mahTickFrame);
}
function mahTickFrame() {
  if (!mah3d) return;
  mah3d.raf = 0;
  const now = performance.now();
  for (const tw of mah3d.tweens.slice()) mahTweenStep(tw, now);
  mah3d.renderer.render(mah3d.scene, mah3d.camera);
  if (mah3d.tweens.length) mahRender();
}
function mahTweenStep(tw, now) {
  if (tw.finished) return;
  const t = Math.min(1, (now - tw.t0) / tw.dur);
  tw.apply(t);
  if (t >= 1) {
    tw.finished = true;
    const k = mah3d.tweens.indexOf(tw);
    if (k !== -1) mah3d.tweens.splice(k, 1);
    if (tw.done) tw.done();
  }
}
// Frames drive it while the window paints; a timer finishes it regardless (see chessTween).
function mahTween(dur, apply, done) {
  if (!mah3d) {
    apply(1);
    if (done) done();
    return;
  }
  const tw = { t0: performance.now(), dur, apply, done, finished: false };
  mah3d.tweens.push(tw);
  mahRender();
  setTimeout(() => {
    if (!mah3d || tw.finished) return;
    mahTweenStep(tw, tw.t0 + tw.dur);
    mahRender();
  }, dur + 60);
}
function mahPick(clientX, clientY) {
  if (!mah3d) return -1;
  const r = mah3d.canvas.getBoundingClientRect();
  if (!r.width || !r.height) return -1;
  const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  // tiles put down since the last painted frame have no world matrix yet, and a ray would miss them
  mah3d.scene.updateMatrixWorld();
  mah3d.raycaster.setFromCamera(ndc, mah3d.camera);
  const hits = mah3d.raycaster.intersectObjects([...mah3d.tiles.values()], true);
  for (const h of hits) {
    let o = h.object;
    while (o && !(o.userData && Number.isInteger(o.userData.i))) o = o.parent;
    if (o) return o.userData.i;
  }
  return -1;
}
// Where a tile's top is on screen - for the tests, which click like a person.
function mahTileClient(i) {
  if (!mah3d) return null;
  const p = mahPos(i);
  const v = new THREE.Vector3(p.x, p.y + MAH.H, p.z).project(mah3d.camera);
  const r = mah3d.canvas.getBoundingClientRect();
  return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
}
// The two tiles rise, meet in the air, and are gone.
function mahAnimateOut(pair, done) {
  if (!mah3d) return done();
  const gs = pair.map((i) => mah3d.tiles.get(i)).filter(Boolean);
  if (gs.length < 2) return done();
  for (const i of pair) mah3d.tiles.delete(i);
  mah3d.flying.push(...gs); // still in the scene: the next sync removes them
  const from = gs.map((g) => g.position.clone());
  const mid = from[0].clone().add(from[1]).multiplyScalar(0.5);
  mid.y = Math.max(from[0].y, from[1].y) + 2.2;
  mahTween(
    330,
    (t) => {
      const e = t * t * (3 - 2 * t);
      gs.forEach((g, k) => {
        g.position.lerpVectors(from[k], mid, e);
        g.scale.setScalar(1 - 0.75 * e);
      });
    },
    done
  );
}
// A tile that is held shakes its head.
function mahShake(i) {
  const g = mah3d && mah3d.tiles.get(i);
  if (!g) return;
  const x0 = mahPos(i).x;
  mahTween(
    260,
    (t) => {
      g.position.x = x0 + Math.sin(t * Math.PI * 4) * 0.05 * (1 - t);
    },
    () => (g.position.x = x0)
  );
}
// The signs: the chosen tile, a hinted pair, and (if asked for) a shade on the held tiles.
function mahMarks() {
  if (!mah3d) return;
  const st = mahSt;
  const marks = mah3d.marks;
  while (marks.children.length) {
    const m = marks.children.pop();
    m.geometry.dispose();
    m.material.dispose();
  }
  const cover = (i, color, opacity) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(MAH.W - 0.06, MAH.D - 0.06), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    const p = mahPos(i);
    m.position.set(p.x, p.y + MAH.H + 0.006, p.z);
    marks.add(m);
  };
  for (const [i, g] of mah3d.tiles) g.position.y = mahPos(i).y + (i === st.sel ? 0.14 : 0);
  if (st.showFree) for (const i of mah3d.tiles.keys()) if (!MahjongEngine.isFree(i, st.gone)) cover(i, 0x000000, 0.34);
  if (st.sel >= 0 && mah3d.tiles.has(st.sel)) {
    cover(st.sel, 0xffc93a, 0.42);
    marks.children[marks.children.length - 1].position.y += 0.14;
  }
  if (st.hint) for (const i of st.hint) if (mah3d.tiles.has(i)) cover(i, 0x3aa0ff, 0.5);
  mahRender();
}

document.getElementById('mahjong-btn')?.addEventListener('click', () => createMahjongTab());
tabKinds.mahjong = { title: 'Mahjong', glyph: '🀄', color: '#3fb97f', create: createMahjongTab, onShow: mahOnShow, onClose: mahOnClose, restore: mahRestoreSettings };
