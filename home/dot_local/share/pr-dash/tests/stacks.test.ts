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
  assert.strictEqual(roots[0]!.danglingBase, false);
  assert.strictEqual(roots[0]!.ambiguousBase, false);
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
  for (const node of nodes) {
    assert.strictEqual(node.stackSize, 3);
    assert.strictEqual(node.danglingBase, false);
    assert.strictEqual(node.ambiguousBase, false);
  }
});

test('a dangling base becomes a flagged root', () => {
  const roots = buildStacks([pr('a/b', 2, 'f2', 'f1-merged-away')]);
  assert.strictEqual(roots.length, 1);
  assert.strictEqual(roots[0]!.danglingBase, true);
  assert.strictEqual(roots[0]!.ambiguousBase, false);
});

test('a PR based on trunk is not flagged', () => {
  const roots = buildStacks([pr('a/b', 1, 'f1', 'main')]);
  assert.strictEqual(roots[0]!.danglingBase, false);
  assert.strictEqual(roots[0]!.ambiguousBase, false);
});

test('identical branch names in different repos do not link', () => {
  const roots = buildStacks([pr('a/b', 1, 'f1', 'main'), pr('c/d', 2, 'f2', 'f1')]);
  assert.strictEqual(roots.length, 2);
  assert.strictEqual(roots[0]!.danglingBase, false);
  assert.strictEqual(roots[0]!.ambiguousBase, false);
  // c/d#2's base "f1" matches no headRef in ITS OWN repo (only a/b has one) — a
  // genuinely missing parent, not an ambiguous one, and not repo-scoping bleeding
  // the two repos' identical branch names together.
  assert.strictEqual(roots[1]!.danglingBase, true);
  assert.strictEqual(roots[1]!.ambiguousBase, false);
});

test('a cycle terminates and renders flat rather than hanging', () => {
  const roots = buildStacks([pr('a/b', 1, 'f1', 'f2'), pr('a/b', 2, 'f2', 'f1')]);
  assert.strictEqual(roots.length, 2);
  assert.ok(roots.every((r) => r.children.length === 0));
  assert.ok(roots.every((r) => r.danglingBase === false && r.ambiguousBase === false));
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

  const [r1, r2, r3] = roots;
  assert.strictEqual(r1!.danglingBase, false);
  assert.strictEqual(r1!.ambiguousBase, false);
  // r2's base ("release") matches no open PR's head at all in this repo — the same
  // trunk-name-list limitation noted elsewhere in this suite (out of scope: telling
  // "merged away" apart from "just not this repo's trunk and not anyone's branch"
  // needs ref-existence data nobody's asked for), not new behavior from this fix.
  assert.strictEqual(r2!.danglingBase, true);
  assert.strictEqual(r2!.ambiguousBase, false);
  // r3's base ("f1") DOES match an open PR's head — two of them (r1 and r2). That
  // ambiguity, not a merged parent, is why r3 has no parent here, and it must not
  // read as "base merged": nothing has merged, and rebasing would be wrong advice.
  assert.strictEqual(r3!.danglingBase, false);
  assert.strictEqual(r3!.ambiguousBase, true);
});

// Fix round 1, finding 4: a fixed list of conventional trunk names misreports every
// ordinary PR in a repo with a differently named default branch as needing a rebase.
// PrRecord.defaultBranch (from GitHub's defaultBranchRef) replaces the list whenever
// it's known.
test('a PR based on a non-conventional default branch is not flagged', () => {
  const roots = buildStacks([pr('a/b', 1, 'f1', 'development', 'development')]);
  assert.strictEqual(roots[0]!.danglingBase, false);
  assert.strictEqual(roots[0]!.ambiguousBase, false);
});

test('a dangling base is still flagged when the repo has a known default branch', () => {
  const roots = buildStacks([pr('a/b', 2, 'f2', 'f1-merged-away', 'development')]);
  assert.strictEqual(roots[0]!.danglingBase, true);
  assert.strictEqual(roots[0]!.ambiguousBase, false);
});

// An empty repository has no default branch — GitHub's defaultBranchRef is null there
// — so this falls back to the conventional-name list rather than flagging every PR.
test('a null defaultBranch falls back to the conventional trunk-name list', () => {
  const roots = buildStacks([pr('a/b', 1, 'f1', 'main', null)]);
  assert.strictEqual(roots[0]!.danglingBase, false);
  assert.strictEqual(roots[0]!.ambiguousBase, false);
});

// Fix round 2: a base that names a headRef shared by more than one open PR is a real
// candidate parent, just not a determinable one -- distinct from a merged-away parent,
// which is what danglingBase means. The round-1 fix for finding 2 (stopping the false
// parent link) accidentally routed this case through the same dangling check as a
// genuinely merged base, since both look like "no parent found" from that check alone.
test('an ambiguous base is not the same as a merged one', () => {
  const roots = buildStacks([
    pr('a/b', 1, 'f1', 'main'),
    pr('a/b', 2, 'f1', 'main'),
    pr('a/b', 3, 'f2', 'f1'),
  ]);
  const r3 = roots.find((r) => r.pr.number === 3)!;
  assert.strictEqual(r3.ambiguousBase, true);
  assert.strictEqual(r3.danglingBase, false);
});
