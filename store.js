'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Tiny JSON-file session store. Stores connection profiles only — never secrets
 * (passwords/passphrases are entered at connect time).
 */
class Store {
  /**
   * @param {string} userDataDir result of app.getPath('userData')
   */
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'sessions.json');
    this.settingsFile = path.join(userDataDir, 'settings.json');
  }

  /** @returns {object} persisted UI settings (e.g. { fontSize }) */
  loadSettings() {
    try {
      return JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) || {};
    } catch (_) {
      return {};
    }
  }

  /** @param {object} settings merged over existing settings, then written atomically */
  saveSettings(settings) {
    const merged = { ...this.loadSettings(), ...(settings || {}) };
    // Write to a temp file then rename, so a concurrent reader never sees a
    // half-written file (which would parse as empty and clobber everything).
    const tmp = this.settingsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
    fs.renameSync(tmp, this.settingsFile);
    return merged;
  }

  /** @returns {Array<object>} list of saved sessions */
  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.sessions)) return data.sessions;
      return [];
    } catch (_) {
      return [];
    }
  }

  /** @param {Array<object>} sessions */
  save(sessions) {
    const safe = (sessions || []).map((s) => ({
      name: s.name,
      host: s.host,
      port: s.port || 22,
      username: s.username,
      authMethod: s.authMethod || 'agent',
      keyPath: s.keyPath || '',
    }));
    fs.writeFileSync(this.file, JSON.stringify(safe, null, 2), 'utf8');
    return safe;
  }
}

module.exports = { Store };
