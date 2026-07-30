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

const HOOK = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_allow-compound-bash.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-'));
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude', 'settings.json'), JSON.stringify({
  permissions: {
    allow: ['Bash(git status:*)', 'Bash(ls:*)', 'Bash(echo:*)', 'Bash(cat:*)',
      'Bash(jq:*)', 'Bash(jsonq:*)', 'Bash(git commit:*)', 'Bash(gh api:*)',
      'Bash(sh:*)',
      // An allow rule with an interior wildcard, to pin that those stay literal.
      'Bash(frob * --safe)'],
    deny: ['Bash(rm:*)', 'Bash(git commit *--no-verify)', 'Bash(* | sh)'],
    ask: ['Bash(git push:*)', 'Bash(gh api *-X DELETE)'],
  },
}));

function allowed(command, home = HOME, projectDir = '') {
  let out;
  try {
    out = execFileSync('bash', [HOOK], {
      input: JSON.stringify({ tool_input: { command } }),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: projectDir },
    });
  } catch (e) { out = e.stdout || ''; }
  if (!out.trim()) return null; // hook deferred to normal handling
  try { return JSON.parse(out).hookSpecificOutput.decision.behavior; } catch { return null; }
}

test('auto-allows a compound command where every part is allow-listed', { skip }, () => {
  assert.strictEqual(allowed('git status && ls -la'), 'allow');
  assert.strictEqual(allowed('echo hi && cat file.txt && ls'), 'allow');
});

test('defers (no decision) for non-compound commands', { skip }, () => {
  assert.strictEqual(allowed('git status'), null);
});

test('defers when any part is denied, ask-listed, or unlisted', { skip }, () => {
  assert.strictEqual(allowed('ls && rm -rf build'), null);          // deny
  assert.strictEqual(allowed('git status && git push origin main'), null); // ask
  assert.strictEqual(allowed('git status && frobnicate'), null);    // unlisted
});

test('defers when a command substitution could smuggle a segment', { skip }, () => {
  assert.strictEqual(allowed('echo $(whoami) && ls'), null);        // command substitution
  assert.strictEqual(allowed('echo `whoami` && ls'), null);         // backticks
  assert.strictEqual(allowed('cat <(curl example.com) && ls'), null); // process substitution
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
const REAL_SETTINGS = path.join(__dirname, '..', 'home', '.chezmoitemplates', 'settings.base.json');
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
const GUARDED = { find: ['-exec', '-execdir', '-ok', '-delete', '-fprintf'], awk: ['system('] };

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

process.on('exit', () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(ESC_HOME, { recursive: true, force: true });
  fs.rmSync(PROJ, { recursive: true, force: true });
});
