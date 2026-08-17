// The cmdparse.sh half of the shared adversarial corpus in tests/fixtures/command-vectors.json.
//
// The corpus exists because two independent implementations judge Bash commands — this repo's
// cmdparse.sh, and auto-approve-readonly.py in ~/server/.claude/hooks — and both were fixed for
// the same newline-merges-two-commands bypass, separately, in two languages. They are meant to
// stay separate (see cmdparse.sh's header on why it is bash), so the corpus is what keeps them
// from diverging: this file asserts the `cmdparse` field, and the server repo's
// test_command_vectors.py asserts the `readonly` field of the same vectors.
//
// cmdparse.test.js still owns the detailed unit cases. This file is deliberately only the
// cross-implementation contract, so a vector added for one side is checked by both.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_cmdparse.sh');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'command-vectors.json');

const { vectors } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

const parse = (cmd) =>
  JSON.parse(execFileSync('bash', [LIB, '--json'], { input: cmd, encoding: 'utf8' }));

// Empty segments are dropped: a trailing separator leaves one behind, and every guard already
// skips it, so this is the split as a consumer actually sees it.
const segments = (parsed) => parsed.seg.map((s) => s.trim()).filter((s) => s !== '');

test('the corpus is not silently empty', () => {
  assert.ok(vectors.length >= 10, `expected a real corpus, got ${vectors.length} vectors`);
  assert.ok(vectors.some((v) => v.readonly), 'corpus has no read-only controls, so it cannot catch over-blocking');
  assert.ok(vectors.some((v) => !v.readonly), 'corpus has no dangerous vectors');
});

for (const v of vectors) {
  test(`cmdparse: ${v.name}`, () => {
    const parsed = parse(v.command);
    assert.strictEqual(parsed.status, v.cmdparse.status);
    assert.deepStrictEqual(segments(parsed), v.cmdparse.segments);
  });
}
