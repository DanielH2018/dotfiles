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
