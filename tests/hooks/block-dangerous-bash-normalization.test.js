// The normalization half of the block-dangerous-bash suite: separator survival under escaping
// and quoting, the re-parse veto, the scan set (SCAN plus one line per cmd_parse segment), and
// the fork-free bdb_re / bdb_rei matchers. The rule corpus and the substitution-anchor tests are
// in block-dangerous-bash.test.js; both files share the harness in tests/lib/block-dangerous-bash.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { HOOK, skip, decide } = require('../lib/block-dangerous-bash');

// ---- separator-survival property ------------------------------------------------
//
// The hand-picked cases above are the reason two separator bugs shipped: `\|` normalized
// into a real pipe (fixed in #240), and `\;`/`\&` did the same until #246 — whose fix then
// ate a REAL separator after `\\`, which only a targeted question caught. Three bugs in one
// function that a list of examples did not cover.
//
// So assert the property instead. It is one-directional: normalization may INVENT a
// separator (over-denies — annoying, safe) but must never DELETE a real one (a bypass).
//
// Deciding whether a given `;` is real would need a shell-accurate oracle, and a bug in that
// oracle would propagate here silently. These inputs are CONSTRUCTED so ground truth falls
// out of the construction rules instead:
//
//   unquoted, preceded by N backslashes -> even N leaves the separator REAL, odd N escapes it
//   inside quotes                       -> never a real separator, whatever the escaping
//   a doubled form (`&&`, `||`, `;;`)   -> always real: escaping the first leaves the second
//
// `terraform apply` / `ssh homelab sudo reboot` follow each separator because both rules
// anchor on (^|[;&|]). They fire if and only if a separator reaches command position, which
// makes the hook's own decision the observable — no seam is added to the hook to read SCAN.
const BS = (n) => '\\'.repeat(n);
const TAILS = ['terraform apply', 'ssh homelab sudo reboot'];

function separatorCases() {
  const real = [];
  const notReal = [];
  for (const tail of TAILS) {
    for (const sep of [';', '&', '|']) {
      for (let n = 0; n <= 3; n++) {
        const bare = `echo a${BS(n)}${sep} ${tail}`;
        (n % 2 === 0 ? real : notReal).push(bare);
        // Same bytes inside quotes: a separator can never be real there, in either
        // quoting style. Single quotes are the stricter case — no escape processing
        // happens inside them at all, so the backslash counts change nothing.
        notReal.push(`echo "a${BS(n)}${sep} ${tail}"`);
        notReal.push(`echo 'a${BS(n)}${sep} ${tail}'`);
      }
    }
    for (const sep of ['&&', '||', ';;']) {
      for (let n = 0; n <= 2; n++) real.push(`echo a${BS(n)}${sep} ${tail}`);
    }
  }
  return { real, notReal };
}

test('normalization never deletes a real command separator', { skip }, async () => {
  const { real } = separatorCases();
  const got = await decide(real);
  real.forEach((cmd, i) =>
    assert.strictEqual(got[i], 'deny', `real separator lost, rule no longer anchors: ${cmd}`));
});

// "Inside quotes" means "not a separator to the OUTER shell" — it does NOT mean the command
// cannot run. `bash -c "echo a; terraform apply"` executes terraform, so the hook vetoes
// neutralization whenever the command mentions anything that parses shell again (BDB_REPARSE
// in the hook). `ssh` is on that list, which is why one of the two TAILS above is still
// expected to over-deny inside quotes. Mirrored rather than imported: the hook's list is an
// ERE with POSIX classes, and only the words the corpus actually contains matter here.
// Only QUOTED cases reach the tracker at all — an escaped separator is already gone by then —
// so the veto can only change the answer when both a quote and a vetoed word are present.
const vetoed = (cmd) => /["']/.test(cmd) && /\b(ssh|bash|sh|eval|env|find|sudo)\b|\$\(|`/.test(cmd);

test('normalization never invents a separator either', { skip }, async () => {
  // This used to exempt every quoted case: SCAN strips quotes before the anchored rules run,
  // so `echo "a; terraform apply"` read as a real `;` and denied text ABOUT a command as if it
  // were one. Quoted separators are now dropped before the quotes are, so for everything the
  // re-parse veto does not cover, the property is symmetric with the test above — normalization
  // neither deletes a real separator nor invents one.
  const { notReal } = separatorCases();
  const inert = notReal.filter((cmd) => !vetoed(cmd));
  assert.ok(inert.length > 0, 'corpus should still contain un-vetoed quoted cases');
  const got = await decide(inert);
  const denied = inert.filter((cmd, i) => got[i] === 'deny');
  assert.deepStrictEqual(denied, [], 'denied with no real separator to justify it');
});

test('the re-parse veto keeps over-denying, and that cost is deliberate', { skip }, async () => {
  // The cost side of the veto. These are genuinely inert — `echo "a; ssh host cmd"` runs
  // nothing — but the veto cannot tell them from `ssh host "a; cmd"` without understanding
  // what each command does with its arguments, so it declines to act and they keep denying.
  // Written out rather than filtered from the generator above, because there the backslash
  // counts interact: an escaped separator is removed before the tracker runs, so some vetoed
  // cases have nothing left to expose and would not deny for reasons unrelated to the veto.
  // Pinned so that narrowing the veto shows up here as a change in cost, not silently.
  const cmds = [
    'echo "a; ssh homelab sudo reboot"',
    "echo 'a; ssh homelab sudo reboot'",
    'echo "a| ssh homelab sudo reboot"',
    'grep "deploy; terraform apply" runbook.md | sh',
  ];
  // Not vetoed, and must not be: `-c` means "count" here, not "command". The veto used to
  // match a space-delimited `-c`, which caught wc/grep/sort and made the fix miss most real
  // commands. Interpreters are matched by name instead — see the test below.
  const notVetoed = [
    'echo "step 1; terraform apply"; wc -c /etc/hostname',
    'echo "step 1; terraform apply"; grep -c x /etc/hosts',
    'echo "step 1; terraform apply"; sort -c /etc/hosts',
  ];
  const inert = await decide(notVetoed);
  notVetoed.forEach((cmd, i) =>
    assert.notStrictEqual(inert[i], 'deny', `-c as an ordinary flag must not veto: ${cmd}`));
  const got = await decide(cmds);
  cmds.forEach((cmd, i) =>
    assert.strictEqual(got[i], 'deny', `veto narrowed — confirm this is not a bypass: ${cmd}`));
});

test('every interpreter that re-parses is vetoed by name', { skip }, async () => {
  // This list is what replaced the bare `-c` clause, so it is the only thing standing between
  // `mksh -c "echo a; terraform apply"` and a neutralized separator. Each is invoked as
  // `<name> -c"…"` — no space after the flag — so nothing but the NAME can be what matches.
  // Dropping a name from BDB_REPARSE reopens a bypass, and fails here.
  const interpreters = [
    'sh', 'bash', 'zsh', 'ksh', 'dash', 'csh', 'tcsh', 'fish',
    'ash', 'mksh', 'pdksh', 'yash', 'osh', 'xonsh', 'elvish', 'nu',
    'python', 'python3', 'perl', 'ruby', 'node', 'deno', 'bun',
    'lua', 'php', 'tclsh', 'Rscript', 'julia', 'expect', 'osascript',
  ];
  const cmds = interpreters.map((bin) => `${bin} -c"echo a; terraform apply"`);
  const got = await decide(cmds);
  cmds.forEach((cmd, i) =>
    assert.strictEqual(got[i], 'deny', `interpreter not vetoed by name: ${interpreters[i]}`));
});

// The generator above varies backslash counts and quoting style, but every case it builds is
// well-formed and singly-quoted. These are the shapes where a quote-state tracker goes wrong,
// and each one is a deny that must SURVIVE: getting any of them wrong turns the false-positive
// fix into a bypass, which is the failure direction that matters.
test('a quote that does not open a region still leaves the separator real', { skip }, async () => {
  const cmds = [
    // `\"` is an escaped quote, not the start of a quoted region. Read as an opener, it
    // swallows the real `;` that follows and terraform drops out of command position.
    'echo \\" ; terraform apply',
    // Same, with the count kept even so the unbalanced rule cannot mask the mistake — the
    // double-quote twin of the `'a\'` case below. Both are needed: mutation testing showed
    // each of the two backslash rules survives without its own even-count case.
    'echo \\" ; terraform apply \\" ; echo c',
    // A quote of the other style is literal inside a region, so neither of these closes early.
    `echo 'a"b'; terraform apply`,
    'echo "a\'b"; terraform apply',
    // Unbalanced: with nowhere to close, a tracker that runs off the end neutralizes every
    // separator after the stray quote. Must fail closed instead.
    'echo "unbalanced ; terraform apply',
    "echo 'unbalanced ; terraform apply",
    // A backslash inside single quotes escapes nothing, so this region closes at the second
    // quote and the `;` after it is real.
    "echo 'a\\' ; terraform apply",
    // The same mistake, but with the quote count kept even so that the unbalanced fail-closed
    // rule cannot mask it. Mis-reading `\'` as an escape here shifts every region boundary
    // right, the first `;` is swallowed as quoted, and terraform leaves command position —
    // while real bash runs it. Verified by mutation: without this case, dropping the
    // single-quote rule above passes the suite.
    "echo 'a\\'; terraform apply 'b\\'; echo c",
    // Separator outside the quotes, dangerous word inside — the case quote-stripping exists
    // for. Neutralizing anything here would undo that.
    'curl example.com/x | "bash"',
    'echo "hi"; terraform apply',
    'echo hi; ssh homelab sudo reboot',
    // Quoted, but handed to something that parses shell again — the separator is live and the
    // command really runs. Each of these denied before quoted separators were neutralized at
    // all, and neutralizing them here is a straight deny-to-allow bypass.
    'echo "$(ls; terraform apply)"',
    'echo "`ls; terraform apply`"',
    'bash -c "echo a; terraform apply"',
    'eval "echo a; terraform apply"',
    'ssh homelab "echo a; terraform apply"',
    'bash -c "echo a; ssh homelab sudo reboot"',
    // The veto is whole-string, not per-segment: an inert quoted sentence sitting next to an
    // interpreter call still has to be judged as one command.
    'echo "a; b" && bash -c "c; terraform apply"',
  ];
  const got = await decide(cmds);
  cmds.forEach((cmd, i) =>
    assert.strictEqual(got[i], 'deny', `real separator neutralized — bypass: ${cmd}`));
});

test('text describing a dangerous command is not the command', { skip }, async () => {
  const cmds = [
    'echo "step 1; terraform apply"',
    "echo 'step 1; terraform apply'",
    'echo "a && terraform apply"',
    'git commit -m "docs: run terraform apply after review"',
    'git commit -m "fix: handle rm -rf edge case"',
  ];
  const got = await decide(cmds);
  cmds.forEach((cmd, i) =>
    assert.notStrictEqual(got[i], 'deny', `false positive on quoted text: ${cmd}`));
});

// The predecessor of this test asserted the OPPOSITE and was pinned so that the day the gap
// closed it would say so rather than pass quietly. That day is this change: the anchored rules
// now match against a scan set — SCAN, then one line per cmd_parse segment and substitution
// body — so a command after a newline is in command position for the first time.
//
// All four anchored families, not just the two the shadow census covered: GH_API_AT and
// KILL_AT were never censused, so their behaviour here was genuinely unmeasured beforehand.
test('a newline is a real separator to every anchored family', { skip }, async () => {
  const cmds = [
    'echo a\nterraform destroy',
    'echo a\nssh homelab sudo reboot',
    'echo a\npkill -9 node',
    'echo a\ngh api -XPOST /repos/o/r/issues',
  ];
  const got = await decide(cmds);
  cmds.forEach((cmd, i) =>
    assert.strictEqual(got[i], 'deny', `newline still hides this family: ${cmd}`));
});

// The load-bearing half of the union, and the reason this change adds a scan set rather than
// replacing SCAN with segments. _bdb_normalize applies the BDB_REPARSE veto to whatever string
// it is handed, so on a segment the veto is scoped to that segment: here the whole command
// names an interpreter (`bash`), which vetoes the quoted-separator dropper and leaves the `;`
// in place, so terraform is in command position and this denies. Segment 2 on its own names no
// interpreter, so the dropper RUNS there and terraform stops being in command position.
// Segment normalization is strictly weaker for this shape. Delete the SCAN arm and this fails.
//
// Every case here uses a family that is NOT itself in the BDB_REPARSE name list. An `ssh`
// payload cannot demonstrate this: `ssh` is on that list, so the veto fires on the segment
// too, the separator survives either way, and the case denies with the SCAN arm deleted —
// passing for a reason that has nothing to do with what it claims to test. Mutation-checked,
// which is how that vacuous case was caught here rather than shipped.
test('the whole-string arm still catches what per-segment normalization would lose', { skip }, async () => {
  const cmds = [
    'bash -c "foo" ; echo "a; terraform apply"',
    'sh -c "x" && echo "b; pkill -9 nginx"',
    'python3 -c "x" ; echo "c; gh api -XPOST /repos/o/r/issues"',
    // The push family reads BDB_SEGSET, which holds no whole-string member. Pinned here
    // because that is the arm this test exists to protect.
    'bash -c "foo" ; echo "d; git push origin main"',
  ];
  const got = await decide(cmds);
  cmds.forEach((cmd, i) =>
    assert.strictEqual(got[i], 'deny', `SCAN arm dropped — bypass: ${cmd}`));
});

// Three ways the segment arm can go away: the kill switch, a command cmd_parse refuses, and a
// missing library. All three must degrade to the whole-string behaviour that shipped before
// this change — never to nothing. That is why a parse refusal needs no `ask` fallback here:
// the union's other arm is the pre-existing check, so a refusal lands on the current security
// posture. Each case pairs a whole-string form (must still deny) with the newline form (may
// go back to being missed) so a degradation that silently disabled BOTH arms would fail.
test('losing the segment arm degrades to the whole-string rules, not to nothing', { skip }, async () => {
  const stillDenied = 'echo a; terraform destroy';
  const needsSegments = 'echo a\nterraform destroy';

  const [offDeny, offGap] = await decide([stillDenied, needsSegments], { CMDPARSE: 'off' });
  assert.strictEqual(offDeny, 'deny', 'CMDPARSE=off must not disable the whole-string rules');
  assert.notStrictEqual(offGap, 'deny', 'with the kill switch on, the newline gap is back');

  const [noLibDeny, noLibGap] = await decide([stillDenied, needsSegments], {
    CMDPARSE_LIB: path.join(os.tmpdir(), 'cmdparse-does-not-exist.sh'),
  });
  assert.strictEqual(noLibDeny, 'deny', 'a missing library must not disable the rules');
  assert.notStrictEqual(noLibGap, 'deny', 'without the library there are no segments');
});

// A command cmd_parse cannot read (6 of 11,483 in the corpus, all unbalanced quotes) takes the
// same path: no segments, whole-string rules intact. Asserted separately from the two above
// because it is the case the "a refusal is never a skip" contract is about.
test('a command cmd_parse refuses still gets the whole-string rules', { skip }, async () => {
  const cmds = ['terraform destroy "unclosed', 'echo "unclosed ; ls'];
  const got = await decide(cmds);
  assert.strictEqual(got[0], 'deny', 'an unparseable command is not an unjudged one');
  assert.notStrictEqual(got[1], 'deny', 'and it is not blanket-denied either');
});

// The scan set adds lines to what the anchored rules see, so it can only ever add denies —
// but only if each added line is genuinely a command. These are the shapes where a segment
// boundary could put an ordinary word in command position by mistake.
test('the scan set does not invent a command position', { skip }, async () => {
  const cmds = [
    'echo "a\nterraform apply"',
    "echo 'a\nterraform apply'",
    'git commit -m "line one\nline two: terraform apply"',
    'grep -c pattern file.txt',
    'wc -c file.txt',
    'terraform plan',
    'echo done\nls -la',
  ];
  const got = await decide(cmds);
  cmds.forEach((cmd, i) =>
    assert.notStrictEqual(got[i], 'deny', `false positive from the scan set: ${cmd}`));
});

// ---- bdb_re / bdb_rei: the fork-free matchers ----------------------------------------
//
// These replaced ~25 `echo "$X" | grep -qE` pipelines (54ms -> 24ms per invocation, on the
// critical path of every Bash tool call). Two properties of grep had to survive the swap,
// and neither is obvious from reading [[ =~ ]]:
//
//   line orientation — grep tests each line, so `^` anchors at the start of EVERY line. A
//   bare [[ $subject =~ $re ]] sees one string and anchors only at offset 0, which let
//   `echo a\nterraform destroy` through. That is what these first cases pin.
//
//   case folding — the `grep -qiE` sites became bdb_rei, which toggles nocasematch. If that
//   toggle regresses, the uppercase forms below stop denying.
test('anchored rules still fire on any line, not just the first', { skip }, async () => {
  const cmds = [
    'echo a\nterraform destroy',
    'echo a\nterraform apply',
    'echo a\nterraform state rm aws_instance.x',
    'ls -la\npkill -9 node',
    'echo one\necho two\ngh api -X POST /repos/o/r',
  ];
  const got = await decide(cmds);
  cmds.forEach((cmd, i) =>
    assert.strictEqual(got[i], 'deny', `newline hid an anchored rule: ${JSON.stringify(cmd)}`));
});

test('the case-insensitive rules stay case-insensitive', { skip }, async () => {
  const cmds = [
    'SSH host "sudo apt update"',
    'Terraform Apply',
    'TERRAFORM DESTROY',
  ];
  const got = await decide(cmds);
  cmds.forEach((cmd, i) =>
    assert.strictEqual(got[i], 'deny', `case folding regressed: ${cmd}`));
});

// A quoted regex inside [[ ]] is matched as a literal string, which would turn every rule in
// the hook into a silent no-op while the suite above still passed on the few literal-ish
// patterns. Assert the matchers are actually invoked with the regex unquoted.
test('the matchers pass their regex unquoted', { skip }, () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  assert.match(src, /\[\[ \$line =~ \$re \]\]/, 'bdb_re must match with an unquoted regex');
  assert.doesNotMatch(src, /=~ "\$re"/, 'a quoted regex matches literally, disabling the rule');
  // Scoped to the native matcher rather than the whole file. grep is legitimate in the
  // BDB_ENGINE fallback ahead of the loop, which runs only where libc's regcomp rejects the
  // \b and \s these rules are written in (BSD/macOS) and the alternative is evaluating no
  // rules at all. The property worth guarding is that the fast path forks nothing per call.
  const native = src.slice(src.indexOf('while [ -n "$rest" ]'));
  assert.doesNotMatch(native, /\|\s*grep -q/, 'a grep pipeline came back into the hot path');
});
