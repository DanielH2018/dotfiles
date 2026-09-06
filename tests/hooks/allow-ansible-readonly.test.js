// Regression guard for executable_allow-ansible-readonly.sh (PermissionRequest/Bash).
// Drives the ACTUAL hook and asserts it auto-allows ONLY a provably read-only
// ansible-playbook invocation, and defers (no decision) for everything else.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_allow-ansible-readonly.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

function behavior(command) {
  let out;
  try {
    out = execFileSync('bash', [HOOK], {
      input: JSON.stringify({ tool_input: { command } }),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) { out = e.stdout || ''; }
  if (!out.trim()) return null;
  try { return JSON.parse(out).hookSpecificOutput.decision.behavior; } catch { return null; }
}

const ALLOW = [
  'ansible-playbook site.yml --check',
  'ansible-playbook site.yml --list-tasks',
  'ansible-playbook site.yml --list-tags',
  'ansible-playbook site.yml --list-hosts',
  'ansible-playbook site.yml --syntax-check',
  'ansible-playbook site.yml --check --diff',
  'uv run ansible-playbook site.yml --check',
  'uv run --frozen ansible-playbook site.yml --list-tasks',
  'stdio-blocking; ansible-playbook site.yml --check',
  'stdio-blocking; uv run ansible-playbook site.yml --check --tags x',
  'ansible-playbook site.yml --check 2>&1 | tail -n 50',
  'stdio-blocking; ansible-playbook site.yml --check 2>&1 | tail -n 12',
  // The shape uv-python.sh actually produces on the homelab: a bare -N count.
  'stdio-blocking; uv run ansible-playbook ansible/deploy.yml --tags karakeep --check 2>&1 | tail -3',
  'ansible-playbook site.yml --check -e foo=bar',
];

const DEFER = [
  // No read-only mode named at all.
  'ansible-playbook site.yml',
  'ansible-playbook deploy.yml --tags traefik',
  'uv run ansible-playbook site.yml',
  // A read-only flag word buried inside an -e/--extra-vars STRING value must not count.
  "ansible-playbook site.yml -e 'msg=--check'",
  "ansible-playbook site.yml --extra-vars 'msg=--list-tasks'",
  // A file-valued extra-vars disqualifies even alongside --check.
  'ansible-playbook site.yml --check -e @vars.yml',
  'ansible-playbook site.yml --check --extra-vars @vars.yml',
  'ansible-playbook site.yml --check --extra-vars=@vars.yml',
  'ansible-playbook site.yml --check -e@vars.yml',
  // Chaining beyond the one recognized trailing pipe is a refusal.
  'ansible-playbook site.yml --check && echo pwned',
  'ansible-playbook site.yml --check; echo pwned',
  'ansible-playbook site.yml --check | tee /tmp/x',
  // Not this hook's command at all.
  'echo ansible-playbook --check',
  'ansible-vault view secrets.yml',
  '',
];

test('auto-allows a provably read-only ansible-playbook invocation', { skip }, () => {
  for (const c of ALLOW) {
    assert.strictEqual(behavior(c), 'allow', `expected allow: ${c}`);
  }
});

test('defers everything it cannot prove read-only', { skip }, () => {
  for (const c of DEFER) {
    assert.strictEqual(behavior(c), null, `expected defer: ${c}`);
  }
});
