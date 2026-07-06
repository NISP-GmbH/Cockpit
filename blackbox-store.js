'use strict';

const fs = require('fs');

// Append-only local event log for the Black Box timeline. Stored as JSON Lines in
// userData/blackbox.jsonl. Local only — never transmitted.
class BlackBoxStore {
  constructor(file) {
    this.file = file;
  }

  append(events) {
    if (!Array.isArray(events) || !events.length) return { ok: true };
    let lines = '';
    for (const e of events) {
      try {
        lines += JSON.stringify(e) + '\n';
      } catch (_) {
        /* skip unserializable */
      }
    }
    try {
      fs.appendFileSync(this.file, lines);
    } catch (_) {
      /* ignore write errors */
    }
    return { ok: true };
  }

  _readAll() {
    let txt = '';
    try {
      txt = fs.readFileSync(this.file, 'utf8');
    } catch (_) {
      return [];
    }
    const out = [];
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch (_) {
        /* skip a corrupt line */
      }
    }
    return out;
  }

  query(range) {
    range = range || {};
    const from = range.from || 0;
    const to = range.to || Date.now() + 1;
    let res = this._readAll().filter((e) => e && e.ts >= from && e.ts <= to);
    const limit = range.limit || 4000;
    if (res.length > limit) res = res.slice(-limit);
    return res;
  }

  clear() {
    try {
      fs.writeFileSync(this.file, '');
    } catch (_) {
      /* ignore */
    }
    return { ok: true };
  }

  stats() {
    let size = 0;
    let count = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch (_) {
      /* no file yet */
    }
    try {
      count = this._readAll().length;
    } catch (_) {
      /* ignore */
    }
    return { size, count };
  }

  // Drop events older than `days`, and hard-cap total events. Rewrites the file.
  trim(days) {
    const cutoff = Date.now() - (days || 14) * 86400000;
    const all = this._readAll();
    let kept = all.filter((e) => e && e.ts >= cutoff);
    if (kept.length > 50000) kept = kept.slice(-50000);
    if (kept.length !== all.length) {
      try {
        fs.writeFileSync(this.file, kept.length ? kept.map((e) => JSON.stringify(e)).join('\n') + '\n' : '');
      } catch (_) {
        /* ignore */
      }
    }
    return { ok: true, kept: kept.length };
  }
}

module.exports = { BlackBoxStore };
