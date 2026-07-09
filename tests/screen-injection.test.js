// Red-team test for executable_screen-injection.sh: feeds a fixture corpus of malicious
// and benign tool outputs through the ACTUAL hook and asserts it flags the attacks without
// false-positiving on benign content. Turns the injection hook from "trust it works" into
// "proven against known attacks", and is a regression guard for future edits.
//
// Categories (tests/fixtures/injection-fixtures.json):
//   flag      -> MUST emit the SECURITY additionalContext warning
//   silent    -> MUST stay quiet (no false positive)
//   known_gap -> evasions the regex hook currently MISSES; characterized, not asserted,
//                so we neither encode bad behavior as desired nor fail CI on a known limit.
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_screen-injection.sh');
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'injection-fixtures.json'), 'utf8'));

function runHook(input) {
  try {
    const stdout = execFileSync('bash', [HOOK], { input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
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

for (const f of fixtures.flag) {
  const r = runHook(f.input);
  assert.ok(isFlagged(r.stdout), `flag fixture must be warned: ${f.name}`);
}

for (const f of fixtures.silent) {
  const r = runHook(f.input);
  assert.strictEqual(r.stdout.trim(), '', `silent fixture must stay quiet (no false positive): ${f.name}`);
}

// known_gap: informational. If a future hardening starts catching one, surface it so the
// fixture gets reclassified to `flag` — but never fail (or lock in) on current misses.
let stillMissed = 0;
for (const f of fixtures.known_gap) {
  if (isFlagged(runHook(f.input).stdout)) console.log(`  NOTE: known_gap now FLAGGED — reclassify to 'flag': ${f.name}`);
  else stillMissed++;
}

console.log(`screen-injection: ${fixtures.flag.length} attacks flagged, ${fixtures.silent.length} benign quiet, `
  + `${stillMissed}/${fixtures.known_gap.length} known evasions still unflagged (backlog: back the regex with a model classifier)`);
console.log('ALL PASS');
