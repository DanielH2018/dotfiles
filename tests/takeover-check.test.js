// Regression guard for home/dot_local/bin/executable_takeover-check.
// takeover-check carries a blanket `Bash(takeover-check:*)` allow rule, which is defensible
// only while it runs exactly `sudo -n /usr/local/sbin/homelab-takeover-check` with the
// wrapper's four flags or --help, every value plain and none starting with `-`. The tests load
// it as a module and point SUDO at a fake that prints the argv, environment and stdin it was
// given, so each test asserts the exact invocation, and an empty stdout proves sudo was never
// started.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { srcPath } = require('./lib/paths');
const { run } = require('./lib/run');

const TOOL = srcPath('dot_local', 'bin', 'executable_takeover-check');
const WRAPPER = '/usr/local/sbin/homelab-takeover-check';

let skip = false;
try {
  execFileSync('python3', ['--version'], { stdio: 'ignore' });
} catch {
  skip = 'python3 unavailable';
}

const DIR = scratch(os.tmpdir(), 'takeover-check-');
const SUDO = path.join(DIR, 'sudo');
const FAKE_WRAPPER = path.join(DIR, 'wrapper');
fs.writeFileSync(SUDO, `#!${process.execPath}
const fs = require('node:fs');
process.stderr.write('FROM-STDERR\\n');
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  env: Object.keys(process.env).sort(),
  stdin: fs.readFileSync(0, 'utf8'),
}));
`);
fs.chmodSync(SUDO, 0o755);
fs.writeFileSync(FAKE_WRAPPER, '');

const SEAM = `
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader('takeover_check', sys.argv[1])
mod = importlib.util.module_from_spec(importlib.util.spec_from_loader('takeover_check', loader))
loader.exec_module(mod)
mod.SUDO = sys.argv[2]
mod.WRAPPER = sys.argv[3]
sys.exit(mod.main(sys.argv[4:]))
`;

function tool(args, { wrapper = FAKE_WRAPPER, env = {} } = {}) {
  return run('python3', ['-c', SEAM, TOOL, SUDO, wrapper, ...args], {
    cwd: DIR, input: 'caller stdin', env: { ...process.env, ...env },
  });
}

const FLAGS = ['--label', '5707', '--render', 'render', '--src', '.', '--tags', 'traefik-crds,traefik'];

test('runs sudo -n on the wrapper with the four flags, paths made absolute', { skip }, () => {
  const r = tool(['--tags', 'traefik-crds,traefik', '--src', '.', '--label', '5707',
    '--render', 'render']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))).argv,
    ['-n', FAKE_WRAPPER, '--label', '5707', '--render', path.join(DIR, 'render'),
      '--src', DIR, '--tags', 'traefik-crds,traefik']);
});

test('passes --help alone through', { skip }, () => {
  for (const flag of ['--help', '-h']) {
    const r = tool([flag]);
    assert.deepStrictEqual(JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))).argv,
      ['-n', FAKE_WRAPPER, '--help']);
  }
});

test('merges stderr into stdout, closes stdin and gives sudo a fixed environment', { skip }, () => {
  const r = tool(FLAGS, { env: { SUDO_ASKPASS: '/tmp/x', CALLER_ONLY: 'x' } });
  assert.strictEqual(r.stderr, '');
  assert.match(r.stdout, /^FROM-STDERR\n/);
  const seen = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.strictEqual(seen.stdin, '');
  assert.deepStrictEqual(seen.env.filter((k) => !k.startsWith('NODE_')),
    ['HOME', 'LOGNAME', 'PATH', 'USER']);
});

test('refuses anything but the four flags or --help, and never starts sudo', { skip }, () => {
  const cases = [
    [],
    ['--help', '--label', 'x'],
    ['--label', '1', '--render', 'r', '--src', '.'],
    [...FLAGS, '--label', '2'],
    [...FLAGS, '--kubeconfig', '/etc/x'],
    ['--label', '--render', '--render', 'r', '--src', '.', '--tags', 'a'],
    ['--label', '-x', '--render', 'r', '--src', '.', '--tags', 'a'],
    ['--label', '1', '--render', 'r;id', '--src', '.', '--tags', 'a'],
    ['--label', '1', '--render', 'r', '--src', '$(id)', '--tags', 'a'],
    ['--label', '..', '--render', 'r', '--src', '.', '--tags', 'a'],
    ['--label', '1', '--render', 'r', '--src', '.', '--tags', 'a,,b'],
    ['--label', '1', '--render', 'r', '--src', '.', '--tags', 'a b'],
  ];
  for (const args of cases) {
    const r = tool(args);
    assert.strictEqual(r.code, 2, JSON.stringify(args));
    assert.strictEqual(r.stdout, '', JSON.stringify(args));
    assert.match(r.stderr, /refused/);
  }
});

test('exits 3 without starting sudo on a host with no wrapper', { skip }, () => {
  const r = tool(FLAGS, { wrapper: path.join(DIR, 'absent') });
  assert.strictEqual(r.code, 3);
  assert.strictEqual(r.stdout, '');
});

test('the interpreter is fixed and isolated, never looked up on PATH', () => {
  const first = fs.readFileSync(TOOL, 'utf8').split('\n')[0];
  assert.strictEqual(first, '#!/usr/bin/python3 -I');
  assert.ok(fs.readFileSync(TOOL, 'utf8').includes(`WRAPPER = "${WRAPPER}"`));
});
