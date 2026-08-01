// The last four launcher functions without coverage. Each was previously
// written off as needing a container runtime; only two of them touch docker at
// all, and both only through a single command that can be stubbed:
//
//   build_base               what it asks docker to build, and the daily-vs-forced
//                            cache-bust arg that decides whether Claude Code is
//                            actually re-pulled
//   refresh_claude_if_stale  whether a launch stops to rebuild the base image
//   list_sessions            running/stopped detection and the resume command
//                            printed for each session
//   compact_session          archiving a finished session into the vault — no
//                            docker at any point; it drives compact-session.py
//
// Real directories, real git repos and the real compact-session.py throughout;
// `docker` is a stub because building an image says nothing about the decision
// to build one. Offline; skips cleanly without bash/awk/git/python3.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX = path.join(__dirname, '..', 'home', 'private_dot_claude', 'sandbox');
const LAUNCHER = path.join(SANDBOX, 'executable_claude-sandbox');
const WORKTREE_LIB = path.join(SANDBOX, 'executable_sandbox-worktree.sh');

let toolsOk = true;
try {
  execFileSync('bash', ['-c', 'command -v awk'], { stdio: 'ignore' });
  execFileSync('git', ['--version'], { stdio: 'ignore' });
  execFileSync('python3', ['--version'], { stdio: 'ignore' });
} catch { toolsOk = false; }
const skip = process.platform === 'win32' ? 'launcher is Unix-only'
  : toolsOk ? false : 'bash/awk/git/python3 unavailable';

function extractFunction(name) {
  const body = execFileSync('awk', [
    `/^${name}\\(\\) \\{/ { started=1 }\n` +
    'started {\n  print\n  depth += gsub(/{/,"{") - gsub(/}/,"}")\n  if (started && depth==0) exit\n}',
    LAUNCHER,
  ], { encoding: 'utf8' });
  assert.ok(new RegExp(`^${name}\\(\\) \\{`).test(body), `extracted the ${name} definition`);
  assert.strictEqual(body.trimEnd().split('\n').pop(), '}', `extracted ${name} body ends at its matching closing brace`);
  return body;
}

const FN = skip ? {} : Object.fromEntries(
  ['build_base', 'refresh_claude_if_stale', 'list_sessions', 'compact_session']
    .map((n) => [n, extractFunction(n)]),
);

const dirs = [];
process.on('exit', () => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function scratch() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sblf-'));
  dirs.push(d);
  return d;
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const VARS_MARKER = '---VARS---';

// Runs one function. `pre` carries stubs; `lib` sources the real worktree
// helpers; `dump` reports globals afterwards. TMPDIR is redirected per run so
// any mktemp files are both disposable and countable.
function drive(name, { env = {}, deps = [], dump = [], pre = '', lib = false, args = '' } = {}) {
  const tmp = scratch();
  const script = `set -uo pipefail
export TMPDIR=${q(tmp)}
${lib ? `. ${q(WORKTREE_LIB)}` : ''}
${Object.entries(env).map(([k, v]) => `${k}=${q(v)}`).join('\n')}
${pre}
${deps.map((d) => FN[d]).join('\n')}
${FN[name]}
${name} ${args}
echo ${q(VARS_MARKER)}
${dump.map((v) => `printf '%s=%s\\n' ${q(v)} "\${${v}:-}"`).join('\n')}
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const out = r.stdout ?? '';
  const at = out.indexOf(VARS_MARKER);
  assert.notStrictEqual(at, -1, `harness for ${name} completed:\n${r.stderr}`);
  const vars = Object.fromEntries(out.slice(at + VARS_MARKER.length).split('\n')
    .filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const leaked = fs.readdirSync(tmp);
  return { stdout: out.slice(0, at), stderr: r.stderr ?? '', vars, tmp, leaked };
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore', env: GIT_ENV });

// --- build_base --------------------------------------------------------------

// The stub prints the docker argv one word per line so the build args can be
// asserted without matching on a formatted command string.
const DOCKER_ECHO = `docker() { printf 'DOCKERARG:%s\\n' "$@"; }`;

function buildRun({ force = false } = {}) {
  const state = path.join(scratch(), 'state');
  const r = drive('build_base', {
    env: { SANDBOX_DIR: SANDBOX, STATE_DIR: state },
    pre: DOCKER_ECHO,
    args: force ? 'force' : '',
  });
  const argv = r.stdout.split('\n').filter((l) => l.startsWith('DOCKERARG:')).map((l) => l.slice(10));
  const stamp = path.join(state, '.last-claude-update');
  return { ...r, argv, state, stamp, stamped: fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : null };
}

test('build_base builds the base image from the sandbox Dockerfile', { skip }, () => {
  const r = buildRun();
  assert.deepStrictEqual(r.argv.slice(0, 3), ['build', '-t', 'claudebot:base']);
  assert.strictEqual(r.argv[r.argv.indexOf('-f') + 1], path.join(SANDBOX, 'Dockerfile.base'));
  assert.strictEqual(r.argv[r.argv.length - 1], SANDBOX, 'the build context is the sandbox dir');
});

test('an ordinary build busts the cache once per day', { skip }, () => {
  // CLAUDE_CODE_REFRESH exists only to invalidate the layer that npm-installs
  // Claude Code. A date-granular value means one re-pull per day.
  const arg = buildRun().argv.find((a) => a.startsWith('CLAUDE_CODE_REFRESH='));
  assert.match(arg, /^CLAUDE_CODE_REFRESH=\d{8}$/, `expected a date, got ${arg}`);
});

test('a forced build busts the cache on every invocation', { skip }, () => {
  // --rebuild-base must actually re-pull, so the value goes to second
  // granularity; a date would let two forced builds in one day share a layer.
  const arg = buildRun({ force: true }).argv.find((a) => a.startsWith('CLAUDE_CODE_REFRESH='));
  assert.match(arg, /^CLAUDE_CODE_REFRESH=\d{14}$/, `expected a timestamp, got ${arg}`);
});

test('build_base records when Claude Code was last refreshed', { skip }, () => {
  // refresh_claude_if_stale reads this stamp; without it every launch rebuilds.
  const r = buildRun();
  assert.match(r.stamped ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

// --- refresh_claude_if_stale -------------------------------------------------

function staleRun({ baseImage = true, stampAgeDays = null } = {}) {
  const state = path.join(scratch(), 'state');
  if (stampAgeDays !== null) {
    fs.mkdirSync(state, { recursive: true });
    const stamp = path.join(state, '.last-claude-update');
    fs.writeFileSync(stamp, 'x');
    const when = new Date(Date.now() - stampAgeDays * 86400 * 1000);
    fs.utimesSync(stamp, when, when);
  }
  return drive('refresh_claude_if_stale', {
    deps: ['build_base'],
    env: { SANDBOX_DIR: SANDBOX, STATE_DIR: state, REBUILD: 'false' },
    pre: `docker() {
  if [[ "\${1:-}" == "image" ]]; then return ${baseImage ? 0 : 1}; fi
  printf 'DOCKERARG:%s\\n' "$@"
}`,
    dump: ['REBUILD'],
  });
}

test('a fresh install does not rebuild before the base image exists', { skip }, () => {
  // --rebuild-base/first launch builds it; refreshing something absent would
  // build the base twice on a first run.
  const r = staleRun({ baseImage: false });
  assert.doesNotMatch(r.stdout, /Refreshing/);
  assert.strictEqual(r.vars.REBUILD, 'false');
});

test('a refresh within the last day is skipped', { skip }, () => {
  const r = staleRun({ stampAgeDays: 0 });
  assert.doesNotMatch(r.stdout, /Refreshing/);
  assert.strictEqual(r.vars.REBUILD, 'false');
});

test('a stale stamp refreshes Claude Code and forces the per-repo rebuild', { skip }, () => {
  // REBUILD=true is the point: a new base image with no per-repo rebuild leaves
  // the session running the old Claude Code from the derived image's layers.
  const r = staleRun({ stampAgeDays: 3 });
  assert.match(r.stdout, /Refreshing Claude Code/);
  assert.strictEqual(r.vars.REBUILD, 'true');
});

test('a missing stamp alongside an existing image also refreshes', { skip }, () => {
  const r = staleRun({ stampAgeDays: null });
  assert.match(r.stdout, /Refreshing Claude Code/);
  assert.strictEqual(r.vars.REBUILD, 'true');
});

// --- list_sessions -----------------------------------------------------------

function sessionsFixture(worktrees = [{ name: 'alpha', branch: 'claude/alpha' }, { name: 'beta', branch: 'feature/x' }]) {
  const root = scratch();
  const repo = path.join(root, 'demo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'root');
  for (const { name, branch } of worktrees) {
    git(repo, 'worktree', 'add', '-q', '-b', branch, path.join(root, `demo-wt-${name}`));
  }
  return { root, repo };
}

function listRun(f, { running = '', sessionsBase = null } = {}) {
  const r = drive('list_sessions', {
    lib: true,
    env: { REPO_PATH: f.repo, SESSIONS_BASE: sessionsBase ?? path.join(f.root, 'sessions') },
    pre: `docker() { printf '%s\\n' ${q(running)}; }`,
  });
  const rows = r.stdout.split('\n').filter((l) => /^ {2}\S/.test(l) && !/^ {2}(NAME|----)/.test(l));
  return { ...r, rows };
}

test('list_sessions lists the main repo and every tool worktree', { skip }, () => {
  const f = sessionsFixture();
  const { rows } = listRun(f);
  assert.ok(rows.some((l) => l.includes('(main)') && l.includes('main')));
  assert.ok(rows.some((l) => l.includes('alpha') && l.includes('claude/alpha')));
  assert.ok(rows.some((l) => l.includes('beta') && l.includes('feature/x')));
});

// A function declaration, not `const repoHash = …`: sandbox-escape.test.js
// taints names by declaration, WORKTREE_LIB is built from __dirname, and an
// arrow bound to a const would spread that taint to every `const x =
// repoHash(…)` and then to any directory built from it.
function repoHash(repo) {
  return execFileSync('bash', ['-c', `. ${q(WORKTREE_LIB)}; repo_hash ${q(repo)}`], { encoding: 'utf8' }).trim();
}

test('a running worktree container is reported as running', { skip }, () => {
  const f = sessionsFixture();
  assert.ok(listRun(f).rows.every((l) => l.includes('stopped')), 'nothing running with empty docker ps');

  const r = listRun(f, { running: `claudebot-demo-${repoHash(f.repo)}-alpha-1a2b3c` });
  const alpha = r.rows.find((l) => l.trim().startsWith('alpha'));
  assert.ok(alpha.includes('running'), `alpha should be running: ${alpha}`);
  assert.ok(r.rows.find((l) => l.trim().startsWith('beta')).includes('stopped'),
    'an unrelated worktree stays stopped');
});

test('a hex-initial worktree name does not mark the main session running', { skip }, () => {
  // The probe means to match the hex run id appended to the bare instance. Left
  // unanchored it also matched a WORKTREE whose name merely starts with a hex
  // character, so a running `alpha` reported the main repo as running too —
  // alpha, beta, cache, docs, edge, fix, api and db all hit it.
  const f = sessionsFixture();
  const hex = listRun(f, { running: `claudebot-demo-${repoHash(f.repo)}-alpha-1a2b3c` });
  assert.ok(hex.rows.find((l) => l.includes('(main)')).includes('stopped'),
    'main stays stopped while only a worktree is running');
  assert.ok(hex.rows.find((l) => /^\s*alpha\s/.test(l)).includes('running'),
    'the worktree that is actually running still reports running');

  // The non-hex name always took the correct path; it must keep doing so.
  const nonHex = sessionsFixture([{ name: 'notes', branch: 'claude/notes' }]);
  const clean = listRun(nonHex, { running: `claudebot-demo-${repoHash(nonHex.repo)}-notes-1a2b3c` });
  assert.ok(clean.rows.find((l) => l.includes('(main)')).includes('stopped'),
    'main is correctly stopped when the worktree name does not start with a hex char');
});

test('a real main-session container is still detected', { skip }, () => {
  // Anchoring must not break the case the probe exists for: the bare instance
  // plus a run id, with no worktree segment in between.
  const f = sessionsFixture();
  const r = listRun(f, { running: `claudebot-demo-${repoHash(f.repo)}-1a2b3c` });
  assert.ok(r.rows.find((l) => l.includes('(main)')).includes('running'),
    'main reports running when its own container is up');
  assert.ok(r.rows.filter((l) => !l.includes('(main)')).every((l) => l.includes('stopped')),
    'no worktree is dragged along by the main session');
});

test('a worktree probe does not match a longer worktree name', { skip }, () => {
  // The same defect class at the worktree probe, which was unanchored too: a
  // running `alpha-beta` would have marked `alpha` running, since b is hex.
  const f = sessionsFixture([
    { name: 'alpha', branch: 'claude/alpha' },
    { name: 'alpha-beta', branch: 'claude/alpha-beta' },
  ]);
  const r = listRun(f, { running: `claudebot-demo-${repoHash(f.repo)}-alpha-beta-1a2b3c` });
  assert.ok(r.rows.find((l) => l.trim().startsWith('alpha-beta')).includes('running'),
    'the worktree that is running reports running');
  assert.ok(r.rows.find((l) => /^\s*alpha\s/.test(l)).includes('stopped'),
    'the shorter name must not inherit the longer one\'s status');
});

test('the resume command differs for tool branches and adopted branches', { skip }, () => {
  // A claude/* worktree is re-entered by NAME (--worktree alpha); one created
  // with -b on a pre-existing branch must be re-entered by BRANCH, since its
  // name is not derivable from the branch.
  const f = sessionsFixture();
  const { rows } = listRun(f);
  assert.match(rows.find((l) => l.trim().startsWith('alpha')), /--worktree alpha/);
  assert.match(rows.find((l) => l.trim().startsWith('beta')), /--branch feature\/x/);
});

test('sessions whose worktree is gone are listed as orphaned', { skip }, () => {
  const f = sessionsFixture([]);
  const hash = repoHash(f.repo);
  const sessionsBase = path.join(f.root, 'sessions');
  fs.mkdirSync(path.join(sessionsBase, `demo-${hash}-ghost`), { recursive: true });
  const { rows } = listRun(f, { sessionsBase });
  const ghost = rows.find((l) => l.includes('ghost'));
  assert.ok(ghost, `expected an orphaned row, got ${JSON.stringify(rows)}`);
  assert.match(ghost, /orphaned/);
  assert.match(ghost, /no worktree/);
});

// --- compact_session ---------------------------------------------------------

// compact_session invokes "$SANDBOX_DIR/compact-session.py". In the chezmoi
// SOURCE tree that file is executable_compact-session.py — the plain name only
// exists once chezmoi has deployed it. Pointing SANDBOX_DIR straight at the
// source dir makes every extraction fail, which looks like a passing test on
// the paths that expect a warning. So the harness stages a deployed-shaped
// copy: same content, deployed names.
let deployedSandbox = null;
function deployedSandboxDir() {
  if (deployedSandbox) return deployedSandbox;
  deployedSandbox = scratch();
  for (const name of fs.readdirSync(SANDBOX)) {
    const target = name.startsWith('executable_') ? name.slice('executable_'.length) : name;
    const from = path.join(SANDBOX, name);
    if (!fs.statSync(from).isFile()) continue;
    fs.copyFileSync(from, path.join(deployedSandbox, target));
  }
  assert.ok(fs.existsSync(path.join(deployedSandbox, 'compact-session.py')),
    'the staged sandbox dir must expose compact-session.py under its deployed name');
  return deployedSandbox;
}

const CONVERSATION = [
  { type: 'user', message: { content: 'Please fix the bug' }, timestamp: '2026-01-01T00:00:00Z' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed it' }] }, timestamp: '2026-01-01T00:01:00Z' },
].map((e) => JSON.stringify(e)).join('\n');

function compactRun({ transcript = CONVERSATION, instance = 'demo-abc-alpha', vault = true, existingVault = null } = {}) {
  const base = scratch();
  const sessionsBase = path.join(base, 'sessions');
  if (transcript !== null) {
    const dir = path.join(sessionsBase, instance, '-workspace');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'chat.jsonl'), `${transcript}\n`);
  }
  const home = path.join(base, 'home');
  const vaultDir = path.join(base, 'vault');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    SESSIONS_BASE: sessionsBase,
    SANDBOX_DIR: deployedSandboxDir(),
    REPO_PATH: path.join(base, 'repo'),
    HOME: home,
  };
  if (vault) env.CLAUDE_VAULT_DIR = vaultDir;
  const outDir = vault ? path.join(vaultDir, 'Work', 'Sessions', 'demo')
    : path.join(home, '.claude', 'sandbox-sessions', 'demo');
  if (existingVault) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const name of existingVault) fs.writeFileSync(path.join(outDir, name), 'old\n');
  }
  const r = drive('compact_session', {
    env,
    pre: 'unset ANTHROPIC_API_KEY ANTHROPIC_ADMIN_API_KEY || true',
    args: `${q(instance)} demo alpha`,
  });
  const written = fs.existsSync(outDir) ? fs.readdirSync(outDir).sort() : [];
  return { ...r, outDir, written };
}

test('a finished session is archived into the vault', { skip }, () => {
  const r = compactRun();
  const notes = r.written.filter((n) => n !== '_Index.md');
  assert.strictEqual(notes.length, 1, `expected one note, got ${JSON.stringify(r.written)}`);
  assert.match(notes[0], /^alpha_\d{4}-\d{2}-\d{2}\.md$/);
  assert.match(r.stdout, /Archived to/);
});

test('the sessions index is created with frontmatter and gains a row', { skip }, () => {
  const r = compactRun();
  const index = fs.readFileSync(path.join(r.outDir, '_Index.md'), 'utf8');
  assert.match(index, /^title: "Sessions — demo"$/m);
  assert.match(index, /^\| Date \| Worktree \| Summary \| Link \|$/m);
  const rows = index.split('\n').filter((l) => l.startsWith('| 2'));
  assert.strictEqual(rows.length, 1, 'exactly one session row');
  assert.match(rows[0], /\| alpha \|/);
  assert.match(rows[0], /\[\[alpha_\d{4}-\d{2}-\d{2}\]\]/, 'the row links to the note');
});

test('a second session on the same day does not overwrite the first', { skip }, () => {
  const today = new Date().toISOString().slice(0, 10);
  const r = compactRun({ existingVault: [`alpha_${today}.md`] });
  assert.ok(r.written.includes(`alpha_${today}_2.md`), `expected a _2 suffix, got ${JSON.stringify(r.written)}`);
  assert.strictEqual(fs.readFileSync(path.join(r.outDir, `alpha_${today}.md`), 'utf8'), 'old\n',
    'the existing note must be left untouched');
});

test('the duplicate counter keeps climbing past the second session', { skip }, () => {
  const today = new Date().toISOString().slice(0, 10);
  const r = compactRun({ existingVault: [`alpha_${today}.md`, `alpha_${today}_2.md`] });
  assert.ok(r.written.includes(`alpha_${today}_3.md`), `expected a _3 suffix, got ${JSON.stringify(r.written)}`);
});

test('compaction falls back to a home directory when there is no vault', { skip }, () => {
  const r = compactRun({ vault: false });
  assert.ok(r.written.some((n) => n.startsWith('alpha_')), `expected a note under ${r.outDir}`);
});

test('a missing session directory is skipped without failing', { skip }, () => {
  const r = compactRun({ transcript: null });
  assert.match(r.stdout, /No session data for demo-abc-alpha/);
  assert.deepStrictEqual(r.written, []);
});

test('an unparseable transcript is skipped without writing a note', { skip }, () => {
  const r = compactRun({ transcript: 'not json\nalso not json' });
  assert.match(r.stdout, /Warning: .*(extraction failed|no session data)/);
  assert.deepStrictEqual(r.written, []);
});

test('compaction leaves no temp files behind, on any path', { skip }, () => {
  // The extract and summary files are mktemp'd into TMPDIR; an earlier leak of
  // exactly this shape is why the launcher grew a cleanup block.
  for (const opts of [{}, { transcript: null }, { transcript: 'not json' }, { vault: false }]) {
    const r = compactRun(opts);
    assert.deepStrictEqual(r.leaked, [], `${JSON.stringify(opts)} left ${JSON.stringify(r.leaked)}`);
  }
});

test('the index sed leaves no .bak file in the vault', { skip }, () => {
  const r = compactRun();
  assert.ok(!r.written.some((n) => n.endsWith('.bak')), `stray backup: ${JSON.stringify(r.written)}`);
});
