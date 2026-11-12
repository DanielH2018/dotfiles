import { execFile } from 'node:child_process';
import { createCache } from './cache.ts';

/** Runs a command with `args`; rejects on ENOENT, a non-zero exit or the timeout. */
export type RunCli = (args: string[]) => Promise<{ stdout: string }>;

/** A loader's answer: the parsed value, or the reason it could not be read. */
export type CliResult<T> = { value: T; error?: undefined } | { value?: undefined; error: string };

export type CliLoaderOpts<T> = {
  // Absolute, because launchd's PATH does not include ~/.local/bin.
  bin: string;
  // How messages name the command, e.g. `jobstat`.
  name: string;
  timeoutMs: number;
  ttlMs: number;
  // Turns the command's parsed JSON into the value, or says why it cannot.
  parse: (json: unknown) => CliResult<T>;
  // The seam tests use; the default spawns `bin`.
  run?: RunCli;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ENOENT means the command is not installed, which is the normal state outside the work
// laptop, so it reads as a reason rather than a crash.
function failureMessage(err: unknown, { bin, name, timeoutMs }: CliLoaderOpts<unknown>): string {
  if (isRecord(err) && err['code'] === 'ENOENT') return `${name} is not installed at ${bin}`;
  if (isRecord(err) && err['killed'] === true) return `${name} did not finish within ${timeoutMs / 1000}s`;
  const stderr = isRecord(err) && typeof err['stderr'] === 'string' ? err['stderr'].trim() : '';
  if (stderr === '') return `${name} --json failed`;
  // A command that already names itself, as `oncall: ...` does, is not prefixed twice.
  return stderr.startsWith(`${name}: `) ? stderr : `${name}: ${stderr}`;
}

/**
 * Returns a loader that runs `<bin> --json` and parses what it prints. It takes no
 * argument, so nothing a request sends reaches the command's argv. Every way the command
 * can be missing or broken answers as `{ error }`. A failure is never cached, so the next
 * call retries; a success is reused for `ttlMs`; concurrent calls share one run.
 */
export function createCliLoader<T>(opts: CliLoaderOpts<T>): () => Promise<CliResult<T>> {
  const run =
    opts.run ??
    ((args: string[]) =>
      new Promise<{ stdout: string }>((resolve, reject) => {
        execFile(opts.bin, args, { timeout: opts.timeoutMs }, (err, stdout, stderr) => {
          if (err) reject(Object.assign(err, { stderr: String(stderr) }));
          else resolve({ stdout: String(stdout) });
        });
      }));
  const cache = createCache<T>(opts.ttlMs);
  let inFlight: Promise<CliResult<T>> | undefined;

  async function load(): Promise<CliResult<T>> {
    let stdout: string;
    try {
      ({ stdout } = await run(['--json']));
    } catch (err) {
      return { error: failureMessage(err, opts) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { error: `${opts.name} --json printed something that is not JSON` };
    }
    const result = opts.parse(parsed);
    if (result.error === undefined) cache.set(result.value);
    return result;
  }

  return () => {
    const cached = cache.get();
    if (cached !== undefined) return Promise.resolve({ value: cached });
    inFlight ??= load().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
