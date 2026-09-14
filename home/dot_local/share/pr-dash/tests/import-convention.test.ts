// Guards against a trap `nodenext` creates: `import ... from './foo.js'` type-checks clean
// even when the real file is `foo.ts` — TypeScript's own TS2835 message for a missing
// extension even suggests it ("Did you mean './types.js'?"). Node's ESM loader on v24 does
// not rewrite .js to .ts, so that specifier throws ERR_MODULE_NOT_FOUND at runtime. tsc has
// no flag for this (the .js-to-.ts mirror is nodenext's intended convention for compiled
// projects), so it is checked here instead: no relative import under src/ or public/ may end
// in .js. Bare package specifiers ('react') and node: builtins ('node:http') are untouched —
// only a specifier starting with './' or '../' is in scope.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(__dirname, '..');

type Hit = { line: number; specifier: string };

// Matches the specifier inside a static `from '...'`/`from "..."` or a dynamic
// `import('...')`, restricted to a relative path (./ or ../) ending in .js.
const RELATIVE_JS_IMPORT = /(?:from\s+|import\(\s*)['"](\.\.?\/[^'"]*\.js)['"]/g;

function findRelativeJsImports(text: string): Hit[] {
  const hits: Hit[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    RELATIVE_JS_IMPORT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RELATIVE_JS_IMPORT.exec(line))) {
      hits.push({ line: i + 1, specifier: match[1]! });
    }
  }
  return hits;
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

test('fixture: relative import ending in .js is detected', () => {
  const hits = findRelativeJsImports("import { x } from './foo.js';\n");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.line, 1);
  assert.equal(hits[0]!.specifier, './foo.js');
});

test('fixture: relative .ts import and a node: builtin are both accepted', () => {
  const text = "import { x } from './foo.ts';\nimport { y } from 'node:http';\n";
  assert.equal(findRelativeJsImports(text).length, 0);
});

test('src/ and public/ contain no relative .js import specifiers', () => {
  const files = [
    ...listSourceFiles(path.join(PACKAGE_ROOT, 'src')),
    ...listSourceFiles(path.join(PACKAGE_ROOT, 'public')),
  ];
  const failures: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const hit of findRelativeJsImports(text)) {
      const rel = path.relative(PACKAGE_ROOT, file);
      failures.push(
        `${rel}:${hit.line}: relative import '${hit.specifier}' type-checks clean under ` +
          `"moduleResolution": "nodenext" but does not exist at runtime — Node's ESM loader ` +
          `does not rewrite .js to .ts. Use the .ts extension instead, even though TS2835 ` +
          `suggested this .js specifier.`,
      );
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});
