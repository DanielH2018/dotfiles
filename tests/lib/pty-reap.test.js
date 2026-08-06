// The pty harness has to survive its owner being killed, not just closed.
//
// Term.stop() runs from a t.after hook, so it covers the normal path and nothing else: a
// node killed by SIGKILL -- a worktree removed mid-run, a test runner reaped by the job
// that spawned it -- never reaches any cleanup handler. `detached: true` then puts script(1)
// outside node's process group, so a kill of that group misses it too. One such run left a
// full agentview picker (script, three bashes, an fzf, a respawning inotifywait) polling
// for an hour after the test that made it was gone, with its scratch HOME still being
// written to.
//
// Asserting the watchdog string appears in the spawn arguments would prove nothing about
// that. This kills a real owner and looks for real survivors.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { ptySkip, sleep } = require('./pty');

const PTY_LIB = path.join(__dirname, 'pty.js');
const skip = ptySkip();

// The marker rides in the pty'd command so ps can tell this test's tree from any other
// suite's -- suites run in parallel, and `sleep` alone would match half of them.
const alive = (marker) => {
  try {
    return execFileSync('ps', ['-eo', 'pid,cmd'], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes(marker) && !l.includes('ps -eo'))
      .map((l) => Number(l.trim().split(/\s+/)[0]));
  } catch {
    return [];
  }
};

const waitUntil = async (fn, { timeout = 10000, interval = 100 } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (fn()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(interval);
  }
};

test('a pty tree does not outlive the node process that owns it', { skip }, async (t) => {
  const marker = `pty-reap-marker-${process.pid}`;
  const src = `
    const { Term } = require(${JSON.stringify(PTY_LIB)});
    new Term(['bash', '-c', 'sleep 600 # ${marker}']);
    setInterval(() => {}, 1000);
  `;
  const owner = spawn(process.execPath, ['-e', src], { stdio: 'ignore' });

  // Any survivor is a leak of this test's own making; don't leave one behind on failure.
  t.after(() => {
    try { owner.kill('SIGKILL'); } catch { /* already gone */ }
    for (const pid of alive(marker)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  assert.ok(
    await waitUntil(() => alive(marker).length > 0),
    'the child never brought its pty tree up, so the reap below would prove nothing',
  );

  process.kill(owner.pid, 'SIGKILL');   // no exit handler, no t.after, no stop()

  const reaped = await waitUntil(() => alive(marker).length === 0);
  assert.ok(
    reaped,
    `pty tree outlived its owner; survivors: ${JSON.stringify(alive(marker))}`,
  );
});
