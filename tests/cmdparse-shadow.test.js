const { test, after } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOKS = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks');
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
const run = (hook, command, env = {}) =>
  execFileSync('bash', [hook], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    env: { CMDPARSE_LIB: LIB, ...process.env, ...env },
  });

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

// The census's actual finding, pinned so it cannot be shipped by accident.
//
// A newline-separated chain of individually allow-listed commands is not "compound" to
// today's substring gate, so it never reaches this hook's judgement and falls through to
// native prefix matching, which prompts. Under the shared segmentation the approver DOES
// judge it, both segments are allow-listed, and it would be auto-approved. That is a real
// widening — prompt becomes silent approval — and it is the owner's call, not the parser's.
// Slice 2 must not land until it is signed off.
test('the newline class is the one population that would newly be approved', () => {
  const d = logDir('widening');
  for (const cmd of CORPUS) run(ACB, cmd, { CMDPARSE_SHADOW: '1', CLAUDE_SHADOW_LOG_DIR: d });
  const widened = readLog(d).filter((r) => r.old !== 'allow' && r.new === 'allow');
  assert.deepStrictEqual(widened.map((r) => r.cmd), ['echo hi\nls']);
  assert.strictEqual(widened[0].shadow_only, 1, 'and it is only ever recorded, never emitted');
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
