// Regression guard for executable_chezmoi-apply-guard.sh (PreToolUse/Bash).
// Drives the ACTUAL hook with a STUB `chezmoi` on PATH so it's hermetic. The
// discriminator under test is chezmoi's own status columns, verified against
// chezmoi v2.71.1: " M path" is the normal source-edited workflow and must pass,
// "MM path" means the deployed file changed outside chezmoi and apply would
// discard it. Blocking the first would make the hook useless, so both directions
// are pinned. Skips without bash/jq.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_chezmoi-apply-guard.sh');
const GUARD = srcPath('dot_local', 'share', 'claude-guard');

const skip = skipUnless('bash', 'jq');

// The parsed path needs the same interpreter the shims resolve: a uv-MANAGED 3.14, which
// is not the one actions/setup-python provides. Probing for `uv` alone would run the
// parsed assertions on a machine where the hook silently takes its fallback, and they
// would fail for a reason that is not a regression.
const managedPython = (() => {
  try {
    const r = execFileSync(
      'uv', ['python', 'find', '--no-project', '--managed-python', '--system', '3.14'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return fs.existsSync(r);
  } catch { return false; }
})();
const skipParsed = skip || (managedPython ? false : 'no uv-managed 3.14');

const BIN = scratch(os.tmpdir(), 'czag-bin-');
fs.writeFileSync(path.join(BIN, 'chezmoi'), `#!/bin/bash
# status, source-path and diff are consulted by the hook; echo the fixture it was given.
case "$1" in
  status) printf '%s' "$STUB_STATUS"; [ -n "$STUB_STATUS" ] && printf '\\n' ;;
  source-path) printf '%s' "\${STUB_SOURCE_PATH:-}" ;;
  diff) printf '%s\\n' "$*" > "\${STUB_DIFF_ARGS:-/dev/null}"; printf '%s' "\${STUB_DIFF:-}" ;;
  *) exit 0 ;;
esac
exit 0
`, { mode: 0o755 });

const CLEAN = '';
const NORMAL = ' M /home/daniel/.local/bin/agentview';
const CLOBBER = 'MM /home/daniel/.local/bin/agentview';

// HOME is faked so `~/...` targets expand onto the fixture's own paths. That also hides
// uv's managed toolchain and its cache, both of which live under the REAL home -- without
// these two the interpreter lookup fails and every test below would silently measure the
// fallback instead of the parser. They are named explicitly rather than inherited so the
// reason survives in the file that depends on it.
const UV_ENV = {
  UV_PYTHON_INSTALL_DIR:
    process.env.UV_PYTHON_INSTALL_DIR || path.join(os.homedir(), '.local', 'share', 'uv', 'python'),
  UV_CACHE_DIR: process.env.UV_CACHE_DIR || path.join(os.homedir(), '.cache', 'uv'),
};

// A decision, or null when the hook stayed out of the way. `guardHome` is the claude_guard
// package the hook parses with; pointing it at an empty directory is how the fallback is
// exercised, exactly as a machine with no claude-guard deploy would take it.
function decide(command, stubStatus, guardHome = GUARD) {
  const out = execFileSync('bash', [HOOK], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...UV_ENV,
      PATH: `${BIN}:${process.env.PATH}`,
      STUB_STATUS: stubStatus,
      HOME: '/home/daniel',
      CLAUDE_GUARD_HOME: guardHome,
    },
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput : null;
}

const denies = (command, stub = CLOBBER, guardHome = GUARD) => {
  const d = decide(command, stub, guardHome);
  assert.ok(d, `expected a decision for: ${command}`);
  assert.strictEqual(d.permissionDecision, 'deny');
  return d.permissionDecisionReason;
};
const allows = (command, stub = CLOBBER, guardHome = GUARD) =>
  assert.strictEqual(decide(command, stub, guardHome), null, `expected no decision for: ${command}`);

test('denies an apply that would discard an out-of-band deployed change', { skip }, () => {
  const reason = denies('chezmoi apply');
  assert.match(reason, /\/home\/daniel\/\.local\/bin\/agentview/);
  assert.match(reason, /chezmoi diff/);
  assert.match(reason, /CHEZMOI_APPLY_GUARD=off/);
});

test('allows the normal workflow: source edited, deployed untouched', { skip }, () => {
  allows('chezmoi apply', NORMAL);
  allows('chezmoi apply', CLEAN);
  allows('chezmoi apply', ' A /home/daniel/.local/bin/newthing');
});

test('ignores commands that do not write deployed files', { skip }, () => {
  allows('ls -la');
  allows('chezmoi status');
  allows('chezmoi diff ~/.local/bin/agentview');
  allows('chezmoi source-path ~/.zshrc');
});

test('covers the other writing verbs', { skip }, () => {
  denies('chezmoi update');
  denies('chezmoi init --apply DanielH2018/dotfiles');
});

test('--dry-run writes nothing, so it is never blocked', { skip }, () => {
  allows('chezmoi apply --dry-run');
});

test('the documented override lets a deliberate revert through', { skip }, () => {
  allows('CHEZMOI_APPLY_GUARD=off chezmoi apply');
});

test('a line-continuation cannot hide the verb', { skip }, () => {
  denies('chezmoi \\\n  apply');
});

test('scoped applies only care about conflicts under the named target', { skip }, () => {
  denies('chezmoi apply /home/daniel/.local/bin/agentview');
  denies('chezmoi apply ~/.local/bin/agentview');
  denies('chezmoi apply /home/daniel/.local/bin');
  allows('chezmoi apply /home/daniel/.zshrc');
  allows('chezmoi apply ~/.config/wezterm');
});

test('a flag value that looks like a path is not treated as a target', { skip }, () => {
  // --source=... names the source tree, not a target; the conflict is still real.
  denies('chezmoi --source=/home/daniel/.local/share/chezmoi apply');
});

test('stays silent when chezmoi status fails', { skip }, () => {
  // Stub returns nothing for an unknown subcommand shape; hook must not block.
  allows('chezmoi apply', CLEAN);
});

// ── what the flattened-text scan got wrong ────────────────────────────────────────
//
// Each pair below is one shape the glob-and-tr version misread, measured against this
// same stub. Two of them are fail-OPEN, which is the reason the parser is here at all:
// the apply ran and reverted a sibling's deployed build while the session believed the
// guard had looked.
test('a redirect or a pipeline does not narrow the targets', { skip: skipParsed }, () => {
  // The old scan took every /-rooted token in the WHOLE command as a target, so a log
  // path on the far side of a pipe left no conflict under any named target and the
  // apply was allowed.
  denies('chezmoi apply 2>&1 | tee /tmp/apply.log');
  denies('chezmoi apply > /tmp/apply.log');
  // `2>`, `&>` and `2>>` are operators as much as `>` is. Reading them as arguments
  // left their operand standing as a target, which is the same fail-open shape.
  denies('chezmoi apply 2> /dev/null');
  denies('chezmoi apply &> /tmp/x');
  denies('chezmoi apply 2>> /tmp/x');
});

test('a cd in front of the apply does not narrow the targets', { skip: skipParsed }, () => {
  denies('cd /tmp && chezmoi apply');
});

test('the override counts only as an assignment on the apply itself', { skip: skipParsed }, () => {
  // Matching the override anywhere in the text made it settable from inside any other
  // command's arguments, which is a bypass rather than an override.
  denies('echo CHEZMOI_APPLY_GUARD=off; chezmoi apply');
  denies('git commit -m "use CHEZMOI_APPLY_GUARD=off" && chezmoi apply');
  // The documented form still works, including behind another command.
  allows('git status && CHEZMOI_APPLY_GUARD=off chezmoi apply');
  // And it covers only the command it prefixes: bash gives the assignment to that
  // process and no other, so a second apply beside it is still guarded.
  denies('CHEZMOI_APPLY_GUARD=off chezmoi apply ~/.zshrc && chezmoi apply');
});

// The deny message is an instruction, so it has to be one that works. The assignment
// only reaches the process it prefixes: suggesting it at the head of
// `cd /tmp && chezmoi apply` sets it for `cd`, the apply is denied again, and the
// session loops on the hook's own advice.
test('the override the message suggests is one the guard accepts', { skip: skipParsed }, () => {
  const reason = denies('cd /tmp && chezmoi apply');
  const suggested = /^ {2}(.*CHEZMOI_APPLY_GUARD=off.*)$/m.exec(reason);
  assert.ok(suggested, `the reason offers no override command:\n${reason}`);
  assert.strictEqual(suggested[1], 'cd /tmp && CHEZMOI_APPLY_GUARD=off chezmoi apply');
  allows(suggested[1]);
});

test('the words only count as a command, not as text', { skip: skipParsed }, () => {
  // Denying these blocked commands that write nothing, and the message told the session
  // to re-run its own commit with CHEZMOI_APPLY_GUARD=off.
  allows('git commit -m "fix chezmoi apply guard"');
  allows('echo "chezmoi apply"');
  allows('grep -rn "chezmoi apply" docs/');
});

test('-n is the short dry-run flag wherever it sits', { skip: skipParsed }, () => {
  allows('chezmoi apply -n');
  allows('chezmoi apply -n ~/.local/bin/agentview');
});

test('an apply inside a substitution is still seen', { skip: skipParsed }, () => {
  denies('echo $(chezmoi apply)');
});

// The parser is an improvement, never a dependency. A machine with no claude-guard
// deploy -- and a command the parser refuses to read -- must still get the guard.
test('with no claude_guard package it falls back and still denies', { skip }, () => {
  const empty = scratch(os.tmpdir(), 'czag-noguard-');
  denies('chezmoi apply', CLOBBER, empty);
  allows('chezmoi apply', NORMAL, empty);
  allows('ls -la', CLOBBER, empty);
});

test('an unreadable command falls back rather than passing', { skip: skipParsed }, () => {
  // An unbalanced quote makes the parser refuse. Its docstring is explicit that a
  // refusal is never a skip, so the hook takes the old scan, which denies this.
  denies('chezmoi apply "unbalanced');
});


// ── a primary source checkout behind origin/main (#583) ───────────────────────────
//
// A real repository, not a stubbed git: the refusal is a `rev-list` against the local
// origin/main ref, and only a real ref can prove it counts commits in the right direction.
// `behind` builds a checkout on main one commit short of origin/main; `current` is the same
// repository with main fast-forwarded, which is what bin/land-sync leaves.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
function sourceRepo(behind) {
  const dir = scratch(os.tmpdir(), 'czag-src-');
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { env: GIT_ENV, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false',
    'commit', '-q', '--allow-empty', '-m', 'one');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false',
    'commit', '-q', '--allow-empty', '-m', 'two');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  if (behind) git('reset', '-q', '--hard', 'HEAD~1');
  fs.mkdirSync(path.join(dir, 'home'));
  return path.join(dir, 'home');
}

function run(command, extraEnv = {}, args = []) {
  const out = execFileSync('bash', [HOOK, ...args], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    env: {
      ...GIT_ENV, ...UV_ENV,
      PATH: `${BIN}:${process.env.PATH}`, STUB_STATUS: CLEAN,
      HOME: '/home/daniel', CLAUDE_GUARD_HOME: GUARD, ...extraEnv,
    },
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput : null;
}

test('denies an apply while the primary source checkout is behind origin/main', { skip }, () => {
  const d = run('chezmoi apply', { STUB_SOURCE_PATH: sourceRepo(true) });
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /1 commit\(s\) behind origin\/main/);
  assert.match(d.permissionDecisionReason, /bin\/land-sync/);
});

test('allows an apply from a source checkout level with origin/main', { skip }, () => {
  assert.strictEqual(run('chezmoi apply', { STUB_SOURCE_PATH: sourceRepo(false) }), null);
});

test('a stale primary does not block an apply that reads another source', { skip: skipParsed }, () => {
  const stale = { STUB_SOURCE_PATH: sourceRepo(true) };
  assert.strictEqual(run('chezmoi apply --source /wt/home ~/.zshrc', stale), null);
  assert.strictEqual(run('chezmoi apply --source=/wt/home', stale), null);
  assert.strictEqual(run('chezmoi update', stale), null);
  assert.strictEqual(run('CHEZMOI_APPLY_GUARD=off chezmoi apply', stale), null);
  assert.strictEqual(run('chezmoi apply -S /wt/home && chezmoi apply', stale).permissionDecision, 'deny');
});

test('the --source operand is not read as a target', { skip: skipParsed }, () => {
  // Before, /wt/home became a target and narrowed the conflict scan to a path no
  // conflict could be under, so this clobbering apply ran.
  denies('chezmoi apply --source /wt/home');
});

// ── post: the diff an --source apply leaves behind (#583) ─────────────────────────
test('after an --source apply it prints the diff against the primary source', { skip: skipParsed }, () => {
  const argsFile = path.join(scratch(os.tmpdir(), 'czag-diff-'), 'args');
  const d = run('chezmoi apply --source /wt/home ~/.zshrc',
    { STUB_DIFF: '-old line\n+new line', STUB_DIFF_ARGS: argsFile }, ['post']);
  assert.strictEqual(d.hookEventName, 'PostToolUse');
  assert.match(d.additionalContext, /-old line/);
  const argv = fs.readFileSync(argsFile, 'utf8');
  assert.match(argv, /--exclude=encrypted,scripts/);
  assert.match(argv, /\/home\/daniel\/\.zshrc/);
  assert.doesNotMatch(argv, /\/wt\/home/);
});

test('after a plain apply, or a clean diff, post says nothing', { skip: skipParsed }, () => {
  assert.strictEqual(run('chezmoi apply', { STUB_DIFF: '-x' }, ['post']), null);
  assert.strictEqual(run('chezmoi apply --source /wt/home', { STUB_DIFF: '' }, ['post']), null);
});

test('the stale-source refusal is parser-only, so the text fallback stays no stricter', { skip }, () => {
  // The fallback matches the words anywhere, a commit message included. Before the
  // stale check, a fallback match with no status conflict passed, and it still must.
  const stale = { STUB_SOURCE_PATH: sourceRepo(true) };
  const empty = scratch(os.tmpdir(), 'czag-noguard-');
  assert.strictEqual(run('chezmoi apply', { ...stale, CLAUDE_GUARD_HOME: empty }), null);
  if (!skipParsed) assert.strictEqual(run('git commit -m "chezmoi apply \\"x', stale), null);
});

// ── words in quoted or heredoc text (#614) ──────────────────────────────────────────
//
// Commands that only NAME the apply were refused during the 2026-09-23 fan-out: a PR body,
// a commit heredoc, a `findings.py open --title`. The parsed path read most of them right.
// The one it did not is a heredoc body with an odd `"` in it: shlex cannot split the
// segment that carries it, the whole command became `unreadable`, and the text fallback
// then refused on the deployed-ahead conflict.
const ODD_QUOTE_BODY = 'gh pr create --title "Stop the chezmoi apply guard misfiring" --body "$(cat <<\'EOF\'\nA 5" screen shows it.\nEOF\n)"';

test('an odd quote in a heredoc body does not turn a non-chezmoi command into a refusal', { skip: skipParsed }, () => {
  allows(ODD_QUOTE_BODY);
  // The reject half: a chezmoi command the parser cannot split still falls back and denies.
  denies('chezmoi apply "unbalanced');
});

test('the text fallback ignores quoted and quoted-heredoc text', { skip }, () => {
  const empty = scratch(os.tmpdir(), 'czag-noguard-');
  allows('git commit -m "fix chezmoi apply guard"', CLOBBER, empty);
  allows('GH_REPO=a/b uv run python findings.py open --title "Stop the guard refusing chezmoi apply text"', CLOBBER, empty);
  allows("git commit -F - <<'EOF'\nFix guard\n\nIt no longer refuses chezmoi apply in a heredoc.\nEOF", CLOBBER, empty);
  allows(ODD_QUOTE_BODY, CLOBBER, empty);
  // A substitution inside double quotes runs, so that text still counts.
  denies('echo "$(chezmoi apply)"', CLOBBER, empty);
  denies('chezmoi apply', CLOBBER, empty);
});
