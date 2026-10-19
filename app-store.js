'use strict';

const fs = require('fs');

// Local per-day breakdown of time spent in outside apps, attributed to the project that
// was being timed at the moment. Shape:
//   { days: { 'YYYY-MM-DD': { <projectId>: { <app>: seconds } } } }
// Local only (userData/app-activity.json). Stores app names (window titles are dropped by
// the caller unless explicitly opted in). Saves are debounced to spare the disk.
class AppStore {
  constructor(file) {
    this.file = file;
    this.data = this._load();
    this._saveTimer = null;
  }
  _load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      d.days = d.days || {};
      return d;
    } catch (_) {
      return { days: {} };
    }
  }
  _save() {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file); // atomic replace
    } catch (_) {
      /* ignore */
    }
  }
  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._save();
    }, 10000);
  }
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._save();
  }

  bump(day, projectId, app, secs) {
    if (!day || !projectId || !app || !(secs > 0)) return;
    const D = this.data.days[day] || (this.data.days[day] = {});
    const P = D[projectId] || (D[projectId] = {});
    P[app] = (P[app] || 0) + secs;
    this._scheduleSave();
  }

  // Remove one app's tracked time from the given days (across all projects). Used by the
  // "✕" on a row in the Apps breakdown.
  removeApp(app, days) {
    if (!app || !Array.isArray(days)) return { ok: false };
    let changed = false;
    for (const day of days) {
      const D = this.data.days[day];
      if (!D) continue;
      for (const pid of Object.keys(D)) {
        if (D[pid] && D[pid][app] != null) {
          delete D[pid][app];
          changed = true;
          if (!Object.keys(D[pid]).length) delete D[pid];
        }
      }
      if (!Object.keys(D).length) delete this.data.days[day];
    }
    if (changed) this.flush();
    return { ok: true };
  }

  getState() {
    return { days: this.data.days };
  }
  clear() {
    this.data = { days: {} };
    this.flush();
    return { ok: true };
  }
  // Drop days beyond a retention window (keep the newest `keepDays`).
  prune(keepDays) {
    keepDays = keepDays || 400;
    const days = Object.keys(this.data.days).sort();
    if (days.length > keepDays) {
      for (const d of days.slice(0, days.length - keepDays)) delete this.data.days[d];
      this._scheduleSave();
    }
  }
}

module.exports = { AppStore };
