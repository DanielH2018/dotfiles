// The lint gates only gate files they can SEE, and twice now they have silently
// stopped seeing one.
//
// Both hooks classify by `types`/`types_or`, which identifies a file by extension
// or — failing that — by shebang, and only when the file is executable. So an
// extensionless script drops out of its gate the moment it loses the +x bit in
// git. Nothing announces it: chezmoi's executable_ prefix sets the DEPLOYED mode,
// so a 100644 source still lands as 0755 in ~/.local/bin and the script runs fine.
//
// executable_jsonq sat at 100644 and was never ruff-checked. executable_claude-sandbox
// and 14 other shell scripts were invisible to shellcheck the same way — which is how
// a malformed `shellcheck` directive reached main in #179 with a green gate.
//
// These assert the two conditions a gate needs, so the next script to lose one fails
// here instead of quietly going unlinted.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

let entries;
try {
  entries = execFileSync('git', ['ls-files', '-s'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split('\t');
      return { mode: meta.split(' ')[0], file };
    });
} catch {
  entries = null;
}
const skip = entries ? false : 'git ls-files unavailable';

const SHELL = /^#!.*\b(bash|zsh|ksh|dash|sh)\b/;
const PYTHON = /^#!.*\bpython[0-9.]*\b/;

// Extensionless tracked files, tagged by the shebang they carry. A basename with a
// dot is left alone: those are classified by extension and the +x bit is irrelevant.
function scripts() {
  const out = [];
  for (const { mode, file } of entries) {
    if (path.basename(file).includes('.')) continue;
    let first = '';
    try {
      const fd = fs.openSync(path.join(ROOT, file), 'r');
      const buf = Buffer.alloc(200);
      const n = fs.readSync(fd, buf, 0, 200, 0);
      fs.closeSync(fd);
      first = buf.subarray(0, n).toString('utf8').split('\n')[0];
    } catch {
      continue;
    }
    if (SHELL.test(first)) out.push({ mode, file, kind: 'shell' });
    else if (PYTHON.test(first)) out.push({ mode, file, kind: 'python' });
  }
  return out;
}

test('every extensionless script is executable in git, or its linter cannot see it',
  { skip }, () => {
    const found = scripts();
    assert.ok(found.length > 10, `expected to find the repo's scripts, saw ${found.length}`);
    const unreadable = found.filter((s) => s.mode !== '100755');
    assert.deepStrictEqual(unreadable.map((s) => s.file), [],
      'these carry a shebang but are not executable in git, so shellcheck/ruff skip '
      + 'them entirely. Fix with: git update-index --chmod=+x <file>');
  });

// ruff additionally narrows by path, so +x alone is not enough for Python: `files:`
// and `types_or:` are ANDed. A new extensionless Python script needs both.
//
// Empty, and worth keeping that way. It once held otelq, streamdeck-usb-reset and
// wl-bmp2png, which were carrying 25 findings between them at the point the gate
// first saw them. Deleting a name from this list is the last step of fixing one;
// adding one is how coverage is lost, so do not.
const RUFF_BACKLOG = [];

test('no extensionless Python script falls outside the ruff hook unnoticed',
  { skip }, () => {
    const cfg = fs.readFileSync(path.join(ROOT, '.pre-commit-config.yaml'), 'utf8');
    const line = cfg.match(/^\s*files: (\(.*\))$/m);
    assert.ok(line, 'could not find the ruff hook\'s files: pattern');
    const re = new RegExp(line[1]);
    const missing = scripts()
      .filter((s) => s.kind === 'python' && !re.test(s.file))
      .map((s) => s.file);
    assert.deepStrictEqual(missing, RUFF_BACKLOG,
      'the set of Python scripts outside the ruff hook\'s files: pattern changed. A new '
      + 'entry is never linted — add it to the alternation in .pre-commit-config.yaml. '
      + 'A cleared entry means the backlog above needs the same name removed.');
  });
