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

test('the remote probe only ever reaches a private address', () => {
  // Loki is unpublished on daniel-server, so the probe resolves a container IP.
  // That discovered value is the one place remote data selects a network target.
  assert.match(SRC, /RFC1918 = re\.compile/);
  assert.match(SRC, /if RFC1918\.match\(candidate\)/);
});

test('the probe performs no writes', () => {
  const probe = SRC.slice(SRC.indexOf("PROBE = r'''"), SRC.indexOf("'''\n\n\ndef probe"));
  assert.ok(!/\bopen\(/.test(probe), 'the probe must not open files for writing');
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

// Live sweep. Skipped by default: it dials two other machines over ssh.
test('live sweep returns a per-machine object', { skip: skip || 'live: needs daniel-box and daniel-server' }, () => {
  const out = JSON.parse(run(['--only', 'local']));
  assert.ok(Object.prototype.hasOwnProperty.call(out.local, 'backends'));
});
