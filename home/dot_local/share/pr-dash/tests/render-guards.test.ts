import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  AXES,
  SORTS,
  toAxis,
  toSort,
  parsePrsBody,
  isSafeUrl,
} from '../public/render-guards.js';
import { groupBy } from '../public/group.js';
import type { PrRecord } from '../src/types.ts';

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

/**
 * Extracts the `value` of every `<option>` inside the `<select id="selectId">`
 * in `index.html`, in document order — read from the real markup rather than
 * hardcoded here, so a `<select>` and its guard's allowed values can never
 * silently drift apart.
 */
function optionValues(html: string, selectId: string): string[] {
  const select = new RegExp(`<select id="${selectId}">([\\s\\S]*?)</select>`).exec(html);
  assert.ok(select, `no <select id="${selectId}"> found in index.html`);
  const values: string[] = [];
  // `[^"]*`, not `[^"]+`: an empty value="" is a real (if currently unused) option and must
  // be counted, not silently skipped.
  const optionPattern = /<option value="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = optionPattern.exec(select[1]!))) {
    values.push(match[1]!);
  }
  return values;
}

/** A fully well-formed PR record, for tests to override fields on. */
const validRecord: PrRecord = {
  id: 'x/y#1',
  repo: 'x/y',
  number: 1,
  title: 'Add feature',
  url: 'https://github.com/x/y/pull/1',
  headRef: 'feature',
  baseRef: 'main',
  isDraft: false,
  ci: 'success',
  review: 'approved',
  openedAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-10T00:00:00Z',
  ageDays: 5,
  staleDays: 2,
  additions: 10,
  deletions: 2,
};

test('AXES matches the #group-by <select> options in index.html', () => {
  assert.deepStrictEqual(AXES, optionValues(indexHtml, 'group-by'));
});

test('SORTS matches the #sort-by <select> options in index.html', () => {
  assert.deepStrictEqual(SORTS, optionValues(indexHtml, 'sort-by'));
});

test('toAxis passes through every known axis unchanged', () => {
  for (const axis of AXES) {
    assert.strictEqual(toAxis(axis), axis);
  }
});

test('toAxis falls back to repo for an unknown value', () => {
  assert.strictEqual(toAxis('bogus-axis'), 'repo');
});

test('toAxis falls back to repo for the empty string', () => {
  assert.strictEqual(toAxis(''), 'repo');
});

test('toSort passes through every known sort unchanged', () => {
  for (const sort of SORTS) {
    assert.strictEqual(toSort(sort), sort);
  }
});

test('toSort falls back to stale for an unknown value', () => {
  assert.strictEqual(toSort('bogus-sort'), 'stale');
});

test('toSort falls back to stale for the empty string', () => {
  assert.strictEqual(toSort(''), 'stale');
});

test('parsePrsBody returns the prs array from a well-formed body', () => {
  const body = { prs: [validRecord], fetchedAt: '2026-09-14T00:00:00Z' };
  assert.deepStrictEqual(parsePrsBody(body), body.prs);
});

test('parsePrsBody throws when prs is not an array', () => {
  assert.throws(() => parsePrsBody({ prs: 'not-an-array' }), /"prs" is not an array/);
});

test('parsePrsBody throws when prs is missing entirely', () => {
  assert.throws(() => parsePrsBody({}), /"prs" is not an array/);
});

test('parsePrsBody throws on a non-object body', () => {
  assert.throws(() => parsePrsBody(null));
  assert.throws(() => parsePrsBody('nope'));
});

test('parsePrsBody throws, naming the index and field, when a record is missing a required field', () => {
  const { repo, ...withoutRepo } = validRecord;
  assert.throws(
    () => parsePrsBody({ prs: [withoutRepo] }),
    /record 0 has an invalid "repo"/,
  );
});

test('parsePrsBody throws, naming the index and field, when a field has the wrong type', () => {
  assert.throws(
    () => parsePrsBody({ prs: [{ ...validRecord, staleDays: '2' }] }),
    /record 0 has an invalid "staleDays"/,
  );
});

test('parsePrsBody throws, naming the index, for a non-object element', () => {
  assert.throws(() => parsePrsBody({ prs: [null] }), /record 0 is not an object/);
  assert.throws(() => parsePrsBody({ prs: ['nope'] }), /record 0 is not an object/);
});

test('parsePrsBody names the offending record among several, not just the first', () => {
  assert.throws(
    () => parsePrsBody({ prs: [validRecord, { ...validRecord, ci: 'unknown' }] }),
    /record 1 has an invalid "ci"/,
  );
});

test(
  'a malformed record throws before "current" is reassigned, so a fallback ' +
    're-render of the previous rows does not throw a second time',
  () => {
    // Mirrors app.js's refresh(): `current` is assigned only from the awaited
    // load's result, so a load that throws leaves `current` at its previous
    // value, and the catch's fallback re-renders that value instead of the
    // bad one. Reproduces the reviewer's repro directly: with the per-element
    // check removed, groupBy's `a.key.localeCompare(b.key)` throws on the
    // second (malformed) record's undefined `repo`, inside the fallback
    // render too, uncaught.
    const previousGoodRecords = [validRecord];
    let current: PrRecord[] = previousGoodRecords;
    let renderCount = 0;
    const render = (records: PrRecord[]): void => {
      renderCount += 1;
      groupBy(records, 'repo');
    };
    const load = (): PrRecord[] =>
      parsePrsBody({
        prs: [validRecord, { id: 'bad', number: 1, title: 'Untitled' }],
      });

    let bannerMessage: string | null = null;
    try {
      current = load();
      render(current);
    } catch (err) {
      bannerMessage = String(err);
      if (current.length > 0) render(current);
    }

    assert.deepStrictEqual(current, previousGoodRecords);
    assert.strictEqual(renderCount, 1);
    assert.ok(bannerMessage !== null);
  },
);

test('isSafeUrl accepts https and http', () => {
  assert.strictEqual(isSafeUrl('https://github.com/acme/api/pull/12'), true);
  assert.strictEqual(isSafeUrl('http://github.com/acme/api/pull/12'), true);
});

test('isSafeUrl rejects javascript: and data: schemes', () => {
  assert.strictEqual(isSafeUrl('javascript:alert(1)'), false);
  assert.strictEqual(isSafeUrl('data:text/html,<script>alert(1)</script>'), false);
});

test('isSafeUrl rejects a malformed URL', () => {
  assert.strictEqual(isSafeUrl('not a url'), false);
});
