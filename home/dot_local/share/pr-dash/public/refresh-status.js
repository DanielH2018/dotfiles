// @ts-check
import { formatRelativeTime } from './render-guards.js';

/**
 * The Refresh button's feedback, shared by the PR and vulnerability pages.
 *
 * Without it a click gave no sign it had started, and a click whose answer matched what was
 * already on screen gave no sign it had finished either. The button says "Refreshing…" for
 * as long as the request runs, and the status beside it names when the data on screen was
 * fetched. That time is the server's `fetchedAt`, not the moment the response arrived: a
 * click the server throttled is answered from its cache, and the stamp has to say so.
 */

/** How often the page re-renders the relative "Updated …" text so it does not freeze. */
export const STATUS_TICK_MS = 30_000;

/**
 * @param {string} fetchedAt ISO time the data on screen was fetched, or '' when unknown.
 * @param {number} [now] Milliseconds since epoch; defaults to `Date.now()`.
 * @returns {string} '' when there is no valid time to report.
 */
export function updatedText(fetchedAt, now = Date.now()) {
  if (!Number.isFinite(Date.parse(fetchedAt))) return '';
  return `Updated ${formatRelativeTime(fetchedAt, now)}`;
}

/**
 * @typedef {object} RefreshIndicator
 * @property {(busy: boolean) => void} setBusy Marks a refresh as started or settled.
 * @property {(fetchedAt: string, opts?: { flash?: boolean }) => void} setFetchedAt
 *   Records the fetch time of the data now on screen. `flash` briefly highlights the stamp,
 *   so a click whose answer changed nothing still visibly completed.
 */

/**
 * Binds the indicator to the page's Refresh button and its status element, and keeps the
 * relative time current. Either element may be missing; the matching half is then skipped.
 * @param {HTMLButtonElement | null} button
 * @param {HTMLElement | null} status
 * @param {(repaint: () => void) => void} [tick] Arms the periodic repaint. Injectable so a
 *   test can drive it without leaving a live interval behind.
 * @returns {RefreshIndicator}
 */
export function createRefreshIndicator(button, status, tick = (repaint) => void setInterval(repaint, STATUS_TICK_MS)) {
  const idleLabel = button?.textContent ?? 'Refresh';
  let fetchedAt = '';

  const paint = () => {
    if (status === null) return;
    const text = updatedText(fetchedAt);
    status.textContent = text;
    // The absolute time sits in the tooltip, for when "3 minutes ago" is not precise enough.
    status.title = text === '' ? '' : new Date(fetchedAt).toLocaleString();
  };
  tick(paint);

  return {
    setBusy(busy) {
      if (button === null) return;
      // Disabled rather than left clickable: a second click mid-flight would only be
      // downgraded by the server's force throttle, and would read as a second fetch.
      button.disabled = busy;
      button.setAttribute('aria-busy', String(busy));
      button.textContent = busy ? 'Refreshing…' : idleLabel;
    },
    setFetchedAt(at, opts = {}) {
      fetchedAt = at;
      paint();
      if (opts.flash === true && status !== null) {
        // Removed and re-added across a reflow so the animation restarts on a quick second click.
        status.classList.remove('flash');
        void status.offsetWidth;
        status.classList.add('flash');
      }
    },
  };
}
