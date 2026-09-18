const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');

// When these tests run inside a git hook (e.g. the repo's pre-push), git exports GIT_DIR,
// GIT_WORK_TREE, GIT_INDEX_FILE, etc. into the environment. The temp-repo `git -C <dir>` calls
// and the hooks invoked below would then act on the outer repo instead of each test's fixture
// (e.g. `git add a.txt` fails: "pathspec 'a.txt' did not match any files"). Strip them so every
// git subprocess discovers its own repository.
for (const v of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX', 'GIT_NAMESPACE']) {
  delete process.env[v];
}

// Same leakage risk from the host's own exported CLAUDE_VAULT_DIR: runHook()
// spreads process.env into the child, so a "no vault configured" fixture
// would otherwise still see the real vault.
delete process.env.CLAUDE_VAULT_DIR;

const HOOKS = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks');
const AUTO_FORMAT = path.join(HOOKS, 'executable_auto-format.sh');
const CHECK_STOP = path.join(HOOKS, 'executable_check-before-stop.sh');
const WATCH = path.join(HOOKS, 'executable_watch-paths.sh');

// Claude passes file paths and CLAUDE_VAULT_DIR to hooks with forward slashes, even on
// Windows (Git Bash). Feed the hooks forward-slash paths so the tests mirror reality and
// the hooks' `"$CLAUDE_VAULT_DIR"/*` globs match; on macOS/Linux this is a no-op.
const fwd = (p) => p.replace(/\\/g, '/');

function writeLocalEnv(home, vaultDir) {
  const dir = path.join(home, '.config', 'claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'local.env'), `CLAUDE_VAULT_DIR=${JSON.stringify(fwd(vaultDir))}\n`);
}
function runHook(hook, { input = '', home, cwd, extraPath } = {}) {
  const env = { ...process.env, HOME: fwd(home) };
  if (extraPath) env.PATH = extraPath + ':' + process.env.PATH;
  try {
    const stdout = execFileSync('bash', [hook], { input, env, cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { stdout, status: 0 };
  } catch (e) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', status: e.status };
  }
}

test('auto-format.sh: vault markdown skipped, non-vault markdown formatted', () => {
  const home = scratch(os.tmpdir(), 'hookhome-');
  const vault = path.join(home, 'Vault');
  fs.mkdirSync(vault, { recursive: true });
  writeLocalEnv(home, vault);
  const bin = scratch(os.tmpdir(), 'bin-');
  const marker = path.join(bin, 'called.log');
  fs.writeFileSync(path.join(bin, 'prettier'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(fwd(marker))}\n`, { mode: 0o755 });

  const vfile = path.join(vault, 'note.md');
  fs.writeFileSync(vfile, '# x');
  runHook(AUTO_FORMAT, { input: JSON.stringify({ tool_input: { file_path: fwd(vfile) } }), home, extraPath: bin });
  assert.ok(!fs.existsSync(marker), 'vault markdown must NOT be formatted');

  const ofile = path.join(home, 'other.md');
  fs.writeFileSync(ofile, '# y');
  runHook(AUTO_FORMAT, { input: JSON.stringify({ tool_input: { file_path: fwd(ofile) } }), home, extraPath: bin });
  assert.ok(fs.existsSync(marker), 'non-vault markdown must be formatted');
});

test('check-before-stop.sh: protected-branch block, vault exemption, dead paths removed', () => {
  const home = scratch(os.tmpdir(), 'hookhome-');
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one'); git('add', 'a.txt'); git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two'); git('add', 'a.txt');           // stage change on main
  const top = git('rev-parse', '--show-toplevel').trim();                            // realpath (macOS /tmp symlink)

  const r1 = runHook(CHECK_STOP, { input: '{}', home, cwd: repo });
  assert.match(r1.stdout, /"decision":\s*"block"/, 'staged changes on main must block');

  writeLocalEnv(home, top);
  const r2 = runHook(CHECK_STOP, { input: '{}', home, cwd: repo });
  assert.doesNotMatch(r2.stdout, /"decision":\s*"block"/, 'vault repo is exempt');
  assert.strictEqual(r2.status, 0);

  const src = fs.readFileSync(CHECK_STOP, 'utf8');
  assert.ok(!src.includes('.dotfiles'), 'retired ~/.dotfiles logic removed');
  assert.ok(!/My_Vault/.test(src), 'hardcoded My_Vault removed');
});

test('watch-paths.sh: vault raw/ watched only when configured', () => {
  const home = scratch(os.tmpdir(), 'hookhome-');
  const vault = path.join(home, 'Vault');
  fs.mkdirSync(path.join(vault, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'rules'), { recursive: true });
  writeLocalEnv(home, vault);
  const r1 = runHook(WATCH, { input: JSON.stringify({ source: 'startup' }), home });
  const w1 = JSON.parse(r1.stdout).hookSpecificOutput.watchPaths;
  assert.ok(w1.includes(fwd(path.join(vault, 'raw'))), 'vault raw/ watched when configured');
  assert.ok(w1.includes(fwd(path.join(home, '.claude', 'rules'))), 'rules dir always watched');

  const home2 = scratch(os.tmpdir(), 'hookhome-');
  fs.mkdirSync(path.join(home2, '.claude', 'rules'), { recursive: true });
  const r2 = runHook(WATCH, { input: JSON.stringify({ source: 'startup' }), home: home2 });
  const w2 = JSON.parse(r2.stdout).hookSpecificOutput.watchPaths;
  assert.deepStrictEqual(w2, [fwd(path.join(home2, '.claude', 'rules'))], 'no vault -> only rules dir');

  const r3 = runHook(WATCH, { input: JSON.stringify({ source: 'resume' }), home });
  assert.strictEqual(r3.stdout.trim(), '', 'non-startup source produces no output');
});

