// Guards the one property that makes home/.chezmoitemplates/linux-install.sh safe to exercise:
// its install destinations must stay *overridable* from the environment.
//
// This is not a hypothetical. The module used to open with `BIN_DIR="$HOME/.local/bin"` — a plain
// assignment — so sourcing it silently overwrote whatever a caller had exported. A test harness
// that believed it had sandboxed itself by exporting BIN_DIR/VER_DIR/APP_DIR at a throwaway
// directory installed its fixtures straight into the real ~/.local/bin instead, replacing the
// live `yazi` and `ya` binaries with 27-byte stubs and stamping bogus tags into .versions. The
// damage was invisible until someone ran the tools. Nothing failed; the harness reported success.
//
// The `: "${VAR:=default}"` form fixes that, but nothing stopped it regressing — hence this file.
//
// Every case below redirects HOME as well as the three overrides, which is load-bearing rather
// than belt-and-braces: if the module regresses to plain assignment it recomputes `$HOME/.local/bin`,
// so a test that pinned only the overrides would install into the tester's real home *while
// reporting a failure*. The guard would inflict the exact damage it exists to catch. With HOME
// pointed at the sandbox too, even a fully reverted module can only write inside the temp dir.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', 'home');
const LIB = path.join(SOURCE, '.chezmoitemplates', 'linux-install.sh');
const source = fs.readFileSync(LIB, 'utf8');

// Skip cleanly where chezmoi isn't installed (minimal CI / sandbox) rather than failing with a
// spurious spawn ENOENT. --source pins the render to THIS checkout; without it chezmoi resolves
// .chezmoitemplates from ~/.local/share/chezmoi and a branch would be tested against main's copy.
let toolsOk = true;
try { execFileSync('chezmoi', ['--version'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'chezmoi not on PATH';

let rendered;
const render = () =>
  (rendered ??= execFileSync('chezmoi', ['--source', SOURCE, 'execute-template'],
    { input: '{{ includeTemplate "linux-install.sh" . }}', encoding: 'utf8' }));

const dirs = [];
const sandbox = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-install-lib-'));
  dirs.push(d);
  return d;
};
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// Sources the rendered module under `env` and reports where it decided to install. sh, not bash:
// the module is inlined into `#!/bin/sh` scripts, so that is the interpreter that has to accept it.
const resolveDirs = (env) => {
  const out = execFileSync('sh', ['-c', `${render()}\nprintf '%s\\n%s\\n%s\\n' "$BIN_DIR" "$VER_DIR" "$APP_DIR"`], {
    encoding: 'utf8',
    // A deliberately minimal env: only PATH (the module probes for apt-get/dnf) plus what the
    // case under test sets. Anything inherited could mask a variable the module failed to honour.
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', 'pipe', 'ignore'], // the module narrates its package-manager choice on stderr
  });
  const [bin, ver, app] = out.trim().split('\n');
  return { bin, ver, app };
};

test('exported install destinations survive sourcing the module', { skip }, () => {
  const root = sandbox();
  const want = { BIN_DIR: `${root}/bin`, VER_DIR: `${root}/ver`, APP_DIR: `${root}/app` };
  const got = resolveDirs({ HOME: `${root}/home`, ...want });

  assert.strictEqual(got.bin, want.BIN_DIR, 'BIN_DIR was overwritten — a harness cannot sandbox this');
  assert.strictEqual(got.ver, want.VER_DIR, 'VER_DIR was overwritten — version stamps escape the sandbox');
  assert.strictEqual(got.app, want.APP_DIR, 'APP_DIR was overwritten — unpacked apps escape the sandbox');

  // Sourcing has a side effect: `mkdir -p "$BIN_DIR" "$VER_DIR"` runs at the top level, before any
  // helper is called. Asserting on the directories rather than only the variables is what proves
  // the override reached the code that writes, not just the code that reports.
  assert.ok(fs.existsSync(want.BIN_DIR), 'BIN_DIR should have been created inside the sandbox');
  assert.ok(fs.existsSync(want.VER_DIR), 'VER_DIR should have been created inside the sandbox');
  assert.ok(!fs.existsSync(`${root}/home/.local/bin`),
    'the module fell back to $HOME despite an explicit override — this is the regression that stubbed yazi/ya');
});

test('with no overrides at all, every destination stays under $HOME', { skip }, () => {
  // The other half of the contract, and the sandboxing route to recommend: a harness that
  // redirects HOME alone is fully contained, with no way to half-cover it by forgetting one var.
  const root = sandbox();
  const got = resolveDirs({ HOME: root });

  for (const [name, dir] of Object.entries(got)) {
    assert.ok(dir.startsWith(`${root}/`), `${name} resolved to ${dir}, outside the redirected HOME`);
  }
  assert.strictEqual(got.ver, `${got.bin}/.versions`, 'VER_DIR should follow BIN_DIR, not $HOME directly');
});

test('no install destination is set by plain assignment', { skip: false }, () => {
  // Catches what the behavioural cases above cannot: a *new* destination variable added later in
  // the plain form. Scoped to top-level assignments whose value mentions $HOME, since those are
  // exactly the ones that decide where the module writes on the live machine.
  const offenders = source
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /^[A-Z_]+=.*\$(HOME|\{HOME)/.test(line));

  assert.deepStrictEqual(offenders, [],
    'use `: "${VAR:=$HOME/...}"` so a caller can redirect it; plain assignment silently clobbers the caller');
});
