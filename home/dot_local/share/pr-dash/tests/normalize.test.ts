import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { normalize } from '../src/normalize.ts';
import { parsePrsBody } from '../public/render-guards.js';
import { stalenessBucket } from '../public/group.js';

const nodes = JSON.parse(
  readFileSync(new URL('./fixtures/graphql-page.json', import.meta.url), 'utf8'),
);
const NOW = new Date('2026-09-14T00:00:00Z');

// Fixture-array indexing below asserts with `!` rather than destructuring, matching the
// non-null-assertion convention already used for known-position array access elsewhere in
// this suite (e.g. tests/import-convention.test.ts's `hits[0]!`). noUncheckedIndexedAccess
// types every element access — direct or destructured — as possibly undefined; these four
// fixture nodes are fixed and known, unlike the real no-commits case normalize.ts itself
// guards against without an assertion.

test('builds a stable id from repo and number', () => {
  const first = normalize(nodes, NOW)[0]!;
  assert.strictEqual(first.id, 'acme/api#12');
});

test('maps a SUCCESS rollup to success', () => {
  assert.strictEqual(normalize(nodes, NOW)[0]!.ci, 'success');
});

test('a null statusCheckRollup is none, not pending', () => {
  assert.strictEqual(normalize(nodes, NOW)[1]!.ci, 'none');
});

test('a null reviewDecision is none, not review_required', () => {
  assert.strictEqual(normalize(nodes, NOW)[1]!.review, 'none');
});

test('maps CHANGES_REQUESTED', () => {
  assert.strictEqual(normalize(nodes, NOW)[2]!.review, 'changes_requested');
});

test('a PR with no commits is none rather than a crash', () => {
  assert.strictEqual(normalize(nodes, NOW)[3]!.ci, 'none');
});

// commits(last: 1) is the query the caller must run — GitHub returns commits oldest-first,
// so a caller that queries first: 1 instead would silently hand normalize() the oldest
// commit's rollup rather than the head's. Every fixture node above has 0 or 1 commits, so
// none of them can tell "reads the last element" apart from "reads the first" — this fixture
// carries two commits with different rollup states to force that distinction.
test('reads the last commit in commits.nodes, not the first', () => {
  const record = normalize(
    [
      {
        ...nodes[0],
        commits: {
          nodes: [
            { commit: { statusCheckRollup: { state: 'SUCCESS' } } },
            { commit: { statusCheckRollup: { state: 'FAILURE' } } },
          ],
        },
      },
    ],
    NOW,
  )[0]!;
  assert.strictEqual(record.ci, 'failure');
});

test('computes age and staleness in whole days from now', () => {
  const first = normalize(nodes, NOW)[0]!;
  assert.strictEqual(first.ageDays, 13);
  assert.strictEqual(first.staleDays, 4);
});

// Beyond the seven behaviours in the brief: the fixtures above never exercise a future
// timestamp, an unparseable date, or a rollup state GitHub hasn't shipped yet, but the task
// calls out all three as reachable (clock skew, a malformed field, a schema addition), so
// the clamping/fallback decisions made in normalize.ts get their own coverage rather than
// living only in the report.

test('a createdAt in the future clamps ageDays to 0, not a negative number', () => {
  const first = normalize(nodes, new Date('2026-08-01T00:00:00Z'))[0]!;
  assert.strictEqual(first.ageDays, 0);
});

// An unparseable date must not clamp to 0: 0 lands in stalenessBucket's '<1d' bucket and
// sorts to the bottom of the descending 'stale'/'age' sort, reading as "freshly touched" —
// the opposite of "unknown" on the one axis whose entire job is surfacing neglected PRs. It
// surfaces instead, landing in '>7d' and sorting to the top, so a malformed record renders
// looking wrong rather than looking fine. normalize() does not throw on a bad date — one
// malformed record from GitHub should not blank the whole dashboard.
test('an unparseable updatedAt is treated as maximally stale, not freshly touched', () => {
  const record = normalize([{ ...nodes[0], updatedAt: 'not-a-date' }], NOW)[0]!;
  assert.strictEqual(stalenessBucket(record.staleDays), '>7d');
  assert.ok(Number.isFinite(record.staleDays));
});

test('an unparseable createdAt is treated as maximally old, not freshly opened', () => {
  const record = normalize([{ ...nodes[0], createdAt: 'not-a-date' }], NOW)[0]!;
  assert.strictEqual(stalenessBucket(record.ageDays), '>7d');
  assert.ok(Number.isFinite(record.ageDays));
});

test('an unrecognized rollup state falls back to pending, not none or success', () => {
  const record = normalize(
    [
      {
        ...nodes[0],
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SOME_NEW_STATE' } } }] },
      },
    ],
    NOW,
  )[0]!;
  assert.strictEqual(record.ci, 'pending');
});

// The real contract between Task 5 and Task 7: normalize()'s output must satisfy the same
// validateRecord that public/app.js runs against /api/prs responses. Nothing else in the
// suite checks this — render-guards.test.ts exercises validateRecord against hand-built
// records, never against normalize()'s actual output, including the null-rollup and
// no-commits nodes that are this task's whole point.
test('normalize output satisfies render-guards.js\'s validateRecord for every fixture node', () => {
  const records = normalize(nodes, NOW);
  assert.doesNotThrow(() => parsePrsBody({ prs: records }));
});
