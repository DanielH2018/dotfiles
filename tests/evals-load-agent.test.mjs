import { test } from 'node:test';
import assert from 'node:assert';
import { parseAgent, buildAgentsFlag, agentSearchDirs, loadAgentFromRepo } from '../evals/lib/load-agent.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';

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

test('loadAgentFromRepo resolves a skill via <name>/SKILL.md and tolerates allowed-tools frontmatter', () => {
  const extra = mkdtempSync(pjoin(tmpdir(), 'skilldir-'));
  const sdir = pjoin(extra, 'homelab-review');
  mkdirSync(sdir, { recursive: true });
  writeFileSync(pjoin(sdir, 'SKILL.md'),
    '---\nname: homelab-review\ndescription: Multi-agent review.\nallowed-tools: Read, Grep, Glob, Bash, Agent\n---\n\nRun a review and STOP.');
  const fakeRepo = mkdtempSync(pjoin(tmpdir(), 'repo-'));  // no chezmoi agent shadows the name
  try {
    const a = loadAgentFromRepo('homelab-review', fakeRepo, [extra]);
    assert.strictEqual(a.name, 'homelab-review');
    assert.strictEqual(a.description, 'Multi-agent review.');
    assert.match(a.systemPrompt, /Run a review and STOP\./);
  } finally {
    rmSync(extra, { recursive: true, force: true });
    rmSync(fakeRepo, { recursive: true, force: true });
  }
});
