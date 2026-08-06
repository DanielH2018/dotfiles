// Regression guard for home/dot_local/bin/executable_otel-sweep-watch.
//
// The thing worth pinning is what the runner treats as a finding. It fires a desktop
// notification, so a rule that flags something normal — daniel-server runs no Tempo, and
// never will — gets muted within a week, after which it detects nothing at all. These
// drive the real script against a stubbed otel-sweep on PATH.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WATCH = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_otel-sweep-watch');

let skip = false;
try {
  execFileSync('python3', ['--version'], { stdio: 'ignore' });
} catch {
  skip = 'python3 unavailable';
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-sweep-watch-'));

// A stub standing in for otel-sweep: prints the fixture handed to it, ignores its flags.
function stub(payload) {
  const file = path.join(DIR, `stub-${Math.abs(hash(payload))}`);
  fs.writeFileSync(file, `#!/usr/bin/env bash\ncat <<'JSON'\n${payload}\nJSON\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function run(payload) {
  try {
    const stdout = execFileSync('bash', [WATCH], {
      encoding: 'utf8',
      env: { ...process.env, OTEL_SWEEP: stub(payload), PATH: process.env.PATH },
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || '') };
  }
}

const HEALTHY = JSON.stringify({
  local: { backends: { loki: 'ready', prometheus: 'ready', tempo: 'ready' }, events_24h: { api_request: 12 }, sessions_24h: 3, silent_sessions: [] },
});

test('a healthy sweep is silent and exits 0', { skip }, () => {
  const { code, stdout } = run(HEALTHY);
  assert.strictEqual(code, 0);
  assert.ok(!stdout.includes('FINDINGS'), 'nothing should be reported');
  assert.match(stdout, /local: events=12 sessions=3 silent=0/);
});

test('a missing Tempo is NOT a finding — daniel-server runs none', { skip }, () => {
  const payload = JSON.stringify({
    server: { backends: { loki: 'ready', prometheus: 'ready', tempo: 'unreachable' }, events_24h: {}, sessions_24h: 0, silent_sessions: [] },
  });
  const { code, stdout } = run(payload);
  assert.strictEqual(code, 0, 'a daily false alarm here would get the check muted');
  assert.ok(!stdout.includes('FINDINGS'));
});

test('a silent session is a finding', { skip }, () => {
  const payload = JSON.stringify({
    box: {
      backends: { loki: 'ready', prometheus: 'ready', tempo: 'ready' },
      events_24h: { hook_registered: 20 },
      sessions_24h: 7,
      silent_sessions: [{ session: 'dbb7b1bf-6de4-4e60-a04d-d9bbcf729bf3', mb: 18.1, modified: '2026-08-05T23:43:59Z' }],
    },
  });
  const { code, stdout } = run(payload);
  assert.strictEqual(code, 1);
  assert.match(stdout, /FINDINGS:/);
  assert.match(stdout, /dbb7b1bf exporting nowhere \(18\.1MB\)/);
});

test('Loki unreachable is a finding — nothing is recorded without it', { skip }, () => {
  const payload = JSON.stringify({
    box: { backends: { loki: 'unreachable', prometheus: 'ready', tempo: 'ready' }, events_24h: {}, sessions_24h: 0, silent_sessions: [] },
  });
  const { code, stdout } = run(payload);
  assert.strictEqual(code, 1);
  assert.match(stdout, /Loki unreachable/);
});

test('an unreachable machine is a finding, not a crash', { skip }, () => {
  const payload = JSON.stringify({ server: { error: 'ssh: connect to host daniel-server port 22: No route to host' } });
  const { code, stdout } = run(payload);
  assert.strictEqual(code, 1);
  assert.match(stdout, /server: UNREACHABLE/);
  assert.match(stdout, /unreachable \(ssh: connect/);
});

test('unparseable sweep output exits 2, distinct from a finding', { skip }, () => {
  const { code } = run('not json at all');
  assert.strictEqual(code, 2, 'a broken sweep must not look like a clean run');
});
