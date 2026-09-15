export type Ci = 'success' | 'failure' | 'pending' | 'none';
export type Review = 'approved' | 'changes_requested' | 'review_required' | 'none';

export type PrRecord = {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  headRef: string;
  baseRef: string;
  isDraft: boolean;
  ci: Ci;
  review: Review;
  openedAt: string;
  updatedAt: string;
  ageDays: number;
  staleDays: number;
  additions: number;
  deletions: number;
  // The repo's actual default branch name, or null for an empty repository (GitHub's
  // defaultBranchRef is itself null there). buildStacks compares baseRef against this
  // instead of a fixed list of conventional trunk names.
  defaultBranch: string | null;
};

export type StackNode = {
  pr: PrRecord;
  children: StackNode[];
  depth: number;
  position: number;
  stackSize: number;
  danglingBase: boolean;
};
