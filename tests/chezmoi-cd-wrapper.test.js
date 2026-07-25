// Regression guard for the bare-`chezmoi` cd wrapper in shell/common.sh: an argument-less
// call cds to `chezmoi source-path`, and EVERY invocation with arguments reaches the real
// binary untouched (so `apply`, `diff`, `source-path` and the czv/czs aliases still work).
// Extracts the ACTUAL function from the source and drives it with a stub chezmoi on PATH,
// in bash and (when present) zsh — the two shells that source common.sh.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const COMMON = path.join(__dirname, '..', 'home', 'dot_config', 'shell', 'common.sh');

function have(cmd) { try { execFileSync('bash', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } }
const zshSkip = have('zsh') ? false : 'zsh unavailable';

// The function under test, lifted verbatim from common.sh and dedented — it lives indented
// inside the `if command -v chezmoi` guard, so the match is anchored on that indentation.
const fnMatch = fs.readFileSync(COMMON, 'utf8').match(/^ {2}chezmoi\(\) \{\n[\s\S]*?\n {2}\}/m);
assert.ok(fnMatch, 'chezmoi() exists in common.sh');
const FN = fnMatch[0].replace(/^ {2}/gm, '');

const dirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// Stub bin: `chezmoi source-path` prints $SRC_DIR, every other argv is logged. The real
// binary must never run. SRC_FAIL=1 makes source-path fail, standing in for a broken config.
// `git` is real here — the wrapper resolves the repo root, so the source dir is created as
// <repo>/home inside a scratch checkout, mirroring this repo's .chezmoiroot=home layout.
// Pass {bare:true} for a source dir with no checkout above it, to exercise the fallback.
function makeEnv({ bare = false } = {}) {
  const bin = scratch('czcd-bin-');
  const repo = scratch('czcd-repo-');
  let src = repo;
  if (!bare) {
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
    src = path.join(repo, 'home');
    fs.mkdirSync(src);
  }
  const log = path.join(bin, 'chezmoi.log'); fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(bin, 'chezmoi'),
    '#!/bin/bash\n'
    + 'echo "$*" >> "$CZ_LOG"\n'
    + 'if [ "$1" = "source-path" ]; then\n'
    + '  [ -n "$SRC_FAIL" ] && { echo "no config" >&2; exit 3; }\n'
    + '  echo "$SRC_DIR"; exit 0\n'
    + 'fi\n'
    + 'exit 0\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CZ_LOG: log, SRC_DIR: src };
  delete env.SRC_FAIL;
  // The suite runs under a private TMPDIR, which could itself sit inside a checkout and let
  // rev-parse ascend out of the scratch dir — pinning the ceiling keeps the fallback honest.
  if (bare) env.GIT_CEILING_DIRECTORIES = src;
  return { env, log, src, repo };
}
const read = (p) => fs.readFileSync(p, 'utf8');

// Runs the function in `shell` and echoes the resulting cwd, so a cd is observable. Only the
// LAST line is the cwd: a pass-through call also relays whatever the stub printed (`chezmoi
// source-path` echoes a path), which the bare call swallows into its own $(...) capture.
function runPwd(shell, env, args, extraEnv = {}) {
  const argv = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const out = execFileSync(shell, ['-c', `${FN}\nchezmoi ${argv}\npwd -P`],
    { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 10000 });
  return out.trim().split('\n').pop();
}

for (const shell of ['bash', 'zsh']) {
  const skip = shell === 'zsh' ? zshSkip : false;

  test(`${shell}: bare chezmoi cds to the repo root, not the .chezmoiroot source dir`, { skip }, () => {
    const { env, repo, src } = makeEnv();
    // realpath both sides: macOS puts mkdtemp under /var -> /private/var.
    const landed = runPwd(shell, env, []);
    assert.strictEqual(landed, fs.realpathSync(repo));
    assert.notStrictEqual(landed, fs.realpathSync(src), 'must not stop at <repo>/home');
  });

  test(`${shell}: bare chezmoi falls back to the source dir outside a checkout`, { skip }, () => {
    const { env, src } = makeEnv({ bare: true });
    assert.strictEqual(runPwd(shell, env, []), fs.realpathSync(src));
  });

  test(`${shell}: bare chezmoi asks source-path and nothing else`, { skip }, () => {
    const { env, log } = makeEnv();
    runPwd(shell, env, []);
    assert.strictEqual(read(log).trim(), 'source-path');
  });

  test(`${shell}: subcommands pass through untouched and do not cd`, { skip }, () => {
    for (const args of [['apply'], ['diff'], ['source-path'], ['verify', '--exclude=scripts'],
      ['apply', '~/.claude/settings.json']]) {
      const { env, log } = makeEnv();
      const cwd = runPwd(shell, env, args);
      assert.strictEqual(read(log).trim(), args.join(' '));
      assert.strictEqual(cwd, fs.realpathSync(process.cwd()), `${args[0]} must not cd`);
    }
  });

  test(`${shell}: a failing source-path propagates its status and does not cd`, { skip }, () => {
    const { env } = makeEnv();
    const out = execFileSync(shell, ['-c', `${FN}\nchezmoi; echo "rc=$?"\npwd -P`],
      { env: { ...env, SRC_FAIL: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
    assert.match(out, /rc=3/);
    assert.strictEqual(out.trim().split('\n').pop(), fs.realpathSync(process.cwd()));
  });
}
