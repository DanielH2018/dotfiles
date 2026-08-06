// bin/sweep-test-tmp reaps scratch dirs from test runs whose cleanup handlers never got
// to run (node killed by SIGKILL). Two properties carry the safety of deleting things in
// $TMPDIR, and both are asserted here:
//
//   - it only matches prefixes some tracked test actually passes to os.tmpdir(), so an
//     unrelated /tmp entry cannot be swept even if it looks like scratch;
//   - it only takes dirs older than the age threshold, so a suite running in the next
//     session over -- several run at once here -- is never swept out from under itself.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SWEEP = path.join(__dirname, '..', 'bin', 'sweep-test-tmp');

const dirs = [];
const scratch = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// Makes a dir in `tmp` and backdates it, since age is what the sweep decides on.
const mk = (tmp, name, hoursAgo = 0) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  if (hoursAgo) {
    const when = new Date(Date.now() - hoursAgo * 3600 * 1000);
    fs.utimesSync(dir, when, when);
  }
  return dir;
};

// A throwaway repo whose only tracked test file declares the prefixes under test. The
// script reads them with `git ls-files`, so the file has to be in the index -- staging is
// enough, which keeps this clear of the repo's commit signing.
function fakeRepo(testSource) {
  const repo = scratch('sweep-repo-');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'bin'));
  fs.copyFileSync(SWEEP, path.join(repo, 'bin', 'sweep-test-tmp'));
  fs.chmodSync(path.join(repo, 'bin', 'sweep-test-tmp'), 0o755);
  fs.mkdirSync(path.join(repo, 'tests'));
  fs.writeFileSync(path.join(repo, 'tests', 'fake.test.js'), testSource);
  execFileSync('git', ['add', 'tests/fake.test.js'], { cwd: repo });
  return repo;
}

const run = (repo, tmp, args = []) => {
  const r = require('node:child_process').spawnSync(
    path.join(repo, 'bin', 'sweep-test-tmp'), args,
    { cwd: repo, encoding: 'utf8', env: { ...process.env, TMPDIR: tmp } },
  );
  return { out: r.stdout || '', err: r.stderr || '', status: r.status };
};

const SOURCE = `
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sweepable-'));
  const e = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
`;

test('sweeps a declared prefix once it is past the age threshold', () => {
  const repo = fakeRepo(SOURCE);
  const tmp = scratch('sweep-tmp-');
  const old = mk(tmp, 'sweepable-AAAAAA', 24);

  const { status } = run(repo, tmp);
  assert.strictEqual(status, 0);
  assert.ok(!fs.existsSync(old), 'a stale dir under a declared prefix should be gone');
});

test('leaves a dir younger than the threshold alone', () => {
  const repo = fakeRepo(SOURCE);
  const tmp = scratch('sweep-tmp-');
  const fresh = mk(tmp, 'sweepable-BBBBBB');   // a run in flight next to this one

  run(repo, tmp);
  assert.ok(fs.existsSync(fresh), 'a fresh dir belongs to a live run and must survive');
});

test('leaves a stale dir alone when no test declares its prefix', () => {
  const repo = fakeRepo(SOURCE);
  const tmp = scratch('sweep-tmp-');
  const other = mk(tmp, 'not-a-test-dir', 24);

  run(repo, tmp);
  assert.ok(fs.existsSync(other), 'only prefixes a tracked test declares may be swept');
});

test('refuses a prefix too short to identify scratch, and says so', () => {
  const repo = fakeRepo(SOURCE);
  const tmp = scratch('sweep-tmp-');
  const risky = mk(tmp, 'x-CCCCCC', 24);

  const { err } = run(repo, tmp);
  assert.ok(fs.existsSync(risky), "a two-character prefix must not be swept");
  assert.match(err, /prefix too short to sweep safely:(?: \S+)* x-/, 'the narrowing must be reported, not silent');
});

test('--dry-run reports what it would take without taking it', () => {
  const repo = fakeRepo(SOURCE);
  const tmp = scratch('sweep-tmp-');
  const old = mk(tmp, 'sweepable-DDDDDD', 24);

  const { out } = run(repo, tmp, ['--dry-run']);
  assert.ok(fs.existsSync(old), '--dry-run must not delete');
  assert.match(out, /would remove .*sweepable-DDDDDD/);
});

test('SWEEP_AGE_MIN moves the threshold', () => {
  const repo = fakeRepo(SOURCE);
  const tmp = scratch('sweep-tmp-');
  const hourOld = mk(tmp, 'sweepable-EEEEEE', 1);

  const r = require('node:child_process').spawnSync(
    path.join(repo, 'bin', 'sweep-test-tmp'), [],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, TMPDIR: tmp, SWEEP_AGE_MIN: '30' } },
  );
  assert.strictEqual(r.status, 0);
  assert.ok(!fs.existsSync(hourOld), 'an hour-old dir should go once the threshold drops to 30m');
});

test('the pre-push gate runs the sweep without letting it block a push', () => {
  const hook = fs.readFileSync(path.join(__dirname, '..', '.githooks', 'pre-push'), 'utf8');
  assert.match(hook, /bin\/sweep-test-tmp/, 'the gate must actually invoke the sweep');
  assert.match(
    hook,
    /bin\/sweep-test-tmp"? \|\| true/,
    'housekeeping must not be able to fail a push',
  );
});
