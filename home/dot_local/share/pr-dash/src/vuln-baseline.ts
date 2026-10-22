import { join } from 'node:path';
import { realFs, writeFileAtomically, type FsSeam } from './payload-store.ts';
import type { VulnAlert } from './vulns.ts';

// The zero-drop guard's memory, kept on disk so it survives a restart. On 2026-10-22 the
// agent restarted mid-outage and its first fetch listed a repository with 45 open alerts as
// empty; with the in-memory baseline gone, the page showed that repository as clean.

const FILE_NAME = 'vuln-baseline.json';

/** What the guard remembers about one repository. */
export type BaselineEntry = {
  /** The last non-empty alert list GitHub returned. */
  alerts: VulnAlert[];
  /** When that list was fetched, ISO 8601. */
  fetchedAt: string;
  /**
   * Epoch milliseconds of the first empty answer since then, if GitHub is answering empty
   * now. Persisted so a restart does not restart the hour the guard waits.
   */
  emptySince?: number;
};

/** The baseline for every repository that has one, keyed by `owner/name`. */
export type Baseline = Record<string, BaselineEntry>;

export type BaselineStore = {
  /**
   * The stored baseline, restricted to `repos`. A missing, unreadable or malformed file
   * reads as empty, and any entry that fails the shape check is dropped on its own.
   */
  read(repos: readonly string[]): Promise<Baseline>;
  /** Replaces the stored baseline. Never rejects; see `writeFileAtomically`. */
  write(baseline: Baseline): Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SEVERITIES: ReadonlySet<unknown> = new Set(['critical', 'high', 'moderate', 'low']);

// Checks the fields the page renders and sorts on, so a hand-edited or truncated file cannot
// put a row on the page that the client's own validator would then reject.
function looksLikeAlert(value: unknown, repo: string): value is VulnAlert {
  if (!isRecord(value)) return false;
  return (
    value['repo'] === repo &&
    typeof value['number'] === 'number' &&
    typeof value['url'] === 'string' &&
    SEVERITIES.has(value['severity']) &&
    typeof value['ecosystem'] === 'string' &&
    typeof value['packageName'] === 'string' &&
    typeof value['manifestPath'] === 'string' &&
    typeof value['summary'] === 'string' &&
    typeof value['ghsaId'] === 'string' &&
    Array.isArray(value['cveIds']) &&
    typeof value['advisoryUrl'] === 'string' &&
    typeof value['vulnerableRange'] === 'string' &&
    typeof value['createdAt'] === 'string'
  );
}

function entryOf(value: unknown, repo: string): BaselineEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { alerts, fetchedAt, emptySince } = value;
  if (!Array.isArray(alerts) || alerts.length === 0) return undefined;
  if (!alerts.every((a) => looksLikeAlert(a, repo))) return undefined;
  if (typeof fetchedAt !== 'string' || fetchedAt === '') return undefined;
  if (typeof emptySince === 'number') return { alerts, fetchedAt, emptySince };
  return emptySince === undefined ? { alerts, fetchedAt } : undefined;
}

/** A store for the guard's baseline in `dir`, beside the PR payload store's file. */
export function createBaselineStore(dir: string, fs: FsSeam = realFs): BaselineStore {
  return {
    async read(repos) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await fs.readFile(join(dir, FILE_NAME)));
      } catch {
        return {};
      }
      if (!isRecord(parsed)) return {};
      const baseline: Baseline = {};
      // Only repositories still configured: one removed from prDashVulnRepos must not
      // resurface from an old file.
      for (const repo of repos) {
        const entry = entryOf(parsed[repo], repo);
        if (entry !== undefined) baseline[repo] = entry;
      }
      return baseline;
    },
    async write(baseline) {
      await writeFileAtomically(fs, dir, FILE_NAME, JSON.stringify(baseline));
    },
  };
}
