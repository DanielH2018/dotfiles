// Unit tests for executable_ct — launches claude in a fresh named tmux session.
// Drives the ACTUAL script with a `tmux` stub on PATH that logs its args instead of
// starting a server. Skips without bash.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CT = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_ct');
let toolsOk = true;
try { execFileSync('bash', ['-c', ':'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash unavailable';

const dirs = [];
function scratch() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-')); dirs.push(d); return d; }
function runCt(arg, { extraEnv = {}, cwd } = {}) {
  const bin = scratch();
  const log = path.join(bin, 'tmux.log');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash
echo "$*" >> "${log.replace(/\\\\/g, '/')}"
exit 0
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extraEnv };
  const opts = { env, stdio: ['ignore', 'pipe', 'pipe'] };
  // bash recomputes $PWD from getcwd() at startup and ignores a mismatched PWD env
  // var, so the no-arg test must control the REAL working dir via `cwd`.
  if (cwd) opts.cwd = cwd;
  execFileSync('bash', [CT, ...(arg ? [arg] : [])], opts);
  return fs.readFileSync(log, 'utf8');
}

test('ct DIR opens a named tmux session (basename + path hash) running claude', { skip }, () => {
  const out = runCt('/home/ubuntu/airflow');
  assert.match(out, /new-session -A -s airflow-[0-9]+ -c \/home\/ubuntu\/airflow claude/);
});

test('ct with no arg uses $PWD basename', { skip }, () => {
  const workdir = path.join(scratch(), 'myrepo'); fs.mkdirSync(workdir);
  const out = runCt('', { cwd: workdir });
  assert.match(out, /-s myrepo-[0-9]+/);
});

test('ct sanitizes an unsafe session name', { skip }, () => {
  const out = runCt('/tmp/we ird:name');
  assert.match(out, /-s we-ird-name-[0-9]+/, 'spaces/colons collapse to hyphens');
});

test('ct disambiguates same-basename dirs by path hash', { skip }, () => {
  const nameA = (runCt('/home/ubuntu/work/api').match(/-s (api-[0-9]+)/) || [])[1];
  const nameB = (runCt('/home/ubuntu/personal/api').match(/-s (api-[0-9]+)/) || [])[1];
  assert.ok(nameA && nameB, 'both produced an api-<hash> session name');
  assert.notStrictEqual(nameA, nameB, 'same basename, different path -> different session');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
