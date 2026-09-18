// Regression guard for home/dot_local/bin/executable_claude-transcript-scan.
//
// The scanner is the detection half of the credential-leak problem: the Bash guard denies a
// command before it runs, but a `grep` that happens to print a line CARRYING a key names no
// secret path and no decrypt verb, and no hook can rewrite a tool result after the fact. So
// this is the only layer that sees that class at all, and the thing it must never do is
// report clean when it did not actually look.
//
// Every case below is a pair: one input that must be FLAGGED and one near-miss that must
// stay CLEAN. A detector is only ever observed passing, so without the flagged half there is
// no evidence it can fail — the failure mode this repo has paid for twice.
//
// The token in the dirty fixture is synthetic and has never been a credential. It has to be
// high-entropy: gitleaks discards a low-entropy candidate, and a `ghp_AAAA...` fixture
// reported clean against a working scanner during development.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { have, skipUnless } = require('./lib/probe');

// The one synthetic token that must NOT be allowlisted, generated per run rather than
// written down. A committed literal PROPAGATES: any session that reads this file copies it
// into its own transcript, and the next sweep flags it there forever. That is measured, not
// theoretical — the two allowlisted fixtures below did exactly that on 2026-08-29, and the
// first version of the un-allowlisted one reintroduced the same defect within an hour of the
// commit that fixed it, in four transcripts.
//
// Allowlisting is not available here: this token's whole job is to prove the allowlist is
// not so wide that it swallows every github-pat. So it is generated instead, and lives only
// in the transcript of the run that made it, which ages out of the scan window.
//
// 36 characters from a 62-symbol alphabet. The entropy floor is the thing to get right —
// gitleaks discards low-entropy candidates, which is how a `ghp_AAAA…` fixture once reported
// clean against a working scanner — and a random draw at this length clears it with margin.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function syntheticPat() {
  return 'ghp_' + Array.from(crypto.randomBytes(36), (b) => ALPHABET[b % ALPHABET.length]).join('');
}

const SCANNER = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_claude-transcript-scan');

// gitleaks is not installed system-wide; prek fetches it into its own cache. Resolve it the
// same way the scanner does, and skip rather than fail when the cache has not been populated
// (a fresh clone that has never run `prek`).
function findGitleaks() {
  try { return execFileSync('bash', ['-c', 'command -v gitleaks'], { encoding: 'utf8' }).trim(); } catch { /* fall through */ }
  const base = path.join(os.homedir(), '.cache', 'prek', 'hooks');
  try {
    for (const d of fs.readdirSync(base)) {
      const c = path.join(base, d, 'bin', 'gitleaks');
      if (fs.existsSync(c)) return c;
    }
  } catch { /* no cache */ }
  return '';
}
const GITLEAKS = findGitleaks();
const skip = GITLEAKS && skipUnless('bash', 'jq');

const DIRTY = [
  { type: 'user', message: { role: 'user', content: 'hello' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'GITHUB_TOKEN=ghp_9tQz3XbW7kR2mYvL8pJdN4sH6cF1aE0uG5iT' }] } },
].map((o) => JSON.stringify(o)).join('\n') + '\n';

const CLEAN = [
  { type: 'user', message: { role: 'user', content: 'hello' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ran the tests, all 22 pass' }] } },
].map((o) => JSON.stringify(o)).join('\n') + '\n';

// Every sandbox is removed when the file finishes. bin/sweep-test-tmp collects what a suite
// leaves behind, but only six hours later, and tests/sweep-test-tmp.test.js fails a suite
// that relies on it — scratch is the suite's to clean up on a clean run.

function sandbox() {
  const dir = scratch(os.tmpdir(), 'transcript-scan-');
  const projects = path.join(dir, 'projects', '-fixture');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, 'dirty.jsonl'), DIRTY);
  fs.writeFileSync(path.join(projects, 'clean.jsonl'), CLEAN);
  // glConfig is a path, not a file: the tests that want the narrowed ruleset write it, and
  // the fallback test deliberately leaves it absent.
  return {
    dir, projects,
    log: path.join(dir, 'leaks.jsonl'),
    baseline: path.join(dir, 'baseline.txt'),
    glConfig: path.join(dir, 'gitleaks.toml'),
    // Same shape for the Loki arm: absent unless a test points it at the shipped file.
    // Left unset, the scanner would read the operator's deployed copy under $HOME and the
    // suite would measure this machine rather than the repo.
    glLokiConfig: path.join(dir, 'gitleaks-loki.toml'),
    // Load-bearing, not decoration. The scanner appends to this file on every finding, and
    // these fixtures deliberately produce findings — left unset it defaults to the real
    // ~/.claude/logs/transcript-leaks-pending, so a suite run would raise a credential
    // banner in the operator's next session out of a test fixture.
    pending: path.join(dir, 'pending.tsv'),
  };
}

function run(args, sb, extraEnv = {}) {
  // Loki is scanned by default, and this file is hermetic. A transcript test that reached
  // a real Loki -- or failed on a missing otelq -- would be testing the machine it ran on,
  // so everything opts out unless it asked for the Loki arm by name.
  const wantsLoki = args.some((a) => a === '--loki');
  const argv = wantsLoki ? args : ['--no-loki', ...args];
  return spawnSync('bash', [SCANNER, ...argv], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_TRANSCRIPT_ROOT: path.join(sb.dir, 'projects'),
      CLAUDE_TRANSCRIPT_LEAK_LOG: sb.log,
      CLAUDE_TRANSCRIPT_LEAK_BASELINE: sb.baseline,
      CLAUDE_TRANSCRIPT_GITLEAKS_CONFIG: sb.glConfig,
      CLAUDE_TRANSCRIPT_GITLEAKS_LOKI_CONFIG: sb.glLokiConfig,
      CLAUDE_TRANSCRIPT_LEAK_PENDING: sb.pending,
      GITLEAKS_BIN: GITLEAKS,
      ...extraEnv,
    },
  });
}

test('a transcript carrying a credential is flagged', { skip }, () => {
  const sb = sandbox();
  const r = run(['--session', path.join(sb.projects, 'dirty.jsonl')], sb);
  assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /github-pat/, 'the finding names the rule that matched');
});

test('a transcript without one is clean', { skip }, () => {
  const sb = sandbox();
  const r = run(['--session', path.join(sb.projects, 'clean.jsonl')], sb);
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stdout, /github-pat/);
});

test('the finding never carries the secret itself', { skip }, () => {
  const sb = sandbox();
  run(['--session', path.join(sb.projects, 'dirty.jsonl')], sb);
  const logged = fs.readFileSync(sb.log, 'utf8');
  // A detector that prints what it found is a second copy of the leak, in a file that is
  // not itself scanned. --redact is what prevents that, and this is its regression guard.
  assert.doesNotMatch(logged, /ghp_9tQz/, 'the log must not repeat the token');
  assert.match(logged, /"secret":"\[redacted\]"/);
  assert.match(logged, /"rule":"github-pat"/);
});

test('the window sweep reaches both fixtures and flags only the dirty one', { skip }, () => {
  const sb = sandbox();
  const r = run(['--since', '1'], sb);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /2 source\(s\) scanned/, 'both fixtures were scanned');
  // Count findings, not substring hits: each emitted record names the rule twice, once in
  // `rule` and once inside `fingerprint`.
  assert.strictEqual((fs.readFileSync(sb.log, 'utf8').match(/"rule":"github-pat"/g) || []).length, 1,
    'exactly one finding');
});

test('a missing gitleaks reports could-not-evaluate, never clean', { skip: (have('bash') && have('jq')) ? false : skip }, () => {
  const sb = sandbox();
  // The whole point of exit 3. Reporting 0 here would make an unrunnable detector
  // indistinguishable from a clean machine, which is the failure this file exists to stop.
  const r = spawnSync('bash', [SCANNER, '--session', path.join(sb.projects, 'dirty.jsonl')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '/usr/bin:/bin', GITLEAKS_BIN: '/nonexistent', HOME: sb.dir, CLAUDE_TRANSCRIPT_ROOT: path.join(sb.dir, 'projects') },
  });
  assert.strictEqual(r.status, 3, `expected exit 3, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stdout, /clean/);
});

// The baseline exists because the first real sweep returned 52 findings across 82
// transcripts, 45 of them gitleaks' `generic-api-key` firing on a k8s `secretKeyRef:` field
// name. A daily unit that goes red every day on noise gets muted, and then it caps nothing.
// The pair below is the whole contract: it must suppress what was accepted, and it must
// still report what was not.
test('an accepted finding stops being reported', { skip }, () => {
  const sb = sandbox();
  const accept = run(['--since', '1', '--accept-baseline'], sb);
  assert.strictEqual(accept.status, 0);
  assert.ok(fs.existsSync(sb.baseline), 'the baseline file is written');

  const after = run(['--since', '1'], sb);
  assert.strictEqual(after.status, 0, 'a fully baselined sweep is not a failure');
  // "nothing new" must not read as "nothing found" — a baseline nobody can see is one
  // nobody trusts, and then it suppresses something that mattered.
  assert.match(after.stdout, /no new findings/);
  assert.match(after.stdout, /1 already baselined/);
});

test('a finding the baseline does not cover is still reported', { skip }, () => {
  const sb = sandbox();
  run(['--since', '1', '--accept-baseline'], sb);
  // A second, different credential appears after the baseline was taken.
  fs.writeFileSync(path.join(sb.projects, 'newleak.jsonl'),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'GITHUB_TOKEN=ghp_4kM8vB2nQ7wR5xT9zY1cD3fH6jL0pS8uA2eG' }] } }) + '\n');
  const r = run(['--since', '1'], sb);
  assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /1 new finding/);
});

test('the fingerprint keys on content, not on line position', { skip }, () => {
  const sb = sandbox();
  run(['--session', path.join(sb.projects, 'dirty.jsonl'), '--accept-baseline'], sb);
  // Prepending a record renumbers every line of the extracted stream. gitleaks' own
  // Fingerprint is `:<rule>:<line>` and would stop matching here; hashing the matched line
  // survives it. Compaction does exactly this to a real transcript.
  const shifted = JSON.stringify({ type: 'user', message: { role: 'user', content: 'padding' } }) + '\n' + DIRTY;
  fs.writeFileSync(path.join(sb.projects, 'dirty.jsonl'), shifted);
  const r = run(['--session', path.join(sb.projects, 'dirty.jsonl')], sb);
  assert.strictEqual(r.status, 0, `a renumbered but unchanged finding must stay baselined: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /no new findings/);
});

// The narrowed ruleset is the answer to the drip: the baseline clears the backlog, but live
// sessions keep producing fresh `generic-api-key` matches — 4 in the two minutes after the
// first baseline was accepted — because that rule matches entropy alone. The pair below is
// its contract: it must drop the noise and must NOT drop a real token shape. `secretKeyRef:`
// is a real line from the 2026-08-29 sweep, not an invented one.
const NARROW = '[extend]\nuseDefault = true\ndisabledRules = ["generic-api-key"]\n';
const SHIPPED = path.join(__dirname, '..', 'home', 'dot_config', 'gitleaks', 'transcript-scan.toml');
const NOISE = JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: '  secretKeyRef:\n    name: sonarr-exportarr\n  api_key: "a7Kq93MnZx2WvBc8LpRt5YdH4FgJ6sEu"' }] },
}) + '\n';

test('the narrowed ruleset drops entropy-only noise', { skip }, () => {
  const sb = sandbox();
  const p = path.join(sb.projects, 'noise.jsonl');
  fs.writeFileSync(p, NOISE);
  fs.writeFileSync(sb.glConfig, NARROW);
  const r = run(['--session', p], sb);
  assert.strictEqual(r.status, 0, `expected clean, got ${r.status}: ${r.stdout}${r.stderr}`);
});

test('--paranoid puts the entropy rule back', { skip }, () => {
  const sb = sandbox();
  const p = path.join(sb.projects, 'noise.jsonl');
  fs.writeFileSync(p, NOISE);
  fs.writeFileSync(sb.glConfig, NARROW);
  const r = run(['--session', p, '--paranoid'], sb);
  assert.strictEqual(r.status, 1, `expected a finding under --paranoid: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /generic-api-key/);
});

test('narrowing does not drop a real token shape', { skip }, () => {
  const sb = sandbox();
  fs.writeFileSync(sb.glConfig, NARROW);
  const r = run(['--session', path.join(sb.projects, 'dirty.jsonl')], sb);
  assert.strictEqual(r.status, 1, 'github-pat must still fire under the narrowed set');
  assert.match(fs.readFileSync(sb.log, "utf8"), /"rule":"github-pat"/,
    "the machine-readable record lives in the log, not on stdout");
});

test('a missing ruleset falls back to the full set rather than refusing', { skip }, () => {
  const sb = sandbox();
  const p = path.join(sb.projects, 'noise.jsonl');
  fs.writeFileSync(p, NOISE);
  // sb.glConfig deliberately not written. This is the OPPOSITE direction from a missing
  // gitleaks: no gitleaks means the question was never asked, no config means it was asked
  // too broadly. Over-reporting is recoverable by reading; under-reporting is not.
  const r = run(['--session', p], sb);
  assert.strictEqual(r.status, 1, 'the full set still finds it');
  assert.match(r.stderr, /falling back to gitleaks' full set/);
});

// The SHIPPED ruleset, not a sandbox copy. A fixture token in a committed file PROPAGATES:
// any session that reads this very file copies the token into its own transcript, and the
// next sweep flags it there. Measured 2026-08-29 — six github-pat findings in a different
// session's transcript, every one of them a line of this file. So the shipped config
// allowlists the two literals, and this pair keeps that allowlist honest: the first half
// fails if a fixture changes without the config, the second fails if the allowlist is ever
// widened into something that swallows real tokens too.
test("the shipped ruleset does not flag the suite's own fixtures", { skip }, () => {
  assert.ok(fs.existsSync(SHIPPED), 'the shipped ruleset is where the scanner expects it');
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.projects, 'newleak.jsonl'),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'GITHUB_TOKEN=ghp_4kM8vB2nQ7wR5xT9zY1cD3fH6jL0pS8uA2eG' }] } }) + '\n');
  const r = run(['--since', '1'], sb, { CLAUDE_TRANSCRIPT_GITLEAKS_CONFIG: SHIPPED });
  assert.strictEqual(r.status, 0, `the fixtures must not read as leaks: ${r.stdout}${r.stderr}`);
});

test('the shipped ruleset still catches a token that is not a fixture', { skip }, () => {
  const sb = sandbox();
  const p = path.join(sb.projects, 'real.jsonl');
  // A third synthetic token, deliberately NOT allowlisted — without this half, an allowlist
  // that swallowed every github-pat would pass the test above just as well. Generated per
  // run so it never becomes a committed literal; see syntheticPat above for why.
  fs.writeFileSync(p, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `GITHUB_TOKEN=${syntheticPat()}` }] } }) + '\n');
  const r = run(['--session', p], sb, { CLAUDE_TRANSCRIPT_GITLEAKS_CONFIG: SHIPPED });
  assert.strictEqual(r.status, 1, `expected a finding: ${r.stdout}${r.stderr}`);
  assert.match(fs.readFileSync(sb.log, "utf8"), /"rule":"github-pat"/,
    "the machine-readable record lives in the log, not on stdout");
});

// --- the Loki store ------------------------------------------------------------------
// otelq is stubbed throughout: these tests are about what the scanner does with a slice,
// not about Loki. The stub answers every slice with the same payload.
function stubOtelq(sb, payload) {
  const bin = path.join(sb.dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const stub = path.join(bin, 'otelq');
  fs.writeFileSync(stub, `#!/bin/sh\ncat <<'JSON'\n${payload}\nJSON\n`);
  fs.chmodSync(stub, 0o755);
  // Load-bearing, not setup noise. With no config on disk the scanner falls back to
  // gitleaks' FULL set for every arm, which would make "the Loki arm uses the full set"
  // pass without the two arms differing at all. Writing NARROW is what puts the daily
  // ruleset in play and makes that contrast real.
  fs.writeFileSync(sb.glConfig, NARROW);
  // --loki scans BOTH stores, and the shared sandbox ships a transcript that trips a rule
  // on purpose. Pointing the transcript root at an empty directory is what makes these
  // assertions about the Loki arm rather than about that fixture.
  const empty = path.join(sb.dir, 'no-transcripts');
  fs.mkdirSync(empty, { recursive: true });
  return { PATH: `${bin}:${process.env.PATH}`, CLAUDE_TRANSCRIPT_ROOT: empty };
}

function lokiPayload(...streams) {
  return JSON.stringify({
    status: 'success',
    data: { resultType: 'streams', result: streams.map((st) => ({ stream: st })) },
  });
}

// An unstructured NAME=<32 hex> assignment: the shape every *arr API key takes, and the
// only shape `generic-api-key` catches. Built here rather than written literally so the
// suite carries no string that reads like a real credential.
const ENTROPY_ONLY = `FIXTURE_KEY=${'0123456789abcdef'.repeat(2)}`;

test('a credential in a Loki slice is flagged, keyed to the loki store', { skip }, () => {
  const sb = sandbox();
  const env = stubOtelq(sb, lokiPayload({
    // syntheticPat(), not a literal: gitleaks discards low-entropy candidates, so a
    // repeated-character fixture reports clean against a working scanner.
    tool_parameters: `{"full_command":"curl -H \\"Authorization: token ${syntheticPat()}\\""}`,
  }));
  const r = run(['--loki', '--since', '1'], sb, env);
  assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /github-pat/, 'the finding names the rule that matched');
  assert.match(fs.readFileSync(sb.log, "utf8"), /"fingerprint":"github-pat:loki:/,
    'the fingerprint names the store, so accepting a transcript finding cannot suppress it');
});

test('a clean Loki slice raises nothing', { skip }, () => {
  const sb = sandbox();
  const env = stubOtelq(sb, lokiPayload({ prompt: 'deploy the monitor-bridge role please' }));
  const r = run(['--loki', '--since', '1'], sb, env);
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stdout, /github-pat/);
});

test('the Loki arm runs the FULL ruleset, not the narrowed daily one', { skip }, () => {
  // The whole reason this arm exists. `generic-api-key` is disabled for the transcript run
  // because it produced 45 false positives there, and it is the only rule matching the
  // shape above -- which is the shape of the real leak that went undetected for two days.
  // Scanning Loki with $GL_RULES would find exactly the same nothing.
  const sb = sandbox();
  const env = stubOtelq(sb, lokiPayload({ tool_parameters: `{"full_command":"${ENTROPY_ONLY}"}` }));
  const r = run(['--loki', '--since', '1'], sb, env);
  assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /generic-api-key/,
    'the entropy rule must be live here even though the daily config disables it');
});

// The shipped Loki ruleset is the full set plus allowlists for two public-text shapes that
// were re-logged on every run between 2026-09-03 and 2026-09-13 (127 of the 247 rows in the
// pending set triaged on 2026-09-18). The pair below keeps those allowlists honest in both
// directions: the first half fails if either shape starts reporting again, the second if an
// allowlist is ever widened until it swallows the `api_key=<hex>` shape the arm exists for.
const SHIPPED_LOKI = path.join(__dirname, '..', 'home', 'dot_config', 'gitleaks', 'transcript-scan-loki.toml');

// The two shapes as they reached Loki: a signed-commit summary carrying an ED25519 key
// fingerprint, and an Edit old_string carrying a docstring that says "token: `<name>`".
// The fingerprint is a real SHA-256 digest of a fixed string, so it is deterministic and
// still carries the entropy of a real fingerprint; a repeated-character stand-in would sit
// under gitleaks' floor and make the "bare set flags it" half pass for the wrong reason.
function sshFingerprint() {
  return crypto.createHash('sha256').update('claude-transcript-scan fixture key').digest('base64').slice(0, 43);
}
const SIGNED_COMMIT_SUMMARY = () =>
  `**Commit:** signed (verified: \`Good 'git' signature with ED25519 key SHA256:${sshFingerprint()}\`).`;
const KEBAB_IN_PROSE = '"pi" must be its own hyphen-delimited token: `pihole-k8s-dns` contains it';

test('the shipped Loki ruleset drops the two measured public-text shapes', { skip }, () => {
  assert.ok(fs.existsSync(SHIPPED_LOKI), 'the shipped Loki ruleset is where the scanner expects it');
  const sb = sandbox();
  const env = stubOtelq(sb, lokiPayload(
    { prompt: SIGNED_COMMIT_SUMMARY() },
    { tool_input: JSON.stringify({ file_path: '/x/y.py', old_string: KEBAB_IN_PROSE }) },
  ));
  const r = run(['--loki', '--since', '1'], sb, { ...env, CLAUDE_TRANSCRIPT_GITLEAKS_LOKI_CONFIG: SHIPPED_LOKI });
  assert.strictEqual(r.status, 0, `public text must not read as a leak: ${r.stdout}${r.stderr}`);
});

test('the bare default set DOES flag those shapes, so the allowlists are doing the work', { skip }, () => {
  // Without this half, an allowlist that matched nothing would pass the test above just as
  // well, because the fixtures might simply be below the entropy floor.
  const sb = sandbox();
  const env = stubOtelq(sb, lokiPayload(
    { prompt: SIGNED_COMMIT_SUMMARY() },
    { tool_input: JSON.stringify({ file_path: '/x/y.py', old_string: KEBAB_IN_PROSE }) },
  ));
  const r = run(['--loki', '--since', '1'], sb, env);
  assert.strictEqual(r.status, 1, `expected the bare set to flag both: ${r.stdout}${r.stderr}`);
  const log = fs.readFileSync(sb.log, 'utf8');
  assert.strictEqual((log.match(/"rule":"generic-api-key"/g) || []).length, 2,
    'both shapes must fire on the bare set, or the pair proves less than it claims');
});

test('the shipped Loki ruleset still flags an api_key on a URL', { skip }, () => {
  // The shape of the real 2026-09-09 leak: the jellyfin key as a query string on a curl
  // line. The same all-sixteen-symbols hex as ENTROPY_ONLY, not random bytes: 32 random hex
  // characters dip under gitleaks' 3.5 entropy floor about one run in ten (measured: the
  // first pre-push of this test failed that way), and a fixture that flakes proves nothing.
  const sb = sandbox();
  const hex = '0123456789abcdef'.repeat(2);
  const env = stubOtelq(sb, lokiPayload({
    tool_input: JSON.stringify({ command: `curl -sk 'https://jellyfin.example/emby/Sessions?api_key=${hex}'` }),
  }));
  const r = run(['--loki', '--since', '1'], sb, { ...env, CLAUDE_TRANSCRIPT_GITLEAKS_LOKI_CONFIG: SHIPPED_LOKI });
  assert.strictEqual(r.status, 1, `expected a finding: ${r.stdout}${r.stderr}`);
  assert.match(fs.readFileSync(sb.log, 'utf8'), /"rule":"generic-api-key"/,
    'the entropy rule must survive the allowlists');
});

test('the same shape in a TRANSCRIPT still goes unflagged, which is why the arm exists', { skip }, () => {
  // The rejecting half of the pair above. If this starts failing, generic-api-key was
  // re-enabled for the daily run, the two arms no longer differ, and the comment
  // justifying the split has gone stale.
  const sb = sandbox();
  fs.writeFileSync(sb.glConfig, NARROW);
  fs.writeFileSync(path.join(sb.projects, 'arr.jsonl'),
    `${JSON.stringify({ type: 'user', message: { content: ENTROPY_ONLY } })}\n`);
  const r = run(['--session', path.join(sb.projects, 'arr.jsonl')], sb);
  assert.strictEqual(r.status, 0, `expected the narrowed ruleset to MISS it, got ${r.status}`);
});

test('a slice at the entry cap is a failure, never a clean scan', { skip }, () => {
  // Loki refuses limit > 5000, so a slice returning exactly the cap has been truncated.
  // Under-reporting is the one failure this tool cannot recover from, so a capped slice
  // must not be able to produce a clean verdict.
  const sb = sandbox();
  const streams = Array.from({ length: 5000 }, () => ({ prompt: 'ordinary text' }));
  const env = stubOtelq(sb, lokiPayload(...streams));
  const r = run(['--loki', '--since', '1'], sb, env);
  assert.match(r.stderr, /hit the 5000-entry cap/, 'a truncated slice must say so');
  assert.ok(fs.existsSync(sb.pending), 'and must leave the could-not-evaluate marker');
});

test('a slice under the cap leaves no truncation marker', { skip }, () => {
  const sb = sandbox();
  const env = stubOtelq(sb, lokiPayload({ prompt: 'ordinary text' }));
  const r = run(['--loki', '--since', '1'], sb, env);
  assert.doesNotMatch(r.stderr, /entry cap/, 'nothing was truncated, so nothing may claim it was');
  assert.strictEqual(r.status, 0);
});

test('a missing otelq reports could-not-evaluate, never clean', { skip }, () => {
  const sb = sandbox();
  const bin = path.join(sb.dir, 'emptybin');
  fs.mkdirSync(bin, { recursive: true });
  const r = run(['--loki', '--since', '1'], sb, { PATH: `${bin}:/usr/bin:/bin` });
  assert.strictEqual(r.status, 3, `expected exit 3, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /otelq unavailable/);
});

test('every verdict names the stores it covered', { skip }, () => {
  // "clean across 37 source(s)" cannot be told apart from a scan that skipped a whole
  // store. For one day --loki lived only in the systemd unit, so a hand-run scan covered
  // transcripts alone and printed exactly that -- a clean verdict for a store it never
  // opened, which is the could-not-run-reads-as-clean failure this tool exists to prevent.
  const sb = sandbox();
  const env = stubOtelq(sb, lokiPayload({ prompt: 'ordinary text' }));
  assert.match(run(['--loki', '--since', '1'], sb, env).stdout, /in transcripts\+loki/);
});

test('--no-loki says so in the verdict rather than looking complete', { skip }, () => {
  // The rejecting half: opting out must be visible in the output, or the escape hatch
  // recreates the trap it exists to make explicit.
  const sb = sandbox();
  const r = run(['--no-loki', '--session', path.join(sb.projects, 'clean.jsonl')], sb);
  assert.match(r.stdout, /scanned in transcripts\./, 'the verdict covers transcripts alone');
  // Naming the skip is the point -- "Loki skipped (--no-loki)" is the opposite of the
  // silent partial coverage this test guards. What must never appear is loki inside the
  // list of stores the verdict claims to have covered.
  assert.match(r.stdout, /Loki skipped/, 'the skip is stated, not silent');
  assert.doesNotMatch(r.stdout, /scanned in transcripts\+loki/,
    'a skipped store must not appear as covered');
});

test('an hourly slice asks for an hourly WIDTH, not a window back to now', { skip }, () => {
  // The bug that made this whole area wrong. --since is the window WIDTH and --until moves
  // its END, so a slice is `--since <width> --until Nh`. It read `--since ${h}h` until
  // 2026-08-31, making slice 30 a THIRTY-hour window ending 29h ago -- every slice
  // re-scanned everything newer than it. Two abutting slices returned an identical 4858
  // entries against an authoritative 4130 for the whole 30h period.
  const src = fs.readFileSync(SCANNER, 'utf8');
  assert.match(src, /--stream --since 70m --until "\$\{until_h\}h"/,
    'the width must be a fixed slice width, never the distance back to now');
  assert.ok(!/--since "\$\{h\}h" --until/.test(src),
    'the superseded form must be gone');
});

test('a finding reached twice in one run is counted once', { skip }, () => {
  // Slices overlap by ten minutes on purpose, because each query computes `now` when it
  // runs and exactly-abutting windows drift apart. That hands the same finding back twice,
  // so the run must dedupe or the overlap would inflate every count.
  const sb = sandbox();
  const dup = lokiPayload(
    { tool_parameters: `{"full_command":"curl -H \\"Authorization: token ${syntheticPat()}\\""}` },
  );
  // The stub answers EVERY slice with the same payload, so a 3h scan sees it three times.
  const env = stubOtelq(sb, dup);
  const r = run(['--loki', '--since', '3'], sb, env);
  assert.strictEqual(r.status, 1);
  const records = fs.readFileSync(sb.log, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(records.length, 1,
    `the same fingerprint across slices is one finding, got ${records.length}`);
  assert.match(r.stdout, /1 new finding/);
});

test('two DIFFERENT findings in one run are both kept', { skip }, () => {
  // The rejecting half: a dedupe keyed too broadly would collapse distinct credentials
  // into one and hide a real leak, which is worse than the double-count it fixes.
  const sb = sandbox();
  const env = stubOtelq(sb, lokiPayload(
    { tool_parameters: `{"full_command":"curl -H \\"Authorization: token ${syntheticPat()}\\""}` },
    { prompt: `a second, different one: ${syntheticPat()}` },
  ));
  const r = run(['--loki', '--since', '1'], sb, env);
  assert.strictEqual(r.status, 1);
  const records = fs.readFileSync(sb.log, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(records.length, 2, 'distinct fingerprints must survive the dedupe');
});

test('a bad argument is a usage error, not a silent pass', { skip }, () => {
  const sb = sandbox();
  assert.strictEqual(run(['--nope'], sb).status, 2);
  assert.strictEqual(run(['--since', 'yesterday'], sb).status, 2);
  assert.strictEqual(run(['--session', path.join(sb.dir, 'absent.jsonl')], sb).status, 2);
});

// ── The pending marker ────────────────────────────────────────────────────────
//
// Both unattended callers used to throw the verdict away: session-end.sh backgrounds this
// with its output discarded, and the timer's journal line reaches nobody on a headless
// host. notify-send does not close that (it needs a daemon) and neither does osascript
// (it needs a Mac). The marker is the platform-independent half, read back by
// hooks/session-context.sh at the start of the next session.

test('a finding leaves a durable marker, not just a log line', { skip }, () => {
  const sb = sandbox();
  const r = run(['--session', path.join(sb.projects, 'dirty.jsonl')], sb);
  assert.strictEqual(r.status, 1);
  const rows = fs.readFileSync(sb.pending, 'utf8').trim().split('\n');
  assert.strictEqual(rows.length, 1, 'one run reports one row');
  const [ts, count, log] = rows[0].split('\t');
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'the row is timestamped');
  assert.strictEqual(Number(count) > 0, true, `expected a positive count, got ${count}`);
  assert.strictEqual(log, sb.log, 'the row points at the log holding the detail');
});

test('a clean transcript writes no marker', { skip }, () => {
  const sb = sandbox();
  const r = run(['--session', path.join(sb.projects, 'clean.jsonl')], sb);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.existsSync(sb.pending), false,
    'a clean run must not arm the banner — a marker nobody can clear by fixing anything '
    + 'is how the banner stops being read');
});

test('--clear-pending disarms the banner and keeps the evidence', { skip }, () => {
  const sb = sandbox();
  run(['--session', path.join(sb.projects, 'dirty.jsonl')], sb);
  assert.strictEqual(fs.existsSync(sb.pending), true, 'precondition: the marker is armed');
  const before = fs.readFileSync(sb.log, 'utf8');

  const r = run(['--clear-pending'], sb);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.existsSync(sb.pending), false, 'the marker is gone');
  // The reverse operation must not also destroy the record. Rotating a credential settles
  // a finding; it does not mean the finding never happened.
  assert.strictEqual(fs.readFileSync(sb.log, 'utf8'), before, 'the log is untouched');
  assert.strictEqual(fs.existsSync(sb.baseline), false, 'nothing was baselined');
});

test('--accept-baseline also disarms the banner', { skip }, () => {
  const sb = sandbox();
  run(['--session', path.join(sb.projects, 'dirty.jsonl')], sb);
  assert.strictEqual(fs.existsSync(sb.pending), true, 'precondition: the marker is armed');
  run(['--session', path.join(sb.projects, 'dirty.jsonl'), '--accept-baseline'], sb);
  assert.strictEqual(fs.existsSync(sb.pending), false,
    'everything outstanding is now baselined, so the banner has nothing left to report');
});

// Exit 3 is the one verdict with no other durable trace: a finding lands in the log, but a
// scan that never ran leaves nothing at all — which is indistinguishable from a clean run.
test('a scan that could not run records that it could not run', { skip: skipUnless('bash', 'jq') }, () => {
  const sb = sandbox();
  // PATH stays real — emptying it means bash itself cannot be spawned, and the test fails
  // for a reason that has nothing to do with the scanner. HOME is redirected so the prek
  // cache glob finds nothing either; between them the scanner has no gitleaks to resolve.
  const r = run(['--session', path.join(sb.projects, 'dirty.jsonl')], sb, {
    PATH: '/usr/bin:/bin',
    GITLEAKS_BIN: '/nonexistent',
    HOME: sb.dir,
  });
  assert.strictEqual(r.status, 3, `expected could-not-evaluate, got ${r.status}: ${r.stdout}${r.stderr}`);
  const [ts, count, why] = fs.readFileSync(sb.pending, 'utf8').trim().split('\t');
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.strictEqual(count, '0', 'a could-not-evaluate row carries count 0, not a finding count');
  assert.match(why, /gitleaks|jq/, `the row says what was missing, got: ${why}`);
});
