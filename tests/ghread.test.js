// Regression guard for home/dot_local/bin/executable_ghread.
// ghread carries a blanket `Bash(ghread:*)` allow rule on the unsandboxed path, and that
// rule is defensible only while every gh invocation is built from constants: `api` sends a
// GET with a field only ever as a raw query parameter and no body, `graphql` is the one POST
// and carries a single document with no mutation in it, no caller text can become a flag,
// --out cannot leave scratch, and the caller's environment cannot choose gh. ghread looks gh up in fixed directories, never $PATH, so the tests load it
// as a module and point GH_DIRS at a fake `gh` that prints the argv it was given. Each test
// asserts the exact invocation, and an empty stdout proves gh was never started.
// The quota ledger module path is a seam too, pointed at a missing file unless a test hands
// it a fake, so no test run records into a host's real ledger.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { srcPath } = require('./lib/paths');
const { run } = require('./lib/run');

const GHREAD = srcPath('dot_local', 'bin', 'executable_ghread');

let skip = false;
try {
  execFileSync('python3', ['--version'], { stdio: 'ignore' });
} catch {
  skip = 'python3 unavailable';
}

const DIR = scratch(os.tmpdir(), 'ghread-');
const BIN = path.join(DIR, 'bin');
const DECOY = path.join(DIR, 'decoy');
fs.mkdirSync(BIN);
fs.mkdirSync(DECOY);
// The absolute node path in the shebang matters: ghread pins gh's PATH to system
// directories, where `env node` would not find an fnm-managed node.
fs.writeFileSync(path.join(BIN, 'gh'), `#!${process.execPath}
if (process.env.FAKE_GH_ENV) {
  process.stdout.write(JSON.stringify({ host: process.env.GH_HOST ?? null, path: process.env.PATH }));
} else {
  process.stdout.write(JSON.stringify(process.argv.slice(2)));
}
`);
fs.writeFileSync(path.join(DECOY, 'gh'), `#!${process.execPath}\nprocess.stdout.write('DECOY');\n`);
for (const dir of [BIN, DECOY]) fs.chmodSync(path.join(dir, 'gh'), 0o755);

const SEAM = `
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader('ghread', sys.argv[1])
mod = importlib.util.module_from_spec(importlib.util.spec_from_loader('ghread', loader))
loader.exec_module(mod)
mod.GH_DIRS = (sys.argv[2],)
mod.GH_QUOTA = sys.argv[3]
sys.exit(mod.main(sys.argv[4:]))
`;
const NO_QUOTA = path.join(DIR, 'no-gh-quota.py');

function ghread(args, env = {}, { quota = NO_QUOTA, cwd } = {}) {
  return run('python3', ['-c', SEAM, GHREAD, BIN, quota, ...args], {
    cwd,
    env: { ...process.env, TMPDIR: DIR, ...env },
  });
}

// A quota module that writes what ghread handed record() to `out`: the environment only as
// the keys the tests read, so no token lands on disk.
function fakeQuota(dir, out) {
  const file = path.join(dir, 'gh_quota.py');
  fs.writeFileSync(file, `import json
KEYS = ("CLAUDE_CODE_SESSION_ID", "GH_QUOTA_DIR", "GH_HOST", "PATH")
def record(args, env=None, gh="gh"):
    with open(${JSON.stringify(out)}, "w") as f:
        json.dump({"args": list(args), "env": {k: env[k] for k in KEYS if k in env}, "gh": gh}, f)
`);
  return file;
}

function argvOf(args) {
  const r = ghread(args);
  assert.strictEqual(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('pr view builds a fixed invocation with each value inside its flag', { skip }, () => {
  assert.deepStrictEqual(
    argvOf(['pr', 'view', '42', '-R', 'o/r', '--json', 'title,state']),
    ['pr', 'view', '--repo=o/r', '--json=title,state', '--', '42']);
});

test('api builds a GET: no method, field, body or graphql flag', { skip }, () => {
  const argv = argvOf(['api', 'repos/o/r/pulls', '--paginate', '--jq', '.[] | select(.n > 1)']);
  assert.deepStrictEqual(argv,
    ['api', '--paginate', '--jq=.[] | select(.n > 1)', '--', 'repos/o/r/pulls']);
  for (const flag of ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input']) {
    assert.ok(!argv.some((a) => a === flag || a.startsWith(`${flag}=`)), flag);
  }
});

test('api sends fields only as raw query parameters on a pinned GET', { skip }, () => {
  // gh switches to POST once a field is present, so the GET must be pinned even when the
  // caller passes no -X.
  for (const method of [[], ['-X', 'GET']]) {
    assert.deepStrictEqual(
      argvOf(['api', ...method, 'search/issues', '-f', 'q=repo:o/r is:open', '-F', 'per_page=10']),
      ['api', '--method=GET', '--raw-field=q=repo:o/r is:open', '--raw-field=per_page=10',
        '--', 'search/issues']);
  }
});

test('graphql posts one query document to the fixed endpoint, variables typed by -F', { skip }, () => {
  const query = 'query($n: Int!) {\n  repository(owner: "o", name: "r") { a: pullRequest(number: $n) { state } }\n}';
  assert.deepStrictEqual(
    argvOf(['graphql', '-f', `query=${query}`, '-F', 'n=4956', '-f', 'owner=o', '--paginate',
      '--jq', '.data']),
    ['api', `--raw-field=query=${query}`, '--raw-field=owner=o', '--field=n=4956', '--paginate',
      '--jq=.data', '--', 'graphql']);
});

test('graphql refuses a write operation, a missing query and a file read without starting gh', { skip }, () => {
  const refused = [
    [['graphql', '-f', 'query=mutation { addStar(input: {starrableId: "x"}) { clientMutationId } }'], /mutation/],
    [['graphql', '-f', 'query=MUTATION{x}'], /mutation/],
    [['graphql', '-f', 'query=subscription { x }'], /subscription/],
    [['graphql', '-f', 'query={ a }', '-f', 'query=mutation { b }'], /second query/],
    [['graphql', '-f', 'query={ a }', '-f', 'query[]=mutation { b }'], /one plain query/],
    [['graphql', '-f', 'query={ a }', '-f', 'operationName[]=b'], /one plain query/],
    [['graphql', '-F', 'n=1'], /needs -f query/],
    [['graphql', '-f', 'query={ a }', '-F', 'v=@/etc/passwd'], /read a file/],
    [['graphql', '-f', 'query={ a \x1b }'], /control character/],
  ];
  for (const [args, message] of refused) {
    const r = ghread(args);
    assert.strictEqual(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, message, args.join(' '));
    assert.strictEqual(r.stdout, '', `${args.join(' ')} reached gh`);
  }
});

test('search puts the query after -- so a term cannot become a flag', { skip }, () => {
  assert.deepStrictEqual(
    argvOf(['search', 'prs', '-R', 'o/r', '--state', 'open', '-q', '.[].url', '--json', 'url',
      '--', '-label:bug', 'flaky']),
    ['search', 'prs', '--repo=o/r', '--state=open', '--json=url', '--jq=.[].url',
      '--', '-label:bug', 'flaky']);
  // A term before an option keeps its place ahead of the terms after --.
  assert.deepStrictEqual(
    argvOf(['search', 'issues', 'flaky', '--state', 'closed', '--', '-label:bug']),
    ['search', 'issues', '--state=closed', '--', 'flaky', '-label:bug']);
});

test('pr comments reads review or issue comments through the REST path', { skip }, () => {
  assert.deepStrictEqual(argvOf(['pr', 'comments', '7', '-R', 'o/r']),
    ['api', '--paginate', '--', 'repos/o/r/pulls/7/comments']);
  assert.deepStrictEqual(argvOf(['pr', 'comments', '7', '--kind', 'issue']),
    ['api', '--paginate', '--', 'repos/{owner}/{repo}/issues/7/comments']);
});

test('run logs and run view pass --attempt through to gh run view', { skip }, () => {
  assert.deepStrictEqual(
    argvOf(['run', 'logs', '42', '-R', 'o/r', '--attempt', '1', '--failed']),
    ['run', 'view', '--repo=o/r', '--attempt=1', '--log-failed', '--', '42']);
  assert.deepStrictEqual(
    argvOf(['run', 'logs', '42', '--job', '7', '-a', '2']),
    ['run', 'view', '--job=7', '--attempt=2', '--log', '--', '42']);
  assert.deepStrictEqual(
    argvOf(['run', 'view', '42', '--attempt', '1', '--json', 'attempt']),
    ['run', 'view', '--attempt=1', '--json=attempt', '--', '42']);
});

test('run logs refuses an --attempt that is not a positive number without starting gh', { skip }, () => {
  for (const attempt of ['0', '1x', '--web']) {
    const r = ghread(['run', 'logs', '42', `--attempt=${attempt}`]);
    assert.strictEqual(r.code, 2, `${attempt}: ${r.stderr}`);
    assert.match(r.stderr, /refusing --attempt/, attempt);
    assert.strictEqual(r.stdout, '', `${attempt} reached gh`);
  }
});

test('refuses writes, graphql and flag injection without starting gh', { skip }, () => {
  const refused = [
    ['api', 'repos/o/r/issues', '-X', 'POST'],
    ['api', 'repos/o/r/issues', '--method', 'POST'],
    ['api', 'repos/o/r/issues', '-X', 'POST', '-f', 'title=x'],
    ['api', 'search/issues', '-F', 'q=@/etc/passwd'],
    ['api', 'search/issues', '-F', 'q=@-'],
    ['api', 'search/issues', '-f', 'novalue'],
    ['api', 'search/issues', '-f', 'a b=c'],
    ['search', 'issues', '--web', 'x'],
    ['api', 'repos/o/r/issues', '--input', 'body.json'],
    ['api', 'graphql'],
    ['api', 'https://evil.example/x'],
    ['pr', 'merge', '1'],
    ['pr', 'comment', '1'],
    ['issue', 'close', '1'],
    ['pr', 'view', '--', '--web'],
    ['pr', 'view', '1', '-R', '--hostname=evil'],
  ];
  for (const args of refused) {
    const r = ghread(args);
    assert.strictEqual(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.strictEqual(r.stdout, '', `${args.join(' ')} reached gh`);
  }
});

test('refuses a --jq expression that reads the environment', { skip }, () => {
  for (const expr of ['$ENV', '$ENV.GH_TOKEN', 'env.HOME']) {
    const r = ghread(['api', 'user', '--jq', expr]);
    assert.strictEqual(r.code, 2, expr);
    assert.strictEqual(r.stdout, '', expr);
  }
});

test('--out writes gh output to a file under the scratch root', { skip }, (t) => {
  const out = path.join(scratch(DIR, 'out-', t), 'pr.json');
  const r = ghread(['pr', 'view', '1', '--out', out]);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), ['pr', 'view', '--', '1']);
});

test('--out outside scratch is refused, even with TMPDIR pointed at it', { skip }, () => {
  const outside = path.join(os.homedir(), `ghread-must-not-exist-${process.pid}`);
  const r = ghread(['pr', 'view', '1', '--out', outside], { TMPDIR: os.homedir() });
  assert.strictEqual(r.code, 2, r.stderr);
  assert.match(r.stderr, /outside the scratch roots/);
  assert.strictEqual(r.stdout, '');
  assert.ok(!fs.existsSync(outside));
});

test('--out refuses a symlink or a hard link as the target', { skip }, (t) => {
  const dir = scratch(DIR, 'links-', t);
  const victim = path.join(dir, 'victim');
  fs.writeFileSync(victim, 'keep');
  fs.symlinkSync(victim, path.join(dir, 'soft'));
  fs.linkSync(victim, path.join(dir, 'hard'));
  for (const name of ['soft', 'hard']) {
    const r = ghread(['pr', 'view', '1', '--out', path.join(dir, name)]);
    assert.strictEqual(r.code, 2, `${name}: ${r.stderr}`);
    assert.strictEqual(r.stdout, '');
  }
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep');
});

test('the caller cannot choose gh through PATH or aim it at another host', { skip }, () => {
  // A gh earlier on PATH is never run: ghread looks only in its fixed directories.
  const viaPath = ghread(['pr', 'view', '1'], { PATH: `${DECOY}:${process.env.PATH}` });
  assert.strictEqual(viaPath.code, 0, viaPath.stderr);
  assert.notStrictEqual(viaPath.stdout, 'DECOY');
  assert.deepStrictEqual(JSON.parse(viaPath.stdout), ['pr', 'view', '--', '1']);
  const env = ghread(['pr', 'view', '1'],
    { FAKE_GH_ENV: '1', GH_HOST: 'evil.example', PATH: `${DECOY}:${process.env.PATH}` });
  assert.strictEqual(env.code, 0, env.stderr);
  const seen = JSON.parse(env.stdout);
  assert.strictEqual(seen.host, null);
  assert.ok(!seen.path.includes(DECOY), seen.path);
});

test('records the gh argv, the environment gh runs in and the gh it resolved', { skip }, (t) => {
  const dir = scratch(DIR, 'quota-', t);
  const out = path.join(dir, 'recorded.json');
  const r = ghread(['pr', 'list', '-R', 'o/r', '--limit', '1'], {
    CLAUDE_CODE_SESSION_ID: 'session-1',
    GH_HOST: 'evil.example',
    GH_QUOTA_DIR: dir,
    PATH: `${DECOY}:${process.env.PATH}`,
  }, { quota: fakeQuota(dir, out) });
  assert.strictEqual(r.code, 0, r.stderr);
  const { args, env, gh } = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepStrictEqual(args, JSON.parse(r.stdout));
  assert.strictEqual(gh, path.join(BIN, 'gh'));
  // The ledger keys on the session id, and a caller must not move the ledger's directory.
  assert.strictEqual(env.CLAUDE_CODE_SESSION_ID, 'session-1');
  assert.ok(!('GH_QUOTA_DIR' in env));
  assert.ok(!('GH_HOST' in env));
  assert.ok(!env.PATH.includes(DECOY), env.PATH);
});

test('a quota module that fails to load or to record leaves the call unchanged', { skip }, (t) => {
  const broken = {
    raises: 'raise RuntimeError("boom")\n',
    syntax: 'def (\n',
    record: 'def record(*a, **k):\n    raise ValueError("boom")\n',
  };
  for (const [name, source] of Object.entries(broken)) {
    const file = path.join(scratch(DIR, `quota-${name}-`, t), 'gh_quota.py');
    fs.writeFileSync(file, source);
    const r = ghread(['pr', 'view', '1'], {}, { quota: file });
    assert.strictEqual(r.code, 0, `${name}: ${r.stderr}`);
    assert.deepStrictEqual(JSON.parse(r.stdout), ['pr', 'view', '--', '1'], name);
  }
});

test('the caller cannot choose the quota module through PYTHONPATH or the cwd', { skip }, (t) => {
  const dir = scratch(DIR, 'quota-planted-', t);
  const marker = path.join(dir, 'loaded');
  fs.writeFileSync(path.join(dir, 'gh_quota.py'),
    `open(${JSON.stringify(marker)}, "w").close()\ndef record(*a, **k): pass\n`);
  const r = ghread(['pr', 'view', '1'], { PYTHONPATH: dir }, { cwd: dir });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), ['pr', 'view', '--', '1']);
  assert.ok(!fs.existsSync(marker), 'a planted gh_quota.py was loaded');
});

// `run failures` makes several dependent gh calls, so it runs against a second fake gh that
// answers from a routes file and logs every argv it was given. A route is keyed on the api
// path, or for `run view --log` on its `--job=` flag.
const ROUTED_BIN = path.join(DIR, 'routed-bin');
fs.mkdirSync(ROUTED_BIN);
fs.writeFileSync(path.join(ROUTED_BIN, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(argv) + '\\n');
const key = argv[0] === 'run' ? argv.find((a) => a.startsWith('--job=')) : argv.at(-1);
const route = JSON.parse(fs.readFileSync(process.env.FAKE_GH_ROUTES, 'utf8'))[key];
if (route === undefined) { process.stderr.write('no route'); process.exit(4); }
process.stdout.write(typeof route === 'string' ? route : JSON.stringify(route));
`);
fs.chmodSync(path.join(ROUTED_BIN, 'gh'), 0o755);

function failures(t, args, routes) {
  const dir = scratch(DIR, 'failures-', t);
  const calls = path.join(dir, 'calls');
  fs.writeFileSync(calls, '');
  fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify(routes));
  const r = run('python3', ['-c', SEAM, GHREAD, ROUTED_BIN, NO_QUOTA, 'run', 'failures', ...args], {
    env: {
      ...process.env,
      TMPDIR: DIR,
      FAKE_GH_CALLS: calls,
      FAKE_GH_ROUTES: path.join(dir, 'routes.json'),
    },
  });
  const argvs = fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { ...r, argvs };
}

const R = 'repos/o/r';
const SHA = 'abc1234def5678abc1234def5678abc1234def56';
// A log as `gh run view --log` prints it: job, step and timestamp ahead of every line.
function logOf(lines) {
  return lines.map((l, i) => `gate\ttest\t${i ? '' : '\ufeff'}2026-11-15T10:00:0${i}.1234567Z ${l}`)
    .join('\n');
}

function failedRun(id, job, log, annotations = []) {
  return {
    [`${R}/actions/runs/${id}`]: { name: 'CI', conclusion: 'failure', html_url: `https://gh/run/${id}` },
    [`${R}/actions/runs/${id}/jobs`]: {
      jobs: [
        { id: job, name: 'gate', conclusion: 'failure', html_url: `https://gh/job/${job}`,
          check_run_url: `https://api.github.com/${R}/check-runs/${job + 1}`,
          steps: [{ name: 'checkout', conclusion: 'success' }, { name: 'test', conclusion: 'failure' }] },
        { id: job + 100, name: 'lint', conclusion: 'success' },
      ],
    },
    [`--job=${job}`]: log,
    [`${R}/check-runs/${job + 1}/annotations`]: annotations,
  };
}

test('run failures prints each failed job with its pytest ids, assertion lines and annotations', { skip }, (t) => {
  const log = logOf([
    '============ test session starts ============',
    'tests/test_a.py::test_ok PASSED',
    'E       assert 1 == 2',
    'E        +  where 1 = f()',
    '\x1b[31mFAILED\x1b[0m tests/test_a.py::test_sum - assert 1 == 2',
    '======= 1 failed, 4 passed in 0.12s =======',
    '##[error]Process completed with exit code 1.',
  ]);
  const r = failures(t, ['42', '-R', 'o/r'], failedRun(42, 7, log, [
    { path: 'tests/test_a.py', start_line: 12, annotation_level: 'failure', message: 'assert\n  1 == 2' },
  ]));
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.stdout, [
    'run 42 CI (failure) https://gh/run/42',
    '  job gate (failure) https://gh/job/7',
    '    failed steps: test',
    '    failing tests:',
    '      tests/test_a.py::test_sum',
    '    errors:',
    '      E       assert 1 == 2',
    '      E        +  where 1 = f()',
    '      ======= 1 failed, 4 passed in 0.12s =======',
    '      ##[error]Process completed with exit code 1.',
    '    annotations:',
    '      failure tests/test_a.py:12 assert 1 == 2',
    '',
  ].join('\n'));
  // Every call is an api GET or a run view, with its one positional after --.
  for (const argv of r.argvs) {
    assert.ok(argv[0] === 'api' || argv.slice(0, 2).join(' ') === 'run view', JSON.stringify(argv));
    assert.strictEqual(argv.at(-2), '--', JSON.stringify(argv));
    assert.ok(argv.every((a) => !a.startsWith('--method=') || a === '--method=GET'), JSON.stringify(argv));
    assert.ok(!argv.some((a) => a.startsWith('--input')), JSON.stringify(argv));
  }
  assert.ok(r.argvs.some((a) => a.join(' ') === 'run view --repo=o/r --job=7 --log -- 42'));
  assert.ok(r.argvs.some((a) => a.join(' ') ===
    `api --method=GET --raw-field=filter=latest --raw-field=per_page=100 -- ${R}/actions/runs/42/jobs`));
});

test('run failures --pr reads the failed runs on the PR head and node:test failures', { skip }, (t) => {
  const log = logOf([
    'not ok 3 - refuses a symlink',
    '  ---',
    '  error: |-',
    '    paths drifted from the allowlist:',
    '      added: x',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '# pass 11',
    '# fail 1',
  ]);
  const r = failures(t, ['--pr', '5', '-R', 'o/r'], {
    [`${R}/pulls/5`]: { head: { sha: SHA } },
    [`${R}/actions/runs`]: { workflow_runs: [
      { id: 90, conclusion: 'success' }, { id: 91, conclusion: 'failure' }] },
    ...failedRun(91, 8, log),
  });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /^run 91 CI/);
  assert.doesNotMatch(r.stdout, /run 90/);
  assert.match(r.stdout, /failing tests:\n {6}refuses a symlink\n/);
  assert.match(r.stdout, /errors:\n {10}paths drifted from the allowlist:\n/);
  assert.doesNotMatch(r.stdout, /added: x/);
  assert.match(r.stdout, /AssertionError \[ERR_ASSERTION\]: Expected values/);
  assert.match(r.stdout, /# fail 1/);
  assert.ok(r.argvs.some((a) => a.join(' ') ===
    `api --method=GET --raw-field=head_sha=${SHA} --raw-field=per_page=100 -- ${R}/actions/runs`));
});

test('run failures resolves a short sha and says when nothing failed', { skip }, (t) => {
  const r = failures(t, ['abc1234'], {
    'repos/{owner}/{repo}/commits/abc1234': { sha: SHA },
    'repos/{owner}/{repo}/actions/runs': { workflow_runs: [{ id: 90, conclusion: 'success' }] },
  });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.stdout, 'no failed runs\n');
});

test('run failures passes on the status of a gh call that fails', { skip }, (t) => {
  const r = failures(t, ['42', '-R', 'o/r'], {});
  assert.strictEqual(r.code, 4);
  assert.match(r.stderr, /actions\/runs\/42: no route/);
});

test('run failures refuses a malformed or ambiguous target without starting gh', { skip }, (t) => {
  const refused = [
    [[], /needs exactly one/],
    [['42', '--pr', '5'], /needs exactly one/],
    [['main'], /refusing run id or sha 'main'/],
    [['ABC1234'], /refusing run id or sha/],
    [['--pr', '5x'], /refusing --pr/],
    [['--web'], /unrecognized arguments: --web/],
  ];
  for (const [args, message] of refused) {
    const r = failures(t, args, {});
    assert.strictEqual(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, message, args.join(' '));
    assert.deepStrictEqual(r.argvs, [], `${args.join(' ')} reached gh`);
  }
});
