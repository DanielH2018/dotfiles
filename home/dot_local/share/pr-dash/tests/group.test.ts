import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { groupBy, sortWithin, stalenessBucket } from '../public/group.js';
import type { PrRecord } from '../src/types.ts';

const records: PrRecord[] = JSON.parse(
  readFileSync(new URL('./fixtures/records.json', import.meta.url), 'utf8'),
);

test('groups by repository, alphabetically', () => {
  const groups = groupBy(records, 'repo');
  assert.deepStrictEqual(groups.map((g) => g.key), ['acme/api', 'acme/web']);
  assert.strictEqual(groups[0]!.records.length, 1);
});

test('groups by ci status', () => {
  const groups = groupBy(records, 'ci');
  const keys = groups.map((g) => g.key).sort();
  assert.deepStrictEqual(keys, ['failure', 'success']);
});

test('groups by draft state', () => {
  const groups = groupBy(records, 'draft');
  assert.deepStrictEqual(groups.map((g) => g.key).sort(), ['draft', 'ready']);
});

test('staleness buckets partition by days since update', () => {
  assert.strictEqual(stalenessBucket(0), '<1d');
  assert.strictEqual(stalenessBucket(2), '1-3d');
  assert.strictEqual(stalenessBucket(5), '3-7d');
  assert.strictEqual(stalenessBucket(30), '>7d');
});

test('sorts by staleness, most stale first', () => {
  const sorted = sortWithin(records, 'stale');
  assert.strictEqual(sorted[0]!.id, 'acme/api#12');
});

test('sorts by size, largest diff first', () => {
  const sorted = sortWithin(records, 'size');
  assert.strictEqual(sorted[0]!.id, 'acme/api#12');
});

test('does not mutate its input', () => {
  const before = records.map((r) => r.id);
  sortWithin(records, 'title');
  assert.deepStrictEqual(records.map((r) => r.id), before);
});
