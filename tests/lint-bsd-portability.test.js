// bin/lint-bsd-portability exists because one audit found four GNU-only shell idioms in a
// single session, every one of them correct on the Linux host it was written on and broken on
// BSD/macOS userland. The regression fixtures below are the actual pre-fix blobs, pulled from
// git, so what is asserted is "this check would have caught the real bug" rather than "this
// check catches a sample I wrote to match my own regex".
//
// The sharpest of them is block-dangerous-bash.sh, which has to come out BOTH ways: the
// pre-fix version fires (its BDB_REPARSE carried a `\b` into [[ =~ ]], a live veto bypass on
// macOS) and the current version is clean (its remaining `\b`s are in grep -E rules, a
// different engine, and are deliberate). A rule that cannot do both is either dead or
// permanently noisy on the one file where a regression matters most.
//
// This file is itself on the linter's exclusion list -- it holds known-bad samples by
// construction -- which is why the literals below do not fail the repo-wide scan.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'bin', 'lint-bsd-portability');
const hookConfig = fs.readFileSync(path.join(REPO, '.pre-commit-config.yaml'), 'utf8');

function run(args) {
  return spawnSync('bash', [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8' });
}

function fixture(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-bsd-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

// A historical blob, written out under its original basename so the extension-driven half of
// the check sees what it saw at the time.
function atCommit(rev, repoPath) {
  const body = execFileSync('git', ['show', `${rev}:${repoPath}`], { cwd: REPO, encoding: 'utf8' });
  return fixture(path.basename(repoPath), body);
}

test('979b240: the mx-ergo solaar stub\'s bare `sed -i` fires, inside a JS template literal', () => {
  const r = run([atCommit('979b240^', 'tests/mx-ergo-resync.test.js')]);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /mx-ergo-resync\.test\.js:90: bare `sed -i`/);
  assert.match(r.stdout, /mx-ergo-resync\.test\.js:95: bare `sed -i`/);
});

test('25cc7e8: BDB_REPARSE\'s `\\b` fires through the variable, not just inline', () => {
  // The bug was assigned on one line and consumed by `[[ ! $s =~ $BDB_REPARSE ]]` twenty lines
  // later. A same-line-only rule would have missed the whole finding.
  const r = run([atCommit('25cc7e8^', 'home/private_dot_claude/hooks/executable_block-dangerous-bash.sh')]);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /block-dangerous-bash\.sh:116: `\\b` in BDB_REPARSE/);
});

test('the CURRENT block-dangerous-bash.sh is clean: its remaining `\\b`s are grep, not [[ =~ ]]', () => {
  const r = run([path.join(REPO, 'home/private_dot_claude/hooks/executable_block-dangerous-bash.sh')]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

test('6ebdaa4: mktemp templates with a suffix after the X\'s fire', () => {
  const r = run([atCommit('6ebdaa4^', 'home/private_dot_claude/sandbox/executable_claude-sandbox')]);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /claude-sandbox:834: mktemp template/);
  assert.match(r.stdout, /claude-sandbox:861: mktemp template/);
});

test('bare `sed -i` fires in its several spellings', () => {
  const cases = [
    'sed -i "s/a/b/" f\n',
    "sed -i 's/a/b/' f\n",
    'sudo sed -i -e "s/a/b/" f\n',
    'sed -E -i "s/a/b/" f\n',
    'sed --in-place "s/a/b/" f\n',
    'x="$(sed -i "s/a/b/" f)"\n',
    // An absolute path is how you invoke the system sed on purpose, which is exactly the case
    // that has to fire; `/` is left out of the leading-context class for this.
    '/usr/bin/sed -i "s/a/b/" f\n',
    '"$BINDIR/sed" -i "s/a/b/" f\n',
  ];
  for (const body of cases) {
    const r = run([fixture('t.sh', body)]);
    assert.strictEqual(r.status, 1, `expected a hit for: ${body.trim()}\n${r.stdout}`);
    assert.match(r.stdout, /bare `sed -i`/);
  }
});

test('portable sed forms pass', () => {
  const cases = [
    'sed -i.bak "s/a/b/" f && rm -f f.bak\n',
    "sed -n '1p' f\n",
    'sed -e "s/a/b/" f > g\n',
    // `-i` on another command is not sed's -i; grep's is case-insensitivity.
    'grep -i pattern f\n',
    'diff -i a b\n',
    // A word ending in "sed" is not sed.
    'parsed -i foo\n',
  ];
  for (const body of cases) {
    const r = run([fixture('t.sh', body)]);
    assert.strictEqual(r.status, 0, `false positive for: ${body.trim()}\n${r.stdout}`);
  }
});

test('`\\b` inside an inline [[ =~ ]] fires', () => {
  const r = run([fixture('t.sh', '[[ $cmd =~ \\b(eval|exec)\\b ]] && echo yes\n')]);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stdout, /Darwin's libc ERE has no word boundary/);
});

test('`\\b` in grep, rg and sed patterns is left alone -- different engine', () => {
  const cases = [
    "grep -E '\\b(eval|exec)\\b' f\n",
    "rg '\\bTODO\\b' .\n",
    "sed -E 's/\\bfoo\\b/bar/' f\n",
    "awk '/\\bfoo\\b/ { print }' f\n",
    // A [[ =~ ]] on the same line as a grep must not drag the grep's \b into the finding.
    "[[ $x =~ ^[0-9]+$ ]] && grep -E '\\bfoo' f\n",
    // The explicit form the audit replaced \b with.
    "[[ $x =~ (^|[^[:alnum:]_])(eval|exec)([^[:alnum:]_]|$) ]] && echo yes\n",
  ];
  for (const body of cases) {
    const r = run([fixture('t.sh', body)]);
    assert.strictEqual(r.status, 0, `false positive for: ${body.trim()}\n${r.stdout}`);
  }
});

test('a `\\b` regex assigned to a variable never used by [[ =~ ]] is left alone', () => {
  // Pattern 2 is scoped to regexes that reach bash's regcomp. A grep pattern held in a variable
  // is the common case and is correct.
  const r = run([fixture('t.sh', "PAT='\\bfoo\\b'\ngrep -E \"$PAT\" f\n")]);
  assert.strictEqual(r.status, 0, r.stdout);
});

test('mktemp templates pass when the X\'s are trailing', () => {
  const cases = [
    'f="$(mktemp "${TMPDIR:-/tmp}/x-XXXXXX")"\n',
    'd="$(mktemp -d)"\n',
    'mktemp -d /tmp/foo.XXXXXX\n',
    'f=$(mktemp -t toolXXXXXX)\n',
  ];
  for (const body of cases) {
    const r = run([fixture('t.sh', body)]);
    assert.strictEqual(r.status, 0, `false positive for: ${body.trim()}\n${r.stdout}`);
  }
});

test('mktemp templates fire when anything follows the X\'s', () => {
  const cases = [
    'f="$(mktemp "${TMPDIR:-/tmp}/compact-XXXXXX.json")"\n',
    'mktemp /tmp/foo.XXXXXX.sh\n',
    'mktemp -d /tmp/XXXXXX-work\n',
  ];
  for (const body of cases) {
    const r = run([fixture('t.sh', body)]);
    assert.strictEqual(r.status, 1, `expected a hit for: ${body.trim()}\n${r.stdout}`);
    assert.match(r.stdout, /mktemp template/);
  }
});

test('comment-only lines are not scanned, in shell or JavaScript', () => {
  // Every one of these bugs is now described in prose somewhere in the repo, including in the
  // linter's own header. None of it runs.
  const body = '# sed -i "s/a/b/" f\n'
    + '  // sed -i "s/a/b/" f\n'
    + '# [[ $x =~ \\bfoo ]]\n'
    + '# mktemp /tmp/a.XXXXXX.json\n';
  assert.strictEqual(run([fixture('t.sh', body)]).status, 0);
});

test('the whole tracked surface is clean, and silent', () => {
  // The no-argument path is the only one that derives the file list itself; prek passes only
  // changed files, so this is what makes the check a gate rather than a spot check.
  const r = run([]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(r.stdout, '', 'a clean tree must produce no output');
});

test('--list reaches the templates, the githooks and the extensionless scripts', () => {
  const listed = run(['--list']).stdout.split('\n').filter(Boolean);
  assert.ok(listed.length > 300, `expected the repo's script surface, saw ${listed.length}`);
  for (const expected of [
    '.githooks/pre-push',
    'home/private_dot_claude/sandbox/executable_claude-sandbox',
    'home/.chezmoitemplates/is-wsl',
    'home/dot_bashrc',
    'tests/mx-ergo-resync.test.js',
  ]) {
    assert.ok(listed.includes(expected), `${expected} is not being scanned`);
  }
  // The exclusions are paths, so a typo in one silently widens the check rather than narrowing
  // it -- assert the two that must stay out.
  assert.ok(!listed.includes('home/.chezmoitemplates/linux-install.sh'));
  assert.ok(!listed.some((f) => f.startsWith('home/.chezmoiscripts/os-linux/')));
});

test('the pre-commit hook admits every file the script scans', () => {
  // `files:` and the script's own list are maintained separately and drift in the direction
  // that loses coverage: a new extensionless script lands in a directory the pattern does not
  // name, the manual run keeps checking it, and the commit hook silently stops.
  const block = hookConfig.match(/entry: bin\/lint-bsd-portability[\s\S]*?files: (\(.*\))$/m);
  assert.ok(block, 'could not find the bsd-portability hook\'s files: pattern');
  const re = new RegExp(block[1]);

  const listed = run(['--list']).stdout.split('\n').filter(Boolean);
  const missed = listed.filter((f) => !re.test(f));
  assert.deepStrictEqual(missed, [],
    'these are scanned by bin/lint-bsd-portability but not matched by the hook\'s files: '
    + 'pattern, so they are checked only on a manual run. Widen the alternation in '
    + '.pre-commit-config.yaml.');
});
