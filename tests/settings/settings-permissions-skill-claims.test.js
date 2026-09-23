// The skills make claims about the permission model, and until now nothing checked them.
// otel-review/SKILL.md lists commands under "none of these prompt"; homelab/SKILL.md names the
// remote verbs `readonly_remote_safe()` auto-approves and the ones it deliberately does not.
// Both are statements about settings.permissions.json plus claude_guard, so an allow-rule edit
// or a check narrowed by a line could make either skill wrong with nothing going red (#584).
//
// The oracle is the real decision path, not a mirror of it. A JS reimplementation of prefix
// matching would get the otelq block right and every `ssh homelab <verb>` wrong: ssh is
// ask-listed, and what un-prompts it is claude_guard's PermissionRequest judge rather than a
// rule. So this renders the permission template into a scratch HOME and drives the deployed
// shim the way the harness drives it: stdout carrying an allow decision means no prompt, and
// silence means the prompt stands (the shim's failure contract, guard-permission-request.sh).
//
// Scope: a normal session OUTSIDE auto mode. `autoMode.classifyAllShell` suspends the Bash
// allow list while auto mode is active, so every verdict below is about the unsuspended model.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');
const { renderFile, chezmoiAvailable } = require('../lib/render');

const PERMISSIONS = srcPath('.chezmoitemplates', 'settings.permissions.json');
const SHIM = srcPath('private_dot_claude', 'hooks', 'executable_guard-permission-request.sh');
const GUARD_PKG = srcPath('dot_local', 'share', 'claude-guard');
const SKILLS = srcPath('private_dot_claude', 'skills');

const skip = !chezmoiAvailable ? 'chezmoi unavailable' : skipUnless('uv', 'bash');

// The shim resolves its interpreter with `uv python find`, which searches under $XDG_DATA_HOME.
// A scratch data dir holding one symlink to uv's managed-python directory answers that lookup
// without the suite reading -- or being one stray write away from touching -- the real one
// (#585). NO_COLOR because `uv python dir` wraps its answer in ANSI escapes even off a tty.
function xdgDataHome(dir) {
  const data = path.join(dir, 'xdg-data');
  fs.mkdirSync(path.join(data, 'uv'), { recursive: true });
  const managed = execFileSync('uv', ['python', 'dir'], {
    encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  }).trim();
  fs.symlinkSync(managed, path.join(data, 'uv', 'python'));
  return data;
}

// A HOME whose ~/.claude/settings.json IS the rendered permission model, which is where
// claude_guard reads its rules from.
// `box` rather than `home` on purpose: tests/lib/sandbox-escape.js binds taint by NAME across
// the whole file, and the callers below hold their result in a `home` built from the rendered
// template -- which is the checkout by another name. Sharing the identifier would make these
// two writes read as writes into the checkout.
function homeWith(dir, permissions) {
  const box = path.join(dir, 'home');
  fs.mkdirSync(path.join(box, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(box, '.claude', 'settings.json'), JSON.stringify({ permissions }));
  return box;
}

function prompts(home, data, command) {
  const r = spawnSync('bash', [SHIM], {
    input: JSON.stringify({ tool_input: { command }, cwd: os.tmpdir() }),
    encoding: 'utf8',
    env: {
      HOME: home,
      PATH: process.env.PATH,
      XDG_DATA_HOME: data,
      CLAUDE_GUARD_HOME: GUARD_PKG,
    },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  if (r.stdout.trim() === '') return true;
  const decision = JSON.parse(r.stdout).hookSpecificOutput.decision.behavior;
  assert.strictEqual(decision, 'allow', `unexpected decision for ${command}: ${r.stdout}`);
  return false;
}

// Rendered once for the file: `chezmoi execute-template` is the slow part here, and every test
// but the red-proof reads the model without changing it.
const permissions = skip ? null : JSON.parse(renderFile(PERMISSIONS));

// The otel-review claim, taken from the skill rather than copied out of it: the fenced blocks
// whose every line runs `otelq` or `otel-sweep` are the ones the prose says do not prompt
// ("needs no prompt", "none of these prompt"). A command added to either block is covered the
// day it lands; the LogQL and kubectl blocks the skill also carries make no claim about
// permissions and are not picked up.
function noPromptCommands(skillText) {
  const out = [];
  for (const block of skillText.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)) {
    // `<LogQL>` is a placeholder for a query, but to a shell parser it is a redirect, and the
    // guard refuses a redirected command on sight. Filling it in judges the command the skill
    // is actually documenting rather than the notation it documents it in.
    const lines = block[1].split('\n')
      .map((l) => l.replace(/\s+#.*$/, '').replace(/<[A-Za-z]+>/g, 'PLACEHOLDER').trim())
      .filter(Boolean);
    if (lines.length > 0 && lines.every((l) => /^(otelq|otel-sweep)\b/.test(l))) out.push(...lines);
  }
  return out;
}

test('every command otel-review says does not prompt is auto-approved', { skip }, (t) => {
  const commands = noPromptCommands(
    fs.readFileSync(path.join(SKILLS, 'otel-review', 'SKILL.md'), 'utf8'),
  );
  // Derived by pattern, so it can go empty in silence: the floor is named members.
  assert.ok(commands.includes('otelq ready'), commands.join(' | '));
  assert.ok(commands.some((c) => c.startsWith('otel-sweep')), commands.join(' | '));
  assert.ok(commands.length >= 8, `expected the skill's eight documented commands, got ${commands.length}`);

  const dir = scratch(os.tmpdir(), 'skill-claims-', t);
  const home = homeWith(dir, permissions);
  const data = xdgDataHome(dir);
  const prompting = commands.filter((c) => prompts(home, data, c));
  assert.deepStrictEqual(prompting, [], 'otel-review/SKILL.md says these need no prompt');
});

// The homelab skill's list is prose, not a fenced block, so the vectors are written out with
// the claim each one stands for. The negatives carry the weight: a check that only ever proves
// things are allowed cannot tell an accurate allowlist from one that approves everything.
const HOMELAB = [
  ['ssh homelab uptime', false, 'Host state: uptime'],
  ['ssh homelab df -h', false, 'Host state: df'],
  ['ssh homelab ls /etc', false, 'Files and text: ls'],
  ['ssh homelab journalctl -n 20', false, 'Services: journalctl'],
  ['ssh homelab systemctl status ssh', false, 'Services: systemctl status'],
  ['ssh homelab docker ps', false, 'Docker: ps'],
  ['ssh homelab printenv', true, 'prints exported variables, which hold tokens on this host'],
  ['ssh homelab docker inspect x', true, 'prints container Env[], the same exfiltration path'],
  ['ssh homelab command -v ls', true, 'a shell builtin that would launder any verb'],
  ['ssh homelab mount', true, 'can write'],
  ['ssh homelab systemctl restart nginx', true, 'not a read-only verb'],
  ["ssh homelab 'uptime && touch /tmp/zz'", true, 'the guard refuses a chained invocation'],
  ["ssh homelab 'cat /etc/hosts > /tmp/zz'", true, 'the guard refuses a redirected one'],
];

test('the remote verbs homelab/SKILL.md sorts into allowed and prompting land where it says',
  { skip }, (t) => {
    const dir = scratch(os.tmpdir(), 'skill-claims-', t);
    const home = homeWith(dir, permissions);
    const data = xdgDataHome(dir);
    const wrong = HOMELAB
      .filter(([cmd, expected]) => prompts(home, data, cmd) !== expected)
      .map(([cmd, expected, why]) => `${cmd} (documented ${expected ? 'prompting' : 'allowed'}: ${why})`);
    assert.deepStrictEqual(wrong, []);
  });

// otel-review also makes a negative claim: a `python3 -` heredoc is not allow-listed, so the
// reflex the skill exists to absorb costs a prompt. (Its neighbouring claim about `curl` does
// NOT hold -- claude_guard's curl_safe() auto-approves a plain GET to the Loki API -- and is
// filed rather than asserted here, because pinning the skill's text would pin a verdict the
// guard disagrees with.)
test('the reflexes otel-review says cost a prompt still cost one', { skip }, (t) => {
  const dir = scratch(os.tmpdir(), 'skill-claims-', t);
  const home = homeWith(dir, permissions);
  const data = xdgDataHome(dir);
  for (const cmd of ["python3 - <<'PY'", 'python3 -c "print(1)"']) {
    assert.ok(prompts(home, data, cmd), `${cmd} should still prompt`);
  }
});

// The red half. Every assertion above is a green reading of the live model; this one removes
// the single allow rule the otel-review claim rests on, in a copy, and asserts the verdict
// flips. Without it a matcher that silently stopped matching would read the same as a model
// that grants everything.
test('dropping the otelq allow rule turns the otel-review claim red', { skip }, (t) => {
  const dir = scratch(os.tmpdir(), 'skill-claims-', t);
  const data = xdgDataHome(dir);
  const narrowed = { ...permissions, allow: permissions.allow.filter((r) => r !== 'Bash(otelq:*)') };
  assert.strictEqual(narrowed.allow.length, permissions.allow.length - 1,
    'the rule this test removes must exist in the rendered model');
  assert.ok(!prompts(homeWith(dir, permissions), data, 'otelq ready'));
  assert.ok(prompts(homeWith(path.join(dir, 'narrowed'), narrowed), data, 'otelq ready'));
});
