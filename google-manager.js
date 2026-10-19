'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { URL } = require('url');
const { google } = require('googleapis');

const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const SCOPES = [
  // modify allows reading, labelling, archiving and moving to Trash (not permanent delete)
  'https://www.googleapis.com/auth/gmail.modify',
  // send is its own scope: a token granted before the Mail tab existed does not have it, so
  // the tab asks for a reconnect before sending while reading and triage keep working
  GMAIL_SEND_SCOPE,
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

// ---------------------------------------------------------------------------
// Mail tab: parsing threads, and building messages to send.
// ---------------------------------------------------------------------------
function headerValue(headers, name) {
  const n = String(name).toLowerCase();
  const h = (headers || []).find((x) => String(x.name).toLowerCase() === n);
  return h ? h.value : '';
}

// One pass over a payload: the first text/plain and text/html bodies, every attachment,
// and a Content-ID -> attachment map so inline `cid:` images can be resolved.
function walkPayload(payload) {
  let text = '';
  let html = '';
  const attachments = [];
  const cids = {};
  const seen = new Set();
  const stack = [payload];
  while (stack.length) {
    const p = stack.shift();
    if (!p) continue;
    const body = p.body || {};
    const isFile = !!(p.filename || body.attachmentId);
    if (!isFile && body.data) {
      if (p.mimeType === 'text/plain' && !text) text = decodeB64(body.data);
      else if (p.mimeType === 'text/html' && !html) html = decodeB64(body.data);
    }
    if (isFile) {
      const key = body.attachmentId || 'inline:' + attachments.length;
      if (!seen.has(key)) {
        seen.add(key);
        const cid = headerValue(p.headers, 'Content-ID').replace(/^<|>$/g, '');
        const disp = headerValue(p.headers, 'Content-Disposition');
        const att = {
          filename: p.filename || 'attachment',
          mimeType: p.mimeType || 'application/octet-stream',
          attachmentId: body.attachmentId || '',
          size: body.size || 0,
          // Small parts can arrive inline instead of by id; carry the data so the
          // renderer does not have to ask for something that has no id to ask with.
          data: body.attachmentId ? '' : body.data || '',
          inline: !!cid && !/attachment/i.test(disp),
        };
        if (cid) cids[cid] = att;
        attachments.push(att);
      }
    }
    if (p.parts) stack.push(...p.parts);
  }
  return { text, html, attachments, cids };
}

function parseMessage(m) {
  const headers = (m.payload && m.payload.headers) || [];
  const w = walkPayload(m.payload);
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labelIds || [],
    snippet: m.snippet || '',
    internalDate: Number(m.internalDate) || 0,
    from: headerValue(headers, 'From'),
    to: headerValue(headers, 'To'),
    cc: headerValue(headers, 'Cc'),
    replyTo: headerValue(headers, 'Reply-To'),
    date: headerValue(headers, 'Date'),
    subject: headerValue(headers, 'Subject'),
    messageId: headerValue(headers, 'Message-ID'),
    references: headerValue(headers, 'References'),
    text: w.text,
    html: w.html,
    attachments: w.attachments,
    cids: w.cids,
  };
}

// A list row. Metadata format carries no parts, so "has attachment" is read from the top
// MIME type: multipart/mixed is what an attachment makes. A heuristic, and labelled as one.
function summarizeThread(t) {
  const msgs = t.messages || [];
  const first = msgs[0] || {};
  const last = msgs[msgs.length - 1] || {};
  const h = (m, n) => headerValue((m.payload && m.payload.headers) || [], n);
  const labels = new Set();
  msgs.forEach((m) => (m.labelIds || []).forEach((l) => labels.add(l)));
  return {
    id: t.id,
    subject: h(first, 'Subject') || '(no subject)',
    from: h(last, 'From') || h(first, 'From'),
    date: Number(last.internalDate) || 0,
    snippet: last.snippet || t.snippet || '',
    unread: msgs.some((m) => (m.labelIds || []).includes('UNREAD')),
    starred: msgs.some((m) => (m.labelIds || []).includes('STARRED')),
    count: msgs.length,
    hasAttachment: msgs.some((m) => /multipart\/mixed/i.test((m.payload && m.payload.mimeType) || '')),
    labelIds: [...labels],
  };
}

// Run `fn` over `items` with at most `limit` in flight. The old inbox fetch made one
// call after another; a 25-row page that way is 25 round trips back to back.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// A header value must never contain a line break: "Subject: hi\r\nBcc: someone" would
// add a recipient. Everything that reaches a header goes through this first.
function oneLine(v) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
}

// RFC 2047. Anything outside printable ASCII becomes =?UTF-8?B?...?= words, split so no
// word passes the 75-character limit and no multi-byte character is cut in half.
function encodeHeader(v) {
  const s = oneLine(v);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words = [];
  let cur = '';
  for (const ch of s) {
    if (cur && Buffer.byteLength(cur + ch, 'utf8') > 45) {
      words.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => '=?UTF-8?B?' + Buffer.from(w, 'utf8').toString('base64') + '?=').join('\r\n ');
}

// Split "A <a@x>, "B, C" <b@x>" on the commas that separate addresses - not the ones
// inside a quoted name or an angle-bracket address.
function splitAddresses(v) {
  const out = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (const ch of oneLine(v)) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angle = true;
    else if (ch === '>' && !quoted) angle = false;
    if ((ch === ',' || ch === ';') && !quoted && !angle) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Only the display name is ever encoded; the address itself has to stay readable.
function encodeAddress(one) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(one);
  if (!m) return one.trim();
  const name = m[1].trim();
  const addr = m[2].trim();
  if (!name) return '<' + addr + '>';
  const shown = /^[\x20-\x7e]*$/.test(name) ? '"' + name.replace(/["\\]/g, '') + '"' : encodeHeader(name);
  return shown + ' <' + addr + '>';
}

function b64Lines(buf) {
  return buf.toString('base64').replace(/.{1,76}/g, '$&\r\n');
}

function mimeBoundary(tag) {
  return '=_cockpit_' + tag + '_' + crypto.randomBytes(12).toString('hex');
}

// A filename that is not plain ASCII gets an RFC 2231 form alongside an ASCII fallback.
function fileParams(name) {
  const n = oneLine(name) || 'attachment';
  const ascii = n.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  if (ascii === n) return 'filename="' + n + '"';
  return 'filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(n);
}

/**
 * Build an RFC 2822 message. Bodies are base64, so any language and any line length are
 * safe; text+html becomes multipart/alternative; attachments wrap it in multipart/mixed.
 * No Date or Message-ID: Gmail stamps both on send.
 */
function buildMime(o) {
  const CRLF = '\r\n';
  const headers = [];
  const addrs = (name, v) => {
    const list = splitAddresses(v);
    if (list.length) headers.push(name + ': ' + list.map(encodeAddress).join(', '));
  };
  addrs('From', o.from);
  addrs('To', o.to);
  addrs('Cc', o.cc);
  addrs('Bcc', o.bcc);
  headers.push('Subject: ' + encodeHeader(o.subject || ''));
  if (o.inReplyTo) headers.push('In-Reply-To: ' + oneLine(o.inReplyTo));
  if (o.references) headers.push('References: ' + oneLine(o.references));
  headers.push('MIME-Version: 1.0');

  const leaf = (type, content) =>
    ['Content-Type: ' + type + '; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64Lines(Buffer.from(content || '', 'utf8'))].join(CRLF);

  let body = leaf('text/plain', o.text || '');
  if (o.html) {
    const b = mimeBoundary('alt');
    body = [
      'Content-Type: multipart/alternative; boundary="' + b + '"',
      '',
      '--' + b,
      leaf('text/plain', o.text || ''),
      '--' + b,
      leaf('text/html', o.html),
      '--' + b + '--',
      '',
    ].join(CRLF);
  }

  const atts = (o.attachments || []).filter((a) => a && a.b64);
  if (atts.length) {
    const b = mimeBoundary('mix');
    const parts = ['--' + b, body];
    atts.forEach((a) => {
      parts.push(
        '--' + b,
        [
          'Content-Type: ' + oneLine(a.mimeType || 'application/octet-stream') + '; name="' + oneLine(a.name || 'attachment').replace(/["\\]/g, '_') + '"',
          'Content-Disposition: attachment; ' + fileParams(a.name),
          'Content-Transfer-Encoding: base64',
          '',
          b64Lines(Buffer.from(a.b64, 'base64')),
        ].join(CRLF)
      );
    });
    parts.push('--' + b + '--', '');
    body = ['Content-Type: multipart/mixed; boundary="' + b + '"', '', parts.join(CRLF)].join(CRLF);
  }
  return headers.join(CRLF) + CRLF + body;
}

const SEND_RAW_MAX = 4 * 1024 * 1024;
const SEND_DELAY_MAX = 60000; // undo send: the longest a message may be held back

// ---- the address book behind compose suggestions ----
// Gmail has no autocomplete API on the scopes we hold (People API would need another
// grant and another API switched on in the Cloud project), so the book is built from your
// own mail: who you wrote to, and who wrote to you. Automated senders are not people.
const CONTACTS_TTL = 24 * 3600 * 1000;
const CONTACTS_SENT = 300; // sent messages read on a rebuild
const CONTACTS_RECV = 150; // received messages read on a rebuild
const CONTACTS_MAX = 2000;
const NOT_A_PERSON = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|newsletter|news|marketing|info@.*mailchimp)([._+-]|@)|@.*(bounce|mailchimp|sendgrid|amazonses|mandrillapp)\./i;
function parseAddress(one) {
  const s = String(one || '').trim();
  const m = /^(.*?)<([^>]+)>\s*$/.exec(s);
  const email = (m ? m[2] : s).trim().replace(/^mailto:/i, '').toLowerCase();
  let name = m ? m[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"').trim() : '';
  if (name.toLowerCase() === email) name = '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { name, email } : null;
}
const UNREAD_COUNT_PAGES = 2; // 1000 unread threads is plenty for a badge that says 999+
function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// "Load images" for a mail. Off by default because a remote image tells the sender you
// opened it; when asked for, fetch here (the page CSP blocks it in the renderer) and hand
// back a data URL. Only public http(s) hosts, only images, and capped - a mail must not be
// able to make Cockpit poke at the local network.
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;
// Redirects are followed HERE, one hop at a time, so every hop gets the public-host check:
// fetch's own redirect:'follow' would go wherever a Location header says - 127.0.0.1
// included. Node's fetch has no cookie jar and sends no referrer, so nothing identifies you
// beyond the request itself. `opts.isPrivate` exists for the harness.
const FETCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
async function fetchFollow(url, opts = {}) {
  const isPrivate = opts.isPrivate || ((h) => PRIVATE_HOST.test(h));
  const maxHops = opts.maxHops || 8;
  const hops = [];
  let cur = String(url);
  for (let i = 0; i <= maxHops; i++) {
    let u;
    try {
      u = new URL(cur);
    } catch (_) {
      throw new Error('not a URL');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { res: null, url: u.toString(), hops, stopped: 'not http' };
    if (isPrivate(u.hostname)) throw new Error('not a public host');
    hops.push(u.toString());
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 8000);
    let res;
    try {
      res = await fetch(u.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: ctl.signal,
        headers: { 'user-agent': FETCH_UA, accept: opts.accept || '*/*' },
      });
    } finally {
      clearTimeout(timer);
    }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      try {
        if (res.body) await res.body.cancel();
      } catch (_) {
        /* nothing to drain */
      }
      cur = new URL(loc, u).toString();
      continue;
    }
    return { res, url: u.toString(), hops };
  }
  throw new Error('too many redirects');
}
async function readCapped(res, cap) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
    n += value.length;
    if (n >= cap) {
      try {
        await reader.cancel();
      } catch (_) {
        /* already closed */
      }
      break;
    }
  }
  return Buffer.concat(parts).slice(0, cap);
}
// "Where does it go?" for a tracking link: follow it WITHOUT opening it. HTTP redirects,
// then the two ways tracker pages bounce you on - a meta refresh, or a one-line script on a
// tiny page. The sender may still count this as a click; the renderer only asks on request.
async function resolveRedirects(url, opts = {}) {
  const all = [];
  let cur = String(url);
  for (let round = 0; round < 4; round++) {
    const r = await fetchFollow(cur, { ...opts, accept: 'text/html,*/*' });
    all.push(...r.hops);
    if (!r.res) return { final: r.url, hops: all.concat(r.url) };
    const type = r.res.headers.get('content-type') || '';
    if (!/html/i.test(type)) {
      try {
        if (r.res.body) await r.res.body.cancel();
      } catch (_) {
        /* fine */
      }
      return { final: r.url, hops: all, status: r.res.status };
    }
    const text = (await readCapped(r.res, 65536)).toString('utf8');
    const meta =
      /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']?\s*\d+\s*;\s*url=([^"'>\s]+)/i.exec(text) ||
      /<meta[^>]+content=["']?\s*\d+\s*;\s*url=([^"'>\s]+)[^>]*http-equiv=["']?refresh/i.exec(text);
    // a script redirect only counts on a small page: a real page full of scripts is a destination
    const js = text.length < 8192 ? /(?:window\.|document\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']|location\.replace\(\s*["']([^"']+)["']\s*\)/.exec(text) : null;
    const next = meta ? meta[1] : js ? js[1] || js[2] : null;
    if (!next) return { final: r.url, hops: all, status: r.res.status };
    cur = new URL(next.replace(/&amp;/g, '&').replace(/\\\//g, '/'), r.url).toString();
  }
  return { final: cur, hops: all };
}
async function fetchImageDataUrl(url, maxBytes, opts = {}) {
  const cap = maxBytes || 5 * 1024 * 1024;
  let u;
  try {
    u = new URL(String(url));
  } catch (_) {
    throw new Error('not a URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) images');
  const followed = await fetchFollow(u.toString(), { ...opts, accept: 'image/*' });
  if (!followed.res) throw new Error('only http(s) images');
  const res = followed.res;
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\//i.test(type)) throw new Error('not an image');
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > cap) throw new Error('too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > cap) throw new Error('too large');
  return 'data:' + type + ';base64,' + buf.toString('base64');
}

/**
 * Google (Gmail + Calendar) client using the OAuth2 loopback flow, suitable for a desktop
 * app. Tokens auto-refresh via the stored refresh token. Reads, triages and (with the send
 * scope granted) sends mail; the calendar is read-only.
 */
class GoogleManager {
  constructor() {
    this.clientId = null;
    this.clientSecret = null;
    this.oauth = null;
    this.email = null;
    this.labelCache = new Map(); // label name -> id
    this.pending = new Map(); // undo send: id -> { o, timer, onResult }
    this.contactsFile = null; // set by main.js; null = memory only
    this.book = null; // email -> { email, name, sent, recv, last }
    this.bookBuiltAt = 0;
    this._building = null;
    this._saveTimer = null;
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

  // `q` narrows the board the way the Mail tab's category filter does (category:primary ...).
  async recentMail(max = 15, q) {
    const gmail = google.gmail({ version: 'v1', auth: this.oauth });
    const list = await gmail.users.messages.list({
      userId: 'me',
      maxResults: max,
      labelIds: ['INBOX'],
      ...(q ? { q } : {}),
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
        threadId: m.threadId || msg.data.threadId || '',
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

  // --- Mail tab ---------------------------------------------------------------
  _gmail() {
    return google.gmail({ version: 'v1', auth: this.oauth });
  }

  /** One page of threads for a view (a label, a search, or both). */
  async listThreads(o = {}) {
    const gmail = this._gmail();
    const params = { userId: 'me', maxResults: Math.max(1, Math.min(50, Number(o.max) || 25)) };
    if (o.q) params.q = String(o.q);
    if (Array.isArray(o.labelIds) && o.labelIds.length) params.labelIds = o.labelIds;
    if (o.pageToken) params.pageToken = o.pageToken;
    const list = await gmail.users.threads.list(params);
    const ids = (list.data.threads || []).map((t) => t.id);
    const threads = await mapLimit(ids, 8, async (id) => {
      const t = await gmail.users.threads.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Date'],
      });
      return summarizeThread(t.data);
    });
    return { threads, nextPageToken: list.data.nextPageToken || null };
  }

  /** A whole conversation, bodies and all - raw HTML included, for the reading pane. */
  async getThread(id) {
    const t = await this._getThread(id);
    this._bookLoad();
    for (const m of t.messages) {
      const when = m.internalDate || 0;
      const mine = (m.labelIds || []).includes('SENT');
      if (mine) ['to', 'cc'].forEach((k) => this._bookAdd(m[k], 'sent', when));
      else this._bookAdd(m.from, 'recv', when);
    }
    this._bookSaveSoon();
    return t;
  }
  async _getThread(id) {
    const t = await this._gmail().users.threads.get({ userId: 'me', id, format: 'full' });
    const messages = (t.data.messages || []).map(parseMessage);
    return { id: t.data.id, messages };
  }

  /** Add/remove labels on a whole thread. Archive, read state and stars are all this. */
  async modifyThread(id, add, remove) {
    const requestBody = {};
    if (Array.isArray(add) && add.length) requestBody.addLabelIds = add;
    if (Array.isArray(remove) && remove.length) requestBody.removeLabelIds = remove;
    await this._gmail().users.threads.modify({ userId: 'me', id, requestBody });
    return true;
  }

  async trashThread(id) {
    await this._gmail().users.threads.trash({ userId: 'me', id });
    return true;
  }

  /** The undo for a trash - Trash is 30 days, not gone. */
  async untrashThread(id) {
    await this._gmail().users.threads.untrash({ userId: 'me', id });
    return true;
  }

  async listLabels() {
    const res = await this._gmail().users.labels.list({ userId: 'me' });
    return (res.data.labels || []).map((l) => ({ id: l.id, name: l.name, type: l.type }));
  }

  /** The real unread count - the old board only ever counted its latest 15 rows. */
  // No filter: the label's own counter, exact and one call. With a category filter there is
  // no counter to read (a category label also covers archived mail), so count the matching
  // unread inbox threads - ids only, two pages at most. resultSizeEstimate is not used on
  // purpose: it is an estimate, and a badge that is wrong is worse than none.
  async unreadCount(o = {}) {
    if (!o.q) {
      const res = await this._gmail().users.labels.get({ userId: 'me', id: 'INBOX' });
      return { threads: res.data.threadsUnread || 0, messages: res.data.messagesUnread || 0 };
    }
    let n = 0;
    let pageToken;
    for (let page = 0; page < UNREAD_COUNT_PAGES; page++) {
      const res = await this._gmail().users.threads.list({
        userId: 'me',
        labelIds: ['INBOX', 'UNREAD'],
        q: o.q,
        maxResults: 500,
        pageToken,
        fields: 'threads(id),nextPageToken',
      });
      n += (res.data.threads || []).length;
      pageToken = res.data.nextPageToken;
      if (!pageToken) return { threads: n, messages: null };
    }
    return { threads: n, messages: null, capped: true };
  }

  /** Which scopes the stored grant really carries (a pre-Mail-tab token has no send). */
  async grantedScopes() {
    const { token } = await this.oauth.getAccessToken();
    const info = await this.oauth.getTokenInfo(token);
    return info.scopes || [];
  }

  async canSend() {
    try {
      return (await this.grantedScopes()).includes(GMAIL_SEND_SCOPE);
    } catch (_) {
      return false;
    }
  }

  /** Send, or reply into a thread when threadId + In-Reply-To + References are given. */
  // A JSON body with `raw` is the simple path, but it is size-limited; past a few MB the
  // message goes up as a media upload instead, which takes up to Gmail's 35 MB.
  async send(o) {
    const mime = buildMime(o || {});
    const requestBody = {};
    if (o && o.threadId) requestBody.threadId = o.threadId;
    const params = { userId: 'me', requestBody };
    if (Buffer.byteLength(mime) > SEND_RAW_MAX) params.media = { mimeType: 'message/rfc822', body: mime };
    else requestBody.raw = b64url(mime);
    const res = await this._gmail().users.messages.send(params);
    this._bookLoad();
    ['to', 'cc', 'bcc'].forEach((k) => this._bookAdd(o && o[k], 'sent', Date.now()));
    this._bookSaveSoon();
    return { id: res.data.id, threadId: res.data.threadId };
  }

  // ---- undo send ----
  // The delay lives HERE, not in the renderer: a reload of the window cannot lose a held
  // message, and flushPending() sends whatever is still waiting when the app quits - a
  // quit is not an undo.
  sendLater(o, delayMs, onResult) {
    const delay = Math.max(0, Math.min(SEND_DELAY_MAX, Number(delayMs) || 0));
    const id = 'ps' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const p = { o, onResult, timer: null };
    p.timer = setTimeout(() => this.sendPendingNow(id), delay);
    this.pending.set(id, p);
    return { pending: id, sendAt: Date.now() + delay };
  }
  cancelPending(id) {
    const p = this.pending.get(id);
    if (!p) return false; // already on its way (or gone)
    clearTimeout(p.timer);
    this.pending.delete(id);
    return true;
  }
  async sendPendingNow(id) {
    const p = this.pending.get(id);
    if (!p) return null;
    clearTimeout(p.timer);
    this.pending.delete(id); // before the await: a cancel from now on is too late, and says so
    let res;
    try {
      res = { ok: true, ...(await this.send(p.o)) };
    } catch (err) {
      res = { ok: false, error: err.message || String(err) };
    }
    if (p.onResult) p.onResult({ pending: id, ...res });
    return res;
  }
  flushPending() {
    return Promise.all([...this.pending.keys()].map((id) => this.sendPendingNow(id)));
  }

  // ---- contacts ----
  _bookAdd(raw, kind, when, into) {
    if (!raw) return;
    if (!into && !this.book) this.book = new Map();
    const book = into || this.book;
    const me = String(this.email || '').toLowerCase();
    for (const one of splitAddresses(raw)) {
      const a = parseAddress(one);
      if (!a || a.email === me || NOT_A_PERSON.test(a.email)) continue;
      const c = book.get(a.email) || { email: a.email, name: '', sent: 0, recv: 0, last: 0 };
      if (a.name && (!c.name || kind === 'sent')) c.name = a.name; // how YOU address them wins
      c[kind] += 1;
      c.last = Math.max(c.last, when || 0);
      book.set(a.email, c);
    }
  }
  _bookList() {
    return [...(this.book || new Map()).values()]
      .sort((a, b) => b.sent * 4 + b.recv - (a.sent * 4 + a.recv) || b.last - a.last)
      .slice(0, CONTACTS_MAX);
  }
  _bookSaveSoon() {
    if (!this.contactsFile) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._bookSave(), 2000);
  }
  _bookSave() {
    if (!this.contactsFile || !this.book) return;
    try {
      const tmp = this.contactsFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ builtAt: this.bookBuiltAt, contacts: this._bookList() }));
      fs.renameSync(tmp, this.contactsFile);
    } catch (_) {
      /* a cache: losing it costs one rebuild */
    }
  }
  _bookLoad() {
    if (this.book || !this.contactsFile) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.contactsFile, 'utf8'));
      this.book = new Map((j.contacts || []).filter((c) => c && c.email).map((c) => [c.email, c]));
      this.bookBuiltAt = Number(j.builtAt) || 0;
    } catch (_) {
      /* no cache yet */
    }
  }
  forgetContacts() {
    clearTimeout(this._saveTimer);
    this.book = null;
    this.bookBuiltAt = 0;
    if (this.contactsFile) {
      try {
        fs.unlinkSync(this.contactsFile);
      } catch (_) {
        /* was not there */
      }
    }
  }
  // Read recent sent and received headers into a fresh book. Few requests in flight,
  // because each metadata read costs quota; one failed read is skipped, not fatal.
  async _harvest() {
    const gmail = this._gmail();
    const ids = async (params, max) => {
      const out = [];
      let pageToken;
      while (out.length < max) {
        const res = await gmail.users.messages.list({ userId: 'me', maxResults: Math.min(500, max - out.length), pageToken, ...params });
        out.push(...(res.data.messages || []).map((m) => m.id));
        pageToken = res.data.nextPageToken;
        if (!pageToken) break;
      }
      return out;
    };
    // Built aside and swapped in whole: suggestions keep using the old book meanwhile, and
    // a rebuild that fails half way leaves it untouched.
    const fresh = new Map();
    const read = async (id, headers, kinds) => {
      try {
        const r = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: headers });
        const hs = (r.data.payload && r.data.payload.headers) || [];
        const when = Number(r.data.internalDate) || 0;
        for (const [h, kind] of kinds) this._bookAdd(headerValue(hs, h), kind, when, fresh);
      } catch (_) {
        /* skip this one */
      }
    };
    const sent = await ids({ labelIds: ['SENT'] }, CONTACTS_SENT);
    await mapLimit(sent, 4, (id) => read(id, ['To', 'Cc', 'Bcc'], [['To', 'sent'], ['Cc', 'sent'], ['Bcc', 'sent']]));
    const recv = await ids({ labelIds: ['INBOX'], q: '-category:promotions -category:social -category:forums' }, CONTACTS_RECV);
    await mapLimit(recv, 4, (id) => read(id, ['From'], [['From', 'recv']]));
    this.book = fresh;
    this.bookBuiltAt = Date.now();
    this._bookSave();
  }
  // What compose suggests from. Answers from the cache at once; rebuilds in the background
  // when the cache is a day old, calling onRebuilt with the new list when that lands.
  async contacts(opts = {}, onRebuilt) {
    this._bookLoad();
    const stale = Date.now() - this.bookBuiltAt > CONTACTS_TTL;
    if ((stale || opts.refresh) && !this._building && this.connected) {
      this._building = this._harvest()
        .then(() => onRebuilt && onRebuilt(this._bookList()))
        .catch(() => {})
        .finally(() => (this._building = null));
    }
    return { contacts: this._bookList(), builtAt: this.bookBuiltAt, building: !!this._building };
  }

  /** The thread a message belongs to (Black Box events only remember the message). */
  async threadIdOf(messageId) {
    const res = await this._gmail().users.messages.get({ userId: 'me', id: messageId, format: 'minimal' });
    return res.data.threadId;
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

module.exports = {
  GoogleManager,
  // Exported for the scratch harnesses; nothing else needs them.
  _mail: { resolveRedirects, fetchFollow, parseAddress, NOT_A_PERSON, buildMime, encodeHeader, splitAddresses, encodeAddress, walkPayload, parseMessage, summarizeThread, mapLimit, b64url, fetchImageDataUrl, PRIVATE_HOST },
};
