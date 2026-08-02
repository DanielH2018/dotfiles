'use strict';
// tools-inventory / core — the decisions that need no filesystem.
//
// Everything here is a pure function of its arguments: text in, verdict out. That is what
// lets the suite exercise header extraction, drift diffing and the per-host gate without a
// chezmoi checkout — the IO lives in sources.js, and callers inject `exists`-style probes.

const path = require('node:path');

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Language from the shebang, falling back to the extension. Used only for uncurated
// entries and as a cross-check; curated entries carry their own label.
function langOf(firstLine, filename) {
  const sh = String(firstLine || '');
  if (/\bpython/.test(sh)) return 'python';
  if (/\bnode\b/.test(sh)) return 'node';
  if (/\b(bash|sh|zsh)\b/.test(sh)) return 'bash';
  if (/\.(ps1|vbs|cmd|bat)$/i.test(filename)) return 'win';
  if (/\.cs$/i.test(filename)) return 'win';
  if (/\.py$/i.test(filename)) return 'python';
  if (/\.(js|mjs)$/i.test(filename)) return 'node';
  if (/\.(sh|bash)$/i.test(filename)) return 'bash';
  return 'other';
}

function countLines(text) {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

// The leading comment block, which in this repo is always a real explanation rather than
// a restatement of the name. Handles `#` blocks, `//` blocks and Python docstrings.
function headerComment(text, maxLines = 8) {
  if (!text) return '';
  const lines = text.split('\n');
  let i = 0;
  if (lines[0] && lines[0].startsWith('#!')) i = 1;
  while (i < lines.length && /^\s*(['"]use strict['"];?|set -[eux]+.*)$/.test(lines[i])) i++;

  const out = [];
  const start = lines[i] || '';
  if (/^\s*(r?"""|r?''')/.test(start)) {
    const q = start.trim().slice(0, 3).replace(/^r/, '');
    let first = start.trim().replace(/^r?("""|''')/, '');
    if (first.endsWith(q)) return first.slice(0, -3).trim();
    if (first) out.push(first);
    for (i++; i < lines.length && out.length < maxLines; i++) {
      if (lines[i].includes(q)) { out.push(lines[i].split(q)[0]); break; }
      out.push(lines[i]);
    }
  } else {
    for (; i < lines.length && out.length < maxLines; i++) {
      const m = /^\s*(?:#|\/\/|rem\s)\s?(.*)$/i.exec(lines[i]);
      if (!m) break;
      out.push(m[1]);
    }
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

// Which entries claim which source files. A card may cover several files (xclip+xsel,
// the two Windows symlinks), so coverage is the union of `source` and `alsoCovers`.
function coveredPaths(tools) {
  const set = new Set();
  for (const t of tools) {
    if (t.source) set.add(t.source);
    for (const p of t.alsoCovers || []) set.add(p);
  }
  return set;
}

// Drift, both directions. `found` is what the scanned command dirs hold; `tools` is what
// tools.json describes. Either side being wrong is a real defect, so both are reported.
//
// The two directions ask different questions, and conflating them was a bug: an entry is
// missing when its file is not on disk, NOT when it is absent from `found`. Library
// entries deliberately point outside the scanned command dirs, so a membership test
// reported every one of them as missing and dropped them from the page.
function driftOf(found, tools, excluded, exists) {
  const covered = coveredPaths(tools);
  const skip = new Set(excluded || []);
  const uncurated = found.filter((p) => !covered.has(p) && !skip.has(p)).sort();
  const missing = tools
    .filter((t) => t.source && !exists(t.source))
    .map((t) => `${t.name} (${t.source})`)
    .sort();
  return { uncurated, missing };
}

// The files whose lines count towards a card's size. A card can cover several (xclip+xsel),
// so the size is their sum; symlinks are excluded because `symlink_av` is one line holding a
// target path, not a line of the tool.
function codeFiles(t) {
  return [t.source, ...(t.alsoCovers || [])].filter(
    (p) => p && !path.basename(p).startsWith('symlink_')
  );
}

// Is this entry's deployed target present on this machine, and if not, why not?
// `ignored` is chezmoi's own answer for this host; an ancestor being ignored ignores
// everything beneath it, which is how `.claude/sandbox` gates its whole subtree.
function hostState(deployed, ignoredSet, exists) {
  if (!deployed) return 'n/a';
  let p = deployed;
  while (p && p !== '.' && p !== '/') {
    if (ignoredSet.has(p)) return 'gated';
    const next = path.posix.dirname(p);
    if (next === p) break;
    p = next;
  }
  return exists(deployed) ? 'here' : 'absent';
}

function humanCount(n) {
  return n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : String(n);
}

module.exports = {
  esc, langOf, countLines, headerComment, coveredPaths, driftOf, codeFiles, hostState, humanCount,
};
