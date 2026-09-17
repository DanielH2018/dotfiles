// Regression guard for executable_protect-secrets.sh (PreToolUse/Read|Edit|Write).
// Feeds file paths through the ACTUAL hook and asserts sensitive paths are denied
// while ordinary source files pass. Offline. Skips cleanly if bash/jq are unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_protect-secrets.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

function runHook(file_path) {
  try {
    return execFileSync('bash', [HOOK], {
      input: JSON.stringify({ tool_input: { file_path } }),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) { return e.stdout || ''; }
}
function decision(stdout) {
  if (!stdout.trim()) return null;
  try { return JSON.parse(stdout).hookSpecificOutput.permissionDecision; } catch { return null; }
}

const DENY = [
  '.env',
  '/home/u/project/.env',
  '.env.local',
  '/home/u/.ssh/id_rsa',
  '/home/u/.ssh/config',
  '/home/u/.aws/credentials',
  '/home/u/.netrc',
  '/home/u/.npmrc',
  '/home/u/.gnupg/secring.gpg',
  '/opt/app/server.pem',
  '/opt/app/tls.key',
  '/opt/app/cert.p12',
  '/srv/secrets/token.txt',
];

// Paths block-dangerous-bash.sh has always denied to Bash, which this gate did not
// cover: `cat ~/.claude.json` was blocked while Read(~/.claude.json) returned the
// OAuth token. Of the set only ~/.config/gh/** had a settings deny behind it.
const DENY_TOKEN_STORES = [
  '/home/u/.claude.json',
  '/home/u/.git-credentials',
  '/home/u/.kube/config',
  '/home/u/.docker/config.json',
  '/home/u/.config/gh/hosts.yml',
  '/etc/shadow',
  '/etc/gshadow',
  '/proc/1/environ',
  '/proc/self/environ',
];

const ALLOW = [
  '/home/u/project/src/main.go',
  '/home/u/project/README.md',
  '/home/u/project/config.yaml',
  '/home/u/project/package.json',
  // Neighbours of the newly-denied paths that must stay readable. ~/.claude/settings.json
  // is a different file from ~/.claude.json, and the config work in this repo reads it
  // constantly; a pattern sloppy enough to catch both would be unusable.
  '/home/u/.claude/settings.json',
  '/home/u/.claude/hooks/notify.sh',
  '/home/u/.kube/README.md',
  '/home/u/project/claude.json',
];

test('sensitive file paths are denied', { skip }, () => {
  for (const p of DENY) assert.strictEqual(decision(runHook(p)), 'deny', `should deny: ${p}`);
});

test('ordinary source files are allowed', { skip }, () => {
  for (const p of ALLOW) assert.notStrictEqual(decision(runHook(p)), 'deny', `should not deny: ${p}`);
});

// Only the .env arm carried a bare form. `.aws/credentials` from a cwd of $HOME is the
// same file as /home/u/.aws/credentials, but a relative path has no separator for the
// */-prefixed patterns to match.
test('a relative path to a secret is denied, not just an absolute one', { skip }, () => {
  for (const p of ['.aws/credentials', '.aws/config', '.netrc', '.npmrc', '.pypirc',
    '.gnupg/secring.gpg', 'secrets/token.txt', '.claude.json', '.git-credentials']) {
    assert.strictEqual(decision(runHook(p)), 'deny', `should deny relative path: ${p}`);
  }
});

test('token stores denied to Bash are denied to Read/Edit/Write too', { skip }, () => {
  for (const p of DENY_TOKEN_STORES) {
    assert.strictEqual(decision(runHook(p)), 'deny', `should deny: ${p}`);
  }
});

// The two gates guard the same secrets and drifted apart once already. This is the
// check that says so: every path in claude_guard.deny's SECRET_PATHS must be denied
// here too, derived from that file rather than hand-copied, so adding one there and
// forgetting this hook fails instead of passing quietly. claude-guard's slice 4 cutover
// unregistered block-dangerous-bash.sh from the host (deny.py:482 has the ported
// SECRET_PATHS); deny.py is the host's oracle now.
test('every SECRET_PATHS entry in the deny gate is covered by this one', { skip }, () => {
  const denyPy = fs.readFileSync(
    path.join(
      __dirname, '..', '..', 'home', 'dot_local', 'share', 'claude-guard', 'claude_guard', 'deny.py',
    ),
    'utf8',
  );
  const block = /^SECRET_PATHS = \(\n([\s\S]*?)^\)$/m.exec(denyPy);
  assert.ok(block, 'located SECRET_PATHS in deny.py');
  const joined = [...block[1].matchAll(/r"([^"]*)"/g)].map((x) => x[1]).join('');
  assert.ok(joined.startsWith('(') && joined.endsWith(')'), 'SECRET_PATHS is not a single (...) group');
  // Strip the outer (...) group, the same content the old bash-string extraction captured.
  const inner = joined.slice(1, -1);

  // Turn each alternation branch into a concrete path this hook can be asked about.
  const SAMPLE = {
    '\\.env': '/home/u/.env',
    '\\.ssh/': '/home/u/.ssh/id_rsa',
    'id_rsa': '/home/u/id_rsa',
    'id_ed25519': '/home/u/id_ed25519',
    'id_ecdsa': '/home/u/id_ecdsa',
    '\\.aws/credentials': '/home/u/.aws/credentials',
    '\\.aws/config': '/home/u/.aws/config',
    '\\.gnupg/': '/home/u/.gnupg/secring.gpg',
    '\\.netrc': '/home/u/.netrc',
    '\\.pypirc': '/home/u/.pypirc',
    '\\.npmrc': '/home/u/.npmrc',
    '/secrets/': '/srv/secrets/token.txt',
    '\\.git-credentials': '/home/u/.git-credentials',
    '\\.kube/config': '/home/u/.kube/config',
    '\\.docker/config\\.json': '/home/u/.docker/config.json',
    '\\.config/gh/hosts\\.yml': '/home/u/.config/gh/hosts.yml',
    '\\.claude/\\.credentials\\.json': '/home/u/.claude/.credentials.json',
    '\\.claude\\.json': '/home/u/.claude.json',
    '/etc/shadow': '/etc/shadow',
    '/etc/gshadow': '/etc/gshadow',
    '/proc/[^/[:space:]]+/environ': '/proc/1/environ',
    '\\.pem': '/opt/app/server.pem',
    '\\.key': '/opt/app/tls.key',
    '\\.p12': '/opt/app/cert.p12',
    '\\.pfx': '/opt/app/cert.pfx',
  };

  // The file-extension branches are grouped as `\.(pem|key|p12|pfx)\b` rather than
  // listed bare, because the bare form matched any substring -- `.keys()` in a
  // python3 -c read as a private key and was denied. A naive split on `|` shreds
  // that group into `\.(pem`, `key`, ... and matches nothing, so split at paren
  // depth 0 and expand such a group back into one branch per extension. Each
  // extension therefore still gets its own sample path and its own assertion.
  // Since 2026-08-27 that branch also carries a leading `(^|[A-Za-z0-9_~/-])` anchor,
  // which keeps a jq filter's `\(.key)` from reading as a filename; strip it here so the
  // sample map stays keyed on the extension rather than on the anchor's spelling.
  const splitTopLevel = (body) => {
    const out = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === '\\') { cur += c + (body[i + 1] ?? ''); i++; continue; }
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  };
  const expand = (branch) => {
    const group = /^(?:\([^)]*\))?\\\.\(([^)]+)\)\\b$/.exec(branch);
    return group ? group[1].split('|').map((ext) => `\\.${ext}`) : [branch];
  };

  const branches = splitTopLevel(inner).flatMap(expand);
  const unmapped = branches.filter((b) => !(b in SAMPLE));
  assert.deepStrictEqual(unmapped, [],
    `SECRET_PATHS gained ${unmapped.join(', ')} — add a sample path here and an arm in protect-secrets.sh`);

  for (const branch of branches) {
    const sample = SAMPLE[branch];
    assert.strictEqual(decision(runHook(sample)), 'deny',
      `block-dangerous-bash.sh denies ${branch} to Bash, but Read/Edit/Write allows ${sample}`);
  }
});

// Every decision here is routed through jq, so a PATH without jq used to make the hook
// exit 0 with empty stdout — the secret-file layer gone, and nothing saying so. Run the
// hook with an empty PATH (the preflight needs only shell builtins) and require a
// decision. spawnSync, not execFileSync: the hook exits before reading stdin, and the
// resulting EPIPE would surface as a throw.
const noJqSkip = skip || (fs.existsSync('/bin/bash') ? false : '/bin/bash unavailable');
function runHookWithoutJq(file_path) {
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nojq-'));
  try {
    return spawnSync('/bin/bash', [HOOK], {
      input: JSON.stringify({ tool_input: { file_path } }),
      encoding: 'utf8',
      env: { PATH: emptyPath, HOME: os.homedir() },
    }).stdout || '';
  } finally {
    fs.rmSync(emptyPath, { recursive: true, force: true });
  }
}

test('asks rather than failing open when jq is unavailable', { skip: noJqSkip }, () => {
  assert.strictEqual(decision(runHookWithoutJq('/home/u/.ssh/id_rsa')), 'ask');
  // The path cannot be parsed without jq, so the fallback is unconditional — an
  // ordinary file gets the same prompt. That is the point: visible, not silent.
  assert.strictEqual(decision(runHookWithoutJq('/home/u/project/README.md')), 'ask');
});
