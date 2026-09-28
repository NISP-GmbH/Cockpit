'use strict';

// node-pty's macOS/Linux shells are started through a small helper binary, `spawn-helper`.
// The node-pty 1.1.0 package on npm ships it WITHOUT the executable bit (the tarball says
// -rw-r--r--), so on a Mac every local terminal dies at once with
//   "posix_spawnp failed."
// Make it executable again. Called before every local shell starts (so a `git pull` on an
// existing install is enough) and from `npm install` (postinstall). Harmless when there is
// nothing to fix; never throws.

const fs = require('fs');
const path = require('path');

function helperCandidates() {
  let root;
  try {
    root = path.dirname(require.resolve('node-pty/package.json'));
  } catch (_) {
    return [];
  }
  // A packaged app keeps executables outside the asar archive; that copy is the one that runs.
  const roots = [root];
  if (root.includes('app.asar' + path.sep)) roots.unshift(root.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep));
  const out = [];
  for (const r of roots) {
    out.push(path.join(r, 'prebuilds', process.platform + '-' + process.arch, 'spawn-helper'));
    out.push(path.join(r, 'build', 'Release', 'spawn-helper')); // built from source instead
  }
  return out;
}

// Returns { fixed: [paths], failed: [{ path, error }] }.
function ensurePtyHelperExecutable() {
  const res = { fixed: [], failed: [] };
  if (process.platform === 'win32') return res; // Windows uses ConPTY, no helper
  for (const p of helperCandidates()) {
    let st;
    try {
      st = fs.statSync(p);
    } catch (_) {
      continue; // not there on this platform/arch
    }
    if ((st.mode & 0o111) === 0o111) continue;
    try {
      fs.chmodSync(p, st.mode | 0o755);
      res.fixed.push(p);
    } catch (err) {
      res.failed.push({ path: p, error: err.message || String(err) });
    }
  }
  return res;
}

// What to tell a user whose shell still failed to start.
function ptyHelpFor(errorText) {
  if (!/posix_spawnp/i.test(String(errorText || ''))) return '';
  const where = helperCandidates()[0] || 'node_modules/node-pty/prebuilds/*/spawn-helper';
  return 'The terminal helper could not be run. In the Cockpit folder try:  chmod +x "' + where + '"  then press R.';
}

module.exports = { ensurePtyHelperExecutable, ptyHelpFor, helperCandidates };

// `node pty-fix.js` (npm postinstall)
if (require.main === module) {
  const r = ensurePtyHelperExecutable();
  if (r.fixed.length) console.log('[cockpit] made node-pty spawn-helper executable: ' + r.fixed.join(', '));
  for (const f of r.failed) console.log('[cockpit] could not fix ' + f.path + ': ' + f.error);
}
