import { test } from 'node:test';
import assert from 'node:assert';
import { buildStacks } from '../src/stacks.ts';
import type { PrRecord } from '../src/types.ts';

function pr(
  repo: string,
  number: number,
  headRef: string,
  baseRef: string,
  defaultBranch: string | null = 'main',
): PrRecord {
  return {
    id: `${repo}#${number}`, repo, number, title: `pr ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    headRef, baseRef, isDraft: false, ci: 'none', review: 'none',
    openedAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    ageDays: 0, staleDays: 0, additions: 0, deletions: 0,
    defaultBranch,
  };
}

test('a linear chain of four nests with positions', () => {
  const roots = buildStacks([
    pr('a/b', 1, 'f1', 'main'),
    pr('a/b', 2, 'f2', 'f1'),
    pr('a/b', 3, 'f3', 'f2'),
    pr('a/b', 4, 'f4', 'f3'),
  ]);
  assert.strictEqual(roots.length, 1);
  assert.strictEqual(roots[0]!.position, 1);
  assert.strictEqual(roots[0]!.stackSize, 4);
  assert.strictEqual(roots[0]!.children[0]!.children[0]!.children[0]!.pr.number, 4);
  assert.strictEqual(roots[0]!.children[0]!.children[0]!.children[0]!.position, 4);
});

test('two PRs sharing one base fork the tree', () => {
  const roots = buildStacks([
    pr('a/b', 1, 'f1', 'main'),
    pr('a/b', 2, 'f2', 'f1'),
    pr('a/b', 3, 'f3', 'f1'),
  ]);
  assert.strictEqual(roots.length, 1);
  assert.strictEqual(roots[0]!.children.length, 2);
  // Positions must be unique and span 1..stackSize with no gaps or overlaps. A mutant
  // that drops a sibling's position by miscounting an earlier branch's size (`next +=
  // size(k)` instead of `size(k) - 1`) still produces two children and passes the
  // length check above, but assigns positions outside that range.
  const nodes = [roots[0]!, ...roots[0]!.children];
  const positions = nodes.map((n) => n.position).sort((a, b) => a - b);
  assert.deepStrictEqual(positions, [1, 2, 3]);
  for (const node of nodes) assert.strictEqual(node.stackSize, 3);
});

test('a dangling base becomes a flagged root', () => {
  const roots = buildStacks([pr('a/b', 2, 'f2', 'f1-merged-away')]);
  assert.strictEqual(roots.length, 1);
  assert.strictEqual(roots[0]!.danglingBase, true);
});

test('a PR based on trunk is not flagged', () => {
  const roots = buildStacks([pr('a/b', 1, 'f1', 'main')]);
  assert.strictEqual(roots[0]!.danglingBase, false);
});

test('identical branch names in different repos do not link', () => {
  const roots = buildStacks([pr('a/b', 1, 'f1', 'main'), pr('c/d', 2, 'f2', 'f1')]);
  assert.strictEqual(roots.length, 2);
});

test('a cycle terminates and renders flat rather than hanging', () => {
  const roots = buildStacks([pr('a/b', 1, 'f1', 'f2'), pr('a/b', 2, 'f2', 'f1')]);
  assert.strictEqual(roots.length, 2);
  assert.ok(roots.every((r) => r.children.length === 0));
});

// Fix round 1, finding 2: GitHub permits the same branch to be the head of two
// simultaneously open PRs (e.g. one opened against `main`, another against a release
// branch). Which of the two a plain `byHead.set()` keeps as "the" parent for a PR based
// on that shared branch depends on the order records arrive in, not on anything real —
// so neither is treated as a parent at all.
test('two PRs sharing a headRef do not silently pick a parent', () => {
  const roots = buildStacks([
    pr('a/b', 1, 'f1', 'main'),
    pr('a/b', 2, 'f1', 'release'),
    pr('a/b', 3, 'f2', 'f1'),
  ]);
  assert.strictEqual(roots.length, 3);
  assert.ok(roots.every((r) => r.children.length === 0));
});

// Fix round 1, finding 4: a fixed list of conventional trunk names misreports every
// ordinary PR in a repo with a differently named default branch as needing a rebase.
// PrRecord.defaultBranch (from GitHub's defaultBranchRef) replaces the list whenever
// it's known.
test('a PR based on a non-conventional default branch is not flagged', () => {
  const roots = buildStacks([pr('a/b', 1, 'f1', 'development', 'development')]);
  assert.strictEqual(roots[0]!.danglingBase, false);
});

test('a dangling base is still flagged when the repo has a known default branch', () => {
  const roots = buildStacks([pr('a/b', 2, 'f2', 'f1-merged-away', 'development')]);
  assert.strictEqual(roots[0]!.danglingBase, true);
});

// An empty repository has no default branch — GitHub's defaultBranchRef is null there
// — so this falls back to the conventional-name list rather than flagging every PR.
test('a null defaultBranch falls back to the conventional trunk-name list', () => {
  const roots = buildStacks([pr('a/b', 1, 'f1', 'main', null)]);
  assert.strictEqual(roots[0]!.danglingBase, false);
});
