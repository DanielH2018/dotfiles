import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createCache } from './cache.ts';

// pr-dash reads Planka through the operator's `planka` CLI and holds no Planka credential
// of its own: the CLI signs in from the login keychain and keeps its own token cache. The
// CLI is not part of this repo, so every way it can be missing or misconfigured answers as
// an `{ error }` body rather than a crash.
//
// Spawned by absolute path, never by bare name: the launchd agent's PATH is
// /usr/bin:/bin:/usr/sbin:/sbin plus Homebrew, which does not include ~/.local/bin, so a
// bare `planka` would work in a terminal and fail with ENOENT under launchd.
export const PLANKA_BIN = join(homedir(), '.local', 'bin', 'planka');

const TIMEOUT_MS = 10_000;
// A full board body is tens of kilobytes; Node's 1 MiB default would truncate a large
// board into an unparseable answer.
const MAX_BUFFER = 16 * 1024 * 1024;

// How long one board answer is reused. Every new tab asks, and each ask spawns Python
// twice, so a burst of tabs shares one read. The extension keeps its own 60-second cache
// on top of this.
const CACHE_TTL_MS = 30_000;

/** Runs the planka CLI with `args`; rejects on ENOENT, a non-zero exit or the timeout. */
export type RunPlanka = (args: string[]) => Promise<{ stdout: string }>;

/**
 * The trimmed board `/api/planka` serves. `included.lists` and `included.cards` keep the
 * names and fields Planka's own `GET /api/boards/:id` uses, so the extension's
 * `activeCards` reads either body. Everything else Planka returns — card descriptions,
 * users, custom field values — is dropped, since the panel shows none of it.
 */
export type PlankaBoard = {
  boardId: string;
  boardName: string;
  included: {
    lists: { id: string; name: string }[];
    cards: { id: string; name: string; listId: string; position: number; listChangedAt: string | null }[];
  };
};

/** One `/api/planka` answer: the trimmed board, or the reason it could not be read. */
export type PlankaResult = { board: PlankaBoard; error?: undefined } | { board?: undefined; error: string };

function defaultRunPlanka(args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(PLANKA_BIN, args, { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }));
      else resolve({ stdout: String(stdout) });
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// The CLI reports its own failures on stderr under --strict, as `planka: <reason>`, and
// that line is the most useful thing to hand the operator. ENOENT means the CLI is not
// installed on this machine, which is the normal state outside the work laptop.
function failureMessage(err: unknown, what: string): string {
  if (isRecord(err) && err['code'] === 'ENOENT') {
    return `the planka CLI is not installed at ${PLANKA_BIN}`;
  }
  if (isRecord(err) && err['killed'] === true) {
    return `planka ${what} did not finish within ${TIMEOUT_MS / 1000}s`;
  }
  const stderr = isRecord(err) && typeof err['stderr'] === 'string' ? err['stderr'].trim() : '';
  return stderr !== '' ? stderr : `planka ${what} failed`;
}

// `planka --strict board show` prints `board\t<id>\t<name>` first when the CLI's config
// names a board. --strict is required: without it the CLI exits 0 with empty output both
// when it has no config and when Planka is down, and the two would be indistinguishable.
function parseBoardId(stdout: string): string | undefined {
  const first = stdout.split('\n')[0] ?? '';
  const [kind, id] = first.split('\t');
  return kind === 'board' && id !== undefined && /^\d+$/.test(id) ? id : undefined;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function trimBoard(raw: unknown, boardId: string): PlankaBoard | undefined {
  if (!isRecord(raw) || !isRecord(raw['included'])) return undefined;
  const included = raw['included'];
  const lists = Array.isArray(included['lists']) ? included['lists'] : [];
  const cards = Array.isArray(included['cards']) ? included['cards'] : [];
  const item = isRecord(raw['item']) ? raw['item'] : {};
  return {
    boardId,
    boardName: typeof item['name'] === 'string' ? item['name'] : '',
    included: {
      // Planka's archive and trash lists carry a null name, which String() would turn into
      // the text "null".
      lists: lists.filter(isRecord).map((l) => ({ id: String(l['id']), name: str(l['name']) })),
      cards: cards.filter(isRecord).map((c) => ({
        id: String(c['id']),
        name: str(c['name']),
        listId: String(c['listId']),
        position: typeof c['position'] === 'number' ? c['position'] : 0,
        listChangedAt: typeof c['listChangedAt'] === 'string' ? c['listChangedAt'] : null,
      })),
    },
  };
}

/**
 * Returns the loader behind `GET /api/planka`. It takes no argument from the request: the
 * board is whichever one the CLI's own config names, so nothing a caller sends reaches the
 * CLI's argv.
 *
 * The board ID is looked up once and kept, so a warm request costs one spawn. A failure
 * is never cached, so the next request retries.
 */
export function createLoadPlanka(run: RunPlanka = defaultRunPlanka): () => Promise<PlankaResult> {
  const cache = createCache<PlankaBoard>(CACHE_TTL_MS);
  let boardId: string | undefined;
  let inFlight: Promise<PlankaResult> | undefined;

  async function load(): Promise<PlankaResult> {
    if (boardId === undefined) {
      let stdout: string;
      try {
        ({ stdout } = await run(['--strict', 'board', 'show']));
      } catch (err) {
        return { error: failureMessage(err, 'board show') };
      }
      boardId = parseBoardId(stdout);
      if (boardId === undefined) return { error: 'the planka CLI config names no board (boardId)' };
    }
    let stdout: string;
    try {
      ({ stdout } = await run(['--strict', 'api', 'GET', `/boards/${boardId}`]));
    } catch (err) {
      return { error: failureMessage(err, 'api') };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { error: 'planka api printed something that is not JSON' };
    }
    const board = trimBoard(parsed, boardId);
    if (board === undefined) return { error: 'planka api returned a body with no included lists or cards' };
    cache.set(board);
    return { board };
  }

  return () => {
    const cached = cache.get();
    if (cached !== undefined) return Promise.resolve({ board: cached });
    inFlight ??= load().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
