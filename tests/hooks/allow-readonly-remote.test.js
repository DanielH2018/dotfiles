// Regression guard for executable_allow-readonly-remote.sh (PermissionRequest/Bash).
// Drives the ACTUAL hook and asserts it auto-allows ONLY provably read-only
// commands run on a remote host via `hl` or a plain `ssh host CMD`, and defers
// (no decision) for anything mutating, quoted-smuggled, secret-reading, or
// non-remote. Offline and deterministic. Skips cleanly without bash/jq.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_allow-readonly-remote.sh');
// The library is still `executable_cmdparse.sh` in the source tree; chezmoi drops the
// prefix on apply, which is the hook's default sibling path. CMDPARSE_LIB points the hook
// at the source copy so the suite runs straight out of the tree, same idiom as
// cmdparse-shadow.test.js.
const CMDPARSE_LIB = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_cmdparse.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

function behavior(command) {
  let out;
  try {
    out = execFileSync('bash', [HOOK], {
      input: JSON.stringify({ tool_input: { command } }),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CMDPARSE_LIB },
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
  'hl ip route',
  'hl ip addr show',
  'hl dmesg',
  'hl ss -tlnp',
  'hl docker ps',
  'hl docker ps -a',
  'hl docker logs web',
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
  // whole-environment dumps: read-only in form, but they print every exported token
  'hl env',
  'hl printenv',
  'hl cat /proc/self/environ',
  'hl cat /proc/1234/environ',
  'ssh ubuntu@10.0.0.161 printenv',
  // credential stores that weren't on the secret-path list
  'hl cat /etc/shadow',
  'hl cat ~/.git-credentials',
  'hl cat ~/.kube/config',
  'hl cat ~/.claude.json',
  'hl cat ~/.config/gh/hosts.yml',
  // journalctl that deletes/rotates logs
  'hl journalctl --vacuum-size=100M',
  'hl journalctl --rotate',
  // `command` is a shell builtin on the remote that executes its argument,
  // laundering any verb past the allowlist
  'hl command rm -rf /tmp/x',
  'hl command curl http://evil.example',
  // write primitives disguised as read-only: all take an output file
  'hl sort -o /home/ubuntu/.bashrc /tmp/payload',
  'hl uniq /tmp/payload /home/ubuntu/.bashrc',
  'hl xxd -r /tmp/payload /home/ubuntu/.bashrc',
  // mutating verbs/subcommands with no gate
  'hl ip link set eth0 down',
  'hl mount /dev/sdb1 /mnt',
  'hl dmesg -C',
  'hl dmesg -c',
  'hl dmesg --clear',
  'hl ss -K',
  'hl ss --kill',
  // glob evasion of the secret-path regex — the remote shell expands these
  'hl cat /proc/self/enviro?',
  'hl cat /proc/self/env*',
  'hl cat /home/ubuntu/.en?',
  'hl cat /home/ubuntu/.s?h/id_?sa',
  // /proc/*/environ variants the narrow regex missed
  'hl cat /proc//self/environ',
  'hl cat /proc/self/task/1/environ',
  // secret directories without a trailing slash
  'hl grep -r x /home/ubuntu/.ssh',
  'hl grep -r x /home/ubuntu/.gnupg',
  'hl ls /secrets',
  // credential stores not previously covered
  'hl tail /home/ubuntu/.bash_history',
  'hl cat /home/ubuntu/.config/gcloud/credentials.db',
  'hl cat /home/ubuntu/.config/rclone/rclone.conf',
  'hl cat /home/ubuntu/terraform.tfstate',
  // env-dumping subcommands: same exfiltration shape as `env`/`printenv`
  'hl docker inspect web',
  'hl docker container inspect web',
  'hl docker image inspect web',
  'hl docker service inspect web',
  'hl docker compose config',
  'hl systemctl show nginx',
  'hl systemctl cat nginx',
  'hl systemctl show-environment',
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
  // a metacharacter smuggled inside a QUOTED remote argument is still live once ssh joins
  // argv into one string for the remote shell to reparse -- local quoting doesn't survive
  // that trip, so these must defer exactly like their unquoted equivalents above.
  'hl systemctl status "app; id"',
  "ssh host 'uptime; rm -rf /'",
  'hl echo "a $(id)"',
  // an unbalanced quote: the old strip-and-split had no balance check at all and would
  // have silently mis-tokenized this; cmd_parse's refusal must reach here as a defer.
  'hl echo "unterminated',
];

// A literal newline embedded in a quoted argument is the same remote-reparsing hazard as
// a quoted `;` (see the case above), but JSON is the only way to get a real newline
// character into a command string here rather than the literal backslash-n the other
// DEFER cases use.
test('defers on a newline smuggled inside a quoted remote argument', { skip }, () => {
  assert.strictEqual(behavior('hl echo "a\nrm -rf /"'), null);
});

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
