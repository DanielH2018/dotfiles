const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../home/dot_local/bin/executable_dotsync');
const { expandTilde, loadManifest, globToRegExp, matchesAnyGlob, deriveTargets, buildOwnership, computeCheck } = mod;

// dotsync is Unix-only tooling (POSIX path/glob handling + symlink farms; deployed to
// ~/.local/bin and used in the Unix restore/sync flow). It isn't run on Windows, where
// path.join yields backslashes that its forward-slash logic isn't meant to take. Skip there.
const skip = process.platform === 'win32' ? 'dotsync is Unix-only' : false;

let HOME, MAN, w, m, fakeRunner;
if (!skip) {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dshome-'));
  MAN = path.join(HOME, '.config', 'dotsync', 'manifest.d');
  fs.mkdirSync(MAN, { recursive: true });
  w = (name, obj) => fs.writeFileSync(path.join(MAN, name), JSON.stringify(obj));

  w('00-general.json', {
    repo: { name: 'general', type: 'chezmoi', path: '~/.local/share/chezmoi', remote: 'git@github.com:DanielH2018/dotfiles.git' },
    ignore: { globs: ['~/.claude/settings.json', '~/.cache/**'] },
  });
  w('50-work.json', {
    repo: { name: 'work', type: 'git-symlink', path: '~/work-laptop-config', remote: 'r', roots: ['.claude', '.config'] },
  });
  m = loadManifest(MAN, HOME);

  fakeRunner = (cmd, args) => {
    if (cmd === 'chezmoi' && args[0] === 'managed') return { code: 0, stdout: '.zshrc\n.config/git/config\n', stderr: '' };
    if (cmd === 'git' && args.includes('ls-files')) return { code: 0, stdout: '.claude/CLAUDE.local.md\n.config/zsh/local.zsh\nREADME.md\ninstall.sh\n', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected ' + cmd };
  };
}

test('expandTilde', { skip }, () => {
  assert.strictEqual(expandTilde('~/x', HOME), path.join(HOME, 'x'));
  assert.strictEqual(expandTilde('~', HOME), HOME);
  assert.strictEqual(expandTilde('/abs', HOME), '/abs');
});

test('loadManifest: lexical merge of repos + ignore globs', { skip }, () => {
  assert.strictEqual(m.repos.length, 2);
  assert.strictEqual(m.repos[0].name, 'general');           // lexical order preserved
  assert.strictEqual(m.repos[0].path, path.join(HOME, '.local/share/chezmoi'));  // tilde-expanded
  assert.deepStrictEqual(m.repos[1].roots, ['.claude', '.config']);
  assert.deepStrictEqual(m.ignoreGlobs, ['~/.claude/settings.json', '~/.cache/**']);
});

test('loadManifest: a malformed fragment throws a path-tagged error, not a raw SyntaxError', { skip }, () => {
  fs.writeFileSync(path.join(MAN, '99-broken.json'), '{ not valid json');
  assert.throws(() => loadManifest(MAN, HOME), /cannot parse .*99-broken\.json/);
  fs.unlinkSync(path.join(MAN, '99-broken.json'));
});

test('globToRegExp + matchesAnyGlob', { skip }, () => {
  assert.ok(globToRegExp('~/.cache/**'.replace('~', HOME)).test(path.join(HOME, '.cache/foo/bar')));
  assert.ok(!globToRegExp('~/.cache/*'.replace('~', HOME)).test(path.join(HOME, '.cache/a/b'))); // * is one segment
  assert.ok(matchesAnyGlob(path.join(HOME, '.cache/x'), ['~/.cache/**'], HOME));
  assert.ok(!matchesAnyGlob(path.join(HOME, '.zshrc'), ['~/.cache/**'], HOME));
  // Windows: native-node path.sep is '\' but globs use '/' — both sides normalize to '/'.
  assert.ok(matchesAnyGlob('C:\\Users\\d\\.cache\\x', ['~/.cache/**'], 'C:\\Users\\d'));
  assert.ok(!matchesAnyGlob('C:\\Users\\d\\.zshrc', ['~/.cache/**'], 'C:\\Users\\d'));
  // trailing /** also matches the bare directory itself (e.g. a dir symlink), not just contents
  assert.ok(globToRegExp(path.join(HOME, '.cache') + '/**').test(path.join(HOME, '.cache')));
  assert.ok(matchesAnyGlob(path.join(HOME, '.cache'), ['~/.cache/**'], HOME));
  // regex metacharacters in a glob are matched literally, only * is a wildcard
  assert.ok(globToRegExp(path.join(HOME, '.claude/*.log')).test(path.join(HOME, '.claude/run.log')));
  assert.ok(!globToRegExp(path.join(HOME, '.claude/*.log')).test(path.join(HOME, '.claude/run.logX')));
  assert.ok(globToRegExp(path.join(HOME, '.config/a+b(c).conf')).test(path.join(HOME, '.config/a+b(c).conf')));
  assert.ok(!globToRegExp(path.join(HOME, '.zcompdump.x')).test(path.join(HOME, '.zcompdumpZx'))); // '.' is literal
});

test('deriveTargets: chezmoi (paths relative to $HOME -> absolute)', { skip }, () => {
  const cz = deriveTargets(m.repos[0], HOME, fakeRunner);
  assert.deepStrictEqual(cz.targets, [path.join(HOME, '.zshrc'), path.join(HOME, '.config/git/config')]);
  assert.deepStrictEqual(cz.errors, []);
});

test('deriveTargets: git-symlink (keep only entries under declared roots)', { skip }, () => {
  const gs = deriveTargets(m.repos[1], HOME, fakeRunner);
  assert.deepStrictEqual(gs.targets, [path.join(HOME, '.claude/CLAUDE.local.md'), path.join(HOME, '.config/zsh/local.zsh')]);
  // README.md / install.sh dropped: not under .claude or .config
});

test('buildOwnership + computeCheck', { skip }, () => {
  const ownership = buildOwnership(m.repos, HOME, fakeRunner);
  const existing = [
    path.join(HOME, '.zshrc'),                  // owned (general)
    path.join(HOME, '.config/git/config'),      // owned (general)
    path.join(HOME, '.claude/CLAUDE.local.md'), // owned (work)
    path.join(HOME, '.config/zsh/local.zsh'),   // owned (work)
    path.join(HOME, '.claude/settings.json'),   // ignored (derived)
    path.join(HOME, '.cache/blob'),             // ignored
    path.join(HOME, '.config/rogue.conf'),      // ORPHAN
  ];
  const chk = computeCheck({ ownership, existing, ignoreGlobs: m.ignoreGlobs, home: HOME });
  assert.deepStrictEqual(chk.orphans, [path.join(HOME, '.config/rogue.conf')]);
  assert.deepStrictEqual(chk.conflicts, []);
  // missing: .config/zsh/local.zsh declared by work but suppose absent from `existing`
  const chk2 = computeCheck({ ownership, existing: existing.filter(p => !p.endsWith('local.zsh')), ignoreGlobs: m.ignoreGlobs, home: HOME });
  assert.deepStrictEqual(chk2.missing, [{ path: path.join(HOME, '.config/zsh/local.zsh'), repo: 'work' }]);
});

test('conflict: two repos claim the same path', { skip }, () => {
  const dupRunner = (cmd, args) => {
    if (cmd === 'chezmoi') return { code: 0, stdout: '.config/zsh/local.zsh\n', stderr: '' };
    if (cmd === 'git') return { code: 0, stdout: '.config/zsh/local.zsh\n', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  const dupOwn = buildOwnership(m.repos, HOME, dupRunner);
  const chk3 = computeCheck({ ownership: dupOwn, existing: [path.join(HOME, '.config/zsh/local.zsh')], ignoreGlobs: [], home: HOME });
  assert.deepStrictEqual(chk3.conflicts, [{ path: path.join(HOME, '.config/zsh/local.zsh'), repos: ['general', 'work'] }]);

  fs.rmSync(HOME, { recursive: true, force: true });
});
