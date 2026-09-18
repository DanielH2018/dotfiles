// Regression guard for gen-install.js — the builder that flattens
// claude-audit-portable/pkg/ into a single self-installing install.sh.
// gen-install.js always writes to path.join(__dirname, "install.sh") (no output-dir
// arg), so to avoid clobbering the real checked-in install.sh this copies the whole
// gen-install.js + pkg/ pair into a scratch dir and runs the COPY from there.
// Offline. Skips cleanly if node is unavailable (it always is here, but match convention).
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const SRC_DIR = srcPath('private_dot_claude', 'vault-tooling', 'claude-audit-portable');

const skip = skipUnless('node');

const FILES = [
  '.claude/hooks/log-permission.js',
  '.claude/hooks/log-permission.test.js',
  '.claude/scripts/audit-permissions.js',
  '.claude/scripts/audit-permissions.test.js',
  '.claude/skills/audit-permissions/SKILL.md',
  '.claude/skills/audit-permissions/README.md',
];
const DELIM = '__CLAUDE_AUDIT_PKG_EOF__';

function scratchCopy() {
  const d = scratch(os.tmpdir(), 'gen-install-');
  fs.cpSync(SRC_DIR, d, { recursive: true });
  return d;
}

test('generated install.sh embeds every pkg file verbatim, is self-installing and executable', { skip }, () => {
  const dir = scratchCopy();
  const out = execFileSync('node', ['gen-install.js'], { cwd: dir, encoding: 'utf8' });
  assert.match(out, /Wrote .*install\.sh/);

  const installPath = path.join(dir, 'install.sh');
  const sh = fs.readFileSync(installPath, 'utf8');

  // Executable + shebang + usage contract.
  assert.strictEqual(fs.statSync(installPath).mode & 0o111, 0o111, 'install.sh must be executable');
  assert.match(sh, /^#!\/usr\/bin\/env bash\n/);
  assert.match(sh, /TARGET="\$\{1:-\.\}"/);

  // Every FILES entry is embedded byte-for-byte inside a write() heredoc.
  for (const rel of FILES) {
    const body = fs.readFileSync(path.join(dir, 'pkg', rel), 'utf8');
    const normalized = body.endsWith('\n') ? body : body + '\n';
    assert.ok(sh.includes(`write "${rel}" <<'${DELIM}'\n${normalized}${DELIM}`),
      `install.sh must embed ${rel} verbatim in a write() heredoc`);
  }

  // settings.json: never clobber an existing one — both branches present.
  assert.match(sh, /if \[ -f "\$SETTINGS" \]; then/);
  assert.match(sh, /EXISTING settings\.json left untouched/);
  assert.match(sh, /wrote \.claude\/settings\.json/);
  const settingsBody = fs.readFileSync(path.join(dir, 'pkg', '.claude', 'settings.json'), 'utf8');
  assert.ok(sh.includes(settingsBody.endsWith('\n') ? settingsBody : settingsBody + '\n'),
    'install.sh must embed settings.json verbatim');

  // .gitignore append guard (only adds logs/ once).
  assert.match(sh, /if ! grep -qs '\^logs\/' "\$GI" 2>\/dev\/null; then/);

  // Self-test + next-steps guidance runs only when node is on PATH.
  assert.match(sh, /if command -v node >\/dev\/null 2>&1; then/);
  assert.match(sh, /log-permission\.test\.js/);
  assert.match(sh, /audit-permissions\.test\.js/);
});

test('a delimiter collision in a pkg file aborts the build instead of emitting a corrupt install.sh', { skip }, () => {
  const dir = scratchCopy();
  const installPath = path.join(dir, 'install.sh');
  const before = fs.readFileSync(installPath, 'utf8'); // pre-existing, checked-in install.sh
  const poisoned = path.join(dir, 'pkg', '.claude', 'hooks', 'log-permission.js');
  fs.writeFileSync(poisoned, `// contains the delimiter\n${DELIM}\n`);
  assert.throws(() => {
    execFileSync('node', ['gen-install.js'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }, (err) => {
    assert.match(err.stderr.toString(), /delimiter collision/);
    return true;
  });
  assert.strictEqual(fs.readFileSync(installPath, 'utf8'), before,
    'a failed build must not overwrite the prior install.sh');
});

