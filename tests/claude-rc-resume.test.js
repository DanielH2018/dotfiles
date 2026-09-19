// Regression guard for home/dot_local/bin/executable_claude-rc-resume.
//
// The script finds a phone-spawned session's transcript by name and resumes it from the
// worktree Claude Code keyed it under. Every case runs against a scratch CLAUDE_CONFIG_DIR
// with `--print`, so nothing here execs claude, and each rule has a pair: one lookup that
// must resolve and one that must refuse.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { srcPath } = require('./lib/paths');

const SCRIPT = srcPath('dot_local', 'bin', 'executable_claude-rc-resume');

const CFG = scratch(os.tmpdir(), 'rc-resume-');
const WT_OLD = path.join(CFG, 'wt', 'bridge-cse_0121AAAA');
const WT_NEW = path.join(CFG, 'wt', 'bridge-cse_0165BBBB');
const OLD = '8f98784d-6083-554c-8fd6-344c2798a48e';
const NEW = '11111111-2222-4333-8444-555555555555';
const GONE = '99999999-2222-4333-8444-555555555555';

function transcript(dir, uuid, cwd, name, mtimeSec) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'user', cwd, message: 'x' }),
    JSON.stringify({ type: 'assistant', cwd, agentName: 'Stale Name' }),
    // the LAST agentName wins: a rename from the app appends a newer record
    JSON.stringify({ type: 'assistant', cwd, agentName: name }),
  ];
  const file = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.utimesSync(file, mtimeSec, mtimeSec);
}

transcript(path.join(CFG, 'projects', 'p-old'), OLD, WT_OLD, 'Bespoke Code Pass', 1000);
transcript(path.join(CFG, 'projects', 'p-new'), NEW, WT_NEW, 'Bespoke Code Pass', 2000);
transcript(path.join(CFG, 'projects', 'p-gone'), GONE, path.join(CFG, 'wt', 'removed'), 'Retired Session', 3000);
// a subagent sidecar beside a session must never be a candidate
fs.writeFileSync(path.join(CFG, 'projects', 'p-old', 'agent-abc123.jsonl'), '{"agentName":"Bespoke Code Pass","cwd":"/nowhere"}\n');
fs.mkdirSync(WT_OLD, { recursive: true });
fs.mkdirSync(WT_NEW, { recursive: true });

function run(...args) {
  const res = spawnSync('python3', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CFG },
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

test('a name resolves to the newest transcript carrying it, and cds into its recorded cwd', () => {
  const r = run('--print', 'bespoke code pass');
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, `cd ${WT_NEW}\nclaude --resume ${NEW}\n`);
  assert.match(r.err, /2 transcripts match/);
  assert.match(r.err, new RegExp(OLD));
});

test('a claude.ai session id resolves through the worktree path, not the name', () => {
  const r = run('--print', 'cse_0121AAAA');
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, `cd ${WT_OLD}\nclaude --resume ${OLD}\n`);
});

test('a transcript uuid resolves to exactly that transcript', () => {
  const r = run('--print', OLD);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`--resume ${OLD}`));
  assert.doesNotMatch(r.err, /transcripts match/);
});

test('arguments after -- reach claude', () => {
  const r = run('--print', OLD, '--', '--model', 'opus');
  assert.strictEqual(r.out.split('\n')[1], `claude --resume ${OLD} --model opus`);
});

test('an unknown name is refused, not resolved to something else', () => {
  const r = run('--print', 'No Such Session');
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /no transcript matches/);
  assert.strictEqual(r.out, '');
});

test('a session whose worktree was removed is refused by name', () => {
  const r = run('--print', 'Retired Session');
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /is gone; the worktree was removed/);
});

test('--list prints candidates newest first and skips subagent sidecars', () => {
  const r = run('--list');
  assert.strictEqual(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.strictEqual(lines.length, 3);
  assert.match(lines[0], /Retired Session/);
  assert.match(lines[1], new RegExp(NEW));
  assert.match(lines[2], new RegExp(OLD));
  assert.doesNotMatch(r.out, /nowhere/);
});
