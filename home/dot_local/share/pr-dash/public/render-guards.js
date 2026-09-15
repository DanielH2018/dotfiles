// @ts-check
/** @typedef {import('./group.js').Axis} Axis */
/** @typedef {import('./group.js').Sort} Sort */
/** @typedef {import('../src/types.ts').PrRecord} PrRecord */
/** @typedef {import('../src/types.ts').Ci} Ci */
/** @typedef {import('../src/types.ts').Review} Review */

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

/**
 * Every value the `#filter-ci` fieldset's checkboxes carry, in the order
 * `index.html` declares them. A test in render-guards.test.ts asserts these
 * stay in sync with that markup, the same way AXES/SORTS do for the
 * `<select>`s. Typed `readonly Ci[]`, not `readonly string[]`: this is also
 * `validateRecord`'s allowlist for `PrRecord.ci`, so a member outside `Ci`
 * added here must fail `tsc` at the declaration rather than only surface
 * once a real PR record makes `validateRecord` throw.
 * @type {readonly Ci[]}
 */
export const CI_VALUES = ['success', 'failure', 'pending', 'none'];

/**
 * Every value the `#filter-review` fieldset's checkboxes carry, in the
 * order `index.html` declares them. Same reasoning as {@link CI_VALUES}
 * for the `readonly Review[]` type.
 * @type {readonly Review[]}
 */
export const REVIEW_VALUES = ['approved', 'changes_requested', 'review_required', 'none'];

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
    // `typeof x === 'number'` is true for NaN and Infinity too, and both corrupt the render
    // path the same way a wrong type would — sortWithin's comparator returns 0 for any
    // comparison touching NaN, leaving stale/age sort undefined. This boundary exists to
    // catch what upstream got wrong, so it rejects non-finite values, not just wrong types.
    if (typeof fields[field] !== 'number' || !Number.isFinite(fields[field])) {
      invalidField(index, field);
    }
  }
  if (typeof fields['isDraft'] !== 'boolean') invalidField(index, 'isDraft');
  if (!CI_VALUES.includes(/** @type {Ci} */ (fields['ci']))) invalidField(index, 'ci');
  if (!REVIEW_VALUES.includes(/** @type {Review} */ (fields['review']))) invalidField(index, 'review');
  return /** @type {PrRecord} */ (record);
}

/**
 * A parsed and validated `/api/prs` response body.
 * @typedef {object} ParsedPrsBody
 * @property {PrRecord[]} prs
 * @property {boolean} stale
 * @property {string} [error]
 * @property {string} fetchedAt
 * @property {string[]} partialErrors
 */

/**
 * Validates and parses a `/api/prs` response body, throwing when `prs` is
 * not an array or one of its elements fails {@link validateRecord}.
 * `fetch().json()` is typed `any`, so this is the one boundary in the
 * client `tsc` cannot enforce the `PrRecord[]` contract at. Without this
 * check a malformed body — or a single malformed record inside an
 * otherwise-fine array — is assigned to the caller's "last good" state on
 * the success path, before any catch runs; a later fallback render then
 * throws a second, uncaught error instead of recovering.
 *
 * Also extracts `stale`, `error`, and `fetchedAt` — the fields
 * {@link staleBanner} needs — so `app.js` never reads them off the raw
 * body itself; that decision used to live in `app.js`, which cannot be
 * imported under `node --test`, so a broken extraction there went
 * untested. These three are coerced, not validated the way `prs` is:
 * throwing on a malformed `stale` would blank the page over a
 * server-side type slip in the one field that exists to prevent exactly
 * that. Anything not exactly `false` counts as stale — over-reporting
 * staleness is the safe direction, since under-reporting it would
 * present genuinely stale data as fresh.
 * @param {unknown} body
 * @returns {ParsedPrsBody}
 */
export function parsePrsBody(body) {
  if (
    body === null ||
    typeof body !== 'object' ||
    !Array.isArray(/** @type {{ prs?: unknown }} */ (body).prs)
  ) {
    throw new Error('malformed /api/prs response: "prs" is not an array');
  }
  const fields = /** @type {Record<string, unknown>} */ (body);
  const rawPrs = /** @type {unknown[]} */ (fields['prs']);
  const prs = rawPrs.map((record, index) => validateRecord(record, index));
  const stale = fields['stale'] !== false;
  const error = typeof fields['error'] === 'string' ? fields['error'] : undefined;
  const fetchedAt = typeof fields['fetchedAt'] === 'string' ? fields['fetchedAt'] : '';
  // Coerced like the three fields above rather than validated: a malformed
  // `partialErrors` must not blank a page whose rows parsed fine. Keeping only the string
  // members means a junk entry drops out instead of rendering as "[object Object]" in the
  // banner, and a non-array degrades to "nothing known to have failed".
  const raw = fields['partialErrors'];
  const partialErrors = Array.isArray(raw) ? raw.filter((e) => typeof e === 'string') : [];
  return { prs, stale, error, fetchedAt, partialErrors };
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

/**
 * @typedef {object} StoredView
 * @property {Axis} axis
 * @property {Sort} sort
 * @property {Ci[]} ci
 * @property {Review[]} review
 */

/** @type {StoredView} */
const DEFAULT_VIEW = { axis: DEFAULT_AXIS, sort: DEFAULT_SORT, ci: [], review: [] };

/**
 * Keeps only the members of `value` that are strings appearing in
 * `allowed`, dropping anything else — a value of the wrong type, or one an
 * axis no longer admits because the code that wrote it predates a change
 * to that axis's set of values.
 * @template {string} T
 * @param {unknown} value
 * @param {readonly T[]} allowed
 * @returns {T[]}
 */
function toKnownArray(value, allowed) {
  if (!Array.isArray(value)) return [];
  return /** @type {T[]} */ (value.filter((v) => typeof v === 'string' && allowed.includes(/** @type {T} */ (v))));
}

/**
 * Keeps only the members of `value` that are valid CI statuses, the same
 * "drop what's unknown, don't throw" contract {@link toAxis}/{@link toSort}
 * give the `<select>` reads. Used for both the `#filter-ci` checkbox reads
 * and the persisted view's `ci` field, so the two paths that read an
 * untrusted `ci` list — the DOM and localStorage — can't drift apart.
 * @param {unknown} value
 * @returns {Ci[]}
 */
export function toCiValues(value) {
  return toKnownArray(value, CI_VALUES);
}

/**
 * Same contract as {@link toCiValues}, for review states.
 * @param {unknown} value
 * @returns {Review[]}
 */
export function toReviewValues(value) {
  return toKnownArray(value, REVIEW_VALUES);
}

/**
 * Parses the `pr-dash:view` localStorage value into a view the controls
 * can trust. Falls back to {@link DEFAULT_VIEW} — in whole or field by
 * field — for a value that isn't valid JSON, doesn't parse to a plain
 * object, or carries a field the current code doesn't recognize: an axis
 * or sort outside AXES/SORTS, or a `ci`/`review` array holding a status
 * outside {@link CI_VALUES}/{@link REVIEW_VALUES}. The value can also just
 * be old — written by an earlier version of this code — so nothing here is
 * trusted merely because it parsed.
 * @param {string | null} raw
 * @returns {StoredView}
 */
export function parseStoredView(raw) {
  if (raw === null) return { ...DEFAULT_VIEW };
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_VIEW };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...DEFAULT_VIEW };
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed);
  return {
    axis: toAxis(typeof obj['axis'] === 'string' ? obj['axis'] : ''),
    sort: toSort(typeof obj['sort'] === 'string' ? obj['sort'] : ''),
    ci: toCiValues(obj['ci']),
    review: toReviewValues(obj['review']),
  };
}

/**
 * The `getItem`/`setItem`/`removeItem` contract `loadStoredView`,
 * `saveStoredView` and `clearStoredView` need — `localStorage`'s own shape,
 * so it can be passed in directly, and a test double's too.
 * @typedef {object} ViewStorage
 * @property {(key: string) => string | null} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} removeItem
 */

/** The localStorage key the view is persisted under. */
export const VIEW_KEY = 'pr-dash:view';

/**
 * Reads and parses the persisted view from `storage`. A private window,
 * blocked site data, or a store that otherwise throws on `getItem` must
 * not stop the page rendering, so that case falls back to the same
 * default view a corrupt stored value does.
 * @param {ViewStorage} storage
 * @returns {StoredView}
 */
export function loadStoredView(storage) {
  /** @type {string | null} */
  let raw = null;
  try {
    raw = storage.getItem(VIEW_KEY);
  } catch {
    // Falls through to parseStoredView(null), which is the default view.
  }
  return parseStoredView(raw);
}

/**
 * Persists `view` to `storage`. A store that throws on `setItem` (quota
 * exhausted, private window) must not propagate — the view just doesn't
 * persist this time, which isn't worth interrupting the user for.
 * @param {ViewStorage} storage
 * @param {StoredView} view
 */
export function saveStoredView(storage, view) {
  try {
    storage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    // Not persisted this time; the page keeps working either way.
  }
}

/**
 * Clears the persisted view from `storage`. Reset's whole point is to
 * un-stick a filter the user can no longer see or change, so a throw here
 * must not stop the reset itself.
 * @param {ViewStorage} storage
 */
export function clearStoredView(storage) {
  try {
    storage.removeItem(VIEW_KEY);
  } catch {
    // Nothing was persisted, or the store is unavailable either way.
  }
}

/**
 * The `/api/prs` response fields the banner decision reads. Matches the fields
 * `app.js`'s `loadPrs()` already normalizes off the response body.
 * @typedef {object} RefreshOutcome
 * @property {boolean} stale
 * @property {string} [error]
 * @property {string} fetchedAt
 * @property {string[]} partialErrors
 */

/**
 * The banner text for a `/api/prs` response, or `null` when the response is fresh and
 * complete and no banner should show. This is the whole banner decision, not just its
 * wording: `app.js` calls this and only this to decide whether to show a banner, rather
 * than checking `stale` itself, because `app.js` cannot be imported under `node --test`
 * (see the module comment above) and a check left there would go untested.
 *
 * Three outcomes need three different sentences. A stale response is a failed refresh
 * behind retained data, so it names the failure and when the data was last good. A
 * partial response is the opposite case: the fetch succeeded just now and returned only
 * some of the user's PRs, so saying "could not refresh (last success ...)" would be
 * false — the rows are exactly as fresh as `fetchedAt` says. A retained payload that was
 * itself partial is both, and says so, because a user who cannot see the rest of their
 * PRs should not have to infer that from a banner about a refresh failure.
 * @param {RefreshOutcome} data
 * @param {number} [now] Milliseconds since epoch; defaults to `Date.now()`, overridable so tests are deterministic.
 * @returns {string | null}
 */
export function staleBanner(data, now = Date.now()) {
  const when = formatRelativeTime(data.fetchedAt, now);
  const incomplete =
    data.partialErrors.length > 0 ? ` Some PRs are missing: ${data.partialErrors.join('; ')}` : '';

  if (data.stale) {
    const reason = data.error ?? 'unknown error';
    return `Could not refresh (last success ${when}): ${reason}${incomplete}`;
  }
  if (incomplete !== '') return `Showing partial data (fetched ${when}).${incomplete}`;
  return null;
}

/**
 * Renders the gap between `iso` and `now` as "just now", "N minutes ago", "N hours
 * ago", or "N days ago". Elapsed time, not the raw timestamp: a viewer's clock isn't
 * guaranteed to match the server's, and a raw ISO string makes a payload that is two
 * minutes old and one that is five hours old look identical at a glance.
 * @param {string} iso
 * @param {number} [now] Milliseconds since epoch; defaults to `Date.now()`.
 * @returns {string}
 */
export function formatRelativeTime(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'an unknown time ago';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
