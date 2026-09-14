// Guards against a trap `nodenext` creates: `import ... from './foo.js'` type-checks clean
// even when the real file is `foo.ts` — TypeScript's own TS2835 message for a missing
// extension even suggests it ("Did you mean './types.js'?"). Node's ESM loader on v24 does
// not rewrite .js to .ts, so that specifier throws ERR_MODULE_NOT_FOUND at runtime. tsc has
// no flag for this (the .js-to-.ts mirror is nodenext's intended convention for compiled
// projects), so it is checked here instead.
//
// The rule is NOT "no relative .js specifier" — public/ holds browser JavaScript with no
// build step, where `import './group.js'` against a real group.js is the only correct
// spelling. The discriminator is whether a real .js file exists at the resolved path: flag
// a relative .js specifier only when no .js file exists there AND a sibling .ts file does.
// That is precisely the trap — the specifier resolves for tsc and not for Node. A missing
// file at either extension is tsc's problem to report, not this guard's.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(__dirname, '..');

type Hit = { line: number; specifier: string };
type Violation = Hit & { message: string };

// Matches the specifier inside a static `from '...'`/`from "..."` or a dynamic
// `import('...')`, restricted to a relative path (./ or ../) ending in .js. `\s` already
// matches newlines, so a `from` clause broken across lines (`from\n  './foo.js'`) still
// matches when this runs against the whole file text rather than one line at a time.
const RELATIVE_JS_SPECIFIER = /(?:from\s+|import\(\s*)['"](\.\.?\/[^'"]*\.js)['"]/g;

// Replaces every comment span with spaces, keeping newlines so that every byte offset in the
// result still maps to the same line as in the original text. A comment quoting the pattern
// in prose (a doc example, a code-review note) therefore cannot match at all, which matters
// because this project documents the very trap the guard checks for — a JSDoc example would
// otherwise block a push with a message indistinguishable from a real violation.
//
// A string literal is left intact: the specifier the scan is looking for lives inside one,
// and `//` inside a URL string is not a comment opener. Single, double and backtick quotes
// are all tracked. Two cases are knowingly out of reach without a real tokenizer, and both
// are left alone rather than half-handled:
//
//   - A regex literal whose character class holds a slash-star (`/[/*]/`) reads as a block
//     comment opener, blanking everything up to the next `*/`. That direction is a false
//     negative — a real violation below it would be missed silently.
//   - `${...}` interpolation inside a template literal is treated as string content, so a
//     comment written inside one is not stripped. That direction is a false positive.
//
// Neither pattern appears in this codebase's import style, which is what the guard scans.
function stripComments(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let j = from; j < to; j += 1) {
      if (out[j] !== '\n') out[j] = ' ';
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      i = skipStringLiteral(text, i);
    } else {
      i += 1;
    }
  }
  return out.join('');
}

// Returns the offset just past the string literal opening at `start`. An unterminated single-
// or double-quoted string ends at the newline: that is invalid JavaScript, and stopping there
// keeps one stray quote from swallowing the rest of the file.
function skipStringLiteral(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === '\n' && quote !== '`') return i;
    i += 1;
  }
  return i;
}

// Scans the whole file text (not line by line — a per-line scan is what let a `from` clause
// split across two lines slip through with zero hits) for relative .js specifiers, with
// comments stripped out beforehand so a prose mention cannot match.
function findJsSpecifiers(text: string): Hit[] {
  const code = stripComments(text);
  const hits: Hit[] = [];
  RELATIVE_JS_SPECIFIER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RELATIVE_JS_SPECIFIER.exec(code))) {
    // The line must come from the specifier's own offset, not from `match.index` — that
    // points at `from`/`import(`, which can sit on an earlier line. Locating the specifier
    // inside the match is exact rather than approximate: everything preceding it in the
    // match is `from`/`import(` plus whitespace and a quote, none of which can contain the
    // `./` or `../` the specifier must start with, so the first occurrence is the right one.
    const specifier = match[1]!;
    const specifierStart = match.index + match[0].indexOf(specifier);
    hits.push({ line: code.slice(0, specifierStart).split('\n').length, specifier });
  }
  return hits;
}

// The corrected rule: flag only when the specifier resolves to nothing real at .js but a
// sibling .ts file exists at that same resolved path. A real .js file (public/'s browser
// scripts) is correct and untouched; a specifier with neither extension present is a
// tsc error, not this guard's to raise.
function resolvesToTsOnly(importerFile: string, specifier: string): boolean {
  const jsPath = path.resolve(path.dirname(importerFile), specifier);
  if (fs.existsSync(jsPath)) return false;
  const tsPath = jsPath.replace(/\.js$/, '.ts');
  return fs.existsSync(tsPath);
}

function buildMessage(importerFile: string, line: number, specifier: string): string {
  const rel = path.relative(PACKAGE_ROOT, importerFile);
  return (
    `${rel}:${line}: relative import '${specifier}' resolves to a .ts file, not a .js ` +
    `file — tsc accepts it under "moduleResolution": "nodenext" (TS2835 even suggests this ` +
    `exact specifier for a missing extension), but Node's ESM loader will not rewrite .js ` +
    `to .ts and throws ERR_MODULE_NOT_FOUND. Use the .ts extension instead.`
  );
}

function scanFile(importerFile: string): Violation[] {
  const text = fs.readFileSync(importerFile, 'utf8');
  const violations: Violation[] = [];
  for (const hit of findJsSpecifiers(text)) {
    if (!resolvesToTsOnly(importerFile, hit.specifier)) continue;
    violations.push({ ...hit, message: buildMessage(importerFile, hit.line, hit.specifier) });
  }
  return violations;
}

function listSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-convention-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('fixture: a from-clause split across lines is still found', () => {
  const text = "import {\n  groupBy,\n} from\n  './group.js';\n";
  const hits = findJsSpecifiers(text);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.specifier, './group.js');
});

test('fixture: a comment mentioning the pattern in prose is not flagged', () => {
  const lineComment = "// see import { x } from './foo.js' for the old shape\n";
  const blockComment = "/*\n * import { x } from './foo.js'\n */\n";
  assert.equal(findJsSpecifiers(lineComment).length, 0);
  assert.equal(findJsSpecifiers(blockComment).length, 0);
});

test('fixture: a JSDoc comment quoting the pattern is not flagged', () => {
  const text = "/** example: import { x } from './types.js' */\n";
  assert.equal(findJsSpecifiers(text).length, 0);
});

test('fixture: a trailing comment after real code does not hide the code', () => {
  const text = "import { x } from './types.js'; // note\n";
  const hits = findJsSpecifiers(text);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.specifier, './types.js');
});

test('fixture: the reported line is the specifier’s, not the from keyword’s', () => {
  const text = "import {\n  groupBy,\n} from\n  './group.js';\n";
  const hits = findJsSpecifiers(text);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.line, 4);
});

test('fixture: a `* as ns` continuation line is code, not a comment', () => {
  const text = "import\n  * as ns from './types.js';\n";
  const hits = findJsSpecifiers(text);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.line, 2);
});

// Blanking a comment span must keep its newlines, or every line below any block comment
// shifts upward. The violation here sits eight lines down with two separate block comments
// and real code above it, so a reported line of 8 is only reachable if all seven preceding
// newlines survived — a fixture with the violation directly under one comment would still
// pass if newlines were dropped from only some spans.
test('fixture: block comments above a violation do not shift its reported line', () => {
  const text =
    '/**\n' + // 1
    " * import { x } from './types.js'\n" + // 2
    ' */\n' + // 3
    'const a = 1;\n' + // 4
    '/* a second comment,\n' + // 5
    '   also spanning lines */\n' + // 6
    'const b = 2;\n' + // 7
    "import { x } from './types.js';\n"; // 8
  const hits = findJsSpecifiers(text);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.line, 8);
});

test('fixture: a dynamic import() specifier is found by the text scan', () => {
  const text = "const mod = await import('./group.js');\n";
  const hits = findJsSpecifiers(text);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.specifier, './group.js');
});

test('fixture: a .js specifier with only a .ts sibling is flagged, with the composed message', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'sibling.ts'), 'export const x = 1;\n');
    const importer = path.join(dir, 'importer.ts');
    fs.writeFileSync(importer, "import { x } from './sibling.js';\n");
    const violations = scanFile(importer);
    assert.equal(violations.length, 1);
    assert.equal(violations[0]!.specifier, './sibling.js');
    assert.match(violations[0]!.message, /sibling\.js/);
    assert.match(violations[0]!.message, /\.ts extension instead/);
  });
});

test('fixture: a .js specifier with a real .js sibling is not flagged', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'group.js'), 'export const groupBy = 1;\n');
    const importer = path.join(dir, 'app.js');
    fs.writeFileSync(importer, "import { groupBy } from './group.js';\n");
    assert.equal(scanFile(importer).length, 0);
  });
});

test('fixture: a .js specifier with no file at either extension is not flagged', () => {
  withTempDir((dir) => {
    const importer = path.join(dir, 'importer.ts');
    fs.writeFileSync(importer, "import { x } from './missing.js';\n");
    assert.equal(scanFile(importer).length, 0);
  });
});

test('src/ and public/ contain no relative .js imports that actually resolve to .ts', () => {
  const files = [
    ...listSourceFiles(path.join(PACKAGE_ROOT, 'src')),
    ...listSourceFiles(path.join(PACKAGE_ROOT, 'public')),
  ];
  const failures: string[] = [];
  for (const file of files) {
    for (const violation of scanFile(file)) failures.push(violation.message);
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});
