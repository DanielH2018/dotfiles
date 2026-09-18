const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../../home/dot_local/bin/executable_dotsync');
const { scratch } = require('../lib/tmp');
const { cmdStatus } = mod;

// dotsync is Unix-only tooling (POSIX path/glob handling + symlink farms; deployed to
// ~/.local/bin and used in the Unix restore/sync flow). It isn't run on Windows. Skip there.
const skip = process.platform === 'win32' ? 'dotsync is Unix-only' : false;

let HOME, MAN, w, captureStatus;
if (!skip) {
  HOME = scratch(os.tmpdir(), 'dsstatus-');
  MAN = path.join(HOME, '.config', 'dotsync', 'manifest.d');
  fs.mkdirSync(MAN, { recursive: true });
  w = (name, obj) => fs.writeFileSync(path.join(MAN, name), JSON.stringify(obj));

  // cmdStatus doesn't compute orphans/conflicts the way cmdCheck does — it just runs
  // `git status -sb` (and, for chezmoi repos, `chezmoi diff`) per manifest repo and echoes
  // the raw output. Capture both console.log headers and the raw process.stdout.write(sb.stdout).
  captureStatus = function (runner) {
    const calls = [];
    const chunks = [];
    const wrapped = (cmd, args, opts) => { calls.push([cmd, ...args]); return runner(cmd, args, opts); };
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk.toString()); return true; };
    const origLog = console.log;
    console.log = (...a) => { chunks.push(a.join(' ') + '\n'); };
    let rc;
    try {
      rc = cmdStatus({ home: HOME, manifestDir: MAN, runner: wrapped });
    } finally {
      process.stdout.write = origWrite;
      console.log = origLog;
    }
    return { rc, output: chunks.join(''), calls };
  };
}

test('(a) clean tree: single chezmoi repo, no pending changes', { skip }, () => {
  w('00-general.json', { repo: { name: 'general', type: 'chezmoi', path: '~/cz', remote: 'r' } });
  const runner = (cmd, args) => {
    if (cmd === 'git' && args.includes('status')) return { code: 0, stdout: '## main...origin/main\n', stderr: '' };
    if (cmd === 'chezmoi' && args.includes('diff')) return { code: 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected ' + cmd };
  };
  const { rc, output } = captureStatus(runner);
  assert.strictEqual(rc, 0);
  assert.ok(output.includes('== general (chezmoi) ~/cz =='), 'repo header printed');
  assert.ok(output.includes('## main...origin/main'), 'raw git status -sb output passed through');
  assert.ok(output.includes('chezmoi diff: clean'), 'empty chezmoi diff reported as clean');
});

test('(b) an orphaned/unmanaged file: untracked file surfaced verbatim via git status -sb passthrough, alongside a pending chezmoi diff', { skip }, () => {
  const runner = (cmd, args) => {
    if (cmd === 'git' && args.includes('status')) {
      return { code: 0, stdout: '## main...origin/main [ahead 1]\n?? .config/rogue.conf\n', stderr: '' };
    }
    if (cmd === 'chezmoi' && args.includes('diff')) return { code: 0, stdout: ' .config/rogue.conf\n', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected ' + cmd };
  };
  const { rc, output } = captureStatus(runner);
  assert.strictEqual(rc, 0);
  assert.ok(output.includes('?? .config/rogue.conf'), 'untracked/unmanaged file surfaced verbatim from git status -sb');
  assert.ok(output.includes('chezmoi diff: changes pending'), 'non-empty chezmoi diff reported as pending');
});

test('(c) multiple manifest repos: header + status printed per repo, in manifest (lexical) order; chezmoi diff is only ever checked for the chezmoi-type repo, never git-symlink', { skip }, () => {
  w('50-work.json', { repo: { name: 'work', type: 'git-symlink', path: '~/work', remote: 'r', roots: ['.claude'] } });
  const runner = (cmd, args) => {
    if (cmd === 'git' && args.includes('status') && args.includes(path.join(HOME, 'cz'))) {
      return { code: 0, stdout: '## main...origin/main\n', stderr: '' };
    }
    if (cmd === 'git' && args.includes('status') && args.includes(path.join(HOME, 'work'))) {
      return { code: 0, stdout: '## main\n M .claude/CLAUDE.local.md\n', stderr: '' };
    }
    if (cmd === 'chezmoi' && args.includes('diff')) return { code: 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected ' + cmd };
  };
  const { rc, output, calls } = captureStatus(runner);
  assert.strictEqual(rc, 0);
  const generalIdx = output.indexOf('== general (chezmoi) ~/cz ==');
  const workIdx = output.indexOf('== work (git-symlink) ~/work ==');
  assert.ok(generalIdx !== -1 && workIdx !== -1 && generalIdx < workIdx, 'repos printed in manifest (lexical) order');
  assert.ok(output.includes('M .claude/CLAUDE.local.md'), "work repo's own git status surfaced");
  const diffCalls = calls.filter((c) => c[0] === 'chezmoi' && c.includes('diff'));
  assert.strictEqual(diffCalls.length, 1, 'chezmoi diff is only invoked for the chezmoi-type repo');
});

