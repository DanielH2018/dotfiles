const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', 'home', 'private_dot_claude', 'sandbox', 'executable_resolve-sandbox-settings.sh');
const MERGE_SRC = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_claude-settings-merge');

const cleanups = [];
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); cleanups.push(d); return d; }
function run(args, { home, pathDirs } = {}) {
  const env = { ...process.env };
  if (home) env.HOME = home;
  if (pathDirs) env.PATH = pathDirs.join(':');
  try {
    const stdout = execFileSync('bash', [HELPER, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { stdout: stdout.trim(), stderr: '', status: 0 };
  } catch (e) {
    return { stdout: (e.stdout || '').trim(), stderr: e.stderr || '', status: e.status };
  }
}

const d = tmp('rss-');
const base = path.join(d, 'base.json');
fs.writeFileSync(base, JSON.stringify({ permissions: { deny: ['mcp__base__only'] } }));
const overlay = path.join(d, 'overlay.json');
fs.writeFileSync(overlay, JSON.stringify({ permissions: { deny: ['mcp__work__only'] } }));

const okBin = tmp('okbin-');
fs.writeFileSync(path.join(okBin, 'claude-settings-merge'),
  `#!/bin/sh\nexec node ${JSON.stringify(MERGE_SRC)} "$@"\n`, { mode: 0o755 });

// 1. overlay absent -> base path
assert.strictEqual(run([base, path.join(d, 'nope.json')]).stdout, base, 'absent overlay -> base');

// 2. overlay present + tool available -> merged temp path with both denies
{
  const r = run([base, overlay], { pathDirs: [okBin, '/usr/bin', '/bin'] });
  assert.notStrictEqual(r.stdout, base, 'merged path differs from base');
  assert.ok(fs.existsSync(r.stdout), 'merged file exists');
  const merged = JSON.parse(fs.readFileSync(r.stdout, 'utf8'));
  assert.ok(merged.permissions.deny.includes('mcp__base__only'), 'keeps base deny');
  assert.ok(merged.permissions.deny.includes('mcp__work__only'), 'adds work deny');
  cleanups.push(r.stdout);
}

// 3. tool missing -> base path + warning
{
  const emptyHome = tmp('emptyhome-');
  const r = run([base, overlay], { home: emptyHome, pathDirs: ['/usr/bin', '/bin'] });
  assert.strictEqual(r.stdout, base, 'missing tool -> base');
  assert.match(r.stderr, /not found/, 'warns when tool missing');
}

// 4. tool fails -> base path + warning
{
  const failBin = tmp('failbin-');
  fs.writeFileSync(path.join(failBin, 'claude-settings-merge'), `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
  const r = run([base, overlay], { pathDirs: [failBin, '/usr/bin', '/bin'] });
  assert.strictEqual(r.stdout, base, 'merge failure -> base');
  assert.match(r.stderr, /merge failed/, 'warns when merge fails');
}

for (const c of cleanups) fs.rmSync(c, { recursive: true, force: true });
console.log('ALL PASS');
