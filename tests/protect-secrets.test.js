// Regression guard for executable_protect-secrets.sh (PreToolUse/Read|Edit|Write).
// Feeds file paths through the ACTUAL hook and asserts sensitive paths are denied
// while ordinary source files pass. Offline. Skips cleanly if bash/jq are unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
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

// Every decision here is routed through jq, so a PATH without jq used to make the hook
// exit 0 with empty stdout — the secret-file layer gone, and nothing saying so. Run the
// hook with an empty PATH (the preflight needs only shell builtins) and require a
// decision. spawnSync, not execFileSync: the hook exits before reading stdin, and the
// resulting EPIPE would surface as a throw.
const noJqSkip = skip || (fs.existsSync('/bin/bash') ? false : '/bin/bash unavailable');
function runHookWithoutJq(file_path) {
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nojq-'));
  try {
    return spawnSync('/bin/bash', [HOOK], {
      input: JSON.stringify({ tool_input: { file_path } }),
      encoding: 'utf8',
      env: { PATH: emptyPath, HOME: os.homedir() },
    }).stdout || '';
  } finally {
    fs.rmSync(emptyPath, { recursive: true, force: true });
  }
}

test('asks rather than failing open when jq is unavailable', { skip: noJqSkip }, () => {
  assert.strictEqual(decision(runHookWithoutJq('/home/u/.ssh/id_rsa')), 'ask');
  // The path cannot be parsed without jq, so the fallback is unconditional — an
  // ordinary file gets the same prompt. That is the point: visible, not silent.
  assert.strictEqual(decision(runHookWithoutJq('/home/u/project/README.md')), 'ask');
});
