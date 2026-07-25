// Regression guard for home/dot_local/bin/executable_jsonq.
// Drives the ACTUAL script. The escape suite is the point of this file: jsonq
// carries a blanket `Bash(jsonq:*)` allow rule, so a hole in the AST allowlist
// is a hole with no prompt in front of it.
// Hermetic: fixtures live in a temp dir. Skips cleanly without python3.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JSONQ = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_jsonq');
const HOOK = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_block-dangerous-bash.sh');

let python = 'python3';
let skip = false;
try {
  execFileSync(python, ['--version'], { stdio: 'ignore' });
} catch {
  skip = 'python3 unavailable';
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonq-'));
const T = path.join(DIR, 't.json');
const U = path.join(DIR, 'u.json');
fs.writeFileSync(T, JSON.stringify({
  a: 1, b: [3, 1, 2],
  users: [{ n: 'ada', ok: true }, { n: 'bob', ok: false }],
}));
fs.writeFileSync(U, JSON.stringify({ a: 9, z: 1 }));

// Returns {code, out, err}. Never throws, so a test can assert on failure.
function jsonq(args, input) {
  try {
    const out = execFileSync(python, [JSONQ, ...args], {
      encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, out: out.trim(), err: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '').trim(), err: (e.stderr || '').trim() };
  }
}

const ok = (args, input) => jsonq(args, input).out;

test('evaluates expressions over a document', { skip }, () => {
  assert.strictEqual(ok(['sorted(d)', T]), '["a","b","users"]');
  assert.strictEqual(ok(['[u["n"] for u in d["users"] if u["ok"]]', T]), '["ada"]');
  assert.strictEqual(ok(['sum(d["b"])', T]), '6');
  assert.strictEqual(ok(['max(d["b"])', T]), '3');
});

test('binds d, d1..dN and ds across multiple inputs', { skip }, () => {
  assert.strictEqual(ok(['sorted(set(d1) - set(d2))', T, U]), '["b","users"]');
  assert.strictEqual(ok(['len(ds)', T, U]), '2');
  assert.strictEqual(ok(['d2["a"]', T, U]), '9');
  assert.strictEqual(ok(['d["a"]', T, U]), '1', 'd aliases the first input');
});

test('reads stdin when given no file', { skip }, () => {
  assert.strictEqual(ok(['max(d["x"])'], '{"x":[1,2,3]}'), '3');
});

test('renders raw, indented and compact output', { skip }, () => {
  assert.strictEqual(ok(['-r', 'd["users"][0]["n"]', T]), 'ada');
  assert.strictEqual(ok(['-r', '[u["n"] for u in d["users"]]', T]), 'ada\nbob');
  assert.strictEqual(ok(['--indent', '2', 'd["b"]', T]), '[\n  3,\n  1,\n  2\n]');
  assert.strictEqual(ok(['d["b"]', T]), '[3,1,2]', 'compact by default');
});

test('coerces sets and iterators that a valid expression can return', { skip }, () => {
  assert.strictEqual(ok(['{1,3,2}', T]), '[1,2,3]');
  assert.strictEqual(ok(['map(str, d["b"])', T]), '["3","1","2"]');
  assert.strictEqual(ok(['range(3)', T]), '[0,1,2]');
});

test('exposes the pure stdlib modules', { skip }, () => {
  assert.strictEqual(ok(['len(re.findall("a", "banana"))', T]), '3');
  assert.strictEqual(ok(['math.floor(2.7)', T]), '2');
  assert.strictEqual(ok(['sorted(collections.Counter("aab").items())', T]), '[["a",2],["b",1]]');
  assert.strictEqual(ok(['functools.reduce(lambda x, y: x + y, d["b"])', T]), '6');
  assert.strictEqual(ok(['list(itertools.islice(d["b"], 2))', T]), '[3,1]');
  assert.strictEqual(ok(['statistics.mean(d["b"])', T]), '2');
  assert.strictEqual(ok(['json.loads("[1,2]")', T]), '[1,2]');
});

test('--script runs statements and returns `out`', { skip }, () => {
  assert.strictEqual(ok(['--script', 'out = sum(d["b"])', T]), '6');
  assert.strictEqual(
    ok(['--script', 'acc = []\nfor u in d["users"]:\n    if u["ok"]:\n        acc.append(u["n"])\nout = acc', T]),
    '["ada"]');
  const r = jsonq(['--script', 'x = 1', T]);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.err, /must assign its result to `out`/);
});

test('f-strings work and stay visible to the attribute check', { skip }, () => {
  assert.strictEqual(ok(['-r', 'f"a={d[\'a\']}"', T]), 'a=1');
  const r = jsonq(['f"{d.__class__}"', T]);
  assert.notStrictEqual(r.code, 0, 'dunder inside an f-string must still be rejected');
});

// ---------------------------------------------------------------------------
// Escape suite. Each must be refused BEFORE evaluation, with exit code 2.
// ---------------------------------------------------------------------------
const ESCAPES = [
  ['dunder call', '__import__("os").system("id")'],
  ['subclasses walk', '().__class__.__bases__[0].__subclasses__()'],
  ['subclasses via comprehension', '[c for c in ().__class__.__base__.__subclasses__()]'],
  ['runtime attr via format', '"{0.__class__}".format([])'],
  ['format_map', '"{a}".format_map(d)'],
  ['getattr', 'getattr(d, "__class__")'],
  ['eval', 'eval("1")'],
  ['exec', 'exec("x=1")'],
  ['open', 'open("/etc/passwd")'],
  ['compile', 'compile("1", "x", "eval")'],
  ['vars', 'vars(d)'],
  ['globals', 'globals()'],
  ['dir', 'dir(d)'],
  ['type', 'type(d)'],
  ['input', 'input()'],
  ['builtins name', 'lambda: __builtins__'],
  ['attr on literal', '(1).__class__'],
  ['attr on binding', 'd.__class__'],
  ['list dunder', '[].__class__'],
  ['mro', 'str.mro()'],
];

for (const [label, expr] of ESCAPES) {
  test(`rejects escape: ${label}`, { skip }, () => {
    const r = jsonq([expr, T]);
    assert.strictEqual(r.code, 2, `${expr} should be refused, got code ${r.code} / ${r.out}`);
    assert.match(r.err, /^jsonq: /);
    assert.strictEqual(r.out, '', 'nothing may be evaluated or printed');
  });
}

const SCRIPT_ESCAPES = [
  ['import', 'import os\nout = 1'],
  ['from import', 'from os import system\nout = 1'],
  ['def', 'def f():\n    pass\nout = 1'],
  ['class', 'class C:\n    pass\nout = 1'],
  ['with', 'with open("x") as f:\n    pass\nout = 1'],
  ['try', 'try:\n    pass\nexcept Exception:\n    pass\nout = 1'],
  ['raise', 'raise Exception("x")'],
  ['global', 'global x\nout = 1'],
  ['delete', 'del d\nout = 1'],
  ['underscore binding', '_x = 1\nout = _x'],
];

for (const [label, src] of SCRIPT_ESCAPES) {
  test(`rejects escape in --script: ${label}`, { skip }, () => {
    const r = jsonq(['--script', src, T]);
    assert.strictEqual(r.code, 2, `${label} should be refused, got code ${r.code}`);
    assert.strictEqual(r.out, '');
  });
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------
test('refuses to read a secret path', { skip }, () => {
  const secret = path.join(DIR, 'signing.key');
  fs.writeFileSync(secret, JSON.stringify({ a: 1 }));
  const r = jsonq(['d', secret]);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /secret-path pattern/);

  // Fires before the file is opened, so a path that doesn't exist is still refused.
  const r2 = jsonq(['d', path.join(DIR, 'nope', '.aws', 'credentials')]);
  assert.strictEqual(r2.code, 2);
  assert.match(r2.err, /secret-path pattern/);
});

test('refuses a symlink that launders a secret path', { skip }, () => {
  const secret = path.join(DIR, 'id_rsa');
  fs.writeFileSync(secret, JSON.stringify({ a: 1 }));
  const link = path.join(DIR, 'innocent.json');
  try {
    fs.symlinkSync(secret, link);
  } catch {
    return; // no symlink support; nothing to assert
  }
  const r = jsonq(['d', link]);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /secret-path pattern/);
});

test('jsonq SECRET_PATHS matches the hook it mirrors', { skip }, () => {
  const hook = fs.readFileSync(HOOK, 'utf8');
  const hookMatch = hook.match(/^SECRET_PATHS='(.+)'$/m);
  assert.ok(hookMatch, 'could not find SECRET_PATHS in block-dangerous-bash.sh');
  // POSIX bracket classes are the one permitted divergence — Python's re has no [:space:].
  const fromHook = hookMatch[1].replace(/\[:space:\]/g, '\\s');

  const src = fs.readFileSync(JSONQ, 'utf8');
  const block = src.match(/^SECRET_PATHS = \(\n([\s\S]*?)^\)$/m);
  assert.ok(block, 'could not find SECRET_PATHS in jsonq');
  const fromJsonq = [...block[1].matchAll(/r"([^"]*)"/g)].map((m) => m[1]).join('');

  assert.strictEqual(fromJsonq, fromHook,
    'jsonq and block-dangerous-bash.sh have drifted apart');
});

test('enforces the wall-clock timeout', { skip }, () => {
  const r = jsonq(['--timeout', '1', '--script', 'while True:\n    pass\nout = 1', T]);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /timeout/);
});

test('reports bad input without a traceback', { skip }, () => {
  const bad = path.join(DIR, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  const r = jsonq(['d', bad]);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /invalid JSON/);
  assert.doesNotMatch(r.err, /Traceback/);

  const missing = jsonq(['d', path.join(DIR, 'absent.json')]);
  assert.strictEqual(missing.code, 2);
  assert.match(missing.err, /no such file/);
});

test('reports an expression error as exit 1, distinct from a refusal', { skip }, () => {
  const r = jsonq(['d["nope"]', T]);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /KeyError/);
  assert.doesNotMatch(r.err, /Traceback/);
});

test('rejects a syntax error before evaluating', { skip }, () => {
  const r = jsonq(['d[', T]);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /syntax error/);
});
