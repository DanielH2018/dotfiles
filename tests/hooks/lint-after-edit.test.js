// Regression guard for executable_lint-after-edit.sh (PostToolUse Edit|Write).
// Feeds synthetic hook JSON through the ACTUAL hook and asserts lint failures
// surface as a block decision while clean/unsupported files are no-ops.
// Offline. Skips cleanly if bash/jq are unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { shConstInt } = require('../lib/sh-const');
const { scratch } = require('../lib/tmp');

const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_lint-after-edit.sh');

// The hook's truncation cap, read from the hook. The noisy-linter case below has to produce
// more output than this to reach the truncation branch at all, so a restated 40 here would
// stop testing truncation the moment the cap were raised — silently, still green.
const MAX_LINES = shConstInt(HOOK, 'MAX_LINES');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

let shellcheckOk = true;
try { execFileSync('bash', ['-c', 'command -v shellcheck'], { stdio: 'ignore' }); } catch { shellcheckOk = false; }

// The hook runs every linter through run_bounded, which is built on coreutils timeout(1) --
// see run-bounded.test.js, whose whole suite skips on the same probe. Where timeout is absent
// (a stock macOS: no coreutils in Brewfile.tmpl or tools.toml) run_bounded emits
// "timeout: command not found" and the hook reports THAT as the lint failure, so every case
// below sees a block decision whose reason is the missing tool rather than the linter's
// verdict. It was invisible until shellcheck arrived on this machine: with no linter for .sh
// at all the hook returned before reaching run_bounded, and these four passed without
// exercising it.
//
// NOT a test-only gap: the deployed PostToolUse hook has the same hole, and on this host it
// now blocks real edits with that message. Closing it means either putting a timeout(1) on
// the hook's PATH or giving run_bounded a fallback, both of which are decisions about
// run_bounded rather than about this suite.
let timeoutOk = true;
try { execFileSync('bash', ['-c', 'command -v timeout'], { stdio: 'ignore' }); } catch { timeoutOk = false; }

const skipLintCase = !(toolsOk && shellcheckOk) ? 'no supported linter installed'
  : timeoutOk ? false : 'coreutils timeout unavailable (run_bounded cannot run)';

function runHook(input, env = {}) {
  try {
    return execFileSync('bash', [HOOK], {
      input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
  } catch (e) { return e.stdout || ''; }
}
function decision(stdout) {
  if (!stdout.trim()) return null;
  try { return JSON.parse(stdout).decision; } catch { return null; }
}

test('clean shell script: exit 0, no block decision', { skip: skipLintCase }, () => {
  const dir = scratch(os.tmpdir(), 'lint-after-edit-');
  const f = path.join(dir, 'clean.sh');
  fs.writeFileSync(f, '#!/bin/bash\nset -euo pipefail\nfoo="$1"\necho "$foo"\n');
  const out = runHook(JSON.stringify({ tool_input: { file_path: f } }));
  assert.strictEqual(decision(out), null);
});

test('shell script with a lint violation: block decision surfaces the output', { skip: skipLintCase }, () => {
  const dir = scratch(os.tmpdir(), 'lint-after-edit-');
  const f = path.join(dir, 'bad.sh');
  fs.writeFileSync(f, '#!/bin/bash\nfoo=$1\necho $foo\n');
  const out = runHook(JSON.stringify({ tool_input: { file_path: f } }));
  assert.strictEqual(decision(out), 'block');
  assert.match(out, /SC2086/);
});

// The whole linter output went into the block reason, i.e. into the model's context, for
// one edit. A failing tsc on a real project emits thousands of lines; the head carries the
// first actual error, so cap it and say what was dropped instead of truncating silently.
test('a very noisy linter run is truncated with a notice, not pasted whole', { skip: skipLintCase }, () => {
  const dir = scratch(os.tmpdir(), 'lint-after-edit-');
  const f = path.join(dir, 'noisy.sh');
  // One SC2086 finding per violation, so overshooting the cap guarantees the truncation branch.
  const violations = Array.from({ length: MAX_LINES * 2 }, (_, i) => `v${i}=$1\necho $v${i}\n`).join('');
  fs.writeFileSync(f, `#!/bin/bash\n${violations}`);
  const out = runHook(JSON.stringify({ tool_input: { file_path: f } }));
  assert.strictEqual(decision(out), 'block');
  const reason = JSON.parse(out).reason;
  assert.match(reason, /more line\(s\) truncated/);
  // Head retained, so the first real finding still reaches the model.
  assert.match(reason, /SC2086/);
  // The bound is the cap plus the hook's own framing lines, not a second magic number.
  const lines = reason.split('\n').length;
  assert.ok(lines < MAX_LINES + 20, `reason should be bounded near MAX_LINES=${MAX_LINES}, got ${lines} lines`);
});

test('unsupported file type is a no-op', { skip }, () => {
  const dir = scratch(os.tmpdir(), 'lint-after-edit-');
  const f = path.join(dir, 'notes.txt');
  fs.writeFileSync(f, 'just some text\n');
  const out = runHook(JSON.stringify({ tool_input: { file_path: f } }));
  assert.strictEqual(decision(out), null);
});

test('malformed stdin JSON does not crash', { skip }, () => {
  const out = runHook('not json');
  assert.strictEqual(decision(out), null);
});

test('empty stdin does not crash', { skip }, () => {
  const out = runHook('');
  assert.strictEqual(decision(out), null);
});

// M10: a check that hangs past its bound must surface as "not evaluated," never
// as silence and never as a lint pass. LINT_TIMEOUT_S is a seam (see the hook)
// so the test doesn't have to wait out the real 8s default.
test('a check that hangs past its bound blocks with a not-evaluated reason', { skip: skipLintCase }, () => {
  const dir = scratch(os.tmpdir(), 'lint-after-edit-');
  const f = path.join(dir, 'slow.sh');
  fs.writeFileSync(f, '#!/bin/bash\nfoo=$1\necho $foo\n');
  const bin = scratch(os.tmpdir(), 'slow-shellcheck-');
  fs.writeFileSync(path.join(bin, 'shellcheck'), '#!/bin/bash\nsleep 999\n');
  fs.chmodSync(path.join(bin, 'shellcheck'), 0o755);
  const out = runHook(JSON.stringify({ tool_input: { file_path: f } }), {
    PATH: `${bin}:${process.env.PATH}`, LINT_TIMEOUT_S: '1',
  });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.decision, 'block');
  assert.match(parsed.reason, /not evaluated/);
  assert.doesNotMatch(parsed.reason, /SC2086/, 'a timeout must not be reported as if the check ran clean or found nothing');
});

// M10 fallback contract: a sourcing failure on run-bounded.sh must not silently
// skip the check — RUN_BOUNDED_LIB pointing nowhere forces exactly that failure
// without touching the real library file.
test('missing run-bounded.sh library: check still runs, unbounded, via the fallback stub', { skip: skipLintCase }, () => {
  const dir = scratch(os.tmpdir(), 'lint-after-edit-');
  const f = path.join(dir, 'bad.sh');
  fs.writeFileSync(f, '#!/bin/bash\nfoo=$1\necho $foo\n');
  const out = runHook(JSON.stringify({ tool_input: { file_path: f } }), {
    RUN_BOUNDED_LIB: '/nonexistent/run-bounded.sh',
  });
  assert.strictEqual(decision(out), 'block', 'the lint violation must still be caught without the lib');
  assert.match(out, /SC2086/);
});

