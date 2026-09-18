// Unit tests for bin/gate-cache and its wiring into .githooks/pre-push.
//
// The gate's expensive steps -- lint, instruction quality, the injection guard, the
// 2039-test suite -- read the working tree, not the refs being pushed. bin/land pushes
// three times per landing (the branch, then <branch>:main, then the branch deletion) and
// cannot change the tree between them, because it refuses to run on a dirty one. Measured
// 2026-08-07: three gate runs at ~58s each, 174s of a 183s landing.
//
// What makes the cache safe is the narrowness of its key: HEAD's sha, consulted only when
// the tree is clean. Two clean trees at the same sha are byte-identical, so a hit is exact
// rather than probable. These tests pin that narrowness -- every way the tree could differ
// from the one that passed has to miss, because a wrong hit skips the whole suite and the
// push still reports green, which is indistinguishable from having run it.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { have } = require('./lib/probe');

const REPO = path.join(__dirname, '..');
const GATE = path.join(REPO, 'bin', 'gate-cache');
const HOOK = path.join(REPO, '.githooks', 'pre-push');

const skip = !have('bash') ? 'bash unavailable' : !have('git') ? 'git unavailable' : false;

// A throwaway repo with one commit. Signing is off: these fixtures never push, and the
// signing key is not available to the suite.
function repo() {
  const root = fs.realpathSync(scratch(os.tmpdir(), 'gatecache-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'README'), 'one\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return root;
}

function commit(root, text) {
  fs.writeFileSync(path.join(root, 'README'), text);
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'next'], { cwd: root, stdio: 'ignore' });
}

function gate(root, arg, env = {}) {
  // Drop any ambient GATE_CACHE_* before layering the case's own on top. The gate that runs
  // this suite is itself a consumer of these variables -- `GATE_CACHE_OFF=1 git push` sets one
  // for the whole run -- so inheriting them turns every hit-expecting test below red for a
  // reason that has nothing to do with the cache. Found exactly that way.
  const base = { ...process.env };
  delete base.GATE_CACHE_OFF;
  delete base.GATE_CACHE_TTL;
  return spawnSync('bash', [GATE, arg], {
    cwd: root, encoding: 'utf8', env: { ...base, ...env },
  });
}

test('a cold cache is a miss', { skip }, () => {
  const root = repo();
  assert.notStrictEqual(gate(root, 'check').status, 0, 'nothing has passed yet, so nothing may be skipped');
});

test('save then check is a hit', { skip }, () => {
  const root = repo();
  assert.strictEqual(gate(root, 'save').status, 0);
  const r = gate(root, 'check');
  assert.strictEqual(r.status, 0, `expected a hit, got status ${r.status}: ${r.stderr}`);
});

test('a hit reports the age of the record, so the gate can say what it skipped', { skip }, () => {
  const root = repo();
  gate(root, 'save');
  assert.match(gate(root, 'check').stdout.trim(), /^\d+$/, 'check must print the record age in seconds');
});

test('moving HEAD misses', { skip }, () => {
  const root = repo();
  gate(root, 'save');
  commit(root, 'two\n');
  assert.notStrictEqual(gate(root, 'check').status, 0, 'new commits were never gated');
});

// The whole point of keying on a clean tree. An edit that is never committed leaves HEAD
// alone, so the sha still matches -- the dirty check is the only thing standing between a
// modified file and a skipped suite.
test('an uncommitted edit at the same HEAD misses', { skip }, () => {
  const root = repo();
  gate(root, 'save');
  fs.writeFileSync(path.join(root, 'README'), 'edited\n');
  assert.notStrictEqual(gate(root, 'check').status, 0, 'a dirty tree was never the tree that passed');
});

test('an untracked file at the same HEAD misses', { skip }, () => {
  const root = repo();
  gate(root, 'save');
  fs.writeFileSync(path.join(root, 'NEW.js'), 'x\n');
  assert.notStrictEqual(gate(root, 'check').status, 0, 'an untracked file could hold the failure');
});

test('saving from a dirty tree records nothing', { skip }, () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'README'), 'dirty\n');
  gate(root, 'save');
  execFileSync('git', ['checkout', '--', 'README'], { cwd: root, stdio: 'ignore' });
  assert.notStrictEqual(gate(root, 'check').status, 0, 'a dirty run must not vouch for the clean tree it becomes');
});

test('a record older than the TTL misses', { skip }, () => {
  const root = repo();
  gate(root, 'save');
  assert.strictEqual(gate(root, 'check', { GATE_CACHE_TTL: '100000' }).status, 0, 'sanity: fresh within a wide TTL');
  assert.notStrictEqual(gate(root, 'check', { GATE_CACHE_TTL: '0' }).status, 0, 'the toolchain is outside the key, so records expire');
});

test('GATE_CACHE_OFF forces a miss on an otherwise valid record', { skip }, () => {
  const root = repo();
  gate(root, 'save');
  assert.strictEqual(gate(root, 'check').status, 0, 'sanity: valid without the override');
  assert.notStrictEqual(gate(root, 'check', { GATE_CACHE_OFF: '1' }).status, 0);
});

test('a corrupt record misses rather than throwing', { skip }, () => {
  const root = repo();
  gate(root, 'save');
  const f = path.join(root, '.git', 'gate-cache');
  for (const junk of ['', 'garbage\n', 'deadbeef notanumber\n', 'deadbeef\n']) {
    fs.writeFileSync(f, junk);
    assert.notStrictEqual(gate(root, 'check').status, 0, `expected a miss for record ${JSON.stringify(junk)}`);
  }
});

// The record's fields changed meaning when the toolchain digest went in. A v1 record has the
// sha where v2 has the version, so without the version check its sha would land in `ver`, its
// timestamp in `sha`, and the comparisons would go on to read fields that were never written.
test('a record from the previous format misses', { skip }, () => {
  const root = repo();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  fs.writeFileSync(path.join(root, '.git', 'gate-cache'),
    `${head} ${Math.floor(Date.now() / 1000)}\n`);
  assert.notStrictEqual(gate(root, 'check').status, 0, 'a v1 record must not be read as a v2 hit');
});

// Without this the digest could be computed and never compared, and nothing else here would
// notice: every other test holds the toolchain still, so a hit proves only that the sha matched.
test('a changed toolchain misses at the same HEAD and clean tree', { skip }, () => {
  const root = repo();
  assert.strictEqual(gate(root, 'save').status, 0);
  assert.strictEqual(gate(root, 'check').status, 0, 'sanity: a hit before the toolchain moves');

  // A stub node earlier on PATH than the real one: same HEAD, same clean tree, different
  // version text. Prepended rather than replacing PATH, so git and bash still resolve.
  const stubDir = fs.realpathSync(scratch(os.tmpdir(), 'gatecache-'));
  fs.writeFileSync(path.join(stubDir, 'node'), '#!/bin/bash\necho v0.0.0-stub\n', { mode: 0o755 });
  const r = gate(root, 'check', { PATH: `${stubDir}:${process.env.PATH}` });
  assert.notStrictEqual(r.status, 0, 'a different node must invalidate the record');

  // ...and the original toolchain still hits, so the miss above was the digest and not some
  // side effect of passing PATH at all.
  assert.strictEqual(gate(root, 'check').status, 0, 'the untouched toolchain must still hit');
});

test('a record saved under one toolchain is not revived by restoring it', { skip }, () => {
  const root = repo();
  const stubDir = fs.realpathSync(scratch(os.tmpdir(), 'gatecache-'));
  fs.writeFileSync(path.join(stubDir, 'node'), '#!/bin/bash\necho v0.0.0-stub\n', { mode: 0o755 });
  const stubPath = { PATH: `${stubDir}:${process.env.PATH}` };
  gate(root, 'save', stubPath);
  assert.strictEqual(gate(root, 'check', stubPath).status, 0, 'sanity: hits under the toolchain that saved it');
  assert.notStrictEqual(gate(root, 'check').status, 0, 'must miss under a different toolchain');
});

test('the record lives under the git dir, so worktrees do not share one', { skip }, () => {
  const root = repo();
  gate(root, 'save');
  assert.ok(fs.existsSync(path.join(root, '.git', 'gate-cache')), 'record must sit in the git dir');
  // A second worktree has its own git dir and its own tree, so it must start cold even
  // though its HEAD sha can match.
  const wt = path.join(fs.realpathSync(scratch(os.tmpdir(), 'gatecache-')), 'wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', wt], { cwd: root, stdio: 'ignore' });
  assert.notStrictEqual(gate(wt, 'check').status, 0, 'a fresh worktree has proved nothing');
});

test('outside a git repo it misses instead of failing the push', { skip }, () => {
  assert.notStrictEqual(gate(fs.realpathSync(scratch(os.tmpdir(), 'gatecache-')), 'check').status, 0);
});

// --- wiring ------------------------------------------------------------------------
// The cache is only worth anything if the hook actually consults it, and only *safe* if
// the hook keeps the signature check outside it. Text assertions, because exercising the
// real hook costs ~58s a run.
const hookText = fs.readFileSync(HOOK, 'utf8');

test('the hook consults the cache', () => {
  assert.match(hookText, /gate-cache/, 'pre-push must ask gate-cache whether the tree gate can be skipped');
});

test('the hook records a green run so the next push can skip', () => {
  assert.match(hookText, /"\$GATE" save/, 'without a save the cache never hits and nothing is saved');
});

test('the signature check stays outside the cached block', () => {
  // It is the one step that reads the push range from stdin, so its answer differs per
  // push even when the tree does not. Caching it would let an unsigned commit onto main
  // behind a hit earned by an earlier, signed push.
  const sig = hookText.indexOf('run "commit signatures"');
  const guard = hookText.indexOf('if [ "$tree_cached" -eq 0 ]');
  assert.ok(sig > 0, 'signature step must still exist');
  assert.ok(guard > 0, 'the cached block must be guarded by $tree_cached');
  assert.ok(sig < guard, 'the signature check must run before, and outside, the cached block');
});

test('every expensive step sits inside the cached block', () => {
  const guard = hookText.indexOf('if [ "$tree_cached" -eq 0 ]');
  const close = hookText.indexOf('\nfi  # tree_cached', guard);
  assert.ok(close > guard, 'the cached block must be closed with the marked fi');
  const block = hookText.slice(guard, close);
  for (const step of ['config-soak', 'instruction quality', 'prek run --all-files', 'screen-injection', 'unit tests (node --test)']) {
    assert.ok(block.includes(step), `${step} must be inside the cached block, or it re-runs on every push`);
  }
});
