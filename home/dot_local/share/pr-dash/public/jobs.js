// @ts-check
import { jobLogPath, jobLogText, jobsTotals, logTime, parseJobsBody, shortLabel, sortJobs } from './job-view.js';

/** @typedef {import('../src/jobs.ts').JobStatus} JobStatus */

// The server caches jobstat's answer for two minutes, so polling faster only re-reads it.
const POLL_MS = 2 * 60 * 1000;

let scrolledToHash = false;

/** The labels whose log is open, so a poll's re-render keeps them open. @type {Set<string>} */
const openLogs = new Set();

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

/**
 * Fills `pre` with the end of the job's log, scrolled to the last line.
 * @param {HTMLPreElement} pre
 * @param {string} label
 */
async function loadLog(pre, label) {
  pre.textContent = 'Loading the log…';
  try {
    const res = await fetch(jobLogPath(label));
    const body = await res.json();
    if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : String(res.status));
    const text = jobLogText(body);
    if (text === null) throw new Error('the answer is not a job log');
    pre.textContent = text;
    pre.scrollTop = pre.scrollHeight;
  } catch (err) {
    pre.textContent = `Could not load the log: ${String(err)}`;
  }
}

/**
 * Returns the button that shows and hides `pre`, fetching the log each time it opens.
 * @param {HTMLPreElement} pre
 * @param {string} label
 */
function logToggle(pre, label) {
  const button = document.createElement('button');
  const show = (/** @type {boolean} */ open) => {
    pre.hidden = !open;
    button.textContent = open ? 'hide log' : 'show log';
    button.setAttribute('aria-expanded', String(open));
    if (open) {
      openLogs.add(label);
      void loadLog(pre, label);
    } else {
      openLogs.delete(label);
    }
  };
  button.addEventListener('click', () => show(pre.hidden));
  show(openLogs.has(label));
  return button;
}

/** @param {JobStatus} job */
function renderJob(job) {
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
  const wrapper = document.createElement('div');
  wrapper.append(row);
  if (job.log !== null) {
    meta.append(span(job.log, 'job-log'));
    const pre = document.createElement('pre');
    pre.className = 'job-log-text';
    meta.append(logToggle(pre, job.label));
    wrapper.append(pre);
  }
  row.append(meta);
  return wrapper;
}

/** @param {JobStatus[]} jobs */
function render(jobs) {
  const main = document.getElementById('jobs');
  const totals = document.getElementById('totals');
  if (main === null || totals === null) return;
  totals.textContent = `${jobsTotals(jobs)}.`;
  totals.hidden = false;
  main.replaceChildren();
  if (jobs.length === 0) {
    main.append(span('jobstat found no launchd jobs.', 'empty'));
    return;
  }
  // The new tab links a failed job here, so its log opens on arrival. Once, like the scroll.
  const linked = linkedLabel();
  if (!scrolledToHash && linked !== '') openLogs.add(linked);
  for (const job of sortJobs(jobs)) main.append(renderJob(job));
  // The rows arrive after the browser's own jump to the fragment, so it found nothing to
  // scroll to. Done once, so a later poll never yanks the page back.
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
