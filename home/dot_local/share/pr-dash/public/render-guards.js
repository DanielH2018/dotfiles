// @ts-check
import { DRAFT_STATES, STALENESS_BUCKETS } from './group.js';

/** @typedef {import('./group.js').Axis} Axis */
/** @typedef {import('./group.js').Sort} Sort */
/** @typedef {import('./group.js').StalenessBucket} StalenessBucket */
/** @typedef {import('./group.js').DraftState} DraftState */
/** @typedef {import('../src/types.ts').PrRecord} PrRecord */
/** @typedef {import('../src/types.ts').StackNode} StackNode */
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
 * @param {string} label
 * @param {string} field
 * @returns {never}
 */
function invalidField(label, field) {
  throw new Error(`malformed /api/prs response: ${label} has an invalid "${field}"`);
}

/**
 * Validates one PR record against the fields the render path reads, throwing with `label`
 * and the offending field so a bad response is diagnosable rather than just rejected.
 * `label` names where the record sits — `record 3` in `prs`, `stack node 0.1` in the
 * forest — because the same record shape arrives by both routes.
 * @param {unknown} record
 * @param {string} label
 * @returns {PrRecord}
 */
function validateRecord(record, label) {
  if (record === null || typeof record !== 'object') {
    throw new Error(`malformed /api/prs response: ${label} is not an object`);
  }
  const fields = /** @type {Record<string, unknown>} */ (record);
  for (const field of STRING_FIELDS) {
    if (typeof fields[field] !== 'string') invalidField(label, field);
  }
  for (const field of NUMBER_FIELDS) {
    // `typeof x === 'number'` is true for NaN and Infinity too, and both corrupt the render
    // path the same way a wrong type would — sortWithin's comparator returns 0 for any
    // comparison touching NaN, leaving stale/age sort undefined. This boundary exists to
    // catch what upstream got wrong, so it rejects non-finite values, not just wrong types.
    if (typeof fields[field] !== 'number' || !Number.isFinite(fields[field])) {
      invalidField(label, field);
    }
  }
  if (typeof fields['isDraft'] !== 'boolean') invalidField(label, 'isDraft');
  if (!CI_VALUES.includes(/** @type {Ci} */ (fields['ci']))) invalidField(label, 'ci');
  if (!REVIEW_VALUES.includes(/** @type {Review} */ (fields['review']))) invalidField(label, 'review');
  return /** @type {PrRecord} */ (record);
}

/** The numeric fields every stack node carries, all of them read by the render path. */
const STACK_NUMBER_FIELDS = ['depth', 'position', 'stackSize'];

/** The boolean flags every stack node carries, each one a badge on the row. */
const STACK_BOOLEAN_FIELDS = ['danglingBase', 'ambiguousBase'];

/**
 * Validates one stack node and its descendants. `path` is the node's position in the
 * forest, so `stack node 0.1` is the second child of the first root.
 *
 * The render path reads every field checked here: `indexStacks` walks `children`,
 * `renderStack` reads `depth` and calls `renderRow(node.pr)`, and `addStackBadges` reads
 * the rest. A node missing one of them throws inside the render, where the caller's catch
 * re-renders the same value and throws again, uncaught.
 * @param {unknown} node
 * @param {string} path
 * @returns {StackNode}
 */
function validateStackNode(node, path) {
  const label = `stack node ${path}`;
  if (node === null || typeof node !== 'object') {
    throw new Error(`malformed /api/prs response: ${label} is not an object`);
  }
  const fields = /** @type {Record<string, unknown>} */ (node);
  validateRecord(fields['pr'], label);
  for (const field of STACK_NUMBER_FIELDS) {
    if (typeof fields[field] !== 'number' || !Number.isFinite(fields[field])) {
      invalidField(label, field);
    }
  }
  for (const field of STACK_BOOLEAN_FIELDS) {
    if (typeof fields[field] !== 'boolean') invalidField(label, field);
  }
  if (!Array.isArray(fields['children'])) invalidField(label, 'children');
  const children = /** @type {unknown[]} */ (fields['children']);
  children.forEach((child, index) => validateStackNode(child, `${path}.${index}`));
  return /** @type {StackNode} */ (node);
}

/**
 * A parsed and validated `/api/prs` response body.
 * @typedef {object} ParsedPrsBody
 * @property {PrRecord[]} prs
 * @property {StackNode[]} stacks
 * @property {boolean} stale
 * @property {boolean} refreshing
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
  const prs = rawPrs.map((record, index) => validateRecord(record, `record ${index}`));
  // `stacks` goes through the boundary too. It used to be cast straight off the raw body in
  // app.js while `prs` was validated here, and one of the two fields the render path
  // consumes opting out is how the untrusted-input invariant rots. A present `stacks` that
  // is not a well-formed forest is a type violation and throws, like a malformed `prs`. An
  // absent one is an empty forest, which the non-repo axes render as their flat row lists
  // but the default repo axis renders as group headings with no rows under them, since that
  // axis draws only what the forest holds. This server always sends the array, so the empty
  // forest is unreachable; a second producer would have to send it too.
  const rawStacks = fields['stacks'];
  const stacks =
    rawStacks === undefined
      ? []
      : Array.isArray(rawStacks)
        ? rawStacks.map((node, index) => validateStackNode(node, String(index)))
        : invalidField('response body', 'stacks');
  const stale = fields['stale'] !== false;
  // Strict `=== true`, the opposite direction from `stale` above: over-reporting staleness
  // is safe, but over-reporting a refresh would make the client poll a server that is not
  // fetching anything. A server-side slip therefore degrades to one render with no poll,
  // which the Refresh button already recovers from.
  const refreshing = fields['refreshing'] === true;
  const error = typeof fields['error'] === 'string' ? fields['error'] : undefined;
  const fetchedAt = typeof fields['fetchedAt'] === 'string' ? fields['fetchedAt'] : '';
  // Coerced like the three fields above rather than validated: a malformed
  // `partialErrors` must not blank a page whose rows parsed fine. Keeping only the string
  // members means a junk entry drops out instead of rendering as "[object Object]" in the
  // banner, and a non-array degrades to "nothing known to have failed".
  const raw = fields['partialErrors'];
  const partialErrors = Array.isArray(raw) ? raw.filter((e) => typeof e === 'string') : [];
  return { prs, stacks, stale, refreshing, error, fetchedAt, partialErrors };
}

/**
 * The message to show in place of the group list, or `null` when there is at least one row
 * to render.
 *
 * Two different situations reach zero rows and a blank page cannot tell them apart: the
 * user has no open PRs, or the active filters exclude every PR they have. spec:172-173
 * justifies the Reset control with exactly that — a filter state the user cannot see is a
 * trap because the dashboard looks empty and the reason is invisible — so the second case
 * names the control that undoes it.
 * @param {number} totalRecords How many PRs the payload carries.
 * @param {number} visibleRecords How many survive the active filters.
 * @returns {string | null}
 */
export function emptyStateMessage(totalRecords, visibleRecords) {
  if (visibleRecords > 0) return null;
  if (totalRecords === 0) return 'No open pull requests.';
  // The verb agrees as well as the noun: "All 1 PR are hidden" was the previous reading.
  const one = totalRecords === 1;
  const noun = one ? 'PR' : 'PRs';
  const verb = one ? 'is' : 'are';
  // "them" is the filters, which are always plural, so it does not vary with the count.
  return `All ${totalRecords} ${noun} ${verb} hidden by the active filters. Reset view clears them.`;
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
 * @property {StalenessBucket[]} staleness
 * @property {DraftState[]} draft
 * @property {string[]} collapsed
 */

/** @type {StoredView} */
const DEFAULT_VIEW = {
  axis: DEFAULT_AXIS,
  sort: DEFAULT_SORT,
  ci: [],
  review: [],
  staleness: [],
  draft: [],
  collapsed: [],
};

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
 * Same contract as {@link toCiValues}, for staleness buckets. The allowed set is
 * `group.js`'s own {@link STALENESS_BUCKETS} rather than a copy declared here, so
 * the filter cannot end up admitting a bucket `stalenessBucket` never returns.
 * @param {unknown} value
 * @returns {StalenessBucket[]}
 */
export function toStalenessValues(value) {
  return toKnownArray(value, STALENESS_BUCKETS);
}

/**
 * Same contract as {@link toCiValues}, for draft state.
 * @param {unknown} value
 * @returns {DraftState[]}
 */
export function toDraftValues(value) {
  return toKnownArray(value, DRAFT_STATES);
}

/**
 * The collapsed section keys from a stored value: an axis-qualified `axis:key` string (see
 * `groupCollapseKey` in `group.js`) for a group header, and a bare PR id for a stack root.
 * Non-strings are dropped, so a hand-edited or older stored value cannot put anything but
 * strings into the set. Duplicates are left in place rather than collapsed here: this has
 * two callers — `parseStoredView` below, which keeps the array as-is, and `app.js`'s
 * `applyView`, which wraps the result in `new Set(...)` and so already dedupes there —
 * doing it here too would be one job done in two places for the caller that already does it.
 *
 * Unlike the axis and status validators, this one does not check membership in a known
 * list, because there is no such list: a key naming a merged PR or a repository with
 * nothing open is normal, and the section it named is simply not rendered. Rejecting
 * unknown keys would un-collapse everything the first time a PR merged.
 * @param {unknown} value
 * @returns {string[]}
 */
export function toCollapsedKeys(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string');
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
    staleness: toStalenessValues(obj['staleness']),
    draft: toDraftValues(obj['draft']),
    collapsed: toCollapsedKeys(obj['collapsed']),
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
 * @property {boolean} [refreshing]
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
 * Five outcomes need five different sentences. A stale response is a failed refresh
 * behind retained data, so it names the failure and when the data was last good. A
 * partial response is the opposite case: the fetch succeeded just now and returned only
 * some of the user's PRs, so saying "could not refresh (last success ...)" would be
 * false — the rows are exactly as fresh as `fetchedAt` says. A retained payload that was
 * itself partial is both, and says so, because a user who cannot see the rest of their
 * PRs should not have to infer that from a banner about a refresh failure. The fourth is
 * a payload restored from disk or retained in memory while a fetch runs behind it — not a
 * failure at all, so it gets its own sentence rather than borrowing the stale one's. The
 * fifth, `gaveUp`, is that same in-progress response once `nextPollState` has stopped
 * asking again: `when` and `incomplete` still apply — the operator still needs the
 * last-good time and which PRs are missing — so this only swaps the "while it refreshes"
 * clause for one naming Refresh as the way forward, rather than replacing the whole
 * message and losing the rest of it.
 * @param {RefreshOutcome} data
 * @param {number} [now] Milliseconds since epoch; defaults to `Date.now()`, overridable so tests are deterministic.
 * @param {boolean} [gaveUp] True once the poll loop has stopped asking again for this
 *   refreshing response — see `nextPollState`'s own `gaveUp` field.
 * @returns {string | null}
 */
export function staleBanner(data, now = Date.now(), gaveUp = false) {
  const when = formatRelativeTime(data.fetchedAt, now);
  const incomplete =
    data.partialErrors.length > 0 ? ` Some PRs are missing: ${data.partialErrors.join('; ')}` : '';

  // Checked before the stale branch, which would otherwise read the absent `error` as
  // "unknown error" and tell the user a refresh failed while it is still running. Gated on
  // `error` being absent too: `refreshing` and a failed refresh both set `stale: true` with
  // no other field distinguishing them, so a response that somehow carries both must fall
  // through to the failure branch below rather than swallow the error text.
  if (data.refreshing === true && data.error === undefined) {
    if (gaveUp) {
      return `Refreshing timed out (last saved ${when}). Click Refresh to try again.${incomplete}`;
    }
    return `Showing the last saved list (${when}) while it refreshes.${incomplete}`;
  }
  if (data.stale) {
    const reason = data.error ?? 'unknown error';
    // The reason comes from upstream and mostly does not end in a full stop, so the
    // "Some PRs are missing" clause needs one supplied — without it the two run together
    // as "... network down Some PRs are missing: ...". Conditional rather than appended
    // unconditionally, because github.ts's rate-limit message is already two sentences.
    const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
    return `Could not refresh (last success ${when}): ${sentence}${incomplete}`;
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

/** How long the page waits before asking `/api/prs` again while a fetch is in flight. */
export const REFRESH_POLL_MS = 600;
/**
 * How long it keeps asking before giving up. A fetch still running after this long is
 * broken rather than slow, and an uncapped poll would hammer the loopback server for the
 * life of the tab. The Refresh button is the way back from a give-up.
 */
export const REFRESH_POLL_TIMEOUT_MS = 60_000;

/**
 * The poll loop's state carried from one `/api/prs` response to the next: when the current
 * run of refreshing responses began, or `null` when none is in progress.
 * @typedef {object} PollState
 * @property {number | null} since
 */

/**
 * Decides what `app.js` should do after rendering a `/api/prs` response: carry forward (or
 * reset) the poll state, and either wait `REFRESH_POLL_MS` and ask again or stop. A pure
 * function rather than `app.js`'s own `setTimeout` bookkeeping, because `app.js` cannot be
 * imported under `node --test` (see the module comment above) — the whole stateful decision,
 * including the give-up timeout, would otherwise have no test coverage at all.
 * @param {PollState} state
 * @param {{ refreshing?: boolean }} data
 * @param {number} [now] Milliseconds since epoch; defaults to `Date.now()`, overridable so tests are deterministic.
 * @returns {{ state: PollState, waitMs: number | null, gaveUp: boolean }} `waitMs` is `null`
 *   when no poll should be armed. `gaveUp` is true only when this call is the one that
 *   crossed the timeout — `app.js` passes it to {@link staleBanner} as its `gaveUp`
 *   argument, since nothing here arms another poll once that happens.
 */
export function nextPollState(state, data, now = Date.now()) {
  if (data.refreshing !== true) return { state: { since: null }, waitMs: null, gaveUp: false };
  const since = state.since ?? now;
  // A run past the timeout resets `since` rather than only stopping: without this, one
  // fetch stuck open for a full minute would spend the give-up budget for the rest of the
  // tab's life, and every later refreshing response would be measured against that spent
  // start time instead of getting its own allowance.
  if (now - since >= REFRESH_POLL_TIMEOUT_MS) {
    return { state: { since: null }, waitMs: null, gaveUp: true };
  }
  return { state: { since }, waitMs: REFRESH_POLL_MS, gaveUp: false };
}

/**
 * Whether `status` names a permanent failure — an HTTP client error (4xx) that retrying
 * without changing anything (the URL, the request's Host) cannot fix. A rejected
 * request is not worth retrying: every one of those requests only adds load for a
 * response that can never succeed. `undefined` (a network error, or a malformed body that
 * never reached an HTTP status at all) and a 5xx are both treated as not permanent — a
 * transient condition on the wire or upstream, which the next poll might find cleared.
 * @param {number | undefined} status
 * @returns {boolean}
 */
export function isPermanentFailure(status) {
  return typeof status === 'number' && status >= 400 && status < 500;
}

/**
 * Whether a response for `generation` arrived after a newer request already started, and so
 * must be discarded rather than applied. Two overlapping fetches can settle out of order — a
 * poll issued before a Refresh click can still resolve after it — and applying the older one
 * last would revert the page to what the click was meant to replace.
 * @param {number} generation
 * @param {number} latestGeneration
 * @returns {boolean}
 */
export function isStaleResponse(generation, latestGeneration) {
  return generation !== latestGeneration;
}
