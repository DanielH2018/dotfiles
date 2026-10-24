// Regression guard for home/dot_local/bin/executable_envq.
// envq carries a blanket `Bash(envq:*)` allow rule while it reads the environment that holds
// a session's credentials, so the rule is defensible only while it prints no credential. The
// canary test puts one canary in every value that must stay hidden: a credential-named
// variable, a session id, a URL with a password, and a long mixed-case token under an
// innocent name.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { srcPath } = require('./lib/paths');
const { run } = require('./lib/run');

const TOOL = process.env.ENVQ_UNDER_TEST || srcPath('dot_local', 'bin', 'executable_envq');

let skip = false;
try {
  execFileSync('python3', ['--version'], { stdio: 'ignore' });
} catch {
  skip = 'python3 unavailable';
}

const CANARY = 'Zx9Canary4f2e';
const ENV = {
  GITHUB_TOKEN: CANARY,
  apiKey: CANARY,
  CLAUDE_CODE_BRIDGE_SESSION_ID: `${CANARY.toLowerCase()}0a1b`,
  DATABASE_URL: `postgres://u:${CANARY}@db/x`,
  INNOCENT_NAME: `${CANARY}${CANARY}`,
  DB_PASSWORDS: 'abc',
  PYTEST_XDIST_AUTO_NUM_WORKERS: '4',
  CLAUDE_CODE_EFFORT_LEVEL: 'high',
  LAND_DEADLINE: '28800s',
  CACHE_DIR: '/var/cache/x',
  TOKENIZERS_PARALLELISM: 'false',
};

function envq(args) {
  return run('python3', [TOOL, ...args], { env: { PATH: process.env.PATH, ...ENV } });
}

test('prints no hidden value, by name or through --names', { skip }, () => {
  for (const args of [Object.keys(ENV), ['--names'], ['--names', 'canary']]) {
    const r = envq(args);
    assert.ok(!(r.stdout + r.stderr).toLowerCase().includes(CANARY.toLowerCase()),
      args.join(' '));
  }
});

test('prints plain values under plain names, and `set` for the rest', { skip }, () => {
  const r = envq(Object.keys(ENV));
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.stdout.split('\n'), [
    'GITHUB_TOKEN set', 'apiKey set', 'CLAUDE_CODE_BRIDGE_SESSION_ID set', 'DATABASE_URL set',
    'INNOCENT_NAME set', 'DB_PASSWORDS set', 'PYTEST_XDIST_AUTO_NUM_WORKERS=4',
    'CLAUDE_CODE_EFFORT_LEVEL=high', 'LAND_DEADLINE=28800s', 'CACHE_DIR=/var/cache/x',
    'TOKENIZERS_PARALLELISM=false', '',
  ]);
});

test('reports unset names with exit 1, and refuses a malformed name', { skip }, () => {
  const r = envq(['NOT_THERE', 'CACHE_DIR']);
  assert.deepStrictEqual([r.code, r.stdout], [1, 'NOT_THERE unset\nCACHE_DIR=/var/cache/x\n']);
  assert.strictEqual(envq(['A;id']).code, 2);
});

test('--names lists matching names only', { skip }, () => {
  assert.deepStrictEqual(envq(['--names', 'xdist|effort']).stdout.split('\n'),
    ['CLAUDE_CODE_EFFORT_LEVEL', 'PYTEST_XDIST_AUTO_NUM_WORKERS', '']);
});
