'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { Client, utils: sshUtils } = require('ssh2');

let _tunnelSeq = 0;
const nextTunnelId = () => 't' + Date.now().toString(36) + (_tunnelSeq++).toString(36);

// Lightweight one-shot host-vitals probe. Emits a single line:
//   VIT <load1> <ncpu> <mem%> <disk%> <memTotalKB> <memUsedKB> <diskTotalKB> <diskUsedKB>
// The first four fields drive the sparklines; the trailing totals (KB) feed the hover
// tooltip ("29% of 33 GB"). Missing values fall back to the literal "na" so field
// positions stay stable. Linux-oriented (/proc + df -Pk); elsewhere fields come back "na".
const VIT_CMD =
  "L=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null); " +
  'N=$(nproc 2>/dev/null || echo 1); ' +
  "M=$(awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2}END{if(t>0)printf \"%d\",(t-a)*100/t}' /proc/meminfo 2>/dev/null); " +
  "MT=$(awk '/^MemTotal:/{printf \"%d\",$2}' /proc/meminfo 2>/dev/null); " +
  "MU=$(awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2}END{if(t>0)printf \"%d\",t-a}' /proc/meminfo 2>/dev/null); " +
  "DF=$(df -Pk / 2>/dev/null | awk 'NR==2{gsub(/%/,\"\",$5);print $5\" \"$2\" \"$3}'); " +
  'echo VIT ${L:-na} ${N:-1} ${M:-na} ${DF:-na na na} ${MT:-na} ${MU:-na}';

// SSH agent address: Windows OpenSSH named pipe, else the unix socket from the env.
function agentAddress() {
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent';
  return process.env.SSH_AUTH_SOCK || '';
}

/**
 * Manages one ssh2 Client + shell stream per tab id.
 * Emits data/close back to the caller via the callbacks passed to connect().
 */
class SSHManager {
  constructor() {
    /** @type {Map<string, {client: Client, stream: import('stream').Duplex|null}>} */
    this.sessions = new Map();
    /** @type {Map<string, object>} live port-forward tunnels, keyed by tunnel id */
    this.tunnels = new Map();
    /** Set by main.js to push tunnel state/stat updates to the renderer. */
    this.onTunnelUpdate = null;
    this._statTimer = null;
    /** @type {Map<string, NodeJS.Timeout>} per-tab host-vitals poll timers */
    this.vitals = new Map();
    /** Set by main.js to push a vitals sample to the renderer. */
    this.onVitals = null;
  }

  /**
   * Discover default private keys under ~/.ssh.
   * @returns {string[]} absolute paths to candidate key files
   */
  static discoverKeys() {
    const sshDir = path.join(os.homedir(), '.ssh');
    const candidates = ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa'];
    const found = [];
    for (const name of candidates) {
      const p = path.join(sshDir, name);
      try {
        if (fs.statSync(p).isFile()) found.push(p);
      } catch (_) {
        /* not present */
      }
    }
    return found;
  }

  /**
   * @param {object} opts
   * @param {string} opts.tabId
   * @param {string} opts.host
   * @param {number} opts.port
   * @param {string} opts.username
   * @param {('agent'|'key'|'password')} opts.authMethod
   * @param {string} [opts.keyPath]
   * @param {string} [opts.passphrase]
   * @param {string} [opts.password]
   * @param {number} [opts.cols]
   * @param {number} [opts.rows]
   * @param {object} callbacks
   * @param {(data: string) => void} callbacks.onData    raw terminal bytes (binary string)
   * @param {(line: string) => void} callbacks.onStatus  human-readable status lines
   * @param {(info: {code?: number, signal?: string}) => void} callbacks.onClose
   * @param {(message: string) => void} callbacks.onError
   */
  connect(opts, callbacks) {
    const { tabId } = opts;
    this.disconnect(tabId); // ensure no stale session for this tab

    const client = new Client();
    this.sessions.set(tabId, { client, stream: null });

    const connectConfig = {
      host: opts.host,
      port: opts.port || 22,
      username: opts.username,
      keepaliveInterval: 20000,
      // Be permissive about host keys for a personal client; could be hardened later.
      readyTimeout: 30000,
    };

    // Build an ORDERED list of auth attempts. ssh2 tries each until one succeeds, so
    // we can fall back gracefully (e.g. agent -> default ~/.ssh keys) the way OpenSSH
    // does, instead of dead-ending when the agent isn't running or has no keys.
    const attempts = [];
    const tried = []; // human-readable labels for the connect diagnostic
    try {
      if (opts.authMethod === 'agent') {
        const addr = agentAddress();
        if (addr) {
          attempts.push({ type: 'agent', agent: addr });
          tried.push('agent');
        }
        // Also offer on-disk default keys so a stopped/empty agent isn't a dead end.
        for (const kp of SSHManager.discoverKeys()) {
          let buf;
          try {
            buf = fs.readFileSync(kp);
          } catch (_) {
            continue;
          }
          const parsed = sshUtils.parseKey(buf, opts.passphrase || undefined);
          if (parsed && !(parsed instanceof Error)) {
            attempts.push({ type: 'publickey', key: buf, ...(opts.passphrase ? { passphrase: opts.passphrase } : {}) });
            tried.push(path.basename(kp));
          } else {
            tried.push(path.basename(kp) + ' (skipped: needs passphrase)');
          }
        }
      } else if (opts.authMethod === 'key') {
        if (!opts.keyPath) throw new Error('No key file specified.');
        const buf = fs.readFileSync(opts.keyPath);
        const parsed = sshUtils.parseKey(buf, opts.passphrase || undefined);
        if (parsed instanceof Error) throw parsed;
        attempts.push({ type: 'publickey', key: buf, ...(opts.passphrase ? { passphrase: opts.passphrase } : {}) });
        tried.push(path.basename(opts.keyPath));
      } else if (opts.authMethod === 'password') {
        attempts.push({ type: 'password', password: opts.password || '' });
        attempts.push('keyboard-interactive'); // string form auto-wires the prompt event
        tried.push('password');
      } else {
        throw new Error(`Unknown auth method: ${opts.authMethod}`);
      }
    } catch (err) {
      callbacks.onError(`Auth setup failed: ${err.message}`);
      this.sessions.delete(tabId);
      return;
    }

    if (!attempts.length) {
      callbacks.onError(
        opts.authMethod === 'agent'
          ? 'No SSH agent is running and no usable keys were found in ~/.ssh. Start the OpenSSH ' +
              'Authentication Agent (and `ssh-add` a key), or use key-file auth in the New Connection dialog.'
          : 'No authentication method available.'
      );
      this.sessions.delete(tabId);
      return;
    }
    // ssh2 accepts an array authHandler and walks it in order until one succeeds.
    // String items (e.g. 'keyboard-interactive') pass through so ssh2 auto-wires them.
    connectConfig.authHandler = attempts.map((a) =>
      typeof a === 'string' ? a : { username: opts.username, ...a }
    );
    if (opts.authMethod === 'password') connectConfig.tryKeyboard = true;

    client.on('ready', () => {
      callbacks.onStatus(`Connected to ${opts.username}@${opts.host}:${opts.port || 22}`);
      client.shell(
        {
          term: 'xterm-256color',
          cols: opts.cols || 80,
          rows: opts.rows || 24,
        },
        (err, stream) => {
          if (err) {
            callbacks.onError(`Failed to open shell: ${err.message}`);
            this.disconnect(tabId);
            return;
          }
          const sess = this.sessions.get(tabId);
          if (sess) sess.stream = stream;

          stream.on('data', (chunk) => callbacks.onData(chunk.toString('binary')));
          stream.stderr.on('data', (chunk) => callbacks.onData(chunk.toString('binary')));
          stream.on('close', () => {
            callbacks.onStatus('Shell closed.');
            this.disconnect(tabId);
          });
        }
      );
    });

    client.on('banner', (message) => callbacks.onData(message.replace(/\n/g, '\r\n')));

    client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      // Fallback for servers requiring keyboard-interactive password auth.
      if (opts.authMethod === 'password') {
        finish(prompts.map(() => opts.password || ''));
      } else {
        finish([]);
      }
    });

    client.on('error', (err) => {
      // A failing SSH agent is NOT fatal: ssh2 emits this and then falls through to the
      // next configured method (our on-disk keys). Note it and keep going, otherwise the
      // "Connection failed" banner shows even though the key auth is about to succeed.
      if (err && err.level === 'agent') {
        callbacks.onData('\x1b[2m[cockpit] SSH agent unavailable - trying key files...\x1b[0m\r\n');
        return;
      }
      callbacks.onError(err.message || String(err));
    });

    client.on('close', () => {
      callbacks.onClose({});
      this.sessions.delete(tabId);
    });

    callbacks.onStatus(`Connecting to ${opts.host}:${opts.port || 22} ...`);
    try {
      client.connect(connectConfig);
    } catch (err) {
      callbacks.onError(err.message || String(err));
      this.sessions.delete(tabId);
    }
  }

  write(tabId, data) {
    const sess = this.sessions.get(tabId);
    if (sess && sess.stream) sess.stream.write(data);
  }

  resize(tabId, cols, rows) {
    const sess = this.sessions.get(tabId);
    if (sess && sess.stream) {
      try {
        sess.stream.setWindow(rows, cols, 0, 0);
      } catch (_) {
        /* stream may be closing */
      }
    }
  }

  // --- SFTP (reuses the tab's existing SSH connection) ---
  _getSftp(tabId) {
    return new Promise((resolve, reject) => {
      const sess = this.sessions.get(tabId);
      if (!sess || !sess.client) return reject(new Error('Not connected'));
      if (sess.sftp) return resolve(sess.sftp);
      sess.client.sftp((err, sftp) => {
        if (err) return reject(err);
        sess.sftp = sftp;
        resolve(sftp);
      });
    });
  }

  async sftpList(tabId, dir) {
    const sftp = await this._getSftp(tabId);
    const real = await new Promise((res, rej) =>
      sftp.realpath(dir || '.', (e, p) => (e ? rej(e) : res(p)))
    );
    const list = await new Promise((res, rej) =>
      sftp.readdir(real, (e, l) => (e ? rej(e) : res(l)))
    );
    const entries = list.map((it) => ({
      name: it.filename,
      isDir: it.attrs.isDirectory(),
      isLink: typeof it.attrs.isSymbolicLink === 'function' ? it.attrs.isSymbolicLink() : false,
      size: it.attrs.size,
      mtime: it.attrs.mtime,
    }));
    return { path: real, entries };
  }

  async sftpDownload(tabId, remotePath, localPath) {
    const sftp = await this._getSftp(tabId);
    await new Promise((res, rej) => sftp.fastGet(remotePath, localPath, (e) => (e ? rej(e) : res())));
    return true;
  }

  async sftpUpload(tabId, localPath, remotePath) {
    const sftp = await this._getSftp(tabId);
    await new Promise((res, rej) => sftp.fastPut(localPath, remotePath, (e) => (e ? rej(e) : res())));
    return true;
  }

  async sftpDelete(tabId, p, isDir) {
    const sftp = await this._getSftp(tabId);
    await new Promise((res, rej) => {
      const cb = (e) => (e ? rej(e) : res());
      if (isDir) sftp.rmdir(p, cb);
      else sftp.unlink(p, cb);
    });
    return true;
  }

  // ---- Port forwarding (SSH tunnels) over the tab's existing connection ----
  // A tunnel is one of:
  //   L (local)   - listen on YOUR machine; connections are forwarded through the SSH
  //                 host to destHost:destPort (e.g. reach an internal DB from your laptop).
  //   R (remote)  - listen on the SSH HOST; connections there come back through the tunnel
  //                 to destHost:destPort on your side (e.g. expose your local dev server).
  //   D (dynamic) - a SOCKS5 proxy on YOUR machine; any app pointed at it tunnels out
  //                 through the SSH host to wherever it asks.

  _pubTunnel(t) {
    return {
      id: t.id,
      tabId: t.tabId,
      type: t.type,
      listenHost: t.listenHost,
      listenPort: t.listenPort,
      destHost: t.destHost,
      destPort: t.destPort,
      status: t.status,
      error: t.error || '',
      conns: t.conns,
      up: t.up,
      down: t.down,
    };
  }
  _emitTunnel(t) {
    if (this.onTunnelUpdate) {
      try {
        this.onTunnelUpdate(this._pubTunnel(t));
      } catch (_) {
        /* renderer gone */
      }
    }
  }
  _startStatTimer() {
    if (this._statTimer) return;
    this._statTimer = setInterval(() => {
      let any = false;
      for (const t of this.tunnels.values()) {
        if (t.status === 'up') {
          any = true;
          if (t._dirty) {
            t._dirty = false;
            this._emitTunnel(t);
          }
        }
      }
      if (!any) {
        clearInterval(this._statTimer);
        this._statTimer = null;
      }
    }, 1000);
  }
  // Wire the byte counters + connection lifecycle for one forwarded pair (a<->b duplex).
  _wirePair(t, a, b) {
    t.conns++;
    t._dirty = true;
    this._emitTunnel(t);
    a.on('data', (d) => {
      t.up += d.length;
      t._dirty = true;
    });
    b.on('data', (d) => {
      t.down += d.length;
      t._dirty = true;
    });
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      t.conns = Math.max(0, t.conns - 1);
      t._dirty = true;
      this._emitTunnel(t);
      try {
        a.destroy();
      } catch (_) {
        /* ignore */
      }
      try {
        b.destroy();
      } catch (_) {
        /* ignore */
      }
    };
    a.on('error', () => {});
    b.on('error', () => {});
    a.on('close', done);
    b.on('close', done);
    a.pipe(b);
    b.pipe(a);
  }

  listTunnels(tabId) {
    const out = [];
    for (const t of this.tunnels.values()) if (!tabId || t.tabId === tabId) out.push(this._pubTunnel(t));
    return out;
  }

  startTunnel(spec) {
    const sess = this.sessions.get(spec.tabId);
    const t = {
      id: spec.id || nextTunnelId(),
      tabId: spec.tabId,
      type: spec.type, // 'L' | 'R' | 'D'
      listenHost: spec.listenHost || '127.0.0.1',
      listenPort: Number(spec.listenPort) || 0,
      destHost: spec.type === 'D' ? '' : spec.destHost || '127.0.0.1',
      destPort: spec.type === 'D' ? 0 : Number(spec.destPort) || 0,
      status: 'starting',
      error: '',
      conns: 0,
      up: 0,
      down: 0,
      server: null,
      _dirty: false,
    };
    this.tunnels.set(t.id, t);
    if (!sess || !sess.client) {
      t.status = 'error';
      t.error = 'SSH session is not connected';
      this._emitTunnel(t);
      return this._pubTunnel(t);
    }
    try {
      if (t.type === 'L') this._startLocal(sess, t);
      else if (t.type === 'R') this._startRemote(sess, t);
      else if (t.type === 'D') this._startDynamic(sess, t);
      else {
        t.status = 'error';
        t.error = 'Unknown tunnel type';
      }
    } catch (err) {
      t.status = 'error';
      t.error = err.message || String(err);
    }
    this._startStatTimer();
    this._emitTunnel(t);
    return this._pubTunnel(t);
  }

  _startLocal(sess, t) {
    const server = net.createServer((sock) => {
      const s = this.sessions.get(t.tabId);
      if (!s || !s.client) return sock.destroy();
      s.client.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, t.destHost, t.destPort, (err, stream) => {
        if (err) return sock.destroy();
        this._wirePair(t, sock, stream);
      });
    });
    server.on('error', (e) => {
      t.status = 'error';
      t.error = e.code === 'EADDRINUSE' ? `Local port ${t.listenPort} is already in use` : e.message;
      this._emitTunnel(t);
    });
    server.listen(t.listenPort, t.listenHost, () => {
      t.status = 'up';
      t.error = '';
      this._emitTunnel(t);
    });
    t.server = server;
  }

  _startRemote(sess, t) {
    this._ensureTcpRouter(sess);
    sess.client.forwardIn(t.listenHost, t.listenPort, (err, port) => {
      if (err) {
        t.status = 'error';
        t.error = err.message || 'Remote bind failed (is GatewayPorts/AllowTcpForwarding enabled?)';
        return this._emitTunnel(t);
      }
      const realPort = t.listenPort || port;
      t.listenPort = realPort;
      sess._rfwd = sess._rfwd || new Map();
      sess._rfwd.set(String(realPort), t);
      t.status = 'up';
      t.error = '';
      this._emitTunnel(t);
    });
  }

  // One 'tcp connection' handler per client routes inbound remote-forward channels to the
  // matching tunnel by the remote bound port.
  _ensureTcpRouter(sess) {
    if (sess._tcpRouter) return;
    sess._tcpRouter = true;
    sess.client.on('tcp connection', (info, accept, reject) => {
      const t = sess._rfwd && sess._rfwd.get(String(info.destPort));
      if (!t) return reject();
      const stream = accept();
      const target = net.connect(t.destPort, t.destHost);
      target.on('connect', () => this._wirePair(t, stream, target));
      target.on('error', () => {
        try {
          stream.end();
        } catch (_) {
          /* ignore */
        }
      });
    });
  }

  _startDynamic(sess, t) {
    const server = net.createServer((sock) => this._socks5(sock, t));
    server.on('error', (e) => {
      t.status = 'error';
      t.error = e.code === 'EADDRINUSE' ? `Local port ${t.listenPort} is already in use` : e.message;
      this._emitTunnel(t);
    });
    server.listen(t.listenPort, t.listenHost, () => {
      t.status = 'up';
      t.error = '';
      this._emitTunnel(t);
    });
    t.server = server;
  }

  // Minimal SOCKS5 (no-auth, CONNECT only) that dials out through the SSH client.
  _socks5(sock, t) {
    let stage = 0;
    let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    const reply = (code) => {
      try {
        sock.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      } catch (_) {
        /* ignore */
      }
    };
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        const nmethods = buf[1];
        if (buf.length < 2 + nmethods) return;
        buf = buf.slice(2 + nmethods);
        sock.write(Buffer.from([0x05, 0x00])); // no authentication
        stage = 1;
      }
      if (stage === 1) {
        if (buf.length < 4) return;
        if (buf[0] !== 0x05) return sock.destroy();
        const cmd = buf[1];
        const atyp = buf[3];
        let host;
        let off;
        if (atyp === 0x01) {
          if (buf.length < 10) return;
          host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
          off = 8;
        } else if (atyp === 0x03) {
          const len = buf[4];
          if (buf.length < 5 + len + 2) return;
          host = buf.slice(5, 5 + len).toString('utf8');
          off = 5 + len;
        } else if (atyp === 0x04) {
          if (buf.length < 22) return;
          const parts = [];
          for (let i = 0; i < 8; i++) parts.push(buf.readUInt16BE(4 + i * 2).toString(16));
          host = parts.join(':');
          off = 20;
        } else {
          reply(0x08); // address type not supported
          return sock.destroy();
        }
        const port = buf.readUInt16BE(off);
        buf = buf.slice(off + 2);
        stage = 2;
        sock.removeListener('data', onData);
        sock.pause();
        if (cmd !== 0x01) {
          reply(0x07); // command not supported
          return sock.destroy();
        }
        const s = this.sessions.get(t.tabId);
        if (!s || !s.client) {
          reply(0x01);
          return sock.destroy();
        }
        s.client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
          if (err) {
            reply(0x05); // connection refused
            return sock.destroy();
          }
          reply(0x00); // succeeded
          if (buf.length) stream.write(buf); // any bytes already past the handshake
          // _wirePair attaches data listeners and pipes; the pipe resumes the paused sock,
          // so no bytes are dropped in the gap.
          this._wirePair(t, sock, stream);
        });
      }
    };
    sock.on('data', onData);
  }

  stopTunnel(id) {
    const t = this.tunnels.get(id);
    if (!t) return false;
    try {
      if (t.server) t.server.close();
    } catch (_) {
      /* ignore */
    }
    if (t.type === 'R') {
      const sess = this.sessions.get(t.tabId);
      if (sess && sess.client) {
        try {
          sess.client.unforwardIn(t.listenHost, t.listenPort, () => {});
        } catch (_) {
          /* ignore */
        }
        if (sess._rfwd) sess._rfwd.delete(String(t.listenPort));
      }
    }
    this.tunnels.delete(id);
    t.status = 'stopped';
    this._emitTunnel(t);
    return true;
  }

  _stopTunnelsForTab(tabId) {
    for (const id of Array.from(this.tunnels.keys())) {
      const t = this.tunnels.get(id);
      if (t && t.tabId === tabId) this.stopTunnel(id);
    }
  }

  // ---- Host vitals: poll load/mem/disk over a side exec channel (never the shell) ----
  startVitals(tabId, intervalMs) {
    if (this.vitals.has(tabId)) return; // already polling
    const sess = this.sessions.get(tabId);
    if (!sess || !sess.client) return;
    this._sampleVitals(tabId); // first sample immediately
    const h = setInterval(() => this._sampleVitals(tabId), intervalMs || 5000);
    this.vitals.set(tabId, h);
  }
  stopVitals(tabId) {
    const h = this.vitals.get(tabId);
    if (h) {
      clearInterval(h);
      this.vitals.delete(tabId);
    }
  }
  _parseVitals(out) {
    const line = String(out || '')
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.startsWith('VIT '));
    if (!line) return null;
    // VIT load1 ncpu mem% disk% diskTotalKB diskUsedKB memTotalKB memUsedKB
    const p = line.split(/\s+/);
    const num = (v) => (v == null || v === 'na' || isNaN(parseFloat(v)) ? null : parseFloat(v));
    const clamp = (v) => (v == null ? null : Math.max(0, Math.min(100, Math.round(v))));
    const load1 = num(p[1]);
    const ncpu = parseInt(p[2], 10) || 1;
    const mem = clamp(num(p[3]));
    const disk = clamp(num(p[4]));
    const cpu = load1 == null ? null : clamp((load1 / ncpu) * 100);
    return {
      load1,
      ncpu,
      cpu,
      mem,
      disk,
      diskTotalKB: num(p[5]),
      diskUsedKB: num(p[6]),
      memTotalKB: num(p[7]),
      memUsedKB: num(p[8]),
    };
  }
  _sampleVitals(tabId) {
    const sess = this.sessions.get(tabId);
    if (!sess || !sess.client || sess._vitBusy) return;
    sess._vitBusy = true;
    let out = '';
    try {
      sess.client.exec(VIT_CMD, (err, stream) => {
        if (err) {
          sess._vitBusy = false;
          return;
        }
        const to = setTimeout(() => {
          sess._vitBusy = false;
          try {
            stream.close();
          } catch (_) {
            /* ignore */
          }
        }, 8000);
        stream.on('data', (d) => {
          out += d.toString('utf8');
        });
        if (stream.stderr) stream.stderr.on('data', () => {});
        stream.on('close', () => {
          clearTimeout(to);
          sess._vitBusy = false;
          const v = this._parseVitals(out);
          if (v && this.onVitals) {
            try {
              this.onVitals(tabId, v);
            } catch (_) {
              /* renderer gone */
            }
          }
        });
      });
    } catch (_) {
      sess._vitBusy = false;
    }
  }

  disconnect(tabId) {
    const sess = this.sessions.get(tabId);
    if (!sess) return;
    this.stopVitals(tabId);
    this._stopTunnelsForTab(tabId);
    try {
      if (sess.stream) sess.stream.end();
    } catch (_) {
      /* ignore */
    }
    try {
      sess.client.end();
    } catch (_) {
      /* ignore */
    }
    this.sessions.delete(tabId);
  }

  disconnectAll() {
    for (const tabId of Array.from(this.sessions.keys())) {
      this.disconnect(tabId);
    }
  }
}

module.exports = { SSHManager };
