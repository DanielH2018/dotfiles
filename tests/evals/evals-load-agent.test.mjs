import { test } from 'node:test';
import assert from 'node:assert';
import { parseAgent, buildAgentsFlag, agentSearchDirs, loadAgentFromRepo, loadAgentFlagOrError, loadSkillFromRepo, loadSkillFlagOrError } from '../../evals/lib/load-agent.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
  assert.deepStrictEqual(dirs, [pjoin('/repo', 'home', 'private_dot_claude', 'agents'), '/work/.claude/agents']);
});

test('agentSearchDirs with no extra dirs is just the repo dir (hermetic default)', () => {
  assert.deepStrictEqual(agentSearchDirs('/repo', []), [pjoin('/repo', 'home', 'private_dot_claude', 'agents')]);
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

test('loadAgentFlagOrError returns an error (no flag) for a bogus agent name', () => {
  const fakeRepo = mkdtempSync(pjoin(tmpdir(), 'repo-'));  // no agents dir contents
  try {
    const r = loadAgentFlagOrError('nonexistent-agent', fakeRepo, []);
    assert.ok(r.error);
    assert.ok(!('flag' in r));
  } finally {
    rmSync(fakeRepo, { recursive: true, force: true });
  }
});

test('loadSkillFlagOrError resolves a repo skill as synthetic agent skill-<name> with a pinned model', () => {
  const fakeRepo = mkdtempSync(pjoin(tmpdir(), 'repo-'));
  const sdir = pjoin(fakeRepo, 'home', 'private_dot_claude', 'skills', 'grilling');
  mkdirSync(sdir, { recursive: true });
  writeFileSync(pjoin(sdir, 'SKILL.md'),
    '---\nname: grilling\ndescription: One-question-at-a-time interview.\nmetadata:\n    author: daniel\n    version: 0.1.0\n---\n\nAsk exactly one question per turn.');
  try {
    const r = loadSkillFlagOrError('grilling', fakeRepo);
    assert.ok(!r.error, r.error);
    const flag = JSON.parse(r.flag);
    assert.deepStrictEqual(Object.keys(flag), ['skill-grilling']);
    assert.strictEqual(flag['skill-grilling'].model, 'opus');     // pinned: skills carry no model frontmatter
    assert.match(flag['skill-grilling'].prompt, /^The skill below has just been invoked/); // execution framing
    assert.match(flag['skill-grilling'].prompt, /exactly one question per turn/);
    assert.ok(!flag['skill-grilling'].prompt.includes('author:')); // frontmatter stripped, incl. indented metadata
  } finally {
    rmSync(fakeRepo, { recursive: true, force: true });
  }
});

test('loadSkillFlagOrError reports an error naming the missing path for an unknown skill', () => {
  const fakeRepo = mkdtempSync(pjoin(tmpdir(), 'repo-'));
  try {
    const r = loadSkillFlagOrError('nonexistent-skill', fakeRepo);
    assert.ok(r.error);
    assert.match(r.error, /nonexistent-skill/);
    assert.ok(!('flag' in r));
  } finally {
    rmSync(fakeRepo, { recursive: true, force: true });
  }
});

test('loadSkillFromRepo renders a templated SKILL.md.tmpl source', () => {
  const fakeRepo = mkdtempSync(pjoin(tmpdir(), 'repo-'));
  const sdir = pjoin(fakeRepo, 'home', 'private_dot_claude', 'skills', 'skill-router');
  mkdirSync(sdir, { recursive: true });
  writeFileSync(pjoin(sdir, 'SKILL.md.tmpl'),
    '---\nname: skill-router\ndescription: Route to a skill.\n---\n\nUse {{ if .work }}to-spec{{ end }}writing-plans.');
  try {
    const rendered = [];
    const a = loadSkillFromRepo('skill-router', fakeRepo, (p) => {
      rendered.push(p);
      return readFileSync(p, 'utf8').replace(/\{\{ if \.work \}\}.*?\{\{ end \}\}/g, '');
    });
    assert.deepStrictEqual(rendered, [pjoin(sdir, 'SKILL.md.tmpl')]);
    assert.strictEqual(a.name, 'skill-router');
    assert.strictEqual(a.systemPrompt, 'Use writing-plans.');
  } finally {
    rmSync(fakeRepo, { recursive: true, force: true });
  }
});

test('loadSkillFromRepo prefers a plain SKILL.md over a templated sibling', () => {
  const fakeRepo = mkdtempSync(pjoin(tmpdir(), 'repo-'));
  const sdir = pjoin(fakeRepo, 'home', 'private_dot_claude', 'skills', 'grilling');
  mkdirSync(sdir, { recursive: true });
  writeFileSync(pjoin(sdir, 'SKILL.md'), '---\nname: grilling\ndescription: d\n---\n\nplain body');
  writeFileSync(pjoin(sdir, 'SKILL.md.tmpl'), '---\nname: grilling\ndescription: d\n---\n\ntemplated body');
  try {
    const a = loadSkillFromRepo('grilling', fakeRepo, () => { throw new Error('should not render'); });
    assert.strictEqual(a.systemPrompt, 'plain body');
  } finally {
    rmSync(fakeRepo, { recursive: true, force: true });
  }
});

test('loadSkillFromRepo error names both the plain and templated paths it looked for', () => {
  const fakeRepo = mkdtempSync(pjoin(tmpdir(), 'repo-'));
  try {
    assert.throws(() => loadSkillFromRepo('nonexistent-skill', fakeRepo), /SKILL\.md or .*SKILL\.md\.tmpl/s);
  } finally {
    rmSync(fakeRepo, { recursive: true, force: true });
  }
});

test('loadAgentFlagOrError returns a flag (no error) for a resolvable agent', () => {
  const extra = mkdtempSync(pjoin(tmpdir(), 'agentdir-'));
  writeFileSync(pjoin(extra, 'greeter.md'),
    '---\nname: greeter\ndescription: Says hello.\n---\n\nSay hello.');
  const fakeRepo = mkdtempSync(pjoin(tmpdir(), 'repo-'));
  try {
    const r = loadAgentFlagOrError('greeter', fakeRepo, [extra]);
    assert.ok(!r.error);
    assert.strictEqual(typeof r.flag, 'string');
    const parsed = JSON.parse(r.flag);
    assert.deepStrictEqual(Object.keys(parsed), ['greeter']);
  } finally {
    rmSync(extra, { recursive: true, force: true });
    rmSync(fakeRepo, { recursive: true, force: true });
  }
});
