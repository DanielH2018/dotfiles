import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  AXES,
  SORTS,
  CI_VALUES,
  REVIEW_VALUES,
  toAxis,
  toSort,
  parsePrsBody,
  isSafeUrl,
  parseStoredView,
  loadStoredView,
  saveStoredView,
  clearStoredView,
} from '../public/render-guards.js';
import { groupBy } from '../public/group.js';
import type { PrRecord } from '../src/types.ts';
import type { StoredView } from '../public/render-guards.js';

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

/**
 * Extracts the `value` of every checkbox `<input>` inside the
 * `<fieldset id="fieldsetId">` in `index.html`, in document order — the
 * checkbox equivalent of {@link optionValues}, so a filter fieldset and
 * its guard's allowed values can never silently drift apart either.
 */
function checkboxValues(html: string, fieldsetId: string): string[] {
  const fieldset = new RegExp(`<fieldset id="${fieldsetId}">([\\s\\S]*?)</fieldset>`).exec(html);
  assert.ok(fieldset, `no <fieldset id="${fieldsetId}"> found in index.html`);
  const values: string[] = [];
  const inputPattern = /<input type="checkbox" value="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = inputPattern.exec(fieldset[1]!))) {
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
  defaultBranch: 'main',
};

type FieldKind = 'string' | 'number' | 'boolean' | 'enum';

/**
 * One row per field `validateRecord` checks in `render-guards.js`.
 * `edgeValid`, when present, is a legitimate value for that field that must
 * NOT be rejected. Both test tables below are generated from this single
 * list, so covering a field `validateRecord` gains means adding one row
 * here rather than a new test block.
 */
const FIELD_SPECS: {
  field: string;
  kind: FieldKind;
  edgeValid?: unknown;
  edgeInvalid?: unknown;
}[] = [
  { field: 'repo', kind: 'string' },
  { field: 'title', kind: 'string', edgeValid: '' },
  { field: 'url', kind: 'string' },
  { field: 'number', kind: 'number', edgeValid: 0 },
  // NaN and Infinity both pass `typeof x === 'number'`, so a numeric field needs its own
  // edgeInvalid case rather than relying on breakField's "wrong type" coverage: normalize.ts
  // has its own reasons never to emit either, but this guard exists precisely to catch what
  // upstream got wrong, so it must reject a non-finite number even if nothing here does.
  { field: 'staleDays', kind: 'number', edgeValid: 0, edgeInvalid: NaN },
  { field: 'ageDays', kind: 'number', edgeValid: 0 },
  { field: 'additions', kind: 'number', edgeValid: 0 },
  { field: 'deletions', kind: 'number', edgeValid: 0 },
  { field: 'isDraft', kind: 'boolean' },
  { field: 'ci', kind: 'enum' },
  { field: 'review', kind: 'enum' },
];

/**
 * Breaks one field of `validRecord` the way that field can actually arrive
 * wrong: a missing string, a numeric string where a number belongs, a
 * non-boolean for `isDraft`, or a value outside `ci`/`review`'s union.
 */
function breakField(field: string, kind: FieldKind): Record<string, unknown> {
  const record = { ...validRecord } as Record<string, unknown>;
  switch (kind) {
    case 'string':
      delete record[field];
      break;
    case 'number':
      record[field] = String(record[field]);
      break;
    case 'boolean':
      record[field] = String(record[field]);
      break;
    case 'enum':
      record[field] = 'not-a-real-value';
      break;
  }
  return record;
}

test('AXES matches the #group-by <select> options in index.html', () => {
  assert.deepStrictEqual(AXES, optionValues(indexHtml, 'group-by'));
});

test('SORTS matches the #sort-by <select> options in index.html', () => {
  assert.deepStrictEqual(SORTS, optionValues(indexHtml, 'sort-by'));
});

test('CI_VALUES matches the #filter-ci fieldset checkboxes in index.html', () => {
  assert.deepStrictEqual(CI_VALUES, checkboxValues(indexHtml, 'filter-ci'));
});

test('REVIEW_VALUES matches the #filter-review fieldset checkboxes in index.html', () => {
  assert.deepStrictEqual(REVIEW_VALUES, checkboxValues(indexHtml, 'filter-review'));
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

for (const { field, kind } of FIELD_SPECS) {
  test(`parsePrsBody throws naming "${field}" when it is broken`, () => {
    assert.throws(
      () => parsePrsBody({ prs: [breakField(field, kind)] }),
      new RegExp(`record 0 has an invalid "${field}"`),
    );
  });
}

for (const { field, edgeValid } of FIELD_SPECS) {
  if (edgeValid === undefined) continue;
  test(`parsePrsBody accepts the edge value ${JSON.stringify(edgeValid)} for "${field}"`, () => {
    const record = { ...validRecord, [field]: edgeValid };
    assert.doesNotThrow(() => parsePrsBody({ prs: [record] }));
  });
}

for (const { field, edgeInvalid } of FIELD_SPECS) {
  if (edgeInvalid === undefined) continue;
  test(`parsePrsBody throws naming "${field}" for the invalid edge value ${String(edgeInvalid)}`, () => {
    const record = { ...validRecord, [field]: edgeInvalid };
    assert.throws(
      () => parsePrsBody({ prs: [record] }),
      new RegExp(`record 0 has an invalid "${field}"`),
    );
  });
}

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

const DEFAULT_VIEW: StoredView = { axis: 'repo', sort: 'stale', ci: [], review: [] };

test('parseStoredView returns the default view for null (nothing stored yet)', () => {
  assert.deepStrictEqual(parseStoredView(null), DEFAULT_VIEW);
});

test('parseStoredView falls back to the default view for a value that is not JSON', () => {
  assert.deepStrictEqual(parseStoredView('not json'), DEFAULT_VIEW);
});

test('parseStoredView falls back to the default view when the parsed value is the wrong shape', () => {
  assert.deepStrictEqual(parseStoredView('[1, 2, 3]'), DEFAULT_VIEW);
  assert.deepStrictEqual(parseStoredView('"a string"'), DEFAULT_VIEW);
  assert.deepStrictEqual(parseStoredView('null'), DEFAULT_VIEW);
});

test('parseStoredView falls back to the default axis for a value outside AXES', () => {
  const stored = JSON.stringify({ axis: 'bogus-axis', sort: 'age', ci: [], review: [] });
  assert.deepStrictEqual(parseStoredView(stored), { ...DEFAULT_VIEW, axis: 'repo', sort: 'age' });
});

test('parseStoredView drops a ci value outside CI_VALUES instead of throwing', () => {
  const stored = JSON.stringify({ axis: 'repo', sort: 'stale', ci: ['success', 'bogus'], review: [] });
  assert.deepStrictEqual(parseStoredView(stored), { ...DEFAULT_VIEW, ci: ['success'] });
});

test('parseStoredView treats a non-array ci field as no constraint', () => {
  const stored = JSON.stringify({ axis: 'repo', sort: 'stale', ci: 'failure', review: [] });
  assert.deepStrictEqual(parseStoredView(stored), DEFAULT_VIEW);
});

/** A storage double whose methods can be told to throw, mirroring the localStorage contract. */
function fakeStorage(overrides: Partial<{ getItem: () => string | null; setItem: () => void; removeItem: () => void }>) {
  return {
    getItem: overrides.getItem ?? (() => null),
    setItem: overrides.setItem ?? (() => {}),
    removeItem: overrides.removeItem ?? (() => {}),
  };
}

test('loadStoredView falls back to the default view when getItem throws', () => {
  const storage = fakeStorage({
    getItem: () => {
      throw new Error('blocked');
    },
  });
  assert.deepStrictEqual(loadStoredView(storage), DEFAULT_VIEW);
});

test('loadStoredView returns the parsed view when the store has one', () => {
  const stored = JSON.stringify({ axis: 'ci', sort: 'age', ci: ['failure'], review: [] });
  const storage = fakeStorage({ getItem: () => stored });
  assert.deepStrictEqual(loadStoredView(storage), { axis: 'ci', sort: 'age', ci: ['failure'], review: [] });
});

test('saveStoredView does not throw when setItem throws', () => {
  const storage = fakeStorage({
    setItem: () => {
      throw new Error('quota exceeded');
    },
  });
  assert.doesNotThrow(() => saveStoredView(storage, DEFAULT_VIEW));
});

test('clearStoredView does not throw when removeItem throws', () => {
  const storage = fakeStorage({
    removeItem: () => {
      throw new Error('blocked');
    },
  });
  assert.doesNotThrow(() => clearStoredView(storage));
});
