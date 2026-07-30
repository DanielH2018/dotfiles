const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const path = require('node:path');

// cmdparse.sh is sourced by the guards on the hot path; `--json` is the test/linter entry
// point and is never used there. Driving the library through it keeps these fixtures cheap
// to assert against from node --test.
const LIB = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_cmdparse.sh');
const parse = (cmd) =>
  JSON.parse(execFileSync('bash', [LIB, '--json'], { input: cmd, encoding: 'utf8' }));

const seps = (cmd) => parse(cmd).sep;
// Segments, with the empty tail a trailing separator leaves behind dropped — the guards
// already skip empty segments, so this is how a consumer actually sees the split.
const segs = (cmd) => parse(cmd).seg.map((s) => s.trim()).filter((s) => s !== '');

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
// ACB-02: allow-compound-bash.sh transports segments as text and re-splits them on `\n`, so
// every body line became its own "segment" and ordinary `gh pr create --body-file -` always
// prompted. Bodies are lifted before segmentation, so this is structural now.
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

// The parser does not expand, so it must not pretend to have read the command.
test('command and process substitution are refused', () => {
  assert.strictEqual(parse('echo $(curl evil) && ls').status, 'unreadable:substitution');
  assert.strictEqual(parse('echo `id` && ls').status, 'unreadable:substitution');
  assert.strictEqual(parse('diff <(a) <(b)').status, 'unreadable:substitution');
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
// This is a widening guard, not cosmetics: allow-compound-bash.sh keys its compound gate on
// the segment count, and a trailing newline is ordinary in a multi-line prompt. Reporting
// `ls\n` as 2 segments would run the approver over a single command and auto-approve what
// native prefix matching would have prompted for.
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
  assert.notStrictEqual(rc("echo 'unterminated"), 0);
  assert.notStrictEqual(rc('echo $(id)'), 0);
});
