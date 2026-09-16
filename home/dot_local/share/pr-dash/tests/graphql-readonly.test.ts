// This dashboard's whole read-only posture rests on every GraphQL operation it sends being
// a `query`, never a `mutation` — the one kind of request that can actually change state on
// GitHub. The 405 method gate (server.ts) and the secret gate (guard.ts) both have tests
// that redden when removed, but nothing asserted the GraphQL boundary itself: rewriting
// queries.ts's `query($cursor: String) {` to `mutation($cursor: String) {` left the whole
// suite green, since every fixture in github.test.ts and refresh.test.ts stubs `fetchImpl`
// and never inspects the request body it was sent.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './strip-comments.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..', 'src');
const QUERIES_TS = path.join(SRC_DIR, 'queries.ts');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('no file under src/ defines a GraphQL mutation operation', () => {
  // A mutation keyword outside a comment or a string is the shape of a real GraphQL
  // operation type, not a prose mention — src/ has no other reason to contain the bare
  // word "mutation" in code.
  for (const file of listTsFiles(SRC_DIR)) {
    const stripped = stripComments(readFileSync(file, 'utf8'));
    assert.doesNotMatch(
      stripped,
      /\bmutation\b/,
      `expected no GraphQL mutation operation in ${path.relative(SRC_DIR, file)}`,
    );
  }
});

test('the search operation in src/queries.ts still opens with the query keyword, not deleted outright', () => {
  // The test above alone would also pass if the `query` keyword were simply deleted rather
  // than swapped for `mutation` — GraphQL treats an operation with no keyword as an
  // implicit query, but that is not what this asserts; it pins the explicit keyword this
  // module actually sends.
  const stripped = stripComments(readFileSync(QUERIES_TS, 'utf8'));
  assert.match(
    stripped,
    /`\s*query\(\$cursor: String\) \{/,
    'expected queries.ts to open its search operation with the explicit query keyword',
  );
});
