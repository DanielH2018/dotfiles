'use strict';
// html-kit holds the Catppuccin palette and the HTML escape that tools-inventory,
// terminal-cheatsheet and config-map share (#564). Moving the palette out of each page.css
// is safe only while every custom property a page reads is still declared somewhere the
// page inlines, so that is the invariant pinned here, with a rejecting case to show the
// check can fail. The two flavours must also declare the same names, or a page that opts
// into Latte loses a colour in light mode only.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { srcPath } = require('./lib/paths');

const SHARE = srcPath('dot_local', 'share');
const KIT = path.join(SHARE, 'html-kit');
const THEME = fs.readFileSync(path.join(KIT, 'theme.css'), 'utf8');

const declared = (css) => new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const read = (css) => new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));

// The properties `pageText` reads that neither the theme nor the page itself declares.
function undeclared(pageText) {
  const have = new Set([...declared(THEME), ...declared(pageText)]);
  return [...read(pageText)].filter((v) => !have.has(v)).sort();
}

// Everything that ends up in the page's <style> or a style attribute: page.css, plus the
// renderer and parsers, which write `--accent:var(--x)` inline on each card.
function pageText(dir) {
  const files = [path.join(dir, 'assets', 'page.css')];
  for (const sub of ['', 'parsers']) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.js') && !f.endsWith('.test.js')) files.push(path.join(d, f));
  }
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

for (const page of ['tools-inventory', 'terminal-cheatsheet']) {
  test(`${page} reads only custom properties the theme or the page itself declares`, () => {
    const text = pageText(path.join(SHARE, page));
    const used = read(text);
    assert.ok(used.has('--base') && used.has('--text'), `${page}: the census found no palette reads`);
    assert.deepStrictEqual(undeclared(text), []);
  });
}

test('a page reading a property nobody declares is flagged', () => {
  assert.deepStrictEqual(undeclared('a{color:var(--base);border-color:var(--subtext)}'), ['--subtext']);
});

test('Mocha and Latte declare the same palette names', () => {
  const [mocha, latte] = THEME.split('@media');
  assert.ok(latte, 'theme.css carries a light-scheme block');
  assert.deepStrictEqual([...declared(latte)].sort(), [...declared(mocha)].sort());
  assert.strictEqual(declared(mocha).size, 26, 'the full Catppuccin palette');
});

test('esc escapes the four characters the pages interpolate into markup and attributes', () => {
  const { esc } = require(KIT);
  assert.strictEqual(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.strictEqual(esc(42), '42');
});
