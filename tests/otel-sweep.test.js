// Regression guard for home/dot_local/bin/executable_otel-sweep.
// The confinement suite is the point of this file. otel-sweep is meant to carry a
// blanket `Bash(otel-sweep:*)` allow rule, and that rule is only defensible while
// the destinations stay a fixed enum and the remote program stays a constant. This
// tool reaches other machines over ssh, so a --host flag or an interpolated command
// string would turn it into the arbitrary-remote-execution primitive that `Bash(ssh:*)`
// is ask-listed for being.
//
// The assertions below are structural on purpose. A deny-list of bad inputs would
// only be evidence about the cases someone thought of; these assert the absence that
// makes the grant hold.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { srcPath } = require('./lib/paths');
const { scratch } = require('./lib/tmp');

const SWEEP = srcPath('dot_local', 'bin', 'executable_otel-sweep');
const SRC = fs.readFileSync(SWEEP, 'utf8');
// The module docstring argues the confinement in prose, so it names the very
// constructs these checks forbid. Scan the code, not the argument for it.
const CODE = SRC.slice(SRC.indexOf('from __future__'));
// CODE with its comment lines dropped too. A rule about what the probe DOES must
// not fire on a comment explaining what it deliberately does NOT do — two rules
// below name the approach they reject, and naming it is the point.
const STATEMENTS = CODE.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

const python = 'python3';
let skip = false;
try {
  execFileSync(python, ['--version'], { stdio: 'ignore' });
} catch {
  skip = 'python3 unavailable';
}

function run(args) {
  return execFileSync(python, [SWEEP, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('no flag can redirect where it connects or what it writes', () => {
  for (const flag of ['--host', '--url', '--endpoint', '--query', '--output', '--outfile', '--dest']) {
    assert.ok(!SRC.includes(`"${flag}"`), `${flag} must not be an argument`);
    assert.ok(!SRC.includes(`'${flag}'`), `${flag} must not be an argument`);
  }
});

// Stays a source check: proving --only's choices are DERIVED from HOSTS (rather than a
// separately hardcoded list that happens to also reject 'somewhere-else', which is all
// 'an unknown flag is refused' below can show) means reading the wiring. Proving the two
// live entries actually resolve to daniel-box/daniel-server would need `--only box` and
// `--only server` to really ssh out, which is exactly what the live-only sweep test below
// is gated on not doing by default.
test('destinations are a closed enum of literals', () => {
  const block = SRC.slice(SRC.indexOf('HOSTS = {'), SRC.indexOf('}', SRC.indexOf('HOSTS = {')) + 1);
  assert.match(block, /"local": None/);
  assert.match(block, /"box": "daniel-box"/);
  assert.match(block, /"server": "daniel-server"/);
  // --only must validate against that same dict rather than accept free text.
  assert.match(SRC, /choices=sorted\(HOSTS\)/);
});

test('no shell, anywhere', () => {
  assert.ok(!CODE.includes('shell=True'), 'subprocess must never get shell=True');
  assert.ok(!/\bos\.system\b/.test(CODE), 'os.system must not appear');
  assert.ok(!/\bsubprocess\.(getoutput|getstatusoutput)\b/.test(CODE), 'shell-backed helpers must not appear');
  // `re.compile` is fine; a bare `compile(` is not, so require the absence of a
  // receiver rather than the absence of the word.
  assert.ok(!/(?<![.\w])eval\(/.test(CODE), 'eval must not appear');
  assert.ok(!/(?<![.\w])exec\(/.test(CODE), 'exec must not appear');
  assert.ok(!/(?<![.\w])compile\(/.test(CODE), 'a bare compile() must not appear');
});

test('the remote program is a constant and is never built from input', () => {
  // PROBE may only ever be referenced bare — piped to stdin. Any interpolation of
  // it (or into it) would mean caller data could reach the remote interpreter.
  const uses = SRC.match(/PROBE[^\n]*/g) || [];
  assert.ok(uses.length > 0, 'PROBE must exist');
  for (const use of uses) {
    assert.ok(!/PROBE\s*[%+]/.test(use), `PROBE must not be concatenated or %-formatted: ${use}`);
    assert.ok(!/PROBE\.format/.test(use), `PROBE must not be .format()ed: ${use}`);
    assert.ok(!/f["'][^"']*PROBE/.test(use), `PROBE must not appear in an f-string: ${use}`);
  }
  assert.match(SRC, /input=PROBE/, 'PROBE must be delivered on stdin, not as an argument');
});

test('ssh argv is assembled from constants and cannot hang on a prompt', () => {
  assert.match(SRC, /"ssh", \*SSH_OPTS, dest, "python3", "-", mode/);
  assert.ok(SRC.includes('"BatchMode=yes"'), 'BatchMode=yes keeps it from waiting on a password');
  assert.ok(SRC.includes('"ConnectTimeout=5"'), 'a connect timeout is required');
});

test('a burst of sweeps reuses one connection per machine', () => {
  // daniel-box and daniel-server both run UFW's `limit ssh`: the 6th connection
  // from one source inside 30s is rejected, and probe() renders that rejection as
  // an unreachable machine. Multiplexing is the only thing keeping a burst of
  // sweeps under that budget, so assert it the way the confinement checks work —
  // on the option list, not on a live connection.
  assert.ok(SRC.includes('"ControlMaster=auto"'), 'connection reuse must be enabled');
  assert.ok(
    SRC.includes('"ControlPath=~/.ssh/otel-sweep-%C"'),
    "the control socket must be otel-sweep's own, so a probe cannot adopt an interactive session's forwardings",
  );
  assert.match(SRC, /"ControlPersist=\d+"/, 'the master must outlive a single run to help across runs');
});

// Real behaviour, not a source read: imports the module (same technique as "a machine does
// not ssh to itself" below), stubs subprocess.run and time.sleep, and drives probe() through
// both branches. The ssh path crosses a WireGuard tunnel that rekeys and a UFW rate limiter
// that rejects bursts; both recover in seconds, and treating the first refusal as an outage
// is what raises a desktop notification about a healthy machine.
test('a single transient is retried before a machine is called unreachable', { skip }, () => {
  const out = execFileSync(python, ['-c', `
import importlib.util
from importlib.machinery import SourceFileLoader
loader = SourceFileLoader("sweep", ${JSON.stringify(SWEEP)})
spec = importlib.util.spec_from_loader("sweep", loader)
m = importlib.util.module_from_spec(spec)
loader.exec_module(m)

class FakeResult:
    def __init__(self, returncode, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

calls = []
sleeps = []
m.time.sleep = lambda s: sleeps.append(s)

# 1. An ssh destination whose first attempt is refused must be retried once, and the
#    retry's success must be what probe() returns.
def flaky_then_ok(argv, **kw):
    calls.append(argv)
    if len(calls) == 1:
        return FakeResult(255, stderr="ssh: connect refused")
    return FakeResult(0, stdout="{}")
m.subprocess.run = flaky_then_ok
r1 = m.probe("daniel-box", "fast", 5)
print(len(calls), len(sleeps), "error" in r1)

# 2. The local probe (dest=None) must NOT be retried even when it errors -- it has no
#    transient ssh hop to recover from, so a retry would only double the cost of a real
#    local failure.
calls.clear()
sleeps.clear()
def always_fails(argv, **kw):
    calls.append(argv)
    return FakeResult(1, stderr="boom")
m.subprocess.run = always_fails
r2 = m.probe(None, "fast", 5)
print(len(calls), len(sleeps), "error" in r2)
`], { encoding: 'utf8' });
  const [remote, local] = out.trim().split('\n');
  const [remoteCalls, remoteSleeps, remoteHadError] = remote.split(' ');
  assert.strictEqual(remoteCalls, '2', 'a refused ssh connection must be retried exactly once');
  assert.strictEqual(remoteSleeps, '1', 'the retry must pause between attempts');
  assert.strictEqual(remoteHadError, 'False', "the retry's success must be what probe() returns");

  const [localCalls, localSleeps, localHadError] = local.split(' ');
  assert.strictEqual(localCalls, '1', 'the local probe must not be retried');
  assert.strictEqual(localSleeps, '0', 'the local probe must not pay the retry pause');
  assert.strictEqual(localHadError, 'True', 'a real local failure must still be reported as an error');
});

// The deep scan, driven for real. PROBE (the program otel-sweep pipes to each machine) runs
// here with urllib's urlopen replaced by a fake Loki, against a HOME holding fresh
// transcripts. PROBE comes from importing the module, as the retry test above does.
function deepScan(home, lokiReachable) {
  const out = execFileSync(python, ['-c', `
import importlib.util, io, json, sys, urllib.error, urllib.request
from importlib.machinery import SourceFileLoader
loader = SourceFileLoader("sweep", ${JSON.stringify(SWEEP)})
spec = importlib.util.spec_from_loader("sweep", loader)
m = importlib.util.module_from_spec(spec)
loader.exec_module(m)

REACHABLE = ${lokiReachable ? 'True' : 'False'}
def fake_urlopen(url, timeout=None):
    if not REACHABLE:
        raise urllib.error.URLError("connection refused")
    if url.endswith("/ready"):
        return io.BytesIO(b"ready")
    # A reachable Loki that holds no events for any session.
    return io.BytesIO(json.dumps({"status": "success", "data": {"result": []}}).encode())
urllib.request.urlopen = fake_urlopen
sys.argv = ["probe", "deep"]
exec(compile(m.PROBE, "<probe>", "exec"), {"__name__": "probe"})
`], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  return JSON.parse(out.trim().split('\n').pop());
}

// n transcripts, each last written a minute ago according to its own content timestamp.
function homeWithTranscripts(t, n) {
  const home = scratch(os.tmpdir(), 'otel-sweep-home-', t);
  const dir = path.join(home, '.claude', 'projects', 'proj');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(Date.now() - 60000).toISOString();
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = `session-${String(i).padStart(2, '0')}`;
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), `{"timestamp":"${stamp}"}\n`);
    ids.push(id);
  }
  return { home, ids };
}

test('silent-session detection is skipped when Loki is unreachable', { skip }, (t) => {
  // The set of known sessions comes from Loki, so an unreachable Loki returns
  // nothing and every recently-written transcript reads as exporting nowhere —
  // one outage manufacturing a finding per session on top of its own.
  const { home, ids } = homeWithTranscripts(t, 3);
  // Control: against a reachable Loki that knows none of them, the same transcripts DO read
  // as silent, so the empty list below is the guard at work and not an empty scan.
  const up = deepScan(home, true);
  assert.deepStrictEqual(up.silent_sessions.map((s) => s.session).sort(), ids);

  const down = deepScan(home, false);
  assert.strictEqual(down.backends.loki, 'unreachable');
  assert.deepStrictEqual(down.silent_sessions, [], 'an unreachable Loki must not condemn every transcript');
  assert.strictEqual(down.silent_checked, false, 'the payload must say the check did not run');
});

test('the silent-session payload is uncapped', { skip }, (t) => {
  // A `[:10]` slice lived here until 2026-08-31. otel-sweep-watch derives its
  // `silent=N` alert from len() of this list, so the slice under-counted the
  // alert as well as the listing — 24 silent sessions reported as 10, with
  // nothing in either output saying anything had been dropped.
  const { home, ids } = homeWithTranscripts(t, 12);
  const result = deepScan(home, true);
  assert.strictEqual(result.silent_checked, true);
  assert.deepStrictEqual(result.silent_sessions.map((s) => s.session).sort(), ids,
    'the payload must carry every silent session, uncapped');
});

test('hermetic agent-eval transcripts are counted apart, not reported silent', { skip }, (t) => {
  // An eval fan-out on 2026-10-03 left 203 `claude -p --agent` transcripts that skip
  // the user settings carrying the OTEL env, and they read as 203 silent sessions
  // (dotfiles #784). The control is a fan-out agent: sdk-cli too, but no
  // agent-setting record, and it is expected to export — so it must stay silent here.
  const { home } = homeWithTranscripts(t, 0);
  const dir = path.join(home, '.claude', 'projects', 'proj');
  const stamp = new Date(Date.now() - 60000).toISOString();
  const user = `{"type":"user","entrypoint":"sdk-cli","timestamp":"${stamp}"}\n`;
  fs.writeFileSync(path.join(dir, 'eval-run.jsonl'),
    `{"type":"agent-setting","agentSetting":"judge","sessionId":"eval-run"}\n${user}`);
  fs.writeFileSync(path.join(dir, 'fanout-agent.jsonl'), user);

  const result = deepScan(home, true);
  assert.deepStrictEqual(result.silent_sessions.map((s) => s.session), ['fanout-agent'],
    'a headless session without --agent must still be checked');
  assert.strictEqual(result.eval_sessions_skipped_48h, 1, 'the skipped eval stays visible as a count');
});

test('--rows names the silent count and says when it truncated', () => {
  // The rejecting half: a cap in the compact view is fine, a cap that looks
  // like the whole set is the defect. Both the total and the notice must exist.
  assert.match(SRC, /ROW_SILENT_LIMIT = \d+/);
  assert.match(SRC, /summary \+= f" silent=\{len\(silent\)\}"/,
    'the summary line must carry the total, not just the listed lines');
  assert.match(SRC, /if len\(silent\) > ROW_SILENT_LIMIT:/,
    'a truncated listing must say so');
});

test('the error count is a pattern, not a list of event names', () => {
  // The list read `api_error|api_refusal` and missed `internal_error` outright --
  // 7 events over 30d that reached no output at all. A hardcoded enumeration
  // fails silently when a new name appears; a pattern over-reports instead,
  // which a reader narrows once.
  assert.match(SRC, /errors_24h.*event_name=~`\.\*\(error\|refusal\)\.\*`/,
    'the error filter must match by pattern');
  assert.ok(!/event_name=~`api_error\|api_refusal`/.test(SRC),
    'the superseded hardcoded list must be gone');
});

test('the remote probe only ever reaches a private address', () => {
  // The second candidate for each backend is the one place the probe targets
  // something other than loopback, so it stays behind the RFC1918 guard.
  assert.match(SRC, /RFC1918 = re\.compile/);
  assert.match(SRC, /RFC1918\.match\(candidate\)/);
});

test('the probe performs no writes', () => {
  const probe = SRC.slice(SRC.indexOf("PROBE = r'''"), SRC.indexOf("'''\n\n\ndef is_self"));
  // The deep scan reads transcripts, so `open` is permitted — but only for
  // reading. Anything that could truncate or append is what this forbids, and
  // naming the modes keeps the assertion about writes rather than about I/O.
  for (const call of probe.match(/\bopen\([^)]*\)/g) || []) {
    assert.match(call, /"rb?"/, `every open must name a read mode: ${call}`);
  }
  assert.ok(!/urllib\.request\.Request\([^)]*method=/.test(probe), 'every request stays a plain GET');
  assert.ok(!/\bdata=/.test(probe), 'a request body would make it a POST');
});

test('--help works and names the tool', { skip }, () => {
  assert.match(run(['--help']), /otel-sweep/);
});

test('--only rejects a machine that is not in the enum', { skip }, () => {
  assert.throws(() => run(['--only', 'somewhere-else']), (err) => {
    assert.match(String(err.stderr), /invalid choice/);
    return true;
  });
});

test('an unknown flag is refused rather than ignored', { skip }, () => {
  assert.throws(() => run(['--host', 'evil.example.com']), (err) => {
    assert.match(String(err.stderr), /unrecognized arguments/);
    return true;
  });
});

// The fallback that keeps the sweep working across a reschedule. Both candidates
// must stay literal and private, or the blanket allow rule stops being defensible.
test('the cluster fallback is a fixed table of private literals', { skip }, () => {
  const table = SRC.match(/CLUSTER_IP = \{([^}]*)\}/);
  assert.ok(table, 'PROBE must carry a CLUSTER_IP table');
  const addresses = [...table[1].matchAll(/"([\d.]+)"/g)].map((m) => m[1]);
  assert.strictEqual(addresses.length, 3, 'one address per backend');
  for (const address of addresses) {
    assert.match(address, /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)[\d.]+$/,
      'every fallback address must be RFC1918');
  }
});

// The fallback used to be `docker inspect`, which returns nothing on a k3s node —
// so the second candidate was dead code on both machines that needed it.
test('the probe shells out to nothing', { skip }, () => {
  assert.ok(!CODE.includes('"docker"'), 'no docker invocation may remain in PROBE');
  assert.ok(!CODE.includes('container_ip'), 'the retired bridge lookup must be gone');
});

test('a machine does not ssh to itself', { skip }, () => {
  const out = execFileSync(python, ['-c', `
import importlib.util, socket, sys
from importlib.machinery import SourceFileLoader
loader = SourceFileLoader("sweep", ${JSON.stringify(SWEEP)})
spec = importlib.util.spec_from_loader("sweep", loader)
m = importlib.util.module_from_spec(spec)
loader.exec_module(m)
me = socket.gethostname().split(".")[0]
print(m.is_self(me), m.is_self(me + ".local"), m.is_self("not-" + me), m.is_self(None),
      m.dest_for("local") is None)
`], { encoding: 'utf8' });
  const [self, fqdn, other, none, localDest] = out.trim().split(' ');
  assert.strictEqual(localDest, 'True', 'the local entry always runs here');
  assert.strictEqual(self, 'True', 'the local hostname is self');
  assert.strictEqual(fqdn, 'True', 'an FQDN for this machine is still self');
  assert.strictEqual(other, 'False', 'a different machine is not self');
  assert.strictEqual(none, 'False', 'the local entry has no ssh hop to skip');
});

// Session activity comes from the transcript's content, not its mtime. A
// retention sweep re-stamped four transcripts from days earlier, and each then
// looked like a live session exporting nothing — the exact shape of the finding
// this tool exists to raise.
test('transcript activity is read from content, not mtime', { skip }, () => {
  const probe = SRC.slice(SRC.indexOf("PROBE = r'''"));
  assert.ok(probe.includes('last_activity(path, st)'),
    'the candidate cutoff must go through last_activity');
  assert.ok(!/if st\.st_mtime >= cutoff/.test(probe),
    'st_mtime must not be the activity signal');

  const out = execFileSync(python, ['-c', `
import ast, json, os, sys, tempfile, time, calendar
src = open(${JSON.stringify(SWEEP)}).read()
probe = src.split("PROBE = r'''")[1].split("'''")[0]
tree = ast.parse(probe)
wanted = [n for n in ast.walk(tree)
          if (isinstance(n, ast.FunctionDef) and n.name == "last_activity")
          or (isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == "STAMP")]
ns = {"re": __import__("re"), "time": time, "calendar": calendar, "open": open}
exec(compile(ast.Module(body=wanted, type_ignores=[]), "<probe>", "exec"), ns)
d = tempfile.mkdtemp()
p = os.path.join(d, "s.jsonl")
open(p, "w").write('{"timestamp":"2020-01-02T03:04:05.000Z"}\\n')
os.utime(p, (time.time(), time.time()))   # fresh mtime, stale content
st = os.stat(p)
print(int(ns["last_activity"](p, st)), int(st.st_mtime))
`], { encoding: 'utf8' });
  const [activity, mtime] = out.trim().split(' ').map(Number);
  assert.strictEqual(activity, Date.UTC(2020, 0, 2, 3, 4, 5) / 1000,
    'the content timestamp wins over a fresh mtime');
  assert.ok(mtime - activity > 86400, 'the mtime really was much newer');
});

// Live sweep. Skipped by default: it dials two other machines over ssh.
test('live sweep returns a per-machine object', { skip: skip || 'live: needs daniel-box and daniel-server' }, () => {
  const out = JSON.parse(run(['--only', 'local']));
  assert.ok(Object.prototype.hasOwnProperty.call(out.local, 'backends'));
});

test('the store identity is reachability, not a process fingerprint', () => {
  // Loki is a single-replica Deployment on an RWO volume, so anything derived
  // from the process — a start time, a pid, a uptime metric — moves on every
  // reschedule while the store stays put, and would split the group at the next
  // pod restart. A ClusterIP is routed on cluster nodes alone, so reaching it is
  // a fact about the machine's position that a restart does not change.
  assert.match(SRC, /out\["store"\] = "cluster"/, 'the probe must report which store it read');
  assert.match(SRC, /_cluster_loki = cluster_ip\("loki"\)/,
    'the discriminator must be the fixed ClusterIP constant');
  // Comment lines are excluded: the paragraph above deliberately NAMES the
  // rejected approach, and a test that forbade the word would forbid the reason.
  assert.ok(!/process_start_time|buildinfo|proc\/uptime/.test(STATEMENTS),
    'a process-derived identity must not creep back in');
});

test('a machine that cannot reach the cluster Loki is its own store', () => {
  // The rejecting half. A probe that reported "cluster" unconditionally would
  // satisfy the assertions above and merge a standalone machine's store with the
  // cluster's, hiding its errors behind the cluster's numbers.
  assert.match(SRC, /out\["store"\] = "local"/,
    'the negative branch must exist, or the identity says nothing');
});

test('errors are also counted by message, not only by event name', () => {
  // api_error covers a rate-limit rejection and a dead OAuth token alike, so the
  // name alone permits no class judgement: on 2026-09-02 it carried 11 of the
  // first and 2 of the second and reported 13 of one thing.
  assert.match(SRC, /out\["error_messages_24h"\] = count\(.*, "error"\)/,
    'the breakdown must aggregate by the error message');
  assert.match(SRC, /error_messages_24h.*event_name=~`\.\*\(error\|refusal\)\.\*`/,
    'and must cover the same events as errors_24h, by the same pattern');
});

test('otel-sweep does not itself decide what is benign', () => {
  // The rejecting half, and a boundary: the sweep reports, the watch judges.
  // A benign list in both places is a list that gets updated in one.
  // Matched on the provider's sentence, not on the words "rate limit" — the
  // probe legitimately discusses the UFW rate limiter that throttles its own ssh.
  assert.ok(!/would exceed your account/i.test(SRC),
    'classification belongs to otel-sweep-watch, which is where its test lives');
});
