'use strict';
// terminal-cheatsheet / parsers / Neovim — the only parser that walks a tree rather than
// reading one known file: keybinds are spread across every .lua under nvim/lua, in three
// different spellings (lazy.nvim `keys = {…}`, explicit vim.keymap.set, and data-driven
// `m(lhs, rhs, desc)` helpers).

const fs = require('node:fs');
const path = require('node:path');

const { XDG, read, disp } = require('../core');

const NVIM_LABEL = { Lsp: 'LSP', Dap: 'Debug (DAP)' };
const pretty = (base) => base.replace(/\.lua$/, '').replace(/(^|[-_])(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase());
const nvimMode = (m) => (m ? m.replace(/[{}"'\s]/g, '').split(',').join(' ') : 'n') || 'n';

// Collect the top-level string literals of a call, starting at the index of its
// opening '('. Used for data-driven `m(lhs, rhs, desc)` helper maps where rhs may
// be a multiline function: the first string is the lhs, the last is the desc.
function callStrings(src, open) {
  let depth = 0, inStr = false, q = '', cur = '';
  const out = [];
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === q) { inStr = false; out.push(cur); cur = ''; } else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; q = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) break;
  }
  return out;
}

function parseNvim(xdg = XDG) {
  const dirRoot = path.join(xdg, 'nvim', 'lua');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.lua')) files.push(p);
    }
  };
  try { walk(dirRoot); } catch { return null; }
  if (!files.length) return null;

  const groups = {};
  const seen = new Set();
  const add = (group, keys, mode, descText) => {
    const sig = group + '|' + mode + '|' + keys;
    if (seen.has(sig)) return;
    seen.add(sig);
    (groups[group] = groups[group] || []).push({ keys, mode, desc: descText || '—' });
  };

  for (const f of files.sort()) {
    const src = read(f);
    const inPlugins = /[\\/]plugins[\\/]/.test(f);
    const group = inPlugins ? (NVIM_LABEL[pretty(path.basename(f))] || pretty(path.basename(f))) : 'General';

    // lazy.nvim `keys = { { "<lhs>", <rhs>, desc = "…", mode = … }, … }`
    const kb = src.match(/keys\s*=\s*\{([\s\S]*?)\n\t*\},?\n/);
    if (kb) {
      for (const line of kb[1].split('\n')) {
        const lhs = (line.match(/\{\s*"([^"]+)"/) || [])[1];
        if (!lhs) continue;
        const d = (line.match(/desc\s*=\s*"([^"]*)"/) || ['', ''])[1];
        const mode = nvimMode((line.match(/mode\s*=\s*("[^"]*"|\{[^}]*\})/) || [])[1]);
        add(group, lhs, mode, d);
      }
    }
    // explicit map()/vim.keymap.set() calls carrying an inline desc
    const re = /(?:vim\.keymap\.set|[^.\w]map)\(\s*("[^"]*"|\{[^}]*\})\s*,\s*"([^"]+)"[\s\S]{0,220}?desc\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(src))) add(group, m[2], nvimMode(m[1]), m[3]);

    // data-driven helper: `local function <h>(lhs, rhs, desc)` then <h>("gd", …, "…")
    const helpers = [...src.matchAll(/local\s+(?:function\s+)?(\w+)\s*=?\s*(?:function\s*)?\(\s*lhs\s*,\s*rhs\s*,\s*desc\s*\)/g)]
      .map((h) => h[1]);
    for (const h of new Set(helpers)) {
      const call = new RegExp('[^.\\w]' + h + '\\s*\\(', 'g');
      while (call.exec(src)) {
        const strs = callStrings(src, call.lastIndex - 1);
        if (strs.length >= 2 && strs[0] !== strs[strs.length - 1]) add(group, strs[0], 'n', strs[strs.length - 1]);
      }
    }
  }

  const o = read(path.join(xdg, 'nvim', 'lua', 'config', 'options.lua'));
  const og = (re) => (o.match(re) || ['', ''])[1];
  const lead = og(/mapleader\s*=\s*"([^"]*)"/);
  const leader = lead === ' ' ? 'Space' : (lead || '\\');
  const settings = [
    ['Leader', leader],
    ['Clipboard', /unnamed/.test(og(/clipboard\s*=\s*"([^"]*)"/)) ? 'System' : og(/clipboard\s*=\s*"([^"]*)"/)],
    ['Line numbers', og(/\bnumber\s*=\s*(\w+)/)],
  ].filter((s) => s[1]);
  return { title: 'Neovim', accent: 'var(--green)', sub: disp(path.join(xdg, 'nvim')) + '/', groups, settings, leader };
}

module.exports = { NVIM_LABEL, pretty, nvimMode, callStrings, parseNvim };
