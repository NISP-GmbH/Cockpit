// The games registry. Each game file (chess.js, mahjong.js, sudoku.js) adds one entry:
//   gameTabs.<kind> = { title, glyph, color, create, onShow, onClose, restore }
// and renderer.js handles every game tab through it - the tab glyph, showing, closing, the
// saved tab order, the restart, the 3D overview - so a new game needs no edit there.
// Loaded before the game files and before renderer.js.
const gameTabs = {};

// "Games" in the ＋ New menu opens its own small menu to the right (hover, or a click for touch
// and keyboard). The click must not reach the main menu, which closes on any click inside it.
document.getElementById('games-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  e.currentTarget.parentElement.classList.toggle('open');
});

// A small seeded random source (mulberry32), shared by the games: the same seed gives the
// same wood grain, the same deal.
function gameRng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// m:ss, or h:mm:ss past an hour
function gameClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
}

// A short wooden knock, made on the spot (no sound files). Silent in a meeting.
let gameAudio = null;
function gameSound(kind) {
  if (typeof inMeeting === 'function' && inMeeting()) return;
  try {
    const ctx = gameAudio || (gameAudio = new (window.AudioContext || window.webkitAudioContext)());
    const knock = (at, vol, pitch) => {
      const len = Math.floor(ctx.sampleRate * 0.06);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = pitch;
      bp.Q.value = 1.4;
      const gain = ctx.createGain();
      gain.gain.value = vol;
      src.connect(bp).connect(gain).connect(ctx.destination);
      src.start(ctx.currentTime + at);
      const osc = ctx.createOscillator();
      const og = ctx.createGain();
      osc.frequency.setValueAtTime(pitch * 0.22, ctx.currentTime + at);
      osc.frequency.exponentialRampToValueAtTime(pitch * 0.1, ctx.currentTime + at + 0.08);
      og.gain.setValueAtTime(vol * 0.9, ctx.currentTime + at);
      og.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + 0.09);
      osc.connect(og).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.1);
    };
    if (kind === 'tick') return knock(0, 0.1, 1700); // a light touch: picking something up
    knock(0, 0.22, 950);
    if (kind === 'capture') knock(0.07, 0.18, 700);
    if (kind === 'check' || kind === 'end') knock(0.1, 0.16, 1500);
    if (kind === 'end') knock(0.22, 0.16, 1100);
  } catch (_) {
    /* no audio: play on in silence */
  }
}

// A game's keys are heard on its pane, so the pane must hold the keyboard focus - and a click
// can take it away. After a mousedown the browser focuses the nearest focusable ancestor of the
// element that was clicked, but it looks AFTER the handlers ran: a handler that redraws
// (innerHTML) has by then removed that element from the page, nothing focusable is found, and
// the focus falls to <body>. The next key goes nowhere. (Sudoku: click a cell that holds notes,
// type a digit - nothing. A cell without notes worked, which made it look random.)
// So: after every click inside the pane, and after a choice in a select or a checkbox, the pane
// takes the focus back. A select is left alone while it is open.
function gameKeepFocus(pane) {
  const back = (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('select, textarea, input:not([type="checkbox"])')) return;
    if (document.activeElement !== pane) pane.focus({ preventScroll: true });
  };
  pane.addEventListener('mouseup', back);
  pane.addEventListener('click', back);
  pane.addEventListener('contextmenu', back);
  pane.addEventListener('change', () => pane.focus({ preventScroll: true }));
}
