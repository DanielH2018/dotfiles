import { test } from 'node:test';
import assert from 'node:assert';
import { buildStacks } from '../src/stacks.ts';
import type { PrRecord } from '../src/types.ts';

function pr(repo: string, number: number, headRef: string, baseRef: string): PrRecord {
  return {
    id: `${repo}#${number}`, repo, number, title: `pr ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    headRef, baseRef, isDraft: false, ci: 'none', review: 'none',
    openedAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    ageDays: 0, staleDays: 0, additions: 0, deletions: 0,
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
