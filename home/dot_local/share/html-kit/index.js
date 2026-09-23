'use strict';
// html-kit — what the generated HTML pages under ~/.local/share share: the Catppuccin
// palette and the HTML escape. tools-inventory and terminal-cheatsheet each typed out both
// until #564, and config-map (~/.claude/vault-tooling) reads the same theme.css.
//
// theme.css is Catppuccin Mocha under the flavour's own variable names. A page that sets
// data-flavor="auto" on <html> gets Latte instead when the browser prefers a light scheme;
// the two dark-only pages leave it unset. Each page inlines the file ahead of its own
// page.css, which maps these names onto whatever the page's rules read.

const path = require('node:path');

const THEME_CSS = path.join(__dirname, 'theme.css');

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

module.exports = { THEME_CSS, esc };
