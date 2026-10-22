// Regression guard for the chezmoi apply guard, claude_guard.apply_guard. It runs inside
// guard-pre-tool-use.sh (PreToolUse/Bash) and bash-write-fanout.sh (PostToolUse/Bash), the
// two shims that start claude_guard; it was chezmoi-apply-guard.sh until it folded into them.
// Drives the ACTUAL shims with a STUB `chezmoi` on PATH so it's hermetic. The
// discriminator under test is chezmoi's own status columns, verified against
// chezmoi v2.71.1: " M path" is the normal source-edited workflow and must pass,
// "MM path" means the deployed file changed outside chezmoi and apply would
// discard it. Blocking the first would make the hook useless, so both directions
// are pinned. Skips without bash, jq or a uv-managed 3.14. The text fallback for a command
// the parser cannot read is pinned in claude-guard's tests/test_apply_guard.py.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const PRE = srcPath('private_dot_claude', 'hooks', 'executable_guard-pre-tool-use.sh');
const POST = srcPath('private_dot_claude', 'hooks', 'executable_bash-write-fanout.sh');
const GUARD = srcPath('dot_local', 'share', 'claude-guard');

// The guard needs the interpreter the shims resolve: a uv-MANAGED 3.14, which is not the one
// actions/setup-python provides. Without it the pre shim asks on every command, and these
// assertions would fail for a reason that is not a regression.
const managedPython = (() => {
  try {
    const r = execFileSync(
      'uv', ['python', 'find', '--no-project', '--managed-python', '--system', '3.14'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return fs.existsSync(r);
  } catch { return false; }
})();
const skip = skipUnless('bash', 'jq') || (managedPython ? false : 'no uv-managed 3.14');

const BIN = scratch(os.tmpdir(), 'czag-bin-');
fs.writeFileSync(path.join(BIN, 'chezmoi'), `#!/bin/bash
# status, source-path and diff are consulted by the hook; echo the fixture it was given.
# STUB_SLOW=<verb> makes that verb hang; STUB_STATUS_EXIT sets status's exit code.
[ "\${STUB_SLOW:-}" = "$1" ] && sleep 30
case "$1" in
  status) printf '%s' "$STUB_STATUS"; [ -n "$STUB_STATUS" ] && printf '\\n'
          exit "\${STUB_STATUS_EXIT:-0}" ;;
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

// A deny or ask, or null when the guard stayed out of the way. The pre shim decides for the
// whole deny side, so a read-only allow or a context nudge beside the guard is no decision.
const blocking = (d) => (d && ['deny', 'ask'].includes(d.permissionDecision) ? d : null);

function decide(command, stubStatus) {
  const out = execFileSync('bash', [PRE], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: '/home/daniel' }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...UV_ENV,
      PATH: `${BIN}:${process.env.PATH}`,
      STUB_STATUS: stubStatus,
      HOME: '/home/daniel',
      CLAUDE_GUARD_HOME: GUARD,
    },
  });
  return blocking(out.trim() ? JSON.parse(out).hookSpecificOutput : null);
}

const denies = (command, stub = CLOBBER) => {
  const d = decide(command, stub);
  assert.ok(d, `expected a decision for: ${command}`);
  assert.strictEqual(d.permissionDecision, 'deny');
  return d.permissionDecisionReason;
};
const allows = (command, stub = CLOBBER) =>
  assert.strictEqual(decide(command, stub), null, `expected no decision for: ${command}`);

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
  allows('chezmoi apply ~/.config/starship.toml');
});

test('a flag value that looks like a path is not treated as a target', { skip }, () => {
  // --source=... names the source tree, not a target; the conflict is still real.
  denies('chezmoi --source=/home/daniel/.local/share/chezmoi apply');
});

test('stays silent when chezmoi status reports nothing to overwrite', { skip }, () => {
  allows('chezmoi apply', CLEAN);
});

// ── what the flattened-text scan got wrong ────────────────────────────────────────
//
// Each pair below is one shape the glob-and-tr version misread, measured against this
// same stub. Two of them are fail-OPEN, which is the reason the parser is here at all:
// the apply ran and reverted a sibling's deployed build while the session believed the
// guard had looked.
test('a redirect or a pipeline does not narrow the targets', { skip }, () => {
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

test('a cd in front of the apply does not narrow the targets', { skip }, () => {
  denies('cd /tmp && chezmoi apply');
});

test('the override counts only as an assignment on the apply itself', { skip }, () => {
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
test('the override the message suggests is one the guard accepts', { skip }, () => {
  const reason = denies('cd /tmp && chezmoi apply');
  const suggested = /^ {2}(.*CHEZMOI_APPLY_GUARD=off.*)$/m.exec(reason);
  assert.ok(suggested, `the reason offers no override command:\n${reason}`);
  assert.strictEqual(suggested[1], 'cd /tmp && CHEZMOI_APPLY_GUARD=off chezmoi apply');
  allows(suggested[1]);
});

test('the words only count as a command, not as text', { skip }, () => {
  // Denying these blocked commands that write nothing, and the message told the session
  // to re-run its own commit with CHEZMOI_APPLY_GUARD=off.
  allows('git commit -m "fix chezmoi apply guard"');
  allows('echo "chezmoi apply"');
  allows('grep -rn "chezmoi apply" docs/');
});

test('-n is the short dry-run flag wherever it sits', { skip }, () => {
  allows('chezmoi apply -n');
  allows('chezmoi apply -n ~/.local/bin/agentview');
});

test('an apply inside a substitution is still seen', { skip }, () => {
  denies('echo $(chezmoi apply)');
});

// A command the parser refuses to read must still get the guard.
test('an unreadable command falls back rather than passing', { skip }, () => {
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
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
function sourceRepo(behind) {
  const dir = scratch(os.tmpdir(), 'czag-src-');
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { env: GIT_ENV, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t',
    'commit', '-q', '--allow-empty', '-m', 'one');
  git('-c', 'user.email=t@t', '-c', 'user.name=t',
    'commit', '-q', '--allow-empty', '-m', 'two');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  if (behind) git('reset', '-q', '--hard', 'HEAD~1');
  fs.mkdirSync(path.join(dir, 'home'));
  return path.join(dir, 'home');
}

// The pre shim's deny or ask, or with `post` the fanout shim's report.
function run(command, extraEnv = {}, args = []) {
  const post = args[0] === 'post';
  const out = execFileSync('bash', [post ? POST : PRE], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: '/home/daniel' }),
    encoding: 'utf8',
    env: {
      ...GIT_ENV, ...UV_ENV,
      PATH: `${BIN}:${process.env.PATH}`, STUB_STATUS: CLEAN,
      HOME: '/home/daniel', CLAUDE_GUARD_HOME: GUARD, ...extraEnv,
    },
  });
  const d = out.trim() ? JSON.parse(out).hookSpecificOutput : null;
  return post ? d : blocking(d);
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

test('a stale primary does not block an apply that reads another source', { skip }, () => {
  const stale = { STUB_SOURCE_PATH: sourceRepo(true) };
  assert.strictEqual(run('chezmoi apply --source /wt/home ~/.zshrc', stale), null);
  assert.strictEqual(run('chezmoi apply --source=/wt/home', stale), null);
  assert.strictEqual(run('chezmoi update', stale), null);
  assert.strictEqual(run('CHEZMOI_APPLY_GUARD=off chezmoi apply', stale), null);
  assert.strictEqual(run('chezmoi apply -S /wt/home && chezmoi apply', stale).permissionDecision, 'deny');
});

test('the --source operand is not read as a target', { skip }, () => {
  // Before, /wt/home became a target and narrowed the conflict scan to a path no
  // conflict could be under, so this clobbering apply ran.
  denies('chezmoi apply --source /wt/home');
});

// ── post: the diff an --source apply leaves behind (#583) ─────────────────────────
test('after an --source apply it prints the diff against the primary source', { skip }, () => {
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

test('after a plain apply, or a clean diff, post says nothing', { skip }, () => {
  assert.strictEqual(run('chezmoi apply', { STUB_DIFF: '-x' }, ['post']), null);
  assert.strictEqual(run('chezmoi apply --source /wt/home', { STUB_DIFF: '' }, ['post']), null);
});

test('with no claude_guard after an --source apply, the diff is reported as not run', { skip }, () => {
  const empty = scratch(os.tmpdir(), 'czag-noguard-');
  const d = run('chezmoi apply --source /wt/home', { CLAUDE_GUARD_HOME: empty, STUB_DIFF: '-x' }, ['post']);
  assert.match(d.additionalContext, /chezmoi diff.*did not run -- not evaluated/s);
  assert.strictEqual(run('chezmoi apply', { CLAUDE_GUARD_HOME: empty }, ['post']), null);
});

test('a commit message naming the apply is not a stale-source refusal', { skip }, () => {
  // The parser cannot split this, and the text fallback matches the words; the stale check
  // is parser-only, so with no status conflict it passes, as it did before the stale check.
  assert.strictEqual(run('git commit -m "chezmoi apply \\"x', { STUB_SOURCE_PATH: sourceRepo(true) }), null);
});

// ── words in quoted or heredoc text (#614) ──────────────────────────────────────────
//
// Commands that only NAME the apply were refused during the 2026-09-23 fan-out: a PR body,
// a commit heredoc, a `findings.py open --title`. The parsed path read most of them right.
// The one it did not is a heredoc body with an odd `"` in it: shlex cannot split the
// segment that carries it, the whole command became `unreadable`, and the text fallback
// then refused on the deployed-ahead conflict.
const ODD_QUOTE_BODY = 'gh pr create --title "Stop the chezmoi apply guard misfiring" --body "$(cat <<\'EOF\'\nA 5" screen shows it.\nEOF\n)"';

test('an odd quote in a heredoc body does not turn a non-chezmoi command into a refusal', { skip }, () => {
  allows(ODD_QUOTE_BODY);
  // The reject half: a chezmoi command the parser cannot split still falls back and denies.
  denies('chezmoi apply "unbalanced');
});

// ── a lookup that cannot finish asks instead of allowing (#657) ─────────────────────
//
// `STATUS=$(chezmoi status) || exit 0` let the apply through whenever status failed, and
// every chezmoi call here ran with no bound, so a hung one ran into the harness's 15s kill,
// which is also a pass. Each is now bounded, and a status or source-path lookup that does
// not finish asks. The accepting halves are 'allows the normal workflow' and 'allows an
// apply from a source checkout level with origin/main' above. run_bounded needs timeout(1).
const skipBounded = skipUnless('bash', 'jq', 'timeout');

function timedRun(command, env, args) {
  const started = Date.now();
  const d = run(command, { CHEZMOI_APPLY_GUARD_TIMEOUT_S: '1', ...env }, args);
  return { d, seconds: (Date.now() - started) / 1000 };
}

test('a chezmoi status that fails asks rather than allowing the apply', { skip }, () => {
  const d = run('chezmoi apply', { STUB_STATUS: CLOBBER, STUB_STATUS_EXIT: '1' });
  assert.strictEqual(d && d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /chezmoi status.*exit 1.*not evaluated/s);
  assert.match(d.permissionDecisionReason, /CHEZMOI_APPLY_GUARD=off chezmoi apply/);
});

test('a hung chezmoi status is cut off and asks', { skip: skipBounded }, () => {
  const { d, seconds } = timedRun('chezmoi apply', { STUB_SLOW: 'status' });
  assert.ok(seconds < 10, `took ${seconds}s`);
  assert.strictEqual(d && d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /chezmoi status.*within 1s \(timeout\)/s);
});

test('a hung source-path lookup is cut off and asks', { skip: skipBounded }, () => {
  const { d, seconds } = timedRun('chezmoi apply', { STUB_SLOW: 'source-path' });
  assert.ok(seconds < 10, `took ${seconds}s`);
  assert.strictEqual(d && d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /source-path.*within 1s \(timeout\)/s);
});

test('a hung post-apply diff is cut off and reported as not evaluated', { skip: skip || skipBounded }, () => {
  const { d, seconds } = timedRun('chezmoi apply --source /wt/home', { STUB_SLOW: 'diff' }, ['post']);
  assert.ok(seconds < 10, `took ${seconds}s`);
  assert.match(d.additionalContext, /chezmoi diff.*within 1s \(timeout\).*not evaluated/s);
});
