import { test } from 'node:test';
import assert from 'node:assert';
import { createPayloadStore, DIR_MODE, FILE_MODE, type FsSeam } from '../src/payload-store.ts';
import type { LoadResult } from '../src/loader.ts';
import type { PrRecord } from '../src/types.ts';

const RECORD: PrRecord = {
  id: 'acme/api#12',
  repo: 'acme/api',
  number: 12,
  title: 'Add retry budget',
  url: 'https://github.com/acme/api/pull/12',
  headRef: 'retry-budget',
  baseRef: 'main',
  isDraft: false,
  ci: 'success',
  review: 'approved',
  openedAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-10T00:00:00Z',
  ageDays: 13,
  staleDays: 4,
  additions: 120,
  deletions: 8,
  defaultBranch: 'main',
};

const PAYLOAD: LoadResult = {
  prs: [RECORD],
  fetchedAt: '2026-09-15T09:00:00.000Z',
  partialErrors: [],
};

/** An in-memory FsSeam that records what it was asked to do. */
function fakeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const calls: string[] = [];
  const modes = new Map<string, number>();
  const seam: FsSeam = {
    async mkdir(path, opts) {
      calls.push(`mkdir ${path}`);
      modes.set(path, opts.mode);
    },
    async writeFile(path, data, opts) {
      calls.push(`writeFile ${path}`);
      files.set(path, data);
      modes.set(path, opts.mode);
    },
    async rename(from, to) {
      calls.push(`rename ${from} -> ${to}`);
      const data = files.get(from);
      if (data === undefined) throw new Error(`no such file: ${from}`);
      files.set(to, data);
      files.delete(from);
      modes.set(to, modes.get(from) ?? 0);
    },
    async readFile(path) {
      calls.push(`readFile ${path}`);
      const data = files.get(path);
      if (data === undefined) {
        const err: NodeJS.ErrnoException = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return data;
    },
  };
  return { seam, files, calls, modes };
}

test('a written payload reads back unchanged', async () => {
  const fs = fakeFs();
  const store = createPayloadStore('/state', fs.seam);

  await store.write(PAYLOAD);

  assert.deepStrictEqual(await store.read(), PAYLOAD);
});

test('the write is atomic: a temp file is renamed over the target', async () => {
  const fs = fakeFs();
  const store = createPayloadStore('/state', fs.seam);

  await store.write(PAYLOAD);

  const renamed = fs.calls.find((c) => c.startsWith('rename '));
  assert.ok(renamed !== undefined, 'the payload must be renamed into place, not written in place');
  assert.ok(
    renamed.endsWith('-> /state/last-payload.json'),
    `expected a rename onto the target, saw: ${renamed}`,
  );
  // A kill between writeFile and rename must not leave a half-written target.
  assert.ok(!fs.calls.includes('writeFile /state/last-payload.json'));
});

test('the directory and the file are created with owner-only modes', async () => {
  const fs = fakeFs();
  const store = createPayloadStore('/state', fs.seam);

  await store.write(PAYLOAD);

  assert.strictEqual(fs.modes.get('/state'), DIR_MODE);
  assert.strictEqual(fs.modes.get('/state/last-payload.json'), FILE_MODE);
  // This machine's login shell runs `umask 0007`, so leaving the mode to the umask would
  // produce a group-readable 0640 file holding private PR titles.
  assert.strictEqual(FILE_MODE, 0o600);
  assert.strictEqual(DIR_MODE, 0o700);
});

test('each temp file has a unique name', async () => {
  const fs = fakeFs();
  const store = createPayloadStore('/state', fs.seam);

  await store.write(PAYLOAD);
  await store.write(PAYLOAD);

  const temps = fs.calls.filter((c) => c.startsWith('writeFile ')).map((c) => c.slice(10));
  assert.strictEqual(new Set(temps).size, 2, 'a fixed temp name would keep a crashed run\'s mode');
});

test('an absent file is a cold start, not an error', async () => {
  const store = createPayloadStore('/state', fakeFs().seam);
  assert.strictEqual(await store.read(), undefined);
});

test('a read error other than ENOENT is also a cold start', async () => {
  const fs = fakeFs();
  const seam: FsSeam = {
    ...fs.seam,
    async readFile() {
      throw new Error('EACCES');
    },
  };
  const store = createPayloadStore('/state', seam);
  assert.strictEqual(await store.read(), undefined);
});

for (const [label, contents] of [
  ['not JSON at all', 'this is not json'],
  ['truncated JSON', '{"prs":[{"id":"acme/api#1"'],
  ['JSON null', 'null'],
  ['a JSON array', '[1,2,3]'],
  ['a JSON string', '"a token, somehow"'],
  ['prs missing', '{"fetchedAt":"T","partialErrors":[]}'],
  ['prs not an array', '{"prs":{},"fetchedAt":"T","partialErrors":[]}'],
  ['a null record', '{"prs":[null],"fetchedAt":"T","partialErrors":[]}'],
  ['fetchedAt missing', '{"prs":[],"partialErrors":[]}'],
  ['fetchedAt empty', '{"prs":[],"fetchedAt":"","partialErrors":[]}'],
  ['partialErrors not an array', '{"prs":[],"fetchedAt":"T","partialErrors":"x"}'],
  ['partialErrors holding a non-string', '{"prs":[],"fetchedAt":"T","partialErrors":[1]}'],
] as const) {
  test(`a stored file that is ${label} yields a cold start`, async () => {
    const fs = fakeFs({ '/state/last-payload.json': contents });
    const store = createPayloadStore('/state', fs.seam);
    assert.strictEqual(await store.read(), undefined, 'must discard rather than throw');
  });
}

test('an empty payload is valid, not a cold start', async () => {
  // Zero open PRs is a real answer. Treating it as corrupt would refuse to restore the
  // one state the user most wants to see instantly.
  const empty: LoadResult = { prs: [], fetchedAt: 'T', partialErrors: [] };
  const fs = fakeFs({ '/state/last-payload.json': JSON.stringify(empty) });
  const store = createPayloadStore('/state', fs.seam);
  assert.deepStrictEqual(await store.read(), empty);
});

test('a write failure does not propagate', async () => {
  const fs = fakeFs();
  const seam: FsSeam = {
    ...fs.seam,
    async writeFile() {
      throw new Error('ENOSPC');
    },
  };
  const store = createPayloadStore('/state', seam);
  // A full disk must not turn a successful fetch into a failed request.
  await store.write(PAYLOAD);
});
