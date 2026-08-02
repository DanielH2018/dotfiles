'use strict';
// terminal-cheatsheet / parsers / Yazi — keymap.toml, split on its [[mgr.*keymap]] heads.

const path = require('node:path');

const { YAZI, read, disp } = require('../core');

function parseYazi(yaziRoot = YAZI) {
  const kmFile = path.join(yaziRoot, 'keymap.toml');
  const km = read(kmFile);
  if (!km.trim()) return null;
  const binds = [];
  for (const chunk of km.split(/\[\[mgr\.[a-z_]*keymap\]\]/).slice(1)) {
    const onRaw = (chunk.match(/on\s*=\s*(\[[^\]]*\]|"[^"]*")/) || [])[1];
    if (!onRaw) continue;
    const on = onRaw.startsWith('[')
      ? [...onRaw.matchAll(/"([^"]*)"/g)].map((x) => x[1]).join(' ')
      : onRaw.replace(/"/g, '');
    const run = (chunk.match(/run\s*=\s*"([^"]*)"/) || chunk.match(/run\s*=\s*'([^']*)'/) || [])[1];
    const d = (chunk.match(/desc\s*=\s*"([^"]*)"/) || [])[1];
    binds.push({ keys: on, desc: d || run || '—' });
  }
  const yc = read(path.join(yaziRoot, 'yazi.toml'));
  const yg = (re) => (yc.match(re) || [, ''])[1];
  const settings = [
    ['Ratio', yg(/ratio\s*=\s*(\[[^\]]*\])/)],
    ['Sort', yg(/sort_by\s*=\s*"([^"]*)"/)],
    ['Show hidden', yg(/show_hidden\s*=\s*(\w+)/)],
    ['Linemode', yg(/linemode\s*=\s*"([^"]*)"/)],
  ].filter((s) => s[1]);
  return { title: 'Yazi', accent: 'var(--mauve)', sub: disp(kmFile), binds, settings };
}

module.exports = { parseYazi };
