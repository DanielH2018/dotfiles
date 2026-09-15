import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LoadResult } from './loader.ts';

/** Owner-only. Set explicitly: this machine's login shell umask would give 0640. */
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
 * The four filesystem calls this module makes. Injected so a test asserts the atomic
 * write and the modes without writing to the operator's real state directory.
 */
export type FsSeam = {
  mkdir(path: string, opts: { recursive: true; mode: number }): Promise<unknown>;
  writeFile(path: string, data: string, opts: { mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readFile(path: string): Promise<string>;
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
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Deliberately shallower than the browser's validateRecord, and deliberately not shared
// with it: that validator lives in public/render-guards.js, which src/ must not import —
// the import-convention guard bans relative .js imports outside public/, and the browser
// and the server are separate module graphs on purpose.
//
// This check only has to be good enough not to hand something structurally broken
// downstream. A restored payload travels the same /api/prs response path as a fetched
// one, so a record with a subtly wrong field still meets validateRecord in the browser
// and produces its existing, diagnosable error banner rather than a crash.
//
// The narrowing to `value is LoadResult` is therefore unsound on purpose: it checks the
// shape of the envelope and that each element of `prs` is at least an object, not that
// every PrRecord field is present and correctly typed. That gap is deliberate — see above.
function looksLikePayload(value: unknown): value is LoadResult {
  if (!isRecord(value)) return false;
  const prs = value['prs'];
  const fetchedAt = value['fetchedAt'];
  const partialErrors = value['partialErrors'];
  if (!Array.isArray(prs) || !prs.every(isRecord)) return false;
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
        // Rename rather than writing the target in place, so a kill mid-write cannot
        // leave truncated JSON for the next launch to reject.
        await fs.rename(temp, target);
      } catch {
        // A full disk or an unwritable directory must not turn a successful fetch into a
        // failed request. The next launch simply starts cold.
      }
    },
  };
}
