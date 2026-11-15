// bin/deployed against throwaway hosts.
//
// Each "host" is a directory standing in for its $HOME, holding a chezmoi checkout at
// .local/share/chezmoi cloned from a bare origin. DEPLOYED_SSH points at a stub that runs
// the remote command with HOME set to that directory, so the probe runs exactly as it
// would over ssh, and nothing reaches the real $HOME or the network.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { repoPath } = require('../lib/paths');
const { run } = require('../lib/run');

const skip = skipUnless('bash', 'git', 'chezmoi');

const CLEAN_ENV = {
  ...Object.fromEntries(Object.entries(process.env)
    .filter(([k]) => !k.startsWith('GIT_') && !k.startsWith('XDG_') && !k.startsWith('CHEZMOI'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: CLEAN_ENV }).trim();
}

const src = (home) => path.join(home, '.local', 'share', 'chezmoi');

function commitFile(repo, content, msg) {
  fs.writeFileSync(path.join(repo, 'dot_file'), content);
  git(repo, 'add', 'dot_file');
  git(repo, '-c', 'user.email=t@example.test', '-c', 'user.name=Test', 'commit', '-qm', msg);
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
  return git(repo, 'rev-parse', 'HEAD');
}

// origin holds two commits. Both hosts hold both and have deployed the second, so the
// fixture starts in the state every test perturbs: fully deployed.
function makeFixture() {
  const base = scratch(os.tmpdir(), 'deployed-');
  const origin = path.join(base, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: CLEAN_ENV });

  const hosts = { alpha: path.join(base, 'alpha'), beta: path.join(base, 'beta') };
  fs.mkdirSync(path.dirname(src(hosts.alpha)), { recursive: true });
  execFileSync('git', ['clone', '-q', origin, src(hosts.alpha)], { env: CLEAN_ENV, stdio: 'ignore' });
  const first = commitFile(src(hosts.alpha), 'one\n', 'first');
  const second = commitFile(src(hosts.alpha), 'two\n', 'second');
  fs.mkdirSync(path.dirname(src(hosts.beta)), { recursive: true });
  execFileSync('git', ['clone', '-q', origin, src(hosts.beta)], { env: CLEAN_ENV, stdio: 'ignore' });
  for (const home of Object.values(hosts)) fs.writeFileSync(path.join(home, '.file'), 'two\n');

  // The script finds origin through its own checkout, so it runs from a copy in alpha's.
  fs.mkdirSync(path.join(src(hosts.alpha), 'bin'));
  const script = path.join(src(hosts.alpha), 'bin', 'deployed');
  fs.copyFileSync(repoPath('bin', 'deployed'), script);

  const ssh = path.join(base, 'fake-ssh');
  fs.writeFileSync(ssh, `#!/usr/bin/env bash
[ "$1" = down ] && { echo "ssh: connect to host down: Connection refused" >&2; exit 255; }
HOME="${base}/$1" exec bash -c "$2"
`, { mode: 0o755 });
  return { base, origin, hosts, first, second, script, ssh };
}

function deployed(f, args, hosts = 'alpha beta') {
  return run('bash', [f.script, ...args], {
    cwd: f.base,
    env: { ...CLEAN_ENV, HOME: f.hosts.alpha, DEPLOYED_HOSTS: hosts, DEPLOYED_SSH: f.ssh },
  });
}

// Splits the report into one block per host, keyed by the host's name.
function blocks(stdout) {
  const out = {};
  for (const chunk of stdout.split('\n\n').slice(1)) {
    const [name, ...rest] = chunk.split('\n');
    out[name] = rest.join('\n');
  }
  return out;
}

test('reports a commit in HEAD and a clean status on every host that deployed it', { skip }, () => {
  const f = makeFixture();
  const r = deployed(f, [f.first, path.join(f.hosts.alpha, '.file')]);
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  const b = blocks(r.stdout);
  for (const host of ['alpha', 'beta']) {
    assert.match(b[host], /on main, at origin\/main/, host);
    assert.match(b[host], new RegExp(`commit +${f.first.slice(0, 8)} is in HEAD`), host);
    assert.match(b[host], /status +clean/, host);
  }
});

test('defaults to origin/main and reports a host whose checkout is behind it', { skip }, () => {
  const f = makeFixture();
  git(src(f.hosts.beta), 'reset', '-q', '--hard', f.first);
  const r = deployed(f, []);
  assert.strictEqual(r.code, 1, r.stdout);
  const b = blocks(r.stdout);
  assert.match(b.alpha, new RegExp(`${f.second.slice(0, 8)} is in HEAD`));
  assert.match(b.beta, /1 behind origin\/main/);
  assert.match(b.beta, new RegExp(`${f.second.slice(0, 8)} is NOT in HEAD`));
  assert.strictEqual(git(src(f.hosts.beta), 'rev-parse', 'HEAD'), f.first, 'the check moved the checkout');
});

test('says origin/main is not fetched when the checkout lacks its object', { skip }, () => {
  const f = makeFixture();
  const third = commitFile(src(f.hosts.alpha), 'three\n', 'third');
  git(src(f.hosts.alpha), 'reset', '-q', '--hard', f.second);
  git(src(f.hosts.alpha), 'update-ref', 'refs/remotes/origin/main', f.second);
  const r = deployed(f, ['-'], 'beta');
  assert.strictEqual(r.code, 1, r.stdout);
  assert.match(r.stdout, /origin\/main's tip is not fetched here/);
  assert.match(r.stdout, new RegExp(`${third.slice(0, 8)} is not in this checkout at all`));
});

test('lists the chezmoi status lines of a named path that drifted', { skip }, () => {
  const f = makeFixture();
  fs.writeFileSync(path.join(f.hosts.beta, '.file'), 'edited by hand\n');
  const r = deployed(f, ['-', path.join(f.hosts.alpha, '.file')]);
  assert.strictEqual(r.code, 1, r.stdout);
  const b = blocks(r.stdout);
  assert.match(b.alpha, /status +clean/);
  assert.match(b.beta, /chezmoi apply would change:\n +M \.file/);
  assert.strictEqual(fs.readFileSync(path.join(f.hosts.beta, '.file'), 'utf8'), 'edited by hand\n',
    'the check applied the source');
});

test('prints a chezmoi warning apart from the status and does not count it as drift', { skip }, () => {
  const f = makeFixture();
  const bin = path.join(f.hosts.beta, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'chezmoi'), `#!/usr/bin/env bash
echo "chezmoi: warning: config file template has changed" >&2
PATH=\${PATH#${bin}:} exec chezmoi "$@"
`, { mode: 0o755 });
  const r = deployed(f, ['-', path.join(f.hosts.alpha, '.file')]);
  assert.strictEqual(r.code, 0, r.stdout);
  const b = blocks(r.stdout);
  assert.match(b.beta, /warning +chezmoi: warning: config file template has changed/);
  assert.match(b.beta, /status +clean/);
});

test('reports an unreachable host and still checks the rest', { skip }, () => {
  const f = makeFixture();
  const r = deployed(f, [], 'down alpha');
  assert.strictEqual(r.code, 1, r.stdout);
  const b = blocks(r.stdout);
  assert.match(b.down, /unreachable \(exit 255\): ssh: connect to host down/);
  assert.match(b.alpha, /is in HEAD/);
});
