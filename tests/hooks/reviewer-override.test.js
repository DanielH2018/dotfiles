// The code-reviewer dispatch must state the override of the agent's confidence >= 80
// gate. Each case is a Task/Agent payload the hook must pass or deny.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { srcPath } = require('../lib/paths');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_reviewer-override.sh');

function run(toolInput, env = {}) {
  const e = { ...process.env, ...env };
  delete e.CLAUDE_REVIEWER_OVERRIDE_CHECK;
  Object.assign(e, env);
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ tool_name: 'Agent', tool_input: toolInput }),
    env: e,
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, `hook exits 0 (stderr: ${r.stderr})`);
  const out = r.stdout.trim();
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

const REVIEWER = 'feature-dev:code-reviewer';

test('a code-reviewer prompt without the override is denied, and the reason carries a passing sentence', () => {
  const out = run({ subagent_type: REVIEWER, prompt: 'Review the diff on this branch.' });
  assert.strictEqual(out.permissionDecision, 'deny');
  const sentence = out.permissionDecisionReason.split('\n\n').pop();
  assert.strictEqual(run({ subagent_type: REVIEWER, prompt: `Review the diff.\n${sentence}` }), null,
    'the sentence the deny offers must itself pass');
});

test('a code-reviewer prompt that states the override passes', () => {
  assert.strictEqual(run({
    subagent_type: REVIEWER,
    prompt: 'Review the diff. Report everything: I am overriding your confidence >= 80 gate.',
  }), null);
});

test('the override may come after the number', () => {
  assert.strictEqual(run({
    subagent_type: REVIEWER,
    prompt: 'Your gate of 80 is\noverridden for this review; list all findings with scores.',
  }), null);
});

test('mentioning 80 without an override is still denied', () => {
  const out = run({ subagent_type: REVIEWER, prompt: 'Only report issues above confidence 80.' });
  assert.strictEqual(out.permissionDecision, 'deny');
});

test('any other subagent type passes untouched', () => {
  assert.strictEqual(run({ subagent_type: 'Explore', prompt: 'Find the hook.' }), null);
});

test('CLAUDE_REVIEWER_OVERRIDE_CHECK=0 silences the hook', () => {
  assert.strictEqual(run({ subagent_type: REVIEWER, prompt: 'Review it.' },
    { CLAUDE_REVIEWER_OVERRIDE_CHECK: '0' }), null);
});
