'use strict';

// Agent replies: ask an external agent service to DRAFT a reply to a mail. The service reads
// the thread itself and leaves a draft inside it; it never sends anything.
//
// Everything about the service is the user's own and lives on this machine only: the
// endpoint, the API key, the default model and who signs the drafts are entered in Settings
// and stored as ONE blob encrypted with the OS keystore (safeStorage, via encrypt/decrypt).
// None of it belongs in the code or the repository. The key never leaves the main process:
// the page only learns whether one is set.

const MODEL_KEY = /^[a-z0-9._:-]{1,80}$/i;
const LIMITS = { hint: 4000, body: 60000, header: 500 };
const FINAL = new Set(['done', 'dry-run', 'failed', 'timeout', 'lock-timeout']);

class AgentManager {
  // store: { loadSettings, saveSettings }; encrypt/decrypt: (string) => string;
  // fetch: the global fetch (injectable for tests)
  constructor({ store, encrypt, decrypt, fetch: fetchImpl, now } = {}) {
    this.store = store;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.now = now || (() => Date.now());
    this._models = null; // { at, value }
  }

  _load() {
    const raw = (this.store.loadSettings() || {}).agentConfig;
    if (!raw) return {};
    try {
      return JSON.parse(this.decrypt(raw) || '{}') || {};
    } catch (_) {
      return {};
    }
  }
  _save(cfg) {
    this.store.saveSettings({ agentConfig: this.encrypt(JSON.stringify(cfg)) });
    this._models = null;
  }
  // What the page may know: never the key, never the full endpoint.
  publicConfig() {
    const c = this._load();
    let host = '';
    try {
      host = c.endpoint ? new URL(c.endpoint).host : '';
    } catch (_) {
      host = '';
    }
    return {
      configured: !!(c.endpoint && c.key),
      endpointSet: !!c.endpoint,
      endpointHost: host,
      keySet: !!c.key,
      defaultModel: c.defaultModel || '',
      operator: c.operator || '',
    };
  }
  // Partial update. A field left undefined keeps its value; key/endpoint '' clear them.
  setConfig(p = {}) {
    const c = this._load();
    if (p.endpoint !== undefined) {
      const e = String(p.endpoint || '').trim();
      if (e) {
        let u;
        try {
          u = new URL(e);
        } catch (_) {
          throw new Error('the endpoint is not a URL');
        }
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) {
          throw new Error('the endpoint must be https'); // the key travels with every request
        }
        c.endpoint = u.toString();
      } else delete c.endpoint;
    }
    if (p.key !== undefined) {
      const k = String(p.key || '').trim();
      if (k) c.key = k;
      else delete c.key;
    }
    if (p.defaultModel !== undefined) {
      const m = String(p.defaultModel || '').trim();
      if (m && !MODEL_KEY.test(m)) throw new Error('not a model name: ' + m);
      if (m) c.defaultModel = m;
      else delete c.defaultModel;
    }
    if (p.operator !== undefined) {
      const o = String(p.operator || '').trim();
      if (o && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o)) throw new Error('"sign as" must be an email address');
      if (o) c.operator = o;
      else delete c.operator;
    }
    this._save(c);
    return this.publicConfig();
  }

  async _call(method, query, body) {
    const c = this._load();
    if (!c.endpoint || !c.key) throw new Error('the agent is not set up - Settings → Agent reply');
    const url = c.endpoint + (query ? (c.endpoint.includes('?') ? '&' : '?') + query : '');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers: { 'X-Api-Key': c.key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
        redirect: 'error', // a redirect could carry the key somewhere else
      });
    } catch (err) {
      throw new Error(err && err.name === 'AbortError' ? 'the agent service did not answer in time' : 'could not reach the agent service: ' + ((err && err.message) || err));
    } finally {
      clearTimeout(timer);
    }
    let j = null;
    try {
      j = await res.json();
    } catch (_) {
      j = null;
    }
    if (res.status === 403) throw new Error('the agent service refused the API key');
    if (!j || typeof j !== 'object') throw new Error('the agent service sent no JSON (HTTP ' + res.status + ')');
    if (!j.ok) throw new Error(j.error || 'the agent service said no (HTTP ' + res.status + ')');
    return j;
  }

  // The models the service allows, for the dropdown (cached for 10 minutes).
  async models() {
    if (this._models && this.now() - this._models.at < 10 * 60 * 1000) return this._models.value;
    const j = await this._call('GET', 'models=1');
    const value = { default: j.default || '', models: j.models && typeof j.models === 'object' ? j.models : {} };
    this._models = { at: this.now(), value };
    return value;
  }

  // Start a draft. Only the fields the service knows, trimmed to its limits; the operator comes
  // from Settings unless the call names one.
  async start(p = {}) {
    const c = this._load();
    const clip = (v, n) => (v == null ? undefined : String(v).slice(0, n));
    const body = {};
    for (const k of ['gmail_id', 'thread_id']) if (p[k] && /^[0-9a-f]{6,40}$/i.test(String(p[k]))) body[k] = String(p[k]);
    if (p.message_id) body.message_id = clip(p.message_id, LIMITS.header);
    if (p.body) body.body = clip(p.body, LIMITS.body);
    if (!body.gmail_id && !body.thread_id && !body.message_id && !body.body) throw new Error('nothing to answer: no mail id and no text');
    if (p.hint) {
      if (String(p.hint).length > LIMITS.hint) throw new Error('the guidance is longer than ' + LIMITS.hint + ' characters');
      body.hint = String(p.hint);
    }
    const model = p.model || c.defaultModel;
    if (model) {
      if (!MODEL_KEY.test(model)) throw new Error('not a model name: ' + model);
      body.model = model;
    }
    for (const k of ['subject', 'from', 'to', 'cc', 'date']) if (p[k]) body[k] = clip(p[k], LIMITS.header);
    const operator = p.operator || c.operator;
    if (operator) body.operator = operator;
    if (p.dry_run) body.dry_run = true;
    const j = await this._call('POST', '', body);
    return { job_id: j.job_id, model: j.model || '', already: !!j.already };
  }

  async job(id) {
    if (!/^[\w.-]{1,80}$/.test(String(id || ''))) throw new Error('not a job id');
    const j = await this._call('GET', 'job=' + encodeURIComponent(id));
    return { ...j, final: FINAL.has(j.status) };
  }
}

module.exports = { AgentManager, FINAL };
