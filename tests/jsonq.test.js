// Regression guard for home/dot_local/bin/executable_jsonq.
// Drives the ACTUAL script.
//
// jsonq carries a blanket `Bash(jsonq:*)` allow rule, so a hole here is a hole
// with no prompt in front of it. What this file can and cannot prove changed
// with the rewrite, and the distinction is the point:
//
//   The OLD jsonq validated an AST allowlist and then called eval(). Its escape
//   suite could only ever assert "the escapes I thought of are refused" — it was
//   green for the whole period the tool was fully escapable, because eval
//   accepted a larger language than the allowlist described.
//
//   The NEW jsonq interprets the tree itself. The safety property is structural
//   ("no eval, no compile, no attribute access, closed function table"), so the
//   structure block below asserts that property directly and the escape suite
//   is a convenience check on top of it, not the load-bearing part.
//
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

const dirs = [];
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonq-'));
dirs.push(DIR);
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
const SOURCE = fs.readFileSync(JSONQ, 'utf8');

// ---------------------------------------------------------------------------
// Structure. These assert the safety property itself rather than a sample of
// its consequences — they are what the escape suite used to pretend to be.
// ---------------------------------------------------------------------------
test('the interpreter never hands anything to CPython to run', { skip }, () => {
  // Comments and docstrings name eval/exec/compile to explain why they are
  // gone, so match call syntax rather than the bare word.
  for (const bad of ['eval(', 'exec(', 'compile(', '__import__(']) {
    assert.ok(!SOURCE.includes(bad),
      `executable_jsonq must not contain ${bad} — the whole design is that the `
      + 'tree is walked, not compiled');
  }
});

test('ast.Attribute has no handler, so `x.y` cannot run at all', { skip }, () => {
  assert.ok(!/ast\.Attribute\s*:/.test(SOURCE),
    'an entry for ast.Attribute in a dispatch table would reintroduce methods '
    + 'and module namespaces, which is the escape route the rewrite removed');
});

test('the escape-prone builtins are absent from the function table', { skip }, () => {
  const table = ok(['--functions']);
  for (const name of ['type', 'getattr', 'setattr', 'vars', 'globals', 'locals',
    'dir', 'eval', 'exec', 'compile', 'open', 'input', 'format', 'help',
    'breakpoint', 'memoryview', 'object', 'super']) {
    assert.ok(!new RegExp(`(^|\\s)${name}(\\s|$)`, 'm').test(table),
      `${name} must not be callable`);
  }
  assert.match(table, /\bkind\b/, 'kind() is the sanctioned stand-in for type()');
});

test('--functions lists every callable, and nothing outside it resolves', { skip }, () => {
  const table = ok(['--functions']);
  const names = table.split('\n')
    .filter((l) => l.startsWith('  '))
    .flatMap((l) => l.trim().split(/\s+/));
  assert.ok(names.length > 40, 'the table should be listed in full, not summarised');
  for (const name of names) {
    // Naming an advertised function must resolve. It still exits 1, because a
    // function is not JSON — the assertion is that it is not *refused*, which
    // is what an unbound name gets. The point of the loop is the contrast with
    // the unbound case below: nothing outside this list resolves at all.
    const r = jsonq([name, T]);
    assert.notStrictEqual(r.code, 2, `${name} is advertised but is not bound`);
    assert.doesNotMatch(r.err, /not allowed/, `${name} is advertised but refused`);
  }
  const r = jsonq(['nosuchfunction(1)', T]);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /not allowed/);
});

// ---------------------------------------------------------------------------
// Semantics
// ---------------------------------------------------------------------------
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

test('coerces sets and tuples into JSON', { skip }, () => {
  assert.strictEqual(ok(['{1,3,2}', T]), '[1,2,3]');
  assert.strictEqual(ok(['map(str, d["b"])', T]), '["3","1","2"]');
  assert.strictEqual(ok(['range(3)', T]), '[0,1,2]');
  assert.strictEqual(ok(['divmod(7, 2)', T]), '[3,1]');
});

test('supports slices, chained comparison and boolean short-circuit', { skip }, () => {
  assert.strictEqual(ok(['d["b"][::-1]', T]), '[2,1,3]');
  assert.strictEqual(ok(['d["b"][1:]', T]), '[1,2]');
  assert.strictEqual(ok(['0 < d["a"] < 5', T]), 'true');
  assert.strictEqual(ok(['1 < d["a"] < 5', T]), 'false');
  assert.strictEqual(ok(['d["a"] or "fallback"', T]), '1');
  assert.strictEqual(ok(['0 or "fallback"', T]), '"fallback"');
  assert.strictEqual(ok(['"a" in d and "zz" not in d', T]), 'true');
  assert.strictEqual(ok(['d["a"] if d["a"] > 0 else "neg"', T]), '1');
});

test('lambdas work as sort keys and as arguments', { skip }, () => {
  assert.strictEqual(ok(['sorted(d["b"], key=lambda x: -x)', T]), '[3,2,1]');
  assert.strictEqual(ok(['max(d["users"], key=lambda u: u["n"])["n"]', T]), '"bob"');
  assert.strictEqual(ok(['filter(lambda u: u["ok"], d["users"])', T]),
    '[{"n":"ada","ok":true}]');
  assert.strictEqual(ok(['(lambda x, y=10: x + y)(1)', T]), '11');
});

test('comprehensions cover list, set, dict and generator forms', { skip }, () => {
  assert.strictEqual(ok(['{x for x in d["b"] if x > 1}', T]), '[2,3]');
  assert.strictEqual(ok(['{k: len(k) for k in sorted(d)}', T]),
    '{"a":1,"b":1,"users":5}');
  assert.strictEqual(ok(['sum(x for x in d["b"])', T]), '6');
  assert.strictEqual(ok(['[[x, y] for x in [1, 2] for y in [3] if x > 1]', T]),
    '[[2,3]]');
});

// The function table is what keeps the no-attribute-access rule usable. If one
// of these regresses, the tool cannot do the thing it exists to do.
test('dict, string and json helpers replace the retired method calls', { skip }, () => {
  assert.strictEqual(ok(['sorted(keys(d))', T]), '["a","b","users"]');
  assert.strictEqual(ok(['values(d2)', T, U]), '[9,1]');
  assert.strictEqual(ok(['sorted(items(d2))', T, U]), '[["a",9],["z",1]]');
  assert.strictEqual(ok(['get(d, "nope", "dflt")', T]), '"dflt"');
  assert.strictEqual(ok(['merge(d2, {"a": 0})', T, U]), '{"a":0,"z":1}');
  assert.strictEqual(ok(['upper("ab")', T]), '"AB"');
  assert.strictEqual(ok(['startswith("abc", "ab")', T]), 'true');
  assert.strictEqual(ok(['split("a,b", ",")', T]), '["a","b"]');
  assert.strictEqual(ok(['join("-", d["b"])', T]), '"3-1-2"');
  assert.strictEqual(ok(['loads("[1,2]")', T]), '[1,2]');
  assert.strictEqual(ok(['-r', 'dumps(d["b"])', T]), '[3,1,2]');
});

test('regex, numeric and collection helpers behave', { skip }, () => {
  assert.strictEqual(ok(['len(re_findall("a", "banana"))', T]), '3');
  assert.strictEqual(ok(['re_test("^ban", "banana")', T]), 'true');
  assert.strictEqual(ok(['re_search("n.n", "banana")', T]), '"nan"');
  assert.strictEqual(ok(['re_groups("(a)(n)", "banana")', T]), '["a","n"]');
  assert.strictEqual(ok(['re_sub("a", "-", "banana")', T]), '"b-n-n-"');
  assert.strictEqual(ok(['floor(2.7)', T]), '2');
  assert.strictEqual(ok(['mean(d["b"])', T]), '2');
  assert.strictEqual(ok(['unique([1, 1, 2, 1])', T]), '[1,2]');
  assert.strictEqual(ok(['unique([{"a":1},{"a":1}])', T]), '[{"a":1}]',
    'dedupe must work on unhashable JSON values too');
  assert.strictEqual(ok(['flatten([[1], [2, 3]])', T]), '[1,2,3]');
  assert.strictEqual(ok(['counter("aab")', T]), '{"a":2,"b":1}');
  assert.strictEqual(ok(['groupby(d["users"], lambda u: u["n"])["ada"][0]["ok"]', T]),
    'true');
  assert.strictEqual(ok(['kind(d)', T]), '"dict"');
  assert.strictEqual(ok(['kind(None)', T]), '"null"');
});

test('--script runs statements and returns `out`', { skip }, () => {
  assert.strictEqual(ok(['--script', 'out = sum(d["b"])', T]), '6');
  assert.strictEqual(
    // `acc.append(...)` went with attribute access; `+=` is the replacement.
    ok(['--script', 'acc = []\nfor u in d["users"]:\n    if u["ok"]:\n        acc += [u["n"]]\nout = acc', T]),
    '["ada"]');
  assert.strictEqual(
    ok(['--script', 'n = 0\nwhile n < 3:\n    n += 1\nout = n', T]), '3');
  assert.strictEqual(
    ok(['--script', 'out = []\nfor x in d["b"]:\n    if x == 1:\n        continue\n    if x == 2:\n        break\n    out += [x]', T]),
    '[3]');
  assert.strictEqual(
    ok(['--script', 'a, b = 1, 2\nout = [b, a]', T]), '[2,1]', 'tuple unpacking');
  const r = jsonq(['--script', 'x = 1', T]);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.err, /must assign its result to `out`/);
});

test('f-strings interpolate with JSON spelling', { skip }, () => {
  assert.strictEqual(ok(['-r', 'f"a={d[\'a\']}"', T]), 'a=1');
  assert.strictEqual(ok(['-r', 'f"{d[\'users\'][0][\'ok\']}"', T]), 'true',
    'a bool renders as JSON true, not Python True');
  assert.strictEqual(ok(['-r', 'f"{d[\'a\']:03d}"', T]), '001', 'format spec');
  const r = jsonq(['f"{d.__class__}"', T]);
  assert.strictEqual(r.code, 2, 'attribute access inside an f-string is still refused');
});

// ---------------------------------------------------------------------------
// Escape suite. Kept from the previous design so the known-bad inputs stay
// covered, but see the header: it is no longer what makes the tool safe.
// Each must be refused with exit code 2 and print nothing.
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
  // The two escapes the audit actually proved: module traversal to sys and to
  // builtins. Both are now plain unbound names, because no module is bound.
  ['module hop to sys', 'statistics.sys.modules["os"]'],
  ['module hop to builtins', 'str(re.enum.bltns.open)'],
  ['json module hop', 'json.decoder.codecs.open("/etc/passwd")'],
  // Ordinary method calls, refused for the same structural reason — which is
  // why migrating to the function table is not optional.
  ['dict method', 'd.get("a")'],
  ['string method', '"ab".upper()'],
  ['list method', 'd["b"].sort()'],
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
  ['decorator', '@staticmethod\ndef f():\n    pass\nout = 1'],
  ['walrus', 'out = [(y := 1)]'],
];

for (const [label, src] of SCRIPT_ESCAPES) {
  test(`rejects escape in --script: ${label}`, { skip }, () => {
    const r = jsonq(['--script', src, T]);
    assert.strictEqual(r.code, 2, `${label} should be refused, got code ${r.code}`);
    assert.strictEqual(r.out, '');
  });
}

test('no non-JSON Python object can enter the value domain', { skip }, () => {
  // re.sub's callable-replacement form hands the callback a live match object.
  // Nothing could be done with it (no attribute access, no assignment in a
  // lambda), but allowing it would put a hole in the claim that the reachable
  // graph is JSON values, table functions and lambdas — nothing else.
  const r = jsonq(['re_sub("a", lambda m: "x", "abc")', T]);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /must be a string/);
  assert.strictEqual(ok(['re_sub("a", "-", "abc")', T]), '"-bc"', 'the string form still works');
});

test('a format spec cannot be used as an allocation request', { skip }, () => {
  // Twelve characters, ten billion bytes. None of the arithmetic caps see it.
  const r = jsonq(['-r', 'f"{1:>10000000000}"', T]);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /format spec/);
});

test('a JSON value in the callee position is refused, not called', { skip }, () => {
  const r = jsonq(['d["a"](1)', T]);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /callable/);
});

test('statements are refused outside --script', { skip }, () => {
  const r = jsonq(['x = 1', T]);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /syntax error/);
});

// ---------------------------------------------------------------------------
// Resource caps. An interpreter trades sandbox escapes for runaway work, and
// SIGALRM cannot interrupt a single C-level operation, so these caps are the
// only thing between a 12-character expression and the machine's memory.
// ---------------------------------------------------------------------------
test('refuses arithmetic that would build an enormous value', { skip }, () => {
  for (const expr of ['2**10**9', '1 << 10**9', '"x" * 10**9', '[0] * 10**9',
    'range(10**9)', 'int("9" * 10000)']) {
    const r = jsonq([expr, T]);
    assert.strictEqual(r.code, 2, `${expr} should be refused, got ${r.code}`);
    assert.match(r.err, /refusing|exceeds/);
  }
});

test('refuses an expression nested past the interpreter depth cap', { skip }, () => {
  const r = jsonq([`${'('.repeat(300)}1${')'.repeat(300)}`, T]);
  assert.strictEqual(r.code, 2);
  assert.doesNotMatch(r.err, /Traceback/);
});

test('enforces the wall-clock timeout', { skip }, () => {
  const r = jsonq(['--timeout', '1', '--script', 'while True:\n    pass\nout = 1', T]);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /timeout/);
});

test('caps output size', { skip }, () => {
  const r = jsonq(['--script', 'out = "x" * 6000000 + "y" * 6000000', T]);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /10 MB cap/);
});

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

  const block = SOURCE.match(/^SECRET_PATHS = \(\n([\s\S]*?)^\)$/m);
  assert.ok(block, 'could not find SECRET_PATHS in jsonq');
  const fromJsonq = [...block[1].matchAll(/r"([^"]*)"/g)].map((m) => m[1]).join('');

  assert.strictEqual(fromJsonq, fromHook,
    'jsonq and block-dangerous-bash.sh have drifted apart');
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

  const t = jsonq(['upper(1)', T]);
  assert.strictEqual(t.code, 1, "a wrong argument type is the user's error, not a refusal");
  assert.doesNotMatch(t.err, /Traceback/);
});

test('rejects a syntax error before evaluating', { skip }, () => {
  const r = jsonq(['d[', T]);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /syntax error/);
});

test('the attribute refusal names its replacement', { skip }, () => {
  // The migration cost of this rewrite is real, so the error has to teach.
  const r = jsonq(['d.get("a")', T]);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /--functions/);
  assert.match(r.err, /keys\(d\)/);
});

// --jsonl exists so transcript scanning stops falling back to `python3 -c`.
const L = path.join(DIR, 'l.jsonl');
fs.writeFileSync(L, '{"type":"user","n":1}\n\n{"type":"assistant","n":2}\n{"type":"user","n":3}\n');

test('--jsonl parses one record per line and skips blanks', { skip }, () => {
  assert.strictEqual(ok(['--jsonl', 'len(d)', L]), '3', 'blank line is not a record');
  assert.strictEqual(ok(['--jsonl', '[x["n"] for x in d if x["type"] == "user"]', L]), '[1,3]');
  assert.strictEqual(ok(['--jsonl', 'd[0]["n"]', L]), '1');
});

test('--jsonl reads stdin and binds d1..dN per file', { skip }, () => {
  assert.strictEqual(ok(['--jsonl', 'len(d)'], '{"a":1}\n{"a":2}\n'), '2');
  assert.strictEqual(ok(['--jsonl', 'len(ds)', L, L]), '2');
  assert.strictEqual(ok(['--jsonl', 'len(d2)', L, L]), '3');
});

test('--jsonl names the offending line and refuses without a traceback', { skip }, () => {
  const bad = path.join(DIR, 'bad.jsonl');
  fs.writeFileSync(bad, '{"ok":1}\n{oops\n');
  const r = jsonq(['--jsonl', 'len(d)', bad]);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /:2: invalid JSON/, 'error should carry the line number');
  assert.doesNotMatch(r.err, /Traceback/);
});

test('JSONL still fails without --jsonl, and JSON still works with it off', { skip }, () => {
  const r = jsonq(['len(d)', L]);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /invalid JSON/);
  assert.strictEqual(ok(['sorted(d)', T]), '["a","b","users"]', 'plain mode unaffected');
});

test('--jsonl does not bypass the secret-path guard', { skip }, () => {
  const r = jsonq(['--jsonl', 'len(d)', path.join(os.homedir(), '.claude.json')]);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /secret-path/);
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
