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

test('both vault path lists exist and contain at least one real entry', { skip: false }, () => {
  const allow = parseEntries(ALLOWLIST);
  const sensitive = parseEntries(SENSITIVE);
  assert.ok(allow.length > 0, 'vault-allowlist.txt must have at least one entry');
  assert.ok(sensitive.length > 0, 'vault-sensitive.txt must have at least one entry');
});

test('no entry is well-formed-invalid: no blank/absolute paths, no path traversal', { skip: false }, () => {
  for (const entry of [...parseEntries(ALLOWLIST), ...parseEntries(SENSITIVE)]) {
    assert.ok(!entry.startsWith('/'), `entry must be relative, not absolute: ${entry}`);
    assert.ok(!entry.split('/').includes('..'), `entry must not path-traverse: ${entry}`);
  }
});

test('no entry lists CLAUDE.md or index.md directly (gen-vault-index.py would silently skip it)', { skip: false }, () => {
  for (const entry of [...parseEntries(ALLOWLIST), ...parseEntries(SENSITIVE)]) {
    const base = path.basename(entry);
    assert.notStrictEqual(base, 'CLAUDE.md', `must not list CLAUDE.md: ${entry}`);
    assert.notStrictEqual(base, 'index.md', `must not list index.md: ${entry}`);
  }
});

test('vault-allowlist.txt and vault-sensitive.txt never list the same entry', { skip: false }, () => {
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

test('the sandbox container drops all Linux capabilities and blocks privilege escalation', { skip: false }, () => {
  assert.ok(DOCKER_ARGS_BLOCK.includes('\n  --cap-drop all\n'), '--cap-drop all must be set on the sandbox container');
  assert.ok(DOCKER_ARGS_BLOCK.includes('\n  --security-opt no-new-privileges\n'), '--security-opt no-new-privileges must be set on the sandbox container');
});

test('the sandbox container caps its process count via pids-limit, bounding a fork bomb', { skip: false }, () => {
  assert.match(DOCKER_ARGS_BLOCK, /\n {2}--pids-limit \d+\n/);
});

test('the docker socket proxy container drops all Linux capabilities', { skip: false }, () => {
  assert.ok(PROXY_RUN_BLOCK.includes('    --cap-drop all \\\n'), '--cap-drop all must be set on the socket proxy container');
});

test('the docker socket proxy denies exec and other high-risk Docker API endpoints by default', { skip: false }, () => {
  for (const denied of ['EXEC', 'AUTH', 'SECRETS', 'SWARM', 'BUILD', 'COMMIT', 'CONFIGS', 'DISTRIBUTION', 'NODES', 'PLUGINS', 'SYSTEM', 'SERVICES', 'TASKS']) {
    assert.ok(PROXY_RUN_BLOCK.includes(`-e ${denied}=0 `), `${denied} must be denied (=0) on the socket proxy`);
  }
});
