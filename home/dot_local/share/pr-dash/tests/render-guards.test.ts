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
  toStalenessValues,
  toDraftValues,
  toCollapsedKeys,
  parsePrsBody,
  emptyStateMessage,
  isSafeUrl,
  parseStoredView,
  loadStoredView,
  saveStoredView,
  clearStoredView,
  VIEW_KEY,
  staleBanner,
  formatRelativeTime,
  nextPollState,
  isPermanentFailure,
  isStaleResponse,
  REFRESH_POLL_MS,
  REFRESH_POLL_TIMEOUT_MS,
  ciChip,
  reviewChip,
  stackIndentPx,
  STACK_INDENT_CAP,
  STACK_INDENT_STEP,
} from '../public/render-guards.js';
import {
  DRAFT_STATES,
  groupBy,
  STALENESS_BUCKETS,
  stalenessBucket,
  summaryChips,
} from '../public/group.js';
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
  // `[^>]*` after the id: #filter-personal carries a `hidden` attribute as well.
  const fieldset = new RegExp(
    `<fieldset id="${fieldsetId}"[^>]*>([\\s\\S]*?)</fieldset>`,
  ).exec(html);
  assert.ok(fieldset, `no <fieldset id="${fieldsetId}"> found in index.html`);
  const values: string[] = [];
  const inputPattern = /<input type="checkbox" value="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = inputPattern.exec(fieldset[1]!))) {
    values.push(match[1]!);
  }
  return values;
}

/**
 * Extracts the label text of the `<button id="buttonId">` in `index.html` — the button
 * equivalent of {@link optionValues} and {@link checkboxValues}, so a message that names a
 * control and the control's own label cannot silently drift apart.
 */
function buttonLabel(html: string, buttonId: string): string {
  const button = new RegExp(`<button id="${buttonId}"[^>]*>([^<]*)</button>`).exec(html);
  assert.ok(button, `no <button id="${buttonId}"> found in index.html`);
  return button[1]!.trim();
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
 *
 * `edgeInvalid` carries the cases `breakField` cannot express. For a string
 * field that is a value of the wrong type, which is a different check from
 * `breakField`'s absence: with only the absence case, narrowing
 * `typeof x !== 'string'` to `x === undefined` leaves the whole suite green
 * while a numeric `repo` reaches `localeCompare` and throws deep inside
 * group.js. The three string rows use three different wrong types rather
 * than one shape copied twice, since a validator can be wrong about a
 * number and right about an array.
 */
const FIELD_SPECS: {
  field: string;
  kind: FieldKind;
  edgeValid?: unknown;
  edgeInvalid?: unknown;
}[] = [
  { field: 'repo', kind: 'string', edgeInvalid: 42 },
  { field: 'title', kind: 'string', edgeValid: '', edgeInvalid: null },
  { field: 'url', kind: 'string', edgeInvalid: ['https://github.com/x/y/pull/1'] },
  { field: 'number', kind: 'number', edgeValid: 0 },
  // NaN and Infinity both pass `typeof x === 'number'`, so a numeric field needs its own
  // edgeInvalid case rather than relying on breakField's "wrong type" coverage: normalize.ts
  // has its own reasons never to emit either, but this guard exists precisely to catch what
  // upstream got wrong, so it must reject a non-finite number even if nothing here does.
  // Both halves of `Number.isFinite` need a case: with NaN alone, narrowing the check to
  // `Number.isNaN` leaves the suite green and an infinite staleDays passes validation.
  { field: 'staleDays', kind: 'number', edgeValid: 0, edgeInvalid: NaN },
  { field: 'ageDays', kind: 'number', edgeValid: 0, edgeInvalid: Infinity },
  { field: 'additions', kind: 'number', edgeValid: 0, edgeInvalid: -Infinity },
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

// The staleness and draft filters reuse group.js's own value lists rather than declaring a
// second copy, so these read the same constants groupBy and stalenessBucket use. A bucket
// renamed in group.js therefore fails here unless index.html is renamed with it.
test('STALENESS_BUCKETS matches the #filter-staleness fieldset checkboxes in index.html', () => {
  assert.deepStrictEqual(STALENESS_BUCKETS, checkboxValues(indexHtml, 'filter-staleness'));
});

test('DRAFT_STATES matches the #filter-draft fieldset checkboxes in index.html', () => {
  assert.deepStrictEqual(DRAFT_STATES, checkboxValues(indexHtml, 'filter-draft'));
});

test('every staleness checkbox value is a bucket stalenessBucket can actually return', () => {
  // The markup-sync test above compares two lists that could agree with each other and
  // both be wrong. This one goes through the function: a bucket no staleDays maps to would
  // be a filter option that always matches nothing.
  const reachable = new Set([0, 1, 2, 3, 4, 7, 8, 30, 365].map((d) => stalenessBucket(d)));
  for (const value of checkboxValues(indexHtml, 'filter-staleness')) {
    assert.ok(reachable.has(value as (typeof STALENESS_BUCKETS)[number]), `no staleDays maps to "${value}"`);
  }
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
  'parsePrsBody throws before it returns, so a caller that assigns only from its ' +
    'result keeps the previous rows and can re-render them without throwing again',
  () => {
    // What this pins is parsePrsBody's own timing: it validates every element before
    // returning anything, so a caller assigning only from its result still holds the last
    // good value when it throws. That is the property the recovery path depends on, and it
    // is exercised here through the real parsePrsBody and the real groupBy.
    //
    // The refresh()-shaped scaffolding around them is a mirror, not a gate: it
    // re-implements app.js's control flow rather than importing it, so it cannot catch a
    // change in app.js. app.js stays unpinned by design — it reads `location.hash` at
    // module scope, so it cannot be imported under `node --test` and there is no jsdom.
    //
    // With the per-element check removed, groupBy's `a.key.localeCompare(b.key)` throws on
    // the second (malformed) record's undefined `repo`, inside the fallback render too,
    // uncaught. That is the double fault this boundary exists to prevent.
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

test('parsePrsBody validates a stack node, naming where in the forest it sits', () => {
  // `stacks` is the other field the render path consumes, and it used to be cast straight
  // off the raw body while `prs` went through this boundary. A node missing `children`
  // crashes indexStacks, and the catch would then re-render the same bad value and throw
  // again, uncaught — the exact double fault the prs check exists to prevent.
  assert.throws(
    () => parsePrsBody({ prs: [validRecord], stacks: [{ pr: validRecord, depth: 0 }] }),
    /stack node 0/,
  );
  assert.throws(
    () =>
      parsePrsBody({
        prs: [validRecord],
        stacks: [
          {
            pr: validRecord,
            children: [{ pr: { ...validRecord, repo: 7 }, children: [], depth: 1, position: 2, stackSize: 2, danglingBase: false, ambiguousBase: false }],
            depth: 0,
            position: 1,
            stackSize: 2,
            danglingBase: false,
            ambiguousBase: false,
          },
        ],
      }),
    /stack node 0\.0 has an invalid "repo"/,
  );
});

/** A well-formed root node, for the non-finite cases below to break one field of. */
const validStackNode = {
  pr: validRecord,
  children: [],
  depth: 0,
  position: 1,
  stackSize: 1,
  danglingBase: false,
  ambiguousBase: false,
};

// `validateRecord`'s numeric loop rejects non-finite values and three tests pin that.
// `validateStackNode`'s own loop over depth/position/stackSize had the same check and
// nothing exercising it: dropping `|| !Number.isFinite(...)` from it left the whole suite
// green. A node with `depth: Infinity` renders `marginLeft: 'Infinitypx'` and a position of
// `NaN/3`, so the check is right — it was only unpinned.
//
// Each field gets a different non-finite value rather than three copies of one: Infinity,
// -Infinity and NaN reach `Number.isFinite` by different routes, and a fixture set that
// shares one shape is how a defect hides behind five passing tests.
for (const [field, value] of [
  ['depth', Number.POSITIVE_INFINITY],
  ['position', Number.NEGATIVE_INFINITY],
  ['stackSize', Number.NaN],
] as const) {
  test(`parsePrsBody rejects a stack node whose ${field} is not finite`, () => {
    assert.throws(
      () => parsePrsBody({ prs: [validRecord], stacks: [{ ...validStackNode, [field]: value }] }),
      new RegExp(`stack node 0 has an invalid "${field}"`),
    );
  });
}

// The absent-stacks test above says in prose that a present-but-malformed `stacks` throws
// instead. Nothing backed that claim: changing the non-array branch from `invalidField` to
// `[]` left the suite green, because every existing fixture puts its malformation *inside*
// the array or omits the field. A false coverage claim is worse than a silent gap — the
// next reader stops looking.
for (const stacks of ['nope', 7, true, { 0: validStackNode }] as const) {
  test(`parsePrsBody throws on a present but non-array stacks (${typeof stacks})`, () => {
    assert.throws(
      () => parsePrsBody({ prs: [validRecord], stacks }),
      /response body has an invalid "stacks"/,
    );
  });
}

// `null` is its own case: it is the one non-array value that `Array.isArray` and a
// `=== undefined` check disagree about, so a guard written as `stacks == null ? [] : ...`
// would treat it as absent rather than malformed.
test('parsePrsBody throws on a null stacks rather than treating it as absent', () => {
  assert.throws(
    () => parsePrsBody({ prs: [validRecord], stacks: null }),
    /response body has an invalid "stacks"/,
  );
});

test('parsePrsBody returns a well-formed forest unchanged, nesting included', () => {
  const child = {
    pr: { ...validRecord, id: 'x/y#2', number: 2 },
    children: [],
    depth: 1,
    position: 2,
    stackSize: 2,
    danglingBase: false,
    ambiguousBase: false,
  };
  const root = {
    pr: validRecord,
    children: [child],
    depth: 0,
    position: 1,
    stackSize: 2,
    danglingBase: false,
    ambiguousBase: true,
  };
  const parsed = parsePrsBody({ prs: [validRecord], stacks: [root] });
  assert.deepStrictEqual(parsed.stacks, [root]);
});

test('parsePrsBody treats an absent stacks as an empty forest', () => {
  // Rows then render flat with no badges, which is what a response carrying no forest
  // means. A present-but-malformed `stacks` is a type violation and throws instead.
  assert.deepStrictEqual(parsePrsBody({ prs: [validRecord] }).stacks, []);
});

test('parsePrsBody passes the work organizations through, keeping only the strings', () => {
  const body = { prs: [], stale: false, fetchedAt: '', workOrgs: ['acme', 7, null, 'acme-labs'] };
  assert.deepStrictEqual(parsePrsBody(body).workOrgs, ['acme', 'acme-labs']);
});

test('parsePrsBody reads a missing or malformed workOrgs as no constraint', () => {
  // `chezmoi apply` deploys this client under a still-running older server whose response
  // carries no `workOrgs` at all. Throwing there would fail every poll until the launchd
  // job is reloaded; an empty list means every repository counts as work, which is what
  // the dashboard showed before the toggle existed.
  assert.deepStrictEqual(parsePrsBody({ prs: [], stale: false, fetchedAt: '' }).workOrgs, []);
  assert.deepStrictEqual(
    parsePrsBody({ prs: [], stale: false, fetchedAt: '', workOrgs: 'acme' }).workOrgs,
    [],
  );
});

test('emptyStateMessage tells "no open PRs" apart from "filters hid them all"', () => {
  // spec:172-173 justifies the Reset control with exactly this problem: a saved filter
  // state that cannot be cleared is a trap because the dashboard looks empty and the
  // reason is invisible. Two blank pages for two unrelated situations is that trap.
  const noPrs = emptyStateMessage({ total: 0, inScope: 0, visible: 0 });
  const allFiltered = emptyStateMessage({ total: 4, inScope: 4, visible: 0 });
  assert.notStrictEqual(noPrs, null);
  assert.notStrictEqual(allFiltered, null);
  assert.notStrictEqual(noPrs, allFiltered);
  assert.match(String(allFiltered), /Reset view/);
  assert.doesNotMatch(String(noPrs), /filter/i);
});

test('emptyStateMessage returns null when there is anything to render', () => {
  assert.strictEqual(emptyStateMessage({ total: 4, inScope: 4, visible: 1 }), null);
});

// The plural helper covered PR/PRs but not is/are, so a single hidden PR read "All 1 PR are
// hidden by the active filters."
test('emptyStateMessage agrees in number with a single hidden PR', () => {
  const one = String(emptyStateMessage({ total: 1, inScope: 1, visible: 0 }));
  assert.match(one, /All 1 PR is hidden/);
  assert.doesNotMatch(one, /PRs/);
});

test('emptyStateMessage stays plural for more than one hidden PR', () => {
  assert.match(
    String(emptyStateMessage({ total: 2, inScope: 2, visible: 0 })),
    /All 2 PRs are hidden/,
  );
});

// Reset view clears the filters and leaves Personal off, so the two hidden cases need
// different messages: telling a user whose only PRs are personal to reset would name a
// control that changes nothing about why the page is blank.
test('emptyStateMessage names Personal, not Reset view, when the toggle hid everything', () => {
  const message = String(emptyStateMessage({ total: 3, inScope: 0, visible: 0 }));
  assert.match(message, /Personal/);
  assert.doesNotMatch(message, /Reset view/);
  assert.match(message, /All 3 PRs are/);
});

test('emptyStateMessage counts only the in-scope PRs when the filters hid the rest', () => {
  // `total` includes the personal PRs the toggle already removed, so reporting it here
  // would tell the user the filters are hiding PRs those filters never saw.
  assert.match(
    String(emptyStateMessage({ total: 9, inScope: 2, visible: 0 })),
    /All 2 PRs are hidden by the active filters/,
  );
});

// The message points the user at a control by name. Every other control label in this
// markup has a sync test; this one was hardcoded in two places, so renaming the button in
// index.html would leave the message naming a control that no longer exists.
test('emptyStateMessage names the reset control by its real label in index.html', () => {
  const label = buttonLabel(indexHtml, 'reset');
  assert.ok(label.length > 0, 'expected the reset button to carry a label');
  const message = String(emptyStateMessage({ total: 4, inScope: 4, visible: 0 }));
  assert.ok(
    message.includes(label),
    `expected ${JSON.stringify(message)} to name the reset button's label ${JSON.stringify(label)}`,
  );
});

// Same reasoning as the reset-label test above: the message points at a control by name,
// and the two would otherwise be two independent hardcodings of the same word.
test('the personal-only message names the toggle by its real value in index.html', () => {
  const values = checkboxValues(indexHtml, 'filter-personal');
  assert.deepStrictEqual(values, ['personal'], 'expected one checkbox, valued "personal"');
  const message = String(emptyStateMessage({ total: 2, inScope: 0, visible: 0 }));
  assert.match(message, new RegExp(values[0]!, 'i'));
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

const DEFAULT_VIEW: StoredView = {
  axis: 'repo',
  sort: 'stale',
  ci: [],
  review: [],
  staleness: [],
  draft: [],
  personal: false,
  collapsed: [],
  expandedStacks: [],
};

test('parseStoredView defaults personal to off, so the dashboard opens on work PRs alone', () => {
  assert.strictEqual(parseStoredView(null).personal, false);
  // A view written before the toggle existed carries no `personal` key at all, and must
  // land on the same default rather than on `undefined`.
  assert.strictEqual(parseStoredView(JSON.stringify({ axis: 'repo' })).personal, false);
  assert.strictEqual(parseStoredView(JSON.stringify({ personal: 'yes' })).personal, false);
  assert.strictEqual(parseStoredView(JSON.stringify({ personal: true })).personal, true);
});

test('parseStoredView keeps expandedStacks as the stack exceptions, defaulting to none', () => {
  // Empty means every stack is folded, which is the default state — the inverse of
  // `collapsed`, where empty means everything is open.
  assert.deepStrictEqual(parseStoredView(null).expandedStacks, []);
  const stored = JSON.stringify({ expandedStacks: ['acme/api#1', 7, null] });
  assert.deepStrictEqual(parseStoredView(stored).expandedStacks, ['acme/api#1']);
});

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

test('toStalenessValues keeps known buckets and drops the rest', () => {
  assert.deepStrictEqual(toStalenessValues(['>7d', '1-3d']), ['>7d', '1-3d']);
  assert.deepStrictEqual(toStalenessValues(['>7d', '4-9d', 7, null]), ['>7d']);
  assert.deepStrictEqual(toStalenessValues('>7d'), []);
});

test('toDraftValues keeps known states and drops the rest', () => {
  assert.deepStrictEqual(toDraftValues(['draft']), ['draft']);
  assert.deepStrictEqual(toDraftValues(['ready', 'maybe']), ['ready']);
  assert.deepStrictEqual(toDraftValues({ draft: true }), []);
});

test('an empty staleness or draft list is no constraint, not "match nothing"', () => {
  // An inversion here makes the dashboard start blank, with nothing on screen saying why.
  assert.deepStrictEqual(toStalenessValues([]), []);
  assert.deepStrictEqual(toDraftValues([]), []);
  assert.deepStrictEqual(parseStoredView(null).staleness, []);
  assert.deepStrictEqual(parseStoredView(null).draft, []);
});

test('parseStoredView round-trips the staleness and draft axes', () => {
  const stored = JSON.stringify({
    axis: 'repo',
    sort: 'stale',
    ci: [],
    review: [],
    staleness: ['1-3d', '>7d'],
    draft: ['draft'],
  });
  assert.deepStrictEqual(parseStoredView(stored), {
    ...DEFAULT_VIEW,
    staleness: ['1-3d', '>7d'],
    draft: ['draft'],
  });
});

test('parseStoredView drops a staleness bucket the current code does not know', () => {
  const stored = JSON.stringify({ staleness: ['1-3d', '4-9d'], draft: ['almost-ready'] });
  const parsed = parseStoredView(stored);
  assert.deepStrictEqual(parsed.staleness, ['1-3d']);
  assert.deepStrictEqual(parsed.draft, []);
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
  assert.deepStrictEqual(loadStoredView(storage), {
    ...DEFAULT_VIEW,
    axis: 'ci',
    sort: 'age',
    ci: ['failure'],
  });
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
  const view: StoredView = {
    axis: 'ci',
    sort: 'age',
    ci: ['failure'],
    review: ['approved'],
    staleness: ['>7d'],
    draft: ['ready'],
    personal: true,
    collapsed: ['acme/api'],
    expandedStacks: ['acme/api#1'],
  };
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

test('toCollapsedKeys keeps strings and drops everything else', () => {
  // Duplicates are left in place, not collapsed here: applyView, the one caller, wraps
  // the result in `new Set(...)`, which already dedupes.
  assert.deepStrictEqual(
    toCollapsedKeys(['acme/api', 'acme/api', 42, null, 'acme/web', undefined]),
    ['acme/api', 'acme/api', 'acme/web'],
  );
});

test('toCollapsedKeys of a non-array is empty, but a valid array still passes through', () => {
  assert.deepStrictEqual(toCollapsedKeys('acme/api'), []);
  assert.deepStrictEqual(toCollapsedKeys({ 0: 'acme/api' }), []);
  assert.deepStrictEqual(toCollapsedKeys(undefined), []);
  assert.deepStrictEqual(toCollapsedKeys(['acme/api']), ['acme/api']);
});

test('an unknown collapse key survives parsing rather than being rejected', () => {
  // Collapse keys legitimately outlive the payload they described: a merged PR or a
  // repository with nothing open leaves a key nothing reads. Dropping the whole view over
  // one would un-collapse everything after any PR merged.
  const view = parseStoredView(JSON.stringify({ collapsed: ['gone/repo', 'acme/api#9'] }));
  assert.deepStrictEqual(view.collapsed, ['gone/repo', 'acme/api#9']);
});

test('the default view collapses nothing', () => {
  assert.deepStrictEqual(parseStoredView(null).collapsed, []);
});

test('a corrupt collapsed field falls back without discarding the rest of the view', () => {
  const view = parseStoredView(JSON.stringify({ sort: 'age', collapsed: 'nope' }));
  assert.deepStrictEqual(view.collapsed, []);
  assert.strictEqual(view.sort, 'age', 'one bad field must not reset the others');
});

test('collapse state round-trips through storage', () => {
  const store = fakeStorage();
  saveStoredView(store, { ...parseStoredView(null), collapsed: ['acme/api'] });
  assert.deepStrictEqual(loadStoredView(store).collapsed, ['acme/api']);
});

test('clearStoredView clears collapse state along with the filters', () => {
  // Reset exists to un-stick a view the user can no longer see or change. A dashboard
  // collapsed to nothing is exactly that trap, so collapse must not survive a reset.
  const store = fakeStorage();
  saveStoredView(store, { ...parseStoredView(null), collapsed: ['acme/api'], ci: ['failure'] });
  clearStoredView(store);
  const after = loadStoredView(store);
  assert.deepStrictEqual(after.collapsed, []);
  assert.deepStrictEqual(after.ci, []);
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
  // Both clauses in one banner need a sentence break between them, or the upstream reason
  // runs straight into the next sentence: "... network down Some PRs are missing: ...".
  assert.match(String(message), /network down\. Some PRs are missing/);
});

test('staleBanner does not double the full stop when the reason ends in one', () => {
  // github.ts's rate-limit message is already a pair of sentences, so the separator above
  // has to be conditional rather than appended unconditionally.
  const message = staleBanner({
    stale: true,
    error: 'GitHub rate-limited this request (429). Retry after 30s.',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    partialErrors: ['timeout on search'],
  });
  assert.doesNotMatch(String(message), /\.\./);
  assert.match(String(message), /Retry after 30s\. Some PRs are missing/);
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

test('parsePrsBody reports a refreshing response', () => {
  const parsed = parsePrsBody({
    prs: [],
    stacks: [],
    stale: true,
    fetchedAt: 'OLD',
    partialErrors: [],
    refreshing: true,
  });

  assert.strictEqual(parsed.refreshing, true);
});

test('parsePrsBody treats an absent or non-true refreshing as not refreshing', () => {
  const base = { prs: [], stacks: [], stale: false, fetchedAt: 'NEW', partialErrors: [] };

  assert.strictEqual(parsePrsBody(base).refreshing, false);
  assert.strictEqual(parsePrsBody({ ...base, refreshing: 'yes' }).refreshing, false);
});

test('a refreshing payload is named as the last saved list, not as a failed refresh', () => {
  const message = staleBanner(
    {
      stale: true,
      fetchedAt: '2026-09-15T06:00:00.000Z',
      partialErrors: [],
      refreshing: true,
    },
    Date.parse('2026-09-15T09:00:00.000Z'),
  );

  assert.strictEqual(message, 'Showing the last saved list (3 hours ago) while it refreshes.');
});

test('a refreshing payload that was itself partial says both', () => {
  const message = staleBanner(
    {
      stale: true,
      fetchedAt: '2026-09-15T06:00:00.000Z',
      partialErrors: ['acme/api timed out'],
      refreshing: true,
    },
    Date.parse('2026-09-15T09:00:00.000Z'),
  );

  assert.strictEqual(
    message,
    'Showing the last saved list (3 hours ago) while it refreshes. Some PRs are missing: acme/api timed out',
  );
});

test('a failed refresh still names the failure, not the refresh', () => {
  const message = staleBanner(
    {
      stale: true,
      error: 'network down',
      fetchedAt: '2026-09-15T06:00:00.000Z',
      partialErrors: [],
    },
    Date.parse('2026-09-15T09:00:00.000Z'),
  );

  assert.strictEqual(message, 'Could not refresh (last success 3 hours ago): network down.');
});

test('a refreshing payload that also carries an error is named as a failure, not a refresh', () => {
  // Fix round 2: refreshing and a failed refresh both set stale: true with nothing else
  // distinguishing them, so a response carrying both must not be read as the harmless case.
  const message = staleBanner(
    {
      stale: true,
      error: 'network down',
      fetchedAt: '2026-09-15T06:00:00.000Z',
      partialErrors: [],
      refreshing: true,
    },
    Date.parse('2026-09-15T09:00:00.000Z'),
  );

  assert.strictEqual(message, 'Could not refresh (last success 3 hours ago): network down.');
});

test('REFRESH_POLL_MS is 600', () => {
  // Pinned against a literal, not derived from the module under test: the behavioural
  // tests below assert waitMs === REFRESH_POLL_MS, which pins the logic but not the value
  // itself -- REFRESH_POLL_MS = 0 would still make that comparison true.
  assert.strictEqual(REFRESH_POLL_MS, 600);
});

test('REFRESH_POLL_TIMEOUT_MS is 60000', () => {
  assert.strictEqual(REFRESH_POLL_TIMEOUT_MS, 60_000);
});

test('a response that is not refreshing clears the poll state', () => {
  const { state, waitMs, gaveUp } = nextPollState({ since: 1000 }, { refreshing: false }, 2000);
  assert.deepStrictEqual(state, { since: null });
  assert.strictEqual(waitMs, null);
  // Not refreshing at all is a normal stop, not a give-up: the banner must not be
  // replaced with "click Refresh" every time a plain, complete response arrives.
  assert.strictEqual(gaveUp, false);
});

test('the first refreshing response starts the budget at now and asks for a wait', () => {
  const { state, waitMs, gaveUp } = nextPollState({ since: null }, { refreshing: true }, 1000);
  assert.deepStrictEqual(state, { since: 1000 });
  assert.strictEqual(waitMs, REFRESH_POLL_MS);
  assert.strictEqual(gaveUp, false);
});

test('a refreshing response inside the budget keeps the original start time', () => {
  const { state, waitMs, gaveUp } = nextPollState(
    { since: 1000 },
    { refreshing: true },
    1000 + REFRESH_POLL_TIMEOUT_MS - 1,
  );
  assert.deepStrictEqual(state, { since: 1000 });
  assert.strictEqual(waitMs, REFRESH_POLL_MS);
  assert.strictEqual(gaveUp, false);
});

test('a refreshing response past the timeout gives up and clears the state', () => {
  const { state, waitMs, gaveUp } = nextPollState(
    { since: 1000 },
    { refreshing: true },
    1000 + REFRESH_POLL_TIMEOUT_MS,
  );
  // Cleared, not just stopped: a later refreshing response must get a fresh budget rather
  // than being measured against this spent start time.
  assert.deepStrictEqual(state, { since: null });
  assert.strictEqual(waitMs, null);
  // This is the one transition `app.js` must tell apart from an ordinary "stopped
  // refreshing": only here has the poll loop actually given up rather than finished.
  assert.strictEqual(gaveUp, true);
});

test('staleBanner names Refresh, not just "Refreshing", when gaveUp is true', () => {
  // /Refresh/ alone also matches "Refreshing timed out", the sentence that opens this
  // message -- deleting the clause that actually names Refresh as the way forward would
  // still pass that looser check.
  const message = staleBanner(
    { stale: true, fetchedAt: '2026-09-15T06:00:00.000Z', partialErrors: [], refreshing: true },
    Date.parse('2026-09-15T06:30:00.000Z'),
    true,
  );
  assert.match(String(message), /\bRefresh\b/);
  assert.match(String(message), /30 minutes ago/);
});

test('staleBanner keeps the last-good time and the partial-errors clause when giving up', () => {
  // Fix B originally replaced staleBanner's whole message rather than extending it, which
  // meant an operator on the give-up path lost the last-good time and never learned a
  // repository was missing from the list. This composite -- refreshing, past the budget,
  // and carrying partialErrors -- is what that regression looked like.
  const message = staleBanner(
    {
      stale: true,
      fetchedAt: '2026-09-15T06:00:00.000Z',
      partialErrors: ['acme/web: 502 from GitHub'],
      refreshing: true,
    },
    Date.parse('2026-09-15T06:30:00.000Z'),
    true,
  );
  assert.match(String(message), /30 minutes ago/);
  assert.match(String(message), /acme\/web: 502 from GitHub/);
  assert.match(String(message), /\bRefresh\b/);
});

test('gaveUp is ignored once a refreshing response also carries a failure', () => {
  // The failure branch already takes precedence over "while it refreshes" for a response
  // carrying both refreshing and error (see the fix-round-2 test above); gaveUp must not
  // resurrect the refreshing wording for that case.
  const message = staleBanner(
    {
      stale: true,
      error: 'network down',
      fetchedAt: '2026-09-15T06:00:00.000Z',
      partialErrors: [],
      refreshing: true,
    },
    Date.parse('2026-09-15T09:00:00.000Z'),
    true,
  );
  assert.strictEqual(message, 'Could not refresh (last success 3 hours ago): network down.');
});

test('isPermanentFailure treats 4xx as permanent and everything else as worth retrying', () => {
  assert.strictEqual(isPermanentFailure(400), true);
  assert.strictEqual(isPermanentFailure(403), true);
  assert.strictEqual(isPermanentFailure(499), true);
  assert.strictEqual(isPermanentFailure(500), false);
  assert.strictEqual(isPermanentFailure(399), false);
  assert.strictEqual(isPermanentFailure(undefined), false);
});

test('isStaleResponse is true once a newer request has started', () => {
  assert.strictEqual(isStaleResponse(1, 2), true);
  assert.strictEqual(isStaleResponse(2, 2), false);
});

test('ciChip renders an absent CI state as nothing, and every present one as a toned chip', () => {
  assert.deepStrictEqual(ciChip('success'), { label: 'passing', tone: 'good' });
  assert.deepStrictEqual(ciChip('failure'), { label: 'failing', tone: 'bad' });
  assert.deepStrictEqual(ciChip('pending'), { label: 'pending', tone: 'warn' });
  // Not a chip reading "none": the row used to print `none · none · 12d`.
  assert.strictEqual(ciChip('none'), null);
});

test('reviewChip renders an absent review state as nothing, and every present one as a toned chip', () => {
  assert.deepStrictEqual(reviewChip('approved'), { label: 'approved', tone: 'good' });
  assert.deepStrictEqual(reviewChip('changes_requested'), { label: 'changes', tone: 'bad' });
  assert.deepStrictEqual(reviewChip('review_required'), { label: 'waiting', tone: 'warn' });
  assert.strictEqual(reviewChip('none'), null);
});

test('a row chip and the header chip for the same state read the same word', () => {
  // The oracle is group.js, not this file: `summaryChips` owns the words a header shows, so
  // renaming a row chip in isolation fails here. A header reading "3 failing" beside rows
  // reading anything else is two vocabularies for one state.
  const headerWords = new Map(
    summaryChips({
      total: 4,
      ci: { success: 1, failure: 1, pending: 1, none: 1 },
      review: { approved: 1, changes_requested: 1, review_required: 1, none: 1 },
    }).map((chip) => [chip.label.replace(/^\d+ /, ''), chip.tone]),
  );

  for (const [chip, state] of [
    [ciChip('failure'), 'ci failure'],
    [ciChip('pending'), 'ci pending'],
    [reviewChip('approved'), 'review approved'],
    [reviewChip('changes_requested'), 'review changes_requested'],
    [reviewChip('review_required'), 'review review_required'],
  ] as const) {
    assert.ok(chip !== null, `expected a chip for ${state}`);
    assert.strictEqual(
      headerWords.get(chip.label),
      chip.tone,
      `expected the header chip "${chip.label}" for ${state} to carry the same tone as the row's`,
    );
  }
});

test('stackIndentPx indents up to the cap and no further', () => {
  assert.strictEqual(stackIndentPx(0), 0);
  assert.strictEqual(stackIndentPx(1), STACK_INDENT_STEP);
  assert.strictEqual(stackIndentPx(STACK_INDENT_CAP), STACK_INDENT_CAP * STACK_INDENT_STEP);
  // A 10-deep stack is real on this dashboard; uncapped it started its last title ~200px in.
  assert.strictEqual(stackIndentPx(9), STACK_INDENT_CAP * STACK_INDENT_STEP);
  assert.strictEqual(stackIndentPx(400), STACK_INDENT_CAP * STACK_INDENT_STEP);
});

test('stackIndentPx never returns a negative indent', () => {
  assert.strictEqual(stackIndentPx(-1), 0);
});

test('collapse-all, expand-all, reset and refresh are real buttons with a real label', () => {
  // buttonLabel itself asserts a `<button id="...">` match, so a control demoted to a `<div>`
  // fails here rather than passing a check that only greps for the id attribute.
  for (const id of ['collapse-all', 'expand-all', 'reset', 'refresh']) {
    const label = buttonLabel(indexHtml, id);
    assert.ok(label.length > 0, `expected the ${id} button to carry a label`);
  }
});

