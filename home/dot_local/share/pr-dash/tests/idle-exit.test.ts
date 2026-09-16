// The always-on design's "The idle exit": the server exits 0 after 30 minutes with no
// request, so a launchd-managed process does not hold a resolved GitHub token in memory
// indefinitely. See docs/specs/2026-09-16-pr-dash-always-on-design.md.
import { test } from 'node:test';
import assert from 'node:assert';
import { createIdleExit, IDLE_TIMEOUT_MS } from '../src/main-lib.ts';

test('the idle window is 30 minutes', () => {
  assert.strictEqual(IDLE_TIMEOUT_MS, 1_800_000);
});

// A minimal fake timer, not a call-count stub: `clear` marks a handle so `fireAll` skips
// it, the same as a real cleared setTimeout never invoking its callback. That is the
// property "does not stack" actually depends on — a bare count of clearTimeout calls would
// pass just as well against an implementation that clears the wrong handle.
// `ms` is recorded, not discarded: asserting IDLE_TIMEOUT_MS as a constant says nothing
// about the delay createIdleExit actually schedules, so `}, 1)` in place of `}, timeoutMs)`
// left the whole suite green. At a 1-millisecond window the process exits seconds after
// each request and launchd respawns it, so the browser's poll lands either on a process
// about to exit or inside a respawn gap.
type FakeHandle = { cb: () => void; ms: number; cancelled: boolean; unref: () => void };

function fakeTimers() {
  const scheduled: FakeHandle[] = [];
  return {
    setTimeoutFn: (cb: () => void, ms: number): FakeHandle => {
      const handle: FakeHandle = { cb, ms, cancelled: false, unref: () => {} };
      scheduled.push(handle);
      return handle;
    },
    // Typed on the same minimal shape createIdleExit itself uses (`{ unref?: () => void }`)
    // rather than on FakeHandle directly, so this is a real implementation of the seam's
    // contract and not a signature that only this test's own handles could satisfy.
    clearTimeoutFn: (handle: { unref?: () => void }) => {
      (handle as FakeHandle).cancelled = true;
    },
    scheduled,
    fireAll(): void {
      for (const handle of scheduled) {
        if (!handle.cancelled) handle.cb();
      }
    },
  };
}

test('touch schedules a timer that unrefs itself', () => {
  let unreffed = 0;
  const setTimeoutFn = (cb: () => void, _ms: number) => {
    void cb;
    return { unref: () => (unreffed += 1) };
  };
  createIdleExit({ setTimeoutFn, clearTimeoutFn: () => {} });
  assert.strictEqual(unreffed, 1, 'the scheduled handle must be unref\'d immediately');
});

test('the scheduled delay is the idle window, not just a constant declared alongside it', () => {
  const timers = fakeTimers();
  createIdleExit({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    exit: () => {},
  });

  assert.strictEqual(timers.scheduled[0]!.ms, IDLE_TIMEOUT_MS);
});

test('an injected timeoutMs is the delay actually scheduled', () => {
  // Covers the other half of `opts.timeoutMs ?? IDLE_TIMEOUT_MS`: substituting a literal
  // for the injected value is as invisible as substituting one for the default.
  const timers = fakeTimers();
  const idleExit = createIdleExit({
    timeoutMs: 1_234,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    exit: () => {},
  });

  idleExit.touch();

  assert.deepStrictEqual(
    timers.scheduled.map((handle) => handle.ms),
    [1_234, 1_234],
    'both the constructor and touch must schedule the injected window',
  );
});

test('the idle timer exits with status 0 after the window elapses', () => {
  const timers = fakeTimers();
  let exitCode: number | undefined;
  createIdleExit({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    exit: (code) => {
      exitCode = code;
    },
  });

  timers.fireAll();

  assert.strictEqual(exitCode, 0, 'an idle exit must not be reported as a failure');
});

test('touch re-arms the window instead of leaving the original timer to fire', () => {
  const timers = fakeTimers();
  let exitCalls = 0;
  const idleExit = createIdleExit({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    exit: () => {
      exitCalls += 1;
    },
  });

  // The constructor already armed one timer; touch() must cancel it and arm a fresh one,
  // not add a second live one alongside it.
  idleExit.touch();
  const first = timers.scheduled[0]!;
  const second = timers.scheduled[1]!;
  assert.strictEqual(first.cancelled, true, 'the original timer must be cancelled by touch');
  assert.strictEqual(second.cancelled, false, 'the re-armed timer must still be live');

  timers.fireAll();
  assert.strictEqual(exitCalls, 1, 'only the still-live timer should ever fire');
});

test('a burst of requests leaves exactly one live timer, not one per request', () => {
  const timers = fakeTimers();
  let exitCalls = 0;
  const idleExit = createIdleExit({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    exit: () => {
      exitCalls += 1;
    },
  });

  for (let i = 0; i < 5; i += 1) idleExit.touch();

  const live = timers.scheduled.filter((handle) => !handle.cancelled);
  assert.strictEqual(live.length, 1, 'a burst of touches must cancel every timer but the newest');
  // The oldest (constructor) timer and the first four touch()es must all have been
  // cancelled — this is the part a "clearTimeoutFn was called N times" count would not
  // pin: it would pass even if touch cancelled the newest timer and left an old one live.
  assert.strictEqual(timers.scheduled[0]!.cancelled, true);
  assert.strictEqual(timers.scheduled[timers.scheduled.length - 2]!.cancelled, true);

  // Firing every scheduled callback (cancelled ones are no-ops, exactly like a real
  // cleared setTimeout) proves the burst produced one live callback, not five.
  timers.fireAll();
  assert.strictEqual(exitCalls, 1);
});

test('a request that arrives before the window elapses keeps the process alive', () => {
  const timers = fakeTimers();
  let exitCalls = 0;
  const idleExit = createIdleExit({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    exit: () => {
      exitCalls += 1;
    },
  });

  // Simulates a request landing partway through the window: cancel what was pending and
  // arm a fresh one, the same sequence touch() itself performs.
  idleExit.touch();
  timers.clearTimeoutFn(timers.scheduled[0]!);

  timers.fireAll();
  assert.strictEqual(exitCalls, 1, 'exactly the one still-live timer fires');
});
