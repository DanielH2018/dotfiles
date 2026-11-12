import { test } from 'node:test';
import assert from 'node:assert';
import type { RunCli } from '../src/cli-loader.ts';
import { createLoadOnCall } from '../src/oncall.ts';

// Made-up values only: this repo is public, and the real schedule belongs to a private repo.
const SHIFT = { schedule: 'Secondary', level: 2, start: '2026-11-12T18:00:00Z', end: '2026-11-19T18:00:00Z' };
const INCIDENT = {
  number: 41,
  title: 'Queue backed up',
  status: 'triggered',
  urgency: 'high',
  service: 'Example service',
  createdAt: '2026-11-12T10:00:00Z',
  url: 'https://example.pagerduty.com/incidents/Q1',
};

const answer = (stdout: string): RunCli => async () => ({ stdout });

test('passes on only the named fields of well-formed shifts and incidents', async () => {
  const stdout = JSON.stringify({
    shifts: [SHIFT, { ...SHIFT, end: null }],
    incidents: [{ ...INCIDENT, description: 'a log line' }, { ...INCIDENT, number: '41' }],
  });
  assert.deepStrictEqual(await createLoadOnCall(answer(stdout))(), { shifts: [SHIFT], incidents: [INCIDENT] });
});

test("relays oncall's own reason when it fails, and refuses output of the wrong shape", async () => {
  const failing: RunCli = async () => {
    throw Object.assign(new Error('Command failed'), {
      code: 1,
      stderr: 'oncall: the token is not cached; run `secret-get --fetch x` in a terminal\n',
    });
  };
  assert.deepStrictEqual(await createLoadOnCall(failing)(), {
    error: 'oncall: the token is not cached; run `secret-get --fetch x` in a terminal',
  });
  assert.deepStrictEqual(await createLoadOnCall(answer('[]'))(), {
    error: 'oncall --json printed something other than {shifts, incidents}',
  });
});
