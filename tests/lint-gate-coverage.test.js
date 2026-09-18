// The lint gates only gate files they can SEE, and twice now they have silently
// stopped seeing one.
//
// The hooks classify by `types`/`types_or`, which identifies a file by extension
// or — failing that — by shebang, and only when the file is executable. So an
// extensionless script drops out of its gate the moment it loses the +x bit in
// git. Nothing announces it: chezmoi's executable_ prefix sets the DEPLOYED mode,
// so a 100644 source still lands as 0755 in ~/.local/bin and the script runs fine.
//
// executable_jsonq sat at 100644 and was never ruff-checked. executable_claude-sandbox
// and 14 other shell scripts were invisible to shellcheck the same way — which is how
// a malformed `shellcheck` directive reached main in #179 with a green gate.
//
// A gate needs two conditions of an extensionless script: a +x bit, and a name in the
// hook's `files:`. This file asserts the first. The second is no longer asserted here
// because it is no longer hand-maintained: bin/gen-lint-files renders every `files:`
// list from the same census, and tests/gen-lint-files.test.js runs its --check.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const lib = require('../bin/gen-lint-files-lib.js');

const ROOT = path.join(__dirname, '..');

let entries;
try {
  entries = execFileSync('git', ['ls-files', '-s'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split('\t');
      let first = '';
      if (!path.basename(file).includes('.')) {
        try {
          const fd = fs.openSync(path.join(ROOT, file), 'r');
          const buf = Buffer.alloc(200);
          const n = fs.readSync(fd, buf, 0, 200, 0);
          fs.closeSync(fd);
          first = buf.subarray(0, n).toString('utf8').split('\n')[0];
        } catch {
          first = '';
        }
      }
      return { mode: meta.split(' ')[0], file, firstLine: first };
    });
} catch {
  entries = null;
}
const skip = entries ? false : 'git ls-files unavailable';

test('every extensionless script is executable in git, or its linter cannot see it',
  { skip }, () => {
    const found = lib.census(entries);
    assert.ok(found.length > 10, `expected to find the repo's scripts, saw ${found.length}`);
    const unreadable = found.filter((s) => s.mode !== '100755');
    assert.deepStrictEqual(unreadable.map((s) => s.file), [],
      'these carry a shebang but are not executable in git, so shellcheck/ruff/oxlint skip '
      + 'them entirely. Fix with: git update-index --chmod=+x <file>');
  });
