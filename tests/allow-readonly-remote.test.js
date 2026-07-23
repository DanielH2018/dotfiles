// Regression guard for executable_allow-readonly-remote.sh (PermissionRequest/Bash).
// Drives the ACTUAL hook and asserts it auto-allows ONLY provably read-only
// commands run on a remote host via `hl` or a plain `ssh host CMD`, and defers
// (no decision) for anything mutating, quoted-smuggled, secret-reading, or
// non-remote. Offline and deterministic. Skips cleanly without bash/jq.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_allow-readonly-remote.sh');

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
  if (!out.trim()) return null; // hook deferred to normal handling
  try { return JSON.parse(out).hookSpecificOutput.decision.behavior; } catch { return null; }
}

const ALLOW = [
  'hl uptime',
  'hl df -h',
  'hl free -m',
  'hl ip a',
  'hl ss -tlnp',
  'hl docker ps',
  'hl docker ps -a',
  'hl docker logs web',
  'hl docker inspect web',
  'hl docker network ls',
  'hl docker compose ps',
  'hl docker system df',
  'hl systemctl status nginx',
  'hl systemctl is-active docker',
  'hl journalctl -u docker -n 50',
  'hl journalctl -u "my svc" --since -1h',   // quotes are pure grouping
  'hl cat /etc/os-release',
  'hl ls -la /var/log',
  'ssh ubuntu@10.0.0.161 uptime',
  'ssh 10.0.0.161 docker ps',
  '/home/daniel/.local/bin/hl uptime',       // absolute path to wrapper
];

const DEFER = [
  // mutating remote verbs
  'hl docker rm web',
  'hl docker restart web',
  'hl docker compose down',
  'hl docker stop web',
  'hl systemctl restart nginx',
  'hl systemctl stop docker',
  'hl rm -rf /tmp/x',
  'hl apt install htop',
  'hl git push',
  'hl sed -i s/a/b/ f',                       // sed -i mutates; not on allowlist
  'hl frobnicate',                            // unknown verb
  // metacharacter smuggling
  'hl uptime; rm -rf /',
  'hl docker ps && rm x',
  'hl uptime | tee /etc/x',
  'hl cat $(echo /etc/passwd)',
  'hl echo `whoami`',
  'hl docker ps > out.txt',
  'hl uptime & reboot',
  // secret exfiltration (read-only verb, but secret path)
  'hl cat /home/ubuntu/.ssh/id_ed25519',
  'hl cat ~/.aws/credentials',
  'hl tail /etc/app/.env',
  // journalctl that deletes/rotates logs
  'hl journalctl --vacuum-size=100M',
  'hl journalctl --rotate',
  // interactive shells (no remote command)
  'hl',
  'ssh ubuntu@10.0.0.161',
  // ssh with options — deferred so an option value is never read as the verb
  'ssh -i ~/.ssh/key ubuntu@10.0.0.161 uptime',
  'ssh -p 2222 host uptime',
  // not a remote invocation at all
  'docker ps',
  'ls -la',
  'git status',
  'hlfoo uptime',                             // must be exactly `hl`, not a prefix
];

test('auto-allows provably read-only hl/ssh remote commands', { skip }, () => {
  for (const cmd of ALLOW) {
    assert.strictEqual(behavior(cmd), 'allow', `expected ALLOW for: ${cmd}`);
  }
});

test('defers for mutating, smuggled, secret, or non-remote commands', { skip }, () => {
  for (const cmd of DEFER) {
    assert.strictEqual(behavior(cmd), null, `expected DEFER for: ${cmd}`);
  }
});
