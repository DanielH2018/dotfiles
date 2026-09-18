// The four remaining launch-path functions extracted out of the launcher's
// top-level code, none of which had ever been executed under test:
//
//   resolve_session_context      per-instance dirs, and the auto-resume decision
//   add_host_integration_mounts  the 1Password agent socket and keybindings
//   add_sibling_repo_mounts      read-only sibling repos, snapshot or live
//   run_oauth_if_needed          whether to interrupt a launch for an OAuth login
//
// Each is driven with the same awk-extraction harness the other launcher tests
// use, against real directories. run_oauth_if_needed's `docker run` is stubbed:
// the logic worth pinning is the decision ABOVE it, which gates whether a launch
// stops for an interactive prompt at all.
//
// Fixture path variables avoid the name `src` on purpose — see the note in
// claude-sandbox-mounts.test.js about sandbox-escape.test.js tainting by name.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');

const SANDBOX_DIR_SRC = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'sandbox');
const LAUNCHER = path.join(SANDBOX_DIR_SRC, 'executable_claude-sandbox');
// The functions under test are spread across the launcher and the libs it sources, and
// which lib owns which keeps changing as the launcher is decomposed. Globbed rather
// than named, the way the other sandbox harnesses do it: naming them meant this file
// broke on each extraction, once for the mounts lib and again for the auth lib.
const SOURCES = [LAUNCHER, ...fs.readdirSync(SANDBOX_DIR_SRC)
  .filter((f) => /^executable_sandbox-.*\.sh$/.test(f))
  .sort()
  .map((f) => path.join(SANDBOX_DIR_SRC, f))];

const skip = process.platform === 'win32' ? 'launcher is Unix-only'
  : skipUnless('bash', 'awk', 'git');

function extractFunction(name) {
  const body = execFileSync('awk', [
    `/^${name}\\(\\) \\{/ { started=1 }\n` +
    'started {\n' +
    '  print\n' +
    '  depth += gsub(/{/,"{") - gsub(/}/,"}")\n' +
    '  if (started && depth==0) exit\n' +
    '}',
    ...SOURCES,
  ], { encoding: 'utf8' });
  assert.ok(new RegExp(`^${name}\\(\\) \\{`).test(body), `extracted the ${name} definition`);
  assert.strictEqual(body.trimEnd().split('\n').pop(), '}', `extracted ${name} body ends at its matching closing brace`);
  return body;
}

const FN = skip ? {} : Object.fromEntries(
  ['resolve_session_context', 'add_host_integration_mounts', 'add_sibling_repo_mounts',
    'run_oauth_if_needed', 'resolve_main_ref', 'build_repo_snapshot']
    .map((n) => [n, extractFunction(n)]),
);

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const ARGS_MARKER = '---DOCKER_ARGS---';
const VARS_MARKER = '---VARS---';

// Runs one function and reports what it appended to DOCKER_ARGS, what it printed,
// and the final value of any globals named in `dump`. `deps` names other launcher
// functions whose real bodies the one under test calls.
function drive(name, { env = {}, deps = [], dump = [], pre = '' } = {}) {
  const tmp = scratch(os.tmpdir(), 'sblc-');
  const script = `set -uo pipefail
export TMPDIR=${q(tmp)}
${Object.entries(env).map(([k, v]) => `${k}=${q(v)}`).join('\n')}
DOCKER_ARGS=()
${pre}
${deps.map((d) => FN[d]).join('\n')}
${FN[name]}
${name}
echo ${q(ARGS_MARKER)}
printf '%s\\n' \${DOCKER_ARGS[@]+"\${DOCKER_ARGS[@]}"}
echo ${q(VARS_MARKER)}
${dump.map((v) => `printf '%s=%s\\n' ${q(v)} "\${${v}:-}"`).join('\n')}
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const out = r.stdout ?? '';
  const a = out.indexOf(ARGS_MARKER);
  const b = out.indexOf(VARS_MARKER);
  assert.ok(a !== -1 && b !== -1, `harness for ${name} completed:\n${r.stderr}`);
  const args = out.slice(a + ARGS_MARKER.length, b).split('\n').filter(Boolean);
  const vars = Object.fromEntries(out.slice(b + VARS_MARKER.length).split('\n')
    .filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { stdout: out.slice(0, a), stderr: r.stderr ?? '', args, vars };
}

function mounts(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-v') continue;
    const parts = args[i + 1].split(':');
    out.push({ from: parts[0], dest: parts[1], mode: parts[2] ?? 'rw' });
  }
  return out;
}
const envOf = (args) => args.filter((a, i) => args[i - 1] === '-e');

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore', env: GIT_ENV });

// --- resolve_session_context -------------------------------------------------

function sessionRun({ priorSession = false, nestedOnly = false, wtSlug = false, fresh = false, worktree = false, dockerfile = null } = {}) {
  const base = scratch(os.tmpdir(), 'sblc-');
  const bases = {
    AUDIT_BASE: path.join(base, 'audit'),
    SESSIONS_BASE: path.join(base, 'sessions'),
    ARTIFACTS_BASE: path.join(base, 'artifacts'),
    PRIVATE_BASE: path.join(base, 'state-private'),
    STATE_DIR: path.join(base, 'state'),
  };
  const instance = 'demo-abc123';
  if (priorSession || nestedOnly) {
    const proj = path.join(bases.SESSIONS_BASE, instance, '-workspace', nestedOnly ? 'nested' : '.');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'conv.jsonl'), '{}\n');
  }
  // A session that made its own worktree and moved into it re-keys its project
  // directory to the new cwd, so the transcript lands beside "-workspace".
  if (wtSlug) {
    const proj = path.join(bases.SESSIONS_BASE, instance, '-workspace--claude-worktrees-alpha');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'dead-beef.jsonl'), '{}\n');
  }
  let dockerfilePath = path.join(base, 'Dockerfile.missing');
  if (dockerfile !== null) {
    dockerfilePath = path.join(base, 'Dockerfile');
    fs.writeFileSync(dockerfilePath, dockerfile);
  }
  const r = drive('resolve_session_context', {
    env: {
      ...bases,
      INSTANCE_ID: instance,
      REPO_PATH: path.join(base, 'repo'),
      WORK_PATH: path.join(base, 'work'),
      FRESH_SESSION: String(fresh),
      USE_WORKTREE: String(worktree),
      WT_BRANCH: 'claude/alpha',
      DOCKERFILE: dockerfilePath,
    },
    dump: ['RESUME_SESSION', 'RESUME_SESSION_ID', 'AUDIT_DIR', 'SESSIONS_DIR', 'ARTIFACTS_DIR', 'PRIVATE_DIR', 'AUTH_MARKER', 'TOOLCHAIN_LIST'],
  });
  return { ...r, base, bases, instance };
}

test('session context creates every per-instance directory it announces', { skip }, () => {
  // Docker materialises a missing bind-mount source as a root-owned dir on the
  // host, and these live under the user's real ~/.claude tree.
  const r = sessionRun();
  for (const key of ['AUDIT_DIR', 'SESSIONS_DIR', 'ARTIFACTS_DIR', 'PRIVATE_DIR']) {
    assert.ok(fs.existsSync(r.vars[key]), `${key} (${r.vars[key]}) must exist after the call`);
  }
  assert.ok(fs.existsSync(path.join(r.bases.STATE_DIR, 'hooks')),
    'the hooks dir is the parent of per-hook mount points and must be pre-created');
  assert.ok(r.vars.AUDIT_DIR.endsWith(r.instance), 'dirs are namespaced per instance');
  // history.jsonl is a FILE. Left absent, Docker materialises a root-owned
  // DIRECTORY in its place and Claude cannot write its prompt history at all.
  assert.ok(fs.statSync(path.join(r.vars.PRIVATE_DIR, 'history.jsonl')).isFile(),
    'the per-instance history.jsonl must be pre-created as a file');
  for (const d of ['file-history', 'shell-snapshots']) {
    assert.ok(fs.existsSync(path.join(r.vars.PRIVATE_DIR, d)), `${d} must be pre-created`);
  }
});

test('a prior conversation makes the launch resume', { skip }, () => {
  const r = sessionRun({ priorSession: true });
  assert.strictEqual(r.vars.RESUME_SESSION, 'true');
  assert.match(r.stdout, /resuming most recent conversation/);
});

test('--fresh starts cold even with a prior conversation on disk', { skip }, () => {
  const r = sessionRun({ priorSession: true, fresh: true });
  assert.strictEqual(r.vars.RESUME_SESSION, 'false');
  assert.doesNotMatch(r.stdout, /resuming/);
});

test('no prior conversation means no resume', { skip }, () => {
  assert.strictEqual(sessionRun().vars.RESUME_SESSION, 'false');
});

test('only top-level transcripts count towards resuming', { skip }, () => {
  // The scan is maxdepth 1. A .jsonl buried in a subdirectory is not a prior
  // conversation for this project dir, and resuming on one would replay the
  // wrong transcript.
  assert.strictEqual(sessionRun({ nestedOnly: true }).vars.RESUME_SESSION, 'false');
});

test('a transcript under a worktree slug resumes by session id, not --continue', { skip }, () => {
  // --continue resolves against the container cwd (/workspace) and cannot reach a
  // conversation keyed to a worktree the agent made for itself. Without this the
  // instance reads as cold on every relaunch while its transcript sits one
  // directory over — the reported "I don't see the session I was in".
  const r = sessionRun({ wtSlug: true });
  assert.strictEqual(r.vars.RESUME_SESSION, 'true');
  assert.strictEqual(r.vars.RESUME_SESSION_ID, 'dead-beef');
});

test('a -workspace transcript resumes by --continue, with no session id', { skip }, () => {
  // The cwd-scoped path still wins when the conversation is where cwd is: an id
  // is set only when the transcript lives under some other project slug.
  const r = sessionRun({ priorSession: true });
  assert.strictEqual(r.vars.RESUME_SESSION, 'true');
  assert.strictEqual(r.vars.RESUME_SESSION_ID, '');
});

test('--fresh ignores a worktree-slug transcript too', { skip }, () => {
  const r = sessionRun({ wtSlug: true, fresh: true });
  assert.strictEqual(r.vars.RESUME_SESSION, 'false');
  assert.strictEqual(r.vars.RESUME_SESSION_ID, '');
});

test('the cold path names the instance it looked for', { skip }, () => {
  // The cold path used to print nothing, so an instance id that missed by a
  // character was indistinguishable from a genuine first run.
  const r = sessionRun();
  assert.match(r.stdout, /no prior conversation for demo-abc123/);
  assert.match(r.stdout, /--list/);
});

test('the worktree branch is announced only for worktree sessions', { skip }, () => {
  assert.match(sessionRun({ worktree: true }).stdout, /Branch: claude\/alpha/);
  assert.doesNotMatch(sessionRun().stdout, /Branch:/);
});

test('toolchains are read off the generated Dockerfile', { skip }, () => {
  const r = sessionRun({ dockerfile: '# --- Node.js ---\nRUN true\n# --- Go ---\nRUN true\n' });
  assert.strictEqual(r.vars.TOOLCHAIN_LIST, 'Node.js,Go');
});

test('the toolchain separator alternates, which is a paste quirk not a choice', { skip }, () => {
  // `paste -sd ', '` reads ", " as a LIST of delimiters and cycles through it,
  // so entries are joined with a comma, then a space, then a comma again —
  // not with ", " as the code reads at a glance. Pinned as-is because this is
  // a cosmetic display string (SANDBOX_TOOLCHAINS); asserting the intended
  // ", " here would just fail against working code.
  const r = sessionRun({ dockerfile: '# --- A ---\n# --- B ---\n# --- C ---\n# --- D ---\n' });
  assert.strictEqual(r.vars.TOOLCHAIN_LIST, 'A,B C,D');
});

test('uv is appended to the toolchain list when the Dockerfile installs it', { skip }, () => {
  const r = sessionRun({ dockerfile: '# --- Python ---\nRUN curl -LsSf https://astral.sh/uv/install.sh\n' });
  assert.strictEqual(r.vars.TOOLCHAIN_LIST, 'Python, uv');
  assert.strictEqual(sessionRun({ dockerfile: '' }).vars.TOOLCHAIN_LIST, '');
});

// --- add_host_integration_mounts ---------------------------------------------

function hostRun({ socket = false, plainFile = false, keybindings = false } = {}) {
  const home = scratch(os.tmpdir(), 'sblc-');
  const sockPath = path.join(home, 'agent.sock');
  if (socket) {
    execFileSync('python3', ['-c',
      'import socket,sys\ns=socket.socket(socket.AF_UNIX)\ns.bind(sys.argv[1])\n', sockPath]);
  } else if (plainFile) {
    fs.writeFileSync(sockPath, '');
  }
  if (keybindings) {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'keybindings.json'), '{}');
  }
  // Aimed at a path that does not exist, so the WSLg clipboard branch stays out of these cases.
  // It is the one mount here not reached through $HOME, so on a WSL host it attached to every run
  // and the three "contributes nothing" assertions below failed against a real host integration.
  // Its own branch is covered separately, at the end of this group.
  const noWayland = path.join(home, 'no-wayland.sock');
  return {
    home,
    sockPath,
    ...drive('add_host_integration_mounts', { env: { OP_SOCKET: sockPath, HOME: home, WSLG_WAYLAND_SOCK: noWayland } }),
  };
}

test('the 1Password agent socket is forwarded when it exists', { skip }, () => {
  const r = hostRun({ socket: true });
  assert.ok(mounts(r.args).some((m) => m.from === r.sockPath && m.dest === '/run/1password/agent.sock'));
  assert.ok(envOf(r.args).includes('SSH_AUTH_SOCK=/run/1password/agent.sock'));
});

test('a missing agent socket is not mounted', { skip }, () => {
  // Bind-mounting a missing path makes docker create a directory on the host and
  // leaves SSH_AUTH_SOCK pointing at it, which breaks signing more confusingly
  // than simply having no agent.
  const r = hostRun({});
  assert.deepStrictEqual(r.args, []);
});

test('a regular file at the socket path is not forwarded either', { skip }, () => {
  // The guard is -S, not -e: a leftover regular file must not be presented to
  // the container as an ssh-agent socket.
  assert.deepStrictEqual(hostRun({ plainFile: true }).args, []);
});

test('host keybindings are mounted read-only when present', { skip }, () => {
  const r = hostRun({ keybindings: true });
  const m = mounts(r.args).find((x) => x.dest.endsWith('keybindings.json'));
  assert.ok(m, 'keybindings should be mounted');
  assert.strictEqual(m.mode, 'ro');
  assert.deepStrictEqual(hostRun({}).args, [], 'and nothing is mounted when absent');
});

// The branch the suppression above exists for. Worth covering rather than only silencing: it is a
// real host integration, it had no test at all, and the way it surfaced was three unrelated
// assertions failing on WSL — which reads as those integrations being broken, not this one being
// untested. Driven through the override, so it runs on every host rather than only under WSLg.
test('the WSLg Wayland clipboard socket is forwarded when it exists', { skip }, () => {
  const home = scratch(os.tmpdir(), 'sblc-');
  const sock = path.join(home, 'wayland-0');
  execFileSync('python3', ['-c',
    'import socket,sys\ns=socket.socket(socket.AF_UNIX)\ns.bind(sys.argv[1])\n', sock]);
  const r = drive('add_host_integration_mounts', {
    env: { OP_SOCKET: path.join(home, 'absent.sock'), HOME: home, WSLG_WAYLAND_SOCK: sock },
  });
  assert.ok(mounts(r.args).some((m) => m.from === sock && m.dest === '/tmp/wl-clip.sock'),
    'the host clipboard socket should be mounted at the path the xclip shim reads');
  assert.ok(envOf(r.args).includes('WAYLAND_DISPLAY=/tmp/wl-clip.sock'));
});

// --- add_sibling_repo_mounts -------------------------------------------------

// A ~/Repositories with `alpha` and `beta` (both git), a `notes` plain dir, and
// a `alpha-wt-x` worktree-shaped dir. `workspace` is the repo being sandboxed.
function reposFixture() {
  const base = scratch(os.tmpdir(), 'sblc-');
  const reposRoot = path.join(base, 'Repositories');
  const snapRoot = path.join(base, 'snapshots');
  fs.mkdirSync(reposRoot, { recursive: true });
  fs.mkdirSync(snapRoot, { recursive: true });
  const made = {};
  for (const name of ['alpha', 'beta', 'workspace', 'alpha-wt-x']) {
    const dir = path.join(reposRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t.t');
    git(dir, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'file.txt'), name);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'root');
    made[name] = dir;
  }
  fs.mkdirSync(path.join(reposRoot, 'notes'), { recursive: true });
  return { base, reposRoot, snapRoot, made };
}

function reposRun(f, over = {}) {
  return drive('add_sibling_repo_mounts', {
    deps: ['resolve_main_ref', 'build_repo_snapshot'],
    env: {
      NO_REPOS: 'false',
      REPOS_LIVE: 'false',
      REPOS_ROOT: f.reposRoot,
      REPO_SNAPSHOT_ROOT: f.snapRoot,
      REPO_PATH: f.made.workspace,
      ...over,
    },
    dump: ['repos_mounted'],
  });
}

test('sibling repos are snapshotted and mounted read-only', { skip }, () => {
  const f = reposFixture();
  const m = mounts(reposRun(f).args);
  const dests = m.map((x) => x.dest).sort();
  assert.deepStrictEqual(dests, [path.join(f.reposRoot, 'alpha'), path.join(f.reposRoot, 'beta')]);
  for (const x of m) {
    assert.strictEqual(x.mode, 'ro', 'sibling repos are reference material, never writable');
    assert.ok(x.from.startsWith(f.snapRoot), 'the mount source is the snapshot, not the live tree');
  }
});

test('the workspace repo, worktree dirs and non-git dirs are all skipped', { skip }, () => {
  const f = reposFixture();
  const dests = mounts(reposRun(f).args).map((x) => x.dest);
  assert.ok(!dests.some((d) => d.endsWith('/workspace')), 'the repo being sandboxed is already at /workspace');
  assert.ok(!dests.some((d) => d.includes('-wt-')), 'tool worktrees are noise');
  assert.ok(!dests.some((d) => d.endsWith('/notes')), 'a plain directory is not a repo');
});

test('--no-repos mounts nothing', { skip }, () => {
  const f = reposFixture();
  assert.deepStrictEqual(reposRun(f, { NO_REPOS: 'true' }).args, []);
});

test('--repos-live mounts the working trees instead of snapshots', { skip }, () => {
  const f = reposFixture();
  const r = reposRun(f, { REPOS_LIVE: 'true' });
  const m = mounts(r.args);
  for (const x of m) {
    assert.strictEqual(x.mode, 'ro');
    assert.strictEqual(x.from, x.dest, 'live mode mounts the real tree at its own path');
    assert.ok(!x.from.startsWith(f.snapRoot));
  }
  assert.ok(envOf(r.args).includes('SANDBOX_REPOS_LIVE=1'), 'the container is told these are live trees');
});

test('the repos dir is advertised only when something mounted', { skip }, () => {
  const f = reposFixture();
  assert.ok(envOf(reposRun(f).args).includes(`SANDBOX_REPOS_DIR=${f.reposRoot}`));

  const empty = reposFixture();
  fs.rmSync(empty.made.alpha, { recursive: true, force: true });
  fs.rmSync(empty.made.beta, { recursive: true, force: true });
  fs.rmSync(empty.made['alpha-wt-x'], { recursive: true, force: true });
  const r = reposRun(empty);
  assert.deepStrictEqual(r.args, [], 'only the workspace repo remains, so nothing to mount');
});

test('snapshots of the same repo are pruned to the newest two', { skip }, () => {
  // Every launch snapshots main at its current SHA; without the prune the cache
  // grows a full copy of every repo per commit, forever.
  const f = reposFixture();
  const alphaSnaps = path.join(f.snapRoot, 'alpha');
  for (const old of ['sha1', 'sha2', 'sha3']) {
    fs.mkdirSync(path.join(alphaSnaps, old), { recursive: true });
    fs.writeFileSync(path.join(alphaSnaps, old, '.ok'), '');
  }
  reposRun(f);
  const kept = fs.readdirSync(alphaSnaps);
  assert.strictEqual(kept.length, 2, `expected 2 snapshots kept, got ${JSON.stringify(kept)}`);
});

test('a second launch reuses the snapshot instead of rebuilding it', { skip }, () => {
  const f = reposFixture();
  const first = reposRun(f);
  assert.match(first.stdout, /snapshotting/);
  const second = reposRun(f);
  assert.doesNotMatch(second.stdout, /snapshotting/, 'the .ok marker must short-circuit the archive');
  assert.strictEqual(second.vars.repos_mounted, '2');
});

// --- run_oauth_if_needed -----------------------------------------------------

// `docker` is stubbed; the decision above it is what matters. dockerOk=false
// stands for the user cancelling the login.
function oauthRun({ markerAgeDays = null, shell = false, exec = false, dockerOk = true } = {}) {
  const state = scratch(os.tmpdir(), 'sblc-');
  const marker = path.join(state, '.auth-configured');
  if (markerAgeDays !== null) {
    fs.writeFileSync(marker, '');
    const when = new Date(Date.now() - markerAgeDays * 86400 * 1000);
    fs.utimesSync(marker, when, when);
  }
  const r = drive('run_oauth_if_needed', {
    env: {
      AUTH_MARKER: marker,
      SHELL_MODE: String(shell),
      EXEC_MODE: String(exec),
      STATE_DIR: state,
      SANDBOX_SETTINGS: path.join(state, 'settings.json'),
      IMAGE_TAG: 'claudebot:test',
    },
    pre: `ENGINE_ARGS=()
add_mount_relabel() { printf '%s' "$1"; }
docker() { echo "DOCKER_RUN_INVOKED"; return ${dockerOk ? 0 : 1}; }`,
    dump: ['AUTH_NEEDED'],
  });
  return { ...r, marker };
}

test('a missing auth marker triggers the OAuth login', { skip }, () => {
  const r = oauthRun({});
  assert.strictEqual(r.vars.AUTH_NEEDED, 'true');
  assert.match(r.stdout, /DOCKER_RUN_INVOKED/);
});

test('a recent auth marker launches straight through', { skip }, () => {
  const r = oauthRun({ markerAgeDays: 3 });
  assert.strictEqual(r.vars.AUTH_NEEDED, 'false');
  assert.doesNotMatch(r.stdout, /DOCKER_RUN_INVOKED/);
  assert.strictEqual(r.stdout.trim(), '', 'a normal launch says nothing about auth');
});

test('an auth marker older than 30 days re-authenticates', { skip }, () => {
  const r = oauthRun({ markerAgeDays: 45 });
  assert.strictEqual(r.vars.AUTH_NEEDED, 'true');
  assert.match(r.stdout, />30 days old/);
});

test('--shell and --exec never stop for an interactive login', { skip }, () => {
  // Neither can complete an OAuth flow: --exec is headless, and a standalone
  // shell has no need of cloud MCPs. Prompting would hang the launch.
  for (const mode of [{ shell: true }, { exec: true }]) {
    const r = oauthRun(mode);
    assert.strictEqual(r.vars.AUTH_NEEDED, 'false', `${JSON.stringify(mode)} must skip auth`);
    assert.doesNotMatch(r.stdout, /DOCKER_RUN_INVOKED/);
  }
});

test('the marker is written only when the login actually succeeds', { skip }, () => {
  const ok = oauthRun({ dockerOk: true });
  assert.ok(fs.existsSync(ok.marker), 'a successful login is recorded so later launches skip it');
  assert.match(ok.stdout, /Authentication saved/);

  const cancelled = oauthRun({ dockerOk: false });
  assert.ok(!fs.existsSync(cancelled.marker), 'a cancelled login must not be recorded as done');
  assert.match(cancelled.stdout, /Authentication skipped/);
});
