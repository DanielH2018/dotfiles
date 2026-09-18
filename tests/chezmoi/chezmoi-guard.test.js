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
const { scratch } = require('../lib/tmp');

const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_chezmoi-guard.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const HOME = scratch(os.tmpdir(), 'czg-home-');
const BIN = scratch(os.tmpdir(), 'czg-bin-');
// Stub chezmoi: source-path maps by filename; add/chattr succeed; everything else no-ops.
// `managed` has to be modelled too, and it is not decoration: the hook consults a cached
// copy of that list before it will call source-path at all, so a stub that answered it with
// silence (as `*)` did) reported "nothing is managed" and skipped every case below.
// CALLS records invocations so the cache tests can distinguish a hit from a miss.
const CALLS = path.join(BIN, 'calls.log');
fs.writeFileSync(path.join(BIN, 'chezmoi'), `#!/bin/bash
echo "$1" >> ${JSON.stringify(CALLS)}
case "$1" in
  managed) printf '%s\\n' "$HOME/tmplfile" "$HOME/plainfile" ;;
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

const callCount = (verb) => (fs.existsSync(CALLS)
  ? fs.readFileSync(CALLS, 'utf8').split('\n').filter((l) => l === verb).length
  : 0);
const resetCalls = () => { try { fs.rmSync(CALLS); } catch { /* not created yet */ } };
const clearCache = () => {
  try { fs.rmSync(path.join(HOME, '.cache', 'claude-hooks'), { recursive: true, force: true }); } catch { /* fine */ }
};

function context(file_path, extraEnv = {}) {
  let out;
  try {
    out = execFileSync('bash', [HOOK], {
      input: JSON.stringify({ tool_input: { file_path } }),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env, HOME, PATH: `${BIN}:${process.env.PATH}`,
        XDG_CACHE_HOME: path.join(HOME, '.cache'), ...extraEnv,
      },
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

// ---- the managed-list cache -----------------------------------------------------------
//
// Starting chezmoi costs ~41ms and this hook runs after every Edit and Write, so a cached
// copy of `chezmoi managed` answers the common case (a file chezmoi has never managed)
// without launching it. The cache is only ever allowed to make the hook do LESS work on
// unmanaged files. If it can make the hook skip a MANAGED one, the source silently drifts
// and a later `chezmoi apply` reverts a real edit — so both directions are pinned here.

test('an unmanaged file costs one managed lookup, not one per call', { skip }, () => {
  clearCache(); resetCalls();
  const f = path.join(HOME, 'unmanaged.txt');
  assert.strictEqual(context(f), null);
  assert.strictEqual(context(f), null);
  assert.strictEqual(context(f), null);
  assert.strictEqual(callCount('source-path'), 0, 'the cache should answer without calling source-path');
  assert.strictEqual(callCount('managed'), 1, 'the list should be fetched once, then reused');
});

test('a cached managed file is still resolved for real', { skip }, () => {
  clearCache(); resetCalls();
  assert.match(context(path.join(HOME, 'plainfile')), /re-synced/i);
  const cached = context(path.join(HOME, 'plainfile'));
  assert.match(cached, /re-synced/i, 'a warm cache must not turn a managed file into a skip');
  assert.strictEqual(callCount('source-path'), 2, 'presence in the cache defers to chezmoi, never replaces it');
});

test('a failing managed lookup falls back to asking chezmoi directly', { skip }, () => {
  clearCache(); resetCalls();
  const good = fs.readFileSync(path.join(BIN, 'chezmoi'), 'utf8');
  fs.writeFileSync(path.join(BIN, 'chezmoi'), good.replace(
    'managed) printf', 'managed) exit 1 ;;\n  never) printf'), { mode: 0o755 });
  try {
    assert.match(context(path.join(HOME, 'tmplfile')), /template|update the chezmoi source/i);
  } finally {
    fs.writeFileSync(path.join(BIN, 'chezmoi'), good, { mode: 0o755 });
  }
});

test('CHEZMOI_GUARD_CACHE_TTL=0 turns the cache off', { skip }, () => {
  clearCache(); resetCalls();
  const f = path.join(HOME, 'unmanaged.txt');
  context(f, { CHEZMOI_GUARD_CACHE_TTL: '0' });
  context(f, { CHEZMOI_GUARD_CACHE_TTL: '0' });
  assert.strictEqual(callCount('managed'), 0, 'no list is fetched when the cache is disabled');
  assert.strictEqual(callCount('source-path'), 2, 'every call goes straight to chezmoi');
});
