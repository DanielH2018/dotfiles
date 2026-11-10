import { test } from 'node:test';
import assert from 'node:assert';
import { createServer as createNetServer } from 'node:net';
import type { Client, QueryResult } from '../src/github.ts';
import { createCache } from '../src/cache.ts';
import { createServer } from '../src/server.ts';
import {
  createRepoLoader,
  fetchRepoRow,
  type LoadRepos,
  type OverviewData,
  type RawCommit,
  type RawPrNode,
  type RepoLoadResult,
} from '../src/repos.ts';

type Page =
  | { prs: RawPrNode[]; total?: number; next?: string; commit?: Partial<RawCommit> | null; noBranch?: true }
  | { error: string }
  | { throws: string };

const COMMIT: RawCommit = {
  url: 'https://github.com/acme/api/commit/abc',
  committedDate: '2026-11-01T00:00:00Z',
  messageHeadline: 'Fix the thing',
  author: { name: 'A Person', user: { login: 'aperson' } },
  statusCheckRollup: { state: 'SUCCESS' },
};

function pr(overrides: Partial<RawPrNode> = {}): RawPrNode {
  return {
    number: 1,
    title: 'Change a thing',
    url: 'https://github.com/acme/api/pull/1',
    isDraft: false,
    baseRefName: 'main',
    headRefName: 'change',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    additions: 10,
    deletions: 2,
    reviewDecision: null,
    repository: { nameWithOwner: 'acme/api', defaultBranchRef: { name: 'main' } },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
    author: { login: 'teammate' },
    reviews: { totalCount: 0 },
    ...overrides,
  };
}

// Answers each repository from a list of pages keyed by `owner/name`, as vulns.test.ts does.
function fakeClient(pages: Record<string, Page[]>) {
  const calls: Record<string, unknown>[] = [];
  const client: Client = {
    async query<T>(_query: string, variables: Record<string, unknown>): Promise<QueryResult<T>> {
      calls.push(variables);
      const key = `${String(variables['owner'])}/${String(variables['name'])}`;
      const index = calls.filter((c) => `${String(c['owner'])}/${String(c['name'])}` === key).length - 1;
      const page = pages[key]?.[index];
      if (page === undefined) throw new Error(`no page ${index} for ${key}`);
      if ('throws' in page) throw new Error(page.throws);
      if ('error' in page) return { data: { repository: null } as T, errors: [page.error] };
      const data: OverviewData = {
        repository: {
          url: `https://github.com/${key}`,
          defaultBranchRef: page.noBranch ? null : { name: 'main', target: page.commit === undefined ? COMMIT : page.commit },
          pullRequests: {
            totalCount: page.total ?? page.prs.length,
            pageInfo: { hasNextPage: page.next !== undefined, endCursor: page.next ?? null },
            nodes: page.prs,
          },
        },
      };
      return { data: data as T, errors: [] };
    },
  };
  return { client, calls };
}

const API = { owner: 'acme', name: 'api' };
const WEB = { owner: 'acme', name: 'web' };

test('fetchRepoRow counts open PRs across pages, excluding drafts and reviewed PRs from awaiting review', async () => {
  const { client } = fakeClient({
    'acme/api': [
      {
        total: 5,
        next: 'c1',
        prs: [
          pr({ createdAt: '2026-01-01T00:00:00Z', reviewDecision: 'REVIEW_REQUIRED' }),
          pr({ isDraft: true, reviewDecision: 'REVIEW_REQUIRED' }),
          // No required review and nobody has reviewed it yet.
          pr(),
        ],
      },
      {
        total: 5,
        prs: [
          // No required review, but someone has reviewed it.
          pr({ reviews: { totalCount: 2 } }),
          pr({ reviewDecision: 'APPROVED', reviews: { totalCount: 1 } }),
        ],
      },
    ],
  });
  const { row, errors } = await fetchRepoRow(client, API);
  assert.deepStrictEqual(errors, []);
  const { items, ...summary } = row.prs ?? { items: [] };
  assert.deepStrictEqual(summary, {
    open: 5,
    drafts: 1,
    awaitingReview: 2,
    oldestOpenedAt: '2026-01-01T00:00:00Z',
    url: 'https://github.com/acme/api/pulls',
  });
  assert.strictEqual(items.length, 5);
});

test('fetchRepoRow returns each open PR as the dashboard\'s record, naming its author', async () => {
  const { client } = fakeClient({ 'acme/api': [{ prs: [pr({ number: 7 }), pr({ number: 8, author: null })] }] });
  const items = (await fetchRepoRow(client, API)).row.prs?.items ?? [];
  assert.deepStrictEqual(
    items.map((i) => [i.id, i.author]),
    [
      ['acme/api#7', 'teammate'],
      // A deleted account leaves no login; GitHub shows these as "ghost".
      ['acme/api#8', 'ghost'],
    ],
  );
});

test('fetchRepoRow maps the default branch head, falling back to no checks and the author name, and an empty repository to no branch', async () => {
  const { client } = fakeClient({
    'acme/api': [{ prs: [] }],
    'acme/web': [{ prs: [], commit: { ...COMMIT, statusCheckRollup: null, author: { name: 'Bot', user: null } } }],
    'acme/empty': [{ prs: [], noBranch: true }],
  });
  assert.deepStrictEqual((await fetchRepoRow(client, API)).row.branch, {
    name: 'main',
    ci: 'success',
    commitUrl: COMMIT.url,
    headline: 'Fix the thing',
    committedAt: COMMIT.committedDate,
    author: 'aperson',
  });
  const web = (await fetchRepoRow(client, WEB)).row.branch;
  assert.strictEqual(web?.ci, 'none');
  assert.strictEqual(web?.author, 'Bot');
  const empty = (await fetchRepoRow(client, { owner: 'acme', name: 'empty' })).row;
  assert.strictEqual(empty.branch, null);
  assert.strictEqual(empty.prs?.oldestOpenedAt, null);
});

test('fetchRepoRow throws with GitHub\'s reason when the repository answers nothing, and reports a later page that fails', async () => {
  const { client } = fakeClient({
    'acme/api': [{ error: 'Could not resolve to a Repository' }],
    'acme/web': [{ prs: [pr()], total: 2, next: 'c1' }, { error: 'timeout' }],
  });
  await assert.rejects(fetchRepoRow(client, API), /Could not resolve to a Repository/);
  const { row, errors } = await fetchRepoRow(client, WEB);
  assert.strictEqual(row.prs?.open, 2);
  assert.deepStrictEqual(errors, ['PR counts stop after page 1: timeout']);
});

test('one repository failing becomes an error row, and the load fails only when every repository does', async () => {
  const { client } = fakeClient({ 'acme/api': [{ prs: [] }], 'acme/web': [{ throws: 'Resource not accessible by integration' }] });
  const first = await createRepoLoader(client, [API, WEB], createCache<RepoLoadResult>(-1))();
  assert.deepStrictEqual(
    first.rows.map((r) => [r.repo, r.error]),
    [['acme/api', null], ['acme/web', 'Resource not accessible by integration']],
  );
  assert.strictEqual(first.rows[1]?.prs, null);

  const down = fakeClient({ 'acme/api': [{ throws: 'GitHub returned 502' }], 'acme/web': [{ throws: 'GitHub returned 502' }] });
  await assert.rejects(createRepoLoader(down.client, [API, WEB], createCache<RepoLoadResult>(-1))(), /GitHub returned 502/);
});

async function withRepoServer(loadRepos: LoadRepos, fn: (base: string) => Promise<void>) {
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const addr = probe.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  await new Promise<void>((r) => probe.close(() => r()));
  const server = createServer({
    host: `127.0.0.1:${addr.port}`,
    workOrgs: [],
    loadPrs: async () => ({ prs: [], fetchedAt: '' }),
    loadRepos,
  });
  await new Promise<void>((r) => server.listen(addr.port, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('/api/repos serves the loader result, passing only refresh=1 through as force', async () => {
  const forces: (boolean | undefined)[] = [];
  const loadRepos: LoadRepos = async (opts) => {
    forces.push(opts?.force);
    return { rows: [], fetchedAt: 'T', partialErrors: ['x'], stale: false };
  };
  await withRepoServer(loadRepos, async (base) => {
    const body = await (await fetch(`${base}/api/repos`)).json();
    assert.deepStrictEqual(body, { rows: [], fetchedAt: 'T', partialErrors: ['x'], stale: false, error: null });
    await fetch(`${base}/api/repos?refresh=1`);
    await fetch(`${base}/api/repos?refresh=true`);
  });
  assert.deepStrictEqual(forces, [false, true, false]);
});
