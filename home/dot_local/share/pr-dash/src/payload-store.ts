import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LoadResult } from './loader.ts';

/** Owner-only. Set explicitly: this machine's login shell umask would give 0660. */
export const FILE_MODE = 0o600;
/** Owner-only. Same reason as {@link FILE_MODE}. */
export const DIR_MODE = 0o700;

const FILE_NAME = 'last-payload.json';

/**
 * Where the payload lives. Outside chezmoi's managed tree, so it can never reach the
 * source repository, and outside the deployed `pr-dash` directory so `chezmoi apply`
 * never removes it.
 */
export const DEFAULT_STATE_DIR = join(homedir(), '.local', 'state', 'pr-dash');

/**
 * The five filesystem calls this module makes. Injected so a test asserts the atomic
 * write and the modes without writing to the operator's real state directory.
 */
export type FsSeam = {
  mkdir(path: string, opts: { recursive: true; mode: number }): Promise<unknown>;
  writeFile(path: string, data: string, opts: { mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readFile(path: string): Promise<string>;
  unlink(path: string): Promise<void>;
};

export type PayloadStore = {
  /** The stored payload, or `undefined` for anything that is missing or unusable. */
  read(): Promise<LoadResult | undefined>;
  /** Persists `result`. Never rejects: a failure here must not fail the request. */
  write(result: LoadResult): Promise<void>;
};

const realFs: FsSeam = {
  mkdir: (path, opts) => mkdir(path, opts),
  writeFile: (path, data, opts) => writeFile(path, data, opts),
  rename: (from, to) => rename(from, to),
  readFile: (path) => readFile(path, 'utf8'),
  unlink: (path) => unlink(path),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Deliberately shallower than the browser's validateRecord, and deliberately not shared
// with it: that validator lives in public/render-guards.js, which src/ must not import —
// the import-convention guard bans relative .js imports outside public/, and the browser
// and the server are separate module graphs on purpose.
//
// This is not a full PrRecord validator. It checks exactly the fields src/stacks.ts reads
// before a restored payload is serialized: buildStacks sorts stack siblings with
// `a.repo.localeCompare(b.repo) || a.number - b.number`, and keys its parent/child lookups
// on `id`, `headRef` and `baseRef`. A bare `{}` passes a mere "is an object" check, and
// `undefined.localeCompare` then throws — a stored payload with two such records used to
// 500 the /api/prs endpoint (a single one didn't, because Array.prototype.sort never calls
// the comparator on one element). Checking these five fields is what stops that. Anything
// else wrong in a record (title, url, ci, ...) still reaches the browser's validateRecord,
// which is the second line of defence for the rest of PrRecord.
function looksLikeServerSafeRecord(value: Record<string, unknown>): boolean {
  return (
    typeof value['id'] === 'string' &&
    typeof value['repo'] === 'string' &&
    typeof value['headRef'] === 'string' &&
    typeof value['baseRef'] === 'string' &&
    typeof value['number'] === 'number'
  );
}

// The narrowing to `value is LoadResult` is unsound on purpose: it checks the shape of the
// envelope and the fields above, not that every PrRecord field is present and correctly
// typed. That gap is deliberate — see looksLikeServerSafeRecord.
function looksLikePayload(value: unknown): value is LoadResult {
  if (!isRecord(value)) return false;
  const prs = value['prs'];
  const fetchedAt = value['fetchedAt'];
  const partialErrors = value['partialErrors'];
  if (!Array.isArray(prs) || !prs.every((pr) => isRecord(pr) && looksLikeServerSafeRecord(pr))) {
    return false;
  }
  if (typeof fetchedAt !== 'string' || fetchedAt === '') return false;
  if (!Array.isArray(partialErrors)) return false;
  if (!partialErrors.every((e) => typeof e === 'string')) return false;
  return true;
}

/**
 * Persists the last good payload so the next launch can paint before GitHub answers.
 *
 * Reads tolerate every way the file can be wrong — absent, truncated, valid JSON of the
 * wrong shape, or written by an older version with a different schema — because the
 * stored value is whatever was there last and a successful parse does not make it the
 * right shape. Each of those cases starts cold instead of throwing, which is the same
 * discipline `parseStoredView` applies to `localStorage`.
 */
export function createPayloadStore(dir: string, fs: FsSeam = realFs): PayloadStore {
  const target = join(dir, FILE_NAME);

  return {
    async read(): Promise<LoadResult | undefined> {
      let raw: string;
      try {
        raw = await fs.readFile(target);
      } catch {
        return undefined;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return undefined;
      }
      if (!looksLikePayload(parsed)) return undefined;
      return { prs: parsed.prs, fetchedAt: parsed.fetchedAt, partialErrors: parsed.partialErrors };
    },

    async write(result: LoadResult): Promise<void> {
      // A unique temp name per write: writeFile's mode applies only when it creates the
      // file, so reusing one name would silently keep a crashed run's mode.
      const temp = `${target}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
        await fs.writeFile(temp, JSON.stringify(result), { mode: FILE_MODE });
        try {
          // Rename rather than writing the target in place, so a kill mid-write cannot
          // leave truncated JSON for the next launch to reject.
          await fs.rename(temp, target);
        } catch (err) {
          // The temp file survived the write but failed to land (EXDEV, a full directory
          // entry table, ...). Remove it so a directory that keeps failing to rename does
          // not accumulate an unbounded number of full payload copies. A hard kill right
          // here still orphans one temp file, which is an acceptable one-time leak.
          try {
            await fs.unlink(temp);
          } catch {
            // Best effort — the outer catch below already treats this write as failed.
          }
          throw err;
        }
      } catch {
        // A full disk or an unwritable directory must not turn a successful fetch into a
        // failed request. The next launch simply starts cold.
      }
    },
  };
}
