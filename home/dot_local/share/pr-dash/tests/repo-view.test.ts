import { test } from 'node:test';
import assert from 'node:assert';
import { parseReposBody, reposBanner, vulnStatus } from '../public/repo-view.js';
import type { RepoPr, RepoRow } from '../src/repos.ts';
import type { VulnAlert } from '../src/vulns.ts';

const PR: RepoPr = {
  id: 'acme/api#1',
  repo: 'acme/api',
  number: 1,
  title: 'Change a thing',
  url: 'https://github.com/acme/api/pull/1',
  headRef: 'change',
  baseRef: 'main',
  isDraft: false,
  ci: 'success',
  review: 'review_required',
  openedAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
  ageDays: 40,
  staleDays: 39,
  additions: 10,
  deletions: 2,
  defaultBranch: 'main',
  author: 'teammate',
};

const LOADED: RepoRow = {
  repo: 'acme/api',
  url: 'https://github.com/acme/api',
  branch: null,
  prs: {
    open: 1,
    drafts: 0,
    awaitingReview: 1,
    oldestOpenedAt: '2026-10-01T00:00:00Z',
    url: 'https://github.com/acme/api/pulls',
    items: [PR],
  },
  error: null,
};
const FAILED: RepoRow = { repo: 'acme/web', url: null, branch: null, prs: null, error: 'not found' };

function alert(repo: string, severity: VulnAlert['severity']): VulnAlert {
  return {
    repo,
    number: 1,
    url: `https://github.com/${repo}/security/dependabot/1`,
    severity,
    ecosystem: 'pip',
    packageName: 'requests',
    manifestPath: 'uv.lock',
    scope: 'runtime',
    summary: 's',
    ghsaId: 'GHSA-x',
    cveIds: [],
    advisoryUrl: 'https://github.com/advisories/GHSA-x',
    vulnerableRange: '< 2',
    patchedVersion: '2',
    createdAt: '2026-10-01T00:00:00Z',
  };
}

function vulns(overrides: Partial<Parameters<typeof vulnStatus>[1] & object> = {}) {
  return { alerts: [], repos: ['acme/api', 'acme/web'], fetchedAt: 'T', partialErrors: [], staleRepos: [], stale: false, error: null, ...overrides };
}

test('parseReposBody keeps loaded and failed rows, drops a row that is neither or carries a malformed PR, and rejects a malformed envelope', () => {
  const { author: _author, ...noAuthor } = PR;
  const badPr = { ...LOADED, prs: { ...LOADED.prs, items: [noAuthor] } };
  const body = { rows: [LOADED, FAILED, { ...FAILED, prs: LOADED.prs }, badPr], fetchedAt: 'T', partialErrors: [], stale: false, error: null };
  const parsed = parseReposBody(body);
  assert.deepStrictEqual(parsed.rows, [LOADED, FAILED]);
  assert.deepStrictEqual(parsed.partialErrors, ['2 malformed repositories are not shown']);
  assert.throws(() => parseReposBody({ ...body, rows: 'x' }), /expected shape/);
});

test('vulnStatus never reports an unknown count as zero', () => {
  const zero = { critical: 0, high: 0, moderate: 0, low: 0 };
  assert.deepStrictEqual(vulnStatus('acme/api', null), { counts: null, caveat: 'unavailable' });
  assert.deepStrictEqual(vulnStatus('acme/other', vulns()), { counts: null, caveat: 'unavailable' });
  assert.deepStrictEqual(
    vulnStatus('acme/web', vulns({ partialErrors: ['acme/web: Resource not accessible by integration'] })),
    { counts: null, caveat: 'unavailable' },
  );
  assert.deepStrictEqual(vulnStatus('acme/web', vulns({ alerts: [alert('acme/api', 'high')] })), { counts: zero, caveat: null });
});

test('vulnStatus counts by severity and marks retained or partial counts', () => {
  const alerts = [alert('acme/api', 'high'), alert('acme/api', 'high'), alert('acme/api', 'low')];
  const counts = { critical: 0, high: 2, moderate: 0, low: 1 };
  assert.deepStrictEqual(vulnStatus('acme/api', vulns({ alerts, staleRepos: ['acme/api'] })), { counts, caveat: 'out of date' });
  assert.deepStrictEqual(vulnStatus('acme/api', vulns({ alerts, stale: true })), { counts, caveat: 'out of date' });
  assert.deepStrictEqual(
    vulnStatus('acme/api', vulns({ alerts, partialErrors: ['acme/api: listed 2 of 3 open alerts'] })),
    { counts, caveat: 'incomplete' },
  );
});

test('reposBanner names a failed refresh, incomplete counts and unavailable vulns, or returns null', () => {
  const ok = { stale: false, error: null, partialErrors: [], fetchedAt: 'T' };
  assert.strictEqual(reposBanner(ok, null), null);
  assert.strictEqual(
    reposBanner({ ...ok, stale: true, error: '502', partialErrors: ['acme/api: timeout'] }, 'no token'),
    'Showing repositories fetched T; the refresh failed: 502. Some counts are incomplete: acme/api: timeout ' +
      'Vulnerability counts are unavailable: no token',
  );
});
