'use strict';

const fs = require('fs');

// Local project time-accounting store. Time is recorded as SEGMENTS
// [{projectId, start, end}] (ms timestamps) so we know exactly when work happened -
// which lets the Black Box show a project lane and reassign past blocks. Daily/monthly
// totals are derived from segments. Local only (userData/projects.json).
class ProjectStore {
  constructor(file) {
    this.file = file;
    this.data = this._load();
    this._finalizeOpen(); // a new process: any segment left "open" is stale
    this._migrateDays();
    this._ensureIds(); // every segment gets a stable id (for edit/delete/notes)
  }

  _load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      d.projects = d.projects || [];
      d.segments = d.segments || [];
      return d;
    } catch (_) {
      return { projects: [], currentProjectId: null, running: false, segments: [] };
    }
  }
  _save() {
    this._ensureIds();
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch (_) {
      /* ignore */
    }
  }
  _finalizeOpen() {
    for (const s of this.data.segments) if (s.open) delete s.open;
  }
  _newId() {
    return 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }
  _ensureIds() {
    for (const s of this.data.segments) if (!s.id) s.id = this._newId();
  }
  // One-time upgrade from the old daily-aggregate model: lay each day's totals out
  // as back-to-back segments from 09:00 (approximate placement; we never had exact
  // times for that historical data).
  _migrateDays() {
    if (!this.data.days || !Object.keys(this.data.days).length) {
      delete this.data.days;
      return;
    }
    for (const [date, map] of Object.entries(this.data.days)) {
      const [y, mo, d] = date.split('-').map(Number);
      let t = new Date(y, (mo || 1) - 1, d || 1, 9, 0, 0).getTime();
      for (const [pid, secs] of Object.entries(map)) {
        const s = Math.round(secs);
        if (s > 0) {
          this.data.segments.push({ projectId: pid, start: t, end: t + s * 1000 });
          t += s * 1000;
        }
      }
    }
    delete this.data.days;
    this._save();
  }

  getState() {
    return {
      projects: this.data.projects,
      currentProjectId: this.data.currentProjectId,
      running: !!this.data.running,
      segments: this.data.segments,
    };
  }

  addProject(name, color) {
    const id = 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    const proj = { id, name: String(name || 'Project').slice(0, 60), color: color || '#4ea1ff', lastUsed: Date.now() };
    this.data.projects.push(proj);
    this._save();
    return proj;
  }
  // Delete a project. Its time is reassigned to `reassignToId` if given, otherwise removed.
  deleteProject(id, reassignToId) {
    const idx = this.data.projects.findIndex((p) => p.id === id);
    if (idx === -1) return { ok: false };
    const hasTarget = reassignToId && this.data.projects.some((p) => p.id === reassignToId);
    if (hasTarget) {
      for (const s of this.data.segments) if (s.projectId === id) s.projectId = reassignToId;
    } else {
      this.data.segments = this.data.segments.filter((s) => s.projectId !== id);
    }
    this.data.projects.splice(idx, 1);
    if (this.data.currentProjectId === id) {
      this.data.currentProjectId = hasTarget ? reassignToId : null;
      this.data.running = false;
    }
    this._mergeAdjacent();
    this._save();
    return { ok: true };
  }
  rename(id, name) {
    const p = this.data.projects.find((x) => x.id === id);
    if (p) {
      p.name = String(name || p.name).slice(0, 60);
      this._save();
    }
    return { ok: true };
  }
  setColor(id, color) {
    const p = this.data.projects.find((x) => x.id === id);
    if (p) {
      p.color = color;
      this._save();
    }
    return { ok: true };
  }
  setCurrent(id) {
    this.data.currentProjectId = id;
    const p = this.data.projects.find((x) => x.id === id);
    if (p) p.lastUsed = Date.now();
    this._save();
    return { ok: true };
  }
  setRunning(on) {
    this.data.running = !!on;
    this._save();
    return { ok: true };
  }

  // Replace the whole segment array (used by the renderer's undo/revert).
  setSegments(segments) {
    if (Array.isArray(segments)) {
      this.data.segments = segments.map((s) => ({
        ...(s.id ? { id: s.id } : {}),
        projectId: s.projectId,
        start: s.start,
        end: s.end,
        ...(s.note ? { note: s.note } : {}),
        ...(s.open ? { open: true } : {}),
      }));
      this._save();
    }
    return { ok: true };
  }

  // --- Manual entry & correction ---
  // Clip/split every other (closed) segment so nothing overlaps [start, end] -
  // keeps totals from double-counting when time is entered or edited by hand.
  _carve(start, end, exceptId) {
    const out = [];
    for (const seg of this.data.segments) {
      if (seg.id === exceptId || seg.open || seg.end <= start || seg.start >= end) {
        out.push(seg);
        continue;
      }
      if (seg.start < start) out.push({ ...seg, id: this._newId(), end: start });
      if (seg.end > end) out.push({ ...seg, id: this._newId(), start: end });
      // the overlapping middle is dropped (now covered by the new/edited entry)
    }
    this.data.segments = out;
  }
  // Add a time block by hand ("worked 2h offline").
  addSegment(projectId, start, end, note) {
    start = Number(start);
    end = Number(end);
    if (!projectId || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { ok: false };
    const seg = { id: this._newId(), projectId, start, end };
    if (note) seg.note = String(note).slice(0, 200);
    this.data.segments.push(seg);
    this._carve(start, end, seg.id);
    this._mergeAdjacent();
    this._save();
    return { ok: true, id: seg.id };
  }
  // Edit one entry's project / start / end / note.
  updateSegment(id, patch) {
    const s = this.data.segments.find((x) => x.id === id);
    if (!s || !patch) return { ok: false };
    const ns = Number.isFinite(patch.start) ? Number(patch.start) : s.start;
    const ne = Number.isFinite(patch.end) ? Number(patch.end) : s.end;
    if (ne <= ns) return { ok: false };
    if (patch.projectId) s.projectId = patch.projectId;
    s.start = ns;
    s.end = ne;
    if (patch.note != null) {
      const n = String(patch.note).slice(0, 200);
      if (n) s.note = n;
      else delete s.note;
    }
    this._carve(s.start, s.end, s.id);
    this._mergeAdjacent();
    this._save();
    return { ok: true };
  }
  deleteSegment(id) {
    const before = this.data.segments.length;
    this.data.segments = this.data.segments.filter((x) => x.id !== id);
    if (this.data.segments.length !== before) this._save();
    return { ok: true };
  }

  _open() {
    const s = this.data.segments;
    return s.length && s[s.length - 1].open ? s[s.length - 1] : null;
  }
  _closeOpen(end) {
    const s = this._open();
    if (s) {
      s.end = Math.max(s.end, end);
      delete s.open;
    }
  }
  // Timer boundaries, driven by the renderer.
  startSegment(projectId, start) {
    this._closeOpen(start);
    this.data.segments.push({ projectId, start, end: start, open: true });
    this._save();
    return { ok: true };
  }
  touchSegment(end) {
    const s = this._open();
    if (s) {
      s.end = Math.max(s.end, end);
      this._save();
    }
    return { ok: true };
  }
  stopSegment(end) {
    this._closeOpen(end);
    this._save();
    return { ok: true };
  }

  // Reassign a time range to a project, splitting any overlapping segments.
  reassign(start, end, toProjectId) {
    if (!(end > start) || !toProjectId) return { ok: true };
    const out = [];
    for (const seg of this.data.segments) {
      if (seg.end <= start || seg.start >= end || seg.projectId === toProjectId) {
        out.push(seg);
        continue;
      }
      // Head/tail keep the original project, so they keep its note; the reassigned
      // middle changes project and gets no note.
      const keepNote = seg.note ? { note: seg.note } : {};
      if (seg.start < start) out.push({ projectId: seg.projectId, start: seg.start, end: start, ...keepNote });
      const mid = { projectId: toProjectId, start: Math.max(seg.start, start), end: Math.min(seg.end, end) };
      if (seg.end > end) {
        const tail = { projectId: seg.projectId, start: end, end: seg.end, ...keepNote };
        if (seg.open) tail.open = true;
        out.push(mid, tail);
      } else {
        if (seg.open) mid.open = true;
        out.push(mid);
      }
    }
    this.data.segments = out;
    this._mergeAdjacent();
    this._save();
    return { ok: true };
  }

  // Reassign the most recent `seconds` of one project to another (the "⇄ move" chips) -
  // "the last 30 min was actually project B".
  reassignRecent(fromId, toId, seconds) {
    seconds = Math.max(0, Math.round(seconds || 0));
    if (!seconds || !fromId || !toId || fromId === toId) return { ok: true };
    let need = seconds * 1000;
    const segs = this.data.segments;
    for (let i = segs.length - 1; i >= 0 && need > 0; i--) {
      const seg = segs[i];
      if (seg.projectId !== fromId) continue;
      const dur = seg.end - seg.start;
      if (dur <= need) {
        seg.projectId = toId;
        need -= dur;
      } else {
        const origEnd = seg.end;
        const cut = origEnd - need;
        const openFlag = seg.open;
        if (openFlag) delete seg.open;
        seg.end = cut; // keep [start, cut] as `from`
        segs.splice(i + 1, 0, { projectId: toId, start: cut, end: origEnd, ...(openFlag ? { open: true } : {}) });
        need = 0;
      }
    }
    this._mergeAdjacent();
    this._save();
    return { ok: true };
  }

  _mergeAdjacent() {
    const s = this.data.segments.slice().sort((a, b) => a.start - b.start);
    const out = [];
    for (const seg of s) {
      const last = out[out.length - 1];
      // Never merge across a note (each annotated entry stays its own record).
      if (last && last.projectId === seg.projectId && !last.open && seg.start - last.end < 1000 && !last.note && !seg.note) {
        last.end = Math.max(last.end, seg.end);
        if (seg.open) last.open = true;
      } else {
        out.push({ ...seg });
      }
    }
    this.data.segments = out;
  }
}

module.exports = { ProjectStore };
