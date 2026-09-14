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
  const optionPattern = /<option value="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = optionPattern.exec(select[1]!))) {
    values.push(match[1]!);
  }
  return values;
}

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
  const body = { prs: [{ id: 'x/y#1' }], fetchedAt: '2026-09-14T00:00:00Z' };
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
