const { test, after } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOKS = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks');
const ACB = path.join(HOOKS, 'executable_allow-compound-bash.sh');
const BDB = path.join(HOOKS, 'executable_block-dangerous-bash.sh');
// In the source tree the library is still `executable_cmdparse.sh`; chezmoi drops the prefix
// on apply, so the hooks' default sibling path is the deployed one. CMDPARSE_LIB is the seam
// that lets the suite point at the source copy — same idiom as IDENTITY_LIB / REAP_LIB.
const LIB = path.join(HOOKS, 'executable_cmdparse.sh');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// cmdparse.sh is sourced as a sibling of the hook, which is how it lands after an apply, so
// the hooks are exercised straight out of the source tree with no staging.
// The suite must own CMDPARSE_SHADOW and CMDPARSE absolutely, so they are stripped from the
// inherited environment rather than merely left unset. Once the flag ships in settings.json
// it is present in every session's env, and a spread of process.env silently handed it to
// the cases asserting the OFF behaviour — which then passed for the wrong reason until the
// flag was actually deployed, and failed the moment it was. A test of "off by default" that
// inherits the ambient value is not testing anything.
const run = (hook, command, env = {}) => {
  const base = { ...process.env, CMDPARSE_LIB: LIB };
  delete base.CMDPARSE_SHADOW;
  delete base.CMDPARSE;
  return execFileSync('bash', [hook], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    env: { ...base, ...env },
  });
};

const logDir = (name) => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const readLog = (d) => {
  const p = path.join(d, 'cmdparse-shadow.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

// The whole point of a shadow slice: it is decision-identical by construction. If this ever
// fails, the census is not a census — it is a live change nobody signed off on.
//
// BDB only: ACB's shadow computation (CMDPARSE_SHADOW toggling a log without changing the
// decision) was retired when cmd_parse became ACB's authoritative segmentation — there is
// no second decision path left to compare against. ACB's own behavioral coverage lives in
// allow-compound-bash.test.js now.
test('shadow mode changes no decision in either hook', () => {
  const cases = [
    'echo hi && ls',
    'git status && ls & rm -rf /',
    'echo start && tee /tmp/scratch-target.txt',
    "jq '.a' f.json; jq '.b' f.json",
    'terraform destroy',
    'echo x\nterraform destroy',
    'echo x\nssh homelab reboot',
    'ls -la',
    "echo 'unterminated",
  ];
  for (const cmd of cases) {
    for (const hook of [BDB]) {
      const off = run(hook, cmd);
      const on = run(hook, cmd, { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: logDir('neutral') });
      assert.strictEqual(on, off, `${path.basename(hook)} changed its decision for ${JSON.stringify(cmd)}`);
    }
  }
});

// The census EXIT trap reads SSH_AT_RE and TF_AT, which used to be defined hundreds of lines
// below the trap install. A command denying before them expanded both unset, and under
// `set -u` that aborts only the pipeline subshell running each `grep` — not the trap. So a
// record was still written, with `newly_anchored` silently null, which is why asserting that
// a record exists proves nothing here. Each case below denies on an early rule while hiding a
// second segment behind a newline that the whole-string rules cannot anchor on, so a census
// that can see past the early deny must name that family.
test('an early deny still censuses the family the whole-string rules missed', () => {
  const cases = [
    ['gh api -XPOST repos/o/r/issues\nterraform destroy', ['terraform']],
    ['gh api -XPOST repos/o/r/issues\nssh homelab reboot', ['ssh']],
  ];
  for (const [cmd, expected] of cases) {
    const d = logDir(`early-deny-${expected[0]}`);
    const out = run(BDB, cmd, { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d });
    assert.strictEqual(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny', cmd);
    const log = readLog(d);
    assert.strictEqual(log.length, 1, cmd);
    assert.deepStrictEqual(log[0].newly_anchored, expected, cmd);
  }
});

test('shadow is off unless CMDPARSE_SHADOW=1, and writes nothing when off', () => {
  const d = logDir('off');
  run(ACB, 'echo hi && ls', { CLAUDE_SHADOW_LOG_DIR: d });
  run(BDB, 'echo hi && ls', { CLAUDE_SHADOW_LOG_DIR: d });
  assert.deepStrictEqual(readLog(d), []);
});

// CMDPARSE=off is the per-slice rollback named in the spec's rollback section.
test('CMDPARSE=off disables the shadow even with CMDPARSE_SHADOW=1', () => {
  const d = logDir('killswitch');
  run(ACB, 'echo hi && ls', { CMDPARSE_SHADOW: '1', CMDPARSE: 'off', CLAUDE_SHADOW_LOG_DIR: d });
  assert.deepStrictEqual(readLog(d), []);
});

// The census of the two verified bypasses: the anchored rules could not see past a newline,
// and per-segment evaluation of the SAME regexes shows which families they missed.
//
// `old` was 'none' when this census was written — that WAS the bypass. It is 'deny' now that
// the anchored rules match against the scan set (SCAN plus one line per segment), so this
// case is no longer a gap in the decision path. The census keeps measuring, and the pairing
// is what makes it worth keeping: newly_anchored is gated on SCAN ALONE, so a row that is
// both `old: deny` and `newly_anchored: [family]` says the segment arm of the union is what
// produced the deny and the whole-string arm would still have missed it. That is the
// adoption working, asserted rather than assumed.
test('the PreToolUse guard denies the families a newline used to hide from it', () => {
  const d = logDir('bdb');
  run(BDB, 'echo x\nterraform destroy', { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d });
  run(BDB, 'echo x\nssh homelab reboot', { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d });
  const rows = readLog(d);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].old, 'deny', 'the newline form is denied now, not missed');
  assert.strictEqual(rows[1].old, 'deny');
  assert.deepStrictEqual(rows[0].newly_anchored, ['terraform'], 'SCAN alone still misses it');
  assert.deepStrictEqual(rows[1].newly_anchored, ['ssh']);
});

// Also a regression test for the census itself: a jq `select()` inside the object
// construction emitted NOTHING when no family was newly anchored, so every row whose answer
// was "no gap here" — including every deny — silently vanished. A census that only records
// its own positives is not a baseline.
test('a command already caught on the whole string is logged, and not double-counted', () => {
  const d = logDir('nodup');
  run(BDB, 'echo x; terraform destroy', { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d });
  const [row] = readLog(d);
  assert.ok(row, 'a deny must still produce a census row');
  assert.strictEqual(row.old, 'deny', 'the separator form is already denied today');
  assert.strictEqual(row.newly_anchored, null, 'so it is not part of the gap being measured');
});

// --- CP_SUBSEG census (block-dangerous-bash.sh only) ---------------------------------------
//
// The rewrite that added CP_SUBSEG made a substitution's interior visible to cmdparse, but
// the shadow census still only walked CP_SEG — so `terraform apply` genuinely running inside
// `echo "$(ls; terraform apply)"` was invisible to it. These cases census CP_SUBSEG too.
//
// Two fields, not one, because SCAN's quote handling is blind to structure: it is one
// unconditional quote-strip over the whole command, so a substitution's content is
// SOMETIMES already exposed to SCAN by accident (verified: the `;` inside the quoted
// substitution above puts terraform in SCAN's command position too, and the command denies
// today on that coincidence, not because anything here changed). newly_anchored_sub keeps
// the same "gap the decision missed" gate as newly_anchored (SCAN did not already match) so
// its count means the same thing across both fields; sub_anchored is ungated and names a
// family found inside a substitution regardless of whether SCAN already caught it elsewhere.
//
// This suite also fixes the SSH_AT_RE/TF_AT anchor bug the census exposed (both were
// missing `(` and/or a backtick, a genuine decision-path bypass -- see
// tests/hooks/block-dangerous-bash.test.js). That fix structurally closes the exact gap
// newly_anchored_sub measures for ssh/terraform, the two families this census covers:
// every CP_SUBSEG entry's text is, by construction, immediately preceded in SCAN by `(`
// or a backtick, and the anchor now includes both -- so whenever the subseg walk finds a
// family, SCAN finds it too. Expect newly_anchored_sub's corpus count to be at or near
// zero; sub_anchored stays informative regardless, since it still names WHERE a match
// originated even when SCAN independently catches it.

// The exact case from the measurement that motivated this change. old is deny already —
// SCAN's blind quote-strip happens to expose the `;` — so newly_anchored_sub is correctly
// null (SCAN already matched); sub_anchored still names terraform as substitution-sourced.
// Do not "fix" this into a newly_anchored_sub hit: that would mean gating on something
// other than SCAN, which breaks what makes the corpus count of newly_anchored_sub meaningful.
test('a substitution match already exposed by SCAN is named, but not double-counted as newly', () => {
  const d = logDir('sub-already-exposed');
  const cmd = 'echo "$(ls; terraform apply)"';
  const off = run(BDB, cmd);
  const on = run(BDB, cmd, { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d });
  assert.strictEqual(on, off, 'shadow mode must not change this decision');
  assert.strictEqual(JSON.parse(off).hookSpecificOutput.permissionDecision, 'deny', 'the real rule already denies this');
  const [row] = readLog(d);
  assert.strictEqual(row.nsubseg, 2);
  assert.strictEqual(row.newly_anchored_sub, null, 'SCAN already matched, so this is not a gap');
  assert.deepStrictEqual(row.sub_anchored, ['terraform']);
});

// UPDATED: this used to be the genuine None -> ['terraform'] case -- TF_AT's anchor was
// missing `(`, so SCAN's blind quote-strip could not put `terraform` in command position
// here. That anchor gap was a real bypass (terraform ran with no decision at all) and was
// fixed separately, at the decision-path level, in the same change that added this
// census (see TF_AT in the hook and tests/hooks/block-dangerous-bash.test.js). Fixing the
// anchor closes the exact gap newly_anchored_sub existed to measure for this command: SCAN
// now denies it directly, same as the already-exposed case above. sub_anchored still names
// terraform as substitution-sourced regardless.
test('a substitution match now caught by the fixed anchor is named, not newly (post-fix)', () => {
  const d = logDir('sub-newly');
  const cmd = 'echo "$(terraform apply)"';
  const off = run(BDB, cmd);
  const on = run(BDB, cmd, { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d });
  assert.strictEqual(on, off, 'shadow mode must not change this decision');
  assert.strictEqual(JSON.parse(off).hookSpecificOutput.permissionDecision, 'deny', 'the fixed anchor now denies this directly');
  const [row] = readLog(d);
  assert.strictEqual(row.nsubseg, 1);
  assert.strictEqual(row.newly_anchored_sub, null, 'SCAN catches it too, post-fix');
  assert.deepStrictEqual(row.sub_anchored, ['terraform']);
});

// SSH_AT_RE's anchor class includes `(`, unlike TF_AT, so a bare ssh substitution is
// already caught by the live ssh-payload rescan below in this same hook (deny), same shape
// as the terraform-already-exposed case above: sub_anchored names it, newly_anchored_sub
// does not, because SCAN already matched.
test('an ssh substitution already denied by the live rule is named but not newly', () => {
  const d = logDir('sub-ssh');
  const cmd = 'x=$(ssh homelab reboot)';
  const off = run(BDB, cmd);
  const on = run(BDB, cmd, { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d });
  assert.strictEqual(on, off, 'shadow mode must not change this decision');
  assert.strictEqual(JSON.parse(off).hookSpecificOutput.permissionDecision, 'deny');
  const [row] = readLog(d);
  assert.strictEqual(row.newly_anchored_sub, null);
  assert.deepStrictEqual(row.sub_anchored, ['ssh']);
});

// A command with no substitution at all must not report a phantom nsubseg or sub hit —
// the newline-gap census (newly_anchored) is untouched by this change.
test('a command with no substitution reports nsubseg 0 and leaves the newline census alone', () => {
  const d = logDir('sub-none');
  run(BDB, 'echo x\nterraform destroy', { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d });
  const [row] = readLog(d);
  assert.strictEqual(row.nsubseg, 0);
  assert.deepStrictEqual(row.newly_anchored, ['terraform'], 'the newline gap this hook already caught');
  assert.strictEqual(row.newly_anchored_sub, null);
  assert.strictEqual(row.sub_anchored, null);
});

// The census reads CP_STATUS and the normalized members from the decision path's parse
// instead of parsing again. A command cmd_parse REFUSES is the case that used to take an
// explicit `else` branch in the census, so it is the one most likely to regress into
// logging a bare default: it must still carry the real refusal reason, and the counts it
// could not compute must be zero rather than stale.
test('a command cmd_parse refuses is censused with its refusal status, not a default', () => {
  const d = logDir('refused');
  run(BDB, 'terraform destroy "unclosed', { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d });
  const [row] = readLog(d);
  assert.ok(row, 'a refusal must still produce a census row');
  assert.match(row.status, /^unreadable:/, 'the reason, not a bare "unreadable"');
  assert.strictEqual(row.nseg, 0);
  assert.strictEqual(row.nsubseg, 0);
  assert.strictEqual(row.newly_anchored, null, 'nothing was segmented, so nothing is newly anchored');
  assert.strictEqual(row.old, 'deny', 'and the whole-string rules still judged it');
});

// The census reads CP_STATUS from the decision path's parse, which is only sound while
// cmd_parse stays its sole writer and nothing calls it in between. That invariant cannot
// break loudly on its own -- a stray cmd_parse leaves every other assertion in this file
// green and just changes what the status column means. So the break is staged here:
// a copy of the hook with a second cmd_parse injected after the scan set is built, fed a
// command the real parse REFUSES. Without the guard the row would claim `ok`, inheriting
// the injected call's success and reporting a clean parse for a command that had none.
test('a stray cmd_parse between the parse and the trap is reported, not inherited', () => {
  const stage = fs.mkdtempSync(path.join(tmp, 'desync-'));
  for (const f of fs.readdirSync(HOOKS)) {
    const src = path.join(HOOKS, f);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(stage, f));
  }
  const hook = path.join(stage, 'executable_block-dangerous-bash.sh');
  const text = fs.readFileSync(hook, 'utf8');
  assert.strictEqual(
    text.split('\nBDB_OLD=none\n').length, 2,
    'injection anchor must be unique, or this test is staging something else',
  );
  fs.writeFileSync(
    hook,
    text.replace('\nBDB_OLD=none\n', '\ncmd_parse "x;y" >/dev/null 2>&1 || true\nBDB_OLD=none\n'),
  );

  const d = logDir('desync');
  const env = { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d, CMDPARSE_LIB: LIB };
  run(hook, 'terraform destroy "unclosed', env);
  const [row] = readLog(d);
  assert.ok(row, 'the row must still be written — the census stays a census');
  assert.match(row.status, /^desync:/, `guard did not fire, status was ${row.status}`);

  // ...and the unstaged hook does not cry wolf on the same command.
  const clean = logDir('desync-control');
  run(BDB, 'terraform destroy "unclosed', {
    CMDPARSE_SHADOW: '1',
    CLAUDE_SHADOW_LOG_DIR: clean,
  });
  const [ctrl] = readLog(clean);
  assert.match(ctrl.status, /^unreadable:/, 'a real refusal is not a desync');
});
