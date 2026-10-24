// Regression guard for home/dot_local/bin/executable_secretq.
// secretq carries a blanket `Bash(secretq:*)` allow rule while it reads files the Read tool
// is refused, so the rule is defensible only while no subcommand prints a value. The canary
// test is that property: every fixture holds the same canary in each value position, and
// every subcommand over every fixture must keep it out of stdout and stderr. The other tests
// pin what each subcommand does print.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { srcPath } = require('./lib/paths');
const { run } = require('./lib/run');

// SECRETQ_UNDER_TEST lets a mutation check point the suite at an edited copy.
const TOOL = process.env.SECRETQ_UNDER_TEST || srcPath('dot_local', 'bin', 'executable_secretq');

let skip = false;
try {
  execFileSync('python3', ['--version'], { stdio: 'ignore' });
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  skip = 'python3 or git unavailable';
}

// Base64 with no `+` or `/`, so a line of it parses as `NAME=` once its padding is reached.
const CANARY = 'Q0FOQVJZc2VjcmV0dmFsdWU5ODc2NTQzMjEwYWJjZGVm';
const ENC = 'ENC[AES256_GCM,data:aGVsbG8=,iv:aXY=,tag:dGFn,type:str]';
const DIR = scratch(os.tmpdir(), 'secretq-');
const HOME = path.join(DIR, 'home');
fs.mkdirSync(path.join(HOME, '.ssh'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.kube'), { recursive: true });

const FIXTURES = {
  'app.sops.env': `DB_PASSWORD=${ENC}\nLEAKED=${CANARY}\nsops_mac=${ENC}\nsops_version=3.9.0\n`,
  'app.sops.yaml': [
    `db_password: ${ENC}`, 'nested:', `    inner: ${ENC}`, `    leaked: ${CANARY}`,
    `list_key:`, `    - ${ENC}`, 'sops:', `    mac: ${ENC}`, '    version: 3.9.0', '',
  ].join('\n'),
  'app.sops.json': JSON.stringify({ api_key: ENC, nested: { leaked: CANARY }, sops: { mac: ENC } }),
  'plain.env': `TOKEN=${CANARY}\nexport OTHER=${CANARY}\n`,
  'bare.base64': `${CANARY}==\n`,
  'id_ed25519': `-----BEGIN OPENSSH PRIVATE KEY-----\n${CANARY}\n${CANARY}==\n-----END OPENSSH PRIVATE KEY-----\n`,
  'credentials': `[default]\naws_access_key_id = ${CANARY}\naws_secret_access_key=${CANARY}\n`,
  '.netrc': `machine github.com login x password ${CANARY}\n`,
  'plain.json': JSON.stringify({ token: CANARY, sops: 'not-metadata' }),
  'environ': `HOME=/root\0TOKEN=${CANARY}\0`,
  'kubeconfig': [
    'apiVersion: v1', 'kind: Config', 'clusters:', '- cluster:',
    `    certificate-authority-data: ${CANARY}`, '    server: https://127.0.0.1:6443',
    '  name: default', 'contexts:', '- context:', '    cluster: default', '    user: default',
    '  name: default', 'current-context: default', 'users:', '- name: default', '  user:',
    `    client-key-data: ${CANARY}`, `    token: ${CANARY}`, '- name: flow',
    `  user: {token: ${CANARY}}`, '',
  ].join('\n'),
};
for (const [name, body] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(DIR, name), body);
fs.copyFileSync(path.join(DIR, 'kubeconfig'), path.join(HOME, '.kube', 'config'));
fs.writeFileSync(path.join(HOME, '.ssh', 'config'), [
  `# ${CANARY}`, 'Host daniel-box', '    HostName 192.168.1.10', '    User ubuntu',
  '    ControlMaster auto', `    ProxyCommand nc %h %p ${CANARY}`, `    SetEnv TOKEN=${CANARY}`,
  'Host daniel-server', '    HostName 192.168.1.11', '    Port 2222', '',
].join('\n'));

// A repository whose attributes would print the canary through any textconv or smudge
// filter, so `--rev` stays clean only if it reads the blob raw.
const REPO = path.join(DIR, 'repo');
fs.mkdirSync(REPO);
const git = (...args) => execFileSync('git', ['-C', REPO, ...args], {
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t' },
});
git('init', '-q');
fs.copyFileSync(path.join(DIR, 'app.sops.yaml'), path.join(REPO, 'app.sops.yaml'));
fs.writeFileSync(path.join(REPO, '.gitattributes'), '* diff=leak filter=leak\n');
git('add', '.');
git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'x');
git('config', 'diff.leak.textconv', `echo ${CANARY}`);
git('config', 'filter.leak.smudge', `echo ${CANARY}`);

function secretq(args, cwd = DIR) {
  return run('python3', [TOOL, ...args], { cwd, env: { ...process.env, HOME } });
}

test('no subcommand prints a value from any fixture', { skip }, () => {
  const files = [...Object.keys(FIXTURES), '/dev/zero', 'absent'];
  const calls = [];
  for (const f of files) {
    calls.push(['keys', f], ['has', f, 'TOKEN'], ['encrypted', f], ['sha256', f],
      ['kubeconfig', f]);
  }
  calls.push(['ssh-config'], ['ssh-config', 'daniel-box'], ['kubeconfig']);
  for (const sub of ['keys', 'encrypted', 'sha256']) {
    calls.push([sub, '--rev', 'HEAD', 'app.sops.yaml']);
  }
  for (const args of calls) {
    const cwd = args.includes('--rev') ? REPO : DIR;
    const r = secretq(args, cwd);
    assert.ok(!(r.stdout + r.stderr).includes(CANARY.slice(0, 16)), `leaked: ${args.join(' ')}`);
  }
});

test('keys lists only the ciphertext keys of a SOPS file', { skip }, () => {
  assert.deepStrictEqual(secretq(['keys', 'app.sops.env']).stdout.split('\n'),
    ['DB_PASSWORD', '']);
  assert.deepStrictEqual(secretq(['keys', 'app.sops.yaml']).stdout.split('\n'),
    ['db_password', 'list_key', '']);
  assert.deepStrictEqual(secretq(['keys', 'app.sops.json']).stdout.split('\n'), ['api_key', '']);
});

test('keys refuses a file with no SOPS metadata', { skip }, () => {
  for (const f of ['plain.env', 'bare.base64', 'plain.json']) {
    const r = secretq(['keys', f]);
    assert.strictEqual(r.code, 2, f);
    assert.strictEqual(r.stdout, '', f);
  }
});

test('has answers by exit status alone, on any text file', { skip }, () => {
  for (const [f, key, code] of [['app.sops.env', 'DB_PASSWORD', 0], ['app.sops.yaml', 'nested', 0],
    ['plain.env', 'TOKEN', 0], ['plain.env', 'OTHER', 0], ['plain.env', 'MISSING', 1],
    ['bare.base64', 'MISSING', 1]]) {
    const r = secretq(['has', f, key]);
    assert.deepStrictEqual([r.code, r.stdout], [code, ''], `${f} ${key}`);
  }
});

test('encrypted names the plaintext keys and exits 1, or exits 0', { skip }, () => {
  const env = secretq(['encrypted', 'app.sops.env']);
  assert.deepStrictEqual([env.code, env.stdout], [1, 'plaintext: LEAKED\n']);
  const yaml = secretq(['encrypted', 'app.sops.yaml']);
  assert.deepStrictEqual([yaml.code, yaml.stdout], [1, 'plaintext: nested\n']);
  fs.writeFileSync(path.join(DIR, 'clean.sops.env'), `A=${ENC}\nsops_mac=${ENC}\n`);
  assert.strictEqual(secretq(['encrypted', 'clean.sops.env']).code, 0);
  const plain = secretq(['encrypted', 'plain.env']);
  assert.deepStrictEqual([plain.code, plain.stdout], [1, 'plain.env: no SOPS metadata\n']);
});

test('sha256 hashes a SOPS file and refuses a plain one', { skip }, () => {
  const digest = crypto.createHash('sha256').update(FIXTURES['app.sops.env']).digest('hex');
  assert.strictEqual(secretq(['sha256', 'app.sops.env']).stdout, `${digest}  app.sops.env\n`);
  assert.strictEqual(secretq(['sha256', 'plain.env']).code, 2);
});

test('--rev reads the blob git holds, through no filter', { skip }, () => {
  const r = secretq(['keys', '--rev', 'HEAD', 'app.sops.yaml'], REPO);
  assert.deepStrictEqual([r.code, r.stdout], [0, 'db_password\nlist_key\n']);
  for (const args of [['--rev', '-x', 'app.sops.yaml'], ['--rev', 'HEAD', '../x'],
    ['--rev', 'HEAD', '/etc/passwd'], ['--rev', 'HEAD;id', 'app.sops.yaml']]) {
    assert.strictEqual(secretq(['keys', ...args], REPO).code, 2, args.join(' '));
  }
});

test('kubeconfig prints the context, clusters and servers', { skip }, () => {
  assert.deepStrictEqual(secretq(['kubeconfig']).stdout.split('\n'), [
    '    server: https://127.0.0.1:6443', '  name: default', '    cluster: default',
    '    user: default', '  name: default', 'current-context: default', '- name: default',
    '- name: flow', '']);
  assert.strictEqual(secretq(['kubeconfig', 'plain.env']).code, 2);
});

test('ssh-config prints the shown keywords, for one host when named', { skip }, () => {
  assert.deepStrictEqual(secretq(['ssh-config', 'daniel-server']).stdout.split('\n'),
    ['Host daniel-server', '    HostName 192.168.1.11', '    Port 2222', '']);
  assert.ok(secretq(['ssh-config']).stdout.includes('    ControlMaster auto'));
});
