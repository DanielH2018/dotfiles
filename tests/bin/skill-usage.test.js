// bin/skill-usage counts what is installed, not only what this repo's source holds: a skill
// or agent symlinked into ~/.claude by the work overlay, a project's own .claude/ skill or
// agent, and a command in ~/.claude or the vault, each count as installed rather than
// landing in the "Unmatched" list.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scratch } = require('../lib/tmp');

const BIN = path.join(__dirname, '..', '..', 'bin', 'skill-usage');
const NOW = 1762400000;

function fixture() {
  const t = fs.realpathSync(scratch(os.tmpdir(), 'skill-usage-'));
  const mk = (p, body = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
  mk(path.join(t, 'repo/home/private_dot_claude/skills/src-skill/SKILL.md'));
  mk(path.join(t, 'overlay/linked-skill/SKILL.md'));
  mk(path.join(t, 'overlay/linked-agent.md'));
  fs.mkdirSync(path.join(t, 'claude/skills/linked-skill'), { recursive: true });
  fs.symlinkSync(path.join(t, 'overlay/linked-skill/SKILL.md'), path.join(t, 'claude/skills/linked-skill/SKILL.md'));
  fs.mkdirSync(path.join(t, 'claude/agents'), { recursive: true });
  fs.symlinkSync(path.join(t, 'overlay/linked-agent.md'), path.join(t, 'claude/agents/linked-agent.md'));
  mk(path.join(t, 'claude/commands/user-cmd.md'));
  mk(path.join(t, 'vault/.claude/commands/vault-cmd.md'));
  mk(path.join(t, 'repo/.claude/skills/proj-skill/SKILL.md'));
  mk(path.join(t, 'repo/.claude/agents/proj-agent.md'));
  const ts = new Date((NOW - 60) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const line = (kind, name) => JSON.stringify({ ts, kind, name, ok: true });
  mk(path.join(t, 'log.jsonl'), [
    line('skill', 'src-skill'), line('skill', 'linked-skill'), line('agent', 'linked-agent'),
    line('skill', 'user-cmd'), line('skill', 'vault-cmd'), line('skill', 'gone-skill'),
    line('skill', 'proj-skill'), line('agent', 'proj-agent'),
  ].join('\n') + '\n');
  return t;
}

function run(t) {
  const r = spawnSync('python3', [BIN], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SKILL_USAGE_ROOT: path.join(t, 'repo'),
      SKILL_USAGE_CLAUDE_DIR: path.join(t, 'claude'),
      SKILL_USAGE_VAULT_DIR: path.join(t, 'vault'),
      SKILL_USAGE_LOG: path.join(t, 'log.jsonl'),
      SKILL_USAGE_NOW_EPOCH: String(NOW),
    },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}

test('linked skills and agents, and user and vault commands, count as installed', () => {
  const out = run(fixture());
  for (const [kind, name] of [['skill', 'src-skill'], ['skill', 'linked-skill'], ['agent', 'linked-agent'],
    ['command', 'user-cmd'], ['command', 'vault-cmd'], ['skill', 'proj-skill'], ['agent', 'proj-agent']]) {
    assert.match(out, new RegExp(`^${kind}\\s+${name}\\s+1\\s`, 'm'), `${kind} ${name} not counted:\n${out}`);
  }
});

test('a fire with nothing installed under its name is still reported unmatched', () => {
  const out = run(fixture());
  assert.match(out, /^7 of 8 log entries/m);
  assert.match(out, /^\s+skill\tgone-skill\t1$/m);
});
