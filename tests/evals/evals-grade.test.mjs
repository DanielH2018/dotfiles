import { test } from 'node:test';
import assert from 'node:assert';
import { gradeFromParts } from '../../evals/lib/grade.mjs';

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

// needsJudge=false: a fully regex-gradable case (no `rubric`) — pass/fail comes from the
// assertion alone, with no judgeResult required at all.
test('needsJudge=false: assertion pass with no judgeResult is a passing run, not an infra error', () => {
  const r = gradeFromParts({
    invocation: { status: 'ok', text: 'clean output, no emoji' },
    assertion: { pass: true, failures: [] },
    judgeResult: null,
    needsJudge: false,
  });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.pass, true);
});

test('needsJudge=false: assertion failure still fails, same as the judged path', () => {
  const r = gradeFromParts({
    invocation: { status: 'ok', text: 'oops \u{1F600}' },
    assertion: { pass: false, failures: ['must_not_match matched: emoji'] },
    judgeResult: null,
    needsJudge: false,
  });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.pass, false);
});

test('needsJudge defaults to true, so an existing rubric-bearing case is unaffected', () => {
  const r = gradeFromParts({
    invocation: { status: 'ok', text: 'Risk Level: LOW' },
    assertion: { pass: true, failures: [] },
    judgeResult: null,
  });
  assert.strictEqual(r.status, 'infra_error', 'omitting needsJudge must still require a judge result by default');
});
