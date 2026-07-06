'use strict';

/* global Terminal, FitAddon, WebLinksAddon */

const api = window.sshApi;

// ---- Terminal themes ----
// A shared, readable 16-color ANSI palette; themes override bg/fg/cursor so that
// colorized output (ls --color, vim, etc.) still shows colors in every theme.
const ANSI = {
  black: '#1d1f21',
  red: '#cc6666',
  green: '#b5bd68',
  yellow: '#f0c674',
  blue: '#81a2be',
  magenta: '#b294bb',
  cyan: '#8abeb7',
  white: '#c5c8c6',
  brightBlack: '#666666',
  brightRed: '#ff6f6f',
  brightGreen: '#cdee69',
  brightYellow: '#ffe377',
  brightBlue: '#9cc4ff',
  brightMagenta: '#d4a8e0',
  brightCyan: '#a3e7e0',
  brightWhite: '#ffffff',
};

const THEMES = {
  'Tomorrow Night': {
    background: '#1d1f21',
    foreground: '#c5c8c6',
    cursor: '#4ea1ff',
    cursorAccent: '#1d1f21',
    selectionBackground: '#3a5070',
    ...ANSI,
  },
  'Green on Black': {
    background: '#000000',
    foreground: '#33ff33',
    cursor: '#33ff33',
    cursorAccent: '#000000',
    selectionBackground: '#0a4a0a',
    ...ANSI,
  },
  'Amber on Black': {
    background: '#000000',
    foreground: '#ffb000',
    cursor: '#ffb000',
    cursorAccent: '#000000',
    selectionBackground: '#4a3300',
    ...ANSI,
  },
  'Solarized Dark': {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#93a1a1',
    cursorAccent: '#002b36',
    selectionBackground: '#073642',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#586e75',
    brightRed: '#cb4b16',
    brightGreen: '#859900',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
  Dracula: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    cursorAccent: '#282a36',
    selectionBackground: '#44475a',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
};

const DEFAULT_THEME = 'Tomorrow Night';
let currentTheme = DEFAULT_THEME;

let webBookmarks = []; // [{ name, url }] shared across all web tabs
let sshHops = {}; // serverKey -> [ssh commands] (auto-hops, per server)
let remoteDebugPort = 0; // CDP port (0 = off); applied at startup in main

// Stable per-server key for auto-hop storage.
function sshServerKey(p) {
  return `${p.username}@${p.host}:${p.port || 22}`;
}
function persistSshHops() {
  api.saveSettings({ sshHops });
}

/** @type {Map<string, object>} tabId -> tab record */
const tabs = new Map();
let activeTabId = null;
let tabCounter = 0;

const DEFAULT_FONT_SIZE = 14;
let fontSize = DEFAULT_FONT_SIZE;

const els = {
  tabs: document.getElementById('tabs'),
  terminals: document.getElementById('terminals'),
  newTabBtn: document.getElementById('new-tab-btn'),
  themeSelect: document.getElementById('theme-select'),
  webFind: document.getElementById('web-find'),
  webFindInput: document.getElementById('web-find-input'),
  webFindInfo: document.getElementById('web-find-info'),
  webFindPrev: document.getElementById('web-find-prev'),
  webFindNext: document.getElementById('web-find-next'),
  webFindClose: document.getElementById('web-find-close'),
  tabHelp: document.getElementById('tab-help'),
  tabHelpHops: document.getElementById('tab-help-hops'),
  tabHelpCmds: document.getElementById('tab-help-cmds'),
  tabHelpPaste: document.getElementById('tab-help-paste'),
  tabHelpProject: document.getElementById('tab-help-project'),
  tabHelpView: document.getElementById('tab-help-view'),
  grabOverlay: document.getElementById('grab-overlay'),
  grabPath: document.getElementById('grab-path'),
  grabStatus: document.getElementById('grab-status'),
  grabGo: document.getElementById('grab-go'),
  grabPreview: document.getElementById('grab-preview'),
  grabCancel: document.getElementById('grab-cancel'),
  webHelp: document.getElementById('web-help'),
  webHelpCopy: document.getElementById('web-help-copy'),
  setQuickCmds: document.getElementById('set-quick-cmds'),
  quickCmdsSave: document.getElementById('quick-cmds-save'),
  quickCmdsMsg: document.getElementById('quick-cmds-msg'),
  searchBar: document.getElementById('search-bar'),
  searchInput: document.getElementById('search-input'),
  searchInfo: document.getElementById('search-info'),
  searchPrev: document.getElementById('search-prev'),
  searchNext: document.getElementById('search-next'),
  searchClose: document.getElementById('search-close'),
  slackBtn: document.getElementById('slack-btn'),
  webBtn: document.getElementById('web-btn'),
  notesBtn: document.getElementById('notes-btn'),
  notePalette: document.getElementById('note-palette'),
  localTermBtn: document.getElementById('local-term-btn'),
  codeBtn: document.getElementById('code-btn'),
  emptyState: document.getElementById('empty-state'),
  sftpBtn: document.getElementById('sftp-btn'),
  sftpPanel: document.getElementById('sftp-panel'),
  sftpUp: document.getElementById('sftp-up'),
  sftpRefresh: document.getElementById('sftp-refresh'),
  sftpUpload: document.getElementById('sftp-upload'),
  sftpClose: document.getElementById('sftp-close'),
  sftpPath: document.getElementById('sftp-path'),
  sftpListEl: document.getElementById('sftp-list'),
  sftpStatus: document.getElementById('sftp-status'),
  slackOverlay: document.getElementById('slack-overlay'),
  slackConnStatus: document.getElementById('slack-conn-status'),
  slackChannel: document.getElementById('slack-channel'),
  slackError: document.getElementById('slack-error'),
  slackSettingsLink: document.getElementById('slack-settings-link'),
  slackCancelBtn: document.getElementById('slack-cancel-btn'),
  slackOpenBtn: document.getElementById('slack-open-btn'),
  settingsBtn: document.getElementById('settings-btn'),
  pet: document.getElementById('cockpit-pet'),
  reminderOverlay: document.getElementById('reminder-overlay'),
  reminderMsg: document.getElementById('reminder-msg'),
  cmdPalette: document.getElementById('cmd-palette'),
  cmdPaletteInput: document.getElementById('cmd-palette-input'),
  cmdPaletteList: document.getElementById('cmd-palette-list'),
  settingsOverlay: document.getElementById('settings-overlay'),
  settingsSlackStatus: document.getElementById('settings-slack-status'),
  setSlackBot: document.getElementById('set-slack-bot'),
  setSlackApp: document.getElementById('set-slack-app'),
  setSlackConnect: document.getElementById('set-slack-connect'),
  setSlackForget: document.getElementById('set-slack-forget'),
  setSlackNotify: document.getElementById('set-slack-notify'),
  settingsError: document.getElementById('settings-error'),
  settingsCloseBtn: document.getElementById('settings-close-btn'),
  rightSidebar: document.getElementById('right-sidebar'),
  sidebarDivider: document.getElementById('sidebar-divider'),
  gmailPanel: document.getElementById('gmail-panel'),
  gmailRefresh: document.getElementById('gmail-refresh'),
  gmailItems: document.getElementById('gmail-items'),
  slackFeed: document.getElementById('slack-feed'),
  slackFeedItems: document.getElementById('slack-feed-items'),
  whatsappFeed: document.getElementById('whatsapp-feed'),
  whatsappFeedItems: document.getElementById('whatsapp-feed-items'),
  settingsWaStatus: document.getElementById('settings-wa-status'),
  waQrWrap: document.getElementById('wa-qr-wrap'),
  waQr: document.getElementById('wa-qr'),
  setWaConnect: document.getElementById('set-wa-connect'),
  setWaLogout: document.getElementById('set-wa-logout'),
  gmailPreview: document.getElementById('gmail-preview'),
  calendar: document.getElementById('calendar'),
  meetingFlash: document.getElementById('meeting-flash'),
  calendarPreview: document.getElementById('calendar-preview'),
  calendarPreviewList: document.getElementById('calendar-preview-list'),
  settingsGoogleStatus: document.getElementById('settings-google-status'),
  setGoogleId: document.getElementById('set-google-id'),
  setGoogleSecret: document.getElementById('set-google-secret'),
  setGoogleConnect: document.getElementById('set-google-connect'),
  setGoogleForget: document.getElementById('set-google-forget'),
  settingsGoogleError: document.getElementById('settings-google-error'),
  setClaudeWatch: document.getElementById('set-claude-watch'),
  setMeetingChime: document.getElementById('set-meeting-chime'),
  setCmdDone: document.getElementById('set-cmd-done'),
  setBbOn: document.getElementById('set-bb-on'),
  setBbText: document.getElementById('set-bb-text'),
  setBbDays: document.getElementById('set-bb-days'),
  setBbClear: document.getElementById('set-bb-clear'),
  bbStats: document.getElementById('bb-stats'),
  setReminderOn: document.getElementById('set-reminder-on'),
  setReminderText: document.getElementById('set-reminder-text'),
  setReminderMin: document.getElementById('set-reminder-min'),
  setReminderMax: document.getElementById('set-reminder-max'),
  setPip: document.getElementById('set-pip'),
  webExtAdd: document.getElementById('web-ext-add'),
  webExtClear: document.getElementById('web-ext-clear'),
  webExtList: document.getElementById('web-ext-list'),
  webExtMsg: document.getElementById('web-ext-msg'),
  setDebugPort: document.getElementById('set-debug-port'),
  debugPortSave: document.getElementById('debug-port-save'),
  debugPortMsg: document.getElementById('debug-port-msg'),
  setAutoHop: document.getElementById('set-auto-hop'),
  setAutoProject: document.getElementById('set-auto-project'),
  setAutoHopCollect: document.getElementById('set-auto-hop-collect'),
  sshHopsList: document.getElementById('ssh-hops-list'),
  sshHopsSave: document.getElementById('ssh-hops-save'),
  sshHopsMsg: document.getElementById('ssh-hops-msg'),
  setSshProtocol: document.getElementById('set-ssh-protocol'),
  setSshJumpHost: document.getElementById('set-ssh-jumphost'),
  setSshJumpHostSaved: document.getElementById('set-ssh-jumphost-saved'),
  sshProtocolMsg: document.getElementById('ssh-protocol-msg'),
  statusText: document.getElementById('status-text'),
  overlay: document.getElementById('dialog-overlay'),
  savedList: document.getElementById('saved-list'),
  fName: document.getElementById('f-name'),
  fHost: document.getElementById('f-host'),
  fPort: document.getElementById('f-port'),
  fUser: document.getElementById('f-user'),
  fAuth: document.getElementById('f-auth'),
  keyFields: document.getElementById('key-fields'),
  fKey: document.getElementById('f-key'),
  fPassphrase: document.getElementById('f-passphrase'),
  passwordFields: document.getElementById('password-fields'),
  fPassword: document.getElementById('f-password'),
  browseKeyBtn: document.getElementById('browse-key-btn'),
  saveSessionBtn: document.getElementById('save-session-btn'),
  deleteSessionBtn: document.getElementById('delete-session-btn'),
  cancelBtn: document.getElementById('cancel-btn'),
  connectBtn: document.getElementById('connect-btn'),
  dialogError: document.getElementById('dialog-error'),
};

let savedSessions = [];

// ---------------------------------------------------------------------------
// Tab management
// ---------------------------------------------------------------------------
function newTabId() {
  tabCounter += 1;
  return `tab-${tabCounter}-${Math.floor(performance.now())}`;
}

// Build the shared tab button + content pane used by both SSH and Slack tabs.
function createTabChrome(id, title, kind) {
  const tabEl = document.createElement('div');
  tabEl.className = `tab tab--${kind || 'ssh'}`;
  tabEl.dataset.id = id;
  tabEl.draggable = true;
  tabEl.innerHTML =
    '<span class="kind-glyph"></span><span class="title"></span><span class="unread"></span><span class="close" title="Close">✕</span>';
  tabEl.querySelector('.kind-glyph').textContent =
    kind === 'slack' ? '#' : kind === 'web' ? '🌐' : kind === 'notes' ? '📝' : kind === 'deck' ? '🏠' : '>_';
  const titleEl = tabEl.querySelector('.title');
  titleEl.textContent = title;
  titleEl.title = 'Double-click to rename';
  titleEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startTabRename(id, titleEl);
  });
  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('close')) {
      closeTab(id);
    } else {
      activateTab(id);
    }
  });
  tabEl.addEventListener('dragstart', (e) => {
    tabEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  tabEl.addEventListener('dragend', () => {
    tabEl.classList.remove('dragging');
    syncTabOrderFromDom();
  });
  // Terminal tabs: hover shows the shortcut cheat-sheet.
  if (kind === 'ssh' || kind === 'local') {
    tabEl.addEventListener('mouseenter', () => {
      // Hovering an attention-flagged tab is enough to acknowledge it (no click needed).
      const r = tabs.get(tabEl.dataset.id);
      if (r) clearTabAttention(r);
      showTabHelp(tabEl);
    });
    tabEl.addEventListener('mouseleave', hideTabHelp);
  } else if (kind === 'web') {
    // Web tabs: hover shows a CDP helper snippet to hand to Claude.
    tabEl.addEventListener('mouseenter', () => showWebHelp(tabEl));
    tabEl.addEventListener('mouseleave', hideWebHelp);
  }
  els.tabs.appendChild(tabEl);

  const paneEl = document.createElement('div');
  paneEl.className = 'term-pane';
  paneEl.dataset.id = id;
  els.terminals.appendChild(paneEl);

  return { tabEl, paneEl };
}

let tabHelpTimer = null;
let tabHelpTabId = null;
let quickCommands = [];

function showTabHelp(tabEl) {
  clearTimeout(tabHelpTimer);
  const p = els.tabHelp;
  tabHelpTabId = tabEl.dataset.id;
  const rec = tabs.get(tabHelpTabId);

  // Paste clipboard into this terminal.
  els.tabHelpPaste.innerHTML = '';
  const pasteBtn = document.createElement('button');
  pasteBtn.className = 'th-cmd th-paste';
  pasteBtn.textContent = '📋 Paste clipboard';
  pasteBtn.title = 'Paste clipboard into this terminal';
  pasteBtn.addEventListener('click', () => {
    const text = api.clipboardRead();
    const r = tabs.get(tabHelpTabId);
    if (text && r && r.term) r.term.paste(text);
    els.tabHelp.classList.add('hidden');
    if (r && r.term) r.term.focus();
  });
  els.tabHelpPaste.appendChild(pasteBtn);

  // Grab a file from whatever shell this tab is currently in (even a nested ssh).
  if (rec && (rec.kind === 'ssh' || rec.kind === 'local') && rec.term) {
    const grabBtn = document.createElement('button');
    grabBtn.className = 'th-cmd th-plain';
    grabBtn.textContent = '📥 Get a file…';
    grabBtn.title = 'Download a file through this terminal - works even inside a nested ssh / sudo / container';
    grabBtn.addEventListener('click', () => {
      els.tabHelp.classList.add('hidden');
      openGrabOverlay(rec);
    });
    els.tabHelpPaste.appendChild(grabBtn);

    // Capture the current terminal selection into a sticky note, auto-tagged with the
    // host, timestamp, and the command that produced it (Ctrl+Shift+N does the same).
    const hasSel = !!(rec.term.getSelection() || '').trim();
    const noteBtn = document.createElement('button');
    noteBtn.className = 'th-cmd th-plain' + (hasSel ? '' : ' th-disabled');
    noteBtn.textContent = '🗒 Selection → note';
    noteBtn.title = hasSel
      ? 'Save the selected output to a note, tagged with host, time, and the command that produced it (Ctrl+Shift+N)'
      : 'Select some terminal output first, then capture it to a note (Ctrl+Shift+N)';
    noteBtn.addEventListener('click', () => {
      els.tabHelp.classList.add('hidden');
      if (!captureTermNote(rec)) {
        // Nothing selected - keep focus on the terminal so the user can select.
        if (rec.term) rec.term.focus();
      }
    });
    els.tabHelpPaste.appendChild(noteBtn);
  }

  // Port forwarding (SSH tunnels) - only for real ssh connections.
  if (rec && rec.kind === 'ssh') {
    const tunBtn = document.createElement('button');
    tunBtn.className = 'th-cmd th-plain';
    tunBtn.textContent = '🔀 Port forwarding…';
    tunBtn.title = 'Set up and watch SSH tunnels (local / remote / SOCKS) on this connection';
    tunBtn.addEventListener('click', () => {
      els.tabHelp.classList.add('hidden');
      openTunnels(rec);
    });
    els.tabHelpPaste.appendChild(tunBtn);
  }

  // Record the session and export an asciicast (.cast) you can replay or drop in a ticket.
  if (rec && (rec.kind === 'ssh' || rec.kind === 'local') && rec.term) {
    const recBtn = document.createElement('button');
    recBtn.className = 'th-cmd th-plain';
    recBtn.textContent = rec._rec ? '⏹ Stop & save recording' : '⏺ Record session (.cast)';
    recBtn.title = rec._rec
      ? 'Stop recording and save an asciicast (.cast) file'
      : 'Record this terminal to a shareable asciicast (.cast) - replay with asciinema, or convert to GIF';
    recBtn.addEventListener('click', () => {
      els.tabHelp.classList.add('hidden');
      toggleRecording(rec);
    });
    els.tabHelpPaste.appendChild(recBtn);

    const ttBtn = document.createElement('button');
    ttBtn.className = 'th-cmd th-plain';
    ttBtn.textContent = '🕰 Time travel';
    ttBtn.title = 'Scrub this terminal back through its recent history and see its state at any past moment';
    ttBtn.addEventListener('click', () => {
      els.tabHelp.classList.add('hidden');
      openTimeTravel(rec);
    });
    els.tabHelpPaste.appendChild(ttBtn);
  }

  // Include/exclude this terminal from broadcast typing.
  if (rec && (rec.kind === 'ssh' || rec.kind === 'local') && rec.term) {
    const bcBtn = document.createElement('button');
    bcBtn.className = 'th-cmd th-plain th-toggle';
    const syncBc = () => {
      const inc = rec.bcast !== false;
      bcBtn.textContent = (inc ? '☑' : '☐') + ' ⇄ Include in broadcast';
      bcBtn.classList.toggle('on', broadcastOn && inc);
    };
    syncBc();
    bcBtn.title = 'When broadcast is on, mirror your typing to this terminal too';
    bcBtn.addEventListener('click', () => {
      rec.bcast = rec.bcast === false ? true : false;
      syncBc();
      updateBroadcastUI();
    });
    els.tabHelpPaste.appendChild(bcBtn);
  }

  // Assign this tab to a project (drives auto-switch when it's the active tab).
  renderTrackTimeAs(els.tabHelpProject, rec);

  // View options for this terminal (line numbers on command output).
  els.tabHelpView.innerHTML = '';
  if (rec && rec.kind === 'ssh' && rec.term) {
    const title = document.createElement('div');
    title.className = 'th-title';
    title.textContent = 'View';
    els.tabHelpView.appendChild(title);
    const lnBtn = document.createElement('button');
    lnBtn.className = 'th-cmd th-toggle';
    const sync = () => {
      lnBtn.textContent = (rec.lineNums ? '☑' : '☐') + ' # Line numbers';
      lnBtn.classList.toggle('on', !!rec.lineNums);
    };
    sync();
    lnBtn.title = 'Number the lines of each command’s output';
    lnBtn.addEventListener('click', () => {
      setLineNums(rec, !rec.lineNums);
      sync();
      const r = tabs.get(tabHelpTabId);
      if (r && r.term) r.term.focus();
    });
    els.tabHelpView.appendChild(lnBtn);
  }

  // This server's auto-hop commands, if any are configured.
  const hops = (rec && sshHops[rec.serverKey]) || [];
  els.tabHelpHops.innerHTML = '';
  if (hops.length) {
    const title = document.createElement('div');
    title.className = 'th-title';
    title.textContent = 'Auto-hop (click to run)';
    els.tabHelpHops.appendChild(title);
    for (const c of hops) {
      const b = document.createElement('button');
      b.className = 'th-hop';
      b.textContent = c;
      b.title = 'Click to run · Shift-click to type only';
      b.addEventListener('click', (e) => {
        api.write(tabHelpTabId, e.shiftKey ? c : c + '\r');
        els.tabHelp.classList.add('hidden');
        const r = tabs.get(tabHelpTabId);
        if (r && r.term) r.term.focus();
      });
      els.tabHelpHops.appendChild(b);
    }
  }

  // Quick commands — click to run in this tab.
  els.tabHelpCmds.innerHTML = '';
  if (quickCommands.length) {
    const title = document.createElement('div');
    title.className = 'th-title';
    title.textContent = 'Quick commands (click to run)';
    els.tabHelpCmds.appendChild(title);
    for (const cmd of quickCommands) {
      const b = document.createElement('button');
      b.className = 'th-cmd';
      b.textContent = cmd;
      b.title = 'Click to run · Shift-click to type only (review/edit first)';
      b.addEventListener('click', (e) => {
        // Shift-click types the command without Enter, so you can edit before running.
        api.write(tabHelpTabId, e.shiftKey ? cmd : cmd + '\r');
        els.tabHelp.classList.add('hidden');
        const r = tabs.get(tabHelpTabId);
        if (r && r.term) r.term.focus(); // return focus to the terminal
      });
      els.tabHelpCmds.appendChild(b);
    }
  }

  p.classList.remove('hidden');
  const r = tabEl.getBoundingClientRect();
  p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - p.offsetWidth - 8)) + 'px';
  p.style.top = r.bottom + 4 + 'px';
}
function hideTabHelp() {
  tabHelpTimer = setTimeout(() => els.tabHelp.classList.add('hidden'), 200);
}

// Keep the cheat-sheet open while hovering it (so you can click a quick command).
els.tabHelp.addEventListener('mouseenter', () => clearTimeout(tabHelpTimer));
els.tabHelp.addEventListener('mouseleave', () => els.tabHelp.classList.add('hidden'));

// --- Web tab hover: CDP helper snippet (selectable, to paste to Claude) ---
let webHelpTimer = null;
function showWebHelp(tabEl) {
  clearTimeout(webHelpTimer);
  const rec = tabs.get(tabEl.dataset.id);
  renderTrackTimeAs(document.getElementById('web-help-project'), rec); // project picker (web/VS Code)
  const url = (rec && rec.url) || '(open a page first)';
  const base = url.split('?')[0];
  const port = remoteDebugPort || 9222;
  const note = remoteDebugPort
    ? ''
    : '\n# ⚠ Enable this port in ⚙ Settings → Automation, then restart.\n';
  els.webHelp.querySelector('.wh-body').textContent =
    `Drive THIS page via Chrome DevTools Protocol (port ${port}):${note}
# 1) find targets
curl http://localhost:${port}/json/list

# this tab's page:
${url}

# 2) Playwright (Node)
const { chromium } = require('playwright');
const b = await chromium.connectOverCDP('http://localhost:${port}');
const pg = b.contexts().flatMap(c => c.pages())
  .find(p => p.url().startsWith('${base}'));
await pg.title();                 // read
await pg.click('css-selector');   // interact
await pg.fill('input', 'text');
await pg.evaluate(() => document.body.innerText);`;
  els.webHelp.classList.remove('hidden');
  const r = tabEl.getBoundingClientRect();
  els.webHelp.style.left =
    Math.max(8, Math.min(r.left, window.innerWidth - els.webHelp.offsetWidth - 8)) + 'px';
  els.webHelp.style.top = r.bottom + 4 + 'px';
}
function hideWebHelp() {
  webHelpTimer = setTimeout(() => els.webHelp.classList.add('hidden'), 250);
}
els.webHelp.addEventListener('mouseenter', () => clearTimeout(webHelpTimer));
els.webHelp.addEventListener('mouseleave', () => els.webHelp.classList.add('hidden'));
els.webHelpCopy.addEventListener('click', () => {
  api.clipboardWrite(els.webHelp.querySelector('.wh-body').textContent);
  els.webHelpCopy.textContent = 'Copied!';
  setTimeout(() => (els.webHelpCopy.textContent = 'Copy'), 1200);
});

// Return keyboard focus to the active tab's terminal (used after an overlay/dialog that
// stole focus - e.g. the periodic reminder - is dismissed, so typing lands in the shell again).
function focusActiveTerm() {
  const rec = activeTabId ? tabs.get(activeTabId) : null;
  if (rec && rec.term) rec.term.focus();
}

// Ctrl+PageUp / Ctrl+PageDown scroll the terminal one page. Handled locally so the
// keys move the scrollback instead of being forwarded to the remote shell.
function attachTermScrollKeys(term) {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
      term.scrollPages(e.key === 'PageUp' ? -1 : 1);
      return false; // consume; don't send to the shell
    }
    return true;
  });
}

// --- Smart terminal output: make things in the scrollback clickable. On top of the
// URL links (WebLinksAddon), scan each line for IPs, absolute file paths and JSON and
// register them as xterm links with the right action: SSH to an IP, grab a file path,
// pretty-print JSON. Toggle from the Terminal ▾ menu; on by default.
let smartLinksOn = true;

// IPv4, optionally :port. Full 0-255 octet validation to avoid matching version numbers.
const RE_IPV4 =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?::(\d{1,5}))?\b/g;
// Absolute unix path (/a/b or ~/a/b), at least one segment. Lookbehind keeps it from
// matching the "//" inside a URL like http://host/path.
const RE_PATH = /(?<![\w/])(~?(?:\/[\w.+@%\-]+)+\/?)/g;
// An `ls -l` / `ll` row: a permission mode string, then the usual columns, then the name.
// Type char is captured so we can link only regular files (-) and symlinks (l), not dirs.
const RE_LSL = /^\s*([-dlbcpsD])[-rwxsStT]{9}[.+@]?\s+\d+\s+\S+\s+\S+\s+\S+\s+\w{3}\s+\d+\s+[\d:]{4,5}\s+(.+)$/;
// Actionable-output entities: systemd units anywhere; a PID in `ps aux` / `ps -ef` output;
// a container id at the start of a `docker ps` row. The `d` flag gives capture positions.
const RE_UNIT = /\b[\w@.\-]+\.(?:service|socket|timer|target|mount)\b/g;
const RE_PS_AUX = /^(\S+)\s+(\d+)\s+\d+\.\d+\s+\d+\.\d+\b/d; // user PID %CPU %MEM …
const RE_PS_EF = /^(\S+)\s+(\d+)\s+(\d+)\s+\d+\s+[\w:]+\s+\S/d; // UID PID PPID C STIME …
const RE_DOCKER_PS = /^([0-9a-f]{12})\s+\S+\s+\S/d; // CONTAINER-ID IMAGE COMMAND …

function smartFindLinks(text) {
  const out = [];
  let m;
  RE_IPV4.lastIndex = 0;
  while ((m = RE_IPV4.exec(text))) {
    const idx = m.index;
    // Skip IPs that are part of a URL (preceded by "/" as in http://1.2.3.4).
    if (/[/\w]/.test(text[idx - 1] || '')) continue;
    const host = m[0].split(':')[0];
    const port = m[1] ? Number(m[1]) : 22;
    out.push({ start: idx, len: m[0].length, kind: 'ip', text: m[0], host, port });
  }
  RE_PATH.lastIndex = 0;
  while ((m = RE_PATH.exec(text))) {
    const p = m[1];
    if (p.length < 3 || !p.includes('/')) continue; // need a real path, not a lone "/"
    out.push({ start: m.index, len: p.length, kind: 'path', text: p });
  }
  // `ls -l` row: the bare filename at the end isn't a "path" (no slash), but it's grabbable
  // relative to the shell's cwd - link it for regular files and symlinks.
  const ls = text.match(RE_LSL);
  if (ls && (ls[1] === '-' || ls[1] === 'l')) {
    const nm = ls[2].split(' -> ')[0].replace(/\s+$/, ''); // symlink: link the entry, not target
    if (nm && nm !== '.' && nm !== '..' && !nm.includes('/')) {
      out.push({ start: text.length - ls[2].length, len: nm.length, kind: 'path', text: nm });
    }
  }
  // Actionable entities: systemd units, a PID (ps output), a container id (docker ps).
  RE_UNIT.lastIndex = 0;
  while ((m = RE_UNIT.exec(text))) {
    out.push({ start: m.index, len: m[0].length, kind: 'unit', text: m[0], unit: m[0] });
  }
  const ps = text.match(RE_PS_AUX) || text.match(RE_PS_EF);
  if (ps && ps.indices && ps.indices[2]) {
    const [s, e] = ps.indices[2];
    out.push({ start: s, len: e - s, kind: 'pid', text: ps[2], pid: ps[2] });
  }
  const dk = text.match(RE_DOCKER_PS);
  if (dk && dk.indices && dk.indices[1]) {
    const [s, e] = dk.indices[1];
    out.push({ start: s, len: e - s, kind: 'container', text: dk[1], cid: dk[1] });
  }
  // One JSON object/array per line: from the first opener to the last matching closer.
  const ji = text.search(/[{[]/);
  if (ji >= 0) {
    const closer = text[ji] === '{' ? '}' : ']';
    const je = text.lastIndexOf(closer);
    if (je > ji && je - ji >= 4) {
      const cand = text.slice(ji, je + 1);
      try {
        const v = JSON.parse(cand);
        if (v && typeof v === 'object') out.push({ start: ji, len: cand.length, kind: 'json', text: cand, value: v });
      } catch (_) {
        /* not JSON - no link */
      }
    }
  }
  return out;
}

// Detect a pretty-printed (multi-line) JSON block that the buffer row `y` (1-based, as
// xterm passes it) falls inside. Scans up to the nearest line that *starts* with a
// bracket, then down through string-aware bracket depth until it balances, and confirms
// with JSON.parse. Returns { start, end, value } or null. Lets `cat file.json` output be
// clickable on every line of the block, not just single-line JSON.
function multilineJsonAt(term, y) {
  const buf = term.buffer.active;
  const MAX = 500; // bound the up/down scan and the total size we'll parse
  const rowStr = (i) => {
    const ln = i >= 1 && i <= buf.length ? buf.getLine(i - 1) : null;
    return ln ? ln.translateToString(true) : '';
  };
  // Balance brackets downward from an opener line, ignoring brackets inside strings.
  // Returns { start, end, text } for the balanced block, or null.
  const balanceFrom = (start) => {
    let depth = 0;
    let inStr = false;
    let esc = false;
    let chars = 0;
    const lines = [];
    for (let i = start; i <= Math.min(buf.length, start + MAX); i++) {
      const t = rowStr(i);
      chars += t.length + 1;
      if (chars > 200000) return null; // don't try to parse a huge blob
      lines.push(t);
      for (const ch of t) {
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') inStr = true;
        else if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') depth--;
      }
      if (depth <= 0) return { start, end: i, text: lines.join('\n') };
    }
    return null;
  };
  // Walk upward from y through successive lines that START with a bracket. The nearest one
  // may be an inner block that ends before y (e.g. y is a trailing "]"); keep going out
  // until a balanced block actually contains y, then confirm it parses as JSON.
  let tried = 0;
  for (let i = y; i >= Math.max(1, y - MAX) && tried < 60; i--) {
    const c = rowStr(i).trimStart()[0];
    if (c !== '{' && c !== '[') continue;
    tried++;
    const blk = balanceFrom(i);
    if (!blk || y < blk.start || y > blk.end) continue; // doesn't enclose y - try an outer opener
    try {
      const v = JSON.parse(blk.text);
      if (v && typeof v === 'object') return { start: blk.start, end: blk.end, value: v };
    } catch (_) {
      /* not JSON - keep looking outward */
    }
  }
  return null;
}

const SMART_HINT = {
  ip: '🔌 SSH to this host',
  path: '📥 Grab this file',
  json: '🔎 Pretty-print JSON',
  pid: '⚙ Process - actions ▾',
  container: '🐳 Container - actions ▾',
  unit: '⚙ Unit - actions ▾',
};
// A .json file path/name gets a "preview structured" hint instead of the plain grab hint.
function isJsonPath(hit) {
  return hit.kind === 'path' && /\.json$/i.test(hit.text);
}
function smartHintFor(hit) {
  return isJsonPath(hit) ? '🔎 Show JSON structured' : SMART_HINT[hit.kind];
}

// Actionable-output verbs per entity. `run:true` = read-only, executed immediately;
// `run:false` = mutating, typed at the prompt for you to review and press Enter.
function verbsFor(hit) {
  if (hit.kind === 'pid') {
    const p = hit.pid;
    return [
      { label: 'info', cmd: `ps -o pid,ppid,user,%cpu,%mem,stat,etime,args -p ${p}`, run: true },
      { label: 'tree', cmd: `pstree -p ${p}`, run: true },
      { label: 'lsof', cmd: `lsof -p ${p}`, run: true },
      { label: 'renice', cmd: `renice +10 -p ${p}`, run: false },
      { label: 'kill', cmd: `kill ${p}`, run: false },
      { label: 'kill -9', cmd: `kill -9 ${p}`, run: false },
    ];
  }
  if (hit.kind === 'container') {
    const c = hit.cid;
    return [
      { label: 'logs', cmd: `docker logs --tail 200 ${c}`, run: true },
      { label: 'inspect', cmd: `docker inspect ${c}`, run: true },
      { label: 'stats', cmd: `docker stats --no-stream ${c}`, run: true },
      { label: 'exec sh', cmd: `docker exec -it ${c} sh`, run: false },
      { label: 'stop', cmd: `docker stop ${c}`, run: false },
      { label: 'restart', cmd: `docker restart ${c}`, run: false },
    ];
  }
  if (hit.kind === 'unit') {
    const u = hit.unit;
    return [
      { label: 'status', cmd: `systemctl status ${u}`, run: true },
      { label: 'journal', cmd: `journalctl -u ${u} -n 100 --no-pager`, run: true },
      { label: 'restart', cmd: `sudo systemctl restart ${u}`, run: false },
      { label: 'stop', cmd: `sudo systemctl stop ${u}`, run: false },
      { label: 'start', cmd: `sudo systemctl start ${u}`, run: false },
    ];
  }
  return [];
}

function termSend(rec, data) {
  if (!rec) return;
  if (rec.kind === 'local') api.ptyWrite(rec.id, data);
  else api.write(rec.id, data);
}

// A small verb menu shown where you clicked an actionable entity.
function openVerbMenu(hit, rec, e) {
  const verbs = verbsFor(hit);
  if (!verbs.length || !rec) return;
  let menu = document.getElementById('smart-verbs');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'smart-verbs';
    menu.className = 'hidden';
    document.body.appendChild(menu);
    document.addEventListener('mousedown', (ev) => {
      if (!menu.classList.contains('hidden') && !menu.contains(ev.target)) menu.classList.add('hidden');
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !menu.classList.contains('hidden')) menu.classList.add('hidden');
    });
  }
  menu.innerHTML = `<div class="sv-head">${escapeHtml(hit.text)}</div>`;
  for (const v of verbs) {
    const b = document.createElement('button');
    b.className = 'sv-item' + (v.run ? ' sv-run' : ' sv-type');
    b.textContent = v.label;
    b.title = v.cmd + (v.run ? '  (runs)' : '  (typed - press Enter to run)');
    b.addEventListener('click', () => {
      termSend(rec, v.cmd + (v.run ? '\r' : ''));
      menu.classList.add('hidden');
      if (rec.term) rec.term.focus();
    });
    menu.appendChild(b);
  }
  const foot = document.createElement('div');
  foot.className = 'sv-foot';
  foot.textContent = 'green runs · plain is typed for you to press Enter';
  menu.appendChild(foot);
  menu.classList.remove('hidden');
  // Position near the click, kept on-screen.
  const x = e ? e.clientX : 100;
  const y = e ? e.clientY : 100;
  menu.style.left = Math.min(x, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = Math.min(y + 6, window.innerHeight - menu.offsetHeight - 8) + 'px';
}

function updateSmartLinksBtn() {
  const b = document.getElementById('smartlinks-btn');
  if (!b) return;
  b.classList.toggle('on', smartLinksOn);
  b.textContent = (smartLinksOn ? '☑' : '☐') + ' 🔎 Smart output';
}

function smartActivate(hit, rec, e) {
  if (hit.kind === 'ip') smartSshTo(hit.host, hit.port, rec);
  else if (hit.kind === 'path') {
    // A .json file previews structured right away (with Save available); other files grab.
    if (isJsonPath(hit) && rec && (rec.kind === 'ssh' || rec.kind === 'local')) previewJsonFile(rec, hit.text);
    else openGrabOverlay(rec, hit.text);
  } else if (hit.kind === 'json') openJsonOverlay(hit.value, hit.text);
  else if (hit.kind === 'pid' || hit.kind === 'container' || hit.kind === 'unit') openVerbMenu(hit, rec, e);
}

function smartSshTo(host, port, rec) {
  reconnectTabId = null;
  els.fName.value = '';
  els.fHost.value = host;
  els.fPort.value = port || 22;
  if (rec && rec.profile && rec.profile.username) els.fUser.value = rec.profile.username;
  openDialog();
}

function smartTip() {
  let el = document.getElementById('smart-tip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'smart-tip';
    el.className = 'hidden';
    document.body.appendChild(el);
  }
  return el;
}
function showSmartTip(e, label) {
  const el = smartTip();
  el.textContent = label;
  el.classList.remove('hidden');
  const x = Math.min((e ? e.clientX : 0) + 12, window.innerWidth - el.offsetWidth - 8);
  el.style.left = Math.max(8, x) + 'px';
  el.style.top = Math.max(8, (e ? e.clientY : 0) - 30) + 'px';
}
function hideSmartTip() {
  const el = document.getElementById('smart-tip');
  if (el) el.classList.add('hidden');
}

// Register the provider on a terminal. `tabId` is resolved to the live rec at click time
// (the rec object does not exist yet when this runs). Honours the live smartLinksOn flag.
function registerSmartLinks(term, tabId) {
  const mkLink = (hit, start, end) => ({
    text: hit.text,
    range: { start, end },
    decorations: { pointerCursor: true, underline: true },
    activate: (e) => {
      hideSmartTip();
      smartActivate(hit, tabs.get(tabId), e);
    },
    hover: (e) => showSmartTip(e, smartHintFor(hit)),
    leave: () => hideSmartTip(),
  });
  try {
    term.registerLinkProvider({
      provideLinks(y, callback) {
        if (!smartLinksOn) return callback(undefined);
        const buf = term.buffer.active;
        if (!buf.getLine(y - 1)) return callback(undefined);
        // Reconstruct the full LOGICAL line: xterm splits a long line into wrapped
        // continuation rows, so a filename/URL that wraps would otherwise be seen (and
        // underlined) only up to the wrap point. Walk up to the logical start, then join
        // the wrapped rows, tracking each row's offset so matches map back to cells.
        let startY = y;
        while (startY > 1 && buf.getLine(startY - 1).isWrapped) startY--;
        const rows = [];
        let text = '';
        for (let i = startY; i <= buf.length; i++) {
          const ln = buf.getLine(i - 1);
          if (!ln) break;
          if (i > startY && !ln.isWrapped) break; // next logical line begins
          const s = ln.translateToString(false); // full width, so offsets stay contiguous
          rows.push({ y: i, start: text.length });
          text += s;
        }
        // Map a string index in the joined text back to a 1-based {x, y} terminal cell.
        const at = (idx) => {
          for (let r = rows.length - 1; r >= 0; r--) {
            if (idx >= rows[r].start) return { x: idx - rows[r].start + 1, y: rows[r].y };
          }
          return { x: 1, y: startY };
        };

        const found = smartFindLinks(text);
        const links = [];
        for (const hit of found) {
          const start = at(hit.start);
          const end = at(hit.start + hit.len - 1);
          // A match can wrap rows; only surface it for the row being queried so the same
          // link isn't emitted once per row of the block.
          if (y < start.y || y > end.y) continue;
          links.push(mkLink(hit, start, end));
        }
        // If nothing single-line JSON matched, offer a pretty-printed multi-line JSON block
        // (separate logical lines): make the whole queried row clickable to expand it.
        if (!found.some((h) => h.kind === 'json')) {
          const blk = multilineJsonAt(term, y);
          if (blk) {
            const rowStr = buf.getLine(y - 1).translateToString(true);
            const lead = rowStr.length - rowStr.trimStart().length;
            if (rowStr.length > lead) {
              const hit = { kind: 'json', text: rowStr.slice(lead), value: blk.value };
              links.push(mkLink(hit, { x: lead + 1, y }, { x: rowStr.length, y }));
            }
          }
        }
        if (!links.length) return callback(undefined);
        callback(links);
      },
    });
  } catch (_) {
    /* proposed-API link provider unavailable - smart links just off */
  }
}

// Pretty-print a JSON value in a small modal overlay (built lazily, reused after).
// opts: { saveName, b64 } - when b64 is given (a file preview), a Save button appears so
// you can still download the file after viewing it structured.
let sjGeom = null; // {left, top, width, height} - remembered while the app is open
function applySjGeom(card) {
  if (!card) return;
  if (!sjGeom) {
    const w = Math.min(760, Math.round(window.innerWidth * 0.94));
    const h = Math.min(640, Math.round(window.innerHeight * 0.86));
    sjGeom = {
      left: Math.max(20, (window.innerWidth - w) / 2),
      top: Math.max(20, (window.innerHeight - h) / 2),
      width: w,
      height: h,
    };
  }
  card.style.left = sjGeom.left + 'px';
  card.style.top = sjGeom.top + 'px';
  card.style.width = sjGeom.width + 'px';
  card.style.height = sjGeom.height + 'px';
}
function openJsonOverlay(value, raw, opts) {
  opts = opts || {};
  let ov = document.getElementById('smart-json');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'smart-json';
    ov.className = 'hidden';
    ov.innerHTML =
      '<div class="sj-card">' +
      '<div class="sj-head"><span class="sj-title">🔎 JSON</span>' +
      '<button class="sj-save hidden" title="Save this file">💾 Save</button>' +
      '<button class="sj-copy" title="Copy formatted JSON">Copy</button>' +
      '<button class="sj-close" title="Close (Esc)">✕</button></div>' +
      '<pre class="sj-body"></pre></div>';
    document.body.appendChild(ov);
    ov.addEventListener('mousedown', (e) => {
      if (e.target === ov) ov.classList.add('hidden');
    });
    ov.querySelector('.sj-close').addEventListener('click', () => ov.classList.add('hidden'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !ov.classList.contains('hidden')) ov.classList.add('hidden');
    });
    ov.querySelector('.sj-copy').addEventListener('click', () => {
      api.clipboardWrite(ov.querySelector('.sj-body').textContent);
      const b = ov.querySelector('.sj-copy');
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = 'Copy'), 1200);
    });
    const sb = ov.querySelector('.sj-save');
    sb.addEventListener('click', async () => {
      if (!sb._b64) return;
      sb.textContent = 'Saving…';
      try {
        const r = await api.saveBase64(sb._name || 'download.json', sb._b64);
        sb.textContent = r && r.ok ? '✓ Saved' : r && r.canceled ? '💾 Save' : 'Failed';
      } catch (_) {
        sb.textContent = 'Failed';
      }
      setTimeout(() => (sb.textContent = '💾 Save'), 1400);
    });
    // Drag the card by its header.
    ov.querySelector('.sj-head').addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const card = ov.querySelector('.sj-card');
      const sx = e.clientX;
      const sy = e.clientY;
      const ox = parseFloat(card.style.left) || 0;
      const oy = parseFloat(card.style.top) || 0;
      const move = (ev) => {
        sjGeom = sjGeom || {};
        sjGeom.left = Math.max(0, Math.min(ox + (ev.clientX - sx), window.innerWidth - 80));
        sjGeom.top = Math.max(0, Math.min(oy + (ev.clientY - sy), window.innerHeight - 40));
        card.style.left = sjGeom.left + 'px';
        card.style.top = sjGeom.top + 'px';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      e.preventDefault();
    });
    // Remember the size when the corner handle resizes the card.
    try {
      const ro = new ResizeObserver(() => {
        const card = ov.querySelector('.sj-card');
        if (ov.classList.contains('hidden') || !card) return;
        if (card.offsetWidth && card.offsetHeight) {
          sjGeom = sjGeom || {};
          sjGeom.width = card.offsetWidth;
          sjGeom.height = card.offsetHeight;
        }
      });
      ro.observe(ov.querySelector('.sj-card'));
    } catch (_) {}
  }
  ov.querySelector('.sj-title').textContent = opts.saveName ? '🔎 ' + opts.saveName : '🔎 JSON';
  const sb = ov.querySelector('.sj-save');
  sb._b64 = opts.b64 || null;
  sb._name = opts.saveName || null;
  sb.classList.toggle('hidden', !opts.b64);
  let pretty;
  try {
    pretty = JSON.stringify(value, null, 2);
  } catch (_) {
    pretty = raw || '';
  }
  ov.querySelector('.sj-body').textContent = pretty;
  applySjGeom(ov.querySelector('.sj-card'));
  ov.classList.remove('hidden');
}

// Scrollable plain-text file preview (non-JSON). Logs jump to the end. Copy + Save.
let fpGeom = null; // {left, top, width, height} - remembered while the app is open
function applyFpGeom(card) {
  if (!card) return;
  if (!fpGeom) {
    const w = Math.min(900, Math.round(window.innerWidth * 0.94));
    const h = Math.min(640, Math.round(window.innerHeight * 0.86));
    fpGeom = {
      left: Math.max(20, (window.innerWidth - w) / 2),
      top: Math.max(20, (window.innerHeight - h) / 2),
      width: w,
      height: h,
    };
  }
  card.style.left = fpGeom.left + 'px';
  card.style.top = fpGeom.top + 'px';
  card.style.width = fpGeom.width + 'px';
  card.style.height = fpGeom.height + 'px';
}
function openTextOverlay(name, text, opts) {
  opts = opts || {};
  let ov = document.getElementById('file-preview');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'file-preview';
    ov.className = 'hidden';
    ov.innerHTML =
      '<div class="fp-card">' +
      '<div class="fp-head"><span class="fp-title"></span>' +
      '<button class="fp-save hidden" title="Save this file">💾 Save</button>' +
      '<button class="fp-copy" title="Copy contents">Copy</button>' +
      '<button class="fp-close" title="Close (Esc)">✕</button></div>' +
      '<pre class="fp-body"></pre></div>';
    document.body.appendChild(ov);
    ov.addEventListener('mousedown', (e) => {
      if (e.target === ov) ov.classList.add('hidden');
    });
    ov.querySelector('.fp-close').addEventListener('click', () => ov.classList.add('hidden'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !ov.classList.contains('hidden')) ov.classList.add('hidden');
    });
    ov.querySelector('.fp-copy').addEventListener('click', () => {
      api.clipboardWrite(ov.querySelector('.fp-body').textContent);
      const b = ov.querySelector('.fp-copy');
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = 'Copy'), 1200);
    });
    const sb = ov.querySelector('.fp-save');
    sb.addEventListener('click', async () => {
      if (!sb._b64) return;
      sb.textContent = 'Saving…';
      try {
        const r = await api.saveBase64(sb._name || 'download', sb._b64);
        sb.textContent = r && r.ok ? '✓ Saved' : r && r.canceled ? '💾 Save' : 'Failed';
      } catch (_) {
        sb.textContent = 'Failed';
      }
      setTimeout(() => (sb.textContent = '💾 Save'), 1400);
    });
    // Drag the card by its header.
    ov.querySelector('.fp-head').addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const card = ov.querySelector('.fp-card');
      const sx = e.clientX;
      const sy = e.clientY;
      const ox = parseFloat(card.style.left) || 0;
      const oy = parseFloat(card.style.top) || 0;
      const move = (ev) => {
        fpGeom = fpGeom || {};
        fpGeom.left = Math.max(0, Math.min(ox + (ev.clientX - sx), window.innerWidth - 80));
        fpGeom.top = Math.max(0, Math.min(oy + (ev.clientY - sy), window.innerHeight - 40));
        card.style.left = fpGeom.left + 'px';
        card.style.top = fpGeom.top + 'px';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      e.preventDefault();
    });
    // Remember the size when the corner handle resizes the card.
    try {
      const ro = new ResizeObserver(() => {
        const card = ov.querySelector('.fp-card');
        if (ov.classList.contains('hidden') || !card) return;
        if (card.offsetWidth && card.offsetHeight) {
          fpGeom = fpGeom || {};
          fpGeom.width = card.offsetWidth;
          fpGeom.height = card.offsetHeight;
        }
      });
      ro.observe(ov.querySelector('.fp-card'));
    } catch (_) {}
  }
  // Bound very large files so rendering stays snappy: logs keep the tail, others the head.
  const MAX = 1500000;
  let shown = text;
  if (text.length > MAX) {
    shown = opts.scrollEnd
      ? '… (truncated - showing the last part) …\n' + text.slice(text.length - MAX)
      : text.slice(0, MAX) + '\n… (truncated) …';
  }
  ov.querySelector('.fp-title').textContent = name || 'file';
  const sb = ov.querySelector('.fp-save');
  sb._b64 = opts.b64 || null;
  sb._name = name || null;
  sb.classList.toggle('hidden', !opts.b64);
  const body = ov.querySelector('.fp-body');
  body.textContent = shown;
  applyFpGeom(ov.querySelector('.fp-card'));
  ov.classList.remove('hidden');
  // Logs: scroll to the newest lines at the bottom.
  if (opts.scrollEnd) requestAnimationFrame(() => (body.scrollTop = body.scrollHeight));
  else body.scrollTop = 0;
}

// --- Broadcast input: type in one terminal, mirror the keystrokes to every other
// participating ssh/local tab (cluster / "send to all"). Off by default; a tab can
// be excluded from its hover cheat-sheet.
let broadcastOn = false;
function broadcastEligible(rec) {
  return (
    rec &&
    (rec.kind === 'ssh' || rec.kind === 'local') &&
    rec.bcast !== false &&
    rec.status !== 'closed' &&
    rec.status !== 'error'
  );
}
function broadcastFrom(srcRec, data) {
  if (!broadcastOn || !broadcastEligible(srcRec)) return;
  for (const rec of tabs.values()) {
    if (rec === srcRec || !broadcastEligible(rec)) continue;
    if (rec.kind === 'ssh') api.write(rec.id, data);
    else api.ptyWrite(rec.id, data);
  }
}
function broadcastCount() {
  let n = 0;
  for (const rec of tabs.values()) if (broadcastEligible(rec)) n++;
  return n;
}
function updateBroadcastUI() {
  const btn = document.getElementById('broadcast-btn');
  if (btn) {
    const n = broadcastCount();
    btn.classList.toggle('on', broadcastOn);
    btn.textContent = (broadcastOn ? '☑' : '☐') + ' ⇄ Broadcast typing' + (broadcastOn ? ` (${n})` : '');
    btn.title = broadcastOn
      ? `Broadcasting your typing to ${n} terminal${n === 1 ? '' : 's'} - click to stop`
      : 'Mirror your typing to every connected terminal';
  }
  // Mirror the on-state onto the Terminal ▾ button so it's visible while the menu is closed.
  const mbtn = document.getElementById('term-menu-btn');
  if (mbtn) mbtn.classList.toggle('bcast-on', broadcastOn);
  for (const rec of tabs.values()) {
    const on = broadcastOn && broadcastEligible(rec);
    if (rec.tabEl) rec.tabEl.classList.toggle('bcast', on);
    if (rec.paneEl) rec.paneEl.classList.toggle('bcast', on);
  }
}
function toggleBroadcast() {
  broadcastOn = !broadcastOn;
  updateBroadcastUI();
}

// --- Privacy Curtain: blur sensitive ambient content (message boards, mail, notes,
// tab titles, meeting titles, the URL bar) for screen sharing / demos / screenshots.
// Terminal and web page content are left alone - that's what you're presenting.
let privacyMode = false;
function togglePrivacy(on) {
  privacyMode = on == null ? !privacyMode : !!on;
  document.body.classList.toggle('privacy', privacyMode);
  const btn = document.getElementById('privacy-btn');
  if (btn) btn.classList.toggle('on', privacyMode);
}

// ---------------------------------------------------------------------------
// Focus Session - a whole-cockpit "deep work" mode: pin a project's timer, mute
// Slack popups + the reminder overlay, dim the other tabs, run a countdown, drop
// a Black Box marker, and write a summary note (commands run + time) when it ends.
// ---------------------------------------------------------------------------
let focusSession = null;
let focusSelMin = 25;
function openFocusDialog() {
  const sel = document.getElementById('focus-project');
  sel.innerHTML = paProjects.length
    ? paProjects
        .map((p) => `<option value="${p.id}"${p.id === paCurrentId ? ' selected' : ''}>${escapeHtml(p.name)}</option>`)
        .join('')
    : '<option value="">(no projects - add one first)</option>';
  focusSelMin = 25;
  document.getElementById('focus-custom').value = '';
  syncFocusDurs();
  document.getElementById('focus-overlay').classList.remove('hidden');
}
function closeFocusDialog() {
  document.getElementById('focus-overlay').classList.add('hidden');
}
function syncFocusDurs() {
  document.querySelectorAll('#focus-overlay .fo-durs button').forEach((b) => {
    b.classList.toggle('sel', parseInt(b.dataset.min, 10) === focusSelMin);
  });
}
function startFocus(projectId, minutes) {
  if (focusSession) return;
  minutes = Math.max(1, Math.min(480, Math.round(minutes || 25)));
  const p = paProject(projectId);
  const now = Date.now();
  focusSession = {
    projectId: projectId || null,
    projectName: p ? p.name : 'No project',
    startMs: now,
    plannedMin: minutes,
    endAt: now + minutes * 60000,
    commands: [],
    hudTimer: null,
    endTimer: null,
  };
  if (projectId) setCurrentProject(projectId); // pins the project and starts its timer
  document.body.classList.add('focus'); // dim other tabs (DND is enforced in the notifiers)
  logEvent('system', { title: `🎯 Focus started: ${focusSession.projectName} (${minutes}m)` });
  document.getElementById('focus-hud-proj').textContent = '🎯 ' + focusSession.projectName;
  document.getElementById('focus-hud').classList.remove('hidden');
  focusSession.hudTimer = setInterval(updateFocusHud, 1000);
  focusSession.endTimer = setTimeout(() => endFocus(false), minutes * 60000);
  updateFocusHud();
  closeFocusDialog();
}
function updateFocusHud() {
  if (!focusSession) return;
  const rem = Math.max(0, focusSession.endAt - Date.now());
  const m = Math.floor(rem / 60000);
  const s = Math.floor((rem % 60000) / 1000);
  document.getElementById('focus-hud-time').textContent = `${m}:${String(s).padStart(2, '0')}`;
  if (rem <= 0) endFocus(false);
}
function endFocus(manual) {
  if (!focusSession) return;
  const f = focusSession;
  focusSession = null;
  clearInterval(f.hudTimer);
  clearTimeout(f.endTimer);
  document.body.classList.remove('focus');
  document.getElementById('focus-hud').classList.add('hidden');
  const now = Date.now();
  const actualMin = Math.max(0, Math.round((now - f.startMs) / 60000));
  logEvent('system', { title: `🎯 Focus ended: ${f.projectName} (${actualMin}m${manual ? ', early' : ''})` });
  createFocusNote(f, now, actualMin);
}
function createFocusNote(f, endMs, actualMin) {
  const dt = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const spent = f.projectId ? segSeconds(f.startMs, endMs + 1000)[f.projectId] || 0 : 0;
  const lines = [];
  lines.push(`**Project:** ${f.projectName}`);
  lines.push(`**When:** ${dt(f.startMs)} - ${dt(endMs)} (${actualMin}m of ${f.plannedMin}m planned)`);
  if (f.projectId) lines.push(`**Tracked:** ${fmtHM(spent)} on ${f.projectName}`);
  lines.push('');
  if (f.commands.length) {
    lines.push(`**Commands run (${f.commands.length}):**`);
    for (const c of f.commands.slice(0, 40)) lines.push('- ' + c.cmd + (c.host ? ' @' + c.host : ''));
    if (f.commands.length > 40) lines.push(`- …and ${f.commands.length - 40} more`);
  } else {
    lines.push('_No terminal commands recorded._');
  }
  lines.push('');
  lines.push('[ ] Follow-up');
  captureToNote({
    title: `🎯 Focus: ${f.projectName} (${new Date(f.startMs).toLocaleDateString()})`,
    text: lines.join('\n'),
    color: NOTE_COLORS[1],
  });
}
// Called from the command-capture points so the summary note can list what you ran.
function focusTrackCommand(cmd, host) {
  if (focusSession && cmd) focusSession.commands.push({ cmd: String(cmd).slice(0, 120), host: host || '' });
}

function createTab(profile) {
  const id = newTabId();
  const { tabEl, paneEl } = createTabChrome(id, profile.name || profile.host, 'ssh');

  const term = new Terminal({
    theme: THEMES[currentTheme],
    fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
    fontSize: fontSize,
    cursorBlink: false, // blinking forces a repaint ~2x/sec forever (idle CPU); keep a steady cursor
    scrollback: 10000,
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  try {
    // Click a URL in the terminal to open it in a new in-app web tab.
    // Ctrl/Cmd- or Shift-click opens it in the system browser instead.
    term.loadAddon(
      new WebLinksAddon.WebLinksAddon((event, uri) => {
        if (event && (event.ctrlKey || event.metaKey || event.shiftKey)) api.openExternal(uri);
        else createWebTab(uri);
      })
    );
  } catch (_) {
    /* web links optional */
  }
  let searchAddon = null;
  try {
    searchAddon = new SearchAddon.SearchAddon();
    term.loadAddon(searchAddon);
    searchAddon.onDidChangeResults((r) => {
      if (id === activeTabId && r) {
        els.searchInfo.textContent =
          r.resultCount > 0 ? `${r.resultIndex + 1}/${r.resultCount}` : 'No results';
      }
    });
  } catch (_) {
    /* search optional */
  }
  term.open(paneEl);
  attachTermScrollKeys(term);
  registerSmartLinks(term, id);

  term.onData((data) => {
    api.write(id, data);
    broadcastFrom(rec, data); // mirror keystrokes to other terminals when broadcast is on
    captureSshCommand(rec, data);
  });
  term.onResize(({ cols, rows }) => api.resize(id, cols, rows));

  // Rename the tab to the remote hostname when the shell advertises a title.
  term.onTitleChange((title) => {
    const host = deriveHostTitle(title);
    if (host) setTabTitle(id, host);
  });

  // PuTTY-style: copy to clipboard as soon as you select text.
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel) api.clipboardWrite(sel);
  });

  const pasteFromClipboard = () => {
    const text = api.clipboardRead();
    if (text) term.paste(text);
  };

  // Explicit copy/paste shortcuts + font zoom, handled before keys reach the shell.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // When the session is dead, offer MobaXterm-style key options.
    const cur = tabs.get(id);
    if (cur && (cur.status === 'closed' || cur.status === 'error') && !e.ctrlKey && !e.altKey) {
      if (e.key.toLowerCase() === 'r') {
        reconnect(id);
        return false;
      }
      if (e.key.toLowerCase() === 'p') {
        openReconnectDialog(id); // re-enter passphrase/password, then reconnect
        return false;
      }
      if (e.key === 'Enter') {
        closeTab(id);
        return false;
      }
    }
    if (e.ctrlKey && e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'c') {
        const sel = term.getSelection();
        if (sel) api.clipboardWrite(sel);
        return false;
      }
      if (k === 'v') {
        pasteFromClipboard();
        return false;
      }
      if (k === 'n') {
        captureTermNote(tabs.get(id));
        return false;
      }
      // Let the window-level handler act on these (avoid leaking to the shell).
      if (k === 'f' || k === 't' || k === 'w') return false;
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey) {
      if (e.key === '+' || e.key === '=') {
        setFontSize(fontSize + 1);
        return false;
      }
      if (e.key === '-' || e.key === '_') {
        setFontSize(fontSize - 1);
        return false;
      }
      if (e.key === '0') {
        setFontSize(DEFAULT_FONT_SIZE);
        return false;
      }
    }
    return true;
  });

  // Paste via right-click (PuTTY) and middle-click (xterm tradition).
  paneEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    pasteFromClipboard();
  });
  paneEl.addEventListener('mousedown', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      pasteFromClipboard();
    }
  });

  // Drop files on the terminal → upload to this connection (capture preempts xterm).
  paneEl.addEventListener('dragover', (e) => e.preventDefault(), true);
  paneEl.addEventListener(
    'drop',
    async (e) => {
      const paths = pathsFromDrop(e);
      if (!paths.length) return;
      e.preventDefault();
      e.stopPropagation();
      if (activeTabId !== id) activateTab(id);
      if (!sftpOpen) openSftp();
      await uploadDropped(tabs.get(id), paths);
    },
    true
  );

  // Ctrl + mouse wheel zooms the font (capture phase preempts xterm's scroll).
  paneEl.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      setFontSize(fontSize + (e.deltaY < 0 ? 1 : -1));
    },
    { capture: true, passive: false }
  );

  // Reconnect overlay — revealed when the session drops.
  const reconnectBtn = document.createElement('button');
  reconnectBtn.className = 'reconnect-btn hidden';
  reconnectBtn.textContent = '⟳ Reconnect (R)';
  reconnectBtn.addEventListener('click', () => reconnect(id));
  paneEl.appendChild(reconnectBtn);

  // Left gutter that numbers command output lines (toggled from the tab cheat-sheet).
  const gutterEl = document.createElement('div');
  gutterEl.className = 'term-gutter';
  paneEl.appendChild(gutterEl);

  // Keep the gutter in sync whenever the screen repaints or scrolls.
  term.onRender(() => {
    if (rec.lineNums) renderGutter(rec);
  });
  term.onScroll(() => {
    if (rec.lineNums) renderGutter(rec);
  });

  const rec = {
    id,
    kind: 'ssh',
    term,
    fitAddon,
    searchAddon,
    paneEl,
    tabEl,
    profile,
    reconnectBtn,
    gutterEl,
    lineNums: false, // line-numbers mode (per terminal)
    lineBase: 0, // absolute buffer line where the current command's output begins
    status: 'connecting',
    // Auto-hop commands live per-server in sshHops, keyed by serverKey.
    lineBuffer: '',
    escSkip: false,
    serverKey: sshServerKey(profile),
    qBuffer: '', // rolling output buffer for Claude-question detection
    attention: false,
    cmdRunning: false, // command-done detector state
    cmdStart: 0,
    cmdName: '',
    outTail: '',
    altScreen: false,
  };
  tabs.set(id, rec);
  activateTab(id);
  bbTabOpen(rec);

  startConnection(rec);
  persistOpenSshTabs();
  return id;
}

// A local shell in a tab (node-pty via the main process). Reuses the xterm UI.
function createLocalTab(opts) {
  opts = opts || {};
  const id = newTabId();
  const { tabEl, paneEl } = createTabChrome(id, opts.title || 'Local', 'local');

  const term = new Terminal({
    theme: THEMES[currentTheme],
    fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
    fontSize: fontSize,
    cursorBlink: false,
    scrollback: 10000,
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  try {
    term.loadAddon(
      new WebLinksAddon.WebLinksAddon((event, uri) => {
        if (event && (event.ctrlKey || event.metaKey || event.shiftKey)) api.openExternal(uri);
        else createWebTab(uri);
      })
    );
  } catch (_) {
    /* optional */
  }
  let searchAddon = null;
  try {
    searchAddon = new SearchAddon.SearchAddon();
    term.loadAddon(searchAddon);
  } catch (_) {
    /* optional */
  }
  term.open(paneEl);
  attachTermScrollKeys(term);
  registerSmartLinks(term, id);

  term.onData((data) => {
    api.ptyWrite(id, data);
    broadcastFrom(rec, data); // mirror keystrokes to other terminals when broadcast is on
    captureLocalCommand(rec, data);
  });
  term.onResize(({ cols, rows }) => api.ptyResize(id, cols, rows));
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel) api.clipboardWrite(sel);
  });
  const pasteFromClipboard = () => {
    const text = api.clipboardRead();
    if (text) term.paste(text);
  };
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const cur = tabs.get(id);
    if (cur && cur.status === 'closed' && !e.ctrlKey && !e.altKey) {
      if (e.key.toLowerCase() === 'r') {
        startLocalShell(cur);
        return false;
      }
      if (e.key === 'Enter') {
        closeTab(id);
        return false;
      }
    }
    if (e.ctrlKey && e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'c') {
        const sel = term.getSelection();
        if (sel) api.clipboardWrite(sel);
        return false;
      }
      if (k === 'v') {
        pasteFromClipboard();
        return false;
      }
      if (k === 'n') {
        captureTermNote(tabs.get(id));
        return false;
      }
      if (k === 'f' || k === 't' || k === 'w') return false;
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey) {
      if (e.key === '+' || e.key === '=') {
        setFontSize(fontSize + 1);
        return false;
      }
      if (e.key === '-' || e.key === '_') {
        setFontSize(fontSize - 1);
        return false;
      }
      if (e.key === '0') {
        setFontSize(DEFAULT_FONT_SIZE);
        return false;
      }
    }
    return true;
  });
  paneEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    pasteFromClipboard();
  });

  const rec = {
    id,
    kind: 'local',
    term,
    fitAddon,
    searchAddon,
    paneEl,
    tabEl,
    profile: { name: opts.title || 'Local' },
    cwd: opts.cwd || null,
    status: 'connecting',
    qBuffer: '',
    attention: false,
    // Command capture / done-detector state (for the Black Box timeline).
    lineBuffer: '',
    escSkip: false,
    cmdRunning: false,
    cmdStart: 0,
    cmdName: '',
    outTail: '',
    altScreen: false,
  };
  tabs.set(id, rec);
  activateTab(id);
  bbTabOpen(rec);
  startLocalShell(rec);
  persistTabOrder(); // remember this local tab's position for next launch
  return id;
}

async function startLocalShell(rec) {
  rec.status = 'connecting';
  rec.term.reset();
  try {
    rec.fitAddon.fit();
  } catch (_) {
    /* not ready */
  }
  const res = await api.ptySpawn(rec.id, {
    cwd: rec.cwd || undefined,
    cols: rec.term.cols,
    rows: rec.term.rows,
  });
  if (!res || !res.ok) {
    rec.status = 'closed';
    rec.term.write(
      '\r\n\x1b[31mCould not start local shell: ' + ((res && res.error) || 'unknown error') + '\x1b[0m\r\n' +
        'Press \x1b[1mR\x1b[0m to retry or \x1b[1mEnter\x1b[0m to close.\r\n'
    );
    return;
  }
  rec.status = 'connected';
  setTabStatus(rec.id, 'connected', res.shell || 'local');
  requestAnimationFrame(() => {
    try {
      rec.fitAddon.fit();
    } catch (_) {
      /* ignore */
    }
    rec.term.focus();
  });
}

// Local terminal output + exit, routed by tabId (mirrors the SSH data path).
api.onPtyData(({ tabId, data }) => {
  const rec = tabs.get(tabId);
  if (rec && rec.term) {
    captureStream(rec, typeof data === 'string' ? data : streamDecode(rec, binaryToUint8(data)));
    if (rec._grab) {
      const vis = rec._grab.feed(typeof data === 'string' ? data : u8ToLatin1(binaryToUint8(data)));
      if (vis) writeToTerm(rec, vis);
    } else {
      writeToTerm(rec, data);
    }
    detectCommandDone(rec, data); // logs "cmd-done" once the prompt returns
  }
});
api.onPtyExit(({ tabId, exitCode, error }) => {
  const rec = tabs.get(tabId);
  if (!rec || !rec.term) return;
  rec.status = 'closed';
  setTabStatus(tabId, 'closed', error ? 'error' : 'exited');
  const label = error
    ? `\x1b[31m[local shell error: ${error}]\x1b[0m`
    : `\x1b[90m[process exited${exitCode != null ? ' (' + exitCode + ')' : ''}]\x1b[0m`;
  rec.term.write(`\r\n${label}\r\n` + 'Press \x1b[1mR\x1b[0m to start a new shell or \x1b[1mEnter\x1b[0m to close.\r\n');
});

// Show the "pick a tab" placeholder whenever nothing is open.
function updateEmptyState() {
  if (els.emptyState) els.emptyState.classList.toggle('hidden', tabs.size !== 0);
}
{
  const es = els.emptyState;
  if (es) {
    es.querySelector('#es-deck').addEventListener('click', () => createDeckTab());
    es.querySelector('#es-ssh').addEventListener('click', () => openDialog());
    es.querySelector('#es-local').addEventListener('click', () =>
      createLocalTab({ cwd: terminalCwd || undefined })
    );
    es.querySelector('#es-web').addEventListener('click', () => els.webBtn.click());
    es.querySelector('#es-notes').addEventListener('click', () => els.notesBtn.click());
  }
}

function activateTab(id) {
  const rec = tabs.get(id);
  if (!rec) return;
  activeTabId = id;
  updateEmptyState();
  for (const [tid, r] of tabs) {
    const on = tid === id;
    r.tabEl.classList.toggle('active', on);
    r.paneEl.classList.toggle('active', on);
  }
  if (rec.kind !== 'web') closeWebFind(); // the find bar belongs to the web tab it was opened on
  if (rec.kind === 'slack') clearUnread(rec);
  clearTabAttention(rec);
  maybeAutoSwitchProject(rec);
  if (sftpOpen) refreshSftpForActive();
  // Fit + focus the newly visible terminal (or the Slack input).
  requestAnimationFrame(() => {
    if (rec.kind === 'ssh' || rec.kind === 'local') {
      try {
        rec.fitAddon.fit();
      } catch (_) {
        /* not ready */
      }
      if (rec._pendingBottom) {
        rec.term.scrollToBottom(); // catch up to output that arrived while this tab was hidden
        rec._pendingBottom = false;
      }
      rec.term.focus();
    } else if (rec.kind === 'slack' && rec.inputEl) {
      rec.inputEl.focus();
    } else if (rec.kind === 'deck') {
      renderDeck(rec); // refresh the dashboard the moment it's shown
    }
  });
  persistActiveTab();
  updateStatusBar();
  updateBroadcastUI(); // refresh broadcast count/indicators as tabs open/switch
  scheduleSnapshot(id); // keep a thumbnail of this tab for the 3D Exposé
}

// Capture the active tab's pane as a thumbnail (debounced) for the 3D Exposé view.
let snapTimer = null;
function scheduleSnapshot(id) {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => captureSnapshot(id), 450);
}
async function captureSnapshot(id) {
  const rec = tabs.get(id);
  if (!rec || id !== activeTabId) return;
  // Web tabs: capture the webview's OWN contents. The host-window capturePage
  // doesn't reliably composite <webview> guest pages, which left 3D cards blank.
  if (rec.kind === 'web') {
    await captureWebThumb(rec);
    return;
  }
  const r = rec.paneEl.getBoundingClientRect();
  if (r.width < 20 || r.height < 20) return;
  try {
    rec.snapshot = await api.capturePage({
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
  } catch (_) {
    /* ignore */
  }
}

// Grab a live thumbnail of a web tab via the <webview>'s own capturePage().
// Only works while the guest is actually painting (i.e. the tab is/was visible),
// so we call it on activate and after each page load.
async function captureWebThumb(rec) {
  if (!rec || rec.kind !== 'web' || !rec.wv) return;
  try {
    const img = await rec.wv.capturePage();
    if (img && !img.isEmpty()) rec.snapshot = img.toDataURL();
  } catch (_) {
    /* webview not ready / not rendering */
  }
}

function closeTab(id) {
  const rec = tabs.get(id);
  if (!rec) return;
  logEvent('tab-close', {
    title: 'closed ' + (rec.tabEl && rec.tabEl.querySelector('.title') ? rec.tabEl.querySelector('.title').textContent : rec.kind),
  });
  if (rec.kind === 'ssh') {
    api.disconnect(id);
    rec.term.dispose();
  }
  if (rec.kind === 'local') {
    api.ptyKill(id);
    rec.term.dispose();
  }
  const wasSlack = rec.kind === 'slack';
  const wasSsh = rec.kind === 'ssh';
  const wasWeb = rec.kind === 'web';
  const wasNotes = rec.kind === 'notes';
  const wasLocal = rec.kind === 'local';
  const wasDeck = rec.kind === 'deck';
  rec.tabEl.remove();
  rec.paneEl.remove();
  tabs.delete(id);
  if (wasSlack) persistOpenSlackChannels();
  if (wasSsh) persistOpenSshTabs();
  if (wasWeb) persistOpenWebTabs();
  if (wasLocal) persistTabOrder();
  if (wasDeck) persistTabOrder();
  if (wasNotes) {
    notesBoardEl = null;
    api.saveSettings({ notesTabOpen: false });
    persistTabOrder();
  }

  if (activeTabId === id) {
    const next = tabs.keys().next();
    activeTabId = next.done ? null : next.value;
    if (activeTabId) activateTab(activeTabId);
  }
  if (tabs.size === 0) updateStatusBar(); // empty is fine — the empty-state shows options
  updateEmptyState();
  updateBroadcastUI();
}

function setTabStatus(id, status, message) {
  const rec = tabs.get(id);
  if (!rec) return;
  rec.status = status;
  if (message) rec.lastMessage = message;
  if (rec.reconnectBtn) {
    const dead = status === 'closed' || status === 'error';
    rec.reconnectBtn.classList.toggle('hidden', !dead);
  }
  if (id === activeTabId) updateStatusBar();
  if (broadcastOn) updateBroadcastUI(); // a terminal dropping/reconnecting changes the set
}

// (Re)connect a tab using its stored profile, once the pane is laid out.
function startConnection(rec) {
  requestAnimationFrame(() => {
    try {
      rec.fitAddon.fit();
    } catch (_) {
      /* not ready */
    }
    const { cols, rows } = rec.term;
    rec._bannerShown = false; // re-arm the dead-session banner for this attempt
    setTabStatus(rec.id, 'connecting', 'Connecting…');
    api.connect({
      tabId: rec.id,
      host: rec.profile.host,
      port: Number(rec.profile.port) || 22,
      username: rec.profile.username,
      authMethod: rec.profile.authMethod,
      keyPath: rec.profile.keyPath,
      passphrase: rec.profile.passphrase,
      password: rec.profile.password,
      cols,
      rows,
    });
  });
}

// Auto-title (hostname / page title). Skipped once the user has manually renamed.
function setTabTitle(id, title) {
  const rec = tabs.get(id);
  if (!rec || rec.customTitle) return;
  const el = rec.tabEl.querySelector('.title');
  if (el) el.textContent = title;
  rec.tabEl.title = title;
}

// Double-click a tab's title to rename it inline.
function startTabRename(id, titleEl) {
  const rec = tabs.get(id);
  if (!rec || !titleEl) return;
  rec.tabEl.draggable = false; // let the caret/selection work instead of dragging the tab
  titleEl.contentEditable = 'true';
  titleEl.classList.add('editing');
  const range = document.createRange();
  range.selectNodeContents(titleEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  titleEl.focus();
  const finish = (commit) => {
    titleEl.removeEventListener('keydown', onKey);
    titleEl.removeEventListener('blur', onBlur);
    titleEl.contentEditable = 'false';
    titleEl.classList.remove('editing');
    rec.tabEl.draggable = true;
    const name = titleEl.textContent.trim();
    if (commit && name) applyTabRename(rec, name);
    else titleEl.textContent = rec.customTitle || (rec.profile && rec.profile.name) || name || rec.kind;
  };
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };
  const onBlur = () => finish(true);
  titleEl.addEventListener('keydown', onKey);
  titleEl.addEventListener('blur', onBlur);
}

function applyTabRename(rec, name) {
  rec.customTitle = name;
  const el = rec.tabEl.querySelector('.title');
  if (el) el.textContent = name;
  rec.tabEl.title = name;
  if (rec.profile) rec.profile.name = name; // carries into ssh/local persistence + tabKey
  persistTabOrder();
  persistActiveTab();
  if (rec.kind === 'ssh') persistOpenSshTabs();
  else if (rec.kind === 'web') persistOpenWebTabs();
  else if (rec.kind === 'slack') persistOpenSlackChannels();
}

function applyRestoredTitle(id, title) {
  const rec = tabs.get(id);
  if (!rec || !title) return;
  rec.customTitle = title;
  const el = rec.tabEl.querySelector('.title');
  if (el) el.textContent = title;
  rec.tabEl.title = title;
}

// Extract a hostname from a terminal title set by the remote shell.
// Common formats: "user@host: ~", "host", etc. Window titles with spaces
// (e.g. an editor's "file.txt - VIM") are ignored so the tab name stays stable.
function deriveHostTitle(raw) {
  if (!raw) return null;
  const t = raw.trim();
  const at = t.match(/[\w.-]+@([\w.-]+)/);
  if (at) return at[1];
  if (/^[\w.-]+$/.test(t)) return t;
  return null;
}

// R → reconnect THIS session, reusing the in-memory profile (incl. passphrase).
// It never opens the New-Connection panel; to re-enter a passphrase use P
// (openReconnectDialog). If the secret is stale, the connect fails and the banner
// offers P.
function reconnect(id) {
  const rec = tabs.get(id);
  if (!rec) return;
  rec.reconnectBtn.classList.add('hidden');
  rec.term.write('\r\n\x1b[1;36m[reconnecting…]\x1b[0m\r\n');
  startConnection(rec);
}

// Apply a terminal theme live to every open tab and persist the choice.
function applyTheme(name) {
  if (!THEMES[name]) return;
  currentTheme = name;
  for (const r of tabs.values()) {
    if (r.term) r.term.options.theme = THEMES[name];
  }
  if (els.themeSelect) els.themeSelect.value = name;
  api.saveSettings({ theme: name });
}

// Apply a new font size to every open terminal, refit them, and persist it.
let saveFontTimer = null;
function setFontSize(size) {
  const next = Math.max(8, Math.min(36, Math.round(size)));
  if (next === fontSize) return;
  fontSize = next;
  for (const r of tabs.values()) {
    if (!r.term) continue;
    r.term.options.fontSize = fontSize;
    try {
      r.fitAddon.fit();
    } catch (_) {
      /* not ready */
    }
  }
  // Debounce writes so rapid Ctrl+scroll doesn't hammer the disk.
  clearTimeout(saveFontTimer);
  saveFontTimer = setTimeout(() => api.saveSettings({ fontSize }), 300);
}

function updateStatusBar() {
  const rec = activeTabId ? tabs.get(activeTabId) : null;
  if (!rec) {
    els.statusText.textContent = tabs.size === 0 ? 'No active session' : 'Ready';
    renderStatusVitals();
    return;
  }
  const label = rec.profile.name || `${rec.profile.username}@${rec.profile.host}`;
  els.statusText.textContent = `${label} - ${rec.lastMessage || rec.status}`;
  renderStatusVitals(); // show the active shell's CPU/MEM/DISK next to its name
}

// ---------------------------------------------------------------------------
// SSH event wiring (route by tabId)
// ---------------------------------------------------------------------------
// Write new output to a terminal and keep it pinned to the newest line (e.g. a login
// banner). If the user has scrolled up to read history, leave their position alone
// until they scroll back down.
function writeToTerm(rec, data) {
  const b = rec.term.buffer.active;
  const wasAtBottom = b.viewportY >= b.baseY;
  rec.term.write(data, () => {
    if (!wasAtBottom) return; // user scrolled up to read history - don't yank them down
    if (rec.id === activeTabId) rec.term.scrollToBottom();
    else rec._pendingBottom = true; // hidden tab: catch up to the newest line on activate
  });
}

// --- Grab a file from the CURRENT shell -------------------------------------
// Works at any nesting depth (ssh-in-ssh, sudo, tmux, containers) because it goes
// through the terminal stream itself: we ask the far end to print the file as
// base64 wrapped in unique sentinels, capture it out of the output, and save it.
function u8ToLatin1(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}
function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

let grabTargetId = null;
function openGrabOverlay(rec, prefill) {
  if (!rec || (rec.kind !== 'ssh' && rec.kind !== 'local')) return;
  grabTargetId = rec.id;
  els.grabPath.value = prefill || '';
  grabSetStatus('', '');
  els.grabOverlay.classList.remove('hidden');
  setTimeout(() => els.grabPath.focus(), 0);
}
function closeGrabOverlay() {
  els.grabOverlay.classList.add('hidden');
  const rec = tabs.get(grabTargetId);
  if (rec && rec.term) rec.term.focus();
}
function grabSetStatus(msg, kind) {
  els.grabStatus.textContent = msg || '';
  els.grabStatus.className = 'grab-status' + (kind ? ' ' + kind : '');
}
function startGrab() {
  const rec = tabs.get(grabTargetId);
  const filePath = els.grabPath.value.trim();
  beginGrab(rec, filePath, { onStatus: grabSetStatus });
}

// Preview a .json file's structured contents by fetching it in-band, then pretty-printing
// (with a Save button in the viewer). No dialog - triggered from a Smart-output link.
function previewJsonFile(rec, filePath) {
  if (!rec || (rec.kind !== 'ssh' && rec.kind !== 'local')) return;
  beginGrab(rec, filePath, { preview: true });
}

// Core in-band file fetch. opts.onStatus(msg, kind) reports into the grab dialog (optional);
// opts.preview => decode + pretty-print JSON instead of the Save dialog.
function beginGrab(rec, filePath, opts) {
  opts = opts || {};
  const status = opts.onStatus || (() => {});
  if (!rec || !filePath) return;
  if (rec._grab) return status('A grab is already in progress on this tab…', 'warn');

  const tok = 'X' + Math.random().toString(36).slice(2, 12).toUpperCase().replace(/[^A-Z0-9]/g, '') + 'X';
  const startMark = `::S9${tok}::`; // ':' is not a base64 char, so the marker can't collide with the data
  const endMark = `::E9${tok}::`;
  // Echo-safe literals: the '' split means the resolved marker never appears
  // verbatim in the echoed command line, only in the real output.
  const startLit = `'::S9''${tok}::'`;
  const endLit = `'::E9''${tok}::'`;
  const q = "'" + filePath.replace(/'/g, `'\\''`) + "'";
  const name = filePath.split('/').pop() || 'download';

  const grab = {
    done: false,
    started: false,
    all: '',
    timer: null,
    // Returns the text that should still be written to the terminal. Everything
    // from the grab command's echo through the base64 blob and the end marker is
    // suppressed, so the transfer leaves no mess - only the fresh prompt tail shows.
    feed(text) {
      if (this.done) return text;
      this.all += text;
      if (!this.started) {
        const i = this.all.indexOf(startMark);
        if (i === -1) {
          if (this.all.length > 8192) this.all = this.all.slice(-2048); // bound pre-start growth
          return ''; // still swallowing the echoed command
        }
        this.started = true;
        this.all = this.all.slice(i + startMark.length);
      }
      if (this.all.length > 90000000) {
        this.finish({ error: 'File is too large for an in-band grab - use SFTP or scp instead.' });
        return '';
      }
      const j = this.all.indexOf(endMark);
      if (j === -1) return ''; // base64 still streaming - keep it off the screen
      const after = this.all.slice(j + endMark.length);
      const m = after.match(/-?\d+/);
      const rc = m ? parseInt(m[0], 10) : 0;
      const nl = after.indexOf('\n'); // drop the "<endMark> <rc>" line; show the prompt after it
      const tail = nl === -1 ? '' : after.slice(nl + 1);
      const b64 = this.all.slice(0, j).replace(/[^A-Za-z0-9+/=]/g, '');
      this.finish({ rc, b64 });
      const note =
        rc === 0
          ? `\x1b[2m[received ${name} (${fmtBytes(Math.floor((b64.length * 3) / 4))})]\x1b[0m\r\n`
          : `\x1b[2m[grab failed: exit ${rc}]\x1b[0m\r\n`;
      return note + tail;
    },
    finish(res) {
      if (this.done) return;
      this.done = true;
      clearTimeout(this.timer);
      if (rec._grab === this) rec._grab = null;
      onGrabFinished(name, res, opts, rec);
    },
  };
  grab.timer = setTimeout(
    () => grab.finish({ error: 'Timed out. Is `base64` available on that host? For big files use SFTP/scp.' }),
    60000
  );
  rec._grab = grab;

  // Leave a visible note in place of the (suppressed) base64 so the terminal isn't silent.
  if (rec.term) writeToTerm(rec, `\r\n\x1b[2m[sending file ${name} via base64 terminal output …]\x1b[0m\r\n`);

  const cmd = `printf '\\n%s\\n' ${startLit}; base64 ${q} 2>/dev/null; printf '\\n%s %s\\n' ${endLit} "$?"\r`;
  if (rec.kind === 'local') api.ptyWrite(rec.id, cmd);
  else api.write(rec.id, cmd);
  status('Fetching ' + name + ' …', '');
}
async function onGrabFinished(name, res, opts, rec) {
  opts = opts || {};
  const status = opts.onStatus || (() => {});
  if (res.error) return status(res.error, 'err');
  if (res.rc) return status('Could not read the file (exit ' + res.rc + '). Check the path and permissions.', 'err');
  const bytes = Math.floor((res.b64.length * 3) / 4);
  if (opts.preview) {
    let text = null;
    try {
      text = new TextDecoder('utf-8').decode(Uint8Array.from(atob(res.b64), (c) => c.charCodeAt(0)));
    } catch (_) {
      text = null;
    }
    if (text == null || /\x00/.test(text.slice(0, 8192))) {
      status(name + ' looks binary - use Download instead.', 'warn');
      return;
    }
    // .json pretty-prints (if it parses); everything else is shown as scrollable text,
    // and log-like files jump to the end so you see the newest lines first.
    if (/\.json$/i.test(name)) {
      try {
        openJsonOverlay(JSON.parse(text), text, { saveName: name, b64: res.b64 });
        status('Showing ' + name + ' structured.', 'ok');
        return;
      } catch (_) {
        /* not valid JSON - fall through to raw text */
      }
    }
    openTextOverlay(name, text, { b64: res.b64, scrollEnd: /\.(log|out|err)$/i.test(name) });
    status('Showing ' + name, 'ok');
    return;
  }
  status('Got ' + fmtBytes(bytes) + ' - choose where to save…', 'ok');
  try {
    const r = await api.saveBase64(name, res.b64);
    if (r && r.ok) status('Saved ' + fmtBytes(r.bytes) + ' to ' + r.savedTo, 'ok');
    else if (r && r.canceled) status('Save canceled.', 'warn');
    else status('Save failed: ' + ((r && r.error) || 'unknown error'), 'err');
  } catch (e) {
    status('Save failed: ' + (e.message || e), 'err');
  }
}
els.grabGo.addEventListener('click', startGrab);
function startGrabPreview() {
  const rec = tabs.get(grabTargetId);
  const filePath = els.grabPath.value.trim();
  beginGrab(rec, filePath, { preview: true, onStatus: grabSetStatus });
}
if (els.grabPreview) els.grabPreview.addEventListener('click', startGrabPreview);
els.grabCancel.addEventListener('click', closeGrabOverlay);
els.grabPath.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startGrab();
  else if (e.key === 'Escape') closeGrabOverlay();
});
els.grabOverlay.addEventListener('mousedown', (e) => {
  if (e.target === els.grabOverlay) closeGrabOverlay();
});

// ---------------------------------------------------------------------------
// Port-forward manager (SSH tunnels). The hard part about port forwarding is
// picturing WHO listens and WHICH WAY traffic flows; this UI draws it as a
// three-node diagram (your PC · the SSH host · the target) with a LISTENS pin
// and directional arrows, plus a plain-English sentence, and updates live.
// ---------------------------------------------------------------------------
let tunnelOverlayTabId = null;
const tunnelState = new Map(); // id -> public tunnel object (kept live by onTunnelUpdate)
let savedTunnels = {}; // serverKey -> [ spec, … ] remembered per host
const tunForm = { type: 'L' }; // holds the current add-form input elements + type
let tunPanelOffset = { x: 0, y: 0 }; // drag offset for the (centered) tunnel panel

function applyTunOffset() {
  const box = document.querySelector('#tunnel-overlay .tun-box');
  if (box) box.style.transform = tunPanelOffset.x || tunPanelOffset.y ? `translate(${tunPanelOffset.x}px, ${tunPanelOffset.y}px)` : '';
}

function shortHost(h) {
  h = h || 'host';
  return /^[\d.]+$/.test(h) ? h : h.split('.')[0];
}

function tunNode(ico, name, port, opts) {
  opts = opts || {};
  const n = document.createElement('div');
  n.className = 'tun-node' + (opts.dim ? ' dim' : '') + (opts.listens ? ' listens' : '');
  const i = document.createElement('div');
  i.className = 'tun-ico';
  i.textContent = ico;
  n.appendChild(i);
  const nm = document.createElement('div');
  nm.className = 'tun-name';
  nm.textContent = name;
  n.appendChild(nm);
  if (port) {
    const p = document.createElement('div');
    p.className = 'tun-port';
    p.textContent = port;
    n.appendChild(p);
  }
  if (opts.listens) {
    const pin = document.createElement('div');
    pin.className = 'tun-pin';
    pin.textContent = '📡 LISTENS';
    n.appendChild(pin);
  }
  return n;
}
function tunArrow(dir) {
  const a = document.createElement('div');
  a.className = 'tun-arrow';
  a.textContent = dir === 'left' ? '◀━━' : '━━▶';
  return a;
}

// Build the You · Host · Target diagram for a spec. Left = your world, right = the
// remote world, so a Local/Dynamic tunnel flows right (you reach out) and a Remote
// tunnel flows left (traffic comes back to you).
function tunnelDiagramEl(spec, host) {
  const wrap = document.createElement('div');
  wrap.className = 'tun-diagram type-' + spec.type;
  const hostShort = shortHost(host);
  const lp = spec.listenPort || '?';
  if (spec.type === 'L') {
    wrap.append(
      tunNode('💻', 'This PC', 'localhost:' + lp, { listens: true }),
      tunArrow('right'),
      tunNode('🖧', hostShort, 'via SSH'),
      tunArrow('right'),
      tunNode('🎯', spec.destHost || 'dest', ':' + (spec.destPort || '?'))
    );
  } else if (spec.type === 'D') {
    wrap.append(
      tunNode('💻', 'SOCKS proxy', 'localhost:' + lp, { listens: true }),
      tunArrow('right'),
      tunNode('🖧', hostShort, 'via SSH'),
      tunArrow('right'),
      tunNode('🌍', 'anywhere', '', { dim: true })
    );
  } else {
    wrap.append(
      tunNode('💻', spec.destHost || 'your side', ':' + (spec.destPort || '?')),
      tunArrow('left'),
      tunNode('🖧', hostShort, ':' + lp, { listens: true }),
      tunArrow('left'),
      tunNode('🌍', 'clients', '', { dim: true })
    );
  }
  return wrap;
}

function tunnelSentence(spec, host) {
  const hostShort = shortHost(host);
  const lp = spec.listenPort || '?';
  if (spec.type === 'L')
    return `Apps on your PC that connect to localhost:${lp} are tunneled through ${hostShort} to ${spec.destHost || '?'}:${spec.destPort || '?'}.`;
  if (spec.type === 'D')
    return `Point an app's SOCKS5 proxy at localhost:${lp} and all of its traffic exits through ${hostShort}.`;
  return `Anyone connecting to ${hostShort}:${lp} on the server is tunneled back to ${spec.destHost || 'localhost'}:${spec.destPort || '?'} on your side.`;
}

const TUN_TYPES = [
  { key: 'L', label: 'Local  -L', hint: 'Reach a remote service from your PC' },
  { key: 'R', label: 'Remote  -R', hint: 'Expose something of yours on the server' },
  { key: 'D', label: 'Dynamic  -D', hint: 'A SOCKS proxy that tunnels everything' },
];

function buildTunnelOverlay() {
  let ov = document.getElementById('tunnel-overlay');
  if (ov) return ov;
  ov = document.createElement('div');
  ov.id = 'tunnel-overlay';
  ov.className = 'hidden';
  ov.innerHTML =
    '<div class="tun-box">' +
    '<div class="tun-head"><span class="tun-title">🔀 Port forwarding</span>' +
    '<span class="tun-sub"></span><button class="tun-close" title="Close (Esc)">✕</button></div>' +
    '<div class="tun-list"></div>' +
    '<div class="tun-addwrap"><div class="tun-add-title">Add a tunnel</div>' +
    '<div class="tun-types"></div>' +
    '<div class="tun-fields"></div>' +
    '<div class="tun-preview"></div>' +
    '<div class="tun-formrow"><label class="tun-remember"><input type="checkbox" class="tun-remember-cb"> Remember for this host (auto-start on connect)</label>' +
    '<button class="tun-add-btn">Add &amp; start</button></div>' +
    '<div class="tun-err"></div></div>' +
    '</div>';
  document.body.appendChild(ov);
  ov.addEventListener('mousedown', (e) => {
    if (e.target === ov) ov.classList.add('hidden');
  });
  ov.querySelector('.tun-close').addEventListener('click', () => ov.classList.add('hidden'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !ov.classList.contains('hidden')) ov.classList.add('hidden');
  });
  // Drag the panel by its header; double-click the header re-centers it.
  const head = ov.querySelector('.tun-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, input, select')) return; // let controls work
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = tunPanelOffset.x;
    const oy = tunPanelOffset.y;
    const move = (ev) => {
      tunPanelOffset.x = ox + (ev.clientX - sx);
      tunPanelOffset.y = oy + (ev.clientY - sy);
      applyTunOffset();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  });
  head.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input, select')) return;
    tunPanelOffset = { x: 0, y: 0 };
    applyTunOffset();
  });
  // Type picker.
  const types = ov.querySelector('.tun-types');
  for (const t of TUN_TYPES) {
    const b = document.createElement('button');
    b.className = 'tun-type';
    b.dataset.type = t.key;
    b.innerHTML = `<span class="tun-type-label"></span><span class="tun-type-hint"></span>`;
    b.querySelector('.tun-type-label').textContent = t.label;
    b.querySelector('.tun-type-hint').textContent = t.hint;
    b.addEventListener('click', () => {
      tunForm.type = t.key;
      refreshTunnelForm();
    });
    types.appendChild(b);
  }
  ov.querySelector('.tun-add-btn').addEventListener('click', addTunnelFromForm);
  return ov;
}

// Rebuild the input fields for the selected tunnel type and refresh the live preview.
function refreshTunnelForm() {
  const ov = document.getElementById('tunnel-overlay');
  if (!ov) return;
  ov.querySelectorAll('.tun-type').forEach((b) => b.classList.toggle('on', b.dataset.type === tunForm.type));
  const fields = ov.querySelector('.tun-fields');
  fields.innerHTML = '';
  const mkNum = (ph) => {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.min = '1';
    inp.max = '65535';
    inp.placeholder = ph;
    inp.className = 'tun-in';
    inp.addEventListener('input', updateTunnelPreview);
    return inp;
  };
  const mkText = (ph, val) => {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = ph;
    if (val) inp.value = val;
    inp.className = 'tun-in tun-in-host';
    inp.addEventListener('input', updateTunnelPreview);
    return inp;
  };
  const field = (label, el) => {
    const w = document.createElement('label');
    w.className = 'tun-field';
    const s = document.createElement('span');
    s.textContent = label;
    w.append(s, el);
    return w;
  };

  const type = tunForm.type;
  tunForm.listenPortEl = mkNum(type === 'D' ? 'SOCKS port e.g. 1080' : type === 'R' ? 'port on server' : 'local port');
  if (type === 'D') {
    fields.append(field('Listen port (on your PC)', tunForm.listenPortEl));
  } else if (type === 'R') {
    tunForm.destHostEl = mkText('localhost', 'localhost');
    tunForm.destPortEl = mkNum('port');
    fields.append(
      field('Server listens on port', tunForm.listenPortEl),
      field('Forward to host (your side)', tunForm.destHostEl),
      field('… port', tunForm.destPortEl)
    );
  } else {
    tunForm.destHostEl = mkText('e.g. db.internal or 10.0.0.5', '');
    tunForm.destPortEl = mkNum('port');
    fields.append(
      field('Local listen port', tunForm.listenPortEl),
      field('Forward to host (from the server)', tunForm.destHostEl),
      field('… port', tunForm.destPortEl)
    );
  }
  // Expose-to-LAN toggle (bind 0.0.0.0 instead of localhost).
  const exW = document.createElement('label');
  exW.className = 'tun-expose';
  tunForm.exposeEl = document.createElement('input');
  tunForm.exposeEl.type = 'checkbox';
  tunForm.exposeEl.addEventListener('change', updateTunnelPreview);
  const exT = document.createElement('span');
  exT.textContent =
    type === 'R'
      ? 'Expose on the server’s public interface (needs GatewayPorts)'
      : 'Allow other devices on my network to use it (0.0.0.0)';
  exW.append(tunForm.exposeEl, exT);
  fields.append(exW);
  updateTunnelPreview();
}

function readTunForm() {
  const type = tunForm.type;
  const expose = tunForm.exposeEl && tunForm.exposeEl.checked;
  const spec = {
    type,
    listenHost: expose ? '0.0.0.0' : '127.0.0.1',
    listenPort: Number(tunForm.listenPortEl && tunForm.listenPortEl.value) || 0,
  };
  if (type !== 'D') {
    spec.destHost = ((tunForm.destHostEl && tunForm.destHostEl.value) || '').trim() || (type === 'R' ? 'localhost' : '');
    spec.destPort = Number(tunForm.destPortEl && tunForm.destPortEl.value) || 0;
  }
  return spec;
}

function updateTunnelPreview() {
  const ov = document.getElementById('tunnel-overlay');
  if (!ov) return;
  const rec = tabs.get(tunnelOverlayTabId);
  const host = (rec && rec.profile && rec.profile.host) || 'host';
  const spec = readTunForm();
  const box = ov.querySelector('.tun-preview');
  box.innerHTML = '';
  box.appendChild(tunnelDiagramEl(spec, host));
  const say = document.createElement('div');
  say.className = 'tun-say';
  say.textContent = tunnelSentence(spec, host);
  box.appendChild(say);
}

function tunErr(msg) {
  const ov = document.getElementById('tunnel-overlay');
  if (ov) ov.querySelector('.tun-err').textContent = msg || '';
}

async function addTunnelFromForm() {
  const rec = tabs.get(tunnelOverlayTabId);
  if (!rec) return;
  const spec = readTunForm();
  const p = spec.listenPort;
  if (!(p >= 1 && p <= 65535)) return tunErr('Enter a listen port between 1 and 65535.');
  if (spec.type !== 'D' && !(spec.destPort >= 1 && spec.destPort <= 65535))
    return tunErr('Enter a destination port between 1 and 65535.');
  if (spec.type === 'L' && !spec.destHost) return tunErr('Enter the destination host to forward to.');
  tunErr('');
  const res = await api.tunnelStart({ ...spec, tabId: rec.id });
  if (!res || !res.ok) return tunErr((res && res.error) || 'Could not start the tunnel.');
  if (res.tunnel) tunnelState.set(res.tunnel.id, res.tunnel);
  if (ov_tunRememberChecked()) rememberTunnel(rec, spec);
  logEvent('system', {
    title: `Port forward started`,
    detail: `${spec.type} · listen ${spec.listenPort}` + (spec.type !== 'D' ? ` → ${spec.destHost}:${spec.destPort}` : ' (SOCKS)'),
    host: rec.profile && rec.profile.host,
  });
  renderTunnelList();
}
function ov_tunRememberChecked() {
  const ov = document.getElementById('tunnel-overlay');
  const cb = ov && ov.querySelector('.tun-remember-cb');
  return !!(cb && cb.checked);
}

function rememberTunnel(rec, spec) {
  const key = rec.serverKey || sshServerKey(rec.profile);
  const list = savedTunnels[key] || (savedTunnels[key] = []);
  // De-dupe by type + listen port.
  if (!list.some((s) => s.type === spec.type && Number(s.listenPort) === Number(spec.listenPort))) {
    list.push({
      type: spec.type,
      listenHost: spec.listenHost,
      listenPort: spec.listenPort,
      destHost: spec.destHost,
      destPort: spec.destPort,
    });
    api.saveSettings({ tunnels: savedTunnels });
  }
}
function forgetTunnel(rec, spec) {
  const key = rec.serverKey || sshServerKey(rec.profile);
  const list = savedTunnels[key];
  if (!list) return;
  savedTunnels[key] = list.filter((s) => !(s.type === spec.type && Number(s.listenPort) === Number(spec.listenPort)));
  api.saveSettings({ tunnels: savedTunnels });
  renderTunnelList();
}

// Start any remembered tunnels for a freshly-connected host (skips ones already live).
function startSavedTunnels(rec) {
  const key = rec.serverKey || sshServerKey(rec.profile);
  const list = savedTunnels[key];
  if (!list || !list.length) return;
  const liveKeys = new Set(
    [...tunnelState.values()].filter((t) => t.tabId === rec.id).map((t) => t.type + ':' + t.listenPort)
  );
  for (const spec of list) {
    if (liveKeys.has(spec.type + ':' + spec.listenPort)) continue;
    api.tunnelStart({ ...spec, tabId: rec.id }).then((res) => {
      if (res && res.ok && res.tunnel) {
        tunnelState.set(res.tunnel.id, res.tunnel);
        if (tunnelOverlayTabId === rec.id) renderTunnelList();
      }
    });
  }
}

const TUN_STATUS = {
  up: { dot: 'ok', label: 'active' },
  starting: { dot: 'warn', label: 'starting…' },
  error: { dot: 'err', label: 'error' },
  stopped: { dot: 'off', label: 'stopped' },
};

function tunnelCard(t, host) {
  const card = document.createElement('div');
  card.className = 'tun-card s-' + t.status;
  card.appendChild(tunnelDiagramEl(t, host));
  const say = document.createElement('div');
  say.className = 'tun-say';
  say.textContent = tunnelSentence(t, host);
  card.appendChild(say);
  const meta = document.createElement('div');
  meta.className = 'tun-meta';
  const st = TUN_STATUS[t.status] || TUN_STATUS.starting;
  const dot = document.createElement('span');
  dot.className = 'tun-dot ' + st.dot;
  meta.appendChild(dot);
  const info = document.createElement('span');
  info.className = 'tun-info';
  info.textContent =
    t.status === 'error'
      ? t.error || 'error'
      : `${st.label} · ${t.conns} conn${t.conns === 1 ? '' : 's'} · ↑ ${fmtBytes(t.up)}  ↓ ${fmtBytes(t.down)}`;
  meta.appendChild(info);
  const stop = document.createElement('button');
  stop.className = 'tun-stop';
  stop.textContent = 'Stop';
  stop.addEventListener('click', async () => {
    await api.tunnelStop(t.id);
    tunnelState.delete(t.id);
    renderTunnelList();
  });
  meta.appendChild(stop);
  card.appendChild(meta);
  return card;
}

function savedTunnelChip(rec, spec, host) {
  const chip = document.createElement('div');
  chip.className = 'tun-saved';
  const lbl = document.createElement('span');
  lbl.className = 'tun-saved-lbl';
  lbl.textContent = `${spec.type} · localhost:${spec.listenPort}` + (spec.type !== 'D' ? ` → ${spec.destHost}:${spec.destPort}` : ' (SOCKS)');
  lbl.title = tunnelSentence(spec, host);
  chip.appendChild(lbl);
  const start = document.createElement('button');
  start.className = 'tun-saved-go';
  start.textContent = '▶ start';
  start.addEventListener('click', async () => {
    const res = await api.tunnelStart({ ...spec, tabId: rec.id });
    if (res && res.ok && res.tunnel) tunnelState.set(res.tunnel.id, res.tunnel);
    renderTunnelList();
  });
  chip.appendChild(start);
  const forget = document.createElement('button');
  forget.className = 'tun-saved-x';
  forget.textContent = '🗑';
  forget.title = 'Forget this saved tunnel';
  forget.addEventListener('click', () => forgetTunnel(rec, spec));
  chip.appendChild(forget);
  return chip;
}

function renderTunnelList() {
  const ov = document.getElementById('tunnel-overlay');
  if (!ov) return;
  const rec = tabs.get(tunnelOverlayTabId);
  const list = ov.querySelector('.tun-list');
  list.innerHTML = '';
  if (!rec) return;
  const host = (rec.profile && rec.profile.host) || 'host';
  const active = [...tunnelState.values()].filter((t) => t.tabId === rec.id);
  if (active.length) {
    const h = document.createElement('div');
    h.className = 'tun-sec';
    h.textContent = 'Active';
    list.appendChild(h);
    for (const t of active) list.appendChild(tunnelCard(t, host));
  }
  // Saved-but-not-running specs for this host.
  const key = rec.serverKey || sshServerKey(rec.profile);
  const saved = (savedTunnels[key] || []).filter(
    (s) => !active.some((t) => t.type === s.type && Number(t.listenPort) === Number(s.listenPort))
  );
  if (saved.length) {
    const h = document.createElement('div');
    h.className = 'tun-sec';
    h.textContent = 'Saved for this host';
    list.appendChild(h);
    for (const s of saved) list.appendChild(savedTunnelChip(rec, s, host));
  }
  if (!active.length && !saved.length) {
    const empty = document.createElement('div');
    empty.className = 'tun-empty';
    empty.textContent = 'No tunnels yet. Pick a type below and add one - the diagram shows exactly what it will do.';
    list.appendChild(empty);
  }
}

function openTunnels(rec) {
  if (!rec || rec.kind !== 'ssh') return;
  tunnelOverlayTabId = rec.id;
  const ov = buildTunnelOverlay();
  ov.querySelector('.tun-sub').textContent =
    (rec.profile.username ? rec.profile.username + '@' : '') + rec.profile.host + ':' + (rec.profile.port || 22);
  tunForm.type = 'L';
  ov.querySelector('.tun-err').textContent = '';
  const cb = ov.querySelector('.tun-remember-cb');
  if (cb) cb.checked = false;
  refreshTunnelForm();
  applyTunOffset(); // keep any dragged position from this session
  ov.classList.remove('hidden');
  // Refresh the live list from the main process (covers tunnels started earlier).
  api.tunnelList(rec.id).then((res) => {
    if (res && res.ok) {
      for (const t of res.tunnels) tunnelState.set(t.id, t);
    }
    renderTunnelList();
  });
}

api.onTunnelUpdate((t) => {
  if (t.status === 'stopped') tunnelState.delete(t.id);
  else tunnelState.set(t.id, t);
  if (tunnelOverlayTabId && document.getElementById('tunnel-overlay') && !document.getElementById('tunnel-overlay').classList.contains('hidden')) {
    renderTunnelList();
  }
});

// ---------------------------------------------------------------------------
// Host vitals - a tiny live load/mem/disk sparkline strip on each SSH tab, fed by
// a lightweight side-channel poll in the main process (never the interactive shell).
// Opt-in from the Terminal ▾ menu; each metric is 0-100% (CPU = load1 / ncpu).
// ---------------------------------------------------------------------------
let hostVitals = false;
let vitalsIntervalSec = 15; // how often to poll each host (configurable in the Terminal ▾ menu)
const vitalsData = new Map(); // tabId -> { cpu:[], mem:[], disk:[], last:{} }
const VIT_MAX = 40; // samples kept per metric
const vitalsMs = () => Math.max(3, vitalsIntervalSec) * 1000;

function updateVitalsBtn() {
  const b = document.getElementById('vitals-btn');
  if (!b) return;
  b.classList.toggle('on', hostVitals);
  b.textContent = (hostVitals ? '☑' : '☐') + ' 📈 Host vitals';
}

function vitColor(v) {
  if (v == null) return '#7c8894';
  if (v < 60) return '#4cd07d';
  if (v < 85) return '#e6c34a';
  return '#ff6b6b';
}

function vitSparkline(vals, color) {
  const w = 42;
  const h = 14;
  if (!vals.length) return `<svg class="vit-spark" width="${w}" height="${h}"></svg>`;
  const step = vals.length > 1 ? w / (vals.length - 1) : w;
  const pts = vals
    .map((v, i) => {
      const y = (h - 1 - (Math.max(0, Math.min(100, v == null ? 0 : v)) / 100) * (h - 2)).toFixed(1);
      return `${(i * step).toFixed(1)},${y}`;
    })
    .join(' ');
  return `<svg class="vit-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.3"/></svg>`;
}

// Render the ACTIVE ssh tab's vitals into the status bar (bottom line), next to the shell
// name. Hidden when the active tab isn't a connected ssh shell or tracking is off.
function renderStatusVitals() {
  const el = document.getElementById('status-vitals');
  if (!el) return;
  const rec = activeTabId ? tabs.get(activeTabId) : null;
  const d = hostVitals && rec && rec.kind === 'ssh' ? vitalsData.get(rec.id) : null;
  if (!d) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const metric = (label, arr) => {
    const cur = arr.length ? arr[arr.length - 1] : null;
    const txt = cur == null ? 'n/a' : cur + '%';
    return (
      `<div class="vit-metric"><span class="vit-k">${label}</span>` +
      vitSparkline(arr, vitColor(cur)) +
      `<span class="vit-v" style="color:${vitColor(cur)}">${txt}</span></div>`
    );
  };
  el.innerHTML = metric('CPU', d.cpu) + metric('MEM', d.mem) + metric('DISK', d.disk);
  el.title = vitalsTooltip(d.last || {});
  el.classList.remove('hidden');
}

// Build the multi-line hover tooltip with absolute figures (e.g. "MEM 29% of 33 GB").
function vitalsTooltip(v) {
  const fmtGB = (kb) => {
    if (kb == null) return null;
    const g = kb / 1048576; // KB -> GB
    return (g >= 100 ? g.toFixed(0) : g.toFixed(1)) + ' GB';
  };
  const lines = [];
  const load = v.load1 != null ? v.load1.toFixed(2) : '?';
  lines.push(`CPU ${v.cpu != null ? v.cpu + '%' : 'n/a'}  ·  load ${load} on ${v.ncpu || '?'} core${v.ncpu === 1 ? '' : 's'}`);
  let memLine = `MEM ${v.mem != null ? v.mem + '%' : 'n/a'}`;
  if (v.memTotalKB) memLine += ` of ${fmtGB(v.memTotalKB)}` + (v.memUsedKB != null ? ` (${fmtGB(v.memUsedKB)} used)` : '');
  lines.push(memLine);
  let diskLine = `DISK ${v.disk != null ? v.disk + '%' : 'n/a'}`;
  if (v.diskTotalKB) diskLine += ` of ${fmtGB(v.diskTotalKB)}` + (v.diskUsedKB != null ? ` (${fmtGB(v.diskUsedKB)} used)` : '');
  lines.push(diskLine);
  return lines.join('\n');
}

api.onVitals(({ tabId, v }) => {
  const rec = tabs.get(tabId);
  if (!rec) return;
  let d = vitalsData.get(tabId);
  if (!d) {
    d = { cpu: [], mem: [], disk: [], last: {} };
    vitalsData.set(tabId, d);
  }
  d.cpu.push(v.cpu);
  d.mem.push(v.mem);
  d.disk.push(v.disk);
  d.last = v;
  for (const k of ['cpu', 'mem', 'disk']) if (d[k].length > VIT_MAX) d[k].shift();
  if (hostVitals && tabId === activeTabId) renderStatusVitals();
});

function toggleHostVitals() {
  hostVitals = !hostVitals;
  api.saveSettings({ hostVitals });
  updateVitalsBtn();
  for (const rec of tabs.values()) {
    if (rec.kind !== 'ssh') continue;
    if (hostVitals && rec.status === 'connected') api.vitalsStart(rec.id, vitalsMs());
    else api.vitalsStop(rec.id);
  }
  renderStatusVitals();
}

// Apply a changed poll interval by restarting the poll on every connected SSH tab.
function restartVitals() {
  if (!hostVitals) return;
  for (const rec of tabs.values()) {
    if (rec.kind === 'ssh' && rec.status === 'connected') {
      api.vitalsStop(rec.id);
      api.vitalsStart(rec.id, vitalsMs());
    }
  }
}

// ---------------------------------------------------------------------------
// Session recording -> asciicast v2 (.cast). Taps the raw output stream with timing;
// on stop, writes a standard asciicast you can `asciinema play` or convert to a GIF.
// ---------------------------------------------------------------------------
function toggleRecording(rec) {
  if (!rec) return;
  if (rec._rec) stopRecording(rec);
  else startRecording(rec);
}
function startRecording(rec) {
  if (!rec || (rec.kind !== 'ssh' && rec.kind !== 'local') || !rec.term || rec._rec) return;
  rec._rec = {
    start: Date.now(),
    events: [],
    bytes: 0,
    cols: rec.term.cols,
    rows: rec.term.rows,
  };
  if (rec.tabEl) rec.tabEl.classList.add('recording');
  writeToTerm(rec, '\r\n\x1b[2m[● recording - stop from the tab menu (hover the tab) to save a .cast]\x1b[0m\r\n');
}
// Append one output chunk (already decoded to a UTF-8 string) to the active recording.
function recCaptureText(rec, text) {
  const r = rec._rec;
  if (!r || !text) return;
  r.events.push([(Date.now() - r.start) / 1000, 'o', text]);
  r.bytes += text.length;
  if (r.bytes > 25 * 1024 * 1024) stopRecording(rec, 'size'); // safety cap
}
function buildCast(rec, r) {
  const header = {
    version: 2,
    width: r.cols || 80,
    height: r.rows || 24,
    timestamp: Math.floor(r.start / 1000),
    title: (rec.profile && (rec.profile.name || rec.profile.host)) || (rec.kind === 'local' ? 'local shell' : 'session'),
    env: { TERM: 'xterm-256color' },
  };
  let out = JSON.stringify(header) + '\n';
  for (const ev of r.events) out += JSON.stringify(ev) + '\n';
  return out;
}
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}
async function stopRecording(rec, reason) {
  const r = rec && rec._rec;
  if (!r) return;
  rec._rec = null;
  if (rec.tabEl) rec.tabEl.classList.remove('recording');
  if (!r.events.length) {
    writeToTerm(rec, '\r\n\x1b[2m[recording stopped - nothing captured]\x1b[0m\r\n');
    return;
  }
  const p2 = (n) => String(n).padStart(2, '0');
  const d = new Date(r.start);
  const host = String((rec.profile && (rec.profile.name || rec.profile.host)) || (rec.kind === 'local' ? 'local' : 'session')).replace(/[^\w.\-]+/g, '_');
  const name = `session-${host}-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.cast`;
  const dur = ((Date.now() - r.start) / 1000).toFixed(0);
  writeToTerm(rec, `\r\n\x1b[2m[recording stopped${reason === 'size' ? ' (size limit)' : ''} - ${dur}s, choose where to save]\x1b[0m\r\n`);
  try {
    const res = await api.saveBase64(name, utf8ToBase64(buildCast(rec, r)));
    if (res && res.ok) writeToTerm(rec, `\x1b[2m[saved .cast to ${res.savedTo} - replay: asciinema play <file>]\x1b[0m\r\n`);
    else if (res && res.canceled) writeToTerm(rec, '\x1b[2m[save canceled]\x1b[0m\r\n');
  } catch (e) {
    writeToTerm(rec, `\x1b[2m[could not save recording: ${e.message || e}]\x1b[0m\r\n`);
  }
}

// ---------------------------------------------------------------------------
// Always-on rolling capture of each terminal's output (bounded), so you can scrub the
// terminal backward through time and see its exact state at any past moment. Also feeds
// the (opt-in) session recorder above so we decode the stream only once.
// ---------------------------------------------------------------------------
const HIST_MAX_BYTES = 4 * 1024 * 1024; // per-terminal rolling window
function streamDecode(rec, u8) {
  if (!rec._streamDec) rec._streamDec = new TextDecoder('utf-8');
  return rec._streamDec.decode(u8, { stream: true });
}
function histCapture(rec, text) {
  let h = rec._hist;
  if (!h) h = rec._hist = { events: [], bytes: 0 };
  h.events.push([Date.now(), text]);
  h.bytes += text.length;
  while (h.bytes > HIST_MAX_BYTES && h.events.length > 1) {
    h.bytes -= h.events.shift()[1].length; // drop oldest
  }
}
function captureStream(rec, text) {
  if (!text) return;
  histCapture(rec, text);
  if (rec._rec) recCaptureText(rec, text);
}

// --- Time-travel overlay: replay the captured stream into a read-only terminal ---
let ttTerm = null;
let ttFit = null;
let ttEvents = [];
let ttIdx = -1;
let ttRaf = 0;
let ttPending = 0;
let ttGeom = null; // {left, top, width, height} - remembered while the app is open
let ttFitTimer = null;

function applyTtGeom(card) {
  if (!card || !ttGeom) return;
  card.style.left = ttGeom.left + 'px';
  card.style.top = ttGeom.top + 'px';
  card.style.width = ttGeom.width + 'px';
  card.style.height = ttGeom.height + 'px';
}
// Re-render the current frame at the terminal's (possibly resized) dimensions.
function ttRerender() {
  if (!ttTerm || !ttEvents.length) return;
  ttTerm.reset();
  ttTerm.write(ttSlice(0, Math.max(0, ttIdx)));
}

function ttSlice(a, b) {
  let s = '';
  for (let i = a; i <= b; i++) s += ttEvents[i][1];
  return s;
}
function ttReplayTo(idx) {
  if (!ttTerm || !ttEvents.length) return;
  idx = Math.max(0, Math.min(ttEvents.length - 1, idx));
  if (idx < ttIdx) {
    ttTerm.reset(); // scrubbing back: rebuild from the start of the window
    ttTerm.write(ttSlice(0, idx));
  } else if (idx > ttIdx) {
    ttTerm.write(ttSlice(ttIdx + 1, idx)); // scrubbing forward: append the delta
  }
  ttIdx = idx;
  const ts = ttEvents[idx][0];
  const live = idx === ttEvents.length - 1;
  const lbl = document.querySelector('#tt-overlay .tt-time');
  if (lbl) lbl.textContent = live ? 'latest' : fmtAgo(Date.now() - ts) + ' · ' + new Date(ts).toLocaleTimeString();
}
function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  return m + 'm ' + (s % 60) + 's ago';
}
function buildTtOverlay() {
  let ov = document.getElementById('tt-overlay');
  if (ov) return ov;
  ov = document.createElement('div');
  ov.id = 'tt-overlay';
  ov.className = 'hidden';
  ov.innerHTML =
    '<div class="tt-card">' +
    '<div class="tt-head"><span class="tt-title">🕰 Time travel</span><span class="tt-sub"></span>' +
    '<span class="tt-time"></span><button class="tt-close" title="Close (Esc)">✕</button></div>' +
    '<div class="tt-term"></div>' +
    '<div class="tt-bar"><input type="range" class="tt-slider" min="0" max="0" value="0">' +
    '<button class="tt-live" title="Jump to the latest">▶ latest</button></div>' +
    '<div class="tt-foot">Drag to scrub this terminal back through its recent history (read-only). Live output keeps flowing in the real tab.</div>' +
    '</div>';
  document.body.appendChild(ov);
  ov.querySelector('.tt-close').addEventListener('click', closeTimeTravel);
  ov.addEventListener('mousedown', (e) => {
    if (e.target === ov) closeTimeTravel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !ov.classList.contains('hidden')) closeTimeTravel();
  });
  const slider = ov.querySelector('.tt-slider');
  slider.addEventListener('input', () => {
    ttPending = Number(slider.value);
    if (!ttRaf) ttRaf = requestAnimationFrame(() => {
      ttRaf = 0;
      ttReplayTo(ttPending);
    });
  });
  ov.querySelector('.tt-live').addEventListener('click', () => {
    slider.value = String(ttEvents.length - 1);
    ttReplayTo(ttEvents.length - 1);
  });
  // Drag the window by its header.
  const card = ov.querySelector('.tt-card');
  ov.querySelector('.tt-head').addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = parseFloat(card.style.left) || 0;
    const oy = parseFloat(card.style.top) || 0;
    const move = (ev) => {
      ttGeom = ttGeom || {};
      ttGeom.left = Math.max(0, Math.min(ox + (ev.clientX - sx), window.innerWidth - 80));
      ttGeom.top = Math.max(0, Math.min(oy + (ev.clientY - sy), window.innerHeight - 40));
      card.style.left = ttGeom.left + 'px';
      card.style.top = ttGeom.top + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  });
  // Resize (corner handle / any size change) -> refit the terminal and re-render the frame.
  try {
    const ro = new ResizeObserver(() => {
      if (ov.classList.contains('hidden') || !ttTerm) return;
      ttGeom = ttGeom || {};
      if (card.offsetWidth && card.offsetHeight) {
        ttGeom.width = card.offsetWidth;
        ttGeom.height = card.offsetHeight;
      }
      clearTimeout(ttFitTimer);
      ttFitTimer = setTimeout(() => {
        if (ov.classList.contains('hidden') || !ttTerm) return;
        try {
          ttFit.fit();
        } catch (_) {
          /* ignore */
        }
        ttRerender();
      }, 60);
    });
    ro.observe(card);
  } catch (_) {
    /* ResizeObserver optional */
  }
  return ov;
}
function openTimeTravel(rec) {
  if (!rec || (rec.kind !== 'ssh' && rec.kind !== 'local') || !rec.term) return;
  const h = rec._hist;
  if (!h || !h.events.length) {
    writeToTerm(rec, '\r\n\x1b[2m[time travel: no history captured yet - it records from now on]\x1b[0m\r\n');
    return;
  }
  ttEvents = h.events.slice(); // snapshot so scrubbing is stable while live output continues
  const ov = buildTtOverlay();
  ov.querySelector('.tt-sub').textContent =
    (rec.profile && (rec.profile.name || rec.profile.host)) || (rec.kind === 'local' ? 'local shell' : 'session');
  if (ttTerm) {
    try {
      ttTerm.dispose();
    } catch (_) {
      /* ignore */
    }
    ttTerm = null;
  }
  try {
    ttTerm = new Terminal({
      theme: THEMES[currentTheme],
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      fontSize: fontSize,
      cursorBlink: false,
      scrollback: 10000,
      disableStdin: true,
      allowProposedApi: true,
    });
    ttFit = new FitAddon.FitAddon();
    ttTerm.loadAddon(ttFit);
  } catch (_) {
    return;
  }
  // Position/size the window (centered by default; remembers drag/resize while open).
  const card = ov.querySelector('.tt-card');
  if (!ttGeom) {
    const w = Math.min(1000, window.innerWidth - 40);
    const h = Math.min(680, window.innerHeight - 40);
    ttGeom = { left: Math.max(20, (window.innerWidth - w) / 2), top: Math.max(20, (window.innerHeight - h) / 2), width: w, height: h };
  }
  applyTtGeom(card);
  const host = ov.querySelector('.tt-term');
  host.innerHTML = '';
  ttTerm.open(host);
  const slider = ov.querySelector('.tt-slider');
  slider.min = '0';
  slider.max = String(ttEvents.length - 1);
  slider.value = String(ttEvents.length - 1);
  ttIdx = -1;
  ov.classList.remove('hidden');
  setTimeout(() => {
    try {
      ttFit.fit();
    } catch (_) {
      /* ignore */
    }
    ttReplayTo(ttEvents.length - 1); // start at "now"
  }, 30);
}
function closeTimeTravel() {
  const ov = document.getElementById('tt-overlay');
  if (ov) ov.classList.add('hidden');
  if (ttTerm) {
    try {
      ttTerm.dispose();
    } catch (_) {
      /* ignore */
    }
    ttTerm = null;
  }
  ttEvents = [];
  ttIdx = -1;
}

api.onData(({ tabId, data }) => {
  const rec = tabs.get(tabId);
  if (rec && rec.term) {
    const u8 = binaryToUint8(data);
    captureStream(rec, streamDecode(rec, u8)); // ssh: latin1 bytes -> UTF-8 text (history + recorder)
    if (rec._grab) {
      const vis = rec._grab.feed(u8ToLatin1(u8)); // hides the base64; returns only the tail
      if (vis) writeToTerm(rec, vis);
    } else {
      writeToTerm(rec, u8);
    }
    detectClaudeQuestion(rec, data);
    detectCommandDone(rec, data);
  }
});

// --- Detect Claude Code prompts in terminal output and flag the tab ---
let claudeWatch = true;
const CLAUDE_Q_PATTERNS = [
  /Do you want to proceed\?/i,
  /Do you trust the files/i,
  /Would you like to proceed/i,
  /❯\s*\d+\.\s+Yes/,
  /\b1\.\s+Yes\b[\s\S]{0,80}\b2\.\s+No\b/,
];

function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b[P^_][^\x1b]*\x1b\\/g, '') // DCS/PM/APC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[@-Z\\-_]/g, ''); // other escapes
}

function detectClaudeQuestion(rec, data) {
  if (!claudeWatch || rec.kind !== 'ssh') return;
  // Decode UTF-8 (data is a latin1/binary string) so box chars like ❯ match.
  const text = stripAnsi(new TextDecoder('utf-8').decode(binaryToUint8(data)));
  rec.qBuffer = (rec.qBuffer + text).slice(-3000);
  if (rec.attention || rec.id === activeTabId) return;
  if (CLAUDE_Q_PATTERNS.some((re) => re.test(rec.qBuffer))) setTabAttention(rec);
}

function setTabAttention(rec) {
  rec.attention = true;
  rec.tabEl.classList.add('attention');
  logEvent('attention', {
    title: 'Claude asked in ' + ((rec.profile && rec.profile.name) || 'a tab'),
    ref: { type: 'tab', tabKey: tabKey(rec) },
  });
  if (!document.hasFocus()) {
    try {
      const n = new Notification('Claude is asking a question', {
        body: `${rec.profile.name}: a prompt is waiting for your answer`,
      });
      n.onclick = () => {
        api.focusWindow();
        activateTab(rec.id);
      };
    } catch (_) {
      /* notifications optional */
    }
  }
}

function clearTabAttention(rec) {
  if (!rec.attention) return;
  rec.attention = false;
  rec.tabEl.classList.remove('attention');
  rec.qBuffer = ''; // drop the answered prompt so it can't re-trigger
}

// Auto-hop: run a server's stored ssh commands automatically on connect. Off by default.
let autoHopEnabled = false;
// Auto-hop collection: record `ssh …` commands you type into the per-server hop list. Off by default.
let autoHopCollect = false;
// Register Cockpit as the OS handler for ssh:// links. Off by default (opt-in in Settings).
let sshProtocolHandler = false;
// Optional jump/bastion host to reach ssh:// link targets through: "[user@]host [-p port]".
// When set, an ssh:// link connects here first and hops to the target with `ssh …`.
let sshJumpHost = '';

// --- Command-done notifier (long command finishes in a background SSH tab) ---
let cmdDoneNotify = true;
const CMD_MIN_DURATION = 10000; // only commands that ran longer than this

function detectCommandDone(rec, data) {
  if (!rec.cmdRunning) return;
  // Track the alternate screen buffer (vim/less/htop/top) to suppress false "done".
  if (data.includes('\x1b[?1049h')) rec.altScreen = true;
  if (data.includes('\x1b[?1049l')) rec.altScreen = false;
  rec.outTail = (rec.outTail + stripAnsi(new TextDecoder('utf-8').decode(binaryToUint8(data)))).slice(-240);
  if (rec.altScreen) return;
  if (Date.now() - rec.cmdStart < CMD_MIN_DURATION) return;
  // Heuristic: the shell prompt has returned (line ends with $ # % > ❯).
  const tail = rec.outTail.replace(/\s+$/, '');
  if (/[$#%>❯]$/.test(tail)) {
    rec.cmdRunning = false;
    logEvent('cmd-done', {
      title: rec.cmdName || 'command',
      detail: 'took ' + bbDur(Date.now() - rec.cmdStart),
      host: (rec.profile && (rec.profile.host || rec.profile.name)) || '',
      ref: { type: 'tab', tabKey: tabKey(rec) },
    });
    notifyCommandDone(rec);
  }
}

function notifyCommandDone(rec) {
  if (!cmdDoneNotify) return;
  const unfocused = rec.id !== activeTabId || !document.hasFocus();
  if (!unfocused) return; // you're watching this tab — no need to ping
  doneChime();
  rec.attention = true;
  rec.tabEl.classList.add('attention');
  try {
    const n = new Notification('✓ Command finished', {
      body: `${rec.cmdName} — ${rec.profile.name}`,
    });
    n.onclick = () => {
      api.focusWindow();
      activateTab(rec.id);
    };
  } catch (_) {
    /* notifications unavailable */
  }
}

// A short two-note "ding-dong" when a command finishes.
function doneChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [
      [880, 0],
      [1318.51, 0.12],
    ].forEach(([f, dt]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = now + dt;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.45);
    });
    setTimeout(() => ctx.close(), 1000);
  } catch (_) {
    /* audio unavailable */
  }
}

api.onStatus(({ tabId, line }) => {
  const rec = tabs.get(tabId);
  if (!rec || !rec.term) return;
  if (/connected/i.test(line)) {
    setTabStatus(tabId, 'connected', line);
    replayStartupCommands(rec);
    // One-shot hop for an ssh:// link opened through a jump/bastion host.
    if (rec.startupCmd) {
      const cmd = rec.startupCmd;
      rec.startupCmd = null;
      setTimeout(() => {
        try {
          api.write(rec.id, cmd + '\r');
        } catch (_) {
          /* session may have dropped */
        }
      }, 700);
    }
    startSavedTunnels(rec); // re-establish remembered port forwards for this host
    if (hostVitals) api.vitalsStart(tabId, vitalsMs()); // begin the load/mem/disk poll
  } else if (/closed/i.test(line)) setTabStatus(tabId, 'closed', line);
  else setTabStatus(tabId, rec.status, line);
});

api.onError(({ tabId, message }) => {
  const rec = tabs.get(tabId);
  if (!rec || !rec.term) return;
  setTabStatus(tabId, 'error', message);
  rec.term.write(`\r\n\x1b[1;31m[error] ${message}\x1b[0m\r\n`);
  // A failed connect (e.g. timeout / bad passphrase) is a dead end without options —
  // show the reconnect banner here too, not just on a clean close.
  if (!rec._bannerShown) {
    rec.term.write(deadSessionBanner('Connection failed', rec));
    rec._bannerShown = true;
  }
});

api.onClose(({ tabId }) => {
  const rec = tabs.get(tabId);
  if (!rec || !rec.term) return;
  setTabStatus(tabId, 'closed', 'Disconnected');
  if (!rec._bannerShown) rec.term.write(deadSessionBanner('Session closed', rec));
  rec._bannerShown = true;
});

// An ssh:// link was opened in the OS (Cockpit is registered as its handler).
if (api.onSshUrl) api.onSshUrl((t) => openSshUrl(t));

// Fallback so R / P / Enter work on a dead SSH tab even when the terminal doesn't
// have keyboard focus (common right after a failed connect). The in-terminal
// handler covers the focused case; this covers everything else.
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!activeTabId) return;
  const rec = tabs.get(activeTabId);
  if (!rec || rec.kind !== 'ssh') return;
  if (rec.status !== 'closed' && rec.status !== 'error') return;
  if (els.overlay && !els.overlay.classList.contains('hidden')) return; // dialog open
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
    return; // don't hijack real typing (incl. the focused xterm textarea)
  }
  const k = e.key.toLowerCase();
  if (k === 'r') {
    e.preventDefault();
    reconnect(activeTabId);
  } else if (k === 'p') {
    e.preventDefault();
    openReconnectDialog(activeTabId);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    closeTab(activeTabId);
  }
});

// MobaXterm-style options banner shown when a session ends. Offers to re-enter the
// passphrase/password for key/password auth (secrets aren't kept once the tab dies).
function deadSessionBanner(label, rec) {
  const needsSecret = rec && rec.profile && (rec.profile.authMethod === 'key' || rec.profile.authMethod === 'password');
  return (
    `\r\n\x1b[1;33m── ${label} ──\x1b[0m\r\n` +
    '  Press \x1b[1;32mR\x1b[0m to reconnect    ' +
    (needsSecret ? '\x1b[1;32mP\x1b[0m to re-enter passphrase    ' : '') +
    '\x1b[1;32mEnter\x1b[0m to close this tab\r\n'
  );
}

// ssh2 hands us binary strings; xterm wants Uint8Array for raw bytes.
function binaryToUint8(str) {
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i) & 0xff;
  return arr;
}

// ---------------------------------------------------------------------------
// Connection dialog
// ---------------------------------------------------------------------------
// When set, the dialog's Connect re-connects THIS existing tab (re-entering the
// passphrase/password) instead of creating a new one.
let reconnectTabId = null;

function openDialog() {
  reconnectTabId = null;
  els.connectBtn.textContent = 'Connect';
  els.dialogError.textContent = '';
  els.overlay.classList.remove('hidden');
  els.fHost.focus();
}

// Re-open the dialog to re-enter the passphrase/password for a dead tab and reconnect it.
function openReconnectDialog(id) {
  const rec = tabs.get(id);
  if (!rec || rec.kind !== 'ssh') return;
  reconnectTabId = id;
  fillForm(rec.profile); // clears passphrase/password fields
  els.connectBtn.textContent = 'Reconnect';
  els.dialogError.textContent = '';
  els.overlay.classList.remove('hidden');
  // Focus the secret field they need to re-enter.
  const field = rec.profile.authMethod === 'password' ? els.fPassword : els.fPassphrase;
  requestAnimationFrame(() => field.focus());
}

function closeDialog() {
  els.overlay.classList.add('hidden');
  reconnectTabId = null;
  els.connectBtn.textContent = 'Connect';
}

function syncAuthFields() {
  const m = els.fAuth.value;
  els.keyFields.classList.toggle('hidden', m !== 'key');
  els.passwordFields.classList.toggle('hidden', m !== 'password');
}

function readForm() {
  return {
    name: els.fName.value.trim(),
    host: els.fHost.value.trim(),
    port: Number(els.fPort.value) || 22,
    username: els.fUser.value.trim(),
    authMethod: els.fAuth.value,
    keyPath: els.fKey.value.trim(),
    passphrase: els.fPassphrase.value,
    password: els.fPassword.value,
  };
}

function fillForm(s) {
  els.fName.value = s.name || '';
  els.fHost.value = s.host || '';
  els.fPort.value = s.port || 22;
  els.fUser.value = s.username || '';
  els.fAuth.value = s.authMethod || 'agent';
  els.fKey.value = s.keyPath || '';
  els.fPassphrase.value = '';
  els.fPassword.value = '';
  syncAuthFields();
}

function renderSavedList() {
  els.savedList.innerHTML = '';
  savedSessions.forEach((s, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = s.name || `${s.username}@${s.host}`;
    els.savedList.appendChild(opt);
  });
}

async function refreshSaved() {
  savedSessions = await api.loadSessions();
  renderSavedList();
}

function validate(form) {
  if (!form.host) return 'Host is required.';
  if (!form.username) return 'Username is required.';
  if (form.authMethod === 'key' && !form.keyPath) return 'Select a private key file.';
  return null;
}

// ---------------------------------------------------------------------------
// Dialog event handlers
// ---------------------------------------------------------------------------
els.fAuth.addEventListener('change', syncAuthFields);

els.savedList.addEventListener('change', () => {
  const idx = Number(els.savedList.value);
  if (!Number.isNaN(idx) && savedSessions[idx]) fillForm(savedSessions[idx]);
});
els.savedList.addEventListener('dblclick', () => doConnect());

els.browseKeyBtn.addEventListener('click', async () => {
  const p = await api.browseKey();
  if (p) els.fKey.value = p;
});

els.saveSessionBtn.addEventListener('click', async () => {
  const form = readForm();
  const err = validate(form);
  if (err) {
    els.dialogError.textContent = err;
    return;
  }
  const profile = {
    name: form.name || `${form.username}@${form.host}`,
    host: form.host,
    port: form.port,
    username: form.username,
    authMethod: form.authMethod,
    keyPath: form.keyPath,
  };
  const existing = savedSessions.findIndex((s) => s.name === profile.name);
  if (existing >= 0) savedSessions[existing] = profile;
  else savedSessions.push(profile);
  savedSessions = await api.saveSessions(savedSessions);
  renderSavedList();
  els.dialogError.textContent = 'Saved.';
});

els.deleteSessionBtn.addEventListener('click', async () => {
  const idx = Number(els.savedList.value);
  if (Number.isNaN(idx) || !savedSessions[idx]) return;
  savedSessions.splice(idx, 1);
  savedSessions = await api.saveSessions(savedSessions);
  renderSavedList();
});

function doConnect() {
  const form = readForm();
  const err = validate(form);
  if (err) {
    els.dialogError.textContent = err;
    return;
  }
  if (!form.name) form.name = `${form.username}@${form.host}`;
  // Reconnect mode: update the existing tab's profile (new passphrase) and retry.
  if (reconnectTabId) {
    const rec = tabs.get(reconnectTabId);
    const id = reconnectTabId;
    closeDialog();
    if (rec) {
      rec.profile = { ...rec.profile, ...form };
      reconnect(id); // reconnect with the just-entered secret
    }
    return;
  }
  // Remember this connection (without secrets) to prefill the dialog next time.
  api.saveSettings({
    lastConnection: {
      name: form.name,
      host: form.host,
      port: form.port,
      username: form.username,
      authMethod: form.authMethod,
      keyPath: form.keyPath,
    },
  });
  closeDialog();
  createTab(form);
}

els.connectBtn.addEventListener('click', doConnect);
els.cancelBtn.addEventListener('click', () => {
  if (tabs.size > 0) closeDialog();
});
els.newTabBtn.addEventListener('click', openDialog);

// Enter to connect from any text field in the form
els.overlay.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !els.overlay.classList.contains('hidden')) {
    if (document.activeElement !== els.savedList) doConnect();
  } else if (e.key === 'Escape' && tabs.size > 0) {
    closeDialog();
  }
});

// ---------------------------------------------------------------------------
// Global keyboard shortcuts
// ---------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't') {
    e.preventDefault();
    openDialog();
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    if (activeTabId) closeTab(activeTabId);
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openSearch();
  } else if (e.key === 'F9') {
    e.preventDefault();
    togglePrivacy(); // Privacy Curtain on/off
  } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
    // Ctrl+F = find in page on a web tab; on terminals it stays a shell shortcut.
    if (activeWebRec()) {
      e.preventDefault();
      openWebFind();
    }
  } else if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'r') {
    // Reload the active web tab; ignore for SSH/Slack (Ctrl+R is reverse-search there).
    const rec = activeTabId ? tabs.get(activeTabId) : null;
    if (rec && rec.kind === 'web' && rec.wv) {
      e.preventDefault();
      try {
        if (e.shiftKey) rec.wv.reloadIgnoringCache();
        else rec.wv.reload();
      } catch (_) {
        /* webview not ready */
      }
    }
  } else if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    const ids = Array.from(tabs.keys());
    if (ids.length > 1 && activeTabId) {
      const i = ids.indexOf(activeTabId);
      activateTab(ids[(i + 1) % ids.length]);
    }
  }
});

// ---------------------------------------------------------------------------
// Resize handling: refit the active terminal when the window changes.
// ---------------------------------------------------------------------------
const ro = new ResizeObserver(() => {
  const rec = activeTabId ? tabs.get(activeTabId) : null;
  if (rec && (rec.kind === 'ssh' || rec.kind === 'local')) {
    try {
      rec.fitAddon.fit();
    } catch (_) {
      /* not ready */
    }
  }
});
ro.observe(els.terminals);

// ---------------------------------------------------------------------------
// Drag to reorder tabs
// ---------------------------------------------------------------------------
// Mouse wheel over the tab strip scrolls it left/right (vertical wheel → horizontal).
els.tabs.addEventListener(
  'wheel',
  (e) => {
    if (els.tabs.scrollWidth <= els.tabs.clientWidth) return; // nothing to scroll
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!delta) return;
    els.tabs.scrollLeft += delta;
    e.preventDefault(); // don't let it bubble into a page/zoom action
  },
  { passive: false }
);

els.tabs.addEventListener('dragover', (e) => {
  e.preventDefault();
  const dragging = els.tabs.querySelector('.tab.dragging');
  if (!dragging) return;
  const after = getDragAfterElement(e.clientX);
  if (after == null) els.tabs.appendChild(dragging);
  else els.tabs.insertBefore(dragging, after);
});

function getDragAfterElement(x) {
  const others = [...els.tabs.querySelectorAll('.tab:not(.dragging)')];
  let closest = { offset: -Infinity, el: null };
  for (const child of others) {
    const box = child.getBoundingClientRect();
    const offset = x - box.left - box.width / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, el: child };
  }
  return closest.el;
}

// Rebuild the tabs Map to match the DOM order (keeps Ctrl+Tab nav in sync).
function syncTabOrderFromDom() {
  const entries = [];
  els.tabs.querySelectorAll('.tab').forEach((el) => {
    const tid = el.dataset.id;
    if (tabs.has(tid)) entries.push([tid, tabs.get(tid)]);
  });
  tabs.clear();
  for (const [k, v] of entries) tabs.set(k, v);
  persistOpenSlackChannels();
  persistOpenSshTabs();
  persistOpenWebTabs();
}

// ---------------------------------------------------------------------------
// Scrollback search (Ctrl+Shift+F)
// ---------------------------------------------------------------------------
const SEARCH_DECOR = {
  decorations: {
    matchBackground: '#5c4b00',
    matchBorder: '#ffd54f',
    matchOverviewRuler: '#ffd54f',
    activeMatchBackground: '#ff9800',
    activeMatchBorder: '#ffcc80',
    activeMatchColorOverviewRuler: '#ff9800',
  },
};

function activeSearch() {
  const rec = activeTabId ? tabs.get(activeTabId) : null;
  return rec ? rec.searchAddon : null;
}

function openSearch() {
  if (!activeTabId) return;
  els.searchBar.classList.remove('hidden');
  els.searchInput.focus();
  els.searchInput.select();
  if (els.searchInput.value) searchFind(1);
}

function closeSearch() {
  els.searchBar.classList.add('hidden');
  els.searchInfo.textContent = '';
  const sa = activeSearch();
  if (sa) {
    try {
      sa.clearDecorations();
    } catch (_) {
      /* ignore */
    }
  }
  const rec = activeTabId ? tabs.get(activeTabId) : null;
  if (rec && rec.term) rec.term.focus();
}

function searchFind(dir) {
  const sa = activeSearch();
  const q = els.searchInput.value;
  if (!sa || !q) {
    els.searchInfo.textContent = '';
    return;
  }
  try {
    if (dir < 0) sa.findPrevious(q, SEARCH_DECOR);
    else sa.findNext(q, SEARCH_DECOR);
  } catch (_) {
    // Fall back without decorations if the proposed API is unavailable.
    if (dir < 0) sa.findPrevious(q);
    else sa.findNext(q);
  }
}

els.searchInput.addEventListener('input', () => searchFind(1));
els.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    searchFind(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch();
  }
});
els.searchNext.addEventListener('click', () => searchFind(1));
els.searchPrev.addEventListener('click', () => searchFind(-1));
els.searchClose.addEventListener('click', closeSearch);

// ---------------------------------------------------------------------------
// Find in page for web tabs (Ctrl+F) - uses the <webview>'s native findInPage.
// ---------------------------------------------------------------------------
function activeWebRec() {
  const rec = activeTabId ? tabs.get(activeTabId) : null;
  return rec && rec.kind === 'web' && rec.wv ? rec : null;
}
function openWebFind() {
  const rec = activeWebRec();
  if (!rec) return false;
  // Anchor to the top-right of the actual page view (clears the web toolbar/tab bar).
  try {
    const r = rec.wv.getBoundingClientRect();
    els.webFind.style.top = r.top + 8 + 'px';
    els.webFind.style.right = window.innerWidth - r.right + 12 + 'px';
  } catch (_) {
    /* fall back to CSS defaults */
  }
  els.webFind.classList.remove('hidden');
  els.webFindInput.focus();
  els.webFindInput.select();
  if (els.webFindInput.value) webFindDo(1, true);
  return true;
}
function closeWebFind() {
  if (els.webFind.classList.contains('hidden')) return;
  els.webFind.classList.add('hidden');
  els.webFindInfo.textContent = '';
  const rec = activeWebRec();
  if (rec) {
    try {
      rec.wv.stopFindInPage('clearSelection');
    } catch (_) {
      /* webview not ready */
    }
  }
}
// dir: +1 forward / -1 backward. isNew=true starts a fresh search for the query.
function webFindDo(dir, isNew) {
  const rec = activeWebRec();
  const q = els.webFindInput.value;
  if (!rec) return;
  if (!q) {
    els.webFindInfo.textContent = '';
    try {
      rec.wv.stopFindInPage('clearSelection');
    } catch (_) {
      /* ignore */
    }
    return;
  }
  try {
    rec.wv.findInPage(q, { forward: dir >= 0, findNext: !isNew });
  } catch (_) {
    /* webview not ready */
  }
}
els.webFindInput.addEventListener('input', () => webFindDo(1, true));
els.webFindInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    webFindDo(e.shiftKey ? -1 : 1, false);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    const rec = activeWebRec();
    closeWebFind();
    if (rec && rec.wv) rec.wv.focus();
  }
});
els.webFindNext.addEventListener('click', () => webFindDo(1, false));
els.webFindPrev.addEventListener('click', () => webFindDo(-1, false));
els.webFindClose.addEventListener('click', closeWebFind);

// ---------------------------------------------------------------------------
// Mini-cockpit (PiP): push a small glance payload to the floating window.
// ---------------------------------------------------------------------------
let pipEnabled = true;
function nextTimedEvent() {
  if (!googleConnected) return null;
  const now = Date.now();
  const timed = upcomingEvents
    .filter((e) => !e.allDay && e.start)
    .map((e) => ({ summary: e.summary, t: Date.parse(e.start), meetLink: e.meetLink || '' }))
    .filter((e) => e.t > now - 15 * 60000)
    .sort((a, b) => a.t - b.t);
  const n = timed[0];
  return n ? { summary: n.summary, startMs: n.t, meetLink: n.meetLink } : null;
}
function sendPipUpdate() {
  if (!pipEnabled) return;
  let open = 0;
  let overdue = 0;
  try {
    const s = petStats();
    open = s.open;
    overdue = s.overdue;
  } catch (_) {
    /* notes not ready */
  }
  api.pipUpdate({
    meeting: nextTimedEvent(),
    tasksOpen: open,
    tasksOverdue: overdue,
  });
}
setInterval(sendPipUpdate, 1000);

// ---------------------------------------------------------------------------
// Slack tabs
// ---------------------------------------------------------------------------
let slackConnected = false;
let slackTeam = null;
let slackUserId = null;
let slackNotify = 'all'; // 'all' | 'mentions' | 'off'

// Show a desktop notification for an incoming Slack message when the app is unfocused.
function maybeNotifySlack(rec, m) {
  if (focusSession) return; // Focus Session = Do-Not-Disturb
  if (slackNotify === 'off') return;
  if (document.hasFocus()) return; // only when the app window isn't focused
  if (m.user && slackUserId && m.user === slackUserId) return; // skip our own messages
  if (slackNotify === 'mentions') {
    const t = m.text || '';
    const mentioned =
      (slackUserId && t.includes('<@' + slackUserId + '>')) || /<!(here|channel|everyone)>/.test(t);
    if (!mentioned) return;
  }
  try {
    const ch = rec.channel;
    const title = ch.is_im ? '@' + ch.name : ch.is_mpim ? ch.name : '#' + ch.name;
    const n = new Notification(title, {
      body: `${m.username || 'someone'}: ${stripForNotify(m.text || '')}`,
    });
    n.onclick = () => {
      api.focusWindow();
      activateTab(rec.id);
    };
  } catch (_) {
    /* notifications unavailable */
  }
}

// Flatten Slack mrkdwn/entities/emoji to plain text for a notification body.
function stripForNotify(t) {
  return t
    .replace(/<@[A-Z0-9]+>/g, '@user')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    .replace(/<(?:https?:\/\/[^|>]+)\|([^>]+)>/g, '$1')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/:([a-z0-9_+-]+):/gi, (m, n) => {
      const map = window.EMOJI_MAP || {};
      return map[n] || map[n.toLowerCase()] || m;
    })
    .replace(/[*_~`]/g, '')
    .slice(0, 160);
}

// Shared connect routine used by both the Slack dialog and the Settings dialog.
async function doSlackConnect(botToken, appToken) {
  const res = await api.slackConnect({ botToken, appToken });
  if (res.ok) {
    slackConnected = true;
    slackTeam = res.info && res.info.team ? res.info.team : 'Slack';
    slackUserId = res.info && res.info.user_id ? res.info.user_id : null;
    await api.slackSaveTokens({ botToken, appToken });
  } else {
    slackConnected = false;
    slackTeam = null;
    slackUserId = null;
  }
  updateSlackStatusUI();
  return res;
}

// Reflect the current Slack connection state in both dialogs.
function updateSlackStatusUI() {
  const text = slackConnected ? `Connected to ${slackTeam}` : 'Not connected';
  if (els.settingsSlackStatus) {
    els.settingsSlackStatus.textContent = text;
    els.settingsSlackStatus.classList.toggle('connected', slackConnected);
  }
  if (els.slackConnStatus) {
    els.slackConnStatus.textContent = slackConnected ? text : '';
  }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function nearBottom(el) {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
}

// Convert Slack mrkdwn to safe HTML: escapes first, then applies emoji
// shortcodes, *bold* _italic_ ~strike~ `code`, links, and mentions.
function formatSlackText(raw) {
  let s = escapeHtml(raw || '');
  // Slack entities arrive as <...>, now escaped to &lt;...&gt;.
  s = s.replace(
    /&lt;(https?:\/\/[^|&]+)\|([^&]+?)&gt;/g,
    (_m, url, label) => `<a class="slack-link" data-url="${url}">${label}</a>`
  );
  s = s.replace(
    /&lt;(https?:\/\/[^|&]+?)&gt;/g,
    (_m, url) => `<a class="slack-link" data-url="${url}">${url}</a>`
  );
  s = s.replace(
    /&lt;mailto:([^|&]+)\|([^&]+?)&gt;/g,
    (_m, addr, label) => `<a class="slack-link" data-url="mailto:${addr}">${label}</a>`
  );
  s = s.replace(/&lt;#[A-Z0-9]+\|([^&]+?)&gt;/g, '<span class="slack-mention">#$1</span>');
  s = s.replace(/&lt;@([A-Z0-9]+)&gt;/g, '<span class="slack-mention">@$1</span>');
  s = s.replace(/&lt;!(here|channel|everyone)&gt;/g, '<span class="slack-mention">@$1</span>');
  // code block then inline code
  s = s.replace(/```([\s\S]+?)```/g, (_m, code) => `<pre class="slack-code">${code}</pre>`);
  s = s.replace(/`([^`\n]+?)`/g, '<code class="slack-code-inline">$1</code>');
  // bold / italic / strike (bounded so a*b doesn't match mid-word)
  s = s.replace(/(^|[\s(>])\*([^*\n]+?)\*(?=[\s).,!?:]|$)/g, '$1<b>$2</b>');
  s = s.replace(/(^|[\s(>])_([^_\n]+?)_(?=[\s).,!?:]|$)/g, '$1<i>$2</i>');
  s = s.replace(/(^|[\s(>])~([^~\n]+?)~(?=[\s).,!?:]|$)/g, '$1<s>$2</s>');
  // emoji :shortcode:
  s = s.replace(/:([a-z0-9_+-]+):/gi, (m, name) => {
    const map = window.EMOJI_MAP || {};
    return map[name] || map[name.toLowerCase()] || m;
  });
  return s.replace(/\n/g, '<br>');
}

// Render a message's file attachments: image thumbnails (lazy-loaded) + file chips.
function buildFilesHtml(files) {
  if (!files || !files.length) return '';
  let html = '<div class="slack-files">';
  for (const f of files) {
    if (f.isImage && f.thumb) {
      html +=
        `<img class="slack-img loading" data-thumb="${escapeHtml(f.thumb)}" ` +
        `data-permalink="${escapeHtml(f.permalink)}" alt="${escapeHtml(f.name)}" title="${escapeHtml(f.name)}">`;
    } else {
      html += `<a class="slack-file slack-link" data-url="${escapeHtml(f.permalink)}">📎 ${escapeHtml(f.name)}</a>`;
    }
  }
  return html + '</div>';
}

// Fetch each image thumbnail (authenticated, as a data URL) and swap it in.
function loadRowImages(row) {
  row.querySelectorAll('img.slack-img.loading').forEach(async (img) => {
    const thumb = img.dataset.thumb;
    if (!thumb) {
      img.classList.remove('loading');
      return;
    }
    const res = await api.slackImage(thumb);
    img.classList.remove('loading');
    if (res && res.ok) {
      img.src = res.dataUrl;
    } else {
      img.classList.add('failed');
      img.alt = 'image unavailable';
    }
  });
}

// Slack links open in the default browser; clicking an image opens its permalink.
document.addEventListener('click', (e) => {
  if (!e.target.closest) return;
  const a = e.target.closest('.slack-link');
  if (a && a.dataset.url) {
    e.preventDefault();
    api.openExternal(a.dataset.url);
    return;
  }
  const img = e.target.closest('.slack-img');
  if (img && img.dataset.permalink) {
    e.preventDefault();
    api.openExternal(img.dataset.permalink);
  }
});

// --- presence (online/away dots) ---
const presenceCache = new Map(); // userId -> 'active' | 'away' | 'unknown'

function paintPresenceDots(userId, presence) {
  const cls =
    presence === 'active' ? 'online' : presence === 'away' ? 'away' : 'unknown';
  const title = presence === 'active' ? 'Active' : presence === 'away' ? 'Away' : '';
  document.querySelectorAll(`.slack-presence[data-user="${userId}"]`).forEach((el) => {
    el.className = 'slack-presence ' + cls;
    el.title = title;
  });
}

async function ensurePresence(userId) {
  if (!userId) return;
  if (presenceCache.has(userId)) {
    paintPresenceDots(userId, presenceCache.get(userId));
    return;
  }
  const res = await api.slackPresence(userId);
  const presence = res && res.ok ? res.presence : 'unknown';
  presenceCache.set(userId, presence);
  paintPresenceDots(userId, presence);
}

// Refresh presence for everyone we've seen, so dots stay current.
setInterval(() => {
  for (const userId of presenceCache.keys()) {
    api.slackPresence(userId).then((res) => {
      const presence = res && res.ok ? res.presence : 'unknown';
      presenceCache.set(userId, presence);
      paintPresenceDots(userId, presence);
    });
  }
}, 45000);

function buildMsgRow(m, system) {
  const row = document.createElement('div');
  if (system) {
    row.className = 'slack-msg slack-sys';
    row.textContent = m.text;
    return row;
  }
  row.className = 'slack-msg';
  const time = m.ts
    ? new Date(parseFloat(m.ts) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  row.innerHTML =
    `<span class="slack-presence unknown" data-user="${escapeHtml(m.user || '')}"></span>` +
    `<span class="slack-author">${escapeHtml(m.username || m.user || '?')}</span>` +
    `<span class="slack-time">${time}</span>` +
    `<div class="slack-text">${formatSlackText(m.text || '')}</div>` +
    buildFilesHtml(m.files);
  // Right-click a message to save it as a sticky note.
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const author = m.username || m.user || '?';
    captureToNote({ title: author + (time ? ' · ' + time : ''), text: m.text || '' });
  });
  return row;
}

// --- main channel view ---
function appendSlackMessage(rec, m, system) {
  if (m.ts) {
    if (rec.seen.has(m.ts)) return;
    rec.seen.add(m.ts);
  }
  const atBottom = nearBottom(rec.messagesEl);
  const row = buildMsgRow(m, system);
  rec.messagesEl.appendChild(row);
  if (!system && m.user) ensurePresence(m.user);
  if (!system) loadRowImages(row);
  if (!system && m.ts) {
    rec.msgRows.set(m.ts, row);
    if (m.reply_count > 0) {
      rec.replyCounts.set(m.ts, m.reply_count);
      updateReplyLink(rec, m.ts, m.reply_count);
    }
  }
  if (atBottom) rec.messagesEl.scrollTop = rec.messagesEl.scrollHeight;
}

// Add/update the "🧵 N replies" link under a parent message row.
function updateReplyLink(rec, parentTs, count) {
  const row = rec.msgRows.get(parentTs);
  if (!row) return;
  let link = row.querySelector('.slack-thread-link');
  if (!link) {
    link = document.createElement('button');
    link.className = 'slack-thread-link';
    link.addEventListener('click', () => openThread(rec, parentTs));
    row.appendChild(link);
  }
  link.textContent = `🧵 ${count} ${count === 1 ? 'reply' : 'replies'}`;
}

// --- thread view ---
function appendThreadMessage(rec, m, system) {
  if (m.ts) {
    if (rec.threadSeen.has(m.ts)) return;
    rec.threadSeen.add(m.ts);
  }
  const atBottom = nearBottom(rec.threadMessagesEl);
  const row = buildMsgRow(m, system);
  rec.threadMessagesEl.appendChild(row);
  if (!system && m.user) ensurePresence(m.user);
  if (!system) loadRowImages(row);
  if (atBottom) rec.threadMessagesEl.scrollTop = rec.threadMessagesEl.scrollHeight;
}

async function openThread(rec, parentTs) {
  rec.currentThreadTs = parentTs;
  rec.threadSeen = new Set();
  rec.threadMessagesEl.innerHTML = '';
  rec.threadEl.classList.remove('hidden');
  const res = await api.slackReplies(rec.channel.id, parentTs);
  if (res.ok) {
    for (const m of res.messages) appendThreadMessage(rec, m);
  } else {
    appendThreadMessage(rec, { text: `Could not load thread: ${res.error}` }, true);
  }
  rec.threadMessagesEl.scrollTop = rec.threadMessagesEl.scrollHeight;
  rec.threadInputEl.focus();
}

function closeThread(rec) {
  rec.threadEl.classList.add('hidden');
  rec.currentThreadTs = null;
}

function createSlackTab(channel) {
  const id = newTabId();
  // DMs use @name, group DMs a people glyph, channels #name.
  const label = channel.is_im ? '@' + channel.name : channel.is_mpim ? channel.name : '#' + channel.name;
  const { tabEl, paneEl } = createTabChrome(id, channel.name, 'slack');
  tabEl.querySelector('.kind-glyph').textContent = channel.is_im
    ? '@'
    : channel.is_mpim
    ? '👥'
    : '#';
  paneEl.classList.remove('term-pane');
  paneEl.classList.add('slack-pane');
  const ph = escapeHtml(label);
  paneEl.innerHTML =
    `<div class="slack-header">${ph}</div>` +
    '<div class="slack-body">' +
    '<div class="slack-col-main">' +
    '<div class="slack-messages"></div>' +
    `<form class="slack-form"><input class="slack-input" type="text" autocomplete="off" placeholder="Message ${ph}" /><button type="submit">Send</button></form>` +
    '</div>' +
    '<div class="slack-thread hidden">' +
    '<div class="slack-thread-header"><span>🧵 Thread</span><button class="slack-thread-close" title="Close thread">✕</button></div>' +
    '<div class="slack-thread-messages"></div>' +
    '<form class="slack-thread-form"><input class="slack-thread-input" type="text" autocomplete="off" placeholder="Reply…" /><button type="submit">Reply</button></form>' +
    '</div>' +
    '</div>';

  const rec = {
    id,
    kind: 'slack',
    channel,
    paneEl,
    tabEl,
    messagesEl: paneEl.querySelector('.slack-messages'),
    inputEl: paneEl.querySelector('.slack-input'),
    threadEl: paneEl.querySelector('.slack-thread'),
    threadMessagesEl: paneEl.querySelector('.slack-thread-messages'),
    threadInputEl: paneEl.querySelector('.slack-thread-input'),
    unreadEl: tabEl.querySelector('.unread'),
    seen: new Set(),
    threadSeen: new Set(),
    msgRows: new Map(),
    replyCounts: new Map(),
    currentThreadTs: null,
    unread: 0,
    profile: { name: label },
    status: 'connected',
  };
  tabs.set(id, rec);
  activateTab(id);
  bbTabOpen(rec);
  setTabStatus(id, 'connected', label);
  persistOpenSlackChannels();

  paneEl.querySelector('.slack-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = rec.inputEl.value.trim();
    if (!text) return;
    rec.inputEl.value = '';
    const res = await api.slackSend(channel.id, text);
    if (!res.ok) appendSlackMessage(rec, { text: `Failed to send: ${res.error}` }, true);
    else appendSlackMessage(rec, { username: 'you', text, ts: res.ts });
  });

  paneEl.querySelector('.slack-thread-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = rec.threadInputEl.value.trim();
    if (!text || !rec.currentThreadTs) return;
    rec.threadInputEl.value = '';
    const res = await api.slackSend(channel.id, text, rec.currentThreadTs);
    if (!res.ok) appendThreadMessage(rec, { text: `Failed to send: ${res.error}` }, true);
    else appendThreadMessage(rec, { username: 'you', text, ts: res.ts });
  });

  paneEl.querySelector('.slack-thread-close').addEventListener('click', () => closeThread(rec));

  (async () => {
    const res = await api.slackHistory(channel.id);
    if (res.ok) for (const m of res.messages) appendSlackMessage(rec, m);
    else appendSlackMessage(rec, { text: `Could not load history: ${res.error}` }, true);
    rec.messagesEl.scrollTop = rec.messagesEl.scrollHeight;
  })();

  return id;
}

// Persist the currently-open SSH tabs (profiles only, no secrets) for next launch.
function persistOpenSshTabs() {
  const list = [];
  for (const rec of tabs.values()) {
    if (rec.kind === 'ssh') {
      const p = rec.profile;
      list.push({
        name: p.name,
        host: p.host,
        port: p.port,
        username: p.username,
        authMethod: p.authMethod,
        keyPath: p.keyPath,
      });
    }
  }
  api.saveSettings({ openSshTabs: list });
  persistTabOrder();
}

// Watch terminal input for typed `ssh …` commands and remember them per tab.
// Toggle the per-terminal line-numbers mode and refit (the gutter narrows the pane).
function setLineNums(rec, on) {
  rec.lineNums = on;
  rec.paneEl.classList.toggle('lines-on', on);
  if (on && !rec.lineBase && rec.term) {
    const buf = rec.term.buffer.active;
    rec.lineBase = buf.baseY + buf.cursorY + 1; // number from the current bottom
  }
  try {
    rec.fitAddon.fit();
  } catch (_) {
    /* ignore */
  }
  renderGutter(rec);
}

// Paint the gutter: one number per visible row, counting from the line where the
// last command's output started (so each command's output reads 1, 2, 3, …).
function renderGutter(rec) {
  const el = rec.gutterEl;
  if (!el || !rec.term) return;
  if (!rec.lineNums) {
    el.innerHTML = '';
    return;
  }
  const rowsEl = rec.paneEl.querySelector('.xterm-rows');
  if (!rowsEl || !rowsEl.children.length) {
    el.innerHTML = '';
    return;
  }
  const rowH = rowsEl.children[0].getBoundingClientRect().height || 17;
  const buf = rec.term.buffer.active;
  const base = rec.lineBase || 0;
  let html = '';
  for (let r = 0; r < rec.term.rows; r++) {
    const abs = buf.viewportY + r;
    const n = base > 0 && abs >= base ? abs - base + 1 : '';
    html += `<div class="term-gutter-row">${n}</div>`;
  }
  el.style.setProperty('--row-h', rowH + 'px');
  el.innerHTML = html;
}

function captureSshCommand(rec, data) {
  for (const ch of data) {
    if (rec.escSkip) {
      if (/[A-Za-z~]/.test(ch)) rec.escSkip = false; // end of an escape sequence
      continue;
    }
    if (ch === '\x1b') {
      rec.escSkip = true; // skip arrow keys / CSI sequences
    } else if (ch === '\r' || ch === '\n') {
      const line = rec.lineBuffer.trim();
      rec.lineBuffer = '';
      if (line) {
        // Arm the command-done detector for any submitted command.
        rec.cmdRunning = true;
        rec.cmdStart = Date.now();
        rec.cmdName = line.length > 60 ? line.slice(0, 57) + '…' : line;
        rec.outTail = '';
        const cmdHost = (rec.profile && (rec.profile.host || rec.profile.name)) || '';
        logEvent('cmd', { title: line, host: cmdHost, ref: { type: 'tab', tabKey: tabKey(rec) } });
        focusTrackCommand(line, cmdHost);
        // Restart line numbering at the line where this command's output begins.
        if (rec.term) {
          const buf = rec.term.buffer.active;
          rec.lineBase = buf.baseY + buf.cursorY + 1;
          if (rec.lineNums) renderGutter(rec);
        }
      }
      if (autoHopCollect && /^ssh\s+\S/.test(line) && !/^ssh\s+(-V|--?help)\b/.test(line)) {
        const arr = sshHops[rec.serverKey] || (sshHops[rec.serverKey] = []);
        if (arr[arr.length - 1] !== line) {
          arr.push(line);
          if (arr.length > 10) arr.shift();
          persistSshHops();
        }
      }
    } else if (ch === '\x7f' || ch === '\b') {
      rec.lineBuffer = rec.lineBuffer.slice(0, -1);
    } else if (ch === '\x03' || ch === '\x15') {
      rec.lineBuffer = ''; // Ctrl-C / Ctrl-U clear the line
    } else if (ch >= ' ') {
      rec.lineBuffer += ch;
    }
  }
}

// Line-buffer a local shell's typed input so submitted commands land in the Black Box
// (and arm the command-done detector). Mirrors captureSshCommand, minus the SSH bits.
function captureLocalCommand(rec, data) {
  for (const ch of data) {
    if (rec.escSkip) {
      if (/[A-Za-z~]/.test(ch)) rec.escSkip = false;
      continue;
    }
    if (ch === '\x1b') {
      rec.escSkip = true;
    } else if (ch === '\r' || ch === '\n') {
      const line = (rec.lineBuffer || '').trim();
      rec.lineBuffer = '';
      if (line) {
        rec.cmdRunning = true;
        rec.cmdStart = Date.now();
        rec.cmdName = line.length > 60 ? line.slice(0, 57) + '…' : line;
        rec.outTail = '';
        logEvent('cmd', { title: line, host: 'local', ref: { type: 'tab', tabKey: tabKey(rec) } });
        focusTrackCommand(line, 'local');
      }
    } else if (ch === '\x7f' || ch === '\b') {
      rec.lineBuffer = (rec.lineBuffer || '').slice(0, -1);
    } else if (ch === '\x03' || ch === '\x15') {
      rec.lineBuffer = '';
    } else if (ch >= ' ') {
      rec.lineBuffer = (rec.lineBuffer || '') + ch;
    }
  }
}

// After a tab connects, replay that server's stored ssh hops into the shell.
function replayStartupCommands(rec) {
  if (!autoHopEnabled) return; // auto-hop is opt-in (Settings)
  const cmds = (rec.serverKey && sshHops[rec.serverKey]) || [];
  if (!cmds.length) return;
  let delay = 800;
  for (const cmd of cmds) {
    setTimeout(() => api.write(rec.id, cmd + '\r'), delay);
    delay += 1500;
  }
}

// Persist the currently-open Slack channels (in tab order) for next launch.
function persistOpenSlackChannels() {
  const list = [];
  for (const rec of tabs.values()) {
    if (rec.kind === 'slack') {
      list.push({
        id: rec.channel.id,
        name: rec.channel.name,
        is_im: !!rec.channel.is_im,
        is_mpim: !!rec.channel.is_mpim,
      });
    }
  }
  api.saveSettings({ openSlackChannels: list });
  persistTabOrder();
}

// Persist the currently-open web tabs (URLs) for next launch.
function persistOpenWebTabs() {
  const list = [];
  for (const rec of tabs.values()) {
    if (rec.kind === 'web' && rec.url) list.push(rec.url);
  }
  api.saveSettings({ openWebTabs: list });
  persistTabOrder();
}

// A stable identity for a tab, independent of its runtime id — used to remember
// which tab was active across relaunches (robust to tabs that fail to reopen).
function tabKey(rec) {
  if (!rec) return null;
  if (rec.kind === 'ssh') {
    const p = rec.profile || {};
    return `ssh:${p.name || ''}|${p.host || ''}|${p.port || ''}|${p.username || ''}`;
  }
  if (rec.kind === 'web') return 'web:' + (rec.url || '');
  if (rec.kind === 'local') return 'local:' + (rec.cwd || '') + '|' + ((rec.profile && rec.profile.name) || '');
  if (rec.kind === 'slack') return 'slack:' + ((rec.channel && rec.channel.id) || '');
  if (rec.kind === 'notes') return 'notes';
  if (rec.kind === 'deck') return 'deck';
  return rec.kind + ':' + rec.id;
}

// Remember which tab is currently focused so it can be re-selected next launch.
function persistActiveTab() {
  const rec = activeTabId ? tabs.get(activeTabId) : null;
  api.saveSettings({ activeTabKey: rec ? tabKey(rec) : null });
}

// Persist the full interleaved tab order (all kinds) so each tab reopens in place.
function persistTabOrder() {
  const order = [];
  for (const rec of tabs.values()) {
    let entry = null;
    if (rec.kind === 'ssh') {
      const p = rec.profile || {};
      entry = {
        kind: 'ssh',
        profile: {
          name: p.name,
          host: p.host,
          port: p.port,
          username: p.username,
          authMethod: p.authMethod,
          keyPath: p.keyPath,
        },
      };
    } else if (rec.kind === 'web') {
      if (rec.url) entry = { kind: 'web', url: rec.url };
    } else if (rec.kind === 'slack') {
      entry = {
        kind: 'slack',
        channel: {
          id: rec.channel.id,
          name: rec.channel.name,
          is_im: !!rec.channel.is_im,
          is_mpim: !!rec.channel.is_mpim,
        },
      };
    } else if (rec.kind === 'local') {
      entry = { kind: 'local', cwd: rec.cwd || '', title: (rec.profile && rec.profile.name) || 'Local' };
    } else if (rec.kind === 'notes') {
      entry = { kind: 'notes' };
    } else if (rec.kind === 'deck') {
      entry = { kind: 'deck' };
    }
    if (!entry) continue;
    if (rec.customTitle) entry.title = rec.customTitle; // remember a manual rename
    order.push(entry);
  }
  api.saveSettings({ tabOrder: order });
}

function markUnread(rec) {
  rec.unread = (rec.unread || 0) + 1;
  if (rec.unreadEl) {
    rec.unreadEl.textContent = rec.unread > 99 ? '99+' : String(rec.unread);
    rec.unreadEl.classList.add('show');
  }
}

function clearUnread(rec) {
  rec.unread = 0;
  if (rec.unreadEl) {
    rec.unreadEl.textContent = '';
    rec.unreadEl.classList.remove('show');
  }
}

// Route incoming Slack messages to the right tab / thread, and flag unread.
// ---- Slack updates board (latest messages across all channels) ----
let slackFeedOn = false; // right-sidebar Slack board visible?
let gmailPanelOn = true; // right-sidebar Inbox board visible?
const slackFeedData = []; // recent messages: {channel, user, text, ts}
const slackChannelNames = new Map(); // channel id -> channel meta (name, is_im, …)

function slackChannelLabel(id) {
  for (const rec of tabs.values()) {
    if (rec.kind === 'slack' && rec.channel.id === id) return channelDisplayName(rec.channel);
  }
  const c = slackChannelNames.get(id);
  return c ? channelDisplayName(c) : id;
}
function channelDisplayName(c) {
  if (c.is_im) return '@' + (c.name || 'dm');
  if (c.is_mpim) return c.name || 'group';
  return '#' + (c.name || c.id || '');
}
function fmtSlackTime(ts) {
  const d = new Date(parseFloat(ts) * 1000);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Pull channel names so the board can label each message with its source.
async function primeSlackChannelNames() {
  try {
    const res = await api.slackChannels();
    if (res && res.ok) for (const c of res.channels) slackChannelNames.set(c.id, c);
  } catch (_) {
    /* not connected yet */
  }
  if (slackFeedOn) renderSlackFeed();
}

function pushSlackFeed(m) {
  slackFeedData.push({
    channel: m.channel,
    user: m.username || 'someone',
    text: m.text || '',
    ts: m.ts,
  });
  if (slackFeedData.length > 200) slackFeedData.shift();
  if (slackFeedOn) renderSlackFeed();
}

function renderSlackFeed() {
  const host = els.slackFeedItems;
  if (!host) return;
  host.innerHTML = '';
  if (!slackFeedData.length) {
    const empty = document.createElement('div');
    empty.className = 'sf-empty';
    empty.textContent = 'No Slack messages yet. New messages from any channel appear here.';
    host.appendChild(empty);
    return;
  }
  for (let i = slackFeedData.length - 1; i >= 0; i--) {
    const m = slackFeedData[i];
    const item = document.createElement('div');
    item.className = 'sf-item';
    const top = document.createElement('div');
    top.className = 'sf-top';
    const chan = document.createElement('span');
    chan.className = 'sf-chan';
    chan.textContent = slackChannelLabel(m.channel);
    chan.title = 'Open this channel';
    const user = document.createElement('span');
    user.className = 'sf-user';
    user.textContent = m.user;
    const time = document.createElement('span');
    time.className = 'sf-time';
    time.textContent = fmtSlackTime(m.ts);
    top.append(chan, user, time);
    const text = document.createElement('div');
    text.className = 'sf-text';
    text.innerHTML = formatSlackText(m.text);
    text.dataset.full = m.text; // raw text for the "cut off" tooltip
    item.append(top, text);
    item.addEventListener('click', () => openSlackChannelById(m.channel));
    host.appendChild(item);
  }
  // After layout, add a tooltip with the full message only where it's clipped.
  requestAnimationFrame(() => {
    for (const t of host.querySelectorAll('.sf-text')) {
      if (t.scrollHeight > t.clientHeight + 1) t.title = t.dataset.full || t.textContent;
      else t.removeAttribute('title');
    }
  });
}

function openSlackChannelById(id) {
  for (const rec of tabs.values()) {
    if (rec.kind === 'slack' && rec.channel.id === id) {
      activateTab(rec.id);
      return;
    }
  }
  const c = slackChannelNames.get(id);
  if (c) createSlackTab({ id: c.id, name: c.name, is_im: !!c.is_im, is_mpim: !!c.is_mpim });
}

// Show the right sidebar when any board is on (and, for Gmail, connected).
function updateRightSidebar() {
  const gmailShow = gmailPanelOn && googleConnected;
  els.gmailPanel.classList.toggle('hidden', !gmailShow);
  els.slackFeed.classList.toggle('hidden', !slackFeedOn);
  els.whatsappFeed.classList.toggle('hidden', !whatsappFeedOn);
  const anyOn = gmailShow || slackFeedOn || whatsappFeedOn;
  els.rightSidebar.classList.toggle('hidden', !anyOn);
  els.sidebarDivider.classList.toggle('hidden', !anyOn); // divider only when the sidebar shows
  layoutRightSidebar();
}

// Apply per-board heights (drag the horizontal dividers) + show a divider only
// under a visible board that isn't the last one.
let boardHeights = {}; // { slack, whatsapp } px
function layoutRightSidebar() {
  const gmailShow = gmailPanelOn && googleConnected;
  const vis = [];
  if (slackFeedOn) vis.push('slack');
  if (whatsappFeedOn) vis.push('whatsapp');
  if (gmailShow) vis.push('gmail');
  const last = vis[vis.length - 1];
  const setFlex = (key, el, on) => {
    if (!on) return;
    el.style.flex = key !== last && boardHeights[key] ? `0 0 ${boardHeights[key]}px` : '1 1 0';
  };
  setFlex('slack', els.slackFeed, slackFeedOn);
  setFlex('whatsapp', els.whatsappFeed, whatsappFeedOn);
  setFlex('gmail', els.gmailPanel, gmailShow);
  document.querySelectorAll('.board-divider').forEach((d) => {
    const key = d.dataset.above;
    const on = (key === 'slack' && slackFeedOn) || (key === 'whatsapp' && whatsappFeedOn);
    d.classList.toggle('hidden', !(on && last !== key));
  });
}

// Apply / persist the right-sidebar width (drag the divider).
let sidebarWidth = 300;
function applySidebarWidth(w) {
  sidebarWidth = Math.round(w);
  els.rightSidebar.style.flex = '0 0 ' + sidebarWidth + 'px';
  els.rightSidebar.style.width = sidebarWidth + 'px';
}
{
  const divider = els.sidebarDivider;
  if (divider) {
    divider.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      divider.classList.add('dragging');
      try {
        divider.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
      const row = document.getElementById('main-row').getBoundingClientRect();
      const onMove = (ev) => {
        let w = row.right - ev.clientX; // sidebar hugs the right edge
        w = Math.max(200, Math.min(row.width - 260, w)); // leave room for the terminals
        applySidebarWidth(w);
        // #terminals shrinks → its ResizeObserver refits the active terminal automatically.
      };
      const onUp = () => {
        divider.classList.remove('dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        api.saveSettings({ sidebarWidth });
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }
}

// Horizontal dividers: drag to resize the board above; persist its height.
document.querySelectorAll('.board-divider').forEach((divider) => {
  divider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const key = divider.dataset.above;
    const el = key === 'slack' ? els.slackFeed : els.whatsappFeed;
    if (!el) return;
    divider.classList.add('dragging');
    try {
      divider.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    const startY = e.clientY;
    const startH = el.getBoundingClientRect().height;
    const sidebarH = els.rightSidebar.getBoundingClientRect().height;
    const onMove = (ev) => {
      const h = Math.max(70, Math.min(sidebarH - 100, startH + (ev.clientY - startY)));
      el.style.flex = `0 0 ${Math.round(h)}px`;
    };
    const onUp = () => {
      divider.classList.remove('dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      boardHeights[key] = Math.round(el.getBoundingClientRect().height);
      api.saveSettings({ boardHeights });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
});
function updateBoardToggleLabels() {
  const sf = document.getElementById('toggle-slack-feed');
  const wa = document.getElementById('toggle-whatsapp-feed');
  const gm = document.getElementById('toggle-gmail');
  if (sf) sf.textContent = (slackFeedOn ? '✓ ' : '   ') + '💬 Slack board';
  if (wa) wa.textContent = (whatsappFeedOn ? '✓ ' : '   ') + '🟢 WhatsApp board';
  if (gm) gm.textContent = (gmailPanelOn ? '✓ ' : '   ') + '📧 Inbox board';
}
function setSlackFeed(on) {
  slackFeedOn = on;
  api.saveSettings({ slackFeedOn });
  if (on) {
    primeSlackChannelNames();
    renderSlackFeed();
  }
  updateRightSidebar();
  updateBoardToggleLabels();
}
function setGmailPanel(on) {
  gmailPanelOn = on;
  api.saveSettings({ gmailPanelOn });
  updateRightSidebar();
  updateBoardToggleLabels();
}

els.slackFeed.querySelector('#slack-feed-hide').addEventListener('click', () => setSlackFeed(false));
els.slackFeed.querySelector('#slack-feed-clear').addEventListener('click', () => {
  slackFeedData.length = 0;
  renderSlackFeed();
});
document.getElementById('gmail-hide').addEventListener('click', () => setGmailPanel(false));
document.getElementById('toggle-slack-feed').addEventListener('click', () => setSlackFeed(!slackFeedOn));
document.getElementById('toggle-gmail').addEventListener('click', () => setGmailPanel(!gmailPanelOn));

// ---- WhatsApp updates board (latest messages across your chats) ----
let whatsappFeedOn = false;
let whatsappConnected = false;
let whatsappStarted = false; // have we asked main to open the socket this session?
const whatsappFeedData = []; // {chat, chatName, sender, text, ts, fromMe}

function pushWhatsappFeed(m) {
  whatsappFeedData.push({
    chat: m.chat,
    chatName: m.chatName || m.chat,
    sender: m.sender || 'someone',
    text: m.text || '',
    ts: m.ts,
    fromMe: !!m.fromMe,
  });
  if (whatsappFeedData.length > 200) whatsappFeedData.shift();
  logEvent('whatsapp', {
    title: (m.chatName || m.chat || 'chat') + ' · ' + (m.sender || 'someone'),
    detail: m.text || '',
  });
  if (whatsappFeedOn) renderWhatsappFeed();
}
function renderWhatsappFeed() {
  const host = els.whatsappFeedItems;
  if (!host) return;
  host.innerHTML = '';
  if (!whatsappFeedData.length) {
    const empty = document.createElement('div');
    empty.className = 'sf-empty';
    empty.textContent = whatsappConnected
      ? 'No WhatsApp messages yet. New chats appear here.'
      : 'Not linked. Open ⚙ Settings → WhatsApp and scan the QR code.';
    host.appendChild(empty);
    return;
  }
  for (let i = whatsappFeedData.length - 1; i >= 0; i--) {
    const m = whatsappFeedData[i];
    const item = document.createElement('div');
    item.className = 'sf-item';
    const top = document.createElement('div');
    top.className = 'sf-top';
    const chan = document.createElement('span');
    chan.className = 'sf-chan';
    chan.textContent = m.chatName;
    const user = document.createElement('span');
    user.className = 'sf-user';
    user.textContent = m.sender;
    const time = document.createElement('span');
    time.className = 'sf-time';
    time.textContent = fmtSlackTime(m.ts); // ts is unix seconds, same formatter
    top.append(chan, user, time);
    const text = document.createElement('div');
    text.className = 'sf-text';
    text.textContent = m.text;
    text.dataset.full = m.text;
    item.append(top, text);
    host.appendChild(item);
  }
  requestAnimationFrame(() => {
    for (const t of host.querySelectorAll('.sf-text')) {
      if (t.scrollHeight > t.clientHeight + 1) t.title = t.dataset.full || t.textContent;
      else t.removeAttribute('title');
    }
  });
}
// Ask main to open the WhatsApp socket (reuses saved login; emits a QR if unpaired).
async function ensureWhatsappStarted() {
  if (whatsappStarted) return;
  whatsappStarted = true;
  try {
    await api.whatsappConnect();
  } catch (_) {
    whatsappStarted = false;
  }
}
function setWhatsappFeed(on) {
  whatsappFeedOn = on;
  api.saveSettings({ whatsappFeedOn });
  if (on) {
    ensureWhatsappStarted();
    renderWhatsappFeed();
  }
  updateRightSidebar();
  updateBoardToggleLabels();
}

els.whatsappFeed.querySelector('#whatsapp-feed-hide').addEventListener('click', () => setWhatsappFeed(false));
els.whatsappFeed.querySelector('#whatsapp-feed-clear').addEventListener('click', () => {
  whatsappFeedData.length = 0;
  renderWhatsappFeed();
});
document.getElementById('toggle-whatsapp-feed').addEventListener('click', () => setWhatsappFeed(!whatsappFeedOn));

api.onWhatsappMessage((m) => pushWhatsappFeed(m));
api.onWhatsappStatus((s) => {
  whatsappConnected = s && s.state === 'connected';
  if (whatsappConnected && els.waQrWrap) els.waQrWrap.classList.add('hidden');
  updateWaSettingsStatus(s);
  if (whatsappFeedOn) renderWhatsappFeed();
});
api.onWhatsappQr((d) => {
  if (!d || !d.dataUrl) return;
  if (els.waQr) els.waQr.src = d.dataUrl;
  if (els.waQrWrap) els.waQrWrap.classList.remove('hidden');
  updateWaSettingsStatus({ state: 'qr' });
});

function updateWaSettingsStatus(s) {
  if (!els.settingsWaStatus) return;
  const state = s && s.state;
  let text = 'Not connected';
  if (state === 'connected') {
    const num = s.me && s.me.id ? String(s.me.id).split(':')[0].split('@')[0] : '';
    text = 'Connected' + (num ? ' — ' + num : '');
  } else if (state === 'qr') text = 'Scan the QR code to link…';
  else if (state === 'logged_out') text = 'Logged out';
  else if (state === 'disconnected') text = 'Disconnected (reconnecting…)';
  els.settingsWaStatus.textContent = text;
  els.settingsWaStatus.classList.toggle('connected', state === 'connected');
}

if (els.setWaConnect) {
  els.setWaConnect.addEventListener('click', async () => {
    els.setWaConnect.disabled = true;
    els.settingsWaStatus.textContent = 'Connecting…';
    showBusy('🟢 Connecting to WhatsApp…');
    try {
      await api.whatsappConnect();
      whatsappStarted = true;
    } catch (_) {
      /* status arrives via events */
    }
    els.setWaConnect.disabled = false;
    hideBusy();
  });
}
if (els.setWaLogout) {
  els.setWaLogout.addEventListener('click', async () => {
    await api.whatsappLogout();
    whatsappConnected = false;
    whatsappStarted = false;
    if (els.waQrWrap) els.waQrWrap.classList.add('hidden');
    updateWaSettingsStatus({ state: 'logged_out' });
    renderWhatsappFeed();
  });
}

api.onSlackMessage((m) => {
  pushSlackFeed(m);
  logEvent('slack', {
    title: slackChannelLabel(m.channel) + ' · ' + (m.username || 'someone'),
    detail: m.text || '',
    ref: { type: 'slack', channelId: m.channel },
  });
  let notified = false;
  for (const rec of tabs.values()) {
    if (rec.kind !== 'slack' || rec.channel.id !== m.channel) continue;
    const isReply = m.thread_ts && m.thread_ts !== m.ts;
    if (isReply) {
      const count = (rec.replyCounts.get(m.thread_ts) || 0) + 1;
      rec.replyCounts.set(m.thread_ts, count);
      updateReplyLink(rec, m.thread_ts, count);
      if (rec.currentThreadTs === m.thread_ts) appendThreadMessage(rec, m);
    } else {
      appendSlackMessage(rec, m);
    }
    if (rec.id !== activeTabId) markUnread(rec);
    if (!notified) {
      maybeNotifySlack(rec, m);
      notified = true;
    }
  }
});

// ---- Slack dialog ----
async function openSlackDialog() {
  els.slackError.textContent = '';
  els.slackOverlay.classList.remove('hidden');
  if (slackConnected) {
    els.slackConnStatus.textContent = `Connected to ${slackTeam || 'Slack'}`;
    await loadSlackChannels();
  } else {
    els.slackConnStatus.textContent = 'Not connected — click “Open Settings…” to add your Slack tokens.';
    els.slackChannel.innerHTML = '';
    els.slackChannel.disabled = true;
    els.slackOpenBtn.disabled = true;
  }
}

function closeSlackDialog() {
  els.slackOverlay.classList.add('hidden');
}

async function loadSlackChannels() {
  const res = await api.slackChannels();
  if (!res.ok) {
    els.slackError.textContent = res.error;
    return;
  }
  els.slackChannel.innerHTML = '';
  for (const c of res.channels) {
    const opt = document.createElement('option');
    opt.value = JSON.stringify({
      id: c.id,
      name: c.name,
      is_im: !!c.is_im,
      is_mpim: !!c.is_mpim,
    });
    if (c.is_im) opt.textContent = '💬 @' + c.name;
    else if (c.is_mpim) opt.textContent = '👥 ' + c.name;
    else opt.textContent = (c.is_private ? '🔒 ' : '# ') + c.name + (c.is_member ? '' : '  (not a member)');
    els.slackChannel.appendChild(opt);
  }
  els.slackChannel.disabled = false;
  els.slackOpenBtn.disabled = res.channels.length === 0;
}

els.slackSettingsLink.addEventListener('click', () => {
  closeSlackDialog();
  openSettings();
});

els.slackOpenBtn.addEventListener('click', () => {
  if (!els.slackChannel.value) return;
  let channel;
  try {
    channel = JSON.parse(els.slackChannel.value);
  } catch (_) {
    return;
  }
  closeSlackDialog();
  createSlackTab(channel);
});

els.slackCancelBtn.addEventListener('click', closeSlackDialog);
els.slackBtn.addEventListener('click', openSlackDialog);
els.slackOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSlackDialog();
});

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------
async function openSettings() {
  els.settingsError.textContent = '';
  els.settingsOverlay.classList.remove('hidden');
  const t = await api.slackLoadTokens();
  if (t) {
    els.setSlackBot.value = t.botToken || '';
    els.setSlackApp.value = t.appToken || '';
  }
  els.setSlackConnect.textContent = slackConnected ? 'Reconnect' : 'Connect';
  els.setSlackNotify.value = slackNotify;
  updateSlackStatusUI();
  els.settingsGoogleError.textContent = '';
  const g = await api.googleLoadConfig();
  if (g) {
    els.setGoogleId.value = g.clientId || '';
    els.setGoogleSecret.value = g.clientSecret || '';
  }
  updateGoogleStatusUI(googleEmail);
  els.setClaudeWatch.checked = claudeWatch;
  els.setMeetingChime.checked = meetingChime;
  els.setCmdDone.checked = cmdDoneNotify;
  els.setPip.checked = pipEnabled;
  els.setBbOn.checked = blackboxOn;
  els.setBbText.checked = blackboxLogText;
  els.setBbDays.value = blackboxDays;
  refreshBbStats();
  els.setReminderOn.checked = reminderEnabled;
  els.setReminderText.value = reminderText;
  els.setReminderMin.value = reminderMinMin;
  els.setReminderMax.value = reminderMaxMin;
  els.setAutoHop.checked = autoHopEnabled;
  els.setAutoProject.checked = autoProjectSwitch;
  els.setAutoHopCollect.checked = autoHopCollect;
  if (els.setSshProtocol) els.setSshProtocol.checked = sshProtocolHandler;
  if (els.setSshJumpHost) els.setSshJumpHost.value = sshJumpHost;
  populateJumpHostSelect();
  api.whatsappStatus().then((s) => {
    if (s && s.ok) {
      whatsappConnected = !!s.connected;
      updateWaSettingsStatus({ state: s.connected ? 'connected' : 'disconnected', me: s.me });
    }
  });
  els.setQuickCmds.value = quickCommands.join('\n');
  els.setDebugPort.value = remoteDebugPort || '';
  els.debugPortMsg.textContent = '';
  els.webExtMsg.textContent = '';
  refreshWebExtList();
  renderSshHops();
}

async function refreshWebExtList() {
  try {
    const res = await api.webListExtensions();
    if (res && res.ok) {
      els.webExtList.textContent = res.extensions.length
        ? 'Loaded: ' + res.extensions.map((e) => `${e.name} ${e.version}`).join(', ')
        : 'No extensions loaded.';
    }
  } catch (_) {
    /* ignore */
  }
}

els.webExtAdd.addEventListener('click', async () => {
  els.webExtMsg.textContent = 'Loading…';
  const res = await api.webAddExtension();
  if (res && res.ok) {
    els.webExtMsg.textContent = `Loaded "${res.name}". Reloading web tabs…`;
    refreshWebExtList();
    for (const r of tabs.values()) {
      if (r.kind === 'web' && r.wv) {
        try {
          r.wv.reload();
        } catch (_) {
          /* not ready */
        }
      }
    }
  } else if (res && res.canceled) {
    els.webExtMsg.textContent = '';
  } else {
    els.webExtMsg.textContent = 'Failed: ' + ((res && res.error) || 'error');
  }
});

els.webExtClear.addEventListener('click', async () => {
  await api.webClearExtensions();
  els.webExtMsg.textContent = 'Cleared — restart to fully unload.';
  refreshWebExtList();
});

els.debugPortSave.addEventListener('click', () => {
  const v = parseInt(els.setDebugPort.value, 10);
  const port = v >= 1024 && v <= 65535 ? v : 0;
  remoteDebugPort = port;
  api.saveSettings({ remoteDebugPort: port });
  els.debugPortMsg.textContent = port
    ? `Saved. Restart, then CDP at http://localhost:${port}`
    : 'Disabled. Restart to apply.';
});

els.quickCmdsSave.addEventListener('click', () => {
  quickCommands = els.setQuickCmds.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  api.saveSettings({ quickCommands });
  els.quickCmdsMsg.textContent = 'Saved.';
});

els.setClaudeWatch.addEventListener('change', () => {
  claudeWatch = els.setClaudeWatch.checked;
  api.saveSettings({ claudeWatch });
});

els.setMeetingChime.addEventListener('change', () => {
  meetingChime = els.setMeetingChime.checked;
  api.saveSettings({ meetingChime });
  if (meetingChime) playMeetingChime(); // preview when enabling
});

els.setCmdDone.addEventListener('change', () => {
  cmdDoneNotify = els.setCmdDone.checked;
  api.saveSettings({ cmdDoneNotify });
  if (cmdDoneNotify) doneChime(); // preview when enabling
});

els.setPip.addEventListener('change', () => {
  pipEnabled = els.setPip.checked;
  api.pipSetEnabled(pipEnabled); // creates/destroys the floating window + persists
  if (pipEnabled) sendPipUpdate();
});

// Configurable reminder overlay.
function applyReminderSettings(reschedule) {
  reminderEnabled = els.setReminderOn.checked;
  reminderText = els.setReminderText.value.trim() || 'Zu….';
  const lo = parseInt(els.setReminderMin.value, 10);
  const hi = parseInt(els.setReminderMax.value, 10);
  if (Number.isFinite(lo) && lo > 0) reminderMinMin = lo;
  if (Number.isFinite(hi) && hi > 0) reminderMaxMin = hi;
  api.saveSettings({
    reminderEnabled,
    reminderText,
    reminderMinMin,
    reminderMaxMin,
  });
  if (reschedule) scheduleReminder(); // re-arm with the new interval / on-off state
}
els.setReminderOn.addEventListener('change', () => applyReminderSettings(true));
els.setReminderText.addEventListener('change', () => applyReminderSettings(false));
els.setReminderMin.addEventListener('change', () => applyReminderSettings(true));
els.setReminderMax.addEventListener('change', () => applyReminderSettings(true));

els.setAutoHop.addEventListener('change', () => {
  autoHopEnabled = els.setAutoHop.checked;
  api.saveSettings({ autoHopEnabled });
});

els.setAutoProject.addEventListener('change', () => {
  autoProjectSwitch = els.setAutoProject.checked;
  api.saveSettings({ autoProjectSwitch });
  if (autoProjectSwitch && activeTabId) maybeAutoSwitchProject(tabs.get(activeTabId)); // apply right away
});

els.setAutoHopCollect.addEventListener('change', () => {
  autoHopCollect = els.setAutoHopCollect.checked;
  api.saveSettings({ autoHopCollect });
});

if (els.setSshProtocol) {
  els.setSshProtocol.addEventListener('change', async () => {
    sshProtocolHandler = els.setSshProtocol.checked;
    api.saveSettings({ sshProtocolHandler });
    let isDefault = sshProtocolHandler;
    try {
      if (api.setSshProtocol) isDefault = await api.setSshProtocol(sshProtocolHandler);
    } catch (_) {
      /* ignore */
    }
    if (els.sshProtocolMsg) {
      els.sshProtocolMsg.textContent = sshProtocolHandler
        ? (isDefault ? 'Cockpit now opens ssh:// links.' : 'Requested - the OS may ask you to confirm.')
        : 'ssh:// links no longer open in Cockpit.';
    }
  });
}

// Build a "[user@]host [-p port]" jump string from a saved session profile.
function sshTargetFromSession(s) {
  if (!s || !s.host) return '';
  return (
    (s.username ? s.username + '@' : '') +
    s.host +
    (s.port && Number(s.port) !== 22 ? ' -p ' + s.port : '')
  );
}

// Fill the "use a saved session as jump host" dropdown from savedSessions, reflecting
// the current value (selects the matching session, else falls back to "custom").
function populateJumpHostSelect() {
  const sel = els.setSshJumpHostSaved;
  if (!sel) return;
  const cur = (sshJumpHost || '').trim();
  sel.innerHTML = '<option value="">- custom / none -</option>';
  for (const s of savedSessions || []) {
    const val = sshTargetFromSession(s);
    if (!val) continue;
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = `${s.name}  (${val})`;
    sel.appendChild(opt);
  }
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
}

if (els.setSshJumpHost) {
  els.setSshJumpHost.addEventListener('change', () => {
    sshJumpHost = els.setSshJumpHost.value.trim();
    api.saveSettings({ sshJumpHost });
    // Keep the dropdown in sync (a hand-typed value that matches a session selects it).
    if (els.setSshJumpHostSaved) {
      const sel = els.setSshJumpHostSaved;
      sel.value = [...sel.options].some((o) => o.value === sshJumpHost) ? sshJumpHost : '';
    }
  });
}

if (els.setSshJumpHostSaved) {
  els.setSshJumpHostSaved.addEventListener('change', () => {
    const v = els.setSshJumpHostSaved.value;
    if (!v) return; // "custom / none" leaves the text field as-is
    if (els.setSshJumpHost) els.setSshJumpHost.value = v;
    sshJumpHost = v;
    api.saveSettings({ sshJumpHost });
  });
}

// List SSH servers (saved sessions + open tabs + existing hops) with editable hop boxes.
async function renderSshHops() {
  els.sshHopsMsg.textContent = '';
  els.sshHopsList.innerHTML = '';
  const servers = new Map(); // serverKey -> label
  const sessions = await api.loadSessions();
  for (const s of sessions || []) {
    servers.set(sshServerKey(s), `${s.name} (${s.username}@${s.host})`);
  }
  for (const r of tabs.values()) {
    if (r.kind === 'ssh' && !servers.has(r.serverKey)) {
      servers.set(r.serverKey, `${r.profile.name} (${r.profile.username}@${r.profile.host})`);
    }
  }
  for (const k of Object.keys(sshHops)) if (!servers.has(k)) servers.set(k, k);

  if (!servers.size) {
    els.sshHopsList.textContent = 'No SSH servers yet.';
    return;
  }
  for (const [key, label] of servers) {
    const row = document.createElement('div');
    row.className = 'ssh-hop-row';
    const l = document.createElement('label');
    l.textContent = label;
    const ta = document.createElement('textarea');
    ta.dataset.key = key;
    const cmds = sshHops[key] || [];
    ta.rows = Math.max(2, cmds.length + 1);
    ta.value = cmds.join('\n');
    ta.placeholder = '(no auto-hops) — e.g.\nssh host1';
    row.appendChild(l);
    row.appendChild(ta);
    els.sshHopsList.appendChild(row);
  }
}

els.sshHopsSave.addEventListener('click', () => {
  els.sshHopsList.querySelectorAll('textarea').forEach((ta) => {
    const cmds = ta.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (cmds.length) sshHops[ta.dataset.key] = cmds;
    else delete sshHops[ta.dataset.key];
  });
  persistSshHops();
  els.sshHopsMsg.textContent = 'Saved.';
});

function closeSettings() {
  els.settingsOverlay.classList.add('hidden');
}

els.setSlackConnect.addEventListener('click', async () => {
  els.settingsError.textContent = '';
  const botToken = els.setSlackBot.value.trim();
  const appToken = els.setSlackApp.value.trim();
  if (!botToken || !appToken) {
    els.settingsError.textContent = 'Both tokens are required.';
    return;
  }
  els.settingsSlackStatus.textContent = 'Connecting…';
  const res = await doSlackConnect(botToken, appToken);
  if (!res.ok) {
    els.settingsError.textContent = res.error;
    return;
  }
  els.setSlackConnect.textContent = 'Reconnect';
  // Reopen any saved channels that aren't already open (recovery after reconnect).
  const s = await api.loadSettings();
  const saved = (s && s.openSlackChannels) || [];
  const openIds = new Set(
    Array.from(tabs.values())
      .filter((r) => r.kind === 'slack')
      .map((r) => r.channel.id)
  );
  for (const ch of saved) if (!openIds.has(ch.id)) createSlackTab(ch);
});

els.setSlackForget.addEventListener('click', async () => {
  await api.slackForgetTokens();
  slackConnected = false;
  slackTeam = null;
  els.setSlackBot.value = '';
  els.setSlackApp.value = '';
  els.setSlackConnect.textContent = 'Connect';
  els.settingsError.textContent = '';
  updateSlackStatusUI();
});

els.setSlackNotify.addEventListener('change', () => {
  slackNotify = els.setSlackNotify.value;
  api.saveSettings({ slackNotify });
});

els.settingsCloseBtn.addEventListener('click', closeSettings);
els.settingsBtn.addEventListener('click', openSettings);
els.settingsOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSettings();
});
// Click the backdrop (outside the dialog) to close. Use mousedown so a drag that
// starts inside the dialog and releases on the backdrop doesn't close it.
els.settingsOverlay.addEventListener('mousedown', (e) => {
  if (e.target === els.settingsOverlay) closeSettings();
});

// ---------------------------------------------------------------------------
// Web page tabs (embedded <webview>)
// ---------------------------------------------------------------------------
function isBookmarked(url) {
  return webBookmarks.some((b) => b.url === url);
}

function renderBookmarksInto(select) {
  select.innerHTML = '<option value="">★ Bookmarks…</option>';
  for (const b of webBookmarks) {
    const o = document.createElement('option');
    o.value = b.url;
    o.textContent = b.name;
    select.appendChild(o);
  }
}

function renderAllBookmarks() {
  document.querySelectorAll('.web-bookmarks').forEach(renderBookmarksInto);
}

function updateStar(rec) {
  if (!rec.starBtn) return;
  const on = isBookmarked(rec.url);
  rec.starBtn.textContent = on ? '★' : '☆';
  rec.starBtn.classList.toggle('on', on);
  rec.starBtn.title = on ? 'Remove bookmark' : 'Bookmark this page';
}

function updateAllStars() {
  for (const rec of tabs.values()) if (rec.kind === 'web') updateStar(rec);
}

function addBookmark(name, url) {
  if (!url || isBookmarked(url)) return;
  webBookmarks.push({ name: name || url, url });
  api.saveSettings({ webBookmarks });
  renderAllBookmarks();
  updateAllStars();
}

function removeBookmark(url) {
  webBookmarks = webBookmarks.filter((b) => b.url !== url);
  api.saveSettings({ webBookmarks });
  renderAllBookmarks();
  updateAllStars();
}

function createWebTab(savedUrl) {
  const id = newTabId();
  let host = 'New tab';
  try {
    if (savedUrl) host = new URL(savedUrl).host || savedUrl;
  } catch (_) {
    host = savedUrl || 'New tab';
  }
  const { tabEl, paneEl } = createTabChrome(id, host, 'web');
  paneEl.classList.remove('term-pane');
  paneEl.classList.add('web-pane');
  paneEl.innerHTML =
    '<div class="web-bar">' +
    '<button class="web-back" title="Back">◀</button>' +
    '<button class="web-fwd" title="Forward">▶</button>' +
    '<button class="web-reload" title="Reload">⟳</button>' +
    '<input class="web-url" type="text" spellcheck="false" placeholder="Enter a URL and press Enter…" />' +
    '<button class="web-go">Go</button>' +
    '<select class="web-bookmarks" title="Bookmarks"></select>' +
    '<button class="web-star" title="Bookmark this page">☆</button>' +
    '<button class="web-devtools" title="DevTools (F12)">🔧</button>' +
    '<button class="web-ext" title="Open in external browser">↗</button>' +
    '</div>' +
    `<webview class="web-view" allowpopups partition="persist:web" preload="${api.webviewPreload}"></webview>`;

  const wv = paneEl.querySelector('webview');
  const urlInput = paneEl.querySelector('.web-url');
  const bmSelect = paneEl.querySelector('.web-bookmarks');
  const starBtn = paneEl.querySelector('.web-star');

  const rec = {
    id,
    kind: 'web',
    paneEl,
    tabEl,
    wv,
    urlInput,
    starBtn,
    bmSelect,
    url: savedUrl || '',
    profile: { name: host },
    status: 'connected',
  };
  tabs.set(id, rec);
  activateTab(id);
  bbTabOpen(rec);
  setTabStatus(id, 'connected', savedUrl || 'New tab');

  const safe = (fn) => {
    try {
      fn();
    } catch (_) {
      /* webview not ready */
    }
  };

  function navigate(input) {
    let u = (input || '').trim();
    if (!u) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
    urlInput.value = u;
    rec.url = u;
    wv.src = u;
    updateStar(rec);
    persistOpenWebTabs();
  }

  renderBookmarksInto(bmSelect);
  updateStar(rec);

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') navigate(urlInput.value);
  });
  paneEl.querySelector('.web-go').addEventListener('click', () => navigate(urlInput.value));
  paneEl.querySelector('.web-back').addEventListener('click', () => safe(() => wv.canGoBack() && wv.goBack()));
  paneEl.querySelector('.web-fwd').addEventListener('click', () => safe(() => wv.canGoForward() && wv.goForward()));
  const reloadBtn = paneEl.querySelector('.web-reload');
  reloadBtn.addEventListener('click', () =>
    // While a page is loading this button stops it; otherwise it reloads.
    safe(() => (rec.loading ? wv.stop() : wv.reload()))
  );

  bmSelect.addEventListener('change', () => {
    if (bmSelect.value) navigate(bmSelect.value);
    bmSelect.value = '';
  });
  starBtn.addEventListener('click', () => {
    if (!rec.url) return;
    if (isBookmarked(rec.url)) removeBookmark(rec.url);
    else {
      const name = rec.tabEl.querySelector('.title').textContent || rec.url;
      addBookmark(name, rec.url);
    }
  });
  paneEl.querySelector('.web-devtools').addEventListener('click', () =>
    safe(() => (wv.isDevToolsOpened() ? wv.closeDevTools() : wv.openDevTools()))
  );
  paneEl.querySelector('.web-ext').addEventListener('click', () => {
    if (rec.url) api.openExternal(rec.url);
  });

  wv.addEventListener('page-title-updated', (e) => {
    if (e.title) setTabTitle(id, e.title);
  });
  // Show loading state on the reload button (spins ⟳ → acts as a stop ✕).
  wv.addEventListener('did-start-loading', () => {
    rec.loading = true;
    reloadBtn.classList.add('loading');
    reloadBtn.title = 'Stop loading';
  });
  const stopLoadingUI = () => {
    rec.loading = false;
    reloadBtn.classList.remove('loading');
    reloadBtn.title = 'Reload';
  };
  // Snapshot the page once it's painted so the 3D Exposé card has a real thumbnail.
  wv.addEventListener('did-stop-loading', () => {
    stopLoadingUI();
    if (id === activeTabId) setTimeout(() => captureWebThumb(rec), 250);
  });
  wv.addEventListener('did-navigate', (e) => {
    urlInput.value = e.url;
    rec.url = e.url;
    updateStar(rec);
    persistOpenWebTabs();
  });
  wv.addEventListener('did-navigate-in-page', (e) => {
    if (e.isMainFrame) {
      urlInput.value = e.url;
      rec.url = e.url;
      updateStar(rec);
    }
  });

  // Find in page: reflect match counts, and catch Ctrl+F even when the page has focus.
  wv.addEventListener('found-in-page', (e) => {
    if (id !== activeTabId) return;
    const r = (e && e.result) || {};
    els.webFindInfo.textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : 'No results';
  });
  wv.addEventListener('ipc-message', (e) => {
    if (e.channel === 'web-find' && id === activeTabId) openWebFind();
  });

  // Right-click selected text on the page → save it as a sticky note.
  wv.addEventListener('context-menu', (e) => {
    const p = e.params || {};
    const sel = (p.selectionText || '').trim();
    if (!sel) return;
    const title = (rec.tabEl.querySelector('.title').textContent || rec.url || 'Web').slice(0, 120);
    captureToNote({ title, text: sel });
  });

  if (savedUrl) {
    urlInput.value = savedUrl;
    wv.src = savedUrl;
  } else {
    setTimeout(() => urlInput.focus(), 0);
  }

  persistOpenWebTabs();
  return id;
}

els.webBtn.addEventListener('click', () => createWebTab());

let terminalCwd = ''; // remembered local-terminal folder
async function openLocalTerminal(pick) {
  const res = await api.openTerminal(pick ? { pick: true, cwd: terminalCwd } : { cwd: terminalCwd });
  if (res && res.ok && res.dir) {
    terminalCwd = res.dir;
    api.saveSettings({ terminalCwd });
  }
}
// Plain click → a local shell in a tab (node-pty). Shift-click → the external OS terminal.
els.localTermBtn.title = 'Open a local terminal tab (Shift-click: external OS terminal)';
els.localTermBtn.addEventListener('click', (e) => {
  if (e.shiftKey) openLocalTerminal(!terminalCwd);
  else createLocalTab({ cwd: terminalCwd || undefined });
});

// VS Code (code-server): launch it locally on first use and open it in a web tab.
// Reusable spinner toast for longer background tasks.
function showBusy(msg) {
  document.getElementById('busy-msg').textContent = msg || 'Working…';
  document.getElementById('busy-toast').classList.remove('hidden');
}
function updateBusy(msg) {
  const t = document.getElementById('busy-toast');
  if (msg && !t.classList.contains('hidden')) document.getElementById('busy-msg').textContent = msg;
}
function hideBusy() {
  document.getElementById('busy-toast').classList.add('hidden');
}

let codeFolder = null; // last-used folder for code-server
let codeStarting = false;
if (els.codeBtn) {
  api.onCodeLog(({ line }) => {
    if (!codeStarting || !line) return;
    const last = String(line).trim().split('\n').filter(Boolean).pop();
    if (last) updateBusy('🧑‍💻 ' + last.slice(0, 70));
  });
  els.codeBtn.addEventListener('click', async (e) => {
    if (codeStarting) return;
    let folder = codeFolder || undefined;
    if (e.shiftKey || !folder) {
      const pick = await api.codePickFolder();
      if (pick && pick.ok && pick.folder) folder = pick.folder;
      else if (!folder) return; // cancelled and nothing remembered
    }
    codeStarting = true;
    showBusy('🧑‍💻 Starting VS Code (installing code-server if needed)…');
    try {
      const res = await api.codeOpen({ folder });
      if (res && res.ok) {
        codeFolder = folder || codeFolder;
        api.saveSettings({ codeFolder });
        createWebTab(res.url);
      } else {
        const msg = (res && res.error) || 'failed to start';
        window.alert('code-server could not start:\n\n' + msg);
      }
    } finally {
      codeStarting = false;
      hideBusy();
    }
  });
}

// A web tab pointing at our local code-server (loopback + ?folder=).
function isCodeServerUrl(url) {
  try {
    const u = new URL(url);
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.searchParams.has('folder');
  } catch (_) {
    return false;
  }
}

// On launch, any restored VS Code tab loads a dead page because code-server isn't
// running yet — start it, then reload those tabs once it's up.
async function ensureCodeServerForRestoredTabs() {
  const codeTabs = [...tabs.values()].filter((r) => r.kind === 'web' && r.url && isCodeServerUrl(r.url));
  if (!codeTabs.length) return;
  let folder;
  try {
    folder = new URL(codeTabs[0].url).searchParams.get('folder') || undefined;
  } catch (_) {
    /* ignore */
  }
  codeStarting = true;
  showBusy('🧑‍💻 Starting VS Code (installing code-server if needed)…');
  try {
    const res = await api.codeOpen({ folder });
    if (res && res.ok) {
      for (const rec of codeTabs) {
        // Re-navigate (a failed ERR_CONNECTION_REFUSED load won't retry on reload()).
        try {
          const p = rec.wv.loadURL(rec.url);
          if (p && p.catch) p.catch(() => {});
        } catch (_) {
          try {
            rec.wv.reload();
          } catch (_) {
            /* webview not ready */
          }
        }
      }
    } else {
      els.statusText.textContent = '🧑‍💻 code-server: ' + ((res && res.error) || 'failed to start');
    }
  } finally {
    codeStarting = false;
    hideBusy();
  }
}

// ===========================================================================
// ✈️ Black Box — a local, scrubbable timeline of activity across every stream.
// ===========================================================================
let blackboxOn = true;
let blackboxLogText = true;
let blackboxDays = 14;
let bbPending = [];

const BB_LANES = ['projects', 'terminal', 'slack', 'whatsapp', 'mail', 'calendar', 'notes', 'system'];
const BB_LANE_LABEL = {
  projects: 'Projects', terminal: 'Terminal', slack: 'Slack', whatsapp: 'WhatsApp', mail: 'Mail',
  calendar: 'Calendar', notes: 'Notes', system: 'System',
};
const BB_COLOR = {
  cmd: '#4ea1ff', 'cmd-done': '#7ee787', slack: '#c285e0', whatsapp: '#25d366',
  mail: '#f0c674', meeting: '#ff9d5c', note: '#f0c674', 'tab-open': '#8a8f94',
  'tab-close': '#5a6068', attention: '#ff5f56', reminder: '#a0e0a0',
};
const BB_LANE_FOR = {
  cmd: 'terminal', 'cmd-done': 'terminal', attention: 'terminal',
  slack: 'slack', whatsapp: 'whatsapp', mail: 'mail', meeting: 'calendar',
  note: 'notes', 'tab-open': 'system', 'tab-close': 'system', reminder: 'system',
};

// The one call sites use — safe to sprinkle anywhere; never throws.
function logEvent(kind, data) {
  if (!blackboxOn) return;
  try {
    data = data || {};
    const ev = {
      ts: Date.now(),
      kind,
      lane: data.lane || BB_LANE_FOR[kind] || 'system',
      title: String(data.title || '').slice(0, 200),
      detail: String(data.detail || '').slice(0, 300),
      host: data.host || '',
      ref: data.ref || null,
    };
    if (!blackboxLogText && (kind === 'slack' || kind === 'whatsapp' || kind === 'mail')) ev.detail = '';
    bbPending.push(ev);
    if (bbPending.length > 500) bbPending = bbPending.slice(-500);
  } catch (_) {
    /* logging must never break the app */
  }
}
function flushBlackbox() {
  if (!bbPending.length) return;
  const batch = bbPending;
  bbPending = [];
  api.blackboxLog(batch);
}
function bbTabOpen(rec) {
  logEvent('tab-open', {
    title:
      'opened ' +
      ((rec.profile && rec.profile.name) || (rec.channel && rec.channel.name) || rec.url || rec.kind),
    ref: { type: 'tab', tabKey: tabKey(rec) },
  });
}
setInterval(flushBlackbox, 1500);
window.addEventListener('beforeunload', flushBlackbox);
function bbDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.round(s / 60);
  return m < 60 ? m + 'm' : (m / 60).toFixed(1) + 'h';
}

// ---- Timeline UI ----
let bbOpen = false;
let bbTo = Date.now();
let bbSpan = 8 * 3600000; // visible window width in ms
let bbCursor = Date.now();
let bbFollowNow = true;
let bbEvents = [];
let bbRefreshTimer = null;
const bbTrackEl = () => document.getElementById('bb-track');
function bbFrom() {
  return bbTo - bbSpan;
}

function openBlackbox() {
  if (bbOpen) return;
  bbOpen = true;
  bbFollowNow = true;
  bbTo = Date.now();
  bbCursor = bbTo - bbSpan * 0.02;
  document.getElementById('blackbox').classList.remove('hidden');
  const btn = document.getElementById('blackbox-btn');
  if (btn) btn.classList.add('on');
  refreshBlackbox();
  clearInterval(bbRefreshTimer);
  bbRefreshTimer = setInterval(() => {
    if (bbFollowNow) bbTo = Date.now();
    refreshBlackbox();
  }, 1500);
  bbRefitActiveTerm();
}
function closeBlackbox() {
  bbOpen = false;
  document.getElementById('blackbox').classList.add('hidden');
  const btn = document.getElementById('blackbox-btn');
  if (btn) btn.classList.remove('on');
  clearInterval(bbRefreshTimer);
  bbRefitActiveTerm();
}
function toggleBlackbox() {
  if (bbOpen) closeBlackbox();
  else openBlackbox();
}
function bbRefitActiveTerm() {
  const rec = activeTabId && tabs.get(activeTabId);
  if (rec && (rec.kind === 'ssh' || rec.kind === 'local') && rec.fitAddon) {
    requestAnimationFrame(() => {
      try {
        rec.fitAddon.fit();
      } catch (_) {
        /* ignore */
      }
    });
  }
}

async function refreshBlackbox() {
  if (!bbOpen) return;
  flushBlackbox();
  const from = bbFrom();
  const pad = bbSpan * 0.5;
  try {
    const res = await api.blackboxQuery({ from: from - pad, to: bbTo + pad, limit: 4000 });
    bbEvents = (res && res.ok && res.events) || [];
  } catch (_) {
    bbEvents = [];
  }
  renderBlackboxTrack();
}

function bbAxisStep(span) {
  const m = 60000, h = 3600000, d = 86400000;
  if (span <= 30 * m) return 5 * m;
  if (span <= 2 * h) return 15 * m;
  if (span <= 8 * h) return h;
  if (span <= 24 * h) return 3 * h;
  if (span <= 3 * d) return 6 * h;
  return d;
}
function bbFmtTime(t) {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
function bbFmtAxis(t, step) {
  const dt = new Date(t);
  if (step >= 86400000) return dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (step >= 3 * 3600000)
    return dt.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  return bbFmtTime(t);
}
function bbFmtRange(from, to) {
  const opt = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
  return new Date(from).toLocaleString([], opt) + '  →  ' + new Date(to).toLocaleString([], opt);
}

function renderBlackboxTrack() {
  const track = bbTrackEl();
  if (!track) return;
  const W = track.clientWidth;
  const H = track.clientHeight;
  const from = bbFrom();
  const to = bbTo;
  const span = to - from || 1;
  track.innerHTML = '';
  const laneH = H / BB_LANES.length;
  BB_LANES.forEach((lane, i) => {
    const y = i * laneH;
    const sep = document.createElement('div');
    sep.className = 'bb-lane-sep';
    sep.style.top = y + 'px';
    track.appendChild(sep);
    const lbl = document.createElement('div');
    lbl.className = 'bb-lane-label';
    lbl.textContent = BB_LANE_LABEL[lane];
    lbl.style.top = y + laneH / 2 + 'px';
    track.appendChild(lbl);
  });
  const step = bbAxisStep(span);
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
    const x = ((t - from) / span) * W;
    const gl = document.createElement('div');
    gl.className = 'bb-gridline';
    gl.style.left = x + 'px';
    track.appendChild(gl);
    const lb = document.createElement('div');
    lb.className = 'bb-axis-label';
    lb.style.left = x + 'px';
    lb.textContent = bbFmtAxis(t, step);
    track.appendChild(lb);
  }
  // Projects lane (index 0): draw each time segment as a colored bar so you can see
  // *when* each project was worked on, and drag-select a block to reassign it.
  const now = Date.now();
  const barTop = 6;
  const barH = Math.max(6, laneH - 12);
  for (const s of paSegments) {
    const segEnd = s === paOpen && paRunning ? now : s.end;
    const a = Math.max(s.start, from);
    const b = Math.min(segEnd, to);
    if (b <= a) continue;
    const proj = paProject(s.projectId);
    const x = ((a - from) / span) * W;
    const w = Math.max(2, ((b - a) / span) * W);
    const bar = document.createElement('div');
    bar.className = 'bb-proj-seg';
    bar.style.left = x + 'px';
    bar.style.width = w + 'px';
    bar.style.top = barTop + 'px';
    bar.style.height = barH + 'px';
    bar.style.background = proj ? proj.color : '#5a6068';
    bar.title =
      `${proj ? proj.name : 'Unknown'}  ${bbFmtTime(s.start)}-${bbFmtTime(segEnd)}  (${bbDur(segEnd - s.start)})` +
      (s.note ? `\n${s.note}` : '');
    track.appendChild(bar);
  }
  const cwin = Math.max(span * 0.012, 60000); // cursor "near" window
  for (const ev of bbEvents) {
    if (ev.ts < from || ev.ts > to) continue;
    const x = ((ev.ts - from) / span) * W;
    const laneIdx = Math.max(0, BB_LANES.indexOf(ev.lane));
    const el = document.createElement('div');
    el.className = 'bb-tick' + (Math.abs(ev.ts - bbCursor) <= cwin ? ' near' : '');
    el.style.left = x + 'px';
    el.style.top = laneIdx * laneH + laneH / 2 + 'px';
    el.style.background = BB_COLOR[ev.kind] || '#8a8f94';
    el.title = `${bbFmtTime(ev.ts)}  ${ev.title}${ev.host ? ' @' + ev.host : ''}${ev.detail ? '\n' + ev.detail : ''}`;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      jumpToEvent(ev);
    });
    track.appendChild(el);
  }
  const ph = document.createElement('div');
  ph.id = 'bb-playhead';
  ph.style.left = ((bbCursor - from) / span) * W + 'px';
  ph.addEventListener('pointerdown', bbPlayheadDown);
  track.appendChild(ph);
  document.getElementById('bb-range').textContent = bbFmtRange(from, to);
  document.getElementById('bb-cursor').textContent = bbFmtTime(bbCursor);
  renderBlackboxSummary(cwin);
}

function renderBlackboxSummary(cwin) {
  const sum = document.getElementById('bb-summary');
  if (!sum) return;
  const win = cwin || 90000;
  const near = bbEvents.filter((e) => Math.abs(e.ts - bbCursor) <= win).sort((a, b) => a.ts - b.ts);
  sum.innerHTML = '';
  if (!near.length) {
    sum.innerHTML = '<span class="settings-status">No activity around this time — drag the playhead.</span>';
    return;
  }
  for (const ev of near.slice(0, 40)) {
    const line = document.createElement('div');
    line.className = 'bb-sum-item';
    line.innerHTML =
      `<span class="bb-sum-dot" style="background:${BB_COLOR[ev.kind] || '#8a8f94'}"></span>` +
      `<span class="bb-sum-time">${bbFmtTime(ev.ts)}</span>` +
      escapeHtml(ev.title) +
      (ev.host ? ` <span class="bb-sum-time">@${escapeHtml(ev.host)}</span>` : '') +
      (ev.detail ? ' — ' + escapeHtml(ev.detail) : '');
    line.addEventListener('click', () => jumpToEvent(ev));
    sum.appendChild(line);
  }
}

function bbPlayheadDown(e) {
  e.stopPropagation();
  const track = bbTrackEl();
  const rect = track.getBoundingClientRect();
  const move = (ev) => {
    const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
    bbCursor = bbFrom() + (x / rect.width) * bbSpan;
    renderBlackboxTrack();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function bbTrackDown(e) {
  if (e.target.id === 'bb-playhead') return;
  const track = bbTrackEl();
  const rect = track.getBoundingClientRect();
  const laneH = rect.height / BB_LANES.length;
  // A drag that begins in the Projects lane (top lane) selects a time block to reassign.
  if (e.clientY - rect.top < laneH) {
    bbProjectSelectDown(e, rect);
    return;
  }
  if (e.target.classList.contains('bb-tick')) return;
  const startX = e.clientX;
  const W = track.clientWidth || 1;
  const startTo = bbTo;
  bbFollowNow = false;
  const move = (ev) => {
    bbTo = startTo - ((ev.clientX - startX) / W) * bbSpan; // drag right → go back in time
    renderBlackboxTrack();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    refreshBlackbox();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// Drag across the Projects lane to select a past block, then pick which project it
// really belonged to. This is the precise fix for "I forgot to switch projects".
function bbProjectSelectDown(e, rect) {
  e.preventDefault();
  const W = rect.width || 1;
  const x0 = Math.max(0, Math.min(W, e.clientX - rect.left));
  const sel = document.createElement('div');
  sel.className = 'bb-proj-select';
  bbTrackEl().appendChild(sel);
  let x1 = x0;
  const paint = () => {
    const lo = Math.min(x0, x1);
    sel.style.left = lo + 'px';
    sel.style.width = Math.abs(x1 - x0) + 'px';
  };
  paint();
  const move = (ev) => {
    x1 = Math.max(0, Math.min(W, ev.clientX - rect.left));
    paint();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    sel.remove();
    if (hi - lo < 4) return; // a click, not a drag
    const from = bbFrom();
    const startMs = from + (lo / W) * bbSpan;
    const endMs = from + (hi / W) * bbSpan;
    openBbAssignPopover(startMs, endMs, rect.left + lo, rect.top);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

let bbAssignPop = null;
function closeBbAssignPopover() {
  if (bbAssignPop) {
    bbAssignPop.remove();
    bbAssignPop = null;
  }
}
function openBbAssignPopover(startMs, endMs, px, py) {
  closeBbAssignPopover();
  if (!paProjects.length) return;
  const el = document.createElement('div');
  el.id = 'bb-assign-pop';
  el.innerHTML =
    `<div class="mp-title">Assign ${bbFmtTime(startMs)}-${bbFmtTime(endMs)} (${bbDur(endMs - startMs)}) to</div>` +
    `<div class="bb-assign-list">${paProjects
      .map(
        (p) =>
          `<button class="bb-assign-item" data-pid="${p.id}"><span class="pa-dot" style="background:${p.color}"></span>${escapeHtml(p.name)}</button>`
      )
      .join('')}</div>`;
  document.body.appendChild(el);
  bbAssignPop = el;
  el.style.left = Math.min(px, window.innerWidth - 240) + 'px';
  el.style.top = py + 24 + 'px';
  el.querySelectorAll('.bb-assign-item').forEach((b) => {
    b.addEventListener('click', async () => {
      flushProject(); // persist the open segment's current end before the store splits it
      const before = paSnapshot();
      await api.projectReassign(Math.round(startMs), Math.round(endMs), b.dataset.pid);
      await reloadSegments();
      const tp = paProject(b.dataset.pid);
      if (tp) tp.lastUsed = Date.now();
      pushUndo(before, `Assigned ${bbFmtTime(startMs)}-${bbFmtTime(endMs)} (${bbDur(endMs - startMs)}) → ${tp ? tp.name : '?'}`);
      closeBbAssignPopover();
      renderBlackboxTrack();
      updateProjectWidget();
      if (!document.getElementById('project-overlay').classList.contains('hidden')) renderProjectOverlay();
    });
  });
}
document.addEventListener('mousedown', (e) => {
  if (bbAssignPop && !e.target.closest('#bb-assign-pop') && !e.target.classList.contains('bb-proj-seg')) closeBbAssignPopover();
});

function bbWheel(e) {
  e.preventDefault();
  const rect = bbTrackEl().getBoundingClientRect();
  const mx = (e.clientX - rect.left) / (rect.width || 1); // 0..1 anchor
  const anchorT = bbFrom() + mx * bbSpan;
  const factor = e.deltaY < 0 ? 0.8 : 1.25;
  bbSpan = Math.max(5 * 60000, Math.min(14 * 86400000, bbSpan * factor));
  bbTo = anchorT + (1 - mx) * bbSpan;
  bbFollowNow = false;
  refreshBlackbox();
}

function jumpToEvent(ev) {
  const r = ev && ev.ref;
  if (!r) return;
  if (r.type === 'tab' && r.tabKey) {
    for (const [id, rec] of tabs) if (tabKey(rec) === r.tabKey) return activateTab(id);
  } else if (r.type === 'note' && r.id != null) {
    createNotesTab();
    const n = notesData.find((x) => x.id === r.id);
    if (n) jumpToNote(n);
  } else if (r.type === 'slack' && r.channelId) {
    openSlackChannelById(r.channelId);
  } else if (r.type === 'url' && r.url) {
    api.openExternal(r.url);
  }
}

{
  const btn = document.getElementById('blackbox-btn');
  if (btn) btn.addEventListener('click', toggleBlackbox);
  document.getElementById('bb-close').addEventListener('click', closeBlackbox);
  document.getElementById('bb-now').addEventListener('click', () => {
    bbFollowNow = true;
    bbTo = Date.now();
    bbCursor = bbTo - bbSpan * 0.02;
    refreshBlackbox();
  });
  document.getElementById('bb-zoom-in').addEventListener('click', () => {
    bbSpan = Math.max(5 * 60000, bbSpan * 0.6);
    refreshBlackbox();
  });
  document.getElementById('bb-zoom-out').addEventListener('click', () => {
    bbSpan = Math.min(14 * 86400000, bbSpan * 1.6);
    refreshBlackbox();
  });
  const track = bbTrackEl();
  track.addEventListener('wheel', bbWheel, { passive: false });
  track.addEventListener('pointerdown', bbTrackDown);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F4') {
      e.preventDefault();
      toggleBlackbox();
    }
  });

  // Settings
  els.setBbOn.addEventListener('change', () => {
    blackboxOn = els.setBbOn.checked;
    api.saveSettings({ blackboxOn });
  });
  els.setBbText.addEventListener('change', () => {
    blackboxLogText = els.setBbText.checked;
    api.saveSettings({ blackboxLogText });
  });
  els.setBbDays.addEventListener('change', () => {
    const d = parseInt(els.setBbDays.value, 10);
    if (Number.isFinite(d) && d > 0) {
      blackboxDays = d;
      api.saveSettings({ blackboxDays });
      api.blackboxTrim(blackboxDays).then(refreshBbStats);
    }
  });
  els.setBbClear.addEventListener('click', async () => {
    await api.blackboxClear();
    bbEvents = [];
    if (bbOpen) renderBlackboxTrack();
    refreshBbStats();
  });
}
async function refreshBbStats() {
  if (!els.bbStats) return;
  try {
    const s = await api.blackboxStats();
    if (s && s.ok) els.bbStats.textContent = `${s.count} events · ${(s.size / 1024).toFixed(0)} KB`;
  } catch (_) {
    /* ignore */
  }
}

// ===========================================================================
// 📊 Project accounting — a manual start/stop time tracker per project.
// Accrues wall-clock time while running (even unfocused); no idle timeout.
// ===========================================================================
const PA_COLORS = ['#4ea1ff', '#7ee787', '#c285e0', '#f0c674', '#ff9d5c', '#25d366', '#ff5f56', '#3bbf9f', '#e0a0ff', '#a0e0ff'];
let paProjects = [];
let paCurrentId = null;
let paRunning = false;
let paSegments = []; // [{projectId, start, end, open?}] — the authoritative time record
let paOpen = null; // the current open (running) segment object, or null
let paDayChart = null;
let paMonthChart = null;
let paMonthRef = null; // {y, m} shown in the Month tab (0-based month)
let paOverlayTimer = null;
let paEditing = false; // true while inline-renaming a project (pauses auto-refresh)
let autoProjectSwitch = false; // switch the active project to the focused tab's assigned project
let tabProjects = {}; // tabKey -> projectId (persisted); which project each tab tracks time as

// The project a tab is assigned to (or null). Guards against a project that was deleted.
// Prefer a per-tab cache (rec.trackProject) so a web/VS Code tab keeps its project even
// as its URL - and therefore its tabKey - changes while browsing.
function getTabProject(rec) {
  if (!rec) return null;
  let pid = rec.trackProject != null ? rec.trackProject : tabProjects[tabKey(rec)];
  if (pid && paProjects.some((p) => p.id === pid)) {
    rec.trackProject = pid; // cache for this session
    return pid;
  }
  return null;
}
function setTabProject(rec, projectId) {
  if (!rec) return;
  rec.trackProject = projectId || null;
  const key = tabKey(rec);
  if (projectId) tabProjects[key] = projectId;
  else delete tabProjects[key];
  api.saveSettings({ tabProjects });
  if (rec.id === activeTabId) maybeAutoSwitchProject(rec); // apply now if it's the focused tab
}
// Build a "Track time as" project picker into `container` for any tab (ssh, local,
// web, VS Code). Shared by the terminal cheat-sheet and the web hover panel.
function renderTrackTimeAs(container, rec) {
  if (!container) return;
  container.innerHTML = '';
  if (!rec || !paProjects.length) return;
  const title = document.createElement('div');
  title.className = 'th-title';
  title.textContent = 'Track time as' + (autoProjectSwitch ? '' : ' (auto-switch off)');
  container.appendChild(title);
  const sel = document.createElement('select');
  sel.className = 'th-proj-select';
  const cur = getTabProject(rec);
  sel.innerHTML =
    '<option value="">- none -</option>' +
    paProjects
      .map((p) => `<option value="${p.id}"${p.id === cur ? ' selected' : ''}>${escapeHtml(p.name)}</option>`)
      .join('');
  sel.addEventListener('change', () => {
    setTabProject(rec, sel.value || null);
    const r = tabs.get(rec.id);
    if (r && r.term) r.term.focus();
  });
  container.appendChild(sel);
}
// On tab focus, follow the tab's assigned project (only when the feature is on).
// While the timer runs, switching tabs switches the running project. If the timer
// is stopped, we only remember the project (never silently restart timing).
function maybeAutoSwitchProject(rec) {
  if (!autoProjectSwitch) return;
  const pid = getTabProject(rec);
  if (!pid || pid === paCurrentId) return;
  if (paRunning) {
    setCurrentProject(pid);
  } else {
    paCurrentId = pid;
    const p = paProject(pid);
    if (p) p.lastUsed = Date.now();
    api.projectSetCurrent(pid);
    updateProjectWidget();
  }
}

function paDateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtHM(secs) {
  secs = Math.max(0, Math.floor(secs || 0));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return secs > 0 ? `${secs}s` : '0m';
}
function paProject(id) {
  return paProjects.find((p) => p.id === id) || null;
}
function paTodayStartMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
// Seconds per project within [from, to], derived from segments (the running/open
// segment counts up to "now").
function segSeconds(from, to) {
  const now = Date.now();
  const map = {};
  for (const s of paSegments) {
    const end = s === paOpen && paRunning ? now : s.end;
    const a = Math.max(s.start, from);
    const b = Math.min(end, to);
    if (b > a) map[s.projectId] = (map[s.projectId] || 0) + (b - a) / 1000;
  }
  return map;
}
function paCurrentTodaySecs() {
  return paCurrentId ? segSeconds(paTodayStartMs(), Date.now() + 1000)[paCurrentId] || 0 : 0;
}

function startOpenSegment(id) {
  const now = Date.now();
  if (paOpen) {
    paOpen.end = now;
    delete paOpen.open;
  }
  paOpen = { projectId: id, start: now, end: now, open: true };
  paSegments.push(paOpen);
  api.projectStartSegment(id, now);
}
function closeOpenSegment() {
  if (!paOpen) return;
  paOpen.end = Date.now();
  delete paOpen.open;
  paOpen = null;
  api.projectStopSegment(Date.now());
}
async function reloadSegments() {
  try {
    const s = await api.projectGetState();
    if (s && s.ok) {
      paSegments = s.segments || [];
      paOpen = paSegments.find((x) => x.open) || null;
    }
  } catch (_) {
    /* ignore */
  }
}

async function initProjects() {
  try {
    const s = await api.projectGetState();
    if (s && s.ok) {
      paProjects = s.projects || [];
      paCurrentId = s.currentProjectId || null;
      paRunning = !!s.running;
      paSegments = s.segments || [];
    }
  } catch (_) {
    /* store not ready */
  }
  paOpen = null;
  if (paRunning && paCurrentId) startOpenSegment(paCurrentId); // resume with a fresh segment
  else paRunning = false;
  // Now that projects are loaded, follow the already-focused tab's assigned project.
  if (activeTabId) maybeAutoSwitchProject(tabs.get(activeTabId));
  updateProjectWidget();
  setInterval(updateProjectWidget, 1000);
  setInterval(flushProject, 15000);
  window.addEventListener('beforeunload', flushProject);
}

// Persist the running segment's growing end.
function flushProject() {
  if (!paRunning || !paOpen) return;
  paOpen.end = Date.now();
  api.projectTouchSegment(paOpen.end);
}

function updateProjectWidget() {
  const nameEl = document.getElementById('pw-name');
  const timeEl = document.getElementById('pw-time');
  const stopEl = document.getElementById('pw-stop');
  if (!nameEl) return;
  const cur = paProject(paCurrentId);
  nameEl.textContent = cur ? cur.name : 'No project';
  nameEl.style.color = cur ? cur.color : '';
  timeEl.textContent = cur ? fmtHM(paCurrentTodaySecs()) : '';
  stopEl.textContent = paRunning ? '⏸' : '▶';
  stopEl.classList.toggle('running', paRunning);
  if (bbOpen) renderBlackboxTrack(); // keep the Black Box project lane live
}

function setProjectRunning(on) {
  if (on && paCurrentId) {
    if (!paRunning) {
      paRunning = true;
      api.projectSetRunning(true);
      startOpenSegment(paCurrentId);
    }
  } else if (paRunning) {
    paRunning = false;
    api.projectSetRunning(false);
    closeOpenSegment();
  }
  updateProjectWidget();
}

function setCurrentProject(id) {
  paCurrentId = id;
  const p = paProject(id);
  if (p) p.lastUsed = Date.now();
  api.projectSetCurrent(id);
  if (!paRunning) {
    paRunning = true; // picking a project starts the clock
    api.projectSetRunning(true);
  }
  startOpenSegment(id); // close the previous segment, open one for the new project
  updateProjectWidget();
  // Update the highlight in place (don't rebuild the list — that would break the
  // double-click-to-select gesture, whose 2nd click needs the same row element).
  document.querySelectorAll('#pa-day-list .pa-row').forEach((r) => {
    r.classList.toggle('current', r.dataset.pid === id);
  });
}

async function addProjectFromInput() {
  const input = document.getElementById('pa-new-name');
  const name = input.value.trim();
  if (!name) return;
  const color = PA_COLORS[paProjects.length % PA_COLORS.length];
  const res = await api.projectAdd(name, color);
  if (res && res.ok && res.project) {
    paProjects.push(res.project);
    input.value = '';
    setCurrentProject(res.project.id); // starts the clock on the new project
    closeProjectOverlayGenie();
  }
}

// Inline-rename a project from its list row.
function startProjectRename(project, nameEl) {
  paEditing = true; // pause the overlay auto-refresh so it doesn't wipe the edit box
  nameEl.contentEditable = 'true';
  nameEl.classList.add('editing');
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  nameEl.focus();
  const finish = (commit) => {
    nameEl.removeEventListener('keydown', onKey);
    nameEl.removeEventListener('blur', onBlur);
    nameEl.contentEditable = 'false';
    nameEl.classList.remove('editing');
    const name = nameEl.textContent.trim();
    if (commit && name && name !== project.name) {
      project.name = name;
      api.projectRename(project.id, name);
      updateProjectWidget();
    } else {
      nameEl.textContent = project.name;
    }
    paEditing = false;
    renderProjectOverlay(); // refresh with the new name + resume auto-updates
  };
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };
  const onBlur = () => finish(true);
  nameEl.addEventListener('keydown', onKey);
  nameEl.addEventListener('blur', onBlur);
}

// ---- Overlay ----
// Drag the project panel by its header (offset kept for the session).
let paPanelOffset = { x: 0, y: 0 };
function applyPanelOffset() {
  const panel = document.getElementById('project-panel');
  if (!panel) return;
  panel.style.transform = paPanelOffset.x || paPanelOffset.y ? `translate(${paPanelOffset.x}px, ${paPanelOffset.y}px)` : '';
}
function openProjectOverlay() {
  document.getElementById('project-overlay').classList.remove('hidden');
  applyPanelOffset(); // restore any dragged position
  paMonthRef = { y: new Date().getFullYear(), m: new Date().getMonth() };
  paEntryDayMs = entDayStart(Date.now()); // Entries tab starts on today
  showLastAction(paUndo.length ? paUndo[paUndo.length - 1].desc : ''); // reflect any pending undo
  showProjectTab('day');
  updateAppTrackHint(); // reflect the opt-in state
  refreshAppActivity(); // pull the latest app breakdown from the store
  clearInterval(paOverlayTimer);
  paOverlayTimer = setInterval(() => {
    renderProjectOverlay();
    if (appTrackingEnabled) refreshAppActivity();
  }, 3000); // keep the running bar + app breakdown fresh
}
function closeProjectOverlay() {
  document.getElementById('project-overlay').classList.add('hidden');
  clearInterval(paOverlayTimer);
}

// Shrink the panel into the status-bar project widget (Apple-dock-ish genie).
function closeProjectOverlayGenie() {
  const overlay = document.getElementById('project-overlay');
  const panel = document.getElementById('project-panel');
  const widget = document.getElementById('project-widget');
  if (!overlay || overlay.classList.contains('hidden') || !panel || !widget) return closeProjectOverlay();
  clearInterval(paOverlayTimer);
  const pr = panel.getBoundingClientRect();
  const wr = widget.getBoundingClientRect();
  const dx = wr.left + wr.width / 2 - (pr.left + pr.width / 2);
  const dy = wr.top + wr.height / 2 - (pr.top + pr.height / 2);
  panel.style.transition = 'transform 0.42s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.42s ease';
  overlay.style.transition = 'background 0.42s ease';
  void panel.offsetWidth; // reflow so the transition takes
  overlay.style.background = 'rgba(0,0,0,0)';
  panel.style.transform = `translate(${dx}px, ${dy}px) scale(0.04)`;
  panel.style.opacity = '0';
  widget.classList.add('pw-bump');
  setTimeout(() => widget.classList.remove('pw-bump'), 500);
  setTimeout(() => {
    overlay.classList.add('hidden');
    panel.style.transition = '';
    panel.style.transform = '';
    panel.style.opacity = '';
    overlay.style.transition = '';
    overlay.style.background = '';
  }, 430);
}
function showProjectTab(which) {
  document.getElementById('pa-day').classList.toggle('hidden', which !== 'day');
  document.getElementById('pa-month').classList.toggle('hidden', which !== 'month');
  document.getElementById('pa-entries').classList.toggle('hidden', which !== 'log');
  document.getElementById('pa-tab-day').classList.toggle('active', which === 'day');
  document.getElementById('pa-tab-month').classList.toggle('active', which === 'month');
  document.getElementById('pa-tab-log').classList.toggle('active', which === 'log');
  document.getElementById('project-overlay').dataset.tab = which;
  renderProjectOverlay();
}
function renderProjectOverlay() {
  if (paEditing) return; // don't rebuild the list while an inline rename is in progress
  if (document.getElementById('project-overlay').classList.contains('hidden')) return;
  const tab = document.getElementById('project-overlay').dataset.tab || 'day';
  if (tab === 'day') renderProjectDay();
  else if (tab === 'month') renderProjectMonth();
  else renderProjectEntries();
}

// ---- Entries tab: manual add / edit / delete / annotate individual time blocks ----
let paEntryDayMs = null; // midnight of the viewed day
function entDayStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function entPad(n) {
  return String(n).padStart(2, '0');
}
function msToHM(ms) {
  const d = new Date(ms);
  return entPad(d.getHours()) + ':' + entPad(d.getMinutes());
}
function hmToMs(dayMs, hm) {
  const [h, m] = String(hm || '').split(':').map(Number);
  const d = new Date(dayMs);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
}
// Full local date-time for the form, so entries that cross midnight work correctly.
function msToDtLocal(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${entPad(d.getMonth() + 1)}-${entPad(d.getDate())}T${entPad(d.getHours())}:${entPad(d.getMinutes())}`;
}
function dtLocalToMs(v) {
  const t = v ? new Date(v).getTime() : NaN; // datetime-local (no tz) parses as local time
  return Number.isFinite(t) ? t : NaN;
}
// Run a store mutation with snapshot-based undo, then refresh everything.
async function paMutate(desc, fn) {
  const before = paSnapshot();
  await fn();
  await reloadSegments();
  pushUndo(before, desc);
  updateProjectWidget();
  renderProjectOverlay();
}
function renderProjectEntries() {
  if (paEntryDayMs == null) paEntryDayMs = entDayStart(Date.now());
  const dayMs = paEntryDayMs;
  const dayEnd = dayMs + 86400000;
  const now = Date.now();
  document.getElementById('pa-ent-label').textContent = new Date(dayMs).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const total = Object.values(segSeconds(dayMs, Math.min(dayEnd, now + 1000))).reduce((a, b) => a + b, 0);
  document.getElementById('pa-ent-total').textContent = total ? 'Σ ' + fmtHM(total) : '';

  const list = paSegments
    .filter((s) => {
      const end = s === paOpen && paRunning ? now : s.end;
      return end > dayMs && s.start < dayEnd;
    })
    .slice()
    .sort((a, b) => a.start - b.start);

  const listEl = document.getElementById('pa-ent-list');
  listEl.innerHTML = '';
  if (!list.length) {
    listEl.innerHTML = '<div class="pa-empty">No entries this day. Use ＋ Add entry to log time by hand.</div>';
    return;
  }
  for (const s of list) {
    const p = paProject(s.projectId);
    const isOpen = s === paOpen && paRunning;
    const end = isOpen ? now : s.end;
    // Flag entries that span across midnight (e.g. a timer left running overnight).
    const spanDays = Math.round((entDayStart(end) - entDayStart(s.start)) / 86400000);
    const cross = spanDays > 0 ? ` <span class="pa-ent-cross" title="ends ${spanDays} day(s) later">+${spanDays}d</span>` : '';
    const row = document.createElement('div');
    row.className = 'pa-ent-row';
    row.innerHTML =
      `<span class="pa-dot" style="background:${p ? p.color : '#888'}"></span>` +
      `<span class="pa-ent-time">${msToHM(s.start)} - ${msToHM(end)}${cross}</span>` +
      `<span class="pa-ent-dur">${fmtHM((end - s.start) / 1000)}</span>` +
      `<span class="pa-ent-proj">${escapeHtml(p ? p.name : '?')}</span>` +
      `<span class="pa-ent-note">${s.note ? escapeHtml(s.note) : ''}</span>` +
      (isOpen
        ? '<span class="pa-ent-live">running</span>'
        : '<button class="pa-ent-edit" title="Edit">✎</button><button class="pa-ent-del" title="Delete">🗑</button>');
    if (!isOpen) {
      row.querySelector('.pa-ent-edit').addEventListener('click', () => openEntryForm(s));
      row.querySelector('.pa-ent-del').addEventListener('click', () => deleteEntry(s));
    }
    listEl.appendChild(row);
  }
}
function openEntryForm(seg) {
  if (!paProjects.length) return;
  paEditing = true; // pause the 3s overlay auto-refresh while the form is open
  const form = document.getElementById('pa-ent-form');
  const dayMs = paEntryDayMs;
  const defEnd = seg ? seg.end : Math.min(Date.now(), dayMs + 86400000 - 60000);
  const defStart = seg ? seg.start : Math.max(dayMs, defEnd - 3600000);
  const curPid = seg ? seg.projectId : paCurrentId || (paProjects[0] && paProjects[0].id);
  const opts = paProjects
    .map((p) => `<option value="${p.id}"${p.id === curPid ? ' selected' : ''}>${escapeHtml(p.name)}</option>`)
    .join('');
  form.innerHTML =
    `<div class="pa-ef-row"><select class="pa-ef-proj">${opts}</select>` +
    `<input class="pa-ef-start" type="datetime-local" value="${msToDtLocal(defStart)}"><span>to</span><input class="pa-ef-end" type="datetime-local" value="${msToDtLocal(defEnd)}"></div>` +
    '<div class="pa-ef-row"><input class="pa-ef-note" type="text" placeholder="What did you do? (optional)" maxlength="200"></div>' +
    `<div class="pa-ef-row"><button class="pa-ef-save">${seg ? 'Save' : 'Add'}</button>` +
    `<button class="pa-ef-cancel">Cancel</button>${seg ? '<button class="pa-ef-del">Delete</button>' : ''}` +
    '<span class="pa-ef-msg"></span></div>';
  form.classList.remove('hidden');
  form.querySelector('.pa-ef-note').value = (seg && seg.note) || '';
  form.querySelector('.pa-ef-save').addEventListener('click', () => submitEntryForm(seg));
  form.querySelector('.pa-ef-cancel').addEventListener('click', closeEntryForm);
  const delBtn = form.querySelector('.pa-ef-del');
  if (delBtn) delBtn.addEventListener('click', () => deleteEntry(seg));
  form.querySelector('.pa-ef-note').focus();
}
function closeEntryForm() {
  paEditing = false;
  const form = document.getElementById('pa-ent-form');
  form.classList.add('hidden');
  form.innerHTML = '';
  renderProjectEntries();
}
async function submitEntryForm(seg) {
  const form = document.getElementById('pa-ent-form');
  const pid = form.querySelector('.pa-ef-proj').value;
  const start = dtLocalToMs(form.querySelector('.pa-ef-start').value);
  const end = dtLocalToMs(form.querySelector('.pa-ef-end').value);
  const note = form.querySelector('.pa-ef-note').value.trim();
  if (!pid) return;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) {
    form.querySelector('.pa-ef-msg').textContent = 'End must be after start.';
    return;
  }
  paEditing = false;
  if (seg) await paMutate('Edited entry', () => api.projectUpdateSegment(seg.id, { projectId: pid, start, end, note }));
  else await paMutate('Added ' + fmtHM((end - start) / 1000), () => api.projectAddSegment(pid, start, end, note));
  closeEntryForm();
}
async function deleteEntry(seg) {
  if (!seg || !seg.id) return;
  paEditing = false;
  await paMutate('Deleted entry', () => api.projectDeleteSegment(seg.id));
  closeEntryForm();
}
function entShiftDay(delta) {
  const d = new Date(paEntryDayMs == null ? Date.now() : paEntryDayMs);
  d.setDate(d.getDate() + delta);
  d.setHours(0, 0, 0, 0);
  paEntryDayMs = d.getTime();
  closeEntryForm();
}

// ---- Undo for time moves / reassignments ----
// Every move snapshots the full segment array first, so any reassignment (move
// chips or Black Box drag-select) can be reverted with Ctrl+U or the Revert button.
let paUndo = []; // stack of { segments: [...snapshot], desc }
function paSnapshot() {
  return paSegments.map((s) => ({
    ...(s.id ? { id: s.id } : {}),
    projectId: s.projectId,
    start: s.start,
    end: s.end,
    ...(s.note ? { note: s.note } : {}),
    ...(s.open ? { open: true } : {}),
  }));
}
function pushUndo(prevSegments, desc) {
  paUndo.push({ segments: prevSegments, desc });
  if (paUndo.length > 40) paUndo.shift();
  showLastAction(desc);
}
function showLastAction(desc) {
  const bar = document.getElementById('pa-last-action');
  const txt = document.getElementById('pa-last-text');
  if (!bar || !txt) return;
  if (!desc) {
    bar.classList.add('hidden');
    return;
  }
  txt.textContent = desc;
  bar.classList.remove('hidden');
}
async function paUndoLast() {
  const entry = paUndo.pop();
  if (!entry) return;
  await api.projectSetSegments(entry.segments);
  await reloadSegments(); // paOpen re-points at the restored open segment (if any)
  const next = paUndo[paUndo.length - 1];
  showLastAction(next ? next.desc : '');
  if (!document.getElementById('project-overlay').classList.contains('hidden')) renderProjectOverlay();
  updateProjectWidget();
  if (bbOpen) renderBlackboxTrack();
}

// ---- Move time between projects (fix "forgot to switch") ----
let paMovePop = null;
function ensureMovePop() {
  if (paMovePop) return paMovePop;
  const el = document.createElement('div');
  el.id = 'pa-move-pop';
  el.className = 'hidden';
  document.body.appendChild(el);
  // Draggable by its title bar (the content is rebuilt on each open, so the handler lives
  // on the container and detects clicks that land on the current `.mp-title`).
  el.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.mp-title') || e.target.closest('button, select, input')) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const rect = el.getBoundingClientRect();
    const ox = rect.left;
    const oy = rect.top;
    const move = (ev) => {
      const nx = Math.max(8, Math.min(ox + (ev.clientX - sx), window.innerWidth - el.offsetWidth - 8));
      const ny = Math.max(8, Math.min(oy + (ev.clientY - sy), window.innerHeight - el.offsetHeight - 8));
      el.style.left = nx + 'px';
      el.style.top = ny + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  });
  paMovePop = el;
  return el;
}
// Nudge the popover fully on-screen (it's anchored under a row that can sit near the
// bottom, so without this it would open partly below the viewport).
function clampMovePop(el) {
  const r = el.getBoundingClientRect();
  let left = r.left;
  let top = r.top;
  if (r.bottom > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
  if (r.right > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
  el.style.left = Math.max(8, left) + 'px';
  el.style.top = Math.max(8, top) + 'px';
}
function closeMovePopover() {
  paEditing = false; // resume the overlay auto-refresh
  if (paMovePop) paMovePop.classList.add('hidden');
}
function openMovePopover(project, anchorEl) {
  flushProject(); // persist the live segment's growing end first
  const others = paProjects.filter((p) => p.id !== project.id);
  if (!others.length) return;
  paEditing = true; // pause auto-refresh while the popover is open
  const el = ensureMovePop();
  const avail = Math.floor(paTodayMerged()[project.id] || 0);
  const maxMin = Math.floor(avail / 60); // whole minutes available to move
  const maxH = Math.floor(maxMin / 60);
  const chips = [
    ['15m', 15],
    ['30m', 30],
    ['45m', 45],
    ['1h', 60],
    ['All', maxMin],
  ];
  el.innerHTML =
    `<div class="mp-title">Move from <span class="pa-dot" style="background:${project.color}"></span> ${escapeHtml(project.name)}</div>` +
    `<div class="mp-row">to <select class="mp-target">${others
      .map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`)
      .join('')}</select></div>` +
    `<div class="mp-slider"><span class="mp-slabel">Hours</span>` +
    `<input type="range" class="mp-h" min="0" max="${maxH}" step="1" value="0"${maxH ? '' : ' disabled'}></div>` +
    `<div class="mp-slider"><span class="mp-slabel">Minutes</span>` +
    `<input type="range" class="mp-m" min="0" max="55" step="5" value="0"></div>` +
    `<div class="mp-row mp-amt-row"><input type="number" class="mp-num" min="0" max="${maxMin}" step="5" value="0"> min` +
    ` <span class="mp-amt-lbl"></span></div>` +
    `<div class="mp-chips">${chips
      .map(([lbl, m]) => `<button data-m="${m}"${m <= 0 ? ' disabled' : ''}>${lbl}</button>`)
      .join('')}</div>` +
    `<div class="mp-row"><button class="mp-move" disabled>Move ▸</button>` +
    `<span class="mp-avail">of ${fmtHM(avail)} today</span></div>`;
  const r = anchorEl.getBoundingClientRect();
  el.style.left = Math.min(r.left, window.innerWidth - 250) + 'px';
  el.style.top = r.bottom + 4 + 'px';
  el.classList.remove('hidden');
  clampMovePop(el); // keep it fully on-screen (drag by the title to reposition)

  const target = el.querySelector('.mp-target');
  const hEl = el.querySelector('.mp-h');
  const mEl = el.querySelector('.mp-m');
  const numEl = el.querySelector('.mp-num');
  const lblEl = el.querySelector('.mp-amt-lbl');
  const moveBtn = el.querySelector('.mp-move');
  let total = 0; // minutes to move
  const clamp = (t) => {
    const c = Math.max(0, Math.min(maxMin, t || 0));
    return Math.floor(c / 5) * 5; // snap down to a 5-min step; never exceed what's available
  };
  const sync = () => {
    total = clamp(total);
    hEl.value = Math.floor(total / 60);
    mEl.value = total % 60; // always a multiple of 5
    numEl.value = total;
    lblEl.textContent = total ? '= ' + fmtHM(total * 60) : '';
    moveBtn.disabled = total <= 0;
  };
  hEl.addEventListener('input', () => {
    total = parseInt(hEl.value, 10) * 60 + parseInt(mEl.value, 10);
    sync();
  });
  mEl.addEventListener('input', () => {
    total = parseInt(hEl.value, 10) * 60 + parseInt(mEl.value, 10);
    sync();
  });
  numEl.addEventListener('input', () => {
    total = parseInt(numEl.value, 10) || 0;
    sync();
  });
  el.querySelectorAll('.mp-chips button').forEach((b) => {
    b.addEventListener('click', () => {
      total = parseInt(b.dataset.m, 10) || 0;
      sync();
    });
  });
  moveBtn.addEventListener('click', () => {
    if (total > 0) doMoveTime(project.id, target.value, total * 60);
  });
  sync();
}
async function doMoveTime(fromId, toId, seconds) {
  flushProject(); // make sure the open segment's end is current before we split it
  seconds = Math.min(Math.floor(seconds || 0), Math.floor(paTodayMerged()[fromId] || 0));
  if (seconds <= 0 || fromId === toId) {
    closeMovePopover();
    return;
  }
  const before = paSnapshot();
  const fromP = paProject(fromId);
  const toP = paProject(toId);
  await api.projectReassignRecent(fromId, toId, seconds);
  await reloadSegments(); // re-read the authoritative split from the store
  const tp = paProject(toId);
  if (tp) tp.lastUsed = Date.now();
  pushUndo(before, `Moved ${fmtHM(seconds)} · ${fromP ? fromP.name : '?'} → ${toP ? toP.name : '?'}`);
  closeMovePopover();
  renderProjectOverlay();
  updateProjectWidget();
}
// Close the move popover on outside click / Esc.
document.addEventListener('mousedown', (e) => {
  if (
    paMovePop &&
    !paMovePop.classList.contains('hidden') &&
    !e.target.closest('#pa-move-pop') &&
    !e.target.closest('.pa-move') &&
    !e.target.closest('.pa-del')
  ) {
    closeMovePopover();
  }
});

// Total tracked seconds for a project across all time (running project counts live).
function projAllSecs(id) {
  const now = Date.now();
  let s = 0;
  for (const seg of paSegments) {
    if (seg.projectId !== id) continue;
    const end = seg === paOpen && paRunning ? now : seg.end;
    s += (end - seg.start) / 1000;
  }
  return s;
}
// Reload projects + segments together (a delete changes both).
async function paReloadState() {
  const st = await api.projectGetState();
  if (st && st.ok) {
    paProjects = st.projects || [];
    paCurrentId = st.currentProjectId || null;
    paRunning = !!st.running;
    paSegments = st.segments || [];
    paOpen = paSegments.find((x) => x.open) || null;
  }
}
function openDeletePopover(project, anchorEl) {
  flushProject();
  paEditing = true; // pause auto-refresh while the popover is open
  const el = ensureMovePop();
  const others = paProjects.filter((p) => p.id !== project.id);
  const secs = Math.floor(projAllSecs(project.id));
  const targetRow =
    secs > 0 && others.length
      ? `<div class="mp-row">move its time to <select class="mp-del-target">` +
        others.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('') +
        '<option value="">- discard it -</option></select></div>'
      : '';
  el.innerHTML =
    `<div class="mp-title">Delete <span class="pa-dot" style="background:${project.color}"></span> ${escapeHtml(project.name)}?</div>` +
    (secs > 0 ? `<div class="mp-avail">${fmtHM(secs)} tracked${others.length ? '' : ' will be removed'}</div>` : '') +
    targetRow +
    '<div class="mp-row"><button class="mp-del-go">Delete</button><button class="mp-del-cancel">Cancel</button></div>';
  const r = anchorEl.getBoundingClientRect();
  el.style.left = Math.min(r.left, window.innerWidth - 250) + 'px';
  el.style.top = r.bottom + 4 + 'px';
  el.classList.remove('hidden');
  clampMovePop(el); // keep it fully on-screen (drag by the title to reposition)
  el.querySelector('.mp-del-cancel').addEventListener('click', closeMovePopover);
  el.querySelector('.mp-del-go').addEventListener('click', () => {
    const sel = el.querySelector('.mp-del-target');
    doDeleteProject(project.id, sel ? sel.value || null : null);
  });
}
async function doDeleteProject(fromId, toId) {
  if (fromId === paCurrentId && paRunning) setProjectRunning(false); // close the open segment first
  await api.projectDeleteProject(fromId, toId);
  await paReloadState();
  paUndo = []; // deleting a project isn't segment-undoable; clear the stale stack
  showLastAction('');
  closeMovePopover();
  updateProjectWidget();
  renderProjectOverlay();
}

// Today's seconds per project, derived from segments (running project counts live).
function paTodayMerged() {
  return segSeconds(paTodayStartMs(), Date.now() + 1000);
}

function renderProjectDay() {
  const merged = paTodayMerged();
  // List: every project, sorted least-recently-used first (most recent sinks to bottom).
  const list = document.getElementById('pa-day-list');
  list.innerHTML = '';
  const sorted = [...paProjects].sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
  if (!sorted.length) {
    list.innerHTML = '<div class="pa-empty">No projects yet — add one below to start tracking.</div>';
  }
  for (const p of sorted) {
    const canMove = (merged[p.id] || 0) >= 60 && paProjects.length > 1; // has ≥1m and a place to send it
    const row = document.createElement('div');
    row.className = 'pa-row' + (p.id === paCurrentId ? ' current' : '');
    row.dataset.pid = p.id;
    row.title =
      'Click: make this the current project · Double-click: select & close · ✎ rename · ⇄ move its time · ✕ delete';
    row.innerHTML =
      `<span class="pa-dot" style="background:${p.color}"></span>` +
      `<span class="pa-name">${escapeHtml(p.name)}</span>` +
      (canMove ? '<button class="pa-move" title="Move time to another project">⇄</button>' : '') +
      '<button class="pa-edit" title="Rename">✎</button>' +
      '<button class="pa-del" title="Delete project">✕</button>' +
      `<span class="pa-time">${fmtHM(merged[p.id] || 0)}</span>`;
    const guarded = (e) => e.target.closest('.pa-edit, .pa-move, .pa-del') || e.target.classList.contains('editing');
    row.addEventListener('click', (e) => {
      if (guarded(e)) return;
      setCurrentProject(p.id);
    });
    row.addEventListener('dblclick', (e) => {
      if (guarded(e)) return;
      setCurrentProject(p.id);
      closeProjectOverlayGenie(); // select & warp-close
    });
    const edit = row.querySelector('.pa-edit');
    if (edit) {
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        startProjectRename(p, row.querySelector('.pa-name'));
      });
    }
    const move = row.querySelector('.pa-move');
    if (move) {
      move.addEventListener('click', (e) => {
        e.stopPropagation();
        openMovePopover(p, move);
      });
    }
    const del = row.querySelector('.pa-del');
    if (del) {
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        openDeletePopover(p, del);
      });
    }
    list.appendChild(row);
  }
  // Chart: only projects with time today, biggest first.
  const withTime = paProjects.filter((p) => (merged[p.id] || 0) >= 1).sort((a, b) => (merged[b.id] || 0) - (merged[a.id] || 0));
  drawBarChart('pa-day-chart', 'day', withTime.map((p) => p.name), withTime.map((p) => (merged[p.id] || 0) / 3600), withTime.map((p) => p.color));
  renderAppBreakdown('pa-day-apps', [appDayStr(Date.now())]);
  // Show the resize divider only when the apps list is actually present.
  const split = document.getElementById('pa-day-split');
  const apps = document.getElementById('pa-day-apps');
  if (split) split.classList.toggle('hidden', !apps || !apps.innerHTML);
  applyPaSplit();
}

function renderProjectMonth() {
  const { y, m } = paMonthRef;
  document.getElementById('pa-month-label').textContent = new Date(y, m, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
  const from = new Date(y, m, 1, 0, 0, 0, 0).getTime();
  const to = new Date(y, m + 1, 1, 0, 0, 0, 0).getTime();
  const totals = segSeconds(from, Math.min(to, Date.now() + 1000)); // projectId -> seconds
  const rows = paProjects
    .filter((p) => (totals[p.id] || 0) >= 1)
    .sort((a, b) => (totals[b.id] || 0) - (totals[a.id] || 0));
  drawBarChart('pa-month-chart', 'month', rows.map((p) => p.name), rows.map((p) => (totals[p.id] || 0) / 3600), rows.map((p) => p.color));
  renderAppBreakdown('pa-month-apps', appMonthDayStrs(y, m));
}

function drawBarChart(canvasId, key, labels, hours, colors) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const existing = key === 'day' ? paDayChart : paMonthChart;
  if (typeof Chart === 'undefined') return;
  if (existing) existing.destroy();
  const chart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data: hours, backgroundColor: colors, borderWidth: 0, borderRadius: 4 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => fmtHM((c.raw || 0) * 3600) } },
      },
      scales: {
        x: { ticks: { color: '#8a8f94' }, grid: { display: false } },
        y: {
          beginAtZero: true,
          ticks: { color: '#8a8f94', callback: (v) => v + 'h' },
          grid: { color: 'rgba(255,255,255,0.06)' },
        },
      },
    },
  });
  if (key === 'day') paDayChart = chart;
  else paMonthChart = chart;
}

// ---- App-usage accounting: time spent in outside apps, attributed to the running project.
// Opt-in (footer toggle), local-only, app names only. Shown as a breakdown in Day/Month.
let appTrackingEnabled = false;
let appTrackDetailed = false; // keep "app › context" buckets from the window title
let appTrackSupported = null; // null = unknown, false = platform unsupported
let appActivityDays = {}; // 'YYYY-MM-DD' -> { projectId -> { app -> secs } }
let appTrackCurrent = ''; // live foreground app (for the footer hint)

function appDayStr(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function appMonthDayStrs(y, m) {
  const out = [];
  const last = new Date(y, m + 1, 0).getDate();
  const p = (n) => String(n).padStart(2, '0');
  for (let d = 1; d <= last; d++) out.push(`${y}-${p(m + 1)}-${p(d)}`);
  return out;
}
// Merge per-app seconds across the given days (optionally filtered to one project).
function appSecsForDays(dayStrs, projectId) {
  const out = {};
  for (const day of dayStrs) {
    const D = appActivityDays[day];
    if (!D) continue;
    for (const pid of Object.keys(D)) {
      if (projectId && pid !== projectId) continue;
      const apps = D[pid];
      for (const app of Object.keys(apps)) out[app] = (out[app] || 0) + apps[app];
    }
  }
  return out;
}
function renderAppBreakdown(containerId, dayStrs) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!appTrackingEnabled) {
    el.innerHTML = '';
    return;
  }
  const secs = appSecsForDays(dayStrs);
  const apps = Object.keys(secs).sort((a, b) => secs[b] - secs[a]);
  const span = containerId.indexOf('day') >= 0 ? 'today' : 'this month';
  if (!apps.length) {
    el.innerHTML =
      '<div class="pa-apps-title">Apps</div><div class="pa-apps-empty">' +
      (appTrackSupported === false
        ? 'App tracking needs Windows or macOS.'
        : 'No app activity yet - time is collected while the timer is running.') +
      '</div>';
    return;
  }
  const max = secs[apps[0]] || 1;
  let html = `<div class="pa-apps-title">Apps ${span}</div>`;
  for (const app of apps.slice(0, 40)) {
    const pct = Math.round((secs[app] / max) * 100);
    html +=
      `<div class="pa-app-row" data-app="${escapeHtml(app)}">` +
      `<span class="pa-app-name" title="${escapeHtml(app)}">${escapeHtml(app)}</span>` +
      `<span class="pa-app-bar"><span class="pa-app-fill" style="width:${pct}%"></span></span>` +
      `<span class="pa-app-time">${fmtHM(secs[app])}</span>` +
      `<button class="pa-app-x" title="Remove this entry's tracked time">✕</button>` +
      '</div>';
  }
  el.innerHTML = html;
  el._days = dayStrs.slice(); // remember which days this breakdown covers (for row removal)
  if (!el._removeWired) {
    el._removeWired = true;
    el.addEventListener('click', (e) => {
      const x = e.target.closest('.pa-app-x');
      if (!x) return;
      const row = x.closest('.pa-app-row');
      if (row) removeAppEntry(row.dataset.app, el._days || []);
    });
  }
}
async function removeAppEntry(app, days) {
  if (!app) return;
  try {
    await api.apptrackRemove(app, days);
  } catch (_) {
    /* ignore */
  }
  refreshAppActivity(); // re-pull and re-render the breakdown
}
// Draggable split between the project list (bars) and the apps breakdown on the Day tab.
// The offset (px) is transferred from the apps pane to the list pane: drag down = more
// room for the bars, drag up = more room for the apps list. Persisted.
let paSplitOffset = 0;
const PA_LIST_BASE = 220;
const PA_APPS_BASE = 190;
function applyPaSplit() {
  const list = document.getElementById('pa-day-list');
  const apps = document.getElementById('pa-day-apps');
  paSplitOffset = Math.max(-(PA_LIST_BASE - 60), Math.min(PA_APPS_BASE - 60, paSplitOffset));
  if (list) list.style.maxHeight = PA_LIST_BASE + paSplitOffset + 'px';
  if (apps) apps.style.maxHeight = PA_APPS_BASE - paSplitOffset + 'px';
}

function renderAppPanelsForTab() {
  const tab = document.getElementById('project-overlay').dataset.tab || 'day';
  if (tab === 'day') renderAppBreakdown('pa-day-apps', [appDayStr(Date.now())]);
  else if (tab === 'month') renderAppBreakdown('pa-month-apps', appMonthDayStrs(paMonthRef.y, paMonthRef.m));
}
let _appActBusy = false;
async function refreshAppActivity() {
  if (_appActBusy) return;
  _appActBusy = true;
  try {
    const r = await api.apptrackGetState();
    if (r && r.ok) {
      appActivityDays = r.days || {};
      appTrackSupported = r.supported;
    }
  } catch (_) {
    /* ignore */
  }
  _appActBusy = false;
  renderAppPanelsForTab();
}
function updateAppTrackHint() {
  const cb = document.getElementById('pa-apptrack-cb');
  if (cb) cb.checked = appTrackingEnabled;
  const dcb = document.getElementById('pa-apptrack-detail-cb');
  if (dcb) {
    dcb.checked = appTrackDetailed;
    dcb.disabled = !appTrackingEnabled;
  }
  const dlabel = document.getElementById('pa-apptrack-detail');
  if (dlabel) dlabel.classList.toggle('disabled', !appTrackingEnabled);
  const hint = document.getElementById('pa-apptrack-hint');
  if (!hint) return;
  if (!appTrackingEnabled) hint.textContent = '';
  else if (appTrackSupported === false) hint.textContent = 'needs Windows/macOS';
  else if (appTrackCurrent) hint.textContent = 'now: ' + appTrackCurrent;
  else hint.textContent = 'on';
}
async function toggleAppTracking(on) {
  appTrackingEnabled = !!on;
  api.saveSettings({ appTrackingEnabled });
  const r = await api.apptrackSetEnabled(appTrackingEnabled, 5, appTrackDetailed);
  if (r) appTrackSupported = r.supported;
  updateAppTrackHint();
  refreshAppActivity();
}
function setAppTrackDetailed(on) {
  appTrackDetailed = !!on;
  api.saveSettings({ appTrackDetailed });
  api.apptrackSetEnabled(appTrackingEnabled, 5, appTrackDetailed); // push the mode to the tracker
  updateAppTrackHint();
}
api.onApptrackSample(({ app, tracked }) => {
  appTrackCurrent = tracked ? app : '';
  if (
    appTrackingEnabled &&
    document.getElementById('project-overlay') &&
    !document.getElementById('project-overlay').classList.contains('hidden')
  ) {
    updateAppTrackHint();
  }
});

// ---------------------------------------------------------------------------
// Cockpit Wrapped - a story-style animated recap of your work, computed entirely
// from data already collected: project segments, app usage, and the Black Box
// timeline (commands, messages, meetings, focus). Exportable as a shareable PNG.
// ---------------------------------------------------------------------------
const WRAPPED_RANGES = { week: { days: 7, label: 'week' }, month: { days: 30, label: 'month' }, year: { days: 365, label: 'year' } };
let wrappedRange = 'week';
let wrappedSlides = [];
let wrappedIdx = 0;
let wrappedTimer = null;
let wrappedStats = null;
let wrappedAuto = true; // auto-advance the story; turned off once you navigate by hand

function wPad2(n) {
  return String(n).padStart(2, '0');
}
function wDayStr(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${wPad2(d.getMonth() + 1)}-${wPad2(d.getDate())}`;
}
function wRangeDates(from, to) {
  const o = { month: 'short', day: 'numeric' };
  return new Date(from).toLocaleDateString([], o) + ' - ' + new Date(to).toLocaleDateString([], o);
}
// Reduce a command line to a tally key: basename of argv0, plus the subcommand for
// multiplexers (git push, docker run, kubectl get, …).
function wCmdKey(title) {
  if (!title) return '';
  const t = String(title).trim().replace(/^\s*(sudo|time|nohup|env)\s+/, '');
  const parts = t.split(/\s+/);
  let p0 = (parts[0] || '').split('/').pop();
  if (!p0 || /[^\w.+\-]/.test(p0)) return p0 ? p0.slice(0, 22) : '';
  const multi = ['git', 'docker', 'kubectl', 'npm', 'yarn', 'pnpm', 'cargo', 'systemctl', 'apt', 'apt-get', 'yum', 'dnf', 'brew', 'pip', 'pip3', 'go', 'make', 'terraform'];
  if (multi.includes(p0) && parts[1] && /^[\w:-]+$/.test(parts[1])) return (p0 + ' ' + parts[1]).slice(0, 22);
  return p0.slice(0, 22);
}

async function computeWrapped(rangeKey) {
  const days = WRAPPED_RANGES[rangeKey].days;
  const to = Date.now();
  const from = to - days * 86400000;
  let proj = { projects: [], segments: [] };
  let appState = { days: {} };
  let events = [];
  try {
    const r = await api.projectGetState();
    if (r && r.ok) proj = r;
  } catch (_) {
    /* ignore */
  }
  try {
    const r = await api.apptrackGetState();
    if (r && r.ok) appState = r;
  } catch (_) {
    /* ignore */
  }
  try {
    const r = await api.blackboxQuery({ from, to, limit: 100000 });
    if (r && r.ok) events = r.events || [];
  } catch (_) {
    /* ignore */
  }
  const pName = (id) => (proj.projects.find((p) => p.id === id) || {}).name || 'Unknown';
  const pColor = (id) => (proj.projects.find((p) => p.id === id) || {}).color || '#4ea1ff';
  // Project time within the window + per-day totals for the streak.
  const pmap = {};
  const dayTotals = {};
  let total = 0;
  for (const s of proj.segments) {
    const end = s.open ? to : s.end;
    const a = Math.max(s.start, from);
    const b = Math.min(end, to);
    if (b > a) {
      const secs = (b - a) / 1000;
      pmap[s.projectId] = (pmap[s.projectId] || 0) + secs;
      total += secs;
      dayTotals[wDayStr(a)] = (dayTotals[wDayStr(a)] || 0) + secs;
    }
  }
  const topProjects = Object.keys(pmap)
    .map((id) => ({ id, name: pName(id), color: pColor(id), secs: pmap[id] }))
    .sort((a, b) => b.secs - a.secs);
  let streak = 0;
  for (let i = 0; i < days; i++) {
    if ((dayTotals[wDayStr(to - i * 86400000)] || 0) > 60) streak++;
    else break;
  }
  const activeDays = Object.values(dayTotals).filter((v) => v > 60).length;
  // Apps within the window.
  const appSecs = {};
  for (let i = 0; i < days; i++) {
    const D = appState.days && appState.days[wDayStr(to - i * 86400000)];
    if (!D) continue;
    for (const pid of Object.keys(D)) for (const app of Object.keys(D[pid])) appSecs[app] = (appSecs[app] || 0) + D[pid][app];
  }
  const topApps = Object.keys(appSecs).map((a) => ({ name: a, secs: appSecs[a] })).sort((a, b) => b.secs - a.secs);
  // Black Box: commands, hosts, comms, meetings, focus, busiest hour.
  const cmdTally = {};
  const hosts = new Set();
  const hourHist = new Array(24).fill(0);
  let cmds = 0;
  let msgs = 0;
  let meetings = 0;
  let focus = 0;
  let notes = 0;
  for (const e of events) {
    if (!e) continue;
    hourHist[new Date(e.ts).getHours()]++;
    if (e.kind === 'cmd') {
      cmds++;
      if (e.host) hosts.add(e.host);
      const k = wCmdKey(e.title);
      if (k) cmdTally[k] = (cmdTally[k] || 0) + 1;
    } else if (e.kind === 'slack' || e.kind === 'whatsapp' || e.kind === 'mail') msgs++;
    else if (e.kind === 'meeting') meetings++;
    else if (e.kind === 'note') notes++;
    else if (e.kind === 'system' && /Focus started/.test(e.title || '')) focus++;
  }
  const topCommands = Object.keys(cmdTally).map((k) => ({ name: k, n: cmdTally[k] })).sort((a, b) => b.n - a.n);
  let busiestHour = -1;
  let mx = 0;
  for (let h = 0; h < 24; h++) if (hourHist[h] > mx) {
    mx = hourHist[h];
    busiestHour = h;
  }
  return { rangeKey, from, to, total, topProjects, activeDays, streak, topApps, cmds, topCommands, hosts: hosts.size, msgs, meetings, focus, notes, busiestHour, hourHist };
}

function wrBarList(items) {
  const max = Math.max(1, ...items.map((i) => i.val));
  return (
    '<div class="wr-bars">' +
    items
      .map((i) => {
        const pct = Math.max(4, Math.round((i.val / max) * 100));
        const val = i.fmt === 'dur' ? fmtHM(i.val) : i.fmt === 'x' ? i.val + '×' : i.val;
        return (
          '<div class="wr-bar"><span class="wr-bar-name">' +
          escapeHtml(i.name) +
          '</span><span class="wr-bar-track"><span class="wr-bar-fill" style="width:' +
          pct +
          '%;background:' +
          (i.color || 'var(--accent,#5cc7ff)') +
          '"></span></span><span class="wr-bar-val">' +
          val +
          '</span></div>'
        );
      })
      .join('') +
    '</div>'
  );
}
function wrHourBars(hist, peak) {
  const max = Math.max(1, ...hist);
  return (
    '<div class="wr-hours">' +
    hist
      .map((v, h) => `<span class="wr-hour${h === peak ? ' peak' : ''}" style="height:${Math.max(6, Math.round((v / max) * 100))}%"></span>`)
      .join('') +
    '</div>'
  );
}

function buildWrappedSlides(s) {
  const R = WRAPPED_RANGES[s.rangeKey].label;
  const slides = [];
  slides.push({ html: `<div class="wr-kicker">🎁 Cockpit Wrapped</div><div class="wr-big">Your ${R}</div><div class="wr-sub">${wRangeDates(s.from, s.to)}</div>` });
  if (s.total > 60)
    slides.push({ html: `<div class="wr-label">You tracked</div><div class="wr-big wr-count" data-to="${Math.round(s.total)}" data-fmt="dur">0</div><div class="wr-sub">${s.topProjects.length} project${s.topProjects.length === 1 ? '' : 's'} · ${s.activeDays} active day${s.activeDays === 1 ? '' : 's'}</div>` });
  if (s.topProjects.length)
    slides.push({ html: `<div class="wr-label">Top projects</div>` + wrBarList(s.topProjects.slice(0, 6).map((p) => ({ name: p.name, val: p.secs, color: p.color, fmt: 'dur' }))) });
  if (s.topApps.length)
    slides.push({ html: `<div class="wr-label">Where you worked</div>` + wrBarList(s.topApps.slice(0, 6).map((a) => ({ name: a.name, val: a.secs, fmt: 'dur' }))) });
  if (s.cmds)
    slides.push({ html: `<div class="wr-label">You ran</div><div class="wr-big wr-count" data-to="${s.cmds}">0</div><div class="wr-sub">commands across ${s.hosts} host${s.hosts === 1 ? '' : 's'}</div>` + (s.topCommands.length ? wrBarList(s.topCommands.slice(0, 5).map((c) => ({ name: c.name, val: c.n, fmt: 'x' }))) : '') });
  if (s.busiestHour >= 0)
    slides.push({ html: `<div class="wr-label">Your power hour</div><div class="wr-big">${wPad2(s.busiestHour)}:00</div><div class="wr-sub">when you were most active</div>` + wrHourBars(s.hourHist, s.busiestHour) });
  if (s.focus || s.streak > 1)
    slides.push({ html: `<div class="wr-label">Deep work</div><div class="wr-big wr-count" data-to="${s.focus}">0</div><div class="wr-sub">focus session${s.focus === 1 ? '' : 's'}</div>` + (s.streak > 1 ? `<div class="wr-streak">🔥 ${s.streak}-day streak</div>` : '') });
  if (s.msgs || s.meetings)
    slides.push({ html: `<div class="wr-label">Staying in touch</div><div class="wr-row2"><div><div class="wr-mid wr-count" data-to="${s.msgs}">0</div><div class="wr-sub">messages</div></div><div><div class="wr-mid wr-count" data-to="${s.meetings}">0</div><div class="wr-sub">meetings</div></div></div>` });
  slides.push({ finale: true });
  return slides;
}

function wrappedFinaleHtml(s) {
  const item = (icon, label, val) =>
    val == null ? '' : `<div class="wr-fin-item"><span class="wr-fin-ico">${icon}</span><span class="wr-fin-label">${label}</span><span class="wr-fin-val">${escapeHtml(String(val))}</span></div>`;
  let html = `<div class="wr-kicker">That was your ${WRAPPED_RANGES[s.rangeKey].label}</div><div class="wr-fin-grid">`;
  html += item('⏱', 'Tracked', fmtHM(s.total));
  if (s.topProjects[0]) html += item('🏆', 'Top project', s.topProjects[0].name);
  if (s.topApps[0]) html += item('🖥', 'Top app', s.topApps[0].name);
  if (s.cmds) html += item('⌨', 'Commands', s.cmds + ' · ' + s.hosts + ' hosts');
  if (s.topCommands[0]) html += item('➤', 'Top command', s.topCommands[0].name + ' ×' + s.topCommands[0].n);
  if (s.busiestHour >= 0) html += item('⚡', 'Power hour', wPad2(s.busiestHour) + ':00');
  if (s.focus) html += item('🎯', 'Focus', s.focus + (s.streak > 1 ? ' · 🔥' + s.streak + 'd' : ''));
  if (s.msgs || s.meetings) html += item('💬', 'Comms', s.msgs + ' msg · ' + s.meetings + ' mtg');
  html += '</div><div class="wr-fin-actions"><button class="wr-save">💾 Save image</button><button class="wr-copy">📋 Copy</button><button class="wr-again">↻ Replay</button></div><div class="wr-fin-note"></div>';
  return html;
}

function animateWrCounts(stage) {
  stage.querySelectorAll('.wr-count').forEach((el) => {
    const target = Number(el.dataset.to) || 0;
    const fmt = el.dataset.fmt;
    const fmtv = (v) => (fmt === 'dur' ? fmtHM(v) : String(Math.round(v)));
    const dur = 900;
    let start = null;
    const step = (ts) => {
      if (start == null) start = ts;
      const t = Math.min(1, (ts - start) / dur);
      el.textContent = fmtv(target * (1 - Math.pow(1 - t, 3)));
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = fmtv(target);
    };
    requestAnimationFrame(step);
  });
}

function buildWrappedOverlay() {
  let ov = document.getElementById('wrapped-overlay');
  if (ov) return ov;
  ov = document.createElement('div');
  ov.id = 'wrapped-overlay';
  ov.className = 'hidden';
  ov.innerHTML =
    '<div class="wr-card">' +
    '<div class="wr-top"><div class="wr-progress"></div>' +
    '<div class="wr-ranges"><button data-r="week">Week</button><button data-r="month">Month</button><button data-r="year">Year</button></div>' +
    '<button class="wr-close" title="Close (Esc)">✕</button></div>' +
    '<div class="wr-stage"></div>' +
    '</div>';
  document.body.appendChild(ov);
  ov.querySelector('.wr-close').addEventListener('click', closeWrapped);
  ov.addEventListener('mousedown', (e) => {
    if (e.target === ov) closeWrapped();
  });
  ov.querySelectorAll('.wr-ranges button').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      wrappedRange = b.dataset.r;
      loadWrapped();
    });
  });
  // Click a progress pip to jump straight to that slide (and stop auto-advancing).
  ov.querySelector('.wr-progress').addEventListener('click', (e) => {
    const pip = e.target.closest('.wr-pip');
    if (!pip) return;
    e.stopPropagation();
    wrappedAuto = false;
    showWrappedSlide(Number(pip.dataset.i));
  });
  // Click the stage to advance (left edge goes back); finale ignores (has buttons).
  ov.querySelector('.wr-stage').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const slide = wrappedSlides[wrappedIdx];
    if (slide && slide.finale) return;
    const rect = ov.querySelector('.wr-stage').getBoundingClientRect();
    if (e.clientX - rect.left < rect.width * 0.25) showWrappedSlide(wrappedIdx - 1);
    else showWrappedSlide(wrappedIdx + 1);
  });
  document.addEventListener('keydown', (e) => {
    if (ov.classList.contains('hidden')) return;
    if (e.key === 'Escape') closeWrapped();
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      wrappedAuto = false; // manual navigation: stop the auto-progress
      showWrappedSlide(wrappedIdx + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      wrappedAuto = false;
      showWrappedSlide(wrappedIdx - 1);
    } else if (e.key === ' ') {
      e.preventDefault();
      showWrappedSlide(wrappedIdx + 1); // space taps forward but leaves auto-play on
    }
  });
  return ov;
}

function showWrappedSlide(i) {
  const ov = document.getElementById('wrapped-overlay');
  if (!ov || !wrappedSlides.length) return;
  clearTimeout(wrappedTimer);
  i = Math.max(0, Math.min(wrappedSlides.length - 1, i));
  wrappedIdx = i;
  const slide = wrappedSlides[i];
  const stage = ov.querySelector('.wr-stage');
  stage.innerHTML = '<div class="wr-slide">' + (slide.finale ? wrappedFinaleHtml(wrappedStats) : slide.html) + '</div>';
  animateWrCounts(stage);
  // progress pips
  const prog = ov.querySelector('.wr-progress');
  prog.innerHTML = wrappedSlides.map((_, k) => `<span class="wr-pip${k <= i ? ' on' : ''}" data-i="${k}"></span>`).join('');
  // active range button
  ov.querySelectorAll('.wr-ranges button').forEach((b) => b.classList.toggle('on', b.dataset.r === wrappedRange));
  if (slide.finale) {
    stage.querySelector('.wr-save').addEventListener('click', wrappedSaveImage);
    stage.querySelector('.wr-copy').addEventListener('click', (e) => {
      wrappedCopyText();
      e.target.textContent = '✓ Copied';
    });
    stage.querySelector('.wr-again').addEventListener('click', () => showWrappedSlide(0));
  } else if (wrappedAuto) {
    wrappedTimer = setTimeout(() => showWrappedSlide(wrappedIdx + 1), 4500);
  }
}

async function loadWrapped() {
  const ov = buildWrappedOverlay();
  const stage = ov.querySelector('.wr-stage');
  stage.innerHTML = '<div class="wr-slide"><div class="wr-sub">Crunching your ' + WRAPPED_RANGES[wrappedRange].label + '…</div></div>';
  wrappedStats = await computeWrapped(wrappedRange);
  wrappedSlides = buildWrappedSlides(wrappedStats);
  showWrappedSlide(0);
}
function openWrapped() {
  wrappedRange = 'week';
  wrappedAuto = true; // fresh open: resume the auto-advancing story
  const ov = buildWrappedOverlay();
  ov.classList.remove('hidden');
  loadWrapped();
}
function closeWrapped() {
  clearTimeout(wrappedTimer);
  const ov = document.getElementById('wrapped-overlay');
  if (ov) ov.classList.add('hidden');
}

function wrappedCopyText() {
  const s = wrappedStats;
  if (!s) return;
  const L = ['🎁 Cockpit Wrapped - your ' + WRAPPED_RANGES[s.rangeKey].label, '⏱ ' + fmtHM(s.total) + ' tracked across ' + s.topProjects.length + ' projects'];
  if (s.topProjects[0]) L.push('🏆 top project: ' + s.topProjects[0].name + ' (' + fmtHM(s.topProjects[0].secs) + ')');
  if (s.topApps[0]) L.push('🖥 top app: ' + s.topApps[0].name + ' (' + fmtHM(s.topApps[0].secs) + ')');
  if (s.cmds) L.push('⌨ ' + s.cmds + ' commands on ' + s.hosts + ' hosts' + (s.topCommands[0] ? ' (top: ' + s.topCommands[0].name + ' ×' + s.topCommands[0].n + ')' : ''));
  if (s.busiestHour >= 0) L.push('⚡ power hour: ' + wPad2(s.busiestHour) + ':00');
  if (s.focus) L.push('🎯 ' + s.focus + ' focus sessions' + (s.streak > 1 ? ' · 🔥 ' + s.streak + '-day streak' : ''));
  if (s.msgs || s.meetings) L.push('💬 ' + s.msgs + ' messages · 📅 ' + s.meetings + ' meetings');
  api.clipboardWrite(L.join('\n'));
}

async function wrappedSaveImage() {
  const s = wrappedStats;
  if (!s) return;
  const c = document.createElement('canvas');
  c.width = 1080;
  c.height = 1350;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 1080, 1350);
  grad.addColorStop(0, '#12203a');
  grad.addColorStop(1, '#2a1140');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1080, 1350);
  g.fillStyle = '#7cd6ff';
  g.font = 'bold 46px Segoe UI, Arial, sans-serif';
  g.fillText('🎁 COCKPIT WRAPPED', 80, 130);
  g.fillStyle = '#c7d3e0';
  g.font = '28px Segoe UI, Arial, sans-serif';
  g.fillText('Your ' + WRAPPED_RANGES[s.rangeKey].label + ' · ' + wRangeDates(s.from, s.to), 80, 178);
  g.fillStyle = '#ffffff';
  g.font = 'bold 128px Segoe UI, Arial, sans-serif';
  g.fillText(fmtHM(s.total), 80, 330);
  g.fillStyle = '#9fb3c8';
  g.font = '30px Segoe UI, Arial, sans-serif';
  g.fillText('tracked across ' + s.topProjects.length + ' project' + (s.topProjects.length === 1 ? '' : 's'), 80, 384);
  let y = 500;
  const line = (label, val) => {
    if (val == null) return;
    g.fillStyle = '#9fb3c8';
    g.font = '32px Segoe UI, Arial, sans-serif';
    g.textAlign = 'left';
    g.fillText(label, 80, y);
    g.fillStyle = '#ffffff';
    g.textAlign = 'right';
    g.fillText(String(val), 1000, y);
    y += 74;
  };
  if (s.topProjects[0]) line('Top project', s.topProjects[0].name + ' · ' + fmtHM(s.topProjects[0].secs));
  if (s.topApps[0]) line('Top app', s.topApps[0].name + ' · ' + fmtHM(s.topApps[0].secs));
  if (s.cmds) line('Commands', s.cmds + ' on ' + s.hosts + ' hosts');
  if (s.topCommands[0]) line('Top command', s.topCommands[0].name + ' ×' + s.topCommands[0].n);
  if (s.busiestHour >= 0) line('Power hour', wPad2(s.busiestHour) + ':00');
  if (s.focus) line('Focus sessions', String(s.focus) + (s.streak > 1 ? '  (🔥' + s.streak + 'd)' : ''));
  if (s.msgs || s.meetings) line('Messages / Meetings', s.msgs + ' / ' + s.meetings);
  g.textAlign = 'left';
  g.fillStyle = '#5a6b7d';
  g.font = '24px Segoe UI, Arial, sans-serif';
  g.fillText('made with Cockpit', 80, 1290);
  const note = document.querySelector('#wrapped-overlay .wr-fin-note');
  try {
    const b64 = c.toDataURL('image/png').split(',')[1];
    const r = await api.saveBase64('cockpit-wrapped.png', b64);
    if (note) note.textContent = r && r.ok ? 'Saved to ' + r.savedTo : r && r.canceled ? '' : 'Could not save image';
  } catch (e) {
    if (note) note.textContent = 'Could not save image';
  }
}

{
  const widget = document.getElementById('project-widget');
  if (widget) {
    widget.addEventListener('click', (e) => {
      if (e.target.id === 'pw-stop') {
        setProjectRunning(!paRunning);
        return;
      }
      openProjectOverlay();
    });
    document.getElementById('pa-close').addEventListener('click', closeProjectOverlay);
    document.getElementById('pa-undo-btn').addEventListener('click', paUndoLast);
    const appCb = document.getElementById('pa-apptrack-cb');
    if (appCb) appCb.addEventListener('change', () => toggleAppTracking(appCb.checked));
    const appDetailCb = document.getElementById('pa-apptrack-detail-cb');
    if (appDetailCb) appDetailCb.addEventListener('change', () => setAppTrackDetailed(appDetailCb.checked));
    const wrapBtn = document.getElementById('pa-wrapped');
    if (wrapBtn) wrapBtn.addEventListener('click', openWrapped);
    const paSplit = document.getElementById('pa-day-split');
    if (paSplit) {
      paSplit.addEventListener('pointerdown', (e) => {
        const sy = e.clientY;
        const o0 = paSplitOffset;
        const move = (ev) => {
          paSplitOffset = o0 + (ev.clientY - sy);
          applyPaSplit();
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          api.saveSettings({ paSplitOffset });
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        e.preventDefault();
      });
    }
    // Drag the panel by its header; double-click the header re-centers it.
    const paHead = document.querySelector('#project-panel .pa-head');
    if (paHead) {
      paHead.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button, .pa-tab, select, input')) return; // let controls work
        const sx = e.clientX, sy = e.clientY;
        const ox = paPanelOffset.x, oy = paPanelOffset.y;
        const move = (ev) => {
          paPanelOffset.x = ox + (ev.clientX - sx);
          paPanelOffset.y = oy + (ev.clientY - sy);
          applyPanelOffset();
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        e.preventDefault();
      });
      paHead.addEventListener('dblclick', (e) => {
        if (e.target.closest('button, .pa-tab, select, input')) return;
        paPanelOffset = { x: 0, y: 0 };
        applyPanelOffset();
      });
    }
    document.getElementById('pa-tab-day').addEventListener('click', () => showProjectTab('day'));
    document.getElementById('pa-tab-month').addEventListener('click', () => showProjectTab('month'));
    document.getElementById('pa-tab-log').addEventListener('click', async () => {
      await reloadSegments(); // pull the store's authoritative segments (with ids) before editing
      showProjectTab('log');
    });
    document.getElementById('pa-ent-prev').addEventListener('click', () => entShiftDay(-1));
    document.getElementById('pa-ent-next').addEventListener('click', () => entShiftDay(1));
    document.getElementById('pa-ent-add').addEventListener('click', () => openEntryForm(null));
    document.getElementById('pa-new-btn').addEventListener('click', addProjectFromInput);
    document.getElementById('pa-new-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addProjectFromInput();
    });
    document.getElementById('pa-month-prev').addEventListener('click', () => {
      paMonthRef.m--;
      if (paMonthRef.m < 0) { paMonthRef.m = 11; paMonthRef.y--; }
      renderProjectMonth();
    });
    document.getElementById('pa-month-next').addEventListener('click', () => {
      paMonthRef.m++;
      if (paMonthRef.m > 11) { paMonthRef.m = 0; paMonthRef.y++; }
      renderProjectMonth();
    });
    // Click backdrop / Esc to close.
    document.getElementById('project-overlay').addEventListener('mousedown', (e) => {
      if (e.target.id === 'project-overlay') closeProjectOverlay();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('project-overlay').classList.contains('hidden')) closeProjectOverlay();
      // Ctrl+U reverts the last time move when the accounting overlay or Black Box is open.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'u' || e.key === 'U') && paUndo.length) {
        const overlayOpen = !document.getElementById('project-overlay').classList.contains('hidden');
        if (overlayOpen || bbOpen) {
          e.preventDefault();
          paUndoLast();
        }
      }
    });
    initProjects();
  }
}

// ---------------------------------------------------------------------------
// SFTP file panel (reuses the active SSH tab's connection)
// ---------------------------------------------------------------------------
let sftpOpen = false;

function activeSshRec() {
  const rec = activeTabId ? tabs.get(activeTabId) : null;
  return rec && rec.kind === 'ssh' ? rec : null;
}

function joinRemote(base, name) {
  if (name === '..') {
    const p = base.replace(/\/+$/, '');
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }
  return (base.endsWith('/') ? base : base + '/') + name;
}

function fmtSize(n) {
  if (n == null) return '';
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return (i ? v.toFixed(1) : v) + u[i];
}

function openSftp() {
  sftpOpen = true;
  els.sftpPanel.classList.remove('hidden');
  refreshSftpForActive();
}
function closeSftp() {
  sftpOpen = false;
  els.sftpPanel.classList.add('hidden');
}

function refreshSftpForActive() {
  if (!sftpOpen) return;
  const rec = activeSshRec();
  if (!rec) {
    els.sftpPath.textContent = '';
    els.sftpListEl.innerHTML = '';
    els.sftpStatus.textContent = 'Open an SSH tab to browse its files.';
    return;
  }
  loadSftp(rec);
}

async function loadSftp(rec) {
  els.sftpStatus.textContent = 'Loading…';
  const res = await api.sftpList(rec.id, rec.sftpCwd || '.');
  if (!res || !res.ok) {
    els.sftpStatus.textContent = (res && res.error) || 'Failed to list directory.';
    return;
  }
  rec.sftpCwd = res.path;
  renderSftp(rec, res.entries);
}

function renderSftp(rec, entries) {
  els.sftpPath.textContent = rec.sftpCwd;
  els.sftpListEl.innerHTML = '';
  els.sftpStatus.textContent = `${entries.length} item${entries.length === 1 ? '' : 's'}`;

  const addRow = (label, isDir, entry) => {
    const row = document.createElement('div');
    row.className = 'sftp-row';
    const icon = document.createElement('span');
    icon.textContent = isDir ? '📁' : entry && entry.isLink ? '🔗' : '📄';
    const name = document.createElement('span');
    name.className = 'sftp-name';
    name.textContent = label;
    const size = document.createElement('span');
    size.className = 'sftp-size';
    size.textContent = entry && !isDir ? fmtSize(entry.size) : '';
    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(size);

    if (entry) {
      const actions = document.createElement('span');
      actions.className = 'sftp-actions';
      if (!isDir) {
        const dl = document.createElement('button');
        dl.textContent = '⬇';
        dl.title = 'Download';
        dl.addEventListener('click', async (e) => {
          e.stopPropagation();
          els.sftpStatus.textContent = 'Downloading…';
          const r = await api.sftpDownload(rec.id, joinRemote(rec.sftpCwd, label), label);
          els.sftpStatus.textContent = r.ok
            ? 'Saved: ' + r.savedTo
            : r.canceled
            ? 'Download canceled.'
            : 'Download failed: ' + r.error;
        });
        actions.appendChild(dl);
      }
      const del = document.createElement('button');
      del.className = 'sftp-del';
      del.textContent = '🗑';
      del.title = isDir ? 'Delete folder' : 'Delete file';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!window.confirm(`Delete ${isDir ? 'folder' : 'file'} "${label}"?`)) return;
        const r = await api.sftpDelete(rec.id, joinRemote(rec.sftpCwd, label), isDir);
        if (r.ok) loadSftp(rec);
        else els.sftpStatus.textContent = 'Delete failed: ' + r.error;
      });
      actions.appendChild(del);
      row.appendChild(actions);
    }

    if (isDir) {
      row.addEventListener('click', () => {
        rec.sftpCwd = joinRemote(rec.sftpCwd, label);
        loadSftp(rec);
      });
    }
    els.sftpListEl.appendChild(row);
  };

  if (rec.sftpCwd !== '/') addRow('..', true, null);
  const dirs = entries.filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter((e) => !e.isDir).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of dirs) addRow(e.name, true, e);
  for (const e of files) addRow(e.name, false, e);
}

// Drag-and-drop upload. file.path is the local filesystem path (Electron).
function pathsFromDrop(e) {
  return Array.from((e.dataTransfer && e.dataTransfer.files) || [])
    .map((f) => f.path)
    .filter(Boolean);
}

async function uploadDropped(rec, paths) {
  if (!rec || !paths.length) return;
  els.sftpStatus.textContent = `Uploading ${paths.length} file(s)…`;
  const r = await api.sftpUploadPaths(rec.id, rec.sftpCwd || '.', paths);
  if (r.ok) {
    els.sftpStatus.textContent = 'Uploaded: ' + r.uploaded.join(', ');
    if (rec === activeSshRec()) loadSftp(rec);
  } else {
    els.sftpStatus.textContent = 'Upload failed: ' + r.error;
  }
}

// Prevent a stray file drop from navigating the whole window.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

els.sftpPanel.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.sftpPanel.classList.add('drag-over');
});
els.sftpPanel.addEventListener('dragleave', (e) => {
  if (e.target === els.sftpPanel) els.sftpPanel.classList.remove('drag-over');
});
els.sftpPanel.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  els.sftpPanel.classList.remove('drag-over');
  const rec = activeSshRec();
  if (!rec) {
    els.sftpStatus.textContent = 'Open an SSH tab to upload.';
    return;
  }
  await uploadDropped(rec, pathsFromDrop(e));
});

els.sftpBtn.addEventListener('click', () => (sftpOpen ? closeSftp() : openSftp()));
els.sftpClose.addEventListener('click', closeSftp);
els.sftpRefresh.addEventListener('click', refreshSftpForActive);
els.sftpUp.addEventListener('click', () => {
  const rec = activeSshRec();
  if (rec) {
    rec.sftpCwd = joinRemote(rec.sftpCwd || '/', '..');
    loadSftp(rec);
  }
});
els.sftpUpload.addEventListener('click', async () => {
  const rec = activeSshRec();
  if (!rec) return;
  els.sftpStatus.textContent = 'Uploading…';
  const r = await api.sftpUpload(rec.id, rec.sftpCwd || '.');
  if (r.ok) {
    els.sftpStatus.textContent = 'Uploaded: ' + r.uploaded.join(', ');
    loadSftp(rec);
  } else {
    els.sftpStatus.textContent = r.canceled ? 'Upload canceled.' : 'Upload failed: ' + r.error;
  }
});

// ---------------------------------------------------------------------------
// Google: Gmail strip + Calendar bar
// ---------------------------------------------------------------------------
let googleConnected = false;
let googleEmail = null;
let meetingChime = true;
let upcomingEvents = [];
const TITLE_BASE = 'Cockpit';
let titleText = TITLE_BASE; // current desired title
let titleAnimate = false; // bounce it (last 5 min before a meeting)
let titlePhase = 0;

// Shift the title left/right with a triangle wave of leading spaces.
function bounceTitle(text, phase) {
  const amp = 8;
  const p = phase % (amp * 2);
  const spaces = p <= amp ? p : amp * 2 - p;
  return ' '.repeat(spaces) + text;
}
// One writer for document.title: animate when flagged, else show it static.
setInterval(() => {
  if (titleAnimate) document.title = bounceTitle(titleText, ++titlePhase);
  else document.title = titleText;
}, 500);

// A short ascending arpeggio to announce an upcoming meeting (no audio file).
function playMeetingChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    // C5 E5 G5 C6, then a soft echo of the top note.
    const notes = [523.25, 659.25, 783.99, 1046.5, 1046.5];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      const t = now + i * 0.16;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(i === 4 ? 0.12 : 0.28, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.55);
    });
    setTimeout(() => ctx.close(), 1600);
  } catch (_) {
    /* audio unavailable */
  }
}
// A warm bell: a struck tone with inharmonic partials and a long decay, rung a few times.
function playBell(strikes) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const base = 660; // ~E5
    const partials = [1, 2.0, 2.98, 4.02, 5.4];
    const rel = [1, 0.5, 0.34, 0.22, 0.12];
    const n = strikes || 3;
    for (let s = 0; s < n; s++) {
      const t0 = now + s * 0.62;
      partials.forEach((p, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = base * p;
        const peak = 0.22 * rel[i];
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.4);
        o.connect(g).connect(ctx.destination);
        o.start(t0);
        o.stop(t0 + 1.5);
      });
    }
    setTimeout(() => ctx.close(), (n * 0.62 + 1.6) * 1000);
  } catch (_) {
    /* audio unavailable */
  }
}

// --- Countdown timer (below the TZ panel): configure h/m, counts down, rings a bell ---
let tztEndAt = 0;
let tztRemain = 0; // seconds
let tztTotal = 0;
let tztTimer = null;
let tztRunning = false;
function tztFmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
function tztRender() {
  const d = document.getElementById('tzt-display');
  if (d) d.textContent = tztFmt(tztRemain);
  const b = document.getElementById('tzt-start');
  if (b) b.textContent = tztRunning ? '⏸ Pause' : tztRemain > 0 ? '▶ Resume' : '▶ Start';
}
function tztTick() {
  tztRemain = Math.max(0, Math.round((tztEndAt - Date.now()) / 1000));
  if (tztRemain <= 0) {
    tztRender();
    tztFinish();
    return;
  }
  tztRender();
}
function tztStartPause() {
  if (tztRunning) {
    clearInterval(tztTimer);
    tztTimer = null;
    tztRunning = false;
    tztRender();
    return;
  }
  if (tztRemain <= 0) {
    const h = Math.max(0, parseInt((document.getElementById('tzt-h') || {}).value, 10) || 0);
    const m = Math.max(0, parseInt((document.getElementById('tzt-m') || {}).value, 10) || 0);
    tztRemain = h * 3600 + m * 60;
    tztTotal = tztRemain;
  }
  if (tztRemain <= 0) return; // nothing configured
  const d = document.getElementById('tzt-display');
  if (d) d.classList.remove('ringing');
  tztEndAt = Date.now() + tztRemain * 1000;
  tztRunning = true;
  tztRender();
  clearInterval(tztTimer);
  tztTimer = setInterval(tztTick, 250);
}
function tztReset() {
  clearInterval(tztTimer);
  tztTimer = null;
  tztRunning = false;
  tztRemain = 0;
  tztTotal = 0;
  const d = document.getElementById('tzt-display');
  if (d) d.classList.remove('ringing');
  tztRender();
}
function tztFinish() {
  clearInterval(tztTimer);
  tztTimer = null;
  tztRunning = false;
  tztRemain = 0;
  const d = document.getElementById('tzt-display');
  if (d) {
    d.textContent = '00:00:00';
    d.classList.add('ringing');
  }
  tztRender();
  playBell(3);
  if (api.bringToFront && !inMeeting()) api.bringToFront(); // surface the window
  logEvent('system', { title: '⏲ Timer finished' });
}

const ackedEvents = new Set();
const notifiedEvents = new Set();
const poppedAlerts = new Set(); // events we've already raised the window for
const bbLoggedMeetings = new Set(); // meetings already recorded in the Black Box
let currentAlertId = null;
let gmailTimer = null;
let eventsTimer = null;
let tickTimer = null;

function updateGoogleStatusUI(email) {
  const text = googleConnected ? `Connected${email ? ' — ' + email : ''}` : 'Not connected';
  els.settingsGoogleStatus.textContent = text;
  els.settingsGoogleStatus.classList.toggle('connected', googleConnected);
}

async function startGoogleFeeds() {
  updateRightSidebar(); // reveal the Inbox board if it's enabled
  els.calendar.classList.remove('hidden');
  await refreshGmail();
  await refreshEvents();
  calendarTick();
  clearInterval(gmailTimer);
  clearInterval(eventsTimer);
  clearInterval(tickTimer);
  gmailTimer = setInterval(refreshGmail, 120000); // every 2 min
  eventsTimer = setInterval(refreshEvents, 300000); // every 5 min
  tickTimer = setInterval(calendarTick, 20000); // countdown + alert check
}

function stopGoogleFeeds() {
  clearInterval(gmailTimer);
  clearInterval(eventsTimer);
  clearInterval(tickTimer);
  updateRightSidebar(); // googleConnected is now false → Inbox board hides
  els.calendar.classList.add('hidden');
  titleText = TITLE_BASE;
  titleAnimate = false;
}

const bbSeenMail = new Set();
let bbMailPrimed = false;
let gmailLastMessages = []; // most recent fetch, so the Command Deck can count unread
async function refreshGmail() {
  if (!googleConnected) return;
  const res = await api.googleRecentMail();
  if (!res || !res.ok) return;
  gmailLastMessages = res.messages || [];
  // Log only genuinely-new mail; prime the seen-set on the first fetch so the whole
  // inbox isn't logged as "new" at startup.
  for (const m of res.messages) {
    if (bbSeenMail.has(m.id)) continue;
    bbSeenMail.add(m.id);
    if (bbMailPrimed) {
      logEvent('mail', {
        title: shortFrom(m.from) + ' · ' + (m.subject || '(no subject)'),
        detail: m.snippet || '',
        ref: { type: 'mail', id: m.id },
      });
    }
  }
  bbMailPrimed = true;
  els.gmailItems.innerHTML = '';
  for (const m of res.messages) {
    const item = document.createElement('div');
    item.className = 'gmail-item' + (m.unread ? ' unread' : '');
    item.title = m.from + (m.unread ? '  (unread)' : '');
    const subj = document.createElement('div');
    subj.className = 'gmail-subj';
    subj.textContent = m.subject;
    const from = document.createElement('div');
    from.className = 'gmail-from';
    from.textContent = shortFrom(m.from);
    const actions = document.createElement('div');
    actions.className = 'gmail-actions';

    const tag = document.createElement('button');
    tag.className = 'gmail-tag';
    tag.textContent = '🏷';
    tag.title = "Add 'draftit' label";
    tag.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't open the email
      tag.disabled = true;
      const res = await api.googleAddLabel(m.id, 'draftit');
      if (res && res.ok) {
        tag.textContent = '✓';
        tag.title = "Labeled 'draftit'";
      } else {
        tag.disabled = false;
        tag.title = 'Failed: ' + (res && res.error ? res.error : 'error');
      }
    });

    const del = document.createElement('button');
    del.className = 'gmail-del';
    del.textContent = '🗑';
    del.title = 'Move to Trash';
    del.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't open the email
      del.disabled = true;
      const res = await api.googleTrashMessage(m.id);
      if (res && res.ok) {
        item.remove();
        els.gmailPreview.classList.add('hidden');
      } else {
        del.disabled = false;
        del.title = 'Failed: ' + (res && res.error ? res.error : 'error');
      }
    });

    actions.appendChild(tag);
    actions.appendChild(del);
    item.appendChild(subj);
    item.appendChild(from);
    item.appendChild(actions);
    item.addEventListener('click', () =>
      api.openExternal('https://mail.google.com/mail/u/0/#all/' + m.id)
    );
    item.addEventListener('mouseenter', () => showGmailPreview(item, m));
    item.addEventListener('mouseleave', hideGmailPreview);
    // Right-click an email to save it as a sticky note (full body if available, else snippet).
    item.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      let text = shortFrom(m.from) + '\n\n' + (m.snippet || '');
      try {
        const res = await api.googleMessageBody(m.id);
        if (res && res.ok && res.body) text = shortFrom(m.from) + '\n\n' + res.body.slice(0, 2000);
      } catch (_) {
        /* fall back to snippet */
      }
      captureToNote({ title: m.subject, text });
    });
    els.gmailItems.appendChild(item);
  }
}

// On-demand message cache (body + attachments) + attachment data cache.
const gmailMsgCache = new Map(); // id -> { body, attachments }
const gmailAttCache = new Map(); // attachmentId -> dataUrl
let gmailPreviewTimer = null;

function renderGmailAttachments(msgId, attachments) {
  const wrap = els.gmailPreview.querySelector('.gp-atts');
  wrap.innerHTML = '';
  for (const a of attachments || []) {
    const isImg = a.mimeType && a.mimeType.startsWith('image/');
    if (isImg && a.size <= 5 * 1024 * 1024) {
      const img = document.createElement('img');
      img.className = 'gp-att-img';
      img.alt = a.filename;
      img.title = a.filename;
      wrap.appendChild(img);
      if (gmailAttCache.has(a.attachmentId)) {
        img.src = gmailAttCache.get(a.attachmentId);
      } else {
        api.googleAttachment(msgId, a.attachmentId, a.mimeType).then((r) => {
          if (r && r.ok) {
            gmailAttCache.set(a.attachmentId, r.dataUrl);
            img.src = r.dataUrl;
          }
        });
      }
    } else {
      const chip = document.createElement('div');
      chip.className = 'gp-att-file';
      chip.textContent = '📎 ' + a.filename + (a.size ? ` (${fmtSize(a.size)})` : '');
      wrap.appendChild(chip);
    }
  }
}

function showGmailPreview(anchorEl, m) {
  clearTimeout(gmailPreviewTimer);
  const p = els.gmailPreview;
  p.querySelector('.gp-subj').textContent = m.subject;
  p.querySelector('.gp-from').textContent = m.from;
  const bodyEl = p.querySelector('.gp-body');
  const cached = gmailMsgCache.get(m.id);
  bodyEl.textContent = cached ? cached.body : m.snippet || 'Loading…';
  renderGmailAttachments(m.id, cached ? cached.attachments : []);
  p.classList.remove('hidden');

  // Position to the left of the sidebar, vertically aligned with the item.
  const sb = els.gmailPanel.getBoundingClientRect();
  const r = anchorEl.getBoundingClientRect();
  p.style.left = Math.max(8, sb.left - p.offsetWidth - 8) + 'px';
  p.style.top = Math.min(r.top, window.innerHeight - p.offsetHeight - 8) + 'px';

  if (!cached) {
    api.googleMessageBody(m.id).then((res) => {
      if (!res || !res.ok) return;
      const entry = { body: res.body || res.snippet || '(no content)', attachments: res.attachments || [] };
      gmailMsgCache.set(m.id, entry);
      if (!p.classList.contains('hidden')) {
        bodyEl.textContent = entry.body;
        renderGmailAttachments(m.id, entry.attachments);
      }
    });
  }
}

function hideGmailPreview() {
  gmailPreviewTimer = setTimeout(() => els.gmailPreview.classList.add('hidden'), 200);
}

// Keep the preview open while hovering it (so you can read/scroll long emails).
els.gmailPreview.addEventListener('mouseenter', () => clearTimeout(gmailPreviewTimer));
els.gmailPreview.addEventListener('mouseleave', () => els.gmailPreview.classList.add('hidden'));

// "Name <email>" -> "Name"; otherwise the address.
function shortFrom(from) {
  if (!from) return '';
  const m = from.match(/^\s*"?([^"<]+?)"?\s*<.+>/);
  return (m ? m[1] : from).trim();
}

async function refreshEvents() {
  if (!googleConnected) return;
  const res = await api.googleUpcomingEvents();
  if (res && res.ok) {
    upcomingEvents = res.events || [];
    calendarTick();
  }
}

function fmtMins(mins) {
  if (mins < 60) return mins + 'm';
  return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
}

function calendarTick() {
  if (!googleConnected) return;
  const now = Date.now();
  const timed = upcomingEvents
    .filter((e) => !e.allDay && e.start)
    .map((e) => ({ ...e, t: Date.parse(e.start) }))
    .filter((e) => e.t > now - 15 * 60000)
    .sort((a, b) => a.t - b.t);
  const next = timed[0];
  if (!next) {
    els.calendar.textContent = '📅 No upcoming events';
    els.calendar.classList.remove('flashing');
    currentAlertId = null;
    setMeetingFlash(false);
    titleText = TITLE_BASE;
    titleAnimate = false;
    return;
  }
  const lead = next.t - now;
  // Log a meeting once, when it starts.
  if (lead <= 0 && next.id && !bbLoggedMeetings.has(next.id)) {
    bbLoggedMeetings.add(next.id);
    logEvent('meeting', {
      title: next.summary || 'Meeting',
      detail: 'started',
      ref: next.meetLink ? { type: 'url', url: next.meetLink } : null,
    });
  }
  const mins = Math.round(lead / 60000);
  els.calendar.textContent =
    '📅 ' + next.summary + ' ' + (lead >= 0 ? 'in ' + fmtMins(mins) : '(now)');
  if (next.meetLink) {
    const join = document.createElement('a');
    join.className = 'cal-join';
    join.textContent = 'Join';
    join.title = next.meetLink;
    join.addEventListener('click', (e) => {
      e.stopPropagation();
      api.openExternal(next.meetLink);
    });
    els.calendar.appendChild(join);
  }

  // Alert window: 3 min before → 15 min after, until acknowledged.
  const alerting = lead <= 3 * 60000 && now < next.t + 15 * 60000 && !ackedEvents.has(next.id);
  els.calendar.classList.toggle('flashing', alerting);
  currentAlertId = alerting ? next.id : null;

  // Hard-to-miss centered popup (raises the window) while unacknowledged.
  if (alerting) showMeetingAlert(next, lead);
  else hideMeetingAlert();

  // Whole-window pulse in the last ~2 minutes (slow/faint far out, faster/stronger near).
  setMeetingFlash(lead > 0 && lead <= 120000 && !ackedEvents.has(next.id), lead);

  // Reflect an imminent appointment (≤30 min) in the window title; bounce it in the last 5 min.
  const shortSummary = next.summary.length > 32 ? next.summary.slice(0, 30) + '…' : next.summary;
  if (lead < 0) {
    titleText = `🔴 ${shortSummary} now — ${TITLE_BASE}`;
    titleAnimate = now < next.t + 15 * 60000;
  } else if (lead <= 30 * 60000) {
    titleText = `⏰ ${shortSummary} in ${fmtMins(mins)} — ${TITLE_BASE}`;
    titleAnimate = lead <= 5 * 60000;
  } else {
    titleText = TITLE_BASE;
    titleAnimate = false;
  }
  if (alerting && !notifiedEvents.has(next.id)) {
    notifiedEvents.add(next.id);
    if (meetingChime) playMeetingChime();
    try {
      new Notification('📅 ' + next.summary, {
        body: lead >= 0 ? 'Starts in ' + fmtMins(mins) : 'Starting now',
      });
    } catch (_) {
      /* ignore */
    }
  }
}

// Window pulse: from 2 min out (slow, faint) ramping to fast/stronger near start.
function setMeetingFlash(active, lead) {
  const el = els.meetingFlash;
  if (!active) {
    el.classList.add('hidden');
    return;
  }
  const frac = Math.max(0, Math.min(1, lead / 120000)); // 1 = far (2 min), 0 = at start
  el.style.animationDuration = (0.7 + frac * 1.9).toFixed(2) + 's'; // 2.6s far → 0.7s near
  el.style.setProperty('--mf-peak', (0.06 + (1 - frac) * 0.12).toFixed(3)); // .06 far → .18 near
  el.classList.remove('hidden');
}

function acknowledgeAlert() {
  if (currentAlertId) {
    ackedEvents.add(currentAlertId);
    calendarTick();
  }
}

// Centered "you have a meeting" popup. Raises the Cockpit window once per event.
function showMeetingAlert(ev, lead) {
  const el = document.getElementById('meeting-alert');
  document.getElementById('ma-title').textContent = ev.summary || 'Meeting';
  const startHm = new Date(ev.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('ma-when').textContent =
    lead >= 0 ? `starts in ${fmtMins(Math.max(0, Math.round(lead / 60000)))} · ${startHm}` : `started at ${startHm}`;
  const join = document.getElementById('ma-join');
  if (ev.meetLink) {
    join.href = ev.meetLink;
    join.dataset.url = ev.meetLink;
    join.classList.remove('hidden');
  } else {
    join.classList.add('hidden');
  }
  el.classList.remove('hidden');
  // Pull the window to the foreground the first time we alert for this event.
  if (ev.id && !poppedAlerts.has(ev.id)) {
    poppedAlerts.add(ev.id);
    if (api.bringToFront) api.bringToFront();
  }
}
function hideMeetingAlert() {
  document.getElementById('meeting-alert').classList.add('hidden');
}
{
  const join = document.getElementById('ma-join');
  if (join) {
    join.addEventListener('click', (e) => {
      e.preventDefault();
      if (join.dataset.url) api.openExternal(join.dataset.url);
      acknowledgeAlert(); // opening the meeting counts as acknowledging it
      hideMeetingAlert();
    });
  }
  const dismiss = document.getElementById('ma-dismiss');
  if (dismiss) dismiss.addEventListener('click', () => {
    acknowledgeAlert();
    hideMeetingAlert();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('meeting-alert').classList.contains('hidden')) {
      acknowledgeAlert();
      hideMeetingAlert();
    }
  });
}

// Format an event's time for the upcoming list.
function fmtEventTime(e) {
  if (e.allDay) return 'all day';
  const d = new Date(e.start);
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? hm : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + hm;
}

function renderCalendarPreview() {
  const now = Date.now();
  const list = upcomingEvents
    .filter((e) => e.start)
    .map((e) => ({ ...e, t: Date.parse(e.start) }))
    .filter((e) => e.t > now - 15 * 60000)
    .sort((a, b) => a.t - b.t)
    .slice(0, 10);
  els.calendarPreviewList.innerHTML = '';
  if (!list.length) {
    els.calendarPreviewList.textContent = 'No upcoming events.';
    return;
  }
  for (const e of list) {
    const lead = e.t - now;
    const row = document.createElement('div');
    row.className = 'cal-ev' + (!e.allDay && lead <= 3 * 60000 && lead > -15 * 60000 ? ' soon' : '');
    const time = document.createElement('span');
    time.className = 'cal-ev-time';
    time.textContent = fmtEventTime(e);
    const title = document.createElement('span');
    title.className = 'cal-ev-title';
    const mins = Math.round(lead / 60000);
    title.textContent =
      e.summary + (!e.allDay ? ' · ' + (lead >= 0 ? 'in ' + fmtMins(mins) : 'now') : '');
    row.appendChild(time);
    row.appendChild(title);
    if (e.meetLink) {
      const join = document.createElement('a');
      join.className = 'cal-join';
      join.textContent = 'Join';
      join.title = e.meetLink;
      join.addEventListener('click', (ev) => {
        ev.stopPropagation();
        api.openExternal(e.meetLink);
      });
      row.appendChild(join);
    }
    els.calendarPreviewList.appendChild(row);
  }
}

let calPreviewTimer = null;
function showCalendarPreview() {
  clearTimeout(calPreviewTimer);
  renderCalendarPreview();
  acknowledgeAlert(); // hovering the calendar stops the flashing
  const p = els.calendarPreview;
  p.classList.remove('hidden');
  const r = els.calendar.getBoundingClientRect();
  p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - p.offsetWidth - 8)) + 'px';
  p.style.top = Math.max(8, r.top - p.offsetHeight - 8) + 'px'; // above the status bar
}
function hideCalendarPreview() {
  calPreviewTimer = setTimeout(() => els.calendarPreview.classList.add('hidden'), 200);
}

els.calendar.addEventListener('click', acknowledgeAlert);
els.calendar.addEventListener('mouseenter', showCalendarPreview);
els.calendar.addEventListener('mouseleave', hideCalendarPreview);
els.calendarPreview.addEventListener('mouseenter', () => clearTimeout(calPreviewTimer));
els.calendarPreview.addEventListener('mouseleave', () => els.calendarPreview.classList.add('hidden'));

els.setGoogleConnect.addEventListener('click', async () => {
  els.settingsGoogleError.textContent = '';
  const clientId = els.setGoogleId.value.trim();
  const clientSecret = els.setGoogleSecret.value.trim();
  if (!clientId || !clientSecret) {
    els.settingsGoogleError.textContent = 'Client ID and secret are required.';
    return;
  }
  els.settingsGoogleStatus.textContent = 'Opening browser for sign-in…';
  const res = await api.googleConnect({ clientId, clientSecret });
  if (!res.ok) {
    googleConnected = false;
    updateGoogleStatusUI();
    els.settingsGoogleError.textContent = res.error;
    return;
  }
  googleConnected = true;
  googleEmail = res.email;
  updateGoogleStatusUI(res.email);
  startGoogleFeeds();
});

els.setGoogleForget.addEventListener('click', async () => {
  await api.googleDisconnect();
  googleConnected = false;
  upcomingEvents = [];
  updateGoogleStatusUI();
  stopGoogleFeeds();
});

els.gmailRefresh.addEventListener('click', async () => {
  els.gmailRefresh.disabled = true;
  els.gmailRefresh.textContent = '…';
  await refreshGmail();
  els.gmailRefresh.textContent = '⟳';
  els.gmailRefresh.disabled = false;
});

// ---------------------------------------------------------------------------
// Notes board (sticky notes: click to edit, drag, right-click to color)
// ---------------------------------------------------------------------------
let notesData = []; // [{ id, text, x, y, color }]
let notesBoardEl = null;
let tasksDashEl = null; // the Tasks dashboard overlay inside the notes pane
let tasksShowDone = false;
let kanbanEl = null; // the Kanban board overlay inside the notes pane
const NOTE_COLORS = ['#f6e58d', '#b5e0a0', '#9cc4ff', '#f7a6c4', '#ffc38a', '#d4a8e0', '#e0e0e0'];
let noteSaveTimer = null;
function saveNotes() {
  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(() => {
    api.saveSettings({ notes: notesData });
    updatePet(true); // react to whatever just changed (a task closed → cheer, etc.)
  }, 300);
}

// ---------------------------------------------------------------------------
// Cockpit pet 🐤 — a corner buddy that thrives as you close tasks and sulks when
// overdue notes pile up. Mood is derived from notes; no timers run while idle
// (only transient animations), so it doesn't add background CPU.
// ---------------------------------------------------------------------------
let petPrevDone = null;
let petCheerTimer = null;
function petStats() {
  const tasks = collectTasks();
  const open = tasks.filter((t) => t.state !== 'done').length;
  const done = tasks.filter((t) => t.state === 'done').length;
  const now = Date.now();
  // A note is "handled" if it has tasks and every one is done — don't complain
  // about a timed note whose work is already finished. A timed note with no
  // tasks (a plain reminder) still counts as overdue once its due time passes.
  const noteDone = (n) => {
    const ts = tasks.filter((t) => t.note === n);
    return ts.length > 0 && ts.every((t) => t.state === 'done');
  };
  const overdue = notesData.filter((n) => n.due && n.due < now && !noteDone(n)).length;
  return { open, done, overdue };
}
function updatePet(allowCheer) {
  const el = els.pet;
  if (!el) return;
  const { open, done, overdue } = petStats();
  let mood;
  let face;
  let msg;
  if (overdue > 0) {
    // Friendly nudge, never grumpy: a cheerful bird that waves for attention.
    mood = 'nudge';
    face = '🐥';
    msg =
      overdue >= 3
        ? `${overdue} past due - let's knock a few out! 💪`
        : `${overdue} overdue - you've got this! 💪`;
  } else if (open === 0 && done === 0) {
    mood = 'idle';
    face = '🐤';
    msg = 'Ready when you are! Add a task ✨';
  } else if (open === 0) {
    mood = 'ecstatic';
    face = '🤩';
    msg = 'All tasks done! 🎉';
  } else if (open <= 3) {
    mood = 'happy';
    face = '🐤';
    msg = `${open} task${open === 1 ? '' : 's'} to go - we've got this! 💛`;
  } else {
    mood = 'happy';
    face = '🐤';
    msg = `${open} on the list - one at a time 🙂`;
  }
  el.dataset.mood = mood;
  el.querySelector('.pet-face').textContent = face;
  const bubble = el.querySelector('.pet-bubble');
  bubble.textContent = msg;

  // Celebrate when the number of completed tasks goes up.
  if (allowCheer && petPrevDone != null && done > petPrevDone) {
    el.classList.remove('pet-cheer');
    void el.offsetWidth; // restart the animation
    el.classList.add('pet-cheer');
    bubble.classList.add('show');
    clearTimeout(petCheerTimer);
    petCheerTimer = setTimeout(() => {
      el.classList.remove('pet-cheer');
      bubble.classList.remove('show');
    }, 2600);
  }
  petPrevDone = done;
}
els.pet.addEventListener('click', () => {
  const bubble = els.pet.querySelector('.pet-bubble');
  bubble.classList.add('show');
  clearTimeout(petCheerTimer);
  petCheerTimer = setTimeout(() => bubble.classList.remove('show'), 2600);
  // Clicking the bird opens (or focuses) the Notes/tasks board.
  createNotesTab();
});

// ---------------------------------------------------------------------------
// Periodic reminder: a colorful overlay every 10–20 min, window to front.
// ---------------------------------------------------------------------------
let reminderHideTimer = null;
let reminderTimer = null;
// Configurable reminder (text + how often it appears, roughly).
let reminderEnabled = true;
let reminderText = 'Zu….';
let reminderMinMin = 10; // minutes (lower bound)
let reminderMaxMin = 20; // minutes (upper bound)
// Are we currently inside a timed calendar event (between its start and end)?
function inMeeting() {
  const now = Date.now();
  return upcomingEvents.some((e) => {
    if (e.allDay || !e.start || !e.end) return false;
    const s = Date.parse(e.start);
    const end = Date.parse(e.end);
    return s <= now && now < end;
  });
}
function showReminder() {
  if (!reminderEnabled) return;
  if (focusSession) return; // don't interrupt a focus session
  logEvent('reminder', { title: reminderText || 'reminder' });
  // During a meeting, don't yank the window to the foreground (just show quietly).
  if (api.bringToFront && !inMeeting()) api.bringToFront();
  els.reminderMsg.textContent = reminderText || 'Zu….';
  els.reminderOverlay.classList.remove('hidden');
  const t = els.reminderMsg; // restart the pop animation each appearance
  t.style.animation = 'none';
  void t.offsetWidth;
  t.style.animation = '';
  clearTimeout(reminderHideTimer);
  reminderHideTimer = setTimeout(hideReminder, 5000);
}
function hideReminder() {
  els.reminderOverlay.classList.add('hidden');
  focusActiveTerm(); // the overlay/bring-to-front stole focus - hand it back to the terminal
}
els.reminderOverlay.addEventListener('click', hideReminder);
function scheduleReminder() {
  clearTimeout(reminderTimer);
  reminderTimer = null;
  if (!reminderEnabled) return;
  const lo = Math.min(reminderMinMin, reminderMaxMin);
  const hi = Math.max(reminderMinMin, reminderMaxMin);
  const ms = (lo + Math.random() * Math.max(0, hi - lo)) * 60000;
  reminderTimer = setTimeout(() => {
    showReminder();
    scheduleReminder();
  }, ms);
}
scheduleReminder();

// ---------------------------------------------------------------------------
// 3D Exposé: a navigable three.js view of all tabs as floating panels.
//   drag = tilt the wall · wheel = zoom · click a panel = jump to it
//   Shift+drag a panel = roll it around its Z axis · Esc = close
// ---------------------------------------------------------------------------
let exposeState = null;
const exposeMemory = new Map(); // tabId -> saved 3D transform {px,py,pz,rx,ry,rz,scale,cScale}
let exposeScene = null; // saved scene view {rotX,rotY,posX,posY,camZ}
const CARD_W = 760;
const CARD_H = 480;
const CARD_SX = 840;
const CARD_SY = 560;

function exposeKind(rec) {
  const colors = { ssh: '#4ea1ff', local: '#7ee787', slack: '#c285e0', web: '#3bbf9f', notes: '#f0c674' };
  const glyphs = { ssh: '>_', local: '🖥', slack: '#', web: '🌐', notes: '📝' };
  return { color: colors[rec.kind] || '#8a8f94', glyph: glyphs[rec.kind] || '?' };
}
function exposeTitle(rec) {
  const t = rec.tabEl && rec.tabEl.querySelector('.title');
  return (t && t.textContent) || (rec.profile && rec.profile.name) || rec.kind;
}

// Build the DOM card for one tab. Terminals/Slack/notes embed the REAL live pane;
// web tabs (webviews can't be CSS-3D-transformed) fall back to a snapshot image.
function makeExposeCard(rec, live, layout) {
  const k = exposeKind(rec);
  const card = document.createElement('div');
  card.className = 'exp-card';
  card.style.width = CARD_W + 'px';
  card.style.height = CARD_H + 'px';
  card.style.setProperty('--exp-accent', k.color);

  const head = document.createElement('div');
  head.className = 'exp-head';
  head.innerHTML =
    `<span class="exp-glyph">${escapeHtml(k.glyph)}</span>` +
    `<span class="exp-title">${escapeHtml(exposeTitle(rec))}</span>`;
  card.appendChild(head);

  const bodyHost = document.createElement('div');
  bodyHost.className = 'exp-body';
  card.appendChild(bodyHost);

  let scaler = null;
  if (live) {
    // Render the pane at the app's real content size, then scale the whole thing
    // down to fit the card — so nothing (e.g. notes off to the side) is cut off.
    scaler = document.createElement('div');
    scaler.className = 'exp-scaler';
    scaler.style.width = layout.vW + 'px';
    scaler.style.height = layout.vH + 'px';
    scaler.style.transform = `translate(${layout.offX}px, ${layout.offY}px) scale(${layout.k})`;
    scaler.appendChild(rec.paneEl); // move the real, live pane in
    bodyHost.appendChild(scaler);
  } else if (rec.snapshot) {
    const img = document.createElement('img');
    img.className = 'exp-shot';
    img.src = rec.snapshot;
    bodyHost.appendChild(img);
  } else if (k && rec.kind === 'web') {
    // No thumbnail yet (e.g. tab never shown this session) — show a readable
    // placeholder with the site instead of an empty card.
    const ph = document.createElement('div');
    ph.className = 'exp-ph exp-ph-web';
    ph.style.color = k.color;
    ph.innerHTML =
      `<div class="exp-ph-glyph">${escapeHtml(k.glyph)}</div>` +
      `<div class="exp-ph-title">${escapeHtml(exposeTitle(rec))}</div>` +
      `<div class="exp-ph-url">${escapeHtml(rec.url || '')}</div>`;
    bodyHost.appendChild(ph);
  } else {
    const ph = document.createElement('div');
    ph.className = 'exp-ph';
    ph.textContent = k.glyph;
    ph.style.color = k.color;
    bodyHost.appendChild(ph);
  }
  return { card, head, bodyHost, scaler };
}

async function openExpose() {
  if (exposeState || typeof THREE === 'undefined' || !THREE.CSS3DRenderer) return;
  const recs = [...tabs.values()];
  if (!recs.length) return;
  if (activeTabId) await captureSnapshot(activeTabId); // freshen web thumbnails

  const overlay = document.createElement('div');
  overlay.id = 'expose-overlay';
  overlay.innerHTML =
    '<button id="expose-close" title="Close 3D view (Esc)">✕</button>' +
    '<div id="expose-hint">Tab = next to front · Shift+Tab = back to 3D · drag = move · wheel = resize · Ctrl+wheel = zoom content · Shift+wheel = depth · drag title = rotate · click title = open · drag bg = orbit · right-drag bg = pan · Esc</div>';
  document.body.appendChild(overlay);
  overlay.querySelector('#expose-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeExpose();
  });

  const renderer = new THREE.CSS3DRenderer();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.domElement.id = 'expose-3d';
  overlay.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 100000);
  const group = new THREE.Group();
  scene.add(group);

  const cols = Math.ceil(Math.sqrt(recs.length));
  const rows = Math.ceil(recs.length / cols);
  const objs = [];
  const moved = []; // live panes we relocate (to restore on close)
  const objByCard = new Map();

  // Content scaling: render each live pane at the app's real content size, scaled
  // to fit the card body (so notes / wide content aren't clipped).
  const trect = els.terminals.getBoundingClientRect();
  const vW = Math.max(700, Math.round(trect.width || 1000));
  const vH = Math.max(450, Math.round(trect.height || 650));
  const HEAD_H = 30;
  const bodyW = CARD_W;
  const bodyH = CARD_H - HEAD_H;
  const k = Math.min(bodyW / vW, bodyH / vH);
  const layout = { vW, vH, k, offX: (bodyW - vW * k) / 2, offY: (bodyH - vH * k) / 2 };

  // Lay panels out on a concave cylinder section facing the viewer.
  const STEP = 0.42; // radians between columns
  const R = Math.max(1100, CARD_SX / STEP); // cylinder radius

  recs.forEach((rec, i) => {
    const live = rec.kind !== 'web' && !!rec.paneEl;
    moved.push({ rec, parent: rec.paneEl.parentNode, cls: rec.paneEl.className, live });
    if (live) rec.paneEl.classList.add('active'); // force it visible inside the card
    else rec.paneEl.classList.remove('active'); // hide the webview so it can't show through
    const { card, scaler } = makeExposeCard(rec, live, layout);
    const obj = new THREE.CSS3DObject(card);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const theta = (col - (cols - 1) / 2) * STEP;
    // Default placement on a concave cylinder wall: the middle column sits back and
    // the side columns wrap toward the viewer (so the middle no longer protrudes).
    obj.position.x = R * Math.sin(theta);
    obj.position.z = R - R * Math.cos(theta); // middle (θ=0) furthest, sides come forward
    obj.position.y = -(row - (rows - 1) / 2) * CARD_SY;
    obj.rotation.y = -theta; // turn each panel to face the viewer
    const memKey = tabKey(rec);
    obj.userData = { tabId: rec.id, key: memKey, scaler, baseK: layout.k, offX: layout.offX, offY: layout.offY, cScale: 1 };
    // Restore a remembered placement (from a previous session / launch) if we have one.
    const mem = exposeMemory.get(memKey);
    if (mem) {
      obj.position.set(mem.px, mem.py, mem.pz);
      obj.rotation.set(mem.rx, mem.ry, mem.rz);
      obj.scale.setScalar(mem.scale || 1);
      obj.userData.cScale = mem.cScale || 1;
      if (scaler && obj.userData.cScale !== 1) {
        scaler.style.transform = `translate(${layout.offX}px, ${layout.offY}px) scale(${layout.k * obj.userData.cScale})`;
      }
    }
    group.add(obj);
    objs.push(obj);
    objByCard.set(card, obj);
  });

  const arcHalf = ((cols - 1) / 2) * STEP;
  const tanF = Math.tan((camera.fov * Math.PI) / 360);
  const maxZ = R * (1 - Math.cos(arcHalf)); // how far the nearest (side) panels come forward
  const needH = (R * Math.sin(arcHalf) + CARD_W * 0.6) / camera.aspect;
  const needV = rows * CARD_SY * 0.6;
  let camZ = Math.max(needH, needV) / tanF + 350 + maxZ;
  if (exposeScene) camZ = exposeScene.camZ; // restore previous zoom

  const st = {
    overlay,
    renderer,
    scene,
    camera,
    group,
    objs,
    movedPanes: moved,
    raf: 0,
    mode: null, // 'orbit' | 'move' | 'rotate' | 'roll'
    activeObj: null,
    dragDist: 0,
    headDownId: null,
    pending: null, // press on a live terminal/Slack body, not yet a drag
    focusIdx: -1, // which panel is currently pulled to the front (Tab to cycle)
    focusSaved: null, // that panel's transform before it was pulled forward
    lastX: 0,
    lastY: 0,
    targetRotX: 0,
    targetRotY: 0,
    camZ,
  };
  exposeState = st;

  // Restore the remembered scene view (orbit/pan/zoom) instantly, no fly-in.
  if (exposeScene) {
    st.targetRotX = exposeScene.rotX;
    st.targetRotY = exposeScene.rotY;
    group.rotation.set(exposeScene.rotX, exposeScene.rotY, 0);
    group.position.set(exposeScene.posX, exposeScene.posY, 0);
  }

  // Refit terminals to their new card size now that they've been relocated, then
  // force a full repaint. A terminal that lived in a hidden (display:none) tab all
  // session has a suspended xterm renderer; fit() alone is a no-op if the cell
  // dimensions happen to match, so the card would show blank. refresh() guarantees
  // the live buffer is painted. Defer a frame so the new layout is measurable.
  const repaintTerms = () => {
    for (const m of moved) {
      if ((m.rec.kind !== 'ssh' && m.rec.kind !== 'local') || !m.rec.term) continue;
      try {
        if (m.rec.fitAddon) m.rec.fitAddon.fit();
        m.rec.term.refresh(0, m.rec.term.rows - 1);
      } catch (_) {
        /* ignore */
      }
    }
  };
  requestAnimationFrame(repaintTerms);

  // Screen pixels → world units at the panel plane (the group lives in px space).
  function planeScale() {
    const dist = Math.abs(camera.position.z);
    return (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / window.innerHeight;
  }

  st.onDown = (ev) => {
    if (ev.target.closest('#expose-close')) return; // let the close button click through
    const headEl = ev.target.closest('.exp-head');
    const cardEl = ev.target.closest('.exp-card');
    // On a notes panel, let clicks on an actual note through (check tasks, edit,
    // drag the note); only the board background drives Exposé manipulation.
    if (cardEl && !headEl && ev.target.closest('.note')) return;
    // On a terminal / Slack panel body, don't claim the press immediately: let it
    // through so the live pane focuses (you can type / select / scroll, just like a
    // note). If the pointer then drags past a small threshold we take over and move
    // the panel instead. The header still rotates/opens the panel.
    if (cardEl && !headEl && ev.target.closest('.term-pane, .slack-pane')) {
      st.pending = { obj: objByCard.get(cardEl) || null, x: ev.clientX, y: ev.clientY };
      st.mode = null;
      st.activeObj = null;
      st.lastX = ev.clientX;
      st.lastY = ev.clientY;
      return; // event continues to the live pane → focus / caret
    }
    st.pending = null;
    st.dragDist = 0;
    st.lastX = ev.clientX;
    st.lastY = ev.clientY;
    if (cardEl) {
      ev.preventDefault();
      ev.stopPropagation(); // claim the drag from the live pane underneath
      st.activeObj = objByCard.get(cardEl) || null;
      if (headEl) {
        st.mode = ev.shiftKey ? 'roll' : 'rotate';
        st.headDownId = ev.shiftKey ? null : st.activeObj && st.activeObj.userData.tabId;
      } else {
        st.mode = 'move'; // drag the panel body to reposition it individually
        st.headDownId = null;
      }
    } else {
      // Empty space: left-drag orbits; middle/right-drag pans the scene in X/Y.
      st.mode = ev.button === 1 || ev.button === 2 ? 'pan' : 'orbit';
      st.activeObj = null;
      st.headDownId = null;
    }
  };
  st.onMove = (ev) => {
    // A press that started on a live terminal/Slack body becomes a panel move only
    // once it's clearly a drag — below the threshold it stays a click for the pane.
    if (st.pending) {
      if (Math.abs(ev.clientX - st.pending.x) + Math.abs(ev.clientY - st.pending.y) < 8) return;
      st.mode = 'move';
      st.activeObj = st.pending.obj;
      st.headDownId = null;
      st.dragDist = 0;
      st.lastX = ev.clientX;
      st.lastY = ev.clientY;
      st.pending = null;
      const rec = st.activeObj && tabs.get(st.activeObj.userData.tabId);
      if (rec && rec.term) {
        try {
          rec.term.clearSelection();
        } catch (_) {
          /* ignore */
        }
      }
      return; // start fresh next move so the panel doesn't jump
    }
    if (!st.mode) return;
    const dx = ev.clientX - st.lastX;
    const dy = ev.clientY - st.lastY;
    st.lastX = ev.clientX;
    st.lastY = ev.clientY;
    st.dragDist += Math.abs(dx) + Math.abs(dy);
    const o = st.activeObj;
    if (st.mode === 'orbit') {
      st.targetRotY += dx * 0.005;
      st.targetRotX += dy * 0.005;
      st.targetRotX = Math.max(-1.2, Math.min(1.2, st.targetRotX));
    } else if (st.mode === 'pan') {
      const s = planeScale();
      group.position.x += dx * s;
      group.position.y -= dy * s;
    } else if (st.mode === 'rotate' && o) {
      o.rotation.y += dx * 0.01; // tumble this panel around Y…
      o.rotation.x += dy * 0.01; // …and X
    } else if (st.mode === 'roll' && o) {
      o.rotation.z -= dx * 0.01;
    } else if (st.mode === 'move' && o) {
      const s = planeScale();
      const v = new THREE.Vector3(dx * s, -dy * s, 0);
      const q = new THREE.Quaternion().setFromEuler(group.rotation);
      v.applyQuaternion(q.invert()); // world delta → group-local so it tracks the cursor
      o.position.add(v);
    }
  };
  st.onUp = () => {
    // A clean click on the title bar (no drag) jumps to that tab.
    if (st.mode === 'rotate' && st.headDownId && st.dragDist < 6) {
      const id = st.headDownId;
      closeExpose();
      activateTab(id);
      return;
    }
    st.mode = null;
    st.activeObj = null;
    st.headDownId = null;
    st.pending = null;
  };
  st.onWheel = (ev) => {
    ev.preventDefault();
    const cardEl = ev.target.closest && ev.target.closest('.exp-card');
    const o = cardEl && objByCard.get(cardEl);
    if (o) {
      ev.stopPropagation();
      if (ev.ctrlKey && o.userData.scaler) {
        // Ctrl+wheel → zoom the content INSIDE this pane (e.g. bigger terminal text).
        const u = o.userData;
        u.cScale = Math.max(0.3, Math.min(6, u.cScale * Math.exp(-ev.deltaY * 0.004)));
        u.scaler.style.transform = `translate(${u.offX}px, ${u.offY}px) scale(${u.baseK * u.cScale})`;
      } else if (ev.shiftKey) {
        // Shift+wheel → move this panel forward/back in depth (toward/away from you).
        const v = new THREE.Vector3(0, 0, -ev.deltaY * 0.8);
        const q = new THREE.Quaternion().setFromEuler(group.rotation);
        v.applyQuaternion(q.invert());
        o.position.add(v);
      } else {
        // Plain wheel → resize just this panel, around its own center (fast).
        const f = Math.exp(-ev.deltaY * 0.004);
        const s = Math.max(0.15, Math.min(12, o.scale.x * f));
        o.scale.set(s, s, s);
      }
    } else {
      // Over empty space → zoom the camera.
      st.camZ += ev.deltaY * 0.6;
      st.camZ = Math.max(200, Math.min(9000, st.camZ));
    }
  };
  st.onResize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };

  st.onCtx = (ev) => ev.preventDefault(); // allow right-drag panning without a menu
  overlay.addEventListener('pointerdown', st.onDown, true); // capture: beat the live pane
  window.addEventListener('pointermove', st.onMove);
  window.addEventListener('pointerup', st.onUp);
  overlay.addEventListener('wheel', st.onWheel, { passive: false, capture: true });
  overlay.addEventListener('contextmenu', st.onCtx);
  window.addEventListener('resize', st.onResize);

  camera.position.set(0, 0, st.camZ);

  // Glue the currently-focused panel to a spot dead-centre in front of the camera,
  // facing the viewer, regardless of how the scene is orbited / panned / zoomed.
  // Recomputed each frame so it stays put even while the group keeps easing.
  function placeFocused() {
    const obj = st.objs[st.focusIdx];
    if (!obj) return;
    group.updateMatrixWorld(true);
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const gap = st.camZ * 0.5; // distance from camera to the focused panel
    const focusZ = st.camZ - gap;
    obj.position.copy(group.worldToLocal(new THREE.Vector3(0, 0, focusZ)));
    const gq = new THREE.Quaternion();
    group.getWorldQuaternion(gq);
    obj.quaternion.copy(gq.invert()); // cancel the group rotation → face the camera
    obj.scale.setScalar((0.8 * 2 * gap * tan) / CARD_H); // ~80% of the viewport height
  }

  // Tab through panels: bring the next one to the front and return the previous
  // one to exactly where it was.
  st.cycle = (dir) => {
    if (!st.objs.length) return;
    if (st.focusIdx >= 0 && st.focusSaved) {
      const prev = st.objs[st.focusIdx];
      prev.position.copy(st.focusSaved.pos);
      prev.quaternion.copy(st.focusSaved.quat);
      prev.scale.copy(st.focusSaved.scale);
    }
    const base = st.focusIdx < 0 ? (dir > 0 ? -1 : 0) : st.focusIdx;
    st.focusIdx = (base + dir + st.objs.length) % st.objs.length;
    const obj = st.objs[st.focusIdx];
    st.focusSaved = {
      pos: obj.position.clone(),
      quat: obj.quaternion.clone(),
      scale: obj.scale.clone(),
    };
    placeFocused();
  };

  // Release the focused panel back to its position and return to the plain 3D view.
  st.unfocus = () => {
    if (st.focusIdx < 0) return;
    if (st.focusSaved) {
      const o = st.objs[st.focusIdx];
      o.position.copy(st.focusSaved.pos);
      o.quaternion.copy(st.focusSaved.quat);
      o.scale.copy(st.focusSaved.scale);
    }
    st.focusIdx = -1;
    st.focusSaved = null;
  };

  function frame() {
    st.raf = requestAnimationFrame(frame);
    group.rotation.x += (st.targetRotX - group.rotation.x) * 0.12;
    group.rotation.y += (st.targetRotY - group.rotation.y) * 0.12;
    camera.position.z += (st.camZ - camera.position.z) * 0.15;
    camera.lookAt(0, 0, 0);
    if (st.focusIdx >= 0) placeFocused();
    renderer.render(scene, camera);
  }
  frame();
  requestAnimationFrame(() => overlay.classList.add('shown'));
}

function closeExpose() {
  const st = exposeState;
  if (!st) return;
  exposeState = null;
  cancelAnimationFrame(st.raf);
  window.removeEventListener('resize', st.onResize);
  window.removeEventListener('pointermove', st.onMove);
  window.removeEventListener('pointerup', st.onUp);
  // If a panel is currently pulled to the front, put it back first so we persist
  // its real placement, not the temporary focus position.
  if (st.focusIdx >= 0 && st.focusSaved) {
    const o = st.objs[st.focusIdx];
    o.position.copy(st.focusSaved.pos);
    o.quaternion.copy(st.focusSaved.quat);
    o.scale.copy(st.focusSaved.scale);
  }
  // Remember each panel's placement + the scene view for next time (this session
  // and across restarts — keyed by the stable tab key, not the runtime id).
  for (const o of st.objs) {
    if (!o.userData.key) continue;
    exposeMemory.set(o.userData.key, {
      px: o.position.x,
      py: o.position.y,
      pz: o.position.z,
      rx: o.rotation.x,
      ry: o.rotation.y,
      rz: o.rotation.z,
      scale: o.scale.x,
      cScale: o.userData.cScale || 1,
    });
  }
  exposeScene = {
    rotX: st.group.rotation.x,
    rotY: st.group.rotation.y,
    posX: st.group.position.x,
    posY: st.group.position.y,
    camZ: st.camZ,
  };
  api.saveSettings({
    exposeLayout: { panels: Object.fromEntries(exposeMemory), scene: exposeScene },
  });
  // Put every live pane back into the terminals container and restore its classes.
  // (Pane DOM order doesn't matter — only the .active one is visible.)
  for (const m of st.movedPanes) {
    try {
      m.rec.paneEl.className = m.cls;
      if (m.live) (m.parent || els.terminals).appendChild(m.rec.paneEl);
    } catch (_) {
      /* ignore */
    }
  }
  st.overlay.remove();
  // Re-fit the (restored) active terminal to its real pane size.
  if (activeTabId) {
    const rec = tabs.get(activeTabId);
    if (rec && (rec.kind === 'ssh' || rec.kind === 'local') && rec.term) {
      requestAnimationFrame(() => {
        try {
          if (rec.fitAddon) rec.fitAddon.fit();
          rec.term.refresh(0, rec.term.rows - 1);
        } catch (_) {
          /* ignore */
        }
      });
    }
  }
}

function toggleExpose() {
  if (exposeState) closeExpose();
  else openExpose();
}

window.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'F3') {
      e.preventDefault();
      e.stopPropagation();
      toggleExpose();
    } else if (e.key === 'Escape' && exposeState) {
      e.preventDefault();
      e.stopPropagation();
      closeExpose();
    } else if (e.key === 'Tab' && exposeState && exposeState.cycle) {
      e.preventDefault();
      e.stopPropagation();
      // Shift+Tab: drop the focused panel back into place (plain 3D view).
      // Tab: pull the next panel to the front.
      if (e.shiftKey) exposeState.unfocus();
      else exposeState.cycle(1);
    }
  },
  true
);
{
  const exposeBtn = document.getElementById('expose-btn');
  if (exposeBtn) exposeBtn.addEventListener('click', toggleExpose);
}

// Toolbar dropdown (New / Slack / Files / Local / Web / Notes / 3D).
{
  const menuBtn = document.getElementById('tab-menu-btn');
  const menu = document.getElementById('tab-menu');
  if (menuBtn && menu) {
    const closeMenu = () => menu.classList.add('hidden');
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('hidden');
    });
    // Clicking any item runs its own handler, then closes the menu.
    menu.addEventListener('click', () => closeMenu());
    // Click anywhere else (or Esc) closes it.
    document.addEventListener('click', (e) => {
      if (!menu.classList.contains('hidden') && !e.target.closest('#tab-menu-wrap')) closeMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });
  }
}

// ---- Timezone comparator (world clock) ----
const TZ_DEFAULTS = [
  { label: 'Pacific', zone: 'America/Los_Angeles' },
  { label: 'Central US', zone: 'America/Chicago' },
  { label: 'Eastern', zone: 'America/New_York' },
  { label: 'Central Europe', zone: 'Europe/Berlin' },
  { label: 'India', zone: 'Asia/Kolkata' },
  { label: 'Japan', zone: 'Asia/Tokyo' },
];
let tzList = TZ_DEFAULTS.slice();
let tzEditIndex = null; // row being edited (null = adding a new one)

function tzValidZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch (_) {
    return false;
  }
}
// Minutes the zone is ahead of UTC right now (handles DST).
function tzOffsetMinutes(zone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  let hh = m.hour === '24' ? 0 : Number(m.hour);
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, hh, +m.minute, +m.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}
// The absolute instant currently being compared across all zones (a fixed pick,
// scrubbed by dragging a column). Set to "now" each time the planner opens.
let tzSelected = Date.now();
const TZ_ROWS = 13; // hours shown per column
const TZ_CENTER = 6; // the middle (selected) row
const TZ_STEP_MS = 60 * 60000; // one hour between rows
const TZ_CELL_H = 30; // must match .tz-cell height in CSS
const TZ_COL_W = 86; // per-column width used to size the panel
const TZ_SNAP_MS = 30 * 60000; // snap the compared time to clean :00 / :30 marks
const tzSnap = (ms) => Math.round(ms / TZ_SNAP_MS) * TZ_SNAP_MS;

function tzLocalZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
  } catch (_) {
    return 'Local';
  }
}
function tzFmtTime(ms, zone) {
  return new Intl.DateTimeFormat([], {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}
function tzFmtDay(ms, zone) {
  return new Intl.DateTimeFormat([], {
    timeZone: zone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(ms));
}
function tzHourIn(ms, zone) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', hour12: false }).format(
    new Date(ms)
  );
  return h === '24' ? 0 : parseInt(h, 10) || 0;
}
// Working hours green, fringe amber, night dim — so a good meeting slot is one
// where every column is green on the same row.
function tzDayClass(h) {
  if (h >= 9 && h < 18) return 'work';
  if ((h >= 7 && h < 9) || (h >= 18 && h < 22)) return 'fringe';
  return 'night';
}
// All columns: the user's own zone first (as an anchor), then the saved list.
function tzColumns() {
  return [{ label: 'You', zone: tzLocalZone(), fixed: true }, ...tzList];
}

// Keep the TZ panel on-screen: it is right-aligned under its button, so when the
// button sits near the left edge (few tabs) the wide panel would run off into
// negative x. Nudge it right so its left edge stays within the viewport.
function clampTzPanel() {
  const panel = document.getElementById('tz-panel');
  if (!panel || panel.classList.contains('hidden')) return;
  panel.style.transform = 'none'; // reset before measuring the anchored position
  const r = panel.getBoundingClientRect();
  const margin = 8;
  if (r.left < margin) panel.style.transform = `translateX(${Math.ceil(margin - r.left)}px)`;
}

function renderTzGrid() {
  const grid = document.getElementById('tz-grid');
  if (!grid) return;
  const cols = tzColumns();
  grid.innerHTML = '';
  cols.forEach((col, ci) => {
    const valid = tzValidZone(col.zone);
    const colEl = document.createElement('div');
    colEl.className = 'tz-col';

    const head = document.createElement('div');
    head.className = 'tz-col-head';
    const lbl = document.createElement('div');
    lbl.className = 'h-label';
    lbl.textContent = col.label;
    const sub = document.createElement('div');
    sub.className = 'h-sub';
    sub.textContent = valid ? tzFmtDay(tzSelected, col.zone) : 'invalid zone';
    head.append(lbl, sub);
    if (!col.fixed) {
      const tzIndex = ci - 1; // shift past the leading "You" column
      const ed = document.createElement('button');
      ed.className = 'h-edit';
      ed.textContent = '✎';
      ed.title = 'Edit';
      ed.addEventListener('click', (e) => {
        e.stopPropagation();
        tzBeginEdit(tzIndex);
      });
      const dl = document.createElement('button');
      dl.className = 'h-del';
      dl.textContent = '✕';
      dl.title = 'Remove';
      dl.addEventListener('click', (e) => {
        e.stopPropagation();
        tzRemove(tzIndex);
      });
      head.append(ed, dl);
    }

    const cells = document.createElement('div');
    cells.className = 'tz-cells';
    for (let r = 0; r < TZ_ROWS; r++) {
      const ms = tzSelected + (r - TZ_CENTER) * TZ_STEP_MS;
      const cell = document.createElement('div');
      cell.className = 'tz-cell';
      cell.dataset.row = r;
      if (valid) {
        cell.classList.add(tzDayClass(tzHourIn(ms, col.zone)));
        cell.textContent = tzFmtTime(ms, col.zone);
      } else {
        cell.textContent = '—';
      }
      if (r === TZ_CENTER) cell.classList.add('sel');
      cells.appendChild(cell);
    }
    colEl.append(head, cells);
    grid.appendChild(colEl);
  });

  const panel = document.getElementById('tz-panel');
  if (panel) {
    // Cap to the viewport width (never wider than the window); clampTzPanel() then
    // nudges it right if the right-aligned position would push its left edge off-screen.
    const maxW = window.innerWidth - 16;
    panel.style.width = Math.min(cols.length * TZ_COL_W + 18, maxW) + 'px';
    clampTzPanel();
  }
  const foot = document.getElementById('tz-foot');
  if (foot) {
    foot.textContent =
      'Comparing ' +
      new Intl.DateTimeFormat([], {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(tzSelected)) +
      ' your time · drag a column or scroll to change · green = working hours';
  }
}

function tzSave() {
  api.saveSettings({ timezones: tzList });
}
function tzRemove(i) {
  tzList.splice(i, 1);
  if (tzEditIndex === i) tzCancelEdit();
  else if (tzEditIndex != null && i < tzEditIndex) tzEditIndex--;
  tzSave();
  renderTzGrid();
}
function tzBeginEdit(i) {
  tzEditIndex = i;
  document.getElementById('tz-add-label').value = tzList[i].label;
  document.getElementById('tz-add-zone').value = tzList[i].zone;
  document.getElementById('tz-add-btn').textContent = '✓';
  document.getElementById('tz-add-label').focus();
}
function tzCancelEdit() {
  tzEditIndex = null;
  document.getElementById('tz-add-label').value = '';
  document.getElementById('tz-add-zone').value = '';
  document.getElementById('tz-add-btn').textContent = '＋';
  document.getElementById('tz-add-msg').textContent = '';
}
function tzAddOrSave() {
  const labelEl = document.getElementById('tz-add-label');
  const zoneEl = document.getElementById('tz-add-zone');
  const msg = document.getElementById('tz-add-msg');
  const zone = zoneEl.value.trim();
  const label = labelEl.value.trim() || zone.split('/').pop().replace(/_/g, ' ');
  if (!zone) {
    msg.textContent = 'Enter a zone, e.g. Europe/Berlin';
    return;
  }
  if (!tzValidZone(zone)) {
    msg.textContent = 'Unknown timezone: ' + zone;
    return;
  }
  if (tzEditIndex != null && tzList[tzEditIndex]) tzList[tzEditIndex] = { label, zone };
  else tzList.push({ label, zone });
  tzCancelEdit();
  tzSave();
  renderTzGrid();
}

{
  const tzBtn = document.getElementById('tz-btn');
  const tzPanel = document.getElementById('tz-panel');
  if (tzBtn && tzPanel) {
    const grid = document.getElementById('tz-grid');
    const openTz = () => {
      tzSelected = tzSnap(Date.now()); // start near "now", snapped to :00/:20/:40
      renderTzGrid();
      tzPanel.classList.remove('hidden');
      clampTzPanel(); // measurable only now that it's visible
    };
    window.addEventListener('resize', clampTzPanel);
    const closeTz = () => {
      tzPanel.classList.add('hidden');
      tzCancelEdit();
    };
    tzBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (tzPanel.classList.contains('hidden')) openTz();
      else closeTz();
    });
    document.getElementById('tz-close').addEventListener('click', closeTz);
    document.getElementById('tz-now').addEventListener('click', () => {
      tzSelected = tzSnap(Date.now());
      renderTzGrid();
    });
    document.getElementById('tz-add-btn').addEventListener('click', tzAddOrSave);

    // Countdown timer below the planner.
    const tztStart = document.getElementById('tzt-start');
    if (tztStart) tztStart.addEventListener('click', tztStartPause);
    const tztResetBtn = document.getElementById('tzt-reset');
    if (tztResetBtn) tztResetBtn.addEventListener('click', tztReset);
    ['tzt-h', 'tzt-m'].forEach((id) => {
      const el = document.getElementById(id);
      if (el)
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') tztStartPause();
        });
    });

    // Drag a column up/down to scrub the compared instant (snaps to 5 min).
    let tzDrag = null;
    grid.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.h-edit, .h-del')) return;
      tzDrag = { y: e.clientY, sel: tzSelected, moved: 0 };
      try {
        grid.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
    });
    grid.addEventListener('pointermove', (e) => {
      if (!tzDrag) return;
      const dy = e.clientY - tzDrag.y;
      tzDrag.moved = Math.max(tzDrag.moved, Math.abs(dy));
      // Pull the strip down → earlier times move to centre (and vice-versa).
      // One row of drag = one row step (30 min).
      const mins = (dy / TZ_CELL_H) * (TZ_STEP_MS / 60000);
      tzSelected = tzSnap(tzDrag.sel - mins * 60000);
      renderTzGrid();
    });
    grid.addEventListener('pointerup', (e) => {
      // A tap (no real drag) on a cell jumps the selection to that row's time.
      if (tzDrag && tzDrag.moved < 4) {
        const cell = e.target.closest('.tz-cell');
        if (cell && cell.dataset.row != null) {
          tzSelected += (+cell.dataset.row - TZ_CENTER) * TZ_STEP_MS;
          renderTzGrid();
        }
      }
      tzDrag = null;
    });
    grid.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        tzSelected = tzSnap(tzSelected - (e.deltaY > 0 ? 1 : -1) * TZ_SNAP_MS); // 30-min steps
        renderTzGrid();
      },
      { passive: false }
    );

    tzPanel.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target.id === 'tz-add-label' || e.target.id === 'tz-add-zone')) {
        e.preventDefault();
        tzAddOrSave();
      } else if (e.key === 'Escape') {
        if (tzEditIndex != null) tzCancelEdit();
        else closeTz();
      }
    });
    // Click outside closes the panel. mousedown (not click) fires reliably even for
    // presses that become drags/selections.
    document.addEventListener('mousedown', (e) => {
      if (!tzPanel.classList.contains('hidden') && !e.target.closest('#tz-wrap')) closeTz();
    });
    // Clicking into a web <webview> moves focus out of the renderer without a DOM
    // click reaching us — close on blur so the panel doesn't get stuck open.
    window.addEventListener('blur', () => {
      if (!tzPanel.classList.contains('hidden')) closeTz();
    });
  }
}

let noteTopZ = 1;
// Notes must stay below the modal overlays (z ~100) and the tab-bar popovers (z 1000).
// Renormalize z whenever click-to-front climbs near that range so it never crosses it.
const NOTE_Z_CEILING = 50;
function renormalizeNoteZ() {
  const sorted = [...notesData].sort((a, b) => (a.z || 1) - (b.z || 1));
  sorted.forEach((n, i) => {
    n.z = i + 1;
  });
  noteTopZ = sorted.length;
  if (notesBoardEl) {
    for (const n of notesData) {
      const el = notesBoardEl.querySelector(`.note[data-note-id="${n.id}"]`);
      if (el) el.style.zIndex = n.z;
    }
  }
}
function bringToFront(note, el) {
  if (noteTopZ >= NOTE_Z_CEILING) renormalizeNoteZ();
  note.z = ++noteTopZ;
  el.style.zIndex = note.z;
  saveNotes();
}

// Inline Markdown (escaped) -> safe HTML.
function inlineMd(s) {
  s = escapeHtml(s);
  s = s.replace(/`([^`\n]+?)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/\*([^*\n]+?)\*/g, '<i>$1</i>');
  s = s.replace(/(^|\s)_([^_\n]+?)_(?=\s|$)/g, '$1<i>$2</i>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<span class="note-link" data-url="$2">$1</span>');
  return s;
}

// If a line is an `ssh …` command or contains a URL, return a tiny action button
// (run the SSH session / open the link). Returns '' for ordinary lines.
function lineActionHtml(line) {
  const t = String(line).trim();
  const ssh = t.match(/^ssh\s+(\S.*)$/i);
  if (ssh) {
    return ` <button class="note-act" data-act="ssh" data-arg="${escapeHtml(
      ssh[1].trim()
    )}" title="Open SSH session">▶ ssh</button>`;
  }
  const url = t.match(/https?:\/\/[^\s<>"')]+/);
  if (url) {
    return ` <button class="note-act" data-act="open" data-arg="${escapeHtml(
      url[0]
    )}" title="Open link">↗ open</button>`;
  }
  return '';
}

// Parse an "[user@]host [-p port]" ssh target string into its parts.
function parseSshTarget(str) {
  const tokens = (str || '').trim().split(/\s+/);
  let username = '';
  let host = '';
  let port = 22;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if ((tok === '-p' || tok === '-P') && tokens[i + 1]) {
      port = Number(tokens[++i]) || 22;
    } else if (!host && !tok.startsWith('-')) {
      if (tok.includes('@')) {
        const at = tok.split('@');
        username = at[0];
        host = at[1];
      } else {
        host = tok;
      }
    }
  }
  return { username, host, port };
}

// Open an SSH tab for an ssh:// link delivered by the OS ({username, host, port}).
// If a jump/bastion host is configured in Settings, connect there first and hop to
// the target with an `ssh …` command once the bastion session is up.
function openSshUrl(t) {
  if (!t || !t.host) return;
  const port = Number(t.port) || 22;
  const target = (t.username ? t.username + '@' : '') + t.host;
  const jump = (sshJumpHost || '').trim();
  if (jump) {
    const j = parseSshTarget(jump);
    if (j.host) {
      const id = createTab({
        name: target + ' (via ' + j.host + ')',
        host: j.host,
        port: j.port,
        username: j.username,
        authMethod: 'agent',
        keyPath: '',
      });
      const rec = tabs.get(id);
      if (rec) rec.startupCmd = 'ssh ' + target + (port !== 22 ? ' -p ' + port : '');
      return;
    }
  }
  createTab({ name: target, host: t.host, port, username: t.username, authMethod: 'agent', keyPath: '' });
}

// Open an SSH tab from a note's `ssh …` line: match a saved session by name/host,
// else parse "[user@]host [-p port]".
function runSshFromNote(arg) {
  const raw = (arg || '').trim();
  if (!raw) return;
  const saved = savedSessions.find(
    (s) => s.name.toLowerCase() === raw.toLowerCase() || s.host === raw
  );
  if (saved) {
    createTab({ ...saved });
    return;
  }
  const tokens = raw.split(/\s+/);
  let username = '';
  let host = '';
  let port = 22;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if ((tok === '-p' || tok === '-P') && tokens[i + 1]) {
      port = Number(tokens[++i]) || 22;
    } else if (!host && !tok.startsWith('-')) {
      if (tok.includes('@')) {
        const at = tok.split('@');
        username = at[0];
        host = at[1];
      } else {
        host = tok;
      }
    }
  }
  if (!host) return;
  createTab({ name: raw, host, port, username, authMethod: 'agent', keyPath: '' });
}

// Line-aware Markdown -> safe HTML. Task lines (- [ ] / - [x]) become checkboxes
// tagged with their source line index so clicks can edit the underlying text.
function mdToHtml(src) {
  const lines = (src || '').split('\n');
  const out = [];
  let inFence = false;
  let fence = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      if (!inFence) {
        inFence = true;
        fence = [];
      } else {
        out.push('<pre class="note-pre">' + escapeHtml(fence.join('\n')) + '</pre>');
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      fence.push(line);
      continue;
    }
    const task = line.match(/^\s*(?:[-*]\s+)?\[([ xX/])\]\s*(.*)$/);
    if (task) {
      const ch = task[1].toLowerCase();
      const done = ch === 'x';
      const doing = ch === '/';
      out.push(
        `<div class="note-task${doing ? ' doing' : ''}" data-line="${i}">` +
          `<span class="task-grip" title="Drag to reorder">⠿</span>` +
          `<input type="checkbox" class="task-check"${done ? ' checked' : ''}>` +
          `<span class="task-text${done ? ' done' : ''}">${inlineMd(task[2])}</span>` +
          `<button class="task-del" title="Delete task">✕</button></div>`
      );
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      const n = h[1].length;
      out.push(`<h${n}>${inlineMd(h[2])}</h${n}>`);
      continue;
    }
    const b = line.match(/^\s*[-*]\s+(.+)$/);
    if (b) {
      out.push('• ' + inlineMd(b[1]) + lineActionHtml(b[1]) + '<br>');
      continue;
    }
    out.push(line.trim() === '' ? '<br>' : inlineMd(line) + lineActionHtml(line) + '<br>');
  }
  if (inFence) out.push('<pre class="note-pre">' + escapeHtml(fence.join('\n')) + '</pre>');
  return out.join('');
}

// Toggle or delete a task line in a note's source text (no DOM). Returns true if changed.
function setTaskState(note, idx, del) {
  const lines = note.text.split('\n');
  if (idx < 0 || idx >= lines.length) return false;
  if (del) lines.splice(idx, 1);
  else
    lines[idx] = lines[idx].replace(/^(\s*(?:[-*]\s+)?\[)([ xX/])(\])/, (_m, a, c, z) =>
      a + (c.toLowerCase() === 'x' ? ' ' : 'x') + z
    );
  note.text = lines.join('\n');
  saveNotes();
  return true;
}

// Set a task line's marker to a specific char (' ' todo, '/' doing, 'x' done).
function setTaskMarker(note, idx, char) {
  const lines = note.text.split('\n');
  if (idx < 0 || idx >= lines.length) return false;
  lines[idx] = lines[idx].replace(/^(\s*(?:[-*]\s+)?\[)([ xX/])(\])/, (_m, a, _c, z) => a + char + z);
  note.text = lines.join('\n');
  saveNotes();
  return true;
}

// Toggle a task's checkbox, or delete its line, then re-render the note body.
function updateTaskLine(note, body, idx, del) {
  if (setTaskState(note, idx, del)) body.innerHTML = mdToHtml(note.text);
}

// Move one line (a task being dragged) so it lands just before the target line.
function moveTaskLine(note, fromIdx, toIdx) {
  const lines = note.text.split('\n');
  if (fromIdx < 0 || fromIdx >= lines.length || toIdx < 0 || toIdx >= lines.length) return;
  const [moved] = lines.splice(fromIdx, 1);
  const insertAt = fromIdx < toIdx ? toIdx - 1 : toIdx;
  lines.splice(insertAt, 0, moved);
  note.text = lines.join('\n');
  saveNotes();
}

// Re-render a note's body in place if it's currently on the board (not being edited).
function refreshNoteBody(note) {
  const el = notesBoardEl && notesBoardEl.querySelector(`.note[data-note-id="${note.id}"]`);
  if (!el) return;
  const body = el.querySelector('.note-body');
  if (body && document.activeElement !== body) body.innerHTML = mdToHtml(note.text);
}

// Note links open in the browser (mousedown so we don't focus the note into edit mode).
document.addEventListener('mousedown', (e) => {
  const l = e.target.closest && e.target.closest('.note-link');
  if (l && l.dataset.url) {
    e.preventDefault();
    api.openExternal(l.dataset.url);
  }
});

// Caret offset within a contenteditable (single text node when editing raw).
function caretOffset(el) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer)) return null;
  const pre = r.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}
function setCaret(el, pos) {
  el.focus();
  const tn = el.firstChild;
  const range = document.createRange();
  if (tn && tn.nodeType === 3) range.setStart(tn, Math.min(pos, tn.length));
  else range.selectNodeContents(el);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function toLocalInput(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

function renderNote(note) {
  const el = document.createElement('div');
  el.className = 'note';
  el.dataset.noteId = note.id;
  el.style.left = note.x + 'px';
  el.style.top = note.y + 'px';
  el.style.background = note.color;
  el.style.zIndex = note.z || 1;
  if (note.w) el.style.width = note.w + 'px';
  if (note.h) el.style.height = note.h + 'px';
  if ((note.z || 1) > noteTopZ) noteTopZ = note.z || 1;
  el.innerHTML =
    '<div class="note-head"><button class="note-add" title="Insert a checkbox task at the cursor">☑ Task</button>' +
    '<button class="note-del" title="Delete note">✕</button></div>';
  const titleInput = document.createElement('input');
  titleInput.className = 'note-title';
  titleInput.placeholder = 'Title';
  titleInput.value = note.title || '';
  titleInput.addEventListener('input', () => {
    note.title = titleInput.value;
    saveNotes();
  });
  el.appendChild(titleInput);

  const body = document.createElement('div');
  body.className = 'note-body';
  body.contentEditable = 'true';
  body.spellcheck = false;
  body.innerHTML = mdToHtml(note.text); // rendered Markdown when not editing
  el.appendChild(body);

  // Task checkbox / delete + action buttons: act without entering edit mode.
  body.addEventListener('mousedown', (e) => {
    const act = e.target.closest('.note-act');
    if (act) {
      e.preventDefault();
      e.stopPropagation();
      if (act.dataset.act === 'open') api.openExternal(act.dataset.arg);
      else if (act.dataset.act === 'ssh') runSshFromNote(act.dataset.arg);
      return;
    }
    const ctl = e.target.closest('.task-check, .task-del');
    if (!ctl) return;
    e.preventDefault();
    const row = ctl.closest('.note-task');
    if (row) updateTaskLine(note, body, parseInt(row.dataset.line, 10), ctl.classList.contains('task-del'));
  });

  // Drag a task by its grip to reorder it among the note's lines (rendered view).
  body.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.task-grip');
    if (!grip) return;
    e.preventDefault();
    e.stopPropagation();
    const startRow = grip.closest('.note-task');
    if (!startRow) return;
    const fromLine = parseInt(startRow.dataset.line, 10);
    let targetLine = fromLine;
    startRow.classList.add('dragging');
    body.setPointerCapture(e.pointerId);
    const clearTargets = () =>
      body.querySelectorAll('.note-task.drop-target').forEach((r) => r.classList.remove('drop-target'));
    const move = (ev) => {
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      const row = over && over.closest && over.closest('.note-task');
      clearTargets();
      if (row && row !== startRow) {
        row.classList.add('drop-target');
        targetLine = parseInt(row.dataset.line, 10);
      } else {
        targetLine = fromLine;
      }
    };
    const up = () => {
      body.removeEventListener('pointermove', move);
      body.removeEventListener('pointerup', up);
      startRow.classList.remove('dragging');
      clearTargets();
      if (targetLine !== fromLine) moveTaskLine(note, fromLine, targetLine);
      body.innerHTML = mdToHtml(note.text);
    };
    body.addEventListener('pointermove', move);
    body.addEventListener('pointerup', up);
  });

  // Enter on a task line continues the list with a fresh [ ]; an empty task ends it.
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey) return;
    const raw = body.textContent; // raw Markdown while editing
    const off = caretOffset(body);
    if (off == null) return;
    const lineStart = raw.lastIndexOf('\n', off - 1) + 1;
    let lineEnd = raw.indexOf('\n', off);
    if (lineEnd === -1) lineEnd = raw.length;
    const m = raw.slice(lineStart, lineEnd).match(/^(\s*(?:[-*]\s+)?)\[[ xX]\]\s*(.*)$/);
    if (!m) return;
    e.preventDefault();
    if (m[2].trim() === '') {
      // Empty task → drop the marker to end the list.
      const next = raw.slice(0, lineStart) + raw.slice(lineEnd);
      body.textContent = next;
      note.text = next;
      setCaret(body, lineStart);
    } else {
      const insert = '\n' + m[1] + '[ ] ';
      const next = raw.slice(0, off) + insert + raw.slice(off);
      body.textContent = next;
      note.text = next;
      setCaret(body, off + insert.length);
    }
    saveNotes();
  });

  // Click to edit raw Markdown; blur re-renders it.
  body.addEventListener('focus', () => {
    body.textContent = note.text;
  });
  body.addEventListener('input', () => {
    note.text = body.innerText;
    saveNotes();
  });
  body.addEventListener('blur', () => {
    note.text = body.innerText;
    body.innerHTML = mdToHtml(note.text);
    saveNotes();
  });

  // Raise above other notes; flag a deliberate grab of the resize corner.
  el.addEventListener('pointerdown', (e) => {
    bringToFront(note, el);
    const r = el.getBoundingClientRect();
    if (e.clientX > r.right - 18 && e.clientY > r.bottom - 18) note._manual = true;
  });

  // Persist width always; persist height only when the corner was dragged
  // (otherwise the note auto-grows to fit its text).
  const ro = new ResizeObserver(() => {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // When the Notes tab is hidden the pane is display:none and these read 0 —
    // ignore that so we don't clobber the saved size with zeros.
    if (w === 0 || h === 0) return;
    if (w !== note.w) {
      note.w = w;
      saveNotes();
    }
    if (note._manual && h !== note.h) {
      note.h = h;
      saveNotes();
    }
  });
  ro.observe(el);

  // Due time — pops the note when it arrives.
  const foot = document.createElement('div');
  foot.className = 'note-foot';
  const lbl = document.createElement('span');
  lbl.className = 'note-due-label';
  lbl.textContent = '⏰';
  const dueInput = document.createElement('input');
  dueInput.type = 'datetime-local';
  dueInput.className = 'note-due';
  dueInput.title = 'Pop this note up at this time';
  if (note.due) dueInput.value = toLocalInput(note.due);
  dueInput.addEventListener('change', () => {
    note.due = dueInput.value ? Date.parse(dueInput.value) : null;
    note.dueFired = false; // re-arm
    saveNotes();
  });
  foot.appendChild(lbl);
  foot.appendChild(dueInput);
  el.appendChild(foot);

  // Delete — confirm first if the note holds 2+ tasks (likely not a throwaway).
  el.querySelector('.note-del').addEventListener('click', () => {
    const taskCount = (note.text || '')
      .split('\n')
      .filter((l) => /^\s*(?:[-*]\s+)?\[[ xX]\]/.test(l)).length;
    if (taskCount >= 2) {
      const label = noteLabel(note);
      if (!window.confirm(`Delete "${label}"? It has ${taskCount} tasks.`)) return;
    }
    notesData = notesData.filter((n) => n.id !== note.id);
    el.remove();
    saveNotes();
  });

  // Add a checkbox task at the cursor (mousedown keeps the caret; preventDefault avoids blur).
  el.querySelector('.note-add').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const wasFocused = document.activeElement === body;
    if (!wasFocused) body.focus(); // focus handler swaps to raw text
    const raw = wasFocused ? body.textContent : note.text;
    let off = wasFocused ? caretOffset(body) : null;
    if (off == null) off = raw.length; // not editing → append
    const atLineStart = off === 0 || raw[off - 1] === '\n';
    const insert = (atLineStart ? '' : '\n') + '[ ] ';
    const next = raw.slice(0, off) + insert + raw.slice(off);
    body.textContent = next;
    note.text = next;
    setCaret(body, off + insert.length); // caret after "[ ] " to type the task
    saveNotes();
  });

  // Drag by the header
  const head = el.querySelector('.note-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.note-del, .note-add')) return; // let header buttons receive clicks
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = note.x;
    const oy = note.y;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => {
      note.x = Math.max(0, ox + (ev.clientX - sx));
      note.y = Math.max(0, oy + (ev.clientY - sy));
      el.style.left = note.x + 'px';
      el.style.top = note.y + 'px';
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      saveNotes();
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });

  // Right-click to color
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openNotePalette(e.clientX, e.clientY, note, el);
  });

  notesBoardEl.appendChild(el);
}

function addNote() {
  const note = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: '',
    x: 24 + ((notesData.length * 26) % 320),
    y: 24 + ((notesData.length * 22) % 220),
    color: NOTE_COLORS[0],
  };
  notesData.push(note);
  renderNote(note);
  saveNotes();
}

// Cascading spawn position so new notes don't pile up exactly on top of each other.
function nextNotePos() {
  return {
    x: 24 + ((notesData.length * 34) % 300),
    y: 24 + ((notesData.length * 30) % 200),
  };
}

// Add a note, open/focus the board, render + raise it, and flash it so it's obvious
// where it landed. Optionally drop the caret straight into it for editing.
function spawnNote(note, opts) {
  opts = opts || {};
  notesData.push(note);
  logEvent('note', { title: noteLabel(note), ref: { type: 'note', id: note.id } });
  createNotesTab(); // creates (renders all) or focuses the board
  if (notesBoardEl && !notesBoardEl.querySelector(`.note[data-note-id="${note.id}"]`)) {
    renderNote(note); // board already existed → render just this one
  }
  saveNotes();
  const el = notesBoardEl && notesBoardEl.querySelector(`.note[data-note-id="${note.id}"]`);
  if (el) {
    bringToFront(note, el);
    el.classList.add('note-due-flash');
    setTimeout(() => el.classList.remove('note-due-flash'), 4000);
    if (opts.focus) {
      const body = el.querySelector('.note-body');
      if (body) body.focus(); // focus handler swaps to raw text for immediate editing
    }
  }
  return el;
}

// Capture the current terminal selection into a note, auto-tagged with the host, a
// timestamp, and the command that produced the output (from the tab's command tracker).
// Works for both SSH and local tabs; the selection is fenced so it renders monospaced.
function captureTermNote(rec) {
  const term = rec && rec.term;
  if (!term) return false;
  const sel = term.getSelection();
  if (!sel || !sel.trim()) return false;
  const host = rec.kind === 'local'
    ? 'local'
    : ((rec.profile && (rec.profile.name || rec.profile.host)) || 'terminal');
  const cmd = (rec.cmdName || '').trim();
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const tag = `${host} · ${stamp}` + (cmd ? ` · ${cmd}` : '');
  const cleaned = sel.replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
  const body = '`' + tag + '`\n\n```\n' + cleaned + '\n```\n';
  captureToNote({ title: cmd || host, text: body });
  return true;
}

// Create a note pre-filled from elsewhere (a Slack message, an email, terminal text),
// open/focus the board, and flash the new note so it's obvious where it landed.
function captureToNote({ title, text, color }) {
  const note = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: (title || '').slice(0, 120),
    text: text || '',
    ...nextNotePos(),
    color: color || NOTE_COLORS[2],
  };
  // Only long captures (e.g. an email body) would auto-grow off-screen and make the
  // resize corner unreachable — give those a fixed, scrollable size. Short captures
  // and templates keep the default width so they don't heavily overlap each other.
  if ((text || '').length > 240) {
    note.w = 300;
    note.h = 340;
  }
  spawnNote(note);
}

// --- Tasks dashboard: aggregate every [ ] across all notes ---
function collectTasks() {
  const out = [];
  for (const note of notesData) {
    const lines = (note.text || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*(?:[-*]\s+)?\[([ xX/])\]\s*(.*)$/);
      if (m) {
        const ch = m[1].toLowerCase();
        out.push({
          note,
          lineIdx: i,
          done: ch === 'x',
          state: ch === 'x' ? 'done' : ch === '/' ? 'doing' : 'todo',
          text: m[2],
        });
      }
    }
  }
  return out;
}

// A short label for a note: its title, else its first non-empty line.
function noteLabel(note) {
  return (
    (note.title && note.title.trim()) ||
    (note.text || '')
      .split('\n')
      .map((s) => s.trim())
      .find(Boolean) ||
    '(untitled)'
  );
}

// Bring a note to the front of the board and flash it.
function jumpToNote(note) {
  if (tasksDashEl) tasksDashEl.classList.add('hidden');
  const el = notesBoardEl && notesBoardEl.querySelector(`.note[data-note-id="${note.id}"]`);
  if (!el) return;
  bringToFront(note, el);
  el.classList.add('note-due-flash');
  setTimeout(() => el.classList.remove('note-due-flash'), 4000);
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderTasksDash() {
  if (!tasksDashEl) return;
  const all = collectTasks();
  const openCount = all.filter((t) => !t.done).length;
  const tasks = tasksShowDone ? all : all.filter((t) => !t.done);

  const head = document.createElement('div');
  head.className = 'td-head';
  head.innerHTML =
    `<span class="td-title">☑ Tasks <span class="td-count">${openCount} open</span></span>` +
    `<button class="td-close" title="Close">✕</button>` +
    `<label class="td-toggle"><input type="checkbox" class="td-showdone"${
      tasksShowDone ? ' checked' : ''
    }> show done</label>`;

  const list = document.createElement('div');
  list.className = 'td-list';
  if (!tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'td-empty';
    empty.textContent = all.length ? 'No open tasks 🎉' : 'No tasks yet — add [ ] lines to a note.';
    list.appendChild(empty);
  } else {
    for (const t of tasks) {
      const row = document.createElement('div');
      row.className = 'td-row' + (t.done ? ' done' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'td-check';
      cb.checked = t.done;
      cb.addEventListener('change', () => {
        setTaskState(t.note, t.lineIdx, false);
        refreshNoteBody(t.note);
        renderTasksDash();
      });
      const txt = document.createElement('span');
      txt.className = 'td-text';
      txt.innerHTML = inlineMd(t.text) || '<i class="td-blank">(empty task)</i>';
      const chip = document.createElement('button');
      chip.className = 'td-jump';
      chip.textContent = noteLabel(t.note);
      chip.title = 'Jump to this note';
      chip.style.background = t.note.color || '';
      chip.addEventListener('click', () => jumpToNote(t.note));
      row.appendChild(cb);
      row.appendChild(txt);
      row.appendChild(chip);
      list.appendChild(row);
    }
  }

  tasksDashEl.innerHTML = '';
  tasksDashEl.appendChild(head);
  tasksDashEl.appendChild(list);
  head.querySelector('.td-close').addEventListener('click', () =>
    tasksDashEl.classList.add('hidden')
  );
  head.querySelector('.td-showdone').addEventListener('change', (e) => {
    tasksShowDone = e.target.checked;
    renderTasksDash();
  });
}

// --- Note templates: one click drops a scaffolded note ---
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addTemplateNote(kind) {
  let title = '';
  let text = '';
  if (kind === 'standup') {
    title = 'Standup ' + todayStr();
    text = '## Yesterday\n[ ] \n\n## Today\n[ ] \n\n## Blockers\n- ';
  } else if (kind === 'incident') {
    title = 'Incident ' + todayStr();
    text =
      '**Severity:** \n**Impact:** \n**Started:** \n\n## Timeline\n- \n\n## Action items\n[ ] ';
  } else if (kind === 'checklist') {
    title = 'Checklist';
    text = '[ ] \n[ ] \n[ ] ';
  } else {
    return;
  }
  // Templates are short — keep the default width (no overlap) and open them focused
  // so you can fill in the scaffold right away.
  const note = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title,
    text,
    ...nextNotePos(),
    color: NOTE_COLORS[0],
  };
  spawnNote(note, { focus: true });
}

// --- Kanban view: all tasks as cards in To do / Doing / Done columns ---
const KANBAN_COLS = [
  { key: 'todo', char: ' ', title: 'To do' },
  { key: 'doing', char: '/', title: 'Doing' },
  { key: 'done', char: 'x', title: 'Done' },
];
function renderKanban() {
  if (!kanbanEl) return;
  const tasks = collectTasks();
  kanbanEl.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'td-head';
  head.innerHTML =
    `<span class="td-title">▦ Board <span class="td-count">${tasks.length} tasks</span></span>` +
    `<button class="kb-close td-close" title="Close">✕</button>`;
  kanbanEl.appendChild(head);
  head.querySelector('.kb-close').addEventListener('click', () => kanbanEl.classList.add('hidden'));

  const cols = document.createElement('div');
  cols.className = 'kb-cols';
  for (const col of KANBAN_COLS) {
    const items = tasks.filter((t) => t.state === col.key);
    const colEl = document.createElement('div');
    colEl.className = 'kb-col';
    colEl.dataset.col = col.key;
    colEl.innerHTML = `<div class="kb-col-title">${col.title} <span class="td-count">${items.length}</span></div>`;
    const list = document.createElement('div');
    list.className = 'kb-list';

    for (const t of items) {
      const card = document.createElement('div');
      card.className = 'kb-card';
      card.draggable = true;
      const txt = document.createElement('div');
      txt.className = 'kb-card-text';
      txt.innerHTML = inlineMd(t.text) || '<i class="td-blank">(empty task)</i>';
      const chip = document.createElement('button');
      chip.className = 'td-jump';
      chip.textContent = noteLabel(t.note);
      chip.title = 'Jump to this note';
      chip.style.background = t.note.color || '';
      chip.addEventListener('click', () => jumpToNote(t.note));
      card.appendChild(txt);
      card.appendChild(chip);
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', t.note.id + '|' + t.lineIdx);
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      list.appendChild(card);
    }
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'kb-empty';
      empty.textContent = '—';
      list.appendChild(empty);
    }

    colEl.appendChild(list);
    colEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      colEl.classList.add('kb-over');
    });
    colEl.addEventListener('dragleave', () => colEl.classList.remove('kb-over'));
    colEl.addEventListener('drop', (e) => {
      e.preventDefault();
      colEl.classList.remove('kb-over');
      const [nid, lineStr] = (e.dataTransfer.getData('text/plain') || '').split('|');
      const note = notesData.find((n) => n.id === nid);
      if (note && setTaskMarker(note, parseInt(lineStr, 10), col.char)) {
        refreshNoteBody(note);
        renderKanban();
      }
    });
    cols.appendChild(colEl);
  }
  kanbanEl.appendChild(cols);
}

// Build the color palette once, then position/show it for a note.
function openNotePalette(x, y, note, el) {
  if (!els.notePalette.childElementCount) {
    for (const c of NOTE_COLORS) {
      const s = document.createElement('div');
      s.className = 'note-swatch';
      s.style.background = c;
      s.dataset.color = c;
      els.notePalette.appendChild(s);
    }
  }
  els.notePalette._note = note;
  els.notePalette._el = el;
  els.notePalette.classList.remove('hidden');
  els.notePalette.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  els.notePalette.style.top = Math.min(y, window.innerHeight - 50) + 'px';
}
els.notePalette.addEventListener('click', (e) => {
  const sw = e.target.closest('.note-swatch');
  if (!sw) return;
  const note = els.notePalette._note;
  if (note) {
    note.color = sw.dataset.color;
    if (els.notePalette._el) els.notePalette._el.style.background = note.color;
    saveNotes();
  }
  els.notePalette.classList.add('hidden');
});
document.addEventListener('click', (e) => {
  if (!els.notePalette.classList.contains('hidden') && !e.target.closest('#note-palette')) {
    els.notePalette.classList.add('hidden');
  }
});

// ---------------------------------------------------------------------------
// Command Deck - a live "home" dashboard tab: next meeting, project time today,
// tasks, unread messages, and quick-launch buttons. Reuses existing data sources.
// ---------------------------------------------------------------------------
function deckCountdown(ms) {
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd';
}
function deckGreeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
function deckUnread() {
  let slack = 0;
  for (const r of tabs.values()) if (r.kind === 'slack') slack += r.unread || 0;
  const mail = googleConnected ? gmailLastMessages.filter((m) => m.unread).length : null;
  const wa = whatsappConnected ? whatsappFeedData.filter((m) => !m.fromMe).length : null;
  return { slack, mail, wa };
}
function createDeckTab() {
  for (const [tid, r] of tabs) {
    if (r.kind === 'deck') {
      activateTab(tid);
      return tid;
    }
  }
  const id = newTabId();
  const { tabEl, paneEl } = createTabChrome(id, 'Home', 'deck');
  paneEl.classList.remove('term-pane');
  paneEl.classList.add('deck-pane');
  const body = document.createElement('div');
  body.className = 'deck-body';
  paneEl.appendChild(body);
  const rec = { id, kind: 'deck', paneEl, tabEl, deckBody: body, status: 'connected', profile: { name: 'Home' } };
  tabs.set(id, rec);
  renderDeck(rec);
  activateTab(id);
  bbTabOpen(rec);
  persistTabOrder();
  return id;
}
function renderDeck(rec) {
  if (!rec || !rec.deckBody) return;
  const now = Date.now();
  const clock = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const date = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  // Meeting
  const mtg = nextTimedEvent();
  const mtgCard = mtg
    ? `<div class="dk-big">${deckCountdown(mtg.startMs - now)}</div>` +
      `<div class="dk-line">${escapeHtml(mtg.summary || 'Meeting')}</div>` +
      `<div class="dk-sub">${new Date(mtg.startMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</div>` +
      (mtg.meetLink ? `<button class="dk-btn dk-join" data-act="join">▶ Join</button>` : '')
    : `<div class="dk-empty">No meetings ahead</div>`;

  // Project time today
  const today = paTodayMerged();
  const grand = Object.values(today).reduce((a, b) => a + b, 0);
  const cur = paProject(paCurrentId);
  const projCard =
    `<div class="dk-big">${fmtHM(grand)}</div>` +
    `<div class="dk-line">${cur ? `<span class="dk-dot" style="background:${cur.color}"></span>${escapeHtml(cur.name)} · ${fmtHM(today[cur.id] || 0)}` : 'No project selected'}</div>` +
    `<div class="dk-row"><button class="dk-btn" data-act="proj-toggle">${paRunning ? '⏸ Pause' : '▶ Start'}</button>` +
    `<button class="dk-btn" data-act="proj-open">Projects</button></div>`;

  // Tasks
  const { open, overdue } = petStats();
  const taskCard =
    `<div class="dk-big">${open}<span class="dk-unit"> open</span></div>` +
    (overdue > 0 ? `<div class="dk-line dk-warn">${overdue} overdue</div>` : `<div class="dk-line">nothing overdue 🎉</div>`) +
    `<div class="dk-row"><button class="dk-btn" data-act="notes">Open notes</button></div>`;

  // Messages
  const u = deckUnread();
  const chips = [];
  chips.push(`<span class="dk-chip${u.slack ? ' hot' : ''}">＃ Slack ${u.slack}</span>`);
  if (u.wa != null) chips.push(`<span class="dk-chip${u.wa ? ' hot' : ''}">🟢 WhatsApp ${u.wa}</span>`);
  if (u.mail != null) chips.push(`<span class="dk-chip${u.mail ? ' hot' : ''}">📧 Mail ${u.mail}</span>`);
  const msgCard = `<div class="dk-chips">${chips.join('')}</div>`;

  const launch = [
    ['ssh', '＋ SSH'],
    ['local', '🖥 Local'],
    ['web', '🌐 Web'],
    ['notes', '📝 Notes'],
    ['code', '🧑‍💻 VS Code'],
    ['slack', '＃ Slack'],
    ['expose', '🧊 3D'],
    ['tz', '🕐 TZ'],
    ['blackbox', '✈️ Black Box'],
  ]
    .map(([act, label]) => `<button class="dk-launch" data-act="${act}">${label}</button>`)
    .join('');

  rec.deckBody.innerHTML =
    `<div class="dk-head"><div class="dk-hello">${deckGreeting()} 🛩</div>` +
    `<div class="dk-clock">${clock}</div><div class="dk-date">${date}</div></div>` +
    '<div class="dk-grid">' +
    `<div class="dk-card"><div class="dk-cap">Next meeting</div>${mtgCard}</div>` +
    `<div class="dk-card"><div class="dk-cap">Time today</div>${projCard}</div>` +
    `<div class="dk-card"><div class="dk-cap">Tasks</div>${taskCard}</div>` +
    `<div class="dk-card"><div class="dk-cap">Messages</div>${msgCard}</div>` +
    '</div>' +
    `<div class="dk-cap dk-launch-cap">Quick launch</div><div class="dk-launch-row">${launch}</div>`;

  rec.deckBody.querySelectorAll('[data-act]').forEach((el) => {
    el.addEventListener('click', () => deckAction(el.dataset.act, mtg));
  });
}
function deckAction(act, mtg) {
  const click = (elId) => {
    const b = document.getElementById(elId);
    if (b) b.click();
  };
  switch (act) {
    case 'join': if (mtg && mtg.meetLink) api.openExternal(mtg.meetLink); break;
    case 'proj-toggle': setProjectRunning(!paRunning); break;
    case 'proj-open': case 'proj': openProjectOverlay(); break;
    case 'ssh': openDialog(); break;
    case 'local': createLocalTab({ cwd: terminalCwd || undefined }); break;
    case 'web': click('web-btn'); break;
    case 'notes': createNotesTab(); break;
    case 'code': click('code-btn'); break;
    case 'slack': click('slack-btn'); break;
    case 'expose': click('expose-btn'); break;
    case 'tz': click('tz-btn'); break;
    case 'blackbox': click('blackbox-btn'); break;
  }
}
// Keep the active deck fresh (clock + counts) without per-tab timers.
setInterval(() => {
  const rec = activeTabId && tabs.get(activeTabId);
  if (rec && rec.kind === 'deck') renderDeck(rec);
}, 1000);

function createNotesTab() {
  // Single notes board — focus it if already open.
  for (const [tid, r] of tabs) {
    if (r.kind === 'notes') {
      activateTab(tid);
      return tid;
    }
  }
  const id = newTabId();
  const { tabEl, paneEl } = createTabChrome(id, 'Notes', 'notes');
  paneEl.classList.remove('term-pane');
  paneEl.classList.add('notes-pane');
  paneEl.innerHTML =
    '<div class="notes-toolbar"><button class="notes-add">+ New note</button>' +
    '<select class="notes-template" title="New note from a template">' +
    '<option value="">+ Template…</option>' +
    '<option value="standup">📋 Standup</option>' +
    '<option value="incident">🚨 Incident</option>' +
    '<option value="checklist">☑ Checklist</option></select>' +
    '<button class="notes-tasks" title="See every task across all notes">☑ Tasks</button>' +
    '<button class="notes-kanban" title="Board view: To do / Doing / Done">▦ Board</button>' +
    '<span class="notes-hint">Click text to edit · click away to render · ☑ adds a task · drag top bar · right-click = color</span></div>' +
    '<div class="notes-board"></div>' +
    '<div class="tasks-dash hidden"></div>' +
    '<div class="kanban hidden"></div>';
  notesBoardEl = paneEl.querySelector('.notes-board');
  tasksDashEl = paneEl.querySelector('.tasks-dash');
  kanbanEl = paneEl.querySelector('.kanban');
  paneEl.querySelector('.notes-add').addEventListener('click', addNote);

  const tplSel = paneEl.querySelector('.notes-template');
  tplSel.addEventListener('change', () => {
    if (tplSel.value) addTemplateNote(tplSel.value);
    tplSel.value = '';
  });

  const tasksBtn = paneEl.querySelector('.notes-tasks');
  const kbBtn = paneEl.querySelector('.notes-kanban');
  tasksBtn.addEventListener('click', () => {
    const nowOpen = tasksDashEl.classList.contains('hidden');
    tasksDashEl.classList.toggle('hidden', !nowOpen);
    tasksBtn.classList.toggle('active', nowOpen);
    if (nowOpen) {
      kanbanEl.classList.add('hidden');
      kbBtn.classList.remove('active');
      renderTasksDash();
    }
  });
  kbBtn.addEventListener('click', () => {
    const nowOpen = kanbanEl.classList.contains('hidden');
    kanbanEl.classList.toggle('hidden', !nowOpen);
    kbBtn.classList.toggle('active', nowOpen);
    if (nowOpen) {
      tasksDashEl.classList.add('hidden');
      tasksBtn.classList.remove('active');
      renderKanban();
    }
  });
  // Double-click empty board to add a note where you clicked.
  notesBoardEl.addEventListener('dblclick', (e) => {
    if (e.target !== notesBoardEl) return;
    const r = notesBoardEl.getBoundingClientRect();
    addNote();
    const last = notesData[notesData.length - 1];
    last.x = e.clientX - r.left;
    last.y = e.clientY - r.top;
    const el = notesBoardEl.lastElementChild;
    el.style.left = last.x + 'px';
    el.style.top = last.y + 'px';
    saveNotes();
  });

  const rec = { id, kind: 'notes', paneEl, tabEl, profile: { name: 'Notes' }, status: 'connected' };
  tabs.set(id, rec);
  for (const n of notesData) renderNote(n);
  activateTab(id);
  api.saveSettings({ notesTabOpen: true });
  persistTabOrder();
  return id;
}

els.notesBtn.addEventListener('click', () => createNotesTab());
{
  const deckBtn = document.getElementById('deck-btn');
  if (deckBtn) deckBtn.addEventListener('click', () => createDeckTab());
  const bcBtn = document.getElementById('broadcast-btn');
  if (bcBtn) bcBtn.addEventListener('click', toggleBroadcast);
  const slBtn = document.getElementById('smartlinks-btn');
  if (slBtn) {
    updateSmartLinksBtn();
    slBtn.addEventListener('click', () => {
      smartLinksOn = !smartLinksOn;
      api.saveSettings({ smartLinksOn });
      updateSmartLinksBtn();
    });
  }
  const vitBtn = document.getElementById('vitals-btn');
  if (vitBtn) {
    updateVitalsBtn();
    vitBtn.addEventListener('click', toggleHostVitals);
  }
  const vitInt = document.getElementById('vitals-interval');
  if (vitInt) {
    vitInt.value = String(vitalsIntervalSec);
    vitInt.addEventListener('change', () => {
      vitalsIntervalSec = Number(vitInt.value) || 15;
      api.saveSettings({ vitalsIntervalSec });
      restartVitals();
    });
  }
  const pvBtn = document.getElementById('privacy-btn');
  if (pvBtn) pvBtn.addEventListener('click', () => togglePrivacy());
  // Focus Session dialog + HUD wiring.
  const focusBtn = document.getElementById('focus-btn');
  if (focusBtn) focusBtn.addEventListener('click', openFocusDialog);
  document.getElementById('focus-cancel').addEventListener('click', closeFocusDialog);
  document.getElementById('focus-start').addEventListener('click', () => {
    const custom = parseInt(document.getElementById('focus-custom').value, 10);
    startFocus(document.getElementById('focus-project').value || null, Number.isFinite(custom) && custom > 0 ? custom : focusSelMin);
  });
  document.getElementById('focus-hud-end').addEventListener('click', () => endFocus(true));
  document.querySelectorAll('#focus-overlay .fo-durs button').forEach((b) => {
    b.addEventListener('click', () => {
      focusSelMin = parseInt(b.dataset.min, 10);
      document.getElementById('focus-custom').value = '';
      syncFocusDurs();
    });
  });
  document.getElementById('focus-custom').addEventListener('input', () => {
    focusSelMin = -1; // custom value in the box takes over
    syncFocusDurs();
  });
  document.getElementById('focus-overlay').addEventListener('mousedown', (e) => {
    if (e.target.id === 'focus-overlay') closeFocusDialog();
  });
  // Terminal ▾ dropdown (theme + broadcast). Stays open on inside clicks so the
  // theme select and broadcast toggle are usable; closes on outside click / Esc.
  const termBtn = document.getElementById('term-menu-btn');
  const termMenu = document.getElementById('term-menu');
  if (termBtn && termMenu) {
    termBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      termMenu.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!termMenu.classList.contains('hidden') && !e.target.closest('#term-menu-wrap')) termMenu.classList.add('hidden');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') termMenu.classList.add('hidden');
    });
  }
}

// ---------------------------------------------------------------------------
// Command palette (Ctrl+L): fuzzy-jump to a session, tab, bookmark, note, command
// ---------------------------------------------------------------------------
let paletteMatches = [];
let paletteSel = 0;

function buildPaletteItems() {
  const items = [];
  const act = (icon, label, run) => items.push({ icon, label, sub: 'Action', run });
  act('+', 'New SSH connection', () => openDialog());
  act('#', 'Open Slack channel', () => openSlackDialog());
  act('📁', 'Toggle Files (SFTP) panel', () => els.sftpBtn && els.sftpBtn.click());
  act('🖥', 'Open local terminal', () => els.localTermBtn && els.localTermBtn.click());
  act('🌐', 'New web tab', () => createWebTab());
  act('📝', 'Notes board', () => createNotesTab());
  act('⚙', 'Settings', () => openSettings());

  for (const [id, rec] of tabs) {
    const titleEl = rec.tabEl && rec.tabEl.querySelector('.title');
    const title = (titleEl && titleEl.textContent) || (rec.profile && rec.profile.name) || id;
    items.push({ icon: '▸', label: title, sub: 'Switch to tab', run: () => activateTab(id) });
  }
  for (const s of savedSessions) {
    const label = s.name || `${s.username || ''}@${s.host}`;
    items.push({ icon: '>_', label, sub: 'SSH session', run: () => createTab({ ...s }) });
  }
  for (const b of webBookmarks) {
    items.push({ icon: '★', label: b.name || b.url, sub: 'Bookmark', run: () => createWebTab(b.url) });
  }
  for (const n of notesData) {
    items.push({
      icon: '📝',
      label: noteLabel(n),
      sub: 'Note',
      run: () => {
        createNotesTab();
        jumpToNote(n);
      },
    });
  }
  for (const cmd of quickCommands) {
    items.push({
      icon: '⌘',
      label: cmd,
      sub: 'Run in active terminal',
      run: () => {
        const rec = activeTabId ? tabs.get(activeTabId) : null;
        if (rec && rec.kind === 'ssh') {
          api.write(rec.id, cmd + '\r');
          if (rec.term) rec.term.focus();
        }
      },
    });
  }
  return items;
}

// Subsequence fuzzy score; -1 if not a match. Consecutive hits score higher.
function fuzzyScore(text, q) {
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let run = 0;
  for (let i = 0; i < q.length; i++) {
    const idx = t.indexOf(q[i], ti);
    if (idx === -1) return -1;
    run = idx === ti ? run + 2 : 0;
    score += 1 + run;
    ti = idx + 1;
  }
  return score;
}

function renderPalette(query) {
  const q = (query || '').trim().toLowerCase();
  const all = buildPaletteItems();
  let matches;
  if (!q) {
    matches = all;
  } else {
    matches = all
      .map((it) => ({ it, score: fuzzyScore(it.label + ' ' + it.sub, q) }))
      .filter((m) => m.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((m) => m.it);
  }
  paletteMatches = matches.slice(0, 50);
  paletteSel = 0;
  els.cmdPaletteList.innerHTML = '';
  if (!paletteMatches.length) {
    const e = document.createElement('div');
    e.className = 'cmdp-empty';
    e.textContent = 'No matches';
    els.cmdPaletteList.appendChild(e);
    return;
  }
  paletteMatches.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'cmdp-row' + (i === 0 ? ' sel' : '');
    row.innerHTML =
      `<span class="cmdp-icon">${escapeHtml(it.icon || '')}</span>` +
      `<span class="cmdp-label">${escapeHtml(it.label)}</span>` +
      `<span class="cmdp-sub">${escapeHtml(it.sub || '')}</span>`;
    row.addEventListener('mousemove', () => setPaletteSel(i));
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      runPaletteItem(i);
    });
    els.cmdPaletteList.appendChild(row);
  });
}

function setPaletteSel(i) {
  const rows = els.cmdPaletteList.querySelectorAll('.cmdp-row');
  if (!rows.length) return;
  paletteSel = (i + rows.length) % rows.length;
  rows.forEach((r, idx) => r.classList.toggle('sel', idx === paletteSel));
  rows[paletteSel].scrollIntoView({ block: 'nearest' });
}

function runPaletteItem(i) {
  const it = paletteMatches[i];
  if (!it) return;
  closePalette();
  try {
    it.run();
  } catch (_) {
    /* ignore */
  }
}

function openPalette() {
  els.cmdPaletteInput.value = '';
  els.cmdPalette.classList.remove('hidden');
  renderPalette('');
  els.cmdPaletteInput.focus();
}
function closePalette() {
  els.cmdPalette.classList.add('hidden');
}

els.cmdPaletteInput.addEventListener('input', () => renderPalette(els.cmdPaletteInput.value));
els.cmdPaletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setPaletteSel(paletteSel + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setPaletteSel(paletteSel - 1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runPaletteItem(paletteSel);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePalette();
  }
});
els.cmdPalette.addEventListener('mousedown', (e) => {
  if (e.target === els.cmdPalette) closePalette();
});

// Ctrl+L toggles the palette (capture phase so it beats the terminal key handler).
window.addEventListener(
  'keydown',
  (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      e.stopPropagation();
      if (els.cmdPalette.classList.contains('hidden')) openPalette();
      else closePalette();
    }
  },
  true
);

// When a note's due time arrives: open/focus the Notes tab, surface the note, alert.
function fireNoteDue(note) {
  createNotesTab(); // opens or focuses the board (renders all notes)
  const el = notesBoardEl && notesBoardEl.querySelector(`.note[data-note-id="${note.id}"]`);
  if (el) {
    bringToFront(note, el);
    el.classList.add('note-due-flash');
    setTimeout(() => el.classList.remove('note-due-flash'), 6000);
  }
  playMeetingChime();
  api.focusWindow();
  try {
    const n = new Notification('⏰ Note due', {
      body: (note.title || (note.text || '').split('\n')[0] || '(note)').slice(0, 80),
    });
    n.onclick = () => {
      api.focusWindow();
      createNotesTab();
    };
  } catch (_) {
    /* notifications unavailable */
  }
}

setInterval(() => {
  const now = Date.now();
  for (const note of notesData) {
    if (note.due && !note.dueFired && now >= note.due) {
      note.dueFired = true;
      saveNotes();
      fireNoteDue(note);
    }
  }
  updatePet(false); // refresh mood as notes cross their due time
}, 15000);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function init() {
  const settings = await api.loadSettings();
  if (settings && Number.isFinite(settings.fontSize)) {
    fontSize = Math.max(8, Math.min(36, settings.fontSize));
  }
  if (settings && THEMES[settings.theme]) currentTheme = settings.theme;
  if (settings && ['all', 'mentions', 'off'].includes(settings.slackNotify)) {
    slackNotify = settings.slackNotify;
  }
  if (settings && Array.isArray(settings.webBookmarks)) webBookmarks = settings.webBookmarks;
  if (settings && typeof settings.claudeWatch === 'boolean') claudeWatch = settings.claudeWatch;
  if (settings && typeof settings.smartLinksOn === 'boolean') smartLinksOn = settings.smartLinksOn;
  updateSmartLinksBtn(); // reflect the persisted state on the Terminal ▾ toggle
  if (settings && settings.tunnels && typeof settings.tunnels === 'object') savedTunnels = settings.tunnels;
  if (settings && typeof settings.hostVitals === 'boolean') hostVitals = settings.hostVitals;
  if (settings && Number.isFinite(settings.vitalsIntervalSec)) vitalsIntervalSec = settings.vitalsIntervalSec;
  if (settings && typeof settings.appTrackingEnabled === 'boolean') appTrackingEnabled = settings.appTrackingEnabled;
  if (settings && typeof settings.appTrackDetailed === 'boolean') appTrackDetailed = settings.appTrackDetailed;
  if (settings && Number.isFinite(settings.paSplitOffset)) paSplitOffset = settings.paSplitOffset;
  if (appTrackingEnabled) {
    api.apptrackSetEnabled(true, 5, appTrackDetailed).then((r) => {
      if (r) appTrackSupported = r.supported;
      updateAppTrackHint();
    });
  }
  updateVitalsBtn();
  {
    const vitInt = document.getElementById('vitals-interval');
    if (vitInt) vitInt.value = String(vitalsIntervalSec);
  }
  if (settings && typeof settings.meetingChime === 'boolean') meetingChime = settings.meetingChime;
  if (settings && typeof settings.cmdDoneNotify === 'boolean') cmdDoneNotify = settings.cmdDoneNotify;
  if (settings && typeof settings.pipEnabled === 'boolean') pipEnabled = settings.pipEnabled;
  if (settings && typeof settings.reminderEnabled === 'boolean') reminderEnabled = settings.reminderEnabled;
  if (settings && typeof settings.reminderText === 'string') reminderText = settings.reminderText;
  if (settings && Number.isFinite(settings.reminderMinMin)) reminderMinMin = settings.reminderMinMin;
  if (settings && Number.isFinite(settings.reminderMaxMin)) reminderMaxMin = settings.reminderMaxMin;
  scheduleReminder(); // re-arm with the loaded interval / on-off state
  if (settings && typeof settings.autoHopEnabled === 'boolean') autoHopEnabled = settings.autoHopEnabled;
  if (settings && typeof settings.autoHopCollect === 'boolean') autoHopCollect = settings.autoHopCollect;
  if (settings && typeof settings.sshProtocolHandler === 'boolean') sshProtocolHandler = settings.sshProtocolHandler;
  if (settings && typeof settings.sshJumpHost === 'string') sshJumpHost = settings.sshJumpHost;
  if (settings && typeof settings.autoProjectSwitch === 'boolean') autoProjectSwitch = settings.autoProjectSwitch;
  if (settings && settings.tabProjects && typeof settings.tabProjects === 'object') tabProjects = settings.tabProjects;
  if (settings && typeof settings.slackFeedOn === 'boolean') slackFeedOn = settings.slackFeedOn;
  if (settings && typeof settings.gmailPanelOn === 'boolean') gmailPanelOn = settings.gmailPanelOn;
  if (settings && typeof settings.whatsappFeedOn === 'boolean') whatsappFeedOn = settings.whatsappFeedOn;
  if (settings && Number.isFinite(settings.sidebarWidth)) applySidebarWidth(settings.sidebarWidth);
  if (settings && settings.boardHeights && typeof settings.boardHeights === 'object') boardHeights = settings.boardHeights;
  if (settings && typeof settings.codeFolder === 'string') codeFolder = settings.codeFolder;
  if (settings && typeof settings.blackboxOn === 'boolean') blackboxOn = settings.blackboxOn;
  if (settings && typeof settings.blackboxLogText === 'boolean') blackboxLogText = settings.blackboxLogText;
  if (settings && Number.isFinite(settings.blackboxDays)) blackboxDays = settings.blackboxDays;
  api.blackboxTrim(blackboxDays); // drop events past the retention window
  if (settings && Array.isArray(settings.timezones) && settings.timezones.length) {
    tzList = settings.timezones.filter((t) => t && t.zone);
  }
  if (settings && settings.exposeLayout) {
    const el = settings.exposeLayout;
    if (el.panels) for (const [k, v] of Object.entries(el.panels)) exposeMemory.set(k, v);
    if (el.scene) exposeScene = el.scene;
  }
  if (settings && Array.isArray(settings.notes)) {
    notesData = settings.notes;
    renormalizeNoteZ(); // compact any inflated z values from prior sessions
  }
  updatePet(false); // set the pet's initial mood from restored notes
  if (settings && Array.isArray(settings.quickCommands)) quickCommands = settings.quickCommands;
  if (settings && Number.isFinite(settings.remoteDebugPort)) remoteDebugPort = settings.remoteDebugPort;
  if (settings && typeof settings.terminalCwd === 'string') terminalCwd = settings.terminalCwd;
  // Auto-hops, keyed per server. Migrate from the old per-tab `commands` if needed.
  sshHops = (settings && settings.sshHops) || {};
  if (settings && !settings.sshHops && Array.isArray(settings.openSshTabs)) {
    let migrated = false;
    for (const t of settings.openSshTabs) {
      if (t.commands && t.commands.length) {
        sshHops[sshServerKey(t)] = t.commands.slice();
        migrated = true;
      }
    }
    if (migrated) api.saveSettings({ sshHops });
  }

  // Populate the theme switcher in the tab bar.
  for (const name of Object.keys(THEMES)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    els.themeSelect.appendChild(opt);
  }
  els.themeSelect.value = currentTheme;
  els.themeSelect.addEventListener('change', () => applyTheme(els.themeSelect.value));

  await refreshSaved();
  // Prefill a discovered key to make first connect easy.
  const keys = await api.discoverKeys();
  if (keys && keys.length) els.fKey.value = keys[0];
  // Prefill the dialog with the last-used connection, if any.
  if (settings && settings.lastConnection) {
    fillForm(settings.lastConnection);
    if (!els.fKey.value && keys && keys.length) els.fKey.value = keys[0];
  }
  syncAuthFields();

  // Restore Google (Gmail strip + Calendar bar) from a saved session.
  const gstat = await api.googleStatus();
  if (gstat && gstat.ok && gstat.connected) {
    googleConnected = true;
    googleEmail = gstat.email;
    startGoogleFeeds();
  }

  // Reopen tabs in their saved order (interleaving preserved — e.g. Notes stays where
  // you put it). Slack tabs need the workspace connected first, so connect up front.
  const tabOrder = settings && Array.isArray(settings.tabOrder) ? settings.tabOrder : null;
  if (tabOrder && tabOrder.length) {
    let slackReady = false;
    if (tabOrder.some((t) => t.kind === 'slack')) {
      const tokens = await api.slackLoadTokens();
      if (tokens && tokens.botToken && tokens.appToken) {
        const res = await doSlackConnect(tokens.botToken, tokens.appToken);
        slackReady = !!(res && res.ok);
      }
    }
    for (const t of tabOrder) {
      let created = false;
      if (t.kind === 'ssh' && t.profile) created = !!createTab(t.profile);
      else if (t.kind === 'web' && t.url) created = !!createWebTab(t.url);
      else if (t.kind === 'local') created = !!createLocalTab({ cwd: t.cwd || undefined, title: t.title });
      else if (t.kind === 'notes') created = !!createNotesTab();
      else if (t.kind === 'deck') created = !!createDeckTab();
      else if (t.kind === 'slack' && slackReady && t.channel) created = !!createSlackTab(t.channel);
      // Each create activates the new tab — reapply a manual rename to it.
      if (created && t.title && activeTabId) applyRestoredTitle(activeTabId, t.title);
    }
  } else {
    // Legacy restore (settings saved before tab order was tracked).
    const savedSsh = (settings && settings.openSshTabs) || [];
    for (const p of savedSsh) createTab(p);
    const savedWeb = (settings && settings.openWebTabs) || [];
    for (const u of savedWeb) createWebTab(u);
    if (settings && settings.notesTabOpen) createNotesTab();
    const savedChannels = (settings && settings.openSlackChannels) || [];
    if (savedChannels.length) {
      const tokens = await api.slackLoadTokens();
      if (tokens && tokens.botToken && tokens.appToken) {
        const res = await doSlackConnect(tokens.botToken, tokens.appToken);
        if (res.ok) for (const ch of savedChannels) createSlackTab(ch);
      }
    }
  }

  // Slack updates board: if it's enabled but Slack isn't connected yet (no Slack
  // tabs were restored), connect with saved tokens so the board receives messages.
  if (slackFeedOn && !slackConnected) {
    const tokens = await api.slackLoadTokens();
    if (tokens && tokens.botToken && tokens.appToken) {
      await doSlackConnect(tokens.botToken, tokens.appToken);
    }
  }
  if (slackFeedOn) primeSlackChannelNames();
  // If the WhatsApp board is on, open the socket so it fills (uses the saved login;
  // if not paired yet it just waits for a QR scan from Settings).
  if (whatsappFeedOn) ensureWhatsappStarted();
  ensureCodeServerForRestoredTabs(); // relaunch code-server if a VS Code tab was restored
  updateRightSidebar();
  updateBoardToggleLabels();

  // Re-select the tab that was focused last time (match by stable key).
  const savedActiveKey = settings && settings.activeTabKey;
  if (savedActiveKey) {
    for (const [id, rec] of tabs) {
      if (tabKey(rec) === savedActiveKey) {
        activateTab(id);
        break;
      }
    }
  }

  // Nothing restored → show the empty state so the user can pick what to open
  // (SSH / local terminal / web / notes) instead of forcing the SSH dialog.
  updateEmptyState();
})();
