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
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const SWEEP = path.join(REPO_ROOT, 'home', 'dot_local', 'bin', 'executable_retention-sweep');
const MANIFEST = path.join(REPO_ROOT, 'home', 'private_dot_claude', 'retention-manifest.json');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

let flockAvailable = true;
try { execFileSync('bash', ['-c', 'command -v flock'], { stdio: 'ignore' }); } catch { flockAvailable = false; }

const dirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }
process.on('exit', () => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

// Every fixture manifest is written into its own scratch root, so that root is also the
// right sandbox for everything else the sweeper touches.
//
// This isolates HOME as well as the individual seams, and the belt-and-braces is not
// theoretical: eight --apply tests here passed RETENTION_MANIFEST but not
// RETENTION_STATE_DIR, so the run marker was written to the developer's REAL
// ~/.claude/.retention-sweep-last-run, and the real $XDG_RUNTIME_DIR lock was taken for
// the duration. The second one is the dangerous half — the suite and the hourly timer
// contend for the same lock, so running tests could make a scheduled sweep skip itself.
// Overriding HOME means a seam added later that this helper does not know about still
// cannot reach outside the scratch directory.
function runSweep(manifestPath, args = [], extraEnv = {}) {
  const home = path.dirname(manifestPath);
  return execFileSync('bash', [SWEEP, ...args], {
    env: {
      ...process.env,
      HOME: home,
      RETENTION_MANIFEST: manifestPath,
      RETENTION_STATE_DIR: home,
      RETENTION_LOCK: path.join(home, 'sweep.lock'),
      ...extraEnv,
    },
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

test('removal is exactly two rm forms plus rmdir', () => {
  const codeOnly = codeOf(SWEEP);

  // Exactly two rm call sites — the file form and the directory form — both with `--`, so
  // a dash-leading name can never be read as a flag. Rotation's generation drop is a mv
  // overwrite, not a delete (see the next test), so this count is unaffected by it.
  const rms = codeOnly.match(/\brm\s+[^\n]*/g) || [];
  assert.strictEqual(rms.length, 2, `expected exactly two rm call sites, found ${rms.length}: ${rms.join(' | ')}`);
  assert.ok(rms.some((r) => r.startsWith('rm -rf -- "$f"')), 'the directory form must be rm -rf -- "$f"');
  assert.ok(rms.some((r) => r.startsWith('rm -f -- "$f"')), 'the file form must be rm -f -- "$f"');

  // The empty-dir rule must use rmdir, which refuses a non-empty directory in the kernel
  // rather than trusting an emptiness check that could race a writer.
  assert.match(codeOnly, /\brmdir "\$f"/, 'prune-empty-dir must use rmdir, not rm -r');
});

// Slice 3 deferred rotate/truncate entirely — no `mv`/`tail -n` anywhere in the source.
// This slice implements them, so the guarantee narrows rather than disappears: the
// primitives may exist, but only inside the two functions that implement
// rename-then-create-fresh, never reachable from the removal path or anywhere else.
test('rotate/truncate primitives (mv, tail -n) exist only inside their own functions', () => {
  const codeOnly = codeOf(SWEEP);

  const extractFn = (name) => {
    const at = codeOnly.indexOf(`${name}() {`);
    assert.ok(at > -1, `${name} function not found`);
    const start = codeOnly.indexOf('{', at);
    let depth = 0, i = start;
    for (; i < codeOnly.length; i += 1) {
      if (codeOnly[i] === '{') depth += 1;
      else if (codeOnly[i] === '}') { depth -= 1; if (depth === 0) break; }
    }
    return { body: codeOnly.slice(start, i + 1), start: at, end: i + 1 };
  };

  const rotateFn = extractFn('rotate_by_size');
  const truncateFn = extractFn('truncate_lines_file');
  assert.ok(rotateFn.start < truncateFn.start, 'rotate_by_size must be defined before truncate_lines_file');

  assert.match(rotateFn.body, /\bmv\b/, 'rotate_by_size must use mv for rename-then-create-fresh');
  assert.doesNotMatch(rotateFn.body, /\btail\s+-n\b/, 'rotate_by_size has no business reading lines');
  assert.match(truncateFn.body, /\btail\s+-n\b/, 'truncate_lines_file must use tail -n to select the kept lines');
  assert.match(truncateFn.body, /\bmv\b/, 'truncate_lines_file must rename the temp file atomically over the original');

  // Outside the two functions, none of the primitives that would let a rule rewrite a
  // file in place may appear. "truncate-lines"/"rotate-size" are rule-name literals, not
  // the primitive itself, so they are stripped before scanning for leaks.
  const outside = (codeOnly.slice(0, rotateFn.start)
    + codeOnly.slice(rotateFn.end, truncateFn.start)
    + codeOnly.slice(truncateFn.end))
    .replace(/truncate-lines/g, '').replace(/rotate-size/g, '');
  const primitive = /\btruncate\b|\bmv\b|\bshred\b|\bdd\b|\bsed\s+-i\b|\btail\s+-n\b|:>\s*\S/i;
  const leaked = outside.match(primitive);
  assert.strictEqual(leaked, null, `found a rotate/truncate primitive outside its function: ${leaked && leaked[0]}`);
});

// Recursive removal is the sharpest edge slice 3 adds, so its guard is pinned in source
// as well as in behaviour: rm -rf must be unreachable without contained() having passed.
test('recursive removal is gated behind the containment check', () => {
  const codeOnly = codeOf(SWEEP);
  const guardAt = codeOnly.indexOf('if ! contained "$prefix" "$f"');
  const rmAt = codeOnly.indexOf('rm -rf -- "$f"');
  assert.ok(guardAt > -1, 'the containment guard is missing');
  assert.ok(rmAt > guardAt, 'rm -rf must come after the containment guard, not before it');
  assert.match(codeOnly, /\[ -L "\$entry" \] && return 1/, 'contained() must refuse a symlink outright');
});

test('the only files the sweeper writes are the run marker and truncate-lines\' own temp file', () => {
  const codeOnly = codeOf(SWEEP);
  const redirects = codeOnly.match(/(?<!-)\d*>>?(&\d+|\s*\S+)/g) || [];
  // Allowed: /dev/null, an fd dup or close, the flock descriptor (a zero-byte mutex, not
  // data), the run marker, and truncate_lines_file's own "$tmp" -- written once, in the
  // same directory as the file it will atomically replace, never left behind on success.
  const bad = redirects.filter((r) => !/\/dev\/null/.test(r)
    && !/^\d*>>?&[\d-]/.test(r)
    && !/\$LOCK/.test(r)
    && !/\$MARKER/.test(r)
    && !/"\$tmp"/.test(r));
  assert.deepStrictEqual(bad, [], 'the marker and the truncate temp file are the only real files the sweeper may write');
  // No append anywhere: an append is how a log grows without bound, which is the very
  // thing this module exists to prevent. The marker is overwritten each run, and the
  // temp file is written once with `>`, never `>>`.
  assert.doesNotMatch(codeOnly, />>/, 'the sweeper must never append to a file');
});

// The row set is the blast radius. Reading it from the manifest would mean adding a row
// could grant itself a delete path; keeping it in the source means widening it is a
// reviewable edit. Rotation gets its own, separate row set for the same reason, and
// staying out of APPLY_ROWS is what keeps --apply alone from ever touching it.
test('the acting and rotating row sets are source literals covering their rules and no others', () => {
  const src = fs.readFileSync(SWEEP, 'utf8');

  const m = src.match(/^APPLY_ROWS="([^"]*)"/m);
  assert.ok(m, 'APPLY_ROWS literal not found');
  const rows = m[1].trim().split(/\s+/).sort();
  assert.deepStrictEqual(rows,
    ['G1', 'G12', 'G14', 'G15', 'G16', 'G17', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'].sort());

  // The rotate/truncate rows must never be reachable through --apply alone.
  for (const deferred of ['G8', 'G9', 'G10', 'G11', 'G13']) {
    assert.ok(!rows.includes(deferred), `${deferred} is a rotate/truncate row and must not act under --apply alone`);
  }
  assert.doesNotMatch(codeOf(SWEEP), /APPLY_ROWS=\$\(|APPLY_ROWS=.*jq/, 'the row set must not be derived from the manifest');

  const mr = src.match(/^ROTATE_ROWS="([^"]*)"/m);
  assert.ok(mr, 'ROTATE_ROWS literal not found');
  const rotateRows = mr[1].trim().split(/\s+/).sort();
  assert.deepStrictEqual(rotateRows, ['G10', 'G13', 'G19', 'G8', 'G9'].sort());
  assert.ok(!rotateRows.includes('G11'),
    'G11 stays cwd-skipped at runtime for every rule and must not gain a rotate row');
  assert.doesNotMatch(codeOf(SWEEP), /ROTATE_ROWS=\$\(|ROTATE_ROWS=.*jq/, 'the rotate row set must not be derived from the manifest');
});

// --- Manifest shape ----------------------------------------------------------------

test('manifest has all 21 rows (the 19-row spec table plus G18 and G19) with required schema fields', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  assert.strictEqual(manifest.length, 21);
  const ids = manifest.map((r) => r.id).sort();
  const expected = ['N1', 'N2', ...Array.from({ length: 19 }, (_, i) => `G${i + 1}`)].sort();
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
  assert.match(out, /retention-sweep — APPLY/);
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

// --- Slice 3: age rules, empty dirs, containment, the lock, the marker ----------------

const ageRow = (id, glob, cap) => ({
  id, path: glob, kind: 'file-glob', rule: 'prune-age',
  cap, grace: '1h', owner: 'retention-sweep', finding: 'test',
});

test('prune-age removes an aged directory tree and keeps one inside the cap', { skip }, () => {
  const root = scratch('retention-age-');
  // G4's real shape: file-history/<uuid>/ holding content-addressed versions.
  const old = path.join(root, 'hist', 'old-uuid');
  aged(path.join(old, 'abc@v1'), 'v1', 20 * 86400 * 1000);
  fs.utimesSync(old, ago(20 * 86400 * 1000), ago(20 * 86400 * 1000));
  const recent = path.join(root, 'hist', 'recent-uuid');
  aged(path.join(recent, 'def@v1'), 'v1', 3 * 86400 * 1000);
  fs.utimesSync(recent, ago(3 * 86400 * 1000), ago(3 * 86400 * 1000));

  const m = manifestFile(root, [ageRow('G4', path.join(root, 'hist', '*'), '14d')]);
  const out = runSweep(m, ['--apply'], { RETENTION_STATE_DIR: root });

  assert.ok(!fs.existsSync(old), 'the 20-day-old tree should have been removed');
  assert.ok(fs.existsSync(recent), 'the 3-day-old tree is inside the 14d cap and must survive');
  assert.match(out, /younger than cap=14d/);
});

test('prune-empty-dir removes an empty directory and never a populated one', { skip }, () => {
  const root = scratch('retention-empty-');
  const week = 7 * 86400 * 1000;
  const empty = path.join(root, 'env', 'empty-uuid');
  fs.mkdirSync(empty, { recursive: true });
  fs.utimesSync(empty, ago(week), ago(week));
  const full = path.join(root, 'env', 'full-uuid');
  aged(path.join(full, 'payload'), 'x', week);
  fs.utimesSync(full, ago(week), ago(week));

  const m = manifestFile(root, [{
    id: 'G1', path: path.join(root, 'env', '*'), kind: 'dir-glob', rule: 'prune-empty-dir',
    cap: 'unconditional once eligible', grace: '1h', owner: 'retention-sweep', finding: 'test',
  }]);
  const out = runSweep(m, ['--apply'], { RETENTION_STATE_DIR: root });

  assert.ok(!fs.existsSync(empty), 'the empty directory should have been removed');
  assert.ok(fs.existsSync(path.join(full, 'payload')), 'a populated directory must be untouched');
  assert.match(out, /directory is not empty/);
});

// The guard that makes unattended recursive removal defensible.
test('a symlink inside the swept directory is refused, so its target survives', { skip }, () => {
  const root = scratch('retention-escape-');
  const precious = path.join(root, 'outside');
  aged(path.join(precious, 'keepme'), 'precious', 30 * 86400 * 1000);
  fs.utimesSync(precious, ago(30 * 86400 * 1000), ago(30 * 86400 * 1000));

  const link = path.join(root, 'hist', 'link-uuid');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(precious, link);
  // Backdate the LINK itself, not its target: GNU stat does not follow symlinks, so a
  // freshly-created link would be held by the grace floor and never reach the
  // containment check this test exists to exercise.
  fs.lutimesSync(link, ago(30 * 86400 * 1000), ago(30 * 86400 * 1000));

  const m = manifestFile(root, [ageRow('G4', path.join(root, 'hist', '*'), '14d')]);
  const out = runSweep(m, ['--apply'], { RETENTION_STATE_DIR: root });

  assert.ok(fs.existsSync(path.join(precious, 'keepme')), 'the symlink target must never be removed');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the symlink itself must be left alone');
  assert.match(out, /outside its glob prefix or a symlink/);
});

test('an unparseable cap refuses to act rather than falling back to a default', { skip }, () => {
  const root = scratch('retention-badcap-');
  const f = aged(path.join(root, 'hist', 'old-uuid'), 'x', 40 * 86400 * 1000);
  const m = manifestFile(root, [ageRow('G4', path.join(root, 'hist', '*'), 'fourteen days')]);

  const out = runSweep(m, ['--apply'], { RETENTION_STATE_DIR: root });
  assert.ok(fs.existsSync(f), 'a cap the sweeper cannot parse must mean no action');
  assert.match(out, /cap not understood: fourteen days/);
});

// The critical constraint on this slice: the hourly timer already passes --apply, so
// rotate-size/truncate-lines must not become automatic just by being implemented. They
// only earn --apply's automatic reach once they have their own supervised --rotate runs,
// the same way the removal rules earned --apply in slice 2.
test('--apply alone leaves a rotate-size row completely untouched, even 2x over cap', { skip }, () => {
  const root = scratch('retention-deferred-');
  const log = path.join(root, 'sessions.log');
  fs.writeFileSync(log, 'x'.repeat(2_000_000));
  const m = manifestFile(root, [{
    id: 'G8', path: log, kind: 'file', rule: 'rotate-size', cap: '1MB, keep 3 gen',
    grace: null, owner: 'retention-sweep', finding: 'test',
  }]);

  const out = runSweep(m, ['--apply'], { RETENTION_STATE_DIR: root });
  assert.strictEqual(fs.statSync(log).size, 2_000_000, '--apply alone must not rotate anything');
  assert.ok(!fs.existsSync(`${log}.1`), 'no rotation generation may be created');
  assert.match(out, /\[dry-run\] G8/);
});

// --- Slice 4: rotate-size and truncate-lines, gated behind --apply --rotate ----------

const rotateRow = (id, glob, cap) => ({
  id, path: glob, kind: 'file', rule: 'rotate-size',
  cap, grace: null, owner: 'retention-sweep', finding: 'test',
});
const truncateRow = (id, glob, cap) => ({
  id, path: glob, kind: 'file', rule: 'truncate-lines',
  cap, grace: null, owner: 'retention-sweep', finding: 'test',
});
const countLines = (p) => fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.length).length;

test('rotate-size: --apply --rotate is required together; --rotate alone (no --apply) does nothing', { skip }, () => {
  const root = scratch('retention-rotate-gate-');
  const log = path.join(root, 'sessions.log');
  fs.writeFileSync(log, 'x'.repeat(2_000_000));
  const m = manifestFile(root, [rotateRow('G8', log, '1MB, keep 3 gen')]);

  const out = runSweep(m, ['--rotate']);
  assert.strictEqual(fs.statSync(log).size, 2_000_000, '--rotate without --apply must not rotate');
  assert.ok(!fs.existsSync(`${log}.1`), 'no rotation generation may be created');
  assert.match(out, /\[dry-run\] G8/);

  const out2 = runSweep(m, ['--apply', '--rotate']);
  assert.match(out2, /\[rotate\] G8/);
  assert.strictEqual(fs.statSync(log).size, 0, 'the current file must be fresh after rotation');
  assert.ok(fs.existsSync(`${log}.1`), 'the rotated generation must exist');
  assert.strictEqual(fs.statSync(`${log}.1`).size, 2_000_000, 'no data lost in the rotated generation');
});

test('rotate-size leaves a file under cap untouched even with --apply --rotate', { skip }, () => {
  const root = scratch('retention-rotate-undercap-');
  const log = path.join(root, 'sessions.log');
  fs.writeFileSync(log, 'small');
  const m = manifestFile(root, [rotateRow('G8', log, '1MB, keep 3 gen')]);

  const out = runSweep(m, ['--apply', '--rotate']);
  assert.ok(!fs.existsSync(`${log}.1`), 'a file under cap must not be rotated');
  assert.strictEqual(fs.readFileSync(log, 'utf8'), 'small');
  assert.match(out, /under cap=1MB, keep 3 gen/);
});

test('rotate-size shifts generations and drops the oldest', { skip }, () => {
  const root = scratch('retention-rotate-gens-');
  const log = path.join(root, 'sessions.log');
  fs.writeFileSync(log, 'x'.repeat(2_000_000));
  fs.writeFileSync(`${log}.1`, 'gen1-content\n');
  fs.writeFileSync(`${log}.2`, 'gen2-content\n');
  fs.writeFileSync(`${log}.3`, 'gen3-content-must-be-dropped\n');
  const m = manifestFile(root, [rotateRow('G8', log, '1MB, keep 3 gen')]);

  runSweep(m, ['--apply', '--rotate']);
  assert.strictEqual(fs.statSync(log).size, 0, 'the current file must be fresh');
  assert.strictEqual(fs.readFileSync(`${log}.1`, 'utf8'), 'x'.repeat(2_000_000), 'the old current became .1');
  assert.strictEqual(fs.readFileSync(`${log}.2`, 'utf8'), 'gen1-content\n', 'the old .1 shifted to .2');
  assert.strictEqual(fs.readFileSync(`${log}.3`, 'utf8'), 'gen2-content\n', 'the old .2 shifted to .3, dropping the old .3');
});

// Mirrors the spec's own fixture (M12 spec section 6): current file is fresh/empty after
// rotation, a .1 sibling exists, and the line count across current + .1 equals the
// pre-rotation total exactly -- a race can only interleave lines into the old segment,
// never lose them.
test('rotate-size: no data loss -- line count across current + .1 equals the pre-rotation total', { skip }, () => {
  const root = scratch('retention-rotate-nodataloss-');
  const log = path.join(root, 'sessions.log');
  // Padded to 50 bytes/line so 30000 lines comfortably clears the 1MB cap (short lines
  // like "line 42" wouldn't: 30000 * ~8 bytes is well under 1MB).
  const content = Array.from({ length: 30000 }, (_, i) => `line ${i.toString().padStart(6, '0')}`.padEnd(50, '-')).join('\n') + '\n';
  fs.writeFileSync(log, content);
  assert.ok(fs.statSync(log).size > 1024 * 1024, 'test setup: fixture must exceed the 1MB cap');
  const preLineCount = countLines(log);
  const m = manifestFile(root, [rotateRow('G8', log, '1MB, keep 3 gen')]);

  runSweep(m, ['--apply', '--rotate']);
  const curLines = fs.existsSync(log) ? countLines(log) : 0;
  const g1Lines = countLines(`${log}.1`);
  assert.strictEqual(curLines, 0, 'the current file must be fresh/empty after rotation');
  assert.strictEqual(curLines + g1Lines, preLineCount, 'no line lost across current + .1');
});

test('rotate-size preserves the file mode across rotation', { skip }, () => {
  const root = scratch('retention-rotate-mode-');
  const log = path.join(root, 'daemon.log');
  fs.writeFileSync(log, 'x'.repeat(1_500_000));
  fs.chmodSync(log, 0o600);
  const m = manifestFile(root, [rotateRow('G9', log, '1MB, keep 3 gen')]);

  runSweep(m, ['--apply', '--rotate']);
  assert.strictEqual(fs.statSync(log).mode & 0o777, 0o600, 'the fresh current file must keep the original mode');
  assert.strictEqual(fs.statSync(`${log}.1`).mode & 0o777, 0o600, 'the rotated generation must keep the original mode');
});

test('an unparseable rotate-size cap refuses to act rather than falling back to a default', { skip }, () => {
  const root = scratch('retention-rotate-badcap-');
  const log = path.join(root, 'sessions.log');
  fs.writeFileSync(log, 'x'.repeat(2_000_000));
  const m = manifestFile(root, [rotateRow('G8', log, 'one megabyte')]);

  const out = runSweep(m, ['--apply', '--rotate']);
  assert.strictEqual(fs.statSync(log).size, 2_000_000, 'an unparseable cap must mean no rotation');
  assert.ok(!fs.existsSync(`${log}.1`));
  assert.match(out, /cap not understood: one megabyte/);
});

test('truncate-lines: --apply alone leaves a 2x-over-cap file untouched; --apply --rotate truncates it', { skip }, () => {
  const root = scratch('retention-truncate-gate-');
  const log = path.join(root, 'history.jsonl');
  const lines = Array.from({ length: 4000 }, (_, i) => `{"n":${i}}`);
  fs.writeFileSync(log, lines.join('\n') + '\n');
  const before = fs.readFileSync(log, 'utf8');
  const m = manifestFile(root, [truncateRow('G13', log, 'keep last 2000')]);

  const out1 = runSweep(m, ['--apply']);
  assert.strictEqual(fs.readFileSync(log, 'utf8'), before, '--apply alone must not truncate');
  assert.match(out1, /\[dry-run\] G13/);

  const out2 = runSweep(m, ['--apply', '--rotate']);
  assert.match(out2, /\[rotate\] G13/);
  assert.strictEqual(countLines(log), 2000, 'must keep exactly the last 2000 lines');
});

test('truncate-lines keeps exactly the last N lines and preserves mode', { skip }, () => {
  const root = scratch('retention-truncate-');
  const log = path.join(root, 'history.jsonl');
  const lines = Array.from({ length: 6000 }, (_, i) => `{"n":${i}}`);
  fs.writeFileSync(log, lines.join('\n') + '\n');
  fs.chmodSync(log, 0o600);
  const m = manifestFile(root, [truncateRow('G13', log, 'keep last 5000')]);

  runSweep(m, ['--apply', '--rotate']);
  const kept = fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.length);
  assert.strictEqual(kept.length, 5000, 'must keep exactly the last 5000 lines');
  assert.strictEqual(kept[0], '{"n":1000}', 'must keep the tail, not the head');
  assert.strictEqual(kept[kept.length - 1], '{"n":5999}', 'must keep up to the very last line');
  assert.strictEqual(fs.statSync(log).mode & 0o777, 0o600, 'mode must be preserved across truncation');
});

test('truncate-lines leaves a file under cap untouched', { skip }, () => {
  const root = scratch('retention-truncate-undercap-');
  const log = path.join(root, 'reap-origin.log');
  const content = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n') + '\n';
  fs.writeFileSync(log, content);
  const m = manifestFile(root, [truncateRow('G10', log, 'keep last 2000')]);

  const out = runSweep(m, ['--apply', '--rotate']);
  assert.strictEqual(fs.readFileSync(log, 'utf8'), content, 'a file under cap must be untouched');
  assert.match(out, /under cap=keep last 2000/);
});

test('an unparseable truncate-lines cap refuses to act rather than falling back to a default', { skip }, () => {
  const root = scratch('retention-truncate-badcap-');
  const log = path.join(root, 'history.jsonl');
  const content = Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n') + '\n';
  fs.writeFileSync(log, content);
  const m = manifestFile(root, [truncateRow('G13', log, 'a lot')]);

  const out = runSweep(m, ['--apply', '--rotate']);
  assert.strictEqual(fs.readFileSync(log, 'utf8'), content, 'an unparseable cap must mean no truncation');
  assert.match(out, /cap not understood: a lot/);
});

test('the run marker records the counts and is overwritten, never appended', { skip }, () => {
  const root = scratch('retention-marker-');
  aged(path.join(root, 'sessions', `${DEAD_PID}.json`), '{}', 7 * 86400 * 1000);
  const m = manifestFile(root, [deadPidRow('G2', path.join(root, 'sessions', '*.json'))]);

  runSweep(m, ['--apply'], { RETENTION_STATE_DIR: root });
  const markerPath = path.join(root, '.retention-sweep-last-run');
  const first = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.strictEqual(first.entries_pruned, 1);
  assert.strictEqual(first.errors, 0);
  assert.ok(first.timestamp, 'the marker must carry a timestamp');

  // A second run finds nothing; the marker must be replaced, not grown.
  runSweep(m, ['--apply'], { RETENTION_STATE_DIR: root });
  const second = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.strictEqual(second.entries_pruned, 0, 'the marker must reflect the latest run only');
});

// The timer and a hand-run sweep can collide. Contention must be a quiet no-op, not a
// failed unit and not two sweeps racing over the same directories.
// `skip` carries a reason string; `!flockAvailable` needs its own, or this reports as a bare
// "# SKIP" — the only one of the suite's skips that never said why it sat out.
test('a second sweep exits cleanly while another holds the lock', { skip: skip || (flockAvailable ? false : 'flock unavailable'), timeout: 20000 }, () => {
  const root = scratch('retention-lock-');
  const f = aged(path.join(root, 'sessions', `${DEAD_PID}.json`), '{}', 7 * 86400 * 1000);
  const m = manifestFile(root, [deadPidRow('G2', path.join(root, 'sessions', '*.json'))]);
  const lock = path.join(root, 'sweep.lock');

  // Hold the lock from an unrelated process, then confirm it really is held before
  // running the sweeper — no sleep-and-hope.
  const holder = spawn('bash', ['-c', `exec 9>"${lock}"; flock 9; sleep 10`], { detached: true, stdio: 'ignore' });
  try {
    let held = false;
    for (let i = 0; i < 100 && !held; i += 1) {
      const r = spawnSync('bash', ['-c', `flock -n "${lock}" -c true`]);
      held = r.status !== 0;
      if (!held) spawnSync('bash', ['-c', 'sleep 0.05']);
    }
    assert.ok(held, 'setup: could not get the holder to take the lock');

    const out = runSweep(m, ['--apply'], { RETENTION_STATE_DIR: root, RETENTION_LOCK: lock });
    assert.match(out, /another sweep is running/);
    assert.ok(fs.existsSync(f), 'the blocked sweep must not have deleted anything');
  } finally {
    try { process.kill(-holder.pid, 9); } catch { /* already gone */ }
  }
});

// The suite runs on the same machine the sweeper maintains, and an hourly timer runs the
// real thing. A test that reaches the real ~/.claude does not just make a mess: it
// contends for the sweep lock, so it can silently cause a scheduled sweep to skip.
test('running the suite never touches the real home or the real lock', { skip }, () => {
  const realMarker = path.join(os.homedir(), '.claude', '.retention-sweep-last-run');
  const realLock = path.join(process.env.XDG_RUNTIME_DIR || '/tmp', 'retention-sweep.lock');
  const stamp = (p) => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : null);
  const before = { marker: stamp(realMarker), lock: stamp(realLock) };

  const root = scratch('retention-isolation-');
  aged(path.join(root, 'sessions', `${DEAD_PID}.json`), '{}', 7 * 86400 * 1000);
  const m = manifestFile(root, [deadPidRow('G2', path.join(root, 'sessions', '*.json'))]);
  runSweep(m, ['--apply']);

  assert.strictEqual(stamp(realMarker), before.marker, 'a test wrote the real run marker');
  assert.strictEqual(stamp(realLock), before.lock, 'a test took the real sweep lock');
  assert.ok(fs.existsSync(path.join(root, '.retention-sweep-last-run')),
    'the marker should have landed inside the scratch home instead');
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
