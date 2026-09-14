// @ts-check
/** @typedef {import('./group.js').Axis} Axis */
/** @typedef {import('./group.js').Sort} Sort */
/** @typedef {import('../src/types.ts').PrRecord} PrRecord */

// Pulled out of app.js so these can be unit-tested under `node --test`: app.js reads
// `location.hash` at module scope, which throws when imported outside a browser, so
// nothing in app.js can be imported directly from a Node test.

/**
 * Every axis `group.js`'s `groupBy` accepts, in the order `index.html`'s
 * `#group-by` `<select>` declares its `<option>`s. A test in
 * render-guards.test.ts asserts these stay in sync with that markup.
 * @type {readonly Axis[]}
 */
export const AXES = ['repo', 'ci', 'review', 'staleness', 'draft'];

/**
 * Every sort `group.js`'s `sortWithin` accepts, in the order `index.html`'s
 * `#sort-by` `<select>` declares its `<option>`s.
 * @type {readonly Sort[]}
 */
export const SORTS = ['stale', 'age', 'title', 'size'];

const DEFAULT_AXIS = /** @type {Axis} */ ('repo');
const DEFAULT_SORT = /** @type {Sort} */ ('stale');

/**
 * Validates a `<select>` value against the axes `group.js` actually knows,
 * falling back to the default rather than passing an unchecked string
 * through. `groupBy`'s switch has no `default` case, so an axis outside the
 * declared union makes it return a single group keyed `undefined`.
 * @param {string} value
 * @returns {Axis}
 */
export function toAxis(value) {
  return AXES.includes(/** @type {Axis} */ (value)) ? /** @type {Axis} */ (value) : DEFAULT_AXIS;
}

/**
 * Same guard as {@link toAxis}, for the sort `<select>`. `sortWithin`'s
 * switch also has no `default` case, so an unrecognized sort makes it
 * return `undefined` instead of an array and the caller throws on `.map`.
 * @param {string} value
 * @returns {Sort}
 */
export function toSort(value) {
  return SORTS.includes(/** @type {Sort} */ (value)) ? /** @type {Sort} */ (value) : DEFAULT_SORT;
}

// The string- and number-typed fields the render path (groupBy, sortWithin, renderRow)
// actually reads. Not full PrRecord schema validation: repo/title feed .localeCompare and
// throw on a non-string, while staleDays/ageDays/additions/deletions feed arithmetic that
// silently misclassifies or missorts a record on the wrong type rather than throwing —
// staleDays as a string, for instance, falls through stalenessBucket's comparisons into the
// ">7d" bucket with no error at all.
const STRING_FIELDS = ['repo', 'title', 'url'];
const NUMBER_FIELDS = ['number', 'staleDays', 'ageDays', 'additions', 'deletions'];
const CI_VALUES = ['success', 'failure', 'pending', 'none'];
const REVIEW_VALUES = ['approved', 'changes_requested', 'review_required', 'none'];

/**
 * @param {number} index
 * @param {string} field
 * @returns {never}
 */
function invalidField(index, field) {
  throw new Error(`malformed /api/prs response: record ${index} has an invalid "${field}"`);
}

/**
 * Validates one element of a parsed `/api/prs` body against the fields the
 * render path reads, throwing with the record's index and the offending
 * field so a bad response is diagnosable rather than just rejected.
 * @param {unknown} record
 * @param {number} index
 * @returns {PrRecord}
 */
function validateRecord(record, index) {
  if (record === null || typeof record !== 'object') {
    throw new Error(`malformed /api/prs response: record ${index} is not an object`);
  }
  const fields = /** @type {Record<string, unknown>} */ (record);
  for (const field of STRING_FIELDS) {
    if (typeof fields[field] !== 'string') invalidField(index, field);
  }
  for (const field of NUMBER_FIELDS) {
    if (typeof fields[field] !== 'number') invalidField(index, field);
  }
  if (typeof fields['isDraft'] !== 'boolean') invalidField(index, 'isDraft');
  if (!CI_VALUES.includes(/** @type {string} */ (fields['ci']))) invalidField(index, 'ci');
  if (!REVIEW_VALUES.includes(/** @type {string} */ (fields['review']))) invalidField(index, 'review');
  return /** @type {PrRecord} */ (record);
}

/**
 * Validates a parsed `/api/prs` response body, throwing when `prs` is not
 * an array or one of its elements fails {@link validateRecord}.
 * `fetch().json()` is typed `any`, so this is the one boundary in the
 * client `tsc` cannot enforce the `PrRecord[]` contract at. Without this
 * check a malformed body — or a single malformed record inside an
 * otherwise-fine array — is assigned to the caller's "last good" state on
 * the success path, before any catch runs; a later fallback render then
 * throws a second, uncaught error instead of recovering.
 * @param {unknown} body
 * @returns {PrRecord[]}
 */
export function parsePrsBody(body) {
  if (
    body === null ||
    typeof body !== 'object' ||
    !Array.isArray(/** @type {{ prs?: unknown }} */ (body).prs)
  ) {
    throw new Error('malformed /api/prs response: "prs" is not an array');
  }
  const prs = /** @type {{ prs: unknown[] }} */ (body).prs;
  return prs.map((record, index) => validateRecord(record, index));
}

/**
 * Whether `url` is safe to assign to an anchor's `href`. A `PrRecord.url`
 * comes from GitHub's API and should always be `http(s)`, but nothing in
 * the type system enforces that once it reaches the DOM — an unchecked
 * `javascript:` or `data:` value would otherwise become a clickable link.
 * @param {string} url
 * @returns {boolean}
 */
export function isSafeUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
