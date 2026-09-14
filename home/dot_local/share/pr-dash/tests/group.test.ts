import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { groupBy, sortWithin, stalenessBucket } from '../public/group.js';
import type { PrRecord } from '../src/types.ts';

const records: PrRecord[] = JSON.parse(
  readFileSync(new URL('./fixtures/records.json', import.meta.url), 'utf8'),
);

/**
 * Builds a PrRecord for a test, filling every field with an arbitrary but
 * valid default so a test only has to name the fields it cares about.
 */
function makeRecord(overrides: Partial<PrRecord> & { id: string }): PrRecord {
  return {
    repo: 'x/y',
    number: 1,
    title: 'Untitled',
    url: `https://github.com/${overrides.id}`,
    headRef: 'branch',
    baseRef: 'main',
    isDraft: false,
    ci: 'success',
    review: 'none',
    openedAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-10T00:00:00Z',
    ageDays: 1,
    staleDays: 1,
    additions: 1,
    deletions: 0,
    ...overrides,
  };
}

// Source order, staleness order, size order, title order and age order are
// all different permutations of these four records, and each repo holds two
// of them — so a test built on this set can pin the sorted/grouped id
// sequence and have that sequence mean something (see fix round 1 below).
const orderRecords: PrRecord[] = [
  makeRecord({ id: 'x/y#1', repo: 'x/y', title: 'Charlie', staleDays: 2, additions: 10, deletions: 0, ageDays: 5 }),
  makeRecord({ id: 'x/y#2', repo: 'x/y', title: 'Alpha', staleDays: 8, additions: 50, deletions: 0, ageDays: 1 }),
  makeRecord({ id: 'a/b#3', repo: 'a/b', title: 'Delta', staleDays: 5, additions: 5, deletions: 0, ageDays: 9 }),
  makeRecord({ id: 'a/b#4', repo: 'a/b', title: 'Bravo', staleDays: 1, additions: 100, deletions: 0, ageDays: 3 }),
];

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

test('groups by staleness in chronological order, not alphabetical', () => {
  const stalenessRecords = [
    makeRecord({ id: 'p#1', staleDays: 10 }), // >7d
    makeRecord({ id: 'p#2', staleDays: 0 }), // <1d
    makeRecord({ id: 'p#3', staleDays: 5 }), // 3-7d
    makeRecord({ id: 'p#4', staleDays: 2 }), // 1-3d
  ];
  const groups = groupBy(stalenessRecords, 'staleness');
  assert.deepStrictEqual(groups.map((g) => g.key), ['<1d', '1-3d', '3-7d', '>7d']);
});

test('groups by review, most actionable first', () => {
  const reviewRecords = [
    makeRecord({ id: 'r#1', review: 'approved' }),
    makeRecord({ id: 'r#2', review: 'none' }),
    makeRecord({ id: 'r#3', review: 'changes_requested' }),
    makeRecord({ id: 'r#4', review: 'review_required' }),
  ];
  const groups = groupBy(reviewRecords, 'review');
  assert.deepStrictEqual(groups.map((g) => g.key), [
    'changes_requested',
    'review_required',
    'none',
    'approved',
  ]);
});

test('a group holds every record sharing its key', () => {
  const groups = groupBy(orderRecords, 'repo');
  assert.deepStrictEqual(groups.map((g) => g.key), ['a/b', 'x/y']);
  assert.deepStrictEqual(groups[0]!.records.map((r) => r.id), ['a/b#3', 'a/b#4']);
  assert.deepStrictEqual(groups[1]!.records.map((r) => r.id), ['x/y#1', 'x/y#2']);
});

test('staleness bucket boundaries at exactly 1, 3 and 7 days', () => {
  assert.strictEqual(stalenessBucket(1), '1-3d');
  assert.strictEqual(stalenessBucket(3), '1-3d');
  assert.strictEqual(stalenessBucket(7), '3-7d');
});

test('staleness buckets partition by days since update', () => {
  assert.strictEqual(stalenessBucket(0), '<1d');
  assert.strictEqual(stalenessBucket(2), '1-3d');
  assert.strictEqual(stalenessBucket(5), '3-7d');
  assert.strictEqual(stalenessBucket(30), '>7d');
});

test('sorts by staleness, most stale first', () => {
  const sorted = sortWithin(orderRecords, 'stale');
  assert.deepStrictEqual(sorted.map((r) => r.id), ['x/y#2', 'a/b#3', 'x/y#1', 'a/b#4']);
});

test('sorts by size, largest diff first', () => {
  const sorted = sortWithin(orderRecords, 'size');
  assert.deepStrictEqual(sorted.map((r) => r.id), ['a/b#4', 'x/y#2', 'x/y#1', 'a/b#3']);
});

test('sorts by age, oldest first', () => {
  const sorted = sortWithin(orderRecords, 'age');
  assert.deepStrictEqual(sorted.map((r) => r.id), ['a/b#3', 'x/y#1', 'a/b#4', 'x/y#2']);
});

test('does not mutate its input', () => {
  const before = orderRecords.map((r) => r.id);
  sortWithin(orderRecords, 'stale');
  assert.deepStrictEqual(orderRecords.map((r) => r.id), before);
});
