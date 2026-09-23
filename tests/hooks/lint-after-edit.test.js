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
const { have, skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_lint-after-edit.sh');

// The hook's truncation cap, read from the hook. The noisy-linter case below has to produce
// more output than this to reach the truncation branch at all, so a restated 40 here would
// stop testing truncation the moment the cap were raised — silently, still green.
const MAX_LINES = shConstInt(HOOK, 'MAX_LINES');

const skip = skipUnless('bash', 'jq');

// The hook runs every linter through run_bounded, which is built on coreutils timeout(1) --
// see run-bounded.test.js, whose whole suite skips on the same probe. Where no timeout exists
// (a stock macOS without Brewfile.tmpl's coreutils) run_bounded reports could-not-evaluate
// rather than running the linter, so every case below would see a not-evaluated block instead
// of the linter's verdict. They skip there for that reason.

const skipLintCase = !(have('bash') && have('jq') && have('shellcheck')) ? 'no supported linter installed'
  : skipUnless('bash', 'timeout');

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

// #581: a sourcing failure on run-bounded.sh must neither skip the check silently nor run it
// unbounded through a private copy of the primitive. It blocks with a not-evaluated reason, and
// runs nothing: RUN_BOUNDED_LIB pointing nowhere forces the failure without touching the real
// library, and a linter that would have flagged the file proves nothing ran. The accepting half
// is the clean-script case above, which runs with the library present.
test('missing run-bounded.sh library: blocks as not evaluated and runs no check', { skip }, () => {
  const dir = scratch(os.tmpdir(), 'lint-after-edit-');
  const f = path.join(dir, 'bad.sh');
  fs.writeFileSync(f, '#!/bin/bash\nfoo=$1\necho $foo\n');
  const out = runHook(JSON.stringify({ tool_input: { file_path: f } }), {
    RUN_BOUNDED_LIB: '/nonexistent/run-bounded.sh',
  });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.decision, 'block', 'a hook that cannot bound its checks must not pass silently');
  assert.match(parsed.reason, /not evaluated/);
  assert.match(parsed.reason, /\/nonexistent\/run-bounded\.sh/, 'the reason names the missing library');
  assert.doesNotMatch(parsed.reason, /SC2086/, 'no check may run without its bound');
});

// --- The Markdown prose case (#573) ---------------------------------------------------------
// Two of CLAUDE.md's writing rules are pure regex, and until this case existed they relied on
// the model remembering them through a long session. The rules are about PROSE, so the pair
// that matters is a sentence that must be flagged and the same sentence's reworded form, which
// must not be -- a check that fires on everything and one that fires on nothing look identical
// from the passing side.
const skipMd = skipUnless('bash', 'jq', 'perl', 'timeout');

function mdHook(body, name = 'doc.md') {
  const dir = scratch(os.tmpdir(), 'lint-after-edit-');
  const f = path.join(dir, name);
  fs.writeFileSync(f, body);
  return runHook(JSON.stringify({ tool_input: { file_path: f } }));
}

test('a dated sentence in Markdown blocks, and its reworded form does not', { skip: skipMd }, () => {
  // The live violation the issue names: pr-review-prep/SKILL.md opened a paragraph with this,
  // and the same paragraph reworded to an absolute date is what replaced it.
  const dated = mdHook('As of mid-2026, the API is private-preview.\n');
  assert.strictEqual(decision(dated), 'block');
  assert.match(dated, /dates the prose/);
  assert.strictEqual(decision(mdHook('Checked 2026-07-22: the API is private-preview.\n')), null);
});

test('an emoji in Markdown prose blocks; the same emoji in a fenced block does not',
  { skip: skipMd }, () => {
    assert.strictEqual(decision(mdHook('A sentence with ✨ in it.\n')), 'block');
    assert.strictEqual(decision(mdHook('Sample output:\n\n```\nDone ✨\n```\n')), null);
  });

// A banned word is not a banned word when the sentence is about the word. CLAUDE.md's own rule
// line spells them to ban them, and a check that reported it would fire on every edit of the
// file whose rules these are.
test('a dating word quoted, emphasised or in code is a mention, not a use', { skip: skipMd }, () => {
  assert.strictEqual(decision(mdHook('Cut *currently* from the sentence.\n')), null);
  assert.strictEqual(decision(mdHook('Prefer it to "the hook currently matches" here.\n')), null);
  assert.strictEqual(decision(mdHook('The `currently` flag is the one to drop.\n')), null);
  // ... and the bare use it exists to catch still reports.
  assert.strictEqual(decision(mdHook('The hook currently matches both forms.\n')), 'block');
});

// CLAUDE.md.tmpl is the file these rules live in and the most-edited prose file here, so the
// case has to reach a .md.tmpl as well as a .md.
test('the case covers .md.tmpl, not just .md', { skip: skipMd }, () => {
  assert.strictEqual(decision(mdHook('As of mid-2026, this dates the prose.\n', 'CLAUDE.md.tmpl')), 'block');
});
