// @ts-check
import { applyFilters, groupBy, groupSummary, summaryChips, sortStackRoots, sortWithin } from './group.js';
import {
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
  loadStoredView,
  saveStoredView,
  clearStoredView,
  parseStoredView,
  staleBanner,
  nextPollState,
  isStaleResponse,
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

/**
 * Keys of the sections the user has folded shut: `axis:key` for a group header (see
 * {@link groupCollapseKey}), a bare PR id for a stack root. Held as a Set for the membership
 * test `render` does per section, and written back to storage as an array. A key outlives the
 * section it named — switching axes or filtering a group out of view never removes its key —
 * so the set can carry keys naming nothing currently on screen. Reset view and Expand all are
 * the only ways to clear them.
 * @type {Set<string>}
 */
let collapsed = new Set();

/** @param {string} key */
function toggleCollapsed(key) {
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
  saveView();
  render(current, currentStacks);
}

/**
 * Reports the controls' current state, `collapsed` included — it is read from the
 * in-memory Set here, not from storage, since that Set is the one place collapse state lives
 * while the page is open.
 * @returns {StoredView}
 */
function readControls() {
  const groupSel = document.getElementById('group-by');
  const sortSel = document.getElementById('sort-by');
  return {
    axis: toAxis(groupSel instanceof HTMLSelectElement ? groupSel.value : ''),
    sort: toSort(sortSel instanceof HTMLSelectElement ? sortSel.value : ''),
    ci: toCiValues(checkedValues('filter-ci')),
    review: toReviewValues(checkedValues('filter-review')),
    staleness: toStalenessValues(checkedValues('filter-staleness')),
    draft: toDraftValues(checkedValues('filter-draft')),
    collapsed: [...collapsed],
  };
}

/**
 * Persists the controls' current state, including a collapse toggle, so the next page
 * load can restore it.
 */
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
  setCheckedValues('filter-staleness', view.staleness);
  setCheckedValues('filter-draft', view.draft);
  collapsed = new Set(toCollapsedKeys(view.collapsed));
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
 * @returns {Promise<import('./render-guards.js').ParsedPrsBody>}
 */
async function loadPrs(force) {
  const path = force ? '/api/prs?refresh=1' : '/api/prs';
  const res = await fetch(path, { headers: { 'x-pr-dash-secret': secret } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = await res.json();
  // Both fields the render path consumes come back through parsePrsBody. `stacks` used to
  // be cast straight off the raw body on the grounds that the server derives it from the
  // same prs — true, and still no reason for one of the two to skip the boundary tsc
  // cannot enforce across the network.
  return parsePrsBody(body);
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
  // `row:` prefixed so this can never collide with a stack toggle's bare PR id or a header's
  // axis-qualified key — the three key kinds share one lookup in `render`'s focus restore.
  row.dataset.key = `row:${pr.id}`;
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
 * The `▾`/`▸` glyph a disclosure button shows. `aria-hidden`: the glyph is decorative in both
 * callers — a header button's own name already comes from the repo name, count and chips
 * beside it, and a stack toggle carries an explicit `aria-label` instead of relying on this
 * text for its accessible name.
 * @param {boolean} isCollapsed
 * @returns {HTMLElement}
 */
function chevron(isCollapsed) {
  const el = document.createElement('span');
  el.className = 'chevron';
  el.setAttribute('aria-hidden', 'true');
  el.textContent = isCollapsed ? '▸' : '▾';
  return el;
}

/**
 * Whether collapsing `node` would actually hide anything: true when some descendant, at any
 * depth, is currently in `allowed`. Gates the stack toggle so a root whose children the active
 * filters have already excluded doesn't offer a control that folds nothing.
 * @param {StackNode} node
 * @param {ReadonlySet<string>} allowed
 * @returns {boolean}
 */
function hasVisibleChild(node, allowed) {
  return node.children.some((child) => allowed.has(child.pr.id) || hasVisibleChild(child, allowed));
}

/**
 * Renders a stack's nodes in depth order, skipping any node not in
 * `allowed` while still recursing into its children — a filtered-out PR
 * in the middle of a stack hides its own row but not its descendants',
 * since the stack's shape (not the filter) decides what nests under what.
 * A collapsed root only stops that recursion when its own row actually rendered: a root the
 * filter excludes has no toggle anyone could have collapsed, so its children show through it
 * exactly as any other filtered-out node's would.
 * @param {StackNode} node
 * @param {DocumentFragment | HTMLElement} into
 * @param {ReadonlySet<string>} allowed
 */
function renderStack(node, into, allowed) {
  const isRoot = node.depth === 0;
  const rowRendered = allowed.has(node.pr.id);
  if (rowRendered) {
    const row = renderRow(node.pr);
    addStackBadges(row, node);
    // A sibling wrapper, not a child of `row`: `row` is the PR's own link anchor, and an
    // anchor must not contain interactive content — a nested button breaks tab order and
    // screen-reader browse mode, and a middle-click dispatches `auxclick` rather than
    // `click`, so a handler on the button could never stop the anchor's own navigation.
    const wrapper = document.createElement('div');
    wrapper.className = 'stack-row';
    wrapper.style.marginLeft = `${node.depth * 20}px`;
    // Only a root with a currently visible descendant is worth a toggle: a single PR has
    // nothing to fold, a child's own subtree folds with its root, and a root whose children
    // the filter has already excluded would offer a control that folds nothing.
    if (isRoot && hasVisibleChild(node, allowed)) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'disclosure stack-toggle';
      toggle.dataset.key = node.pr.id;
      const isCollapsed = collapsed.has(node.pr.id);
      toggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      // The chevron alone would leave the accessible name a glyph with nothing to say what
      // it folds, so the toggle names its target explicitly instead of relying on text
      // content the way the header button does.
      toggle.setAttribute(
        'aria-label',
        `${isCollapsed ? 'Expand' : 'Collapse'} the ${node.pr.repo}#${node.pr.number} stack`,
      );
      toggle.append(chevron(isCollapsed));
      toggle.addEventListener('click', () => toggleCollapsed(node.pr.id));
      wrapper.append(toggle);
    }
    wrapper.append(row);
    into.append(wrapper);
  }
  if (isRoot && rowRendered && collapsed.has(node.pr.id)) return;
  for (const child of node.children) renderStack(child, into, allowed);
}

/**
 * The key {@link collapsed} tracks a group header under: the axis and the group's own key,
 * joined so the same key text under two axes — both `ci` and `review` have a `none` group —
 * can't collide and fold a section nobody collapsed. A stack key is a bare PR id instead,
 * never axis-qualified; a PR id always contains `#`, which none of these joined strings do,
 * so the two kinds of key can never collide with each other either.
 * @param {import('./group.js').Axis} axis
 * @param {string} key
 * @returns {string}
 */
function groupCollapseKey(axis, key) {
  return `${axis}:${key}`;
}

/**
 * A section header that folds its contents away. The disclosure state lives on the button as
 * `aria-expanded`, and the count and chips render in both states, not just while collapsed, so
 * folding a repository away never hides that something inside is failing.
 * @param {string} collapseKey The axis-qualified key {@link collapsed} tracks this section under.
 * @param {string} label The unqualified text the button shows — a bare repo name or group key.
 * @param {import('./group.js').GroupSummary} summary
 * @returns {HTMLElement}
 */
function collapsibleHeader(collapseKey, label, summary) {
  const isCollapsed = collapsed.has(collapseKey);
  const h2 = document.createElement('h2');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'disclosure';
  button.dataset.key = collapseKey;
  button.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
  button.addEventListener('click', () => toggleCollapsed(collapseKey));
  button.append(chevron(isCollapsed));

  const name = document.createElement('span');
  name.className = 'section-name';
  name.textContent = label;
  button.append(name);

  const count = document.createElement('span');
  count.className = 'section-count';
  count.textContent = summary.total === 1 ? '1 PR' : `${summary.total} PRs`;
  button.append(count);

  for (const chip of summaryChips(summary)) {
    const el = document.createElement('span');
    el.className = `summary-chip ${chip.tone}`;
    el.textContent = chip.label;
    button.append(el);
  }

  h2.append(button);
  return h2;
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
    staleness: toStalenessValues(checkedValues('filter-staleness')),
    draft: toDraftValues(checkedValues('filter-draft')),
  };
  const filtered = applyFilters(records, filters);
  const allowed = new Set(filtered.map((pr) => pr.id));

  // `replaceChildren` below destroys whatever disclosure button currently has focus, which
  // would otherwise drop keyboard focus to <body> on every toggle. `data-key` identifies the
  // same section or stack across the rebuild, so focus can move to its replacement.
  const focused = document.activeElement;
  const focusedKey = focused instanceof HTMLElement && host.contains(focused) ? focused.dataset.key : undefined;

  host.replaceChildren();

  // Zero groups used to render nothing at all, so a user with no open PRs and a user whose
  // filters exclude every PR saw the same blank page. Which of the two it is decides what
  // to do next, so the page says. Held in an `else` below rather than an early return, so the
  // focus restore at the end runs on every path out of this function, not just the common one
  // — a poll landing a payload the active filters exclude entirely must not strand focus.
  const empty = emptyStateMessage(records.length, filtered.length);
  if (empty !== null) {
    const message = document.createElement('p');
    message.className = 'empty';
    message.textContent = empty;
    host.append(message);
  } else {
    for (const group of groupBy(filtered, axis)) {
      const collapseKey = groupCollapseKey(axis, group.key);
      const section = document.createElement('section');
      section.append(collapsibleHeader(collapseKey, group.key, groupSummary(group.records)));
      if (!collapsed.has(collapseKey)) {
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
      }
      host.append(section);
    }
  }

  if (focusedKey !== undefined) {
    const toFocus = host.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`);
    // `preventScroll`: this same path runs on every poll while a user reads on, and a plain
    // `focus()` would yank the page back to whatever was focused every time one lands.
    if (toFocus instanceof HTMLElement) toFocus.focus({ preventScroll: true });
  }
}

/** @type {PrRecord[]} */
let current = [];
/** @type {StackNode[]} */
let currentStacks = [];
/** @type {import('./render-guards.js').PollState} */
let pollState = { since: null };
/** @type {ReturnType<typeof setTimeout> | null} */
let pollTimer = null;
/**
 * The most recent `refresh()` call's ordinal. `isStaleResponse` compares a settled
 * response's own generation against this, so a response that resolves after a newer
 * request has already started is discarded instead of applied.
 */
let requestGeneration = 0;

/**
 * Arms or clears the timer that asks `/api/prs` again, per `nextPollState`'s decision.
 * Without this the page paints the restored rows once and shows them indefinitely, which
 * is worse than the wait it replaces — the rows would be presented as the current state of
 * the world with no further request to correct them.
 * @param {{ refreshing?: boolean }} data
 */
function schedulePoll(data) {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  const next = nextPollState(pollState, data);
  pollState = next.state;
  if (next.waitMs === null) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void refresh();
  }, next.waitMs);
}

/**
 * Loads `/api/prs` and re-renders. `force` is true only for a Refresh click, so the
 * initial load below is served from the server's cache like any other poll.
 * @param {boolean} [force]
 */
async function refresh(force = false) {
  if (force && pollTimer !== null) {
    // The button exists to reach GitHub now. Left armed, that timer could fire mid-click
    // and issue a non-forced request that hits the server's in-flight shortcut, answering
    // with the very payload this click is trying to replace.
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  requestGeneration += 1;
  const generation = requestGeneration;
  try {
    const data = await loadPrs(force);
    // A poll issued before this call can still resolve after it — see isStaleResponse.
    // Applying it here would revert the page to what a newer request already replaced.
    if (isStaleResponse(generation, requestGeneration)) return;
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
    schedulePoll(data);
  } catch (err) {
    if (isStaleResponse(generation, requestGeneration)) return;
    // Reached only when the request itself failed outright (network error, or a
    // 500 with no retained payload behind it) rather than the server returning a
    // retained payload marked stale.
    showBanner(`Could not refresh: ${String(err)}`);
    if (current.length > 0) render(current, currentStacks);
  }
}

for (const id of [
  'group-by',
  'sort-by',
  'filter-ci',
  'filter-review',
  'filter-staleness',
  'filter-draft',
]) {
  document.getElementById(id)?.addEventListener('change', () => {
    saveView();
    render(current, currentStacks);
  });
}
document.getElementById('refresh')?.addEventListener('click', () => void refresh(true));
document.getElementById('reset')?.addEventListener('click', resetView);

// A way in needs a way out at the same granularity: per-section toggles alone leave no way
// to undo a session's worth of collapsing. Folds stack roots along with group headers so
// Collapse all and Expand all stay inverses of each other — otherwise expanding a repository
// afterward would reveal stacks Collapse all never touched.
document.getElementById('collapse-all')?.addEventListener('click', () => {
  const axis = readControls().axis;
  for (const group of groupBy(current, axis)) collapsed.add(groupCollapseKey(axis, group.key));
  for (const root of currentStacks) {
    if (root.children.length > 0) collapsed.add(root.pr.id);
  }
  saveView();
  render(current, currentStacks);
});

document.getElementById('expand-all')?.addEventListener('click', () => {
  collapsed.clear();
  saveView();
  render(current, currentStacks);
});

applyView(loadStoredView(localStorage));
void refresh();
