// @ts-check
import { createRefreshIndicator } from './refresh-status.js';
import { ciChip, isSafeUrl } from './render-guards.js';
import { parseReposBody, reposBanner, vulnStatus } from './repo-view.js';
import { SEVERITIES, ageDays, parseVulnsBody } from './vuln-view.js';

/** @typedef {import('./repo-view.js').ReposBody} ReposBody */
/** @typedef {import('./vuln-view.js').VulnsBody} VulnsBody */
/** @typedef {import('../src/repos.ts').RepoRow} RepoRow */

// Both routes cache for five minutes on the server, so polling faster only re-reads them.
const POLL_MS = 5 * 60 * 1000;

/** @type {ReposBody | null} */
let current = null;
/** @type {VulnsBody | null} */
let vulns = null;
/** @type {string | null} */
let vulnsError = null;
let requestGeneration = 0;
const refreshButton = document.getElementById('refresh');
const indicator = createRefreshIndicator(
  refreshButton instanceof HTMLButtonElement ? refreshButton : null,
  document.getElementById('refresh-status'),
);

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
 * A link that opens in a new tab, or a plain span when the URL fails `isSafeUrl`.
 * @param {string} text
 * @param {string} className
 * @param {string | null} url
 */
function link(text, className, url) {
  if (url === null || !isSafeUrl(url)) return span(text, className);
  const a = document.createElement('a');
  a.className = className;
  a.textContent = text;
  a.href = url;
  a.target = '_blank';
  a.rel = 'noreferrer';
  return a;
}

/** @param {number} days */
function daysText(days) {
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * @param {RepoRow} row
 * @param {number} now
 */
function renderRow(row, now) {
  const el = document.createElement('div');
  el.className = 'row';
  el.append(link(row.repo, 'repo-name', row.url));

  if (row.error !== null || row.prs === null) {
    const chip = span('unavailable', 'state-chip bad');
    el.append(chip);
    el.append(span(row.error ?? 'no data', 'row-title'));
    return el;
  }

  // Default branch: its CI state, then the head commit's headline as the row's flexible title.
  const branch = row.branch;
  if (branch === null) {
    el.append(span('no default branch', 'state-chip muted'));
    el.append(span('', 'row-title'));
  } else {
    const ci = ciChip(branch.ci) ?? { label: 'no checks', tone: 'muted' };
    const ciEl = link(`${branch.name} ${ci.label}`, `state-chip ${ci.tone}`, branch.commitUrl);
    ciEl.title = `CI on the head of ${branch.name}.`;
    el.append(ciEl);
    const title = span(branch.headline, 'row-title');
    const landed = ageDays(branch.committedAt, now);
    title.title = `${branch.author}, ${daysText(landed)} ago`;
    el.append(title);
  }

  const meta = document.createElement('span');
  meta.className = 'meta';

  const prs = row.prs;
  const prParts = [`${prs.open} open PR${prs.open === 1 ? '' : 's'}`];
  if (prs.awaitingReview > 0) prParts.push(`${prs.awaitingReview} awaiting review`);
  if (prs.drafts > 0) prParts.push(`${prs.drafts} draft`);
  meta.append(link(prParts.join(' · '), 'repo-prs', prs.url));
  if (prs.oldestOpenedAt !== null) {
    const oldest = span(`oldest ${daysText(ageDays(prs.oldestOpenedAt, now))}`, 'stale');
    oldest.title = 'Age of the oldest open PR.';
    meta.append(oldest);
  }

  const status = vulnStatus(row.repo, vulns);
  const vulnLink = document.createElement('a');
  vulnLink.className = 'repo-vulns';
  vulnLink.href = './vulns.html';
  if (status.counts === null) {
    vulnLink.append(span('vulns unavailable', 'state-chip warn'));
  } else {
    const counts = status.counts;
    const shown = SEVERITIES.filter((s) => counts[s] > 0);
    if (shown.length === 0) vulnLink.append(span('no alerts', 'state-chip good'));
    for (const s of shown) vulnLink.append(span(`${counts[s]} ${s}`, `sev-chip sev-${s}`));
    if (status.caveat !== null) vulnLink.append(span(status.caveat, 'badge ambiguous'));
  }
  meta.append(vulnLink);

  el.append(meta);
  return el;
}

function render() {
  const main = document.getElementById('repos');
  const totals = document.getElementById('totals');
  if (main === null || totals === null || current === null) return;
  const now = Date.now();
  const loaded = current.rows.filter((r) => r.prs !== null);
  const failing = loaded.filter((r) => r.branch?.ci === 'failure').length;
  const open = loaded.reduce((n, r) => n + (r.prs?.open ?? 0), 0);
  const failed = current.rows.length - loaded.length;
  totals.textContent =
    `${current.rows.length} repositories · ${open} open PRs · ${failing} with a failing default branch` +
    (failed > 0 ? ` · ${failed} could not be read` : '');
  totals.hidden = false;

  main.replaceChildren();
  if (current.rows.length === 0) {
    main.append(span('No repositories configured. Set prDashVulnRepos in chezmoi.toml and reload the agent.', 'empty'));
    return;
  }
  for (const row of current.rows) main.append(renderRow(row, now));
}

/**
 * Loads `/api/vulns` for the per-repository counts. A failure here costs the counts, never
 * the page: each row then says its counts are unavailable.
 * @param {boolean} force
 * @returns {Promise<{ body: VulnsBody | null, error: string | null }>}
 */
async function loadVulns(force) {
  try {
    const res = await fetch(force ? '/api/vulns?refresh=1' : '/api/vulns');
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return { body: parseVulnsBody(await res.json()), error: null };
  } catch (err) {
    return { body: null, error: String(err) };
  }
}

/**
 * Loads `/api/repos` and `/api/vulns` together and re-renders. `force` is the Refresh click.
 * @param {boolean} [force]
 */
async function refresh(force = false) {
  requestGeneration += 1;
  const generation = requestGeneration;
  if (force) indicator.setBusy(true);
  try {
    const [res, vulnResult] = await Promise.all([fetch(force ? '/api/repos?refresh=1' : '/api/repos'), loadVulns(force)]);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = parseReposBody(await res.json());
    // A slow poll can resolve after a later Refresh; applying it would undo the newer answer.
    if (generation !== requestGeneration) return;
    current = data;
    vulns = vulnResult.body;
    vulnsError = vulnResult.error;
    render();
    setBanner(reposBanner(data, vulnsError));
    indicator.setFetchedAt(data.fetchedAt, { flash: force });
    indicator.setBusy(false);
  } catch (err) {
    if (generation !== requestGeneration) return;
    setBanner(`Could not load repositories: ${String(err)}`);
    indicator.setBusy(false);
  }
}

document.getElementById('refresh')?.addEventListener('click', () => void refresh(true));

void refresh();
setInterval(() => void refresh(), POLL_MS);
