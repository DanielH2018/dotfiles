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
  toCiValues,
  toReviewValues,
  parsePrsBody,
  isSafeUrl,
  parseStoredView,
  loadStoredView,
  saveStoredView,
  clearStoredView,
  VIEW_KEY,
  staleBanner,
  formatRelativeTime,
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
  assert.deepStrictEqual(parsePrsBody(body).prs, body.prs);
});

test('parsePrsBody reports stale exactly as given when it is false', () => {
  const body = { prs: [], stale: false, fetchedAt: '2026-09-14T00:00:00Z' };
  assert.strictEqual(parsePrsBody(body).stale, false);
});

test('parsePrsBody reports stale exactly as given when it is true', () => {
  const body = { prs: [], stale: true, fetchedAt: '2026-09-14T00:00:00Z' };
  assert.strictEqual(parsePrsBody(body).stale, true);
});

test('parsePrsBody treats a non-boolean stale as stale, not as fresh', () => {
  // Over-reporting staleness is the safe direction: a server-side type slip on `stale`
  // must not read as "fresh" and hide genuinely stale data behind no banner at all.
  assert.strictEqual(parsePrsBody({ prs: [], stale: 'no', fetchedAt: '' }).stale, true);
  assert.strictEqual(parsePrsBody({ prs: [], stale: 0, fetchedAt: '' }).stale, true);
});

test('parsePrsBody treats a missing stale field as stale', () => {
  assert.strictEqual(parsePrsBody({ prs: [], fetchedAt: '' }).stale, true);
});

test('parsePrsBody passes through a string error', () => {
  const body = { prs: [], stale: true, error: 'network down', fetchedAt: '' };
  assert.strictEqual(parsePrsBody(body).error, 'network down');
});

test('parsePrsBody drops a non-string error rather than passing it through', () => {
  assert.strictEqual(parsePrsBody({ prs: [], stale: true, error: 12, fetchedAt: '' }).error, undefined);
  assert.strictEqual(parsePrsBody({ prs: [], stale: true, fetchedAt: '' }).error, undefined);
});

test('parsePrsBody passes through a string fetchedAt', () => {
  const body = { prs: [], stale: false, fetchedAt: '2026-09-14T00:00:00Z' };
  assert.strictEqual(parsePrsBody(body).fetchedAt, '2026-09-14T00:00:00Z');
});

test('parsePrsBody falls back to an empty fetchedAt when it is missing or the wrong type', () => {
  assert.strictEqual(parsePrsBody({ prs: [], stale: false }).fetchedAt, '');
  assert.strictEqual(parsePrsBody({ prs: [], stale: false, fetchedAt: 123 }).fetchedAt, '');
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
      }).prs;

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

test('parsePrsBody extracts partialErrors from the response body', () => {
  const parsed = parsePrsBody({
    prs: [validRecord],
    stale: false,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    partialErrors: ['timeout on search'],
  });
  assert.deepStrictEqual(parsed.partialErrors, ['timeout on search']);
  assert.deepStrictEqual(parsed.prs, [validRecord]);
});

test('parsePrsBody treats an absent partialErrors as nothing having failed', () => {
  const parsed = parsePrsBody({ prs: [validRecord], stale: false, fetchedAt: '' });
  assert.deepStrictEqual(parsed.partialErrors, []);
});

test('parsePrsBody drops non-string partialErrors entries rather than throwing', () => {
  // Coerced, not validated: junk here must not blank a page whose rows parsed fine, and a
  // non-string entry would otherwise render as "[object Object]" in the banner.
  const parsed = parsePrsBody({
    prs: [validRecord],
    partialErrors: ['real failure', { message: 'nested' }, 7, null],
  });
  assert.deepStrictEqual(parsed.partialErrors, ['real failure']);
});

test('parsePrsBody treats a non-array partialErrors as nothing having failed', () => {
  const parsed = parsePrsBody({ prs: [validRecord], partialErrors: 'everything broke' });
  assert.deepStrictEqual(parsed.partialErrors, []);
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

/**
 * A storage double backed by a real `Map`, mirroring the localStorage
 * contract closely enough for `saveStoredView`/`clearStoredView` to
 * round-trip against it. `overrides` replaces one method with a throwing
 * stub for the throw-path tests below; the rest keep reading and writing
 * `written`, so a round-trip test can inspect it directly.
 */
function fakeStorage(overrides: Partial<{ getItem: () => string | null; setItem: () => void; removeItem: () => void }> = {}) {
  const written = new Map<string, string>();
  return {
    written,
    getItem: overrides.getItem ?? ((key: string) => written.get(key) ?? null),
    setItem: overrides.setItem ?? ((key: string, value: string) => void written.set(key, value)),
    removeItem: overrides.removeItem ?? ((key: string) => void written.delete(key)),
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

test('saveStoredView writes the view as JSON under VIEW_KEY', () => {
  const storage = fakeStorage();
  const view: StoredView = { axis: 'ci', sort: 'age', ci: ['failure'], review: ['approved'] };
  saveStoredView(storage, view);
  assert.deepStrictEqual([...storage.written.keys()], [VIEW_KEY]);
  assert.deepStrictEqual(JSON.parse(storage.written.get(VIEW_KEY)!), view);
});

test('clearStoredView removes the value under VIEW_KEY', () => {
  const storage = fakeStorage();
  storage.written.set(VIEW_KEY, JSON.stringify(DEFAULT_VIEW));
  clearStoredView(storage);
  assert.strictEqual(storage.written.has(VIEW_KEY), false);
});

test('toCiValues keeps only known CI statuses', () => {
  assert.deepStrictEqual(toCiValues(['success', 'bogus', 'failure']), ['success', 'failure']);
});

test('toReviewValues keeps only known review states', () => {
  assert.deepStrictEqual(toReviewValues(['approved', 'bogus']), ['approved']);
});

test('staleBanner returns null for a fresh, complete response', () => {
  assert.strictEqual(
    staleBanner({ stale: false, fetchedAt: '2026-01-01T00:00:00.000Z', partialErrors: [] }),
    null,
  );
});

test('staleBanner names the error and the last-success time for a stale response', () => {
  const now = Date.parse('2026-01-01T03:00:00.000Z');
  const message = staleBanner(
    { stale: true, error: 'network down', fetchedAt: '2026-01-01T00:00:00.000Z', partialErrors: [] },
    now,
  );
  assert.match(String(message), /network down/);
  assert.match(String(message), /3 hours ago/);
});

test('staleBanner falls back to "unknown error" when the response carries none', () => {
  const now = Date.parse('2026-01-01T00:00:30.000Z');
  const message = staleBanner(
    { stale: true, fetchedAt: '2026-01-01T00:00:00.000Z', partialErrors: [] },
    now,
  );
  assert.match(String(message), /unknown error/);
});

test('staleBanner reports a fresh partial response as partial, not as a failed refresh', () => {
  const now = Date.parse('2026-01-01T00:00:10.000Z');
  const message = staleBanner(
    { stale: false, fetchedAt: '2026-01-01T00:00:00.000Z', partialErrors: ['timeout on search'] },
    now,
  );
  // A banner is required: spec:191 asks for the rows that arrived plus what failed, and
  // silence here is the bug — the user cannot tell an incomplete list from a complete one.
  assert.notStrictEqual(message, null);
  assert.match(String(message), /timeout on search/);
  // The fetch just succeeded, so "could not refresh" and "last success N ago" would both
  // be false. This is the assertion that separates partial from stale.
  assert.doesNotMatch(String(message), /could not refresh/i);
  assert.match(String(message), /just now/);
});

test('staleBanner lists every error a partial response carries', () => {
  const message = staleBanner({
    stale: false,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    partialErrors: ['timeout on search', 'rate limited on checks'],
  });
  assert.match(String(message), /timeout on search/);
  assert.match(String(message), /rate limited on checks/);
});

test('staleBanner reports a retained payload that was itself partial as both', () => {
  const now = Date.parse('2026-01-01T03:00:00.000Z');
  const message = staleBanner(
    {
      stale: true,
      error: 'network down',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      partialErrors: ['timeout on search'],
    },
    now,
  );
  assert.match(String(message), /network down/);
  assert.match(String(message), /timeout on search/);
});

test('formatRelativeTime reports "just now" under a minute', () => {
  const now = Date.parse('2026-01-01T00:00:30.000Z');
  assert.strictEqual(formatRelativeTime('2026-01-01T00:00:00.000Z', now), 'just now');
});

test('formatRelativeTime uses singular "minute" for exactly one', () => {
  const now = Date.parse('2026-01-01T00:01:00.000Z');
  assert.strictEqual(formatRelativeTime('2026-01-01T00:00:00.000Z', now), '1 minute ago');
});

test('formatRelativeTime pluralizes minutes', () => {
  const now = Date.parse('2026-01-01T00:05:00.000Z');
  assert.strictEqual(formatRelativeTime('2026-01-01T00:00:00.000Z', now), '5 minutes ago');
});

test('formatRelativeTime reports hours once past 60 minutes', () => {
  const now = Date.parse('2026-01-01T02:00:00.000Z');
  assert.strictEqual(formatRelativeTime('2026-01-01T00:00:00.000Z', now), '2 hours ago');
});

test('formatRelativeTime reports days once past 24 hours', () => {
  const now = Date.parse('2026-01-03T00:00:00.000Z');
  assert.strictEqual(formatRelativeTime('2026-01-01T00:00:00.000Z', now), '2 days ago');
});

test('formatRelativeTime reports an unknown time for an unparseable timestamp', () => {
  assert.strictEqual(formatRelativeTime('not a date', Date.now()), 'an unknown time ago');
});
