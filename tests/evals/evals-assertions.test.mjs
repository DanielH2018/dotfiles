import { test } from 'node:test';
import assert from 'node:assert';
import { checkAssertions } from '../../evals/lib/assertions.mjs';

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

test('an invalid regex fails its own case instead of throwing out of the sweep', () => {
  const r = checkAssertions('some output', { must_match: ['(?i)confidence'] });
  assert.strictEqual(r.pass, false);
  assert.match(r.failures[0], /invalid regex/);
});

test('an invalid must_not_match pattern is reported, not silently passed', () => {
  const r = checkAssertions('some output', { must_not_match: ['a(b'] });
  assert.strictEqual(r.pass, false);
  assert.match(r.failures[0], /invalid regex/);
});
