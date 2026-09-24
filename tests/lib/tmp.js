// One way to make a scratch directory from a test, and one way to remove it.
//
// scratch(root, prefix, t) -> a fresh directory `root/prefix<random>`.
//
//   With a test context `t`, the directory is removed by t.after(), when that test ends.
//   Without one, it is removed when the process exits -- the shape for a fixture made once at
//   module scope and read by every test in the file (a HOME, a fake /proc), and the shape
//   most call sites had before this file existed: 128 test files each carried a `dirs` array,
//   a `scratch()` wrapper that pushed into it, and a `process.on('exit')` loop over it, in
//   about eight spellings. This is that, once. Removal is best-effort either way: a dir a
//   background process is still holding open is left for bin/sweep-test-tmp, and a test
//   never fails over its own cleanup.
//
// The root is an argument, and is spelled `os.tmpdir()` at the call site, on purpose.
// bin/sweep-test-tmp reads its prefix set out of the tracked test files with a grep for the
// literal `os.tmpdir(), '<prefix>'`, so a helper that took a bare prefix would remove every
// migrated file from the sweep's view and the sweep would go quietly inert -- its own tests
// run against a fixture that still carries the literal, so nothing would go red.
// `scratch(os.tmpdir(), 'x-')` keeps the prefix where the sweep reads it. A dir rooted inside
// another scratch dir (`scratch(DIR, 'bin-')`) is swept with its parent, which is also what
// the sweep's own comment says about that form.
//
// What this does not do: it does not realpath the result. macOS's os.tmpdir() is a symlink
// into /private, and the callers that compare against git's porcelain output realpath it
// themselves, at the site that needs it.
const fs = require('node:fs');
const path = require('node:path');

const untilExit = [];
let exitHookInstalled = false;

function remove(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function scratch(root, prefix, t) {
  const dir = fs.mkdtempSync(path.join(root, prefix));
  if (t) {
    t.after(() => remove(dir));
  } else {
    untilExit.push(dir);
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.on('exit', () => { for (const d of untilExit) remove(d); });
    }
  }
  return dir;
}

// hardenedCopy(dir, src) -> `dir`, holding a copy of `src` at 755 for directories and 644
// for files, with __pycache__ and any .venv left out. Symlinks are copied as links and
// never chmodded.
//
//   For a hook that refuses to import code writable by group or others: a checkout made
//   under a permissive umask (007 on the Ubuntu hosts) is group-writable, while the
//   deployed copy is not, so a test pointing such a hook at the checkout sees a refusal.
//   `dir` comes from a scratch() call at the call site, for the sweep reason above.
//
//   Why links are skipped (dotfiles #637): chmod follows a symlink. A `uv run` inside the
//   claude-guard source leaves a .venv whose bin/python3.14 links to the SHARED uv-managed
//   interpreter, so hardening the copy set that interpreter to 644 and broke every hook
//   that runs Python on the host, four times on 2026-09-24. `.venv` is also left out
//   because it is local build output, never part of the code under test.
function hardenedCopy(dir, src) {
  const skip = (p) => p.includes('__pycache__') || path.basename(p) === '.venv';
  fs.cpSync(src, dir, { recursive: true, filter: (p) => !skip(p) });
  const harden = (p) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return;
    fs.chmodSync(p, st.isDirectory() ? 0o755 : 0o644);
    if (st.isDirectory()) for (const e of fs.readdirSync(p)) harden(path.join(p, e));
  };
  harden(dir);
  return dir;
}

module.exports = { scratch, hardenedCopy };
