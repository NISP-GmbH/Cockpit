// The computer's thinking, off the page's thread: the window stays smooth while it searches.
// A move:     in { id, fen, moves: ['e2e4', ...], level }       out { id, uci, score, depth, book }
// Analysis:   in { id, type: 'analyse', fen, moves, ms, depth } out { id, progress, total } ... then { id, analysis }
// Either can answer { id, error }.
importScripts('chess-engine.js');
self.onmessage = (e) => {
  const { id, type, fen, moves, level, ms, depth } = e.data || {};
  try {
    if (type === 'analyse') {
      const a = new ChessEngine.Analysis(fen, moves, { ms, depth });
      let done = false;
      while (!done) {
        done = a.step();
        self.postMessage({ id, progress: a.i, total: a.total });
      }
      self.postMessage({ id, analysis: a.result() });
      return;
    }
    const g = ChessEngine.replay(fen, moves);
    const fromStart = !fen || fen === ChessEngine.START_FEN;
    const r = ChessEngine.bestMove(g, level, { uciHistory: fromStart ? moves || [] : null });
    self.postMessage({ id, uci: r ? ChessEngine.uci(r.move) : null, score: r ? r.score : 0, depth: r ? r.depth : 0, book: !!(r && r.book) });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
