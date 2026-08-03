// Regression guard for executable_mic-mute-toggle.
//
// Drives the ACTUAL script with a stub pactl/notify-send on PATH, so it never touches the
// real audio graph.
//
// The behaviour worth pinning is that the toast reports the state pactl actually ends up in,
// read back after the toggle -- not the state the script intended. Another client (Discord,
// a hotkey) can flip the mic between the toggle and the read, and a key that says "Muted"
// while the mic is live is worse than a key that says nothing.
//
// Skips without bash.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_mic-mute-toggle');

let bashOk = true;
try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); } catch { bashOk = false; }
const skip = bashOk ? false : 'bash unavailable';

const dirs = [];

function mkdtemp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// Stub bin dir. STUB_MUTE is what `get-source-mute` reports back, independent of the toggle,
// so a test can simulate the racing-client case. Every pactl call is logged so the test can
// assert the script targets @DEFAULT_SOURCE@ rather than a hardcoded device name.
function makeStubs({ mute, defaultSource, describe = true }) {
  const bin = mkdtemp('mmt-bin-');
  const marks = mkdtemp('mmt-marks-');

  fs.writeFileSync(path.join(bin, 'pactl'), `#!/bin/bash
printf '%s\\n' "$*" >> "${marks}/pactl"
case "$1 $2" in
  "set-source-mute @DEFAULT_SOURCE@") exit 0 ;;
  "get-source-mute @DEFAULT_SOURCE@") echo "Mute: ${mute}"; exit 0 ;;
esac
case "$1" in
  get-default-source) echo "${defaultSource}"; exit 0 ;;
  list)
    ${describe ? `cat <<'EOF'
Source #71
	Name: ${defaultSource}
	Description: Arctis Pro Wireless Chat
Source #74
	Name: alsa_input.other
	Description: HD Pro Webcam C920
EOF` : 'true'}
    exit 0 ;;
esac
exit 0
`, { mode: 0o755 });

  fs.writeFileSync(path.join(bin, 'notify-send'), `#!/bin/bash
printf '%s\\n' "$*" >> "${marks}/notify"
`, { mode: 0o755 });

  return { bin, marks };
}

function run({ mute = 'no', defaultSource = 'alsa_input.headset', describe = true } = {}) {
  const { bin, marks } = makeStubs({ mute, defaultSource, describe });

  const out = execFileSync('bash', [SCRIPT], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: mkdtemp('mmt-home-') },
  });

  const read = (f) => (fs.existsSync(path.join(marks, f)) ? fs.readFileSync(path.join(marks, f), 'utf8') : '');
  return { out, pactl: read('pactl'), notify: read('notify') };
}

test('toggling into muted reports Muted with the muted icon', { skip }, () => {
  const { out, notify } = run({ mute: 'yes' });
  assert.match(out, /Muted/);
  assert.match(notify, /microphone-sensitivity-muted/);
  assert.match(notify, /Muted/);
});

test('toggling back to live reports Live', { skip }, () => {
  const { out, notify } = run({ mute: 'no' });
  assert.match(out, /Live/);
  assert.match(notify, /microphone-sensitivity-high/);
  assert.doesNotMatch(notify, /Muted/);
});

test('the toggle targets @DEFAULT_SOURCE@, not a device name', { skip }, () => {
  const { pactl } = run();
  assert.match(pactl, /^set-source-mute @DEFAULT_SOURCE@ toggle$/m);
  assert.doesNotMatch(pactl, /set-source-mute alsa_input/);
});

test('the toast names the source description, not its raw name', { skip }, () => {
  const { notify } = run({ defaultSource: 'alsa_input.headset' });
  assert.match(notify, /Arctis Pro Wireless Chat/);
  assert.doesNotMatch(notify, /alsa_input\.headset/);
});

test('a source with no description falls back to its raw name', { skip }, () => {
  const { notify } = run({ defaultSource: 'alsa_input.headset', describe: false });
  assert.match(notify, /alsa_input\.headset/);
});

test('an unreadable mute state is reported as Unknown rather than guessed', { skip }, () => {
  const { out, notify } = run({ mute: '' });
  assert.match(out, /Unknown/);
  assert.doesNotMatch(notify, /\bLive\b/);
});

process.on('exit', () => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
