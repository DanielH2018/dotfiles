'use strict';
// terminal-cheatsheet / parsers / Ghostty — one `keybind = <chord>=<action>` per line.

const path = require('node:path');

const { XDG, read, disp, appendUnit } = require('../core');

function ghosttyCombo(chord) {
  const sym = { cmd: '⌘', command: '⌘', super: '⌘', opt: '⌥', option: '⌥', alt: '⌥', shift: '⇧', ctrl: '⌃', control: '⌃' };
  const parts = chord.split('+');
  return parts.map((p, i) => {
    const low = p.toLowerCase();
    if (sym[low]) return sym[low];
    if (i === parts.length - 1) return p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
    return p;
  }).join('+');
}

function ghosttyLabel(action) {
  if (action.startsWith('text:')) return 'Insert newline (Claude Code multiline)';
  const map = {
    reload_config: 'Reload config',
    copy_to_clipboard: 'Copy to clipboard',
    paste_from_clipboard: 'Paste from clipboard',
    new_tab: 'New tab',
    close_surface: 'Close tab / pane',
    new_window: 'New window',
    close_all_windows: 'Quit — close all windows',
    'new_split:right': 'Split right',
    'new_split:down': 'Split down',
    'goto_split:previous': 'Focus previous split',
    'goto_split:next': 'Focus next split',
  };
  if (map[action]) return map[action];
  if (action.startsWith('resize_split:')) return 'Resize split ' + action.split(':')[1].split(',')[0];
  return action.replace(/:.*/, '').replace(/_/g, ' ');
}

function parseGhostty(xdg = XDG) {
  const file = path.join(xdg, 'ghostty', 'config');
  const src = read(file);
  if (!src.trim()) return null;
  const binds = [];
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*keybind\s*=\s*(.+)$/); // leading '#' on comments won't match
    if (!m) continue;
    const eq = m[1].indexOf('=');
    if (eq < 0) continue;
    binds.push({ combo: ghosttyCombo(m[1].slice(0, eq).trim()), desc: ghosttyLabel(m[1].slice(eq + 1).trim()) });
  }
  const g = (re) => (src.match(re) || ['', ''])[1];
  const scroll = g(/^scrollback-limit\s*=\s*(\d+)/m);
  const settings = [
    ['Font', g(/^font-family\s*=\s*"?([^"\n]+?)"?\s*$/m)],
    ['Size', appendUnit(g(/^font-size\s*=\s*([\d.]+)/m), ' pt')],
    ['Theme', g(/^theme\s*=\s*"?([^"\n]+?)"?\s*$/m)],
    ['Cursor', g(/^cursor-style\s*=\s*(\w+)/m)],
    ['Padding', appendUnit(g(/^window-padding-x\s*=\s*(\d+)/m), ' px')],
    ['Scrollback', scroll ? Number(scroll).toLocaleString() + ' lines' : ''],
    ['Shell', g(/^shell-integration\s*=\s*(\w+)/m)],
  ].filter((s) => s[1]);
  return { title: 'Ghostty', accent: 'var(--teal)', sub: disp(file), binds, settings };
}

module.exports = { ghosttyCombo, ghosttyLabel, parseGhostty };
