// @ts-check
import { ciChip, draftChip, isSafeUrl, reviewChip } from './render-guards.js';

/** @typedef {import('../src/types.ts').PrRecord} PrRecord */

// The PR row the dashboard draws, shared by every page that lists PRs so they read the same.

/**
 * One PR as a dashboard row: a link carrying its number, title, state chips and staleness.
 * Builds elements only, so a page imports it without running anything at module scope.
 * @param {PrRecord} pr
 * @returns {HTMLAnchorElement}
 */
export function renderPrRow(pr) {
  const row = document.createElement('a');
  row.className = `row ci-${pr.ci} review-${pr.review}`;
  // `row:` prefixed so this can never collide with a stack toggle's bare PR id or a header's
  // axis-qualified key — the three key kinds share one lookup in `render`'s focus restore.
  row.dataset.key = `row:${pr.id}`;
  if (isSafeUrl(pr.url)) row.href = pr.url;
  row.target = '_blank';
  row.rel = 'noreferrer';

  const number = document.createElement('span');
  number.className = 'row-number';
  number.textContent = `#${pr.number}`;
  row.append(number);

  const title = document.createElement('span');
  title.className = 'row-title';
  title.textContent = pr.title;
  row.append(title);

  const meta = document.createElement('span');
  meta.className = 'meta';

  // Spans, not buttons. `.row` is an `<a>`, and a nested `<button>` is invalid there: a
  // `preventDefault` on click does not stop a middle-click, which dispatches `auxclick` and
  // opens the PR anyway. Nothing in the row is interactive except the row itself.
  for (const chip of [draftChip(pr.isDraft), ciChip(pr.ci), reviewChip(pr.review)]) {
    if (chip === null) continue;
    const el = document.createElement('span');
    el.className = `state-chip ${chip.tone}`;
    el.textContent = chip.label;
    meta.append(el);
  }

  const stale = document.createElement('span');
  stale.className = 'stale';
  stale.textContent = pr.staleDays === 1 ? '1 day' : `${pr.staleDays} days`;
  stale.title = 'Days since the last commit on this branch.';
  meta.append(stale);

  row.append(meta);
  return row;
}
