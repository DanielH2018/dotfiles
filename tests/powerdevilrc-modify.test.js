// Regression guard for home/dot_config/modify_powerdevilrc.sh.
//
// The behaviour worth pinning is PASS-THROUGH, not the value being set. PowerDevil owns
// ~/.config/powerdevilrc and writes every power setting into it, including
// AutoSuspendAction=0 -- the line that stops this box suspending while background Claude
// sessions are running. Replace this modify_ script with a plain managed file and that line
// is deleted on the next apply, KDE falls back to its auto-suspend default, and long-running
// work gets frozen mid-task by a config change nobody connected to it. That is the failure
// this file exists to catch; the timeout assertions below are the cheap part.
//
// The second failure mode is non-idempotency. chezmoi re-runs a modify_ script on every
// apply and compares its stdout to the current target, so any output that is not a pure
// function of its input leaves `chezmoi status` permanently dirty and re-prompts on each
// run -- which aborts non-interactive applies (see tests/chezmoi/chezmoi-umask-wrapper.test.js
// for the same class of bug from directory modes).
//
// Driven through bash rather than sh because that is what chezmoi does: chezmoi.toml sets
// [interpreters.sh] command = "bash", so the deployed behaviour is bash's.
//
// Offline. Skips without bash.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'home', 'dot_config', 'modify_powerdevilrc.sh');
const KEY = 'TurnOffDisplayIdleTimeoutSec';

let bashOk = true;
try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); } catch { bashOk = false; }
const skip = bashOk ? false : 'bash unavailable';

function run(input) {
  return execFileSync('bash', [SCRIPT], { input, encoding: 'utf8' });
}

const ini = (...lines) => lines.join('\n') + '\n';

test('keeps settings it does not own -- AutoSuspendAction must survive', { skip }, () => {
  const out = run(ini(
    '[AC][Display]', `${KEY}=1800`,
    '',
    '[AC][SuspendAndShutdown]', 'AutoSuspendAction=0',
  ));
  assert.match(out, /^AutoSuspendAction=0$/m,
    'auto-suspend setting was dropped; the box would start suspending under load');
  assert.match(out, /^\[AC\]\[SuspendAndShutdown\]$/m);
  assert.match(out, new RegExp(`^${KEY}=600$`, 'm'));
});

test('replaces an existing value in place, keeping sibling keys', { skip }, () => {
  const out = run(ini('[AC][Display]', `${KEY}=1800`, 'DimDisplayIdleTimeoutSec=300'));
  assert.match(out, new RegExp(`^${KEY}=600$`, 'm'));
  assert.doesNotMatch(out, new RegExp(`^${KEY}=1800$`, 'm'));
  assert.match(out, /^DimDisplayIdleTimeoutSec=300$/m, 'sibling key in the same group was lost');
});

test('adds the group when the file has other groups but not this one', { skip }, () => {
  const out = run(ini('[AC][SuspendAndShutdown]', 'AutoSuspendAction=0'));
  assert.match(out, /^\[AC\]\[Display\]$/m);
  assert.match(out, new RegExp(`^${KEY}=600$`, 'm'));
  assert.match(out, /^AutoSuspendAction=0$/m);
});

test('adds the key when the group is present but last and lacks it', { skip }, () => {
  const out = run(ini(
    '[AC][SuspendAndShutdown]', 'AutoSuspendAction=0',
    '',
    '[AC][Display]', 'DimDisplayIdleTimeoutSec=300',
  ));
  assert.match(out, new RegExp(`^${KEY}=600$`, 'm'));
  assert.match(out, /^DimDisplayIdleTimeoutSec=300$/m);
});

test('writes the group from empty input (target does not exist yet)', { skip }, () => {
  assert.strictEqual(run(''), `[AC][Display]\n${KEY}=600\n`);
});

test('does not touch the same key in a different group', { skip }, () => {
  // KConfig writes nested groups as one literal line, so [Battery][Display] carries its own
  // TurnOffDisplayIdleTimeoutSec. A bracket-splitting parser would clobber it.
  const out = run(ini(
    '[Battery][Display]', `${KEY}=120`,
    '',
    '[AC][Display]', `${KEY}=1800`,
  ));
  assert.match(out, new RegExp(`^${KEY}=120$`, 'm'), 'battery-profile timeout was overwritten');
  assert.match(out, new RegExp(`^${KEY}=600$`, 'm'));
});

test('collapses duplicate keys rather than accumulating them', { skip }, () => {
  const out = run(ini('[AC][Display]', `${KEY}=1800`, `${KEY}=900`));
  assert.strictEqual(out.match(new RegExp(`^${KEY}=`, 'gm')).length, 1);
});

test('is idempotent -- output is a fixed point', { skip }, () => {
  for (const input of [
    '',
    ini('[AC][Display]', `${KEY}=1800`),
    ini('[AC][SuspendAndShutdown]', 'AutoSuspendAction=0'),
    ini('[Battery][Display]', `${KEY}=120`, '', '[AC][Display]', 'DimDisplayIdleTimeoutSec=300'),
  ]) {
    const once = run(input);
    assert.strictEqual(run(once), once, `not a fixed point for input: ${JSON.stringify(input)}`);
  }
});
