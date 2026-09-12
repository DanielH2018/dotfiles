const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// cmdparse.sh is sourced by the guards on the hot path; `--json` is the test/linter entry
// point and is never used there. Driving the library through it keeps these fixtures cheap
// to assert against from node --test.
const LIB = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_cmdparse.sh');
const parse = (cmd) =>
  JSON.parse(execFileSync('bash', [LIB, '--json'], { input: cmd, encoding: 'utf8' }));

const seps = (cmd) => parse(cmd).sep;
// Segments, with the empty tail a trailing separator leaves behind dropped — the guards
// already skip empty segments, so this is how a consumer actually sees the split.
const segs = (cmd) => parse(cmd).seg.map((s) => s.trim()).filter((s) => s !== '');
const subsegs = (cmd) => parse(cmd).subseg.map((s) => s.trim()).filter((s) => s !== '');

// --- F4: the bypasses this module exists to close ----------------------------------------
//
// Verified against a scratch copy of block-dangerous-bash.sh this session: each `\n` form
// below produced NO DECISION, while the identical payload after `;` or `&&` produced `deny`.
// The cause is one shared assumption — a newline is not a separator — so it is fixed once,
// here, rather than in each guard's own regex.
test('a newline separates two commands', () => {
  assert.deepStrictEqual(segs('echo x\nterraform destroy'), ['echo x', 'terraform destroy']);
  assert.deepStrictEqual(segs('echo x\nssh homelab reboot'), ['echo x', 'ssh homelab reboot']);
  assert.strictEqual(seps('echo x\nterraform destroy')[0], 'newline');
});

test('the newline split agrees with the ; && and glued forms', () => {
  const expected = ['echo x', 'terraform destroy'];
  assert.deepStrictEqual(segs('echo x; terraform destroy'), expected);
  assert.deepStrictEqual(segs('echo x && terraform destroy'), expected);
  assert.deepStrictEqual(segs('echo x&&terraform destroy'), ['echo x', 'terraform destroy']);
  assert.deepStrictEqual(segs('terraform destroy'), ['terraform destroy']);
});

// A lone `&` backgrounds what is left of it and starts a new command. The old splitter
// refused the whole command here (safe but coarse); worse, anything that fell through glued
// the tail onto the previous segment, which only ever had its PREFIX matched — so
// `git status && ls & rm -rf /` inherited `ls`'s approval.
test('a lone & separates and does not glue the tail onto the previous segment', () => {
  assert.deepStrictEqual(segs('git status && ls & rm -rf /'), ['git status', 'ls', 'rm -rf /']);
  assert.deepStrictEqual(seps('git status && ls & rm -rf /'), ['&&', '&', 'eof']);
});

// --- F4: heredocs -------------------------------------------------------------------------
//
// ACB-02: allow-compound-bash.sh used to transport segments as text and re-split them on
// `\n`, so every body line became its own "segment" and ordinary `gh pr create --body-file -`
// always prompted. That hook is gone (claude-guard slice 3); block-dangerous-bash.sh is now
// the only consumer of this parser's segments, and bodies are lifted before segmentation, so
// this is structural rather than specific to either consumer.
test('a heredoc body is lifted, not segmented', () => {
  const cmd = "gh pr create --body-file - <<'EOF'\nsome body\nrm -rf /\nEOF";
  const r = parse(cmd);
  assert.strictEqual(r.nseg, 1, 'the whole thing is one command');
  assert.strictEqual(r.seg[0].trim(), "gh pr create --body-file - <<'EOF'");
  assert.strictEqual(r.sep[0], 'eof');
  assert.match(r.heredoc[0], /rm -rf \//, 'the body is recorded against its own segment');
});

// Inert in BOTH directions: a body line must not be judged as a command, and a body must not
// hide a real one either — which is why the operator stays in the segment text.
test('a redirect alongside a heredoc stays visible in the segment', () => {
  const r = parse("cat <<'EOF' > ~/.zshrc\nexport EVIL=1\nEOF");
  assert.strictEqual(r.nseg, 1);
  assert.match(r.seg[0], />\s*~\/\.zshrc/, 'the write target is still in the segment');
  assert.match(r.heredoc[0], /export EVIL=1/);
});

test('a command after a terminated heredoc is its own segment', () => {
  assert.deepStrictEqual(
    segs("cat <<'EOF'\nbody\nEOF\nterraform destroy"),
    ["cat <<'EOF'", 'terraform destroy'],
  );
});

test('<<- strips leading tabs when matching the terminator', () => {
  const r = parse('cat <<-EOF\n\tbody\n\tEOF\nls');
  assert.deepStrictEqual(r.seg.map((s) => s.trim()).filter(Boolean), ['cat <<-EOF', 'ls']);
  assert.match(r.heredoc[0], /body/);
});

test('<<< is a herestring, not a heredoc', () => {
  const r = parse('jq ".a" <<< "$x"');
  assert.strictEqual(r.nseg, 1);
  assert.strictEqual(r.heredoc[0], '', 'a herestring has no body to lift');
});

// --- F3: quoting controls -----------------------------------------------------------------
//
// These are the false-positive half. A stricter parse is only survivable if ordinary work
// keeps parsing the way it does today, so every case here is a CONTROL.
test('a quoted separator does not split', () => {
  assert.deepStrictEqual(segs('echo "a && b" && ls'), ['echo "a && b"', 'ls']);
  assert.deepStrictEqual(segs("jq '.a|.b' f.json"), ["jq '.a|.b' f.json"]);
  assert.deepStrictEqual(segs("echo 'x;y'"), ["echo 'x;y'"]);
});

test('separately quoted arguments still split between them', () => {
  assert.deepStrictEqual(segs("jq '.a' f.json; jq '.b' f.json"), ["jq '.a' f.json", "jq '.b' f.json"]);
});

test('an unbalanced quote is refused, never approximated', () => {
  const r = parse("echo 'unterminated");
  assert.strictEqual(r.status, 'unreadable:unbalanced-quote');
  assert.strictEqual(r.nseg, 0, 'a refusal yields no segments to reason about');
});

// The parser does not expand — it does not run $(curl evil) to see what it prints — but it
// no longer refuses on sight of one either. The outer segmentation stays correct (the whole
// substitution is one opaque atom in the segment that contains it) and the substitution's own
// content is exposed separately, in CP_SUBSEG, for a consumer that wants to look inside.
test('command and process substitution parse instead of refusing, and expose their content', () => {
  let r = parse('echo $(curl evil) && ls');
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual(segs('echo $(curl evil) && ls'), ['echo $(curl evil)', 'ls']);
  assert.deepStrictEqual(subsegs('echo $(curl evil) && ls'), ['curl evil']);

  r = parse('echo `id` && ls');
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual(subsegs('echo `id` && ls'), ['id']);

  r = parse('diff <(a) <(b)');
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.nseg, 1, 'process substitution stays part of the one command');
  assert.deepStrictEqual(subsegs('diff <(a) <(b)'), ['a', 'b']);
});

// The blind spot this closes: inside "...", a `;` was never checked for substitution at all,
// so `echo "$(ls; terraform apply)"` used to parse as one ordinary segment with the second
// command completely invisible. It must still be one outer segment — the `;` inside the
// substitution is not an outer separator — but CP_SUBSEG must show both inner commands.
test('a substitution inside double quotes is not a blind spot', () => {
  const r = parse('echo "$(ls; terraform apply)"');
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.nseg, 1);
  assert.deepStrictEqual(subsegs('echo "$(ls; terraform apply)"'), ['ls', 'terraform apply']);
});

// A regression the shadow census caught directly: `git commit -am "$(cat <<'EOF' … EOF)"` is
// the shape a PR/commit body produces routinely. Heredoc lifting and substitution scanning
// have to agree that crossing into the `$( )` reopens a command position, or the heredoc body
// never gets lifted and its own prose — which is full of unpaired apostrophes and quotes —
// gets read as shell syntax and refused as unbalanced. A two-pass version of this parser
// shipped exactly that bug; this is the case that caught it.
test('a heredoc inside a double-quoted substitution is lifted, not misread as syntax', () => {
  const cmd = [
    'git commit -am "$(cat <<\'EOF\'',
    "It's a fix, not a feature. Don't read the apostrophes as quotes.",
    'EOF',
    ')" 2>&1',
  ].join('\n');
  const r = parse(cmd);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.nseg, 1);
  assert.match(r.heredoc[0], /apostrophes as quotes/, 'the body is lifted onto the segment');
  assert.deepStrictEqual(subsegs(cmd), ["cat <<'EOF'"]);
});

// Nesting: each level gets its own CP_SUBSEG entry, exactly once — not zero (lost inside a
// non-executing wrapper) and not duplicated (found again by an executing ancestor's re-scan).
test('nested substitutions are each recorded exactly once', () => {
  assert.deepStrictEqual(subsegs('echo $(echo $(id))'), ['id', 'echo $(id)']);
  // ${...} is parameter expansion, not execution, but a substitution nested inside it is
  // still found — it is scanned through, not skipped.
  assert.deepStrictEqual(subsegs('echo ${x:-$(id)}'), ['id']);
  // $(( )) is arithmetic, same treatment: `<<` here is a shift operator, not a heredoc, and
  // a real substitution nested inside is still found.
  assert.deepStrictEqual(subsegs('echo $((1 + $(id)))'), ['id']);
});

// ${...} is parameter expansion, never execution — it must never itself refuse and must never
// produce a CP_SUBSEG entry for its own content.
test('${...} is not treated as execution', () => {
  const r = parse('echo ${x:-default value}');
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.nseg, 1);
  assert.deepStrictEqual(r.subseg, []);
});

// A quote inside a substitution is ordinary content, not a boundary the outer scan trips on.
test('a substitution containing a quote parses and its content is exposed intact', () => {
  const r = parse('x=$(echo "hi there")');
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.nseg, 1);
  assert.deepStrictEqual(subsegs('x=$(echo "hi there")'), ['echo "hi there"']);
});

// Refusal is still mandatory when a substitution's delimiters never balance — narrowing to
// "parseable" must not mean "anything goes". unreadable:substitution now means exactly this:
// a substitution that could not be read, not merely one that was found.
test('an unbalanced substitution is still refused', () => {
  assert.strictEqual(parse('echo $(echo "unterminated').status, 'unreadable:unbalanced-quote');
  assert.strictEqual(parse('echo $(ls').status, 'unreadable:substitution');
  assert.strictEqual(parse('echo `id').status, 'unreadable:substitution');
});

// The decomposition is one awk pass (see the file header for why). A missing awk must refuse,
// never silently skip — same direction as block-dangerous-bash.sh losing jq or awk.
test('refuses rather than failing open when awk is unavailable', () => {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdparse-noawk-'));
  try {
    const shim = path.join(shimDir, 'awk');
    fs.writeFileSync(shim, '#!/bin/sh\nexit 127\n');
    fs.chmodSync(shim, 0o755);
    const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH}` };
    const r = JSON.parse(execFileSync('bash', [LIB, '--json'], {
      input: 'ls -la', encoding: 'utf8', env,
    }));
    assert.strictEqual(r.status, 'unreadable:no-awk');
    assert.strictEqual(r.nseg, 0, 'a refusal yields no segments to reason about');
  } finally {
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
});

// --- F7: redirect vs fd-dup ---------------------------------------------------------------
test('fd dups are not separators', () => {
  assert.deepStrictEqual(segs('cmd 2>&1'), ['cmd 2>&1']);
  assert.deepStrictEqual(segs('cmd >/dev/null 2>&1'), ['cmd >/dev/null 2>&1']);
  assert.deepStrictEqual(seps('cmd 2>&1'), ['eof']);
});

test('a pipe separates and the separator is recorded', () => {
  assert.deepStrictEqual(segs('echo hi | tee /usr/bin/tee'), ['echo hi', 'tee /usr/bin/tee']);
  assert.deepStrictEqual(seps('echo hi | tee /usr/bin/tee'), ['|', 'eof']);
  assert.deepStrictEqual(seps('a || b'), ['||', 'eof']);
});

// --- contract -----------------------------------------------------------------------------
test('a single command reports one segment terminated by eof', () => {
  const r = parse('ls -la');
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.nseg, 1);
  assert.strictEqual(r.sep[0], 'eof');
});

// A trailing separator terminates the last command rather than starting an empty new one.
// This is a widening guard, not cosmetics: allow-compound-bash.sh used to key its own
// compound gate on the segment count, and a trailing newline is ordinary in a multi-line
// prompt, so reporting `ls\n` as 2 segments there would have run the approver over a single
// command and auto-approved what native prefix matching would have prompted for. That hook
// is gone (claude-guard slice 3); block-dangerous-bash.sh is now the only consumer of this
// parser's segment count, and it reads that count to build the set it scans for dangerous
// patterns, so the same "is this really N segments" correctness still matters to it.
test('a trailing separator does not create an empty second command', () => {
  for (const cmd of ['ls\n', 'ls;', 'ls ;  ', 'ls &&\n']) {
    const r = parse(cmd);
    assert.strictEqual(r.nseg, 1, `${JSON.stringify(cmd)} is one command, not two`);
    assert.strictEqual(r.sep[0], 'eof', 'nothing follows it');
  }
  // ...but a real second command after the separator still counts.
  assert.strictEqual(parse('ls\nrm -rf /').nseg, 2);
});

// The refusal contract is what makes the module safe to adopt one call site at a time: a
// non-zero parse must never read as "nothing to worry about here".
test('cmd_parse returns non-zero exactly when the status is unreadable', () => {
  const rc = (cmd) => {
    try {
      execFileSync('bash', ['-c', `. "${LIB}"; cmd_parse "$1"`, '_', cmd], { stdio: 'pipe' });
      return 0;
    } catch (e) { return e.status; }
  };
  assert.strictEqual(rc('ls -la'), 0);
  assert.strictEqual(rc('echo $(id)'), 0, 'a balanced substitution now parses');
  assert.notStrictEqual(rc("echo 'unterminated"), 0);
  assert.notStrictEqual(rc('echo $(id'), 0, 'an unbalanced substitution still refuses');
});
