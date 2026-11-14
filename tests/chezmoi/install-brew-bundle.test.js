// os-darwin/run_onchange_after_install-brew-bundle.sh.tmpl, run against stub brew and fnm.
// install-fnm runs before this script, so on a fresh Mac this script is what gives fnm a
// default node.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { renderTemplate, chezmoiAvailable } = require('../lib/render');
const { srcPath } = require('../lib/paths');
const { tmpdir, readLog, runSh } = require('../lib/chezmoi-scripts');

const SRC = srcPath('.chezmoiscripts', 'os-darwin', 'run_onchange_after_install-brew-bundle.sh.tmpl');
const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

// set() fakes .chezmoi.os, which the `data` config override cannot reach.
const asDarwin = () => renderTemplate(`{{ $_ := set .chezmoi "os" "darwin" }}${fs.readFileSync(SRC, 'utf8')}`, { profile: 'server' });

function sandbox({ defaultNode = false } = {}) {
  const dir = tmpdir('brew-bundle-');
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  const logFile = path.join(dir, 'log.txt');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'Brewfile'), '');
  if (defaultNode) fs.mkdirSync(path.join(home, '.local', 'share', 'fnm', 'aliases', 'default'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'brew'), `#!/bin/sh\necho "brew $*" >> "${logFile}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'fnm'), `#!/bin/sh\necho "fnm $* FNM_DIR=$FNM_DIR" >> "${logFile}"\nexit "\${FNM_EXIT:-0}"\n`, { mode: 0o755 });
  const scriptFile = path.join(dir, 'script.sh');
  fs.writeFileSync(scriptFile, asDarwin());
  return { scriptFile, logFile, home, env: { HOME: home, PATH: bin } };
}

test('install-brew-bundle: fnm without a default node -> installs the LTS under ~/.local/share/fnm', { skip }, () => {
  const { scriptFile, logFile, home, env } = sandbox();
  const { status, stderr } = runSh(scriptFile, env);
  assert.strictEqual(status, 0, stderr);
  const fnmDir = path.join(home, '.local', 'share', 'fnm');
  const log = readLog(logFile);
  assert.ok(log.includes(`fnm install --lts FNM_DIR=${fnmDir}`), log);
  assert.ok(log.includes(`fnm default lts-latest FNM_DIR=${fnmDir}`), log);
});

test('install-brew-bundle: a default node already present -> fnm is not called', { skip }, () => {
  const { scriptFile, logFile, env } = sandbox({ defaultNode: true });
  const { status } = runSh(scriptFile, env);
  assert.strictEqual(status, 0);
  assert.doesNotMatch(readLog(logFile), /^fnm /m);
});

// chezmoi records a script that exits 0 as done, and this one would then never run again.
test('install-brew-bundle: fnm fails to install node -> defers with exit 1', { skip }, () => {
  const { scriptFile, env } = sandbox();
  env.FNM_EXIT = '1';
  const { status, stderr } = runSh(scriptFile, env);
  assert.strictEqual(status, 1);
  assert.match(stderr, /deferring/);
});
