// Tests for M12 slices 1-2: the retention manifest data file + the sweeper
// (executable_retention-sweep).
//
// Slice 1's guarantee was that no delete code path existed at all, asserted structurally.
// Slice 2 introduces exactly one, so the structural assertions change shape rather than
// disappearing: what is now pinned is that the delete path is *reachable only* under
// --apply, only for the four rows the spec names (G2, G12, G16, G17), and only for a
// plain file — and that rotate/truncate/move still do not exist anywhere (spec §7: they
// are slice 3).
//
// The behavioural half matters more than the structural half here, because "it deleted
// the wrong thing" is the failure that costs something. Each gate — the flag, the row
// set, the grace floor, pid liveness, the live-sibling proof — gets a fixture that
// survives when the gate holds.
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

function runSweep(manifestPath, args = [], extraEnv = {}) {
  return execFileSync('bash', [SWEEP, ...args], {
    env: { ...process.env, RETENTION_MANIFEST: manifestPath, ...extraEnv },
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const ago = (ms) => new Date(Date.now() - ms);

// Writes a file and backdates it, which is how every gate below is exercised: the grace
// floor and the 48h staleness window are both measured from mtime.
function aged(file, contents, ageMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  if (ageMs) fs.utimesSync(file, ago(ageMs), ago(ageMs));
  return file;
}

const manifestFile = (root, rows) => {
  const p = path.join(root, 'manifest.json');
  fs.writeFileSync(p, JSON.stringify(rows));
  return p;
};

// --- Structural no-delete guarantee -----------------------------------------------

const codeOf = (file) => fs.readFileSync(file, 'utf8')
  .split('\n').slice(1)
  .map((line) => line.replace(/#.*/, ''))
  .join('\n');

test('the only delete primitive is a single guarded rm, and rotate/truncate/move still do not exist', () => {
  const codeOnly = codeOf(SWEEP);

  // Slice 3's verbs. Their absence is what keeps slice 2 a *deletion* slice: a rotate or
  // truncate has to contend with a writer holding the file open, which is a different
  // failure mode with no fixture here yet.
  const slice3 = /\btruncate\b|\bmv\b|\bshred\b|\bdd\b|\bsed\s+-i\b|:>\s*\S/i;
  const leaked = codeOnly.match(slice3);
  assert.strictEqual(leaked, null, `found a slice-3 primitive: ${leaked && leaked[0]}`);

  // Exactly one rm, and it is the guarded one. More than one means a second, unreviewed
  // path to deletion.
  const rms = codeOnly.match(/\brm\s+[^\n]*/g) || [];
  assert.strictEqual(rms.length, 1, `expected exactly one rm, found ${rms.length}: ${rms.join(' | ')}`);
  assert.match(rms[0], /^rm -f -- "\$f"/, 'the rm must be -f -- "$f", so a dash-leading name cannot become a flag');

  // No recursive removal anywhere: slice 2 has no directory rule at all.
  assert.doesNotMatch(codeOnly, /\brm\b[^\n]*-[a-zA-Z]*[rR]/, 'slice 2 must never remove a directory tree');
});

test('sweeper has no write redirect other than to /dev/null or an fd dup', () => {
  const codeOnly = codeOf(SWEEP);
  // Negative lookbehind excludes the literal "->" arrow used in echoed prose (e.g.
  // "-> no action"), which is not a redirect. `>&N` (fd dup, e.g. stderr passthrough)
  // and `>/dev/null` are the only redirect shapes this script legitimately uses.
  const redirects = codeOnly.match(/(?<!-)\d*>>?(&\d+|\s*\S+)/g) || [];
  const badRedirects = redirects.filter((r) => !/\/dev\/null/.test(r) && !/^\d*>>?&\d/.test(r));
  assert.deepStrictEqual(badRedirects, [], 'sweeper must never redirect output to a real file');
});

// The row set is the blast radius. Reading it from the manifest would mean adding a row
// could grant itself a delete path; keeping it in the source means widening it is a
// reviewable edit.
test('the acting row set is a source-level literal naming exactly the spec slice-2 rows', () => {
  const src = fs.readFileSync(SWEEP, 'utf8');
  const m = src.match(/^APPLY_ROWS="([^"]*)"/m);
  assert.ok(m, 'APPLY_ROWS literal not found');
  assert.deepStrictEqual(m[1].trim().split(/\s+/).sort(), ['G12', 'G16', 'G17', 'G2']);
  assert.doesNotMatch(codeOf(SWEEP), /APPLY_ROWS=\$\(|APPLY_ROWS=.*jq/, 'the row set must not be derived from the manifest');
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

  assert.match(output, /DRY RUN/);
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

// --- Slice 2: the delete path, one test per gate -------------------------------------

const DEAD_PID = 999999;
const deadPidRow = (id, glob) => ({
  id, path: glob, kind: 'file-glob', rule: 'prune-dead-pid',
  cap: 'kill -0 fails', grace: '1h', owner: 'retention-sweep', finding: 'test',
});

test('--apply prunes a dead-pid file, and each of the three filename shapes is understood', { skip }, () => {
  const root = scratch('retention-apply-');
  const week = 7 * 86400 * 1000;
  const session = aged(path.join(root, 'sessions', `${DEAD_PID}.json`), '{}', week);
  const fzfport = aged(path.join(root, `.agentview-fzfport.${DEAD_PID}`), '4321', week);
  const tmpjson = aged(path.join(root, `.claude.json.tmp.${DEAD_PID}.a1b2`), '{}', week);

  const m = manifestFile(root, [
    deadPidRow('G2', path.join(root, 'sessions', '*.json')),
    deadPidRow('G16', path.join(root, '.agentview-fzfport.*')),
    deadPidRow('G17', path.join(root, '.claude.json.tmp.*')),
  ]);

  const out = runSweep(m, ['--apply']);
  assert.match(out, /APPLY \(slice 2 rows only\)/);
  for (const f of [session, fzfport, tmpjson]) {
    assert.ok(!fs.existsSync(f), `${path.basename(f)} should have been pruned`);
  }
  assert.match(out, /Pruned 3 entries/);
});

test('without --apply the same dead-pid fixtures are only reported', { skip }, () => {
  const root = scratch('retention-noapply-');
  const f = aged(path.join(root, 'sessions', `${DEAD_PID}.json`), '{}', 7 * 86400 * 1000);
  const m = manifestFile(root, [deadPidRow('G2', path.join(root, 'sessions', '*.json'))]);

  const out = runSweep(m);
  assert.ok(fs.existsSync(f), 'default run must delete nothing');
  assert.match(out, /matched=1/);
  assert.doesNotMatch(out, /pruned=/);
});

// The gate that matters most: a live session's own state file.
test('a live pid survives --apply', { skip }, () => {
  const root = scratch('retention-live-');
  const live = aged(path.join(root, 'sessions', `${process.pid}.json`), '{}', 7 * 86400 * 1000);
  const m = manifestFile(root, [deadPidRow('G2', path.join(root, 'sessions', '*.json'))]);

  const out = runSweep(m, ['--apply']);
  assert.ok(fs.existsSync(live), 'a live pid must never be pruned');
  assert.match(out, new RegExp(`pid ${process.pid} is alive`));
});

test('the grace floor protects a dead-pid file that is too young', { skip }, () => {
  const root = scratch('retention-grace-');
  // Dead pid, so only the grace floor can save it. Two minutes old against grace=1h.
  const young = aged(path.join(root, 'sessions', `${DEAD_PID}.json`), '{}', 2 * 60 * 1000);
  const m = manifestFile(root, [deadPidRow('G2', path.join(root, 'sessions', '*.json'))]);

  const out = runSweep(m, ['--apply']);
  assert.ok(fs.existsSync(young), 'a file younger than grace must survive');
  assert.match(out, /younger than grace=1h/);
});

// Same rule, same shape, same age — only the row id differs. This is what pins the
// blast radius to the source-level set rather than to the rule name.
test('a row outside the slice-2 set is untouched even under --apply', { skip }, () => {
  const root = scratch('retention-rowset-');
  const week = 7 * 86400 * 1000;
  const inSet = aged(path.join(root, 'in', `${DEAD_PID}.json`), '{}', week);
  const outSet = aged(path.join(root, 'out', `${DEAD_PID}.json`), '{}', week);
  const m = manifestFile(root, [
    deadPidRow('G2', path.join(root, 'in', '*.json')),
    deadPidRow('G99', path.join(root, 'out', '*.json')),
  ]);

  const out = runSweep(m, ['--apply']);
  assert.ok(!fs.existsSync(inSet), 'G2 is in the set and should have been pruned');
  assert.ok(fs.existsSync(outSet), 'G99 is not in the set and must be untouched');
  assert.match(out, /\[dry-run\] G99/);
});

test('a symlink matching the glob is reported, never followed or removed', { skip }, () => {
  const root = scratch('retention-symlink-');
  const outside = aged(path.join(root, 'outside.json'), 'precious', 7 * 86400 * 1000);
  const link = path.join(root, 'sessions', `${DEAD_PID}.json`);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(outside, link);
  const m = manifestFile(root, [deadPidRow('G2', path.join(root, 'sessions', '*.json'))]);

  runSweep(m, ['--apply']);
  assert.ok(fs.existsSync(outside), 'the symlink target must never be removed');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the symlink itself must be left alone');
});

// --- G12: the stale duplicate ---------------------------------------------------------

const stale12 = (root, glob) => ({
  id: 'G12', path: glob, kind: 'file', rule: 'prune-stale-duplicate',
  cap: 'age>48h + mtime frozen + live sibling exists', grace: null,
  owner: 'retention-sweep (manual, slice 2)', finding: 'test',
});

test('the stale duplicate is pruned only once a newer live sibling proves it stale', { skip }, () => {
  const root = scratch('retention-dup-');
  const target = aged(path.join(root, 'home', 'permissions.json'), 'stale', 6 * 86400 * 1000);
  const sibling = aged(path.join(root, 'proj', 'permissions.json'), 'live', 0);
  const m = manifestFile(root, [stale12(root, target)]);

  const out = runSweep(m, ['--apply'], { RETENTION_SIBLING_CANDIDATES: sibling });
  assert.ok(!fs.existsSync(target), 'the stale duplicate should have been pruned');
  assert.ok(fs.existsSync(sibling), 'the live sibling must never be touched');
  assert.match(out, /live sibling is/);
});

test('with no newer sibling the duplicate is kept — staleness must be proven, not assumed', { skip }, () => {
  const root = scratch('retention-dup-nosib-');
  const target = aged(path.join(root, 'home', 'permissions.json'), 'stale', 6 * 86400 * 1000);
  // The only candidate is OLDER than the target, so nothing proves the target superseded.
  const sibling = aged(path.join(root, 'proj', 'permissions.json'), 'older', 9 * 86400 * 1000);
  const m = manifestFile(root, [stale12(root, target)]);

  const out = runSweep(m, ['--apply'], { RETENTION_SIBLING_CANDIDATES: sibling });
  assert.ok(fs.existsSync(target), 'without proof the duplicate must survive');
  assert.match(out, /no live sibling is newer/);
});

test('a duplicate younger than 48h is kept even with a newer sibling', { skip }, () => {
  const root = scratch('retention-dup-young-');
  const target = aged(path.join(root, 'home', 'permissions.json'), 'recent', 3600 * 1000);
  const sibling = aged(path.join(root, 'proj', 'permissions.json'), 'live', 0);
  const m = manifestFile(root, [stale12(root, target)]);

  const out = runSweep(m, ['--apply'], { RETENTION_SIBLING_CANDIDATES: sibling });
  assert.ok(fs.existsSync(target), 'a duplicate inside the 48h window must survive');
  assert.match(out, /newer than 48h/);
});

test('an unknown argument is refused rather than ignored', { skip }, () => {
  const root = scratch('retention-badflag-');
  const m = manifestFile(root, []);
  try {
    runSweep(m, ['--force']);
    assert.fail('expected a non-zero exit');
  } catch (e) {
    assert.strictEqual(e.status, 2);
    assert.match(String(e.stderr), /unknown argument --force/);
  }
});
