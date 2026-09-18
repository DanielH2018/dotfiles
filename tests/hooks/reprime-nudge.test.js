// Regression guard for executable_reprime-nudge.sh (PostToolUse, matcher "*").
// Runs the ACTUAL hook against a temp HOME with a small threshold, asserting it
// stays silent below the threshold, emits a re-read pointer at it, and doesn't
// immediately re-fire. Offline. Skips cleanly if bash/jq are unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');

const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_reprime-nudge.sh');

const skip = skipUnless('bash', 'jq');

// Forward-slash HOME so Git Bash resolves it cleanly on Windows.
function tmpHome() {
  const d = scratch(os.tmpdir(), 'reprime-').replace(/\\/g, '/');
  return d;
}

function runHook(home, every, input) {
  try {
    return execFileSync('bash', [HOOK], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, CLAUDE_REPRIME_EVERY: String(every) },
    });
  } catch (e) { return e.stdout || ''; }
}

function ctx(stdout) {
  if (!stdout.trim()) return null;
  try { return JSON.parse(stdout).hookSpecificOutput.additionalContext; } catch { return null; }
}

test('stays silent below the threshold, then nudges at it', { skip }, () => {
  const home = tmpHome();
  const body = { session_id: 's1' };
  assert.strictEqual(ctx(runHook(home, 3, body)), null, 'call 1 silent');
  assert.strictEqual(ctx(runHook(home, 3, body)), null, 'call 2 silent');
  const out = ctx(runHook(home, 3, body));
  assert.ok(out && /re-read/i.test(out), 'call 3 emits a re-read pointer');
});

test('does not re-nudge on the very next call', { skip }, () => {
  const home = tmpHome();
  const body = { session_id: 's2' };
  for (let i = 0; i < 3; i++) runHook(home, 3, body); // reach first nudge
  assert.strictEqual(ctx(runHook(home, 3, body)), null, 'call 4 silent again');
});

test('EVERY=0 disables the nudge entirely', { skip }, () => {
  const home = tmpHome();
  const body = { session_id: 's3' };
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(ctx(runHook(home, 0, body)), null, `call ${i + 1} silent when disabled`);
  }
});

test('malformed stdin exits cleanly with no nudge', { skip }, () => {
  const home = tmpHome();
  const out = runHook(home, 3, 'not json'); // returns stdout even on nonzero exit
  assert.strictEqual(ctx(out), null);
});

