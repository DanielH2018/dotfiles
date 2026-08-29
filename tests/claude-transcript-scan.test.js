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
const { test, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
let jqOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { jqOk = false; }
const skip = GITLEAKS && jqOk ? false : 'gitleaks/jq unavailable';

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
const SANDBOXES = [];
after(() => {
  for (const d of SANDBOXES) fs.rmSync(d, { recursive: true, force: true });
});

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-scan-'));
  SANDBOXES.push(dir);
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
  };
}

function run(args, sb, extraEnv = {}) {
  return spawnSync('bash', [SCANNER, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_TRANSCRIPT_ROOT: path.join(sb.dir, 'projects'),
      CLAUDE_TRANSCRIPT_LEAK_LOG: sb.log,
      CLAUDE_TRANSCRIPT_LEAK_BASELINE: sb.baseline,
      CLAUDE_TRANSCRIPT_GITLEAKS_CONFIG: sb.glConfig,
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
  assert.match(r.stdout, /2 transcript\(s\)/, 'both fixtures were scanned');
  // Count findings, not substring hits: each emitted record names the rule twice, once in
  // `rule` and once inside `fingerprint`.
  assert.strictEqual((r.stdout.match(/"rule":"github-pat"/g) || []).length, 1, 'exactly one finding');
});

test('a missing gitleaks reports could-not-evaluate, never clean', { skip: jqOk ? false : skip }, () => {
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
  assert.match(after.stdout, /1 baselined/);
});

test('a finding the baseline does not cover is still reported', { skip }, () => {
  const sb = sandbox();
  run(['--since', '1', '--accept-baseline'], sb);
  // A second, different credential appears after the baseline was taken.
  fs.writeFileSync(path.join(sb.projects, 'newleak.jsonl'),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'GITHUB_TOKEN=ghp_4kM8vB2nQ7wR5xT9zY1cD3fH6jL0pS8uA2eG' }] } }) + '\n');
  const r = run(['--since', '1'], sb);
  assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /1 NEW finding/);
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
  assert.match(r.stdout, /"rule":"github-pat"/);
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

test('a bad argument is a usage error, not a silent pass', { skip }, () => {
  const sb = sandbox();
  assert.strictEqual(run(['--nope'], sb).status, 2);
  assert.strictEqual(run(['--since', 'yesterday'], sb).status, 2);
  assert.strictEqual(run(['--session', path.join(sb.dir, 'absent.jsonl')], sb).status, 2);
});
