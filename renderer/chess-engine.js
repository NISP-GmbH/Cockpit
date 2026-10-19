// Chess: the rules and a small engine. No DOM - this one file runs in the page (legal moves,
// notation), in a Web Worker (the computer's thinking, so the window never freezes) and in
// node (the tests: move counts against the published perft numbers).
//
// Board: 0x88. A square is rank * 16 + file, a1 = 0, h8 = 0x77; (sq & 0x88) is "off the board".
// A piece is type | (colour << 3). A move is one integer: from | to << 7 | promo << 14 | flag << 17.
(function (root) {
  'use strict';
  const WHITE = 0;
  const BLACK = 1;
  const P = 1;
  const N = 2;
  const B = 3;
  const R = 4;
  const Q = 5;
  const K = 6;
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const F_DOUBLE = 1; // a pawn's two-square first move
  const F_EP = 2; // en passant
  const F_CK = 3; // castle king side
  const F_CQ = 4; // castle queen side
  const KNIGHT_D = [33, 31, 18, 14, -33, -31, -18, -14];
  const KING_D = [1, -1, 16, -16, 17, 15, -17, -15];
  const BISHOP_D = [17, 15, -17, -15];
  const ROOK_D = [1, -1, 16, -16];
  const PIECE_CH = ' pnbrqk';

  const mk = (from, to, promo, flag) => from | (to << 7) | ((promo || 0) << 14) | ((flag || 0) << 17);
  const mFrom = (m) => m & 127;
  const mTo = (m) => (m >> 7) & 127;
  const mPromo = (m) => (m >> 14) & 7;
  const mFlag = (m) => (m >> 17) & 7;
  const sqName = (sq) => 'abcdefgh'[sq & 7] + ((sq >> 4) + 1);
  const sqFromName = (s) => {
    const m = /^([a-h])([1-8])$/.exec(String(s || ''));
    return m ? (m[2].charCodeAt(0) - 49) * 16 + (m[1].charCodeAt(0) - 97) : -1;
  };
  const uci = (m) => sqName(mFrom(m)) + sqName(mTo(m)) + (mPromo(m) ? PIECE_CH[mPromo(m)] : '');

  // Castling rights are bits K=1 Q=2 k=4 q=8; a move from or to one of these squares ends some.
  const CASTLE_MASK = new Int8Array(128).fill(15);
  CASTLE_MASK[0x00] = 15 & ~2;
  CASTLE_MASK[0x07] = 15 & ~1;
  CASTLE_MASK[0x04] = 15 & ~3;
  CASTLE_MASK[0x70] = 15 & ~8;
  CASTLE_MASK[0x77] = 15 & ~4;
  CASTLE_MASK[0x74] = 15 & ~12;

  // Zobrist numbers (two 32-bit halves), from a fixed seed so every run hashes the same.
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const zr = mulberry32(0xc0c4b17);
  const z32 = () => (zr() * 4294967296) | 0;
  const Z_P_LO = new Int32Array(16 * 128).map(z32);
  const Z_P_HI = new Int32Array(16 * 128).map(z32);
  const Z_SIDE = [z32(), z32()];
  const Z_CASTLE_LO = new Int32Array(16).map(z32);
  const Z_CASTLE_HI = new Int32Array(16).map(z32);
  const Z_EP_LO = new Int32Array(8).map(z32);
  const Z_EP_HI = new Int32Array(8).map(z32);

  function Chess(fen) {
    this.board = new Int8Array(128);
    this.kings = [0, 0];
    this.load(fen || START_FEN);
  }
  Chess.prototype.load = function (fen) {
    const parts = String(fen || '').trim().split(/\s+/);
    if (parts.length < 4) throw new Error('not a FEN: ' + fen);
    const rows = parts[0].split('/');
    if (rows.length !== 8) throw new Error('a FEN needs 8 ranks');
    this.board.fill(0);
    const kings = [0, 0];
    for (let r = 0; r < 8; r++) {
      let f = 0;
      for (const ch of rows[r]) {
        if (ch >= '1' && ch <= '8') f += +ch;
        else {
          const t = PIECE_CH.indexOf(ch.toLowerCase());
          if (t < 1 || f > 7) throw new Error('bad FEN rank: ' + rows[r]);
          const color = ch === ch.toLowerCase() ? BLACK : WHITE;
          const sq = (7 - r) * 16 + f;
          this.board[sq] = t | (color << 3);
          if (t === K) {
            this.kings[color] = sq;
            kings[color]++;
          }
          f++;
        }
      }
      if (f !== 8) throw new Error('bad FEN rank: ' + rows[r]);
    }
    if (kings[0] !== 1 || kings[1] !== 1) throw new Error('each side needs exactly one king');
    this.turn = parts[1] === 'b' ? BLACK : WHITE;
    this.castling = 0;
    for (const ch of parts[2]) this.castling |= { K: 1, Q: 2, k: 4, q: 8 }[ch] || 0;
    this.ep = parts[3] === '-' ? -1 : sqFromName(parts[3]);
    this.half = parseInt(parts[4], 10) || 0;
    this.full = parseInt(parts[5], 10) || 1;
    this.stack = [];
    // The en-passant square is part of the position only if a pawn could really take there.
    this.epKey = 0;
    if (this.ep >= 0) {
      const pawnSq = this.ep + (this.turn === WHITE ? -16 : 16);
      const mine = P | (this.turn << 3);
      for (const d of [-1, 1]) {
        const s = pawnSq + d;
        if (!(s & 0x88) && this.board[s] === mine) this.epKey = (this.ep & 7) + 1;
      }
    }
    this._rehash();
    this.reps = [this.key()];
    return this;
  };
  Chess.prototype._rehash = function () {
    let lo = 0;
    let hi = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      const p = this.board[sq];
      if (p) {
        lo ^= Z_P_LO[p * 128 + sq];
        hi ^= Z_P_HI[p * 128 + sq];
      }
    }
    lo ^= Z_CASTLE_LO[this.castling];
    hi ^= Z_CASTLE_HI[this.castling];
    if (this.epKey) {
      lo ^= Z_EP_LO[this.epKey - 1];
      hi ^= Z_EP_HI[this.epKey - 1];
    }
    if (this.turn === BLACK) {
      lo ^= Z_SIDE[0];
      hi ^= Z_SIDE[1];
    }
    this.lo = lo;
    this.hi = hi;
  };
  // One number for the position (53 bits, exact in a double): map key, repetition test.
  Chess.prototype.key = function () {
    return (this.hi & 0x1fffff) * 4294967296 + (this.lo >>> 0);
  };
  Chess.prototype.fen = function () {
    const rows = [];
    for (let r = 7; r >= 0; r--) {
      let s = '';
      let gap = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.board[r * 16 + f];
        if (!p) gap++;
        else {
          if (gap) s += gap;
          gap = 0;
          const ch = PIECE_CH[p & 7];
          s += p >> 3 === WHITE ? ch.toUpperCase() : ch;
        }
      }
      rows.push(s + (gap || ''));
    }
    const c = this.castling;
    const castle = (c & 1 ? 'K' : '') + (c & 2 ? 'Q' : '') + (c & 4 ? 'k' : '') + (c & 8 ? 'q' : '') || '-';
    return [rows.join('/'), this.turn === WHITE ? 'w' : 'b', castle, this.ep >= 0 ? sqName(this.ep) : '-', this.half, this.full].join(' ');
  };
  Chess.prototype.pieceAt = function (sq) {
    const p = this.board[sq];
    return p ? { type: p & 7, color: p >> 3 } : null;
  };

  Chess.prototype.attacked = function (sq, by) {
    const b = this.board;
    const pawn = P | (by << 3);
    let s;
    if (by === WHITE) {
      s = sq - 15;
      if (!(s & 0x88) && b[s] === pawn) return true;
      s = sq - 17;
      if (!(s & 0x88) && b[s] === pawn) return true;
    } else {
      s = sq + 15;
      if (!(s & 0x88) && b[s] === pawn) return true;
      s = sq + 17;
      if (!(s & 0x88) && b[s] === pawn) return true;
    }
    const knight = N | (by << 3);
    for (let i = 0; i < 8; i++) {
      s = sq + KNIGHT_D[i];
      if (!(s & 0x88) && b[s] === knight) return true;
    }
    const king = K | (by << 3);
    for (let i = 0; i < 8; i++) {
      s = sq + KING_D[i];
      if (!(s & 0x88) && b[s] === king) return true;
    }
    for (let i = 0; i < 4; i++) {
      const d = BISHOP_D[i];
      for (s = sq + d; !(s & 0x88); s += d) {
        const p = b[s];
        if (p) {
          if (p >> 3 === by && ((p & 7) === B || (p & 7) === Q)) return true;
          break;
        }
      }
    }
    for (let i = 0; i < 4; i++) {
      const d = ROOK_D[i];
      for (s = sq + d; !(s & 0x88); s += d) {
        const p = b[s];
        if (p) {
          if (p >> 3 === by && ((p & 7) === R || (p & 7) === Q)) return true;
          break;
        }
      }
    }
    return false;
  };
  Chess.prototype.inCheck = function () {
    return this.attacked(this.kings[this.turn], this.turn ^ 1);
  };

  // Every move the pieces can make, king safety not yet checked (see legal()).
  // capsOnly: captures and queen promotions - what the quiet search looks at.
  Chess.prototype.gen = function (capsOnly) {
    const out = [];
    const b = this.board;
    const us = this.turn;
    const them = us ^ 1;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) {
        sq += 7;
        continue;
      }
      const p = b[sq];
      if (!p || p >> 3 !== us) continue;
      const t = p & 7;
      if (t === P) {
        const dir = us === WHITE ? 16 : -16;
        const rank = sq >> 4;
        const last = rank === (us === WHITE ? 6 : 1); // the next step promotes
        const one = sq + dir;
        if (!(one & 0x88) && !b[one]) {
          if (last) {
            out.push(mk(sq, one, Q));
            if (!capsOnly) out.push(mk(sq, one, R), mk(sq, one, B), mk(sq, one, N));
          } else if (!capsOnly) {
            out.push(mk(sq, one));
            if (rank === (us === WHITE ? 1 : 6) && !b[one + dir]) out.push(mk(sq, one + dir, 0, F_DOUBLE));
          }
        }
        for (let dx = -1; dx <= 1; dx += 2) {
          const to = one + dx;
          if (to & 0x88) continue;
          const tp = b[to];
          if (tp && tp >> 3 === them) {
            if (last) {
              out.push(mk(sq, to, Q));
              if (!capsOnly) out.push(mk(sq, to, R), mk(sq, to, B), mk(sq, to, N));
            } else out.push(mk(sq, to));
          } else if (!tp && to === this.ep) out.push(mk(sq, to, 0, F_EP));
        }
      } else if (t === N || t === K) {
        const D = t === N ? KNIGHT_D : KING_D;
        for (let i = 0; i < 8; i++) {
          const to = sq + D[i];
          if (to & 0x88) continue;
          const tp = b[to];
          if (!tp) {
            if (!capsOnly) out.push(mk(sq, to));
          } else if (tp >> 3 === them) out.push(mk(sq, to));
        }
      } else {
        const diag = t === B || t === Q;
        const straight = t === R || t === Q;
        for (let i = 0; i < 8; i++) {
          if (i < 4 ? !diag : !straight) continue;
          const d = i < 4 ? BISHOP_D[i] : ROOK_D[i - 4];
          for (let to = sq + d; !(to & 0x88); to += d) {
            const tp = b[to];
            if (!tp) {
              if (!capsOnly) out.push(mk(sq, to));
            } else {
              if (tp >> 3 === them) out.push(mk(sq, to));
              break;
            }
          }
        }
      }
    }
    if (!capsOnly) {
      // Castling: the right is still there, the squares between are empty, and the king
      // neither stands on, passes over, nor lands on an attacked square.
      const home = us === WHITE ? 0x04 : 0x74;
      const kBit = us === WHITE ? 1 : 4;
      const qBit = us === WHITE ? 2 : 8;
      const rook = R | (us << 3);
      if (b[home] === (K | (us << 3)) && this.castling & (kBit | qBit) && !this.attacked(home, them)) {
        if (this.castling & kBit && !b[home + 1] && !b[home + 2] && b[home + 3] === rook && !this.attacked(home + 1, them) && !this.attacked(home + 2, them)) {
          out.push(mk(home, home + 2, 0, F_CK));
        }
        if (this.castling & qBit && !b[home - 1] && !b[home - 2] && !b[home - 3] && b[home - 4] === rook && !this.attacked(home - 1, them) && !this.attacked(home - 2, them)) {
          out.push(mk(home, home - 2, 0, F_CQ));
        }
      }
    }
    return out;
  };

  Chess.prototype.make = function (m) {
    const b = this.board;
    const us = this.turn;
    const from = m & 127;
    const to = (m >> 7) & 127;
    const promo = (m >> 14) & 7;
    const flag = (m >> 17) & 7;
    const piece = b[from];
    let capSq = to;
    if (flag === F_EP) capSq = to + (us === WHITE ? -16 : 16);
    const captured = b[capSq];
    this.stack.push({ m, captured, castling: this.castling, ep: this.ep, epKey: this.epKey, half: this.half, lo: this.lo, hi: this.hi });
    let lo = this.lo ^ Z_CASTLE_LO[this.castling];
    let hi = this.hi ^ Z_CASTLE_HI[this.castling];
    if (this.epKey) {
      lo ^= Z_EP_LO[this.epKey - 1];
      hi ^= Z_EP_HI[this.epKey - 1];
    }
    if (captured) {
      b[capSq] = 0;
      lo ^= Z_P_LO[captured * 128 + capSq];
      hi ^= Z_P_HI[captured * 128 + capSq];
    }
    b[from] = 0;
    lo ^= Z_P_LO[piece * 128 + from];
    hi ^= Z_P_HI[piece * 128 + from];
    const placed = promo ? promo | (us << 3) : piece;
    b[to] = placed;
    lo ^= Z_P_LO[placed * 128 + to];
    hi ^= Z_P_HI[placed * 128 + to];
    if ((piece & 7) === K) this.kings[us] = to;
    if (flag === F_CK || flag === F_CQ) {
      const rFrom = flag === F_CK ? to + 1 : to - 2;
      const rTo = flag === F_CK ? to - 1 : to + 1;
      const rook = b[rFrom];
      b[rFrom] = 0;
      b[rTo] = rook;
      lo ^= Z_P_LO[rook * 128 + rFrom] ^ Z_P_LO[rook * 128 + rTo];
      hi ^= Z_P_HI[rook * 128 + rFrom] ^ Z_P_HI[rook * 128 + rTo];
    }
    this.castling &= CASTLE_MASK[from] & CASTLE_MASK[to];
    this.ep = -1;
    this.epKey = 0;
    if (flag === F_DOUBLE) {
      this.ep = (from + to) >> 1;
      const enemyPawn = P | ((us ^ 1) << 3);
      if ((!((to - 1) & 0x88) && b[to - 1] === enemyPawn) || (!((to + 1) & 0x88) && b[to + 1] === enemyPawn)) this.epKey = (to & 7) + 1;
    }
    this.half = (piece & 7) === P || captured ? 0 : this.half + 1;
    if (us === BLACK) this.full++;
    this.turn = us ^ 1;
    lo ^= Z_CASTLE_LO[this.castling] ^ Z_SIDE[0];
    hi ^= Z_CASTLE_HI[this.castling] ^ Z_SIDE[1];
    if (this.epKey) {
      lo ^= Z_EP_LO[this.epKey - 1];
      hi ^= Z_EP_HI[this.epKey - 1];
    }
    this.lo = lo;
    this.hi = hi;
    this.reps.push(this.key());
    return captured;
  };
  Chess.prototype.undo = function () {
    const u = this.stack.pop();
    if (!u) return false;
    this.reps.pop();
    const b = this.board;
    const us = this.turn ^ 1;
    this.turn = us;
    const m = u.m;
    const from = m & 127;
    const to = (m >> 7) & 127;
    const promo = (m >> 14) & 7;
    const flag = (m >> 17) & 7;
    const piece = promo ? P | (us << 3) : b[to];
    b[from] = piece;
    b[to] = 0;
    if (flag === F_EP) b[to + (us === WHITE ? -16 : 16)] = u.captured;
    else if (u.captured) b[to] = u.captured;
    if ((piece & 7) === K) this.kings[us] = from;
    if (flag === F_CK) {
      b[to + 1] = b[to - 1];
      b[to - 1] = 0;
    } else if (flag === F_CQ) {
      b[to - 2] = b[to + 1];
      b[to + 1] = 0;
    }
    this.castling = u.castling;
    this.ep = u.ep;
    this.epKey = u.epKey;
    this.half = u.half;
    this.lo = u.lo;
    this.hi = u.hi;
    if (us === BLACK) this.full--;
    return true;
  };
  // The moves that do not leave your own king attacked.
  Chess.prototype.legal = function () {
    const us = this.turn;
    const out = [];
    for (const m of this.gen(false)) {
      this.make(m);
      if (!this.attacked(this.kings[us], us ^ 1)) out.push(m);
      this.undo();
    }
    return out;
  };
  // K v K, K+minor v K, or only bishops that all stand on one colour: nobody can mate.
  Chess.prototype.insufficient = function () {
    let minors = 0;
    let bishopsOn = 0; // bit 1: a bishop on a light square, bit 2: on a dark one
    let knights = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      const t = this.board[sq] & 7;
      if (t === P || t === R || t === Q) return false;
      if (t === N) {
        minors++;
        knights++;
      } else if (t === B) {
        minors++;
        bishopsOn |= ((sq >> 4) + (sq & 7)) & 1 ? 1 : 2;
      }
    }
    if (minors <= 1) return true;
    return knights === 0 && bishopsOn !== 3;
  };
  Chess.prototype.repetitions = function () {
    const k = this.reps[this.reps.length - 1];
    let n = 0;
    for (let i = this.reps.length - 1; i >= 0; i--) if (this.reps[i] === k) n++;
    return n;
  };
  Chess.prototype.status = function () {
    const moves = this.legal();
    const check = this.inCheck();
    if (!moves.length) return { over: true, check, result: check ? 'checkmate' : 'stalemate', winner: check ? this.turn ^ 1 : null };
    if (this.insufficient()) return { over: true, check, result: 'draw-material', winner: null };
    if (this.half >= 100) return { over: true, check, result: 'draw-50', winner: null };
    if (this.repetitions() >= 3) return { over: true, check, result: 'draw-repetition', winner: null };
    return { over: false, check, result: null, winner: null };
  };
  // Standard notation ("Nf3", "exd5", "O-O", "e8=Q#"). Call BEFORE making the move.
  Chess.prototype.san = function (m, legal) {
    const b = this.board;
    const from = mFrom(m);
    const to = mTo(m);
    const flag = mFlag(m);
    const t = b[from] & 7;
    let s;
    if (flag === F_CK) s = 'O-O';
    else if (flag === F_CQ) s = 'O-O-O';
    else {
      const capture = !!b[to] || flag === F_EP;
      if (t === P) {
        s = (capture ? 'abcdefgh'[from & 7] + 'x' : '') + sqName(to) + (mPromo(m) ? '=' + PIECE_CH[mPromo(m)].toUpperCase() : '');
      } else {
        s = PIECE_CH[t].toUpperCase();
        const twins = (legal || this.legal()).filter((o) => o !== m && mTo(o) === to && mFrom(o) !== from && (b[mFrom(o)] & 7) === t);
        if (twins.length) {
          const sameFile = twins.some((o) => (mFrom(o) & 7) === (from & 7));
          const sameRank = twins.some((o) => mFrom(o) >> 4 === from >> 4);
          if (!sameFile) s += 'abcdefgh'[from & 7];
          else if (!sameRank) s += (from >> 4) + 1;
          else s += sqName(from);
        }
        s += (capture ? 'x' : '') + sqName(to);
      }
    }
    this.make(m);
    if (this.inCheck()) s += this.legal().length ? '+' : '#';
    this.undo();
    return s;
  };
  Chess.prototype.findUci = function (text) {
    const want = String(text || '').toLowerCase();
    return this.legal().find((m) => uci(m) === want) || 0;
  };
  // A game from its start and its moves ("e2e4", ...). Stops at the first move that is not legal.
  function replay(fen, moves) {
    const g = new Chess(fen || START_FEN);
    for (const u of moves || []) {
      const m = g.findUci(u);
      if (!m) break;
      g.make(m);
    }
    return g;
  }
  function perft(g, depth) {
    if (depth === 0) return 1;
    const us = g.turn;
    let n = 0;
    for (const m of g.gen(false)) {
      g.make(m);
      if (!g.attacked(g.kings[us], us ^ 1)) n += depth === 1 ? 1 : perft(g, depth - 1);
      g.undo();
    }
    return n;
  }

  // ---- the computer ----
  // Material, piece-square tables (the classic "simplified evaluation" set), the bishop pair,
  // and in a won endgame a push of the bare king to the edge - without that a shallow search
  // shuffles a queen about and never mates.
  const VAL = [0, 100, 320, 330, 500, 900, 0];
  // prettier-ignore
  const PST = [null,
    [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5, 0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
    [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30, -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
    [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10, -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
    [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
    [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5, 0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
    [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10, 20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20],
  ];
  // prettier-ignore
  const KING_END = [-50,-40,-30,-20,-20,-30,-40,-50, -30,-20,-10,0,0,-10,-20,-30, -30,-10,20,30,30,20,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,20,30,30,20,-10,-30, -30,-30,0,0,0,0,-30,-30, -50,-30,-30,-30,-30,-30,-30,-50];
  const PHASE = [0, 0, 1, 1, 2, 4, 0];
  const MATE = 100000;
  const INF = 1000000;

  // The score of the position for the side to move, in hundredths of a pawn.
  function evaluate(g) {
    const b = g.board;
    let mat = [0, 0];
    let pst = [0, 0];
    let phase = 0;
    let pawns = 0;
    const bishops = [0, 0];
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) {
        sq += 7;
        continue;
      }
      const p = b[sq];
      if (!p) continue;
      const t = p & 7;
      const c = p >> 3;
      if (t === K) continue;
      const r = sq >> 4;
      const idx = (c === WHITE ? 7 - r : r) * 8 + (sq & 7);
      mat[c] += VAL[t];
      pst[c] += PST[t][idx];
      phase += PHASE[t];
      if (t === P) pawns++;
      if (t === B) bishops[c]++;
    }
    if (!pawns && mat[0] <= 330 && mat[1] <= 330) return 0; // nobody can mate
    if (phase > 24) phase = 24;
    let s = mat[0] - mat[1] + pst[0] - pst[1];
    if (bishops[0] >= 2) s += 30;
    if (bishops[1] >= 2) s -= 30;
    for (let c = 0; c < 2; c++) {
      const k = g.kings[c];
      const idx = (c === WHITE ? 7 - (k >> 4) : k >> 4) * 8 + (k & 7);
      const ks = (PST[K][idx] * phase + KING_END[idx] * (24 - phase)) / 24;
      s += c === WHITE ? ks : -ks;
    }
    if (phase <= 8) {
      const lead = mat[0] - mat[1];
      if (Math.abs(lead) >= 400) {
        const strong = lead > 0 ? WHITE : BLACK;
        const wk = g.kings[strong];
        const lk = g.kings[strong ^ 1];
        const edge = Math.max(Math.abs((lk & 7) * 2 - 7), Math.abs((lk >> 4) * 2 - 7)); // 1 centre .. 7 edge
        const apart = Math.abs((wk & 7) - (lk & 7)) + Math.abs((wk >> 4) - (lk >> 4));
        const push = edge * 12 + (14 - apart) * 6;
        s += strong === WHITE ? push : -push;
      }
    }
    s = Math.round(s);
    return g.turn === WHITE ? s : -s;
  }

  function Searcher(g) {
    this.g = g;
    this.tt = new Map();
    this.killers = [];
    this.hist = new Int32Array(16 * 128);
    this.nodes = 0;
    this.stop = false;
    this.deadline = Infinity;
    this.rootBest = 0;
    this.rootScore = 0;
  }
  Searcher.prototype.order = function (moves, ttMove, ply) {
    const b = this.g.board;
    const k = this.killers[ply] || [0, 0];
    const scored = moves.map((m) => {
      let s;
      const to = (m >> 7) & 127;
      const victim = b[to] & 7;
      if (m === ttMove) s = 1e7;
      else if (victim || mFlag(m) === F_EP) s = 1e6 + (victim || P) * 100 - (b[m & 127] & 7);
      else if (mPromo(m)) s = 9e5 + mPromo(m);
      else if (m === k[0]) s = 8e5;
      else if (m === k[1]) s = 7e5;
      else s = this.hist[b[m & 127] * 128 + to];
      return { m, s };
    });
    scored.sort((x, y) => y.s - x.s);
    return scored;
  };
  // Captures only, until the position is quiet: never stop the search mid-exchange.
  Searcher.prototype.qs = function (alpha, beta, ply) {
    const g = this.g;
    if ((++this.nodes & 2047) === 0 && Date.now() > this.deadline) this.stop = true;
    if (this.stop) return 0;
    const stand = evaluate(g);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    if (ply > 48) return stand;
    const us = g.turn;
    const moves = this.order(g.gen(true), 0, ply);
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i].m;
      g.make(m);
      if (g.attacked(g.kings[us], us ^ 1)) {
        g.undo();
        continue;
      }
      const s = -this.qs(-beta, -alpha, ply + 1);
      g.undo();
      if (this.stop) return 0;
      if (s >= beta) return s;
      if (s > alpha) alpha = s;
    }
    return alpha;
  };
  Searcher.prototype.ab = function (depth, alpha, beta, ply) {
    const g = this.g;
    if ((++this.nodes & 2047) === 0 && Date.now() > this.deadline) this.stop = true;
    if (this.stop) return 0;
    if (ply > 0) {
      if (g.half >= 100) return 0;
      // a position seen before on this line (or in the game) is a draw: do not walk in circles
      const reps = g.reps;
      const key = reps[reps.length - 1];
      for (let i = reps.length - 3, n = g.half; i >= 0 && n >= 2; i -= 2, n -= 2) if (reps[i] === key) return 0;
    }
    const inCheck = g.inCheck();
    if (inCheck && ply < 30) depth++; // look one move further when in check
    if (depth <= 0) return this.qs(alpha, beta, ply);
    const key = g.key();
    const e = this.tt.get(key);
    let ttMove = 0;
    if (e) {
      ttMove = e.m;
      if (e.d >= depth && ply > 0) {
        let s = e.s;
        if (s > MATE - 1000) s -= ply;
        else if (s < -MATE + 1000) s += ply;
        if (e.f === 0) return s;
        if (e.f === 1 && s >= beta) return s;
        if (e.f === 2 && s <= alpha) return s;
      }
    }
    const us = g.turn;
    const a0 = alpha;
    const moves = this.order(g.gen(false), ttMove, ply);
    let best = -INF;
    let bestMove = 0;
    let legal = 0;
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i].m;
      const quiet = !g.board[(m >> 7) & 127] && mFlag(m) !== F_EP && !mPromo(m);
      const moved = g.board[m & 127];
      g.make(m);
      if (g.attacked(g.kings[us], us ^ 1)) {
        g.undo();
        continue;
      }
      legal++;
      const s = -this.ab(depth - 1, -beta, -alpha, ply + 1);
      g.undo();
      if (this.stop) return 0;
      if (s > best) {
        best = s;
        bestMove = m;
        if (s > alpha) {
          alpha = s;
          if (ply === 0) {
            this.rootBest = m;
            this.rootScore = s;
          }
          if (alpha >= beta) {
            if (quiet) {
              const k = this.killers[ply] || (this.killers[ply] = [0, 0]);
              if (k[0] !== m) {
                k[1] = k[0];
                k[0] = m;
              }
              this.hist[moved * 128 + ((m >> 7) & 127)] += depth * depth;
            }
            break;
          }
        }
      }
    }
    if (!legal) return inCheck ? -MATE + ply : 0;
    let store = best;
    if (store > MATE - 1000) store += ply;
    else if (store < -MATE + 1000) store -= ply;
    if (this.tt.size > 400000) this.tt.clear();
    this.tt.set(key, { d: depth, s: store, f: best <= a0 ? 2 : best >= beta ? 1 : 0, m: bestMove });
    return best;
  };

  // The first moves of well-known openings, so the computer does not open the same way every
  // game (and does not spend its thinking time on move one).
  const BOOK_LINES = [
    'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7',
    'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d3',
    'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 g8f6',
    'e2e4 e7e5 g1f3 g8f6 f3e5 d7d6 e5f3 f6e4',
    'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6',
    'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g7g6',
    'e2e4 c7c5 b1c3 b8c6 g2g3 g7g6',
    'e2e4 e7e6 d2d4 d7d5 b1c3 g8f6 c1g5',
    'e2e4 e7e6 d2d4 d7d5 e4e5 c7c5 c2c3',
    'e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4 c8f5',
    'e2e4 d7d5 e4d5 d8d5 b1c3 d5a5',
    'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7 e2e3',
    'd2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 d5c4',
    'd2d4 d7d5 c2c4 d5c4 g1f3 g8f6 e2e3',
    'd2d4 g8f6 c2c4 e7e6 b1c3 f8b4 e2e3',
    'd2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 g1f3',
    'd2d4 g8f6 c2c4 e7e6 g1f3 b7b6 g2g3',
    'd2d4 d7d5 g1f3 g8f6 c1f4 e7e6',
    'c2c4 e7e5 b1c3 g8f6 g1f3 b8c6',
    'c2c4 g8f6 b1c3 e7e6 e2e4',
    'g1f3 d7d5 d2d4 g8f6 c2c4 e7e6',
    'g1f3 g8f6 c2c4 g7g6 b1c3 f8g7',
  ];
  const BOOK = {};
  for (const line of BOOK_LINES) {
    const ms = line.split(' ');
    for (let i = 0; i < ms.length; i++) {
      const k = ms.slice(0, i).join(' ');
      (BOOK[k] = BOOK[k] || []).push(ms[i]);
    }
  }

  const LEVELS = {
    1: { name: 'Beginner', depth: 1, ms: 300, blunder: 0.3, slack: 120 },
    2: { name: 'Easy', depth: 2, ms: 500, blunder: 0, slack: 45 },
    3: { name: 'Medium', depth: 4, ms: 900 },
    4: { name: 'Hard', depth: 6, ms: 2500 },
    5: { name: 'Expert', depth: 10, ms: 6000 },
  };

  /**
   * The move the computer plays. opts.uciHistory = the game so far (for the opening book, only
   * meaningful from the normal start), opts.rng for the tests, opts.ms / opts.depth override.
   * Returns { move, score, depth, nodes, book } or null when there is no legal move.
   */
  function bestMove(g, level, opts) {
    opts = opts || {};
    const rng = opts.rng || Math.random;
    const L = LEVELS[level] || LEVELS[3];
    const legal = g.legal();
    if (!legal.length) return null;
    if (legal.length === 1) return { move: legal[0], score: 0, depth: 0, nodes: 0, book: false };
    if (level >= 2 && opts.uciHistory && !opts.noBook) {
      const cand = BOOK[opts.uciHistory.join(' ')];
      if (cand) {
        const m = g.findUci(cand[Math.floor(rng() * cand.length)]);
        if (m) return { move: m, score: 0, depth: 0, nodes: 0, book: true };
      }
    }
    const s = new Searcher(g);
    s.deadline = Date.now() + (opts.ms || L.ms);
    const maxDepth = opts.depth || L.depth;
    if (L.slack) {
      // The weak levels: score every move at a shallow depth, then pick among the good ones
      // at random - and now and then (Beginner) any move at all.
      if (L.blunder && rng() < L.blunder) return { move: legal[Math.floor(rng() * legal.length)], score: 0, depth: 0, nodes: 0, book: false };
      const scored = [];
      for (const m of legal) {
        g.make(m);
        const sc = -s.ab(maxDepth - 1, -INF, INF, 1);
        g.undo();
        scored.push({ m, sc });
      }
      scored.sort((a, b) => b.sc - a.sc);
      const top = scored[0].sc;
      // a mate is a mate: even the beginner takes it
      const pool = top > MATE - 1000 ? [scored[0]] : scored.filter((x) => x.sc >= top - L.slack);
      const pick = pool[Math.floor(rng() * pool.length)];
      return { move: pick.m, score: pick.sc, depth: maxDepth, nodes: s.nodes, book: false };
    }
    let best = legal[0];
    let score = 0;
    let reached = 0;
    for (let d = 1; d <= maxDepth; d++) {
      s.rootBest = 0;
      const sc = s.ab(d, -INF, INF, 0);
      if (s.stop) {
        // out of time mid-way: a move that already beat the previous best is still good
        if (s.rootBest) {
          best = s.rootBest;
          score = s.rootScore;
        }
        break;
      }
      if (s.rootBest) best = s.rootBest;
      score = sc;
      reached = d;
      if (Math.abs(sc) > MATE - 1000) break; // a forced mate: no need to look deeper
    }
    return { move: best, score, depth: reached, nodes: s.nodes, book: false };
  }

  // The best move and the score of one position, searched properly (no book, no shortcuts):
  // what the analysis measures every move against.
  function searchPos(g, ms, maxDepth) {
    const st = g.status();
    if (st.over) return { move: 0, score: st.result === 'checkmate' ? -MATE : 0, depth: 0 };
    const s = new Searcher(g);
    s.deadline = Date.now() + ms;
    let best = 0;
    let score = 0;
    let reached = 0;
    for (let d = 1; d <= maxDepth; d++) {
      s.rootBest = 0;
      const sc = s.ab(d, -INF, INF, 0);
      if (s.stop) {
        if (!reached && s.rootBest) {
          best = s.rootBest;
          score = s.rootScore;
        }
        break;
      }
      if (s.rootBest) best = s.rootBest;
      score = sc;
      reached = d;
      if (Math.abs(sc) > MATE - 1000) break;
    }
    if (!best) best = g.legal()[0];
    return { move: best, score, depth: reached };
  }
  /**
   * A game, move by move: how much each move gave away against the best one. Work through it
   * with step() (one position per call - a worker reports progress between calls, the page can
   * breathe), then result():
   *   { moves: [{ ply, uci, san, best, bestSan, loss, tag, why, mover }], evals: [white's score per position] }
   * tag: 'best' | 'ok' | 'inaccuracy' | 'mistake' | 'blunder'. loss is in hundredths of a pawn.
   * The score of a move = what the position was worth before it, minus what it is worth after
   * (both searched the same way), so a move that IS the engine's choice loses nothing.
   */
  function Analysis(fen, moves, opts) {
    opts = opts || {};
    this.g = new Chess(fen || START_FEN);
    this.ucis = (moves || []).slice();
    this.ms = opts.ms || 300;
    this.depth = opts.depth || 5;
    this.i = 0;
    this.pos = []; // per position: { score (for the side to move), best, bestSan, turn }
    this.played = []; // per move: { uci, san }
    this.total = this.ucis.length + 1;
  }
  Analysis.prototype.step = function () {
    if (this.i >= this.total) return true;
    const g = this.g;
    const r = searchPos(g, this.ms, this.depth);
    this.pos.push({ score: r.score, best: r.move ? uci(r.move) : '', bestSan: r.move ? g.san(r.move) : '', turn: g.turn });
    if (this.i < this.ucis.length) {
      const m = g.findUci(this.ucis[this.i]);
      if (!m) {
        this.total = this.i + 1; // a move that is not legal: the game ends here
        this.ucis.length = this.i;
      } else {
        this.played.push({ uci: this.ucis[this.i], san: g.san(m) });
        g.make(m);
      }
    }
    this.i++;
    return this.i >= this.total;
  };
  Analysis.prototype.result = function () {
    const cap = (x) => Math.max(-1500, Math.min(1500, x)); // a mate is "a lot", not a million
    const moves = [];
    for (let k = 0; k < this.played.length && k + 1 < this.pos.length; k++) {
      const before = this.pos[k];
      const after = this.pos[k + 1];
      const isBest = this.played[k].uci === before.best;
      const loss = isBest ? 0 : Math.max(0, cap(before.score) + cap(after.score)); // after is the OTHER side's score
      const tag = isBest ? 'best' : loss >= 300 ? 'blunder' : loss >= 150 ? 'mistake' : loss >= 70 ? 'inaccuracy' : 'ok';
      // In words a mate is not a number of pawns: say which of the two it was.
      const why = isBest ? '' : after.score > MATE - 1000 && before.score > -(MATE - 1000) ? 'allows-mate' : before.score > MATE - 1000 && after.score > -(MATE - 1000) ? 'misses-mate' : '';
      moves.push({ ply: k, uci: this.played[k].uci, san: this.played[k].san, best: before.best, bestSan: before.bestSan, loss, tag, why, mover: before.turn });
    }
    return { moves, evals: this.pos.map((p) => cap(p.turn === WHITE ? p.score : -p.score)) };
  };

  const api = {
    Chess,
    Analysis,
    START_FEN,
    WHITE,
    BLACK,
    P,
    N,
    B,
    R,
    Q,
    K,
    F_DOUBLE,
    F_EP,
    F_CK,
    F_CQ,
    mFrom,
    mTo,
    mPromo,
    mFlag,
    sqName,
    sqFromName,
    uci,
    replay,
    perft,
    evaluate,
    bestMove,
    LEVELS,
    BOOK_LINES,
    MATE,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChessEngine = api;
})(typeof self !== 'undefined' ? self : this);
