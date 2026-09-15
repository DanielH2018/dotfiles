import type { PrRecord, StackNode } from './types.ts';

// Branch names are only unique within a repository, so every lookup key below combines
// the repo with the ref, not just the bare ref -- otherwise two repos sharing a branch
// name (e.g. both using "main") would link into one false stack. The separator is a
// plain space: a ref can't contain one (git itself rejects it) and repo is always
// "owner/name", so neither half can ever contain the separator either.
function refKey(repo: string, ref: string): string {
  return `${repo} ${ref}`;
}

// A repo whose actual default branch is unknown -- PrRecord.defaultBranch is null,
// which happens for an empty repository, where GitHub's defaultBranchRef is itself
// null -- falls back to guessing from these common names rather than flagging every
// ordinary PR in that repo as needing a rebase.
const TRUNK_NAMES = new Set(['main', 'master', 'develop', 'trunk']);

function isTrunk(pr: PrRecord): boolean {
  if (pr.defaultBranch !== null) return pr.baseRef === pr.defaultBranch;
  return TRUNK_NAMES.has(pr.baseRef);
}

// True if walking parent-of-parent (by baseRef -> headRef) from `pr` ever revisits a
// node already seen, including `pr` itself. This should be impossible through GitHub's
// UI (you cannot open a PR whose base branch is downstream of its own head), but code
// that assumes that and walks unbounded parent chains hangs forever on bad data -- a
// genuine infinite loop, not a failing assertion. `node --test`'s `--test-timeout`
// would not save it either: the loop is synchronous and never yields to the event
// loop, so nothing gets a chance to observe the deadline. Tracking visited nodes turns
// that hang into a normal, fast return instead.
function inCycle(pr: PrRecord, byHead: Map<string, PrRecord>): boolean {
  const seen = new Set<string>([pr.id]);
  let cursor = byHead.get(refKey(pr.repo, pr.baseRef));
  while (cursor !== undefined) {
    if (seen.has(cursor.id)) return true;
    seen.add(cursor.id);
    cursor = byHead.get(refKey(cursor.repo, cursor.baseRef));
  }
  return false;
}

// Counts how many open PRs each repo+headRef names, and maps that key to the one PR
// with that head when the count is exactly 1. GitHub permits the same branch to be
// the head of two simultaneously open PRs (e.g. one branch opened against both
// `main` and a release branch), and when that happens there is no principled way to
// say which of the two is the stack parent for a PR based on that branch. Leaving
// the ref out of `byHead` entirely -- rather than letting whichever PR a plain
// `set()` saw last win -- makes every PR based on that ref a root instead of
// attaching to an arbitrary, iteration-order-dependent parent. `counts` is exposed
// too, because a root by this route still needs to know *why* it has no parent: a
// count of 0 means the base never existed as an open PR's head at all (a plausible
// merged-away parent), while a count of 2+ means it exists but is ambiguous -- a
// materially different, non-dangling state.
function buildHeadIndex(
  records: readonly PrRecord[],
): { byHead: Map<string, PrRecord>; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  for (const pr of records) {
    const key = refKey(pr.repo, pr.headRef);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const byHead = new Map<string, PrRecord>();
  for (const pr of records) {
    const key = refKey(pr.repo, pr.headRef);
    if (counts.get(key) === 1) byHead.set(key, pr);
  }
  return { byHead, counts };
}

export function buildStacks(records: readonly PrRecord[]): StackNode[] {
  const { byHead, counts } = buildHeadIndex(records);

  const childrenOf = new Map<string, PrRecord[]>();
  const roots: PrRecord[] = [];
  const dangling = new Set<string>();
  const ambiguous = new Set<string>();

  for (const pr of records) {
    // A PR that sits on a cycle is treated as a root with no linkage at all -- both
    // ends of the cycle render flat rather than each claiming the other as parent,
    // which would recurse forever when the tree is later walked for size/depth.
    const cyclic = inCycle(pr, byHead);
    const headKey = refKey(pr.repo, pr.baseRef);
    const parent = cyclic ? undefined : byHead.get(headKey);

    if (parent === undefined) {
      roots.push(pr);
      // A cyclic PR is never flagged either way: its "root" status is an artifact
      // of cycle-breaking, not a merged or ambiguous parent. Trunk is checked
      // first and gates both flags: a PR based on the repo's actual trunk is
      // neither dangling nor ambiguous, however many other open PRs happen to
      // share its base as their headRef.
      if (!cyclic && !isTrunk(pr)) {
        const baseCount = counts.get(headKey) ?? 0;
        if (baseCount > 1) {
          // baseRef names a headRef that exists -- more than once -- so there is a
          // real candidate parent, just not a determinable one. That is not the
          // same as a merged-away parent, and flagging it dangling would tell the
          // user to rebase when there is nothing to rebase onto.
          ambiguous.add(pr.id);
        } else {
          // A base that resolves to no open PR's head at all and isn't the repo's
          // trunk means the parent merged while this PR stayed open -- exactly the
          // state where a stack needs a rebase, so it is flagged rather than
          // treated as an ordinary stack-free PR.
          dangling.add(pr.id);
        }
      }
    } else {
      const list = childrenOf.get(parent.id);
      if (list === undefined) childrenOf.set(parent.id, [pr]);
      else list.push(pr);
    }
  }

  const bySort = (a: PrRecord, b: PrRecord): number =>
    a.repo.localeCompare(b.repo) || a.number - b.number;

  function size(pr: PrRecord): number {
    return 1 + (childrenOf.get(pr.id) ?? []).reduce((n, c) => n + size(c), 0);
  }

  function build(pr: PrRecord, depth: number, position: number, stackSize: number): StackNode {
    const kids = [...(childrenOf.get(pr.id) ?? [])].sort(bySort);
    let next = position;
    const children = kids.map((k) => {
      next += 1;
      const node = build(k, depth + 1, next, stackSize);
      next += size(k) - 1;
      return node;
    });
    return {
      pr,
      children,
      depth,
      position,
      stackSize,
      danglingBase: dangling.has(pr.id),
      ambiguousBase: ambiguous.has(pr.id),
    };
  }

  return roots.sort(bySort).map((r) => build(r, 0, 1, size(r)));
}
