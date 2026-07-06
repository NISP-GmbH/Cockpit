'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog, Menu, screen, safeStorage, shell, session, powerMonitor } = require('electron');
const { SSHManager } = require('./ssh-manager');
const { AppTracker } = require('./app-tracker');
const { AppStore } = require('./app-store');
const { SlackManager } = require('./slack-manager');
const { WhatsAppManager } = require('./whatsapp-manager');
const { GoogleManager } = require('./google-manager');
const { LocalPty } = require('./local-pty');
const { CodeServerManager } = require('./codeserver-manager');
const { BlackBoxStore } = require('./blackbox-store');
const { ProjectStore } = require('./project-store');
const { Store } = require('./store');

// Data folder: %APPDATA%/Cockpit (macOS/Linux equivalents). Older installs used
// "ssh-gui" - migrate it once (copy) so existing settings/notes/sessions/tokens
// carry over; ssh-gui acts as the fallback if the new folder doesn't exist yet.
(function pinUserDataDir() {
  const appData = app.getPath('appData');
  const newDir = path.join(appData, 'Cockpit');
  const oldDir = path.join(appData, 'ssh-gui');
  try {
    if (!fs.existsSync(newDir) && fs.existsSync(oldDir)) {
      fs.cpSync(oldDir, newDir, { recursive: true });
    }
  } catch (_) {
    /* migration is best-effort; fall through to a fresh Cockpit folder */
  }
  app.setPath('userData', newDir);
})();

// Optional CDP remote-debugging port (off unless set in settings). Must be enabled
// before app 'ready', so read settings.json directly here. Binds to 127.0.0.1 only.
(function enableRemoteDebugIfConfigured() {
  try {
    const s = JSON.parse(
      fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')
    );
    const port = Number(s.remoteDebugPort) || 0;
    if (port > 0) {
      app.commandLine.appendSwitch('remote-debugging-port', String(port));
      app.commandLine.appendSwitch('remote-allow-origins', '*'); // allow local CDP ws clients
    }
  } catch (_) {
    /* no settings yet / disabled */
  }
})();

// Let the meeting-alert chime play without a recent user gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
let store = null;
// ssh:// link handling: the renderer's listener is only live once the page has
// loaded, so URLs that arrive earlier (cold launch, macOS open-url) are queued.
let mainReady = false;
let pendingSshUrl = null;
const ssh = new SSHManager();
const slack = new SlackManager();
let whatsapp = null; // WhatsAppManager, created lazily once userData path is known
const localPty = new LocalPty((ch, payload) => send(ch, payload));
const codeServer = new CodeServerManager();
const googleMgr = new GoogleManager();
const appTracker = new AppTracker();
let appStore = null; // AppStore, created lazily once userData path is known (flushed on quit)

// Encrypt secrets at rest with the OS keystore (DPAPI on Windows) when available.
function encryptSecret(s) {
  if (!s) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(s).toString('base64');
    }
  } catch (_) {
    /* fall through to plain */
  }
  return 'b64:' + Buffer.from(s, 'utf8').toString('base64');
}

function decryptSecret(v) {
  if (!v) return '';
  try {
    if (v.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    }
    if (v.startsWith('b64:')) {
      return Buffer.from(v.slice(4), 'base64').toString('utf8');
    }
  } catch (_) {
    return '';
  }
  return '';
}

// A saved position is only honored if its center lands on a connected display,
// so a disconnected/rearranged monitor can't strand the window off-screen.
function boundsOnVisibleDisplay(b) {
  if (!b || !Number.isInteger(b.x) || !Number.isInteger(b.y)) return false;
  const cx = b.x + (b.width || 0) / 2;
  const cy = b.y + (b.height || 0) / 2;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height;
  });
}

function persistBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    store.saveSettings({
      windowBounds: mainWindow.getNormalBounds(),
      maximized: mainWindow.isMaximized(),
    });
  } catch (_) {
    /* ignore */
  }
}

function createWindow() {
  const saved = (store && store.loadSettings()) || {};
  const b = saved.windowBounds || {};
  const usePos = boundsOnVisibleDisplay(b);

  mainWindow = new BrowserWindow({
    width: b.width || 1100,
    height: b.height || 720,
    x: usePos ? b.x : undefined,
    y: usePos ? b.y : undefined,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#1d1f21',
    title: 'Cockpit',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true, // enables <webview> for the web-page tab kind
    },
  });

  if (saved.maximized) mainWindow.maximize();

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Persist geometry as the window is moved/resized (debounced), plus on close —
  // so position survives even if the app is force-killed and never gets 'close'.
  let boundsTimer = null;
  const scheduleSave = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(persistBounds, 400);
  };
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('move', scheduleSave);
  mainWindow.on('close', () => {
    clearTimeout(boundsTimer);
    persistBounds();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    destroyPipWindow(); // PiP is a window too — don't keep the app alive after main closes
  });
}

// ---- Mini-cockpit (PiP): a tiny always-on-top glance window ----
let pipWin = null;
function createPipWindow() {
  if (pipWin && !pipWin.isDestroyed()) return pipWin;
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 248;
  const h = 116;
  const saved = (store && store.loadSettings()) || {};
  const pb = saved.pipBounds || {};
  pipWin = new BrowserWindow({
    width: w,
    height: h,
    x: Number.isFinite(pb.x) ? pb.x : wa.x + wa.width - w - 16,
    y: Number.isFinite(pb.y) ? pb.y : wa.y + wa.height - h - 16,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#1d1f21',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  pipWin.setAlwaysOnTop(true, 'screen-saver'); // float above fullscreen apps too
  pipWin.loadFile(path.join(__dirname, 'renderer', 'pip.html'));
  pipWin.once('ready-to-show', () => pipWin.showInactive()); // don't steal focus
  let pbTimer = null;
  const savePb = () => {
    if (!pipWin || pipWin.isDestroyed()) return;
    const [x, y] = pipWin.getPosition();
    store.saveSettings({ pipBounds: { x, y } });
  };
  pipWin.on('move', () => {
    clearTimeout(pbTimer);
    pbTimer = setTimeout(savePb, 400);
  });
  pipWin.on('closed', () => {
    pipWin = null;
  });
  return pipWin;
}
function destroyPipWindow() {
  if (pipWin && !pipWin.isDestroyed()) pipWin.destroy();
  pipWin = null;
}

// ---- Web extensions (unpacked) loaded into the web tabs' session ----
function webSession() {
  return session.fromPartition('persist:web');
}
function listWebExtensions() {
  const ses = webSession();
  const all =
    ses.extensions && ses.extensions.getAllExtensions
      ? ses.extensions.getAllExtensions()
      : ses.getAllExtensions();
  return all.map((e) => ({ name: e.name, version: e.version }));
}
async function loadWebExtensions() {
  try {
    const paths = ((store && store.loadSettings()) || {}).webExtensions || [];
    if (!Array.isArray(paths) || !paths.length) return;
    const ses = webSession();
    for (const p of paths) {
      try {
        await ses.loadExtension(p, { allowFileAccess: true });
      } catch (e) {
        console.error('Web extension failed to load:', p, e.message);
      }
    }
  } catch (_) {
    /* ignore */
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// Open the OS terminal in a directory (for running Claude/CDP tools locally).
function openExternalTerminal(cwd) {
  const dir = cwd || os.homedir();
  if (process.platform === 'win32') {
    const c = spawn('wt.exe', ['-d', dir], { detached: true, stdio: 'ignore' }); // Windows Terminal
    c.on('error', () => {
      // Fall back to a classic cmd window in the directory.
      try {
        spawn('cmd.exe', ['/c', 'start', '', '/D', dir, 'cmd.exe'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        }).unref();
      } catch (_) {
        /* ignore */
      }
    });
    c.unref();
  } else if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Terminal', dir], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(
      'sh',
      [
        '-c',
        `x-terminal-emulator --working-directory="${dir}" || gnome-terminal --working-directory="${dir}" || konsole --workdir "${dir}" || xterm`,
      ],
      { detached: true, stdio: 'ignore' }
    ).unref();
  }
}

// Find an ssh:// URL among command-line arguments (how Windows/Linux deliver it).
function extractSshUrl(argv) {
  return (argv || []).find((a) => typeof a === 'string' && a.startsWith('ssh://')) || null;
}

// Parse an ssh:// URL and hand it to the renderer (or queue it until the page loads),
// bringing the window forward so the new terminal is visible.
function deliverSshUrl(url) {
  if (!url) return;
  let t;
  try {
    const u = new URL(url);
    if (u.protocol !== 'ssh:') return;
    t = {
      username: u.username ? decodeURIComponent(u.username) : '',
      host: u.hostname || '',
      port: u.port ? Number(u.port) : 22,
    };
  } catch (_) {
    return;
  }
  if (!t.host) return;
  if (mainReady && mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    send('ssh:open-url', t);
  } else {
    pendingSshUrl = t; // flushed on did-finish-load
  }
}

// Register/unregister Cockpit as the OS handler for ssh:// links. In dev (run from
// source) the registration must point at electron + this script, not just the exe.
function setSshProtocol(enable) {
  try {
    const devArgs = process.defaultApp && process.argv.length >= 2
      ? [process.execPath, [path.resolve(process.argv[1])]]
      : null;
    if (enable) {
      if (devArgs) app.setAsDefaultProtocolClient('ssh', devArgs[0], devArgs[1]);
      else app.setAsDefaultProtocolClient('ssh');
    } else {
      if (devArgs) app.removeAsDefaultProtocolClient('ssh', devArgs[0], devArgs[1]);
      else app.removeAsDefaultProtocolClient('ssh');
    }
  } catch (_) {
    /* registry / permissions may refuse - reflect the real state below */
  }
  try {
    return app.isDefaultProtocolClient('ssh');
  } catch (_) {
    return false;
  }
}

// macOS delivers the URL via this event (must be registered before app is ready).
app.on('open-url', (event, url) => {
  event.preventDefault();
  deliverSshUrl(url);
});

// Ensure only one instance runs — prevents two processes fighting over settings.json.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on('second-instance', (_e, argv) => {
  const url = extractSshUrl(argv);
  if (url) deliverSshUrl(url); // opens a terminal + brings the window forward
  else if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Distinct taskbar identity/grouping on Windows (also helps the icon show).
if (process.platform === 'win32') app.setAppUserModelId('com.local.cockpit');

app.whenReady().then(() => {
  // Drop the default menu so Ctrl +/-/0 don't trigger Electron's page zoom —
  // we repurpose those keys for terminal font zoom in the renderer.
  Menu.setApplicationMenu(null);

  // Keyboard shortcuts inside a web <webview>: F12 DevTools + Ctrl+R reload.
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = (input.key || '').toLowerCase();
      // F12 / Ctrl+Shift+I → toggle DevTools for this page.
      if (input.key === 'F12' || (input.control && input.shift && key === 'i')) {
        if (contents.isDevToolsOpened()) contents.closeDevTools();
        else contents.openDevTools({ mode: 'detach' });
        event.preventDefault();
        return;
      }
      // Ctrl+R reload.
      if (input.control && !input.alt && key === 'r') {
        if (input.shift) contents.reloadIgnoringCache();
        else contents.reload();
        event.preventDefault();
      }
    });
  });

  loadWebExtensions(); // restore any unpacked extensions into the web partition

  store = new Store(app.getPath('userData'));

  // Restore a Google session from stored, encrypted credentials (no browser needed).
  try {
    const gs = store.loadSettings();
    const cid = decryptSecret(gs.googleClientId);
    const csec = decryptSecret(gs.googleClientSecret);
    const grt = decryptSecret(gs.googleRefreshToken);
    if (cid && grt) {
      googleMgr.configure(cid, csec);
      googleMgr.useRefreshToken(grt);
    }
  } catch (_) {
    /* ignore */
  }

  createWindow();

  // ssh:// link handling: register the OS handler if the user opted in, and once the
  // page has loaded, mark ready and flush any URL that launched us (cold start).
  if ((store.loadSettings() || {}).sshProtocolHandler) setSshProtocol(true);
  {
    const launchUrl = extractSshUrl(process.argv);
    if (launchUrl) deliverSshUrl(launchUrl); // queues until did-finish-load
  }
  mainWindow.webContents.once('did-finish-load', () => {
    mainReady = true;
    if (pendingSshUrl) {
      const t = pendingSshUrl;
      pendingSshUrl = null;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      send('ssh:open-url', t);
    }
  });

  // Mini-cockpit (PiP) — on by default; disable in Settings.
  if (((store.loadSettings() || {}).pipEnabled) !== false) createPipWindow();

  // ---- session profile IPC ----
  ipcMain.handle('store:load', () => store.load());
  ipcMain.handle('store:save', (_e, sessions) => store.save(sessions));
  ipcMain.handle('settings:load', () => store.loadSettings());
  ipcMain.handle('settings:save', (_e, settings) => store.saveSettings(settings));
  ipcMain.handle('keys:discover', () => SSHManager.discoverKeys());
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^(https?|mailto):/i.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('app:focus', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  // Register/unregister Cockpit as the ssh:// handler; returns whether it is now default.
  ipcMain.handle('app:setSshProtocol', (_e, on) => setSshProtocol(!!on));
  // Capture a region of the window as a PNG data URL (for the 3D Exposé thumbnails).
  ipcMain.handle('app:capturePage', async (_e, rect) => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    try {
      const img = rect
        ? await mainWindow.webContents.capturePage(rect)
        : await mainWindow.webContents.capturePage();
      return img.toDataURL();
    } catch (_) {
      return null;
    }
  });
  // Force the window to the foreground (a brief always-on-top pulse beats Windows'
  // focus-stealing prevention), used by the periodic reminder overlay.
  ipcMain.handle('app:toFront', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    mainWindow.moveTop();
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
    }, 1500);
  });

  // ---- Mini-cockpit (PiP) IPC ----
  ipcMain.on('pip:update', (_e, data) => {
    if (pipWin && !pipWin.isDestroyed()) pipWin.webContents.send('pip:data', data);
  });
  ipcMain.handle('pip:setEnabled', (_e, on) => {
    store.saveSettings({ pipEnabled: !!on });
    if (on) createPipWindow();
    else destroyPipWindow();
    return { ok: true };
  });
  ipcMain.on('pip:focusMain', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  // ---- Web extensions IPC ----
  ipcMain.handle('web:addExtension', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select an unpacked extension folder (containing manifest.json)',
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const dir = res.filePaths[0];
    try {
      const ext = await webSession().loadExtension(dir, { allowFileAccess: true });
      const s = store.loadSettings() || {};
      const list = Array.isArray(s.webExtensions) ? s.webExtensions.slice() : [];
      if (!list.includes(dir)) {
        list.push(dir);
        store.saveSettings({ webExtensions: list });
      }
      return { ok: true, name: ext.name, version: ext.version, path: dir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('web:listExtensions', () => {
    try {
      return { ok: true, extensions: listWebExtensions() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('web:clearExtensions', () => {
    store.saveSettings({ webExtensions: [] });
    return { ok: true }; // fully unloads on next restart
  });
  ipcMain.handle('app:openTerminal', async (_e, opts = {}) => {
    let dir = opts.cwd || os.homedir();
    if (opts.pick) {
      const res = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose folder for the local terminal',
        defaultPath: opts.cwd || os.homedir(),
        properties: ['openDirectory'],
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
      dir = res.filePaths[0];
    }
    openExternalTerminal(dir);
    return { ok: true, dir };
  });
  ipcMain.handle('keys:browse', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Select SSH private key',
      defaultPath: path.join(require('os').homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  // ---- SSH lifecycle IPC ----
  ipcMain.handle('ssh:connect', (_e, opts) => {
    const { tabId } = opts;
    ssh.connect(opts, {
      onData: (data) => send('ssh:data', { tabId, data }),
      onStatus: (line) => send('ssh:status', { tabId, line }),
      onError: (message) => send('ssh:error', { tabId, message }),
      onClose: (info) => send('ssh:close', { tabId, info }),
    });
    return { ok: true };
  });

  // ---- SFTP IPC ----
  ipcMain.handle('sftp:list', async (_e, { tabId, dir }) => {
    try {
      return { ok: true, ...(await ssh.sftpList(tabId, dir)) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('sftp:download', async (_e, { tabId, remotePath, name }) => {
    try {
      const res = await dialog.showSaveDialog(mainWindow, { defaultPath: name });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      await ssh.sftpDownload(tabId, remotePath, res.filePath);
      return { ok: true, savedTo: res.filePath };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  // Save a base64 blob captured in-band from a terminal ("Grab file from here").
  ipcMain.handle('file:saveBase64', async (_e, { name, b64 }) => {
    try {
      const res = await dialog.showSaveDialog(mainWindow, { defaultPath: name || 'download' });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      const buf = Buffer.from(b64 || '', 'base64');
      fs.writeFileSync(res.filePath, buf);
      return { ok: true, savedTo: res.filePath, bytes: buf.length };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('sftp:upload', async (_e, { tabId, dir }) => {
    try {
      const res = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
      const uploaded = [];
      for (const local of res.filePaths) {
        const base = path.basename(local);
        const remote = (dir.endsWith('/') ? dir : dir + '/') + base;
        await ssh.sftpUpload(tabId, local, remote);
        uploaded.push(base);
      }
      return { ok: true, uploaded };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('sftp:uploadPaths', async (_e, { tabId, dir, paths }) => {
    try {
      const uploaded = [];
      for (const local of paths || []) {
        const base = path.basename(local);
        const remote = (dir.endsWith('/') ? dir : dir + '/') + base;
        await ssh.sftpUpload(tabId, local, remote);
        uploaded.push(base);
      }
      return { ok: true, uploaded };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('sftp:delete', async (_e, { tabId, path: p, isDir }) => {
    try {
      await ssh.sftpDelete(tabId, p, isDir);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.on('ssh:write', (_e, { tabId, data }) => ssh.write(tabId, data));
  ipcMain.on('ssh:resize', (_e, { tabId, cols, rows }) => ssh.resize(tabId, cols, rows));
  ipcMain.on('ssh:disconnect', (_e, { tabId }) => ssh.disconnect(tabId));

  // ---- Port forwarding (SSH tunnels) ----
  ssh.onTunnelUpdate = (t) => send('tunnel:update', t);
  ipcMain.handle('tunnel:list', (_e, { tabId }) => {
    try {
      return { ok: true, tunnels: ssh.listTunnels(tabId) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('tunnel:start', (_e, spec) => {
    try {
      return { ok: true, tunnel: ssh.startTunnel(spec) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('tunnel:stop', (_e, { id }) => {
    try {
      return { ok: ssh.stopTunnel(id) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  // ---- Host vitals (load/mem/disk sparklines) ----
  ssh.onVitals = (tabId, v) => send('vitals:sample', { tabId, v });
  ipcMain.on('vitals:start', (_e, { tabId, intervalMs }) => ssh.startVitals(tabId, intervalMs));
  ipcMain.on('vitals:stop', (_e, { tabId }) => ssh.stopVitals(tabId));

  // ---- Slack IPC ----
  ipcMain.handle('slack:saveTokens', (_e, { botToken, appToken }) => {
    store.saveSettings({
      slackBotToken: encryptSecret(botToken),
      slackAppToken: encryptSecret(appToken),
    });
    return { ok: true };
  });
  ipcMain.handle('slack:loadTokens', () => {
    const s = store.loadSettings();
    return {
      botToken: decryptSecret(s.slackBotToken),
      appToken: decryptSecret(s.slackAppToken),
    };
  });
  ipcMain.handle('slack:connect', async (_e, { botToken, appToken }) => {
    try {
      const info = await slack.connect(botToken, appToken, {
        onMessage: (m) => send('slack:message', m),
        onStatus: (line) => send('slack:status', { line }),
      });
      return { ok: true, info };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('slack:channels', async () => {
    try {
      return { ok: true, channels: await slack.listChannels() };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  // --- WhatsApp (Baileys, QR login) ---
  function ensureWhatsApp() {
    if (!whatsapp) {
      whatsapp = new WhatsAppManager(path.join(app.getPath('userData'), 'whatsapp-auth'));
    }
    return whatsapp;
  }
  ipcMain.handle('whatsapp:connect', async () => {
    try {
      await ensureWhatsApp().connect({
        onMessage: (m) => send('whatsapp:message', m),
        onStatus: (s) => send('whatsapp:status', s),
        onQr: (dataUrl) => send('whatsapp:qr', { dataUrl }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('whatsapp:status', () => {
    return { ok: true, ...(whatsapp ? whatsapp.status() : { connected: false, me: null }) };
  });
  ipcMain.handle('whatsapp:send', async (_e, { jid, text }) => {
    try {
      if (!whatsapp) throw new Error('WhatsApp not connected');
      return await whatsapp.send(jid, text);
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('whatsapp:logout', async () => {
    try {
      if (whatsapp) await whatsapp.logout();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  // --- Black Box (local event timeline) ---
  let blackbox = null;
  const bb = () => {
    if (!blackbox) blackbox = new BlackBoxStore(path.join(app.getPath('userData'), 'blackbox.jsonl'));
    return blackbox;
  };
  ipcMain.handle('blackbox:log', (_e, events) => bb().append(events));
  ipcMain.handle('blackbox:query', (_e, range) => ({ ok: true, events: bb().query(range || {}) }));
  ipcMain.handle('blackbox:clear', () => bb().clear());
  ipcMain.handle('blackbox:stats', () => ({ ok: true, ...bb().stats() }));
  ipcMain.handle('blackbox:trim', (_e, days) => bb().trim(days));

  // --- Project accounting (time tracking) ---
  let projects = null;
  const pj = () => {
    if (!projects) projects = new ProjectStore(path.join(app.getPath('userData'), 'projects.json'));
    return projects;
  };
  ipcMain.handle('project:getState', () => ({ ok: true, ...pj().getState() }));
  ipcMain.handle('project:add', (_e, { name, color }) => ({ ok: true, project: pj().addProject(name, color) }));
  ipcMain.handle('project:rename', (_e, { id, name }) => pj().rename(id, name));
  ipcMain.handle('project:setColor', (_e, { id, color }) => pj().setColor(id, color));
  ipcMain.handle('project:setCurrent', (_e, { id }) => pj().setCurrent(id));
  ipcMain.handle('project:setRunning', (_e, { on }) => pj().setRunning(on));
  ipcMain.handle('project:startSegment', (_e, { projectId, start }) => pj().startSegment(projectId, start));
  ipcMain.handle('project:touchSegment', (_e, { end }) => pj().touchSegment(end));
  ipcMain.handle('project:stopSegment', (_e, { end }) => pj().stopSegment(end));
  ipcMain.handle('project:reassign', (_e, { start, end, toId }) => pj().reassign(start, end, toId));
  ipcMain.handle('project:reassignRecent', (_e, { fromId, toId, seconds }) => pj().reassignRecent(fromId, toId, seconds));
  ipcMain.handle('project:setSegments', (_e, { segments }) => pj().setSegments(segments));
  ipcMain.handle('project:addSegment', (_e, { projectId, start, end, note }) => pj().addSegment(projectId, start, end, note));
  ipcMain.handle('project:updateSegment', (_e, { id, patch }) => pj().updateSegment(id, patch));
  ipcMain.handle('project:deleteSegment', (_e, { id }) => pj().deleteSegment(id));
  ipcMain.handle('project:deleteProject', (_e, { id, reassignToId }) => pj().deleteProject(id, reassignToId));

  // --- App-usage accounting: attribute time spent in outside apps to the running project.
  // Opt-in; local only; app names only (titles are not stored). Idle time is excluded.
  const APPTRACK_IDLE_SEC = 90;
  let appTrackDetailed = false; // when on, keep a "app › context" bucket from the window title
  // Turn { app:"chrome", title:"Gmail - Google Chrome" } into "chrome › Gmail". The active
  // tab / open file is the first title segment (before " - "); we strip a leading unread
  // counter like "(3) " and cap the length. Falls back to the bare app name when there's no
  // usable title (e.g. macOS, which never sends one).
  const detailedBucket = (appName, title) => {
    if (!title) return appName;
    let ctx = String(title).split(' - ')[0].trim(); // Chrome/VS Code separate with " - "
    ctx = ctx.replace(/^\(\d+\)\s*/, ''); // drop a leading unread counter like "(3) "
    // Collapse live countdowns / timers so "Meeting in 28m", "… in 26m", "… in 17m" don't
    // each become their own bucket (Cockpit puts an upcoming-meeting countdown in its title).
    ctx = ctx.replace(/\bin\s+\d+\s*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b.*$/i, '');
    ctx = ctx.replace(/\s*[.…]+\s*$/, '').trim(); // drop trailing ellipsis left behind
    if (ctx.length > 40) ctx = ctx.slice(0, 40).trim();
    if (!ctx || ctx.toLowerCase() === appName.toLowerCase()) return appName;
    return appName + ' › ' + ctx;
  };
  const asStore = () => {
    if (!appStore) appStore = new AppStore(path.join(app.getPath('userData'), 'app-activity.json'));
    return appStore;
  };
  const localDayStr = (ts) => {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  appTracker.onSample = ({ app: appName, title }) => {
    // "Idle" is the System Idle Process (PID 0) - reported when there's no foreground
    // window (locked screen / nothing focused); never attribute that.
    if (!appName || appName === 'Idle') return;
    const bucket = appTrackDetailed ? detailedBucket(appName, title) : appName;
    const st = pj().getState();
    // Only count while a project is actively being timed and you're not idle.
    if (!st.running || !st.currentProjectId) return send('apptrack:sample', { app: bucket, tracked: false });
    let idle = 0;
    try {
      idle = powerMonitor.getSystemIdleTime();
    } catch (_) {
      /* not available */
    }
    if (idle >= APPTRACK_IDLE_SEC) return send('apptrack:sample', { app: bucket, tracked: false, idle: true });
    asStore().bump(localDayStr(Date.now()), st.currentProjectId, bucket, appTracker.intervalSec);
    send('apptrack:sample', { app: bucket, tracked: true });
  };
  ipcMain.handle('apptrack:setEnabled', (_e, { on, intervalSec, detailed }) => {
    if (typeof detailed === 'boolean') appTrackDetailed = detailed;
    if (intervalSec) appTracker.setInterval(intervalSec);
    if (on) appTracker.start(intervalSec);
    else appTracker.stop();
    return { ok: true, supported: appTracker.supported };
  });
  ipcMain.handle('apptrack:getState', () => {
    asStore().prune();
    return { ok: true, supported: appTracker.supported, ...asStore().getState() };
  });
  ipcMain.handle('apptrack:clear', () => asStore().clear());
  ipcMain.handle('apptrack:remove', (_e, { app, days }) => asStore().removeApp(app, days));

  // --- code-server (local VS Code in a tab) ---
  ipcMain.handle('code:open', async (_e, opts) => {
    return codeServer.start(opts || {}, (line) => send('code:log', { line }));
  });
  ipcMain.handle('code:stop', () => {
    codeServer.stop();
    return { ok: true };
  });
  ipcMain.handle('code:status', () => ({ ok: true, ...codeServer.status() }));
  ipcMain.handle('code:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return { ok: !r.canceled, folder: r.canceled ? null : r.filePaths[0] };
  });

  // --- Local terminal (node-pty) ---
  ipcMain.handle('pty:spawn', (_e, opts) => localPty.spawn(opts && opts.tabId, opts || {}));
  ipcMain.on('pty:write', (_e, { tabId, data }) => localPty.write(tabId, data));
  ipcMain.on('pty:resize', (_e, { tabId, cols, rows }) => localPty.resize(tabId, cols, rows));
  ipcMain.on('pty:kill', (_e, { tabId }) => localPty.kill(tabId));
  ipcMain.handle('slack:history', async (_e, { channel }) => {
    try {
      return { ok: true, messages: await slack.history(channel) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('slack:send', async (_e, { channel, text, threadTs }) => {
    try {
      const ts = await slack.send(channel, text, threadTs);
      return { ok: true, ts };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('slack:replies', async (_e, { channel, ts }) => {
    try {
      return { ok: true, messages: await slack.replies(channel, ts) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('slack:presence', async (_e, { user }) => {
    try {
      return { ok: true, presence: await slack.getPresence(user) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('slack:image', async (_e, { url }) => {
    try {
      return { ok: true, dataUrl: await slack.fetchImageDataUrl(url) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('slack:disconnect', () => {
    slack.disconnect();
    return { ok: true };
  });

  // ---- Google (Gmail + Calendar) IPC ----
  ipcMain.handle('google:loadConfig', () => {
    const s = store.loadSettings();
    return {
      clientId: decryptSecret(s.googleClientId),
      clientSecret: decryptSecret(s.googleClientSecret),
      connected: googleMgr.connected,
    };
  });
  ipcMain.handle('google:connect', async (_e, { clientId, clientSecret }) => {
    try {
      googleMgr.configure(clientId, clientSecret);
      const r = await googleMgr.authenticate((u) => shell.openExternal(u));
      const patch = {
        googleClientId: encryptSecret(clientId),
        googleClientSecret: encryptSecret(clientSecret),
      };
      if (r.refreshToken) patch.googleRefreshToken = encryptSecret(r.refreshToken);
      store.saveSettings(patch);
      return { ok: true, email: r.email };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('google:status', async () => {
    try {
      return { ok: true, ...(await googleMgr.status()) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('google:recentMail', async () => {
    try {
      return { ok: true, messages: await googleMgr.recentMail() };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('google:messageBody', async (_e, { id }) => {
    try {
      return { ok: true, ...(await googleMgr.messageBody(id)) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('google:trashMessage', async (_e, { id }) => {
    try {
      await googleMgr.trashMessage(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('google:attachment', async (_e, { messageId, attachmentId, mimeType }) => {
    try {
      return { ok: true, dataUrl: await googleMgr.attachment(messageId, attachmentId, mimeType) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('google:addLabel', async (_e, { id, name }) => {
    try {
      await googleMgr.addLabel(id, name);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('google:upcomingEvents', async () => {
    try {
      return { ok: true, events: await googleMgr.upcomingEvents() };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('google:disconnect', () => {
    googleMgr.disconnect();
    store.saveSettings({ googleRefreshToken: '' });
    return { ok: true };
  });
  ipcMain.handle('slack:forgetTokens', () => {
    slack.disconnect();
    store.saveSettings({ slackBotToken: '', slackAppToken: '' });
    return { ok: true };
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  ssh.disconnectAll();
  slack.disconnect();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  ssh.disconnectAll();
  slack.disconnect();
  if (whatsapp) whatsapp.disconnect();
  localPty.disposeAll();
  codeServer.stop();
  appTracker.stop();
  if (appStore) appStore.flush();
});
