// Regression guard for home/dot_local/bin/executable_killown.
// killown carries a blanket `Bash(killown:*)` allow rule, which is defensible only while it
// signals nothing outside the session that runs it. The tests build two real stand-in
// sessions: a copy of bash at `<tmp>/claude/versions/9.9.9` plays Claude Code, since killown
// recognises Claude by that executable path, and it starts a shell carrying session id A or
// B, as Claude starts the Bash tool's shell. Targets are real sleeping processes, one of
// them detached with setsid so that it leaves the tree.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { srcPath } = require('./lib/paths');

const TOOL = process.env.KILLOWN_UNDER_TEST || srcPath('dot_local', 'bin', 'executable_killown');

let skip = process.platform === 'linux' ? false : 'killown reads /proc';
try {
  execFileSync('python3', ['--version'], { stdio: 'ignore' });
} catch {
  skip = 'python3 unavailable';
}

const DIR = scratch(os.tmpdir(), 'killown-');
const CLAUDE = path.join(DIR, 'claude', 'versions', '9.9.9');
fs.mkdirSync(path.dirname(CLAUDE), { recursive: true });
if (!skip) fs.copyFileSync('/bin/bash', CLAUDE);
fs.chmodSync(CLAUDE, 0o755);
const started = [];

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z');
  } catch {
    return false;
  }
};
const waitFor = (file) => {
  for (let i = 0; i < 200 && !fs.existsSync(file); i++) execFileSync('sleep', ['0.05']);
  return fs.readFileSync(file, 'utf8').trim().split(/\s+/).map(Number);
};

// A stand-in session: Claude (the bash copy) runs a shell with `id`, the shell starts a
// matching target and a detached one, records their PIDs, and waits.
function session(id, tag) {
  const pids = path.join(DIR, `${tag}.pids`);
  const shell = path.join(DIR, `${tag}.sh`);
  fs.writeFileSync(shell, [
    'sleep 300 & t=$!',
    `setsid sh -c 'sleep 301 & echo $! > ${pids}.detached' &`,
    `while [ ! -s ${pids}.detached ]; do sleep 0.05; done`,
    `echo $$ $t $(cat ${pids}.detached) > ${pids}`,
    'exec sleep 302',
    '',
  ].join('\n'));
  // `sleep 299` is Claude's own direct child carrying the id, as an MCP server is.
  const claude = spawn(CLAUDE, ['-c',
    `sleep 299 & echo $! > ${pids}.server; bash ${shell}; exec sleep 303`], {
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: id }, stdio: 'ignore',
  });
  started.push(claude.pid);
  const [sh, target, detached] = waitFor(pids);
  const [server] = waitFor(`${pids}.server`);
  started.push(sh, target, detached, server);
  return { claude: claude.pid, shell: sh, target, detached, server };
}

// Runs killown from a fresh shell under `s`'s Claude stand-in, the way the Bash tool would:
// Claude -> shell carrying the session id -> killown.
function killownIn(s, args, env = {}) {
  const out = path.join(DIR, `run-${Date.now()}-${Math.random()}`);
  const exports = Object.entries(env).map(([k, v]) => `export ${k}='${v}'\n`).join('');
  fs.writeFileSync(`${out}.inner`, `${exports}python3 ${TOOL} ${args.map((a) => `'${a}'`)
    .join(' ')} > ${out}.o 2> ${out}.e\necho $? > ${out}\n`);
  // Claude -> the shell it started -> a shell whose own command line holds `killown-marker`
  // -> killown. Only the ancestor rule spares that middle shell.
  fs.writeFileSync(`${out}.sh`, `bash -c '. ${out}.inner' killown-marker\n`);
  spawn(CLAUDE, ['-c', `bash ${out}.sh; true`], {
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: s.id }, stdio: 'ignore',
  });
  const [code] = waitFor(out);
  return { code, stdout: fs.readFileSync(`${out}.o`, 'utf8'), stderr: fs.readFileSync(`${out}.e`, 'utf8') };
}

after(() => {
  for (const pid of started) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('signals this session\'s matching processes, detached ones included, and nothing else',
  { skip }, () => {
    const a = { ...session('session-a', 'a'), id: 'session-a' };
    const b = { ...session('session-b', 'b'), id: 'session-b' };
    const r = killownIn(a, ['^sleep 30[01]$']);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`signalled ${a.target} sleep`));
    execFileSync('sleep', ['0.3']);
    assert.ok(!alive(a.target), 'A target survived');
    assert.ok(!alive(a.detached), 'A detached target survived');
    for (const [name, pid] of [['B target', b.target], ['B detached', b.detached],
      ['A claude', a.claude], ['A shell', a.shell], ['B claude', b.claude]]) {
      assert.ok(alive(pid), `${name} was signalled`);
    }
  });

test('a forged session id in killown\'s own environment changes nothing', { skip }, () => {
  const a = { ...session('session-c', 'c'), id: 'session-c' };
  const b = { ...session('session-d', 'd'), id: 'session-d' };
  const r = killownIn(a, ['--dry-run', '^sleep 30[01]$'], { CLAUDE_CODE_SESSION_ID: 'session-d' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`would signal ${a.target} `), r.stdout);
  assert.ok(!r.stdout.includes(`${b.target} `), 'targeted the forged session');
});

test('never signals its own invoking shell, though its command line holds PATTERN', { skip }, () => {
  const a = { ...session('session-e', 'e'), id: 'session-e' };
  const r = killownIn(a, ['--dry-run', 'killown']);
  assert.ok(!/would signal \d+ (bash|python3)/.test(r.stdout), r.stdout);
  assert.ok(alive(a.target));
});

test('never signals a direct child of Claude, such as an MCP server', { skip }, () => {
  const a = { ...session('session-g', 'g'), id: 'session-g' };
  const r = killownIn(a, ['^sleep 299$']);
  assert.strictEqual(r.code, 1, r.stdout);
  assert.ok(alive(a.server));
});

test('refuses an empty pattern and a match wider than --max', { skip }, () => {
  const a = { ...session('session-f', 'f'), id: 'session-f' };
  assert.strictEqual(killownIn(a, ['  ']).code, 2);
  assert.strictEqual(killownIn(a, ['--max', '0', '^sleep 300$']).code, 2);
  assert.ok(alive(a.target));
});
