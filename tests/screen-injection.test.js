// Red-team test for executable_screen-injection.sh: feeds a fixture corpus of malicious
// and benign tool outputs through the ACTUAL hook and asserts the two-layer defense
// behaves. Everything runs OFFLINE — Layer 2's model call is replaced by a stub through
// the hook's SCREEN_INJECTION_CLASSIFY_CMD seam, so CI/pre-push never hits the network.
//
// Categories (tests/fixtures/injection-fixtures.json):
//   flag                -> Layer-1 (deterministic) MUST warn.
//   silent              -> MUST stay quiet (no false positive).
//   flag_via_classifier -> Layer-1 MISSES (asserted); with the classifier enabled and a
//                          stubbed injection:true verdict the hook MUST warn.
//   classifier_silent   -> reaches the classifier, but a stubbed injection:false verdict
//                          MUST keep the hook quiet.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_screen-injection.sh');
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'injection-fixtures.json'), 'utf8'));

function runHook(input, env = {}) {
  try {
    const stdout = execFileSync('bash', [HOOK], {
      input: JSON.stringify(input), encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
    });
    return { stdout, status: 0 };
  } catch (e) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', status: e.status };
  }
}

// A run is "flagged" iff the hook emitted valid JSON carrying the SECURITY additionalContext.
function isFlagged(stdout) {
  if (!/SECURITY:/.test(stdout)) return false;
  try { return typeof JSON.parse(stdout).hookSpecificOutput.additionalContext === 'string'; }
  catch { return false; }
}

// Offline stubs for the classifier seam — never touch the network.
const STUB_TRUE = `printf '%s' '{"injection":true,"reason":"stub"}'`;
const STUB_FALSE = `printf '%s' '{"injection":false,"reason":"stub"}'`;
const clsOn = (cmd) => ({ SCREEN_INJECTION_CLASSIFIER: '1', SCREEN_INJECTION_CLASSIFY_CMD: cmd });

// Layer 1 — deterministic, classifier OFF (default).
test('flag fixtures are warned by Layer 1', () => {
  for (const f of fixtures.flag) {
    assert.ok(isFlagged(runHook(f.input).stdout), `flag fixture must be warned by Layer 1: ${f.name}`);
  }
});

test('silent fixtures stay quiet under Layer 1', () => {
  for (const f of fixtures.silent) {
    assert.strictEqual(runHook(f.input).stdout.trim(), '', `silent fixture must stay quiet: ${f.name}`);
  }
});

// Layer 2 — classifier enabled, verdict stubbed (offline).
test('flag_via_classifier fixtures slip Layer 1 but are warned when the classifier says injection:true', () => {
  for (const f of fixtures.flag_via_classifier) {
    // Must genuinely slip Layer 1 (else it belongs in `flag`).
    assert.strictEqual(runHook(f.input).stdout.trim(), '', `flag_via_classifier must slip Layer 1: ${f.name}`);
    assert.ok(isFlagged(runHook(f.input, clsOn(STUB_TRUE)).stdout), `classifier injection:true must warn: ${f.name}`);
  }
});

test('classifier_silent fixtures stay quiet when the classifier says injection:false', () => {
  for (const f of fixtures.classifier_silent) {
    assert.strictEqual(runHook(f.input, clsOn(STUB_FALSE)).stdout.trim(), '', `classifier injection:false must stay quiet: ${f.name}`);
  }
});

console.log(`screen-injection: ${fixtures.flag.length} flagged by regex, `
  + `${fixtures.flag_via_classifier.length} via classifier (stubbed), `
  + `${fixtures.silent.length} benign quiet, 0 known evasions.`);
