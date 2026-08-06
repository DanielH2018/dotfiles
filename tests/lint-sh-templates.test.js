// bin/lint-sh-templates renders each *.sh.tmpl through chezmoi and shellchecks the result,
// because the templates cannot be linted in place (Go template syntax is a shell parse
// error). The behaviours worth pinning are the ones that decide whether a green run means
// anything: a template that renders to nothing must be REPORTED as unchecked rather than
// counted as clean, and a missing tool must announce itself for the same reason.
//
// The script reads each template from stdin, so fixtures can live in a temp dir — they do
// not have to be added to the chezmoi source tree to be linted.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'bin', 'lint-sh-templates');

const have = (tool) => spawnSync('command', ['-v', tool], { shell: true }).status === 0;
const skipUnlessTooling = have('chezmoi') && have('shellcheck')
  ? false
  : 'needs chezmoi and shellcheck on PATH';

function run(args, env) {
  return spawnSync('bash', [SCRIPT, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const dirs = [];
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function fixture(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-sh-tmpl-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

test('a clean template passes and is counted as checked', { skip: skipUnlessTooling }, () => {
  const f = fixture('clean.sh.tmpl', '#!/bin/sh\nset -eu\nprintf \'%s\\n\' "hello"\n');
  const r = run([f]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 checked, 0 skipped/);
});

test('a template with a shellcheck finding fails and names the file', { skip: skipUnlessTooling }, () => {
  // Unquoted expansion in a test bracket — SC2086, enough to make shellcheck exit non-zero.
  const f = fixture('dirty.sh.tmpl', '#!/bin/sh\nx=$1\nif [ $x = 1 ]; then echo hi; fi\n');
  const r = run([f]);
  assert.strictEqual(r.status, 1, 'a finding must fail the gate');
  assert.match(r.stdout, /dirty\.sh\.tmpl: shellcheck findings/);
  // The line numbers belong to the rendered script, not the template; say so rather than
  // letting a reader chase a line that does not line up in their editor.
  assert.match(r.stdout, /line numbers refer to the rendered script/);
});

test('a template that renders empty is reported, not silently passed', { skip: skipUnlessTooling }, () => {
  // The WSL/Windows scripts do exactly this on Linux. Counting them as clean would repeat
  // the failure auto-format.sh documents for its absent prettier: a skip that reads as a pass.
  const f = fixture('other-os.sh.tmpl', '{{ if eq .chezmoi.os "plan9" -}}\n#!/bin/sh\necho hi\n{{- end -}}\n');
  const r = run([f]);
  assert.strictEqual(r.status, 0, 'an inapplicable branch is not a failure');
  assert.match(r.stdout, /rendered empty on this host .* NOT checked/);
  assert.match(r.stdout, /0 checked, 1 skipped/);
});

test('a template that does not render fails loudly', { skip: skipUnlessTooling }, () => {
  const f = fixture('broken.sh.tmpl', '{{ this is not a valid template\n');
  const r = run([f]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /broken\.sh\.tmpl: template did not render/);
});

test('a missing tool announces the skip instead of reporting success quietly', () => {
  // A PATH holding git and nothing else: the script needs git to find the repo root, and
  // the point is to remove chezmoi/shellcheck specifically rather than to break the script.
  // (Emptying PATH outright would take bash and git with it and prove nothing.)
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-sh-nopath-'));
  dirs.push(fakeBin);
  const gitPath = spawnSync('command', ['-v', 'git'], { shell: true, encoding: 'utf8' }).stdout.trim();
  fs.symlinkSync(gitPath, path.join(fakeBin, 'git'));

  // The gate still exits 0 — a machine without chezmoi should not be blocked from pushing —
  // but it must say the templates went unchecked, which is the whole distinction between
  // degrading and lying.
  const r = spawnSync('/bin/bash', [SCRIPT], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, PATH: fakeBin },
  });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /not installed, skipped \(templates NOT checked\)/);
});

test('it passes --source so a worktree lints its own fragments', () => {
  // includeTemplate resolves against chezmoi's CONFIGURED source dir (the primary checkout),
  // not the working directory. Without --source, a run inside .claude/worktrees/* renders
  // this branch's scripts against main's fragments and never checks an edit to one.
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(text, /chezmoi execute-template --source "\$ROOT"/);
});

test('every tracked shell template is reachable by the prek hook that runs this', () => {
  const config = fs.readFileSync(path.join(REPO, '.pre-commit-config.yaml'), 'utf8');
  assert.match(config, /entry: bin\/lint-sh-templates/);
  assert.match(config, /files: \\\.sh\\\.tmpl\$/);
});
