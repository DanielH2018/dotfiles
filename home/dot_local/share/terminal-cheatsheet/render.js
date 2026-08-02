'use strict';
// terminal-cheatsheet / render — the parsed cards turned into the page.
//
// The stylesheet and the filter/relayout script live beside this file as real .css and
// .js under assets/ rather than inline in the template literal below; they are the two
// blocks that change for entirely different reasons than the parsers do.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PLATFORM, esc } = require('./core');
const { parseWezterm } = require('./parsers/wezterm');
const { parseGhostty } = require('./parsers/ghostty');
const { parseNvim } = require('./parsers/nvim');
const { parseYazi } = require('./parsers/yazi');
const { parseClaude } = require('./parsers/claude');

const ASSETS = path.join(__dirname, 'assets');
const cache = new Map();

// Read on first use, not at require time, so a missing asset surfaces where the caller can
// report it rather than as an uncaught throw while the module graph loads. The trailing
// newline is trimmed because these are files now: inline, both blocks ended at their last
// brace, and the page has to keep rendering identically.
function asset(name) {
  if (!cache.has(name)) {
    cache.set(name, fs.readFileSync(path.join(ASSETS, name), 'utf8').trimEnd());
  }
  return cache.get(name);
}

const kbdCombo = (combo) => combo.split('+').map((k) => `<kbd>${esc(k)}</kbd>`).join('<span class="plus">+</span>');
const chips = (settings) => settings.map(([k, v]) => `<span class="chip"><b>${esc(k)}</b>${esc(v)}</span>`).join('');

function tableRows(rows) {
  const body = rows.map((r) => `<tr class="bind"><td class="k">${r.k}</td><td class="d">${esc(r.desc)}</td></tr>`).join('');
  return `<table><tbody>${body}</tbody></table>`;
}

// Map one key token to a readable label: `<leader>` -> the configured leader, angle-named
// keys (<CR>, <Esc>, <Space>, …) -> friendly words, <C-w>/<M-x> -> Ctrl+/Alt+ combos, and
// a plain run like "gd" stays as-is. Shared by the Neovim (lhs) and Yazi (on) cards.
const NVIM_KEYNAME = { cr: 'Enter', esc: 'Esc', tab: 'Tab', bs: 'Bksp', del: 'Del',
  space: 'Space', up: '↑', down: '↓', left: '←', right: '→' };
function friendlyKey(tok, leader) {
  if (tok[0] !== '<' || !tok.endsWith('>')) return tok;
  const inner = tok.slice(1, -1), low = inner.toLowerCase();
  if (leader && low === 'leader') return leader;
  if (low === 'localleader') return 'LocalLdr';
  if (NVIM_KEYNAME[low]) return NVIM_KEYNAME[low];
  if (inner.includes('-')) return inner.replace(/[cC]-/g, 'Ctrl+').replace(/[mMaA]-/g, 'Alt+').replace(/[sS]-/g, 'Shift+');
  return inner;
}
// Each token renders as its own <kbd> so a multi-key sequence reads clearly.
const chipsHtml = (arr) => arr.map((c) => `<kbd class="seq">${esc(c)}</kbd>`).join(' ');
const nvimKeyChips = (lhs, leader) => chipsHtml((lhs.match(/<[^>]+>|[^<]+/g) || []).map((t) => friendlyKey(t, leader)));
const yaziKeyChips = (on) => chipsHtml(on.split(' ').filter(Boolean).map((t) => friendlyKey(t)));

function nvimBody(groups, leader) {
  const order = ['General', 'LSP', 'Finder', 'Editor', 'Git', 'Debug (DAP)'];
  const names = Object.keys(groups).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return names.map((name) => {
    const rows = groups[name].map((b) => ({
      k: `${nvimKeyChips(b.keys, leader)}${b.mode && b.mode !== 'n' ? `<span class="mode">${esc(b.mode)}</span>` : ''}`,
      desc: b.desc,
    }));
    return `<div class="grp"><h3>${esc(name)}</h3>${tableRows(rows)}</div>`;
  }).join('');
}

// Claude chords are space-separated steps, each a `+`-joined mods+key (e.g.
// "ctrl+k ctrl+t"). Render every step as its own <kbd> run and separate steps with a
// "then" so the two-stroke sequence reads clearly.
const claudeCap = (s) => (s.length === 1 ? s.toUpperCase() : s.charAt(0).toUpperCase() + s.slice(1));
const claudeKeyHtml = (chord) => chord.trim().split(/\s+/).map((step) =>
  step.split('+').map((k) => `<kbd>${esc(claudeCap(k))}</kbd>`).join('<span class="plus">+</span>')
).join('<span class="then">then</span>');

function claudeBody(groups) {
  return Object.keys(groups).map((name) => {
    const rows = groups[name].map((b) => ({ k: claudeKeyHtml(b.combo), desc: b.desc }));
    return `<div class="grp"><h3>${esc(name)}</h3>${tableRows(rows)}</div>`;
  }).join('');
}

// Each card is a <details> so its header collapses the section. Starts open; the click
// target is the whole <summary>. A CSS chevron rotates with [open]; the search filter
// (below) force-opens a card whenever it holds a match so collapsed sections still surface.
function cardHtml(id, data, inner) {
  return `
  <details class="card" data-tool="${id}" style="--accent:${data.accent}" open>
    <summary class="card-head"><span class="chev">▸</span><h2>${esc(data.title)}</h2><span class="src">${esc(data.sub)}</span></summary>
    <div class="chips">${chips(data.settings)}</div>
    ${inner}
  </details>`;
}

function build() {
  const terminals = [parseWezterm(), parseGhostty()].filter(Boolean);
  const nv = parseNvim();
  const ya = parseYazi();
  const cl = parseClaude();

  const cards = [];
  for (const t of terminals) cards.push(cardHtml(t.title.toLowerCase(), t, tableRows(t.binds.map((b) => ({ k: kbdCombo(b.combo), desc: b.desc })))));
  if (nv) cards.push(cardHtml('nvim', nv, nvimBody(nv.groups, nv.leader)));
  if (ya) cards.push(cardHtml('yazi', ya, tableRows(ya.binds.map((b) => ({ k: yaziKeyChips(b.keys), desc: b.desc })))));
  if (cl) cards.push(cardHtml('claude', cl, claudeBody(cl.groups)));

  const groupCount = (g) => Object.values(g).reduce((a, rows) => a + rows.length, 0);
  const total = terminals.reduce((a, t) => a + t.binds.length, 0)
    + (nv ? groupCount(nv.groups) : 0)
    + (ya ? ya.binds.length : 0)
    + (cl ? groupCount(cl.groups) : 0);
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const host = os.hostname().replace(/\.local$/, '');
  const nvNote = nv || ya ? ' Neovim leader is <kbd>Space</kbd>; sequences like <kbd class="seq">c m</kbd> mean press the keys in order.' : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Terminal Cheatsheet — ${esc(host)}</title>
<style>
${asset('page.css')}
</style></head><body>
<header><div class="bar">
  <h1><span class="star">✳</span> Terminal Cheatsheet</h1>
  <span class="meta"><b>${esc(host)}</b> · ${esc(PLATFORM)}</span>
  <span class="meta" id="count">${total} keybinds</span>
  <input id="q" type="search" placeholder="Filter keys or actions…" autofocus>
</div></header>
${cards.length ? `<main>${cards.join('')}</main>` : '<p class="none">No WezTerm / Ghostty / Neovim / Yazi / Claude Code configs found.</p>'}
<footer>Auto-generated ${stamp} on ${esc(PLATFORM)} by <code>terminal-cheatsheet</code> — do not edit by hand;
  it is regenerated from the deployed configs on every <code>chezmoi apply</code>.${nvNote}</footer>
<script>
${asset('page.js')}
</script>
</body></html>`;
}

module.exports = {
  asset, kbdCombo, chips, tableRows, friendlyKey, nvimKeyChips, yaziKeyChips,
  nvimBody, claudeKeyHtml, claudeBody, cardHtml, build,
};
