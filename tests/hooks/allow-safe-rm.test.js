// Regression guard for executable_allow-safe-rm.sh (PermissionRequest/Bash).
// Drives the ACTUAL hook and asserts it auto-allows ONLY a delete whose every
// operand is provably below a scratch root, and defers (no decision) for
// everything else. Offline and deterministic. Skips cleanly without bash/jq.
//
// The case lists below are NOT the warrant. A deny-list suite is only ever evidence
// about the shapes someone thought of -- so the load-bearing block is `structure`,
// which asserts the option table is an allowlist, that no root-defeating option was
// ever added to it, and that the single allow() call site stays behind the "we saw a
// confined operand" guard.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_allow-safe-rm.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

function behavior(command) {
  let out;
  try {
    out = execFileSync('bash', [HOOK], {
      input: JSON.stringify({ tool_input: { command } }),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: '/home/testuser', TMPDIR: '' },
    });
  } catch (e) { out = e.stdout || ''; }
  if (!out.trim()) return null; // hook deferred to normal handling
  try { return JSON.parse(out).hookSpecificOutput.decision.behavior; } catch { return null; }
}

const ALLOW = [
  'rm -rf /tmp/scratch',
  'rm -f /tmp/claude-1000/session/x.json',
  'rm /tmp/a/b/c.txt',
  'rm -rf /var/tmp/build',
  'rm -rf /home/testuser/.claude/jobs/abc123/tmp',
  'rm -rf /home/testuser/.cache/claude/x',
  'rm -rfv /tmp/a /tmp/b',
  'rm --recursive --force /tmp/a',
  'rm -rf -- /tmp/a',
  'rm -rf "/tmp/a b"',
  "rm -rf '/tmp/a b'",
  '/usr/bin/rm -rf /tmp/a',
];

// Each of these would be a real loss, or is a shape the hook cannot read with
// confidence. Both must defer -- an unreadable command is not a safe one.
const DEFER = [
  // The scratch roots themselves are not scratch.
  'rm -rf /tmp',
  'rm -rf /tmp/',
  'rm -rf /var/tmp',
  'rm -rf /home/testuser/.claude/jobs',
  'rm -rf /',
  // Traversal out of a root, lexically or quoted.
  'rm -rf /tmp/../etc',
  'rm -rf "/tmp/../etc"',
  'rm -rf /tmp/a/../../etc',
  // One bad operand condemns the whole command.
  'rm -rf /tmp/a /etc/passwd',
  'rm -rf /tmp/a /home/testuser/.ssh',
  // Outside any root.
  'rm -rf /home/testuser/.ssh',
  'rm -rf /etc/passwd',
  'rm -rf /home/testuser/src/project',
  // Shell expansion happens after the decision, so none of it is readable here.
  'rm -rf /tmp/*',
  'rm -rf /tmp/?',
  'rm -rf /tmp/[ab]',
  'rm -rf $HOME/x',
  'rm -rf "$HOME/x"',
  'rm -rf ~/scratch',
  'rm -rf `echo /tmp/a`',
  'rm -rf $(echo /tmp/a)',
  'rm -rf /tmp/a\\ b',
  // Relative paths: the cwd is unknown to a PermissionRequest hook.
  'rm -rf scratch',
  'rm -rf ./scratch',
  'rm -rf ../scratch',
  // Chaining, piping and redirection belong to allow-compound-bash.sh, not here.
  'rm -rf /tmp/a && rm -rf /etc',
  'rm -rf /tmp/a; rm -rf /etc',
  'rm -rf /tmp/a | tee /etc/x',
  'rm -rf /tmp/a > /etc/x',
  // The one option that would make every path check above a lie.
  'rm --no-preserve-root -rf /tmp/a',
  // Unnamed options are not decisions.
  'rm --unknown-flag /tmp/a',
  'rm -z /tmp/a',
  'rm -rz /tmp/a',
  // Not this hook's command, or no operand at all.
  'rm',
  'rm -rf',
  'rmdir /tmp/a',
  'srm -rf /tmp/a',
  'sudo rm -rf /tmp/a',
  'TMPDIR=/ rm -rf /tmp/a',
  // Collapsed separators: refuse rather than guess.
  'rm -rf /tmp//a',
  // Unterminated quote.
  'rm -rf "/tmp/a',
];

test('auto-allows deletes confined to a scratch root', { skip }, () => {
  for (const c of ALLOW) {
    assert.strictEqual(behavior(c), 'allow', `expected allow: ${c}`);
  }
});

test('defers everything it cannot prove confined', { skip }, () => {
  for (const c of DEFER) {
    assert.strictEqual(behavior(c), null, `expected defer: ${c}`);
  }
});

test('TMPDIR can only ever narrow, never widen', { skip }, () => {
  // TMPDIR is honoured only when it is itself under /tmp, so pointing it at a home
  // directory must not make that directory deletable.
  const run = (command, tmpdir) => {
    let out;
    try {
      out = execFileSync('bash', [HOOK], {
        input: JSON.stringify({ tool_input: { command } }),
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOME: '/home/testuser', TMPDIR: tmpdir },
      });
    } catch (e) { out = e.stdout || ''; }
    return out.trim() ? JSON.parse(out).hookSpecificOutput.decision.behavior : null;
  };
  assert.strictEqual(run('rm -rf /home/testuser/secrets', '/home/testuser'), null);
  assert.strictEqual(run('rm -rf /home/testuser/secrets', '/tmp/x'), null);
  // A TMPDIR under /tmp is already covered by the /tmp root itself.
  assert.strictEqual(run('rm -rf /tmp/x/a', '/tmp/x'), 'allow');
});

test('structure: the option table stays an allowlist', { skip }, () => {
  const src = fs.readFileSync(HOOK, 'utf8');

  // A single allow() call site, and it sits behind the "we saw a confined operand"
  // guard. More than one, or one before the loop, is how this stops being provable.
  const callSites = src.split('\n').filter((l) => /^\s*\(\(SAW_PATH == 1\)\) && allow$/.test(l));
  assert.strictEqual(callSites.length, 1, 'expected exactly one guarded allow() call site');
  assert.ok(!/^\s*allow\s*$/m.test(src), 'unguarded allow() call');

  // Options are matched against closed tables, never a catch-all.
  assert.ok(/BOOL_SHORT='[rRfdvIi]+'/.test(src), 'BOOL_SHORT table missing or widened');
  assert.ok(/LONG_OK=\(/.test(src), 'LONG_OK table missing');

  // Anything that relocates the operation off the paths checked must stay out.
  for (const banned of ['--no-preserve-root']) {
    const inTable = new RegExp(`LONG_OK=\\([^)]*${banned.replace(/-/g, '\\-')}`, 's').test(src);
    assert.ok(!inTable, `${banned} must never be in the option allowlist`);
  }

  // The refusals that make the path check meaningful.
  assert.ok(/\*\.\.\*\) return 1/.test(src), 'traversal refusal missing');
  assert.ok(/\*\/\/\*\) return 1/.test(src), 'collapsed-separator refusal missing');
  assert.ok(/\[\[ \$p == \/\* \]\] \|\| return 1/.test(src), 'relative-path refusal missing');
  assert.ok(/"\$root"\/\?\*/.test(src), 'root itself must not match as a child');
});
