// Holds the suite to the rule the rest of the suite already follows: a test writes into a
// temp dir it made, and nowhere else. See tests/lib/sandbox-escape.js for the three
// incidents this generalises from.
//
// Every fixture below is a string literal, which is how this file can state the bug shape
// without tripping its own guard — findEscapes blanks string contents before scanning, so
// the walker sees these as inert text while the checker sees them as source. Nothing here
// touches the filesystem except reading the files under test.
//
// There is deliberately no allowlist, unlike tests/managed-test-drift.test.js. That one
// guards a judgement call — thirty-eight test files legitimately deploy — whereas there is
// no correct way to write into the checkout or the real home from a test. If a case ever
// turns up that genuinely needs it, the fix is a temp copy, which is what the failure
// message says.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { findEscapes, blankLiterals } = require('./lib/sandbox-escape');

const REPO = path.join(__dirname, '..');

// The suite is not only tests/. .githooks/pre-push step 5 runs `node --test` from the repo
// root, and the evals and config-soak libraries are exercised by tests here while living
// elsewhere. Scanning tests/ alone would report "clean" for files nobody walked, which is
// the same silent hole the lex-failure path below refuses to leave.
const SCANNED = [
  ['tests', /\.test\.m?js$/],
  ['tests/lib', /\.js$/],
  ['evals', /\.mjs$/],
  ['evals/lib', /\.mjs$/],
  ['bin', /\.js$/],
];

const sources = () => SCANNED.flatMap(([dir, pattern]) => {
  const abs = path.join(REPO, dir);
  return fs.readdirSync(abs).filter((f) => pattern.test(f)).map((f) => path.join(abs, f));
});

test('no test writes outside its own scratch directory', () => {
  const files = sources();
  assert.ok(files.length > 50, `sanity: expected to find the suite, got ${files.length} files`);

  const offenders = [];
  for (const file of files) {
    const rel = path.relative(REPO, file);
    let escapes;
    try {
      escapes = findEscapes(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      // A file the lexer cannot read is reported, never skipped: skipping it would be a
      // silent hole in the guard that looks exactly like a pass.
      assert.fail(`${rel}: ${e.message}`);
    }
    for (const e of escapes) {
      offenders.push(`  ${rel}:${e.line}  fs.${e.api} writes into ${e.root.what}\n`
        + `      target: ${e.arg}\n`
        + `      fix:    ${e.root.fix}`);
    }
  }

  assert.deepStrictEqual(offenders, [],
    'these writes land in live state that outlives the run:\n' + offenders.join('\n'));
});

test('catches a write into the checkout, through a chain of bound names', () => {
  const bad = [
    "const REPO = path.join(__dirname, '..');",
    "const SOURCE = path.join(REPO, 'home');",
    "fs.writeFileSync(path.join(SOURCE, 'probe.sh'), '#!/bin/sh\\n');",
  ].join('\n');

  const [found, ...rest] = findEscapes(bad);
  assert.deepStrictEqual(rest, [], 'expected exactly one escape');
  assert.strictEqual(found.line, 3);
  assert.strictEqual(found.api, 'writeFileSync');
  assert.strictEqual(found.root.what, 'the repo checkout');
});

test('catches a write into the real home', () => {
  const bad = [
    "const marker = path.join(os.homedir(), '.claude', 'marker');",
    "fs.writeFileSync(marker, '');",
  ].join('\n');

  const found = findEscapes(bad);
  assert.strictEqual(found.length, 1, `expected one escape, got ${JSON.stringify(found)}`);
  assert.strictEqual(found[0].root.what, 'the real home');
});

test('catches a destination built by template substitution', () => {
  // Substitutions are stepped back into code rather than blanked with the surrounding
  // string, so this shape cannot hide inside a template literal.
  const bad = "const SOURCE = path.join(__dirname, '..', 'home');\n"
    + 'fs.mkdirSync(`${SOURCE}/scratch`);';

  const found = findEscapes(bad);
  assert.strictEqual(found.length, 1, `expected one escape, got ${JSON.stringify(found)}`);
  assert.strictEqual(found[0].api, 'mkdirSync');
});

test('leaves the read side of a copy alone', () => {
  // The recommended fix for every case above is to copy the tree out and work on the copy.
  // A guard that flagged the fix would just push people back to writing in place.
  const good = [
    "const SOURCE = path.join(__dirname, '..', 'home');",
    "const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'x-')), 'home');",
    'fs.cpSync(SOURCE, copy, { recursive: true });',
    "fs.writeFileSync(path.join(copy, 'probe.sh'), '');",
  ].join('\n');

  assert.deepStrictEqual(findEscapes(good), []);
});

test('ignores the shape in comments and strings', () => {
  const inert = [
    "const SOURCE = path.join(__dirname, '..', 'home');",
    "// never do this: fs.writeFileSync(path.join(SOURCE, 'x'), '')",
    "/* fs.rmSync(SOURCE, { recursive: true }) */",
    "const doc = \"fs.mkdirSync(SOURCE)\";",
    'const snippet = `fs.appendFileSync(SOURCE, "x")`;',
  ].join('\n');

  assert.deepStrictEqual(findEscapes(inert), []);
});

test('a regex containing a quote does not blank the rest of the file', () => {
  // Without the regex heuristic this apostrophe opens a string literal that never closes,
  // so everything after it is blanked and the guard reports a clean file. The suite is
  // full of regexes; this is the failure that would have made the guard quietly useless.
  const bad = [
    "const SOURCE = path.join(__dirname, '..', 'home');",
    "assert.match(out, /doesn't converge/);",
    "fs.writeFileSync(path.join(SOURCE, 'probe.sh'), '');",
  ].join('\n');

  const found = findEscapes(bad);
  assert.strictEqual(found.length, 1, `the regex swallowed the file: ${JSON.stringify(found)}`);
  assert.strictEqual(found[0].line, 3);
});

test('a regex literal after a keyword is not read as division', () => {
  // tests/chezmoi-umask-wrapper.test.js:41 is `return /chezmoi.../s.test(src)`. The
  // character before the slash is a letter, so the punctuation heuristic alone calls it
  // division and scans the pattern as code — where this apostrophe opens a string that
  // never closes.
  const bad = [
    "const SOURCE = path.join(__dirname, '..', 'home');",
    "const hit = () => { return /doesn't converge/.test(out); };",
    "fs.writeFileSync(path.join(SOURCE, 'probe.sh'), '');",
  ].join('\n');

  const found = findEscapes(bad);
  assert.strictEqual(found.length, 1, `the regex swallowed the file: ${JSON.stringify(found)}`);
  assert.strictEqual(found[0].line, 3);
});

test('refuses to report a clean file it could not lex', () => {
  assert.throws(() => blankLiterals('const s = "never closed;\n'), /could not lex/);
});
