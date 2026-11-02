// @ts-check
import { jobsTotals, logTime, parseJobsBody, shortLabel, sortJobs } from './job-view.js';

/** @typedef {import('../src/jobs.ts').JobStatus} JobStatus */

// The server caches jobstat's answer for two minutes, so polling faster only re-reads it.
const POLL_MS = 2 * 60 * 1000;

let scrolledToHash = false;

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

/** @param {string | null} text */
function setBanner(text) {
  const banner = document.getElementById('banner');
  if (banner === null) return;
  banner.textContent = text ?? '';
  banner.hidden = text === null;
}

/** Returns the label the URL fragment names, or '' when there is none. */
function linkedLabel() {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return '';
  }
}

/** @param {JobStatus} job */
function renderRow(job) {
  const row = document.createElement('div');
  // A class rather than `:target`: the browser resolves the fragment before these rows exist.
  row.className = job.label === linkedLabel() ? 'row job-row linked' : 'row job-row';
  // The full label, so the new tab's Jobs panel can link straight to a row.
  row.id = job.label;

  row.append(span(job.failed ? 'failed' : 'ok', `state-chip ${job.failed ? 'bad' : 'good'}`));
  const name = span(shortLabel(job.label), 'job-name');
  name.title = job.label;
  row.append(name);
  row.append(span(job.status, 'row-title job-status'));

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.append(span(job.schedule, 'badge'));
  const at = span(logTime(job.logAt), 'stale');
  at.title = 'When the job last wrote its log.';
  meta.append(at);
  if (job.log !== null) meta.append(span(job.log, 'job-log'));
  row.append(meta);
  return row;
}

/** @param {JobStatus[]} jobs */
function render(jobs) {
  const main = document.getElementById('jobs');
  const totals = document.getElementById('totals');
  if (main === null || totals === null) return;
  totals.textContent = `${jobsTotals(jobs)}. Run jobstat in a terminal for each job's last log line.`;
  totals.hidden = false;
  main.replaceChildren();
  if (jobs.length === 0) {
    main.append(span('jobstat found no launchd jobs.', 'empty'));
    return;
  }
  for (const job of sortJobs(jobs)) main.append(renderRow(job));
  // The rows arrive after the browser's own jump to the fragment, so it found nothing to
  // scroll to. Done once, so a later poll never yanks the page back.
  const linked = linkedLabel();
  if (!scrolledToHash && linked !== '') {
    scrolledToHash = true;
    document.getElementById(linked)?.scrollIntoView({ block: 'center' });
  }
}

async function refresh() {
  try {
    const res = await fetch('/api/jobs');
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const jobs = parseJobsBody(await res.json());
    if (jobs === null) throw new Error('the answer is not a list of jobs');
    render(jobs);
    setBanner(null);
  } catch (err) {
    setBanner(`Could not load jobs: ${String(err)}`);
  }
}

void refresh();
setInterval(() => void refresh(), POLL_MS);
