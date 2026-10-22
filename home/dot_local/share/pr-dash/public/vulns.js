// @ts-check
import { isSafeUrl } from './render-guards.js';
import {
  SEVERITIES,
  VULN_AXES,
  VULN_SORTS,
  ageDays,
  cleanRepos,
  filterAlerts,
  groupAlerts,
  parseVulnsBody,
  severityCounts,
  sortAlerts,
  vulnsBanner,
} from './vuln-view.js';

/** @typedef {import('./vuln-view.js').VulnAlert} VulnAlert */
/** @typedef {import('./vuln-view.js').VulnAxis} VulnAxis */
/** @typedef {import('./vuln-view.js').VulnSort} VulnSort */
/** @typedef {import('./vuln-view.js').VulnFilters} VulnFilters */
/** @typedef {import('./vuln-view.js').VulnsBody} VulnsBody */

// Separate from the PR page's `pr-dash:view`: the two pages share an origin, and their
// controls do not overlap.
const VIEW_KEY = 'pr-dash:vulns-view';

// The server caches alerts for five minutes, so polling faster only re-reads its cache.
const POLL_MS = 5 * 60 * 1000;

const FILTER_IDS = /** @type {const} */ (['filter-severity', 'filter-scope', 'filter-fix']);

/** @type {VulnsBody | null} */
let current = null;
/** @type {Set<string>} */
const collapsed = new Set();
let requestGeneration = 0;

/**
 * @param {string} fieldsetId
 * @returns {string[]}
 */
function checkedValues(fieldsetId) {
  const inputs = Array.from(document.querySelectorAll(`#${fieldsetId} input[type=checkbox]`));
  return inputs.filter((i) => i instanceof HTMLInputElement && i.checked).map((i) => /** @type {HTMLInputElement} */ (i).value);
}

/**
 * @param {string} fieldsetId
 * @param {readonly string[]} values
 */
function setCheckedValues(fieldsetId, values) {
  for (const input of Array.from(document.querySelectorAll(`#${fieldsetId} input[type=checkbox]`))) {
    if (input instanceof HTMLInputElement) input.checked = values.includes(input.value);
  }
}

/** @param {string} id */
function selectValue(id) {
  const el = document.getElementById(id);
  return el instanceof HTMLSelectElement ? el.value : '';
}

/**
 * @returns {{ axis: VulnAxis, sort: VulnSort, filters: VulnFilters }}
 */
function readControls() {
  const axis = selectValue('group-by');
  const sort = selectValue('sort-by');
  return {
    axis: VULN_AXES.includes(/** @type {VulnAxis} */ (axis)) ? /** @type {VulnAxis} */ (axis) : 'repo',
    sort: VULN_SORTS.includes(/** @type {VulnSort} */ (sort)) ? /** @type {VulnSort} */ (sort) : 'severity',
    filters: {
      severities: /** @type {VulnFilters['severities']} */ (checkedValues('filter-severity')),
      scopes: /** @type {VulnFilters['scopes']} */ (checkedValues('filter-scope')),
      fixes: /** @type {VulnFilters['fixes']} */ (checkedValues('filter-fix')),
    },
  };
}

// Storage access is wrapped throughout: a private window or blocked site data makes
// localStorage throw, and the page must still render with its defaults.
function saveView() {
  const { axis, sort, filters } = readControls();
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ axis, sort, filters, collapsed: [...collapsed] }));
  } catch {}
}

function loadView() {
  /** @type {unknown} */
  let view = null;
  try {
    view = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null');
  } catch {}
  if (typeof view !== 'object' || view === null) return;
  const v = /** @type {Record<string, unknown>} */ (view);
  const axisEl = document.getElementById('group-by');
  const sortEl = document.getElementById('sort-by');
  if (axisEl instanceof HTMLSelectElement && VULN_AXES.includes(/** @type {VulnAxis} */ (v['axis']))) {
    axisEl.value = /** @type {string} */ (v['axis']);
  }
  if (sortEl instanceof HTMLSelectElement && VULN_SORTS.includes(/** @type {VulnSort} */ (v['sort']))) {
    sortEl.value = /** @type {string} */ (v['sort']);
  }
  const filters = typeof v['filters'] === 'object' && v['filters'] !== null ? /** @type {Record<string, unknown>} */ (v['filters']) : {};
  const strings = (/** @type {unknown} */ x) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string') : []);
  setCheckedValues('filter-severity', strings(filters['severities']));
  setCheckedValues('filter-scope', strings(filters['scopes']));
  setCheckedValues('filter-fix', strings(filters['fixes']));
  for (const key of strings(v['collapsed'])) collapsed.add(key);
}

function resetView() {
  try {
    localStorage.removeItem(VIEW_KEY);
  } catch {}
  collapsed.clear();
  const axisEl = document.getElementById('group-by');
  const sortEl = document.getElementById('sort-by');
  if (axisEl instanceof HTMLSelectElement) axisEl.value = 'repo';
  if (sortEl instanceof HTMLSelectElement) sortEl.value = 'severity';
  for (const id of FILTER_IDS) setCheckedValues(id, []);
  render();
}

/** @param {string | null} message */
function setBanner(message) {
  const el = document.getElementById('banner');
  if (el === null) return;
  el.textContent = message ?? '';
  el.hidden = message === null;
}

/**
 * @param {string} text
 * @param {string} className
 */
function span(text, className) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

/**
 * @param {VulnAlert} alert
 * @param {number} now
 * @param {boolean} showRepo
 */
function renderRow(alert, now, showRepo) {
  const row = document.createElement('a');
  row.className = 'row';
  if (isSafeUrl(alert.url)) row.href = alert.url;
  row.target = '_blank';
  row.rel = 'noreferrer';

  row.append(span(alert.severity, `sev-chip sev-${alert.severity}`));
  // Under severity or package grouping a section mixes repositories, so each row names its
  // own. The owner is dropped: every configured repository is normally under one owner.
  if (showRepo) row.append(span(alert.repo.slice(alert.repo.indexOf('/') + 1), 'badge'));
  row.append(span(alert.packageName, 'vuln-package'));

  const title = span(alert.summary, 'row-title');
  title.title = [alert.ghsaId, ...alert.cveIds].join(' · ');
  row.append(title);

  const meta = document.createElement('span');
  meta.className = 'meta';
  const fix = alert.patchedVersion === null ? 'no patch' : `fix ${alert.patchedVersion}`;
  const fixChip = span(fix, `state-chip ${alert.patchedVersion === null ? 'bad' : 'good'}`);
  fixChip.title = `Vulnerable: ${alert.vulnerableRange}`;
  meta.append(fixChip);
  if (alert.scope === 'development') meta.append(span('dev', 'badge'));
  meta.append(span(alert.manifestPath, 'vuln-manifest'));
  const days = ageDays(alert.createdAt, now);
  const age = span(days === 1 ? '1 day' : `${days} days`, 'stale');
  age.title = 'Days since Dependabot opened this alert.';
  meta.append(age);
  row.append(meta);
  return row;
}

/**
 * @param {string} key
 * @param {string} label
 * @param {readonly VulnAlert[]} alerts
 * @param {VulnAxis} axis
 * @param {boolean} stale
 */
function groupHeader(key, label, alerts, axis, stale) {
  const isCollapsed = collapsed.has(key);
  const h2 = document.createElement('h2');
  h2.className = 'section-header';
  h2.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a') !== null) return;
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    saveView();
    render();
  });

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'section-toggle';
  button.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
  button.setAttribute('aria-label', `${isCollapsed ? 'Expand' : 'Collapse'} ${label}`);
  button.append(span(isCollapsed ? '▼' : '▲', ''));
  h2.append(button);

  // A repository header links to that repository's Dependabot tab, built from one of its
  // alert URLs rather than a hard-coded host.
  const first = alerts[0];
  const href =
    axis === 'repo' && first !== undefined && isSafeUrl(first.url)
      ? first.url.replace(/\/\d+$/, '')
      : null;
  const name = document.createElement(href === null ? 'span' : 'a');
  name.className = 'section-name';
  name.textContent = label;
  if (name instanceof HTMLAnchorElement && href !== null) {
    name.href = href;
    name.target = '_blank';
    name.rel = 'noreferrer';
  }
  h2.append(name);
  h2.append(span(alerts.length === 1 ? '1 alert' : `${alerts.length} alerts`, 'section-count'));
  if (stale) {
    // The banner says why; this marks which group the retained alerts are in.
    const badge = span('out of date', 'badge ambiguous');
    badge.title = 'GitHub suddenly listed no alerts for this repository, so these are from an earlier fetch.';
    h2.append(badge);
  }

  if (axis !== 'severity') {
    const counts = severityCounts(alerts);
    for (const s of SEVERITIES) {
      if (counts[s] > 0) h2.append(span(`${counts[s]} ${s}`, `sev-chip sev-${s}`));
    }
  }
  return h2;
}

function render() {
  const main = document.getElementById('groups');
  const totals = document.getElementById('totals');
  if (main === null || totals === null || current === null) return;
  const { axis, sort, filters } = readControls();
  const now = Date.now();
  const shown = filterAlerts(current.alerts, filters);

  const counts = severityCounts(shown);
  const clean = cleanRepos(current.repos, current.alerts);
  const summary = SEVERITIES.map((s) => `${counts[s]} ${s}`).join(' · ');
  totals.textContent =
    `${shown.length} of ${current.alerts.length} open alerts across ${current.repos.length} repositories (${summary}).` +
    (clean.length > 0 ? ` No open alerts: ${clean.join(', ')}.` : '');
  totals.hidden = false;

  main.replaceChildren();
  if (current.repos.length === 0) {
    main.append(
      span('No repositories configured. Set prDashVulnRepos in chezmoi.toml and reload the agent.', 'empty'),
    );
    return;
  }
  if (shown.length === 0) {
    main.append(span('No alerts match these filters.', 'empty'));
    return;
  }
  for (const group of groupAlerts(shown, axis)) {
    const key = `${axis}:${group.key}`;
    const section = document.createElement('section');
    const stale = axis === 'repo' && current.staleRepos.includes(group.key);
    section.append(groupHeader(key, group.label, group.alerts, axis, stale));
    if (!collapsed.has(key)) {
      for (const alert of sortAlerts(group.alerts, sort)) section.append(renderRow(alert, now, axis !== 'repo'));
    }
    main.append(section);
  }
}

/**
 * Loads `/api/vulns` and re-renders. `force` is the Refresh click, which asks the server to
 * bypass its cache.
 * @param {boolean} [force]
 */
async function refresh(force = false) {
  requestGeneration += 1;
  const generation = requestGeneration;
  try {
    const res = await fetch(force ? '/api/vulns?refresh=1' : '/api/vulns');
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = parseVulnsBody(await res.json());
    // A slow poll can resolve after a later Refresh; applying it would undo the newer answer.
    if (generation !== requestGeneration) return;
    current = data;
    render();
    setBanner(vulnsBanner(data));
  } catch (err) {
    if (generation !== requestGeneration) return;
    setBanner(`Could not load alerts: ${String(err)}`);
  }
}

for (const id of ['group-by', 'sort-by', ...FILTER_IDS]) {
  document.getElementById(id)?.addEventListener('change', () => {
    saveView();
    render();
  });
}
document.getElementById('refresh')?.addEventListener('click', () => void refresh(true));
document.getElementById('reset')?.addEventListener('click', resetView);
document.getElementById('collapse-all')?.addEventListener('click', () => {
  if (current === null) return;
  const { axis, filters } = readControls();
  for (const g of groupAlerts(filterAlerts(current.alerts, filters), axis)) collapsed.add(`${axis}:${g.key}`);
  saveView();
  render();
});
document.getElementById('expand-all')?.addEventListener('click', () => {
  collapsed.clear();
  saveView();
  render();
});

loadView();
void refresh();
setInterval(() => void refresh(), POLL_MS);
