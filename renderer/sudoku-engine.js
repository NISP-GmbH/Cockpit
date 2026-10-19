// Sudoku: making puzzles, solving them the way a person does, and hints. No DOM - it runs in
// the page and in node (the tests).
//
// A grid is 81 numbers, row by row, 0 = empty. Candidates are bit masks: bit d (1..9) set =
// "d is still possible here".
(function (root) {
  'use strict';
  const ALL = 0x3fe; // bits 1..9
  const bit = (d) => 1 << d;
  const count = (m) => {
    let n = 0;
    while (m) {
      m &= m - 1;
      n++;
    }
    return n;
  };
  const digits = (m) => {
    const out = [];
    for (let d = 1; d <= 9; d++) if (m & bit(d)) out.push(d);
    return out;
  };
  const ROW = (i) => Math.floor(i / 9);
  const COL = (i) => i % 9;
  const BOX = (i) => Math.floor(ROW(i) / 3) * 3 + Math.floor(COL(i) / 3);
  // the 27 units (9 rows, 9 columns, 9 boxes) and, for every cell, the 20 cells it shares one with
  const UNITS = [];
  for (let r = 0; r < 9; r++) UNITS.push({ kind: 'row', n: r, cells: Array.from({ length: 9 }, (_, c) => r * 9 + c) });
  for (let c = 0; c < 9; c++) UNITS.push({ kind: 'column', n: c, cells: Array.from({ length: 9 }, (_, r) => r * 9 + c) });
  for (let b = 0; b < 9; b++) {
    const cells = [];
    for (let i = 0; i < 81; i++) if (BOX(i) === b) cells.push(i);
    UNITS.push({ kind: 'box', n: b, cells });
  }
  const PEERS = Array.from({ length: 81 }, (_, i) => {
    const s = new Set();
    for (const u of UNITS) if (u.cells.includes(i)) u.cells.forEach((c) => c !== i && s.add(c));
    return [...s];
  });
  const unitName = (u) => u.kind + ' ' + (u.n + 1);

  function candidatesOf(grid) {
    const cand = new Array(81).fill(0);
    for (let i = 0; i < 81; i++) {
      if (grid[i]) continue;
      let m = ALL;
      for (const p of PEERS[i]) if (grid[p]) m &= ~bit(grid[p]);
      cand[i] = m;
    }
    return cand;
  }
  // Two cells of one unit with the same digit: [i, j] pairs (each cell listed once).
  function conflicts(grid) {
    const bad = new Set();
    for (const u of UNITS) {
      const seen = {};
      for (const c of u.cells) {
        const d = grid[c];
        if (!d) continue;
        if (seen[d] !== undefined) {
          bad.add(c);
          bad.add(seen[d]);
        } else seen[d] = c;
      }
    }
    return [...bad];
  }

  // ---- brute force: how many solutions (up to `limit`), and the first one ----
  function solve(grid, limit, rng) {
    const g = grid.slice();
    const out = { count: 0, solution: null };
    if (conflicts(g).length) return out;
    const step = () => {
      // the empty cell with the fewest candidates
      let best = -1;
      let bestMask = 0;
      let bestN = 10;
      for (let i = 0; i < 81; i++) {
        if (g[i]) continue;
        let m = ALL;
        for (const p of PEERS[i]) if (g[p]) m &= ~bit(g[p]);
        const n = count(m);
        if (n < bestN) {
          best = i;
          bestMask = m;
          bestN = n;
          if (n <= 1) break;
        }
      }
      if (best === -1) {
        out.count++;
        if (!out.solution) out.solution = g.slice();
        return;
      }
      if (!bestN) return;
      const ds = digits(bestMask);
      if (rng) {
        for (let k = ds.length - 1; k > 0; k--) {
          const j = Math.floor(rng() * (k + 1));
          [ds[k], ds[j]] = [ds[j], ds[k]];
        }
      }
      for (const d of ds) {
        g[best] = d;
        step();
        if (out.count >= limit) break;
      }
      g[best] = 0;
    };
    step();
    return out;
  }

  // ---- solving by reasoning ----
  // Each technique looks at the candidates and either places a digit or rules some out.
  // Level 1: singles. Level 2: locked candidates, naked pairs. Level 3: hidden pairs, naked
  // triples, X-wing. A puzzle these cannot finish is level 4.
  function place(st, i, d) {
    st.grid[i] = d;
    st.cand[i] = 0;
    for (const p of PEERS[i]) st.cand[p] &= ~bit(d);
  }
  const TECH = [
    {
      name: 'naked single',
      level: 1,
      run(st) {
        for (let i = 0; i < 81; i++) {
          if (!st.grid[i] && count(st.cand[i]) === 1) return { place: [i, digits(st.cand[i])[0]], why: 'only one digit is left for this cell' };
        }
        return null;
      },
    },
    {
      name: 'hidden single',
      level: 1,
      run(st) {
        for (const u of UNITS) {
          for (let d = 1; d <= 9; d++) {
            let at = -1;
            let n = 0;
            for (const c of u.cells) {
              if (st.cand[c] & bit(d)) {
                at = c;
                n++;
              }
            }
            if (n === 1) return { place: [at, d], why: 'the only place for ' + d + ' in ' + unitName(u) };
          }
        }
        return null;
      },
    },
    {
      name: 'locked candidates',
      level: 2,
      run(st) {
        for (const u of UNITS) {
          for (let d = 1; d <= 9; d++) {
            const cells = u.cells.filter((c) => st.cand[c] & bit(d));
            if (cells.length < 2 || cells.length > 3) continue;
            // all of them also share ANOTHER unit: d goes from the rest of that unit
            for (const o of UNITS) {
              if (o === u || (u.kind !== 'box' && o.kind !== 'box')) continue;
              if (!cells.every((c) => o.cells.includes(c))) continue;
              const cut = o.cells.filter((c) => !cells.includes(c) && st.cand[c] & bit(d));
              if (cut.length) return { cut: cut.map((c) => [c, bit(d)]), why: d + ' in ' + unitName(u) + ' is confined to ' + unitName(o) };
            }
          }
        }
        return null;
      },
    },
    {
      name: 'naked pair',
      level: 2,
      run(st) {
        for (const u of UNITS) {
          const twos = u.cells.filter((c) => count(st.cand[c]) === 2);
          for (let a = 0; a < twos.length; a++) {
            for (let b = a + 1; b < twos.length; b++) {
              if (st.cand[twos[a]] !== st.cand[twos[b]]) continue;
              const m = st.cand[twos[a]];
              const cut = u.cells.filter((c) => c !== twos[a] && c !== twos[b] && st.cand[c] & m);
              if (cut.length) return { cut: cut.map((c) => [c, m]), why: 'two cells of ' + unitName(u) + ' hold only ' + digits(m).join(' and ') };
            }
          }
        }
        return null;
      },
    },
    {
      name: 'hidden pair',
      level: 3,
      run(st) {
        for (const u of UNITS) {
          const where = {};
          for (let d = 1; d <= 9; d++) where[d] = u.cells.filter((c) => st.cand[c] & bit(d));
          for (let a = 1; a <= 9; a++) {
            if (where[a].length !== 2) continue;
            for (let b = a + 1; b <= 9; b++) {
              if (where[b].length !== 2 || where[a][0] !== where[b][0] || where[a][1] !== where[b][1]) continue;
              const keep = bit(a) | bit(b);
              const cut = where[a].filter((c) => st.cand[c] & ~keep).map((c) => [c, st.cand[c] & ~keep]);
              if (cut.length) return { cut, why: a + ' and ' + b + ' fit only two cells of ' + unitName(u) };
            }
          }
        }
        return null;
      },
    },
    {
      name: 'naked triple',
      level: 3,
      run(st) {
        for (const u of UNITS) {
          const open = u.cells.filter((c) => !st.grid[c] && count(st.cand[c]) <= 3);
          for (let a = 0; a < open.length; a++) {
            for (let b = a + 1; b < open.length; b++) {
              for (let c = b + 1; c < open.length; c++) {
                const m = st.cand[open[a]] | st.cand[open[b]] | st.cand[open[c]];
                if (count(m) !== 3) continue;
                const cut = u.cells.filter((x) => x !== open[a] && x !== open[b] && x !== open[c] && st.cand[x] & m);
                if (cut.length) return { cut: cut.map((x) => [x, m]), why: 'three cells of ' + unitName(u) + ' share ' + digits(m).join(', ') };
              }
            }
          }
        }
        return null;
      },
    },
    {
      name: 'X-wing',
      level: 3,
      run(st) {
        for (const lines of [UNITS.slice(0, 9), UNITS.slice(9, 18)]) {
          const cross = lines[0].kind === 'row' ? COL : ROW; // rows pair up by column, columns by row
          for (let d = 1; d <= 9; d++) {
            const two = lines.map((u) => u.cells.filter((c) => st.cand[c] & bit(d))).filter((cs) => cs.length === 2);
            for (let a = 0; a < two.length; a++) {
              for (let b = a + 1; b < two.length; b++) {
                if (cross(two[a][0]) !== cross(two[b][0]) || cross(two[a][1]) !== cross(two[b][1])) continue;
                const corners = [...two[a], ...two[b]];
                const k0 = cross(two[a][0]);
                const k1 = cross(two[a][1]);
                const cut = [];
                for (let i = 0; i < 81; i++) {
                  if (corners.includes(i) || !(st.cand[i] & bit(d))) continue;
                  if (cross(i) === k0 || cross(i) === k1) cut.push([i, bit(d)]);
                }
                if (cut.length) return { cut, why: 'an X-wing on ' + d };
              }
            }
          }
        }
        return null;
      },
    },
  ];
  // The next thing a person would find, cheapest technique first: { tech, level, place | cut, why }.
  function nextStep(st, maxLevel) {
    for (const t of TECH) {
      if (t.level > (maxLevel || 3)) break;
      const r = t.run(st);
      if (r) return { tech: t.name, level: t.level, ...r };
    }
    return null;
  }
  function applyStep(st, s) {
    if (s.place) place(st, s.place[0], s.place[1]);
    else for (const [c, m] of s.cut) st.cand[c] &= ~m;
  }
  // How hard a puzzle is: the highest level of technique needed. { solved, level, used }.
  function rate(grid, maxLevel) {
    const st = { grid: grid.slice(), cand: candidatesOf(grid) };
    let level = 1;
    const used = {};
    for (let guard = 0; guard < 2000; guard++) {
      if (!st.grid.includes(0)) return { solved: true, level, used, grid: st.grid };
      const s = nextStep(st, maxLevel);
      if (!s) return { solved: false, level: 4, used, grid: st.grid };
      used[s.tech] = (used[s.tech] || 0) + 1;
      if (s.level > level) level = s.level;
      applyStep(st, s);
    }
    return { solved: false, level: 4, used, grid: st.grid };
  }

  // ---- making a puzzle ----
  const LEVELS = {
    1: { name: 'Easy', minGivens: 36 },
    2: { name: 'Medium', minGivens: 30 },
    3: { name: 'Hard', minGivens: 0 },
    4: { name: 'Expert', minGivens: 0 },
  };
  function shuffled(n, rng) {
    const a = Array.from({ length: n }, (_, i) => i);
    for (let k = n - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      [a[k], a[j]] = [a[j], a[k]];
    }
    return a;
  }
  // One attempt: a full grid, then cells taken away in mirrored pairs while the puzzle still
  // stands - "stands" meaning: still solvable with this level's techniques (levels 1-3), or
  // still has exactly one solution (Expert).
  function attempt(level, rng) {
    const solution = solve(new Array(81).fill(0), 1, rng).solution;
    const puzzle = solution.slice();
    let givens = 81;
    const min = LEVELS[level].minGivens;
    for (const i of shuffled(81, rng)) {
      const j = 80 - i; // its mirror through the centre
      if (!puzzle[i]) continue;
      const pair = i === j ? [i] : [i, j];
      if (givens - pair.length < min) continue;
      const kept = pair.map((c) => puzzle[c]);
      pair.forEach((c) => (puzzle[c] = 0));
      const ok = level === 4 ? solve(puzzle, 2).count === 1 : rate(puzzle, level).solved;
      if (ok) givens -= pair.length;
      else pair.forEach((c, k) => (puzzle[c] = kept[k]));
    }
    return { puzzle, solution, givens, rating: rate(puzzle) };
  }
  /** A puzzle of the wanted level: { puzzle, solution, level, rated, givens, tries }. */
  function generate(level, rng, maxTries) {
    rng = rng || Math.random;
    level = LEVELS[level] ? level : 2;
    // An attempt takes a few milliseconds; a Hard one that really needs a hard technique turns
    // up about once in thirty.
    const tries = maxTries || { 1: 6, 2: 40, 3: 250, 4: 80 }[level];
    let best = null;
    for (let t = 1; t <= tries; t++) {
      const a = attempt(level, rng);
      a.level = a.rating.level;
      if (a.level === level) return { puzzle: a.puzzle, solution: a.solution, level, rated: a.level, givens: a.givens, tries: t };
      // the nearest miss, in case none fits: an easier one with few cells given beats a harder one
      const miss = Math.abs(a.level - level) * 100 + a.givens;
      if (!best || miss < best.miss) best = { ...a, miss };
    }
    return { puzzle: best.puzzle, solution: best.solution, level, rated: best.level, givens: best.givens, tries };
  }

  /**
   * A hint for the grid as it stands. `solution` settles what is wrong and what the answer is.
   *  { kind: 'wrong', cell }                         an entry that is not the solution
   *  { kind: 'place', cell, digit, tech, why, first } the next cell a person can settle;
   *                                                   first = techniques needed before it shows
   *  { kind: 'done' }
   */
  function hint(grid, solution) {
    for (let i = 0; i < 81; i++) if (grid[i] && grid[i] !== solution[i]) return { kind: 'wrong', cell: i };
    if (!grid.includes(0)) return { kind: 'done' };
    const st = { grid: grid.slice(), cand: candidatesOf(grid) };
    const first = [];
    for (let guard = 0; guard < 200; guard++) {
      const s = nextStep(st, 3);
      if (!s) break;
      if (s.place) return { kind: 'place', cell: s.place[0], digit: s.place[1], tech: s.tech, why: s.why, first };
      if (!first.includes(s.tech)) first.push(s.tech);
      applyStep(st, s);
    }
    // beyond these techniques: the cell with the fewest candidates, its digit from the solution
    let best = -1;
    for (let i = 0; i < 81; i++) if (!st.grid[i] && (best === -1 || count(st.cand[i]) < count(st.cand[best]))) best = i;
    return { kind: 'place', cell: best, digit: solution[best], tech: 'advanced', why: 'this one needs a longer chain of reasoning', first };
  }
  const parse = (s) => String(s || '').replace(/[^0-9.]/g, '').split('').map((ch) => (ch === '.' ? 0 : +ch));
  const format = (g) => g.join('');

  const api = { generate, solve, rate, hint, conflicts, candidatesOf, parse, format, LEVELS, PEERS, UNITS, bit, digits, count };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SudokuEngine = api;
})(typeof self !== 'undefined' ? self : this);
