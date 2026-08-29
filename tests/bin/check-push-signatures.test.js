// Unit tests for bin/check-push-signatures — the pre-push gate that rejects unsigned
// commits. commit.gpgsign is only a default (any --no-gpg-sign, alternate HOME, or a
// machine whose gitconfig never got the signing block produces unsigned commits), so the
// gate is what makes "commits are signed" an invariant rather than a habit.
//
// Builds throwaway repos with a throwaway ed25519 key and drives the real script over
// git's pre-push stdin protocol: "<local ref> <local sha> <remote ref> <remote sha>".
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', '..', 'bin', 'check-push-signatures');
function have(cmd) { try { execFileSync('bash', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } }
const skip = !have('bash') ? 'bash unavailable'
  : !have('git') ? 'git unavailable'
  : !have('ssh-keygen') ? 'ssh-keygen unavailable' : false;

const ZERO = '0'.repeat(40);
const dirs = [];
function scratch() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'signgate-')); dirs.push(d); return fs.realpathSync(d); }

// A repo wired for ssh commit signing with its own ephemeral key. `trustKey` controls
// whether that key lands in allowed_signers, which is the difference between %G? = G and
// %G? = U (a real signature whose signer git cannot vouch for).
function repo({ trustKey = true } = {}) {
  const root = scratch();
  const keydir = scratch();
  const key = path.join(keydir, 'id');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test@example.com', '-f', key]);
  const pub = fs.readFileSync(`${key}.pub`, 'utf8').trim().split(' ').slice(0, 2).join(' ');
  const signers = path.join(keydir, 'allowed_signers');
  fs.writeFileSync(signers, trustKey ? `test@example.com ${pub}\n` : '');

  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [
    ['user.email', 'test@example.com'], ['user.name', 'Test'],
    ['gpg.format', 'ssh'], ['user.signingkey', `${key}.pub`],
    ['gpg.ssh.allowedSignersFile', signers], ['commit.gpgsign', 'true'],
    // Pinned, not inherited: this machine's global gitconfig points gpg.ssh.program at
    // 1Password's op-ssh-sign, which routes signing to the agent and then correctly
    // refuses a key it does not hold ("No SSH private key found for the specified public
    // key"), so every commit here fails to be written. The throwaway repo must sign with
    // the throwaway key file it just generated, which is what plain ssh-keygen does.
    ['gpg.ssh.program', 'ssh-keygen'],
  ]) git('config', k, v);

  return {
    root,
    // signed:false reproduces exactly what the gate exists to catch.
    commit(msg, { signed = true } = {}) {
      fs.appendFileSync(path.join(root, 'f'), `${msg}\n`);
      git('add', '-A');
      git('commit', '-qm', msg, signed ? '--gpg-sign' : '--no-gpg-sign');
      return git('rev-parse', 'HEAD').trim();
    },
    verdicts() { return git('log', '--format=%G?').trim().split('\n'); },
  };
}

function check(root, refLines, env = {}) {
  const r = spawnSync('bash', [SCRIPT], {
    cwd: root, input: refLines, encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status, err: r.stderr || '' };
}

test('rejects a push containing an unsigned commit', { skip }, () => {
  const r = repo();
  const base = r.commit('base');
  const bad = r.commit('sneaky', { signed: false });
  const { code, err } = check(r.root, `refs/heads/main ${bad} refs/heads/main ${base}\n`);
  assert.strictEqual(code, 1, 'the push is blocked');
  assert.match(err, /unsigned/, 'names the problem');
  assert.match(err, /sneaky/, 'and identifies the offending commit');
});

test('passes a push whose commits are all signed and trusted', { skip }, () => {
  const r = repo();
  const base = r.commit('base');
  const head = r.commit('good');
  assert.deepStrictEqual(r.verdicts(), ['G', 'G'], 'fixture really does produce good signatures');
  const { code } = check(r.root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
  assert.strictEqual(code, 0);
});

test('only judges the commits the push actually adds', { skip }, () => {
  // An unsigned commit already on the remote must not block an otherwise-clean push —
  // otherwise the gate is unusable on a repo with pre-existing unsigned history.
  const r = repo();
  r.commit('old', { signed: false });
  const base = r.commit('base', { signed: false });
  const head = r.commit('new');
  const { code } = check(r.root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
  assert.strictEqual(code, 0, 'history before the remote tip is out of scope');
});

test('warns but does not block when the signer is not in allowed_signers', { skip }, () => {
  const r = repo({ trustKey: false });
  const base = r.commit('base');
  const head = r.commit('untrusted-signer');
  const { code, err } = check(r.root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
  assert.strictEqual(code, 0, 'a real signature with an unlisted signer is a trust-list gap, not an unsigned commit');
  assert.match(err, /unverified|could not be verified/, 'but it is surfaced');
});

test('SIGN_GATE_STRICT=1 turns an unverifiable signature into a failure', { skip }, () => {
  const r = repo({ trustKey: false });
  const base = r.commit('base');
  const head = r.commit('untrusted-signer');
  const { code } = check(r.root, `refs/heads/main ${head} refs/heads/main ${base}\n`, { SIGN_GATE_STRICT: '1' });
  assert.strictEqual(code, 1);
});

test('ignores a branch deletion', { skip }, () => {
  const r = repo();
  const head = r.commit('base');
  const { code } = check(r.root, `(delete) ${ZERO} refs/heads/gone ${head}\n`);
  assert.strictEqual(code, 0);
});

test('passes when the push adds nothing', { skip }, () => {
  const r = repo();
  const head = r.commit('base');
  const { code } = check(r.root, `refs/heads/main ${head} refs/heads/main ${head}\n`);
  assert.strictEqual(code, 0);
});

test('checks every ref in a multi-ref push', { skip }, () => {
  const r = repo();
  const base = r.commit('base');
  const good = r.commit('good');
  execFileSync('git', ['checkout', '-qb', 'side', base], { cwd: r.root });
  const bad = r.commit('bad-on-side', { signed: false });
  const { code, err } = check(r.root,
    `refs/heads/main ${good} refs/heads/main ${base}\nrefs/heads/side ${bad} refs/heads/side ${base}\n`);
  assert.strictEqual(code, 1, 'a bad second ref still blocks the push');
  assert.match(err, /bad-on-side/);
});

// The case that made this gate unusable in practice. `gh pr merge --rebase` replays
// commits server-side without signatures, so main collects unsigned commits on every
// landing; a branch rebased onto main then carried them inside $remote_sha..$local_sha
// and was rejected for history it neither wrote nor could amend.
test('a branch rebased onto unsigned main history still passes', { skip }, () => {
  const r = repo();
  const git = (...args) => execFileSync('git', args, { cwd: r.root, encoding: 'utf8' }).trim();
  const origin = path.join(scratch(), 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git('remote', 'add', 'origin', origin);

  r.commit('base');
  git('push', '-q', 'origin', 'main');
  git('checkout', '-qb', 'feature');
  const early = r.commit('early work');
  git('push', '-q', 'origin', 'feature');

  // A landing lands on main unsigned, exactly as gh pr merge --rebase leaves it.
  git('checkout', '-q', 'main');
  const landed = r.commit('landed by gh, replayed unsigned', { signed: false });
  git('push', '-q', 'origin', 'main');

  // Rebasing feature onto that main puts the unsigned commit in its ancestry.
  git('checkout', '-qB', 'feature', landed);
  const head = r.commit('work after the rebase');
  assert.ok(git('rev-list', `${early}..${head}`).split('\n').includes(landed),
    'the unsigned commit really is inside the old push range');

  const { code, err } = check(r.root, `refs/heads/feature ${head} refs/heads/feature ${early}\n`);
  assert.strictEqual(code, 0, err);
});

test('an unsigned commit of your own still blocks, rebase or not', { skip }, () => {
  const r = repo();
  const git = (...args) => execFileSync('git', args, { cwd: r.root, encoding: 'utf8' }).trim();
  const origin = path.join(scratch(), 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git('remote', 'add', 'origin', origin);

  const base = r.commit('base');
  git('push', '-q', 'origin', 'main');
  git('checkout', '-qb', 'feature');
  const mine = r.commit('mine, unsigned', { signed: false });

  const { code, err } = check(r.root, `refs/heads/feature ${mine} refs/heads/feature ${base}\n`);
  assert.strictEqual(code, 1, 'widening the exclusion must not blind the gate');
  assert.match(err, /mine, unsigned/);
});

test('does nothing when run by hand with no pre-push input', { skip }, () => {
  const r = repo();
  r.commit('base', { signed: false });
  const { code } = check(r.root, '');
  assert.strictEqual(code, 0, 'no stdin means no range to judge, not "everything fails"');
});

// ── --range mode ──────────────────────────────────────────────────────────────
//
// CI has a range to check but no push to read it from. The first version of the workflow
// faked the protocol on stdin, which looked equivalent and was not: the stdin path appends
// `--not --remotes` so a server-side rebase replay is not re-judged, and on a runner
// actions/checkout has already created a remote-tracking ref for the branch under test.
// Every commit was excluded, so the step checked ZERO while exiting 0 and printing nothing
// -- a signature gate indistinguishable from one that had actually passed.

function checkRange(root, base, head, env = {}) {
  const r = spawnSync('bash', [SCRIPT, '--range', base, head], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

test('--range reports how many commits it checked', { skip }, () => {
  const r = repo();
  const base = r.commit('base');
  r.commit('one');
  const head = r.commit('two');
  const { code, out } = checkRange(r.root, base, head);
  assert.strictEqual(code, 0);
  assert.match(out, /checked 2 commit\(s\)/,
    'the count prints on every run, so a gate that checked nothing cannot hide');
});

test('--range refuses an empty range instead of passing it', { skip }, () => {
  const r = repo();
  const head = r.commit('base');
  const { code, err } = checkRange(r.root, head, head);
  assert.strictEqual(code, 1, 'an empty range is a caller bug, not a pass');
  assert.match(err, /checked 0 commits/);
  assert.match(err, /refusing to report a pass/);
});

test('--range still catches an unsigned commit', { skip }, () => {
  const r = repo();
  const base = r.commit('base');
  const bad = r.commit('sneaky', { signed: false });
  const { code, err } = checkRange(r.root, base, bad);
  assert.strictEqual(code, 1);
  assert.match(err, /unsigned/);
  assert.match(err, /sneaky/);
});

test('--range ignores remote-tracking refs, which is why it exists', { skip }, () => {
  // Reproduce the runner: the branch under test already has a remote-tracking ref covering
  // its tip. The stdin path excludes --remotes and therefore finds nothing; --range must
  // still see every commit in the range it was handed.
  const r = repo();
  const base = r.commit('base');
  const head = r.commit('later');
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: r.root });

  const viaStdin = check(r.root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
  assert.strictEqual(viaStdin.code, 0, 'the stdin path excludes it and finds nothing to check');

  const ranged = checkRange(r.root, base, head);
  assert.strictEqual(ranged.code, 0);
  assert.match(ranged.out, /checked 1 commit\(s\)/,
    'the remote-tracking ref must not hide the commit from --range');
});

test('--range without both arguments is a usage error', { skip }, () => {
  const r = repo();
  r.commit('base');
  const bare = spawnSync('bash', [SCRIPT, '--range'], { cwd: r.root, encoding: 'utf8' });
  assert.strictEqual(bare.status, 2);
  assert.match(bare.stderr, /needs <base> <head>/);
});

// ── N does not always mean unsigned ───────────────────────────────────────────
//
// For an SSH-signed commit git needs gpg.ssh.allowedSignersFile configured AND existing
// before it will look at the signature at all. Without it, it reports %G? = N — the same
// code a genuinely unsigned commit gets — and says why only on stderr. So on a machine
// that has not configured a signers file, EVERY signed commit reads as unsigned and this
// gate rejects the push for a reason that is not true. Not hypothetical: the CI step's
// first run on main failed with "10 of 10 pushed commit(s) are not properly signed"
// against ten commits that verify as G locally.

// A fresh CI runner has the setting nowhere: not in the repo, and not in a global config
// either. Both halves are needed to reproduce it. `repo()` writes the key at repo level, so
// that one is unset here — and the machine running these tests has it in ~/.gitconfig, which
// the fixture would otherwise inherit and the guard would never fire.
//
// GIT_CONFIG_GLOBAL/SYSTEM=/dev/null is the stronger isolation the 2026-08-06 audit
// recommended over per-repo overrides, for exactly this reason: it cuts the fixture off from
// the machine instead of patching one setting at a time.
const BARE_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function unsetSigners(root) {
  execFileSync('git', ['config', '--unset', 'gpg.ssh.allowedSignersFile'], { cwd: root });
}

test('git really does report a signed commit as N when the setting is absent', { skip }, () => {
  // The premise, pinned. Everything below is only worth doing while this holds, so if a
  // future git separates "unsigned" from "cannot verify", this is where it surfaces.
  const r = repo();
  r.commit('signed');
  unsetSigners(r.root);
  const verdict = execFileSync('git', ['log', '--format=%G?', '-1'],
    { cwd: r.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: BARE_ENV }).trim();
  assert.strictEqual(verdict, 'N',
    'a signed commit reads as N with the setting absent — the whole reason for the guard');
});

test('an unverifiable machine with nothing to judge is still a pass', { skip }, () => {
  // The guard must fire on a false verdict, not on the mere possibility of one.
  // .githooks/pre-push runs this with </dev/null — a push protocol carrying no refs — and
  // an early exit 3 there turns the gate's own no-op into a failure on any machine without
  // a signers file. This branch's first CI run did exactly that: `✗ commit signatures
  // (exit 3)` inside a gate step that had no commits in front of it.
  const r = repo();
  r.commit('signed');
  unsetSigners(r.root);
  const res = spawnSync('bash', [SCRIPT], {
    cwd: r.root, input: '', encoding: 'utf8', env: BARE_ENV,
  });
  assert.strictEqual(res.status, 0, 'no refs means nothing was misjudged, so nothing to refuse');
});

test('refuses to judge when allowedSignersFile is unset', { skip }, () => {
  const r = repo();
  const base = r.commit('base');
  const head = r.commit('also signed');
  unsetSigners(r.root);
  const res = spawnSync('bash', [SCRIPT, '--range', base, head], { cwd: r.root, encoding: 'utf8', env: BARE_ENV });
  assert.strictEqual(res.status, 3,
    'could-not-evaluate, not a rejection — calling these signed commits unsigned is the bug');
  assert.match(res.stderr, /allowedSignersFile is unset/);
  assert.doesNotMatch(res.stderr, /not properly signed/,
    'it must not claim the commits are unsigned when it cannot tell');
});

test('any signers path restores a real verdict, existing or not', { skip }, () => {
  // Measured on git 2.51: unset gives N, but /dev/null, an empty file, and a path that does
  // not exist all give U. So the guard tests for a VALUE, not for a readable file — and a
  // nonexistent path must not be refused, or CI configurations that work would be rejected.
  const r = repo();
  const base = r.commit('base');
  const head = r.commit('signed');
  for (const signers of ['/dev/null', path.join(r.root, 'no-such-file')]) {
    execFileSync('git', ['config', 'gpg.ssh.allowedSignersFile', signers], { cwd: r.root });
    const res = spawnSync('bash', [SCRIPT, '--range', base, head], { cwd: r.root, encoding: 'utf8' });
    assert.strictEqual(res.status, 0, `${signers}: a signed commit warns rather than blocks`);
    assert.match(res.stderr, /could not be verified/, `${signers}: and says it could not attribute it`);
  }
});

test('an unsigned commit is still caught once a signers path is set', { skip }, () => {
  // The guard must not have bought its honesty by going blind. This is what CI relies on.
  const r = repo();
  const base = r.commit('base');
  const bad = r.commit('sneaky', { signed: false });
  execFileSync('git', ['config', 'gpg.ssh.allowedSignersFile', '/dev/null'], { cwd: r.root });
  const res = spawnSync('bash', [SCRIPT, '--range', base, bad], { cwd: r.root, encoding: 'utf8' });
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /unsigned/);
  assert.match(res.stderr, /sneaky/);
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
