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

// A comment quoting the pattern in prose (a doc example, a code-review note) is not a
// violation. This is deliberately not a real comment parser — it only catches the common
// case of a `//` line or a `*`-prefixed block-comment continuation line, which is what a
// hand-written note looks like in this codebase.
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*');
}

// Scans the whole file text (not line by line — a per-line scan is what let a `from` clause
// split across two lines slip through with zero hits) for relative .js specifiers, and
// drops any that land on a comment line.
function findJsSpecifiers(text: string): Hit[] {
  const lines = text.split('\n');
  const hits: Hit[] = [];
  RELATIVE_JS_SPECIFIER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RELATIVE_JS_SPECIFIER.exec(text))) {
    const line = text.slice(0, match.index).split('\n').length;
    const lineText = lines[line - 1] ?? '';
    if (isCommentLine(lineText)) continue;
    hits.push({ line, specifier: match[1]! });
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
  const blockCommentContinuation = " * import { x } from './foo.js'\n";
  assert.equal(findJsSpecifiers(lineComment).length, 0);
  assert.equal(findJsSpecifiers(blockCommentContinuation).length, 0);
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
