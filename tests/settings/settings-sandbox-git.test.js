// Render checks for the git-dir entries in settings.base.json's sandbox block.
//
// allowWrite opens the .git directory of each repo under ~/Repositories so a sandboxed session
// can commit in a repo it was not started in. denyWrite then closes everything inside those
// dirs that git executes or reads as config. The two only make sense together: the first
// without the second lets a sandboxed process plant .git/hooks/pre-commit, which git runs
// outside the sandbox. These tests pin both halves and the shape of the deny patterns.
//
// The sandbox block is darwin-only and CI runs on Linux, so the gate is replaced by a literal,
// as tests/ssh-config-template.test.js does. HOME points at a fixture tree, because the
// allowWrite list is enumerated from $HOME/Repositories when the template renders.
//
// The deny patterns are matched here the way Claude Code 2.1.282 compiles them for Seatbelt:
// `**` spans directories, `*` stays inside one segment, and a match also covers everything
// beneath the matched path. The anchoring was measured, not assumed: an unanchored
// `**/.git/hooks` deny let every probe write through, and `/**/.git/config*` blocked
// `git init` in $TMPDIR.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { renderTemplate, chezmoiAvailable } = require('../lib/render');
const { srcPath } = require('../lib/paths');

const TMPL = srcPath('.chezmoitemplates', 'settings.base.json');
const skip = chezmoiAvailable ? false : 'chezmoi unavailable';

let home = null;
function fixtureHome() {
  if (home) return home;
  home = fs.realpathSync(scratch(os.tmpdir(), 'sandbox-git-home-'));
  const repos = path.join(home, 'Repositories');
  // A normal clone: .git is a directory.
  fs.mkdirSync(path.join(repos, 'plain', '.git'), { recursive: true });
  // A linked worktree checked out at the top level: .git is a `gitdir:` pointer file.
  fs.mkdirSync(path.join(repos, 'linked'), { recursive: true });
  fs.writeFileSync(path.join(repos, 'linked', '.git'), 'gitdir: /elsewhere/.git/worktrees/linked\n');
  // A .git symlinked to a directory elsewhere.
  fs.mkdirSync(path.join(home, 'elsewhere-git'));
  fs.mkdirSync(path.join(repos, 'symlinked'));
  fs.symlinkSync(path.join(home, 'elsewhere-git'), path.join(repos, 'symlinked', '.git'));
  return home;
}

let fsBlock = null;
function filesystem() {
  if (fsBlock) return fsBlock;
  // The exact gate text, not a bare `eq .chezmoi.os "darwin"`: an earlier block also tests
  // for darwin, and replace() rewrites only the first match, which on Linux left the sandbox
  // block rendering as `{ "enabled": false }`.
  const gate = 'if eq .chezmoi.os "darwin" }}';
  const tmpl = fs.readFileSync(TMPL, 'utf8');
  assert.strictEqual(tmpl.split(gate).length, 2, 'the sandbox gate text appears exactly once');
  const body = tmpl.replace(gate, 'if eq "darwin" "darwin" }}');
  const out = renderTemplate(body, { env: { ...process.env, HOME: fixtureHome() } });
  fsBlock = JSON.parse(out).sandbox.filesystem;
  return fsBlock;
}

function denies(target) {
  return filesystem().denyWrite.some((pattern) => {
    const abs = pattern.replace(/^~(?=\/)/, home);
    const re = abs
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*');
    return new RegExp(`^${re}(/.*)?$`).test(target);
  });
}

test('allowWrite lists a repo whose .git is a directory', { skip }, () => {
  assert.ok(filesystem().allowWrite.includes(path.join(home, 'Repositories', 'plain', '.git')));
});

test('allowWrite skips a .git pointer file and a symlinked .git', { skip }, () => {
  // A writable pointer file can be aimed at a planted git dir that carries its own hooks.
  const listed = filesystem().allowWrite.filter((p) => p.startsWith(path.join(home, 'Repositories')));
  assert.deepStrictEqual(listed, [path.join(home, 'Repositories', 'plain', '.git')]);
});

test('every deny pattern is anchored at a root', { skip }, () => {
  for (const p of filesystem().denyWrite) {
    assert.match(p, /^[~/]/, `unanchored patterns resolve against the settings scope and match nothing: ${p}`);
  }
});

test('hooks, config and the files git reads as config are denied in each writable git dir', { skip }, () => {
  const gitDirs = [
    path.join(home, 'Repositories', 'plain', '.git'),
    path.join(home, '.local', 'share', 'chezmoi', '.git'),
    path.join(home, 'work-laptop-config', '.git'),
  ];
  const targets = [
    'hooks/pre-commit',
    'hooks-safe/pre-push',
    'config',
    'config.lock',
    'config.worktree',
    'info/attributes',
    'worktrees/w/config.worktree',
    'worktrees/w/commondir',
    'modules/sub/config',
    'modules/sub/hooks/post-checkout',
    'modules/sub/info/attributes',
  ];
  for (const dir of gitDirs) {
    for (const t of targets) assert.ok(denies(path.join(dir, t)), `writable: ${path.join(dir, t)}`);
  }
});

test('refs, the index and objects stay writable, including refs named like a denied file', { skip }, () => {
  const g = path.join(home, 'Repositories', 'plain', '.git');
  const targets = [
    'index.lock',
    'refs/heads/config-x.lock',
    'refs/heads/feature/hooks',
    'refs/heads/feature/info/attributes',
    'logs/refs/heads/config-x',
    'worktrees/w/index.lock',
    'objects/ab/cdef',
  ];
  for (const t of targets) assert.ok(!denies(path.join(g, t)), `denied: ${t}`);
});

test('a scratch repo outside the listed roots can still be created', { skip }, () => {
  // `git init` writes .git/config and .git/hooks. A deny that reached $TMPDIR would break
  // every test suite here that builds a fixture repo.
  assert.ok(!denies(path.join(os.tmpdir(), 'fixture', '.git', 'config')));
  assert.ok(!denies(path.join(os.tmpdir(), 'fixture', '.git', 'hooks', 'pre-commit')));
});

test('writes under /tmp are allowed by its resolved path, /private/tmp', { skip }, () => {
  // /tmp is a symlink to /private/tmp and Seatbelt checks the resolved path, so a "/tmp"
  // entry alone left a sandboxed `touch /tmp/x` refused.
  const allow = filesystem().allowWrite;
  assert.ok(allow.includes('/private/tmp'), 'allowWrite lacks /private/tmp');
  assert.ok(allow.includes('/tmp'), 'allowWrite lacks /tmp');
});
