// @ts-check
import { applyFilters, groupBy, sortStackRoots, sortWithin } from './group.js';
import {
  toAxis,
  toSort,
  toCiValues,
  toReviewValues,
  parsePrsBody,
  isSafeUrl,
  loadStoredView,
  saveStoredView,
  clearStoredView,
  parseStoredView,
  staleBanner,
} from './render-guards.js';

/** @typedef {import('../src/types.ts').PrRecord} PrRecord */
/** @typedef {import('../src/types.ts').StackNode} StackNode */
/** @typedef {import('./render-guards.js').StoredView} StoredView */

const secret = location.hash.replace(/^#/, '');

/**
 * The checked values of the checkboxes inside the fieldset with `fieldsetId`.
 * @param {string} fieldsetId
 * @returns {string[]}
 */
function checkedValues(fieldsetId) {
  const fieldset = document.getElementById(fieldsetId);
  if (fieldset === null) return [];
  return Array.from(fieldset.querySelectorAll('input[type=checkbox]:checked')).map(
    (el) => /** @type {HTMLInputElement} */ (el).value,
  );
}

/**
 * Checks exactly the checkboxes inside the fieldset with `fieldsetId` whose
 * value is in `values`, without dispatching a `change` event — so restoring
 * a saved view on load never triggers the `change` handler that would save
 * it again.
 * @param {string} fieldsetId
 * @param {readonly string[]} values
 */
function setCheckedValues(fieldsetId, values) {
  const fieldset = document.getElementById(fieldsetId);
  if (fieldset === null) return;
  for (const el of Array.from(fieldset.querySelectorAll('input[type=checkbox]'))) {
    /** @type {HTMLInputElement} */ (el).checked = values.includes(/** @type {HTMLInputElement} */ (el).value);
  }
}

/** @returns {StoredView} */
function readControls() {
  const groupSel = document.getElementById('group-by');
  const sortSel = document.getElementById('sort-by');
  return {
    axis: toAxis(groupSel instanceof HTMLSelectElement ? groupSel.value : ''),
    sort: toSort(sortSel instanceof HTMLSelectElement ? sortSel.value : ''),
    ci: toCiValues(checkedValues('filter-ci')),
    review: toReviewValues(checkedValues('filter-review')),
  };
}

/** Persists the controls' current state so the next page load can restore it. */
function saveView() {
  saveStoredView(localStorage, readControls());
}

/** @param {StoredView} view */
function applyView(view) {
  const groupSel = document.getElementById('group-by');
  const sortSel = document.getElementById('sort-by');
  if (groupSel instanceof HTMLSelectElement) groupSel.value = view.axis;
  if (sortSel instanceof HTMLSelectElement) sortSel.value = view.sort;
  setCheckedValues('filter-ci', view.ci);
  setCheckedValues('filter-review', view.review);
}

/**
 * Clears the persisted view and re-renders from the already-loaded
 * `current`/`currentStacks` in memory — it does not reload the page. A
 * reload would re-fetch `/api/prs`, and on an expired token or an
 * exhausted rate limit that fetch 500s, so a user who clicked Reset to
 * escape an empty filtered view would land on a truly empty dashboard
 * with an error banner instead. Clearing storage without a reload is also
 * what keeps this a real reset: a browser restores user-modified checkbox
 * state across a soft reload, which could re-tick the boxes this just
 * cleared.
 */
function resetView() {
  clearStoredView(localStorage);
  applyView(parseStoredView(null));
  render(current, currentStacks);
}

/**
 * Fetches `/api/prs`. `force` adds the `refresh=1` the server reads as "bypass the
 * cache TTL" — the Refresh button's whole job. Without it the server may answer from
 * its 60-second cache, which is what a first load and any later poll want.
 * @param {boolean} force
 * @returns {Promise<{ prs: PrRecord[], stacks: StackNode[], stale: boolean, error?: string, fetchedAt: string, partialErrors: string[] }>}
 */
async function loadPrs(force) {
  const path = force ? '/api/prs?refresh=1' : '/api/prs';
  const res = await fetch(path, { headers: { 'x-pr-dash-secret': secret } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = await res.json();
  const { prs, stale, error, fetchedAt, partialErrors } = parsePrsBody(body);
  // The server builds stacks from the same prs this request just validated, so no
  // separate validation is needed here — unlike prs, which travels over the network
  // as the one boundary tsc cannot enforce PrRecord[] across.
  const stacks = /** @type {StackNode[]} */ (body.stacks);
  return { prs, stacks, stale, error, fetchedAt, partialErrors };
}

/** @param {string} message */
function showBanner(message) {
  const el = document.getElementById('banner');
  if (el === null) return;
  el.textContent = message;
  el.hidden = false;
}

/** Hides the banner shown by {@link showBanner}. */
function hideBanner() {
  const el = document.getElementById('banner');
  if (el !== null) el.hidden = true;
}

/** @param {PrRecord} pr */
function renderRow(pr) {
  const row = document.createElement('a');
  row.className = `row ci-${pr.ci} review-${pr.review}`;
  if (isSafeUrl(pr.url)) row.href = pr.url;
  row.target = '_blank';
  row.rel = 'noreferrer';
  row.textContent = `#${pr.number} ${pr.title}`;

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${pr.ci} · ${pr.review} · ${pr.staleDays}d`;
  row.append(meta);
  return row;
}

/**
 * @param {StackNode[]} stacks
 * @returns {Map<string, StackNode>} keyed by `PrRecord.id`
 */
function indexStacks(stacks) {
  /** @type {Map<string, StackNode>} */
  const byId = new Map();
  /** @param {StackNode} node */
  function walk(node) {
    byId.set(node.pr.id, node);
    for (const child of node.children) walk(child);
  }
  for (const root of stacks) walk(root);
  return byId;
}

/**
 * @param {HTMLElement} row
 * @param {StackNode | undefined} node
 */
function addStackBadges(row, node) {
  if (node === undefined) return;
  if (node.stackSize > 1) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `${node.position}/${node.stackSize}`;
    row.prepend(badge);
  }
  if (node.danglingBase) {
    const flag = document.createElement('span');
    flag.className = 'badge flag';
    flag.textContent = 'base merged';
    row.prepend(flag);
  }
  if (node.ambiguousBase) {
    const flag = document.createElement('span');
    flag.className = 'badge ambiguous';
    flag.textContent = 'ambiguous base';
    flag.title = 'This base branch is the head of more than one open PR, so which is the real parent cannot be determined.';
    row.prepend(flag);
  }
}

/**
 * Renders a stack's nodes in depth order, skipping any node not in
 * `allowed` while still recursing into its children — a filtered-out PR
 * in the middle of a stack hides its own row but not its descendants',
 * since the stack's shape (not the filter) decides what nests under what.
 * @param {StackNode} node
 * @param {DocumentFragment | HTMLElement} into
 * @param {ReadonlySet<string>} allowed
 */
function renderStack(node, into, allowed) {
  if (allowed.has(node.pr.id)) {
    const row = renderRow(node.pr);
    row.style.marginLeft = `${node.depth * 20}px`;
    addStackBadges(row, node);
    into.append(row);
  }
  for (const child of node.children) renderStack(child, into, allowed);
}

/**
 * @param {PrRecord[]} records
 * @param {StackNode[]} stacks
 */
function render(records, stacks) {
  const host = document.getElementById('groups');
  const groupSel = document.getElementById('group-by');
  const sortSel = document.getElementById('sort-by');
  if (host === null || !(groupSel instanceof HTMLSelectElement) || !(sortSel instanceof HTMLSelectElement)) return;

  const axis = toAxis(groupSel.value);
  const sort = toSort(sortSel.value);
  const byId = indexStacks(stacks);

  /** @type {import('./group.js').Filters} */
  const filters = {
    ci: toCiValues(checkedValues('filter-ci')),
    review: toReviewValues(checkedValues('filter-review')),
    draft: [],
  };
  const filtered = applyFilters(records, filters);
  const allowed = new Set(filtered.map((pr) => pr.id));

  host.replaceChildren();
  for (const group of groupBy(filtered, axis)) {
    const section = document.createElement('section');
    const h2 = document.createElement('h2');
    h2.textContent = `${group.key} (${group.records.length})`;
    section.append(h2);
    if (axis === 'repo') {
      // The tree, not the flat sort-selectable row list every other axis gets, since a
      // stack's shape is the point of grouping by repo. The Sort control still applies,
      // to the stack roots: without that it had no effect at all in the default view,
      // because buildStacks orders roots by number. Children keep their stack order.
      // `allowed` hides a filtered-out row without dropping its place in the tree.
      const roots = stacks.filter((s) => s.pr.repo === group.key);
      for (const root of sortStackRoots(roots, sort)) renderStack(root, section, allowed);
    } else {
      for (const pr of sortWithin(group.records, sort)) {
        const row = renderRow(pr);
        addStackBadges(row, byId.get(pr.id));
        section.append(row);
      }
    }
    host.append(section);
  }
}

/** @type {PrRecord[]} */
let current = [];
/** @type {StackNode[]} */
let currentStacks = [];

/**
 * Loads `/api/prs` and re-renders. `force` is true only for a Refresh click, so the
 * initial load below is served from the server's cache like any other poll.
 * @param {boolean} [force]
 */
async function refresh(force = false) {
  try {
    const data = await loadPrs(force);
    current = data.prs;
    currentStacks = data.stacks;
    // A stale response is still a 200: the server retained the last good payload
    // instead of failing the request, so it never reaches the catch below. Whether
    // to show a banner, and what it says, is staleBanner's call, not a `data.stale`
    // check inlined here — that decision lives in render-guards.js so it can be
    // covered by a real test, the same reasoning as every other guard imported above.
    const message = staleBanner(data);
    if (message !== null) showBanner(message);
    else hideBanner();
    render(current, currentStacks);
  } catch (err) {
    // Reached only when the request itself failed outright (network error, or a
    // 500 with no retained payload behind it) rather than the server returning a
    // retained payload marked stale.
    showBanner(`Could not refresh: ${String(err)}`);
    if (current.length > 0) render(current, currentStacks);
  }
}

for (const id of ['group-by', 'sort-by', 'filter-ci', 'filter-review']) {
  document.getElementById(id)?.addEventListener('change', () => {
    saveView();
    render(current, currentStacks);
  });
}
document.getElementById('refresh')?.addEventListener('click', () => void refresh(true));
document.getElementById('reset')?.addEventListener('click', resetView);

applyView(loadStoredView(localStorage));
void refresh();
