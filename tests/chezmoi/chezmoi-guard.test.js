// Regression guard for executable_chezmoi-guard.sh (PostToolUse/Edit|Write).
// Drives the ACTUAL hook with a STUB `chezmoi` on PATH so it's hermetic (no real
// chezmoi needed). Asserts: non-$HOME + unmanaged files are no-ops; a templated
// source warns "update the source"; a plain managed file re-syncs. Skips without bash/jq.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_chezmoi-guard.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'czg-home-'));
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'czg-bin-'));
// Stub chezmoi: source-path maps by filename; add/chattr succeed; everything else no-ops.
fs.writeFileSync(path.join(BIN, 'chezmoi'), `#!/bin/bash
case "$1" in
  source-path)
    case "$2" in
      *tmplfile*) echo "/fake/src/dot_config.tmpl" ;;
      *plainfile*) echo "/fake/src/dot_config" ;;
      *) exit 1 ;;
    esac ;;
  add) exit 0 ;;
  chattr) exit 0 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });

function context(file_path) {
  let out;
  try {
    out = execFileSync('bash', [HOOK], {
      input: JSON.stringify({ tool_input: { file_path } }),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME, PATH: `${BIN}:${process.env.PATH}` },
    });
  } catch (e) { out = e.stdout || ''; }
  if (!out.trim()) return null;
  try { return JSON.parse(out).hookSpecificOutput.additionalContext; } catch { return null; }
}

test('non-$HOME files are ignored', { skip }, () => {
  assert.strictEqual(context('/etc/hosts'), null);
});

test('unmanaged files under $HOME are ignored', { skip }, () => {
  assert.strictEqual(context(path.join(HOME, 'unmanaged.txt')), null);
});

test('a templated/scripted source warns to edit the source, not the render', { skip }, () => {
  const msg = context(path.join(HOME, 'tmplfile'));
  assert.match(msg, /template|update the chezmoi source/i);
});

test('a plain managed file is re-synced into the source', { skip }, () => {
  const msg = context(path.join(HOME, 'plainfile'));
  assert.match(msg, /re-synced/i);
});

process.on('exit', () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(BIN, { recursive: true, force: true });
});
