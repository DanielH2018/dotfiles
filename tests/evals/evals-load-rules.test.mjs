import { test } from 'node:test';
import assert from 'node:assert';
import { extractSection, buildRulesPrompt, loadRulesFlagOrError, RULES_SECTIONS } from '../../evals/lib/load-rules.mjs';
import { loadCases } from '../../evals/lib/load-cases.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';

const DOC = `# Top

## Communication style

- No emojis unless I ask.

### Sentence-level clarity

- **One idea per sentence.** Two independent claims means two sentences.
- **Name the actor.** Passive voice hides who does the thing.

**Compression is not clarity.** Terse means no padding, not telegraphic.

## Config & dotfiles management

Edit the source, never the deployed copy.
`;

const render = () => DOC;

test('extractSection slices a heading through the next same-or-shallower heading', () => {
  const body = extractSection(DOC, '### Sentence-level clarity');
  assert.match(body, /One idea per sentence/);
  assert.match(body, /Compression is not clarity/);
  // stops at the following `##`, so the next section must not bleed in
  assert.ok(!body.includes('Edit the source'));
  assert.ok(!body.includes('### Sentence-level clarity'));
});

test('extractSection throws on a missing section rather than returning empty', () => {
  assert.throws(() => extractSection(DOC, '### No Such Section'), /not found/);
});

test('extractSection throws on a section with no body', () => {
  assert.throws(() => extractSection('## A\n\n## B\n\nbody\n', '## A'), /is empty/);
});

test('treatment prompt carries the real rules text', () => {
  const p = buildRulesPrompt('sentence-clarity', '/repo', render);
  assert.match(p, /One idea per sentence/);
  assert.match(p, /govern your reply/);
});

test('control prompt carries the task framing and none of the rules', () => {
  const p = buildRulesPrompt('control', '/repo', render);
  assert.ok(!p.includes('One idea per sentence'));
  assert.ok(!p.includes('govern your reply'));
  // both arms must share the framing, or a treatment win is not attributable to the rules
  assert.match(p, /technical operator will read/);
  assert.match(buildRulesPrompt('sentence-clarity', '/repo', render), /technical operator will read/);
});

test('unknown slug becomes an infra error, not a throw', () => {
  const r = loadRulesFlagOrError('nope', '/repo', render);
  assert.match(r.error, /unknown rules section "nope"/);
  assert.strictEqual(r.flag, undefined);
});

test('loadRulesFlagOrError emits an --agents flag keyed by the arm name', () => {
  const r = loadRulesFlagOrError('sentence-clarity', '/repo', render);
  const parsed = JSON.parse(r.flag);
  assert.deepStrictEqual(Object.keys(parsed), ['rules-sentence-clarity']);
  assert.strictEqual(parsed['rules-sentence-clarity'].model, 'opus');
  assert.match(parsed['rules-sentence-clarity'].prompt, /One idea per sentence/);
});

test('every slug in RULES_SECTIONS names a heading that exists in the real CLAUDE.md', async () => {
  const { renderChezmoiTemplate } = await import('../../evals/lib/load-agent.mjs');
  const repoRoot = pjoin(import.meta.dirname, '..', '..');
  for (const slug of Object.keys(RULES_SECTIONS)) {
    const p = buildRulesPrompt(slug, repoRoot, renderChezmoiTemplate);
    assert.ok(p.length > 200, `${slug} extracted a suspiciously short block`);
  }
});

// --- case wiring -----------------------------------------------------------

function withCase(body, fn) {
  const root = mkdtempSync(pjoin(tmpdir(), 'rules-cases-'));
  mkdirSync(pjoin(root, 'rules-sentence-clarity'));
  writeFileSync(pjoin(root, 'rules-sentence-clarity', '001-x.json'), JSON.stringify(body));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

const CASE = { id: 'rules-sentence-clarity/001-x', rules: 'sentence-clarity', input: 'x', rubric: 'y' };

test('a rules case gets the synthetic agent name', () => {
  withCase(CASE, (root) => {
    const [c] = loadCases({}, [root]);
    assert.strictEqual(c.agent, 'rules-sentence-clarity');
  });
});

test('--control swaps the arm after filtering, so --agent still names the treatment', () => {
  withCase(CASE, (root) => {
    const [c] = loadCases({ control: true, agent: 'rules-sentence-clarity' }, [root]);
    assert.strictEqual(c.rules, 'control');
    assert.strictEqual(c.agent, 'rules-control');
  });
});

// --- gate falsifiability ---------------------------------------------------
// A case that cannot fail measures nothing. The regex half of each gate is
// deterministic, so prove here — free, no API calls — that it still rejects the
// failure it exists to catch, and still admits the honest form. Reads the real
// case files, so gutting a gate breaks this test.

import { checkAssertions } from '../../evals/lib/assertions.mjs';
import { readFileSync as rf } from 'node:fs';

const caseFile = (slug) => JSON.parse(rf(
  pjoin(import.meta.dirname, '..', '..', 'evals', 'cases', 'rules-sentence-clarity', `${slug}.json`), 'utf8'));

const GATES = [
  ['003-name-the-actor',
    'On this cluster ingress policies are enforced by kube-router.',
    'On this cluster kube-router enforces ingress policies.'],
  ['004-consistent-terminology',
    'The rollout takes about four minutes to finish.',
    'The deploy takes about four minutes to finish.'],
  ['006-one-em-dash-aside',
    'Egress is unenforced — nothing blocks it — so treat it as absent.',
    'Egress is unenforced — nothing blocks it.'],
  ['007-terse-not-telegraphic',
    'B2 disarmed pending cap-raise/spend-reduction decision',
    'We disarmed the B2 backup target until the cap is raised.'],
];

for (const [slug, bad, good] of GATES) {
  test(`gate for ${slug} rejects the failure it targets`, () => {
    const r = checkAssertions(bad, caseFile(slug).assert);
    assert.strictEqual(r.pass, false, `gate did not fire on: ${bad}`);
  });
  test(`gate for ${slug} admits the honest form`, () => {
    const r = checkAssertions(good, caseFile(slug).assert);
    assert.strictEqual(r.pass, true, `gate false-failed: ${r.failures.join('; ')}`);
  });
}
