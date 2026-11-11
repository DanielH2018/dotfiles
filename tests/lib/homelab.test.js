// tests/lib/homelab.js: GitHub master wins over an implicit checkout, $HOMELAB_REPO wins over
// both, and a checkout stands in only when GitHub is unreachable.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { HOMELAB_RAW, homelabFile } = require('./homelab');

const none = [path.join(os.tmpdir(), 'no-homelab-here')];
const here = path.join(__dirname, '..', '..');
const answer = (status) => async () => ({ status, text: async () => 'body' });
const refused = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); };

test('$HOMELAB_REPO is read without a fetch', async () => {
  const unused = async () => { throw new Error('fetched although $HOMELAB_REPO names a checkout'); };
  const got = await homelabFile('tests/lib/homelab.js', none, unused, here);
  assert.strictEqual(got.from, here);
  assert.match(got.text, /homelabFile/);
});

test('master on GitHub wins over a fallback checkout that has the file', async () => {
  const url = `${HOMELAB_RAW}/tests/lib/homelab.js`;
  assert.deepStrictEqual(await homelabFile('tests/lib/homelab.js', [here], answer(200), ''), { text: 'body', from: url });
});

test('offline, a fallback checkout answers, and with none the fetch skips', async () => {
  assert.strictEqual((await homelabFile('tests/lib/homelab.js', [...none, here], refused, '')).from, here);
  assert.strictEqual((await homelabFile('tests/lib/homelab.js', [here], answer(503), '')).from, here);
  assert.match((await homelabFile('prek.toml', none, answer(503), '')).skip, /answered 503/);
  assert.match((await homelabFile('prek.toml', none, refused, '')).skip, /unreachable \(ECONNREFUSED\)/);
});

test('a 404 throws even where a fallback checkout has the file', async () => {
  await assert.rejects(homelabFile('tests/lib/homelab.js', [here], answer(404), ''),
    /answered 404: the homelab tests\/lib\/homelab\.js moved/);
});
