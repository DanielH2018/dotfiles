# Subagent Evals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a subagent eval harness in the chezmoi repo that invokes each custom agent headlessly via `claude -p`, grades output with a deterministic assertion gate plus an LLM judge, and reports an all-pass / pass-rate consistency signal.

**Architecture:** Pure ES-module libraries under `evals/lib/` (parsing, assertions, run classification, reporting) are unit-tested with `node:test` and **no API calls**. Two thin shell-out modules (`invoke-agent`, `judge`) call the `claude` CLI and are proven by a live smoke run. A CLI entry point (`run-evals.mjs`) orchestrates. Cases are JSON data files under `evals/cases/<agent>/`.

**Tech Stack:** Node.js ES modules (`.mjs`), `node:test` + `node:assert`, `node:child_process` (`execFile`), the `claude` CLI (v2.1.204). No `package.json`, no new dependencies (matches repo convention).

## Global Constraints

- `evals/` is a top-level directory (sibling of `tests/`), **not** under `home/` — chezmoi must never deploy it. Unit tests live in the existing `tests/` dir.
- The agent under test is invoked as: `claude -p "<input>" --agents '<json>' --agent <name> --output-format json --tools "" --max-budget-usd <cap> --setting-sources project --strict-mcp-config`. Add `--bare` **only if** `process.env.ANTHROPIC_API_KEY` is set.
- **Model is pinned inside the `--agents` JSON entry**, never via top-level `--model` (the flag is unreliable in `-p` mode — lower tiers get upgraded).
- **Side-effect guard is `--tools ""`**, never `--permission-mode plan` (plan mode injects boilerplate that corrupts behavioral grading).
- A run is a valid sample only if `is_error === false && subtype === "success"`; otherwise it is an **infra error** (excluded from the pass^k denominator).
- Judge output shape is enforced with `--json-schema`; the judge pins opus via its own `--agents` entry.
- Threshold values: `"all"` (all healthy runs pass) or `"rate>=X/Y"` (pass rate ≥ X/Y). `k` precedence: `--smoke` > `--k` > case `k` field.
- Agent source-of-truth files: `home/private_dot_claude/agents/{implementer,planner,lucid-diagrammer,migration-reviewer}.md`.
- Node ESM tests run via `node --test tests/`. Commit after each task with a signed commit (`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`).

---

### Task 1: `load-agent` — parse agent `.md` and build the `--agents` payload

**Files:**
- Create: `evals/lib/load-agent.mjs`
- Test: `tests/evals-load-agent.test.mjs`

**Interfaces:**
- Produces:
  - `parseAgent(md: string) → { name, model|null, tools|null, description, systemPrompt }`
  - `buildAgentsFlag(parsed, {name?, model?, prompt?}) → string` (JSON for `--agents`)
  - `loadAgentFromRepo(name: string, repoRoot: string) → parsed`

- [ ] **Step 1: Write the failing test**

```js
// tests/evals-load-agent.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { parseAgent, buildAgentsFlag } from '../evals/lib/load-agent.mjs';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/evals-load-agent.test.mjs`
Expected: FAIL — `Cannot find module '../evals/lib/load-agent.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// evals/lib/load-agent.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FM = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseAgent(md) {
  const m = FM.exec(md);
  if (!m) throw new Error('agent file has no YAML frontmatter');
  const [, fmBlock, body] = m;
  const fields = {};
  for (const line of fmBlock.split('\n')) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  if (!fields.name) throw new Error('agent frontmatter missing name');
  return {
    name: fields.name,
    model: fields.model || null,
    tools: fields.tools || null,
    description: fields.description || '',
    systemPrompt: body.trim(),
  };
}

export function buildAgentsFlag(parsed, over = {}) {
  const name = over.name || parsed.name;
  const model = over.model !== undefined ? over.model : parsed.model;
  const entry = {
    description: over.description || parsed.description || name,
    prompt: over.prompt || parsed.systemPrompt,
  };
  if (model) entry.model = model;
  return JSON.stringify({ [name]: entry });
}

export function loadAgentFromRepo(name, repoRoot) {
  const p = join(repoRoot, 'home', 'private_dot_claude', 'agents', `${name}.md`);
  return parseAgent(readFileSync(p, 'utf8'));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/evals-load-agent.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add evals/lib/load-agent.mjs tests/evals-load-agent.test.mjs
git commit -m "feat(evals): agent .md parser + --agents payload builder"
```

---

### Task 2: `assertions` — deterministic must_match / must_not_match gate

**Files:**
- Create: `evals/lib/assertions.mjs`
- Test: `tests/evals-assertions.test.mjs`

**Interfaces:**
- Produces: `checkAssertions(text: string, assert?: {must_match?: string[], must_not_match?: string[]}) → { pass: boolean, failures: string[] }`
- Semantics: every `must_match` regex must match (case-insensitive); no `must_not_match` regex may match. Missing/empty arrays pass.

- [ ] **Step 1: Write the failing test**

```js
// tests/evals-assertions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { checkAssertions } from '../evals/lib/assertions.mjs';

test('passes when all must_match present and no must_not_match present', () => {
  const r = checkAssertions('Risk Level: CRITICAL\nRollback Safe: no',
    { must_match: ['Risk Level', 'Rollback Safe'], must_not_match: [':5432'] });
  assert.strictEqual(r.pass, true);
  assert.deepStrictEqual(r.failures, []);
});

test('fails and names a missing must_match', () => {
  const r = checkAssertions('some output', { must_match: ['Risk Level'] });
  assert.strictEqual(r.pass, false);
  assert.ok(r.failures.some(f => f.includes('Risk Level')));
});

test('fails when a must_not_match appears', () => {
  const r = checkAssertions('connects on :5432', { must_not_match: [':\\d{2,5}'] });
  assert.strictEqual(r.pass, false);
  assert.ok(r.failures.some(f => f.includes('must_not_match')));
});

test('match is case-insensitive', () => {
  assert.strictEqual(checkAssertions('risk level', { must_match: ['RISK LEVEL'] }).pass, true);
});

test('empty or missing assert object passes', () => {
  assert.strictEqual(checkAssertions('anything', {}).pass, true);
  assert.strictEqual(checkAssertions('anything').pass, true);
  assert.strictEqual(checkAssertions('anything', { must_match: [], must_not_match: [] }).pass, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/evals-assertions.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// evals/lib/assertions.mjs
export function checkAssertions(text, assert = {}) {
  const failures = [];
  for (const pat of assert.must_match || []) {
    if (!new RegExp(pat, 'i').test(text)) failures.push(`must_match not found: ${pat}`);
  }
  for (const pat of assert.must_not_match || []) {
    if (new RegExp(pat, 'i').test(text)) failures.push(`must_not_match matched: ${pat}`);
  }
  return { pass: failures.length === 0, failures };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/evals-assertions.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add evals/lib/assertions.mjs tests/evals-assertions.test.mjs
git commit -m "feat(evals): deterministic assertion gate"
```

---

### Task 3: `classify` — infra-health classification of a `claude` result

**Files:**
- Create: `evals/lib/classify.mjs`
- Test: `tests/evals-classify.test.mjs`

**Interfaces:**
- Produces: `classifyRun(resultJson: object) → { status: 'ok'|'infra_error', text: string|null, reason: string|null }`
- `ok` iff `is_error === false && subtype === 'success'`; then `text = resultJson.result`. Otherwise `infra_error` with a reason string.

- [ ] **Step 1: Write the failing test**

```js
// tests/evals-classify.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { classifyRun } from '../evals/lib/classify.mjs';

test('clean success is ok with text', () => {
  const r = classifyRun({ is_error: false, subtype: 'success', result: 'KIWI' });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.text, 'KIWI');
});

test('is_error true is infra_error even when subtype is success', () => {
  const r = classifyRun({ is_error: true, subtype: 'success', result: 'Not logged in · Please run /login' });
  assert.strictEqual(r.status, 'infra_error');
  assert.match(r.reason, /Not logged in/);
});

test('non-success subtype is infra_error', () => {
  const r = classifyRun({ is_error: false, subtype: 'error_max_turns', result: '' });
  assert.strictEqual(r.status, 'infra_error');
  assert.match(r.reason, /error_max_turns/);
});

test('missing/undefined result is infra_error', () => {
  const r = classifyRun({});
  assert.strictEqual(r.status, 'infra_error');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/evals-classify.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// evals/lib/classify.mjs
export function classifyRun(j) {
  if (!j || typeof j !== 'object') {
    return { status: 'infra_error', text: null, reason: 'no result JSON' };
  }
  if (j.is_error === false && j.subtype === 'success' && typeof j.result === 'string') {
    return { status: 'ok', text: j.result, reason: null };
  }
  const reason = j.is_error
    ? `is_error: ${JSON.stringify(j.result ?? j.api_error_status ?? 'unknown')}`
    : `subtype: ${j.subtype ?? 'missing'}`;
  return { status: 'infra_error', text: null, reason };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/evals-classify.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add evals/lib/classify.mjs tests/evals-classify.test.mjs
git commit -m "feat(evals): infra-health run classifier"
```

---

### Task 4: `report` — threshold parsing, per-case aggregation, exit code

**Files:**
- Create: `evals/lib/report.mjs`
- Test: `tests/evals-report.test.mjs`

**Interfaces:**
- Consumes: run objects `{ status: 'ok'|'infra_error', pass?: boolean }`.
- Produces:
  - `parseThreshold(str) → { kind: 'all' } | { kind: 'rate', num, den }`
  - `aggregateCase(caseDef, runs) → { id, k, healthy, passes, passRate, allPass, thresholdMet, status: 'PASS'|'FAIL'|'INCONCLUSIVE' }`
  - `overallExitCode(caseReports) → 0|1`
- Floor: `healthy < Math.ceil(k/2)` → `INCONCLUSIVE`.

- [ ] **Step 1: Write the failing test**

```js
// tests/evals-report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { parseThreshold, aggregateCase, overallExitCode } from '../evals/lib/report.mjs';

const ok = (pass) => ({ status: 'ok', pass });
const infra = () => ({ status: 'infra_error' });

test('parseThreshold parses all and rate', () => {
  assert.deepStrictEqual(parseThreshold('all'), { kind: 'all' });
  assert.deepStrictEqual(parseThreshold('rate>=4/5'), { kind: 'rate', num: 4, den: 5 });
});

test('all: every healthy run must pass', () => {
  const c = { id: 'x', k: 5, threshold: 'all' };
  const passAll = aggregateCase(c, [ok(true), ok(true), ok(true), ok(true), ok(true)]);
  assert.strictEqual(passAll.status, 'PASS');
  const oneFail = aggregateCase(c, [ok(true), ok(false), ok(true), ok(true), ok(true)]);
  assert.strictEqual(oneFail.status, 'FAIL');
});

test('rate: passRate over healthy runs meets bar', () => {
  const c = { id: 'x', k: 5, threshold: 'rate>=4/5' };
  assert.strictEqual(aggregateCase(c, [ok(true), ok(true), ok(true), ok(true), ok(false)]).status, 'PASS');
  assert.strictEqual(aggregateCase(c, [ok(true), ok(true), ok(true), ok(false), ok(false)]).status, 'FAIL');
});

test('infra errors are excluded from denominator', () => {
  const c = { id: 'x', k: 5, threshold: 'rate>=4/5' };
  const r = aggregateCase(c, [ok(true), ok(true), ok(true), ok(true), infra()]);
  assert.strictEqual(r.healthy, 4);
  assert.strictEqual(r.passRate, 1);
  assert.strictEqual(r.status, 'PASS');
});

test('too few healthy runs is INCONCLUSIVE', () => {
  const c = { id: 'x', k: 5, threshold: 'all' };
  const r = aggregateCase(c, [ok(true), ok(true), infra(), infra(), infra()]);
  assert.strictEqual(r.status, 'INCONCLUSIVE');
});

test('overallExitCode is 1 if any case is not PASS', () => {
  assert.strictEqual(overallExitCode([{ status: 'PASS' }, { status: 'PASS' }]), 0);
  assert.strictEqual(overallExitCode([{ status: 'PASS' }, { status: 'FAIL' }]), 1);
  assert.strictEqual(overallExitCode([{ status: 'INCONCLUSIVE' }]), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/evals-report.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// evals/lib/report.mjs
export function parseThreshold(str) {
  if (str === 'all') return { kind: 'all' };
  const m = /^rate>=(\d+)\/(\d+)$/.exec(str || '');
  if (!m) throw new Error(`bad threshold: ${str}`);
  return { kind: 'rate', num: Number(m[1]), den: Number(m[2]) };
}

export function aggregateCase(caseDef, runs) {
  const k = caseDef.k ?? runs.length;
  const healthyRuns = runs.filter(r => r.status === 'ok');
  const healthy = healthyRuns.length;
  const passes = healthyRuns.filter(r => r.pass === true).length;
  const passRate = healthy ? passes / healthy : 0;
  const allPass = healthy > 0 && passes === healthy;
  const th = parseThreshold(caseDef.threshold);
  const thresholdMet = th.kind === 'all' ? allPass : passRate >= th.num / th.den;

  let status;
  if (healthy < Math.ceil(k / 2)) status = 'INCONCLUSIVE';
  else status = thresholdMet ? 'PASS' : 'FAIL';

  return { id: caseDef.id, k, healthy, passes, passRate, allPass, thresholdMet, status };
}

export function overallExitCode(caseReports) {
  return caseReports.every(r => r.status === 'PASS') ? 0 : 1;
}

export function formatReport(caseReports) {
  const line = r =>
    `${r.status.padEnd(12)} ${r.id}  (${r.passes}/${r.healthy} healthy pass, rate ${(r.passRate * 100).toFixed(0)}%)`;
  return caseReports.map(line).join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/evals-report.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add evals/lib/report.mjs tests/evals-report.test.mjs
git commit -m "feat(evals): pass^k/pass-rate aggregation and reporting"
```

---

### Task 5: `invoke-agent` — build command + shell out to `claude` with timeout/retry

**Files:**
- Create: `evals/lib/invoke-agent.mjs`
- Test: `tests/evals-invoke-agent.test.mjs` (tests the pure `buildAgentArgs` only — no API call)

**Interfaces:**
- Consumes: `buildAgentsFlag` (Task 1), `classifyRun` (Task 3).
- Produces:
  - `buildAgentArgs({ agentsFlag, name, input, maxBudgetUsd }) → string[]`
  - `async invokeAgent({ agentsFlag, name, input, maxBudgetUsd?, timeoutMs?, retries? }) → { status, text|null, reason|null, raw }`

- [ ] **Step 1: Write the failing test**

```js
// tests/evals-invoke-agent.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { buildAgentArgs } from '../evals/lib/invoke-agent.mjs';

test('buildAgentArgs uses -p, --agents/--agent, --tools "" and no --model/--permission-mode', () => {
  const args = buildAgentArgs({ agentsFlag: '{"x":{}}', name: 'x', input: 'go', maxBudgetUsd: 0.5 });
  assert.ok(args.includes('-p'));
  assert.strictEqual(args[args.indexOf('-p') + 1], 'go');
  assert.strictEqual(args[args.indexOf('--agent') + 1], 'x');
  assert.strictEqual(args[args.indexOf('--agents') + 1], '{"x":{}}');
  assert.strictEqual(args[args.indexOf('--output-format') + 1], 'json');
  // side-effect guard is empty --tools, not plan mode:
  assert.strictEqual(args[args.indexOf('--tools') + 1], '');
  assert.ok(!args.includes('--model'));
  assert.ok(!args.includes('--permission-mode'));
  assert.strictEqual(args[args.indexOf('--max-budget-usd') + 1], '0.5');
});

test('buildAgentArgs adds --bare only when ANTHROPIC_API_KEY is set', () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.ok(!buildAgentArgs({ agentsFlag: '{}', name: 'x', input: 'g', maxBudgetUsd: 1 }).includes('--bare'));
  process.env.ANTHROPIC_API_KEY = 'test-key';
  assert.ok(buildAgentArgs({ agentsFlag: '{}', name: 'x', input: 'g', maxBudgetUsd: 1 }).includes('--bare'));
  if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/evals-invoke-agent.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// evals/lib/invoke-agent.mjs
import { execFile } from 'node:child_process';
import { classifyRun } from './classify.mjs';

export function buildAgentArgs({ agentsFlag, name, input, maxBudgetUsd }) {
  const args = [
    '-p', input,
    '--agents', agentsFlag,
    '--agent', name,
    '--output-format', 'json',
    '--tools', '',
    '--max-budget-usd', String(maxBudgetUsd),
    '--setting-sources', 'project',
    '--strict-mcp-config',
  ];
  if (process.env.ANTHROPIC_API_KEY) args.push('--bare');
  return args;
}

function runClaude(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('claude', args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err && !stdout) { resolve({ __timeout: true, reason: String(err.message || err) }); return; }
        try { resolve(JSON.parse(stdout)); }
        catch { resolve({ is_error: true, subtype: 'parse_error', result: (stdout || '').slice(0, 500) }); }
      });
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function invokeAgent({ agentsFlag, name, input, maxBudgetUsd = 0.75, timeoutMs = 180000, retries = 2 }) {
  const args = buildAgentArgs({ agentsFlag, name, input, maxBudgetUsd });
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await runClaude(args, timeoutMs);
    if (raw.__timeout) { last = { status: 'infra_error', text: null, reason: `timeout: ${raw.reason}`, raw }; }
    else {
      const c = classifyRun(raw);
      last = { ...c, raw };
      if (c.status === 'ok') return last;
    }
    if (attempt < retries) await sleep(1000 * (attempt + 1));
  }
  return last;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/evals-invoke-agent.test.mjs`
Expected: PASS (2 tests). (End-to-end behavior is verified in Task 11's smoke run.)

- [ ] **Step 5: Commit**

```bash
git add evals/lib/invoke-agent.mjs tests/evals-invoke-agent.test.mjs
git commit -m "feat(evals): claude -p agent invocation with timeout/retry"
```

---

### Task 6: `judge` — LLM judge via `--json-schema`, opus pinned in `--agents`

**Files:**
- Create: `evals/lib/judge.mjs`
- Test: `tests/evals-judge.test.mjs` (pure `buildJudgeArgs` + `parseVerdict` only)

**Interfaces:**
- Consumes: `buildAgentsFlag` (Task 1), `classifyRun` (Task 3).
- Produces:
  - `buildJudgeArgs({ rubric, output, maxBudgetUsd }) → string[]`
  - `parseVerdict(text) → { pass: boolean, reason: string }` (throws on unparseable)
  - `async judge({ rubric, output, maxBudgetUsd?, timeoutMs?, retries? }) → { status, verdict|null, reason|null }`

- [ ] **Step 1: Write the failing test**

```js
// tests/evals-judge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { buildJudgeArgs, parseVerdict } from '../evals/lib/judge.mjs';

test('buildJudgeArgs pins opus inside --agents and sets --json-schema', () => {
  const args = buildJudgeArgs({ rubric: 'R', output: 'O', maxBudgetUsd: 0.5 });
  const agents = JSON.parse(args[args.indexOf('--agents') + 1]);
  assert.strictEqual(agents.judge.model, 'opus');
  assert.ok(!args.includes('--model'));
  const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  assert.deepStrictEqual(schema.required.sort(), ['pass', 'reason']);
  assert.strictEqual(args[args.indexOf('--tools') + 1], '');
});

test('parseVerdict reads strict JSON', () => {
  const v = parseVerdict('{"pass": true, "reason": "meets all conditions"}');
  assert.strictEqual(v.pass, true);
  assert.match(v.reason, /meets all/);
});

test('parseVerdict throws on garbage', () => {
  assert.throws(() => parseVerdict('not json'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/evals-judge.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// evals/lib/judge.mjs
import { execFile } from 'node:child_process';
import { buildAgentsFlag } from './load-agent.mjs';
import { classifyRun } from './classify.mjs';

const JUDGE_PROMPT =
  'You are a strict evaluation judge. You are given a RUBRIC and an agent OUTPUT. ' +
  'Decide whether the OUTPUT satisfies EVERY condition in the RUBRIC. ' +
  'Pass only if all conditions hold. Respond ONLY via the structured output schema.';

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: { pass: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['pass', 'reason'],
  additionalProperties: false,
});

export function buildJudgeArgs({ rubric, output, maxBudgetUsd }) {
  const agentsFlag = buildAgentsFlag({ name: 'judge', description: 'eval judge', systemPrompt: JUDGE_PROMPT, model: 'opus' });
  const input = `RUBRIC:\n${rubric}\n\n---\nAGENT OUTPUT:\n${output}`;
  const args = [
    '-p', input,
    '--agents', agentsFlag,
    '--agent', 'judge',
    '--output-format', 'json',
    '--json-schema', SCHEMA,
    '--tools', '',
    '--max-budget-usd', String(maxBudgetUsd),
    '--setting-sources', 'project',
    '--strict-mcp-config',
  ];
  if (process.env.ANTHROPIC_API_KEY) args.push('--bare');
  return args;
}

export function parseVerdict(text) {
  const v = JSON.parse(text);
  if (typeof v.pass !== 'boolean') throw new Error('verdict missing boolean pass');
  return { pass: v.pass, reason: String(v.reason ?? '') };
}

function runClaude(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('claude', args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err && !stdout) { resolve({ is_error: true, subtype: 'timeout', result: String(err.message || err) }); return; }
        try { resolve(JSON.parse(stdout)); }
        catch { resolve({ is_error: true, subtype: 'parse_error', result: (stdout || '').slice(0, 500) }); }
      });
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function judge({ rubric, output, maxBudgetUsd = 0.5, timeoutMs = 120000, retries = 2 }) {
  const args = buildJudgeArgs({ rubric, output, maxBudgetUsd });
  let last = { status: 'infra_error', verdict: null, reason: 'not run' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await runClaude(args, timeoutMs);
    const c = classifyRun(raw);
    if (c.status === 'ok') {
      try { return { status: 'ok', verdict: parseVerdict(c.text), reason: null }; }
      catch (e) { last = { status: 'infra_error', verdict: null, reason: `verdict parse failed: ${e.message}` }; }
    } else {
      last = { status: 'infra_error', verdict: null, reason: c.reason };
    }
    if (attempt < retries) await sleep(1000 * (attempt + 1));
  }
  return last;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/evals-judge.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add evals/lib/judge.mjs tests/evals-judge.test.mjs
git commit -m "feat(evals): json-schema LLM judge (opus via --agents)"
```

---

### Task 7: `run-evals.mjs` — CLI: load cases, orchestrate runs, grade, report

**Files:**
- Create: `evals/lib/args.mjs`
- Create: `evals/lib/grade.mjs`
- Create: `evals/run-evals.mjs`
- Test: `tests/evals-args.test.mjs`, `tests/evals-grade.test.mjs`

**Interfaces:**
- Consumes: all Task 1–6 exports.
- Produces:
  - `parseArgs(argv: string[]) → { agent?, case?, k?, smoke: boolean, json? }`
  - `async gradeRun({ caseDef }) → { status: 'ok'|'infra_error', pass?: boolean, text?, judgeReason? }` (assertion gate → judge)
  - `effectiveK(caseDef, opts) → number` (precedence: smoke=1 > opts.k > caseDef.k)
  - `run-evals.mjs` as executable entry.

- [ ] **Step 1: Write the failing tests**

```js
// tests/evals-args.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { parseArgs, effectiveK } from '../evals/lib/args.mjs';

test('parseArgs reads flags', () => {
  const o = parseArgs(['--agent', 'planner', '--k', '5', '--case', 'planner/001', '--json', 'out.json']);
  assert.strictEqual(o.agent, 'planner');
  assert.strictEqual(o.k, 5);
  assert.strictEqual(o.case, 'planner/001');
  assert.strictEqual(o.json, 'out.json');
  assert.strictEqual(o.smoke, false);
});

test('effectiveK precedence: smoke > --k > case k', () => {
  assert.strictEqual(effectiveK({ k: 5 }, { smoke: true, k: 3 }), 1);
  assert.strictEqual(effectiveK({ k: 5 }, { smoke: false, k: 3 }), 3);
  assert.strictEqual(effectiveK({ k: 5 }, { smoke: false }), 5);
  assert.strictEqual(effectiveK({}, { smoke: false }), 1);
});
```

```js
// tests/evals-grade.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { gradeFromParts } from '../evals/lib/grade.mjs';

// gradeFromParts is the pure decision function given already-fetched pieces.
test('assertion failure short-circuits to failed run, no judge', () => {
  const r = gradeFromParts({
    invocation: { status: 'ok', text: 'no headers here' },
    assertion: { pass: false, failures: ['must_match not found: Risk Level'] },
    judgeResult: null,
  });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.pass, false);
});

test('infra error invocation yields infra_error run', () => {
  const r = gradeFromParts({ invocation: { status: 'infra_error', reason: 'timeout' } });
  assert.strictEqual(r.status, 'infra_error');
});

test('judge infra error yields infra_error run (not silent pass)', () => {
  const r = gradeFromParts({
    invocation: { status: 'ok', text: 'Risk Level: LOW' },
    assertion: { pass: true, failures: [] },
    judgeResult: { status: 'infra_error', reason: 'verdict parse failed' },
  });
  assert.strictEqual(r.status, 'infra_error');
});

test('assertion pass + judge pass = passing run', () => {
  const r = gradeFromParts({
    invocation: { status: 'ok', text: 'Risk Level: CRITICAL' },
    assertion: { pass: true, failures: [] },
    judgeResult: { status: 'ok', verdict: { pass: true, reason: 'good' } },
  });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.pass, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/evals-args.test.mjs tests/evals-grade.test.mjs`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementations**

```js
// evals/lib/args.mjs
export function parseArgs(argv) {
  const o = { smoke: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--smoke') o.smoke = true;
    else if (a === '--agent') o.agent = argv[++i];
    else if (a === '--case') o.case = argv[++i];
    else if (a === '--k') o.k = Number(argv[++i]);
    else if (a === '--json') o.json = argv[++i];
  }
  return o;
}

export function effectiveK(caseDef, opts) {
  if (opts.smoke) return 1;
  if (opts.k) return opts.k;
  return caseDef.k ?? 1;
}
```

```js
// evals/lib/grade.mjs
// Pure decision function: combine an invocation result, an assertion result,
// and (optionally) a judge result into a single run outcome.
export function gradeFromParts({ invocation, assertion, judgeResult }) {
  if (!invocation || invocation.status !== 'ok') {
    return { status: 'infra_error', reason: invocation?.reason ?? 'no invocation' };
  }
  if (!assertion.pass) {
    return { status: 'ok', pass: false, text: invocation.text, failures: assertion.failures };
  }
  if (!judgeResult || judgeResult.status !== 'ok') {
    return { status: 'infra_error', reason: judgeResult?.reason ?? 'no judge result', text: invocation.text };
  }
  return { status: 'ok', pass: judgeResult.verdict.pass, text: invocation.text, judgeReason: judgeResult.verdict.reason };
}
```

```js
// evals/run-evals.mjs
#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs, effectiveK } from './lib/args.mjs';
import { loadAgentFromRepo, buildAgentsFlag } from './lib/load-agent.mjs';
import { invokeAgent } from './lib/invoke-agent.mjs';
import { checkAssertions } from './lib/assertions.mjs';
import { judge } from './lib/judge.mjs';
import { gradeFromParts } from './lib/grade.mjs';
import { aggregateCase, overallExitCode, formatReport } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CASES_DIR = join(HERE, 'cases');
const CONCURRENCY = 3;

function loadCases(opts) {
  const cases = [];
  for (const agent of readdirSync(CASES_DIR, { withFileTypes: true }).filter(d => d.isDirectory())) {
    if (opts.agent && agent.name !== opts.agent) continue;
    const dir = join(CASES_DIR, agent.name);
    for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (opts.case && c.id !== opts.case) continue;
      cases.push(c);
    }
  }
  return cases;
}

async function gradeRun(caseDef, agentsFlagCache) {
  if (!agentsFlagCache[caseDef.agent]) {
    const parsed = loadAgentFromRepo(caseDef.agent, REPO_ROOT);
    agentsFlagCache[caseDef.agent] = buildAgentsFlag(parsed);
  }
  const invocation = await invokeAgent({ agentsFlag: agentsFlagCache[caseDef.agent], name: caseDef.agent, input: caseDef.input });
  if (invocation.status !== 'ok') return gradeFromParts({ invocation });
  const assertion = checkAssertions(invocation.text, caseDef.assert);
  if (!assertion.pass) return gradeFromParts({ invocation, assertion });
  const judgeResult = await judge({ rubric: caseDef.rubric, output: invocation.text });
  return gradeFromParts({ invocation, assertion, judgeResult });
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cases = loadCases(opts);
  if (!cases.length) { console.error('no cases matched'); process.exit(2); }
  const agentsFlagCache = {};
  const reports = [];
  for (const c of cases) {
    const k = effectiveK(c, opts);
    const runs = await pool(Array.from({ length: k }), CONCURRENCY, () => gradeRun(c, agentsFlagCache));
    const report = aggregateCase({ ...c, k }, runs);
    report._runs = runs;
    reports.push(report);
    console.log(`${report.status.padEnd(12)} ${c.id}  (${report.passes}/${report.healthy} pass)`);
    for (const r of runs) {
      if (r.status === 'infra_error') console.log(`    infra: ${r.reason}`);
      else if (r.pass === false) console.log(`    fail:  ${r.failures ? r.failures.join('; ') : r.judgeReason}`);
    }
  }
  console.log('\n' + formatReport(reports));
  if (opts.json) writeFileSync(opts.json, JSON.stringify(reports, null, 2));
  process.exit(overallExitCode(reports));
}

main();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/evals-args.test.mjs tests/evals-grade.test.mjs`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add evals/lib/args.mjs evals/lib/grade.mjs evals/run-evals.mjs tests/evals-args.test.mjs tests/evals-grade.test.mjs
git commit -m "feat(evals): CLI orchestration + grading pipeline"
```

---

### Task 8: Author migration-reviewer cases (8)

**Files:**
- Create: `evals/cases/migration-reviewer/00{1..8}-*.json`

**Interfaces:**
- Consumes: case schema from Task 7 loader. Each file matches: `{ id, agent, description, input, assert, rubric, k, threshold }`.

- [ ] **Step 1: Write the 8 case files.** Each `agent` is `"migration-reviewer"`. Use `assert.must_match: ["Risk Level", "Rollback Safe"]` on all (the required output headers), plus case-specific `must_match`/`must_not_match`. Cases (see spec §"The cases"):
  1. `001-drop-column-still-read` — input: drop `legacy_token` still read by fraud-service. rubric: flags cross-service read + rates CRITICAL/HIGH + recommends expand/contract. `threshold:"all"`.
  2. `002-not-null-no-default` — add `NOT NULL` column without default. rubric: flags existing rows fail. `threshold:"all"`.
  3. `003-index-without-concurrently` — `CREATE INDEX` on hot table, no `CONCURRENTLY`. rubric: flags lock risk + recommends CONCURRENTLY. `threshold:"all"`.
  4. `004-unbatched-backfill` — single-txn UPDATE across all rows. rubric: flags long transaction + recommends batching. `threshold:"rate>=4/5"`.
  5. `005-pci-table` — migration altering a table with `pan`/`card_number`. rubric: raises PCI/compliance flag. `threshold:"all"`.
  6. `006-no-down-migration` — reversible change, no down migration. rubric: flags missing rollback. `threshold:"rate>=4/5"`.
  7. `007-safe-additive` — add nullable column + `CREATE INDEX CONCURRENTLY`. rubric: risk LOW; must **not** label CRITICAL/HIGH. `assert.must_not_match: ["CRITICAL"]`. `threshold:"rate>=4/5"`.
  8. `008-output-format` — any simple migration. rubric: emits all required headers. Relies mostly on `assert`. `threshold:"all"`.

Example file:

```json
{
  "id": "migration-reviewer/001-drop-column-still-read",
  "agent": "migration-reviewer",
  "description": "Dropping a column another service still reads must be flagged CRITICAL/HIGH",
  "input": "Review this migration:\n```sql\nALTER TABLE cards DROP COLUMN legacy_token;\n```\nContext: the fraud-service still runs SELECT legacy_token FROM cards.",
  "assert": { "must_match": ["Risk Level", "Rollback Safe"], "must_not_match": [] },
  "rubric": "PASS only if the review (1) flags that legacy_token is still read by fraud-service, (2) rates risk CRITICAL or HIGH, and (3) recommends an expand/contract or deploy-then-migrate split.",
  "k": 5,
  "threshold": "all"
}
```

- [ ] **Step 2: Validate the files load and match schema.**

Run: `node -e "const {readdirSync,readFileSync}=require('fs');for(const f of readdirSync('evals/cases/migration-reviewer')){const c=JSON.parse(readFileSync('evals/cases/migration-reviewer/'+f));if(!c.id||!c.input||!c.rubric||!c.threshold)throw new Error('bad '+f);console.log('ok',c.id)}"`
Expected: `ok migration-reviewer/001…` … through 008, no throw.

- [ ] **Step 3: Commit**

```bash
git add evals/cases/migration-reviewer/
git commit -m "test(evals): migration-reviewer eval cases"
```

---

### Task 9: Author lucid-diagrammer cases (7)

**Files:**
- Create: `evals/cases/lucid-diagrammer/00{1..7}-*.json`

**Interfaces:**
- Consumes: case schema. **Every `input` ends with:** `"\n\nProduce the full diagram specification as structured text — shapes, fill colors, connection labels, and legend. Do not attempt to call any tool."` (see spec — MCP tools are removed by `--tools ""`).

- [ ] **Step 1: Write the 7 case files.** `agent: "lucid-diagrammer"`. Cases:
  1. `001-no-ports` — input names `:5432`/`:443`. `assert.must_not_match: [":\\d{2,5}\\b"]`. rubric: omits all port numbers. `threshold:"all"`.
  2. `002-scope-colors` — CDE/shared/segmented system. rubric: uses red/yellow/green scope fill + a legend. `threshold:"rate>=4/5"`.
  3. `003-semantic-labels` — rubric: connection labels describe what flows, not protocols/ports. `threshold:"rate>=4/5"`.
  4. `004-asks-when-ambiguous` — deliberately vague ("diagram our system"). rubric: asks exactly one focused clarifying question. `threshold:"rate>=4/5"`.
  5. `005-no-scope-text-in-shapes` — rubric: does not put "CDE"/"Shared"/"Segmented" text inside/under shapes (uses color instead). `threshold:"rate>=4/5"`.
  6. `006-sequence-diagram` — asks for a sequence diagram. rubric: chooses a sequence-diagram structure (actors + ordered messages). `threshold:"rate>=4/5"`.
  7. `007-no-needless-question` — fully specified request. rubric: proceeds to a spec without asking a clarifying question. `assert.must_not_match` may include a `"\\?\\s*$"`-style guard only if reliable; primarily judged. `threshold:"rate>=4/5"`.

Example file:

```json
{
  "id": "lucid-diagrammer/001-no-ports",
  "agent": "lucid-diagrammer",
  "description": "Ports named in the request must not appear in the diagram spec",
  "input": "Diagram this flow: api-gateway talks to auth-service on :443, auth-service reads postgres on :5432.\n\nProduce the full diagram specification as structured text — shapes, fill colors, connection labels, and legend. Do not attempt to call any tool.",
  "assert": { "must_match": [], "must_not_match": [":\\d{2,5}\\b"] },
  "rubric": "PASS only if the specification contains no port numbers anywhere and uses semantic connection labels (e.g. 'authorization request') rather than protocols or ports.",
  "k": 5,
  "threshold": "all"
}
```

- [ ] **Step 2: Validate** (same loader check as Task 8, path `evals/cases/lucid-diagrammer`). Expected: `ok` for 001–007.

- [ ] **Step 3: Commit**

```bash
git add evals/cases/lucid-diagrammer/
git commit -m "test(evals): lucid-diagrammer eval cases"
```

---

### Task 10: Author planner (5) + implementer (4) cases

**Files:**
- Create: `evals/cases/planner/00{1..5}-*.json`
- Create: `evals/cases/implementer/00{1..4}-*.json`

**Interfaces:**
- Consumes: case schema. These agents are open-ended → mostly `rubric`-judged, `assert` usually empty. Use `threshold:"rate>=4/5"` (open-ended variation) except where noted.

- [ ] **Step 1: Write the planner cases (5).** `agent: "planner"`:
  1. `001-multiple-options` — a design task. rubric: presents ≥2 distinct options **with explicit trade-offs**. `threshold:"all"`.
  2. `002-concrete-plan` — rubric: ends with a concrete, ordered plan an implementer could execute. `threshold:"rate>=4/5"`.
  3. `003-surfaces-assumptions` — under-specified request. rubric: states assumptions / asks rather than inventing scope. `threshold:"rate>=4/5"`.
  4. `004-stays-at-planning-altitude` — rubric: does not dive into full implementation code; stays at design/plan level. `threshold:"rate>=4/5"`.
  5. `005-proportionate` — a trivially simple task. rubric: plan is proportionate, not over-engineered. `threshold:"rate>=4/5"`.

- [ ] **Step 2: Write the implementer cases (4).** `agent: "implementer"`:
  1. `001-follows-plan` — a given plan. rubric: follows the plan without adding unrequested features. `threshold:"rate>=4/5"`.
  2. `002-matches-style` — includes a snippet with a clear style. rubric: output matches the described conventions. `threshold:"rate>=4/5"`.
  3. `003-no-scope-creep` — rubric: does not invent scope beyond the plan. `threshold:"rate>=4/5"`.
  4. `004-flags-ambiguity` — genuinely ambiguous instruction. rubric: flags the ambiguity rather than silently guessing. `threshold:"rate>=4/5"`.

Example (planner/001):

```json
{
  "id": "planner/001-multiple-options",
  "agent": "planner",
  "description": "A planning request must yield multiple options with trade-offs",
  "input": "We need to add rate limiting to our public API. Plan the approach.",
  "assert": { "must_match": [], "must_not_match": [] },
  "rubric": "PASS only if the response presents at least two distinct approaches AND states explicit trade-offs for each (not just a single recommendation).",
  "k": 5,
  "threshold": "all"
}
```

- [ ] **Step 3: Validate** both dirs with the loader check. Expected: `ok` for planner 001–005 and implementer 001–004.

- [ ] **Step 4: Commit**

```bash
git add evals/cases/planner/ evals/cases/implementer/
git commit -m "test(evals): planner and implementer eval cases"
```

---

### Task 11: Stubs, template, README, and live smoke run

**Files:**
- Create: `evals/cases/{security-reviewer,ops-investigator,processing-engineer,network-navigator}/.gitkeep`
- Create: `evals/_case.template.json`
- Create: `evals/README.md`

**Interfaces:** none (docs + validation).

- [ ] **Step 1: Create the four stub dirs with `.gitkeep`** (cases authored on the host where those agent defs live).

- [ ] **Step 2: Create `evals/_case.template.json`:**

```json
{
  "id": "<agent>/<nnn-slug>",
  "agent": "<agent>",
  "description": "<one line: the behavior this case checks>",
  "input": "<the exact prompt handed to the agent>",
  "assert": { "must_match": [], "must_not_match": [] },
  "rubric": "PASS only if <all conditions, written so an honest run passes every time>.",
  "k": 5,
  "threshold": "all | rate>=X/Y"
}
```

- [ ] **Step 3: Write `evals/README.md`** covering: purpose; how to run (`node evals/run-evals.mjs`, `--smoke`, `--agent`, `--case`, `--k`, `--json`); the invocation contract (model-in-`--agents`, `--tools ""`, no `--model`/plan mode); isolation & auth (`--bare` only with `ANTHROPIC_API_KEY`); the fidelity boundary (`--agent` in `-p` runs the main loop as that agent, not nested Task dispatch; tool-scoping out of scope); `pass^k` vs pass-rate semantics; measured cost + `--max-budget-usd`; the lucid "produce text" caveat; and how the 4 work-agents are stubbed. Source content from the spec.

- [ ] **Step 4: Run the full unit-test suite** (no API):

Run: `node --test tests/`
Expected: PASS — all existing tests plus the new `evals-*` tests.

- [ ] **Step 5: Live smoke run — one case per readable agent, k=1.** This is the end-to-end proof (Tasks 5 & 6 have no live unit test).

Run: `node evals/run-evals.mjs --smoke --case migration-reviewer/001-drop-column-still-read`
Then repeat `--smoke --case` for `lucid-diagrammer/001-no-ports`, `planner/001-multiple-options`, `implementer/004-flags-ambiguity`.
Expected: each prints a `PASS`/`FAIL` line with `1/1` or `0/1` healthy — **crucially, not `infra_error`** (that would mean auth/flags are wrong). Confirm lucid emits gradeable text (not a bare "I'll create the diagram"). Record observed per-run cost in the README cost note.

- [ ] **Step 6: Commit**

```bash
git add evals/cases/*/.gitkeep evals/_case.template.json evals/README.md
git commit -m "docs(evals): template, README, work-agent stubs"
```

---

## Notes for the executor
- If the live smoke (Task 11 Step 5) returns `infra_error` with "Not logged in", the environment uses keychain OAuth — ensure `--bare` is NOT being added (it should only appear when `ANTHROPIC_API_KEY` is set). If it returns a budget error, raise `--max-budget-usd`.
- If lucid produces no gradeable text, confirm the case `input` ends with the explicit "produce spec as text, do not call tools" instruction (Task 9).
- Full `k=5` runs are intentionally NOT part of this plan (cost). The user triggers them after the smoke passes.
