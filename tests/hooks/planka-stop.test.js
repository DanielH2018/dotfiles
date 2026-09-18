// The Stop hook comments once, and only for a session that actually claimed a
// card. A session that only read and answered questions must leave no trace.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_planka-stop.sh');

// Same gate as planka-claim.test.js: the board is set up on one machine, and these
// hooks race a backgrounded CLI call everywhere else.
const skip = fs.existsSync(path.join(os.homedir(), '.config', 'planka', 'config.json'))
  ? false
  : 'no ~/.config/planka/config.json: the Planka board is not set up on this machine';

// Every scratch dir this suite makes, removed on the way out — bin/sweep-test-tmp
// only collects leftovers six hours later.

function setup() {
  const dir = scratch(os.tmpdir(), 'planka-stop-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const captured = path.join(dir, 'captured');
  fs.writeFileSync(path.join(bin, 'planka'), `#!/bin/sh\ncat > ${captured}\nexit 0\n`,
    { mode: 0o755 });
  return { dir, bin, captured, state: path.join(dir, 'state') };
}

function fire({ bin, state, sessionId = 'sess-1' }) {
  return spawnSync('bash', [HOOK], {
    encoding: 'utf8',
    input: JSON.stringify({ session_id: sessionId }),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PLANKA_STATE_DIR: state },
  });
}

// Wait for content, not existence: `cat > file` creates the file before it
// writes a byte, so an existence check can win the race and read nothing.
function waitForContent(file) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      const body = fs.readFileSync(file, 'utf8');
      if (body.length > 0) return body;
    } catch { /* not created yet */ }
    if (Date.now() >= deadline) return '';
  }
}

function claim(state, sessionId = 'sess-1') {
  fs.mkdirSync(path.join(state, 'claimed'), { recursive: true });
  fs.writeFileSync(path.join(state, 'claimed', sessionId), '');
}

test('a session that never claimed a card comments nothing', { skip }, () => {
  const { bin, state, captured } = setup();
  const r = fire({ bin, state });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.existsSync(captured), false);
});

test('a claimed session posts its summary file', { skip }, () => {
  const { bin, state, captured } = setup();
  claim(state);
  fs.mkdirSync(path.join(state, 'summary'), { recursive: true });
  fs.writeFileSync(path.join(state, 'summary', 'sess-1'), 'Reconciled the ledger writer.');
  const r = fire({ bin, state });
  assert.strictEqual(r.status, 0);
  assert.match(waitForContent(captured), /Reconciled the ledger writer\./);
});

test('a claimed session with no summary still says something true', { skip }, () => {
  const { bin, state, captured } = setup();
  claim(state);
  const r = fire({ bin, state });
  assert.strictEqual(r.status, 0);
  assert.match(waitForContent(captured), /paused/i);
});

test('PLANKA_TRACKING=0 comments nothing even for a claimed session', { skip }, () => {
  const { bin, state, captured } = setup();
  claim(state);
  const r = spawnSync('bash', [HOOK], {
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'sess-1' }),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PLANKA_STATE_DIR: state,
      PLANKA_TRACKING: '0',
    },
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.existsSync(captured), false);
});
