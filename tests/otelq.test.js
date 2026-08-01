// Regression guard for home/dot_local/bin/executable_otelq.
// Drives the ACTUAL script. The confinement suite is the point of this file:
// otelq is meant to carry a blanket `Bash(otelq:*)` allow rule, and that rule is
// only defensible while the host stays un-settable and the method stays GET. A
// --host flag added later would turn this into the arbitrary-fetch primitive
// that `Bash(curl:*)` is ask-listed for being.
// Hermetic: no network needed except the one explicitly-skipped live test.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OTELQ = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_otelq');

const python = 'python3';
let skip = false;
try {
  execFileSync(python, ['--version'], { stdio: 'ignore' });
} catch {
  skip = 'python3 unavailable';
}

const dirs = [];
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'otelq-'));
dirs.push(DIR);

// Loads the script as a module so the pure helpers can be exercised without a
// backend. The __main__ guard keeps exec_module from running the CLI.
const DRIVER = path.join(DIR, 'driver.py');
// otelq has no .py suffix, so importlib cannot infer a loader — name one.
fs.writeFileSync(DRIVER, `import importlib.util, json, sys
from importlib.machinery import SourceFileLoader
loader = SourceFileLoader("otelq", ${JSON.stringify(OTELQ)})
spec = importlib.util.spec_from_loader("otelq", loader)
m = importlib.util.module_from_spec(spec)
loader.exec_module(m)
verb = sys.argv[1]
if verb == "dur":
    try:
        print(m.parse_duration(sys.argv[2]))
    except m.OtelqError as e:
        print("ERR: %s" % e)
elif verb == "rows":
    print(m._rows(json.loads(sys.stdin.read())))
elif verb == "bases":
    print(json.dumps([m.LOKI, m.PROM, m.TEMPO]))
`);

function otelq(args, input) {
  try {
    const out = execFileSync(python, [OTELQ, ...args], {
      encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, out: out.trim(), err: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '').trim(), err: (e.stderr || '').trim() };
  }
}

function drive(args, input) {
  return execFileSync(python, [DRIVER, ...args], {
    encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

const SRC = fs.readFileSync(OTELQ, 'utf8');

test('targets only loopback, on the three telemetry ports', { skip }, () => {
  const bases = JSON.parse(drive(['bases']));
  assert.deepStrictEqual(bases,
    ['http://127.0.0.1:3100', 'http://127.0.0.1:9090', 'http://127.0.0.1:3200']);
  for (const b of bases) {
    assert.match(b, /^http:\/\/127\.0\.0\.1:/, 'base must be loopback-literal, not a hostname');
  }
});

test('exposes no flag that could redirect or persist the response', { skip }, () => {
  const help = otelq(['--help']).out + otelq(['logs', '--help']).out;
  for (const flag of ['--host', '--url', '--base', '--output', '-o', '--insecure']) {
    assert.ok(!help.includes(flag), `${flag} must not exist — it would break the allow rule`);
  }
});

test('issues GET only, and never sends a request body', { skip }, () => {
  assert.ok(!/method\s*=\s*["'](?!GET)/.test(SRC), 'only GET requests may be constructed');
  assert.ok(!/urlopen\([^)]*\bdata\s*=/.test(SRC), 'urlopen must not be handed a body');
});

test('parses durations and rejects anything else', { skip }, () => {
  assert.strictEqual(drive(['dur', '19h']), '68400');
  assert.strictEqual(drive(['dur', '90s']), '90');
  assert.strictEqual(drive(['dur', '7d']), '604800');
  for (const bad of ['19', 'h', '19x', '-5h', '1h;ls', '../etc']) {
    assert.match(drive(['dur', bad]), /^ERR:/, `${bad} should be refused`);
  }
});

test('--rows renders vector results, largest first', { skip }, () => {
  const payload = JSON.stringify({
    data: {
      resultType: 'vector',
      result: [
        { metric: { event_name: 'api_request' }, value: [1, '12'] },
        { metric: { event_name: 'tool_result' }, value: [1, '340'] },
      ],
    },
  });
  const out = drive(['rows'], payload);
  assert.strictEqual(out.split('\n')[0], '340\tevent_name=tool_result');
  assert.strictEqual(out.split('\n')[1], '12\tevent_name=api_request');
});

test('--rows handles Loki streams and matrix values', { skip }, () => {
  const payload = JSON.stringify({
    data: { result: [{ stream: { level: 'err' }, values: [['1', '5'], ['2', '9']] }] },
  });
  const out = drive(['rows'], payload);
  assert.strictEqual(out, '9\tlevel=err\n5\tlevel=err');
});

test('--rows survives a non-numeric value without throwing', { skip }, () => {
  const payload = JSON.stringify({ data: { result: [{ metric: { a: '1' }, value: [1, 'NaN'] }] } });
  assert.match(drive(['rows'], payload), /NaN\ta=1/);
});

test('--rows on an empty result set is empty, not an error', { skip }, () => {
  assert.strictEqual(drive(['rows'], JSON.stringify({ data: { result: [] } })), '');
});

test('reports a bad duration as exit 2 without a traceback', { skip }, () => {
  const r = otelq(['logs', '{a="b"}', '--stream', '--since', 'nope']);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /bad duration/);
  assert.doesNotMatch(r.err, /Traceback/);
});

test('requires a subcommand and rejects an unknown one', { skip }, () => {
  assert.notStrictEqual(otelq([]).code, 0);
  assert.notStrictEqual(otelq(['fetch', 'http://example.com']).code, 0);
});

test('accepts --rows after the subcommand, not just before it', { skip }, () => {
  // Regression: declaring the shared flags only at the top level made the
  // natural trailing form an "unrecognized arguments" error.
  for (const args of [['logs', '--help'], ['metric', '--help'], ['labels', '--help']]) {
    const r = otelq(args);
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /--rows/, `${args[0]} should accept --rows in trailing position`);
    assert.match(r.out, /--indent/);
  }
});

// The only test that touches the network. Skipped unless the stack is actually
// listening, so a stopped stack is not a red suite. Probed synchronously —
// node:test collects tests before any await would resolve.
let lokiUp = false;
try {
  execFileSync(python, ['-c',
    'import socket; socket.create_connection(("127.0.0.1", 3100), 0.7).close()'],
  { stdio: 'ignore' });
  lokiUp = true;
} catch {
  lokiUp = false;
}

test('ready reports every backend against the live stack', { skip: skip || !lokiUp }, () => {
  const r = otelq(['ready']);
  assert.strictEqual(r.code, 0);
  const out = JSON.parse(r.out);
  assert.ok('loki' in out && 'prometheus' in out && 'tempo' in out);
  assert.ok(typeof out.loki.code === 'number' || out.loki.code === null);
});

test('reports an unreachable backend as a refusal, not a crash', { skip }, () => {
  // Ports are fixed, so this asserts the error path's shape via the message the
  // URLError branch produces; a live stack makes it a no-op.
  assert.match(SRC, /unreachable.*docker ps/, 'unreachable path should hint at the stack');
});

// otelq hardcodes its backend ports and claude-otel/docker-compose.yml publishes them, with
// no shared source between them. Rather than template one from the other, pin them together:
// a port changed on either side fails here instead of surfacing as a stack that reports
// unreachable. Tempo is in this list because `ready` probes it while nothing queries it —
// that asymmetry is exactly the kind that rots unwatched.
test('every otelq backend port is published by the compose stack', () => {
  const compose = fs.readFileSync(
    path.join(__dirname, '..', 'home', 'claude-otel', 'docker-compose.yml'), 'utf8');
  const consts = Object.fromEntries(
    [...SRC.matchAll(/^(LOKI|PROM|TEMPO) = "http:\/\/127\.0\.0\.1:(\d+)"$/gm)]
      .map((m) => [m[1], m[2]]));
  assert.deepStrictEqual(Object.keys(consts).sort(), ['LOKI', 'PROM', 'TEMPO'],
    'otelq should define exactly the three backend constants this test knows about');
  for (const [name, port] of Object.entries(consts)) {
    assert.ok(compose.includes(`"127.0.0.1:${port}:${port}"`),
      `${name} uses port ${port}, which docker-compose.yml does not publish on 127.0.0.1`);
  }
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
