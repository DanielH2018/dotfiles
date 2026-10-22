import { test } from 'node:test';
import assert from 'node:assert';
import { createServer as createNetServer } from 'node:net';
import type { Client, QueryResult } from '../src/github.ts';
import { createCache } from '../src/cache.ts';
import { createServer } from '../src/server.ts';
import type { Baseline } from '../src/vuln-baseline.ts';
import {
  createVulnLoader,
  fetchRepoAlerts,
  parseVulnRepos,
  type LoadVulns,
  type RawAlert,
  type VulnLoadResult,
} from '../src/vulns.ts';

function rawAlert(number: number, overrides: Partial<RawAlert> = {}): RawAlert {
  return {
    number,
    createdAt: '2026-10-01T00:00:00Z',
    vulnerableManifestPath: 'uv.lock',
    dependencyScope: 'RUNTIME',
    securityAdvisory: {
      ghsaId: `GHSA-${number}`,
      summary: `advisory ${number}`,
      permalink: `https://github.com/advisories/GHSA-${number}`,
      identifiers: [
        { type: 'GHSA', value: `GHSA-${number}` },
        { type: 'CVE', value: `CVE-2026-${number}` },
      ],
    },
    securityVulnerability: {
      severity: 'HIGH',
      vulnerableVersionRange: '< 2.0',
      firstPatchedVersion: { identifier: '2.0' },
      package: { ecosystem: 'PIP', name: 'requests' },
    },
    ...overrides,
  };
}

type Page =
  | { nodes: (RawAlert | null)[]; next?: string; total?: number }
  | { error: string }
  | { throws: string };

// A Client that answers each repository from a list of pages, keyed by `owner/name`, and
// records every request so a test can count them. A page's totalCount defaults to its own
// node count, which is right for a single-page answer; a multi-page answer sets `total`.
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
      if ('error' in page) {
        return { data: { repository: { url: `https://github.com/${key}`, vulnerabilityAlerts: null } } as T, errors: [page.error] };
      }
      const pageInfo = { hasNextPage: page.next !== undefined, endCursor: page.next ?? null };
      const totalCount = page.total ?? page.nodes.length;
      return {
        data: { repository: { url: `https://github.com/${key}`, vulnerabilityAlerts: { totalCount, pageInfo, nodes: page.nodes } } } as T,
        errors: [],
      };
    },
  };
  return { client, calls };
}

const API = { owner: 'acme', name: 'api' };
const WEB = { owner: 'acme', name: 'web' };

test('an unset or empty PR_DASH_VULN_REPOS configures no repositories', () => {
  assert.deepStrictEqual(parseVulnRepos(undefined), { ok: true, repos: [] });
  assert.deepStrictEqual(parseVulnRepos(' , '), { ok: true, repos: [] });
});

test('PR_DASH_VULN_REPOS is read as trimmed owner/name pairs', () => {
  assert.deepStrictEqual(parseVulnRepos('acme/api, acme/web.site '), {
    ok: true,
    repos: [API, { owner: 'acme', name: 'web.site' }],
  });
});

test('a malformed PR_DASH_VULN_REPOS entry rejects the whole value, naming the entry', () => {
  for (const bad of ['api', 'acme/web/extra', '"acme"/x']) {
    const parsed = parseVulnRepos(`acme/api,${bad}`);
    assert.strictEqual(parsed.ok, false, bad);
    if (!parsed.ok) assert.ok(parsed.reason.includes(`PR_DASH_VULN_REPOS`) && parsed.reason.includes(`"${bad}"`), parsed.reason);
  }
});

test('fetchRepoAlerts follows pagination and flattens each alert', async () => {
  const { client, calls } = fakeClient({
    'acme/api': [{ nodes: [rawAlert(1)], next: 'c1', total: 2 }, { nodes: [rawAlert(2)] }],
  });
  const { alerts, errors } = await fetchRepoAlerts(client, API);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(calls.map((c) => c['cursor']), [null, 'c1']);
  assert.deepStrictEqual(alerts[0], {
    repo: 'acme/api',
    number: 1,
    url: 'https://github.com/acme/api/security/dependabot/1',
    severity: 'high',
    ecosystem: 'pip',
    packageName: 'requests',
    manifestPath: 'uv.lock',
    scope: 'runtime',
    summary: 'advisory 1',
    ghsaId: 'GHSA-1',
    cveIds: ['CVE-2026-1'],
    advisoryUrl: 'https://github.com/advisories/GHSA-1',
    vulnerableRange: '< 2.0',
    patchedVersion: '2.0',
    createdAt: '2026-10-01T00:00:00Z',
  });
  assert.strictEqual(alerts[1]?.number, 2);
});

test('fetchRepoAlerts reports a list that stops short of the totalCount GitHub gave', async () => {
  // The 2026-10-22 shape: one page, hasNextPage false, no error, 100 of 243 alerts.
  const { client } = fakeClient({ 'acme/api': [{ nodes: [rawAlert(1), rawAlert(2)], total: 3 }] });
  const { alerts, errors } = await fetchRepoAlerts(client, API);
  assert.deepStrictEqual(alerts.map((a) => a.number), [1, 2]);
  assert.deepStrictEqual(errors, ['GitHub reported 3 open alerts but returned 2']);
});

test('fetchRepoAlerts throws when the repository answers no alert data, carrying GitHub\'s reason', async () => {
  const { client } = fakeClient({ 'acme/api': [{ error: 'Resource not accessible by integration' }] });
  await assert.rejects(fetchRepoAlerts(client, API), /Resource not accessible by integration/);
});

test('fetchRepoAlerts keeps the rows it can place and reports the ones without advisory details', async () => {
  const { client } = fakeClient({
    'acme/api': [{ nodes: [rawAlert(1), rawAlert(2, { securityAdvisory: null }), null] }],
  });
  const { alerts, errors } = await fetchRepoAlerts(client, API);
  assert.deepStrictEqual(alerts.map((a) => a.number), [1]);
  assert.deepStrictEqual(errors, ['2 alert(s) arrived without advisory details']);
});

test('one repository failing costs only that repository, named in partialErrors', async () => {
  const { client } = fakeClient({
    'acme/api': [{ nodes: [rawAlert(1)] }],
    'acme/web': [{ error: 'Resource not accessible by integration' }],
  });
  const load = createVulnLoader(client, [API, WEB], createCache<VulnLoadResult>(60_000));
  const result = await load();
  assert.deepStrictEqual(result.alerts.map((a) => a.repo), ['acme/api']);
  assert.deepStrictEqual(result.repos, ['acme/api', 'acme/web']);
  assert.deepStrictEqual(result.partialErrors, ['acme/web: Resource not accessible by integration']);
  assert.strictEqual(result.stale, false);
});

test('every repository failing serves the last good result marked stale, or rejects with nothing to fall back on', async () => {
  let failing = false;
  const client: Client = {
    async query<T>(): Promise<QueryResult<T>> {
      if (failing) throw new Error('GitHub returned 502');
      return {
        data: { repository: { url: 'https://github.com/acme/api', vulnerabilityAlerts: { pageInfo: null, nodes: [rawAlert(1)] } } } as T,
        errors: [],
      };
    },
  };
  // A negative TTL never hits: a TTL of 0 still hits within the same millisecond.
  const noCache = () => createCache<VulnLoadResult>(-1);
  failing = true;
  const cold = createVulnLoader(client, [API], noCache());
  await assert.rejects(cold(), /GitHub returned 502/);

  failing = false;
  const load = createVulnLoader(client, [API, WEB], noCache());
  await load();
  failing = true;
  const result = await load();
  assert.strictEqual(result.stale, true);
  assert.strictEqual(result.error, 'GitHub returned 502');
  assert.strictEqual(result.alerts.length, 2);
});

test('a repository suddenly listed with no alerts keeps its previous alerts until that holds for an hour', async () => {
  // The 2026-10-22 GitHub incident: an empty listing, no error, for alerts still open.
  let clock = Date.parse('2026-10-22T15:00:00Z');
  const { client } = fakeClient({
    'acme/api': [{ nodes: [rawAlert(1), rawAlert(2)] }, { nodes: [] }, { nodes: [] }, { nodes: [] }],
    'acme/web': [{ nodes: [] }, { nodes: [] }, { nodes: [] }, { nodes: [] }],
  });
  const load = createVulnLoader(client, [API, WEB], createCache<VulnLoadResult>(-1), { now: () => clock });

  await load();
  clock += 5 * 60 * 1000;
  const retained = await load();
  assert.deepStrictEqual(retained.alerts.map((a) => a.number), [1, 2]);
  assert.deepStrictEqual(retained.staleRepos, ['acme/api']);
  assert.match(retained.partialErrors[0] ?? '', /^acme\/api: GitHub listed no open alerts, down from 2; showing the alerts fetched 2026-10-22T15:00:00\.000Z/);

  // One millisecond short of an hour after the first empty answer: still retained.
  clock += 60 * 60 * 1000 - 1;
  assert.deepStrictEqual((await load()).staleRepos, ['acme/api']);

  // A repository that never had alerts is not held back; one whose empty answer has held for
  // the full hour is accepted as clean.
  clock += 1;
  const accepted = await load();
  assert.deepStrictEqual([accepted.alerts, accepted.staleRepos, accepted.partialErrors], [[], [], []]);
});

test('the zero-drop guard keeps its alerts and its clock across a restart', async () => {
  // The 2026-10-22 gap: a restart mid-outage, then an empty first answer, showed 45 alerts as 0.
  let clock = Date.parse('2026-10-22T16:00:00Z');
  const now = () => clock;
  let persisted: Baseline | undefined;
  const save = (b: Baseline) => {
    persisted = b;
  };

  // Before the restart: one good answer, then GitHub starts listing the repository as empty.
  const before = fakeClient({ 'acme/api': [{ nodes: [rawAlert(1), rawAlert(2)] }, { nodes: [] }] });
  const first = createVulnLoader(before.client, [API], createCache<VulnLoadResult>(-1), { now, onBaselineChange: save });
  await first();
  clock += 5 * 60 * 1000;
  await first();

  // After the restart, a fresh loader seeded from what was saved: still retained.
  clock += 5 * 60 * 1000;
  const after = fakeClient({ 'acme/api': [{ nodes: [] }, { nodes: [] }] });
  const second = createVulnLoader(after.client, [API], createCache<VulnLoadResult>(-1), {
    now,
    initialBaseline: persisted,
    onBaselineChange: save,
  });
  const retained = await second();
  assert.deepStrictEqual(retained.alerts.map((a) => a.number), [1, 2]);
  assert.deepStrictEqual(retained.staleRepos, ['acme/api']);

  // The hour counts from the first empty answer before the restart (16:05), not from 16:10.
  clock = Date.parse('2026-10-22T17:05:00Z');
  const accepted = await second();
  assert.deepStrictEqual([accepted.alerts, accepted.staleRepos], [[], []]);
  assert.deepStrictEqual(persisted, {});
});

test('a load inside the cache TTL does not query GitHub again, and a forced one does', async () => {
  const { client, calls } = fakeClient({ 'acme/api': [{ nodes: [] }, { nodes: [] }] });
  const load = createVulnLoader(client, [API], createCache<VulnLoadResult>(60_000));
  await load();
  await load();
  assert.strictEqual(calls.length, 1);
  await load({ force: true });
  assert.strictEqual(calls.length, 2);
});

async function withVulnServer(loadVulns: LoadVulns, fn: (base: string) => Promise<void>) {
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const addr = probe.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  await new Promise<void>((r) => probe.close(() => r()));
  const server = createServer({
    host: `127.0.0.1:${addr.port}`,
    workOrgs: [],
    loadPrs: async () => ({ prs: [], fetchedAt: '' }),
    loadVulns,
  });
  await new Promise<void>((r) => server.listen(addr.port, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('/api/vulns serves the loader result, passing only refresh=1 through as force', async () => {
  const forces: (boolean | undefined)[] = [];
  const loadVulns: LoadVulns = async (opts) => {
    forces.push(opts?.force);
    return { alerts: [], repos: ['acme/api'], fetchedAt: 'T', partialErrors: ['x'], staleRepos: ['acme/api'], stale: false };
  };
  await withVulnServer(loadVulns, async (base) => {
    const body = await (await fetch(`${base}/api/vulns`)).json();
    assert.deepStrictEqual(body, {
      alerts: [],
      repos: ['acme/api'],
      fetchedAt: 'T',
      partialErrors: ['x'],
      staleRepos: ['acme/api'],
      stale: false,
      error: null,
    });
    await fetch(`${base}/api/vulns?refresh=1`);
    await fetch(`${base}/api/vulns?refresh=true`);
  });
  assert.deepStrictEqual(forces, [false, true, false]);
});
