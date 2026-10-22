import { test } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_MODE } from '../src/payload-store.ts';
import { createBaselineStore, type Baseline } from '../src/vuln-baseline.ts';
import type { VulnAlert } from '../src/vulns.ts';

function alert(repo: string, number: number): VulnAlert {
  return {
    repo,
    number,
    url: `https://github.com/${repo}/security/dependabot/${number}`,
    severity: 'high',
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

function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pr-dash-baseline-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('a written baseline reads back owner-only, keeping only repositories still configured', async () => {
  await withDir(async (dir) => {
    const baseline: Baseline = {
      'acme/api': { alerts: [alert('acme/api', 1)], fetchedAt: '2026-10-22T15:00:00.000Z', emptySince: 1_700_000_000_000 },
      'acme/gone': { alerts: [alert('acme/gone', 2)], fetchedAt: '2026-10-22T15:00:00.000Z' },
    };
    const store = createBaselineStore(dir);
    await store.write(baseline);
    assert.strictEqual(statSync(join(dir, 'vuln-baseline.json')).mode & 0o777, FILE_MODE);
    assert.deepStrictEqual(await store.read(['acme/api', 'acme/web']), { 'acme/api': baseline['acme/api'] });
  });
});

test('a missing or unparseable file reads as empty, and a malformed entry is dropped on its own', async () => {
  await withDir(async (dir) => {
    const store = createBaselineStore(dir);
    assert.deepStrictEqual(await store.read(['acme/api']), {});

    writeFileSync(join(dir, 'vuln-baseline.json'), '{"acme/api":');
    assert.deepStrictEqual(await store.read(['acme/api']), {});

    // One good entry; one whose alert claims another repository; one with a string emptySince.
    const good = { alerts: [alert('acme/api', 1)], fetchedAt: '2026-10-22T15:00:00.000Z' };
    writeFileSync(
      join(dir, 'vuln-baseline.json'),
      JSON.stringify({
        'acme/api': good,
        'acme/web': { alerts: [alert('acme/api', 2)], fetchedAt: '2026-10-22T15:00:00.000Z' },
        'acme/docs': { ...good, alerts: [alert('acme/docs', 3)], emptySince: 'soon' },
      }),
    );
    assert.deepStrictEqual(await store.read(['acme/api', 'acme/web', 'acme/docs']), { 'acme/api': good });
  });
});
