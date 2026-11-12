import { homedir } from 'node:os';
import { join } from 'node:path';
import { createCliLoader, type RunCli } from './cli-loader.ts';

// pr-dash reads the operator's on-call shifts and their team's open incidents through
// `oncall --json`, which lives in the private work-laptop-config repo with the pager
// service's IDs and the secret's name. This repo only relays what it prints.
export const ONCALL_BIN = join(homedir(), '.local', 'bin', 'oncall');

// oncall makes three sequential API requests.
const TIMEOUT_MS = 30_000;

// An open incident is the thing an on-call tab exists to show, so this matches the
// extension's own 60-second cache rather than the jobs route's longer one.
const CACHE_TTL_MS = 60_000;

/** One shift in the operator's on-call schedule. `start` and `end` are ISO 8601. */
export type Shift = { schedule: string; level: number; start: string; end: string };

/** One open incident, with only the fields the panel shows: never its description. */
export type Incident = {
  number: number;
  title: string;
  status: string;
  urgency: string;
  service: string;
  createdAt: string;
  url: string;
};

/** One `/api/oncall` answer: the shifts and incidents, or why oncall could not be read. */
export type OnCallResult =
  | { shifts: Shift[]; incidents: Incident[]; error?: undefined }
  | { shifts?: undefined; incidents?: undefined; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

// An entry missing a field is dropped rather than passed on half-formed. Each output is
// rebuilt from named fields, so nothing oncall adds later reaches the extension unreviewed.
function toShift(raw: unknown): Shift | undefined {
  if (!isRecord(raw)) return undefined;
  const { schedule, level, start, end } = raw;
  if (typeof schedule !== 'string' || typeof level !== 'number' || !isTime(start) || !isTime(end)) return undefined;
  return { schedule, level, start, end };
}

function toIncident(raw: unknown): Incident | undefined {
  if (!isRecord(raw)) return undefined;
  const { number, title, status, urgency, service, createdAt, url } = raw;
  if (typeof number !== 'number' || typeof title !== 'string' || typeof status !== 'string') return undefined;
  if (typeof urgency !== 'string' || typeof service !== 'string' || !isTime(createdAt) || typeof url !== 'string') {
    return undefined;
  }
  return { number, title, status, urgency, service, createdAt, url };
}

/**
 * Returns the loader behind `GET /api/oncall`. Like createLoadJobs, it takes nothing from
 * the request, never caches a failure, and shares one run between concurrent calls.
 */
export function createLoadOnCall(run?: RunCli): () => Promise<OnCallResult> {
  const load = createCliLoader<{ shifts: Shift[]; incidents: Incident[] }>({
    bin: ONCALL_BIN,
    name: 'oncall',
    timeoutMs: TIMEOUT_MS,
    ttlMs: CACHE_TTL_MS,
    run,
    parse: (json) => {
      if (!isRecord(json) || !Array.isArray(json['shifts']) || !Array.isArray(json['incidents'])) {
        return { error: 'oncall --json printed something other than {shifts, incidents}' };
      }
      return {
        value: {
          shifts: json['shifts'].map(toShift).filter((s): s is Shift => s !== undefined),
          incidents: json['incidents'].map(toIncident).filter((i): i is Incident => i !== undefined),
        },
      };
    },
  });
  return async () => {
    const result = await load();
    return result.error !== undefined ? { error: result.error } : result.value;
  };
}
