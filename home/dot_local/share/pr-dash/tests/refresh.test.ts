import { test } from 'node:test';
import assert from 'node:assert';
import { withFallback } from '../src/main-lib.ts';
import type { PrRecord } from '../src/types.ts';

// A non-empty payload, not `[]`: a fallback that returns the fresh (empty) result
// instead of the retained one would still pass `deepStrictEqual([], [])` below, so
// an empty fixture can't tell "retained" apart from "fresh but empty".
const one: PrRecord[] = [
  {
    id: 'acme/api#12',
    repo: 'acme/api',
    number: 12,
    title: 'Add retry budget',
    url: 'https://github.com/acme/api/pull/12',
    headRef: 'retry-budget',
    baseRef: 'main',
    isDraft: false,
    ci: 'success',
    review: 'approved',
    openedAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-10T00:00:00Z',
    ageDays: 13,
    staleDays: 4,
    additions: 120,
    deletions: 8,
    defaultBranch: 'main',
  },
];

test('a successful load is not stale', async () => {
  const load = withFallback(async () => one);
  const r = await load();
  assert.strictEqual(r.stale, false);
  assert.strictEqual(r.error, undefined);
});

test('a failure after a success returns the last good payload, marked stale', async () => {
  let fail = false;
  const load = withFallback(async () => {
    if (fail) throw new Error('network down');
    return one;
  });
  await load();
  fail = true;
  const r = await load();
  assert.strictEqual(r.stale, true);
  assert.match(String(r.error), /network down/);
  assert.deepStrictEqual(r.prs, one);
});

test('a failure with no previous success rejects', async () => {
  const load = withFallback(async () => { throw new Error('cold failure'); });
  await assert.rejects(load, /cold failure/);
});
