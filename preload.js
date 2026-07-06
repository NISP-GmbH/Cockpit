'use strict';

const { contextBridge, ipcRenderer, clipboard } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');

// file:// URL of the guest preload injected into web <webview>s (adds Ctrl+wheel zoom).
const WEBVIEW_PRELOAD = pathToFileURL(path.join(__dirname, 'webview-preload.js')).toString();

/**
 * Locked-down bridge between the renderer (terminal UI) and the main process (SSH).
 * The renderer has no direct Node access; everything goes through this API.
 */
contextBridge.exposeInMainWorld('sshApi', {
  webviewPreload: WEBVIEW_PRELOAD, // guest preload path for <webview preload="…">
  // --- session profiles ---
  // --- clipboard (PuTTY-style copy on select / right-click paste) ---
  clipboardWrite: (text) => clipboard.writeText(text),
  clipboardRead: () => clipboard.readText(),

  loadSessions: () => ipcRenderer.invoke('store:load'),
  saveSessions: (sessions) => ipcRenderer.invoke('store:save', sessions),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  discoverKeys: () => ipcRenderer.invoke('keys:discover'),
  browseKey: () => ipcRenderer.invoke('keys:browse'),

  // --- connection lifecycle (per tabId) ---
  connect: (opts) => ipcRenderer.invoke('ssh:connect', opts),
  write: (tabId, data) => ipcRenderer.send('ssh:write', { tabId, data }),

  // --- SFTP ---
  sftpList: (tabId, dir) => ipcRenderer.invoke('sftp:list', { tabId, dir }),
  sftpDownload: (tabId, remotePath, name) =>
    ipcRenderer.invoke('sftp:download', { tabId, remotePath, name }),
  sftpUpload: (tabId, dir) => ipcRenderer.invoke('sftp:upload', { tabId, dir }),
  sftpUploadPaths: (tabId, dir, paths) => ipcRenderer.invoke('sftp:uploadPaths', { tabId, dir, paths }),
  sftpDelete: (tabId, path, isDir) => ipcRenderer.invoke('sftp:delete', { tabId, path, isDir }),
  saveBase64: (name, b64) => ipcRenderer.invoke('file:saveBase64', { name, b64 }),
  resize: (tabId, cols, rows) => ipcRenderer.send('ssh:resize', { tabId, cols, rows }),
  disconnect: (tabId) => ipcRenderer.send('ssh:disconnect', { tabId }),

  // --- Port forwarding (SSH tunnels) ---
  tunnelList: (tabId) => ipcRenderer.invoke('tunnel:list', { tabId }),
  tunnelStart: (spec) => ipcRenderer.invoke('tunnel:start', spec),
  tunnelStop: (id) => ipcRenderer.invoke('tunnel:stop', { id }),
  onTunnelUpdate: (cb) => {
    const handler = (_e, t) => cb(t);
    ipcRenderer.on('tunnel:update', handler);
    return () => ipcRenderer.removeListener('tunnel:update', handler);
  },

  // --- App-usage accounting ---
  apptrackSetEnabled: (on, intervalSec, detailed) => ipcRenderer.invoke('apptrack:setEnabled', { on, intervalSec, detailed }),
  apptrackGetState: () => ipcRenderer.invoke('apptrack:getState'),
  apptrackClear: () => ipcRenderer.invoke('apptrack:clear'),
  apptrackRemove: (app, days) => ipcRenderer.invoke('apptrack:remove', { app, days }),
  onApptrackSample: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('apptrack:sample', handler);
    return () => ipcRenderer.removeListener('apptrack:sample', handler);
  },

  // --- Host vitals ---
  vitalsStart: (tabId, intervalMs) => ipcRenderer.send('vitals:start', { tabId, intervalMs }),
  vitalsStop: (tabId) => ipcRenderer.send('vitals:stop', { tabId }),
  onVitals: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('vitals:sample', handler);
    return () => ipcRenderer.removeListener('vitals:sample', handler);
  },

  // --- Slack ---
  slackSaveTokens: (tokens) => ipcRenderer.invoke('slack:saveTokens', tokens),
  slackLoadTokens: () => ipcRenderer.invoke('slack:loadTokens'),
  slackConnect: (tokens) => ipcRenderer.invoke('slack:connect', tokens),
  slackChannels: () => ipcRenderer.invoke('slack:channels'),
  slackHistory: (channel) => ipcRenderer.invoke('slack:history', { channel }),
  slackSend: (channel, text, threadTs) => ipcRenderer.invoke('slack:send', { channel, text, threadTs }),
  slackReplies: (channel, ts) => ipcRenderer.invoke('slack:replies', { channel, ts }),
  slackPresence: (user) => ipcRenderer.invoke('slack:presence', { user }),
  slackImage: (url) => ipcRenderer.invoke('slack:image', { url }),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // --- ssh:// link handling ---
  setSshProtocol: (on) => ipcRenderer.invoke('app:setSshProtocol', on),
  onSshUrl: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('ssh:open-url', handler);
    return () => ipcRenderer.removeListener('ssh:open-url', handler);
  },

  // --- Black Box (local event timeline) ---
  blackboxLog: (events) => ipcRenderer.invoke('blackbox:log', events),
  blackboxQuery: (range) => ipcRenderer.invoke('blackbox:query', range || {}),
  blackboxClear: () => ipcRenderer.invoke('blackbox:clear'),
  blackboxStats: () => ipcRenderer.invoke('blackbox:stats'),
  blackboxTrim: (days) => ipcRenderer.invoke('blackbox:trim', days),

  // --- Project accounting ---
  projectGetState: () => ipcRenderer.invoke('project:getState'),
  projectAdd: (name, color) => ipcRenderer.invoke('project:add', { name, color }),
  projectRename: (id, name) => ipcRenderer.invoke('project:rename', { id, name }),
  projectSetColor: (id, color) => ipcRenderer.invoke('project:setColor', { id, color }),
  projectSetCurrent: (id) => ipcRenderer.invoke('project:setCurrent', { id }),
  projectSetRunning: (on) => ipcRenderer.invoke('project:setRunning', { on }),
  projectStartSegment: (projectId, start) => ipcRenderer.invoke('project:startSegment', { projectId, start }),
  projectTouchSegment: (end) => ipcRenderer.invoke('project:touchSegment', { end }),
  projectStopSegment: (end) => ipcRenderer.invoke('project:stopSegment', { end }),
  projectReassign: (start, end, toId) => ipcRenderer.invoke('project:reassign', { start, end, toId }),
  projectReassignRecent: (fromId, toId, seconds) => ipcRenderer.invoke('project:reassignRecent', { fromId, toId, seconds }),
  projectSetSegments: (segments) => ipcRenderer.invoke('project:setSegments', { segments }),
  projectAddSegment: (projectId, start, end, note) => ipcRenderer.invoke('project:addSegment', { projectId, start, end, note }),
  projectUpdateSegment: (id, patch) => ipcRenderer.invoke('project:updateSegment', { id, patch }),
  projectDeleteSegment: (id) => ipcRenderer.invoke('project:deleteSegment', { id }),
  projectDeleteProject: (id, reassignToId) => ipcRenderer.invoke('project:deleteProject', { id, reassignToId }),

  // --- code-server (local VS Code) ---
  codeOpen: (opts) => ipcRenderer.invoke('code:open', opts || {}),
  codeStop: () => ipcRenderer.invoke('code:stop'),
  codeStatus: () => ipcRenderer.invoke('code:status'),
  codePickFolder: () => ipcRenderer.invoke('code:pickFolder'),
  onCodeLog: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('code:log', handler);
    return () => ipcRenderer.removeListener('code:log', handler);
  },

  // --- Local terminal (node-pty) ---
  ptySpawn: (tabId, opts) => ipcRenderer.invoke('pty:spawn', { tabId, ...(opts || {}) }),
  ptyWrite: (tabId, data) => ipcRenderer.send('pty:write', { tabId, data }),
  ptyResize: (tabId, cols, rows) => ipcRenderer.send('pty:resize', { tabId, cols, rows }),
  ptyKill: (tabId) => ipcRenderer.send('pty:kill', { tabId }),
  onPtyData: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('pty:data', handler);
    return () => ipcRenderer.removeListener('pty:data', handler);
  },
  onPtyExit: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('pty:exit', handler);
    return () => ipcRenderer.removeListener('pty:exit', handler);
  },
  focusWindow: () => ipcRenderer.invoke('app:focus'),
  bringToFront: () => ipcRenderer.invoke('app:toFront'),
  capturePage: (rect) => ipcRenderer.invoke('app:capturePage', rect),
  openTerminal: (opts) => ipcRenderer.invoke('app:openTerminal', opts),

  // --- Web extensions ---
  webAddExtension: () => ipcRenderer.invoke('web:addExtension'),
  webListExtensions: () => ipcRenderer.invoke('web:listExtensions'),
  webClearExtensions: () => ipcRenderer.invoke('web:clearExtensions'),

  // --- Mini-cockpit (PiP) ---
  pipUpdate: (data) => ipcRenderer.send('pip:update', data), // main renderer → PiP
  pipSetEnabled: (on) => ipcRenderer.invoke('pip:setEnabled', on),
  pipFocusMain: () => ipcRenderer.send('pip:focusMain'), // PiP → focus main window
  onPipData: (cb) => ipcRenderer.on('pip:data', (_e, d) => cb(d)), // PiP receives data

  // --- Google (Gmail + Calendar) ---
  googleLoadConfig: () => ipcRenderer.invoke('google:loadConfig'),
  googleConnect: (cfg) => ipcRenderer.invoke('google:connect', cfg),
  googleStatus: () => ipcRenderer.invoke('google:status'),
  googleRecentMail: () => ipcRenderer.invoke('google:recentMail'),
  googleMessageBody: (id) => ipcRenderer.invoke('google:messageBody', { id }),
  googleAttachment: (messageId, attachmentId, mimeType) =>
    ipcRenderer.invoke('google:attachment', { messageId, attachmentId, mimeType }),
  googleTrashMessage: (id) => ipcRenderer.invoke('google:trashMessage', { id }),
  googleAddLabel: (id, name) => ipcRenderer.invoke('google:addLabel', { id, name }),
  googleUpcomingEvents: () => ipcRenderer.invoke('google:upcomingEvents'),
  googleDisconnect: () => ipcRenderer.invoke('google:disconnect'),
  slackDisconnect: () => ipcRenderer.invoke('slack:disconnect'),
  slackForgetTokens: () => ipcRenderer.invoke('slack:forgetTokens'),

  // --- WhatsApp (Baileys, QR login) ---
  whatsappConnect: () => ipcRenderer.invoke('whatsapp:connect'),
  whatsappStatus: () => ipcRenderer.invoke('whatsapp:status'),
  whatsappSend: (jid, text) => ipcRenderer.invoke('whatsapp:send', { jid, text }),
  whatsappLogout: () => ipcRenderer.invoke('whatsapp:logout'),
  onWhatsappMessage: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('whatsapp:message', handler);
    return () => ipcRenderer.removeListener('whatsapp:message', handler);
  },
  onWhatsappStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('whatsapp:status', handler);
    return () => ipcRenderer.removeListener('whatsapp:status', handler);
  },
  onWhatsappQr: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('whatsapp:qr', handler);
    return () => ipcRenderer.removeListener('whatsapp:qr', handler);
  },
  onSlackMessage: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('slack:message', handler);
    return () => ipcRenderer.removeListener('slack:message', handler);
  },
  onSlackStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('slack:status', handler);
    return () => ipcRenderer.removeListener('slack:status', handler);
  },

  // --- events from main (return unsubscribe fns) ---
  onData: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('ssh:data', handler);
    return () => ipcRenderer.removeListener('ssh:data', handler);
  },
  onStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('ssh:status', handler);
    return () => ipcRenderer.removeListener('ssh:status', handler);
  },
  onError: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('ssh:error', handler);
    return () => ipcRenderer.removeListener('ssh:error', handler);
  },
  onClose: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('ssh:close', handler);
    return () => ipcRenderer.removeListener('ssh:close', handler);
  },
});
