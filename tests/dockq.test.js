// Regression guard for home/dot_local/bin/executable_dockq.
// dockq carries a blanket `Bash(dockq:*)` allow rule on the unsandboxed path, and that rule
// is defensible only while the verbs stay a closed set of reads and `inspect` can never
// print Config.Env, and while the caller's environment cannot choose the docker binary or
// daemon. dockq looks docker up in fixed directories, never $PATH, so the tests load it as a
// module and point DOCKER_DIRS at a fake `docker` that prints the argv it was given. An
// empty stdout proves docker was never started. For `inspect` the fake goes further: it holds a
// container whose environment carries a canary, prints all of it when no --format is given,
// and otherwise renders `{{json .Path}}` against it -- so the test sees what a real daemon
// would return, not just the template.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { srcPath } = require('./lib/paths');
const { run } = require('./lib/run');

const DOCKQ = srcPath('dot_local', 'bin', 'executable_dockq');

let skip = false;
try {
  execFileSync('python3', ['--version'], { stdio: 'ignore' });
} catch {
  skip = 'python3 unavailable';
}

const CANARY = 'DB_PASSWORD=canary-7f3a';
const DIR = scratch(os.tmpdir(), 'dockq-');
const BIN = path.join(DIR, 'bin');
const DECOY = path.join(DIR, 'decoy');
fs.mkdirSync(BIN);
fs.mkdirSync(DECOY);
// An absolute node path in the shebang: dockq pins docker's PATH to system directories,
// where `env node` would not find an fnm-managed node.
fs.writeFileSync(path.join(BIN, 'docker'), `#!${process.execPath}
const args = process.argv.slice(2);
if (process.env.FAKE_DOCKER_ENV) {
  process.stdout.write(JSON.stringify({ host: process.env.DOCKER_HOST ?? null }));
  process.exit(0);
}
if (args[0] !== 'inspect') {
  process.stdout.write(JSON.stringify(args));
  process.exit(0);
}
const c = {
  Name: '/web', Id: 'abc', Created: '2026-10-20T00:00:00Z', RestartCount: 0, Platform: 'linux',
  State: { Status: 'running' }, Mounts: [], HostConfig: { RestartPolicy: { Name: 'no' } },
  NetworkSettings: { Networks: {}, Ports: {} },
  Config: { Image: 'nginx:1', Env: [${JSON.stringify(CANARY)}], Labels: {} },
};
const fmt = args.find((a) => a.startsWith('--format='));
if (!fmt) {
  process.stdout.write(JSON.stringify([c]));
  process.exit(0);
}
const template = fmt.slice('--format='.length);
const rendered = template.replace(/{{json (\\.[A-Za-z.]*)}}/g, (_, p) => {
  const value = p === '.' ? c : p.slice(1).split('.').reduce((o, k) => o[k], c);
  return JSON.stringify(value);
});
if (rendered.includes('{{')) {
  process.stderr.write('fake docker cannot render: ' + template);
  process.exit(99);
}
process.stdout.write(rendered);
`);
fs.writeFileSync(path.join(DECOY, 'docker'), `#!${process.execPath}\nprocess.stdout.write('DECOY');\n`);
for (const dir of [BIN, DECOY]) fs.chmodSync(path.join(dir, 'docker'), 0o755);

const SEAM = `
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader('dockq', sys.argv[1])
mod = importlib.util.module_from_spec(importlib.util.spec_from_loader('dockq', loader))
loader.exec_module(mod)
mod.DOCKER_DIRS = (sys.argv[2],)
sys.exit(mod.main(sys.argv[3:]))
`;

function dockq(args, env = {}) {
  return run('python3', ['-c', SEAM, DOCKQ, BIN, ...args], { env: { ...process.env, ...env } });
}

test('logs builds a bounded invocation with the name after --', { skip }, () => {
  const r = dockq(['logs', 'web', '--tail', '50', '--since', '30m']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout),
    ['logs', '--tail=50', '--since=30m', '--', 'web']);
});

test('logs refuses an unbounded or missing --tail', { skip }, () => {
  for (const args of [['logs', 'web'], ['logs', 'web', '--tail', '0'],
    ['logs', 'web', '--tail', '5001'], ['logs', 'web', '--tail', 'all']]) {
    const r = dockq(args);
    assert.strictEqual(r.code, 2, args.join(' '));
    assert.strictEqual(r.stdout, '', `${args.join(' ')} reached docker`);
  }
});

test('refuses every write verb and caller-supplied format without starting docker', { skip }, () => {
  const refused = [
    ['run', 'alpine'], ['exec', 'web', 'sh'], ['rm', 'web'], ['stop', 'web'],
    ['pull', 'alpine'], ['build', '.'], ['compose', 'up'], ['compose', 'down'],
    ['inspect', 'web', '--format', '{{json .}}'], ['manifest', 'push', 'x'],
    ['logs', '--', '--privileged', '--tail', '5'],
  ];
  for (const args of refused) {
    const r = dockq(args);
    assert.strictEqual(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.strictEqual(r.stdout, '', `${args.join(' ')} reached docker`);
  }
});

test('inspect output excludes the environment, for every field', { skip }, () => {
  // Read from the tool's own --field choices, so a field added later is covered here
  // without anyone remembering to list it.
  const help = dockq(['inspect', '--help']).stdout.replace(/\s+/g, '');
  const fields = help.match(/--field\{([^}]+)\}/)[1].split(',');
  assert.ok(fields.length >= 5, help);
  const all = dockq(['inspect', 'web', ...fields.flatMap((f) => ['--field', f])]);
  assert.strictEqual(all.code, 0, all.stderr);
  assert.deepStrictEqual(Object.keys(JSON.parse(all.stdout)), fields);
  assert.ok(!all.stdout.includes('canary'), all.stdout);
  const byDefault = dockq(['inspect', 'web']);
  assert.strictEqual(byDefault.code, 0, byDefault.stderr);
  assert.strictEqual(JSON.parse(byDefault.stdout).image, 'nginx:1');
  assert.ok(!byDefault.stdout.includes('canary'), byDefault.stdout);
});

test('the caller cannot choose docker through PATH or aim it at another daemon', { skip }, () => {
  const viaPath = dockq(['ps'], { PATH: `${DECOY}:${process.env.PATH}` });
  assert.strictEqual(viaPath.code, 0, viaPath.stderr);
  assert.deepStrictEqual(JSON.parse(viaPath.stdout), ['ps']);
  const env = dockq(['ps'], { FAKE_DOCKER_ENV: '1', DOCKER_HOST: 'tcp://192.0.2.1:2375' });
  assert.strictEqual(env.code, 0, env.stderr);
  assert.strictEqual(JSON.parse(env.stdout).host, null);
});
