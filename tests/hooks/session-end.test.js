// Behavioral test for the SessionEnd hook (executable_session-end.sh). Real bash against
// the ACTUAL hook; skips without bash/jq. The transcript scan the hook detaches is covered
// by tests/claude-transcript-scan.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_session-end.sh');

const skip = skipUnless('bash', 'jq');

test('exits cleanly and writes no sessions.log', { skip }, () => {
  // HOME is faked so a test run never touches the real ~/.claude/logs. The sessions.log
  // append was dropped (no reader ever consumed it) — this guards against it coming back.
  const home = scratch(os.tmpdir(), 'se-home-');
  fs.mkdirSync(path.join(home, '.claude', 'logs'), { recursive: true });
  execFileSync('bash', [HOOK], {
    input: JSON.stringify({ session_id: 'test-session', cwd: home }),
    env: { ...process.env, HOME: home }, cwd: home, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.strictEqual(fs.existsSync(path.join(home, '.claude', 'logs', 'sessions.log')), false);
});
