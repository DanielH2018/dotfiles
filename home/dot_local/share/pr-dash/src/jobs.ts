import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { createCliLoader, type RunCli } from './cli-loader.ts';

// pr-dash reads the launchd jobs' status through the operator's `jobstat --json`, which
// lives in the private work-laptop-config repo, not this one. Like the planka CLI, every
// way it can be missing or broken answers as an `{ error }` body rather than a crash.
//
// Spawned by absolute path for the reason PLANKA_BIN gives: launchd's PATH does not
// include ~/.local/bin.
export const JOBSTAT_BIN = join(homedir(), '.local', 'bin', 'jobstat');

// jobstat asks launchctl about every job in turn, which takes a few seconds.
const TIMEOUT_MS = 20_000;

// A job's state changes a few times a day at most, while every new tab asks. The
// extension keeps its own 60-second cache on top of this.
const CACHE_TTL_MS = 120_000;

/**
 * One job as `GET /api/jobs` serves it. `failed` is jobstat's own decision, catch-up
 * replays included, so nothing here re-derives it. `logAt` is the job's newest log's
 * modification time in epoch seconds, and `log` its path with $HOME as `~`; both are null
 * when it has none. jobstat never sends the log's content; `GET /api/job-log` reads it
 * through createLoadJobLog below.
 */
export type JobStatus = {
  label: string;
  schedule: string;
  status: string;
  failed: boolean;
  logAt: number | null;
  log: string | null;
};

/** One `/api/jobs` answer: every job, or the reason jobstat could not be read. */
export type JobsResult = { jobs: JobStatus[]; error?: undefined } | { jobs?: undefined; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// An entry missing a field is dropped rather than passed on half-formed.
function toJob(raw: unknown): JobStatus | undefined {
  if (!isRecord(raw)) return undefined;
  const { label, schedule, status, failed, logAt, log = null } = raw;
  if (typeof label !== 'string' || typeof schedule !== 'string' || typeof status !== 'string') return undefined;
  if (typeof failed !== 'boolean') return undefined;
  if (logAt !== null && (typeof logAt !== 'number' || !Number.isFinite(logAt))) return undefined;
  // Defaulted rather than required, so a jobstat from before the field still answers.
  if (log !== null && typeof log !== 'string') return undefined;
  return { label, schedule, status, failed, logAt, log };
}

/**
 * Returns the loader behind `GET /api/jobs`. It takes no argument from the request, so
 * nothing a caller sends reaches jobstat's argv. A failure is never cached, so the next
 * request retries, and concurrent requests share one run.
 */
export function createLoadJobs(run?: RunCli): () => Promise<JobsResult> {
  const load = createCliLoader<JobStatus[]>({
    bin: JOBSTAT_BIN,
    name: 'jobstat',
    timeoutMs: TIMEOUT_MS,
    ttlMs: CACHE_TTL_MS,
    run,
    parse: (json) =>
      Array.isArray(json)
        ? { value: json.map(toJob).filter((j): j is JobStatus => j !== undefined) }
        : { error: 'jobstat --json printed something other than a list' },
  });
  return async () => {
    const result = await load();
    return result.error !== undefined ? { error: result.error } : { jobs: result.value };
  };
}

// The jobs page shows the end of a log, where a failure is. The largest scheduled log runs
// to hundreds of kilobytes.
export const LOG_TAIL_BYTES = 64 * 1024;

/** One `/api/job-log` answer: the end of the job's log, or why it could not be read. */
export type JobLogResult =
  | { log: string; text: string; truncated: boolean; error?: undefined }
  | { error: string; status: 404 | 502 };

/**
 * Returns the loader behind `GET /api/job-log`. The request names a job, never a path: the
 * file read is the `log` jobstat reported for that label, and it must resolve to a regular
 * file inside `home`. `truncated` says the text starts partway through the log; the partial
 * first line is dropped.
 */
export function createLoadJobLog(
  loadJobs: () => Promise<JobsResult>,
  home: string = homedir(),
): (label: string) => Promise<JobLogResult> {
  return async (label) => {
    const result = await loadJobs();
    if (result.error !== undefined) return { error: result.error, status: 502 };
    const job = result.jobs.find((j) => j.label === label);
    if (job === undefined) return { error: 'jobstat reports no job with that label', status: 404 };
    if (job.log === null) return { error: `${job.label} has no log`, status: 404 };
    if (!job.log.startsWith('~/')) return { error: `${job.label}'s log is not under the home directory`, status: 502 };

    let path: string;
    let root: string;
    try {
      [path, root] = await Promise.all([realpath(join(home, job.log.slice(2))), realpath(home)]);
    } catch {
      return { error: `${job.log} no longer exists`, status: 404 };
    }
    if (!path.startsWith(root + sep)) return { error: `${job.log} resolves outside the home directory`, status: 502 };

    // O_NOFOLLOW refuses a symlink swapped in after realpath resolved the path.
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return { error: `${job.log} could not be opened`, status: 502 };
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { error: `${job.log} is not a regular file`, status: 502 };
      const start = Math.max(0, stat.size - LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(stat.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      return { log: job.log, text, truncated: start > 0 };
    } finally {
      await handle.close();
    }
  };
}
