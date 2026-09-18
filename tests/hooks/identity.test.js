// Unit tests for hooks/identity.sh — the (pid, procStart) check that has to hold before
// anything signals a recorded process. The reaper suites cover it behaviourally; this
// covers the library directly, because the later agentview/purge call sites consume these
// functions rather than the reaper.
//
// Seam: IDENTITY_PROC_DIR (a fake /proc, so no real process is read).
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const LIB = srcPath('private_dot_claude', 'hooks', 'identity.sh');

const skip = skipUnless('bash', 'jq');

// A /proc/<pid>/stat line. `comm` is placed verbatim inside the parens so a name
// containing spaces and parens can be exercised.
function fakeProc(entries) {
  const procdir = path.join(scratch(os.tmpdir(), 'identity-'), 'proc');
  for (const [pid, { comm = 'claude', start = '900100' }] of Object.entries(entries)) {
    fs.mkdirSync(path.join(procdir, pid), { recursive: true });
    const pad = Array.from({ length: 18 }, (_, i) => i).join(' ');
    fs.writeFileSync(path.join(procdir, pid, 'stat'), `${pid} (${comm}) S ${pad} ${start}\n`);
  }
  return procdir;
}

// Source the lib and run one expression, returning trimmed stdout plus the exit status.
function sh(procdir, expr) {
  const script = `set -u; IDENTITY_PROC_DIR=${JSON.stringify(procdir)}; . ${JSON.stringify(LIB)}; ${expr}; printf 'rc=%s' "$?"`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
}

test('proc_start_of reads field 22 for an ordinary comm', { skip }, () => {
  const p = fakeProc({ 4242: { start: '300592' } });
  assert.strictEqual(sh(p, 'proc_start_of 4242'), '300592\nrc=0');
});

test('proc_start_of survives a comm containing spaces and parens', { skip }, () => {
  // The bug this avoids: `awk '{print $22}'` counts fields from the left and shifts by
  // one for every space inside the parenthesised name.
  const p = fakeProc({ 4242: { comm: 'claude (bg) worker', start: '300592' } });
  assert.strictEqual(sh(p, 'proc_start_of 4242'), '300592\nrc=0');
});

test('proc_start_of on an absent pid prints nothing and fails', { skip }, () => {
  const p = fakeProc({});
  assert.strictEqual(sh(p, 'proc_start_of 4242'), 'rc=1');
});

test('proc_start_of rejects a non-numeric pid', { skip }, () => {
  const p = fakeProc({});
  assert.strictEqual(sh(p, 'proc_start_of "; touch /tmp/pwned"'), 'rc=1');
});

test('verify_target: matching start time is live', { skip }, () => {
  const p = fakeProc({ 4242: { start: '300592' } });
  assert.strictEqual(sh(p, 'verify_target 4242 300592'), 'live\nrc=0');
});

test('verify_target: differing start time is different, not live', { skip }, () => {
  const p = fakeProc({ 4242: { start: '288106' } });
  assert.strictEqual(sh(p, 'verify_target 4242 1375'), 'different\nrc=1');
});

test('verify_target: absent process is dead', { skip }, () => {
  const p = fakeProc({});
  assert.strictEqual(sh(p, 'verify_target 4242 300592'), 'dead\nrc=1');
});

test('verify_target: nothing recorded to compare is unverifiable', { skip }, () => {
  const p = fakeProc({ 4242: { start: '300592' } });
  assert.strictEqual(sh(p, 'verify_target 4242 ""'), 'unverifiable\nrc=1');
});

test('verify_target: unreadable stat under a live pid dir is unverifiable, not dead', { skip }, () => {
  const p = fakeProc({ 4242: { start: '300592' } });
  fs.rmSync(path.join(p, '4242', 'stat'));
  assert.strictEqual(sh(p, 'verify_target 4242 300592'), 'unverifiable\nrc=1');
});

test('only live returns success', { skip }, () => {
  const p = fakeProc({ 1: { start: '5' } });
  for (const [args, verdict] of [['1 5', 'live'], ['1 9', 'different'], ['2 5', 'dead'], ['1 ""', 'unverifiable']]) {
    const out = sh(p, `verify_target ${args}`);
    assert.match(out, new RegExp(`^${verdict}\\n`), `${args} -> ${verdict}`);
    assert.strictEqual(out.endsWith('rc=0'), verdict === 'live', `${verdict} exit status`);
  }
});
