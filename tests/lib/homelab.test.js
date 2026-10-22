// tests/lib/homelab.js: a checkout wins over the network, and a fetch skips only when offline.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { HOMELAB_RAW, homelabFile } = require('./homelab');

const none = [path.join(os.tmpdir(), 'no-homelab-here')];
const answer = (status) => async () => ({ status, text: async () => 'body' });

test('a checkout that has the file is read without a fetch', async () => {
  const unused = async () => { throw new Error('fetched although a checkout has the file'); };
  const here = path.join(__dirname, '..', '..');
  const got = await homelabFile('tests/lib/homelab.js', [...none, here], unused);
  assert.strictEqual(got.from, here);
  assert.match(got.text, /homelabFile/);
});

test('the fetch skips only when offline', async () => {
  const url = `${HOMELAB_RAW}/prek.toml`;
  assert.deepStrictEqual(await homelabFile('prek.toml', none, answer(200)), { text: 'body', from: url });
  assert.match((await homelabFile('prek.toml', none, answer(503))).skip, /answered 503/);
  const refused = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); };
  assert.match((await homelabFile('prek.toml', none, refused)).skip, /unreachable \(ECONNREFUSED\)/);
  await assert.rejects(homelabFile('prek.toml', none, answer(404)), /answered 404: the homelab prek\.toml moved/);
});
