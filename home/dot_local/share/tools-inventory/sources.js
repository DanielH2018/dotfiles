'use strict';
// tools-inventory / sources — everything that has to touch the world: the source-tree scan
// and the three questions only chezmoi can answer (where the source is, what this host
// ignores, what this host is).
//
// `listSources` takes its `readdir`/`isDir` probes as arguments rather than reaching for fs
// directly, so the scan itself stays testable; the rest genuinely spawns chezmoi, and the
// comments below are the record of what that costs inside `chezmoi apply`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = os.homedir();

const BIN_DIRS = [
  { dir: 'dot_local/bin', match: (f) => /^(executable_|symlink_)/.test(f) },
  { dir: 'private_dot_claude/sandbox', match: (f) => /^executable_/.test(f) },
  { dir: 'bin', match: () => true },
  { dir: 'Scripts', match: () => true, recurse: true },
];

function listSources(sourceDir, readdir, isDir) {
  const found = [];
  for (const spec of BIN_DIRS) {
    const walk = (rel) => {
      let entries;
      try {
        entries = readdir(path.join(sourceDir, rel));
      } catch {
        return;
      }
      for (const name of entries) {
        if (name === '__pycache__' || name.startsWith('.')) continue;
        const relPath = `${rel}/${name}`;
        if (isDir(path.join(sourceDir, relPath))) {
          if (spec.recurse) walk(relPath);
          continue;
        }
        if (spec.match(name)) found.push(relPath);
      }
    };
    walk(spec.dir);
  }
  return found.sort();
}

// The fs-backed probes `listSources` needs. Kept here, next to the only other code that
// reads the source tree, so callers do not each rebuild the pair.
function scanSources(sourceDir) {
  return listSources(
    sourceDir,
    (d) => fs.readdirSync(d),
    (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
  );
}

// chezmoi is not necessarily on PATH: `chezmoi apply` runs its scripts with a
// non-interactive environment that need not carry ~/.local/bin, which is where the
// installer puts the binary. A bare spawn therefore failed with ENOENT during the very
// apply this generator exists to run in, and the page silently rendered with no host
// column at all — every gated tool losing its "not deployed here" badge and the tile
// reading 0. Resolve it explicitly instead, and let the caller override.
function chezmoiBin() {
  if (process.env.CHEZMOI_BIN) return process.env.CHEZMOI_BIN;
  for (const c of [path.join(HOME, '.local', 'bin', 'chezmoi'), '/usr/bin/chezmoi', '/usr/local/bin/chezmoi']) {
    if (fs.existsSync(c)) return c;
  }
  return 'chezmoi';
}

// Run a chezmoi query from inside `chezmoi apply`.
//
// apply holds an exclusive lock on its persistent state (chezmoistate.boltdb) for the
// whole run, including while it executes its own run_ scripts — so a nested plain call
// cannot work, it can only wait and then fail with "timeout obtaining persistent state
// lock". That is structural, not environmental: the earlier PATH fix was necessary but
// addressed a different failure, and this one survived it.
//
// --persistent-state points chezmoi at a throwaway file instead, which lifts the
// contention entirely. Nothing is lost by doing so: `ignored` and `source-path` are
// queries over the source state and the config, and neither reads the real persistent
// state for its answer (verified: the list is identical, lock held or not).
function chezmoiQuery(args, cwd) {
  const scratch = path.join(os.tmpdir(), `tools-inventory-state-${process.pid}.boltdb`);
  try {
    const r = spawnSync(chezmoiBin(), ['--persistent-state', scratch, ...args], {
      encoding: 'utf8',
      cwd,
    });
    if (r.status === 0 && r.stdout) return r.stdout;
    // Older chezmoi without the flag; outside an apply this still succeeds.
    const plain = spawnSync(chezmoiBin(), args, { encoding: 'utf8', cwd });
    return plain.status === 0 && plain.stdout ? plain.stdout : null;
  } finally {
    try { fs.rmSync(scratch, { force: true }); } catch { /* nothing to clean up */ }
  }
}

function chezmoiIgnored(sourceDir) {
  if (process.env.TOOLS_INVENTORY_IGNORED != null) {
    return new Set(process.env.TOOLS_INVENTORY_IGNORED.split('\n').map((s) => s.trim()).filter(Boolean));
  }
  const out = chezmoiQuery(['ignored'], sourceDir);
  if (!out) return null;
  return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
}

function resolveSourceDir() {
  if (process.env.TOOLS_INVENTORY_SOURCE) return process.env.TOOLS_INVENTORY_SOURCE;
  // Same lock, same treatment. This one used to spawn a bare `chezmoi` and fall back to
  // the default path, which was right by luck rather than by working.
  const out = chezmoiQuery(['source-path']);
  if (out && out.trim()) return out.trim();
  return path.join(HOME, '.local', 'share', 'chezmoi', 'home');
}

function hostLabel() {
  const plat = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  let wsl = false;
  try {
    wsl = /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch { /* not linux */ }
  return `${plat}${wsl ? ' / WSL' : ''} / ${os.hostname()}`;
}

module.exports = {
  BIN_DIRS, listSources, scanSources, chezmoiBin, chezmoiQuery, chezmoiIgnored, resolveSourceDir, hostLabel,
};
