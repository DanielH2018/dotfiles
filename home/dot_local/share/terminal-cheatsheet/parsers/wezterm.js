'use strict';
// terminal-cheatsheet / parsers / WezTerm — Lua config, brace-matched.

const fs = require('node:fs');
const path = require('node:path');

const { XDG, read, disp, appendUnit } = require('../core');

function weztCombo(mods, key) {
  const names = { CTRL: 'Ctrl', SHIFT: 'Shift', ALT: 'Alt', SUPER: 'Super' };
  const parts = (mods || '').split('|').filter(Boolean).map((m) => names[m] || m);
  let k = key.replace(/^phys:/, '');
  k = ({ LeftBracket: '[', RightBracket: ']' })[k] || k;
  parts.push(k.length === 1 ? k.toUpperCase() : k);
  return parts.join('+');
}

// `text` is the WHOLE bind entry (see weztEntries), so content checks catch the binds
// whose action isn't a bare `act.X` on the key line: action_callback bodies (Ctrl+W's
// CloseCurrentPane, Ctrl+Shift+T's mux.spawn_window) and the multiline SpawnCommandInNewTab
// tabs (agentview / sandbox / homelab), whose distinguishing string sits a few lines down.
function weztLabel(action, text) {
  if (/agentview\s+--spawn/.test(text)) return 'New sandbox session — pick repo + branch';
  if (/agentview/.test(text)) return 'Agent View — cross-machine session switcher';
  if (/daniel-server/.test(text)) return 'New homelab tab (daniel-server)';
  if (/mux\.spawn_window/.test(text)) return 'New window';
  if (/CloseCurrentPane/.test(text)) return 'Close tab / pane';
  if (action === 'SpawnTab' && /DomainName\s*=\s*"local"/.test(text)) return 'New Git Bash tab (local)';
  if (action === 'SendString') return 'Insert newline (Claude Code multiline)';
  if (action === 'ActivatePaneDirection') return /Prev/.test(text) ? 'Focus previous split' : 'Focus next split';
  if (action === 'AdjustPaneSize') return /Left/.test(text) ? 'Resize split left' : 'Resize split right';
  return ({
    ReloadConfiguration: 'Reload config',
    CopyTo: 'Copy to clipboard',
    PasteFrom: 'Paste from clipboard',
    SpawnTab: 'New tab',
    SpawnWindow: 'New window',
    CloseCurrentPane: 'Close tab / pane',
    QuitApplication: 'Quit — close all windows',
    SplitHorizontal: 'Split right',
    SplitVertical: 'Split down',
  })[action] || action;
}

// WezTerm's config lives at $XDG_CONFIG_HOME/wezterm/wezterm.lua. Under WSL that resolves
// to the Linux ~/.config, where the Windows-only config is never deployed — so also probe
// the Windows user homes on /mnt/c so the Linux sheet still shows the host terminal's binds.
// Returns the local path when nothing matches, so read() yields '' and the card is omitted.
function weztermFile(xdg = XDG) {
  const local = path.join(xdg, 'wezterm', 'wezterm.lua');
  if (read(local).trim()) return local;
  if (!process.env.WSL_DISTRO_NAME) return local;
  let users = [];
  try { users = fs.readdirSync('/mnt/c/Users'); } catch { return local; }
  const skip = new Set(['Public', 'Default', 'Default User', 'All Users', 'desktop.ini']);
  for (const u of users) {
    if (skip.has(u)) continue;
    const win = path.join('/mnt/c/Users', u, '.config', 'wezterm', 'wezterm.lua');
    if (read(win).trim()) return win;
  }
  return local;
}

// Split a Lua table body into its top-level `{ … }` entries, brace-matched and string/
// comment-aware so a multiline action_callback (and any `{ … }` nested in it, e.g.
// SendKey({ key = "Escape" })) stays part of ONE entry. The old line-by-line scan dropped
// callback binds (no `action = act.X` on the key line) and only ever handed weztLabel the
// key line, so the SpawnCommandInNewTab tabs collapsed to a generic "SpawnCommandInNewTab".
function weztEntries(block) {
  const entries = [];
  let depth = 0, start = -1, inStr = false, q = '';
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === q) inStr = false;
      continue;
    }
    if (ch === '-' && block[i + 1] === '-') { const nl = block.indexOf('\n', i); if (nl < 0) break; i = nl; continue; }
    if (ch === '"' || ch === "'") { inStr = true; q = ch; continue; }
    if (ch === '{') { if (depth++ === 0) start = i; }
    else if (ch === '}') { if (--depth === 0 && start >= 0) { entries.push(block.slice(start, i + 1)); start = -1; } }
  }
  return entries;
}

function parseWezterm(xdg = XDG) {
  const file = weztermFile(xdg);
  const src = read(file);
  if (!src.trim()) return null;
  const binds = [];
  const block = (src.match(/config\.keys\s*=\s*\{([\s\S]*?)\n\}/) || ['', ''])[1];
  for (const entry of weztEntries(block)) {
    if (!/\bkey\s*=/.test(entry) || !/\baction\s*=/.test(entry)) continue;
    const key = (entry.match(/key\s*=\s*"([^"]+)"/) || [])[1];
    const mods = (entry.match(/mods\s*=\s*"([^"]+)"/) || ['', ''])[1];
    const action = (entry.match(/action\s*=\s*act\.(\w+)/) || [])[1];
    if (!key) continue;
    binds.push({ combo: weztCombo(mods, key), desc: weztLabel(action, entry) });
  }
  const loop = src.match(/for\s+i\s*=\s*1\s*,\s*(\d+)[\s\S]*?ActivateTab\(i\s*-\s*1\)/);
  if (loop) binds.push({ combo: `Ctrl+1…${loop[1]}`, desc: `Jump straight to tab 1…${loop[1]}` });

  const g = (re) => (src.match(re) || ['', ''])[1];
  const shell = g(/default_prog\s*=\s*\{\s*"([^"]+)"/).replace(/\\\\/g, '\\').split(/[\\/]/).pop();
  const scroll = g(/scrollback_lines\s*=\s*(\d+)/);
  const settings = [
    ['Font', [g(/family\s*=\s*"([^"]+)"/), g(/family = "[^"]+", weight = "([^"]+)"/)].filter(Boolean).join(' ')],
    ['Size', appendUnit(g(/font_size\s*=\s*([\d.]+)/), ' pt')],
    ['Theme', g(/color_scheme\s*=\s*"([^"]+)"/)],
    ['Cursor', g(/default_cursor_style\s*=\s*"([^"]+)"/)],
    ['Padding', appendUnit(g(/window_padding\s*=\s*\{\s*left\s*=\s*(\d+)/), ' px')],
    ['Scrollback', scroll ? Number(scroll).toLocaleString() + ' lines' : ''],
    ['Shell', shell],
  ].filter((s) => s[1]);
  return { title: 'WezTerm', accent: 'var(--blue)', sub: disp(file), binds, settings };
}

module.exports = { weztCombo, weztLabel, weztermFile, weztEntries, parseWezterm };
