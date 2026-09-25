'use strict';
// bin/gen-lib.js holds the marker splice and the `--check` report that gen-hooks
// splices with, and that both generators report with (#563). Each
// generator's own suite pins its marker syntax end to end; these pin the shared contract:
// the splice keeps both marker lines and everything outside them, it refuses a missing,
// doubled or reversed marker, and the report returns the verdict it prints.
const { test } = require('node:test');
const assert = require('node:assert');

const { spliceBetween, reportCheck } = require('../bin/gen-lib.js');

const OPTS = {
  label: 'gen-x',
  begin: { test: (l) => l.trim() === '# begin', name: '# begin' },
  end: { test: (l) => l.trim() === '# end', name: '# end' },
  where: 'the file',
};

test('spliceBetween replaces only the interior and hands render the begin line', () => {
  const seen = [];
  const out = spliceBetween('head\n  # begin\nstale\n  # end\ntail\n', OPTS, (line) => {
    seen.push(line);
    return 'fresh';
  });
  assert.strictEqual(out, 'head\n  # begin\nfresh\n  # end\ntail\n');
  assert.deepStrictEqual(seen, ['  # begin']);
});

test('spliceBetween refuses a missing, doubled or reversed marker', () => {
  const render = () => 'x';
  assert.throws(() => spliceBetween('no markers\n', OPTS, render), /^Error: gen-x: expected exactly one # begin and one # end marker in the file, found 0 and 0\.$/);
  assert.throws(() => spliceBetween('# begin\n# begin\n# end\n', { ...OPTS, hint: 'Add them.' }, render), /found 2 and 1\. Add them\.$/);
  assert.throws(() => spliceBetween('# end\n# begin\n', OPTS, render), /gen-x: end marker appears before begin marker/);
});

function capture(fn) {
  const out = { stdout: '', stderr: '' };
  const orig = { stdout: process.stdout.write, stderr: process.stderr.write };
  process.stdout.write = (s) => { out.stdout += s; return true; };
  process.stderr.write = (s) => { out.stderr += s; return true; };
  try {
    out.result = fn();
  } finally {
    process.stdout.write = orig.stdout;
    process.stderr.write = orig.stderr;
  }
  return out;
}

test('reportCheck passes an identical file and names the summary', () => {
  const r = capture(() => reportCheck({ tool: 'gen-x', rel: 'a.txt', summary: '3 things' }, 'a\nb\n', 'a\nb\n'));
  assert.strictEqual(r.result, true);
  assert.strictEqual(r.stdout, 'gen-x --check: a.txt is up to date (3 things).\n');
  assert.strictEqual(r.stderr, '');
});

test('reportCheck fails a differing file and names the first differing line', () => {
  const r = capture(() => reportCheck({ tool: 'gen-x', rel: 'a.txt' }, 'a\nnew\n', 'a\nold\n'));
  assert.strictEqual(r.result, false);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /^gen-x --check: a\.txt is out of date\. Run `bin\/gen-x` and commit the result\.\n/);
  assert.match(r.stderr, /first difference at line 2:\n {4}generated: new\n {4}committed: old\n$/);
});
