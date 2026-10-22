import { test } from 'node:test';
import assert from 'node:assert';
import { createLoadJobs, JOBSTAT_BIN, type RunJobstat } from '../src/jobs.ts';

// Synthetic labels only: this repo is public, and the real jobs belong to a private repo.
const JOB = { label: 'com.example.digest', schedule: 'Mon-Fri 08:34', status: 'not running, last exit 1', failed: true, logAt: 1761137640 };

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
  const run = fakeRun(() => JSON.stringify([JOB, { label: 'com.example.half', failed: 'yes' }, { ...JOB, logAt: null }]));
  assert.deepStrictEqual(await createLoadJobs(run)(), { jobs: [JOB, { ...JOB, logAt: null }] });
  assert.deepStrictEqual(run.calls, [['--json']]);
});

test('a missing jobstat is an error naming where pr-dash looked', async () => {
  const run: RunJobstat = async () => {
    throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  };
  assert.deepStrictEqual(await createLoadJobs(run)(), { error: `jobstat is not installed at ${JOBSTAT_BIN}` });
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
  assert.strictEqual(run.calls.length, 2);
});
