import { test } from 'node:test';
import assert from 'node:assert';
import { parseAgent, buildAgentsFlag, agentSearchDirs, loadAgentFromRepo } from '../evals/lib/load-agent.mjs';

const MD = `---
name: migration-reviewer
description: Review DB migrations for safety.
model: opus
tools: Read, Grep, Glob, Bash
---

You are a database migration safety reviewer.
Be specific about lock duration.`;

test('parseAgent extracts frontmatter and body', () => {
  const a = parseAgent(MD);
  assert.strictEqual(a.name, 'migration-reviewer');
  assert.strictEqual(a.model, 'opus');
  assert.strictEqual(a.description, 'Review DB migrations for safety.');
  assert.match(a.systemPrompt, /^You are a database migration safety reviewer\./);
  assert.ok(!a.systemPrompt.includes('---'));
});

test('parseAgent tolerates missing model and tools', () => {
  const a = parseAgent(`---\nname: planner\ndescription: Plan things.\n---\n\nDo planning.`);
  assert.strictEqual(a.model, null);
  assert.strictEqual(a.tools, null);
  assert.strictEqual(a.systemPrompt, 'Do planning.');
});

test('buildAgentsFlag emits model inside the JSON entry', () => {
  const a = parseAgent(MD);
  const flag = JSON.parse(buildAgentsFlag(a));
  assert.deepStrictEqual(Object.keys(flag), ['migration-reviewer']);
  assert.strictEqual(flag['migration-reviewer'].model, 'opus');
  assert.strictEqual(flag['migration-reviewer'].description, 'Review DB migrations for safety.');
  assert.match(flag['migration-reviewer'].prompt, /migration safety reviewer/);
});

test('buildAgentsFlag omits model key when none is set', () => {
  const a = parseAgent(`---\nname: planner\ndescription: Plan.\n---\nDo planning.`);
  const flag = JSON.parse(buildAgentsFlag(a));
  assert.ok(!('model' in flag['planner']));
});

test('buildAgentsFlag allows overrides (used by judge)', () => {
  const flag = JSON.parse(buildAgentsFlag(
    { name: 'x', description: 'd', systemPrompt: 'p', model: null },
    { name: 'judge', model: 'opus', prompt: 'JUDGE PROMPT' }));
  assert.deepStrictEqual(Object.keys(flag), ['judge']);
  assert.strictEqual(flag['judge'].model, 'opus');
  assert.strictEqual(flag['judge'].prompt, 'JUDGE PROMPT');
});

test('agentSearchDirs puts the repo agents dir first, then extra dirs', () => {
  const dirs = agentSearchDirs('/repo', ['/work/.claude/agents']);
  assert.deepStrictEqual(dirs, ['/repo/home/private_dot_claude/agents', '/work/.claude/agents']);
});

test('agentSearchDirs with no extra dirs is just the repo dir (hermetic default)', () => {
  assert.deepStrictEqual(agentSearchDirs('/repo', []), ['/repo/home/private_dot_claude/agents']);
});

test('loadAgentFromRepo throws a helpful error naming the dirs searched', () => {
  assert.throws(
    () => loadAgentFromRepo('nonexistent-agent', '/no/such/repo', ['/also/missing']),
    /not found in:.*EVAL_AGENT_DIRS/s
  );
});
