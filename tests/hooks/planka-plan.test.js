// The plan hook's whole job is to hand its stdin payload to the CLI without
// blocking or failing the TodoWrite call that triggered it.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(
  __dirname, '..', '..', 'home', 'private_dot_claude', 'hooks',
  'executable_planka-plan.sh',
);

// Every scratch dir this suite makes, removed on the way out — bin/sweep-test-tmp
// only collects leftovers six hours later.
const scratch = [];
after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planka-plan-'));
  scratch.push(dir);
  return dir;
}

function stubBin(dir, script) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'planka'), script, { mode: 0o755 });
  return bin;
}

// The hook backgrounds the CLI, so give it a moment to land. Wait for content
// rather than existence: `cat > file` creates the file before it writes a byte,
// so an existence check can win the race and still read nothing.
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

test('forwards the payload to the CLI on stdin and exits 0', () => {
  const dir = tmpdir();
  const captured = path.join(dir, 'captured');
  const bin = stubBin(dir, `#!/bin/sh\ncat > ${captured}\nexit 0\n`);
  const payload = JSON.stringify({
    tool_input: { todos: [{ content: 'A', status: 'pending' }] },
  });
  const r = spawnSync('bash', [HOOK], {
    encoding: 'utf8',
    input: payload,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.strictEqual(r.status, 0);
  const body = waitForContent(captured);
  assert.notStrictEqual(body, '', 'the CLI received the payload');
  assert.deepStrictEqual(JSON.parse(body), JSON.parse(payload));
});

test('PLANKA_TRACKING=0 forwards nothing', () => {
  const dir = tmpdir();
  const captured = path.join(dir, 'captured');
  const bin = stubBin(dir, `#!/bin/sh\ncat > ${captured}\n`);
  const r = spawnSync('bash', [HOOK], {
    encoding: 'utf8',
    input: '{}',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PLANKA_TRACKING: '0' },
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.existsSync(captured), false);
});

test('a CLI that fails does not fail the hook', () => {
  const dir = tmpdir();
  const bin = stubBin(dir, '#!/bin/sh\nexit 4\n');
  const r = spawnSync('bash', [HOOK], {
    encoding: 'utf8',
    input: '{}',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.strictEqual(r.status, 0);
});
