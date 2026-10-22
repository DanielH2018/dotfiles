// Regression guard for home/dot_local/bin/executable_ghread.
// ghread carries a blanket `Bash(ghread:*)` allow rule on the unsandboxed path, and that
// rule is defensible only while every gh invocation is built from constants: GET only, a
// field only ever as a raw query parameter, no body and no graphql, no caller text that can
// become a flag, and an --out that cannot leave scratch. A fake `gh` first on PATH prints the argv it was given, so each
// test asserts the exact invocation, and an empty stdout proves gh was never started.
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
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'gh'),
  '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
fs.chmodSync(path.join(BIN, 'gh'), 0o755);

function ghread(args, env = {}) {
  return run('python3', [GHREAD, ...args], {
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, TMPDIR: DIR, ...env },
  });
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

test('search puts the query after -- so a term cannot become a flag', { skip }, () => {
  assert.deepStrictEqual(
    argvOf(['search', 'prs', '-R', 'o/r', '--state', 'open', '-q', '.[].url', '--json', 'url',
      '--', '-label:bug', 'flaky']),
    ['search', 'prs', '--repo=o/r', '--state=open', '--json=url', '--jq=.[].url',
      '--', '-label:bug', 'flaky']);
});

test('pr comments reads review or issue comments through the REST path', { skip }, () => {
  assert.deepStrictEqual(argvOf(['pr', 'comments', '7', '-R', 'o/r']),
    ['api', '--paginate', '--', 'repos/o/r/pulls/7/comments']);
  assert.deepStrictEqual(argvOf(['pr', 'comments', '7', '--kind', 'issue']),
    ['api', '--paginate', '--', 'repos/{owner}/{repo}/issues/7/comments']);
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
