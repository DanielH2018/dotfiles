import { test } from 'node:test';
import assert from 'node:assert';
import { resolveToken, DEFAULT_ITEM } from '../src/token.ts';

test('GH_TOKEN wins over op', async () => {
  const token = await resolveToken({ GH_TOKEN: 'from-env' }, async () => 'from-op');
  assert.strictEqual(token, 'from-env');
});

test('falls through to op when GH_TOKEN is absent', async () => {
  const token = await resolveToken({}, async () => 'from-op');
  assert.strictEqual(token, 'from-op');
});

test('reads the default item reference', async () => {
  let seen = '';
  await resolveToken({}, async (ref) => { seen = ref; return 't'; });
  assert.strictEqual(seen, DEFAULT_ITEM);
});

test('PR_DASH_OP_ITEM overrides the item reference', async () => {
  let seen = '';
  await resolveToken({ PR_DASH_OP_ITEM: 'op://Work/Other/token' }, async (ref) => { seen = ref; return 't'; });
  assert.strictEqual(seen, 'op://Work/Other/token');
});

test('a failing op read raises an error naming the command', async () => {
  await assert.rejects(
    () => resolveToken({}, async () => { throw new Error('not signed in'); }),
    (err: Error) => err.message.includes('op read') && err.message.includes(DEFAULT_ITEM),
  );
});

test('an empty op result is treated as failure, not as an empty token', async () => {
  await assert.rejects(() => resolveToken({}, async () => '  '));
});
