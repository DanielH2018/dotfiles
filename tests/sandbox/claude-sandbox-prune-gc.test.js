// Regression guards for claude-sandbox's two interactive delete paths,
// prune_worktrees() and gc_worktrees(), which had no test coverage at all.
//
// Both end in a loop calling delete_worktree(), which is itself guarded — the
// risk is in the selection logic ABOVE that call. prune_worktrees maps a
// comma-separated list of 1-based display numbers back onto a 0-based array;
// an off-by-one there deletes a worktree the user did not pick, and the y/n
// prompt cannot catch it because the user has already confirmed. gc_worktrees
// picks its own victims from `[gone]` upstream tracking, so a loose match there
// deletes live work.
//
// Same technique as claude-sandbox-launcher.test.js: extract the REAL function
// body at test runtime (awk brace-depth counter) and drive it in a bash harness
// with the git/gh/fzf boundary stubbed, rather than re-implementing its logic.
// Offline. Skips cleanly if bash/awk are unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');
const { run } = require('../lib/run');

const SANDBOX_DIR = srcPath('private_dot_claude', 'sandbox');
const SANDBOX = path.join(SANDBOX_DIR, 'executable_claude-sandbox');
// The launcher plus every lib it sources — prune_worktrees and gc_worktrees live in
// sandbox-worktree-ops.sh now. Globbed rather than named, as the other harnesses do.
const SOURCES = [SANDBOX, ...fs.readdirSync(SANDBOX_DIR)
  .filter((f) => /^executable_sandbox-.*\.sh$/.test(f))
  .sort()
  .map((f) => path.join(SANDBOX_DIR, f))];

const skip = skipUnless('bash', 'awk');

function extractFunction(name) {
  const src = execFileSync('awk', [
    `/^${name}\\(\\) \\{/ { started=1 }\n` +
    'started {\n' +
    '  print\n' +
    '  depth += gsub(/{/,"{") - gsub(/}/,"}")\n' +
    '  if (started && depth==0) exit\n' +
    '}',
    ...SOURCES,
  ], { encoding: 'utf8' });
  assert.ok(new RegExp(`^${name}\\(\\) \\{`).test(src), `extracted the ${name} definition`);
  assert.strictEqual(src.trimEnd().split('\n').pop(), '}', `extracted ${name} body ends at its matching closing brace`);
  return src;
}

const PRUNE_SRC = skip ? '' : extractFunction('prune_worktrees');
const GC_SRC = skip ? '' : extractFunction('gc_worktrees');

// Force the non-fzf numeric picker (and, for gc, the gh-absent branch) no
// matter what is installed on the machine running the tests.
function absentTools(...names) {
  return `command() {
  if [[ "\${1:-}" == -v ]]; then
    case "\${2:-}" in ${names.join('|')}) return 1 ;; esac
  fi
  builtin command "$@"
}`;
}

// Runs a harness script; returns { code, stdout }. Both functions call `exit`,
// which is the terminal state we want to observe, so a non-zero code is data,
// not an error.
const runScript = (script, stdin = '') => run('bash', ['-c', script], { input: stdin });

// --- prune_worktrees ---------------------------------------------------------

// Three tool worktrees plus one orphaned session, in display order:
//   1) alpha  2) beta  3) gamma  4) orphan
const PRUNE_HARNESS = (opts = {}) => `
set -uo pipefail
REPO_PATH=/repo
REPO_NAME=demo
REPO_HASH=abc123
SESSIONS_BASE=/sessions
SANDBOX_DIR=/sandbox

${absentTools('fzf')}

list_tool_worktrees() { ${opts.noWorktrees ? 'return 0' : `printf 'alpha\\tclaude/alpha\\t/repo/../demo-wt-alpha\\n'
  printf 'beta\\tclaude/beta\\t/repo/../demo-wt-beta\\n'
  printf 'gamma\\tclaude/gamma\\t/repo/../demo-wt-gamma\\n'`}; }
list_orphan_sessions() { ${opts.noWorktrees || opts.noOrphans ? 'return 0' : "printf 'orphan\\n'"}; }
resolve_worktree_branch() { printf 'claude/%s\\n' "$1"; }
delete_worktree() { echo "DELETED name=$1 instance=$2"; }

# git is only consulted for the status column; keep it deterministic.
git() {
  case "$*" in
    *"status --porcelain"*) ${opts.dirty ? 'echo " M file.txt"' : ':'} ;;
    *"rev-list --count"*)   echo "${opts.unpushed || 0}" ;;
    *"log -1"*)             echo "2026-07-30" ;;
    *)                      : ;;
  esac
}

${PRUNE_SRC}
prune_worktrees
`;

test('prune maps the selected display numbers onto the right worktrees', { skip }, () => {
  // "1,3" must delete alpha and gamma — NOT beta and the orphan, which is what
  // an off-by-one in the 1-based -> 0-based conversion would produce.
  const r = runScript(PRUNE_HARNESS(), '1,3\ny\n');
  const deleted = [...r.stdout.matchAll(/DELETED name=(\S+)/g)].map((m) => m[1]);
  assert.deepStrictEqual(deleted, ['alpha', 'gamma']);
});

test('prune passes delete_worktree the fully-qualified instance id', { skip }, () => {
  const r = runScript(PRUNE_HARNESS(), '2\ny\n');
  assert.match(r.stdout, /DELETED name=beta instance=demo-abc123-beta/,
    'instance must be <repo>-<hash>-<worktree>, the key the session/audit dirs are stored under');
});

test('prune selects an orphaned session by its display number too', { skip }, () => {
  const r = runScript(PRUNE_HARNESS(), '4\ny\n');
  const deleted = [...r.stdout.matchAll(/DELETED name=(\S+)/g)].map((m) => m[1]);
  assert.deepStrictEqual(deleted, ['orphan'],
    'orphan sessions are appended after tool worktrees and share one index space');
});

test('prune tolerates spaces in the selection list', { skip }, () => {
  const r = runScript(PRUNE_HARNESS(), '1, 3\ny\n');
  const deleted = [...r.stdout.matchAll(/DELETED name=(\S+)/g)].map((m) => m[1]);
  assert.deepStrictEqual(deleted, ['alpha', 'gamma']);
});

test('prune drops out-of-range and non-numeric selections', { skip }, () => {
  for (const selection of ['0', '5', '99', 'abc', '-1']) {
    const r = runScript(PRUNE_HARNESS(), `${selection}\ny\n`);
    assert.doesNotMatch(r.stdout, /DELETED/, `selection ${JSON.stringify(selection)} deleted something`);
    assert.match(r.stdout, /No valid worktrees selected/);
  }
});

test('prune keeps the valid half of a partly-invalid selection', { skip }, () => {
  const r = runScript(PRUNE_HARNESS(), '2,99\ny\n');
  const deleted = [...r.stdout.matchAll(/DELETED name=(\S+)/g)].map((m) => m[1]);
  assert.deepStrictEqual(deleted, ['beta'], 'the in-range index is still honoured');
});

test('prune deletes nothing when the confirmation is not y', { skip }, () => {
  for (const answer of ['n', 'N', '', 'yes please', 'yy']) {
    const r = runScript(PRUNE_HARNESS(), `1,2,3\n${answer}\n`);
    assert.doesNotMatch(r.stdout, /DELETED/, `answer ${JSON.stringify(answer)} proceeded with the delete`);
    assert.match(r.stdout, /Cancelled/);
  }
});

test('prune accepts y and Y as confirmation', { skip }, () => {
  // `read -r` strips surrounding IFS whitespace, so "Y " is a plain Y here.
  for (const answer of ['y', 'Y', 'Y ']) {
    const r = runScript(PRUNE_HARNESS(), `1\n${answer}\n`);
    assert.match(r.stdout, /DELETED name=alpha/, `answer ${JSON.stringify(answer)} should confirm`);
  }
});

test('prune exits without prompting when the selection is empty', { skip }, () => {
  const r = runScript(PRUNE_HARNESS(), '\ny\n');
  assert.match(r.stdout, /No selection/);
  assert.doesNotMatch(r.stdout, /DELETED/);
  assert.doesNotMatch(r.stdout, /Proceed\?/, 'must not reach the confirm prompt with nothing selected');
});

test('prune exits early when the repo has no worktrees at all', { skip }, () => {
  const r = runScript(PRUNE_HARNESS({ noWorktrees: true }), '1\ny\n');
  assert.match(r.stdout, /No worktrees found for demo/);
  assert.doesNotMatch(r.stdout, /DELETED/);
});

test('prune surfaces uncommitted changes and unpushed commits in the listing', { skip }, () => {
  // The status column is the only signal the user has before confirming; if it
  // silently read "clean" for dirty worktrees the confirm prompt would be a lie.
  assert.match(runScript(PRUNE_HARNESS({ dirty: true }), '\n').stdout, /has changes/);
  assert.match(runScript(PRUNE_HARNESS({ unpushed: 3 }), '\n').stdout, /has unpushed commits/);
  assert.match(runScript(PRUNE_HARNESS(), '\n').stdout, /clean/);
});

// --- gc_worktrees ------------------------------------------------------------

// alpha's upstream is gone; beta's is alive. Only alpha may be collected.
const GC_HARNESS = (opts = {}) => `
set -uo pipefail
REPO_PATH=/repo
REPO_NAME=demo
REPO_HASH=abc123
STATE_DIR="__STATE_DIR__"

${absentTools('gh')}

list_tool_worktrees() { ${opts.noneGone
    ? "printf 'beta\\tclaude/beta\\t/repo/../demo-wt-beta\\n'"
    : `printf 'alpha\\tclaude/alpha\\t/repo/../demo-wt-alpha\\n'
  printf 'beta\\tclaude/beta\\t/repo/../demo-wt-beta\\n'`}; }
delete_worktree() { echo "DELETED name=$1 instance=$2"; }

git() {
  case "$*" in
    *"for-each-ref"*"refs/heads/claude/alpha"*) echo "[gone]" ;;
    *"for-each-ref"*"refs/heads/claude/beta"*)  echo "${opts.betaTrack || '[ahead 1]'}" ;;
    *"for-each-ref"*)                           : ;;
    *)                                          : ;;
  esac
}

${GC_SRC}
gc_worktrees
`;

// gc_worktrees writes a .last-gc stamp into STATE_DIR and ends in `exit`, which
// tears down the harness shell — so every gc test runs against a throwaway
// STATE_DIR and inspects the stamp from here, after bash is gone. Routing all
// of them through this helper also keeps the suite from writing a state/ dir
// into the repo, which is what a $PWD-relative default did.
function runGc(opts, stdin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-gc-'));
  const stateDir = path.join(dir, opts.stateSubdir || 'state');
  const script = GC_HARNESS(opts).replace('__STATE_DIR__', stateDir);
  assert.ok(!script.includes('__STATE_DIR__'), 'STATE_DIR placeholder must be substituted');
  const r = runScript(script, stdin);
  const stamp = path.join(stateDir, '.last-gc');
  const stamped = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...r, stamped };
}

const deletedIn = (stdout) => [...stdout.matchAll(/DELETED name=(\S+)/g)].map((m) => m[1]);

test('gc collects only worktrees whose upstream is gone', { skip }, () => {
  assert.deepStrictEqual(deletedIn(runGc({}, 'y\n').stdout), ['alpha'],
    'beta still has an upstream and must survive');
});

test('gc requires an exact [gone] match, not a substring', { skip }, () => {
  // A tracking string that merely contains the word would be a false positive.
  assert.deepStrictEqual(deletedIn(runGc({ betaTrack: 'gone' }, 'y\n').stdout), ['alpha']);
});

test('gc passes delete_worktree the fully-qualified instance id', { skip }, () => {
  assert.match(runGc({}, 'y\n').stdout, /DELETED name=alpha instance=demo-abc123-alpha/);
});

test('gc deletes nothing when the confirmation is not y', { skip }, () => {
  for (const answer of ['n', 'N', '', 'later']) {
    const r = runGc({}, `${answer}\n`);
    assert.doesNotMatch(r.stdout, /DELETED/, `answer ${JSON.stringify(answer)} proceeded`);
    assert.match(r.stdout, /Cancelled/);
  }
});

test('gc stamps .last-gc after a successful run', { skip }, () => {
  const r = runGc({}, 'y\n');
  assert.match(r.stdout, /DELETED name=alpha/);
  assert.match(r.stamped ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m,
    'stamp must hold a UTC timestamp the nudge can compare against');
});

test('gc creates STATE_DIR on a fresh install before stamping', { skip }, () => {
  // Regression guard: --gc is reachable before any container launch has created
  // STATE_DIR. Without the mkdir -p, the stamp redirect failed under set -e,
  // so gc deleted the worktrees and then died before writing .last-gc, leaving
  // the startup nudge firing forever.
  const r = runGc({ stateSubdir: path.join('state', 'nested') }, 'y\n');
  assert.strictEqual(r.code, 0, 'must exit cleanly even though STATE_DIR did not exist');
  assert.ok(r.stamped, 'stamp must be written into the directory gc created');
});

test('gc stamps .last-gc when it finds nothing to collect', { skip }, () => {
  const r = runGc({ noneGone: true }, 'y\n');
  assert.match(r.stdout, /No worktrees with deleted remote branches found/);
  assert.ok(r.stamped, 'a clean sweep must still record that gc ran, or the nudge never quiets');
});

test('gc does not stamp .last-gc when the user cancels', { skip }, () => {
  // Cancelling leaves the worktrees in place, so the nudge should keep firing.
  const r = runGc({}, 'n\n');
  assert.match(r.stdout, /Cancelled/);
  assert.strictEqual(r.stamped, null);
});

// --- delete_worktree retention ----------------------------------------------

// The two sweeps above share delete_worktree, but they must not treat the saved
// conversation the same way. --prune is a picker where the user names each
// worktree, so deleting its data is what was asked for. --gc selects on "the
// remote branch is gone", which is what a MERGED PR looks like, and the startup
// nudge invites the user into it — so it removes the worktree and branch and
// leaves the transcript. Asserted against the filesystem rather than against a
// stubbed call, because the argument only matters for what survives on disk.
const DELETE_SRC = skip ? '' : extractFunction('delete_worktree');

function runDelete(keep) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-del-'));
  const sessions = path.join(dir, 'sessions', 'demo-abc123-alpha');
  fs.mkdirSync(path.join(sessions, '-workspace'), { recursive: true });
  fs.writeFileSync(path.join(sessions, '-workspace', 'c0ffee.jsonl'), '{}\n');
  fs.mkdirSync(path.join(dir, 'audit', 'demo-abc123-alpha'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'artifacts', 'demo-abc123-alpha'), { recursive: true });

  const r = runScript(`
set -uo pipefail
REPO_PATH=${dir}/repo
REPO_NAME=demo
SESSIONS_BASE=${dir}/sessions
AUDIT_BASE=${dir}/audit
ARTIFACTS_BASE=${dir}/artifacts
mkdir -p "$REPO_PATH"
resolve_worktree_branch() { printf 'claude/%s\\n' "$1"; }
compact_session() { :; }
git() { :; }
${DELETE_SRC}
delete_worktree alpha demo-abc123-alpha ${keep}
`);
  const survives = (base) => fs.existsSync(path.join(dir, base, 'demo-abc123-alpha'));
  const state = { stdout: r.stdout, sessions: survives('sessions'), audit: survives('audit'), artifacts: survives('artifacts') };
  fs.rmSync(dir, { recursive: true, force: true });
  return state;
}

test('delete_worktree keeps session data when passed keep', { skip }, () => {
  const r = runDelete('keep');
  assert.ok(r.sessions, 'the conversation must survive a --gc sweep');
  assert.ok(r.audit && r.artifacts, 'audit and artifacts ride along with the conversation');
  assert.match(r.stdout, /Conversation kept/);
});

test('delete_worktree removes session data when not passed keep', { skip }, () => {
  const r = runDelete('');
  assert.ok(!r.sessions && !r.audit && !r.artifacts,
    '--prune is an explicit per-worktree selection; it still deletes everything');
  assert.match(r.stdout, /Removed session data/);
});
