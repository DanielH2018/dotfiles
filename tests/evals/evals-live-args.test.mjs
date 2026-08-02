import { test } from 'node:test';
import assert from 'node:assert';
import { buildLiveArgs } from '../../evals/lib/live-args.mjs';

test('buildLiveArgs enables real tools/dispatch (no --agent, no --tools "")', () => {
  const a = buildLiveArgs({ input: 'Review the homelab security area.' });
  assert.ok(a.includes('-p') && a.includes('Review the homelab security area.'));
  assert.ok(a.includes('--output-format') && a.includes('json'));
  assert.ok(!a.includes('--agent'));
  assert.ok(!(a.includes('--tools') && a[a.indexOf('--tools') + 1] === ''));
  const b = buildLiveArgs({ input: 'x', maxBudgetUsd: 3, permissionMode: 'plan' });
  assert.strictEqual(b[b.indexOf('--max-budget-usd') + 1], '3');
  assert.strictEqual(b[b.indexOf('--permission-mode') + 1], 'plan');
});
