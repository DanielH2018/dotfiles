import { test } from 'node:test';
import assert from 'node:assert';
import { parseThreshold, aggregateCase, overallExitCode } from '../../evals/lib/report.mjs';

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
