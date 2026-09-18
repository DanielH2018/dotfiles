// bin/sweep-test-tmp reaps scratch dirs from test runs whose cleanup handlers never got
// to run (node killed by SIGKILL). Two properties carry the safety of deleting things in
// $TMPDIR, and both are asserted here:
//
//   - it only matches prefixes some tracked test actually passes to os.tmpdir(), so an
//     unrelated /tmp entry cannot be swept even if it looks like scratch;
//   - it only takes dirs older than the age threshold, so a suite running in the next
//     session over -- several run at once here -- is never swept out from under itself.
//
// The last test here is about the suites rather than the sweep: it holds the line that
// made the sweep a backstop instead of the cleanup. Seven suites made scratch and never
// removed it, leaking on every clean run -- the sweep would have hidden that indefinitely,
// collecting the same dirs six hours late, forever.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scratch } = require('./lib/tmp');

const SWEEP = path.join(__dirname, '..', 'bin', 'sweep-test-tmp');

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
  const repo = scratch(os.tmpdir(), 'sweep-repo-');
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
  const tmp = scratch(os.tmpdir(), 'sweep-tmp-');
  const old = mk(tmp, 'sweepable-AAAAAA', 24);

  const { status } = run(repo, tmp);
  assert.strictEqual(status, 0);
  assert.ok(!fs.existsSync(old), 'a stale dir under a declared prefix should be gone');
});

// tests/lib/tmp.js takes the root as an argument for exactly this reason: a call site spells
// `os.tmpdir(), '<prefix>'` where the sweep's grep can read it. This is the test that goes
// red if the helper ever takes a bare prefix, which would drop every file using it from the
// sweep's view without any other test noticing.
test('a prefix passed through tests/lib/tmp.js is swept too', () => {
  const repo = fakeRepo("const d = scratch(os.tmpdir(), 'viahelper-');\n");
  const tmp = scratch(os.tmpdir(), 'sweep-tmp-');
  const old = mk(tmp, 'viahelper-AAAAAA', 24);

  const { status } = run(repo, tmp);
  assert.strictEqual(status, 0);
  assert.ok(!fs.existsSync(old), 'a stale dir under a helper-declared prefix should be gone');
});

test('leaves a dir younger than the threshold alone', () => {
  const repo = fakeRepo(SOURCE);
  const tmp = scratch(os.tmpdir(), 'sweep-tmp-');
  const fresh = mk(tmp, 'sweepable-BBBBBB');   // a run in flight next to this one

  run(repo, tmp);
  assert.ok(fs.existsSync(fresh), 'a fresh dir belongs to a live run and must survive');
});

test('leaves a stale dir alone when no test declares its prefix', () => {
  const repo = fakeRepo(SOURCE);
  const tmp = scratch(os.tmpdir(), 'sweep-tmp-');
  const other = mk(tmp, 'not-a-test-dir', 24);

  run(repo, tmp);
  assert.ok(fs.existsSync(other), 'only prefixes a tracked test declares may be swept');
});

test('refuses a prefix too short to identify scratch, and says so', () => {
  const repo = fakeRepo(SOURCE);
  const tmp = scratch(os.tmpdir(), 'sweep-tmp-');
  const risky = mk(tmp, 'x-CCCCCC', 24);

  const { err } = run(repo, tmp);
  assert.ok(fs.existsSync(risky), "a two-character prefix must not be swept");
  assert.match(err, /prefix too short to sweep safely:(?: \S+)* x-/, 'the narrowing must be reported, not silent');
});

test('--dry-run reports what it would take without taking it', () => {
  const repo = fakeRepo(SOURCE);
  const tmp = scratch(os.tmpdir(), 'sweep-tmp-');
  const old = mk(tmp, 'sweepable-DDDDDD', 24);

  const { out } = run(repo, tmp, ['--dry-run']);
  assert.ok(fs.existsSync(old), '--dry-run must not delete');
  assert.match(out, /would remove .*sweepable-DDDDDD/);
});

test('SWEEP_AGE_MIN moves the threshold', () => {
  const repo = fakeRepo(SOURCE);
  const tmp = scratch(os.tmpdir(), 'sweep-tmp-');
  const hourOld = mk(tmp, 'sweepable-EEEEEE', 1);

  const r = require('node:child_process').spawnSync(
    path.join(repo, 'bin', 'sweep-test-tmp'), [],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, TMPDIR: tmp, SWEEP_AGE_MIN: '30' } },
  );
  assert.strictEqual(r.status, 0);
  assert.ok(!fs.existsSync(hourOld), 'an hour-old dir should go once the threshold drops to 30m');
});

test('every suite that makes scratch in $TMPDIR also removes it', () => {
  // Not named `repo`: fakeRepo() above binds that to a temp dir, and the write-escape
  // guard reads these files statically -- one name for both would make its every
  // `path.join(repo, …)` look like a write into the real checkout.
  const checkout = path.join(__dirname, '..');
  const tracked = execFileSync('git', ['ls-files', '*.test.js', '*.test.mjs'], { cwd: checkout, encoding: 'utf8' })
    .split('\n').filter(Boolean);

  // A suite is clean when it removes its own scratch, or makes it through tests/lib/tmp.js,
  // which removes it. The census is asserted non-empty by name: most suites moved onto the
  // helper, and a filter over a corpus that no longer matches anything passes for free.
  const makesScratch = tracked.filter((f) => {
    const src = fs.readFileSync(path.join(checkout, f), 'utf8');
    return src.includes('mkdtempSync(path.join(os.tmpdir()') || src.includes('scratch(os.tmpdir(),');
  });
  for (const f of ['tests/sweep-test-tmp.test.js', 'tests/lib/tmp.test.js', 'tests/statusline-command.test.js']) {
    assert.ok(makesScratch.includes(f), `${f} makes scratch and must be in the census`);
  }
  const leaky = makesScratch.filter((f) => {
    const src = fs.readFileSync(path.join(checkout, f), 'utf8');
    return !src.includes('rmSync') && !/(lib\/|\.\/)tmp(\.js)?'/.test(src);
  });

  assert.deepStrictEqual(
    leaky, [],
    'these suites leave scratch in $TMPDIR on every clean run; remove it on exit rather '
    + 'than leaving it to bin/sweep-test-tmp, which only collects it six hours later',
  );
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
