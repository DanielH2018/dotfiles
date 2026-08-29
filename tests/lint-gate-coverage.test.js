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
// `node` is the third dialect and was missing here, which left the oxlint hook — which
// narrows by path exactly the way ruff does — with no coverage assertion of its own. Its
// config comment states the rule in prose ("name it here AND git update-index --chmod=+x"),
// and prose is the thing this file exists to replace.
const NODE = /^#!.*\bnode\b/;

// The `files:` alternation belonging to one named hook.
//
// Selecting it by hook id rather than by "the first files: in the file". The previous
// spelling matched the first one anywhere in .pre-commit-config.yaml and happened to be
// right only because ruff-check was the first hook carrying one — an ordering dependency
// that nothing declared and that reordering or prepending a hook would silently break,
// leaving the assertion checking some other hook's pattern and still passing.
function filesPatternFor(cfg, id) {
  const start = cfg.indexOf(`- id: ${id}\n`);
  assert.ok(start !== -1, `no hook with id: ${id} in .pre-commit-config.yaml`);
  const rest = cfg.slice(start + 1);
  const end = rest.indexOf('- id: ');
  const block = end === -1 ? rest : rest.slice(0, end);
  const line = block.match(/^\s*files: (\(.*\))$/m);
  assert.ok(line, `hook ${id} has no files: pattern`);
  return new RegExp(line[1]);
}

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
    else if (NODE.test(first)) out.push({ mode, file, kind: 'node' });
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
    const re = filesPatternFor(cfg, 'ruff-check');
    const missing = scripts()
      .filter((s) => s.kind === 'python' && !re.test(s.file))
      .map((s) => s.file);
    assert.deepStrictEqual(missing, RUFF_BACKLOG,
      'the set of Python scripts outside the ruff hook\'s files: pattern changed. A new '
      + 'entry is never linted — add it to the alternation in .pre-commit-config.yaml. '
      + 'A cleared entry means the backlog above needs the same name removed.');
  });

// oxlint narrows by path the same way, and for the same reason: `files:` and `types_or:`
// are ANDed, and `types_or: [javascript]` cannot type an extensionless file by extension,
// so the shebang decides — and a shebang types a file only when it is executable. A new
// `#!/usr/bin/env node` script therefore needs BOTH the +x bit and a name in the
// alternation, exactly like a Python one.
//
// Empty, and to be kept that way for the same reason as RUFF_BACKLOG above: four of the
// five names now in that alternation sat at 100644 until the commit that added the hook.
const OXLINT_BACKLOG = [];

test('no extensionless node script falls outside the oxlint hook unnoticed',
  { skip }, () => {
    const cfg = fs.readFileSync(path.join(ROOT, '.pre-commit-config.yaml'), 'utf8');
    const re = filesPatternFor(cfg, 'oxlint');
    const found = scripts().filter((s) => s.kind === 'node');
    assert.ok(found.length > 0,
      'no extensionless node scripts found — the NODE shebang tag has stopped matching, '
      + 'which would make this assertion vacuous');
    const missing = found.filter((s) => !re.test(s.file)).map((s) => s.file);
    assert.deepStrictEqual(missing, OXLINT_BACKLOG,
      'the set of node scripts outside the oxlint hook\'s files: pattern changed. A new '
      + 'entry is never linted — add it to the alternation in .pre-commit-config.yaml.');
  });
