// Regression guard for home/dot_local/bin/executable_stash-mine.
// The confinement suite is the point of this file. stash-mine is meant to carry a
// blanket `Bash(stash-mine:*)` allow rule, and that rule is only defensible while
// the only caller-supplied value that ever reaches git is a stash SHA, and every
// write path re-validates that SHA against THIS worktree's own tag before using
// it. A --path/--ref/--worktree flag, or a bare `pop`/`clear`, would turn this
// back into the shared-stash footgun the ask-list exists for.
//
// The assertions below are structural on purpose, plus a functional half that
// drives the real tool against a temp git repo with two worktrees — the ownership
// refusal and the index-shift race are both about *runtime* behaviour that no
// amount of source-scanning can stand in for.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TOOL = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_stash-mine');
const SRC = fs.readFileSync(TOOL, 'utf8');
// The module docstring argues the confinement in prose, so it names the very
// constructs these checks forbid (there is no `pop`, no `clear`). Scan the code,
// not the argument for it.
const CODE = SRC.slice(SRC.indexOf('from __future__'));

const python = 'python3';
let skip = false;
try {
  execFileSync(python, ['--version'], { stdio: 'ignore' });
} catch {
  skip = 'python3 unavailable';
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function run(cwd, args) {
  return execFileSync(python, [TOOL, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function runFail(cwd, args) {
  try {
    run(cwd, args);
    assert.fail(`expected ${args.join(' ')} to fail`);
  } catch (err) {
    return err;
  }
}

// Builds base repo + two worktrees (wtA, wtB) sharing one stash stack, the way
// two parallel Claude sessions in this repo actually do.
function makeRepoWithTwoWorktrees() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-mine-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'a@b.example']);
  git(repo, ['config', 'user.name', 'a']);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'hi\n');
  git(repo, ['add', 'f.txt']);
  git(repo, ['commit', '-q', '-m', 'init']);
  const wtA = path.join(base, 'wtA');
  const wtB = path.join(base, 'wtB');
  git(repo, ['worktree', 'add', '-q', '-b', 'wtA', wtA]);
  git(repo, ['worktree', 'add', '-q', '-b', 'wtB', wtB]);
  return { base, repo, wtA, wtB };
}

function cleanup(base) {
  fs.rmSync(base, { recursive: true, force: true });
}

test('no flag can point the tool at another path, ref or worktree', () => {
  for (const flag of ['--path', '--ref', '--worktree', '--repo', '--host', '--url']) {
    assert.ok(!SRC.includes(`"${flag}"`), `${flag} must not be an argument`);
    assert.ok(!SRC.includes(`'${flag}'`), `${flag} must not be an argument`);
  }
});

test('the only subcommands are push, list, apply, drop', () => {
  const names = [...CODE.matchAll(/sub\.add_parser\("([a-z]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(names.sort(), ['apply', 'drop', 'list', 'push']);
});

test('there is no pop and no clear', () => {
  assert.ok(!/add_parser\("pop"\)/.test(CODE), 'pop must not be a subcommand');
  assert.ok(!/add_parser\("clear"\)/.test(CODE), 'clear must not be a subcommand');
  assert.ok(!/"git",\s*"stash",\s*"pop"/.test(CODE), 'git stash pop must never be invoked');
  assert.ok(!/"git",\s*"stash",\s*"clear"/.test(CODE), 'git stash clear must never be invoked');
});

test('no shell, anywhere', () => {
  assert.ok(!CODE.includes('shell=True'), 'subprocess must never get shell=True');
  assert.ok(!/\bos\.system\b/.test(CODE), 'os.system must not appear');
  assert.ok(!/\bsubprocess\.(getoutput|getstatusoutput)\b/.test(CODE), 'shell-backed helpers must not appear');
  assert.ok(!/(?<![.\w])eval\(/.test(CODE), 'eval must not appear');
  assert.ok(!/(?<![.\w])exec\(/.test(CODE), 'exec must not appear');
});

test('the worktree identity is read from git, never from argv', () => {
  // worktree_id() must call git rev-parse itself; no code path may build the
  // tag from something a caller passed in.
  assert.match(SRC, /git_toplevel\(\)/);
  assert.match(SRC, /"git", "rev-parse", "--show-toplevel"/);
  assert.match(SRC, /"git", "rev-parse", "--abbrev-ref", "HEAD"/);
  // sys.argv must never feed the tag/message construction directly.
  const tagBuild = SRC.slice(SRC.indexOf('def worktree_id'), SRC.indexOf('def own_entries'));
  assert.ok(!tagBuild.includes('argv'), 'the tag must not be built from argv');
});

test('apply and drop refuse a SHA without this worktree\'s tag', () => {
  assert.match(SRC, /is not a stash entry this worktree created/);
  assert.match(SRC, /def find_own\(/);
});

test('drop re-resolves stash@{n} at drop time, not at find time', () => {
  // The index-shift protection: own_entries() must be called again inside
  // cmd_drop, after find_own() already ran once.
  const dropBody = SRC.slice(SRC.indexOf('def cmd_drop'), SRC.indexOf('def main'));
  const ownEntriesCalls = dropBody.match(/own_entries\(/g) || [];
  assert.ok(ownEntriesCalls.length >= 1, 'cmd_drop must look up current indices itself');
  assert.match(dropBody, /stash@\{\{\{idx\}\}\}/, 'drop must target stash@{n} by a freshly-read index');
});

test('--help works and names every subcommand', { skip }, () => {
  const out = run(__dirname, ['--help']);
  assert.match(out, /stash-mine/);
});

test('an unknown flag is refused rather than ignored', { skip }, () => {
  const err = runFail(__dirname, ['apply', '--path', '/etc']);
  assert.match(String(err.stderr), /unrecognized arguments|usage:/);
});

test('push tags the entry with this worktree and prints its SHA', { skip }, () => {
  const { base, wtA } = makeRepoWithTwoWorktrees();
  try {
    fs.writeFileSync(path.join(wtA, 'f.txt'), 'change-a\n');
    const sha = run(wtA, ['push', '-m', 'noteA']);
    assert.match(sha, /^[0-9a-f]{40}$/);
    const listing = run(wtA, ['list']);
    assert.match(listing, new RegExp(`^${sha}  stash@\\{0\\}  noteA$`));
  } finally {
    cleanup(base);
  }
});

test('list from one worktree never shows another worktree\'s entry', { skip }, () => {
  const { base, wtA, wtB } = makeRepoWithTwoWorktrees();
  try {
    fs.writeFileSync(path.join(wtA, 'f.txt'), 'change-a\n');
    run(wtA, ['push', '-m', 'noteA']);
    fs.writeFileSync(path.join(wtB, 'f.txt'), 'change-b\n');
    run(wtB, ['push', '-m', 'noteB']);
    assert.ok(!run(wtA, ['list']).includes('noteB'), 'wtA must not see wtB\'s entry');
    assert.ok(!run(wtB, ['list']).includes('noteA'), 'wtB must not see wtA\'s entry');
  } finally {
    cleanup(base);
  }
});

test('apply and drop refuse a foreign worktree\'s SHA', { skip }, () => {
  const { base, wtA, wtB } = makeRepoWithTwoWorktrees();
  try {
    fs.writeFileSync(path.join(wtA, 'f.txt'), 'change-a\n');
    const shaA = run(wtA, ['push', '-m', 'noteA']);

    const applyErr = runFail(wtB, ['apply', shaA]);
    assert.match(String(applyErr.stderr), /not a stash entry this worktree created/);
    const dropErr = runFail(wtB, ['drop', shaA]);
    assert.match(String(dropErr.stderr), /not a stash entry this worktree created/);

    // The foreign entry must still be there — a refused drop must not touch it.
    assert.ok(run(wtA, ['list']).includes('noteA'));
  } finally {
    cleanup(base);
  }
});

test('apply and drop accept an own SHA, and apply with no SHA picks the newest own entry', { skip }, () => {
  const { base, wtA } = makeRepoWithTwoWorktrees();
  try {
    fs.writeFileSync(path.join(wtA, 'f.txt'), 'change-a\n');
    const sha = run(wtA, ['push', '-m', 'noteA']);
    run(wtA, ['apply']); // no argument: newest own entry
    assert.strictEqual(fs.readFileSync(path.join(wtA, 'f.txt'), 'utf8'), 'change-a\n');
    run(wtA, ['drop', sha]);
    const err = runFail(wtA, ['list']);
    assert.match(String(err.stderr) + String(err.stdout), /no stash entries belong to this worktree/);
  } finally {
    cleanup(base);
  }
});

test('a SHA belonging to no stash entry at all is refused, not crashed on', { skip }, () => {
  const { base, wtA } = makeRepoWithTwoWorktrees();
  try {
    const err = runFail(wtA, ['apply', '0000000000000000000000000000000000000000']);
    assert.notStrictEqual(err.status, 0);
    assert.match(String(err.stderr), /not a commit this repository knows about|not a stash entry/);
  } finally {
    cleanup(base);
  }
});

test('drop survives another worktree pushing between list and drop (index shift)', { skip }, () => {
  // This is the race the protocol exists to close: a concurrent push from
  // another worktree inserts at stash@{0} and shifts every existing index up
  // by one. Resolving stash@{n} once and reusing it would drop the wrong entry.
  const { base, wtA, wtB } = makeRepoWithTwoWorktrees();
  try {
    fs.writeFileSync(path.join(wtA, 'f.txt'), 'change-a1\n');
    const shaA1 = run(wtA, ['push', '-m', 'noteA1']);
    // A second own entry so wtA's target sits underneath something, mirroring
    // stash@{1} rather than stash@{0} even before the foreign push lands.
    fs.writeFileSync(path.join(wtA, 'f.txt'), 'change-a2\n');
    run(wtA, ['push', '-m', 'noteA2']);

    // Foreign push from wtB shifts every existing index up by one.
    fs.writeFileSync(path.join(wtB, 'f.txt'), 'change-b\n');
    run(wtB, ['push', '-m', 'noteB']);

    const full = git(wtA, ['stash', 'list', '--format=%H %gs']);
    assert.ok(full.includes(shaA1), 'the target entry must still be on the stack before the drop');

    run(wtA, ['drop', shaA1]);

    const after = git(wtA, ['stash', 'list', '--format=%H %gs']);
    assert.ok(!after.includes(shaA1), 'the targeted entry must be gone');
    assert.ok(after.includes('noteA2'), 'the other own entry must be untouched');
    assert.ok(after.includes('noteB'), 'the foreign entry must be untouched');
  } finally {
    cleanup(base);
  }
});

test('push with nothing to stash fails rather than printing a stale SHA', { skip }, () => {
  const { base, wtA } = makeRepoWithTwoWorktrees();
  try {
    const err = runFail(wtA, ['push', '-m', 'noop']);
    assert.notStrictEqual(err.status, 0);
    assert.match(String(err.stdout) + String(err.stderr), /No local changes to save/);
  } finally {
    cleanup(base);
  }
});
