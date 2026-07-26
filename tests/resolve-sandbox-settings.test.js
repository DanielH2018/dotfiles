const { test, after } = require('node:test');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', 'home', 'private_dot_claude', 'sandbox', 'executable_resolve-sandbox-settings.sh');
const MERGE_SRC = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_claude-settings-merge');

// The sandbox settings resolver is Unix-only (the sandbox doesn't run on Windows) and this
// test relies on POSIX ':'-joined PATHs and /usr/bin,/bin. Skip cleanly on Windows.
const skip = process.platform === 'win32' ? 'sandbox resolver is Unix-only' : false;

const cleanups = [];
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); cleanups.push(d); return d; }
function run(args, { home, pathDirs } = {}) {
  const env = { ...process.env };
  if (home) env.HOME = home;
  if (pathDirs) env.PATH = pathDirs.join(':');
  const r = spawnSync('bash', [HELPER, ...args], { env, encoding: 'utf8' });
  return { stdout: (r.stdout || '').trim(), stderr: r.stderr || '', status: r.status };
}

const d = tmp('rss-');
const base = path.join(d, 'base.json');
fs.writeFileSync(base, JSON.stringify({ permissions: { deny: ['mcp__base__only'] } }));
const overlay = path.join(d, 'overlay.json');
fs.writeFileSync(overlay, JSON.stringify({ permissions: { deny: ['mcp__work__only'] } }));

const okBin = tmp('okbin-');
fs.writeFileSync(path.join(okBin, 'claude-settings-merge'),
  `#!/bin/sh\nexec node ${JSON.stringify(MERGE_SRC)} "$@"\n`, { mode: 0o755 });

// --- host-safe fold (step 1) ---
// A richer base with its own allow, deny, and hooks; and a host with the safe
// keys plus keys that must NOT propagate (permissions.allow, hooks).
const hbase = path.join(d, 'hbase.json');
fs.writeFileSync(hbase, JSON.stringify({
  permissions: { allow: ['Bash(sandbox_only)'], deny: ['Bash(base_deny)'] },
  hooks: { PreToolUse: [{ matcher: 'X', hooks: [{ type: 'command', command: 'sandbox-hook' }] }] },
}));
const host = path.join(d, 'host.json');
fs.writeFileSync(host, JSON.stringify({
  outputStyle: 'Fintech Terse',
  model: 'opus[1m]',
  enabledPlugins: { 'superpowers@x': true, 'remember@claude-plugins-official': true },
  permissions: { allow: ['Bash(host_allow_must_not_cross)'], deny: ['Bash(host_deny)'] },
  hooks: { PreToolUse: [{ matcher: 'Y', hooks: [{ type: 'command', command: 'host-hook-must-not-cross' }] }] },
}));

function hbaseHooks() {
  return { PreToolUse: [{ matcher: 'X', hooks: [{ type: 'command', command: 'sandbox-hook' }] }] };
}

test('overlay absent -> base path', { skip }, () => {
  assert.strictEqual(run([base, path.join(d, 'nope.json')]).stdout, base, 'absent overlay -> base');
});

test('overlay present + tool available -> merged temp path with both denies', { skip }, () => {
  const r = run([base, overlay], { pathDirs: [okBin, ...process.env.PATH.split(':')] });
  assert.notStrictEqual(r.stdout, base, 'merged path differs from base');
  assert.ok(fs.existsSync(r.stdout), 'merged file exists');
  const merged = JSON.parse(fs.readFileSync(r.stdout, 'utf8'));
  assert.ok(merged.permissions.deny.includes('mcp__base__only'), 'keeps base deny');
  assert.ok(merged.permissions.deny.includes('mcp__work__only'), 'adds work deny');
  cleanups.push(r.stdout);
});

test('tool missing -> base path + warning', { skip }, () => {
  const emptyHome = tmp('emptyhome-');
  const r = run([base, overlay], { home: emptyHome, pathDirs: ['/usr/bin', '/bin'] });
  assert.strictEqual(r.stdout, base, 'missing tool -> base');
  assert.match(r.stderr, /not found/, 'warns when tool missing');
});

test('tool fails -> base path + warning', { skip }, () => {
  const failBin = tmp('failbin-');
  fs.writeFileSync(path.join(failBin, 'claude-settings-merge'), `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
  const r = run([base, overlay], { pathDirs: [failBin, '/usr/bin', '/bin'] });
  assert.strictEqual(r.stdout, base, 'merge failure -> base');
  assert.match(r.stderr, /merge failed/, 'warns when merge fails');
});

test('host fold, no overlay -> host-safe keys folded into base, allow/hooks untouched', { skip }, () => {
  const r = run([hbase, path.join(d, 'nope.json'), host]);
  assert.notStrictEqual(r.stdout, hbase, 'host fold produces a new file');
  assert.ok(fs.existsSync(r.stdout), 'host-folded file exists');
  const m = JSON.parse(fs.readFileSync(r.stdout, 'utf8'));
  assert.ok(m.permissions.deny.includes('Bash(base_deny)'), 'keeps base deny');
  assert.ok(m.permissions.deny.includes('Bash(host_deny)'), 'unions host deny');
  assert.strictEqual(m.outputStyle, 'Fintech Terse', 'takes host outputStyle');
  assert.strictEqual(m.model, 'opus[1m]', 'takes host model');
  assert.deepStrictEqual(m.enabledPlugins, { 'superpowers@x': true }, 'takes host enabledPlugins but drops remember (its store is unwritable in-container)');
  assert.deepStrictEqual(m.permissions.allow, ['Bash(sandbox_only)'], 'keeps sandbox allow, does NOT import host allow');
  assert.ok(!JSON.stringify(m.permissions.allow).includes('host_allow'), 'host allow never crosses');
  assert.deepStrictEqual(m.hooks, hbaseHooks(), 'keeps sandbox hooks, does NOT import host hooks');
  cleanups.push(r.stdout);
});

test('host fold + overlay -> deny is union(base, host, overlay)', { skip }, () => {
  const r = run([hbase, overlay, host], { pathDirs: [okBin, ...process.env.PATH.split(':')] });
  const m = JSON.parse(fs.readFileSync(r.stdout, 'utf8'));
  for (const dny of ['Bash(base_deny)', 'Bash(host_deny)', 'mcp__work__only']) {
    assert.ok(m.permissions.deny.includes(dny), `union deny includes ${dny}`);
  }
  assert.strictEqual(m.model, 'opus[1m]', 'host model survives overlay merge');
  cleanups.push(r.stdout);
});

test('host arg absent -> unchanged legacy behavior (base path, no fold)', { skip }, () => {
  assert.strictEqual(run([base, path.join(d, 'nope.json')]).stdout, base, 'no host arg -> legacy base');
});

test('broken host json -> falls back, base deny preserved (no partial import)', { skip }, () => {
  const badhost = path.join(d, 'bad.json');
  fs.writeFileSync(badhost, '{ not json');
  const r = run([hbase, path.join(d, 'nope.json'), badhost]);
  // fold fails -> CUR stays hbase (the raw base path)
  assert.strictEqual(r.stdout, hbase, 'broken host json -> base path');
  assert.match(r.stderr, /host-safe fold failed/, 'warns on broken host json');
});

test('the step-1 host-fold temp is deleted once the overlay merge supersedes it', { skip }, () => {
  // Both steps mktemp into TMPDIR, and only the final path is returned. The
  // intermediate used to be abandoned, leaking one file per sandbox launch.
  const tmpdir = tmp('rss-leak-');
  const r = spawnSync('bash', [HELPER, hbase, overlay, host], {
    env: { ...process.env, TMPDIR: tmpdir, PATH: [okBin, ...process.env.PATH.split(':')].join(':') },
    encoding: 'utf8',
  });
  const out = (r.stdout || '').trim();
  const left = fs.readdirSync(tmpdir);
  assert.deepStrictEqual(left, [path.basename(out)],
    `only the returned settings file may remain in TMPDIR, found: ${left.join(', ')}`);
  assert.match(out, /sandbox-settings-/, 'the returned path is the step-2 merge output');
});

test('a fallback that returns the real base file never deletes it', { skip }, () => {
  // $CUR === $BASE whenever the fold is skipped or fails, and $BASE is the
  // caller's tracked settings.base.json — an unguarded rm there is destructive.
  const tmpdir = tmp('rss-keep-');
  const r = spawnSync('bash', [HELPER, base, overlay], {
    env: { ...process.env, TMPDIR: tmpdir, PATH: [okBin, ...process.env.PATH.split(':')].join(':') },
    encoding: 'utf8',
  });
  assert.ok(fs.existsSync(base), 'the base settings file must still exist after a no-host run');
  cleanups.push((r.stdout || '').trim());
});

after(() => {
  for (const c of cleanups) fs.rmSync(c, { recursive: true, force: true });
});
