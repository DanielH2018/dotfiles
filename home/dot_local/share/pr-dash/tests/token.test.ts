import { test } from 'node:test';
import assert from 'node:assert';
import { resolveToken, DEFAULT_TITLE } from '../src/token.ts';

test('GH_TOKEN wins over op', async () => {
  const token = await resolveToken({ GH_TOKEN: 'from-env' }, async () => 'from-op');
  assert.strictEqual(token, 'from-env');
});

test('does not call op when GH_TOKEN is present', async () => {
  let called = false;
  await resolveToken({ GH_TOKEN: 'from-env' }, async () => {
    called = true;
    return 'from-op';
  });
  assert.strictEqual(called, false);
});

test('GH_TOKEN resolves even when op fails, proving the documented escape hatch works', async () => {
  const token = await resolveToken({ GH_TOKEN: 'from-env' }, async () => {
    throw new Error('not signed in');
  });
  assert.strictEqual(token, 'from-env');
});

test('falls through to the item-get lookup when GH_TOKEN is absent', async () => {
  const token = await resolveToken({}, async () =>
    JSON.stringify([{ label: 'token', value: 'from-op' }]),
  );
  assert.strictEqual(token, 'from-op');
});

test('PR_DASH_OP_ITEM unset looks up the default title across every vault', async () => {
  let seen: unknown;
  await resolveToken({}, async (lookup) => {
    seen = lookup;
    return JSON.stringify([{ label: 'token', value: 't' }]);
  });
  assert.deepStrictEqual(seen, { kind: 'itemGet', title: DEFAULT_TITLE });
});

test('PR_DASH_OP_ITEM set to an op:// reference is read directly, unchanged', async () => {
  // This is the exact value already set in this shell — it must keep resolving through
  // op read rather than being treated as an item title.
  const ref = 'op://Employee/GitHub PR Dashboard/token';
  let seen: unknown;
  await resolveToken({ PR_DASH_OP_ITEM: ref }, async (lookup) => {
    seen = lookup;
    return 't';
  });
  assert.deepStrictEqual(seen, { kind: 'read', ref });
});

test('PR_DASH_OP_ITEM set to a plain title looks it up by title', async () => {
  let seen: unknown;
  await resolveToken({ PR_DASH_OP_ITEM: 'Some Other Item' }, async (lookup) => {
    seen = lookup;
    return JSON.stringify([{ label: 'token', value: 't' }]);
  });
  assert.deepStrictEqual(seen, { kind: 'itemGet', title: 'Some Other Item' });
});

test('a failing op read raises an error naming the op read command', async () => {
  const ref = 'op://Work/Other/token';
  await assert.rejects(
    () => resolveToken({ PR_DASH_OP_ITEM: ref }, async () => { throw new Error('not signed in'); }),
    (err: Error) => err.message.includes('op read') && err.message.includes(ref),
  );
});

test('a failing item-get lookup raises an error naming the op item get command and PR_DASH_OP_ITEM', async () => {
  await assert.rejects(
    () => resolveToken({}, async () => { throw new Error('not signed in'); }),
    (err: Error) =>
      err.message.includes('op item get') &&
      err.message.includes(DEFAULT_TITLE) &&
      err.message.includes('PR_DASH_OP_ITEM'),
  );
});

test('an empty op read result is treated as failure, not as an empty token', async () => {
  await assert.rejects(
    () => resolveToken({ PR_DASH_OP_ITEM: 'op://Work/Other/token' }, async () => '  '),
  );
});

test('an empty token field value is treated as failure, not as an empty token', async () => {
  await assert.rejects(
    () => resolveToken({}, async () => JSON.stringify([{ label: 'token', value: '   ' }])),
  );
});

test('the token field label match is case-insensitive', async () => {
  const token = await resolveToken({}, async () =>
    JSON.stringify([{ label: 'Token', value: 'from-op' }]),
  );
  assert.strictEqual(token, 'from-op');
});

test('picks the field labeled token out of several fields', async () => {
  const token = await resolveToken({}, async () =>
    JSON.stringify([
      { label: 'username', value: 'nope' },
      { label: 'token', value: 'from-op' },
    ]),
  );
  assert.strictEqual(token, 'from-op');
});

test('a response with no field labeled token fails with a clear message', async () => {
  await assert.rejects(
    () => resolveToken({}, async () => JSON.stringify([{ label: 'username', value: 'x' }])),
    (err: Error) => err.message.includes(DEFAULT_TITLE),
  );
});

test('also accepts the full-item shape, in case op item get is not narrowed by --fields', async () => {
  const token = await resolveToken({}, async () =>
    JSON.stringify({ fields: [{ label: 'token', value: 'from-op' }] }),
  );
  assert.strictEqual(token, 'from-op');
});

test('a malformed JSON response fails without leaking the raw output', async () => {
  await assert.rejects(
    () => resolveToken({}, async () => 'not json {ghp_SENTINEL_NOT_JSON'),
    (err: Error) => !err.message.includes('ghp_SENTINEL'),
  );
});
