// Behavior check for the zz() zoxide-jump helper in shell/common.sh.
// The score-stripping sed is pulled straight out of common.sh and run against a fixture
// shaped like real `zoxide query -ls` output, so the row format and the expression stay
// in sync. zz() feeds its result to `cd`, which is aliased to zoxide, so a stray score
// left on the front does not error loudly — it silently becomes a query that matches
// nothing. That failure mode is invisible without a test.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const COMMON = path.join(__dirname, '..', 'home', 'dot_config', 'shell', 'common.sh');

let bashOk = true;
try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); } catch { bashOk = false; }
const skip = bashOk ? false : 'bash unavailable';

// `zoxide query -ls` right-aligns the score, so every row starts with whitespace.
const FIXTURE = [
  '  32.0 /home/daniel/.local/share/chezmoi',
  '   1.0 /home',
  ' 145.5 /home/daniel/dev/some project',
  '1234.0 /home/daniel/dev',
].join('\n');

// Pull the sed program out of the zz() line rather than restating it here.
function scoreStripper() {
  const line = fs.readFileSync(COMMON, 'utf8')
    .split('\n')
    .find((l) => l.includes('zoxide query -ls') && l.includes('sed') && !l.trimStart().startsWith('#'));
  assert.ok(line, 'zz() zoxide query line found in common.sh');
  const m = line.match(/sed '([^']*)'/);
  assert.ok(m, 'sed program found on the zoxide query line');
  return m[1];
}

test('zz() strips the zoxide score and leaves the bare path', { skip }, () => {
  const out = execFileSync('sed', [scoreStripper()], { input: FIXTURE, encoding: 'utf8' });
  assert.deepStrictEqual(out.trimEnd().split('\n'), [
    '/home/daniel/.local/share/chezmoi',
    '/home',
    '/home/daniel/dev/some project',
    '/home/daniel/dev',
  ]);
});

test('every stripped row is an absolute path, not a score fragment', { skip }, () => {
  const out = execFileSync('sed', [scoreStripper()], { input: FIXTURE, encoding: 'utf8' });
  for (const row of out.trimEnd().split('\n')) {
    assert.ok(row.startsWith('/'), `expected an absolute path, got ${JSON.stringify(row)}`);
  }
});
