// @ts-check
import { groupBy, sortWithin } from './group.js';
import { toAxis, toSort, parsePrsBody, isSafeUrl } from './render-guards.js';

/** @typedef {import('../src/types.ts').PrRecord} PrRecord */

const secret = location.hash.replace(/^#/, '');

/** @returns {Promise<PrRecord[]>} */
async function loadPrs() {
  const res = await fetch('/api/prs', { headers: { 'x-pr-dash-secret': secret } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = await res.json();
  return parsePrsBody(body);
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
