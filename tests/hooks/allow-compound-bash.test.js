// Regression guard for executable_allow-compound-bash.sh (PermissionRequest/Bash).
// Drives the ACTUAL hook against a temp settings.json and asserts it auto-allows a
// compound command only when EVERY sub-command is allow-listed and none are deny/ask.
// Hermetic: HOME points at a temp dir. Skips cleanly without bash/jq.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_allow-compound-bash.sh');
// The library is still `executable_cmdparse.sh` in the source tree; chezmoi drops the
// prefix on apply, which is the hook's default sibling path. CMDPARSE_LIB points the hook
// at the source copy so the suite runs straight out of the tree, same idiom as
// cmdparse-shadow.test.js.
const CMDPARSE_LIB = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_cmdparse.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-'));
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude', 'settings.json'), JSON.stringify({
  permissions: {
    allow: ['Bash(git status:*)', 'Bash(ls:*)', 'Bash(echo:*)', 'Bash(cat:*)',
      'Bash(jq:*)', 'Bash(jsonq:*)', 'Bash(git commit:*)', 'Bash(gh api:*)',
      'Bash(sh:*)', 'Bash(tail:*)', 'Bash(git log:*)',
      // An allow rule with an interior wildcard, to pin that those stay literal.
      'Bash(frob * --safe)'],
    deny: ['Bash(rm:*)', 'Bash(git commit *--no-verify)', 'Bash(* | sh)'],
    ask: ['Bash(git push:*)', 'Bash(gh api *-X DELETE)', 'Bash(git merge:*)'],
  },
}));

function allowed(command, home = HOME, projectDir = '') {
  let out;
  try {
    out = execFileSync('bash', [HOOK], {
      input: JSON.stringify({ tool_input: { command } }),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: projectDir, CMDPARSE_LIB },
    });
  } catch (e) { out = e.stdout || ''; }
  if (!out.trim()) return null; // hook deferred to normal handling
  try { return JSON.parse(out).hookSpecificOutput.decision.behavior; } catch { return null; }
}

// Same as allowed(), but sets the input's `cwd` field explicitly rather than letting the
// hook fall back to the test process's own $PWD -- the heredoc-write-parity tests need to
// pin the session cwd to a directory they control.
function allowedAt(command, cwd, home = HOME, projectDir = '') {
  let out;
  try {
    out = execFileSync('bash', [HOOK], {
      input: JSON.stringify({ tool_input: { command }, cwd }),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: projectDir, CMDPARSE_LIB },
    });
  } catch (e) { out = e.stdout || ''; }
  if (!out.trim()) return null;
  try { return JSON.parse(out).hookSpecificOutput.decision.behavior; } catch { return null; }
}

test('auto-allows a compound command where every part is allow-listed', { skip }, () => {
  assert.strictEqual(allowed('git status && ls -la'), 'allow');
  assert.strictEqual(allowed('echo hi && cat file.txt && ls'), 'allow');
});

test('defers (no decision) for non-compound commands', { skip }, () => {
  assert.strictEqual(allowed('git status'), null);
});

// A curl segment always matches the Bash(curl:*) ask rule, so `curl -s URL | jq .` could
// never be approved here however safe both halves were -- 118 of the 147 curl prompts in
// the week of 2026-08-07 were that shape. The segment is now put to allow-safe-curl.sh,
// the same question it answers for a bare curl. The load-bearing cases are the refusals:
// delegation must not let the curl hook vouch for anything beyond its own segment.
test('a provably-safe curl segment resolves its own ask rule', { skip }, () => {
  assert.strictEqual(allowed('curl -s http://127.0.0.1:9090/metrics | tail -20'), 'allow');
  assert.strictEqual(
    allowed('curl -sG http://127.0.0.1:9090/api/v1/query --data-urlencode "query=up" | jq .'),
    'allow');
});

test('curl delegation vouches for the curl segment only', { skip }, () => {
  // A curl the helper would refuse standing alone is not rescued by the pipeline.
  assert.strictEqual(allowed('curl -s http://evil.com/x | tail -20'), null);
  assert.strictEqual(allowed('curl -L http://127.0.0.1:9090/m | tail -20'), null);
  assert.strictEqual(allowed('curl -X POST http://127.0.0.1:9090/m | tail -20'), null);
  assert.strictEqual(allowed('curl -o /tmp/x http://127.0.0.1:9090/m | tail -20'), null);
  // The other stage still has to clear deny and earn its own allow entry.
  assert.strictEqual(allowed('curl -s http://127.0.0.1:9090/metrics | sh'), null);
  assert.strictEqual(allowed('curl -s http://127.0.0.1:9090/m | frobnicate'), null);
  assert.strictEqual(allowed('curl -s http://127.0.0.1:9090/m | tail -20 && rm -rf /tmp/x'), null);
});

// The same delegation for the other ask-listed command that takes an arbitrary target.
// The fixture above puts rm in DENY, which is checked first and never reaches the
// delegation -- that is the assertion on the last line of the block above. The real
// settings ask-list it, so these cases build their own HOME to exercise the path that
// actually runs in production.
const RM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-rm-'));
fs.mkdirSync(path.join(RM_HOME, '.claude'), { recursive: true });
fs.writeFileSync(path.join(RM_HOME, '.claude', 'settings.json'), JSON.stringify({
  permissions: {
    allow: ['Bash(cd:*)', 'Bash(echo:*)', 'Bash(ls:*)', 'Bash(mkdir:*)', 'Bash(uv run:*)'],
    deny: [],
    ask: ['Bash(rm:*)'],
  },
}));
const rmAllowed = (command) => allowed(command, RM_HOME);

// The motivating shape for the rm delegation: a scratch script run then cleaned up in
// the same chain. `uv run` is allow-listed above for exactly this test.
test('a delegate-and-cleanup chain is allowed end to end', { skip }, () => {
  assert.strictEqual(rmAllowed('uv run python /tmp/x.py && rm /tmp/x.py'), 'allow');
});

test('a provably-confined rm segment resolves its own ask rule', { skip }, () => {
  assert.strictEqual(rmAllowed('cd /tmp && rm -rf /tmp/scratch'), 'allow');
  assert.strictEqual(rmAllowed('rm -rf /tmp/a && mkdir -p /tmp/a'), 'allow');
  assert.strictEqual(rmAllowed('echo cleaning && rm -f /tmp/build/out.txt'), 'allow');
});

test('rm delegation vouches for the rm segment only', { skip }, () => {
  // An rm the helper would refuse standing alone is not rescued by the chain.
  assert.strictEqual(rmAllowed('cd /tmp && rm -rf /etc/passwd'), null);
  assert.strictEqual(rmAllowed('cd /tmp && rm -rf /tmp/../etc'), null);
  assert.strictEqual(rmAllowed('cd /tmp && rm -rf /tmp'), null);
  assert.strictEqual(rmAllowed('cd /tmp && rm -rf /tmp/*'), null);
  assert.strictEqual(rmAllowed('cd /tmp && rm --no-preserve-root -rf /tmp/a'), null);
  // One confined rm does not vouch for a second unconfined one.
  assert.strictEqual(rmAllowed('rm -rf /tmp/a && rm -rf /etc/x'), null);
  // The other stage still has to earn its own allow entry.
  assert.strictEqual(rmAllowed('rm -rf /tmp/a && frobnicate'), null);
});

test('deny still outranks the rm delegation', { skip }, () => {
  // The module fixture denies Bash(rm:*), and deny is checked before delegation.
  assert.strictEqual(allowed('cd /tmp && rm -rf /tmp/scratch'), null);
});

// DECIDED 2026-09-06, superseding the 2026-07-30 note this replaced: a newline now joins
// the eligible population and is judged exactly like `;` (see allow-compound-bash.sh's
// eligibility comment). 76+ prompts/wk (measured 2026-08-29) were a `cd <worktree>` on
// one line and a grep on the next, refused for no reason a `;`-joined chain wouldn't
// also refuse. A lone `&` is unaffected -- it never enters the eligible population on
// its own (see the bare-`&` test above), and the UNJUDGEABLE handling still treats one
// as unreadable even inside an otherwise-eligible chain.
test('a newline-only compound is allowed when every part is allow-listed', { skip }, () => {
  assert.strictEqual(allowed('echo hi\nls'), 'allow');
  assert.strictEqual(allowed('git status\ngit log --oneline -3\ncat file.txt'), 'allow');
});

test('a newline-only compound still defers when a segment is denied, ask-listed, or unlisted', { skip }, () => {
  assert.strictEqual(allowed('ls\nrm -rf build'), null);            // deny
  assert.strictEqual(allowed('git status\ngit push origin main'), null); // ask
  assert.strictEqual(allowed('git status\nfrobnicate'), null);      // unlisted
});

// The hook has no segmentation of its own to fall back to now -- a missing library means
// it cannot judge any sub-command, so it must defer everything rather than approve
// anything on the strength of a splitter that no longer exists.
test('a missing cmd_parse library disables auto-approval entirely', { skip }, () => {
  const out = (() => {
    try {
      return execFileSync('bash', [HOOK], {
        input: JSON.stringify({ tool_input: { command: 'echo hi && ls' } }),
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOME, CMDPARSE_LIB: '/does/not/exist/cmdparse.sh' },
      });
    } catch (e) { return e.stdout || ''; }
  })();
  assert.strictEqual(out, '', 'defers rather than approving without any segmentation');
});

test('defers when any part is denied, ask-listed, or unlisted', { skip }, () => {
  assert.strictEqual(allowed('ls && rm -rf build'), null);          // deny
  assert.strictEqual(allowed('git status && git push origin main'), null); // ask
  assert.strictEqual(allowed('git status && frobnicate'), null);    // unlisted
});

// `git merge --ff-only <ref>` is the single named exception to the ask list: no permission
// rule can free it (ask is evaluated before allow, and specificity does not break the tie)
// and every real invocation is a compound, so this hook is the only place it can be said.
test('allows git merge --ff-only past its ask rule, with one ref and no options', { skip }, () => {
  assert.strictEqual(allowed('git merge --ff-only origin/main && git log --oneline -3'), 'allow');
  assert.strictEqual(allowed('git merge --ff-only origin/main | tail -3'), 'allow');
  // `2>&1` is on nearly every real invocation. The ref is read off the redirect-stripped
  // form for exactly this reason — reading the raw segment sees two words and refuses.
  assert.strictEqual(allowed('git merge --ff-only origin/main 2>&1 | tail -3'), 'allow');
  assert.strictEqual(
    allowed('git merge --ff-only origin/main 2>&1 | tail -2; git log --oneline -1'), 'allow');
  assert.strictEqual(allowed('git merge --ff-only origin/main 2>/dev/null && git log'), 'allow');
});

test('the git merge exception does not widen to any other merge form', { skip }, () => {
  // bare merge, and the flags that can create a commit or rewrite the tree
  assert.strictEqual(allowed('git merge origin/main && git log'), null);
  assert.strictEqual(allowed('git merge --no-ff origin/main && git log'), null);
  assert.strictEqual(allowed('git merge --squash origin/main && git log'), null);
  // an option smuggled after --ff-only must not ride in on the prefix
  assert.strictEqual(allowed('git merge --ff-only --no-ff x && git log'), null);
  // more than one ref, or none at all
  assert.strictEqual(allowed('git merge --ff-only a b && git log'), null);
  assert.strictEqual(allowed('git merge --ff-only && git log'), null);
  // the exception sits behind the redirection guard, so it cannot become a writer
  assert.strictEqual(allowed('git merge --ff-only origin/main > out.txt && git log'), null);
});

test('defers when a command substitution could smuggle a segment', { skip }, () => {
  assert.strictEqual(allowed('echo $(whoami) && ls'), null);        // command substitution
  assert.strictEqual(allowed('echo `whoami` && ls'), null);         // backticks
  assert.strictEqual(allowed('cat <(curl example.com) && ls'), null); // process substitution
});

// cmd_parse lifts a heredoc body out whole and never scans it for a substitution, so an
// unquoted OR non-write heredoc could carry a live `$(...)` this hook cannot see (the one
// carve-out, a `cat > path`/`cat >> path` write with a QUOTED delimiter, is its own test
// group below). Stays deferred even though every segment shown here is individually
// allow-listed and the command is eligible (it contains a literal `&&`).
test('defers on a heredoc that is not the cat>path write shape, even when every segment is allow-listed', { skip }, () => {
  assert.strictEqual(allowed("git commit -F - <<'EOF' && ls\nmy message\nEOF\n"), null);
});

// An internal newline used to force a defer regardless of content; now that it is judged
// like `;` (see the newline-only tests above), this is allowed on the strength of every
// segment earning its own allow entry, same as it would with `;` in its place.
test('an internal newline inside an eligible chain is judged like `;`', { skip }, () => {
  assert.strictEqual(allowed('echo hi && ls\ncat file.txt'), 'allow');
  assert.strictEqual(allowed('echo hi && ls\nfrobnicate'), null);
});

// A quoted delimiter used to force a prompt: the hook bailed rather than risk a naive
// split mangling it. The splitter is quote-aware now, so the `&&` inside the string is
// inert — it is an argument to an allow-listed `echo`, and both segments are allow-listed.
// This assertion deliberately changed direction; it is not a regression.
test('splits on delimiters outside quotes, leaving quoted ones inert', { skip }, () => {
  assert.strictEqual(allowed('echo "a && b" && ls'), 'allow');
  assert.strictEqual(allowed("echo 'a; b' && ls"), 'allow');
  assert.strictEqual(allowed('echo "a | b" && ls'), 'allow');
  // The shapes this was really costing us: a filter containing a pipe, and two
  // separately quoted arguments either side of a delimiter.
  assert.strictEqual(allowed(`cat a.json | jq -r '.hooks | keys[]'`), 'allow');
  assert.strictEqual(allowed(`jq -r '.a' f.json; jq -r '.b' f.json`), 'allow');
  assert.strictEqual(allowed(`echo "one" && echo "two" && echo "three"`), 'allow');
});

test('still inspects every segment when quotes are involved', { skip }, () => {
  assert.strictEqual(allowed('echo "a && b" && rm -rf build'), null);      // deny
  assert.strictEqual(allowed(`echo "x" && git push origin main`), null);   // ask
  assert.strictEqual(allowed(`echo "x" && frobnicate 'y'`), null);         // unlisted
});

test('defers on unbalanced quoting rather than guessing', { skip }, () => {
  assert.strictEqual(allowed(`echo 'unbalanced && ls`), null);
  assert.strictEqual(allowed('echo "unbalanced && ls'), null);
});

test('defers when a segment redirects to a real target', { skip }, () => {
  assert.strictEqual(allowed('cat a.json > /etc/passwd && ls'), null);
  assert.strictEqual(allowed('echo hi >> ~/.bashrc && ls'), null);
  // /dev/null and fd dups are harmless and must keep working.
  assert.strictEqual(allowed('cat a.json 2>/dev/null && ls'), 'allow');
  assert.strictEqual(allowed('cat a.json > /dev/null && ls'), 'allow');
  assert.strictEqual(allowed('cat a.json 2>&1 && ls'), 'allow');
});

// A lone `&` is a separator, not an ordinary character. The splitter only ever paired
// `&` with a following `&`, so a backgrounded segment stayed glued to the one before it
// and matches_any — which inspects a segment's prefix only — approved the whole chain off
// the allow-listed leader. `git status && ls & anything` auto-allowed.
test('treats a bare & as a separator rather than gluing the next command on', { skip }, () => {
  assert.strictEqual(allowed('git status && ls & frobnicate'), null);
  assert.strictEqual(allowed('git status; echo hi & rm -rf build'), null);
  // Backgrounding an allow-listed command is deferred too: we cannot split it safely,
  // and a prompt is the conservative outcome.
  assert.strictEqual(allowed('ls & git status'), null);
  // fd dups contain a `&` but are not separators, and must keep working.
  assert.strictEqual(allowed('cat a.json 2>&1 && ls'), 'allow');
  assert.strictEqual(allowed('echo "a & b" && ls'), 'allow');
  // Same case in COMPOUND form (the eligibility gate is satisfied by the `&&`, so this
  // reaches cmd_parse's segmentation): every segment is allow-listed, but the lone `&`
  // must still force a defer, not just when it is the only separator in the command.
  assert.strictEqual(allowed('git status && ls & echo hi'), null);
});

// The matcher has three branches (exact, prefix-plus-space, prefix-slash) and nothing
// pinned the boundary, so simplifying it to a bare prefix-star would have gone unnoticed
// while letting `lsof` ride in on `ls`.
test('matches an allow prefix only at a command boundary', { skip }, () => {
  assert.strictEqual(allowed('lsof -i && ls'), null);
  assert.strictEqual(allowed('git statusfoo && ls'), null);
  assert.strictEqual(allowed('echoes hi && ls'), null);
});

// The extraction only strips a TRAILING wildcard, so a deny/ask rule whose `*` sits in
// the middle kept it — and matches_any compares with the pattern quoted, making all 20
// such rules in the real settings dead strings. Each then matched an allow prefix
// (`git commit`, `gh api`) and auto-approved the very thing it was written to stop.
test('evaluates deny/ask rules with an interior wildcard as globs', { skip }, () => {
  assert.strictEqual(allowed('git status && git commit -m x --no-verify'), null);
  assert.strictEqual(allowed('git status && git commit --no-verify -m x'), null);
  assert.strictEqual(allowed('ls && gh api -X DELETE /repos/o/r'), null);
});

// A rule written across a pipe is only ever intact before the split, since the splitter
// consumes `|` — so the whole command is tested against the glob list as well.
test('applies pipe-spanning deny globs to the whole command', { skip }, () => {
  assert.strictEqual(allowed('cat a.json | sh'), null);
  assert.strictEqual(allowed('echo hi && cat a.json | sh'), null);
});

// The glob must not swallow the ordinary form of the same command.
test('interior-wildcard rules do not over-match', { skip }, () => {
  assert.strictEqual(allowed('git status && git commit -m x'), 'allow');
  assert.strictEqual(allowed('git status && gh api /repos/o/r'), 'allow');
  assert.strictEqual(allowed('git status && gh api -X GET /repos/o/r'), 'allow');
});

// Deliberate asymmetry: activating the allow list's dead wildcards would WIDEN what is
// auto-approved without a prompt. Narrowing is a security fix; widening is the owner's
// call, so allow patterns stay on literal prefix matching.
test('leaves interior wildcards in ALLOW rules inert', { skip }, () => {
  assert.strictEqual(allowed('ls && frob x --safe'), null);
});

// ---------------------------------------------------------------------------
// The interpreter-escape family.
//
// extract_bash_prefixes strips a trailing wildcard, so every allow rule becomes a bare
// command prefix and matches_any grants on "prefix followed by a space". Any allow-listed
// tool that can spawn a command therefore hands over unprompted arbitrary execution as
// soon as it rides in a compound command — the deny list never sees it, because the
// payload is an argument, not a command. Measured against the real allow list: `Bash(env)`
// approved `env FOO=bar bash -c 'id'`, `Bash(/usr/bin/env bash *)` approved
// `/usr/bin/env bash -c 'id'`, `Bash(find:*)` approved `find . -exec id \;`, `Bash(awk:*)`
// approved `awk 'BEGIN{system("id")}'`, and `Bash(xargs:*)` approved `xargs sh -c 'id'`.
//
// env-as-a-wrapper is removed outright (its prefix cannot be narrowed — it takes an
// arbitrary command as its argument). find/awk/xargs stay allow-listed, because they are
// everyday tools, and deny globs cover the execution forms instead.
const ESC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-esc-'));
fs.mkdirSync(path.join(ESC_HOME, '.claude'), { recursive: true });
fs.writeFileSync(path.join(ESC_HOME, '.claude', 'settings.json'), JSON.stringify({
  permissions: {
    allow: ['Bash(echo:*)', 'Bash(ls:*)', 'Bash(find:*)', 'Bash(awk:*)', 'Bash(wc:*)',
      'Bash(grep:*)', 'Bash(tee:*)', 'Bash(/usr/bin/env bash --version)'],
    deny: ['Bash(find *-exec*)', 'Bash(find *-execdir*)', 'Bash(find *-ok*)',
      'Bash(find *-delete*)', 'Bash(find *-fprintf*)', 'Bash(awk *system(*)',
      'Bash(curl:*)'],
    ask: [],
  },
}));

test('deny globs cover the execution forms of allow-listed spawners', { skip }, () => {
  assert.strictEqual(allowed('echo hi && find . -maxdepth 0 -exec id \\;', ESC_HOME), null);
  assert.strictEqual(allowed('echo hi && find . -execdir id \\;', ESC_HOME), null);
  assert.strictEqual(allowed('echo hi && find . -ok rm {} \\;', ESC_HOME), null);
  assert.strictEqual(allowed('echo hi && find . -delete', ESC_HOME), null);
  assert.strictEqual(allowed('echo hi && find . -fprintf /tmp/x %p', ESC_HOME), null);
  assert.strictEqual(allowed(`echo hi && awk 'BEGIN{system("id")}'`, ESC_HOME), null);
});

// The guards are worthless if they cost the ordinary form of each tool.
test('deny globs leave the everyday form of each spawner allowed', { skip }, () => {
  assert.strictEqual(allowed(`echo hi && find . -name '*.ts'`, ESC_HOME), 'allow');
  assert.strictEqual(allowed('echo hi && find . -type f -maxdepth 2', ESC_HOME), 'allow');
  assert.strictEqual(allowed(`echo hi && awk '{print $1}' f.txt`, ESC_HOME), 'allow');
});

// ---------------------------------------------------------------------------
// Wrappers take a command as an ARGUMENT and exec it, so an allow rule for the wrapper
// approves anything it is handed — matches_any only reads a segment's leading words.
// `xargs python -c '...'` auto-approved on the strength of `Bash(xargs:*)` alone
// (measured 2026-07-29, along with node -e, perl -e and ruby -e).
//
// The hook now resolves a wrapper to the command it will actually run and judges THAT.
// Note what is NOT allow-listed in the fixture above: xargs, timeout, env, nice, nohup.
// Every "allow" below is therefore earned by the INNER command, never by the wrapper.
test('a wrapper is judged on the command it will actually run', { skip }, () => {
  assert.strictEqual(allowed('echo hi | xargs wc -l', ESC_HOME), 'allow');
  assert.strictEqual(allowed('echo hi | xargs -0 -n 1 wc -l', ESC_HOME), 'allow');
  assert.strictEqual(allowed('echo hi && timeout 5 ls', ESC_HOME), 'allow');
  assert.strictEqual(allowed('echo hi && timeout -s KILL 5s ls', ESC_HOME), 'allow');
  assert.strictEqual(allowed('echo hi && env FOO=bar ls', ESC_HOME), 'allow');
  assert.strictEqual(allowed('echo hi && nice -n 10 ls', ESC_HOME), 'allow');
  assert.strictEqual(allowed('echo hi && nohup ls', ESC_HOME), 'allow');
  assert.strictEqual(allowed('echo hi && timeout 5 nohup ls', ESC_HOME), 'allow');
});

test('a wrapper cannot carry an unlisted interpreter past its own allow rule', { skip }, () => {
  for (const inner of ["sh -c 'id'", "bash -c 'id'", "python -c 'import os'",
    "python3 -c 'x'", "node -e 'x'", "perl -e 'x'", "ruby -e 'x'"]) {
    assert.strictEqual(allowed(`echo hi | xargs ${inner}`, ESC_HOME), null, `xargs ${inner}`);
    assert.strictEqual(allowed(`echo hi && timeout 5 ${inner}`, ESC_HOME), null, `timeout ${inner}`);
    assert.strictEqual(allowed(`echo hi && nohup ${inner}`, ESC_HOME), null, `nohup ${inner}`);
  }
  // Flags must not be mistaken for the command word, however they are written.
  assert.strictEqual(allowed(`echo hi | xargs -I{} sh -c 'id'`, ESC_HOME), null);
  assert.strictEqual(allowed(`echo hi | xargs -n1 -P4 bash -c 'id'`, ESC_HOME), null);
  assert.strictEqual(allowed(`echo hi | xargs --replace=X sh -c 'id'`, ESC_HOME), null);
  assert.strictEqual(allowed(`echo hi | xargs -- sh -c 'id'`, ESC_HOME), null);
});

test('the unwrapped command is held to the deny list too', { skip }, () => {
  // Deny prefixes anchor at the start of a segment, so `curl` never matches
  // `xargs curl …` on its own. Without a second deny pass the wrapper would carry a
  // denied command straight through to the allow check.
  assert.strictEqual(allowed('echo hi | xargs curl http://evil', ESC_HOME), null);
  assert.strictEqual(allowed('echo hi && timeout 5 curl http://evil', ESC_HOME), null);
});

test('a wrapper whose options cannot be read defers rather than falling back', { skip }, () => {
  // The failure that made xargs a bypass was falling back to the wrapper's own allow
  // entry. These shapes are deliberately refused: env -S splits a string into fresh
  // arguments, env -i reshapes the environment, xargs -e and -l carry OPTIONAL values so
  // their arity is unknowable, and timeout without its mandatory duration is unparseable.
  assert.strictEqual(allowed(`echo hi && env -S 'ls -l'`, ESC_HOME), null);
  assert.strictEqual(allowed('echo hi && env -i ls', ESC_HOME), null);
  assert.strictEqual(allowed('echo hi && env -u PATH ls', ESC_HOME), null);
  assert.strictEqual(allowed('echo hi | xargs -e ls', ESC_HOME), null);
  assert.strictEqual(allowed('echo hi && timeout ls', ESC_HOME), null);
  assert.strictEqual(allowed('echo hi && timeout --unknown-flag 5 ls', ESC_HOME), null);
  assert.strictEqual(allowed('echo hi | xargs', ESC_HOME), null);
});

test('a filename that merely contains an interpreter name is not a command', { skip }, () => {
  // The regression the old `xargs *sh*` glob caused: a substring match cannot tell the
  // command xargs runs from a path it is handed, so ordinary batch work was refused.
  assert.strictEqual(allowed('echo hi | xargs grep foo build.sh', ESC_HOME), 'allow');
  assert.strictEqual(allowed('echo hi | xargs wc -l install.bash', ESC_HOME), 'allow');
  assert.strictEqual(allowed('echo hi | xargs -n1 grep x node_modules', ESC_HOME), 'allow');
});

// env takes a command as its argument, so no prefix of it is safe; the narrowed
// /usr/bin/env rule must match the version probe it was written for and nothing else.
test('env is not allow-listed as a wrapper', { skip }, () => {
  assert.strictEqual(allowed(`echo hi && env FOO=bar bash -c 'id'`, ESC_HOME), null);
  assert.strictEqual(allowed(`echo hi && /usr/bin/env bash -c 'id'`, ESC_HOME), null);
  assert.strictEqual(allowed('echo hi && /usr/bin/env bash --version', ESC_HOME), 'allow');
});

// ---------------------------------------------------------------------------
// A repo must not be able to widen what is auto-approved. The hook reads the project's
// .claude/settings.json and settings.local.json so there is one source of truth for
// deny/ask, but reading `allow` from them too meant any repo could grant itself whatever
// it liked and merely opening it turned that into an unprompted approval.
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-proj-'));
fs.mkdirSync(path.join(PROJ, '.claude'), { recursive: true });

function writeProject(perms) {
  fs.writeFileSync(path.join(PROJ, '.claude', 'settings.json'), JSON.stringify({ permissions: perms }));
}

test('a project settings file cannot widen the allow list', { skip }, () => {
  writeProject({ allow: ['Bash(frobnicate:*)'] });
  // Unlisted in the user settings, so it must stay a prompt no matter what the repo says.
  assert.strictEqual(allowed('echo hi && frobnicate --wipe /', HOME, PROJ), null);
  // Sanity: the same command is a prompt without the project dir too, so the assertion
  // above is not passing for an unrelated reason.
  assert.strictEqual(allowed('echo hi && frobnicate --wipe /', HOME), null);
});

test('a project settings file can still tighten via deny and ask', { skip }, () => {
  // `ls` is allow-listed in the fixture, so this pins that project deny/ask still bite.
  writeProject({ deny: ['Bash(ls:*)'] });
  assert.strictEqual(allowed('echo hi && ls -la', HOME, PROJ), null);
  writeProject({ ask: ['Bash(ls:*)'] });
  assert.strictEqual(allowed('echo hi && ls -la', HOME, PROJ), null);
  // With neither, the allow-listed pair is approved as before — proves the deny/ask
  // above are what changed the outcome, not the mere presence of a project file.
  writeProject({});
  assert.strictEqual(allowed('echo hi && ls -la', HOME, PROJ), 'allow');
});

// tee writes every path it is handed, with no `>` for the redirection guard to catch.
test('tee is treated as a writer unless its target is harmless', { skip }, () => {
  assert.strictEqual(allowed('echo hi | tee /tmp/pwned', ESC_HOME), null);
  assert.strictEqual(allowed('echo hi | tee -a /tmp/pwned', ESC_HOME), null);
  assert.strictEqual(allowed('echo hi | tee /usr/bin/tee', ESC_HOME), null);
  // Copying to stdout writes nothing, and shows up in real diagnostics.
  assert.strictEqual(allowed('echo hi | tee', ESC_HOME), 'allow');
  assert.strictEqual(allowed('echo hi | tee /dev/null', ESC_HOME), 'allow');
});

// Content guard on the REAL allow list, so the rules above cannot be reintroduced.
// Scoped to the allow array: deny and ask entries legitimately name these commands.
//
// settings.permissions.json, not settings.base.json: the permission model was split out of
// the base template, which now only splices it in by includeTemplate. The two tests below
// assert they located the allow and deny arrays before parsing anything, so pointing this
// at the wrong template fails them rather than silently checking zero rules — but keep it
// pointed at whichever template actually holds the arrays.
const REAL_SETTINGS = path.join(__dirname, '..', '..', 'home', '.chezmoitemplates', 'settings.permissions.json');
// Commands that take another command as an argument. None may be an allow prefix.
// `make` counts: a target's recipe is arbitrary code living in the repo's own Makefile.
const SPAWNERS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'env', 'python', 'python3',
  'node', 'perl', 'ruby', 'eval', 'exec', 'sudo', 'ssh', 'nohup', 'setsid', 'script',
  'entr', 'timeout', 'nice', 'stdbuf', 'watch', 'make', 'xargs'];
// `fnm env` ends in the word `env` but prints shell init text; it never runs an argument.
const NOT_A_SPAWNER = ['fnm env', 'gh run watch'];
// Allow-listed spawners that are guarded by deny globs instead of being removed. xargs is
// deliberately absent: its command word floats after any number of options, so no glob can
// pin it down, and it was removed from allow instead. find and awk stay because their
// execution forms are named flags.
// awk's form is `system` rather than `system(`: a deny glob spelled `Bash(awk *system(*)`
// has unbalanced parens, which the rule parser drops outright — leaving `Bash(awk:*)`
// allow-listed with nothing guarding it. The trailing `(` cannot appear here.
const GUARDED = { find: ['-exec', '-execdir', '-ok', '-delete', '-fprintf'], awk: ['system'] };

function bashPrefixes(block) {
  // Mirror extract_bash_prefixes: drop the Bash(...) wrapper, then a trailing :*, ` *` or *.
  return [...block.matchAll(/"Bash\(([^"]*)\)"/g)]
    .map((m) => m[1].replace(/:\*$/, '').replace(/ \*$/, '').replace(/\*$/, ''));
}

test('no allow rule normalizes to a prefix that takes a command as its argument', () => {
  const src = fs.readFileSync(REAL_SETTINGS, 'utf8');
  const allowStart = src.indexOf('"allow": [');
  const denyStart = src.indexOf('"deny": [');
  assert.ok(allowStart > -1 && denyStart > allowStart, 'located the allow array');
  const prefixes = bashPrefixes(src.slice(allowStart, denyStart));
  assert.ok(prefixes.length > 100, `parsed the allow array (got ${prefixes.length} rules)`);
  const offenders = prefixes.filter((p) => {
    if (NOT_A_SPAWNER.includes(p) || Object.keys(GUARDED).includes(p)) return false;
    const last = p.trim().split(/\s+/).pop().split('/').pop();
    return SPAWNERS.includes(last);
  });
  assert.deepStrictEqual(offenders, [], `allow prefixes ending in a spawner: ${offenders.join(', ')}`);
});

test('each allow-listed spawner that is kept carries its deny globs', () => {
  const src = fs.readFileSync(REAL_SETTINGS, 'utf8');
  const denyStart = src.indexOf('"deny": [');
  const askStart = src.indexOf('"ask": [');
  assert.ok(denyStart > -1 && askStart > denyStart, 'located the deny array');
  const denyBlock = src.slice(denyStart, askStart);
  const allowPrefixes = bashPrefixes(src.slice(src.indexOf('"allow": ['), denyStart));
  for (const [cmd, forms] of Object.entries(GUARDED)) {
    if (!allowPrefixes.includes(cmd)) continue;   // removed from allow entirely: nothing to guard
    for (const form of forms) {
      assert.ok(denyBlock.includes(`"Bash(${cmd} *${form}*)"`),
        `${cmd} is allow-listed, so deny must cover ${form}`);
    }
  }
});

test('every wrapper the hook unwraps is one the allow list is checked against', () => {
  // The unwrapper only helps a COMPOUND command — the hook exits early on anything else,
  // so a bare `xargs python -c …` is judged by the native prefix match alone. A wrapper
  // that gained an allow rule would therefore be a bypass no unwrapping could close, and
  // the test above is what refuses it. Keep the two lists in step.
  const hook = fs.readFileSync(HOOK, 'utf8');
  const listed = hook.match(/^\s*(timeout\|env\|nice\|[a-z|]+)\)\s*;;\s*$/m);
  assert.ok(listed, 'located the wrapper case list in the hook');
  for (const w of listed[1].split('|')) {
    assert.ok(SPAWNERS.includes(w), `hook unwraps "${w}" but SPAWNERS does not list it`);
  }
});

// ---------------------------------------------------------------------------
// Heredoc write parity: `cat > path`/`cat >> path` with a QUOTED delimiter is a Write
// with no expansion possible, so it earns the same auto-approval a Write tool call would
// -- when the path is confined to a scratch root or to the session's own cwd. An
// unquoted delimiter can still carry a live $(...) in its body and stays unjudgeable, and
// every OTHER segment in the chain still has to earn its own allow entry.
const HEREDOC_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-cwd-'));

test('a cat>path heredoc write with a quoted delimiter is allowed under a scratch root', { skip }, () => {
  assert.strictEqual(allowed("cat > /tmp/x.sh <<'EOF'\necho hi\nEOF\n"), 'allow');
  assert.strictEqual(allowed('cat >> /tmp/x.sh <<"EOF"\nmore\nEOF\n'), 'allow');
  assert.strictEqual(allowed("cat > /tmp/x.sh <<'EOF'\necho hi\nEOF\ngit status"), 'allow');
});

test('a cat>path heredoc write with a quoted delimiter is allowed under the session cwd', { skip }, () => {
  assert.strictEqual(allowedAt("cat > notes.md <<'EOF'\nhi\nEOF\n", HEREDOC_CWD), 'allow');
  assert.strictEqual(
    allowedAt(`cat > ${HEREDOC_CWD}/notes.md <<'EOF'\nhi\nEOF\n`, HEREDOC_CWD), 'allow');
});

// The cwd arrives from the hook's `.cwd` input field exactly as the harness wrote it, which
// is not necessarily its physical path -- on macOS $TMPDIR lives under /var, itself a symlink
// to /private/var. The check has to hold whichever form it gets, so it resolves the cwd both
// ways and compares the target against each. A symlinked cwd reproduces that mismatch on any
// platform, which matters because the bug this covers was invisible to Linux CI: the previous
// implementation normalized the target with `realpath -m`, a GNU-only flag, and resolved only
// one side of the comparison.
//
// The target itself stays lexical, so only the two forms the cwd arrives in are recognized. A
// target spelled in a THIRD form -- the physical path, where the cwd came through as the
// symlink -- is refused, and deliberately: resolving it would need it to exist, which is
// exactly the trade-off under_scratch documents and refuses to make.
const HEREDOC_CWD_REAL = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-real-'));
const HEREDOC_CWD_LINK = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-link-')), 'via');
fs.symlinkSync(HEREDOC_CWD_REAL, HEREDOC_CWD_LINK);

test('a heredoc write under a symlinked session cwd is still allowed', { skip }, () => {
  assert.strictEqual(
    allowedAt("cat > notes.md <<'EOF'\nhi\nEOF\n", HEREDOC_CWD_LINK), 'allow');
  assert.strictEqual(
    allowedAt(`cat > ${HEREDOC_CWD_LINK}/notes.md <<'EOF'\nhi\nEOF\n`, HEREDOC_CWD_LINK),
    'allow');
});

// A heredoc body writes inert text -- it is never executed -- so even a body that reads
// like a dangerous command is safe to write, and this only reads 'allow' if cmd_parse
// kept the whole body lifted out rather than splitting it into top-level segments. A
// split would turn "rm -rf /" into its own segment and refuse it on the ask list instead.
test('a heredoc body containing rm -rf / on its own line is not split into segments', { skip }, () => {
  assert.strictEqual(allowed("cat > /tmp/x.sh <<'EOF'\nrm -rf /\nEOF\n"), 'allow');
});

// The stronger discriminating case: a heredoc that is NOT the cat>path write shape (piped
// to stdin here, same as `sh <<EOF`) whose body is entirely allow-listed text. This must
// still defer -- if cmd_parse ever mis-lifted the body into top-level segments instead of
// one opaque blob, "echo hi" and "ls" would each earn their own allow entry and the whole
// chain would read 'allow', which is exactly the false-positive this test exists to catch.
test('a non-write heredoc with an all-allow-listed-looking body still defers', { skip }, () => {
  assert.strictEqual(allowed("cat <<'EOF'\necho hi\nls\nEOF\ngit status"), null);
});

test('heredoc write parity refuses an unquoted delimiter, a path escape, or an unconfined target', { skip }, () => {
  // Unquoted delimiter: body can carry a live $(...), stays unjudgeable regardless of path.
  assert.strictEqual(allowedAt('cat > /tmp/x.sh <<EOF\necho hi\nEOF\n', HEREDOC_CWD), null);
  // .. component, a leading ~, or a leading $ -- refused outright, scratch root or not.
  assert.strictEqual(allowedAt("cat > /tmp/../etc/x <<'EOF'\nhi\nEOF\n", HEREDOC_CWD), null);
  assert.strictEqual(allowedAt("cat > ../etc/passwd <<'EOF'\nhi\nEOF\n", HEREDOC_CWD), null);
  assert.strictEqual(allowedAt("cat > ~/.bashrc <<'EOF'\nhi\nEOF\n", HEREDOC_CWD), null);
  assert.strictEqual(allowedAt("cat > $HOME/x <<'EOF'\nhi\nEOF\n", HEREDOC_CWD), null);
  // Neither scratch nor cwd.
  assert.strictEqual(allowedAt("cat > /etc/passwd <<'EOF'\nhi\nEOF\n", HEREDOC_CWD), null);
  // The write earns its own segment's approval only -- the rest of the chain still has
  // to clear the allow list on its own.
  assert.strictEqual(
    allowedAt("cat > /tmp/x.sh <<'EOF'\nhi\nEOF\nfrobnicate", HEREDOC_CWD), null);
});

// ---------------------------------------------------------------------------
// Benign prefixes: `set -...` is shell-builtin state, not a command, and a leading
// VAR=value assignment takes no action a later segment's judgment needs to see. Neither
// earns or needs its own allow entry; they are stripped and the rest of the segment is
// judged as if they were never there.
test('set -e / set -euo pipefail / set -o pipefail are stripped and the rest of the chain is judged normally', { skip }, () => {
  assert.strictEqual(allowed('set -e && git status && git log --oneline -1'), 'allow');
  assert.strictEqual(allowed('set -euo pipefail && git status'), 'allow');
  assert.strictEqual(allowed('set -o pipefail; git status'), 'allow');
});

test('a set prefix does not rescue an otherwise denied or unlisted segment', { skip }, () => {
  assert.strictEqual(allowed('set -e && frobnicate'), null);
  assert.strictEqual(allowed('set -e && rm -rf build'), null);
});

test('a leading VAR=value assignment is stripped before judging the segment', { skip }, () => {
  // A bare single command, compound or not, is outside this hook's scope entirely (see
  // the "defers for non-compound commands" test) -- the assignment only matters once the
  // command is already a chain, so every case here carries a second segment.
  assert.strictEqual(allowed('FOO=bar git status && git log --oneline -1'), 'allow');
  assert.strictEqual(allowed('FOO=bar BAZ=1 git status && git log'), 'allow');
});

test('a VAR=value assignment whose value can expand or execute is judged as itself, not stripped', { skip }, () => {
  assert.strictEqual(allowed('FOO=$(whoami) git status'), null);
  assert.strictEqual(allowed('FOO=`whoami` git status'), null);
  assert.strictEqual(allowed('FOO=$(echo x) git status && ls'), null);
});

// Stripping the assignment prefix does not resolve $VAR for a LATER segment that uses it
// as an operand -- the bare assignment segment is skipped as a no-op, but the rm
// delegation still cannot see through the variable and refuses on principle.
test('a VAR=value prefix does not resolve $VAR for a later rm operand', { skip }, () => {
  assert.strictEqual(rmAllowed('FOO=/tmp/scratch\nrm -rf $FOO'), null);
});

process.on('exit', () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(ESC_HOME, { recursive: true, force: true });
  fs.rmSync(PROJ, { recursive: true, force: true });
  fs.rmSync(RM_HOME, { recursive: true, force: true });
  fs.rmSync(HEREDOC_CWD, { recursive: true, force: true });
});
