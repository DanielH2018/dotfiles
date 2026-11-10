import { test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoadJobLog, createLoadJobs, LOG_TAIL_BYTES, type JobStatus, type RunJobstat } from '../src/jobs.ts';

// Synthetic labels only: this repo is public, and the real jobs belong to a private repo.
const JOB = { label: 'com.example.digest', schedule: 'Mon-Fri 08:34', status: 'not running, last exit 1', failed: true, logAt: 1761137640, log: '~/logs/digest.log' };

function fakeRun(...answers: (() => string)[]): RunJobstat & { calls: string[][] } {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const answer = answers[calls.length - 1];
    if (answer === undefined) throw new Error('jobstat ran more often than expected');
    return { stdout: answer() };
  };
  return Object.assign(run, { calls });
}

test('runs jobstat --json and drops entries missing a field', async () => {
  const run = fakeRun(() => JSON.stringify([JOB, { ...JOB, failed: 'yes' }, { ...JOB, logAt: null }]));
  assert.deepStrictEqual(await createLoadJobs(run)(), { jobs: [JOB, { ...JOB, logAt: null }] });
  assert.deepStrictEqual(run.calls, [['--json']]);
});

test('passes the log path through, and reads an entry without one as having no log', async () => {
  const { log: _, ...noLog } = JOB;
  const run = fakeRun(() => JSON.stringify([JOB, noLog, { ...JOB, log: 7 }]));
  assert.deepStrictEqual(await createLoadJobs(run)(), { jobs: [JOB, { ...JOB, log: null }] });
});

test('output that is not a JSON list is an error', async () => {
  assert.deepStrictEqual(await createLoadJobs(fakeRun(() => 'jq: command not found'))(), {
    error: 'jobstat --json printed something that is not JSON',
  });
  assert.deepStrictEqual(await createLoadJobs(fakeRun(() => '{}'))(), {
    error: 'jobstat --json printed something other than a list',
  });
});

test('a failure is retried on the next call, and a success is reused', async () => {
  const run = fakeRun(
    () => {
      throw Object.assign(new Error('Command failed'), { code: 1, stderr: 'launchctl: busy\n' });
    },
    () => JSON.stringify([JOB]),
  );
  const load = createLoadJobs(run);
  assert.deepStrictEqual(await load(), { error: 'jobstat: launchctl: busy' });
  assert.deepStrictEqual(await load(), { jobs: [JOB] });
  assert.deepStrictEqual(await load(), { jobs: [JOB] });
});

// A throwaway home holding logs/, plus a jobs list naming paths in it the way jobstat does.
function withHome(fn: (home: string, loadLog: (jobs: JobStatus[]) => ReturnType<typeof createLoadJobLog>) => Promise<void>) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pr-dash-home-')));
  mkdirSync(join(home, 'logs'));
  const loadLog = (jobs: JobStatus[]) => createLoadJobLog(async () => ({ jobs }), home);
  return fn(home, loadLog).finally(() => rmSync(home, { recursive: true, force: true }));
}

test('reads the log jobstat names for a label', async () => {
  await withHome(async (home, loadLog) => {
    writeFileSync(join(home, 'logs', 'digest.log'), 'started\nexit 1\n');
    assert.deepStrictEqual(await loadLog([JOB])('com.example.digest'), {
      log: '~/logs/digest.log',
      text: 'started\nexit 1\n',
      truncated: false,
    });
  });
});

test('an unknown label or a job without a log is a 404, and a failed jobs load a 502', async () => {
  await withHome(async (_home, loadLog) => {
    assert.strictEqual((await loadLog([JOB])('com.example.other')).error, 'jobstat reports no job with that label');
    assert.deepStrictEqual(await loadLog([{ ...JOB, log: null }])(JOB.label), {
      error: 'com.example.digest has no log',
      status: 404,
    });
  });
  const failed = createLoadJobLog(async () => ({ error: 'jobstat --json failed' }));
  assert.deepStrictEqual(await failed(JOB.label), { error: 'jobstat --json failed', status: 502 });
});

test('a log that resolves outside home is refused, whether by path or by symlink', async () => {
  await withHome(async (home, loadLog) => {
    const outside = mkdtempSync(join(tmpdir(), 'pr-dash-outside-'));
    try {
      writeFileSync(join(outside, 'secret.log'), 'not yours');
      symlinkSync(join(outside, 'secret.log'), join(home, 'logs', 'digest.log'));
      const linked = await loadLog([JOB])(JOB.label);
      assert.strictEqual(linked.error, '~/logs/digest.log resolves outside the home directory');
      const absolute = await loadLog([{ ...JOB, log: join(outside, 'secret.log') }])(JOB.label);
      assert.match(String(absolute.error), /is not under the home directory/);
      const dottedLog = `~/../${outside.split('/').pop()}/secret.log`;
      const dotted = await loadLog([{ ...JOB, log: dottedLog }])(JOB.label);
      assert.strictEqual(dotted.error, `${dottedLog} resolves outside the home directory`);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('a log longer than the cap is cut to its end, starting on a whole line', async () => {
  await withHome(async (home, loadLog) => {
    const line = 'x'.repeat(99) + '\n';
    writeFileSync(join(home, 'logs', 'digest.log'), 'first\n' + line.repeat(LOG_TAIL_BYTES / 100 + 10) + 'last\n');
    const result = await loadLog([JOB])(JOB.label);
    assert.ok(result.error === undefined, result.error);
    assert.strictEqual(result.truncated, true);
    assert.ok(result.text.length <= LOG_TAIL_BYTES);
    assert.ok(result.text.startsWith(line) && result.text.endsWith('last\n'));
  });
});
