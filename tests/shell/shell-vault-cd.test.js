// Behavior check for the vault() jump helper in shell/common.sh. The function is lifted
// verbatim from the source and driven in bash and zsh — the two shells that source
// common.sh — with $HOME pointed at a scratch dir, so a real vault is never touched.
// The failure that matters is a silent one: if the directory is missing, vault() must not
// leave you in the cwd pretending it moved.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { have } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const COMMON = srcPath('dot_config', 'shell', 'common.sh');

const zshSkip = have('zsh') ? false : 'zsh unavailable';

const fnMatch = fs.readFileSync(COMMON, 'utf8').match(/^vault\(\) \{\n[\s\S]*?\n\}/m);
assert.ok(fnMatch, 'vault() exists in common.sh');
const FN = fnMatch[0];

// Runs vault() in `shell` and reports where it landed plus its exit status. cwd starts at a
// scratch dir so "did not move" is distinguishable from "moved to the vault".
function run(shell, env) {
  const start = scratch(os.tmpdir(), 'vault-');
  const out = execFileSync(shell, ['-c', `${FN}\nvault; echo "rc=$?"\npwd -P`],
    { cwd: start, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  const lines = out.trim().split('\n');
  return { cwd: lines.pop(), rc: Number(/rc=(\d+)/.exec(out)[1]), start: fs.realpathSync(start) };
}

for (const shell of ['bash', 'zsh']) {
  const skip = shell === 'zsh' ? zshSkip : false;

  test(`${shell}: vault cds to ~/My_Vault by default`, { skip }, () => {
    const home = scratch(os.tmpdir(), 'vault-');
    const target = path.join(home, 'My_Vault');
    fs.mkdirSync(target);
    const { cwd, rc } = run(shell, { HOME: home, OBSIDIAN_VAULT_DIR: '' });
    assert.strictEqual(rc, 0);
    assert.strictEqual(cwd, fs.realpathSync(target));
  });

  test(`${shell}: OBSIDIAN_VAULT_DIR overrides the default, spaces and all`, { skip }, () => {
    const home = scratch(os.tmpdir(), 'vault-');
    fs.mkdirSync(path.join(home, 'My_Vault'));
    const elsewhere = path.join(scratch(os.tmpdir(), 'vault-'), 'Second Brain');
    fs.mkdirSync(elsewhere);
    const { cwd, rc } = run(shell, { HOME: home, OBSIDIAN_VAULT_DIR: elsewhere });
    assert.strictEqual(rc, 0);
    assert.strictEqual(cwd, fs.realpathSync(elsewhere));
  });

  test(`${shell}: a missing vault fails loudly and does not cd`, { skip }, () => {
    const home = scratch(os.tmpdir(), 'vault-');
    const { cwd, rc, start } = run(shell, { HOME: home, OBSIDIAN_VAULT_DIR: '' });
    assert.strictEqual(rc, 1);
    assert.strictEqual(cwd, start, 'must stay put when there is no vault');
  });

  test(`${shell}: the missing-vault message names the path and goes to stderr`, { skip }, () => {
    const home = scratch(os.tmpdir(), 'vault-');
    const proc = require('node:child_process').spawnSync(shell, ['-c', `${FN}\nvault`],
      { env: { ...process.env, HOME: home, OBSIDIAN_VAULT_DIR: '' }, encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(proc.stdout, '', 'nothing on stdout');
    assert.match(proc.stderr, new RegExp(`no vault at ${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/My_Vault`));
  });
}
