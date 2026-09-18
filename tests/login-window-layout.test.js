// Regression guard for executable_login-window-layout.
//
// Drives the ACTUAL script with stub launchers and a stub pgrep as its ENTIRE PATH, so it can
// never start a real Discord or Spotify. The stub dir replaces PATH rather than sitting in
// front of it, so a command with no stub fails to resolve instead of reaching the real binary.
//
// The stub pgrep is not a canned yes/no -- it runs the script's own pattern against a fake
// process table with grep -E, the same way the real pgrep -f would. That makes the patterns
// themselves the thing under test, which is where this script's one real bug was: Discord
// self-updates into ~/.config/discord/app-<version>/Discord and never runs as the
// /usr/bin/discord that launches it, so an obvious-looking '^/usr/bin/discord' pattern never
// matches a running Discord and the script opens a second one at every login.
//
// Skips without bash.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { skipUnless } = require('./lib/probe');

const SCRIPT = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_login-window-layout');

const skip = skipUnless('bash');

// Real command lines, as read off a live session with `ps -eo args`. The Discord one carries
// the version directory that broke the first pattern.
const RUNNING = {
  discord: '/home/daniel/.config/discord/app-1.0.152/Discord --url --',
  firefox: '/usr/lib64/firefox/firefox --sm-client-id 10d8c6646f000178610709800000036370005',
  warp: '/usr/bin/warp-terminal',
  spotify: '/app/extra/share/spotify/spotify',
  obsidian: '/app/obsidian --ozone-platform-hint=auto',
  bitwarden: '/app/Bitwarden/bitwarden-app --autostart --ozone-platform=x11',
};

// Every launcher the script can invoke needs a stub here. A missing one used to reach the real
// binary, and swapping ghostty for warp-terminal without updating this list opened ten Warp
// windows on the developer's desktop. The replaced PATH below is what stops that now; this list
// is still what makes the launch observable, and the last test in this file fails when the
// script gains a launcher that is not named here.
const LAUNCHER_STUBS = ['discord', 'firefox', 'warp-terminal', 'flatpak'];

// Real utilities the script and the stubs need, since run() replaces PATH with the stub dir
// rather than prepending to it. Enumerated by observation, not from memory: run the script
// with an empty PATH, read the `command not found` lines off stderr, link what it names, and
// repeat until stderr is clean. date/mktemp/sleep surface on the first pass; cat and rm hide
// behind them, because place_firefox returns early when mktemp fails. grep belongs to the
// pgrep stub and cp to the gdbus stub.
//
// Widening this list is how the isolation gets lost, so treat a new entry as a question about
// the script rather than a fix for a red test.
const REAL_UTILS = ['bash', 'cat', 'cp', 'date', 'grep', 'mktemp', 'rm', 'sleep'];

// Resolve a utility against the developer's own PATH. The stub dir gets a symlink per name,
// which is what makes a replaced PATH survivable.
function realPath(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) { continue; }
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* not here, keep looking */ }
  }
  return null;
}

const BASH = realPath('bash');

function mkdtemp(prefix) {
  const d = scratch(os.tmpdir(), prefix);
  return d;
}

// Stub bin dir. `running` is the fake process table the stub pgrep greps; every launcher stub
// appends its own argv to marks/launched so the test can assert both what started and in what
// order.
function makeStubs(running) {
  const bin = mkdtemp('lwl-bin-');
  const marks = mkdtemp('lwl-marks-');
  const table = path.join(marks, 'proc');
  fs.writeFileSync(table, running.join('\n') + (running.length ? '\n' : ''));

  fs.writeFileSync(path.join(bin, 'pgrep'), `#!/bin/bash
# pgrep -f <pattern>
[ "$1" = "-f" ] || exit 2
grep -Eq -- "$2" "${table}"
`, { mode: 0o755 });

  for (const cmd of LAUNCHER_STUBS) {
    fs.writeFileSync(path.join(bin, cmd), `#!/bin/bash
printf '%s %s\\n' "${cmd}" "$*" >> "${marks}/launched"
`, { mode: 0o755 });
  }

  // Firefox placement talks to KWin over gdbus. Stub it, or a test run would load a script
  // into the live compositor and move the developer's own browser window.
  fs.writeFileSync(path.join(bin, 'gdbus'), `#!/bin/bash
printf '%s\\n' "$*" >> "${marks}/gdbus"
for a in "$@"; do
  case "$a" in
    */login-window-layout-firefox.*) cp "$a" "${marks}/kwinscript" 2>/dev/null ;;
  esac
done
`, { mode: 0o755 });

  // Link the real utilities in by name. Without this the replaced PATH would break the script
  // itself, not just the launchers it must not run.
  for (const util of REAL_UTILS) {
    const target = realPath(util);
    assert.ok(target, `${util} is not on PATH, so the stub dir cannot provide it`);
    fs.symlinkSync(target, path.join(bin, util));
  }

  return { bin, marks };
}

function readMark(marks, name) {
  const p = path.join(marks, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

// Placement runs in a background subshell that outlives the script, so poll rather than sample.
function waitForMark(marks, name, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!fs.existsSync(path.join(marks, name)) && Date.now() < deadline) {
    execFileSync('sleep', ['0.05']);
  }
  return readMark(marks, name);
}

function readLaunched(marks) {
  const p = path.join(marks, 'launched');
  // Split before trimming, and only ever drop empty lines: a stub invoked with no arguments
  // writes "<cmd> " with a trailing space, and .trim() on the whole file strips that space off
  // whichever launch landed last -- making the expected value depend on launch order rather
  // than on what the script did.
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
}

// The script backgrounds every launch, so it exits before the stubs have written their marks.
// Wait for the expected count rather than sampling once; `expect: 0` still has to wait, or the
// test would pass simply by reading too early.
function run({ running = [], delay = 0, expect = 0, placeDelay = 0, position, bwDelay = 0 } = {}) {
  const { bin, marks } = makeStubs(running);
  const env = {
    ...process.env,
    // The stub dir IS the PATH, not the front of it: an unstubbed command must fail to resolve
    // rather than reach the real one. REAL_UTILS covers what the script legitimately needs.
    PATH: bin,
    OBSIDIAN_DELAY: String(delay),
    BITWARDEN_DELAY: String(bwDelay),
    FIREFOX_PLACE_DELAY: String(placeDelay),
  };
  if (position) { env.FIREFOX_POSITION = position; }
  // Spawn bash by absolute path -- with PATH replaced, resolving the interpreter through it
  // would be one more thing to keep in REAL_UTILS for no benefit.
  const res = spawnSync(BASH, [SCRIPT], { env, encoding: 'utf8' });
  assert.strictEqual(res.status, 0, `the script exited ${res.status}: ${res.stderr}`);
  // An incomplete REAL_UTILS is otherwise silent. start() sends every launch to /dev/null,
  // place_firefox runs in a background subshell, and log()'s timestamp comes from date, which
  // no assertion reads -- so a missing binary leaves all 13 tests green.
  assert.doesNotMatch(res.stderr, /command not found/,
    `a command the script needs is missing from REAL_UTILS: ${res.stderr}`);
  const stdout = res.stdout;
  const deadline = Date.now() + 3000;
  let launched = readLaunched(marks);
  while (launched.length < expect && Date.now() < deadline) {
    execFileSync('sleep', ['0.05']);
    launched = readLaunched(marks);
  }
  if (expect === 0) {
    execFileSync('sleep', ['0.3']);
    launched = readLaunched(marks);
  }
  return { stdout, launched, marks };
}

test('starts all six when nothing is running', { skip }, () => {
  const { launched } = run({ expect: 6 });
  assert.deepStrictEqual(launched.sort(), [
    'discord ',
    'firefox ',
    'flatpak run com.bitwarden.desktop',
    'flatpak run com.spotify.Client',
    'flatpak run md.obsidian.Obsidian',
    'warp-terminal ',
  ].sort());
});

test('starts nothing new when all six are already running', { skip }, () => {
  const { stdout, launched } = run({ running: Object.values(RUNNING), expect: 1 });
  // Bitwarden is the one exception, and it is not a second process: the running instance may
  // be the tray-only --autostart one, and re-invoking it is what opens its window.
  assert.deepStrictEqual(launched, ['flatpak run com.bitwarden.desktop'],
    'a running app must not be started a second time');
  for (const name of ['Discord', 'Firefox', 'Warp', 'Spotify', 'Obsidian', 'Bitwarden']) {
    assert.match(stdout, new RegExp(`${name} already running, skipping`));
  }
});

// The failure this covers is silent: Bitwarden's own autostart entry starts it with
// --autostart, the guard sees a process and skips, and the user gets no window at all.
test('summons a window from an already-running Bitwarden', { skip }, () => {
  const { stdout, launched } = run({ running: [RUNNING.bitwarden], expect: 6 });
  assert.match(stdout, /Bitwarden already running, skipping/);
  assert.match(stdout, /asking the running Bitwarden for its window/);
  assert.strictEqual(launched.filter((l) => l === 'flatpak run com.bitwarden.desktop').length, 1,
    'the running Bitwarden must be invoked exactly once to open its window');
});

// The bug this file exists for: Discord's launcher execs into a versioned directory, so
// matching on /usr/bin/discord finds nothing and a second Discord opens at every login.
test('detects Discord at its self-updated versioned path', { skip }, () => {
  const { stdout, launched } = run({ running: [RUNNING.discord] });
  assert.match(stdout, /Discord already running, skipping/);
  assert.ok(!launched.some((l) => l.startsWith('discord ')), 'Discord must not be started again');
});

test('a new Discord version is still detected', { skip }, () => {
  const { stdout } = run({ running: ['/home/daniel/.config/discord/app-2.5.0/Discord --url --'] });
  assert.match(stdout, /Discord already running, skipping/);
});

test('tops up only what is missing', { skip }, () => {
  const { launched } = run({ running: [RUNNING.firefox, RUNNING.spotify], expect: 4 });
  assert.deepStrictEqual(launched.sort(), [
    'discord ',
    'flatpak run com.bitwarden.desktop',
    'flatpak run md.obsidian.Obsidian',
    'warp-terminal ',
  ].sort());
});

// Obsidian and Spotify share a position on the bottom monitor, so whichever maps last is the
// one on top. Ordering is the whole reason the delay exists.
test('starts Obsidian after Spotify', { skip }, () => {
  // Assert on the script's own log, not on the order the stub launchers finished writing
  // their marks. Every launch is backgrounded, so mark order reflects fork scheduling and
  // no delay makes it sound -- only more probable. Under the full suite even 0.8s lost the
  // race, with the marks arriving discord, firefox, warp-terminal, obsidian, spotify. log() runs
  // in the script's main process, in sequence, which is the thing actually under test:
  // this script decides what starts and in what order.
  const { stdout, launched } = run({ delay: 0.1, expect: 6 });
  const spotify = stdout.indexOf('starting Spotify');
  const obsidian = stdout.indexOf('starting Obsidian');
  assert.ok(spotify >= 0 && obsidian >= 0, 'both must start');
  assert.ok(obsidian > spotify, 'Obsidian must start after Spotify to end up on top');
  // Both still have to reach a launcher; membership only, never order.
  assert.ok(launched.some((l) => l.includes('com.spotify.Client')), 'Spotify must launch');
  assert.ok(launched.some((l) => l.includes('md.obsidian.Obsidian')), 'Obsidian must launch');
});

// Bitwarden opens a 1200x720 window on the left monitor, where Discord is maximized. Whichever
// maps last is the visible one, so starting Bitwarden first hides it behind Discord outright.
test('starts Bitwarden after Discord so it is not hidden behind it', { skip }, () => {
  const { stdout, launched } = run({ expect: 6, bwDelay: 0.4 });
  const discord = stdout.indexOf('starting Discord');
  const bitwarden = stdout.indexOf('starting Bitwarden');
  assert.ok(discord >= 0 && bitwarden >= 0, 'both must start');
  assert.ok(bitwarden > discord, 'Bitwarden must start after Discord to end up on top');
  assert.ok(launched.some((l) => l.includes('com.bitwarden.desktop')), 'Bitwarden must launch');
});

test('BITWARDEN_DELAY controls the wait before Bitwarden', { skip }, () => {
  const started = Date.now();
  run({ bwDelay: 0.8, expect: 6 });
  assert.ok(Date.now() - started >= 700, 'the configured delay must actually be waited out');
});

test('OBSIDIAN_DELAY controls the wait before Obsidian', { skip }, () => {
  const started = Date.now();
  // 0.8s, and no lower: the five stub launches cost a couple of hundred ms by themselves, so
  // a threshold much under that would be satisfied even with the delay ignored outright, and
  // the test would stop discriminating rather than merely running faster.
  run({ delay: 0.8, expect: 6 });
  assert.ok(Date.now() - started >= 700, 'the configured delay must actually be waited out');
});

// Firefox placement moved here out of kwinrulesrc, because a wmclass rule also caught the
// popup windows extensions open and shrank them to a sliver in the corner. These tests pin
// the two properties that made moving it worthwhile: it runs once, and only for a launch.
test('places Firefox after starting it', { skip }, () => {
  const { marks } = run({ expect: 6 });
  const calls = waitForMark(marks, 'gdbus');
  assert.match(calls, /Scripting\.loadScript/, 'no KWin script was loaded, so nothing was placed');
  assert.match(calls, /Scripting\.start/, 'the script was loaded but never run');
  assert.match(calls, /Scripting\.unloadScript/,
    'the script was left loaded; KWin would collect a dead entry per login');
});

test('does not place Firefox when it was already running', { skip }, () => {
  const { stdout, marks } = run({ running: Object.values(RUNNING), expect: 1 });
  execFileSync('sleep', ['0.5']);
  assert.strictEqual(readMark(marks, 'gdbus'), '',
    'a top-up run moved a window the user had already arranged');
  assert.doesNotMatch(stdout, /placed Firefox/);
});

test('unmaximizes before moving, or the window hangs off the output', { skip }, () => {
  const { marks } = run({ expect: 6 });
  waitForMark(marks, 'kwinscript');
  const js = readMark(marks, 'kwinscript');
  const unmax = js.indexOf('setMaximize(false, false)');
  const move = js.indexOf('w.frameGeometry =');
  const max = js.indexOf('setMaximize(true, true)');
  assert.ok(unmax >= 0 && move >= 0 && max >= 0, 'placement script lost one of its three steps');
  assert.ok(unmax < move && move < max,
    'writing frameGeometry to a maximized window moves the frame without resizing it');
});

// placeDelay is 0 everywhere else, which would pass even if the placement were killed the
// moment the script exited. This one outlives the parent's own work and still has to land.
test('placement survives a delay longer than the rest of the script', { skip }, () => {
  const { marks } = run({ expect: 6, delay: 0.1, placeDelay: 1 });
  assert.match(waitForMark(marks, 'gdbus', 5000), /Scripting\.loadScript/,
    'the placement was dropped when its parent finished first');
});

test('FIREFOX_POSITION picks the corner to maximize from', { skip }, () => {
  const { marks } = run({ expect: 6, position: '40,80' });
  waitForMark(marks, 'kwinscript');
  assert.match(readMark(marks, 'kwinscript'), /x: 40, y: 80/,
    'the configured position did not reach the KWin script');
});

// With PATH replaced, an unstubbed launcher no longer reaches the real application -- it fails
// to resolve, and the test that wanted it reports a missing mark and a timeout. This names the
// cause instead, by reading the launchers back out of the script rather than trusting the list
// above to be maintained by hand.
test('every launcher the script starts has a stub', { skip }, () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const launchers = [...src.matchAll(/^start\s+\S+\s+'[^']*'\s+(\S+)/gm)].map((m) => m[1]);
  assert.ok(launchers.length > 0, 'no start lines found -- the pattern stopped matching');
  for (const cmd of launchers) {
    assert.ok(LAUNCHER_STUBS.includes(cmd),
      `${cmd} has no stub, so nothing records that the script tried to start it`);
  }
});

