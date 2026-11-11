// The `claude` distrobox's package list and its installer. Inside the container sudo fails, so
// nothing else installs these; a rebuilt container that silently lacked jq broke every jq hook.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderTemplate, chezmoiAvailable } = require('../lib/render');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';
const DIR = srcPath('dot_config', 'distrobox');
const render = (file) => renderTemplate(fs.readFileSync(path.join(DIR, file), 'utf8'), {
  source: srcPath(), profile: 'workstation',
});
const aptPackages = [...fs.readFileSync(srcPath('.chezmoidata', 'tools.toml'), 'utf8')
  .matchAll(/^apt = "([^"]+)"$/gm)].map((m) => m[1]);

const PASSTHROUGH = ['sh', 'mkdir', 'dirname', 'chmod', 'ln'];

// Runs the rendered script with dpkg/apt-get/curl stubbed. `installed` lists the packages dpkg
// reports present; `ghList` pre-creates the cli.github.com apt source. Returns the apt-get log.
function run(t, { installed = [], ghList = false, env = {} } = {}) {
  const root = scratch(os.tmpdir(), 'distrobox-claude-', t);
  const bin = path.join(root, 'stubs');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, 'usr', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'usr', 'local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'usr', 'bin', 'batcat'), '', { mode: 0o755 });
  if (ghList) {
    fs.mkdirSync(path.join(root, 'etc', 'apt', 'sources.list.d'), { recursive: true });
    fs.writeFileSync(path.join(root, 'etc', 'apt', 'sources.list.d', 'github-cli.list'), '');
  }
  for (const name of PASSTHROUGH) {
    fs.symlinkSync(execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(), path.join(bin, name));
  }
  const log = path.join(root, 'apt.log');
  const stubs = {
    dpkg: `case " ${installed.join(' ')} " in *" $2 "*) exit 0 ;; esac; exit 1`,
    'apt-get': `echo "$*" >> ${JSON.stringify(log)}`,
    curl: 'while [ $# -gt 1 ]; do [ "$1" = -o ] && : > "$2"; shift; done',
    id: 'echo 1000',
  };
  for (const [name, body] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  const script = path.join(root, 'claude-packages.sh');
  fs.writeFileSync(script, render('executable_claude-packages.sh.tmpl'));
  let status = 0;
  let out = '';
  try {
    out = execFileSync(path.join(bin, 'sh'), [script], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: bin, CLAUDE_PACKAGES_ROOT: root, ...env },
    });
  } catch (e) {
    status = e.status;
    out = e.stderr;
  }
  const apt = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  return { status, out, apt, root };
}

test('the manifest runs the deployed installer on a rebuild', { skip }, () => {
  const ini = render('claude.ini.tmpl');
  assert.match(ini, /^\[claude\]$/m);
  assert.match(ini, /^image=quay\.io\/toolbx-images\/debian-toolbox:13$/m);
  assert.match(ini, new RegExp(`^init_hooks=${os.homedir()}/\\.config/distrobox/claude-packages\\.sh$`, 'm'));
});

test('a fresh container gets every tools.toml apt package, git-lfs, and gh from cli.github.com', { skip }, (t) => {
  const { status, apt, root } = run(t);
  assert.strictEqual(status, 0);
  const installLine = apt.split('\n').find((l) => l.startsWith('install -y'));
  const pkgs = installLine.split(/\s+/).slice(2);
  for (const p of [...aptPackages, 'jq', 'shellcheck', 'git-lfs', 'gh']) assert.ok(pkgs.includes(p), `${p} not installed`);
  const list = fs.readFileSync(path.join(root, 'etc', 'apt', 'sources.list.d', 'github-cli.list'), 'utf8');
  assert.match(list, /https:\/\/cli\.github\.com\/packages stable main/);
  assert.ok(fs.existsSync(path.join(root, 'etc', 'apt', 'keyrings', 'githubcli-archive-keyring.gpg')));
  assert.strictEqual(fs.readlinkSync(path.join(root, 'usr', 'local', 'bin', 'bat')), '/usr/bin/batcat');
});

test("Debian's gh is replaced once the cli.github.com source is added", { skip }, (t) => {
  const { apt } = run(t, { installed: [...aptPackages, 'git-lfs', 'gh'] });
  assert.match(apt, /^install -y gh$/m);
});

test('a converged container installs nothing', { skip }, (t) => {
  const { status, apt } = run(t, { installed: [...aptPackages, 'git-lfs', 'gh'], ghList: true });
  assert.strictEqual(status, 0);
  assert.strictEqual(apt, '');
});

test('it refuses to run without root', { skip }, (t) => {
  const { status, out } = run(t, { env: { CLAUDE_PACKAGES_ROOT: '' } });
  assert.strictEqual(status, 1);
  assert.match(out, /run as root/);
});
