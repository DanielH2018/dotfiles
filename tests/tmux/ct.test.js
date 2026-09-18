// Unit tests for executable_ct — launches claude in a fresh named tmux session.
// Drives the ACTUAL script with `tmux`/`claude` stubs on PATH that log their args
// instead of starting a server. ct resolves claude to an ABSOLUTE path (tmux runs the
// pane command against its own PATH, which under a non-login ssh shell can lack
// ~/.local/bin), so the assertions check the resolved path, not a bare `claude`.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const CT = srcPath('dot_local', 'bin', 'executable_ct');
const skip = skipUnless('bash');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Run ct with a logging `tmux` stub on PATH. By default also drops a `claude` stub on
// PATH so ct's `command -v claude` resolves deterministically; pass claudeOnPath:false to
// exercise the ~/.local/bin fallback (with a coreutils-only PATH so the runner's real
// claude can't leak in). Returns { out, claude } (claude = the stub's absolute path).
function runCt(arg, { extraEnv = {}, cwd, home, claudeOnPath = true } = {}) {
  const bin = scratch(os.tmpdir(), 'ct-');
  const log = path.join(bin, 'tmux.log');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash
echo "$*" >> "${log.replace(/\\\\/g, '/')}"
exit 0
`, { mode: 0o755 });
  let claude = '';
  if (claudeOnPath) {
    claude = path.join(bin, 'claude');
    fs.writeFileSync(claude, '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  }
  const env = { ...process.env, PATH: claudeOnPath ? `${bin}:${process.env.PATH}` : `${bin}:/usr/bin:/bin`, ...extraEnv };
  if (home) env.HOME = home;
  const opts = { env, stdio: ['ignore', 'pipe', 'pipe'] };
  // bash recomputes $PWD from getcwd() at startup and ignores a mismatched PWD env var,
  // so the no-arg test must control the REAL working dir via `cwd`.
  if (cwd) opts.cwd = cwd;
  execFileSync('bash', [CT, ...(arg ? [arg] : [])], opts);
  return { out: fs.readFileSync(log, 'utf8'), claude };
}

test('ct DIR opens a named tmux session (basename + path hash) running the resolved claude', { skip }, () => {
  const { out, claude } = runCt('/home/ubuntu/airflow');
  assert.match(out, new RegExp(`new-session -A -s airflow-[0-9]+ -c /home/ubuntu/airflow ${esc(claude)}(\\s|$)`));
});

test('ct with no arg uses $PWD basename', { skip }, () => {
  const workdir = path.join(scratch(os.tmpdir(), 'ct-'), 'myrepo'); fs.mkdirSync(workdir);
  const { out } = runCt('', { cwd: workdir });
  assert.match(out, /-s myrepo-[0-9]+/);
});

test('ct sanitizes an unsafe session name', { skip }, () => {
  const { out } = runCt('/tmp/we ird:name');
  assert.match(out, /-s we-ird-name-[0-9]+/, 'spaces/colons collapse to hyphens');
});

test('ct disambiguates same-basename dirs by path hash', { skip }, () => {
  const nameA = (runCt('/home/ubuntu/work/api').out.match(/-s (api-[0-9]+)/) || [])[1];
  const nameB = (runCt('/home/ubuntu/personal/api').out.match(/-s (api-[0-9]+)/) || [])[1];
  assert.ok(nameA && nameB, 'both produced an api-<hash> session name');
  assert.notStrictEqual(nameA, nameB, 'same basename, different path -> different session');
});

test('ct resolves claude to an ABSOLUTE path (not a bare command tmux would miss)', { skip }, () => {
  const { out, claude } = runCt('/x/proj');
  assert.ok(out.trim().endsWith(claude), `pane command ends with the absolute claude path (${claude})`);
  assert.doesNotMatch(out, /-c \/x\/proj claude(\s|$)/, 'never a bare `claude`');
});

test('CT_CLAUDE_BIN overrides the claude binary', { skip }, () => {
  const { out } = runCt('/home/ubuntu/airflow', { extraEnv: { CT_CLAUDE_BIN: '/opt/claude' } });
  assert.match(out, /new-session -A -s airflow-[0-9]+ -c \/home\/ubuntu\/airflow \/opt\/claude(\s|$)/);
});

test('ct falls back to ~/.local/bin/claude when claude is not on PATH', { skip }, () => {
  const home = scratch(os.tmpdir(), 'ct-');
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const localClaude = path.join(home, '.local', 'bin', 'claude');
  fs.writeFileSync(localClaude, '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const { out } = runCt('/srv/api', { claudeOnPath: false, home });
  assert.match(out, new RegExp(`-c /srv/api ${esc(localClaude)}(\\s|$)`), 'uses the installer path when PATH lacks claude');
});

