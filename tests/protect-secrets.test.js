// Regression guard for executable_protect-secrets.sh (PreToolUse/Read|Edit|Write).
// Feeds file paths through the ACTUAL hook and asserts sensitive paths are denied
// while ordinary source files pass. Offline. Skips cleanly if bash/jq are unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_protect-secrets.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

function runHook(file_path) {
  try {
    return execFileSync('bash', [HOOK], {
      input: JSON.stringify({ tool_input: { file_path } }),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) { return e.stdout || ''; }
}
function decision(stdout) {
  if (!stdout.trim()) return null;
  try { return JSON.parse(stdout).hookSpecificOutput.permissionDecision; } catch { return null; }
}

const DENY = [
  '.env',
  '/home/u/project/.env',
  '.env.local',
  '/home/u/.ssh/id_rsa',
  '/home/u/.ssh/config',
  '/home/u/.aws/credentials',
  '/home/u/.netrc',
  '/home/u/.npmrc',
  '/home/u/.gnupg/secring.gpg',
  '/opt/app/server.pem',
  '/opt/app/tls.key',
  '/opt/app/cert.p12',
  '/srv/secrets/token.txt',
];

const ALLOW = [
  '/home/u/project/src/main.go',
  '/home/u/project/README.md',
  '/home/u/project/config.yaml',
  '/home/u/project/package.json',
];

test('sensitive file paths are denied', { skip }, () => {
  for (const p of DENY) assert.strictEqual(decision(runHook(p)), 'deny', `should deny: ${p}`);
});

test('ordinary source files are allowed', { skip }, () => {
  for (const p of ALLOW) assert.notStrictEqual(decision(runHook(p)), 'deny', `should not deny: ${p}`);
});
