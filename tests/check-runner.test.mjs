// Tests for home/private_dot_claude/scripts/check-runner.mjs — the deterministic
// frozen-checks grader. Drives the ACTUAL script in a hermetic tmp git repo and asserts
// its typed exit codes (0 pass / 1 fail / 2 frozen-drift / 3 parse error). Skips without bash.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'home', 'private_dot_claude', 'scripts', 'check-runner.mjs');

let bashOk = true;
try { if (spawnSync('bash', ['-c', 'true']).status !== 0) bashOk = false; } catch { bashOk = false; }
const skip = bashOk ? false : 'bash unavailable';

const dirs = [];
function mkrepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-'));
  dirs.push(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir });
  // Unsigned fixtures: the machine's global commit.gpgsign routes these to the 1Password
  // agent, which stalls on an approval no test can give. Same as tests/bin/try.test.js.
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}
function write(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
}
function run(dir, args) {
  const r = spawnSync('node', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('all checks pass -> exit 0', { skip }, () => {
  const dir = mkrepo();
  write(dir, 'c.checks', '- RUN: `echo hi` -> exit:0\n- RUN: `echo abc` -> match:"abc"\n');
  const { code, out } = run(dir, ['c.checks']);
  assert.equal(code, 0);
  assert.match(out, /2\/2 checks passed/);
});

test('a failing check -> exit 1', { skip }, () => {
  const dir = mkrepo();
  write(dir, 'c.checks', '- RUN: `false` -> exit:0\n');
  assert.equal(run(dir, ['c.checks']).code, 1);
});

// spawnSync reports status:null with no error when the child dies from a signal, so the
// nullish fallback graded a SIGKILL as exit 0 and reported PASS — the self-assessment
// failure this tool exists to prevent.
test('a signal-killed command fails an exit:0 check instead of passing', { skip }, () => {
  const dir = mkrepo();
  write(dir, 'c.checks', '- RUN: `kill -9 $$` -> exit:0\n');
  const { code, out } = run(dir, ['c.checks']);
  assert.equal(code, 1);
  assert.match(out, /killed by SIGKILL/);
});

test('exit and match are ANDed on one line', { skip }, () => {
  const dir = mkrepo();
  // right exit, wrong substring -> fail
  write(dir, 'c.checks', '- RUN: `echo hi` -> exit:0 match:"nope"\n');
  assert.equal(run(dir, ['c.checks']).code, 1);
});

test('match is a literal substring, not a regex', { skip }, () => {
  const dir = mkrepo();
  write(dir, 'c.checks', '- RUN: `echo "a.c"` -> match:"a.c"\n');
  assert.equal(run(dir, ['c.checks']).code, 0);
  // regex-y pattern that would match as regex but not literally
  write(dir, 'd.checks', '- RUN: `echo "abc"` -> match:"a.c"\n');
  assert.equal(run(dir, ['d.checks']).code, 1);
});

test('comments and blank lines are ignored', { skip }, () => {
  const dir = mkrepo();
  write(dir, 'c.checks', '# header\n\n- RUN: `echo hi` -> exit:0\n');
  assert.equal(run(dir, ['c.checks']).code, 0);
});

test('--frozen on an uncommitted file -> exit 2', { skip }, () => {
  const dir = mkrepo();
  write(dir, 'c.checks', '- RUN: `echo hi` -> exit:0\n');
  assert.equal(run(dir, ['c.checks', '--frozen']).code, 2);
});

test('--frozen on a committed, unmodified file -> exit 0', { skip }, () => {
  const dir = mkrepo();
  write(dir, 'c.checks', '- RUN: `echo hi` -> exit:0\n');
  spawnSync('git', ['add', 'c.checks'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'freeze'], { cwd: dir });
  assert.equal(run(dir, ['c.checks', '--frozen']).code, 0);
});

test('--frozen detects edits made after commit -> exit 2', { skip }, () => {
  const dir = mkrepo();
  const p = write(dir, 'c.checks', '- RUN: `echo hi` -> exit:0\n');
  spawnSync('git', ['add', 'c.checks'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'freeze'], { cwd: dir });
  fs.appendFileSync(p, '- RUN: `echo tampered` -> exit:0\n');
  assert.equal(run(dir, ['c.checks', '--frozen']).code, 2);
});

test('malformed line -> exit 3', { skip }, () => {
  const dir = mkrepo();
  write(dir, 'c.checks', '- just some prose\n');
  assert.equal(run(dir, ['c.checks']).code, 3);
});

test('a check with no condition -> exit 3', { skip }, () => {
  const dir = mkrepo();
  write(dir, 'c.checks', '- RUN: `echo hi` -> \n');
  assert.equal(run(dir, ['c.checks']).code, 3);
});

test('empty / no runnable checks -> exit 3', { skip }, () => {
  const dir = mkrepo();
  write(dir, 'c.checks', '# only a comment\n');
  assert.equal(run(dir, ['c.checks']).code, 3);
});

test('missing checks file -> exit 3', { skip }, () => {
  const dir = mkrepo();
  assert.equal(run(dir, ['nope.checks']).code, 3);
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
