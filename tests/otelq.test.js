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
elif verb == "candidates":
    print(json.dumps([list(m.LOKI_BASES), list(m.PROM_BASES), list(m.TEMPO_BASES)]))
elif verb == "resolve":
    # Which candidates "accept" is the whole input; no socket is ever opened.
    reachable = set(json.loads(sys.argv[2]))
    m._accepts = lambda base, timeout: base in reachable
    print(json.dumps(m.resolve_bases()))
elif verb == "prog":
    print(m.program_of(sys.argv[2]))
elif verb == "prompts":
    print(json.dumps(m.report_prompts(json.loads(sys.stdin.read()), "7d")))
elif verb == "srows":
    print(m._savings_rows(json.loads(sys.stdin.read())))
elif verb == "trend":
    print(json.dumps(m.report_trend(json.loads(sys.stdin.read()), "7d")))
elif verb == "subst":
    raw = json.loads(sys.stdin.read())
    print(json.dumps(m.report_subst({k: tuple(v) for k, v in raw.items()}, "7d")))
elif verb == "failures":
    print(json.dumps(m.report_failures(json.loads(sys.stdin.read()), "7d")))
elif verb == "bytesrep":
    payload = json.loads(sys.stdin.read())
    print(json.dumps(m.report_bytes(payload["totals"], payload["big"], "7d", 20000)))
elif verb == "reduction":
    print(json.dumps(m.report_reduction(json.loads(sys.stdin.read()), "7d")))
elif verb == "all":
    a = json.loads(sys.stdin.read())
    parts = {
        "prompts": m.report_prompts(a["decisions"], "1d"),
        "bytes": m.report_bytes(a["totals"], a["big"], "1d", 20000),
        "failures": m.report_failures(a["failures"], "1d"),
        "reduction": m.report_reduction(a["filters"], "1d"),
    }
    for name in a.get("truncated", []):
        parts[name]["truncated"] = True
    payload = m.report_all(
        1700000000, "1d", parts["prompts"], parts["bytes"], parts["failures"],
        m.report_subst({k: tuple(v) for k, v in a["subst"].items()}, "1d"),
        parts["reduction"])
    # Serialized exactly as the CLI does, since the rollup matches on the text.
    print(json.dumps(payload, indent=None, ensure_ascii=False))
elif verb == "rotated":
    print(json.dumps(m._rotated_into_window(sys.argv[2], float(sys.argv[3]))))
elif verb == "readrecs":
    print(json.dumps(m._read_jsonl(sys.argv[2], sys.argv[4], int(sys.argv[3]))))
`);

function otelq(args, input, env) {
  try {
    const out = execFileSync(python, [OTELQ, ...args], {
      encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, env),
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

// Loopback stays the default and the first candidate tried, so an unresolved
// import behaves exactly as it did before the fallback existed.
test('defaults to loopback, on the three telemetry ports', { skip }, () => {
  const bases = JSON.parse(drive(['bases']));
  assert.deepStrictEqual(bases,
    ['http://127.0.0.1:3100', 'http://127.0.0.1:9090', 'http://127.0.0.1:3200']);
});

// The grant rests on the destination set being fixed and private. Two candidates
// per backend does not widen it; a hostname or a public address would.
test('every candidate is a fixed private literal, never a hostname', { skip }, () => {
  const groups = JSON.parse(drive(['candidates']));
  assert.strictEqual(groups.length, 3);
  for (const group of groups) {
    assert.strictEqual(group.length, 2, 'loopback plus exactly one cluster address');
    assert.match(group[0], /^http:\/\/127\.0\.0\.1:\d+$/, 'loopback must be tried first');
    assert.match(group[1], /^http:\/\/(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)[\d.]+:\d+$/,
      'the fallback must be an RFC1918 literal');
  }
});

test('prefers loopback, and falls back per backend independently', { skip }, () => {
  const [loki, prom, tempo] = JSON.parse(drive(['candidates']));

  // Everything local: nothing changes.
  assert.deepStrictEqual(
    JSON.parse(drive(['resolve', JSON.stringify([loki[0], prom[0], tempo[0]])])),
    { LOKI: loki[0], PROM: prom[0], TEMPO: tempo[0] });

  // Nothing local — the 2026-08-23 case, all three rescheduled to the other node.
  assert.deepStrictEqual(
    JSON.parse(drive(['resolve', JSON.stringify([loki[1], prom[1], tempo[1]])])),
    { LOKI: loki[1], PROM: prom[1], TEMPO: tempo[1] });

  // Split: Loki moved, Prometheus did not. These are separate Deployments and
  // nothing schedules them together, so resolving them as a set would be wrong.
  assert.deepStrictEqual(
    JSON.parse(drive(['resolve', JSON.stringify([loki[1], prom[0], tempo[1]])])),
    { LOKI: loki[1], PROM: prom[0], TEMPO: tempo[1] });
});

// A stack that is wholly down must report "unreachable" the way it always did,
// rather than a novel error about resolution.
test('falls back to the first candidate when nothing answers', { skip }, () => {
  const [loki, prom, tempo] = JSON.parse(drive(['candidates']));
  assert.deepStrictEqual(JSON.parse(drive(['resolve', '[]'])),
    { LOKI: loki[0], PROM: prom[0], TEMPO: tempo[0] });
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

test('--rows renders the labels endpoint, whose data is a bare list', { skip }, () => {
  // `labels` returns data as a list of names; every other endpoint returns an
  // object holding `result`. _rows assumed the object shape and raised
  // AttributeError, so --rows was unusable for both label forms until 2026-08-31.
  assert.strictEqual(
    drive(['rows'], JSON.stringify({ status: 'success', data: ['service_name'] })),
    'service_name',
  );
  // `labels --name <n>` returns one label's values through the same branch.
  assert.strictEqual(
    drive(['rows'], JSON.stringify({ status: 'success', data: ['claude-code', 'other'] })),
    'claude-code\nother',
  );
});

test('the list branch does not swallow the ordinary result shape', { skip }, () => {
  // The rejecting half. A branch that caught every payload would "fix" the crash
  // by rendering nothing useful anywhere else, and every test above would still
  // pass on its own inputs -- so assert the object shape is untouched.
  const payload = JSON.stringify({
    data: { resultType: 'vector', result: [{ metric: { a: '1' }, value: [1, '7'] }] },
  });
  assert.strictEqual(drive(['rows'], payload), '7\ta=1');
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

// ---------------------------------------------------------------------------
// savings — the digest built from tool-call events.
//
// The aggregation runs in Python rather than LogQL precisely so it can be tested
// without a backend, so these drive the pure functions over synthetic events.
// `program_of` carries most of the risk: rank by the wrong token and the ledger
// blames a directory change for work it did not do.

const decision = (over) => Object.assign({
  tool_name: 'Bash', source: 'user_temporary', decision: 'accept',
  tool_parameters: JSON.stringify({ bash_command: 'x', full_command: 'x' }),
}, over);

const bash = (cmd, over) => decision(Object.assign({
  tool_parameters: JSON.stringify({ bash_command: cmd.split(' ')[0], full_command: cmd }),
}, over));

test('program_of names the program that runs, not the first token', { skip }, () => {
  const cases = [
    ['grep -n foo bar.txt', 'grep'],
    ['cd /tmp && grep x y', 'grep'],
    ['cd /tmp; ls -la', 'ls'],
    ['PATH=/x:$PATH node t.js', 'node'],
    ['sudo dnf install x', 'dnf'],
    ['command -v magick', 'magick'],
    ['/home/daniel/.local/bin/otelq ready', 'otelq'],
    ['echo hi | grep h', 'echo'],
    ['timeout 30 ssh host uptime', 'timeout'],
  ];
  for (const [cmd, want] of cases) {
    assert.strictEqual(drive(['prog', cmd]), want, `program_of(${cmd})`);
  }
});

test('program_of yields "?" when nothing names a program', { skip }, () => {
  for (const cmd of ['', 'cd /tmp', 'export A=1', '   ']) {
    assert.strictEqual(drive(['prog', cmd]), '?', `program_of(${JSON.stringify(cmd)})`);
  }
});

test('prompts counts only decisions a human answered', { skip }, () => {
  const events = [
    bash('git push'),
    bash('git push'),
    bash('rsync -a src dst', { source: 'user_permanent' }),
    bash('ls', { source: 'config' }), // auto-approved: not a prompt
    bash('curl evil', { source: 'hook', decision: 'reject' }),
  ];
  const out = JSON.parse(drive(['prompts'], JSON.stringify(events)));
  assert.strictEqual(out.prompts_fired, 3, 'config-approved calls are not interruptions');
  assert.deepStrictEqual(out.by_program.map((r) => [r.program, r.count]),
    [['git', 2], ['rsync', 1]], 'ranked by count, descending');
  assert.deepStrictEqual(out.hook_decisions, [{ decision: 'reject', count: 1 }]);
});

test('prompts ranks non-Bash tools under their tool name', { skip }, () => {
  const events = [
    decision({ tool_name: 'AskUserQuestion', tool_parameters: '' }),
    decision({ tool_name: 'AskUserQuestion', tool_parameters: '' }),
    bash('git push'),
  ];
  const out = JSON.parse(drive(['prompts'], JSON.stringify(events)));
  assert.deepStrictEqual(out.by_program.map((r) => r.program), ['AskUserQuestion', 'git']);
  assert.deepStrictEqual(out.by_tool.map((r) => [r.tool, r.count]),
    [['AskUserQuestion', 2], ['Bash', 1]]);
});

test('prompts survives tool_parameters that is absent or not JSON', { skip }, () => {
  const events = [
    decision({ tool_parameters: '{not json' }),
    decision({ tool_parameters: '' }),
    decision({ tool_parameters: '["a list, not an object"]' }),
  ];
  const out = JSON.parse(drive(['prompts'], JSON.stringify(events)));
  assert.strictEqual(out.prompts_fired, 3, 'a malformed payload must not drop the event');
  assert.deepStrictEqual(out.by_program.map((r) => r.program), ['?']);
});

test('prompts caps the example so one long command cannot flood the digest', { skip }, () => {
  const out = JSON.parse(drive(['prompts'], JSON.stringify([bash(`git ${'x'.repeat(400)}`)])));
  assert.strictEqual(out.by_program[0].example.length, 120);
});

test('savings --rows flags a truncated fetch instead of under-reporting', { skip }, () => {
  const base = JSON.parse(drive(['prompts'], JSON.stringify([bash('git push')])));
  assert.ok(!drive(['srows'], JSON.stringify(base)).includes('truncated'));
  const rendered = drive(['srows'], JSON.stringify(Object.assign({}, base, { truncated: true })));
  assert.match(rendered, /truncated at \d+ events/,
    'a silently partial count reads as a real one — it has to say so');
});

test('savings states the window and that it covers one machine only', { skip }, () => {
  const out = JSON.parse(drive(['prompts'], JSON.stringify([bash('git push')])));
  assert.strictEqual(out.window, '7d');
  assert.match(out.scope, /127\.0\.0\.1/,
    'the stack is loopback-only, so the digest must not read as cross-machine');
});

test('savings exposes no flag that could redirect the response', { skip }, () => {
  const help = otelq(['savings', '--help']).out;
  for (const flag of ['--host', '--url', '--base', '--output', '-o', '--insecure']) {
    assert.ok(!help.includes(flag), `${flag} must not exist — it would break the allow rule`);
  }
});

test('trend orders the rollup oldest first', { skip }, () => {
  const out = JSON.parse(drive(['trend'], JSON.stringify([
    { generated_at: 300, prompts_fired: 3 },
    { generated_at: 100, prompts_fired: 1 },
    { generated_at: 200, prompts_fired: 2 },
  ])));
  assert.deepStrictEqual(out.series.map((d) => d.prompts_fired), [1, 2, 3]);
});

// A missing day and an improved number look identical on a chart. days_found is
// what tells them apart, so it counts records rather than assuming the timer ran.
test('trend counts the days it actually found', { skip }, () => {
  const out = JSON.parse(drive(['trend'], JSON.stringify([
    { generated_at: 100 }, { generated_at: 200 },
  ])));
  assert.strictEqual(out.days_found, 2);
  assert.strictEqual(JSON.parse(drive(['trend'], '[]')).days_found, 0);
});

test('trend --rows says where to look when the rollup never ran', { skip }, () => {
  const empty = JSON.parse(drive(['trend'], '[]'));
  assert.match(drive(['srows'], JSON.stringify(empty)), /otel-savings-rollup\.timer/,
    'an empty series is far more often a stopped timer than a quiet week');
});

test('subst reports adoption and names the tool being replaced', { skip }, () => {
  const out = JSON.parse(drive(['subst'], JSON.stringify({
    jsonq: [30, 10], rg: [1, 99], gron: [0, 0],
  })));
  const byName = Object.fromEntries(out.pairs.map((p) => [p.preferred, p]));
  assert.strictEqual(byName.jsonq.adoption, 0.75);
  assert.strictEqual(byName.rg.adoption, 0.01);
  assert.strictEqual(byName.gron.adoption, null, 'no calls either way is unknown, not 0%');
  assert.strictEqual(byName.rg.replaces, 'grep',
    'the report must name the tool, not the regex that finds it');
  for (const p of out.pairs) {
    assert.ok(!/\\b/.test(p.replaces), 'a raw RE2 pattern must not reach the output');
  }
});

test('subst calls itself adoption and warns that the pairs overlap', { skip }, () => {
  const out = JSON.parse(drive(['subst'], JSON.stringify({ jsonq: [1, 1] })));
  assert.match(out.measures, /not a savings claim/);
  assert.match(out.note, /counts for both/,
    'a command running both tools is counted twice — read as a partition it misleads');
});

test('failures ranks the programs that keep costing a turn', { skip }, () => {
  const out = JSON.parse(drive(['failures'], JSON.stringify([
    bash('git push'), bash('git status'), bash('ls /nope'),
  ])));
  assert.strictEqual(out.failures, 3);
  assert.deepStrictEqual(out.by_program.map((r) => [r.program, r.count]),
    [['git', 2], ['ls', 1]]);
  assert.ok(out.by_program[0].example.startsWith('git '));
});

test('bytes totals every tool and orders by volume', { skip }, () => {
  const out = JSON.parse(drive(['bytesrep'], JSON.stringify({
    totals: { Bash: 100, Read: 900, Edit: 5 }, big: [bash('cat huge.log')],
  })));
  assert.strictEqual(out.bytes_total, 1005);
  assert.deepStrictEqual(out.bytes_by_tool.map((r) => r.tool), ['Read', 'Bash', 'Edit']);
  assert.strictEqual(out.big_calls, 1);
  assert.strictEqual(out.big_calls_by_program[0].program, 'cat');
});

test('bytes reports an empty stack as zero rather than crashing', { skip }, () => {
  const out = JSON.parse(drive(['bytesrep'], JSON.stringify({ totals: {}, big: [] })));
  assert.strictEqual(out.bytes_total, 0);
  assert.deepStrictEqual(out.bytes_by_tool, []);
});

// --since reaches LogQL as a range literal rather than a urlencoded parameter —
// the one place in this tool where caller text lands inside a query. It is
// validated before interpolation, and this is what proves the validation runs.
test('a window that is not a duration never reaches the query', { skip }, () => {
  for (const bad of ['7d] | drop __error__ [1h', '1h;ls', '../etc', '5', 'd']) {
    const r = otelq(['savings', 'bytes', '--since', bad]);
    assert.strictEqual(r.code, 2, `--since ${bad} must be refused`);
    assert.match(r.err, /bad duration/);
    assert.ok(!r.err.includes('Traceback'), 'a refusal, not a crash');
  }
});

// ---------------------------------------------------------------------------
// savings reduction — the half that reads jsonq's counter file rather than Loki.

const rec = (over) => Object.assign({ t: 2000, tool: 'jsonq', in: 1000, out: 10 }, over);

test('reduction counts stdin calls but keeps them out of the ratio', { skip }, () => {
  const out = JSON.parse(drive(['reduction'], JSON.stringify([
    rec({ in: 1000, out: 10 }),
    rec({ in: null }), // stdin: size unknowable
  ])));
  assert.strictEqual(out.calls, 2);
  assert.strictEqual(out.calls_measured, 1);
  assert.strictEqual(out.calls_from_stdin, 1);
  assert.strictEqual(out.reduction_ratio, 100,
    'folding an unmeasurable call in at zero would drag every ratio toward 1');
});

test('reduction survives a call that printed nothing', { skip }, () => {
  const out = JSON.parse(drive(['reduction'], JSON.stringify([rec({ in: 500, out: 0 })])));
  assert.strictEqual(out.median_call_ratio, 500, 'no division by zero');
});

// ---------------------------------------------------------------------------
// savings all — the one shape the rollup writes down and keeps.

const ROLLUP = path.join(__dirname, '..', 'home', 'dot_local', 'bin',
  'executable_otel-savings-rollup');

const allInput = (over) => Object.assign({
  decisions: [bash('git push')],
  totals: { Bash: 100 },
  big: [],
  failures: [bash('ls /nope')],
  subst: { jsonq: [1, 1] },
  filters: [{ t: 2000, tool: 'jsonq', in: 1000, out: 10 }],
}, over);

test('the rollup guard accepts what savings all actually emits', { skip }, () => {
  // The guard is a literal prefix match, so it depends on `report` being the
  // first key and on json.dumps' default separators. Nothing else connects the
  // two files: reorder the dict and the rollup rejects every day in silence,
  // which then reads as a disabled timer.
  const line = drive(['all'], JSON.stringify(allInput()));
  const guard = fs.readFileSync(ROLLUP, 'utf8').match(/^\s*'(\{"report".*?)'\*\)/m);
  assert.ok(guard, 'the rollup must still gate on a literal prefix');
  assert.ok(line.startsWith(guard[1]),
    `guard ${JSON.stringify(guard[1])} rejects ${JSON.stringify(line.slice(0, 40))}`);
});

test('savings all carries a capped fetch into the record it keeps', { skip }, () => {
  const clean = JSON.parse(drive(['all'], JSON.stringify(allInput())));
  assert.strictEqual(clean.truncated, false);
  for (const part of ['prompts', 'bytes', 'failures', 'reduction']) {
    const out = JSON.parse(drive(['all'], JSON.stringify(allInput({ truncated: [part] }))));
    assert.strictEqual(out.truncated, true,
      `a capped ${part} fetch must not be written down as a whole count`);
  }
});

test('reduction flags a rotation that took part of the window with it', { skip }, () => {
  // jsonq keeps one generation at .1 and the reader opens only the live file,
  // so without this the missing half reads as a whole count.
  const live = path.join(DIR, 'filters.jsonl');
  fs.writeFileSync(live, '');
  assert.strictEqual(drive(['rotated', live, '1000']), 'false', 'no .1 yet');

  fs.writeFileSync(live + '.1', '');
  fs.utimesSync(live + '.1', 500, 500);
  assert.strictEqual(drive(['rotated', live, '1000']), 'false',
    'a rotation older than the window costs it nothing');

  fs.utimesSync(live + '.1', 2000, 2000);
  assert.strictEqual(drive(['rotated', live, '1000']), 'true');
});

test('reduction reports nulls rather than zero when there is nothing to measure', { skip }, () => {
  const out = JSON.parse(drive(['reduction'], JSON.stringify([])));
  assert.strictEqual(out.reduction_ratio, null);
  assert.strictEqual(out.median_call_ratio, null);
  assert.strictEqual(out.calls, 0);
});

test('reduction labels itself a ratio, not a savings claim', { skip }, () => {
  const out = JSON.parse(drive(['reduction'], JSON.stringify([rec({})])));
  assert.match(out.measures, /not a savings claim/,
    'the counterfactual is unobservable — the wording is the guard against implying it');
});

test('the counter file reader skips junk lines and honours the cutoff', { skip }, () => {
  const f = path.join(DIR, 'filters.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify(rec({ t: 100 })),      // too old
    JSON.stringify(rec({ t: 3000 })),
    '{"partial": ',                        // a half-written append
    '',
    '"not an object"',
    JSON.stringify(rec({ t: 4000 })),
  ].join('\n'));
  const got = JSON.parse(drive(['readrecs', f, '1000', 't']));
  assert.deepStrictEqual(got.map((r) => r.t), [3000, 4000]);
});

test('a missing counter file reads as empty, not as an error', { skip }, () => {
  assert.deepStrictEqual(JSON.parse(drive(['readrecs', path.join(DIR, 'nope'), '0', 't'])), []);
});

// jsonq writes this file and otelq reads it, with no shared constant between
// them. Drifting the two paths apart yields a reduction report that is
// permanently empty while each side looks correct on its own, so the only
// assertion worth making runs both tools against one XDG_DATA_HOME.
test('otelq reads the counter file jsonq actually writes', { skip }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'otelq-xdg-'));
  dirs.push(home);
  const doc = path.join(home, 'doc.json');
  fs.writeFileSync(doc, JSON.stringify({ a: [1, 2, 3] }));
  const JSONQ = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_jsonq');

  execFileSync(python, [JSONQ, 'len(d["a"])', doc], {
    encoding: 'utf8', env: Object.assign({}, process.env, { XDG_DATA_HOME: home }),
  });

  const out = JSON.parse(otelq(['savings', 'reduction'], undefined,
    { XDG_DATA_HOME: home }).out);
  assert.strictEqual(out.calls, 1, 'otelq must find the record jsonq just wrote');
  assert.strictEqual(out.calls_measured, 1);
  assert.strictEqual(out.bytes_in, fs.statSync(doc).size);
  assert.ok(out.reduction_ratio > 1, 'a filtered query reads more than it prints');
});

// otelq hardcodes its backend ports and claude-otel/docker-compose.yml publishes them, with
// no shared source between them. Rather than template one from the other, pin them together:
// a port changed on either side fails here instead of surfacing as a stack that reports
// unreachable. Tempo is in this list because `ready` probes it while nothing queries it —
// that asymmetry is exactly the kind that rots unwatched.
test('every otelq backend port is published by the compose stack', () => {
  const compose = fs.readFileSync(
    path.join(__dirname, '..', 'home', 'claude-otel', 'docker-compose.yml'), 'utf8');
  // Read the loopback candidate of each backend. It stays first in the tuple
  // because that is the one the PC's compose stack publishes; the second is the
  // cluster address, which no compose file knows about.
  const consts = Object.fromEntries(
    [...SRC.matchAll(/^(LOKI|PROM|TEMPO)_BASES = \("http:\/\/127\.0\.0\.1:(\d+)"/gm)]
      .map((m) => [m[1], m[2]]));
  assert.deepStrictEqual(Object.keys(consts).sort(), ['LOKI', 'PROM', 'TEMPO'],
    'otelq should define exactly the three backend constants this test knows about');
  for (const [name, port] of Object.entries(consts)) {
    assert.ok(compose.includes(`"127.0.0.1:${port}:${port}"`),
      `${name} uses port ${port}, which docker-compose.yml does not publish on 127.0.0.1`);
  }
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
