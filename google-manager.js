'use strict';

const http = require('http');
const { URL } = require('url');
const { google } = require('googleapis');

const SCOPES = [
  // modify allows reading + moving messages to Trash (not permanent delete)
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.readonly',
];

function decodeB64(data) {
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function stripHtml(h) {
  return h
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Best video-conference link for an event: Meet, then conferenceData, then any URL
// found in the location or description (preferring known conferencing domains).
function conferenceLink(e) {
  if (e.hangoutLink) return e.hangoutLink;
  const cd = e.conferenceData;
  if (cd && Array.isArray(cd.entryPoints)) {
    const v = cd.entryPoints.find((p) => p.entryPointType === 'video' && p.uri);
    if (v) return v.uri;
  }
  const text = (e.location || '') + '\n' + (e.description || '');
  const urls = text.match(/https?:\/\/[^\s<>"')]+/g) || [];
  if (!urls.length) return '';
  const known =
    /(zoom\.us|meet\.google\.com|teams\.microsoft|teams\.live|webex\.com|whereby\.com|gotomeet|bluejeans|chime\.aws|around\.co|meet\.jit\.si|slack\.com\/(call|huddle))/i;
  return urls.find((u) => known.test(u)) || urls[0];
}

// Collect every part that has downloadable content (attachments + inline images).
function collectAttachments(payload) {
  const out = [];
  const seen = new Set();
  const stack = [payload];
  while (stack.length) {
    const p = stack.shift();
    if (!p) continue;
    if (p.body && p.body.attachmentId && !seen.has(p.body.attachmentId)) {
      seen.add(p.body.attachmentId);
      out.push({
        filename: p.filename || 'attachment',
        mimeType: p.mimeType || '',
        attachmentId: p.body.attachmentId,
        size: p.body.size || 0,
      });
    }
    if (p.parts) stack.push(...p.parts);
  }
  return out;
}

// Pull a plain-text body out of a Gmail message payload (prefers text/plain).
function extractText(payload) {
  const stack = [payload];
  let html = '';
  while (stack.length) {
    const p = stack.shift();
    if (!p) continue;
    if (p.mimeType === 'text/plain' && p.body && p.body.data) return decodeB64(p.body.data);
    if (p.mimeType === 'text/html' && p.body && p.body.data && !html) html = decodeB64(p.body.data);
    if (p.parts) stack.push(...p.parts);
  }
  return html ? stripHtml(html) : '';
}

/**
 * Google (Gmail + Calendar) read-only client using the OAuth2 loopback flow,
 * suitable for a desktop app. Tokens auto-refresh via the stored refresh token.
 */
class GoogleManager {
  constructor() {
    this.clientId = null;
    this.clientSecret = null;
    this.oauth = null;
    this.email = null;
    this.labelCache = new Map(); // label name -> id
  }

  get connected() {
    return !!(this.oauth && this.oauth.credentials && this.oauth.credentials.refresh_token);
  }

  configure(clientId, clientSecret) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  /** Restore a session from a stored refresh token (no browser needed). */
  useRefreshToken(refreshToken) {
    if (!this.clientId || !refreshToken) return;
    this.oauth = new google.auth.OAuth2(this.clientId, this.clientSecret);
    this.oauth.setCredentials({ refresh_token: refreshToken });
  }

  /**
   * Interactive OAuth via a loopback server. `openUrl(url)` opens the system browser.
   * @returns {Promise<{refreshToken:string, email:string}>}
   */
  authenticate(openUrl) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        try {
          server.close();
        } catch (_) {
          /* ignore */
        }
      };
      const server = http.createServer(async (req, res) => {
        try {
          const u = new URL(req.url, 'http://127.0.0.1');
          const err = u.searchParams.get('error');
          const code = u.searchParams.get('code');
          if (err) {
            res.end('Authentication failed: ' + err);
            cleanup();
            return reject(new Error(err));
          }
          if (!code) {
            res.statusCode = 404;
            return res.end();
          }
          res.setHeader('Content-Type', 'text/html');
          res.end(
            '<html><body style="font-family:sans-serif;background:#1d1f21;color:#c5c8c6;padding:40px">' +
              '<h2>✓ Authentication complete</h2><p>You can close this tab and return to Cockpit.</p></body></html>'
          );
          const { tokens } = await this.oauth.getToken(code);
          this.oauth.setCredentials(tokens);
          await this._loadEmail();
          cleanup();
          resolve({ refreshToken: tokens.refresh_token, email: this.email });
        } catch (e) {
          cleanup();
          reject(e);
        }
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        this.oauth = new google.auth.OAuth2(
          this.clientId,
          this.clientSecret,
          `http://127.0.0.1:${port}`
        );
        const authUrl = this.oauth.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: SCOPES,
        });
        openUrl(authUrl);
      });
      setTimeout(() => {
        if (!settled) {
          cleanup();
          reject(new Error('Authentication timed out'));
        }
      }, 300000);
    });
  }

  async _loadEmail() {
    try {
      const gmail = google.gmail({ version: 'v1', auth: this.oauth });
      const p = await gmail.users.getProfile({ userId: 'me' });
      this.email = p.data.emailAddress;
    } catch (_) {
      /* ignore */
    }
  }

  async status() {
    if (!this.connected) return { connected: false };
    if (!this.email) await this._loadEmail();
    return { connected: true, email: this.email };
  }

  async recentMail(max = 15) {
    const gmail = google.gmail({ version: 'v1', auth: this.oauth });
    const list = await gmail.users.messages.list({
      userId: 'me',
      maxResults: max,
      labelIds: ['INBOX'],
    });
    const out = [];
    for (const m of list.data.messages || []) {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: m.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From'],
      });
      const headers = (msg.data.payload && msg.data.payload.headers) || [];
      const get = (n) => {
        const h = headers.find((x) => x.name === n);
        return h ? h.value : '';
      };
      out.push({
        id: m.id,
        subject: get('Subject') || '(no subject)',
        from: get('From'),
        unread: (msg.data.labelIds || []).includes('UNREAD'),
        snippet: msg.data.snippet || '',
      });
    }
    return out;
  }

  /** Full plain-text body of one message (loaded on demand, for hover preview). */
  async messageBody(id) {
    const gmail = google.gmail({ version: 'v1', auth: this.oauth });
    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const text = extractText(msg.data.payload) || msg.data.snippet || '';
    return {
      body: text.slice(0, 4000),
      snippet: msg.data.snippet || '',
      attachments: collectAttachments(msg.data.payload),
    };
  }

  /** Fetch one attachment as a data URL (loaded on demand for previews). */
  async attachment(messageId, attachmentId, mimeType) {
    const gmail = google.gmail({ version: 'v1', auth: this.oauth });
    const res = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachmentId,
    });
    const b64 = String(res.data.data || '')
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    return `data:${mimeType || 'application/octet-stream'};base64,${b64}`;
  }

  /** Get (creating if needed) the id of a label by name; cached. */
  async ensureLabel(name) {
    if (this.labelCache.has(name)) return this.labelCache.get(name);
    const gmail = google.gmail({ version: 'v1', auth: this.oauth });
    const res = await gmail.users.labels.list({ userId: 'me' });
    let label = (res.data.labels || []).find((l) => l.name === name);
    if (!label) {
      const created = await gmail.users.labels.create({
        userId: 'me',
        requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
      });
      label = created.data;
    }
    this.labelCache.set(name, label.id);
    return label.id;
  }

  /** Add a label (by name) to a message (needs gmail.modify). */
  async addLabel(messageId, name) {
    const gmail = google.gmail({ version: 'v1', auth: this.oauth });
    const labelId = await this.ensureLabel(name);
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { addLabelIds: [labelId] },
    });
    return true;
  }

  /** Move a message to Trash (reversible; needs gmail.modify). */
  async trashMessage(id) {
    const gmail = google.gmail({ version: 'v1', auth: this.oauth });
    await gmail.users.messages.trash({ userId: 'me', id });
    return true;
  }

  async upcomingEvents(max = 10) {
    const cal = google.calendar({ version: 'v3', auth: this.oauth });
    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults: max,
      singleEvents: true,
      orderBy: 'startTime',
    });
    return (res.data.items || []).map((e) => ({
      id: e.id,
      summary: e.summary || '(no title)',
      start: (e.start && (e.start.dateTime || e.start.date)) || null,
      end: (e.end && (e.end.dateTime || e.end.date)) || null,
      allDay: !(e.start && e.start.dateTime),
      location: e.location || '',
      htmlLink: e.htmlLink || '',
      meetLink: conferenceLink(e),
    }));
  }

  disconnect() {
    this.oauth = null;
    this.email = null;
  }
}

module.exports = { GoogleManager };
