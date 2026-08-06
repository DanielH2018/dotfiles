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

// A notify-send that records instead of drawing, so the tests can assert on what
// the operator would actually have seen.
//
// Every test here drives the real script, and the real script calls the real
// notify-send — so any fixture carrying a finding drew an actual desktop banner.
// Three of them, on every suite run, which the pre-push gate makes every `git push`:
// the "alerts" that prompted this were the test fixtures all along, landing on the
// desktop as if a machine were down. The stub therefore shadows notify-send for
// EVERY run, not only the tests that assert on notifications.
function notifyStub() {
  const bin = fs.mkdtempSync(path.join(DIR, 'bin-'));
  const log = path.join(bin, 'calls');
  fs.writeFileSync(path.join(bin, 'notify-send'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>${log}\n`);
  fs.chmodSync(path.join(bin, 'notify-send'), 0o755);
  return {
    bin,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
  };
}

// Shadows notify-send for every run that does not bring its own stub.
const SILENT = notifyStub();

function run(payload, extra = {}) {
  try {
    const stdout = execFileSync('bash', [WATCH], {
      encoding: 'utf8',
      env: {
        ...process.env,
        OTEL_SWEEP: stub(payload),
        PATH: `${SILENT.bin}:${process.env.PATH}`,
        // Each run gets its own state dir by default, so the dedup memory neither
        // reaches the real ~/.local/state nor leaks between tests.
        XDG_STATE_HOME: fs.mkdtempSync(path.join(DIR, 'state-')),
        ...extra,
      },
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

const LOKI_DOWN = JSON.stringify({
  box: { backends: { loki: 'unreachable', prometheus: 'ready', tempo: 'ready' }, events_24h: {}, sessions_24h: 0, silent_sessions: [] },
});

test('an unchanged finding set notifies once, not on every run', { skip }, () => {
  const spy = notifyStub();
  const env = { XDG_STATE_HOME: fs.mkdtempSync(path.join(DIR, 'dedup-')), PATH: `${spy.bin}:${process.env.PATH}` };

  assert.strictEqual(run(LOKI_DOWN, env).code, 1);
  assert.strictEqual(spy.calls().length, 1, 'the first finding must reach the desktop');

  assert.strictEqual(run(LOKI_DOWN, env).code, 1, 'still a finding, so still exit 1');
  assert.strictEqual(spy.calls().length, 1, 'repeating the same findings must not raise a second banner');
});

test('something still broken resurfaces once the window lapses', { skip }, () => {
  const spy = notifyStub();
  const env = {
    XDG_STATE_HOME: fs.mkdtempSync(path.join(DIR, 'window-')),
    PATH: `${spy.bin}:${process.env.PATH}`,
    OTEL_SWEEP_WATCH_REPEAT_AFTER: '0',
  };
  run(LOKI_DOWN, env);
  run(LOKI_DOWN, env);
  assert.strictEqual(spy.calls().length, 2, 'dedup must not silence a persisting problem for good');
});

test('a different finding still notifies inside the window', { skip }, () => {
  const spy = notifyStub();
  const env = { XDG_STATE_HOME: fs.mkdtempSync(path.join(DIR, 'changed-')), PATH: `${spy.bin}:${process.env.PATH}` };
  run(LOKI_DOWN, env);
  run(JSON.stringify({ server: { error: 'ssh: connect to host daniel-server port 22: No route to host' } }), env);
  assert.strictEqual(spy.calls().length, 2, 'a new problem must not be masked by an unrelated older one');
});

test('a finding raised by any test is intercepted, never drawn', { skip }, () => {
  // The guard for the bug this file itself caused. Several fixtures above carry
  // findings, and until the stub shadowed notify-send on every run they drew real
  // banners — on every `git push`, since the pre-push gate runs the suite. They were
  // indistinguishable from a machine actually being down, and were chased as such.
  const before = SILENT.calls().length;
  assert.strictEqual(run(LOKI_DOWN).code, 1);
  assert.strictEqual(SILENT.calls().length, before + 1, 'the banner must land in the stub, not on the desktop');
});
