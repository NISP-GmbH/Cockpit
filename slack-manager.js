'use strict';

const { WebClient } = require('@slack/web-api');
const { SocketModeClient } = require('@slack/socket-mode');

// Normalize a Slack message's file attachments to what the renderer needs.
function mapFiles(files) {
  if (!Array.isArray(files)) return [];
  return files
    .map((f) => ({
      name: f.name || f.title || 'file',
      mimetype: f.mimetype || '',
      isImage: !!(f.mimetype && f.mimetype.startsWith('image/')),
      thumb: f.thumb_480 || f.thumb_360 || f.thumb_720 || f.url_private || '',
      permalink: f.permalink || f.url_private || '',
    }))
    .filter((f) => f.thumb || f.permalink);
}

/**
 * Single Slack connection for the app: a WebClient for REST calls and a
 * SocketModeClient for real-time message events. Forwards message events to the
 * renderer via the callbacks passed to connect().
 */
class SlackManager {
  constructor() {
    this.web = null;
    this.socket = null;
    this.userCache = new Map(); // userId -> display name
    this.presenceCache = new Map(); // userId -> { presence, at }
    this.callbacks = {};
  }

  get connected() {
    return !!this.web;
  }

  /**
   * @param {string} botToken xoxb-/xoxp- token for Web API calls
   * @param {string} appToken xapp- app-level token for Socket Mode
   * @param {{onMessage:Function, onStatus:Function}} callbacks
   * @returns {Promise<{team:string, user:string}>}
   */
  async connect(botToken, appToken, callbacks) {
    this.disconnect();
    this.callbacks = callbacks || {};
    this.token = botToken;
    this.web = new WebClient(botToken);

    const auth = await this.web.auth.test(); // throws on a bad token

    this.socket = new SocketModeClient({ appToken });

    this.socket.on('message', async ({ event, ack }) => {
      try {
        if (ack) await ack();
      } catch (_) {
        /* ignore ack errors */
      }
      if (!event || event.type !== 'message' || !event.channel) return;
      // Skip edits/deletes/joins etc.; keep plain, bot, and thread-broadcast messages.
      if (event.subtype && !['bot_message', 'thread_broadcast'].includes(event.subtype)) return;
      const username = await this.resolveUser(event.user, event.username);
      if (this.callbacks.onMessage) {
        this.callbacks.onMessage({
          channel: event.channel,
          user: event.user || null,
          username,
          text: event.text || '',
          ts: event.ts,
          thread_ts: event.thread_ts || null,
          files: mapFiles(event.files),
        });
      }
    });

    this.socket.on('disconnect', () => {
      if (this.callbacks.onStatus) this.callbacks.onStatus('Socket disconnected');
    });

    await this.socket.start();
    return { team: auth.team, user: auth.user, user_id: auth.user_id };
  }

  /** List channels, plus DMs/group-DMs if the token has the scopes. */
  async listChannels() {
    const out = [];
    await this._collect('public_channel,private_channel', out);
    // DMs need im/mpim scopes; best-effort so a channels-only token still works.
    try {
      await this._collect('im,mpim', out);
    } catch (_) {
      /* no DM scopes — skip */
    }
    out.sort((a, b) => {
      const ak = a.is_im || a.is_mpim ? 1 : 0;
      const bk = b.is_im || b.is_mpim ? 1 : 0;
      if (ak !== bk) return ak - bk; // channels first, DMs after
      return (a.name || '').localeCompare(b.name || '');
    });
    return out;
  }

  async _collect(types, out) {
    let cursor;
    do {
      const res = await this.web.conversations.list({
        types,
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      for (const c of res.channels || []) {
        if (c.is_im) {
          if (c.is_user_deleted) continue;
          out.push({ id: c.id, name: await this.resolveUser(c.user), is_im: true, is_member: true });
        } else if (c.is_mpim) {
          out.push({ id: c.id, name: c.name || 'group', is_mpim: true, is_member: true });
        } else {
          out.push({
            id: c.id,
            name: c.name,
            is_private: !!c.is_private,
            is_member: !!c.is_member,
          });
        }
      }
      cursor = res.response_metadata && res.response_metadata.next_cursor;
    } while (cursor);
  }

  /** Recent history for a channel, oldest-first. */
  async history(channel, limit = 50) {
    const res = await this.web.conversations.history({ channel, limit });
    const msgs = (res.messages || []).slice().reverse();
    const out = [];
    for (const m of msgs) {
      out.push({
        user: m.user || null,
        username: await this.resolveUser(m.user, m.username),
        text: m.text || '',
        ts: m.ts,
        thread_ts: m.thread_ts || null,
        reply_count: m.reply_count || 0,
        files: mapFiles(m.files),
      });
    }
    return out;
  }

  /** Parent message + all replies for a thread, oldest-first. */
  async replies(channel, ts) {
    const res = await this.web.conversations.replies({ channel, ts, limit: 200 });
    const out = [];
    for (const m of res.messages || []) {
      out.push({
        user: m.user || null,
        username: await this.resolveUser(m.user, m.username),
        text: m.text || '',
        ts: m.ts,
        thread_ts: m.thread_ts || null,
        files: mapFiles(m.files),
      });
    }
    return out;
  }

  // Fetch a (private) Slack file authenticated with the bot token, as a data URL.
  async fetchImageDataUrl(url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get('content-type') || 'application/octet-stream';
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  async send(channel, text, threadTs) {
    const opts = { channel, text };
    if (threadTs) opts.thread_ts = threadTs;
    const res = await this.web.chat.postMessage(opts);
    return res.ts;
  }

  async resolveUser(id, fallback) {
    if (!id) return fallback || 'bot';
    if (this.userCache.has(id)) return this.userCache.get(id);
    try {
      const res = await this.web.users.info({ user: id });
      const p = res.user.profile || {};
      const name = p.display_name || res.user.real_name || res.user.name || id;
      this.userCache.set(id, name);
      return name;
    } catch (_) {
      return fallback || id;
    }
  }

  /** active|away|unknown, cached briefly to limit API calls. */
  async getPresence(userId) {
    if (!userId) return 'unknown';
    const c = this.presenceCache.get(userId);
    const now = Date.now();
    if (c && now - c.at < 25000) return c.presence;
    try {
      const res = await this.web.users.getPresence({ user: userId });
      const presence = res.presence || 'unknown';
      this.presenceCache.set(userId, { presence, at: now });
      return presence;
    } catch (_) {
      return 'unknown';
    }
  }

  disconnect() {
    try {
      if (this.socket) this.socket.disconnect();
    } catch (_) {
      /* ignore */
    }
    this.socket = null;
    this.web = null;
  }
}

module.exports = { SlackManager };
