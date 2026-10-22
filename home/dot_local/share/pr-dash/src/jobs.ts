import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createCache } from './cache.ts';

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

/** Runs `jobstat` with `args`; rejects on ENOENT, a non-zero exit or the timeout. */
export type RunJobstat = (args: string[]) => Promise<{ stdout: string }>;

/**
 * One job as `GET /api/jobs` serves it. `failed` is jobstat's own decision, catch-up
 * replays included, so nothing here re-derives it. `logAt` is the job's newest log's
 * modification time in epoch seconds, or null when it has none.
 */
export type JobStatus = {
  label: string;
  schedule: string;
  status: string;
  failed: boolean;
  logAt: number | null;
};

/** One `/api/jobs` answer: every job, or the reason jobstat could not be read. */
export type JobsResult = { jobs: JobStatus[]; error?: undefined } | { jobs?: undefined; error: string };

function defaultRunJobstat(args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(JOBSTAT_BIN, args, { timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }));
      else resolve({ stdout: String(stdout) });
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ENOENT means jobstat is not installed, which is the normal state outside the work laptop.
function failureMessage(err: unknown): string {
  if (isRecord(err) && err['code'] === 'ENOENT') return `jobstat is not installed at ${JOBSTAT_BIN}`;
  if (isRecord(err) && err['killed'] === true) return `jobstat did not finish within ${TIMEOUT_MS / 1000}s`;
  const stderr = isRecord(err) && typeof err['stderr'] === 'string' ? err['stderr'].trim() : '';
  return stderr !== '' ? `jobstat: ${stderr}` : 'jobstat --json failed';
}

// An entry missing a field is dropped rather than passed on half-formed.
function toJob(raw: unknown): JobStatus | undefined {
  if (!isRecord(raw)) return undefined;
  const { label, schedule, status, failed, logAt } = raw;
  if (typeof label !== 'string' || typeof schedule !== 'string' || typeof status !== 'string') return undefined;
  if (typeof failed !== 'boolean') return undefined;
  if (logAt !== null && (typeof logAt !== 'number' || !Number.isFinite(logAt))) return undefined;
  return { label, schedule, status, failed, logAt };
}

/**
 * Returns the loader behind `GET /api/jobs`. It takes no argument from the request, so
 * nothing a caller sends reaches jobstat's argv. A failure is never cached, so the next
 * request retries, and concurrent requests share one run.
 */
export function createLoadJobs(run: RunJobstat = defaultRunJobstat): () => Promise<JobsResult> {
  const cache = createCache<JobStatus[]>(CACHE_TTL_MS);
  let inFlight: Promise<JobsResult> | undefined;

  async function load(): Promise<JobsResult> {
    let stdout: string;
    try {
      ({ stdout } = await run(['--json']));
    } catch (err) {
      return { error: failureMessage(err) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { error: 'jobstat --json printed something that is not JSON' };
    }
    if (!Array.isArray(parsed)) return { error: 'jobstat --json printed something other than a list' };
    const jobs = parsed.map(toJob).filter((j): j is JobStatus => j !== undefined);
    cache.set(jobs);
    return { jobs };
  }

  return () => {
    const cached = cache.get();
    if (cached !== undefined) return Promise.resolve({ jobs: cached });
    inFlight ??= load().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
