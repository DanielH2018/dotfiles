// The five functions that decide what the sandbox container can see and write.
// They were straight-line top-level code until they were extracted into
// functions; nothing has ever driven them. sandbox-config-content.test.js
// asserts the static DOCKER_ARGS=( ... ) literal, but the conditional logic
// that APPENDS to that array — every host path the container gets, and whether
// it lands read-only or read-write — has no coverage. A gate silently ceasing
// to fire (--no-vault ignored, a :ro dropped to :rw) passes every other test.
//
// The four mount functions now live in sandbox-mounts.sh, so the harness sources
// that file and drives each one against real fixture directories. configure_gh_auth
// is still launcher-resident, so it keeps the awk extraction used by
// claude-sandbox-launcher.test.js. Offline; skips cleanly without bash/awk.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const SANDBOX_SRC = srcPath('private_dot_claude', 'sandbox');

const skip = process.platform === 'win32' ? 'launcher is Unix-only'
  : skipUnless('bash', 'awk');

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Each entry is the bash that defines the function under test — now a source line
// for every one of them, since configure_gh_auth moved out of the launcher into
// sandbox-auth.sh. Sourcing that lib is safe here even though run_oauth_if_needed
// inside it calls a launcher function: the libs define functions and run nothing at
// load time, so the call would only fail if this suite invoked that function.
const SOURCE_MOUNTS = `. ${q(path.join(SANDBOX_SRC, 'executable_sandbox-mounts.sh'))}`;
const SOURCE_AUTH = `. ${q(path.join(SANDBOX_SRC, 'executable_sandbox-auth.sh'))}`;
const FN = skip ? {} : {
  add_vault_mounts: SOURCE_MOUNTS,
  add_chezmoi_mount: SOURCE_MOUNTS,
  add_work_config_mount: SOURCE_MOUNTS,
  add_vault_self_hardening: SOURCE_MOUNTS,
  configure_gh_auth: SOURCE_AUTH,
};

const ARGS_MARKER = '---DOCKER_ARGS---';

// Drives one function and returns the DOCKER_ARGS it appended plus its stdout.
// TMPDIR is redirected per run so the mktemp files these functions create (the
// vault index, the gh hosts file) land somewhere disposable.
function drive(name, { env = {}, absent = [], pre = '' } = {}) {
  const tmp = scratch(os.tmpdir(), 'sbmnt-');
  const assignments = Object.entries(env)
    .map(([k, v]) => `${k}=${q(v)}`).join('\n');
  const stub = absent.length ? `command() {
  if [[ "\${1:-}" == -v ]]; then
    case "\${2:-}" in ${absent.join('|')}) return 1 ;; esac
  fi
  builtin command "$@"
}` : '';
  const script = `set -uo pipefail
export TMPDIR=${q(tmp)}
${assignments}
DOCKER_ARGS=()
${stub}
${pre}
${FN[name]}
${name}
echo ${q(ARGS_MARKER)}
printf '%s\\n' \${DOCKER_ARGS[@]+"\${DOCKER_ARGS[@]}"}
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const out = r.stdout ?? '';
  const at = out.indexOf(ARGS_MARKER);
  assert.notStrictEqual(at, -1, `harness for ${name} completed:\n${r.stderr}`);
  const args = out.slice(at + ARGS_MARKER.length).split('\n').filter(Boolean);
  return { stdout: out.slice(0, at), stderr: r.stderr ?? '', args, tmp };
}

// -v specs only, as {src, dest, mode}.
function mounts(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-v') continue;
    const parts = args[i + 1].split(':');
    out.push({ src: parts[0], dest: parts[1], mode: parts[2] ?? 'rw' });
  }
  return out;
}
const envOf = (args) => args.filter((a, i) => args[i - 1] === '-e');

// A vault with an allowlist naming `standing` and `tasks`, and a workspace that
// is NOT the vault (the eligible case).
function vaultFixture({ allowlist, sensitive, present = ['standing', 'tasks'] } = {}) {
  const root = scratch(os.tmpdir(), 'sbmnt-');
  const vault = path.join(root, 'vault');
  const sandboxDir = path.join(root, 'sandbox');
  const work = path.join(root, 'someRepo');
  for (const d of [vault, sandboxDir, work]) fs.mkdirSync(d, { recursive: true });
  for (const p of present) fs.mkdirSync(path.join(vault, p), { recursive: true });
  fs.writeFileSync(path.join(sandboxDir, 'vault-allowlist.txt'),
    allowlist ?? 'standing\ntasks\n');
  if (sensitive !== undefined) fs.writeFileSync(path.join(sandboxDir, 'vault-sensitive.txt'), sensitive);
  // The real generator, so the index mount path is exercised rather than stubbed.
  fs.copyFileSync(path.join(SANDBOX_SRC, 'executable_gen-vault-index.py'),
    path.join(sandboxDir, 'gen-vault-index.py'));
  return { root, vault, sandboxDir, work };
}

const vaultEnv = (f, over = {}) => ({
  NO_VAULT: 'false',
  CLAUDE_VAULT_DIR: f.vault,
  SANDBOX_DIR: f.sandboxDir,
  WORK_PATH: f.work,
  REPO_PATH: f.work,
  ...over,
});

// --- add_vault_mounts --------------------------------------------------------

// uv is forced absent so the DuckDB branch stays out of these runs; it shells
// out to a build that has nothing to do with which paths get mounted.
const vaultRun = (f, over) => drive('add_vault_mounts', { env: vaultEnv(f, over), absent: ['uv'] });

test('vault entries are mounted, and every one of them read-only', { skip }, () => {
  const f = vaultFixture();
  const m = mounts(vaultRun(f).args);
  const vaultMounts = m.filter((x) => x.src.startsWith(f.vault));
  assert.ok(vaultMounts.length >= 2, `expected the allowlisted entries, got ${JSON.stringify(m)}`);
  for (const x of vaultMounts) {
    assert.strictEqual(x.mode, 'ro', `${x.src} must be read-only`);
    assert.strictEqual(x.src, x.dest, 'the vault is mounted at its real host path');
  }
});

test('--no-vault mounts nothing at all', { skip }, () => {
  const f = vaultFixture();
  const r = vaultRun(f, { NO_VAULT: 'true' });
  assert.deepStrictEqual(r.args, []);
  assert.strictEqual(r.stdout.trim(), '');
});

test('a vault session does not mount the vault into itself', { skip }, () => {
  // Sandboxing the vault itself already has the whole tree at /workspace;
  // re-mounting the curated subset read-only on top would shadow it.
  const f = vaultFixture();
  const inside = path.join(f.vault, 'sub');
  fs.mkdirSync(inside, { recursive: true });
  const r = vaultRun(f, { WORK_PATH: inside });
  assert.deepStrictEqual(r.args, []);
});

test('allowlist entries that do not exist are skipped', { skip }, () => {
  const f = vaultFixture({ allowlist: 'standing\nghost\n' });
  const srcs = mounts(vaultRun(f).args).map((x) => x.src);
  assert.ok(srcs.some((s) => s.endsWith('/standing')));
  assert.ok(!srcs.some((s) => s.endsWith('/ghost')), 'a missing path must not become a mount');
});

test('allowlist comments and surrounding whitespace are stripped', { skip }, () => {
  const f = vaultFixture({ allowlist: '# a comment\n\n  standing  # trailing note\n' });
  const srcs = mounts(vaultRun(f).args).map((x) => x.src);
  assert.ok(srcs.some((s) => s.endsWith('/standing')), `got ${JSON.stringify(srcs)}`);
  assert.ok(!srcs.some((s) => s.includes('#')), 'a comment must never reach a mount spec');
});

test('CLAUDE.md and index.md are never mounted from the allowlist', { skip }, () => {
  // index.md is replaced by the generated one below, and CLAUDE.md would be
  // auto-loaded into context — the vault is meant to be consulted on demand.
  const f = vaultFixture({ allowlist: 'standing\nCLAUDE.md\nindex.md\n' });
  for (const name of ['CLAUDE.md', 'index.md']) fs.writeFileSync(path.join(f.vault, name), '#');
  const srcs = mounts(vaultRun(f).args).map((x) => x.src);
  assert.ok(!srcs.includes(path.join(f.vault, 'CLAUDE.md')));
  assert.ok(!srcs.includes(path.join(f.vault, 'index.md')));
});

test('a generated index is mounted read-only over the vault index path', { skip }, () => {
  const f = vaultFixture();
  const m = mounts(vaultRun(f).args);
  const index = m.find((x) => x.dest === path.join(f.vault, 'index.md'));
  assert.ok(index, `expected a generated index mount, got ${JSON.stringify(m)}`);
  assert.strictEqual(index.mode, 'ro');
  assert.notStrictEqual(index.src, index.dest, 'the index is generated into a temp file, not taken from the vault');
});

test('the vault dir is advertised to the container only when something mounted', { skip }, () => {
  const f = vaultFixture();
  assert.ok(envOf(vaultRun(f).args).includes(`SANDBOX_VAULT_DIR=${f.vault}`));

  const empty = vaultFixture({ allowlist: 'ghost\n', present: [] });
  const r = vaultRun(empty);
  assert.deepStrictEqual(r.args, [], 'nothing mounted means no SANDBOX_VAULT_DIR either');
});

// --- add_chezmoi_mount -------------------------------------------------------

// The cm/wc prefixes on the fixture paths below are defensive, not style.
// sandbox-escape.test.js taints by NAME across the whole file, so any local called
// `src` inherits the taint of any other `src` bound to a __dirname-derived path, and
// every write to it is then reported as writing into the repo checkout. The binding
// that caused that here (an extractFunction helper reading the launcher) is gone —
// it went dead when those functions moved out into sandbox-auth.sh — but the naming
// stays, because reintroducing a `src` above would re-create the collision silently.
function chezmoiFixture({ root: cmRoot = null, hooks = true, sandbox = true } = {}) {
  const f = vaultFixture();
  const cmSrc = path.join(f.root, 'chezmoi');
  const cmInner = cmRoot ? path.join(cmSrc, cmRoot) : cmSrc;
  fs.mkdirSync(path.join(cmInner, '.chezmoiscripts'), { recursive: true });
  if (cmRoot) fs.writeFileSync(path.join(cmSrc, '.chezmoiroot'), `${cmRoot}\n`);
  if (hooks) fs.mkdirSync(path.join(cmSrc, '.git', 'hooks'), { recursive: true });
  if (sandbox) fs.mkdirSync(path.join(cmInner, 'private_dot_claude', 'sandbox'), { recursive: true });
  // A vault session: the workspace is inside the vault.
  const work = path.join(f.vault, 'notes');
  fs.mkdirSync(work, { recursive: true });
  return { ...f, cmSrc, cmInner, work };
}

const chezmoiRun = (f, over) => drive('add_chezmoi_mount', {
  env: { NO_CHEZMOI: 'false', CLAUDE_VAULT_DIR: f.vault, CHEZMOI_SRC_DIR: f.cmSrc, REPO_PATH: f.work, ...over },
});

test('the chezmoi source is mounted read-write for a vault session', { skip }, () => {
  const f = chezmoiFixture();
  const base = mounts(chezmoiRun(f).args).find((x) => x.src === f.cmSrc);
  assert.ok(base, 'the source tree itself must be mounted');
  assert.strictEqual(base.mode, 'rw', 'editing dotfiles in-session is the point of a vault run');
});

test('host-executed paths inside the chezmoi tree are re-mounted read-only', { skip }, () => {
  // .chezmoiscripts run on the host at apply time and .git/hooks on any host git
  // command, neither with review of their contents — and the sandbox dir defines
  // the boundary the NEXT launch runs under. Writable, each is host code execution.
  const f = chezmoiFixture();
  const m = mounts(chezmoiRun(f).args);
  for (const p of [
    path.join(f.cmInner, '.chezmoiscripts'),
    path.join(f.cmSrc, '.git', 'hooks'),
    path.join(f.cmInner, 'private_dot_claude', 'sandbox'),
  ]) {
    const found = m.find((x) => x.src === p);
    assert.ok(found, `${p} must be re-mounted`);
    assert.strictEqual(found.mode, 'ro', `${p} must be read-only`);
  }
});

test('the read-only re-mounts come after the read-write mount', { skip }, () => {
  // Nested mounts: the writable tree is mounted first and the sensitive
  // subpaths layered on top. Emitted the other way round they would be
  // shadowed by the writable parent.
  const m = mounts(chezmoiRun(chezmoiFixture()).args);
  const rw = m.findIndex((x) => x.mode === 'rw');
  const firstRo = m.findIndex((x) => x.mode === 'ro');
  assert.ok(rw !== -1 && firstRo !== -1);
  assert.ok(rw < firstRo, `read-write mount must be emitted first: ${JSON.stringify(m)}`);
});

test('.chezmoiroot redirects which .chezmoiscripts gets protected', { skip }, () => {
  // This repo sets .chezmoiroot=home, so the scripts live at home/.chezmoiscripts.
  // Reading the root wrong would leave the real scripts dir writable.
  const f = chezmoiFixture({ root: 'home' });
  const srcs = mounts(chezmoiRun(f).args).map((x) => x.src);
  assert.ok(srcs.includes(path.join(f.cmSrc, 'home', '.chezmoiscripts')));
  assert.ok(!srcs.includes(path.join(f.cmSrc, '.chezmoiscripts')));
});

test('--no-chezmoi and non-vault sessions mount nothing', { skip }, () => {
  const f = chezmoiFixture();
  assert.deepStrictEqual(chezmoiRun(f, { NO_CHEZMOI: 'true' }).args, []);
  assert.deepStrictEqual(chezmoiRun(f, { REPO_PATH: path.join(f.root, 'someRepo') }).args, [],
    'a normal repo session must not get the config tree at all');
});

test('the container chezmoi is pointed at the mounted source', { skip }, () => {
  assert.ok(envOf(chezmoiRun(chezmoiFixture()).args).some((e) => e.startsWith('CHEZMOI_SOURCE_DIR=')));
});

// --- add_work_config_mount ---------------------------------------------------

function workConfigFixture({ installer = true, hooks = true } = {}) {
  const f = vaultFixture();
  const wcSrc = path.join(f.root, 'work-laptop-config');
  fs.mkdirSync(wcSrc, { recursive: true });
  if (installer) fs.writeFileSync(path.join(wcSrc, 'install.sh'), '#!/bin/bash\n');
  if (hooks) fs.mkdirSync(path.join(wcSrc, '.git', 'hooks'), { recursive: true });
  const work = path.join(f.vault, 'notes');
  fs.mkdirSync(work, { recursive: true });
  return { ...f, wcSrc, work };
}

const workRun = (f, over) => drive('add_work_config_mount', {
  env: { NO_WORK_CONFIG: 'false', CLAUDE_VAULT_DIR: f.vault, WORK_LAPTOP_CONFIG_DIR: f.wcSrc, REPO_PATH: f.work, ...over },
});

test('work-laptop-config is read-write but its host-run paths are not', { skip }, () => {
  const f = workConfigFixture();
  const m = mounts(workRun(f).args);
  assert.strictEqual(m.find((x) => x.src === f.wcSrc)?.mode, 'rw');
  assert.strictEqual(m.find((x) => x.src === path.join(f.wcSrc, 'install.sh'))?.mode, 'ro',
    'install.sh runs on the host, so a session must not be able to rewrite it');
  assert.strictEqual(m.find((x) => x.src === path.join(f.wcSrc, '.git', 'hooks'))?.mode, 'ro');
});

test('work-laptop-config skips absent install.sh and hooks without failing', { skip }, () => {
  const f = workConfigFixture({ installer: false, hooks: false });
  const m = mounts(workRun(f).args);
  assert.strictEqual(m.length, 1, 'only the base mount');
  assert.strictEqual(m[0].mode, 'rw');
});

test('--no-work-config and non-vault sessions mount nothing', { skip }, () => {
  const f = workConfigFixture();
  assert.deepStrictEqual(workRun(f, { NO_WORK_CONFIG: 'true' }).args, []);
  assert.deepStrictEqual(workRun(f, { REPO_PATH: path.join(f.root, 'someRepo') }).args, []);
});

// --- add_vault_self_hardening ------------------------------------------------

function sensitiveRun(sensitive, present, over = {}) {
  const f = vaultFixture({ sensitive });
  const work = path.join(f.vault, 'notes');
  for (const p of present) {
    fs.mkdirSync(path.dirname(path.join(work, p)), { recursive: true });
    fs.writeFileSync(path.join(work, p), 'x');
  }
  return {
    f,
    work,
    ...drive('add_vault_self_hardening', {
      env: { CLAUDE_VAULT_DIR: f.vault, SANDBOX_DIR: f.sandboxDir, WORK_PATH: work, REPO_PATH: work, ...over },
    }),
  };
}

test('sensitive vault subpaths are re-mounted read-only over the workspace', { skip }, () => {
  // A vault session mounts the whole tree writable at /workspace; these paths
  // are layered back over it read-only.
  const r = sensitiveRun('secrets.md\n', ['secrets.md']);
  const m = mounts(r.args);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].mode, 'ro');
  assert.strictEqual(m[0].dest, '/workspace/secrets.md',
    'must land at the container path, not the host path');
});

test('sensitive globs expand and each match is protected', { skip }, () => {
  const r = sensitiveRun('raw/*.md\n', ['raw/a.md', 'raw/b.md', 'raw/keep.txt']);
  const dests = mounts(r.args).map((x) => x.dest).sort();
  assert.deepStrictEqual(dests, ['/workspace/raw/a.md', '/workspace/raw/b.md']);
});

test('sensitive entries that match nothing are skipped silently', { skip }, () => {
  const r = sensitiveRun('nope/*.md\n', []);
  assert.deepStrictEqual(r.args, []);
  assert.strictEqual(r.stdout.trim(), '');
});

test('sensitive comments and whitespace are stripped', { skip }, () => {
  const r = sensitiveRun('# header\n\n  secrets.md  # note\n', ['secrets.md']);
  assert.deepStrictEqual(mounts(r.args).map((x) => x.dest), ['/workspace/secrets.md']);
});

test('hardening does not apply outside a vault session', { skip }, () => {
  const r = sensitiveRun('secrets.md\n', ['secrets.md'], { REPO_PATH: '/somewhere/else' });
  assert.deepStrictEqual(r.args, []);
});

// --- configure_gh_auth -------------------------------------------------------

// `gh` is stubbed via a directory prepended to PATH so `command -v gh` and
// `gh auth token` both resolve to the fake.
function ghRun({ envToken = null, keyringToken = null } = {}) {
  const bin = scratch(os.tmpdir(), 'sbmnt-');
  if (keyringToken !== null) {
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/bash\n[[ "$*" == "auth token" ]] && echo ${keyringToken}\nexit 0\n`);
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
  }
  const env = {};
  if (envToken !== null) env.GITHUB_TOKEN = envToken;
  return drive('configure_gh_auth', {
    env,
    absent: keyringToken === null ? ['gh'] : [],
    pre: `export PATH=${q(bin)}:$PATH\n${envToken === null ? 'unset GITHUB_TOKEN || true' : ''}`,
  });
}

test('the github token is delivered as a file, never as an environment variable', { skip }, () => {
  // A token in the container env is readable by any python/node subprocess,
  // which walks straight past the gh deny rules.
  const r = ghRun({ envToken: 'ghp_secretvalue' });
  assert.ok(!r.args.includes('-e'), `no -e entries expected, got ${JSON.stringify(r.args)}`);
  for (const a of r.args) {
    assert.ok(!a.includes('ghp_secretvalue'), `token leaked into a docker arg: ${a}`);
  }
  assert.ok(!r.stdout.includes('ghp_secretvalue'), 'token must not be printed');
});

test('the staged gh config is mounted read-only and is not world-readable', { skip }, () => {
  const r = ghRun({ envToken: 'ghp_abc' });
  const m = mounts(r.args);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].dest, '/home/claudebot/.gh-staging/hosts.yml');
  assert.strictEqual(m[0].mode, 'ro');
  const mode = fs.statSync(m[0].src).mode & 0o777;
  assert.strictEqual(mode, 0o600, `staged token file must be 0600, got ${mode.toString(8)}`);
  assert.match(fs.readFileSync(m[0].src, 'utf8'), /oauth_token: ghp_abc/);
});

test('GITHUB_TOKEN wins over the host keyring', { skip }, () => {
  const r = ghRun({ envToken: 'ghp_fromenv', keyringToken: 'ghp_fromkeyring' });
  assert.match(r.stdout, /authenticated via GITHUB_TOKEN/);
  assert.match(fs.readFileSync(mounts(r.args)[0].src, 'utf8'), /oauth_token: ghp_fromenv/);
});

test('the host keyring is used when GITHUB_TOKEN is unset', { skip }, () => {
  const r = ghRun({ keyringToken: 'ghp_fromkeyring' });
  assert.match(r.stdout, /authenticated via host-keyring/);
  assert.match(fs.readFileSync(mounts(r.args)[0].src, 'utf8'), /oauth_token: ghp_fromkeyring/);
});

test('with no auth available nothing is mounted and the user is told', { skip }, () => {
  const r = ghRun({});
  assert.deepStrictEqual(r.args, []);
  assert.match(r.stdout, /no auth found/);
});
