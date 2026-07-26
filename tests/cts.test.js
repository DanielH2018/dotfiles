// Unit tests for executable_cts — runs claude-sandbox in a named tmux session so Agent
// View can jump to it. Drives the ACTUAL script with a `tmux` stub on PATH that logs its
// args (and fakes has-session's exit code) instead of starting a server. A final
// skip-unless-tmux test proves cts's new-session command is accepted by real tmux.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CTS = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_cts');
function have(cmd) { try { execFileSync('bash', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } }
const skip = have('bash') ? false : 'bash unavailable';
const skipTmux = !have('bash') ? 'bash unavailable' : !have('tmux') ? 'tmux unavailable' : false;
const BASH = (() => { try { return execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim(); } catch { return 'bash'; } })();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const dirs = [];
function scratch() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-')); dirs.push(d); return d; }
function repo(name) { const d = path.join(scratch(), name); fs.mkdirSync(d); return fs.realpathSync(d); }

// Run cts with a logging tmux stub. `insideTmux` sets $TMUX (create-detached + switch
// path); `hasSession` controls the stub's has-session exit code. Returns the tmux log.
function runCts(args, { hasSession = false, insideTmux = false, cwd } = {}) {
  const bin = scratch();
  const log = path.join(bin, 'tmux.log');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash
echo "$*" >> ${JSON.stringify(log)}
case "$1" in has-session) exit ${hasSession ? 0 : 1};; esac
exit 0
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_SANDBOX_BIN: 'claude-sandbox' };
  if (insideTmux) env.TMUX = '/tmp/fake-sock,1,0'; else delete env.TMUX;
  const opts = { env, stdio: ['ignore', 'pipe', 'pipe'] };
  if (cwd) opts.cwd = cwd;
  execFileSync('bash', [CTS, ...args], opts);
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
}

test('cts DIR: attach-or-create a named session running claude-sandbox on that repo', { skip }, () => {
  const d = repo('airflow');
  const out = runCts([d]);
  assert.match(out, new RegExp(`new-session -A -s sb-airflow-\\d+ -c ${esc(d)} claude-sandbox ${esc(d)}`));
});

test('cts with no arg uses $PWD basename', { skip }, () => {
  const d = repo('myrepo');
  const out = runCts([], { cwd: d });
  assert.match(out, /-s sb-myrepo-\d+/);
  assert.ok(out.includes(`claude-sandbox ${d}`), 'sandbox targets the resolved cwd');
});

test('cts sanitizes an unsafe basename', { skip }, () => {
  const d = repo('we ird.name');
  const out = runCts([d]);
  assert.match(out, /-s sb-we-ird\.name-\d+/, 'spaces collapse to hyphens, dots kept');
});

test('cts disambiguates same-basename repos by path hash', { skip }, () => {
  const a = (runCts([repo('api')]).match(/-s (sb-api-\d+)/) || [])[1];
  const b = (runCts([repo('api')]).match(/-s (sb-api-\d+)/) || [])[1];
  assert.ok(a && b, 'both produced an sb-api-<hash> name');
  assert.notStrictEqual(a, b, 'different paths -> different session');
});

test('cts forwards extra args and gives the worktree its own session', { skip }, () => {
  const d = repo('airflow');
  const out = runCts([d, '-b', 'feature']);
  assert.match(out, /-s sb-airflow-\d+-feature /, 'branch appended to the session name');
  assert.ok(out.includes(`claude-sandbox ${d} -b feature`), '-b feature forwarded to claude-sandbox');
});

test('cts slugifies a slashed branch for the session name', { skip }, () => {
  const d = repo('airflow');
  const out = runCts([d, '-b', 'feat/x']);
  assert.match(out, /-s sb-airflow-\d+-feat-x /);
  assert.ok(out.includes('-b feat/x'), 'the real branch name is still forwarded verbatim');
});

test('cts treats a leading flag as a passthrough arg, not the dir', { skip }, () => {
  const d = repo('myrepo');
  const out = runCts(['-b', 'feature'], { cwd: d });
  assert.match(out, /-s sb-myrepo-\d+-feature/, 'dir defaulted to $PWD; branch still parsed');
  assert.ok(out.includes(`claude-sandbox ${d} -b feature`));
});

test('inside tmux, absent session: has-session -> new-session -d -> switch-client (no attach)', { skip }, () => {
  const d = repo('airflow');
  const out = runCts([d], { insideTmux: true, hasSession: false });
  assert.match(out, /has-session -t sb-airflow-\d+/);
  assert.match(out, /new-session -d -s sb-airflow-\d+ -c .* claude-sandbox/);
  assert.match(out, /switch-client -t sb-airflow-\d+/);
  assert.doesNotMatch(out, /new-session -A/, 'never attach-creates from inside tmux');
});

test('inside tmux, live session: has-session -> switch-client, never a second launch', { skip }, () => {
  const d = repo('airflow');
  const out = runCts([d], { insideTmux: true, hasSession: true });
  assert.match(out, /has-session -t sb-airflow-\d+/);
  assert.match(out, /switch-client -t sb-airflow-\d+/);
  assert.doesNotMatch(out, /new-session/, 'a live session is reused, not relaunched');
});

test('cts errors when tmux is missing', { skip }, () => {
  const empty = scratch();                       // a PATH with no tmux (and no coreutils)
  let err;
  try {
    execFileSync(BASH, [CTS, '/whatever'], { env: { ...process.env, PATH: empty }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { err = e; }
  assert.ok(err, 'exited non-zero');
  assert.strictEqual(err.status, 1);
  assert.match(String(err.stderr), /tmux not found/);
});

test('-h prints usage and exits 0', { skip }, () => {
  const out = execFileSync('bash', [CTS, '-h'], { encoding: 'utf8' });
  assert.match(out, /^usage: cts /);
});

test('real tmux accepts cts new-session and launches the command (skip-unless-tmux)', { skip: skipTmux }, () => {
  const tmpdir = scratch();
  const uid = process.getuid();
  const sock = path.join(tmpdir, `tmux-${uid}`, 'default');    // the default socket cts will use
  const d = repo('cts-int-repo');
  const sbin = path.join(scratch(), 'claude-sandbox');
  fs.writeFileSync(sbin, '#!/bin/bash\nexec sleep 300\n', { mode: 0o755 });   // keeps the pane alive
  // $TMUX points cts at THIS isolated server (socket field) and takes its inside-tmux
  // path (new-session -d). The trailing switch-client fails with no attached client —
  // harmless, the detached session is already created.
  const env = { ...process.env, TMUX_TMPDIR: tmpdir, TMUX: `${sock},1,0`, CLAUDE_SANDBOX_BIN: sbin };
  const verifyEnv = { ...process.env, TMUX_TMPDIR: tmpdir };   // talk to the server, not "inside" it
  const T = (...a) => execFileSync('tmux', a, { env: verifyEnv, encoding: 'utf8' });
  try {
    // Start the isolated server first so cts's has-session/new-session reach a real
    // server (with $TMUX set, tmux talks to that socket rather than spawning one).
    execFileSync('tmux', ['new-session', '-d', '-s', '_seed'], { env: verifyEnv, stdio: 'ignore' });
    try { execFileSync('bash', [CTS, d], { env, stdio: 'ignore' }); } catch { /* switch-client: no current client */ }
    const sessions = T('list-sessions', '-F', '#{session_name}').trim().split('\n');
    const made = sessions.filter((s) => /^sb-cts-int-repo-\d+$/.test(s));
    assert.strictEqual(made.length, 1, `exactly one sb-cts-int-repo session (got ${JSON.stringify(sessions)})`);
    const pid = T('list-panes', '-t', made[0], '-F', '#{pane_pid}').trim();
    assert.ok(pid.length > 0, 'the session has a live pane running the launcher');
  } finally {
    try { execFileSync('tmux', ['kill-server'], { env, stdio: 'ignore' }); } catch { /* already gone */ }
  }
});

// ---- remote (SSH) mode: `cts --ssh` starts a native claude tmux session on a host ----
// Stub `ssh` to log its args (and a no-op `tmux` so nothing else can fail the run), then
// assert cts drives `ssh -t <host> <remote-ct> [dir]` rather than the local sandbox path.
function runCtsSsh(args, extraEnv = {}) {
  const bin = scratch();
  const log = path.join(bin, 'ssh.log');
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/bash
echo "$*" >> ${JSON.stringify(log)}
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash\nexit 0\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.TMUX; delete env.CTS_REMOTE_HOST; delete env.CTS_REMOTE_CT; delete env.CTS_REMOTE_CTW;
  Object.assign(env, extraEnv);
  execFileSync('bash', [CTS, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
}

test('cts --ssh: attaches to the default homelab and runs the remote ctw launcher', { skip }, () => {
  const out = runCtsSsh(['--ssh']);
  assert.match(out, /(^|\s)-t\s+daniel-server\b/, 'ssh -t to the default host');
  assert.match(out, /\$HOME\/\.local\/bin\/ctw\b/, 'invokes the deployed ctw launcher on the remote');
});

test('cts --ssh REPO: forwards the repo to ctw for remote resolution', { skip }, () => {
  const out = runCtsSsh(['--ssh', '~/airflow']);
  assert.match(out, /ctw \$HOME\/'airflow'/, 'leading ~/ still expands on the remote; the rest is quoted');
});

test('cts --ssh REPO -b BRANCH: forwards repo + branch to ctw', { skip }, () => {
  const out = runCtsSsh(['--ssh', 'proj', '-b', 'feature']);
  assert.match(out, /ctw 'proj' 'feature'/, 'ctw receives repo then branch');
});

test('cts --ssh --branch BRANCH: long form also forwarded', { skip }, () => {
  const out = runCtsSsh(['--ssh', 'proj', '--branch', 'feat/x']);
  assert.match(out, /ctw 'proj' 'feat\/x'/);
});

test('cts --ssh -b without a repo errors', { skip }, () => {
  const bin = scratch();
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/bash\nexit 0\n`, { mode: 0o755 });
  let err;
  try {
    execFileSync('bash', [CTS, '--ssh', '-b', 'feature'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { err = e; }
  assert.ok(err, 'exited non-zero when -b has no repo');
  assert.match(String(err.stderr), /-b .*requires a repo|requires a repo/i);
});

test('cts --ssh=HOST overrides the remote host', { skip }, () => {
  const out = runCtsSsh(['--ssh=box2', 'proj']);
  assert.match(out, /-t\s+box2\b/);
  assert.match(out, /ctw 'proj'/);
});

test('cts -H HOST enables remote mode and sets the host', { skip }, () => {
  const out = runCtsSsh(['-H', 'box3', 'proj']);
  assert.match(out, /-t\s+box3\b/);
  assert.match(out, /ctw 'proj'/);
});

test('CTS_REMOTE_HOST sets the default remote host', { skip }, () => {
  const out = runCtsSsh(['--ssh'], { CTS_REMOTE_HOST: 'box4' });
  assert.match(out, /-t\s+box4\b/);
});

test('CTS_REMOTE_CTW overrides the remote helper path', { skip }, () => {
  const out = runCtsSsh(['--ssh', 'proj'], { CTS_REMOTE_CTW: '/opt/ctw' });
  assert.match(out, /\/opt\/ctw 'proj'/);
});

test('cts --ssh does not fall through to the local sandbox path', { skip }, () => {
  const out = runCtsSsh(['--ssh', 'proj']);
  assert.doesNotMatch(out, /new-session/, 'never runs the local tmux launcher in ssh mode');
  assert.doesNotMatch(out, /claude-sandbox/, '--ssh is not forwarded to claude-sandbox');
});

// ---- completion data modes: `cts --complete-repos|--complete-branches` -----------------
// _cts (zsh) calls these over the same ssh contract to populate tab-completion. They query
// `ctw --list-*` with fail-fast ssh flags and cache the result under $XDG_CACHE_HOME/cts.
function runCtsComplete(args, { sshOut = '', cacheDir, env = {} } = {}) {
  const bin = scratch();
  const log = path.join(bin, 'ssh.log');
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/bash
echo "$*" >> ${JSON.stringify(log)}
printf '%s' ${JSON.stringify(sshOut)}
exit 0
`, { mode: 0o755 });
  const e = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete e.CTS_REMOTE_HOST; delete e.CTS_REMOTE_CT; delete e.CTS_REMOTE_CTW; delete e.CTS_CACHE_TTL;
  if (cacheDir !== undefined) e.XDG_CACHE_HOME = cacheDir;
  Object.assign(e, env);
  let out = '', code = 0;
  try { out = execFileSync('bash', [CTS, ...args], { env: e, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (ex) { code = ex.status; out = String(ex.stdout || ''); }
  const sshArgs = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  return { out, code, sshArgs };
}

test('cts --complete-repos queries ctw --list-repos with fail-fast ssh flags', { skip }, () => {
  const { out, sshArgs } = runCtsComplete(['--complete-repos', 'box'], { sshOut: 'alpha\nbeta\n', cacheDir: scratch() });
  assert.match(sshArgs, /ctw --list-repos/, 'runs the remote list-repos query');
  assert.match(sshArgs, /BatchMode=yes/, 'never prompts for a password');
  assert.match(sshArgs, /ConnectTimeout=2/, 'fails fast on an unreachable host');
  assert.match(sshArgs, /(^|\s)box\b/, 'targets the given host');
  assert.match(out, /alpha/); assert.match(out, /beta/);
});

test('cts --complete-repos defaults to the homelab host', { skip }, () => {
  const { sshArgs } = runCtsComplete(['--complete-repos'], { sshOut: 'x\n', cacheDir: scratch() });
  assert.match(sshArgs, /(^|\s)daniel-server\b/);
});

test('cts --complete-branches HOST REPO queries ctw --list-branches REPO', { skip }, () => {
  const { out, sshArgs } = runCtsComplete(['--complete-branches', 'box', 'proj'], { sshOut: 'main\nfeature\n', cacheDir: scratch() });
  assert.match(sshArgs, /ctw --list-branches 'proj'/);
  assert.match(sshArgs, /BatchMode=yes/);
  assert.match(out, /feature/);
});

test('cts --complete-repos serves cache within the TTL (second call skips ssh)', { skip }, () => {
  const cache = scratch();
  const a = runCtsComplete(['--complete-repos', 'box'], { sshOut: 'alpha\nbeta\n', cacheDir: cache });
  assert.match(a.out, /alpha/);
  const b = runCtsComplete(['--complete-repos', 'box'], { sshOut: 'CHANGED\n', cacheDir: cache });
  assert.match(b.out, /alpha/, 'served from cache');
  assert.doesNotMatch(b.out, /CHANGED/, 'did not re-query');
  assert.strictEqual(b.sshArgs, '', 'ssh not invoked on a cache hit');
});

test('cts --complete-repos refetches when the TTL is 0', { skip }, () => {
  const cache = scratch();
  runCtsComplete(['--complete-repos', 'box'], { sshOut: 'alpha\n', cacheDir: cache, env: { CTS_CACHE_TTL: '0' } });
  const b = runCtsComplete(['--complete-repos', 'box'], { sshOut: 'beta\n', cacheDir: cache, env: { CTS_CACHE_TTL: '0' } });
  assert.match(b.out, /beta/, 'TTL=0 always refetches');
  assert.ok(b.sshArgs.length > 0, 'ssh invoked again');
});

test('cts --ssh errors when ssh is missing', { skip }, () => {
  const empty = scratch();                         // a PATH with neither ssh nor tmux
  let err;
  try {
    execFileSync(BASH, [CTS, '--ssh'], { env: { ...process.env, PATH: empty, TMUX: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { err = e; }
  assert.ok(err, 'exited non-zero');
  assert.strictEqual(err.status, 1);
  assert.match(String(err.stderr), /ssh not found/);
});

test('cts --host with no value errors', { skip }, () => {
  const bin = scratch();
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/bash\nexit 0\n`, { mode: 0o755 });
  let err;
  try {
    execFileSync('bash', [CTS, '--host'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { err = e; }
  assert.ok(err, 'exited non-zero when --host has no HOST');
});

test('-h documents --ssh remote mode', { skip }, () => {
  const out = execFileSync('bash', [CTS, '-h'], { encoding: 'utf8' });
  assert.match(out, /^usage: cts /, 'still prints the local usage first');
  assert.match(out, /--ssh/, 'documents the ssh remote mode');
});

// ---- remote-arg injection: repo/branch must reach the remote as DATA, not as code ------
// ssh concatenates its command arguments into ONE string and the remote login shell
// re-parses it, so asserting on cts's output text proves nothing on its own — the honest
// test is to let a real shell re-parse what cts produced. The `ssh` stub below stands in
// for the far side: it evals the command string with a `ctw` stub on PATH that records the
// argv it was actually handed, inside a throwaway HOME. A payload that escapes quoting
// leaves a marker file behind; one that doesn't, can't.
function runCtsRemote(args, { env = {} } = {}) {
  const bin = scratch();
  const log = path.join(bin, 'ctw.log');
  fs.writeFileSync(path.join(bin, 'ctw'), `#!/bin/bash
printf '%s\\n' "$@" >> ${JSON.stringify(log)}
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/bash
cmd="\${!#}"                    # ssh's last argument is the remote command string
cd ${JSON.stringify(bin)} || exit 1
PATH=${JSON.stringify(bin)}:"$PATH" HOME=${JSON.stringify(bin)} bash -c "$cmd"
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash\nexit 0\n`, { mode: 0o755 });
  const e = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CTS_REMOTE_CTW: 'ctw' };
  delete e.TMUX; delete e.CTS_REMOTE_HOST; delete e.CTS_CACHE_TTL;
  e.XDG_CACHE_HOME = scratch();
  Object.assign(e, env);
  execFileSync('bash', [CTS, ...args], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    argv: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
    injected: fs.existsSync(path.join(bin, 'INJECTED')),
    home: bin,
  };
}

test('cts --ssh: a repo carrying shell metacharacters reaches ctw as one literal argument', { skip }, () => {
  const r = runCtsRemote(['--ssh', 'x;touch INJECTED']);
  assert.deepStrictEqual(r.argv, ['x;touch INJECTED'], 'the whole payload is a single argv entry');
  assert.ok(!r.injected, 'the injected command did not run on the remote');
});

test('cts --ssh -b: a branch carrying shell metacharacters is quoted too', { skip }, () => {
  const r = runCtsRemote(['--ssh', 'proj', '-b', 'y;touch INJECTED']);
  assert.deepStrictEqual(r.argv, ['proj', 'y;touch INJECTED'], 'repo then branch, both intact');
  assert.ok(!r.injected, 'the injected command did not run on the remote');
});

test('cts --ssh: command substitution in a repo name is not evaluated remotely', { skip }, () => {
  const r = runCtsRemote(['--ssh', 'x$(touch INJECTED)']);
  assert.deepStrictEqual(r.argv, ['x$(touch INJECTED)']);
  assert.ok(!r.injected, '$( ) stayed literal');
});

test('cts --ssh: a repo name with an embedded single quote survives quoting', { skip }, () => {
  const r = runCtsRemote(["--ssh", "it's-a-repo"]);
  assert.deepStrictEqual(r.argv, ["it's-a-repo"], "the ' is escaped, not dropped or split on");
});

test('cts --ssh: a leading ~/ still expands on the remote, not locally', { skip }, () => {
  const r = runCtsRemote(['--ssh', '~/airflow']);
  assert.deepStrictEqual(r.argv, [`${r.home}/airflow`], 'expanded against the REMOTE home');
});

test('cts --complete-branches: a hostile repo word cannot execute on TAB', { skip }, () => {
  const r = runCtsRemote(['--complete-branches', 'box', 'x;touch INJECTED']);
  assert.deepStrictEqual(r.argv, ['--list-branches', 'x;touch INJECTED'], 'passed as data');
  assert.ok(!r.injected, 'pressing TAB does not run the completed word');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
