const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../home/dot_local/bin/executable_dotsync');
const { buildOwnership, renderInventory, cmdInventory, cmdCheck } = mod;

// dotsync is Unix-only tooling (POSIX path/glob handling + symlink farms; deployed to
// ~/.local/bin and used in the Unix restore/sync flow). It isn't run on Windows. Skip there.
if (process.platform === 'win32') { console.log('SKIP: dotsync is Unix-only'); process.exit(0); }

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsinv-'));
const MAN = path.join(HOME, '.config', 'dotsync', 'manifest.d');
fs.mkdirSync(MAN, { recursive: true });
fs.writeFileSync(path.join(MAN, '00-general.json'), JSON.stringify({
  repo: { name: 'general', type: 'chezmoi', path: '~/cz', remote: 'r' },
  ignore: { globs: ['~/.cache/**', '~/.config/dotsync/INVENTORY.md'] },
}));
fs.writeFileSync(path.join(MAN, '50-work.json'), JSON.stringify({
  repo: { name: 'work', type: 'git-symlink', path: '~/work', remote: 'r', roots: ['.claude', '.config'] },
}));

// runner that also backs scanRoots' `find` so cmdCheck/cmdInventory work end-to-end.
function seed(p, body = 'x') { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); }
seed(path.join(HOME, '.zshrc'));
seed(path.join(HOME, '.claude', 'CLAUDE.local.md'));
seed(path.join(HOME, '.cache', 'blob'));   // ignored
const runner = (cmd, args) => {
  if (cmd === 'chezmoi' && args[0] === 'managed') return { code: 0, stdout: '.zshrc\n.config/dotsync/manifest.d/00-general.json\n', stderr: '' };
  if (cmd === 'git' && args.includes('ls-files')) return { code: 0, stdout: '.claude/CLAUDE.local.md\nREADME.md\n.config/dotsync/manifest.d/50-work.json\n', stderr: '' };
  if (cmd === 'find') {
    const out = require('node:child_process').execFileSync('find', args, { encoding: 'utf8' });
    return { code: 0, stdout: out, stderr: '' };
  }
  return { code: 1, stdout: '', stderr: '' };
};

// --- renderInventory ---
const own = buildOwnership(mod.loadManifest(MAN, HOME).repos, HOME, runner);
const md = renderInventory(own, HOME);
assert.ok(md.includes('| `~/.claude/CLAUDE.local.md` | work |'), 'work row present, tilde-relative');
assert.ok(md.includes('| `~/.zshrc` | general |'), 'general row present');
assert.ok(md.indexOf('~/.claude/CLAUDE.local.md') < md.indexOf('~/.zshrc'), 'rows sorted by path');

// --- cmdInventory writes the file + returns 0 ---
const logs = [];
const origLog = console.log; console.log = (...a) => logs.push(a.join(' '));
const invRc = cmdInventory({ home: HOME, manifestDir: MAN, runner });
console.log = origLog;
assert.strictEqual(invRc, 0);
const written = fs.readFileSync(path.join(HOME, '.config/dotsync/INVENTORY.md'), 'utf8');
assert.strictEqual(written, md);

// --- cmdCheck: clean -> 0 ---
const origErr = console.error; console.error = () => {}; const origLog2 = console.log; console.log = () => {};
let rc = cmdCheck({ home: HOME, manifestDir: MAN, runner });
console.log = origLog2; console.error = origErr;
assert.strictEqual(rc, 0, 'all existing files owned or ignored -> clean');

// --- cmdCheck: orphan -> 1 ---
seed(path.join(HOME, '.config', 'rogue.conf'));
console.error = () => {}; console.log = () => {};
rc = cmdCheck({ home: HOME, manifestDir: MAN, runner });
console.log = origLog2; console.error = origErr;
assert.strictEqual(rc, 1, 'unowned, non-ignored file -> non-zero exit');

// --- cmdCheck: declared target OUTSIDE scan roots that EXISTS on disk must NOT be reported missing ---
// .local/bin/dotsync is managed by chezmoi but is not under ~/.config or ~/.claude, so scanRoots
// never includes it. The real existsFn (lstatSync) must find it and suppress the false-positive.
const HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsinv2-'));
const MAN2 = path.join(HOME2, '.config', 'dotsync', 'manifest.d');
fs.mkdirSync(MAN2, { recursive: true });
fs.writeFileSync(path.join(MAN2, '00-general.json'), JSON.stringify({
  repo: { name: 'general', type: 'chezmoi', path: path.join(HOME2, 'cz'), remote: 'r' },
  ignore: { globs: ['~/.cache/**', '~/.config/dotsync/INVENTORY.md'] },
}));
// chezmoi reports .local/bin/dotsync as managed — outside scan roots
seed(path.join(HOME2, '.local', 'bin', 'dotsync'), '#!/usr/bin/env node');
// also seed a file that IS in scan roots and is owned
seed(path.join(HOME2, '.zshrc'));
const runner2 = (cmd, args) => {
  if (cmd === 'chezmoi' && args[0] === 'managed') return { code: 0, stdout: '.zshrc\n.local/bin/dotsync\n.config/dotsync/manifest.d/00-general.json\n', stderr: '' };
  if (cmd === 'find') {
    const out = require('node:child_process').execFileSync('find', args, { encoding: 'utf8' });
    return { code: 0, stdout: out, stderr: '' };
  }
  return { code: 1, stdout: '', stderr: '' };
};
console.error = () => {}; console.log = () => {};
const rc2 = cmdCheck({ home: HOME2, manifestDir: MAN2, runner: runner2 });
console.log = origLog2; console.error = origErr;
assert.strictEqual(rc2, 0, 'declared target outside scan roots that exists on disk must not be reported missing');

for (const d of [HOME, HOME2]) fs.rmSync(d, { recursive: true, force: true });
console.log('ALL PASS');
