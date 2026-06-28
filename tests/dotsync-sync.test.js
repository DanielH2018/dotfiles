const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../home/dot_local/bin/executable_dotsync');
const { buildSyncPlan, cmdSync, main } = mod;

// --- buildSyncPlan: per-repo-type step selection ---
const repos = [
  { name: 'general', type: 'chezmoi', path: '/cz' },
  { name: 'work', type: 'git-symlink', path: '/work', roots: ['.claude'] },
];
let plan = buildSyncPlan(repos, { force: false, hasOrphans: false });
assert.strictEqual(plan.blocked, false);
assert.deepStrictEqual(plan.actions[0], { repo: 'general', type: 'chezmoi', steps: ['chezmoi re-add', 'git commit (if changes)', 'git push'] });
assert.deepStrictEqual(plan.actions[1], { repo: 'work', type: 'git-symlink', steps: ['git add -A', 'git commit (if changes)', 'git push'] });

// --- orphan gate: blocked without --force, allowed with --force ---
assert.strictEqual(buildSyncPlan(repos, { force: false, hasOrphans: true }).blocked, true);
assert.strictEqual(buildSyncPlan(repos, { force: true, hasOrphans: true }).blocked, false);

// --- cmdSync --dry-run performs NO mutating runner calls ---
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dssync-'));
const MAN = path.join(HOME, '.config', 'dotsync', 'manifest.d');
fs.mkdirSync(MAN, { recursive: true });
fs.writeFileSync(path.join(MAN, '00-general.json'), JSON.stringify({ repo: { name: 'general', type: 'chezmoi', path: '~/cz', remote: 'r' }, ignore: { globs: ['~/**'] } }));
fs.writeFileSync(path.join(MAN, '50-work.json'), JSON.stringify({ repo: { name: 'work', type: 'git-symlink', path: '~/work', remote: 'r', roots: ['.claude'] } }));

const calls = [];
const MUTATING = new Set(['re-add', 'add', 'commit', 'push']);
const recRunner = (cmd, args) => {
  calls.push([cmd, ...args]);
  if (args.some((a) => MUTATING.has(a))) throw new Error('mutating call during --dry-run: ' + cmd + ' ' + args.join(' '));
  if (cmd === 'chezmoi' && args[0] === 'managed') return { code: 0, stdout: '.zshrc\n', stderr: '' };
  if (cmd === 'git' && args.includes('ls-files')) return { code: 0, stdout: '.claude/x\n', stderr: '' };
  if (cmd === 'find') return { code: 0, stdout: '', stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};
const origLog = console.log; console.log = () => {};
const rc = cmdSync({ home: HOME, manifestDir: MAN, runner: recRunner, force: false, dryRun: true });
console.log = origLog;
assert.strictEqual(rc, 0, 'dry-run with everything ignored -> no orphans -> 0');
assert.ok(!calls.some(([c, ...a]) => a.some((x) => MUTATING.has(x))), 'no mutating calls issued in dry-run');
assert.ok(fs.existsSync(path.join(HOME, '.config/dotsync/INVENTORY.md')), 'dry-run still regenerates inventory');

// --- sync blocked by orphan returns 1 (via main dispatch, no --force) ---
fs.writeFileSync(path.join(MAN, '00-general.json'), JSON.stringify({ repo: { name: 'general', type: 'chezmoi', path: '~/cz', remote: 'r' }, ignore: { globs: [] } }));
fs.mkdirSync(path.join(HOME, '.config'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.config', 'rogue.conf'), 'x');
const orphanRunner = (cmd, args) => {
  if (cmd === 'chezmoi' && args[0] === 'managed') return { code: 0, stdout: '', stderr: '' };
  if (cmd === 'git' && args.includes('ls-files')) return { code: 0, stdout: '', stderr: '' };
  if (cmd === 'find') return { code: 0, stdout: require('node:child_process').execFileSync('find', args, { encoding: 'utf8' }), stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};
const origErr = console.error; console.error = () => {}; console.log = () => {};
const blockedRc = cmdSync({ home: HOME, manifestDir: MAN, runner: orphanRunner, force: false, dryRun: true });
console.log = origLog; console.error = origErr;
assert.strictEqual(blockedRc, 1, 'orphan without --force blocks sync');

// --- main dispatch: unknown subcommand -> 2 ---
const oe = console.error; console.error = () => {};
assert.strictEqual(main(['node', 'dotsync', 'bogus'], { HOME }, () => ({ code: 0, stdout: '', stderr: '' })), 2);
console.error = oe;

// --- FIX A: push failure surfaces as non-zero exit ---
// Setup: fresh home with no orphans (everything ignored via ~/**)
const HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dssync2-'));
const MAN2 = path.join(HOME2, '.config', 'dotsync', 'manifest.d');
fs.mkdirSync(MAN2, { recursive: true });
fs.writeFileSync(path.join(MAN2, '00-general.json'), JSON.stringify({
  repo: { name: 'general', type: 'chezmoi', path: path.join(HOME2, 'cz'), remote: 'r' },
  ignore: { globs: ['~/**'] },
}));

// push returns fatal auth failure -> cmdSync must return 1
const pushFailRunner = (cmd, args) => {
  if (cmd === 'chezmoi' && args[0] === 'managed') return { code: 0, stdout: '', stderr: '' };
  if (cmd === 'chezmoi' && args[0] === 're-add') return { code: 0, stdout: '', stderr: '' };
  if (cmd === 'git' && args.includes('push')) return { code: 1, stdout: '', stderr: 'fatal: Authentication failed' };
  if (cmd === 'find') return { code: 0, stdout: '', stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};
const oeB = console.error; console.error = () => {}; console.log = () => {};
const pushFailRc = cmdSync({ home: HOME2, manifestDir: MAN2, runner: pushFailRunner, force: false, dryRun: false });
console.log = origLog; console.error = oeB;
assert.strictEqual(pushFailRc, 1, 'push failure (auth error) must surface as exit 1');

// push returns "Everything up-to-date" with code 1 -> treated as success
const pushUpToDateRunner = (cmd, args) => {
  if (cmd === 'chezmoi' && args[0] === 'managed') return { code: 0, stdout: '', stderr: '' };
  if (cmd === 'chezmoi' && args[0] === 're-add') return { code: 0, stdout: '', stderr: '' };
  if (cmd === 'git' && args.includes('push')) return { code: 1, stdout: 'Everything up-to-date', stderr: '' };
  if (cmd === 'find') return { code: 0, stdout: '', stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};
const oeC = console.error; console.error = () => {}; console.log = () => {};
const HOME3 = fs.mkdtempSync(path.join(os.tmpdir(), 'dssync3-'));
const MAN3 = path.join(HOME3, '.config', 'dotsync', 'manifest.d');
fs.mkdirSync(MAN3, { recursive: true });
fs.writeFileSync(path.join(MAN3, '00-general.json'), JSON.stringify({
  repo: { name: 'general', type: 'chezmoi', path: path.join(HOME3, 'cz'), remote: 'r' },
  ignore: { globs: ['~/**'] },
}));
const pushUpToDateRc = cmdSync({ home: HOME3, manifestDir: MAN3, runner: pushUpToDateRunner, force: false, dryRun: false });
console.log = origLog; console.error = oeC;
assert.strictEqual(pushUpToDateRc, 0, 'push "Everything up-to-date" must be treated as success (exit 0)');

console.log('ALL PASS');
