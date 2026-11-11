'use strict';
// html-kit holds the Catppuccin palette config-map inlines (#564). A page that opts into Latte
// loses a colour in light mode only if the two flavours declare different names, so that
// invariant is pinned here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { srcPath } = require('./lib/paths');

const THEME = fs.readFileSync(path.join(srcPath('dot_local', 'share', 'html-kit'), 'theme.css'), 'utf8');

const declared = (css) => new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

test('Mocha and Latte declare the same palette names', () => {
  const [mocha, latte] = THEME.split('@media');
  assert.ok(latte, 'theme.css carries a light-scheme block');
  assert.deepStrictEqual([...declared(latte)].sort(), [...declared(mocha)].sort());
  assert.strictEqual(declared(mocha).size, 26, 'the full Catppuccin palette');
});
