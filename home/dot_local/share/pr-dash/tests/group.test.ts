import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { applyFilters, groupBy, sortStackRoots, sortWithin, stalenessBucket } from '../public/group.js';
import type { Sort } from '../public/group.js';
import type { PrRecord, StackNode } from '../src/types.ts';

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
    defaultBranch: 'main',
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

test('groups by ci status, most actionable first', () => {
  const ciRecords = [
    makeRecord({ id: 'c#1', ci: 'success' }),
    makeRecord({ id: 'c#2', ci: 'none' }),
    makeRecord({ id: 'c#3', ci: 'failure' }),
    makeRecord({ id: 'c#4', ci: 'pending' }),
  ];
  const groups = groupBy(ciRecords, 'ci');
  assert.deepStrictEqual(groups.map((g) => g.key), ['failure', 'pending', 'none', 'success']);
});

test('groups by draft state, ready before draft', () => {
  const draftRecords = [
    makeRecord({ id: 'd#1', isDraft: true }),
    makeRecord({ id: 'd#2', isDraft: false }),
  ];
  const groups = groupBy(draftRecords, 'draft');
  assert.deepStrictEqual(groups.map((g) => g.key), ['ready', 'draft']);
});

test('a draft PR lands in the draft group and a non-draft PR in ready', () => {
  // The ordering test above pins the key sequence but not which record
  // ended up under which key, so an inverted isDraft-to-key mapping would
  // still pass it (both keys are still present, just with swapped
  // membership). This test pins the contents instead.
  const draftRecords = [
    makeRecord({ id: 'd#1', isDraft: true }),
    makeRecord({ id: 'd#2', isDraft: false }),
  ];
  const groups = groupBy(draftRecords, 'draft');
  const byKey = new Map(groups.map((g) => [g.key, g.records.map((r) => r.id)]));
  assert.deepStrictEqual(byKey.get('draft'), ['d#1']);
  assert.deepStrictEqual(byKey.get('ready'), ['d#2']);
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

test('sorts by title, ascending', () => {
  const sorted = sortWithin(orderRecords, 'title');
  assert.deepStrictEqual(sorted.map((r) => r.id), ['x/y#2', 'a/b#4', 'x/y#1', 'a/b#3']);
});

test('does not mutate its input', () => {
  const before = orderRecords.map((r) => r.id);
  sortWithin(orderRecords, 'stale');
  assert.deepStrictEqual(orderRecords.map((r) => r.id), before);
});

/**
 * Builds a stack node around `pr`, with `children` nested under it. The positional
 * fields are the arbitrary-but-valid defaults buildStacks would have filled in;
 * sortStackRoots reads none of them.
 */
function makeNode(pr: PrRecord, children: StackNode[] = []): StackNode {
  return { pr, children, depth: 0, position: 1, stackSize: 1 + children.length, danglingBase: false, ambiguousBase: false };
}

// Three roots whose buildStacks order (repo, then number) is r1, r2, r3 — an order that
// differs from every one of the four sorts below. A fixture where one sort happened to
// agree with source order would pass against an implementation that never sorted at all,
// which is exactly how three sort assertions passed against a no-op earlier in this
// project.
const rootRecords = {
  r1: makeRecord({ id: 'x/y#1', repo: 'x/y', title: 'Charlie', staleDays: 2, ageDays: 5, additions: 10 }),
  r2: makeRecord({ id: 'x/y#2', repo: 'x/y', title: 'Alpha', staleDays: 8, ageDays: 1, additions: 50 }),
  r3: makeRecord({ id: 'x/y#3', repo: 'x/y', title: 'Bravo', staleDays: 5, ageDays: 9, additions: 5 }),
};

// r1 carries two children whose own stale/age/title/size order is the reverse of their
// stack order, so a sort that wrongly recursed into the stack would reorder them.
const childA = makeRecord({ id: 'x/y#10', repo: 'x/y', title: 'Zulu', staleDays: 1, ageDays: 1, additions: 1 });
const childB = makeRecord({ id: 'x/y#11', repo: 'x/y', title: 'Yankee', staleDays: 9, ageDays: 9, additions: 99 });

function rootsInStackOrder(): StackNode[] {
  return [
    makeNode(rootRecords.r1, [makeNode(childA), makeNode(childB)]),
    makeNode(rootRecords.r2),
    makeNode(rootRecords.r3),
  ];
}

const rootExpectations: [Sort, string[]][] = [
  ['stale', ['x/y#2', 'x/y#3', 'x/y#1']],
  ['age', ['x/y#3', 'x/y#1', 'x/y#2']],
  ['title', ['x/y#2', 'x/y#3', 'x/y#1']],
  ['size', ['x/y#2', 'x/y#1', 'x/y#3']],
];

for (const [sort, expected] of rootExpectations) {
  test(`sortStackRoots orders roots by ${sort}`, () => {
    const sorted = sortStackRoots(rootsInStackOrder(), sort);
    assert.deepStrictEqual(sorted.map((n) => n.pr.id), expected);
  });
}

test('sortStackRoots leaves a stack\'s children in stack order', () => {
  // The stack's shape is its meaning: #10 bases on #1 and #11 on #10, so reordering them
  // by staleness would render a stack that does not exist.
  for (const [sort] of rootExpectations) {
    const sorted = sortStackRoots(rootsInStackOrder(), sort);
    const withChildren = sorted.find((n) => n.pr.id === 'x/y#1');
    assert.deepStrictEqual(
      withChildren?.children.map((c) => c.pr.id),
      ['x/y#10', 'x/y#11'],
      `children were reordered under the ${sort} sort`,
    );
  }
});

test('sortStackRoots does not mutate its input', () => {
  const roots = rootsInStackOrder();
  sortStackRoots(roots, 'stale');
  assert.deepStrictEqual(roots.map((n) => n.pr.id), ['x/y#1', 'x/y#2', 'x/y#3']);
});

test('an empty filter set matches everything', () => {
  const out = applyFilters(records, { ci: [], review: [], draft: [], staleness: [] });
  assert.strictEqual(out.length, records.length);
});

test('filters by ci status', () => {
  const out = applyFilters(records, { ci: ['failure'], review: [], draft: [], staleness: [] });
  assert.deepStrictEqual(out.map((r) => r.id), ['acme/web#7']);
});

test('filters combine as AND across axes', () => {
  const out = applyFilters(records, { ci: ['failure'], review: ['approved'], draft: [], staleness: [] });
  assert.strictEqual(out.length, 0);
});

test('filters combine as OR within one axis', () => {
  // The fixture's two records are the whole domain of ci: ['failure', 'success'], so that
  // filter is indistinguishable from no constraint at all on records alone — a third
  // record outside the pair makes the OR a strict subset of the input, not just everything.
  const ciRecords = [
    makeRecord({ id: 'p#1', ci: 'success' }),
    makeRecord({ id: 'p#2', ci: 'failure' }),
    makeRecord({ id: 'p#3', ci: 'pending' }),
  ];
  const out = applyFilters(ciRecords, { ci: ['failure', 'success'], review: [], draft: [], staleness: [] });
  assert.deepStrictEqual(out.map((r) => r.id), ['p#1', 'p#2']);
});

test('filters by draft state', () => {
  const draftRecords = [
    makeRecord({ id: 'q#1', isDraft: true }),
    makeRecord({ id: 'q#2', isDraft: false }),
  ];
  const out = applyFilters(draftRecords, { ci: [], review: [], draft: ['draft'], staleness: [] });
  assert.deepStrictEqual(out.map((r) => r.id), ['q#1']);
});

// One record per bucket, so a filter naming one bucket has three records it must exclude
// and an off-by-one threshold changes which id comes back.
const stalenessRecords: PrRecord[] = [
  makeRecord({ id: 's#1', staleDays: 0 }),
  makeRecord({ id: 's#2', staleDays: 2 }),
  makeRecord({ id: 's#3', staleDays: 5 }),
  makeRecord({ id: 's#4', staleDays: 30 }),
];

test('filters by staleness bucket', () => {
  const out = applyFilters(stalenessRecords, { ci: [], review: [], draft: [], staleness: ['3-7d'] });
  assert.deepStrictEqual(out.map((r) => r.id), ['s#3']);
});

test('the staleness axis is OR within itself', () => {
  const out = applyFilters(stalenessRecords, {
    ci: [],
    review: [],
    draft: [],
    staleness: ['<1d', '>7d'],
  });
  assert.deepStrictEqual(out.map((r) => r.id), ['s#1', 's#4']);
});

test('an empty staleness list imposes no constraint', () => {
  const out = applyFilters(stalenessRecords, { ci: [], review: [], draft: [], staleness: [] });
  assert.deepStrictEqual(out.map((r) => r.id), ['s#1', 's#2', 's#3', 's#4']);
});

test('staleness and draft are ANDed with each other and with ci', () => {
  const mixed = [
    makeRecord({ id: 'm#1', staleDays: 30, isDraft: false, ci: 'failure' }),
    makeRecord({ id: 'm#2', staleDays: 30, isDraft: true, ci: 'failure' }),
    makeRecord({ id: 'm#3', staleDays: 0, isDraft: false, ci: 'failure' }),
    makeRecord({ id: 'm#4', staleDays: 30, isDraft: false, ci: 'success' }),
  ];
  const out = applyFilters(mixed, {
    ci: ['failure'],
    review: [],
    draft: ['ready'],
    staleness: ['>7d'],
  });
  assert.deepStrictEqual(out.map((r) => r.id), ['m#1']);
});
