// @ts-check

/** @typedef {import('../src/jobs.ts').JobStatus} JobStatus */

/**
 * Returns the jobs in a `GET /api/jobs` body, or null when the body is not that shape. The
 * server has already validated each job, so this only guards against a body from some
 * other server answering on the port.
 * @param {unknown} body
 * @returns {JobStatus[] | null}
 */
export function parseJobsBody(body) {
  if (typeof body !== 'object' || body === null) return null;
  const { jobs } = /** @type {{ jobs?: unknown }} */ (body);
  if (!Array.isArray(jobs)) return null;
  return jobs.filter(
    (j) => typeof j === 'object' && j !== null && typeof j.label === 'string' && typeof j.failed === 'boolean',
  );
}

/**
 * Returns a job's label without the `com.daniel` prefix every job shares, the same short
 * name the new tab's Jobs panel shows.
 * @param {string} label
 */
export function shortLabel(label) {
  return label.replace(/^com\.daniel(hunter)?\.(claude\.)?/, '');
}

/**
 * Returns the jobs with the failed ones first, each group in short-label order.
 * @param {readonly JobStatus[]} jobs
 */
export function sortJobs(jobs) {
  return [...jobs].sort(
    (a, b) => Number(b.failed) - Number(a.failed) || shortLabel(a.label).localeCompare(shortLabel(b.label)),
  );
}

/**
 * Returns the one-line count above the list, worded as the Jobs panel's note is.
 * @param {readonly JobStatus[]} jobs
 */
export function jobsTotals(jobs) {
  const failed = jobs.filter((j) => j.failed).length;
  const count = `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}`;
  return failed > 0 ? `${failed} of ${count} failing` : `${count}, none failing`;
}

/**
 * Returns a log's modification time as local `YYYY-MM-DD HH:MM`, or `no log` for null.
 * @param {number | null} logAt Epoch seconds.
 */
export function logTime(logAt) {
  if (logAt === null) return 'no log';
  const d = new Date(logAt * 1000);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
