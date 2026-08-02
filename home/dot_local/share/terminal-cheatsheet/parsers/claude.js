'use strict';
// terminal-cheatsheet / parsers / Claude Code.
//
// ~/.claude/keybindings.json holds only the CUSTOM overrides layered on Claude Code's
// built-in keymap, grouped by context ("Global", "Chat", …). Format-driven like the rest:
// unknown action ids fall through to a de-camel-cased label, so binds added later show up
// with no code change. The built-in keymap ships in the binary, not in any config file,
// so it can't be parsed off disk like the other cards — curated in CLAUDE_BUILTINS below
// (checked against the docs 2026-07) and shown whenever ~/.claude exists, even if the
// overrides file is absent or unparseable.

const fs = require('node:fs');
const path = require('node:path');

const { HOME, read, disp } = require('../core');

const CLAUDE_LABEL = {
  'app:toggleTodos': 'Toggle to-do panel',
  'app:globalSearch': 'Global search',
  'chat:killAgents': 'Kill running agents',
  'chat:imagePaste': 'Paste image from clipboard',
};

function claudeLabel(action) {
  if (CLAUDE_LABEL[action]) return CLAUDE_LABEL[action];
  const words = String(action).replace(/^[^:]+:/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : String(action);
}

const CLAUDE_BUILTINS = {
  'Built-in': [
    ['ctrl+o', 'Transcript mode — browse the full session history'],
    ['ctrl+r', 'Search prompt history'],
    ['esc', 'Interrupt Claude mid-turn'],
    ['esc esc', 'Rewind — edit an earlier message'],
    ['shift+tab', 'Cycle permission modes — Manual / acceptEdits / plan (+ auto, bypassPermissions if enabled)'],
    ['alt+t', 'Toggle extended thinking (Option+T on macOS)'],
    ['ctrl+b', 'Move the running task to the background'],
    ['ctrl+l', 'Redraw screen — press twice within 2s to /clear the conversation'],
    ['ctrl+z', 'Suspend to shell — fg to return'],
    ['ctrl+d', 'Exit Claude Code'],
    ['!', 'Bash mode — line runs as a shell command'],
    ['/', 'Slash commands'],
    ['@', 'Mention a file or directory'],
  ],
  'Transcript mode (Ctrl+O)': [
    ['j', 'Scroll down a line'],
    ['k', 'Scroll up a line'],
    ['space', 'Page down'],
    ['ctrl+b', 'Page up'],
    ['g', 'Jump to top'],
    ['shift+g', 'Jump to bottom'],
    ['/', 'Search — n / N for next / previous match'],
    ['v', 'Open transcript in editor'],
    ['q', 'Exit transcript mode'],
  ],
};

function parseClaude(home = HOME) {
  const file = path.join(home, '.claude', 'keybindings.json');
  const src = read(file);
  let json = null;
  if (src.trim()) { try { json = JSON.parse(src); } catch { /* built-ins still render */ } }
  const groups = {};
  for (const ctx of (json && Array.isArray(json.bindings)) ? json.bindings : []) {
    const name = ctx.context || 'Global';
    for (const combo of Object.keys(ctx.bindings || {})) {
      (groups[name] = groups[name] || []).push({ combo, desc: claudeLabel(ctx.bindings[combo]) });
    }
  }
  const custom = Object.keys(groups).length > 0;
  if (!custom && !fs.existsSync(path.join(home, '.claude'))) return null;
  for (const [name, rows] of Object.entries(CLAUDE_BUILTINS)) {
    // Concat, not assign: an override file free to name its context anything could collide
    // with a built-in group name, and assigning would drop those custom binds silently.
    groups[name] = (groups[name] || []).concat(rows.map(([combo, desc]) => ({ combo, desc })));
  }
  return { title: 'Claude Code', accent: 'var(--peach)', sub: custom ? disp(file) : 'built-in keymap',
    groups, settings: [['Scope', custom ? 'Built-ins + custom overrides' : 'Built-ins']] };
}

module.exports = { CLAUDE_LABEL, claudeLabel, CLAUDE_BUILTINS, parseClaude };
