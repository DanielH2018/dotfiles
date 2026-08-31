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
const path = require('node:path');

const SWEEP = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_otel-sweep');
const SRC = fs.readFileSync(SWEEP, 'utf8');
// The module docstring argues the confinement in prose, so it names the very
// constructs these checks forbid. Scan the code, not the argument for it.
const CODE = SRC.slice(SRC.indexOf('from __future__'));

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

test('a single transient is retried before a machine is called unreachable', () => {
  // The ssh path crosses a WireGuard tunnel that rekeys and a UFW rate limiter
  // that rejects bursts; both recover in seconds. Treating the first refusal as
  // an outage is what raises a desktop notification about a healthy machine.
  assert.match(SRC, /def probe_once\(dest, mode, timeout\)/);
  assert.match(SRC, /time\.sleep\(RETRY_PAUSE\)/);
  assert.match(SRC, /return probe_once\(dest, mode, timeout\)/);
  // A local probe cannot fail this way, so it must not pay for the retry.
  assert.match(SRC, /if dest is None or "error" not in result/);
});

test('silent-session detection is skipped when Loki is unreachable', () => {
  // The set of known sessions comes from Loki, so an unreachable Loki returns
  // nothing and every recently-written transcript reads as exporting nowhere —
  // one outage manufacturing a finding per session on top of its own.
  const deep = SRC.slice(SRC.indexOf('if MODE == "deep":'), SRC.indexOf('print(json.dumps(out))'));
  assert.match(deep, /if BASE\["loki"\]:/, 'the scan must be gated on Loki being reachable');
  assert.ok(
    deep.indexOf('if BASE["loki"]:') < deep.indexOf('silent.append'),
    'the guard must wrap the scan rather than follow it',
  );
});

test('the silent-session payload is uncapped', () => {
  // A `[:10]` slice lived here until 2026-08-31. otel-sweep-watch derives its
  // `silent=N` alert from len() of this list, so the slice under-counted the
  // alert as well as the listing — 24 silent sessions reported as 10, with
  // nothing in either output saying anything had been dropped.
  const deep = SRC.slice(SRC.indexOf('if MODE == "deep":'), SRC.indexOf('print(json.dumps(out))'));
  assert.match(deep, /out\["silent_sessions"\] = sorted\(silent, key=lambda s: s\["mb"\], reverse=True\)\n/,
    'the payload must carry every silent session, uncapped');
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
