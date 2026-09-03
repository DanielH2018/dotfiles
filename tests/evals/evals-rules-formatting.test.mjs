// Red-proof pairs for the rules-formatting cases (evals/cases/rules-formatting/*.json),
// the prose-rule cases added alongside rules-sentence-clarity. Same shape as that suite's
// GATES table in evals-load-rules.test.mjs: each pattern must both reject the failure it
// targets and admit the honest form, checked with zero API calls via checkAssertions —
// these three cases carry no `rubric` and are graded on the assertion alone (see
// grade.mjs's needsJudge), so this test is the whole grading contract, not a sample of it.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join as pjoin } from 'node:path';
import { checkAssertions } from '../../evals/lib/assertions.mjs';

const CASES_DIR = pjoin(import.meta.dirname, '..', '..', 'evals', 'cases', 'rules-formatting');
const caseFile = (slug) => JSON.parse(readFileSync(pjoin(CASES_DIR, `${slug}.json`), 'utf8'));

const GATES = [
  ['001-no-emoji-unless-asked',
    'Deploy finished with zero errors, first time in a week! \u{1F389}',
    'Deploy finished with zero errors, first time in a week.'],
  ['001-no-emoji-unless-asked',
    'All green ✅ nothing left to fix.',
    'All checks pass, nothing left to fix.'],
  ['002-reference-code-as-file-line',
    'The bug is defined in scripts/probe.py, around line 42.',
    'The bug is defined at scripts/probe.py:42.'],
  ['003-clickable-link-not-raw-path',
    'You can find it at /home/ubuntu/reports/design.html',
    'Here it is: [design.html](file:///home/ubuntu/reports/design.html)'],
];

for (const [slug, bad, good] of GATES) {
  test(`gate for ${slug} rejects: ${JSON.stringify(bad).slice(0, 60)}`, () => {
    const r = checkAssertions(bad, caseFile(slug).assert);
    assert.strictEqual(r.pass, false, `gate did not fire on: ${bad}`);
  });
  test(`gate for ${slug} admits: ${JSON.stringify(good).slice(0, 60)}`, () => {
    const r = checkAssertions(good, caseFile(slug).assert);
    assert.strictEqual(r.pass, true, `gate false-failed: ${r.failures.join('; ')}`);
  });
}

// None of the three carry a `rubric` — that's the point (needsJudge: false in grade.mjs,
// so run-evals.mjs never places a live judge call for them). A rubric reappearing here
// would silently re-enable a model call this case set was written specifically to avoid.
test('rules-formatting cases carry no rubric (fully regex-graded, no live judge call)', () => {
  for (const slug of ['001-no-emoji-unless-asked', '002-reference-code-as-file-line', '003-clickable-link-not-raw-path']) {
    assert.strictEqual(caseFile(slug).rubric, undefined, `${slug} should not carry a rubric`);
  }
});

// Every case names the "formatting" rules slug this suite added to RULES_SECTIONS
// (evals/lib/load-rules.mjs), not a stray copy-paste of "sentence-clarity".
test('rules-formatting cases point at the "formatting" rules slug', () => {
  for (const slug of ['001-no-emoji-unless-asked', '002-reference-code-as-file-line', '003-clickable-link-not-raw-path']) {
    assert.strictEqual(caseFile(slug).rules, 'formatting', `${slug} rules slug`);
  }
});
