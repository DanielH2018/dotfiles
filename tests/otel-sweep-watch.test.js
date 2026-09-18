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
const { scratch } = require('./lib/tmp');

const WATCH = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_otel-sweep-watch');

let skip = false;
try {
  execFileSync('python3', ['--version'], { stdio: 'ignore' });
} catch {
  skip = 'python3 unavailable';
}

const DIR = scratch(os.tmpdir(), 'otel-sweep-watch-');
// Every other scratch here is made inside DIR, so removing it covers them all.

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
  const bin = scratch(DIR, 'bin-');
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
        XDG_STATE_HOME: scratch(DIR, 'state-'),
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

test('the silent count is the whole truth, not the number of lines shown', { skip }, () => {
  // The payload was sliced to ten before 2026-08-31, and this count is a len()
  // over it — so a night with 24 silent sessions alerted as `silent=10` and read
  // as complete. The count must survive the cap on the finding lines.
  const sessions = Array.from({ length: 24 }, (_, i) => ({
    session: `deadbeef-${String(i).padStart(4, '0')}-4000-8000-000000000000`,
    mb: 24 - i,
    modified: '2026-08-29T20:29:00Z',
  }));
  const payload = JSON.stringify({
    box: {
      backends: { loki: 'ready', prometheus: 'ready', tempo: 'ready' },
      events_24h: { hook_registered: 20 },
      sessions_24h: 7,
      silent_sessions: sessions,
    },
  });
  const { code, stdout } = run(payload);
  assert.strictEqual(code, 1);
  assert.match(stdout, /box: events=20 sessions=7 silent=24/);
  assert.match(stdout, /and 19 more sessions exporting nowhere/);
});

test('a burst under the cap gets no truncation notice', { skip }, () => {
  // The rejecting half of the pair above. A notice that fires whether or not
  // anything was hidden says nothing, and one that never fires hides everything;
  // only the two together show the cap is being read.
  const sessions = Array.from({ length: 3 }, (_, i) => ({
    session: `deadbeef-${String(i).padStart(4, '0')}-4000-8000-000000000000`,
    mb: 3 - i,
    modified: '2026-08-29T20:29:00Z',
  }));
  const payload = JSON.stringify({
    box: {
      backends: { loki: 'ready', prometheus: 'ready', tempo: 'ready' },
      events_24h: { hook_registered: 20 },
      sessions_24h: 7,
      silent_sessions: sessions,
    },
  });
  const { code, stdout } = run(payload);
  assert.strictEqual(code, 1);
  assert.match(stdout, /box: events=20 sessions=7 silent=3/);
  assert.ok(!/more sessions exporting nowhere/.test(stdout), 'nothing was hidden, so nothing may claim it was');
});

test('a counted error reaches the findings block', { skip }, () => {
  // The sweep collected errors_24h nightly and the watch never read it, so every
  // api_error and internal_error was visible only to someone running --rows by
  // hand. One finding per event NAME with its count, not one per occurrence.
  const payload = JSON.stringify({
    box: {
      backends: { loki: 'ready', prometheus: 'ready', tempo: 'ready' },
      events_24h: { api_request: 900 },
      errors_24h: { api_error: 9, internal_error: 5 },
      sessions_24h: 7,
      silent_sessions: [],
    },
  });
  const { code, stdout } = run(payload);
  assert.strictEqual(code, 1);
  assert.match(stdout, /box: 9 api_error events in 24h/);
  assert.match(stdout, /box: 5 internal_error events in 24h/);
});

test('no counted errors raises nothing', { skip }, () => {
  // The rejecting half. A block that reported on an empty dict would fire every
  // night and get the check muted, which is the failure this watch exists to avoid.
  const payload = JSON.stringify({
    box: {
      backends: { loki: 'ready', prometheus: 'ready', tempo: 'ready' },
      events_24h: { api_request: 900 },
      errors_24h: {},
      sessions_24h: 7,
      silent_sessions: [],
    },
  });
  const { code, stdout } = run(payload);
  assert.strictEqual(code, 0);
  assert.ok(!stdout.includes('FINDINGS'), 'an empty error map is not a finding');
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
  const env = { XDG_STATE_HOME: scratch(DIR, 'dedup-'), PATH: `${spy.bin}:${process.env.PATH}` };

  assert.strictEqual(run(LOKI_DOWN, env).code, 1);
  assert.strictEqual(spy.calls().length, 1, 'the first finding must reach the desktop');

  assert.strictEqual(run(LOKI_DOWN, env).code, 1, 'still a finding, so still exit 1');
  assert.strictEqual(spy.calls().length, 1, 'repeating the same findings must not raise a second banner');
});

test('something still broken resurfaces once the window lapses', { skip }, () => {
  const spy = notifyStub();
  const env = {
    XDG_STATE_HOME: scratch(DIR, 'window-'),
    PATH: `${spy.bin}:${process.env.PATH}`,
    OTEL_SWEEP_WATCH_REPEAT_AFTER: '0',
  };
  run(LOKI_DOWN, env);
  run(LOKI_DOWN, env);
  assert.strictEqual(spy.calls().length, 2, 'dedup must not silence a persisting problem for good');
});

test('a different finding still notifies inside the window', { skip }, () => {
  const spy = notifyStub();
  const env = { XDG_STATE_HOME: scratch(DIR, 'changed-'), PATH: `${spy.bin}:${process.env.PATH}` };
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

// --- store grouping -------------------------------------------------------
//
// Every tally the sweep collects belongs to the store, not to the machine that
// asked. Two cluster nodes read one Loki, so before this the watch reported the
// same 9 api_errors as "local: 9" and "server: 9" and the block read as 18.

const CLUSTER_PAIR = {
  local: {
    store: 'cluster',
    backends: { loki: 'ready', prometheus: 'ready', tempo: 'ready' },
    events_24h: { api_request: 900 },
    errors_24h: { api_error: 9 },
    sessions_24h: 7,
    silent_sessions: [],
  },
  server: {
    store: 'cluster',
    backends: { loki: 'ready', prometheus: 'ready', tempo: 'ready' },
    events_24h: { api_request: 900 },
    errors_24h: { api_error: 9 },
    sessions_24h: 7,
    silent_sessions: [],
  },
};

test('two machines on one store report its errors once, not once each', { skip }, () => {
  const { code, stdout } = run(JSON.stringify(CLUSTER_PAIR));
  assert.strictEqual(code, 1);
  const hits = stdout.match(/9 api_error events in 24h/g) || [];
  assert.strictEqual(hits.length, 1, 'one store, one count — a second copy invents an incident');
  assert.match(stdout, /cluster store \(local, server\): 9 api_error events in 24h/);
  assert.match(stdout, /cluster store \(local, server\): events=900 sessions=7/);
});

test('two machines on DIFFERENT stores each report their own', { skip }, () => {
  // The rejecting half. Collapsing by position rather than by store identity
  // would pass the test above and hide a whole machine's errors here.
  const payload = JSON.stringify({
    local: { ...CLUSTER_PAIR.local, store: 'local' },
    server: { ...CLUSTER_PAIR.server, store: 'cluster' },
  });
  const { code, stdout } = run(payload);
  assert.strictEqual(code, 1);
  const hits = stdout.match(/9 api_error events in 24h/g) || [];
  assert.strictEqual(hits.length, 2, 'two stores are two incidents');
});

test('a sweep that names no store groups each machine alone', { skip }, () => {
  // Backward compatibility, and the safe default: an older otel-sweep says
  // nothing about stores, and guessing they are shared would merge two.
  const payload = JSON.stringify({
    local: { ...CLUSTER_PAIR.local, store: undefined },
    server: { ...CLUSTER_PAIR.server, store: undefined },
  });
  const { code, stdout } = run(payload);
  assert.strictEqual(code, 1);
  assert.match(stdout, /local: 9 api_error events in 24h/);
  assert.match(stdout, /server: 9 api_error events in 24h/);
});

test('silent sessions stay per-machine even when the store is shared', { skip }, () => {
  // A silent session is read from THIS machine's transcripts, so it is the one
  // finding the grouping must not absorb.
  const payload = JSON.stringify({
    local: { ...CLUSTER_PAIR.local, errors_24h: {}, silent_sessions: [] },
    server: {
      ...CLUSTER_PAIR.server,
      errors_24h: {},
      silent_sessions: [{ session: 'dbb7b1bf-6de4-4e60-a04d-d9bbcf729bf3', mb: 4.2, modified: '2026-09-02T10:00:00Z' }],
    },
  });
  const { code, stdout } = run(payload);
  assert.strictEqual(code, 1);
  assert.match(stdout, /server: session dbb7b1bf exporting nowhere/);
  assert.ok(!/local: session/.test(stdout), 'the quiet machine must not inherit its neighbour finding');
  assert.match(stdout, /  local: silent=0/);
  assert.match(stdout, /  server: silent=1/);
});

// --- error classification -------------------------------------------------
//
// api_error covers both a rate-limit rejection, which is what a busy day looks
// like, and a dead OAuth token on a nightly timer, which is an outage nobody
// would otherwise see. Counting them together makes the verdict red on ordinary
// use, and a detector that is red every day is one nobody reads.

const RATE_LIMIT = "This request would exceed your account's rate limit. Please try again later.";
const DEAD_TOKEN = 'OAuth refresh token is no longer valid; run /login to re-authenticate';

test('rate-limit rejections alone are not a finding', { skip }, () => {
  const payload = JSON.stringify({
    box: {
      store: 'cluster',
      backends: { loki: 'ready', prometheus: 'ready', tempo: 'ready' },
      events_24h: { api_request: 900 },
      errors_24h: { api_error: 11 },
      error_messages_24h: { [RATE_LIMIT]: 11 },
      sessions_24h: 7,
      silent_sessions: [],
    },
  });
  const { code, stdout } = run(payload);
  assert.strictEqual(code, 0, 'ordinary volume must not raise a daily banner');
  assert.ok(!stdout.includes('FINDINGS'));
  // Not a finding is not the same as not recorded: a rate-limit count that
  // tripled is worth finding afterwards.
  assert.match(stdout, /11 rate-limited request\(s\) in 24h, not a fault/);
});

test('an auth failure IS a finding, in the same event name', { skip }, () => {
  // The rejecting half. A rule that muted api_error wholesale would pass the
  // test above and hide the exact failure that prompted this — a timer that had
  // been dying on a dead token since 2026-08-20.
  const payload = JSON.stringify({
    box: {
      store: 'cluster',
      backends: { loki: 'ready', prometheus: 'ready', tempo: 'ready' },
      events_24h: { api_request: 900 },
      errors_24h: { api_error: 13 },
      error_messages_24h: { [RATE_LIMIT]: 11, [DEAD_TOKEN]: 2 },
      sessions_24h: 7,
      silent_sessions: [],
    },
  });
  const { code, stdout } = run(payload);
  assert.strictEqual(code, 1);
  assert.match(stdout, /box: 2 x OAuth refresh token is no longer valid/);
  assert.ok(!/x This request would exceed/.test(stdout), 'the benign half must stay out of the verdict');
  assert.match(stdout, /11 rate-limited request\(s\)/, 'and stay in the beat');
});

test('without a message breakdown every error is still a finding', { skip }, () => {
  // A sweep too old to report messages permits no class judgement, so the check
  // must fall back to counting rather than to trusting.
  const payload = JSON.stringify({
    box: {
      store: 'cluster',
      backends: { loki: 'ready', prometheus: 'ready', tempo: 'ready' },
      events_24h: { api_request: 900 },
      errors_24h: { api_error: 11 },
      sessions_24h: 7,
      silent_sessions: [],
    },
  });
  const { code, stdout } = run(payload);
  assert.strictEqual(code, 1, 'unknown must not read as benign');
  assert.match(stdout, /box: 11 api_error events in 24h/);
});
