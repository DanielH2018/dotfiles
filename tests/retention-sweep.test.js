// Tests for M12 slice 1: the retention manifest data file + the dry-run-only sweeper
// skeleton (executable_retention-sweep). Slice 1's whole point is that no delete/rotate
// code path exists yet (spec: M12-retention.md §7, §8) — so alongside a normal behavioral
// run, this file asserts that guarantee *structurally*: the sweeper's source must contain
// no delete/rename/truncate primitive and no non-/dev/null write redirect, not merely
// default to a dry-run flag that a future edit could flip.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const SWEEP = path.join(REPO_ROOT, 'home', 'dot_local', 'bin', 'executable_retention-sweep');
const MANIFEST = path.join(REPO_ROOT, 'home', 'private_dot_claude', 'retention-manifest.json');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const dirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }
process.on('exit', () => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

function runSweep(manifestPath) {
  return execFileSync('bash', [SWEEP], {
    env: { ...process.env, RETENTION_MANIFEST: manifestPath },
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// --- Structural no-delete guarantee -----------------------------------------------

test('sweeper source contains no delete/rename/truncate primitive', () => {
  const src = fs.readFileSync(SWEEP, 'utf8');
  // Strip the shebang and comments (this file's own header comment documents the
  // forbidden operations in prose, e.g. "no unlink, truncate, move" — so comments must
  // be stripped or the check would false-positive on its own documentation).
  const codeOnly = src.split('\n').slice(1)
    .map((line) => line.replace(/#.*/, ''))
    .join('\n');

  const forbidden = /\brm\b|\bunlink\b|\btruncate\b|\bmv\b|\bshred\b|\bdd\b|\bsed\s+-i\b|\b>\s*\.\.\/|:>\s*\S/i;
  const match = codeOnly.match(forbidden);
  assert.strictEqual(match, null, `found a delete-capable primitive: ${match && match[0]}`);
});

test('sweeper has no write redirect other than to /dev/null or an fd dup', () => {
  const src = fs.readFileSync(SWEEP, 'utf8');
  const codeOnly = src.split('\n').slice(1).map((line) => line.replace(/#.*/, '')).join('\n');
  // Negative lookbehind excludes the literal "->" arrow used in echoed prose (e.g.
  // "-> no action"), which is not a redirect. `>&N` (fd dup, e.g. stderr passthrough)
  // and `>/dev/null` are the only redirect shapes this script legitimately uses.
  const redirects = codeOnly.match(/(?<!-)\d*>>?(&\d+|\s*\S+)/g) || [];
  const badRedirects = redirects.filter((r) => !/\/dev\/null/.test(r) && !/^\d*>>?&\d/.test(r));
  assert.deepStrictEqual(badRedirects, [], 'sweeper must never redirect output to a real file');
});

test('sweeper accepts no --apply (or any other action-triggering) flag', () => {
  const src = fs.readFileSync(SWEEP, 'utf8');
  assert.doesNotMatch(src, /--apply/, 'slice 1 must not implement an apply/action flag');
});

// --- Manifest shape ----------------------------------------------------------------

test('manifest has all 19 rows from the spec table with required schema fields', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  assert.strictEqual(manifest.length, 19);
  const ids = manifest.map((r) => r.id).sort();
  const expected = ['N1', 'N2', ...Array.from({ length: 17 }, (_, i) => `G${i + 1}`)].sort();
  assert.deepStrictEqual(ids, expected);
  for (const row of manifest) {
    for (const field of ['path', 'kind', 'rule', 'owner', 'finding']) {
      assert.ok(field in row, `row ${row.id} missing required field ${field}`);
    }
  }
});

// --- Behavioral: dry run reports, never touches fixtures ----------------------------

test('dry run reports matches but leaves every fixture path untouched', { skip }, () => {
  const root = scratch('retention-fixture-');
  const sessionEnvDir = path.join(root, 'session-env', 'aged-empty-uuid');
  fs.mkdirSync(sessionEnvDir, { recursive: true });
  const oldTime = new Date(Date.now() - 3 * 86400 * 1000);
  fs.utimesSync(sessionEnvDir, oldTime, oldTime);

  const deadPidFile = path.join(root, 'sessions', '999999.json');
  fs.mkdirSync(path.dirname(deadPidFile), { recursive: true });
  fs.writeFileSync(deadPidFile, '{}');
  fs.utimesSync(deadPidFile, oldTime, oldTime);

  const logFile = path.join(root, 'logs', 'sessions.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, 'x'.repeat(2_000_000));

  const fixtureManifest = path.join(root, 'manifest.json');
  fs.writeFileSync(fixtureManifest, JSON.stringify([
    { id: 'F1', path: path.join(root, 'session-env', '*'), kind: 'dir-glob', rule: 'prune-empty-dir', cap: 'unconditional once eligible', grace: '1h', owner: 'retention-sweep', finding: 'test' },
    { id: 'F2', path: path.join(root, 'sessions', '*.json'), kind: 'file-glob', rule: 'prune-dead-pid', cap: 'kill -0 fails', grace: '1h', owner: 'retention-sweep', finding: 'test' },
    { id: 'F3', path: logFile, kind: 'file', rule: 'rotate-size', cap: '1MB, keep 3 gen', grace: null, owner: 'retention-sweep', finding: 'test' },
  ]));

  const before = {
    sessionEnv: fs.statSync(sessionEnvDir).mtimeMs,
    deadPid: fs.readFileSync(deadPidFile, 'utf8'),
    log: fs.readFileSync(logFile, 'utf8'),
  };

  const output = runSweep(fixtureManifest);

  assert.match(output, /DRY RUN ONLY/);
  assert.match(output, /F1: .*matched=1/);
  assert.match(output, /F2: .*matched=1/);
  assert.match(output, /F3: .*matched=1/);

  // The load-bearing assertion: every fixture is byte-for-byte/timestamp identical.
  assert.strictEqual(fs.statSync(sessionEnvDir).mtimeMs, before.sessionEnv, 'empty dir was touched');
  assert.strictEqual(fs.readFileSync(deadPidFile, 'utf8'), before.deadPid, 'dead-pid file was touched');
  assert.strictEqual(fs.readFileSync(logFile, 'utf8'), before.log, 'log file was touched/rotated');
});

test('native and self-managed rows are reported as no-op, never scanned for deletion', { skip }, () => {
  const output = runSweep(MANIFEST);
  assert.match(output, /N1: rule=native -> no action/);
  assert.match(output, /N2: rule=self-managed -> no action/);
});

test('missing manifest fails closed with a clear error, not a crash mid-scan', { skip }, () => {
  assert.throws(() => runSweep('/nonexistent/retention-manifest.json'));
});
