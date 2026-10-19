// Mahjong solitaire: the layout, which tiles are free, and deals that can be solved. No DOM -
// it runs in the page and in node (the tests).
//
// A position is { x, y, z } in HALF tiles (a tile covers 2 x 2), z = the layer. A tile is free
// when nothing lies on it and its left or its right side is open.
(function (root) {
  'use strict';
  // The classic "turtle": 144 tiles in five layers.
  function turtle() {
    const out = [];
    const row = (y, x0, x1, z) => {
      for (let x = x0; x <= x1; x += 2) out.push({ x, y, z });
    };
    row(0, 2, 24, 0);
    row(2, 6, 20, 0);
    row(4, 4, 22, 0);
    row(6, 2, 24, 0);
    row(8, 2, 24, 0);
    row(10, 4, 22, 0);
    row(12, 6, 20, 0);
    row(14, 2, 24, 0);
    out.push({ x: 0, y: 7, z: 0 }, { x: 26, y: 7, z: 0 }, { x: 28, y: 7, z: 0 }); // the head and the tail
    for (let y = 2; y <= 12; y += 2) row(y, 8, 18, 1);
    for (let y = 4; y <= 10; y += 2) row(y, 10, 16, 2);
    for (let y = 6; y <= 8; y += 2) row(y, 12, 14, 3);
    out.push({ x: 13, y: 7, z: 4 }); // the cap, on the four below
    return out;
  }
  const LAYOUT = turtle();
  const N = LAYOUT.length; // 144
  // for every tile: the tiles that can lie on it, and those at its left and right
  const ABOVE = [];
  const LEFT = [];
  const RIGHT = [];
  for (let i = 0; i < N; i++) {
    const a = LAYOUT[i];
    ABOVE.push([]);
    LEFT.push([]);
    RIGHT.push([]);
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const b = LAYOUT[j];
      const overlapY = Math.abs(b.y - a.y) < 2;
      if (b.z === a.z + 1 && Math.abs(b.x - a.x) < 2 && overlapY) ABOVE[i].push(j);
      if (b.z === a.z && overlapY) {
        if (b.x === a.x - 2) LEFT[i].push(j);
        if (b.x === a.x + 2) RIGHT[i].push(j);
      }
    }
  }
  // The faces: 0-8 dots, 9-17 bamboo, 18-26 characters, 27-30 winds (E S W N), 31-33 dragons
  // (red, green, white), 34-37 flowers, 38-41 seasons. Four of each, except the flowers and the
  // seasons: one of each, and any flower matches any flower, any season any season.
  const FACES = 42;
  const matchKey = (f) => (f < 34 ? f : f < 38 ? 34 : 38);
  const matches = (a, b) => matchKey(a) === matchKey(b);
  const faceName = (f) => {
    if (f < 9) return f + 1 + ' of dots';
    if (f < 18) return f - 8 + ' of bamboo';
    if (f < 27) return f - 17 + ' of characters';
    if (f < 31) return ['east', 'south', 'west', 'north'][f - 27] + ' wind';
    if (f < 34) return ['red', 'green', 'white'][f - 31] + ' dragon';
    if (f < 38) return 'flower ' + (f - 33);
    return 'season ' + (f - 37);
  };

  // gone: a Set (or an array of booleans) of the tiles already taken
  const has = (gone, i) => (gone instanceof Set ? gone.has(i) : !!gone[i]);
  function isFree(i, gone) {
    if (has(gone, i)) return false;
    for (const j of ABOVE[i]) if (!has(gone, j)) return false;
    let left = false;
    for (const j of LEFT[i]) {
      if (!has(gone, j)) {
        left = true;
        break;
      }
    }
    if (!left) return true;
    for (const j of RIGHT[i]) if (!has(gone, j)) return false;
    return true;
  }
  function freeTiles(gone) {
    const out = [];
    for (let i = 0; i < N; i++) if (isFree(i, gone)) out.push(i);
    return out;
  }
  // Every pair that could be taken now: [[i, j], ...].
  function pairs(faces, gone) {
    const free = freeTiles(gone);
    const out = [];
    for (let a = 0; a < free.length; a++) {
      for (let b = a + 1; b < free.length; b++) if (matches(faces[free[a]], faces[free[b]])) out.push([free[a], free[b]]);
    }
    return out;
  }
  function shuffle(a, rng) {
    for (let k = a.length - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      [a[k], a[j]] = [a[j], a[k]];
    }
    return a;
  }
  // Put `facePairs` on the tiles still on the table so that the game CAN be won: play it
  // backwards - take two free tiles, give them a pair, take them away, and so on. Now and then
  // that walks into a corner (one tile on another at the very end); then it starts over.
  function place(facePairs, gone, rng) {
    const total = facePairs.length * 2;
    for (let tries = 0; tries < 400; tries++) {
      const taken = new Set(gone instanceof Set ? gone : []);
      if (!(gone instanceof Set)) for (let i = 0; i < N; i++) if (gone[i]) taken.add(i);
      const faces = new Array(N).fill(-1);
      const order = shuffle(facePairs.slice(), rng);
      const solution = []; // the pairs in an order that clears the table
      let done = 0;
      for (const p of order) {
        const free = freeTiles(taken);
        if (free.length < 2) break;
        const a = free[Math.floor(rng() * free.length)];
        let b = a;
        while (b === a) b = free[Math.floor(rng() * free.length)];
        faces[a] = p[0];
        faces[b] = p[1];
        taken.add(a);
        taken.add(b);
        solution.push([a, b]);
        done += 2;
      }
      if (done === total) return { faces, solution };
    }
    return null;
  }
  // A fresh game: the 144 faces, one per tile of the layout, in a winnable arrangement.
  function deal(rng) {
    rng = rng || Math.random;
    const fp = [];
    for (let f = 0; f < 34; f++) fp.push([f, f], [f, f]);
    const fl = shuffle([34, 35, 36, 37], rng);
    const se = shuffle([38, 39, 40, 41], rng);
    fp.push([fl[0], fl[1]], [fl[2], fl[3]], [se[0], se[1]], [se[2], se[3]]);
    return place(fp, new Set(), rng);
  }
  // deal: { faces, solution } - solution is one order of pairs that wins (the proof it can be won)
  // Stuck? Mix the faces of the tiles that are left - again so that it can be won, when the
  // shape of what is left allows that at all. { faces, winnable }.
  function reshuffle(faces, gone, rng) {
    rng = rng || Math.random;
    const left = [];
    for (let i = 0; i < N; i++) if (!has(gone, i)) left.push(i);
    const byKey = {};
    for (const i of left) (byKey[matchKey(faces[i])] = byKey[matchKey(faces[i])] || []).push(faces[i]);
    const fp = [];
    for (const k of Object.keys(byKey)) {
      const fs = shuffle(byKey[k], rng);
      for (let i = 0; i + 1 < fs.length; i += 2) fp.push([fs[i], fs[i + 1]]);
    }
    const goneSet = new Set();
    for (let i = 0; i < N; i++) if (has(gone, i)) goneSet.add(i);
    const placed = place(fp, goneSet, rng);
    const out = faces.slice();
    if (placed) {
      for (const i of left) out[i] = placed.faces[i];
      return { faces: out, winnable: true, solution: placed.solution };
    }
    // two tiles, one on the other: no order of play clears that. Mix them anyway.
    const mixed = shuffle(left.map((i) => faces[i]), rng);
    left.forEach((i, k) => (out[i] = mixed[k]));
    return { faces: out, winnable: false };
  }

  const api = { LAYOUT, N, FACES, ABOVE, LEFT, RIGHT, matchKey, matches, faceName, isFree, freeTiles, pairs, deal, reshuffle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MahjongEngine = api;
})(typeof self !== 'undefined' ? self : this);
