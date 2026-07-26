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

function allowed(command) {
  let out;
  try {
    out = execFileSync('bash', [HOOK], {
      input: JSON.stringify({ tool_input: { command } }),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME, CLAUDE_PROJECT_DIR: '' },
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

process.on('exit', () => fs.rmSync(HOME, { recursive: true, force: true }));
