'use strict';

const fs = require('fs');
const QRCode = require('qrcode');

// A pino-shaped no-op logger so Baileys stays quiet and never trips on a missing logger.
function silentLogger() {
  const noop = () => {};
  const l = { level: 'silent', trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
  l.child = () => l;
  return l;
}

// WhatsApp via Baileys (multi-device web protocol). Logs in by scanning a QR code
// with your phone — no API key. It mirrors SlackManager's callback shape so the
// renderer can treat WhatsApp messages like Slack ones (a live feed board).
//
// Baileys 7 is ESM-only, so it's loaded with a dynamic import() from this CJS file.
class WhatsAppManager {
  constructor(authDir) {
    this.authDir = authDir; // folder for the persisted login (creds + keys)
    this.sock = null;
    this.callbacks = {};
    this.connected = false;
    this.me = null;
    this.stopped = false;
    this.chatNames = new Map(); // jid -> display name (contacts + group subjects)
    this._DisconnectReason = null;
    this._reconnectTimer = null;
  }

  /** @param {{onMessage:Function, onStatus:Function, onQr:Function}} callbacks */
  async connect(callbacks) {
    if (callbacks) this.callbacks = callbacks;
    this.stopped = false;
    clearTimeout(this._reconnectTimer);

    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;
    this._DisconnectReason = DisconnectReason;

    fs.mkdirSync(this.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (_) {
      /* fall back to the bundled default version */
    }

    const sock = makeWASocket({
      auth: state,
      version,
      logger: silentLogger(),
      browser: (Browsers && Browsers.appropriate && Browsers.appropriate('Cockpit')) || ['Cockpit', 'Chrome', '1.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => this._onConnection(u));
    sock.ev.on('messages.upsert', (up) => this._onMessages(up));
    sock.ev.on('chats.upsert', (chats) => {
      for (const c of chats || []) if (c && c.id && c.name) this.chatNames.set(c.id, c.name);
    });
    sock.ev.on('groups.upsert', (grps) => {
      for (const g of grps || []) if (g && g.id && g.subject) this.chatNames.set(g.id, g.subject);
    });
    sock.ev.on('contacts.upsert', (cts) => {
      for (const c of cts || []) {
        if (!c || !c.id) continue;
        const n = c.name || c.notify || c.verifiedName;
        if (n) this.chatNames.set(c.id, n);
      }
    });
    return { ok: true };
  }

  async _onConnection(u) {
    const { connection, lastDisconnect, qr } = u;
    if (qr && this.callbacks.onQr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 260 });
        this.callbacks.onQr(dataUrl);
      } catch (_) {
        /* qr render failed */
      }
    }
    if (connection === 'open') {
      this.connected = true;
      this.me = (this.sock && this.sock.user) || null;
      if (this.callbacks.onStatus) this.callbacks.onStatus({ state: 'connected', me: this.me });
    } else if (connection === 'close') {
      this.connected = false;
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode
        : null;
      const loggedOut = this._DisconnectReason && code === this._DisconnectReason.loggedOut;
      if (this.callbacks.onStatus) {
        this.callbacks.onStatus({ state: loggedOut ? 'logged_out' : 'disconnected' });
      }
      if (!this.stopped && !loggedOut) {
        // Transient drop — reconnect (reuses the saved creds, no new QR).
        this._reconnectTimer = setTimeout(() => this.connect().catch(() => {}), 3000);
      }
    }
  }

  _onMessages(up) {
    if (!up || up.type !== 'notify') return;
    for (const m of up.messages || []) {
      if (!m || !m.message || !m.key) continue;
      const text = this._extractText(m.message);
      if (!text) continue; // skip receipts, reactions, media without a caption, etc.
      const jid = m.key.remoteJid || '';
      if (jid === 'status@broadcast') continue; // ignore "status" updates
      const isGroup = jid.endsWith('@g.us');
      if (!isGroup && m.pushName && !m.key.fromMe) this.chatNames.set(jid, m.pushName);
      const senderNum = ((isGroup ? m.key.participant : jid) || '').split('@')[0];
      if (this.callbacks.onMessage) {
        this.callbacks.onMessage({
          chat: jid,
          chatName: this.chatName(jid),
          isGroup,
          sender: m.key.fromMe ? 'you' : m.pushName || senderNum || 'someone',
          fromMe: !!m.key.fromMe,
          text,
          ts: this._ts(m.messageTimestamp),
        });
      }
    }
  }

  _extractText(msg) {
    return (
      msg.conversation ||
      (msg.extendedTextMessage && msg.extendedTextMessage.text) ||
      (msg.imageMessage && msg.imageMessage.caption) ||
      (msg.videoMessage && msg.videoMessage.caption) ||
      (msg.documentMessage && msg.documentMessage.caption) ||
      (msg.buttonsResponseMessage && msg.buttonsResponseMessage.selectedDisplayText) ||
      (msg.listResponseMessage && msg.listResponseMessage.title) ||
      ''
    );
  }

  _ts(t) {
    if (typeof t === 'number') return t;
    if (t && typeof t.toNumber === 'function') return t.toNumber();
    if (t && typeof t.low === 'number') return t.low;
    return Math.floor(Date.now() / 1000);
  }

  chatName(jid) {
    if (this.chatNames.has(jid)) return this.chatNames.get(jid);
    const user = (jid || '').split('@')[0];
    return jid.endsWith('@g.us') ? 'Group ' + user.slice(-4) : user;
  }

  status() {
    return { connected: this.connected, me: this.me };
  }

  /** Send a text message to a chat jid. */
  async send(jid, text) {
    if (!this.sock || !this.connected) throw new Error('WhatsApp not connected');
    await this.sock.sendMessage(jid, { text });
    return { ok: true };
  }

  /** Full logout: invalidates the session and wipes the stored creds. */
  async logout() {
    this.stopped = true;
    clearTimeout(this._reconnectTimer);
    try {
      if (this.sock) await this.sock.logout();
    } catch (_) {
      /* ignore */
    }
    try {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
    this.sock = null;
    this.connected = false;
    this.me = null;
  }

  /** Stop the socket without wiping creds (used on app quit). */
  disconnect() {
    this.stopped = true;
    clearTimeout(this._reconnectTimer);
    try {
      if (this.sock && this.sock.end) this.sock.end(undefined);
    } catch (_) {
      /* ignore */
    }
    this.sock = null;
    this.connected = false;
  }
}

module.exports = { WhatsAppManager };
