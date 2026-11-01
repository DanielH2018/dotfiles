// Regression guard for home/dot_local/bin/executable_runlog.
// runlog carries an auto-mode allow entry that says it runs exactly the argv after `--` and
// writes only its own log file, and claude_guard judges it as the command it runs. These tests
// pin the four properties those entries rest on: where the log goes, that a variable cannot
// move it, that the child gets blocking stdio and /dev/null, and that a usage error runs
// nothing. Each run gets its own HOME, TMPDIR and session id.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { skipUnless } = require('./lib/probe');
const { srcPath } = require('./lib/paths');

const TOOL = srcPath('dot_local', 'bin', 'executable_runlog');
const skip = skipUnless('python3');

function run(t, args, { env = {}, input } = {}) {
  const home = scratch(os.tmpdir(), 'runlog-home-', t);
  const tmp = scratch(os.tmpdir(), 'runlog-tmp-', t);
  const r = spawnSync('python3', ['-I', TOOL, ...args], {
    encoding: 'utf8',
    input,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmp, CLAUDE_CODE_SESSION_ID: 'sess-1', ...env },
  });
  return { ...r, home, tmp };
}

const logPath = (stdout) => /^log: (.*)$/m.exec(stdout)?.[1];

test('merges stdout and stderr into the session log and exits with the command code', { skip }, (t) => {
  const r = run(t, ['probe', '--', 'sh', '-c', 'echo out; echo err >&2; exit 3']);
  assert.strictEqual(r.status, 3, r.stderr);
  const log = logPath(r.stdout);
  assert.strictEqual(log, path.join(fs.realpathSync(r.tmp), 'claude-runlog', 'sess-1', 'probe.log'));
  assert.deepStrictEqual(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).sort(), ['err', 'out']);
  assert.match(r.stdout, /\nexit: 3\n$/);
});

test('gives the command /dev/null and a blocking stdout', { skip }, (t) => {
  const probe = 'import os,sys; print(os.get_blocking(1), repr(sys.stdin.read()))';
  const r = run(t, ['stdio', '--', 'python3', '-I', '-c', probe], { input: 'piped data\n' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(logPath(r.stdout), 'utf8'), "True ''\n");
});

test('uses the job dir only when it sits under ~/.claude/jobs', { skip }, (t) => {
  const home = scratch(os.tmpdir(), 'runlog-jobhome-', t);
  const job = path.join(home, '.claude', 'jobs', 'abc123');
  fs.mkdirSync(job, { recursive: true });
  let r = run(t, ['injob', '--', 'true'], { env: { HOME: home, CLAUDE_JOB_DIR: job } });
  assert.strictEqual(logPath(r.stdout), path.join(fs.realpathSync(job), 'tmp', 'injob.log'));
  // A job dir anywhere else, such as a repo checkout, is ignored for the session directory.
  const elsewhere = scratch(os.tmpdir(), 'runlog-notjob-', t);
  r = run(t, ['outside', '--', 'true'], { env: { CLAUDE_JOB_DIR: elsewhere } });
  assert.ok(logPath(r.stdout).includes(`${path.sep}claude-runlog${path.sep}sess-1${path.sep}`), r.stdout);
  assert.ok(!fs.existsSync(path.join(elsewhere, 'tmp')));
});

test('falls back to /tmp when TMPDIR points outside it', { skip }, (t) => {
  const session = `runlog-test-${process.pid}`;
  t.after(() => fs.rmSync(path.join('/tmp', 'claude-runlog', session), { recursive: true, force: true }));
  const r = run(t, ['fallback', '--', 'true'], {
    env: { TMPDIR: os.homedir(), CLAUDE_CODE_SESSION_ID: session },
  });
  assert.strictEqual(logPath(r.stdout), path.join(fs.realpathSync('/tmp'), 'claude-runlog', session, 'fallback.log'));
});

test('a usage error runs nothing and writes no log', { skip }, (t) => {
  for (const args of [
    ['../x', '--', 'true'],
    ['a/b', '--', 'true'],
    ['', '--', 'true'],
    ['name', 'true'],
    ['name', '--'],
    ['name', '--tail', 'x', '--', 'true'],
    ['name', '--', 'runlog', 'inner', '--', 'true'],
    [],
  ]) {
    const r = run(t, args);
    assert.strictEqual(r.status, 2, `${JSON.stringify(args)}: ${r.stdout}`);
    assert.ok(!fs.existsSync(path.join(r.tmp, 'claude-runlog')), JSON.stringify(args));
  }
});

test('--tail limits the echoed lines, and a missing command exits 127', { skip }, (t) => {
  let r = run(t, ['tail', '--tail', '2', '--', 'sh', '-c', 'printf "1\\n2\\n3\\n4\\n"']);
  assert.match(r.stdout, /^log: .*\n3\n4\nexit: 0\n$/);
  r = run(t, ['gone', '--', 'no-such-command-runlog']);
  assert.strictEqual(r.status, 127);
  assert.match(fs.readFileSync(logPath(r.stdout), 'utf8'), /no-such-command-runlog/);
});
