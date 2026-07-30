// Real-content invariants for the sandbox's read-only-mounted git identity
// (gitconfig) and the vault allowlist/sensitive-path lists it uses to decide
// what a claude-sandbox container can see. Drives the REAL `git config`
// parser against gitconfig rather than regexing it, and mirrors the exact
// comment/whitespace-trimming the launcher (executable_claude-sandbox) and
// gen-vault-index.py apply when reading the two vault-*.txt files.
// Offline. Skips cleanly if git is unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SANDBOX_DIR = path.join(__dirname, '..', 'home', 'private_dot_claude', 'sandbox');
const GITCONFIG = path.join(SANDBOX_DIR, 'gitconfig');
const ALLOWLIST = path.join(SANDBOX_DIR, 'vault-allowlist.txt');
const SENSITIVE = path.join(SANDBOX_DIR, 'vault-sensitive.txt');
const LAUNCHER = path.join(SANDBOX_DIR, 'executable_claude-sandbox');

let toolsOk = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'git unavailable';

function gitConfigGet(key) {
  try {
    return execFileSync('git', ['config', '--file', GITCONFIG, '--get', key], { encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

// --- gitconfig: the security-relevant directives it exists to provide ---

test('rewrites SSH-style GitHub URLs to HTTPS, so the gh credential helper (not an SSH key) is used', { skip }, () => {
  assert.strictEqual(gitConfigGet('url.https://github.com/.insteadOf'), 'git@github.com:');
});

test('the GitHub credential helper shells out to gh, not a stored/cached token', { skip }, () => {
  assert.strictEqual(gitConfigGet('credential.https://github.com.helper'), '!/usr/bin/gh auth git-credential');
});

test('the credential helper is scoped to github.com only — no blanket [credential] section', { skip }, () => {
  const entries = execFileSync('git', ['config', '--file', GITCONFIG, '--get-regexp', '^credential\\.'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  assert.strictEqual(entries.length, 1, 'exactly one credential.* entry');
  assert.match(entries[0], /^credential\.https:\/\/github\.com\.helper /);
});

test('safe.directory = * pre-empts the dubious-ownership check on the bind-mounted /workspace', { skip }, () => {
  assert.strictEqual(gitConfigGet('safe.directory'), '*');
});

test('commits are signed via SSH-format signatures, verified against an explicit allowed_signers file', { skip }, () => {
  assert.strictEqual(gitConfigGet('commit.gpgsign'), 'true');
  assert.strictEqual(gitConfigGet('gpg.format'), 'ssh');
  assert.strictEqual(gitConfigGet('gpg.ssh.allowedSignersFile'), '/home/claudebot/.ssh/allowed_signers');
});

test('user.signingkey holds a public key, never private key material', { skip }, () => {
  const key = gitConfigGet('user.signingkey');
  assert.match(key, /^ssh-ed25519 /, 'must be a public-key line');
  const raw = fs.readFileSync(GITCONFIG, 'utf8');
  assert.doesNotMatch(raw, /PRIVATE KEY/);
});

// --- vault-allowlist.txt / vault-sensitive.txt ---
// Mirror the exact parsing the consumers apply: executable_claude-sandbox strips
// inline comments with `${line%%#*}`, trims via `read -r`, and skips blank lines;
// gen-vault-index.py does the equivalent (`split('#', 1)[0].strip()`) and also
// drops any entry whose basename is CLAUDE.md/index.md.
function parseEntries(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.split('#')[0].trim())
    .filter(Boolean);
}

test('both vault path lists exist and contain at least one real entry', () => {
  const allow = parseEntries(ALLOWLIST);
  const sensitive = parseEntries(SENSITIVE);
  assert.ok(allow.length > 0, 'vault-allowlist.txt must have at least one entry');
  assert.ok(sensitive.length > 0, 'vault-sensitive.txt must have at least one entry');
});

test('no entry is well-formed-invalid: no blank/absolute paths, no path traversal', () => {
  for (const entry of [...parseEntries(ALLOWLIST), ...parseEntries(SENSITIVE)]) {
    assert.ok(!entry.startsWith('/'), `entry must be relative, not absolute: ${entry}`);
    assert.ok(!entry.split('/').includes('..'), `entry must not path-traverse: ${entry}`);
  }
});

test('no entry lists CLAUDE.md or index.md directly (gen-vault-index.py would silently skip it)', () => {
  for (const entry of [...parseEntries(ALLOWLIST), ...parseEntries(SENSITIVE)]) {
    const base = path.basename(entry);
    assert.notStrictEqual(base, 'CLAUDE.md', `must not list CLAUDE.md: ${entry}`);
    assert.notStrictEqual(base, 'index.md', `must not list index.md: ${entry}`);
  }
});

test('vault-allowlist.txt and vault-sensitive.txt never list the same entry', () => {
  const allow = new Set(parseEntries(ALLOWLIST));
  const sensitive = parseEntries(SENSITIVE);
  const overlap = sensitive.filter((e) => allow.has(e));
  assert.deepStrictEqual(overlap, [],
    'an entry in both would be mounted read-only into OTHER sandboxes (allowlist) while also being ' +
    'the exact material vault-sensitive.txt exists to keep out of them — a contradiction');
});

// --- container hardening: the DOCKER_ARGS docker run invocation (the
// interactive sandbox container) and the docker socket proxy's docker run
// invocation, extracted verbatim from executable_claude-sandbox by marker.
function extractBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start !== -1, `start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end !== -1, `end marker not found: ${endMarker}`);
  return source.slice(start, end + endMarker.length);
}

const LAUNCHER_SRC = fs.readFileSync(LAUNCHER, 'utf8');
const DOCKER_ARGS_BLOCK = extractBlock(LAUNCHER_SRC, 'DOCKER_ARGS=(', '\n)\n');
const PROXY_RUN_BLOCK = extractBlock(LAUNCHER_SRC, 'docker run -d --rm', '>/dev/null\n');

test('the sandbox container drops all Linux capabilities and blocks privilege escalation', () => {
  assert.ok(DOCKER_ARGS_BLOCK.includes('\n  --cap-drop all\n'), '--cap-drop all must be set on the sandbox container');
  assert.ok(DOCKER_ARGS_BLOCK.includes('\n  --security-opt no-new-privileges\n'), '--security-opt no-new-privileges must be set on the sandbox container');
});

test('the sandbox container caps its process count via pids-limit, bounding a fork bomb', () => {
  assert.match(DOCKER_ARGS_BLOCK, /\n {2}--pids-limit \d+\n/);
});

test('the docker socket proxy container drops all Linux capabilities', () => {
  assert.ok(PROXY_RUN_BLOCK.includes('    --cap-drop all \\\n'), '--cap-drop all must be set on the socket proxy container');
});

test('the docker socket proxy denies exec and other high-risk Docker API endpoints by default', () => {
  for (const denied of ['EXEC', 'AUTH', 'SECRETS', 'SWARM', 'BUILD', 'COMMIT', 'CONFIGS', 'DISTRIBUTION', 'NODES', 'PLUGINS', 'SYSTEM', 'SERVICES', 'TASKS']) {
    assert.ok(PROXY_RUN_BLOCK.includes(`-e ${denied}=0 `), `${denied} must be denied (=0) on the socket proxy`);
  }
});

// --- the container's own permission policy and guard hooks must not be writable
// from inside it. settings.base.json sets defaultMode:bypassPermissions and the
// image launches --dangerously-skip-permissions, so the deny-list plus the hooks
// ARE the whole boundary — and ~/.claude is the read-write $STATE_DIR bind mount.
// These guard the fix: mount them :ro at their LIVE paths instead of staging them
// in ~/.claude-defaults for entrypoint.sh to copy into the writable volume.
const ENTRYPOINT_SRC = fs.readFileSync(path.join(SANDBOX_DIR, 'executable_entrypoint.sh'), 'utf8');

// Every `-v "host:container[:mode]"` in the launcher, as [containerPath, mode].
function containerMounts(src) {
  return [...src.matchAll(/-v "([^"]+)"/g)].map((m) => {
    const parts = m[1].split(':');
    const mode = parts.length > 2 ? parts[parts.length - 1] : '';
    const target = mode ? parts[parts.length - 2] : parts[parts.length - 1];
    return [target, mode];
  });
}
const MOUNTS = containerMounts(LAUNCHER_SRC);

test('settings.json is mounted read-only at its live path, not copied into the writable state volume', () => {
  const live = MOUNTS.filter(([t]) => t === '/home/claudebot/.claude/settings.json');
  assert.ok(live.length > 0, 'settings.json must be mounted at /home/claudebot/.claude/settings.json');
  for (const [, mode] of live) {
    assert.strictEqual(mode, 'ro', 'the live settings.json mount must be :ro — it is the container permission policy');
  }
});

test('every hook is mounted read-only at its live ~/.claude/hooks path', () => {
  const hooks = MOUNTS.filter(([t]) => t.startsWith('/home/claudebot/.claude/hooks/'));
  assert.ok(hooks.length >= 8, `expected the full hook set mounted live, found ${hooks.length}`);
  for (const [target, mode] of hooks) {
    assert.strictEqual(mode, 'ro', `${target} must be mounted :ro — a writable guard hook is no guard`);
  }
});

test('the statusline script is mounted read-only at its live path (it is executed, so it is code)', () => {
  const sl = MOUNTS.filter(([t]) => t === '/home/claudebot/.claude/statusline-command.sh');
  assert.ok(sl.length > 0, 'statusline-command.sh must be mounted at its live path');
  for (const [, mode] of sl) assert.strictEqual(mode, 'ro');
});

test('~/.claude-defaults stages only non-policy, non-executable files', () => {
  // Anything staged there is copied into the agent-writable ~/.claude by
  // entrypoint.sh, so the staging area must not carry settings or hook code.
  const allowed = new Set(['CLAUDE.md', 'keybindings.json']);
  for (const [target] of MOUNTS) {
    if (!target.includes('/.claude-defaults/')) continue;
    const base = target.split('/').pop();
    assert.ok(allowed.has(base),
      `${target} is staged for copy into the writable ~/.claude — mount it :ro at its live path instead`);
  }
});

test('entrypoint.sh does not copy settings or hooks into the writable state volume', () => {
  assert.ok(!/cp -f "\$DEFAULTS_DIR\/settings\.json"/.test(ENTRYPOINT_SRC),
    'copying settings.json into ~/.claude would let the agent rewrite its own permission policy');
  assert.ok(!/DEFAULTS_DIR"\/hooks\/\*\.sh/.test(ENTRYPOINT_SRC),
    'copying hooks into ~/.claude would let the agent stub out every guard hook');
  assert.ok(!/cp -f "\$DEFAULTS_DIR\/statusline-command\.sh"/.test(ENTRYPOINT_SRC),
    'statusline-command.sh is executed, so a writable copy is a code-execution path');
});

test('entrypoint.sh clears settings.local.json, which nothing manages and every instance shares', () => {
  assert.match(ENTRYPOINT_SRC, /rm -f "\$CLAUDE_DIR\/settings\.local\.json"/);
});

// --- host code-execution paths reachable through the read-write mounts ---

test('the worktree gitdir mount re-mounts hooks/ and config read-only', () => {
  // The whole .git is RW so in-container commits resolve, but hooks/ and config
  // (core.fsmonitor, aliases, core.hooksPath) are executed by the HOST's git.
  assert.ok(LAUNCHER_SRC.includes('-v "$REPO_PATH/.git/hooks:$REPO_PATH/.git/hooks:ro"'),
    'a writable .git/hooks in the mounted repo is host code execution on the next host git command');
  assert.ok(LAUNCHER_SRC.includes('-v "$REPO_PATH/.git/config:$REPO_PATH/.git/config:ro"'),
    'a writable .git/config lets core.fsmonitor or an alias run on the host');
});

test('the read-write chezmoi source mount re-mounts .chezmoiscripts and .git/hooks read-only', () => {
  // `chezmoi apply` on the host executes .chezmoiscripts/run_* as the user, and
  // .git/hooks runs on any host git command — neither is covered by diff review.
  assert.match(LAUNCHER_SRC, /-v "\$_cm_root\/\.chezmoiscripts:\$_cm_root\/\.chezmoiscripts:ro"/);
  assert.ok(LAUNCHER_SRC.includes('-v "$CHEZMOI_SRC/.git/hooks:$CHEZMOI_SRC/.git/hooks:ro"'));
});

test('the read-write chezmoi source mount re-mounts the sandbox definition read-only', () => {
  // The sandbox's own boundary lives in the source tree: settings.base.json (which
  // resolve-sandbox-settings.sh takes as its base, hooks block and all — only host
  // DENIES are unioned on top, nothing is sanitised), the container hook set, the
  // entrypoint and the Dockerfiles. Writable, a session could rewrite what the NEXT
  // launch runs under — the same escape the live :ro hook mounts closed inside the
  // container, reached one level back through the source instead.
  assert.match(
    LAUNCHER_SRC,
    /-v "\$_cm_root\/private_dot_claude\/sandbox:\$_cm_root\/private_dot_claude\/sandbox:ro"/
  );
});

test('the read-write work-laptop-config mount re-mounts install.sh and .git/hooks read-only', () => {
  assert.ok(LAUNCHER_SRC.includes('-v "$WORK_CONFIG_SRC/install.sh:$WORK_CONFIG_SRC/install.sh:ro"'));
  assert.ok(LAUNCHER_SRC.includes('-v "$WORK_CONFIG_SRC/.git/hooks:$WORK_CONFIG_SRC/.git/hooks:ro"'));
});

test('the conditional mounts use if/then, not && — set -e would abort the launcher', () => {
  // `[[ -d x ]] && DOCKER_ARGS+=(…)` at statement level exits under set -euo pipefail
  // whenever the path is absent, which is the ordinary case for a fresh repo.
  assert.match(LAUNCHER_SRC, /^set -euo pipefail$/m, 'this guard only matters while set -e is on');
  for (const m of LAUNCHER_SRC.matchAll(/^[ \t]*\[\[[^\n]*\]\] && DOCKER_ARGS\+=/gm)) {
    assert.fail(`use if/then instead of && for a conditional mount: ${m[0].trim()}`);
  }
});

test('the resolved settings temp file is removed on exit, not leaked once per launch', () => {
  const cleanup = extractBlock(LAUNCHER_SRC, 'cleanup() {', '\n}\n');
  assert.match(cleanup, /sandbox-settings-\*\.json/,
    'cleanup() must remove the resolved settings file (it is the mount source, so it outlives the container)');
});
