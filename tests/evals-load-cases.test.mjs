import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envCaseDirs, loadCases, readCaseFiles } from '../evals/lib/load-cases.mjs';

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'evalcases-'));
  const dir = join(root, 'security-review');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '001.json'), JSON.stringify({ id: 'security-review/001', agent: 'security-review', input: 'x' }));
  writeFileSync(join(dir, '002-live.json'), JSON.stringify({ id: 'security-review/002', agent: 'security-review', input: 'y', mode: 'live' }));
  return root;
}

test('envCaseDirs parses colon-separated, empty by default', () => {
  delete process.env.EVAL_CASE_DIRS;
  assert.deepStrictEqual(envCaseDirs(), []);
  process.env.EVAL_CASE_DIRS = '/a:/b:';
  assert.deepStrictEqual(envCaseDirs(), ['/a', '/b']);
  delete process.env.EVAL_CASE_DIRS;
});

test('loadCases discovers cases, skips live, honors filters, ignores missing dirs', () => {
  const root = fixtureRoot();
  try {
    const all = loadCases({}, [root, '/does/not/exist']);
    assert.strictEqual(all.length, 1);                       // live case skipped
    assert.strictEqual(all[0].id, 'security-review/001');
    assert.strictEqual(loadCases({ agent: 'nope' }, [root]).length, 0);
    assert.strictEqual(loadCases({ case: 'security-review/001' }, [root]).length, 1);
    assert.strictEqual(loadCases({ case: 'security-review/002' }, [root]).length, 0); // live filtered before match
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readCaseFiles returns every case incl. live, and skips missing dirs', () => {
  const root = fixtureRoot();
  try {
    const all = readCaseFiles([root, '/does/not/exist']);
    assert.strictEqual(all.length, 2);                       // no filtering: 001 + 002-live
    assert.ok(all.some(c => c.mode === 'live'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
