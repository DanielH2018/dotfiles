// Behavioral tests for the macOS askpass helper (executable_mac-askpass).
//
// sudo hands the helper a prompt and reads the password off its stdout, so the contract is
// narrow and entirely about faithfulness: the prompt must arrive as AppleScript *argv*
// rather than interpolated into the script body (a prompt with quotes could otherwise
// rewrite the dialog), the password must reach stdout byte-identical, and a failure must
// exit non-zero while printing nothing — sudo reads an empty answer as a wrong password,
// which is a silent auth failure, but reports a helper that exits non-zero.
//
// Seam: a stub `osascript` earlier in PATH, so no test draws a dialog or types a password.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_mac-askpass');

const dirs = [];
function scratch(p) { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; }
process.on('exit', () => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

// The helper resolves `osascript` through PATH, which is what lets these tests replace it.
// `cat >/dev/null` drains the AppleScript on stdin so the helper never sees EPIPE.
function helper(stub) {
  const dir = scratch('macaskpass-');
  fs.writeFileSync(path.join(dir, 'osascript'), `#!/bin/sh\ncat >/dev/null\n${stub}\n`, { mode: 0o755 });

  return (args = [], env = {}) => {
    const res = { stdout: '', stderr: '', status: 0 };
    try {
      res.stdout = execFileSync(HELPER, args, {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      res.status = e.status;
      res.stdout = e.stdout ?? '';
      res.stderr = e.stderr ?? '';
    }
    return res;
  };
}

// Records the arguments the helper passed to osascript, one per line.
const RECORD_ARGV = `for a in "$@"; do printf '%s\\n' "$a"; done`;

test('reads the script from stdin and passes prompt and timeout as argv', () => {
  const run = helper(RECORD_ARGV);
  assert.deepEqual(run(['Password for daniel:']).stdout.trim().split('\n'),
    ['-', 'Password for daniel:', '120']);
});

test('defaults the prompt when sudo supplies none', () => {
  const run = helper(RECORD_ARGV);
  assert.equal(run([]).stdout.trim().split('\n')[1], 'Password:');
});

test('MAC_ASKPASS_TIMEOUT overrides the timeout', () => {
  const run = helper(RECORD_ARGV);
  assert.equal(run(['p:'], { MAC_ASKPASS_TIMEOUT: '3' }).stdout.trim().split('\n')[2], '3');
});

// A prompt is attacker-influenced only via the user's own sudoers, but it crosses into
// AppleScript, so it must survive quoting rather than being parsed as part of the script.
test('passes a prompt containing quotes and backslashes through unaltered', () => {
  const run = helper(RECORD_ARGV);
  const nasty = `it's "quoted" \\ and (parenthesised):`;
  assert.equal(run([nasty]).stdout.trim().split('\n')[1], nasty);
});

test('the password reaches stdout byte-identical', () => {
  const run = helper(`printf '%s\\n' 'pa$$ word "with" spaces'`);
  assert.equal(run(['p:']).stdout, 'pa$$ word "with" spaces\n');
});

// Cancel and timeout both land here: osascript exits non-zero, and the helper must not
// turn that into an empty-but-successful answer.
test('a failed dialog exits non-zero with nothing on stdout', () => {
  const run = helper(`echo 'execution error: timed out (1)' >&2; exit 1`);
  const res = run(['p:']);
  assert.notEqual(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /timed out/);
});
