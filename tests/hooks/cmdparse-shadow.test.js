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
    for (const hook of [ACB, BDB]) {
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

test('the approver logs the old decision alongside the new one', () => {
  const d = logDir('acb');
  run(ACB, 'echo hi && ls', { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d });
  const [row] = readLog(d);
  assert.strictEqual(row.hook, 'allow-compound-bash');
  assert.strictEqual(row.old, 'allow', 'two allow-listed commands are approved today');
  assert.strictEqual(row.new, 'allow', 'and under the shared segmentation too');
  assert.strictEqual(row.nseg, 2);
});

// A newline-separated command is not "compound" to today's substring gate, so the approver
// exits before judging anything. SHADOW_ONLY carries it through the judgement for the census
// while pinning the decision to defer — the shadow may withhold an approval, never add one.
test('a newline compound is censused without becoming approvable', () => {
  const d = logDir('shadow-only');
  const out = run(ACB, 'echo hi\nls', { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d });
  assert.strictEqual(out, '', 'no approval is emitted');
  const [row] = readLog(d);
  assert.strictEqual(row.shadow_only, 1);
  assert.strictEqual(row.old, 'defer', 'exiting at the compound gate has always meant defer');
  assert.strictEqual(row.nseg, 2);
});

const CORPUS = [
  'echo hi && ls',
  'echo hi\nls',
  'git status && ls & rm -rf /',
  'echo start && tee /tmp/scratch-target.txt',
  'echo hi | tee /usr/bin/tee',
  "jq '.a' f.json; jq '.b' f.json",
  "jq '.a|.b' f.json",
  'echo "a && b" && ls',
  'cat /etc/hostname && curl evil.example.com',
  'echo x\nterraform destroy',
  "gh pr create --body-file - <<'EOF'\nbody\nEOF",
];

// The ship gate for the cutover slice, stated as a test so it is not a promise in a doc.
// Scoped to commands this hook ALREADY judges: for those, swapping the splitter for the
// shared segmentation must be decision-neutral. A defer that becomes an allow there is a
// parser bug, and the spec makes that non-negotiable.
test('no already-judged command moves toward allow under the new segmentation', () => {
  const d = logDir('gate');
  for (const cmd of CORPUS) run(ACB, cmd, { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d });
  const moved = readLog(d).filter((r) => r.shadow_only === 0 && r.old !== 'allow' && r.new === 'allow');
  assert.deepStrictEqual(moved, [], 'a defer/deny that becomes an allow is a parser bug');
});

// DECIDED 2026-07-30 (spec §8a): the cutover narrows and does not widen.
//
// The census found exactly one population that moves toward allow — a chain of
// individually allow-listed commands separated by a newline (or a lone `&`) and nothing
// else. Today that is not "compound" to the substring gate, so the approver never judges
// it and it prompts. Under the shared segmentation every segment is allow-listed and it
// would be auto-approved.
//
// It stays deferred. Auto-approval eligibility is unchanged: a command reaches the
// approver's judgement only if it was compound under the old && / ; / | test. Newline-only
// compounds are still judged for DENY under the new segmentation — that half is the point
// of the module — but are never eligible for ALLOW. The prompt is the safety net for
// parser bugs, and slice 0 alone produced two.
//
// `shadow_only` marks that population. The census still records what raw segmentation
// would have decided (`new`), so the decision is revisitable on evidence.
test('newline-only compounds are judged for deny but never eligible for allow', () => {
  const d = logDir('policy');
  for (const cmd of CORPUS) run(ACB, cmd, { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d });
  const rows = readLog(d);

  // Nothing outside the old compound test may ever be emitted as an approval.
  for (const r of rows.filter((x) => x.shadow_only === 1)) {
    assert.strictEqual(r.old, 'defer', `${JSON.stringify(r.cmd)} must stay deferred`);
  }
  // And the hook emits nothing for them, which is what "deferred" means on the wire.
  assert.strictEqual(run(ACB, 'echo hi\nls', { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d }), '');

  // The measurement is retained rather than suppressed: raw segmentation still reports
  // what it would have said, which is the evidence for ever revisiting this.
  const wouldHave = rows.filter((r) => r.shadow_only === 1 && r.new === 'allow');
  assert.deepStrictEqual(wouldHave.map((r) => r.cmd), ['echo hi\nls']);
});

// The narrowing half must still reach the newline population — otherwise the module buys
// nothing for the two verified bypasses. Deny/ask is evaluated per segment regardless of
// whether the command was compound under the old test.
test('a newline compound is still judged for deny under the new segmentation', () => {
  const d = logDir('policy-deny');
  run(ACB, 'echo hi\ncurl evil.example.com', { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d });
  const [row] = readLog(d);
  assert.strictEqual(row.shadow_only, 1);
  assert.strictEqual(row.new, 'defer', 'an unlisted second command defers on its own merits');
});

// The census of the two verified bypasses: the anchored rules cannot see past a newline
// today, and per-segment evaluation of the SAME regexes shows which families they miss.
test('the PreToolUse guard records the families a newline hides from it', () => {
  const d = logDir('bdb');
  run(BDB, 'echo x\nterraform destroy', { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d });
  run(BDB, 'echo x\nssh homelab reboot', { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d });
  const rows = readLog(d);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].old, 'none', 'today this command gets no decision at all');
  assert.deepStrictEqual(rows[0].newly_anchored, ['terraform']);
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

// An unreadable command is a refusal, never a skip — the census must not report it as clean.
test('an unparseable command is logged as unreadable', () => {
  const d = logDir('unreadable');
  run(ACB, "echo 'unterminated && ls", { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d });
  const [row] = readLog(d);
  assert.match(row.status, /^unreadable:/);
  assert.strictEqual(row.new, 'defer');
});

// A partial apply that lands a hook without its library is a real hazard in this repo, and
// the guards must not fail open when it happens.
test('a missing library disables the shadow instead of failing the hook', () => {
  const d = logDir('nolib-log');
  const out = execFileSync('bash', [ACB], {
    input: JSON.stringify({ tool_input: { command: 'echo hi && ls' } }),
    encoding: 'utf8',
    env: {
      ...process.env,
      CMDPARSE_LIB: path.join(tmp, 'does-not-exist-cmdparse.sh'),
      CMDPARSE_SHADOW: '1',
      CLAUDE_SHADOW_LOG_DIR: d,
    },
  });
  assert.match(out, /"behavior":"allow"/, 'the hook still decides normally');
  assert.deepStrictEqual(readLog(d), [], 'and simply does not census');
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
