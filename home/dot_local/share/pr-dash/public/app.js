// @ts-check
import { groupBy, sortWithin } from './group.js';
import { toAxis, toSort, parsePrsBody, isSafeUrl } from './render-guards.js';

/** @typedef {import('../src/types.ts').PrRecord} PrRecord */
/** @typedef {import('../src/types.ts').StackNode} StackNode */

const secret = location.hash.replace(/^#/, '');

/** @returns {Promise<{ prs: PrRecord[], stacks: StackNode[] }>} */
async function loadPrs() {
  const res = await fetch('/api/prs', { headers: { 'x-pr-dash-secret': secret } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = await res.json();
  const prs = parsePrsBody(body);
  // The server builds stacks from the same prs this request just validated, so no
  // separate validation is needed here — unlike prs, which travels over the network
  // as the one boundary tsc cannot enforce PrRecord[] across.
  const stacks = /** @type {StackNode[]} */ (body.stacks);
  return { prs, stacks };
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
}

/**
 * @param {StackNode} node
 * @param {DocumentFragment | HTMLElement} into
 */
function renderStack(node, into) {
  const row = renderRow(node.pr);
  row.style.marginLeft = `${node.depth * 20}px`;
  addStackBadges(row, node);
  into.append(row);
  for (const child of node.children) renderStack(child, into);
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

  host.replaceChildren();
  for (const group of groupBy(records, axis)) {
    const section = document.createElement('section');
    const h2 = document.createElement('h2');
    h2.textContent = `${group.key} (${group.records.length})`;
    section.append(h2);
    if (axis === 'repo') {
      // Stack roots for this repo, already ordered by number by buildStacks — nest
      // the tree instead of the flat, sort-selectable row list every other axis
      // gets, since a stack's shape is the point of grouping by repo.
      for (const root of stacks.filter((s) => s.pr.repo === group.key)) renderStack(root, section);
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

async function refresh() {
  try {
    const data = await loadPrs();
    current = data.prs;
    currentStacks = data.stacks;
    const banner = document.getElementById('banner');
    if (banner !== null) banner.hidden = true;
    render(current, currentStacks);
  } catch (err) {
    showBanner(`Could not refresh: ${String(err)}`);
    if (current.length > 0) render(current, currentStacks);
  }
}

for (const id of ['group-by', 'sort-by']) {
  document.getElementById(id)?.addEventListener('change', () => render(current, currentStacks));
}
document.getElementById('refresh')?.addEventListener('click', () => void refresh());

void refresh();
