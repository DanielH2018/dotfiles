// A test may not write outside its own scratch directory. This finds the ones that do.
//
// Three incidents, one shape, each found only by accident:
//
//   1. A harness exported BIN_DIR/VER_DIR/APP_DIR at a temp dir; the module it sourced
//      overwrote them with plain assignments, so the fixtures landed in the real
//      ~/.local/bin and replaced the live `yazi` and `ya` with 27-byte stubs. Nothing
//      failed — the harness reported success.
//   2. apt_repo_add wrote /etc/apt/... inline, so the apt half of the repo helpers could
//      only be tested by stubbing sudo and asserting on a command string.
//   3. tests/managed-test-drift.test.js planted a probe file inside this checkout's own
//      `home/` to prove its guard worked. Two dozen other files render
//      `--source <this tree>` and node --test runs files in parallel, so a walk could
//      readdir the intruder and lstat it after the `finally` had removed it. The failure
//      landed on whichever unrelated test happened to be rendering, which is why it read
//      as random and got misdiagnosed as chezmoi state contention.
//
// (1) and (2) are fixed at the module and guarded by tests/linux-install-lib.test.js.
// This covers the part that was still open: the suite itself.
//
// Why static rather than snapshotting the tree before and after a run: the probe in (3)
// was written and removed inside a `finally`. A snapshot sees nothing — the damage was
// the window, not the residue. Only reading the code catches a write that cleans up
// after itself.
//
// findEscapes is pure over text and never touches the filesystem. That is load-bearing
// rather than fastidious: the obvious way to prove a guard like this works is to plant a
// file in the tree it protects, which is exactly bug (3). A pure checker makes that trap
// unreachable — tests/sandbox-escape.test.js proves it fires using a synthetic string.
//
// Known gap, deliberately not closed: this reads node-side `fs` calls. A subprocess that
// writes into the checkout is invisible here. No instance of that exists, and building
// for it now would be speculative.
//
// Known false positive, currently hypothetical: taint spreads by name, so a scratch path
// derived from a root — `path.join(os.tmpdir(), path.basename(__dirname))` — reads as an
// escape even though it lands in /tmp. Nothing in the scanned set does this. If one turns
// up, bind the temp path without mentioning the root rather than loosening the rule.

// The fs mutators the suite uses, plus their obvious neighbours, and which argument names
// the path being written. Read-side arguments are excluded on purpose: `fs.cpSync(SOURCE,
// copy)` copies the source tree OUT to a scratch dir, which is the recommended fix for
// this whole class rather than an instance of it. `openSync` is absent because its mode
// argument decides whether it writes, and 'r' is the default — flagging it would fail
// every read.
const WRITE_ARGS = {
  writeFileSync: [0],
  appendFileSync: [0],
  mkdirSync: [0],
  mkdtempSync: [0],
  rmSync: [0],
  rmdirSync: [0],
  unlinkSync: [0],
  truncateSync: [0],
  chmodSync: [0],
  chownSync: [0],
  utimesSync: [0],
  createWriteStream: [0],
  cpSync: [1],
  copyFileSync: [1],
  linkSync: [1],
  symlinkSync: [1],
  renameSync: [0, 1], // unlinks the old name and creates the new one
};

// The two roots that outlive a test run: the checkout the suite reads its own inputs
// from, and the operator's real home. Everything else a test can reach is either a temp
// dir it made or a path it was handed.
const ROOTS = [
  {
    what: 'the repo checkout',
    re: /\b__dirname\b|\bprocess\.cwd\(\)/,
    fix: 'copy what you need into a temp dir and point the tool at the copy'
      + ' — tests/managed-test-drift.test.js is the worked example',
  },
  {
    what: 'the real home',
    re: /\bos\.homedir\(\)|\bprocess\.env\.HOME\b/,
    fix: 'build a throwaway HOME with fs.mkdtempSync and pass it in the child env',
  },
];

// Keywords a regex literal can directly follow. After one of these a slash cannot be
// division, because there is no value on its left to divide.
const REGEX_AFTER = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield',
  'await', 'void', 'delete', 'instanceof', 'new', 'throw',
]);

// The identifier immediately before index `i`, skipping whitespace. '' when the preceding
// character is punctuation.
function trailingWord(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j -= 1;
  let end = j;
  while (j >= 0 && /[A-Za-z_$]/.test(src[j])) j -= 1;
  return src.slice(j + 1, end + 1);
}

// Blanks the *contents* of comments, strings and regex literals, preserving length so
// offsets and line numbers still line up.
//
// Two things depend on this. A `//` inside a string is not a comment, so recognising
// comments at all requires tracking strings. And it is what lets the guard's own test
// file hold fixtures of the bug shape: a fixture is a string literal, so it is blanked
// before scanning, while the same text passed to findEscapes as `text` is top-level code
// and is scanned normally.
//
// Substitutions are stepped back into code, so `fs.writeFileSync(`${SOURCE}/x`, '')` is
// still caught. Regex literals are detected by the usual previous-significant-character
// heuristic — without it a regex like /doesn't/ opens a string that never closes and
// silently blanks the rest of the file. Anything that defeats the heuristic ends the scan
// outside code, which throws rather than quietly reporting a clean file.
function blankLiterals(src) {
  const out = Array.from(src);
  const wipe = (i) => { if (out[i] !== undefined && out[i] !== '\n') out[i] = ' '; };
  const frames = []; // brace depth of each template literal we are nested inside
  let mode = 'code';
  let brace = 0;
  let prev = ''; // last significant character of code, for the regex heuristic

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];

    if (mode === 'line') { if (c === '\n') mode = 'code'; else wipe(i); continue; }
    if (mode === 'block') {
      wipe(i);
      if (c === '*' && n === '/') { wipe(i + 1); i += 1; mode = 'code'; }
      continue;
    }
    if (mode === "'" || mode === '"') {
      if (c === '\\') { wipe(i); wipe(i + 1); i += 1; continue; }
      if (c === mode) { mode = 'code'; prev = c; continue; }
      wipe(i);
      continue;
    }
    if (mode === 'regex' || mode === 'class') {
      if (c === '\\') { wipe(i); wipe(i + 1); i += 1; continue; }
      if (mode === 'regex' && c === '[') { mode = 'class'; wipe(i); continue; }
      if (mode === 'class' && c === ']') { mode = 'regex'; wipe(i); continue; }
      if (mode === 'regex' && c === '/') { mode = 'code'; prev = c; continue; }
      wipe(i);
      continue;
    }
    if (mode === '`') {
      if (c === '\\') { wipe(i); wipe(i + 1); i += 1; continue; }
      if (c === '`') { mode = 'code'; prev = c; continue; }
      if (c === '$' && n === '{') { frames.push(brace); brace = 0; mode = 'code'; i += 1; continue; }
      wipe(i);
      continue;
    }

    // code
    if (c === '/' && n === '/') { mode = 'line'; wipe(i); continue; }
    if (c === '/' && n === '*') { mode = 'block'; wipe(i); continue; }
    if (c === '/') {
      // A slash starts a regex only where a value may begin; after an identifier, a
      // closing bracket or a literal it is division. The keyword check is not decoration:
      // `return /chezmoi.../s.test(src)` in tests/chezmoi-umask-wrapper.test.js ends in a
      // letter, so the punctuation test alone reads it as division and scans the pattern
      // as code — one apostrophe in such a regex blanks the rest of the file.
      if (prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev)
          || REGEX_AFTER.has(trailingWord(src, i))) {
        mode = 'regex';
        wipe(i);
        continue;
      }
      prev = c;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { mode = c; continue; }
    if (c === '{') brace += 1;
    else if (c === '}') {
      if (brace === 0 && frames.length) { brace = frames.pop(); mode = '`'; continue; }
      brace -= 1;
    }
    if (!/\s/.test(c)) prev = c;
  }

  if (mode !== 'code') {
    throw new Error(`could not lex the file: ran off the end inside ${mode}`);
  }
  return out.join('');
}

// Splits a call's argument list at top level, starting from the index of its `(`. The
// destination is positional and is routinely a nested call, so `path.join(SOURCE, 'x')`
// has to come back as one argument rather than two.
function splitArgs(code, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < code.length; i += 1) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') depth -= 1;
    else if (c === ')') {
      if (depth === 0) { args.push(code.slice(start, i)); return args; }
      depth -= 1;
    } else if (c === ',' && depth === 0) { args.push(code.slice(start, i)); start = i + 1; }
  }
  return args; // unbalanced: the caller treats a missing argument as nothing to check
}

// Which root, if any, an expression resolves to — directly, or through a name already
// known to hold one.
function rootOf(expr, bound) {
  for (const root of ROOTS) if (root.re.test(expr)) return root;
  for (const id of expr.match(/[A-Za-z_$][\w$]*/g) || []) {
    if (bound.has(id)) return bound.get(id);
  }
  return null;
}

// Names bound to one of the roots, to a fixpoint so `REPO` -> `SOURCE` -> `LIB` all carry
// the taint. Bounded at 400 characters past the `=` so a declaration missing its
// semicolon cannot swallow the rest of the file.
function boundNames(code) {
  const bound = new Map();
  const decl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]{0,400}?);/g;
  let changed = true;
  while (changed) {
    changed = false;
    decl.lastIndex = 0;
    let m = decl.exec(code);
    while (m) {
      const [, name, expr] = m;
      if (!bound.has(name)) {
        const root = rootOf(expr, bound);
        if (root) { bound.set(name, root); changed = true; }
      }
      m = decl.exec(code);
    }
  }
  return bound;
}

/**
 * Find writes aimed outside a test's scratch directory.
 *
 * @param {string} text  JavaScript source
 * @returns {Array<{line: number, api: string, arg: string, root: {what: string, fix: string}}>}
 */
function findEscapes(text) {
  const code = blankLiterals(text);
  const bound = boundNames(code);
  const found = [];
  const call = /\bfs\.([A-Za-z]+)\s*\(/g;

  let m = call.exec(code);
  while (m) {
    const positions = WRITE_ARGS[m[1]];
    if (positions) {
      const args = splitArgs(code, m.index + m[0].length - 1);
      for (const p of positions) {
        const arg = args[p];
        const root = arg === undefined ? null : rootOf(arg, bound);
        if (root) {
          found.push({
            line: code.slice(0, m.index).split('\n').length,
            api: m[1],
            arg: arg.trim(),
            root,
          });
        }
      }
    }
    m = call.exec(code);
  }
  return found;
}

module.exports = { findEscapes, blankLiterals, WRITE_ARGS, ROOTS };
