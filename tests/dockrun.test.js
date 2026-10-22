// Regression guard for home/dot_local/bin/executable_dockrun.
// dockrun carries a blanket `Bash(dockrun:*)` allow rule on the unsandboxed path, and that
// rule is defensible only while the policy holds: flags on an allowlist, binds confined to
// the repository (read-only) or scratch, no Docker socket, compose models checked the same
// way, and rm/exec/logs limited to containers dockrun labelled.
//
// dockrun looks docker up in fixed system directories, never $PATH, so a fake on PATH would
// not be found. The tests load the script as a module instead and point DOCKER_DIRS and
// scratch_root at fixtures. The fake docker answers the three preflight calls dockrun makes
// (inspect, compose config, ps) from fixture files, and for any other call prints the argv it
// was given. So an empty stdout proves docker was never asked to act.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { srcPath } = require('./lib/paths');
const { run } = require('./lib/run');

const DOCKRUN = srcPath('dot_local', 'bin', 'executable_dockrun');

let skip = false;
try {
  execFileSync('python3', ['--version'], { stdio: 'ignore' });
} catch {
  skip = 'python3 unavailable';
}

const DIR = fs.realpathSync(scratch(os.tmpdir(), 'dockrun-'));
const BIN = path.join(DIR, 'bin');
const SCRATCH = path.join(DIR, 'scratch');
const REPO = path.join(DIR, 'repo');
const OUTSIDE = path.join(DIR, 'outside');
for (const d of [BIN, SCRATCH, OUTSIDE, path.join(REPO, '.git'), path.join(REPO, 'src')]) {
  fs.mkdirSync(d, { recursive: true });
}
fs.writeFileSync(path.join(REPO, 'compose.yaml'), 'services: {}\n');
fs.writeFileSync(path.join(OUTSIDE, 'compose.yaml'), 'services: {}\n');
const MODEL = path.join(DIR, 'model.json');
const PS = path.join(DIR, 'ps.txt');
const LEFTOVERS = path.join(DIR, 'leftovers.txt');
const OWNERS = path.join(DIR, 'owners.json');

fs.writeFileSync(path.join(BIN, 'docker'), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'inspect') {
  const owned = { mine: 'cid123 1', theirs: 'cid456 <no value>' }[args[args.length - 1]];
  if (!owned) process.exit(1);
  process.stdout.write(owned + '\\n');
} else if (args[0] === 'compose' && args.includes('config')) {
  process.stdout.write(fs.readFileSync(${JSON.stringify(MODEL)}, 'utf8'));
} else if (args[0] === 'ps') {
  process.stdout.write(fs.readFileSync(${JSON.stringify(PS)}, 'utf8'));
} else if ((args[0] === 'volume' || args[0] === 'network') && args[1] === 'ls') {
  if (args[0] === 'volume') process.stdout.write(fs.readFileSync(${JSON.stringify(LEFTOVERS)}, 'utf8'));
} else {
  process.stdout.write(JSON.stringify(args));
}
`);
fs.chmodSync(path.join(BIN, 'docker'), 0o755);

const SEAM = `
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader('dockrun', sys.argv[1])
mod = importlib.util.module_from_spec(importlib.util.spec_from_loader('dockrun', loader))
loader.exec_module(mod)
mod.DOCKER_DIRS = (sys.argv[2],)
mod.scratch_root = lambda: sys.argv[3]
mod.ownership_file = lambda: sys.argv[4]
sys.exit(mod.main(sys.argv[5:]))
`;

function dockrun(args, {
  model = { name: 'repo', services: {} }, ps = '', leftovers = '', cwd = REPO,
} = {}) {
  fs.writeFileSync(MODEL, JSON.stringify(model));
  fs.writeFileSync(PS, ps);
  fs.writeFileSync(LEFTOVERS, leftovers);
  return run('python3', ['-c', SEAM, DOCKRUN, BIN, SCRATCH, OWNERS, ...args], { cwd });
}

function argvOf(args, opts) {
  const r = dockrun(args, opts);
  assert.strictEqual(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function assertRefused(args, opts, why) {
  const r = dockrun(args, opts);
  assert.strictEqual(r.code, 2, `${args.join(' ')} was not refused: ${r.stdout}${r.stderr}`);
  assert.strictEqual(r.stdout, '', `${args.join(' ')} reached docker`);
  if (why) assert.match(r.stderr, why, args.join(' '));
}

test('run always adds --rm and the ownership label, and binds the repo read-only', { skip }, () => {
  assert.deepStrictEqual(
    argvOf(['run', '--entrypoint', 'sh', '-v', `${REPO}/src:/w:ro`, '-w', '/w', '-e', 'A=1',
      '-p', '8080:80', 'alpine:3.20', '-c', 'ls']),
    ['run', '--rm', '--label=dev.dockrun.managed=1', '--workdir=/w', '--entrypoint=sh',
      '--env=A=1', '--publish=127.0.0.1:8080:80',
      `--mount=type=bind,source=${REPO}/src,target=/w,readonly`, '--', 'alpine:3.20', '-c', 'ls']);
});

test('run refuses every flag outside its allowlist, in both spellings', { skip }, () => {
  const refused = [
    ['--privileged'], ['--cap-add', 'SYS_ADMIN'], ['--cap-add=SYS_ADMIN'],
    ['--security-opt', 'seccomp=unconfined'], ['--security-opt=apparmor=unconfined'],
    ['--device', '/dev/sda'], ['--device=/dev/sda'], ['--pid', 'host'], ['--pid=host'],
    ['--ipc', 'host'], ['--ipc=host'], ['--uts=host'], ['--userns=host'], ['--cgroupns=host'],
    ['--volumes-from', 'other'], ['--env-file', '.env'], ['--label', 'dev.dockrun.managed=1'],
    ['--net', 'host'], ['--net=host'], ['--mount', 'type=bind,src=/,dst=/h'], ['--sysctl', 'a=b'],
  ];
  for (const flags of refused) assertRefused(['run', ...flags, 'alpine:3.20']);
});

test('run refuses the host or another container network, by value', { skip }, () => {
  for (const net of ['host', 'container:abc']) {
    assertRefused(['run', '--network', net, 'alpine:3.20']);
    assertRefused(['run', `--network=${net}`, 'alpine:3.20']);
  }
  assert.ok(argvOf(['run', '--network', 'mwaa-check', 'alpine:3.20']).includes('--network=mwaa-check'));
});

test('run refuses the Docker socket and binds outside the repo or scratch', { skip }, (t) => {
  const sock = path.join(scratch(SCRATCH, 'sock-', t), 'docker.sock');
  fs.writeFileSync(sock, '');
  assertRefused(['run', '-v', '/var/run/docker.sock:/var/run/docker.sock', 'alpine:3.20'],
    {}, /Docker socket/);
  assertRefused(['run', '-v', `${sock}:/s`, 'alpine:3.20'], {}, /Docker socket/);
  assertRefused(['run', '-v', `${OUTSIDE}:/o:ro`, 'alpine:3.20'], {}, /not under the repository/);
  // A symlink inside the repo is judged by where it points.
  const link = path.join(REPO, 'escape');
  fs.symlinkSync(OUTSIDE, link);
  t.after(() => fs.unlinkSync(link));
  assertRefused(['run', '-v', `${link}:/o:ro`, 'alpine:3.20'], {}, /not under the repository/);
  assertRefused(['run', '-v', 'named:/data', 'alpine:3.20'], {}, /named volume/);
});

test('a writable repo bind may not reach .git or .claude; scratch binds may write', { skip }, (t) => {
  // The sandbox's denyWrite protects only git's and Claude Code's own files inside a repo,
  // so that is all a writable bind has to stay clear of.
  assertRefused(['run', '-v', `${REPO}:/r`, 'alpine:3.20'], {}, /contains '\.git'/);
  assertRefused(['run', '-v', `${REPO}/.git:/g`, 'alpine:3.20'], {}, /inside \.git or \.claude/);
  assert.ok(argvOf(['run', '-v', `${REPO}/src:/s`, 'alpine:3.20'])
    .includes(`--mount=type=bind,source=${REPO}/src,target=/s`));
  // A linked worktree under the main checkout's .claude/worktrees/ is judged from its own
  // root, or no writable bind inside any worktree could pass.
  const wt = path.join(REPO, '.claude', 'worktrees', 'wt');
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  fs.mkdirSync(path.join(REPO, '.git', 'worktrees', 'wt'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${REPO}/.git/worktrees/wt\n`);
  t.after(() => fs.rmSync(path.join(REPO, '.claude'), { recursive: true }));
  assert.strictEqual(dockrun(['run', '-v', `${wt}/src:/s`, 'alpine:3.20'], { cwd: wt }).code, 0);
  const out = scratch(SCRATCH, 'out-', t);
  assert.ok(argvOf(['run', '-v', `${out}:/out`, 'alpine:3.20'])
    .includes(`--mount=type=bind,source=${out},target=/out`));
});

test('run refuses a bind whose tree holds a read-denied file', { skip }, (t) => {
  const dir = scratch(SCRATCH, 'secrets-', t);
  fs.writeFileSync(path.join(dir, '.env.example'), '');
  assert.strictEqual(dockrun(['run', '-v', `${dir}:/d:ro`, 'alpine:3.20']).code, 0);
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=x');
  assertRefused(['run', '-v', `${dir}:/d:ro`, 'alpine:3.20'], {}, /read-denies/);
});

test('rm, exec and logs act by ID only on containers dockrun labelled', { skip }, () => {
  assert.deepStrictEqual(argvOf(['rm', '-f', 'mine']), ['rm', '--force', '--', 'cid123']);
  assert.deepStrictEqual(argvOf(['exec', '-u', 'root', 'mine', 'id']),
    ['exec', '--user=root', '--', 'cid123', 'id']);
  assert.deepStrictEqual(argvOf(['logs', 'mine', '--tail', '50']),
    ['logs', '--tail=50', '--', 'cid123']);
  for (const args of [['rm', 'theirs'], ['exec', 'theirs', 'id'], ['logs', 'nosuch'],
    ['exec', '--privileged', 'mine', 'id']]) {
    assertRefused(args);
  }
});

test('compose passes every file explicitly and checks the resolved model', { skip }, () => {
  assert.deepStrictEqual(argvOf(['compose', '-p', 'repo', 'up', '-d', '--wait', 'web']),
    ['compose', `--file=${REPO}/compose.yaml`, '--project-name=repo', 'up', '--detach', '--wait',
      '--', 'web']);
  assert.deepStrictEqual(argvOf(['compose', 'exec', '-T', 'db', 'psql', '-c', 'select 1']),
    ['compose', `--file=${REPO}/compose.yaml`, 'exec', '-T', '--', 'db', 'psql', '-c', 'select 1']);
});

test('compose refuses a service that asks for what run refuses', { skip }, () => {
  const services = [
    { privileged: true }, { cap_add: ['NET_ADMIN'] }, { security_opt: ['seccomp:unconfined'] },
    { devices: ['/dev/sda:/dev/sda'] }, { network_mode: 'host' }, { pid: 'host' },
    { ipc: 'host' }, { use_api_socket: true }, { provider: { type: 'x' } },
    { volumes: [{ type: 'bind', source: '/var/run/docker.sock', target: '/s' }] },
    { volumes: [{ type: 'bind', source: OUTSIDE, target: '/o', read_only: true }] },
    { volumes: [{ type: 'bind', source: REPO, target: '/r' }] },
    { build: { context: REPO, ssh: ['default'] } },
    { env_file: [{ path: path.join(OUTSIDE, 'x.env') }] },
  ];
  for (const svc of services) {
    assertRefused(['compose', 'up', '-d'], { model: { name: 'repo', services: { a: svc } } });
  }
  assertRefused(['compose', 'up'], { model: { name: 'repo', services: {},
    volumes: { v: { driver_opts: { type: 'none', o: 'bind', device: '/' } } } } });
  assertRefused(['compose', 'up'], { model: { name: 'repo', services: {},
    secrets: { s: { environment: 'GITHUB_TOKEN' } } } });
  // exec runs inside a container the model describes, so it is checked like up. down
  // creates nothing, so a stack whose model fails can still be torn down.
  const privileged = { model: { name: 'repo', services: { a: { privileged: true } } } };
  assertRefused(['compose', 'exec', 'a', 'id'], privileged);
  assert.strictEqual(dockrun(['compose', 'down'], privileged).code, 0);
});

test('compose refuses a file or a project that belongs elsewhere', { skip }, () => {
  assertRefused(['compose', '-f', `${OUTSIDE}/compose.yaml`, 'up'], {}, /not under the repository/);
  assertRefused(['compose', '-p', 'airflow', 'down', '-v'],
    { model: { name: 'airflow', services: {} }, ps: `${OUTSIDE}/compose.yaml\n` },
    /outside this repository/);
  assertRefused(['compose', '-p', 'other', 'down'],
    { model: { name: 'other', services: {} }, ps: `${SCRATCH}/x/compose.yaml\n` },
    /outside this repository/);
  assert.strictEqual(dockrun(['compose', '-p', 'repo', 'down', '-v'],
    { ps: `${REPO}/compose.yaml\n` }).code, 0);
  assertRefused(['compose', 'up'], { cwd: OUTSIDE }, /outside a git repository/);
});

test('a project with volumes but no containers needs a recorded owner', { skip }, (t) => {
  // A stack taken down without -v leaves volumes that carry no compose file, so only
  // dockrun's own record can say whose they are.
  t.after(() => fs.rmSync(OWNERS, { force: true }));
  const other = { model: { name: 'victim', services: {} }, leftovers: 'victim_data\n' };
  assertRefused(['compose', '-p', 'victim', 'down', '-v'], other, /no record/);
  assertRefused(['compose', '-p', 'victim', 'up', '-d'], other, /no record/);
  // An up with nothing left over records the project, so the same leftovers then pass.
  assert.strictEqual(dockrun(['compose', '-p', 'mine', 'up', '-d'],
    { model: { name: 'mine', services: {} } }).code, 0);
  assert.strictEqual(dockrun(['compose', '-p', 'mine', 'down', '-v'],
    { model: { name: 'mine', services: {} }, leftovers: 'mine_data\n' }).code, 0);
});
