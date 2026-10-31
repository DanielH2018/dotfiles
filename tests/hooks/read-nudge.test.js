// The PreToolUse/Read nudge shim (dotfiles #1085): it passes the judge's nudge through, and
// whatever cannot run prints nothing on stdout, so the Read goes ahead un-nudged. Drives the
// ACTUAL hook with a stub `uv` on PATH that hands back a stub interpreter.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_read-nudge.sh');

const skip = skipUnless('bash', 'timeout');

const DIR = scratch(os.tmpdir(), 'read-nudge-');
const BIN = path.join(DIR, 'bin');
const SHARE = path.join(DIR, 'share');
fs.mkdirSync(BIN);
fs.mkdirSync(path.join(SHARE, 'claude_guard'), { recursive: true });
fs.writeFileSync(path.join(SHARE, 'claude_guard', 'cli.py'), '');
const PY = path.join(DIR, 'python3.14');
const NUDGE = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"x"}}';
// The stub judge checks it was asked for read-nudge, then prints the nudge, or fails after
// printing it, as STUB_PY says.
fs.writeFileSync(PY, `#!/bin/bash
cat >/dev/null
[ "$5" = read-nudge ] || exit 3
printf '%s\\n' '${NUDGE}'
[ "\${STUB_PY:-}" = fail ] && exit 1
exit 0
`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'uv'), `#!/bin/bash
printf '%s\\n' ${JSON.stringify(PY)}
`, { mode: 0o755 });

function run(env = {}) {
  return spawnSync('bash', [HOOK], {
    input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } }),
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${BIN}:${process.env.PATH}`, CLAUDE_GUARD_HOME: SHARE,
      CLAUDE_GUARD_TIMEOUT_S: '10', GUARD_PYTHON_CACHE: '0', ...env,
    },
  });
}

test('the read-nudge entry has its nudge passed through', { skip }, () => {
  const r = run();
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), NUDGE, `stderr: ${r.stderr}`);
});

test('a judge that exits non-zero has its output dropped and the Read goes ahead', { skip }, () => {
  const r = run({ STUB_PY: 'fail' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /exit 1.*no nudge/);
});
