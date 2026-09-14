// @ts-check
import { groupBy, sortWithin } from './group.js';

/** @typedef {import('../src/types.ts').PrRecord} PrRecord */
/** @typedef {import('./group.js').Axis} Axis */
/** @typedef {import('./group.js').Sort} Sort */

const secret = location.hash.replace(/^#/, '');

/** @type {readonly Axis[]} */
const AXES = ['repo', 'ci', 'review', 'staleness', 'draft'];
/** @type {readonly Sort[]} */
const SORTS = ['stale', 'age', 'title', 'size'];

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
function toAxis(value) {
  return AXES.includes(/** @type {Axis} */ (value)) ? /** @type {Axis} */ (value) : DEFAULT_AXIS;
}

/**
 * Same guard as {@link toAxis}, for the sort `<select>`. `sortWithin`'s
 * switch also has no `default` case, so an unrecognized sort makes it
 * return `undefined` instead of an array and the caller throws on `.map`.
 * @param {string} value
 * @returns {Sort}
 */
function toSort(value) {
  return SORTS.includes(/** @type {Sort} */ (value)) ? /** @type {Sort} */ (value) : DEFAULT_SORT;
}

/** @returns {Promise<PrRecord[]>} */
async function loadPrs() {
  const res = await fetch('/api/prs', { headers: { 'x-pr-dash-secret': secret } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.prs;
}

/** @param {string} message */
function showBanner(message) {
  const el = document.getElementById('banner');
  if (el === null) return;
  el.textContent = message;
  el.hidden = false;
}

/** @param {PrRecord} pr */
function renderRow(pr) {
  const row = document.createElement('a');
  row.className = `row ci-${pr.ci} review-${pr.review}`;
  row.href = pr.url;
  row.target = '_blank';
  row.rel = 'noreferrer';
  row.textContent = `#${pr.number} ${pr.title}`;

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${pr.ci} · ${pr.review} · ${pr.staleDays}d`;
  row.append(meta);
  return row;
}

/** @param {PrRecord[]} records */
function render(records) {
  const host = document.getElementById('groups');
  const groupSel = document.getElementById('group-by');
  const sortSel = document.getElementById('sort-by');
  if (host === null || !(groupSel instanceof HTMLSelectElement) || !(sortSel instanceof HTMLSelectElement)) return;

  const axis = toAxis(groupSel.value);
  const sort = toSort(sortSel.value);

  host.replaceChildren();
  for (const group of groupBy(records, axis)) {
    const section = document.createElement('section');
    const h2 = document.createElement('h2');
    h2.textContent = `${group.key} (${group.records.length})`;
    section.append(h2, ...sortWithin(group.records, sort).map(renderRow));
    host.append(section);
  }
}

/** @type {PrRecord[]} */
let current = [];

async function refresh() {
  try {
    current = await loadPrs();
    const banner = document.getElementById('banner');
    if (banner !== null) banner.hidden = true;
    render(current);
  } catch (err) {
    showBanner(`Could not refresh: ${String(err)}`);
    if (current.length > 0) render(current);
  }
}

for (const id of ['group-by', 'sort-by']) {
  document.getElementById(id)?.addEventListener('change', () => render(current));
}
document.getElementById('refresh')?.addEventListener('click', () => void refresh());

void refresh();
