import { test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envCaseDirs, loadCases, readCaseFiles } from '../../evals/lib/load-cases.mjs';
import { scratch } from '../lib/tmp.js';

function fixtureRoot(t) {
  const root = scratch(tmpdir(), 'evalcases-', t);
  const dir = join(root, 'security-review');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '001.json'), JSON.stringify({ id: 'security-review/001', agent: 'security-review', input: 'x' }));
  writeFileSync(join(dir, '002-live.json'), JSON.stringify({ id: 'security-review/002', agent: 'security-review', input: 'y', mode: 'live' }));
  const sdir = join(root, 'skill-grilling');
  mkdirSync(sdir, { recursive: true });
  writeFileSync(join(sdir, '001.json'), JSON.stringify({ id: 'skill-grilling/001', skill: 'grilling', input: 'z' }));
  return root;
}

test('envCaseDirs parses colon-separated, empty by default', () => {
  delete process.env.EVAL_CASE_DIRS;
  assert.deepStrictEqual(envCaseDirs(), []);
  process.env.EVAL_CASE_DIRS = '/a:/b:';
  assert.deepStrictEqual(envCaseDirs(), ['/a', '/b']);
  delete process.env.EVAL_CASE_DIRS;
});

test('loadCases discovers cases, skips live, honors filters, ignores missing dirs', (t) => {
  const root = fixtureRoot(t);
  const all = loadCases({}, [root, '/does/not/exist']);
  assert.strictEqual(all.length, 2);                       // live case skipped
  assert.strictEqual(all[0].id, 'security-review/001');
  assert.strictEqual(loadCases({ agent: 'nope' }, [root]).length, 0);
  assert.strictEqual(loadCases({ case: 'security-review/001' }, [root]).length, 1);
  assert.strictEqual(loadCases({ case: 'security-review/002' }, [root]).length, 0); // live filtered before match
});

test('loadCases derives agent "skill-<name>" for skill cases so filters and reports work', (t) => {
  const root = fixtureRoot(t);
  const sc = loadCases({}, [root]).find(c => c.skill);
  assert.strictEqual(sc.skill, 'grilling');
  assert.strictEqual(sc.agent, 'skill-grilling');
  assert.strictEqual(loadCases({ agent: 'skill-grilling' }, [root]).length, 1);
  const plain = loadCases({ agent: 'security-review' }, [root]);
  assert.strictEqual(plain.length, 1);                     // explicit-agent cases untouched
  assert.ok(!('skill' in plain[0]));
});

test('readCaseFiles returns every case incl. live, and skips missing dirs', (t) => {
  const root = fixtureRoot(t);
  const all = readCaseFiles([root, '/does/not/exist']);
  assert.strictEqual(all.length, 3);                       // no filtering: 001 + 002-live + skill case
  assert.ok(all.some(c => c.mode === 'live'));
});
