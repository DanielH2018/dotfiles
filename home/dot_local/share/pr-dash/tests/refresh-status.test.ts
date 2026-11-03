import { test } from 'node:test';
import assert from 'node:assert';
import { createRefreshIndicator, updatedText } from '../public/refresh-status.js';

const NOW = Date.parse('2026-11-03T12:00:00Z');

function fakeButton() {
  const attrs = new Map<string, string>();
  return {
    textContent: 'Refresh',
    disabled: false,
    attrs,
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
    },
  };
}

function fakeStatus() {
  const classes = new Set<string>();
  return {
    textContent: '',
    title: '',
    offsetWidth: 0,
    classes,
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
    },
  };
}

test('updatedText names the fetch time relative to now, and is empty without a valid time', () => {
  assert.strictEqual(updatedText('2026-11-03T11:59:30Z', NOW), 'Updated just now');
  assert.strictEqual(updatedText('2026-11-03T11:57:00Z', NOW), 'Updated 3 minutes ago');
  assert.strictEqual(updatedText('', NOW), '');
  assert.strictEqual(updatedText('not a date', NOW), '');
});

test('setBusy disables the button and relabels it until the refresh settles', () => {
  const button = fakeButton();
  const indicator = createRefreshIndicator(button as unknown as HTMLButtonElement, null, () => {});

  indicator.setBusy(true);
  assert.deepStrictEqual(
    [button.disabled, button.textContent, button.attrs.get('aria-busy')],
    [true, 'Refreshing…', 'true'],
  );

  indicator.setBusy(false);
  assert.deepStrictEqual(
    [button.disabled, button.textContent, button.attrs.get('aria-busy')],
    [false, 'Refresh', 'false'],
  );
});

test('setFetchedAt shows the stamp, flashes only when asked, and the tick keeps it current', () => {
  const status = fakeStatus();
  let repaint = () => {};
  const indicator = createRefreshIndicator(null, status as unknown as HTMLElement, (fn) => {
    repaint = fn;
  });
  const fetchedAt = new Date(Date.now() - 30_000).toISOString();

  indicator.setFetchedAt(fetchedAt);
  assert.strictEqual(status.textContent, 'Updated just now');
  assert.ok(!status.classes.has('flash'), 'an ordinary poll must not flash');

  indicator.setFetchedAt(fetchedAt, { flash: true });
  assert.ok(status.classes.has('flash'), 'a Refresh click flashes the stamp');

  // A stamp painted once and never again would read "just now" for the life of the tab.
  status.textContent = '';
  repaint();
  assert.strictEqual(status.textContent, 'Updated just now');
});
