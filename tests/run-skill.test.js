// Tests for the Linux run-skill.sh (home/private_dot_claude/scheduled/executable_run-skill.sh).
// Its once-a-day marker is named for the UTC day (#579): "already ran today" must not move
// with the host timezone. Real bash against the ACTUAL script, with a stub `claude`.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scratch } = require('./lib/tmp');
const { skipUnless } = require('./lib/probe');
const { srcPath } = require('./lib/paths');

const SCRIPT = srcPath('private_dot_claude', 'scheduled', 'executable_run-skill.sh');
const skip = skipUnless('bash', 'flock', 'timeout');

const utcDay = () => new Date().toISOString().slice(0, 10);

function runUnder(tz, t) {
  const home = scratch(os.tmpdir(), 'rs-home-', t);
  const bin = path.join(home, 'bin');
  const skillDir = path.join(home, 'skill-dir');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(skillDir);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const before = utcDay();
  execFileSync('bash', [SCRIPT, 'learning-digest', 'headless'], {
    env: {
      ...process.env, HOME: home, TZ: tz, PATH: `${bin}:${process.env.PATH}`,
      XDG_STATE_HOME: path.join(home, 'state'), XDG_RUNTIME_DIR: home, CLAUDE_VAULT_DIR: skillDir,
    },
    stdio: 'ignore',
  });
  const after = utcDay();
  const markers = fs.readdirSync(path.join(home, 'state', 'claude-run-skill'));
  return { markers, days: new Set([before, after]) };
}

// UTC+14 and UTC-12 are 26 hours apart, so at any instant at least one of them has a local
// date that differs from the UTC date. A marker named with a local `date +%F` fails there.
for (const tz of ['Etc/GMT-14', 'Etc/GMT+12']) {
  test(`the marker is named for the UTC day under TZ=${tz}`, { skip }, (t) => {
    const { markers, days } = runUnder(tz, t);
    assert.strictEqual(markers.length, 1, `one marker after a successful run, got ${markers}`);
    const m = /^learning-digest\.(\d{4}-\d{2}-\d{2})\.done$/.exec(markers[0]);
    assert.ok(m, `unexpected marker name ${markers[0]}`);
    assert.ok(days.has(m[1]), `marker day ${m[1]} is not the UTC day ${[...days]}`);
  });
}
