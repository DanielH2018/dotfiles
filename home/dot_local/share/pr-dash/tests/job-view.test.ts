import { test } from 'node:test';
import assert from 'node:assert';
import { jobLogText, parseJobsBody, shortLabel, sortJobs } from '../public/job-view.js';
import type { JobStatus } from '../src/jobs.ts';

// Synthetic labels only: this repo is public, and the real jobs belong to a private repo.
function job(label: string, failed: boolean): JobStatus {
  return { label, schedule: 'daily 08:00', status: 'not running, last exit 0', failed, logAt: null, log: null };
}

test('parseJobsBody keeps well-formed jobs and rejects a body that is not a job list', () => {
  const ok = job('com.example.a', false);
  assert.deepStrictEqual(parseJobsBody({ jobs: [ok, { label: 'x' }, null] }), [ok]);
  assert.strictEqual(parseJobsBody({ error: 'jobstat broke' }), null);
  assert.strictEqual(parseJobsBody([ok]), null);
});

test('shortLabel drops the shared prefix the new tab also drops', () => {
  assert.strictEqual(shortLabel('com.daniel.claude.digest'), 'digest');
  assert.strictEqual(shortLabel('com.danielhunter.svc'), 'svc');
  assert.strictEqual(shortLabel('com.example.other'), 'com.example.other');
});

test('sortJobs puts failed jobs first, each group by short label', () => {
  const jobs = [job('com.daniel.b', false), job('com.daniel.claude.z', true), job('com.daniel.a', false), job('com.daniel.y', true)];
  assert.deepStrictEqual(
    sortJobs(jobs).map((j) => j.label),
    ['com.daniel.y', 'com.daniel.claude.z', 'com.daniel.a', 'com.daniel.b'],
  );
});

test('jobLogText marks a cut log, names an empty one, and rejects another shape', () => {
  assert.strictEqual(jobLogText({ text: 'exit 1\n', truncated: false }), 'exit 1\n');
  assert.match(String(jobLogText({ text: 'exit 1\n', truncated: true })), /^\[earlier lines cut[^\n]*\nexit 1\n$/);
  assert.strictEqual(jobLogText({ text: '', truncated: false }), '(the log is empty)');
  assert.strictEqual(jobLogText({ error: 'no log' }), null);
});
