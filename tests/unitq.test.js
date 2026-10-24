// Regression guard for home/dot_local/bin/executable_unitq.
// unitq carries a blanket `Bash(unitq:*)` allow rule while it prints what systemctl cat and
// show return, so the rule is defensible only while every value that can hold a secret is
// removed by structure. The tests load it as a module, point SYSTEMCTL at a fake that prints
// a fixture unit holding one canary in every secret-bearing position, and record the argv the
// fake was given.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { srcPath } = require('./lib/paths');
const { run } = require('./lib/run');

const TOOL = process.env.UNITQ_UNDER_TEST || srcPath('dot_local', 'bin', 'executable_unitq');

let skip = false;
try {
  execFileSync('python3', ['--version'], { stdio: 'ignore' });
} catch {
  skip = 'python3 unavailable';
}

const CANARY = 'c4n4ry-s3cr3t-9f8e7d';
const DIR = scratch(os.tmpdir(), 'unitq-');
const CAT = [
  '# /etc/systemd/system/claude-land@.service',
  `# a comment that mentions ${CANARY}`,
  '[Unit]',
  'Description=Land a PR',
  '',
  '[Service]',
  'User=ubuntu',
  'WorkingDirectory=/home/ubuntu/server',
  `Environment=LAND_DEADLINE=28800 DEBUG=yes CACHE=/var/cache/land TOKEN=${CANARY}`,
  `Environment="QUOTED=${CANARY} x" TIMEOUT=30s`,
  'EnvironmentFile=/etc/homelab/land.env',
  `ExecStart=/usr/bin/curl -H "Authorization: Bearer ${CANARY}" --token=${CANARY} -p${CANARY} -v https://x/${CANARY}`,
  `ExecStartPre=-/bin/sh -c 'echo ${CANARY}'`,
  `SetCredential=api-key:${CANARY}`,
  `ExecStop=/bin/kill \\`,
  `    ${CANARY}`,
  'TimeoutStartSec=300',
  '',
].join('\n');
const SHOW = [
  `ExecStart={ path=/usr/bin/claude-transcript-scan ; argv[]=/usr/bin/claude-transcript-scan --key ${CANARY} ; ignore_errors=no }`,
  `Environment=LAND_DEADLINE=28800 TOKEN=${CANARY}`,
  `SetCredential=api-key:${CANARY}`,
  'User=ubuntu',
  'ActiveState=active',
  'ExecMainPID=4242',
  '',
].join('\n');
fs.writeFileSync(path.join(DIR, 'cat.txt'), CAT);
fs.writeFileSync(path.join(DIR, 'show.txt'), SHOW);
const FAKE = path.join(DIR, 'systemctl');
fs.writeFileSync(FAKE, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(path.join(DIR, 'argv.json'))}, JSON.stringify(args));
const sub = args.find((a) => a === 'cat' || a === 'show');
process.stdout.write(fs.readFileSync(${JSON.stringify(DIR)} + '/' + sub + '.txt', 'utf8'));
`);
fs.chmodSync(FAKE, 0o755);

const SEAM = `
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader('unitq', sys.argv[1])
mod = importlib.util.module_from_spec(importlib.util.spec_from_loader('unitq', loader))
loader.exec_module(mod)
mod.SYSTEMCTL = sys.argv[2]
sys.exit(mod.main(sys.argv[3:]))
`;

function unitq(args) {
  return run('python3', ['-c', SEAM, TOOL, FAKE, ...args]);
}
const argv = () => JSON.parse(fs.readFileSync(path.join(DIR, 'argv.json'), 'utf8'));

test('no canary survives cat or show', { skip }, () => {
  for (const args of [['cat', 'claude-land@.service'], ['show', 'x.service', 'ExecStart',
    'Environment', 'SetCredential', 'User']]) {
    const r = unitq(args);
    assert.ok(!(r.stdout + r.stderr).includes(CANARY), args.join(' '));
  }
});

test('cat keeps plain values, names, the binary and flag names', { skip }, () => {
  assert.deepStrictEqual(unitq(['cat', 'claude-land@.service']).stdout.split('\n'), [
    '# /etc/systemd/system/claude-land@.service',
    '[Unit]',
    'Description=Land a PR',
    '',
    '[Service]',
    'User=ubuntu',
    'WorkingDirectory=/home/ubuntu/server',
    'Environment=LAND_DEADLINE=28800 DEBUG=yes CACHE=/var/cache/land TOKEN=<value>',
    'Environment=QUOTED=<value> TIMEOUT=30s',
    'EnvironmentFile=/etc/homelab/land.env',
    'ExecStart=/usr/bin/curl -H <arg> --token=<v> <arg> -v <arg>',
    'ExecStartPre=-/bin/sh -c <arg>',
    'SetCredential=api-key:<value>',
    'ExecStop=<command>',
    '<line>',
    'TimeoutStartSec=300',
    '',
  ]);
});

test('show gives an Exec property as its path and Environment as names', { skip }, () => {
  assert.deepStrictEqual(unitq(['show', 'x.service', 'ExecStart', 'Environment']).stdout
    .split('\n').slice(0, 6), [
    'ExecStart=/usr/bin/claude-transcript-scan',
    'Environment=LAND_DEADLINE=28800 TOKEN=<value>',
    'SetCredential=<value>',
    'User=ubuntu',
    'ActiveState=active',
    'ExecMainPID=4242',
  ]);
});

test('runs a fixed systemctl invocation, --user included', { skip }, () => {
  unitq(['cat', '--user', 'a.service', 'b.timer']);
  assert.deepStrictEqual(argv(), ['--user', 'cat', '--no-pager', '--', 'a.service', 'b.timer']);
  unitq(['show', 'a.service', 'ExecStart', 'User']);
  assert.deepStrictEqual(argv(), ['show', '--no-pager', '-p', 'ExecStart,User', '--', 'a.service']);
});

test('refuses a unit or property that could become a flag or a shell word', { skip }, () => {
  fs.rmSync(path.join(DIR, 'argv.json'), { force: true });
  for (const args of [['cat'], ['cat', '--root=/x'], ['cat', 'a;id'], ['show', 'a.service'],
    ['show', 'a.service', '-p'], ['show', 'a.service', 'Exec,Start'], ['edit', 'a.service']]) {
    const r = unitq(args);
    assert.strictEqual(r.code, 2, args.join(' '));
    assert.strictEqual(r.stdout, '', args.join(' '));
  }
  assert.ok(!fs.existsSync(path.join(DIR, 'argv.json')), 'systemctl was started');
});
