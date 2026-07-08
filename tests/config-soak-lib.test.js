'use strict';
// Pure-logic tests for the config soak gate. No filesystem, network, or clock:
// `now` and the tracked/manifest inputs are all injected, so these are total and
// deterministic (never flaky).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const lib = require(path.join(__dirname, '..', 'bin', 'config-soak-lib.js'));

const NOW = '2026-07-08T00:00:00.000Z';
const daysAgo = (n) => new Date(Date.parse(NOW) - n * lib.DAY_MS).toISOString();

test('fingerprint is deterministic and content-sensitive', () => {
  assert.strictEqual(lib.fingerprint('abc'), lib.fingerprint('abc'));
  assert.notStrictEqual(lib.fingerprint('abc'), lib.fingerprint('abd'));
  // Stable known sha256 of "abc".
  assert.strictEqual(
    lib.fingerprint('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

test('buildReport classifies every state', () => {
  const tracked = {
    'a.sh': 'h_a',       // recorded, unchanged, old  -> stable
    'b.sh': 'h_b',       // recorded, unchanged, fresh -> soaking
    'c.sh': 'h_c_new',   // recorded but content differs -> changed
    'd.sh': 'h_d',       // never recorded -> unrecorded
  };
  const manifest = {
    windowDays: 7,
    entries: [
      { path: 'a.sh', hash: 'h_a', landed: daysAgo(30) },
      { path: 'b.sh', hash: 'h_b', landed: daysAgo(2) },
      { path: 'c.sh', hash: 'h_c_old', landed: daysAgo(1) },
      { path: 'gone.sh', hash: 'h_gone', landed: daysAgo(10) }, // deleted -> removed
    ],
  };
  const r = lib.buildReport({ tracked, manifest, now: NOW });

  assert.strictEqual(r.windowDays, 7);
  assert.deepStrictEqual(r.stable.map((x) => x.path), ['a.sh']);
  assert.deepStrictEqual(r.soaking.map((x) => x.path), ['b.sh']);
  assert.deepStrictEqual(r.changed.map((x) => x.path), ['c.sh']);
  assert.deepStrictEqual(r.unrecorded.map((x) => x.path), ['d.sh']);
  assert.deepStrictEqual(r.removed.map((x) => x.path), ['gone.sh']);

  // soaking exposes a countdown; 2 days into a 7-day window -> 5 remaining.
  assert.strictEqual(r.soaking[0].daysRemaining, 5);
  // changed carries both hashes so a reviewer can see what moved.
  assert.strictEqual(r.changed[0].recordedHash, 'h_c_old');
});

test('window boundary: exactly windowDays old is stable (>=)', () => {
  const tracked = { 'x.sh': 'h' };
  const mk = (days) => lib.buildReport({
    tracked,
    manifest: { windowDays: 7, entries: [{ path: 'x.sh', hash: 'h', landed: daysAgo(days) }] },
    now: NOW,
  });
  assert.strictEqual(mk(7).stable.length, 1, 'exactly at window -> stable');
  assert.strictEqual(mk(6.999).soaking.length, 1, 'just under window -> soaking');
});

test('windowDays override beats manifest which beats default', () => {
  const tracked = { 'x.sh': 'h' };
  const entries = [{ path: 'x.sh', hash: 'h', landed: daysAgo(5) }];
  // default 7 (no windowDays in manifest) -> still soaking at 5 days
  assert.strictEqual(lib.buildReport({ tracked, manifest: { entries }, now: NOW }).soaking.length, 1);
  // manifest window 3 -> stable at 5 days
  assert.strictEqual(lib.buildReport({ tracked, manifest: { windowDays: 3, entries }, now: NOW }).stable.length, 1);
  // explicit override 10 wins over manifest 3 -> soaking again
  assert.strictEqual(lib.buildReport({ tracked, manifest: { windowDays: 3, entries }, now: NOW, windowDays: 10 }).soaking.length, 1);
});

test('gateFailures counts only unrecorded + changed + removed', () => {
  const report = { unrecorded: [1], changed: [1, 2], removed: [1], soaking: [1, 2, 3], stable: [1] };
  assert.strictEqual(lib.gateFailures(report), 4);
  assert.strictEqual(lib.gateFailures({ unrecorded: [], changed: [], removed: [], soaking: [1], stable: [1] }), 0);
});

test('land stamps new/changed now, preserves unchanged clock, drops deleted', () => {
  const tracked = { 'a.sh': 'h_a', 'b.sh': 'h_b_new', 'c.sh': 'h_c' };
  const manifest = {
    windowDays: 7,
    entries: [
      { path: 'a.sh', hash: 'h_a', landed: daysAgo(30) },     // unchanged
      { path: 'b.sh', hash: 'h_b_old', landed: daysAgo(30) }, // changed
      { path: 'gone.sh', hash: 'h_gone', landed: daysAgo(30) }, // deleted
      // c.sh is new
    ],
  };
  const next = lib.land({ tracked, manifest, now: NOW });
  const byPath = Object.fromEntries(next.entries.map((e) => [e.path, e]));

  assert.strictEqual(next.windowDays, 7, 'window carried forward');
  assert.strictEqual(byPath['a.sh'].landed, daysAgo(30), 'unchanged clock preserved');
  assert.strictEqual(byPath['b.sh'].landed, NOW, 'changed clock reset to now');
  assert.strictEqual(byPath['b.sh'].hash, 'h_b_new', 'changed hash updated');
  assert.strictEqual(byPath['c.sh'].landed, NOW, 'new file stamped now');
  assert.ok(!('gone.sh' in byPath), 'deleted file dropped from ledger');

  // After an unfiltered land the gate must pass.
  assert.strictEqual(lib.gateFailures(lib.buildReport({ tracked, manifest: next, now: NOW })), 0);
});

test('land is pure (does not mutate the input manifest)', () => {
  const manifest = { windowDays: 7, entries: [{ path: 'a.sh', hash: 'old', landed: daysAgo(30) }] };
  const snapshot = JSON.stringify(manifest);
  lib.land({ tracked: { 'a.sh': 'new' }, manifest, now: NOW });
  assert.strictEqual(JSON.stringify(manifest), snapshot, 'input manifest untouched');
});

test('land with a path filter acknowledges only the listed paths', () => {
  const tracked = { 'a.sh': 'h_a_new', 'b.sh': 'h_b_new' };
  const manifest = {
    windowDays: 7,
    entries: [
      { path: 'a.sh', hash: 'h_a_old', landed: daysAgo(30) },
      { path: 'b.sh', hash: 'h_b_old', landed: daysAgo(30) },
    ],
  };
  const next = lib.land({ tracked, manifest, now: NOW, paths: ['a.sh'] });
  const byPath = Object.fromEntries(next.entries.map((e) => [e.path, e]));

  assert.strictEqual(byPath['a.sh'].hash, 'h_a_new', 'listed path refreshed');
  assert.strictEqual(byPath['a.sh'].landed, NOW);
  assert.strictEqual(byPath['b.sh'].hash, 'h_b_old', 'unlisted path keeps old record');

  // b.sh remains a gate failure (still changed) after the scoped land.
  const r = lib.buildReport({ tracked, manifest: next, now: NOW });
  assert.deepStrictEqual(r.changed.map((x) => x.path), ['b.sh']);
});

test('empty tracked set with empty manifest is a clean pass', () => {
  const r = lib.buildReport({ tracked: {}, manifest: { entries: [] }, now: NOW });
  assert.strictEqual(lib.gateFailures(r), 0);
  assert.strictEqual(r.windowDays, lib.DEFAULT_WINDOW_DAYS);
});
