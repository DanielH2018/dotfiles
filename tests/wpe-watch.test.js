// Regression guard for executable_wpe-watch.
//
// Drives the ACTUAL script's `once` path against a stub `wpe` sitting next to it and stub
// pgrep/systemctl on PATH, so nothing here touches the real wallpaper service -- a live run would
// restart the desktop background out from under whoever is looking at it.
//
// The whole script is one decision -- restart, or leave it alone -- and every way of getting that
// decision wrong is expensive in a different direction. Five properties are pinned:
//
//  - A shrunk drawing set must restart. This is the reported bug: flip the KVM back and the
//    renderer is still running, just not on the displays that returned. If this stops firing the
//    feature does nothing at all, silently, because the service still reads "active".
//  - A matching set must NOT restart. The tick runs every 15s; a watcher that restarts on every
//    look would rebuild a GL context four times a minute forever.
//  - An inactive unit must be left alone. `wpe stop` is the manual lever before a fullscreen game
//    (KWin cannot do fullscreen detection here), so reviving the wallpaper on the next flip would
//    make stop meaningless mid-session.
//  - A failed unit with displays present must restart. That is the flip-away wreckage: the
//    renderer exited 1 into StartLimitBurst and only `wpe restart`'s reset-failed revives it.
//    Restricting action to "active" would leave exactly the case that needs help unhandled.
//  - Zero resolved displays must NOT restart, and an unsettled topology must NOT restart. Both
//    are mid-flip states; acting on either re-binds to a partial set, which is the original bug
//    reappearing on the recovery path.
//
// Skips without bash.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { srcPath } = require('./lib/paths');

const SCRIPT = srcPath('dot_local', 'bin', 'executable_wpe-watch');

const BASH = ['/bin/bash', '/usr/bin/bash'].find((p) => fs.existsSync(p));
const skip = BASH ? false : 'bash unavailable';

function write(file, body) {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

// A sandbox holding the script under test, a stub `wpe` beside it (the script finds wpe by its
// own dirname, so the neighbour placement is part of what is being tested) and stub pgrep and
// systemctl on PATH.
//
// `resolved` answers from a list of lines: the first call gets entry 0, the second entry 1, and
// so on, falling back to the last. That is what makes the unsettled-topology case testable --
// the script reads twice and compares.
function sandbox({ resolved, drawing, state }) {
  const dir = scratch(os.tmpdir(), 'wpe-watch-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(SCRIPT, path.join(bin, 'wpe-watch'));
  fs.chmodSync(path.join(bin, 'wpe-watch'), 0o755);

  const restarts = path.join(dir, 'restarts');
  const calls = path.join(dir, 'resolved-calls');
  fs.writeFileSync(restarts, '');
  fs.writeFileSync(calls, '');

  const answers = (Array.isArray(resolved) ? resolved : [resolved]).map((a) => a.join('\n'));
  write(
    path.join(bin, 'wpe'),
    `#!/usr/bin/env bash
case "$1" in
  resolved)
    echo x >> ${JSON.stringify(calls)}
    n=$(wc -l < ${JSON.stringify(calls)})
    case "$n" in
${answers
  .map((a, i) => `      ${i + 1}) cat <<'EOF'\n${a}\nEOF\n        ;;`)
  .join('\n')}
      *) cat <<'EOF'
${answers[answers.length - 1]}
EOF
        ;;
    esac
    ;;
  restart) echo restart >> ${JSON.stringify(restarts)} ;;
esac
`,
  );

  // pgrep -af <renderer>: reproduce the real argv shape, since the script parses --screen-root
  // out of it rather than being handed a list.
  const args = drawing.map((o) => `--screen-root ${o} --scaling fill --bg /w/1`).join(' ');
  write(
    path.join(bin, 'pgrep'),
    drawing.length
      ? `#!/usr/bin/env bash\necho "4242 /home/x/linux-wallpaperengine ${args}"\n`
      : '#!/usr/bin/env bash\nexit 1\n',
  );

  write(path.join(bin, 'systemctl'), `#!/usr/bin/env bash\necho ${state}\n`);

  return { dir, bin, restarted: () => fs.readFileSync(restarts, 'utf8').trim().length > 0 };
}

// A `wpe` that does not know the `resolved` subcommand: it falls through to its usage text and
// exits 0, exactly like the version that predates it.
function sandboxWithOldWpe(drawing) {
  const sb = sandbox({ resolved: [['unused']], drawing, state: 'active' });
  write(
    path.join(sb.bin, 'wpe'),
    `#!/usr/bin/env bash
case "$1" in
  restart) echo restart >> ${JSON.stringify(path.join(sb.dir, 'restarts'))} ;;
  *) cat <<'EOF'
usage: wpe <command>

  outputs             connected displays; * marks the current one
  screen <spec>       one name, a comma-separated list, or "all"
  start | stop | restart
EOF
    ;;
esac
`,
  );
  return sb;
}

function run(sb) {
  return execFileSync(BASH, [path.join(sb.bin, 'wpe-watch'), 'once'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${sb.bin}:${process.env.PATH}`,
      // Only the two reads that must agree happen in `once`; collapsing the gap keeps the suite
      // fast without skipping the comparison itself.
      WPE_WATCH_STABLE: '0',
    },
  });
}

test('restarts when the renderer is drawing on fewer displays than are enabled', { skip }, () => {
  const sb = sandbox({
    resolved: [['DP-1', 'DP-2', 'DP-3', 'HDMI-A-1']],
    drawing: ['DP-2'],
    state: 'active',
  });
  const out = run(sb);
  assert.ok(sb.restarted(), 'expected a restart');
  assert.match(out, /outputs changed/);
});

test('restarts when a display went away and the renderer still holds it', { skip }, () => {
  const sb = sandbox({ resolved: [['DP-2']], drawing: ['DP-1', 'DP-2'], state: 'active' });
  run(sb);
  assert.ok(sb.restarted(), 'expected a restart');
});

test('leaves a matching set alone', { skip }, () => {
  const sb = sandbox({
    resolved: [['DP-1', 'DP-2']],
    // Reversed on purpose: the comparison is of sets, and argv order is not meaningful.
    drawing: ['DP-2', 'DP-1'],
    state: 'active',
  });
  run(sb);
  assert.ok(!sb.restarted(), 'a matching set must not be restarted');
});

test('leaves a stopped wallpaper stopped', { skip }, () => {
  const sb = sandbox({ resolved: [['DP-1', 'DP-2']], drawing: [], state: 'inactive' });
  run(sb);
  assert.ok(!sb.restarted(), 'wpe stop must survive a display change');
});

test('revives a failed unit once displays are back', { skip }, () => {
  const sb = sandbox({ resolved: [['DP-1', 'DP-2']], drawing: [], state: 'failed' });
  run(sb);
  assert.ok(sb.restarted(), 'a failed unit with displays present must be restarted');
});

test('does nothing when no display is enabled', { skip }, () => {
  const sb = sandbox({ resolved: [[]], drawing: ['DP-2'], state: 'active' });
  run(sb);
  assert.ok(!sb.restarted(), 'restarting with no --screen-root would just fail again');
});

// Named for what it actually pins: the two-read comparison, not the delay between them. The
// tests set WPE_WATCH_STABLE=0, so the settle *timing* has no coverage here -- only the rule that
// two disagreeing reads mean "do nothing".
// Regression: this happened for real. A plain `chezmoi apply` from a checkout predating the
// `resolved` subcommand replaced ~/.local/bin/wpe, `wpe resolved` printed its usage text and
// exited 0, and the watcher read that as a list of display names -- which can never match what
// the renderer is drawing, so it restarted the wallpaper on every 15s tick. Three restarts
// landed before it was stopped. An exit-code check alone would not have caught it.
test('ignores a wpe that answers `resolved` with usage text', { skip }, () => {
  const sb = sandboxWithOldWpe(['DP-1', 'DP-2', 'DP-3', 'HDMI-A-1']);
  const out = run(sb);
  assert.ok(!sb.restarted(), 'usage text must never be read as a display list');
  assert.match(out, /no usable output list/);
});

test('does not act when two consecutive reads disagree', { skip }, () => {
  const sb = sandbox({
    // Mid-flip: the second display appears between the two reads.
    resolved: [['DP-1'], ['DP-1', 'DP-2']],
    drawing: ['DP-2'],
    state: 'active',
  });
  run(sb);
  assert.ok(!sb.restarted(), 'an unsettled topology must not trigger a restart');
});
