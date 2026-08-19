// Regression guard for executable_warp-session-title.sh.
// Drives the ACTUAL hook and asserts the OSC 0 sequence it writes to the terminal.
// Offline and deterministic. Skips cleanly without bash/jq.
//
// Two properties carry the weight here and neither is a case list.
// `structure` asserts the sequence never goes to stdout: a hook's stdout is read by
// Claude Code as hook output, so an escape printed there reaches the model instead of
// the terminal, and nothing about the rendered row would look wrong while it happened.
// `sanitises control characters` asserts the title is stripped before interpolation --
// the title comes from the transcript, so a stray BEL in it would terminate the
// sequence early and leave the rest of the string as literal text on the row.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOKS = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks');
const HOOK = path.join(HOOKS, 'executable_warp-session-title.sh');
const LIB = path.join(HOOKS, 'hook-input.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

// Runs the hook with the terminal redirected to a temp file, and returns what it wrote.
// Returns stdout separately so a test can assert it stayed empty.
function run(state, input, { transcript } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-title-'));
  const tty = path.join(dir, 'tty');
  fs.writeFileSync(tty, '');
  const payload = { ...input };
  if (transcript !== undefined) {
    const tp = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(tp, transcript);
    payload.transcript_path = tp;
  }
  let stdout = '';
  try {
    stdout = execFileSync('bash', [HOOK, state], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WARP_TITLE_TTY: tty, HOOK_INPUT_LIB: LIB, CLAUDE_PID: '' },
    });
  } catch (e) { stdout = e.stdout || ''; }
  const written = fs.readFileSync(tty, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { written, stdout };
}

// Pulls the title text back out of an OSC 0 sequence, asserting the wrapper is intact.
function titleOf(written) {
  const m = /^\x1b\]0;(.*)\x07$/s.exec(written);
  assert.ok(m, `not a well-formed OSC 0 sequence: ${JSON.stringify(written)}`);
  return m[1];
}

const AI = JSON.stringify({ type: 'ai-title', aiTitle: 'Port Ghostty setup to Warp' });
const CUSTOM = JSON.stringify({ type: 'custom-title', customTitle: 'renamed by hand' });

test('labels each state with Claude\'s own session title', { skip }, () => {
  const cases = [
    ['working', 'working · Port Ghostty setup to Warp'],
    ['completed', 'done · Port Ghostty setup to Warp'],
    ['needs-input', 'input · Port Ghostty setup to Warp'],
    ['start', 'idle · Port Ghostty setup to Warp'],
  ];
  for (const [state, expected] of cases) {
    const { written } = run(state, { cwd: '/home/daniel/server' }, { transcript: AI + '\n' });
    assert.strictEqual(titleOf(written), expected, `state ${state}`);
  }
});

test('a hand-set /rename title beats the automatic one', { skip }, () => {
  // Same precedence Claude's own UI uses, and the ai-title is written LAST here so the
  // test fails if the hook ever just takes the final title line.
  const { written } = run('working', { cwd: '/home/daniel/server' }, { transcript: CUSTOM + '\n' + AI + '\n' });
  assert.strictEqual(titleOf(written), 'working · renamed by hand');
});

test('falls back to the directory name before Claude has titled the session', { skip }, () => {
  const { written } = run('working', { cwd: '/home/daniel/My_Vault' });
  assert.strictEqual(titleOf(written), 'working · My_Vault');
});

test('SessionEnd resets the row instead of leaving a stale label', { skip }, () => {
  const { written } = run('end', { cwd: '/home/daniel/server' }, { transcript: AI + '\n' });
  assert.strictEqual(titleOf(written), '');
});

test('no writable terminal is a silent no-op, not a failure', { skip }, () => {
  // Headless `claude -p` has no controlling terminal. A non-zero exit here would surface
  // as a hook failure on every turn of every headless run.
  //
  // stdin is 'ignore', not a pipe: the hook bails at the tty check BEFORE it reads stdin,
  // so piping input races the exit and intermittently throws EPIPE instead of asserting
  // anything. That early bail is the behaviour under test, so the race is the test's bug.
  const r = execFileSync('bash', [HOOK, 'working'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WARP_TITLE_TTY: '/nonexistent/dir/tty', HOOK_INPUT_LIB: LIB },
  });
  assert.strictEqual(r, '');
});

test('sanitises control characters out of the title', { skip }, () => {
  const nasty = JSON.stringify({ type: 'ai-title', aiTitle: 'weird[31m title' });
  const { written } = run('working', { cwd: '/home/daniel' }, { transcript: nasty + '\n' });
  const title = titleOf(written);
  assert.ok(!/[\x00-\x1f]/.test(title), `control characters survived: ${JSON.stringify(title)}`);
  assert.strictEqual(title, 'working · weird[31m title');
});

test('structure: the sequence goes to the terminal, never stdout', { skip }, () => {
  const { stdout } = run('working', { cwd: '/home/daniel/server' }, { transcript: AI + '\n' });
  assert.strictEqual(stdout, '', 'hook wrote to stdout; Claude Code would read that as hook output');

  const src = fs.readFileSync(HOOK, 'utf8');
  const prints = src.match(/^\s*printf .*\\033\]0;.*$/gm) || [];
  assert.ok(prints.length > 0, 'no OSC 0 printf found — did the hook stop emitting?');
  for (const line of prints) {
    assert.match(line, /> "\$tty_out"/, `OSC printf not redirected to the terminal: ${line.trim()}`);
  }
});
