const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_prune-artifacts.sh');

const dirs = [];

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  dirs.push(root);
  const art = path.join(root, 'artifacts');
  const state = path.join(root, 'state');
  fs.mkdirSync(art, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  return { root, art, state };
}

// mtime is the whole policy here, so the fixtures set it explicitly rather than
// relying on when the test happened to run.
function write(file, daysOld) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
  if (daysOld) {
    const t = new Date(Date.now() - daysOld * 86400_000);
    fs.utimesSync(file, t, t);
  }
}

function run({ art, state }, env = {}) {
  const r = spawnSync('bash', [HOOK], {
    input: '{}', encoding: 'utf8',
    env: { ...process.env, CLAUDE_ARTIFACTS_DIR: art, CLAUDE_ARTIFACT_STATE_DIR: state, ...env },
  });
  assert.strictEqual(r.status, 0, `hook exits 0 (stderr: ${r.stderr})`);
  return r;
}

test('deletes artifacts untouched for more than a week, keeps the rest', () => {
  const s = sandbox();
  write(path.join(s.art, 'fresh.html'), 1);
  write(path.join(s.art, 'week-old.html'), 6);
  write(path.join(s.art, 'stale.html'), 9);
  run(s);

  assert.ok(fs.existsSync(path.join(s.art, 'fresh.html')), 'yesterday stays');
  assert.ok(fs.existsSync(path.join(s.art, 'week-old.html')), 'inside the window stays');
  assert.ok(!fs.existsSync(path.join(s.art, 'stale.html')), 'nine days old goes');
});

test('executables are kept however old — they are tools, not reports', () => {
  const s = sandbox();
  const script = path.join(s.art, 'nvidia-install.sh');
  const doc = path.join(s.art, 'notes.sh');
  write(script, 30);
  write(doc, 30);
  fs.chmodSync(script, 0o755);
  fs.chmodSync(doc, 0o644);
  run(s);

  assert.ok(fs.existsSync(script), 'the +x bit is what spares it, not the extension');
  assert.ok(!fs.existsSync(doc), 'a non-executable .sh is still just a stale file');
});

test('an executable inside a subdirectory keeps that directory alive', () => {
  const s = sandbox();
  const script = path.join(s.art, 'mx-ergo', 'setup.sh');
  write(script, 30);
  fs.chmodSync(script, 0o755);
  write(path.join(s.art, 'mx-ergo', 'report.html'), 30);
  run(s);

  assert.ok(fs.existsSync(script), 'spared');
  assert.ok(!fs.existsSync(path.join(s.art, 'mx-ergo', 'report.html')), 'its stale neighbour goes');
  assert.ok(fs.existsSync(path.join(s.art, 'mx-ergo')), 'dir is not empty, so it survives the -empty sweep');
});

test('a refreshed artifact survives regardless of when it was created', () => {
  const s = sandbox();
  // Created long ago, rewritten yesterday as a slice landed — mtime is what counts.
  write(path.join(s.art, 'three-slice-plan.html'), 1);
  run(s);
  assert.ok(fs.existsSync(path.join(s.art, 'three-slice-plan.html')),
    'the refresh loop keeps a live doc alive indefinitely');
});

test('prunes inside subdirectories and removes the emptied dirs', () => {
  const s = sandbox();
  write(path.join(s.art, 'k3s-migration', 'old.html'), 9);
  write(path.join(s.art, 'keep', 'new.html'), 1);
  run(s);

  assert.ok(!fs.existsSync(path.join(s.art, 'k3s-migration')), 'emptied dir is swept too');
  assert.ok(fs.existsSync(path.join(s.art, 'keep', 'new.html')), 'a dir with live files stays');
});

test('drops stale registry entries so the Stop hook cannot chase a deleted artifact', () => {
  const s = sandbox();
  write(path.join(s.state, 'abc123.current'), 9);
  write(path.join(s.state, 'abc123.sha'), 9);
  write(path.join(s.state, 'live.current'), 1);
  run(s);

  assert.ok(!fs.existsSync(path.join(s.state, 'abc123.current')), 'stale entry cleared');
  assert.ok(!fs.existsSync(path.join(s.state, 'abc123.sha')), 'and its baseline');
  assert.ok(fs.existsSync(path.join(s.state, 'live.current')), 'active entry kept');
});

test('retention window is configurable, and 0 disables the sweep', () => {
  const s = sandbox();
  write(path.join(s.art, 'stale.html'), 9);
  run(s, { CLAUDE_ARTIFACT_RETENTION_DAYS: '0' });
  assert.ok(fs.existsSync(path.join(s.art, 'stale.html')), '0 is the escape hatch, nothing deleted');

  run(s, { CLAUDE_ARTIFACT_RETENTION_DAYS: '30' });
  assert.ok(fs.existsSync(path.join(s.art, 'stale.html')), 'nine days is inside a 30-day window');

  run(s, { CLAUDE_ARTIFACT_RETENTION_DAYS: '7' });
  assert.ok(!fs.existsSync(path.join(s.art, 'stale.html')), 'and outside the default one');
});

test('missing artifacts dir is a no-op, not an error', () => {
  const s = sandbox();
  fs.rmSync(s.art, { recursive: true, force: true });
  run(s);
});

test('emits nothing into the session', () => {
  const s = sandbox();
  write(path.join(s.art, 'stale.html'), 9);
  const r = run(s);
  assert.strictEqual((r.stdout || '').trim(), '', 'a sweep should be silent');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
