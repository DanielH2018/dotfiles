const { test, before, after } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderTemplate, renderFile } = require('./lib/render');

// modify_settings.json.sh.tmpl is a chezmoi modify_ script written as a template. Render it
// with `chezmoi execute-template` (resolves `includeTemplate "settings.base.json"` and
// `.chezmoi.sourceDir`), then exec the rendered /bin/sh script. The script regenerates
// ~/.claude/settings.json as merge(general base, work overlay-if-present), FULLY DERIVED —
// stdin (the current target content) is intentionally ignored.
const TEMPLATE = path.join(__dirname, '..', 'home', 'private_dot_claude', 'modify_settings.json.sh.tmpl');

// This test renders a chezmoi template via `includeTemplate`; skip cleanly where
// chezmoi can't render THIS repo — the binary is absent, or its configured source
// dir isn't this repo (e.g. a sandbox pointing at an empty default source dir).
//
// `.chezmoi.sourceDir` is whatever chezmoi is configured with, which is the primary
// checkout — never a worktree. The rendered script therefore invokes the PRIMARY
// checkout's claude-settings-merge, not this tree's. Run from a worktree, this suite
// used to render the worktree's template against the primary checkout's binary and
// report the result as if it had tested the worktree: false green, or a false red like
// the one that surfaced this. Require the resolved source dir to be this tree's `home/`
// and skip otherwise, so a worktree gets no signal rather than wrong signal.
const REPO_SOURCE_DIR = path.join(__dirname, '..', 'home');
function chezmoiCanRenderRepo() {
  try {
    const srcDir = renderTemplate('{{ .chezmoi.sourceDir }}', { source: null }).trim();
    if (!srcDir || !fs.existsSync(path.join(srcDir, '.chezmoitemplates', 'settings.base.json'))) return false;
    return fs.realpathSync(srcDir) === fs.realpathSync(REPO_SOURCE_DIR);
  } catch { return false; }
}
const skip = chezmoiCanRenderRepo() ? false : 'chezmoi cannot render this repo\'s templates';

let tmp, script, run;
before(() => {
  if (skip) return;
  const rendered = renderFile(TEMPLATE, { source: null });

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modset-'));
  script = path.join(tmp, 'modify_settings.sh');
  fs.writeFileSync(script, rendered, { mode: 0o755 });
  // Run via bash (not the .sh directly): Windows can't exec a .sh (EFTYPE); bash handles both.
  run = (input) => execFileSync('bash', [script], { input, encoding: 'utf8' });
});
after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// 1. Output is valid JSON carrying the base structure (the base always defines permissions).
test('output is valid JSON carrying the base structure', { skip }, () => {
  const out = JSON.parse(run(''));
  assert.ok(out.permissions && typeof out.permissions === 'object', 'output has a permissions object');
});

// 2. Derived except for the runtime-owned key allowlist. stdin is the current target content;
//    it is read ONLY for keys the running harness writes back (effortLevel, via `/effort`).
//    Everything else in it — above all permission rules — must not survive a re-derive, or a
//    hand-edited deployed file would promote itself to policy on the next apply.
test('stdin is ignored except for runtime-owned keys', { skip }, () => {
  const withJunk = run(JSON.stringify({
    model: 'sonnet',
    __stdin_only_key__: true,
    permissions: { allow: ['Bash(STDIN-INJECTED:*)'] },
  }));
  assert.strictEqual(withJunk, run(''), 'output is independent of non-runtime stdin keys');
  assert.ok(!withJunk.includes('__stdin_only_key__'), 'stdin content is not merged into the output');
  assert.ok(!withJunk.includes('STDIN-INJECTED'), 'a stdin permission rule never reaches the output');
});

// The regression this slice exists for: `/effort` writes effortLevel into the deployed file,
// no template sets it, so every `chezmoi apply` silently dropped the pin mid-session.
test('a runtime-owned key in stdin survives the re-derive', { skip }, () => {
  const out = JSON.parse(run(JSON.stringify({ effortLevel: 'xhigh' })));
  assert.strictEqual(out.effortLevel, 'xhigh', 'effortLevel must survive an apply');
  assert.ok(!('effortLevel' in JSON.parse(run(''))), 'and stays absent when nothing set it');
});

// 3. Idempotent: feeding the output back in yields identical output.
test('modify script is idempotent', { skip }, () => {
  const once = run('');
  assert.strictEqual(run(once), once, 'modify script is idempotent');
});

// 4. fnm fallback (Unix-only: hardcoded ~/.local/share/fnm alias path, a /bin/sh node shim,
//    and a POSIX ':'-joined restricted PATH). Skipped on Windows.
test('fnm fallback', { skip }, () => {
  if (process.platform !== 'win32') {
    const fnmHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fnmhome-'));
    const fnmDefaultBin = path.join(fnmHome, '.local', 'share', 'fnm', 'aliases', 'default', 'bin');
    fs.mkdirSync(fnmDefaultBin, { recursive: true });
    fs.writeFileSync(
      path.join(fnmDefaultBin, 'node'),
      `#!/bin/sh\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 },
    );
    // Minimal PATH: the coreutils the script needs, but deliberately no `node`.
    const toolbin = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbin-'));
    for (const tool of ['cat', 'mktemp', 'rm']) {
      const p = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
      if (p) fs.symlinkSync(p, path.join(toolbin, tool));
    }
    const outFnm = execFileSync(script, [], {
      input: '',
      encoding: 'utf8',
      env: { HOME: fnmHome, PATH: toolbin },
    });
    assert.ok(JSON.parse(outFnm).permissions, 'fnm-fallback output carries the base permissions');
    fs.rmSync(fnmHome, { recursive: true, force: true });
    fs.rmSync(toolbin, { recursive: true, force: true });
  }
});

// 5. log-permission.js is fully removed. It logged permission decisions until the
//    permission-audit plugin took over, and the plugin until Claude Code's own OTEL
//    tool_decision events did. The hooks block remains; no merged setting references
//    the retired script.
test('log-permission.js is fully removed', { skip }, () => {
  const base = JSON.parse(run(''));
  assert.ok(base.hooks && typeof base.hooks === 'object', 'hooks block is present');
  assert.ok(!JSON.stringify(base).includes('log-permission'), 'no log-permission.js reference remains');
});
