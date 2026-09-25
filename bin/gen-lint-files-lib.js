'use strict';
// Pure, deterministic logic for `bin/gen-lint-files`. No fs/git/process access lives here:
// the wrapper reads `git ls-files -s` and each candidate's first line, and hands them in as
// plain objects, so every function below is a total function of its arguments
// (gen-hooks-lib.js's precedent).
//
// What this generates, and why it is generated at all. Each lint hook in
// .pre-commit-config.yaml classifies files by `types`/`types_or`, which identifies a file by
// extension or, failing that, by shebang, and only when the file is executable. An
// extensionless script therefore has to be NAMED in the hook's `files:` as well, and that
// name used to be typed by hand in three places (ruff-check, oxlint, bsd-portability) plus a
// fourth in pyproject.toml's `extend-include`, which had already drifted to 1 name of 11.
// The census below is the one list; the four outputs are rendered from it.

const SHEBANG = {
  shell: /^#!.*\b(bash|zsh|ksh|dash|sh)\b/,
  python: /^#!.*\bpython[0-9.]*\b/,
  // `node` is the third dialect. It was missing from the first census and left the oxlint
  // hook with no coverage assertion at all.
  node: /^#!.*\bnode\b/,
};

// Scripts a gate is allowed to leave out, per hook. Empty, and worth keeping that way: the
// ruff list once held otelq, streamdeck-usb-reset and wl-bmp2png, which carried 25 findings
// between them at the point the gate first saw them, and four of the six node scripts sat
// at 100644 until the commit that added the oxlint hook. Deleting a name here is the last
// step of fixing one; adding one is how coverage is lost.
//
// A name here must exist in the census for that kind, or `renderPatterns` throws: a stale
// entry would otherwise keep excluding a path that was renamed onto a different script.
const BACKLOG = {
  'ruff-check': [],
  oxlint: [],
};

// Files bin/lint-bsd-portability scans that carry no shebang: rc files are sourced, never
// executed, and the .chezmoitemplates fragments are spliced into the scripts that include
// them. Mirrors `scannable()` in that script; tests/lint-bsd-portability.test.js asserts the
// rendered pattern admits everything `--list` derives, so the two cannot drift apart.
const BSD_SOURCED_FILES = [
  'home/dot_bashrc',
  'home/dot_zshenv',
  'home/.chezmoitemplates/is-wsl',
  'home/.chezmoitemplates/is-desktop-linux',
  'home/.chezmoitemplates/require-sudo',
];

// The extension branch of each hook's `files:`. `files:` is ANDed with `types_or:`, so for
// ruff-check and oxlint it is a WIDENER: `\.py$` admits every Python file the way
// pre-commit resolving the list itself would, and the enumerated branch adds only the
// scripts an extension cannot type. Emitting an allowlist here would narrow ruff's reach
// silently — the ruff hook once did exactly that and reached 23 of 51 Python files.
//
// bsd-portability carries no `types:` (a .sh.tmpl types as text, not shell), so there the
// pattern IS the allowlist and has to name the extensionless scripts itself.
const EXTENSION_BRANCH = {
  'ruff-check': '\\.py$',
  oxlint: '\\.(js|mjs)$',
  'bsd-portability': '\\.(sh|bash|zsh|js|mjs|cjs)$|\\.(sh|bash)\\.tmpl$',
};

const KINDS_FOR_HOOK = {
  'ruff-check': ['python'],
  oxlint: ['node'],
  'bsd-portability': ['shell', 'node'],
};

const MARKER_PREFIX = '# gen-lint-files: ';

// entries: [{ mode, file, firstLine }] for every tracked file. A basename with a dot is left
// alone: those are classified by extension and need no name in `files:`. Returns the
// extensionless tracked files that carry a recognised shebang, tagged by dialect, sorted.
function census(entries) {
  const out = [];
  for (const { mode, file, firstLine } of entries) {
    const base = file.slice(file.lastIndexOf('/') + 1);
    if (base.includes('.')) continue;
    const first = firstLine || '';
    let kind = null;
    if (SHEBANG.shell.test(first)) kind = 'shell';
    else if (SHEBANG.python.test(first)) kind = 'python';
    else if (SHEBANG.node.test(first)) kind = 'node';
    if (kind) out.push({ mode, file, kind });
  }
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return out;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `^(a/(b|c)|d/e)$`: the paths grouped by their full directory, each group's basenames as
// one alternation, directories and names sorted. A group of one collapses to the bare path.
// Grouped rather than flat because the reader of the bsd-portability line is a human
// checking one script is named, and 74 full paths bury the basename in a repeated prefix.
// Nothing reads the spelling: every test that consumes a rendered line builds the RegExp
// and asks it about paths (#534).
function enumerate(files) {
  const byDir = new Map();
  for (const file of [...files].sort()) {
    const cut = file.lastIndexOf('/') + 1;
    const dir = file.slice(0, cut);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(escapeRegex(file.slice(cut)));
  }
  const groups = [...byDir].map(([dir, names]) => (
    escapeRegex(dir) + (names.length === 1 ? names[0] : `(${names.join('|')})`)
  ));
  return `^(${groups.join('|')})$`;
}

function scriptsFor(hook, scripts) {
  const kinds = KINDS_FOR_HOOK[hook];
  const backlog = BACKLOG[hook] || [];
  const members = scripts.filter((s) => kinds.includes(s.kind)).map((s) => s.file);
  for (const name of backlog) {
    if (!members.includes(name)) {
      throw new Error(
        `gen-lint-files: BACKLOG['${hook}'] names ${name}, which is not an extensionless `
        + `${kinds.join('/')} script in the tree. Remove the stale entry.`,
      );
    }
  }
  return members.filter((f) => !backlog.includes(f));
}

// { hookId: '<files: pattern>' } for every hook this generator owns.
function renderPatterns(scripts) {
  const out = {};
  for (const hook of Object.keys(EXTENSION_BRANCH)) {
    const branches = [EXTENSION_BRANCH[hook]];
    const files = scriptsFor(hook, scripts);
    if (hook === 'bsd-portability') files.push(...BSD_SOURCED_FILES);
    if (files.length > 0) branches.push(enumerate(files));
    out[hook] = `(${branches.join('|')})`;
  }
  return out;
}

// ruff.toml: the entry point ruff discovers first. It `extend`s pyproject.toml so the rules
// stay where humans edit them, and carries only the list this generator owns.
function renderRuffToml(scripts) {
  const files = scriptsFor('ruff-check', scripts);
  const lines = [
    '# Generated by bin/gen-lint-files -- do not hand-edit. Rules live in pyproject.toml,',
    '# which this file extends; only the extensionless-script list is rendered here, from',
    '# the same shebang census that fills the lint hooks\' `files:` in',
    '# .pre-commit-config.yaml. A bare `ruff check .` outside prek reads this file, so the',
    '# two paths see the same scripts.',
    'extend = "pyproject.toml"',
    'extend-include = [',
    ...files.map((f) => `  "${f}",`),
    ']',
    '',
  ];
  return lines.join('\n');
}

// Replace the `files:` line that follows each `# gen-lint-files: <hook-id>` marker. Throws
// when a hook in `patterns` has no marker, a marker names an unknown hook, or a marker is
// not followed by a `files:` line — the generator fills slots the config declares, it does
// not invent where they go.
function injectFilesPatterns(cfgText, patterns) {
  const seen = new Set();
  const lines = cfgText.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)# gen-lint-files: (\S+)\s*$/.exec(lines[i]);
    if (!m) continue;
    const [, indent, hook] = m;
    if (!(hook in patterns)) {
      throw new Error(`gen-lint-files: marker names unknown hook '${hook}' at line ${i + 1}.`);
    }
    if (seen.has(hook)) throw new Error(`gen-lint-files: more than one marker for '${hook}'.`);
    const next = lines[i + 1] || '';
    if (!/^\s*files: /.test(next)) {
      throw new Error(`gen-lint-files: marker for '${hook}' at line ${i + 1} is not followed by a files: line.`);
    }
    lines[i + 1] = `${indent}files: ${patterns[hook]}`;
    seen.add(hook);
  }
  const missing = Object.keys(patterns).filter((h) => !seen.has(h));
  if (missing.length > 0) {
    throw new Error(
      `gen-lint-files: no '${MARKER_PREFIX}<id>' marker for hook(s) ${missing.join(', ')} in `
      + '.pre-commit-config.yaml. Add the marker line once by hand, directly above the hook\'s files: line.',
    );
  }
  return lines.join('\n');
}

module.exports = {
  SHEBANG,
  BACKLOG,
  BSD_SOURCED_FILES,
  MARKER_PREFIX,
  census,
  enumerate,
  renderPatterns,
  renderRuffToml,
  injectFilesPatterns,
};
