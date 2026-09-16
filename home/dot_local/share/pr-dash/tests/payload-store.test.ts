import { test } from 'node:test';
import assert from 'node:assert';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createPayloadStore, DEFAULT_STATE_DIR, DIR_MODE, FILE_MODE, type FsSeam } from '../src/payload-store.ts';
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

const RECORD2: PrRecord = {
  id: 'acme/api#13',
  repo: 'acme/api',
  number: 13,
  title: 'Improve error handling',
  url: 'https://github.com/acme/api/pull/13',
  headRef: 'error-handling',
  baseRef: 'main',
  isDraft: false,
  ci: 'pending',
  review: 'none',
  openedAt: '2026-09-02T00:00:00Z',
  updatedAt: '2026-09-11T00:00:00Z',
  ageDays: 12,
  staleDays: 3,
  additions: 40,
  deletions: 2,
  defaultBranch: 'main',
};

// Two records and a non-empty partialErrors: a fixture of one record and no errors would
// round-trip even if read() dropped every record after the first, or write() silently
// discarded partialErrors — both are real mutations that stayed green against a thinner
// fixture. partialErrors matters beyond this module too: src/main-lib.ts's withFallback
// keeps it riding along with a retained payload precisely so a partial fetch never later
// renders as complete.
const PAYLOAD: LoadResult = {
  prs: [RECORD, RECORD2],
  fetchedAt: '2026-09-15T09:00:00.000Z',
  partialErrors: ['github: rate limited while paging acme/other'],
};

/** An in-memory FsSeam that records what it was asked to do. */
function fakeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const calls: string[] = [];
  const modes = new Map<string, number>();
  const createdDirs = new Set<string>();
  const writes: string[] = [];
  const renames: { from: string; to: string }[] = [];
  const seam: FsSeam = {
    async mkdir(path, opts) {
      calls.push(`mkdir ${path}`);
      modes.set(path, opts.mode);
      createdDirs.add(path);
    },
    async writeFile(path, data, opts) {
      calls.push(`writeFile ${path}`);
      writes.push(path);
      // Mirrors a real filesystem: writing into a directory that was never created
      // fails with ENOENT. Without this, an implementation that calls writeFile before
      // mkdir looks identical to the suite to one that gets the order right.
      const dir = path.slice(0, path.lastIndexOf('/')) || '/';
      if (!createdDirs.has(dir)) {
        throw new Error(`ENOENT: directory not created: ${dir}`);
      }
      files.set(path, data);
      modes.set(path, opts.mode);
    },
    async rename(from, to) {
      calls.push(`rename ${from} -> ${to}`);
      // Recorded before the lookup below can throw, so a test can see what a rename was
      // asked to do even when the fake then rejects it as impossible.
      renames.push({ from, to });
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
    async unlink(path) {
      calls.push(`unlink ${path}`);
      files.delete(path);
    },
  };
  return { seam, files, calls, modes, createdDirs, writes, renames };
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

test('the rename source is exactly what writeFile was called with, in the same directory as the target', async () => {
  // Distinct from the atomicity test above: replacing the rename call with
  // `fs.rename(temp + '.nope', target)` still ends in "-> /state/last-payload.json" and
  // still avoids writing the target directly, so that test stays green. This one catches
  // it, because the renamed-from path no longer matches what writeFile actually wrote.
  const fs = fakeFs();
  const store = createPayloadStore('/state', fs.seam);

  await store.write(PAYLOAD);

  assert.strictEqual(fs.writes.length, 1);
  assert.strictEqual(fs.renames.length, 1);
  const [renameCall] = fs.renames;
  const [writtenPath] = fs.writes;
  assert.strictEqual(renameCall!.from, writtenPath);
  assert.strictEqual(renameCall!.to, '/state/last-payload.json');
  // A rename that crosses filesystems fails with EXDEV, and the temp-and-target-on-one-
  // filesystem case is exactly what makes a rename atomic in the first place.
  const sourceDir = renameCall!.from.slice(0, renameCall!.from.lastIndexOf('/'));
  const targetDir = renameCall!.to.slice(0, renameCall!.to.lastIndexOf('/'));
  assert.strictEqual(sourceDir, targetDir);
});

test('the directory and the file are created with owner-only modes', async () => {
  const fs = fakeFs();
  const store = createPayloadStore('/state', fs.seam);

  await store.write(PAYLOAD);

  assert.strictEqual(fs.modes.get('/state'), DIR_MODE);
  assert.strictEqual(fs.modes.get('/state/last-payload.json'), FILE_MODE);
  // This machine's login shell runs `umask 0007`, so leaving the mode to the umask would
  // produce a group-readable 0660 file holding private PR titles.
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
  // Two bare objects: the shape that used to pass looksLikePayload (both are objects)
  // and then crashed src/stacks.ts server-side, since buildStacks sorts stack siblings
  // with `a.repo.localeCompare(b.repo)` and a single such record never invokes the
  // comparator (Array.prototype.sort skips it for a one-element array).
  ['two records missing every field buildStacks reads', '{"prs":[{},{}],"fetchedAt":"T","partialErrors":[]}'],
  ['a record with a non-string repo', '{"prs":[{"id":"x","repo":1,"headRef":"h","baseRef":"b","number":1}],"fetchedAt":"T","partialErrors":[]}'],
  ['a record with a non-string id', '{"prs":[{"id":1,"repo":"r","headRef":"h","baseRef":"b","number":1}],"fetchedAt":"T","partialErrors":[]}'],
  ['a record missing number', '{"prs":[{"id":"x","repo":"r","headRef":"h","baseRef":"b"}],"fetchedAt":"T","partialErrors":[]}'],
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

test('a failed rename removes the orphaned temp file', async () => {
  const fs = fakeFs();
  const seam: FsSeam = {
    ...fs.seam,
    async rename() {
      throw new Error('EXDEV');
    },
  };
  const store = createPayloadStore('/state', seam);

  await store.write(PAYLOAD);

  // writeFile still ran (on the underlying fake, not the overridden seam), so the temp
  // path it was given is recorded there.
  assert.strictEqual(fs.writes.length, 1);
  assert.deepStrictEqual(fs.calls.filter((c) => c.startsWith('unlink ')), [`unlink ${fs.writes[0]}`]);
});

test('the default state directory sits under the home directory, outside chezmoi and outside any git checkout', () => {
  // Property-based rather than an exact-path comparison: an exact match to
  // `join(homedir(), '.local', 'state', 'pr-dash')` would stay true even if that formula
  // were rewritten to point inside the chezmoi source tree, since both sides would move
  // together. This instead pins the doc comment's actual claim.
  assert.ok(
    DEFAULT_STATE_DIR.startsWith(`${homedir()}/`),
    `expected ${DEFAULT_STATE_DIR} under the home directory`,
  );
  assert.ok(!DEFAULT_STATE_DIR.includes('chezmoi'), 'must not reach the chezmoi source tree');
  assert.ok(!DEFAULT_STATE_DIR.includes('.git'), 'must not sit inside a git checkout');
});

test('the real filesystem seam actually applies the owner-only modes and an atomic rename', async () => {
  // Every mode assertion above runs against the injected fake seam. `realFs` — the seam
  // `createPayloadStore` uses by default, and the only one main.ts ever wires up — is
  // never exercised: dropping writeFile's mode, dropping mkdir's mode, or swapping
  // rename's arguments (rename(to, from)) all leave the rest of this file green. Under
  // this machine's umask 0007, a dropped file mode is a 0660 group-readable file holding
  // every repository name, branch name and PR title.
  //
  // The target directory must not exist yet: mkdtempSync already creates its directory
  // at 0700, so pointing the store straight at it would let `mkdir`'s mode argument go
  // unapplied (the directory already exists) while this test's own assertion passed on
  // mkdtemp's bits rather than on what createPayloadStore actually did. A fresh
  // subdirectory forces a real mkdir call.
  const root = mkdtempSync(join(tmpdir(), 'pr-dash-store-'));
  const dir = join(root, 'state');
  try {
    const store = createPayloadStore(dir);

    await store.write(PAYLOAD);

    const dirMode = statSync(dir).mode & 0o777;
    const fileMode = statSync(join(dir, 'last-payload.json')).mode & 0o777;
    assert.strictEqual(dirMode, DIR_MODE, `expected directory mode ${DIR_MODE.toString(8)}, got ${dirMode.toString(8)}`);
    assert.strictEqual(fileMode, FILE_MODE, `expected file mode ${FILE_MODE.toString(8)}, got ${fileMode.toString(8)}`);

    // Reads back through the real rename too: a swapped rename(to, from) would leave the
    // target file missing (or holding stale bytes from a previous run) rather than the
    // payload just written.
    assert.deepStrictEqual(await store.read(), PAYLOAD);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
