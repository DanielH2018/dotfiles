import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveToken, DEFAULT_TITLE } from '../src/token.ts';
import { stripComments } from './strip-comments.ts';

const TOKEN_TS = path.join(import.meta.dirname, '..', 'src', 'token.ts');

test('the op runners stay unexported, so no other module can catch their rejections', () => {
  // token.ts's own comment above them is the specification for this test: "both op commands
  // write the token to stdout, so a rejection from execFile here carries the token in its
  // .stdout property. No caller may log this rejection or attach it as an Error `cause` —
  // resolveToken's catch below discards it for that reason. Keep these unexported so the
  // only caller stays the one that already does that." A later module that imported one
  // directly and handled the rejection the ordinary way (`console.error(err)`) would print
  // the item JSON, credential included, into ~/.local/state/pr-dash/agent.log.
  const stripped = stripComments(readFileSync(TOKEN_TS, 'utf8'));
  assert.doesNotMatch(stripped, /export\s+(async\s+)?function\s+runOp/);
  assert.doesNotMatch(stripped, /export\s*\{[^}]*\brunOp/);
});

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

test('a response with no field labeled token fails without leaking the raw output', async () => {
  // The sibling branch to the malformed-JSON case above: same function, same secret risk,
  // but this one is the response that parsed fine and simply carries no "token" field —
  // still JSON that op printed with --reveal, so it can still hold the token in the clear
  // under some other label.
  await assert.rejects(
    () =>
      resolveToken({}, async () =>
        JSON.stringify([{ label: 'username', value: 'ghp_SENTINEL_NO_TOKEN_FIELD' }]),
      ),
    (err: Error) => !err.message.includes('ghp_SENTINEL_NO_TOKEN_FIELD'),
  );
});

test('an op failure does not attach the underlying rejection as a cause', async () => {
  // op's rejection carries the raw command output — which can include the token — on its
  // .stdout property. Attaching it as an Error `cause` would let a later structured log
  // that walks the cause chain print it, even though the thrown message itself never does.
  await assert.rejects(
    () =>
      resolveToken({}, async () => {
        throw new Error('not signed in');
      }),
    (err: Error) => {
      assert.strictEqual((err as Error & { cause?: unknown }).cause, undefined);
      return true;
    },
  );
});
