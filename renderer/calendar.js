// The Calendar tab: one week of the PRIMARY Google calendar (the user's choice), with editing.
// Drag across the grid to make an event, drag one to move it, its lower edge to make it longer;
// click one for its details, guests, Join and the answer to an invitation. Extra hour columns
// show the time in zones of the TZ planner. Main side: google-manager.js `calendar*`, `cal:*` IPC.
// Loaded BEFORE renderer.js: it only touches renderer globals inside functions. The part up to
// "the tab" is DOM-free, for node tests.

const CAL_SNAP = 15; // minutes
const CAL_DAY = 86400000;
const CAL_HOUR_MIN = 28; // px an hour may be, zoomed out ...
const CAL_HOUR_MAX = 120; // ... and in
const CAL_ZONES_MAX = 2;

// ---- dates: local wall-clock arithmetic (a day is not always 24 h - DST) ----
function calAddDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
// The Monday of the week a date is in, at local midnight.
function calWeekStart(date) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
}
function calDayKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function calFromKey(k) {
  const [y, m, d] = String(k).split('-').map(Number);
  return new Date(y, m - 1, d);
}
// Minutes since that day's midnight, as the clock on the wall shows them.
function calWallMin(t) {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}
// The moment `min` wall-clock minutes into a day.
function calAt(day, min) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, Math.round(min));
}
function calSnap(min, step) {
  const s = step || CAL_SNAP;
  return Math.round(min / s) * s;
}
// An event's start and end in ms. All-day: local midnights, the end the day AFTER the last.
function calSpan(ev) {
  if (ev.allDay) return { s: calFromKey(ev.start).getTime(), e: calFromKey(ev.end || ev.start).getTime() };
  return { s: Date.parse(ev.start), e: Date.parse(ev.end || ev.start) };
}
// All-day events, and timed ones of a day or more, go in the bar row on top (as Google does).
function calIsBar(ev) {
  if (ev.allDay) return true;
  const { s, e } = calSpan(ev);
  return e - s >= CAL_DAY;
}
// The timed events of the week as pieces per day: { ev, day 0-6, top, bottom (minutes), first,
// last, lane, lanes }. An event over midnight is two pieces; one without length still shows.
function calSegments(events, weekStart) {
  const out = [];
  for (const ev of events || []) {
    if (!ev || calIsBar(ev)) continue;
    const { s, e } = calSpan(ev);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    for (let i = 0; i < 7; i++) {
      const d0 = calAddDays(weekStart, i).getTime();
      const d1 = calAddDays(weekStart, i + 1).getTime();
      if (!(s < d1 && Math.max(e, s + 1) > d0)) continue;
      const top = s <= d0 ? 0 : calWallMin(s);
      let bottom = e >= d1 ? 1440 : calWallMin(e);
      if (bottom <= top) bottom = Math.min(1440, top + CAL_SNAP); // no length (or a DST hour): still visible
      out.push({ ev, day: i, top, bottom, first: s >= d0, last: e <= d1 });
    }
  }
  return calLanes(out);
}
// Events that overlap share their day column: each cluster of overlapping pieces gets lanes,
// and every piece in it is 1/lanes wide. Longer ones first, so they keep the left.
function calLanes(segs) {
  for (let day = 0; day < 7; day++) {
    const list = segs.filter((x) => x.day === day).sort((a, b) => a.top - b.top || b.bottom - a.bottom);
    let cluster = [];
    let end = -1;
    const flush = () => {
      const lanes = [];
      for (const x of cluster) {
        let i = lanes.findIndex((b) => b <= x.top);
        if (i === -1) {
          i = lanes.length;
          lanes.push(0);
        }
        lanes[i] = x.bottom;
        x.lane = i;
      }
      for (const x of cluster) x.lanes = lanes.length;
      cluster = [];
    };
    for (const x of list) {
      if (cluster.length && x.top >= end) {
        flush();
        end = -1;
      }
      cluster.push(x);
      end = Math.max(end, x.bottom);
    }
    if (cluster.length) flush();
  }
  return segs;
}
// The bar row: { bars: [{ ev, from, to (days 0-6), row, contLeft, contRight }], rows }.
function calBars(events, weekStart) {
  const bars = [];
  const w0 = weekStart.getTime();
  const w7 = calAddDays(weekStart, 7).getTime();
  for (const ev of events || []) {
    if (!ev || !calIsBar(ev)) continue;
    const { s, e } = calSpan(ev);
    if (!(s < w7 && e > w0)) continue;
    let from = 0;
    let to = 6;
    for (let i = 0; i < 7; i++) {
      const d0 = calAddDays(weekStart, i).getTime();
      const d1 = calAddDays(weekStart, i + 1).getTime();
      if (s >= d0 && s < d1) from = i;
      if (e > d0 && e <= d1) to = i;
    }
    bars.push({ ev, from, to, contLeft: s < w0, contRight: e > w7 });
  }
  bars.sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from));
  const rows = [];
  for (const b of bars) {
    let r = rows.findIndex((end) => end < b.from);
    if (r === -1) {
      r = rows.length;
      rows.push(-1);
    }
    rows[r] = b.to;
    b.row = r;
  }
  return { bars, rows: rows.length };
}
// "Oct 5 - 11, 2026", "Sep 28 - Oct 4, 2026", "Dec 28, 2026 - Jan 3, 2027"
function calRangeLabel(ws) {
  const we = calAddDays(ws, 6);
  const mon = (d) => d.toLocaleDateString('en-US', { month: 'short' });
  if (ws.getFullYear() !== we.getFullYear()) return mon(ws) + ' ' + ws.getDate() + ', ' + ws.getFullYear() + ' - ' + mon(we) + ' ' + we.getDate() + ', ' + we.getFullYear();
  if (ws.getMonth() !== we.getMonth()) return mon(ws) + ' ' + ws.getDate() + ' - ' + mon(we) + ' ' + we.getDate() + ', ' + we.getFullYear();
  return mon(ws) + ' ' + ws.getDate() + ' - ' + we.getDate() + ', ' + we.getFullYear();
}
// 24h clock time of a moment in a zone ("09:00", "14:30"); '' for a zone that is not one.
function calZoneTime(t, zone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone }).formatToParts(new Date(t));
    const h = parts.find((p) => p.type === 'hour');
    const m = parts.find((p) => p.type === 'minute');
    return h && m ? h.value.padStart(2, '0') + ':' + m.value : '';
  } catch (_) {
    return '';
  }
}
// A zone's short name at a moment: "EDT", "GMT+5:30".
function calZoneShort(zone, t) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(t)).find((x) => x.type === 'timeZoneName');
    return p ? p.value : '';
  } catch (_) {
    return '';
  }
}
// The 24 labels of an extra hour column: that zone's time at each of the day's local hours.
function calZoneGutter(day, zone) {
  const out = [];
  for (let h = 0; h < 24; h++) out.push(calZoneTime(calAt(day, h * 60).getTime(), zone));
  return out;
}
function calHM(t) {
  const d = new Date(t);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// ---- the tab ----
const calSt = {
  rec: null,
  saved: { zones: [], hourH: 48 }, // settings.calendar
  weekStart: null,
  events: [],
  cache: new Map(), // week key -> { events, at }
  meta: null, // { timeZone, color, palette, canEdit }
  seq: 0,
  loading: false,
  err: '',
  sel: null, // the chosen event's id
  drag: null,
  undo: null,
  toastTimer: null,
  tick: null,
  scrolled: false,
};
function calRestore(s) {
  if (!s || typeof s !== 'object') return;
  const out = { zones: [], hourH: 48 };
  if (Array.isArray(s.zones)) out.zones = s.zones.filter((z) => typeof z === 'string' && calZoneTime(0, z)).slice(0, CAL_ZONES_MAX);
  if (Number.isFinite(s.hourH)) out.hourH = Math.max(CAL_HOUR_MIN, Math.min(CAL_HOUR_MAX, Math.round(s.hourH)));
  calSt.saved = out;
}
function calSave() {
  api.saveSettings({ calendar: { ...calSt.saved } });
}
function calEl(sel) {
  return calSt.rec ? calSt.rec.paneEl.querySelector(sel) : null;
}
function calLocalZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch (_) {
    return '';
  }
}
// May Cockpit change the calendar? (the calendar.events permission; unknown = not yet asked)
function calMayEdit() {
  return !!(calSt.meta && calSt.meta.canEdit);
}
function calEditable(ev) {
  return !!ev && calMayEdit() && ev.canEdit;
}
function calFind(id) {
  return calSt.events.find((e) => e.id === id) || null;
}
function calOthers(ev) {
  return ((ev && ev.attendees) || []).filter((a) => !a.self);
}

function createCalendarTab() {
  for (const [tid, r] of tabs) {
    if (r.kind === 'calendar') {
      activateTab(tid);
      return tid;
    }
  }
  const id = newTabId();
  const { tabEl, paneEl } = createTabChrome(id, 'Calendar', 'calendar');
  paneEl.classList.remove('term-pane');
  paneEl.classList.add('cal-pane');
  paneEl.tabIndex = -1;
  paneEl.innerHTML =
    '<div class="cal-top">' +
    '<button class="cal-btn" data-c="today" title="This week (t)">Today</button>' +
    '<button class="cal-btn cal-nav" data-c="prev" title="The week before (← or k)">◀</button>' +
    '<button class="cal-btn cal-nav" data-c="next" title="The week after (→ or j)">▶</button>' +
    '<span class="cal-range"></span><span class="cal-state"></span>' +
    '<span class="cal-spacer"></span>' +
    '<span class="cal-zones"></span>' +
    '<button class="cal-btn" data-c="refresh" title="Read the calendar again (r)">⟳</button>' +
    '<button class="cal-btn cal-primary" data-c="new" title="A new event (n) - or drag across the grid">+ New event</button>' +
    '</div>' +
    '<div class="cal-banner hidden"></div>' +
    '<div class="cal-head"></div>' +
    '<div class="cal-allday"></div>' +
    '<div class="cal-scroll"><div class="cal-grid"></div></div>' +
    '<div class="cal-pop hidden"></div>' +
    '<div class="cal-menu hidden"></div>' +
    '<div class="cal-quick hidden"></div>' +
    '<div class="cal-edit hidden"></div>' +
    '<div class="cal-ask hidden"></div>' +
    '<div class="cal-toast hidden"></div>';
  const rec = { id, kind: 'calendar', paneEl, tabEl, status: 'connected', profile: { name: 'Calendar' } };
  tabs.set(id, rec);
  calSt.rec = rec;
  calSt.weekStart = calWeekStart(new Date());
  calSt.scrolled = false;
  calSt.sel = null;
  calWire(rec);
  activateTab(id);
  bbTabOpen(rec);
  persistTabOrder();
  calRender();
  calLoadMeta();
  calLoad(false);
  return id;
}
function calOnShow() {
  const st = calSt;
  if (!st.rec) return;
  st.rec.paneEl.focus({ preventScroll: true });
  if (!st.meta || !st.meta.canEdit) calLoadMeta(); // a reconnect may have brought the permission
  calRender();
  const c = st.cache.get(calDayKey(st.weekStart));
  if (!c || Date.now() - c.at > 60000) calLoad(true);
  clearInterval(st.tick);
  st.tick = setInterval(calTick, 30000);
}
function calOnClose() {
  clearInterval(calSt.tick);
  clearTimeout(calSt.toastTimer);
  calSt.rec = null;
  calSt.drag = null;
}
// Every 30 s: the now-line; every 2 min (while it is the tab you look at) the week again.
function calTick() {
  const st = calSt;
  if (!st.rec) return clearInterval(st.tick);
  calPaintNow();
  if (activeTabId !== st.rec.id || document.hidden) return;
  const c = st.cache.get(calDayKey(st.weekStart));
  if (!c || Date.now() - c.at > 120000) calLoad(true);
}

// ---- data ----
async function calLoadMeta() {
  if (!googleConnected || !api.calMeta) return calRenderBanner();
  const r = await api.calMeta();
  if (r && r.ok) calSt.meta = r;
  calRender();
}
// The week on screen. `quiet`: keep showing what is there while it comes (a refresh).
async function calLoad(quiet) {
  const st = calSt;
  if (!st.rec) return;
  if (!googleConnected) {
    st.events = [];
    calRender();
    return;
  }
  const ws = st.weekStart;
  const key = calDayKey(ws);
  const cached = st.cache.get(key);
  if (cached) st.events = cached.events.slice();
  const seq = ++st.seq;
  st.loading = true;
  st.err = '';
  if (!quiet || cached) calRender();
  const r = await api.calEvents({ timeMin: ws.toISOString(), timeMax: calAddDays(ws, 7).toISOString() });
  if (seq !== st.seq || !st.rec) return; // the week changed while this was on its way
  st.loading = false;
  if (!r || !r.ok) {
    st.err = (r && r.error) || 'unknown';
    calRender();
    return;
  }
  st.events = r.events || [];
  st.cache.set(key, { events: st.events.slice(), at: Date.now() });
  calRender();
  calPrefetch(calAddDays(ws, 7)); // the next week, so the arrow shows it at once
}
async function calPrefetch(ws) {
  const key = calDayKey(ws);
  const c = calSt.cache.get(key);
  if (c && Date.now() - c.at < 120000) return;
  const r = await api.calEvents({ timeMin: ws.toISOString(), timeMax: calAddDays(ws, 7).toISOString() });
  if (r && r.ok) calSt.cache.set(key, { events: r.events || [], at: Date.now() });
}
// After a change: the cached weeks may hold the old version; the status bar's next meeting too.
function calChanged() {
  calSt.cache.set(calDayKey(calSt.weekStart), { events: calSt.events.slice(), at: Date.now() });
  for (const k of [...calSt.cache.keys()]) if (k !== calDayKey(calSt.weekStart)) calSt.cache.delete(k);
  if (typeof refreshEvents === 'function') refreshEvents();
}
function calGo(ws) {
  calSt.weekStart = calWeekStart(ws);
  calSt.sel = null;
  calHidePop();
  calLoad(false);
}

// ---- painting ----
function calZonesOn() {
  const local = calLocalZone();
  return calSt.saved.zones.filter((z) => z !== local && calZoneTime(0, z)).slice(0, CAL_ZONES_MAX);
}
function calZoneLabel(zone) {
  const t = (typeof tzList !== 'undefined' && tzList.find((x) => x.zone === zone)) || null;
  return (t && t.label) || zone.split('/').pop().replace(/_/g, ' ');
}
// Google's eleven event colours (what colors.get answers; used when that could not be read),
// with the names Google Calendar gives them.
const CAL_PALETTE = {
  1: { background: '#a4bdfc', foreground: '#1d1d1d' },
  2: { background: '#7ae7bf', foreground: '#1d1d1d' },
  3: { background: '#dbadff', foreground: '#1d1d1d' },
  4: { background: '#ff887c', foreground: '#1d1d1d' },
  5: { background: '#fbd75b', foreground: '#1d1d1d' },
  6: { background: '#ffb878', foreground: '#1d1d1d' },
  7: { background: '#46d6db', foreground: '#1d1d1d' },
  8: { background: '#e1e1e1', foreground: '#1d1d1d' },
  9: { background: '#5484ed', foreground: '#1d1d1d' },
  10: { background: '#51b749', foreground: '#1d1d1d' },
  11: { background: '#dc2127', foreground: '#1d1d1d' },
};
const CAL_COLOR_NAMES = { 1: 'Lavender', 2: 'Sage', 3: 'Grape', 4: 'Flamingo', 5: 'Banana', 6: 'Tangerine', 7: 'Peacock', 8: 'Graphite', 9: 'Blueberry', 10: 'Basil', 11: 'Tomato' };
function calPalette() {
  const p = calSt.meta && calSt.meta.palette;
  return p && Object.keys(p).length >= 11 ? p : CAL_PALETTE;
}
function calColorName(id) {
  return id ? CAL_COLOR_NAMES[id] || 'colour ' + id : 'the calendar\'s colour';
}
function calColor(ev) {
  const pal = ev.colorId ? calPalette()[ev.colorId] || CAL_PALETTE[ev.colorId] : null;
  const bg = (pal && pal.background) || (calSt.meta && calSt.meta.color) || '#4ea1ff';
  const rgb = typeof mailHexRgb === 'function' ? mailHexRgb(bg) : null;
  const fg = (pal && pal.foreground) || (rgb && !mailIsLight(rgb) ? '#ffffff' : '#1d1f21');
  return { bg, fg };
}
function calRender() {
  const st = calSt;
  if (!st.rec) return;
  const p = st.rec.paneEl;
  const hh = st.saved.hourH;
  const zones = calZonesOn();
  const ws = st.weekStart;
  const today = calDayKey(new Date());
  p.style.setProperty('--cal-cols', 'repeat(' + (zones.length + 1) + ', var(--cal-gut)) repeat(7, minmax(0, 1fr))');
  p.style.setProperty('--cal-hour', hh + 'px');
  p.querySelector('.cal-range').textContent = calRangeLabel(ws);
  p.querySelector('.cal-state').textContent = st.loading ? 'loading…' : '';
  calRenderZoneChips();
  calRenderBanner();
  // the head: the hour columns' zones, then the days
  const ref = (() => {
    const t = new Date();
    return t >= ws && t < calAddDays(ws, 7) ? t : calAt(ws, 12 * 60);
  })();
  let head = '<div class="cal-gh" title="' + escapeHtml(calLocalZone()) + '">' + escapeHtml(calZoneShort(calLocalZone(), ref)) + '</div>';
  for (const z of zones) head += '<div class="cal-gh zone" title="' + escapeHtml(z) + '">' + escapeHtml(calZoneLabel(z)) + '<i>' + escapeHtml(calZoneShort(z, ref)) + '</i></div>';
  for (let i = 0; i < 7; i++) {
    const d = calAddDays(ws, i);
    const k = calDayKey(d);
    head +=
      '<div class="cal-dh' + (k === today ? ' today' : '') + (i >= 5 ? ' weekend' : '') + '" data-day="' + i + '">' +
      '<span>' + d.toLocaleDateString('en-US', { weekday: 'short' }) + '</span><b>' + d.getDate() + '</b></div>';
  }
  p.querySelector('.cal-head').innerHTML = head;
  // the bar row: all-day events and anything a day or longer
  const { bars, rows } = calBars(st.events, ws);
  const ad = p.querySelector('.cal-allday');
  let bh = '';
  for (const b of bars) {
    const c = calColor(b.ev);
    bh +=
      '<div class="cal-bar' + calEvClass(b.ev) + (b.contLeft ? ' cont-l' : '') + (b.contRight ? ' cont-r' : '') + '" data-id="' + escapeHtml(b.ev.id) + '" ' +
      'style="left:calc(' + (b.from / 7) * 100 + '% + 2px);width:calc(' + ((b.to - b.from + 1) / 7) * 100 + '% - 4px);top:' + (b.row * 22 + 2) + 'px;--ev-bg:' + c.bg + ';--ev-fg:' + c.fg + '" title="' + escapeHtml(b.ev.summary) + '">' +
      escapeHtml(b.ev.summary) + '</div>';
  }
  ad.innerHTML =
    '<div class="cal-adl" style="grid-column: span ' + (zones.length + 1) + '">all day</div>' +
    '<div class="cal-adb" style="grid-column: span 7;height:' + Math.max(24, rows * 22 + 4) + 'px">' + bh + '</div>';
  // the grid: the hour columns, then the days with their events
  const grid = p.querySelector('.cal-grid');
  let g = '';
  const local = [];
  for (let h = 0; h < 24; h++) local.push(calHM(calAt(ref, h * 60)));
  const gutter = (labels, cls) => '<div class="cal-gut' + cls + '">' + labels.map((l, h) => (h ? '<span style="top:' + h * hh + 'px">' + escapeHtml(l) + '</span>' : '')).join('') + '</div>';
  g += gutter(local, '');
  for (const z of zones) g += gutter(calZoneGutter(ref, z), ' zone');
  for (let i = 0; i < 7; i++) {
    const k = calDayKey(calAddDays(ws, i));
    g += '<div class="cal-day' + (k === today ? ' today' : '') + (i >= 5 ? ' weekend' : '') + '" data-day="' + i + '"></div>';
  }
  grid.innerHTML = g;
  grid.style.height = 24 * hh + 'px';
  const cols = [...grid.querySelectorAll('.cal-day')];
  const now = Date.now();
  for (const seg of calSegments(st.events, ws)) cols[seg.day].appendChild(calEvEl(seg, hh, now));
  calPaintNow();
  // the head and the bar row line up with the grid, whose scrollbar takes room
  const sc = p.querySelector('.cal-scroll');
  p.style.setProperty('--cal-sb', sc.offsetWidth - sc.clientWidth + 'px');
  if (!st.scrolled && sc.clientHeight) {
    st.scrolled = true;
    const t = new Date();
    const inWeek = t >= ws && t < calAddDays(ws, 7);
    sc.scrollTop = Math.max(0, ((inWeek ? Math.min(calWallMin(t) / 60 - 2, 16) : 7.5) * hh) | 0);
  }
}
function calEvClass(ev) {
  let c = '';
  if (ev.myStatus === 'declined') c += ' declined';
  else if (ev.myStatus === 'tentative') c += ' tentative';
  else if (ev.myStatus === 'needsAction') c += ' needs';
  if (calSt.sel === ev.id) c += ' sel';
  if (!calEditable(ev)) c += ' ro';
  return c;
}
function calEvEl(seg, hh, now) {
  const ev = seg.ev;
  const el = document.createElement('div');
  const { e } = calSpan(ev);
  el.className = 'cal-ev' + calEvClass(ev) + (e < now ? ' past' : '');
  el.dataset.id = ev.id;
  el.dataset.top = seg.top;
  el.dataset.bottom = seg.bottom;
  el.dataset.day = seg.day;
  const h = ((seg.bottom - seg.top) / 60) * hh;
  el.style.top = (seg.top / 60) * hh + 'px';
  el.style.height = Math.max(14, h - 1) + 'px';
  el.style.left = 'calc(' + (seg.lane / seg.lanes) * 100 + '% + 1px)';
  el.style.width = 'calc(' + 100 / seg.lanes + '% - 3px)';
  const c = calColor(ev);
  el.style.setProperty('--ev-bg', c.bg);
  el.style.setProperty('--ev-fg', c.fg);
  const { s } = calSpan(ev);
  const time = calHM(s) + ' - ' + calHM(e);
  el.title = ev.summary + '\n' + time + (ev.location ? '\n' + ev.location : '');
  el.innerHTML =
    '<div class="cal-ev-t">' + escapeHtml(ev.summary) + '</div>' +
    (h >= 30 ? '<div class="cal-ev-time">' + escapeHtml(time) + (ev.location && h >= 46 ? ' · ' + escapeHtml(ev.location) : '') + '</div>' : '') +
    (calEditable(ev) && seg.last ? '<div class="cal-grip" title="Drag to change the end"></div>' : '');
  return el;
}
function calPaintNow() {
  const st = calSt;
  if (!st.rec) return;
  const grid = st.rec.paneEl.querySelector('.cal-grid');
  grid.querySelectorAll('.cal-now').forEach((n) => n.remove());
  const t = new Date();
  const col = grid.querySelector('.cal-day[data-day="' + Math.floor((t - st.weekStart) / CAL_DAY) + '"]');
  if (!col || calDayKey(calAddDays(st.weekStart, +col.dataset.day)) !== calDayKey(t)) return;
  const n = document.createElement('div');
  n.className = 'cal-now';
  n.style.top = (calWallMin(t) / 60) * st.saved.hourH + 'px';
  col.appendChild(n);
}
function calRenderZoneChips() {
  const box = calEl('.cal-zones');
  if (!box) return;
  const local = calLocalZone();
  const list = (typeof tzList !== 'undefined' ? tzList : []).filter((t) => t.zone && t.zone !== local && calZoneTime(0, t.zone));
  if (!list.length) {
    box.innerHTML = '';
    return;
  }
  const on = calSt.saved.zones;
  box.innerHTML =
    '<span class="cal-zl" title="Extra hour columns: the time in zones from the TZ planner">Also:</span>' +
    list.map((t) => '<button class="cal-chip' + (on.includes(t.zone) ? ' on' : '') + '" data-zone="' + escapeHtml(t.zone) + '" title="' + escapeHtml(t.zone) + '">' + escapeHtml(t.label || t.zone) + '</button>').join('');
}
function calRenderBanner() {
  const b = calEl('.cal-banner');
  if (!b) return;
  let html = '';
  if (!googleConnected) html = 'Google is not connected. <button class="cal-btn" data-c="settings">Open Settings</button>';
  else if (calSt.err) html = 'Could not read the calendar: ' + escapeHtml(calSt.err) + ' <button class="cal-btn" data-c="refresh">Try again</button>';
  else if (calSt.meta && !calSt.meta.canEdit)
    html = 'Read only: Cockpit may read your calendar but not change it. Reconnect Google in Settings and allow the calendar to make changes here. <button class="cal-btn" data-c="settings">Open Settings</button>';
  b.innerHTML = html;
  b.classList.toggle('hidden', !html);
}

// ---- the details popover ----
function calHidePop() {
  const p = calEl('.cal-pop');
  if (p) p.classList.add('hidden');
}
function calTimeText(ev) {
  const { s, e } = calSpan(ev);
  const day = (t) => new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  if (ev.allDay) {
    const last = e - CAL_DAY;
    return last > s ? day(s) + ' - ' + day(last) : day(s) + ' · all day';
  }
  return calDayKey(new Date(s)) === calDayKey(new Date(e - 1)) ? day(s) + ' · ' + calHM(s) + ' - ' + calHM(e) : day(s) + ' ' + calHM(s) + ' - ' + day(e) + ' ' + calHM(e);
}
// A description as plain text. Google keeps HTML there (a link, bold, a list); it is shown as
// text and never as HTML - a link keeps its address next to its words, so it can still be
// clicked (mailLinkify makes it a link again).
function calDescText(d) {
  const raw = String(d || '');
  if (!/<[a-z][\s\S]*>/i.test(raw) || typeof mailHtmlToText !== 'function') return raw.trim().slice(0, 4000);
  const doc = new DOMParser().parseFromString(raw, 'text/html'); // inert: nothing runs, nothing loads
  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const words = a.textContent.trim();
    if (!/^https?:\/\//i.test(href) || words.includes(href)) return;
    a.replaceWith(words ? words + ' (' + href + ')' : href);
  });
  return mailHtmlToText(doc.body ? doc.body.innerHTML : '').slice(0, 4000);
}
function calShowPop(ev, anchor) {
  const st = calSt;
  const p = calEl('.cal-pop');
  if (!p || !ev) return;
  st.sel = ev.id;
  const c = calColor(ev);
  const others = calOthers(ev);
  const RS = { accepted: '✓', tentative: '?', declined: '✗', needsAction: '·' };
  const RS_T = { accepted: 'accepted', tentative: 'maybe', declined: 'declined', needsAction: 'no answer yet' };
  const zones = calZonesOn();
  const { s, e } = calSpan(ev);
  let h =
    '<div class="cp-title"><span class="cp-dot" style="background:' + c.bg + '"></span>' + escapeHtml(ev.summary) + '</div>' +
    '<div class="cp-row">' + escapeHtml(calTimeText(ev)) + (ev.recurringEventId ? ' <span class="cp-dim">· repeats</span>' : '') + '</div>';
  if (!ev.allDay) for (const z of zones) h += '<div class="cp-row cp-dim">' + escapeHtml(calZoneLabel(z)) + ': ' + escapeHtml(calZoneTime(s, z) + ' - ' + calZoneTime(e, z)) + '</div>';
  if (ev.location) h += '<div class="cp-row">📍 ' + (/^https?:\/\//i.test(ev.location) ? '<a href="' + escapeHtml(ev.location) + '">' + escapeHtml(ev.location) + '</a>' : escapeHtml(ev.location)) + '</div>';
  if (ev.meetLink) h += '<div class="cp-row"><button class="cal-btn cal-primary" data-p="join" title="' + escapeHtml(ev.meetLink) + '">Join</button> <span class="cp-dim">' + escapeHtml(ev.meetLink.replace(/^https?:\/\//, '').slice(0, 48)) + '</span></div>';
  if (ev.organizer && (ev.organizer.name || ev.organizer.email) && !ev.organizer.self) h += '<div class="cp-row cp-dim">Organizer: ' + escapeHtml(ev.organizer.name || ev.organizer.email) + '</div>';
  if (others.length) {
    const n = others.length;
    const counts = ['accepted', 'tentative', 'declined', 'needsAction'].map((k) => [k, others.filter((a) => a.responseStatus === k).length]).filter((x) => x[1]);
    h += '<div class="cp-row cp-dim">' + n + ' guest' + (n === 1 ? '' : 's') + ': ' + counts.map(([k, v]) => v + ' ' + RS_T[k]).join(', ') + '</div><div class="cp-guests">';
    for (const a of others.slice(0, 12)) h += '<div class="cp-g ' + a.responseStatus + '" title="' + escapeHtml(a.email + ' - ' + RS_T[a.responseStatus]) + '"><b>' + RS[a.responseStatus] + '</b> ' + escapeHtml(a.name || a.email) + (a.organizer ? ' <span class="cp-dim">(organizer)</span>' : '') + '</div>';
    if (n > 12) h += '<div class="cp-dim">and ' + (n - 12) + ' more</div>';
    h += '</div>';
  }
  const desc = calDescText(ev.description);
  if (desc) h += '<div class="cp-desc">' + (typeof mailLinkify === 'function' ? mailLinkify(escapeHtml(desc)) : escapeHtml(desc)) + '</div>';
  if (ev.myStatus && !ev.organizer.self) {
    h +=
      '<div class="cp-rsvp"><span class="cp-dim">Going?</span>' +
      [['accepted', 'Yes'], ['tentative', 'Maybe'], ['declined', 'No']].map(([k, l]) => '<button class="cal-btn' + (ev.myStatus === k ? ' on' : '') + '" data-p="rsvp" data-r="' + k + '"' + (calMayEdit() ? '' : ' disabled title="Reconnect Google in Settings to answer from here"') + '>' + l + '</button>').join('') +
      '</div>';
  }
  h += '<div class="cp-acts">';
  if (calEditable(ev)) h += '<button class="cal-btn" data-p="edit" title="Change it">✎ Edit</button><button class="cal-btn" data-p="delete" title="Delete it (Delete)">🗑 Delete</button>';
  if (ev.htmlLink) h += '<button class="cal-btn" data-p="open" title="Open it in Google Calendar">Open in Google Calendar</button>';
  h += '<button class="mail-x cp-x" data-p="close" title="Close (Esc)">✕</button></div>';
  p.innerHTML = h;
  p.dataset.id = ev.id;
  p.classList.remove('hidden');
  // beside the event, inside the pane
  const pane = st.rec.paneEl.getBoundingClientRect();
  const r = anchor ? anchor.getBoundingClientRect() : { left: pane.left + pane.width / 2, right: pane.left + pane.width / 2, top: pane.top + 80 };
  const w = p.offsetWidth;
  const hgt = p.offsetHeight;
  let left = r.right + 8 - pane.left;
  if (left + w > pane.width - 8) left = r.left - w - 8 - pane.left;
  left = Math.max(8, Math.min(left, pane.width - w - 8));
  const top = Math.max(8, Math.min(r.top - pane.top, pane.height - hgt - 8));
  p.style.left = left + 'px';
  p.style.top = top + 'px';
  st.rec.paneEl.querySelectorAll('.cal-ev.sel, .cal-bar.sel').forEach((x) => x.classList.remove('sel'));
  st.rec.paneEl.querySelectorAll('[data-id="' + CSS.escape(ev.id) + '"]').forEach((x) => x.classList.add('sel'));
}

// ---- the right-click menu (as in Google Calendar): the colour first, then what to do ----
function calHideMenu() {
  const m = calEl('.cal-menu');
  if (m) m.classList.add('hidden');
}
function calMark(id) {
  calSt.sel = id;
  if (!calSt.rec) return;
  calSt.rec.paneEl.querySelectorAll('.cal-ev.sel, .cal-bar.sel').forEach((x) => x.classList.remove('sel'));
  if (id) calSt.rec.paneEl.querySelectorAll('[data-id="' + CSS.escape(id) + '"]').forEach((x) => x.classList.add('sel'));
}
// ev: the event right-clicked, or null for free time (`slot` = { day, min }).
function calMenu(ev, x, y, slot) {
  const st = calSt;
  const m = calEl('.cal-menu');
  if (!m) return;
  let h = '';
  if (ev) {
    calMark(ev.id);
    h += '<div class="cm-title">' + escapeHtml(ev.summary) + '</div>';
    if (calMayEdit()) {
      const cur = ev.colorId || '';
      const pal = calPalette();
      const sw = (id, bg, name) => '<button class="cm-sw' + (cur === id ? ' on' : '') + '" data-color="' + id + '" style="background:' + escapeHtml(bg) + '" title="' + escapeHtml(name) + '"></button>';
      h += '<div class="cm-colors">' + sw('', (st.meta && st.meta.color) || '#4ea1ff', 'Calendar colour');
      for (let i = 1; i <= 11; i++) {
        const c = pal[i] || CAL_PALETTE[i];
        h += sw(String(i), c.background, CAL_COLOR_NAMES[i]);
      }
      h += '</div><div class="cm-sep"></div>';
    }
    if (ev.myStatus && !ev.organizer.self) {
      for (const [k, l] of [['accepted', 'Yes, going'], ['tentative', 'Maybe'], ['declined', 'No']]) {
        h += '<button class="cm-item' + (ev.myStatus === k ? ' on' : '') + '" data-m="rsvp" data-r="' + k + '"' + (calMayEdit() ? '' : ' disabled') + '>' + (ev.myStatus === k ? '● ' : '○ ') + l + '</button>';
      }
      h += '<div class="cm-sep"></div>';
    }
    h += '<button class="cm-item" data-m="details">Details</button>';
    if (ev.meetLink) h += '<button class="cm-item" data-m="join">Join the meeting</button>';
    if (calEditable(ev)) h += '<button class="cm-item" data-m="edit">✎ Edit…</button>';
    if (calMayEdit()) h += '<button class="cm-item" data-m="duplicate" title="A new event with the same details - you see it before it is made">⧉ Duplicate…</button>';
    if (ev.htmlLink) h += '<button class="cm-item" data-m="open">Open in Google Calendar</button>';
    if (calEditable(ev)) h += '<div class="cm-sep"></div><button class="cm-item cm-danger" data-m="delete">🗑 Delete</button>';
  } else {
    if (!calMayEdit()) return calNoEdit();
    h += '<button class="cm-item" data-m="new">+ New event here</button><button class="cm-item" data-m="newday">+ New all-day event</button>';
  }
  m.innerHTML = h;
  m.dataset.id = ev ? ev.id : '';
  m._slot = slot || null;
  m.classList.remove('hidden');
  const pane = st.rec.paneEl.getBoundingClientRect();
  const w = m.offsetWidth;
  const hgt = m.offsetHeight;
  let left = x - pane.left;
  let top = y - pane.top;
  if (left + w > pane.width - 6) left = Math.max(6, left - w); // open to the left near the edge
  if (top + hgt > pane.height - 6) top = Math.max(6, pane.height - hgt - 6);
  m.style.left = left + 'px';
  m.style.top = top + 'px';
}
async function calSetColor(ev, colorId) {
  if (!calMayEdit()) return calNoEdit();
  const before = ev.colorId || '';
  if (before === colorId) return;
  calPut({ ...ev, colorId });
  calRender();
  const r = await api.calUpdate({ eventId: ev.id, patch: { colorId }, sendUpdates: 'none' }); // a colour is yours alone
  if (!r || !r.ok) {
    calPut(ev);
    calRender();
    return calToast('Colour not changed: ' + ((r && r.error) || 'unknown'), null, true);
  }
  calPut(r.event);
  calRender();
  calChanged();
  calToast('Colour: ' + calColorName(colorId), async () => {
    const back = await api.calUpdate({ eventId: ev.id, patch: { colorId: before }, sendUpdates: 'none' });
    if (back && back.ok) {
      calPut(back.event);
      calRender();
      calChanged();
      calToast('Undone');
    } else calToast('Undo failed: ' + ((back && back.error) || 'unknown'), null, true);
  });
}
function calDuplicate(ev) {
  calEditor(null, {
    dup: true,
    summary: ev.summary,
    allDay: !!ev.allDay,
    start: ev.start,
    end: ev.end,
    location: ev.location || '',
    description: calDescText(ev.description),
    attendees: calOthers(ev).map((a) => (a.name ? mailFormatAddress(a) : a.email)),
    colorId: ev.colorId || '',
  });
}
function calMenuAct(b) {
  const m = calEl('.cal-menu');
  const ev = m.dataset.id ? calFind(m.dataset.id) : null;
  const slot = m._slot;
  calHideMenu();
  if (b.dataset.color !== undefined) return ev && calSetColor(ev, b.dataset.color);
  const k = b.dataset.m;
  if (k === 'new' && slot) {
    const top = Math.floor(slot.min / 30) * 30;
    calGhost(slot.day, top, Math.min(1440, top + 30));
    return calQuick(slot.day, top, Math.min(1440, top + 30), false);
  }
  if (k === 'newday' && slot) return calQuick(slot.day, 0, 0, true);
  if (!ev) return;
  const el = calEl('.cal-ev[data-id="' + CSS.escape(ev.id) + '"], .cal-bar[data-id="' + CSS.escape(ev.id) + '"]');
  if (k === 'details') calShowPop(ev, el);
  else if (k === 'join') api.openExternal(ev.meetLink);
  else if (k === 'edit') calEditor(ev, null);
  else if (k === 'duplicate') calDuplicate(ev);
  else if (k === 'open') api.openExternal(ev.htmlLink);
  else if (k === 'delete') calDelete(ev);
  else if (k === 'rsvp') calRespond(ev, b.dataset.r);
}

// ---- asking: send updates? ----
function calAsk(text, buttons) {
  return new Promise((resolve) => {
    const box = calEl('.cal-ask');
    if (!box) return resolve(null);
    box.innerHTML =
      '<div class="ca-box"><div class="ca-text">' + escapeHtml(text) + '</div><div class="ca-btns">' +
      buttons.map((b, i) => '<button class="cal-btn' + (i === 0 ? ' cal-primary' : '') + '" data-a="' + escapeHtml(b[0]) + '">' + escapeHtml(b[1]) + '</button>').join('') +
      '<button class="cal-btn" data-a="">Cancel</button></div></div>';
    box.classList.remove('hidden');
    const done = (v) => {
      box.classList.add('hidden');
      box.innerHTML = '';
      calSt.rec && calSt.rec.paneEl.focus({ preventScroll: true });
      resolve(v);
    };
    box.onclick = (e) => {
      const b = e.target.closest('[data-a]');
      if (b) done(b.dataset.a || null);
      else if (e.target === box) done(null);
    };
    box.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') done(null);
    };
    const first = box.querySelector('[data-a]');
    if (first) first.focus();
  });
}
// When an event has other guests, Google asks whether they hear of a change - so does this.
// -> 'all' | 'none' | null (cancelled)
async function calAskUpdates(ev, what) {
  if (!calOthers(ev).length) return 'none';
  return calAsk('Send ' + what + ' to the ' + calOthers(ev).length + ' guest' + (calOthers(ev).length === 1 ? '' : 's') + '?', [
    ['all', 'Send'],
    ['none', "Don't send"],
  ]);
}

// ---- the toast, with undo ----
function calToast(text, undo, err) {
  const t = calEl('.cal-toast');
  if (!t) return;
  clearTimeout(calSt.toastTimer);
  calSt.undo = undo || null;
  t.className = 'cal-toast' + (err ? ' err' : '');
  t.innerHTML = escapeHtml(text) + (undo ? ' <button class="cal-btn" data-c="undo">Undo (z)</button>' : '');
  calSt.toastTimer = setTimeout(
    () => {
      t.classList.add('hidden');
      calSt.undo = null;
    },
    undo ? 8000 : 4500
  );
}
function calNoEdit() {
  calToast(calMayEdit() ? 'This event is not yours to change - it belongs to its organizer.' : 'Cockpit may not change your calendar yet - reconnect Google in Settings.', null, true);
}

// ---- changes ----
function calPut(ev) {
  const i = calSt.events.findIndex((x) => x.id === ev.id);
  if (i === -1) calSt.events.push(ev);
  else calSt.events[i] = ev;
}
// Move or resize: new times, the guests asked about, optimistic, with an undo.
async function calChangeTimes(ev, start, end, what) {
  const send = await calAskUpdates(ev, 'the change');
  if (!send) return calRender();
  const before = { start: ev.start, end: ev.end };
  calPut({ ...ev, start: new Date(start).toISOString(), end: new Date(end).toISOString() });
  calRender();
  const r = await api.calUpdate({ eventId: ev.id, patch: { start: new Date(start).toISOString(), end: new Date(end).toISOString() }, sendUpdates: send });
  if (!r || !r.ok) {
    calPut(ev);
    calRender();
    return calToast('Not changed: ' + ((r && r.error) || 'unknown'), null, true);
  }
  calPut(r.event);
  calRender();
  calChanged();
  calToast(what + ' · ' + calTimeText(r.event), async () => {
    const back = await api.calUpdate({ eventId: ev.id, patch: { start: before.start, end: before.end }, sendUpdates: send });
    if (back && back.ok) {
      calPut(back.event);
      calRender();
      calChanged();
      calToast('Undone');
    } else calToast('Undo failed: ' + ((back && back.error) || 'unknown'), null, true);
  });
}
async function calCreate(body) {
  const send = (body.attendees || []).length ? await calAsk('Send invitations to the ' + body.attendees.length + ' guest' + (body.attendees.length === 1 ? '' : 's') + '?', [['all', 'Send'], ['none', "Don't send"]]) : 'none';
  if (!send) return false;
  const r = await api.calCreate({ ...body, timeZone: body.allDay ? undefined : calLocalZone(), sendUpdates: send });
  if (!r || !r.ok) {
    calToast('Not created: ' + ((r && r.error) || 'unknown'), null, true);
    return false;
  }
  calPut(r.event);
  calSt.sel = r.event.id;
  calRender();
  calChanged();
  calToast('Created · ' + calTimeText(r.event), async () => {
    const d = await api.calDelete({ eventId: r.event.id, sendUpdates: send });
    if (d && d.ok) {
      calSt.events = calSt.events.filter((x) => x.id !== r.event.id);
      calRender();
      calChanged();
      calToast('Undone');
    } else calToast('Undo failed: ' + ((d && d.error) || 'unknown'), null, true);
  });
  return true;
}
async function calDelete(ev) {
  if (!calEditable(ev)) return calNoEdit();
  const send = await calAskUpdates(ev, 'a cancellation');
  if (!send) return;
  calHidePop();
  calSt.events = calSt.events.filter((x) => x.id !== ev.id);
  calRender();
  const r = await api.calDelete({ eventId: ev.id, sendUpdates: send });
  if (!r || !r.ok) {
    calPut(ev);
    calRender();
    return calToast('Not deleted: ' + ((r && r.error) || 'unknown'), null, true);
  }
  calChanged();
  calToast(ev.recurringEventId ? 'Deleted this occurrence' : 'Deleted', async () => {
    const back = await api.calUndelete({ eventId: ev.id, sendUpdates: send });
    if (back && back.ok) {
      calPut(back.event);
      calRender();
      calChanged();
      calToast('Undone');
    } else calToast('Undo failed: ' + ((back && back.error) || 'unknown'), null, true);
  });
}
async function calRespond(ev, response) {
  if (!calMayEdit()) return calNoEdit();
  const r = await api.calRespond({ eventId: ev.id, response });
  if (!r || !r.ok) return calToast('Not answered: ' + ((r && r.error) || 'unknown'), null, true);
  const upd = { ...ev, myStatus: response, attendees: ev.attendees.map((a) => (a.self ? { ...a, responseStatus: response } : a)) };
  calPut(upd);
  calRender();
  calChanged();
  calShowPop(upd, calEl('.cal-ev[data-id="' + CSS.escape(ev.id) + '"], .cal-bar[data-id="' + CSS.escape(ev.id) + '"]'));
  calToast({ accepted: 'You are going', tentative: 'Maybe', declined: 'Declined' }[response] + ' - the organizer is told');
}

// ---- quick create: a title for a time just dragged out ----
function calQuick(day, startMin, endMin, allDay) {
  const st = calSt;
  const box = calEl('.cal-quick');
  if (!box) return;
  if (!calMayEdit()) {
    calGhost(null);
    return calNoEdit();
  }
  const dayDate = calAddDays(st.weekStart, day);
  const s = allDay ? dayDate.getTime() : calAt(dayDate, startMin).getTime();
  const e = allDay ? calAddDays(dayDate, 1).getTime() : calAt(dayDate, endMin).getTime();
  const draft = allDay ? { allDay: true, start: calDayKey(dayDate), end: calDayKey(calAddDays(dayDate, 1)) } : { allDay: false, start: new Date(s).toISOString(), end: new Date(e).toISOString() };
  box.innerHTML =
    '<div class="cq-time">' + escapeHtml(calTimeText(draft)) + '</div>' +
    '<input class="cq-title" type="text" placeholder="Title" spellcheck="false" />' +
    '<div class="cq-btns"><button class="cal-btn cal-primary" data-q="save">Save</button><button class="cal-btn" data-q="more" title="Guests, place, Meet, description">More…</button><button class="cal-btn" data-q="cancel">Cancel</button></div>';
  box.classList.remove('hidden');
  // next to the ghost
  const pane = st.rec.paneEl.getBoundingClientRect();
  const ghost = st.rec.paneEl.querySelector('.cal-ghost') || st.rec.paneEl.querySelector('.cal-adb');
  const r = ghost.getBoundingClientRect();
  const w = box.offsetWidth;
  let left = r.right + 8 - pane.left;
  if (left + w > pane.width - 8) left = r.left - w - 8 - pane.left;
  box.style.left = Math.max(8, Math.min(left, pane.width - w - 8)) + 'px';
  box.style.top = Math.max(8, Math.min(r.top - pane.top, pane.height - box.offsetHeight - 8)) + 'px';
  const input = box.querySelector('.cq-title');
  const close = () => {
    box.classList.add('hidden');
    box.innerHTML = '';
    calGhost(null);
    st.rec && st.rec.paneEl.focus({ preventScroll: true });
  };
  const save = async () => {
    const title = input.value.trim();
    close();
    await calCreate({ ...draft, summary: title || '(no title)' });
  };
  box.onclick = (ev) => {
    const b = ev.target.closest('[data-q]');
    if (!b) return;
    if (b.dataset.q === 'save') save();
    else if (b.dataset.q === 'more') {
      const title = input.value.trim();
      close();
      calEditor(null, { ...draft, summary: title });
    } else close();
  };
  box.onkeydown = (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') {
      ev.preventDefault();
      save();
    } else if (ev.key === 'Escape') close();
  };
  input.focus();
}

// ---- the editor ----
function calEditor(ev, draft) {
  const st = calSt;
  const box = calEl('.cal-edit');
  if (!box) return;
  if (!calMayEdit() || (ev && !ev.canEdit)) return calNoEdit();
  calHidePop();
  const src = ev || draft || {};
  let s;
  let e;
  if (src.start) ({ s, e } = calSpan({ allDay: !!src.allDay, start: src.start, end: src.end }));
  else {
    // the next full hour, today if this week is shown, else Monday
    const t = new Date();
    const base = t >= st.weekStart && t < calAddDays(st.weekStart, 7) ? t : calAt(st.weekStart, 9 * 60);
    s = calAt(base, (Math.floor(calWallMin(base) / 60) + 1) * 60).getTime();
    e = s + 3600000;
  }
  const allDay = !!src.allDay;
  const lastDay = allDay ? new Date(e - CAL_DAY) : new Date(e);
  const guests = ev ? (ev.attendees || []).filter((a) => !a.self).map((a) => (a.name ? mailFormatAddress(a) : a.email)).join(', ') : ((draft && draft.attendees) || []).join(', ');
  const desc = ev ? calDescText(ev.description) : src.description || '';
  const v = (x) => escapeHtml(x == null ? '' : String(x));
  box.innerHTML =
    '<div class="ce-box"><div class="ce-title">' + (ev ? 'Edit event' : src.dup ? 'Duplicate event' : 'New event') + (ev && ev.recurringEventId ? ' <span class="cp-dim">· this occurrence only</span>' : '') + '</div>' +
    '<label class="ce-f"><span>Title</span><input data-e="summary" type="text" spellcheck="false" value="' + v(src.summary === '(no title)' ? '' : src.summary) + '" /></label>' +
    '<label class="ce-f ce-check"><input data-e="allDay" type="checkbox"' + (allDay ? ' checked' : '') + ' /> All day</label>' +
    '<div class="ce-f ce-when"><span>From</span><input data-e="sd" type="date" value="' + calDayKey(new Date(s)) + '" /><input data-e="st" type="time" step="300" value="' + calHM(s) + '" /></div>' +
    '<div class="ce-f ce-when"><span>To</span><input data-e="ed" type="date" value="' + calDayKey(lastDay) + '" /><input data-e="et" type="time" step="300" value="' + calHM(e) + '" /></div>' +
    '<label class="ce-f"><span>Where</span><input data-e="location" type="text" spellcheck="false" value="' + v(src.location) + '" /></label>' +
    '<label class="ce-f ce-guests"><span>Guests</span><input data-e="guests" type="text" spellcheck="false" placeholder="names or addresses, separated by commas" value="' + v(guests) + '" /><div class="ce-sug hidden"></div></label>' +
    (ev && ev.meetLink ? '<div class="ce-f cp-dim">Video: ' + v(ev.meetLink) + '</div>' : '<label class="ce-f ce-check"><input data-e="meet" type="checkbox" /> Add a Google Meet link</label>') +
    '<label class="ce-f"><span>Notes</span><textarea data-e="description" rows="4" spellcheck="false">' + v(desc) + '</textarea></label>' +
    '<div class="ce-err"></div>' +
    '<div class="ce-btns">' + (ev ? '<button class="cal-btn" data-ce="delete">🗑 Delete</button>' : '') + '<span class="cal-spacer"></span><button class="cal-btn cal-primary" data-ce="save">Save</button><button class="cal-btn" data-ce="cancel">Cancel</button></div></div>';
  box.classList.remove('hidden');
  const f = (k) => box.querySelector('[data-e="' + k + '"]');
  const syncAllDay = () => {
    f('st').disabled = f('et').disabled = f('allDay').checked;
  };
  syncAllDay();
  f('allDay').addEventListener('change', syncAllDay);
  calWireGuests(f('guests'), box.querySelector('.ce-sug'));
  if (typeof mailBook !== 'undefined' && !mailBook.length && typeof mailLoadContacts === 'function') mailLoadContacts();
  const close = () => {
    box.classList.add('hidden');
    box.innerHTML = '';
    st.rec && st.rec.paneEl.focus({ preventScroll: true });
  };
  const err = (t) => (box.querySelector('.ce-err').textContent = t);
  const save = async () => {
    const ad = f('allDay').checked;
    let start;
    let end;
    if (ad) {
      if (!f('sd').value || !f('ed').value) return err('Pick the days.');
      start = f('sd').value;
      end = calDayKey(calAddDays(calFromKey(f('ed').value), 1));
      if (end <= start) return err('The last day is before the first.');
    } else {
      if (!f('sd').value || !f('st').value || !f('ed').value || !f('et').value) return err('Pick a start and an end.');
      const [sh, sm] = f('st').value.split(':').map(Number);
      const [eh, em] = f('et').value.split(':').map(Number);
      const a = calAt(calFromKey(f('sd').value), sh * 60 + sm);
      const b = calAt(calFromKey(f('ed').value), eh * 60 + em);
      if (b <= a) return err('The end is before the start.');
      start = a.toISOString();
      end = b.toISOString();
    }
    const emails = mailSplit(f('guests').value).map((x) => mailAddr(x)).filter((x) => /@/.test(x));
    const bad = mailSplit(f('guests').value).filter((x) => !/@/.test(mailAddr(x)));
    if (bad.length) return err('Not an address: ' + bad.join(', ') + ' - pick from the list or type the address.');
    const body = {
      summary: f('summary').value.trim() || '(no title)',
      allDay: ad,
      start,
      end,
      location: f('location').value.trim(),
      description: f('description').value,
      attendees: emails,
      meet: !!(f('meet') && f('meet').checked),
    };
    if (!ev && src.colorId) body.colorId = src.colorId; // a duplicate keeps its colour
    if (!ev) {
      close();
      return calCreate(body);
    }
    // only what changed goes to Google
    const patch = {};
    if (body.summary !== ev.summary) patch.summary = body.summary;
    if (body.location !== (ev.location || '')) patch.location = body.location;
    if (body.description !== desc) patch.description = body.description;
    const old = calSpan(ev);
    const now = calSpan(body);
    if (ad !== !!ev.allDay || old.s !== now.s || old.e !== now.e) Object.assign(patch, { allDay: ad, start, end });
    const before = new Set(calOthers(ev).map((a) => a.email.toLowerCase()));
    const after = new Set(emails.map((x) => x.toLowerCase()));
    if (before.size !== after.size || [...after].some((x) => !before.has(x))) patch.attendees = emails;
    if (body.meet) patch.meet = true;
    if (!Object.keys(patch).length) return close();
    const send = calOthers(ev).length || emails.length ? await calAsk('Send the change to the guests?', [['all', 'Send'], ['none', "Don't send"]]) : 'none';
    if (!send) return;
    box.querySelector('[data-ce="save"]').disabled = true;
    const r = await api.calUpdate({ eventId: ev.id, patch, sendUpdates: send });
    if (!r || !r.ok) {
      box.querySelector('[data-ce="save"]').disabled = false;
      return err('Not saved: ' + ((r && r.error) || 'unknown'));
    }
    close();
    calPut(r.event);
    calRender();
    calChanged();
    calToast('Saved · ' + calTimeText(r.event));
  };
  box.onclick = (e2) => {
    const b = e2.target.closest('[data-ce]');
    if (!b) return;
    if (b.dataset.ce === 'save') save();
    else if (b.dataset.ce === 'delete') {
      close();
      calDelete(ev);
    } else close();
  };
  box.onkeydown = (e2) => {
    e2.stopPropagation();
    if (e2.key === 'Escape') close();
    else if (e2.key === 'Enter' && (e2.ctrlKey || e2.metaKey || e2.target.tagName === 'INPUT')) {
      if (e2.target.dataset.e === 'guests' && !box.querySelector('.ce-sug').classList.contains('hidden')) return; // the list takes it
      e2.preventDefault();
      save();
    }
  };
  f('summary').focus();
}
// Guests: the address book of the Mail tab (mailSuggest / mailBook), a small list under the field.
function calWireGuests(inp, list) {
  const st = { items: [], sel: 0 };
  const close = () => list.classList.add('hidden');
  const draw = () => {
    list.innerHTML = st.items.map((c, i) => '<div class="ce-si' + (i === st.sel ? ' sel' : '') + '" data-i="' + i + '"><b>' + escapeHtml(c.name || c.email) + '</b>' + (c.name ? ' <span>' + escapeHtml(c.email) + '</span>' : '') + '</div>').join('');
  };
  const accept = (c) => {
    const tok = mailTokenAt(inp.value, inp.selectionStart);
    let end = tok.end;
    const sep = /^[,;]\s*/.exec(inp.value.slice(end));
    if (sep) end += sep[0].length;
    const text = (tok.start > 0 ? ' ' : '') + mailFormatAddress(c) + ', ';
    inp.value = inp.value.slice(0, tok.start) + text + inp.value.slice(end);
    const at = tok.start + text.length;
    inp.setSelectionRange(at, at);
    close();
  };
  inp.addEventListener('input', () => {
    const tok = mailTokenAt(inp.value, inp.selectionStart);
    if (!tok.text.trim() || typeof mailSuggest !== 'function') return close();
    const have = new Set(mailSplit(inp.value).map((x) => mailAddr(x).toLowerCase()));
    st.items = mailSuggest(tok.text, have, 6);
    st.sel = 0;
    if (!st.items.length) return close();
    draw();
    list.classList.remove('hidden');
  });
  inp.addEventListener('keydown', (e) => {
    if (list.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      st.sel = (st.sel + (e.key === 'ArrowDown' ? 1 : -1) + st.items.length) % st.items.length;
      draw();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      accept(st.items[st.sel]);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  inp.addEventListener('blur', () => setTimeout(close, 150));
  // mousedown, not click: the field keeps the focus
  list.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const it = e.target.closest('[data-i]');
    if (it) accept(st.items[+it.dataset.i]);
  });
}

// ---- dragging on the grid: make, move, make longer ----
function calGhost(day, top, bottom, text) {
  const grid = calEl('.cal-grid');
  if (!grid) return;
  grid.querySelectorAll('.cal-ghost').forEach((g) => g.remove());
  if (day == null) return;
  const col = grid.querySelector('.cal-day[data-day="' + day + '"]');
  if (!col) return;
  const hh = calSt.saved.hourH;
  const g = document.createElement('div');
  g.className = 'cal-ghost';
  g.style.top = (top / 60) * hh + 'px';
  g.style.height = Math.max(12, ((bottom - top) / 60) * hh - 1) + 'px';
  g.textContent = text || '';
  col.appendChild(g);
}
// The day column under a point and the minute there (0-1440).
function calPointAt(x, y) {
  const days = [...calSt.rec.paneEl.querySelectorAll('.cal-grid .cal-day')];
  if (!days.length) return null;
  let i = days.findIndex((d) => {
    const r = d.getBoundingClientRect();
    return x >= r.left && x < r.right;
  });
  if (i === -1) i = x < days[0].getBoundingClientRect().left ? 0 : 6;
  const r = days[i].getBoundingClientRect();
  return { day: i, min: Math.max(0, Math.min(1440, ((y - r.top) / calSt.saved.hourH) * 60)) };
}
function calWire(rec) {
  const p = rec.paneEl;
  const grid = p.querySelector('.cal-grid');
  // the toolbar, the banner, the toast
  p.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (b) {
      const c = b.dataset.c;
      if (c === 'today') calGo(new Date());
      else if (c === 'prev') calGo(calAddDays(calSt.weekStart, -7));
      else if (c === 'next') calGo(calAddDays(calSt.weekStart, 7));
      else if (c === 'refresh') {
        calLoadMeta();
        calLoad(true);
      } else if (c === 'new') calEditor(null, null);
      else if (c === 'settings') openSettings();
      else if (c === 'undo' && calSt.undo) {
        const u = calSt.undo;
        calSt.undo = null;
        u();
      }
      return;
    }
    const z = e.target.closest('[data-zone]');
    if (z) {
      const on = calSt.saved.zones;
      const zone = z.dataset.zone;
      calSt.saved.zones = on.includes(zone) ? on.filter((x) => x !== zone) : on.concat(zone).slice(-CAL_ZONES_MAX);
      calSave();
      calRender();
      return;
    }
    // the bar row: an event, or an empty day = a new all-day event
    const bar = e.target.closest('.cal-bar');
    if (bar) return calShowPop(calFind(bar.dataset.id), bar);
    const adb = e.target.closest('.cal-adb');
    if (adb) {
      const r = adb.getBoundingClientRect();
      const day = Math.max(0, Math.min(6, Math.floor(((e.clientX - r.left) / r.width) * 7)));
      calHidePop();
      return calQuick(day, 0, 0, true);
    }
  });
  // the popover
  p.querySelector('.cal-pop').addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (a) {
      e.preventDefault();
      if (typeof mailFollowLink === 'function') mailFollowLink(a.getAttribute('href'), false);
      return;
    }
    const b = e.target.closest('[data-p]');
    if (!b) return;
    const ev = calFind(p.querySelector('.cal-pop').dataset.id);
    if (!ev) return calHidePop();
    const k = b.dataset.p;
    if (k === 'close') calHidePop();
    else if (k === 'join') api.openExternal(ev.meetLink);
    else if (k === 'open') api.openExternal(ev.htmlLink);
    else if (k === 'edit') calEditor(ev, null);
    else if (k === 'delete') calDelete(ev);
    else if (k === 'rsvp') calRespond(ev, b.dataset.r);
  });
  // a click somewhere else closes the popover - and the menu, wherever the click is
  p.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.cal-pop, .cal-ev, .cal-bar, .cal-ask')) calHidePop();
  });
  if (!calSt.menuWired) {
    calSt.menuWired = true; // once, not once per calendar tab ever opened
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (!(e.target.closest && e.target.closest('.cal-menu'))) calHideMenu();
      },
      true
    );
  }
  // right-click: on an event its colour and what can be done with it; on free time, a new event
  p.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('.cal-ev, .cal-bar');
    const free = !el && e.target.closest('.cal-day, .cal-adb');
    if (!el && !free) return;
    e.preventDefault();
    calHidePop();
    if (el) {
      const ev = calFind(el.dataset.id);
      if (ev) calMenu(ev, e.clientX, e.clientY, null);
      return;
    }
    const pt = e.target.closest('.cal-adb') ? (() => {
      const r = e.target.closest('.cal-adb').getBoundingClientRect();
      return { day: Math.max(0, Math.min(6, Math.floor(((e.clientX - r.left) / r.width) * 7))), min: 0 };
    })() : calPointAt(e.clientX, e.clientY);
    calMenu(null, e.clientX, e.clientY, pt);
  });
  p.querySelector('.cal-menu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-m], [data-color]');
    if (b && !b.disabled) calMenuAct(b);
  });
  p.querySelector('.cal-scroll').addEventListener('scroll', calHideMenu, { passive: true });
  // make / move / resize
  grid.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !calSt.rec) return;
    const pt = calPointAt(e.clientX, e.clientY);
    if (!pt) return;
    const evEl = e.target.closest('.cal-ev');
    const ev = evEl ? calFind(evEl.dataset.id) : null;
    calSt.drag = {
      kind: evEl ? (e.target.closest('.cal-grip') ? 'resize' : 'move') : 'create',
      x0: e.clientX,
      y0: e.clientY,
      pt0: pt,
      moved: false,
      ev,
      el: evEl,
      seg: evEl ? { day: +evEl.dataset.day, top: +evEl.dataset.top, bottom: +evEl.dataset.bottom } : null,
      at: null,
    };
    try {
      grid.setPointerCapture(e.pointerId);
    } catch (_) {
      /* a synthetic event has no pointer to capture */
    }
    e.preventDefault(); // no text selection while dragging
    p.focus({ preventScroll: true });
  });
  grid.addEventListener('pointermove', (e) => {
    const d = calSt.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return;
    if (!d.moved) {
      d.moved = true;
      calHidePop();
      if (d.kind !== 'create' && !calEditable(d.ev)) {
        d.kind = 'none';
        calNoEdit();
      }
    }
    const pt = calPointAt(e.clientX, e.clientY);
    if (!pt) return;
    if (d.kind === 'create') {
      const a = Math.min(d.pt0.min, pt.min);
      const b = Math.max(d.pt0.min, pt.min);
      const top = Math.floor(a / CAL_SNAP) * CAL_SNAP;
      const bottom = Math.max(top + CAL_SNAP, Math.ceil(b / CAL_SNAP) * CAL_SNAP);
      d.at = { day: d.pt0.day, top, bottom };
      calGhost(d.pt0.day, top, bottom, calHM(calAt(calAddDays(calSt.weekStart, d.pt0.day), top)) + ' - ' + calHM(calAt(calAddDays(calSt.weekStart, d.pt0.day), bottom)));
    } else if (d.kind === 'move') {
      const len = d.seg.bottom - d.seg.top;
      const top = Math.max(0, Math.min(1440 - Math.min(len, 1440), calSnap(d.seg.top + (pt.min - d.pt0.min))));
      d.at = { day: pt.day, top, bottom: top + len };
      if (d.el) d.el.classList.add('dragging');
      calGhost(pt.day, top, Math.min(1440, top + len), calHM(calAt(calAddDays(calSt.weekStart, pt.day), top)));
    } else if (d.kind === 'resize') {
      const bottom = Math.max(d.seg.top + CAL_SNAP, Math.min(1440, calSnap(d.seg.bottom + (pt.min - d.pt0.min))));
      d.at = { day: d.seg.day, top: d.seg.top, bottom };
      if (d.el) d.el.classList.add('dragging');
      calGhost(d.seg.day, d.seg.top, bottom, 'until ' + calHM(calAt(calAddDays(calSt.weekStart, d.seg.day), bottom)));
    }
  });
  const finish = (e) => {
    const d = calSt.drag;
    calSt.drag = null;
    if (!d) return;
    if (d.el) d.el.classList.remove('dragging');
    const ws = calSt.weekStart;
    if (!d.moved) {
      calGhost(null);
      if (d.ev) return calShowPop(d.ev, d.el); // a click on an event
      // a click on empty time: half an hour there
      const top = Math.floor(d.pt0.min / 30) * 30;
      calGhost(d.pt0.day, top, Math.min(1440, top + 30));
      return calQuick(d.pt0.day, top, Math.min(1440, top + 30), false);
    }
    if (!d.at || d.kind === 'none') return calGhost(null);
    if (d.kind === 'create') return calQuick(d.at.day, d.at.top, d.at.bottom, false);
    calGhost(null);
    const { s, e: end } = calSpan(d.ev);
    if (d.kind === 'move') {
      const delta = calAt(calAddDays(ws, d.at.day), d.at.top).getTime() - calAt(calAddDays(ws, d.seg.day), d.seg.top).getTime();
      if (!delta) return calRender();
      return calChangeTimes(d.ev, s + delta, end + delta, 'Moved');
    }
    const newEnd = calAt(calAddDays(ws, d.at.day), d.at.bottom).getTime();
    if (newEnd === end) return calRender();
    return calChangeTimes(d.ev, s, newEnd, 'Changed');
  };
  grid.addEventListener('pointerup', finish);
  grid.addEventListener('pointercancel', () => {
    calSt.drag = null;
    calGhost(null);
    calRender();
  });
  // Ctrl + wheel: taller or shorter hours, the time under the pointer stays put
  p.querySelector('.cal-scroll').addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const sc = e.currentTarget;
      const old = calSt.saved.hourH;
      const y = e.clientY - sc.getBoundingClientRect().top + sc.scrollTop;
      const next = Math.max(CAL_HOUR_MIN, Math.min(CAL_HOUR_MAX, old + (e.deltaY < 0 ? 6 : -6)));
      if (next === old) return;
      calSt.saved.hourH = next;
      calRender();
      sc.scrollTop = (y * next) / old - (e.clientY - sc.getBoundingClientRect().top);
      clearTimeout(calSt.zoomSave);
      calSt.zoomSave = setTimeout(calSave, 500);
    },
    { passive: false }
  );
  // keys
  p.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (t && t.closest && t.closest('.cal-edit, .cal-quick, .cal-ask')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const ev = calSt.sel ? calFind(calSt.sel) : null;
    const k = e.key;
    let done = true;
    if (k === 't') calGo(new Date());
    else if (k === 'ArrowLeft' || k === 'k') calGo(calAddDays(calSt.weekStart, -7));
    else if (k === 'ArrowRight' || k === 'j') calGo(calAddDays(calSt.weekStart, 7));
    else if (k === 'n') calEditor(null, null);
    else if (k === 'r') calLoad(true);
    else if (k === 'z' && calSt.undo) {
      const u = calSt.undo;
      calSt.undo = null;
      u();
    } else if (k === 'Escape') {
      calHideMenu();
      calHidePop();
      calSt.sel = null;
      calRender();
    } else if ((k === 'Delete' || k === 'Backspace') && ev) calDelete(ev);
    else if (k === 'Enter' && ev) calShowPop(ev, calEl('.cal-ev[data-id="' + CSS.escape(ev.id) + '"], .cal-bar[data-id="' + CSS.escape(ev.id) + '"]'));
    else if (k === 'e' && ev) calEditor(ev, null);
    else done = false;
    if (done) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  // a click on the pane gives the keys back to it (not out of a field)
  p.addEventListener('mouseup', (e) => {
    if (e.target.closest && e.target.closest('input, textarea, select, .cal-edit, .cal-quick, .cal-ask')) return;
    if (document.activeElement !== p) p.focus({ preventScroll: true });
  });
  new ResizeObserver(() => {
    if (calSt.rec === rec && p.classList.contains('active')) {
      const sc = p.querySelector('.cal-scroll');
      p.style.setProperty('--cal-sb', sc.offsetWidth - sc.clientWidth + 'px');
    }
  }).observe(p);
}

if (typeof tabKinds !== 'undefined') {
  tabKinds.calendar = { title: 'Calendar', glyph: '📅', color: '#4ea1ff', create: createCalendarTab, onShow: calOnShow, onClose: calOnClose, restore: calRestore };
  document.getElementById('calendar-btn')?.addEventListener('click', () => createCalendarTab());
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calAddDays, calWeekStart, calDayKey, calFromKey, calWallMin, calAt, calSnap, calSpan, calIsBar, calSegments, calLanes, calBars, calRangeLabel, calZoneTime, calZoneShort, calZoneGutter, calHM };
}
