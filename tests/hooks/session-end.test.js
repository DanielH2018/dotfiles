// Behavioral tests for the SessionEnd hook's remember-buffer roll
// (executable_session-end.sh). The remember plugin cats today-<DATE>.md whole into
// every new session and nothing bounds it — both its prompts mandate lossless
// compression — so past 45 KiB the harness swaps the injection for a 2 KB preview
// and the memory feature quietly dies. This hook rolls the buffer past a budget so
// it never gets there. Real bash against the ACTUAL hook; skips without bash/jq.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { shConstInt } = require('../lib/sh-const');

const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_session-end.sh');

// A buffer size that has to exceed the hook's roll budget, sized from the budget rather than
// written out beside it. Raise REMEMBER_TODAY_MAX_BYTES past a hardcoded 20000 and every
// "rolls the buffer" test below would go on passing while testing the under-budget path.
const OVER_BUDGET = shConstInt(HOOK, 'REMEMBER_BUDGET') * 3;

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const dirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// The hook derives the buffer path from the JSON `cwd`, and logs under $HOME. Both are
// faked so a test run never touches the real ~/.claude or the real .remember buffer.
function fakeEnv() {
  const home = scratch('se-home-');
  const proj = scratch('se-proj-');
  fs.mkdirSync(path.join(home, '.claude', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.remember'), { recursive: true });
  return { home, proj };
}

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function buffer(proj, suffix = '') { return path.join(proj, '.remember', `today-${today()}${suffix}.md`); }

function run({ home, proj }, { cwd = proj, budget } = {}) {
  const env = { ...process.env, HOME: home };
  if (budget !== undefined) env.REMEMBER_TODAY_MAX_BYTES = String(budget);
  // Run from a scratch cwd so the hook's git-dirty probe can't see the real repo.
  return execFileSync('bash', [HOOK], {
    input: JSON.stringify({ session_id: 'test-session', cwd }),
    env, cwd: home, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function log(home) {
  const p = path.join(home, '.claude', 'logs', 'sessions.log');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

test('leaves the buffer alone when it is under budget', { skip }, () => {
  const env = fakeEnv();
  fs.writeFileSync(buffer(env.proj), 'a'.repeat(4000));
  run(env);
  assert.ok(fs.existsSync(buffer(env.proj)), 'under-budget buffer must not be rolled');
  assert.equal(fs.readdirSync(path.join(env.proj, '.remember')).length, 1);
  assert.ok(!log(env.home).includes('remember_roll'));
});

test('rolls the buffer once it passes budget, freeing the injected name', { skip }, () => {
  const env = fakeEnv();
  fs.writeFileSync(buffer(env.proj), 'b'.repeat(OVER_BUDGET));
  run(env);
  // The plugin's SessionStart hook cats the exact today-<DATE>.md and nothing else,
  // so freeing that name is what actually drops the bytes out of the next session.
  assert.ok(!fs.existsSync(buffer(env.proj)), 'buffer must be renamed out of the injected path');
  assert.equal(fs.readFileSync(buffer(env.proj, '-1'), 'utf8'), 'b'.repeat(OVER_BUDGET));
  // 8192 stays written out: it is the value the hook must REPORT, which is what this
  // assertion exists to catch. Only the input that has to exceed it is derived.
  assert.match(log(env.home), new RegExp(`event=remember_roll bytes=${OVER_BUDGET} budget=8192 part=1`));
});

test('rolls to the next free part without clobbering an earlier one', { skip }, () => {
  const env = fakeEnv();
  fs.writeFileSync(buffer(env.proj), 'b'.repeat(OVER_BUDGET));
  run(env);
  fs.writeFileSync(buffer(env.proj), 'c'.repeat(OVER_BUDGET));
  run(env);
  assert.equal(fs.readFileSync(buffer(env.proj, '-1'), 'utf8'), 'b'.repeat(OVER_BUDGET), 'part 1 must survive');
  assert.equal(fs.readFileSync(buffer(env.proj, '-2'), 'utf8'), 'c'.repeat(OVER_BUDGET));
});

test('rolled parts keep the today-*.md shape consolidation globs for', { skip }, () => {
  const env = fakeEnv();
  fs.writeFileSync(buffer(env.proj), 'b'.repeat(OVER_BUDGET));
  run(env);
  const [rolled] = fs.readdirSync(path.join(env.proj, '.remember'));
  // pipeline/shell.py globs today-*.md, skips names containing the current date and
  // anything ending .done.md — so a rolled part waits today and folds into recent.md
  // tomorrow rather than being stranded.
  assert.match(rolled, /^today-.*\.md$/);
  assert.ok(!rolled.endsWith('.done.md'), 'must not look already-consolidated');
  assert.ok(rolled.includes(today()), 'must carry its own date so it is skipped until tomorrow');
});

test('honours a REMEMBER_TODAY_MAX_BYTES override', { skip }, () => {
  const env = fakeEnv();
  fs.writeFileSync(buffer(env.proj), 'd'.repeat(2000));
  run(env, { budget: 1000 });
  assert.ok(!fs.existsSync(buffer(env.proj)), 'a lowered budget must roll a smaller buffer');
  assert.match(log(env.home), /budget=1000/);
});

test('is a no-op when the project has no remember buffer', { skip }, () => {
  const env = fakeEnv();
  run(env, { cwd: path.join(env.proj, 'nope') });
  assert.ok(!log(env.home).includes('remember_roll'));
});

test('still logs session end when the roll path is not taken', { skip }, () => {
  const env = fakeEnv();
  run(env);
  assert.match(log(env.home), /event=end/, 'roll logic must not displace the existing summary log');
});
