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

const HOOK = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_lint-after-edit.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

let shellcheckOk = true;
try { execFileSync('bash', ['-c', 'command -v shellcheck'], { stdio: 'ignore' }); } catch { shellcheckOk = false; }
const skipLintCase = toolsOk && shellcheckOk ? false : 'no supported linter installed';

const dirs = [];
function scratch() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-after-edit-')); dirs.push(d); return d; }

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
  const dir = scratch();
  const f = path.join(dir, 'clean.sh');
  fs.writeFileSync(f, '#!/bin/bash\nset -euo pipefail\nfoo="$1"\necho "$foo"\n');
  const out = runHook(JSON.stringify({ tool_input: { file_path: f } }));
  assert.strictEqual(decision(out), null);
});

test('shell script with a lint violation: block decision surfaces the output', { skip: skipLintCase }, () => {
  const dir = scratch();
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
  const dir = scratch();
  const f = path.join(dir, 'noisy.sh');
  const violations = Array.from({ length: 40 }, (_, i) => `v${i}=$1\necho $v${i}\n`).join('');
  fs.writeFileSync(f, `#!/bin/bash\n${violations}`);
  const out = runHook(JSON.stringify({ tool_input: { file_path: f } }));
  assert.strictEqual(decision(out), 'block');
  const reason = JSON.parse(out).reason;
  assert.match(reason, /more line\(s\) truncated/);
  // Head retained, so the first real finding still reaches the model.
  assert.match(reason, /SC2086/);
  assert.ok(reason.split('\n').length < 60, `reason should be bounded, got ${reason.split('\n').length} lines`);
});

test('unsupported file type is a no-op', { skip }, () => {
  const dir = scratch();
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
  const dir = scratch();
  const f = path.join(dir, 'slow.sh');
  fs.writeFileSync(f, '#!/bin/bash\nfoo=$1\necho $foo\n');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'slow-shellcheck-'));
  dirs.push(bin);
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
  const dir = scratch();
  const f = path.join(dir, 'bad.sh');
  fs.writeFileSync(f, '#!/bin/bash\nfoo=$1\necho $foo\n');
  const out = runHook(JSON.stringify({ tool_input: { file_path: f } }), {
    RUN_BOUNDED_LIB: '/nonexistent/run-bounded.sh',
  });
  assert.strictEqual(decision(out), 'block', 'the lint violation must still be caught without the lib');
  assert.match(out, /SC2086/);
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
