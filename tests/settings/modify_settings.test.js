const { test, before } = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderFile, chezmoiAvailable } = require('../lib/render');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

// modify_settings.json.sh.tmpl is a chezmoi modify_ script written as a template. Render it
// with `chezmoi execute-template` (resolves `includeTemplate "settings.base.json"` and
// `.chezmoi.sourceDir`), then exec the rendered /bin/sh script. The script regenerates
// ~/.claude/settings.json as merge(general base, work overlay-if-present), FULLY DERIVED —
// stdin (the current target content) is intentionally ignored.
const TEMPLATE = srcPath('private_dot_claude', 'modify_settings.json.sh.tmpl');

// Render with `--source` set to this tree's `home/` (renderTemplate's default), so
// `.chezmoi.sourceDir` is this tree and the rendered script invokes THIS tree's
// claude-settings-merge. This suite used to render with chezmoi's configured source dir,
// which is always the primary checkout, and skip wherever that was not this tree. That
// covered CI and every worktree, so da3a452c broke a test here and nothing turned red for
// a month (#1057). Skip only where chezmoi is not installed.
const skip = chezmoiAvailable ? false : 'chezmoi not installed';

// The rendered script refuses to run when the settings templates are uncommitted. That
// guard protects `chezmoi apply`; here it would fail every test exactly while the
// templates are being edited, so the suite opts out of it.
const env = { ...process.env, CLAUDE_SETTINGS_ALLOW_DIRTY: '1' };

let tmp, script, run;
before(() => {
  if (skip) return;
  const rendered = renderFile(TEMPLATE);

  tmp = scratch(os.tmpdir(), 'modset-');
  script = path.join(tmp, 'modify_settings.sh');
  fs.writeFileSync(script, rendered, { mode: 0o755 });
  // Run via bash (not the .sh directly): Windows can't exec a .sh (EFTYPE); bash handles both.
  run = (input) => execFileSync('bash', [script], { input, encoding: 'utf8', env });
});

// The rendered script must call this tree's merge binary, not the primary checkout's.
// Rendering with chezmoi's configured source dir would point it there.
test('the rendered script runs this tree\'s claude-settings-merge', { skip }, () => {
  const rendered = fs.readFileSync(script, 'utf8').match(/^MERGE="(.*)"$/m);
  assert.ok(rendered, 'rendered script has no MERGE= line');
  // realpath both sides: chezmoi may resolve a symlinked checkout path (macOS /tmp).
  const merge = srcPath('dot_local', 'bin', 'executable_claude-settings-merge');
  assert.strictEqual(fs.realpathSync(rendered[1]), fs.realpathSync(merge));
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
// and every `chezmoi apply` silently replaced it mid-session. Since da3a452c (2026-09-24)
// settings.base.json pins effortLevel, and a template pin beats the deployed value by design;
// claude-settings-merge.test.js covers the unpinned carry-forward on the merge itself. What
// this end-to-end test can still prove is the wiring: stdin reaches the merge, which reports
// the value it replaced. That warning is the only way a reverted /effort is visible (#1055).
test('a deployed effortLevel in stdin reaches the merge, and the template pin wins', { skip }, () => {
  const pin = JSON.parse(run('')).effortLevel;
  assert.ok(pin !== undefined,
    'settings.base.json no longer pins effortLevel: assert the carry-forward here instead');
  const deployed = pin === 'low' ? 'high' : 'low';
  const r = spawnSync('bash', [script], { input: JSON.stringify({ effortLevel: deployed }), encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).effortLevel, pin, 'the template pin wins over the deployed value');
  assert.ok(r.stderr.includes(`replacing deployed ${JSON.stringify(deployed)}`), r.stderr);
});

// 3. Idempotent: feeding the output back in yields identical output.
test('modify script is idempotent', { skip }, () => {
  const once = run('');
  assert.strictEqual(run(once), once, 'modify script is idempotent');
});

// 4. fnm fallback (Unix-only: hardcoded ~/.local/share/fnm alias path, a /bin/sh node shim,
//    and a POSIX ':'-joined restricted PATH). Skipped on Windows.
test('fnm fallback', { skip }, (t) => {
  if (process.platform !== 'win32') {
    const fnmHome = scratch(os.tmpdir(), 'fnmhome-', t);
    const fnmDefaultBin = path.join(fnmHome, '.local', 'share', 'fnm', 'aliases', 'default', 'bin');
    fs.mkdirSync(fnmDefaultBin, { recursive: true });
    fs.writeFileSync(
      path.join(fnmDefaultBin, 'node'),
      `#!/bin/sh\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 },
    );
    // Minimal PATH: the coreutils the script needs, but deliberately no `node`.
    const toolbin = scratch(os.tmpdir(), 'toolbin-', t);
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
