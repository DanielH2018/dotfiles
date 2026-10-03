// tests/fixtures/gen-hooks-grammar.json is the `# gen-hooks:` grammar both parsers read:
// bin/gen-hooks-lib.js here and scripts/dev/gen_hook_settings.py in the server repo, whose
// suite runs the same file from the dotfiles checkout its CI already fetches (server#2818).
// Before it, each parser had its own tests and nothing said they agreed; a key or an error
// added on one side would drift from the other unseen. This runs every case through the JS
// parser; a case either declares its registrations or names an error substring.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const lib = require('../bin/gen-hooks-lib.js');
const { repoPath } = require('./lib/paths');

const FIXTURE = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'gen-hooks-grammar.json'), 'utf8'));

// The fields the fixture compares, in the fixture's spelling.
function normalize(reg) {
  const out = { event: reg.event, timeout: reg.timeout, order: reg.order };
  if (reg.matcher) out.matcher = reg.matcher;
  if (reg.async) out.async = true;
  if (reg.statusMessage) out.statusMessage = reg.statusMessage;
  if (reg.if) out.if = reg.if;
  return out;
}

// A derivation that finds nothing passes for free: name members it must hold, one of each
// verdict, so an emptied or truncated fixture fails here rather than reading green.
test('the grammar fixture holds a register case, a library case and an error case', () => {
  const names = FIXTURE.cases.map((c) => c.name);
  assert.ok(names.includes('one register block'), names.join(', '));
  assert.ok(names.includes('a library block'), names.join(', '));
  assert.ok(names.includes('an unknown key'), names.join(', '));
});

for (const c of FIXTURE.cases) {
  test(`grammar: ${c.name}`, () => {
    const file = 'executable_fixture.sh';
    if (c.error) {
      assert.throws(() => lib.parseHookFile(file, c.text), (err) => err.message.includes(c.error));
      return;
    }
    const parsed = lib.parseHookFile(file, c.text);
    assert.deepStrictEqual(parsed.registrations.map(normalize), c.registrations);
    assert.deepStrictEqual(parsed.library ? parsed.library.reason : null, c.library);
  });
}
