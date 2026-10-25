// Regression guard for home/dot_local/bin/executable_gh-rerun-failed.
// It carries a `Bash(gh-rerun-failed:*)` allow rule, which is defensible only while the one
// write it makes is `gh run rerun --failed` on a finished, failed run in a repo the gh login
// owns. Like ghread's tests, these load it as a module and point GH_DIRS at a fake `gh`. The
// fake answers the three preflight reads from FAKE_* variables and appends every argv it
// receives to a log, so each test asserts the whole call sequence, and a refusal is proven by
// `run rerun` never appearing in it.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { srcPath } = require('./lib/paths');
const { run } = require('./lib/run');

const TOOL = srcPath('dot_local', 'bin', 'executable_gh-rerun-failed');

let skip = false;
try {
  execFileSync('python3', ['--version'], { stdio: 'ignore' });
} catch {
  skip = 'python3 unavailable';
}

const DIR = scratch(os.tmpdir(), 'gh-rerun-failed-');
const BIN = path.join(DIR, 'bin');
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(argv) + '\\n');
const has = (a) => argv.includes(a);
if (argv[0] === 'api' && argv.at(-1) === 'user') {
  process.stdout.write(process.env.FAKE_LOGIN + '\\n');
} else if (argv[0] === 'repo' && argv[1] === 'view') {
  const flag = argv.find((a) => a.startsWith('--repo='));
  process.stdout.write((flag ? flag.slice(7) : 'Owner/cwd-repo') + '\\n');
} else if (argv[0] === 'run' && argv[1] === 'view') {
  process.stdout.write(process.env.FAKE_RUN);
} else if (!(argv[0] === 'run' && argv[1] === 'rerun' && has('--failed'))) {
  process.exit(9);
}
`);
fs.chmodSync(path.join(BIN, 'gh'), 0o755);

const SEAM = `
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader('rerun', sys.argv[1])
mod = importlib.util.module_from_spec(importlib.util.spec_from_loader('rerun', loader))
loader.exec_module(mod)
mod.GH_DIRS = (sys.argv[2],)
sys.exit(mod.main(sys.argv[3:]))
`;

const FAILED_RUN = JSON.stringify({ status: 'completed', conclusion: 'failure', attempt: 1 });
const PREFLIGHT = (repo) => [
  ['api', '--jq=.login', '--', 'user'],
  ['repo', 'view', ...(repo ? [`--repo=${repo}`] : []), '--json=nameWithOwner',
    '--jq=.nameWithOwner'],
];

function rerun(t, args, { login = 'owner', runJson = FAILED_RUN } = {}) {
  const log = path.join(scratch(DIR, 'log-', t), 'argv.jsonl');
  fs.writeFileSync(log, '');
  const r = run('python3', ['-c', SEAM, TOOL, BIN, ...args], {
    env: { ...process.env, FAKE_GH_LOG: log, FAKE_LOGIN: login, FAKE_RUN: runJson },
  });
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  return { ...r, calls };
}

test('re-runs only the failed jobs, on the repository gh resolved', { skip }, (t) => {
  const r = rerun(t, ['4567', '-R', 'Owner/repo']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(r.calls, [
    ...PREFLIGHT('Owner/repo'),
    ['run', 'view', '--repo=Owner/repo', '--json=status,conclusion,attempt', '--', '4567'],
    ['run', 'rerun', '--failed', '--repo=Owner/repo', '--', '4567'],
  ]);
});

test('without -R the cwd repository is resolved and passed explicitly', { skip }, (t) => {
  const r = rerun(t, ['4567']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(r.calls.at(-1),
    ['run', 'rerun', '--failed', '--repo=Owner/cwd-repo', '--', '4567']);
});

test('refuses a repository the gh login does not own', { skip }, (t) => {
  const r = rerun(t, ['4567', '-R', 'someone-else/repo']);
  assert.strictEqual(r.code, 2, r.stderr);
  assert.match(r.stderr, /belongs to someone-else/);
  assert.deepStrictEqual(r.calls, PREFLIGHT('someone-else/repo'));
});

test('refuses a run that is not a finished failure under the attempt cap', { skip }, (t) => {
  const cases = [
    [{ status: 'in_progress', conclusion: '', attempt: 1 }, /only a finished failure/],
    [{ status: 'completed', conclusion: 'success', attempt: 1 }, /only a finished failure/],
    [{ status: 'completed', conclusion: 'failure', attempt: 3 }, /attempt 3 has reached 3/],
  ];
  for (const [runState, message] of cases) {
    const r = rerun(t, ['4567', '-R', 'owner/repo'], { runJson: JSON.stringify(runState) });
    assert.strictEqual(r.code, 2, JSON.stringify(runState));
    assert.match(r.stderr, message);
    assert.ok(!r.calls.some((c) => c[1] === 'rerun'), JSON.stringify(runState));
  }
});

test('refuses a flag-shaped run id or repo, and gh flags that do not exist here', { skip }, (t) => {
  for (const args of [['--', '-5'], ['12x'], ['1', '-R', '--hostname=evil'], ['1', '--job', '9'],
    ['1', '--debug']]) {
    const r = rerun(t, args);
    assert.strictEqual(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.deepStrictEqual(r.calls, [], `${args.join(' ')} reached gh`);
  }
});
