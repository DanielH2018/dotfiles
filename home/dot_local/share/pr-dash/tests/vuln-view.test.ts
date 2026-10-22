import { test } from 'node:test';
import assert from 'node:assert';
import {
  filterAlerts,
  groupAlerts,
  parseVulnsBody,
  sortAlerts,
  vulnsBanner,
} from '../public/vuln-view.js';
import type { Severity, VulnAlert } from '../src/vulns.ts';

function alert(repo: string, number: number, severity: Severity, createdAt: string, extra: Partial<VulnAlert> = {}): VulnAlert {
  return {
    repo,
    number,
    url: `https://github.com/${repo}/security/dependabot/${number}`,
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
    createdAt,
    ...extra,
  };
}

const OLD_LOW = alert('acme/api', 1, 'low', '2026-01-01T00:00:00Z');
const NEW_HIGH = alert('acme/api', 2, 'high', '2026-09-01T00:00:00Z');
const OLD_HIGH = alert('acme/web', 3, 'high', '2026-02-01T00:00:00Z', { patchedVersion: null, scope: 'development' });
const CRITICAL = alert('acme/web', 4, 'critical', '2026-10-01T00:00:00Z', { packageName: 'urllib3' });

test('parseVulnsBody drops a malformed alert and says so, and rejects a malformed envelope', () => {
  const body = {
    alerts: [OLD_LOW, { ...NEW_HIGH, severity: 'urgent' }],
    repos: ['acme/api'],
    fetchedAt: 'T',
    partialErrors: [],
    staleRepos: [],
    stale: false,
    error: null,
  };
  const parsed = parseVulnsBody(body);
  assert.deepStrictEqual(parsed.alerts, [OLD_LOW]);
  assert.deepStrictEqual(parsed.partialErrors, ['1 alert(s) were malformed and are not shown']);
  assert.throws(() => parseVulnsBody({ ...body, repos: 'acme/api' }), /expected shape/);
});

test('filterAlerts ORs within a filter, ANDs across filters, and treats an empty filter as off', () => {
  const all = [OLD_LOW, NEW_HIGH, OLD_HIGH, CRITICAL];
  assert.strictEqual(filterAlerts(all, { severities: [], scopes: [], fixes: [] }).length, 4);
  assert.deepStrictEqual(
    filterAlerts(all, { severities: ['high', 'critical'], scopes: [], fixes: ['unpatched'] }),
    [OLD_HIGH],
  );
  assert.deepStrictEqual(filterAlerts(all, { severities: [], scopes: ['development'], fixes: [] }), [OLD_HIGH]);
});

test('sortAlerts by severity puts the worst first and the oldest first within a level', () => {
  assert.deepStrictEqual(
    sortAlerts([OLD_LOW, NEW_HIGH, CRITICAL, OLD_HIGH], 'severity').map((a) => a.number),
    [4, 3, 2, 1],
  );
});

test('groupAlerts ranks repositories by their worst alert, and severity groups run worst first', () => {
  const all = [OLD_LOW, NEW_HIGH, OLD_HIGH, CRITICAL];
  assert.deepStrictEqual(groupAlerts(all, 'repo').map((g) => g.key), ['acme/web', 'acme/api']);
  assert.deepStrictEqual(groupAlerts(all, 'severity').map((g) => g.key), ['critical', 'high', 'low']);
  // urllib3 sorts after requests alphabetically, so it leading proves the worst-first rank.
  assert.deepStrictEqual(groupAlerts(all, 'package').map((g) => g.label), ['urllib3 (pip)', 'requests (pip)']);
});

test('vulnsBanner names a failed refresh and the missing repositories, and is null for a clean answer', () => {
  assert.strictEqual(vulnsBanner({ stale: false, error: null, partialErrors: [], fetchedAt: 'T' }), null);
  const message = vulnsBanner({ stale: true, error: 'GitHub returned 502', partialErrors: ['acme/web: denied'], fetchedAt: 'T' });
  assert.match(message ?? '', /refresh failed: GitHub returned 502/);
  assert.match(message ?? '', /acme\/web: denied/);
});
