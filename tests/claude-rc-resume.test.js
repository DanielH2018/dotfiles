// Regression guard for home/dot_local/bin/executable_claude-rc-resume.
//
// The script finds a phone-spawned session's transcript by name and resumes it from the
// worktree Claude Code keyed it under. Every case runs against a scratch CLAUDE_CONFIG_DIR
// with `--print`, `--list` or `--show`, so nothing here execs claude or fzf, and each rule
// has a pair: one lookup that must resolve and one that must refuse.
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
const WT_PLAIN = path.join(CFG, 'repo');
const OLD = '8f98784d-6083-554c-8fd6-344c2798a48e';
const NEW = '11111111-2222-4333-8444-555555555555';
const GONE = '99999999-2222-4333-8444-555555555555';
const PUBLISHED = '22222222-2222-4333-8444-555555555555';
const LOCAL = '33333333-2222-4333-8444-555555555555';
const UNTITLED = '44444444-2222-4333-8444-555555555555';
const MOVED = '55555555-2222-4333-8444-555555555555';
const BLANK = '77777777-2222-4333-8444-555555555555';
const STAYED = '66666666-2222-4333-8444-555555555555';
const WT_ENTERED = path.join(CFG, 'wt', 'entered-later');
// How Claude Code names a project directory after a cwd.
const projectKey = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

const enqueue = (content) => ({ type: 'queue-operation', operation: 'enqueue', content });

function transcript(dir, uuid, cwd, mtimeSec, records) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: 'user', cwd, message: 'x' }), ...records.map((r) => JSON.stringify(r))];
  const file = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.utimesSync(file, mtimeSec, mtimeSec);
}

// the LAST agentName wins: a rename from the app appends a newer record
const named = (name) => [{ type: 'assistant', agentName: 'Stale Name' }, { type: 'assistant', agentName: name }];

transcript(path.join(CFG, 'projects', 'p-old'), OLD, WT_OLD, 1000, named('Bespoke Code Pass'));
transcript(path.join(CFG, 'projects', 'p-new'), NEW, WT_NEW, 2000, named('Bespoke Code Pass'));
transcript(path.join(CFG, 'projects', 'p-gone'), GONE, path.join(CFG, 'wt', 'bridge-cse_01GONE'), 3000, named('Retired Session'));
// RC by its bridgeSessionId record, in a plain directory; customTitle outranks agentName
transcript(path.join(CFG, 'projects', 'p-plain'), PUBLISHED, WT_PLAIN, 2500, [
  { type: 'bridge-session', bridgeSessionId: 'cse_01PUBLISHED' },
  { type: 'custom-title', customTitle: 'Renamed In App' },
  ...named('Agent Default'),
]);
// not a Remote Control session at all
transcript(path.join(CFG, 'projects', 'p-plain'), LOCAL, WT_PLAIN, 2600, named('Local Only'));
// RC, untitled: the label is the first prompt the user typed, not the harness's enqueue
transcript(path.join(CFG, 'projects', 'p-untitled'), UNTITLED, WT_NEW, 1500, [
  enqueue('<task-notification>harness text</task-notification>'),
  enqueue([{ type: 'text', text: 'Fix the flaky\nbackup monitor' }]),
  enqueue('a later prompt'),
]);
// A phone session that entered a worktree: Claude Code moved the transcript into the new
// cwd's project directory, and resume must start there. One that was not moved resumes from
// the directory it was keyed under. Both stay RC by the bridge worktree they started in.
const entered = (dir, uuid, mtimeSec) =>
  transcript(dir, uuid, path.join(CFG, 'wt', 'bridge-cse_01ENTERED'), mtimeSec, [{ type: 'user', cwd: WT_ENTERED }, ...named('Entered Later')]);
entered(path.join(CFG, 'projects', projectKey(WT_ENTERED)), MOVED, 500);
entered(path.join(CFG, 'projects', projectKey(path.join(CFG, 'wt', 'bridge-cse_01ENTERED'))), STAYED, 400);
// RC, but with no title and no prompt: nothing a reader could recognise it by
transcript(path.join(CFG, 'projects', 'p-blank'), BLANK, WT_NEW, 600, []);
// a subagent sidecar beside a session must never be a candidate
fs.writeFileSync(path.join(CFG, 'projects', 'p-old', 'agent-abc123.jsonl'), '{"agentName":"Bespoke Code Pass","cwd":"/nowhere"}\n');
for (const d of [WT_OLD, WT_NEW, WT_PLAIN, WT_ENTERED]) fs.mkdirSync(d, { recursive: true });

function run(...args) {
  const res = spawnSync('python3', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CFG },
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

const ids = (out) => out.trim().split('\n').filter(Boolean).map((l) => l.trim().split(/\s+/)[1]);
const short = (uuid) => uuid.slice(0, 8);

test('a name resolves to the newest transcript carrying it, and cds into its recorded cwd', () => {
  const r = run('--print', 'bespoke code pass');
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, `cd ${WT_NEW}\nclaude --resume ${NEW}\n`);
  assert.match(r.err, /2 transcripts match/);
  assert.match(r.err, new RegExp(short(OLD)));
});

test('a claude.ai session id resolves through the worktree path, not the name', () => {
  const r = run('--print', 'cse_0121AAAA');
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, `cd ${WT_OLD}\nclaude --resume ${OLD}\n`);
});

test('a claude.ai session id also resolves through a bridgeSessionId record', () => {
  const r = run('--print', 'cse_01PUBLISHED');
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, `cd ${WT_PLAIN}\nclaude --resume ${PUBLISHED}\n`);
});

test('a transcript uuid resolves to exactly that transcript', () => {
  const r = run('--print', OLD);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`--resume ${OLD}`));
  assert.doesNotMatch(r.err, /transcripts match/);
});

test('an 8-character uuid prefix resolves, and a 7-character one does not', () => {
  assert.match(run('--print', short(OLD)).out, new RegExp(`--resume ${OLD}`));
  const r = run('--print', OLD.slice(0, 7));
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /no transcript matches/);
});

test('a customTitle matches by name, and so does the agentName it outranks', () => {
  assert.match(run('--print', 'renamed in app').out, new RegExp(`--resume ${PUBLISHED}`));
  assert.match(run('--print', 'Agent Default').out, new RegExp(`--resume ${PUBLISHED}`));
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

test('--list shows titled Remote Control sessions oldest first, newest last, and skips sidecars', () => {
  const r = run('--list');
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(ids(r.out), [STAYED, MOVED, OLD, UNTITLED, NEW, PUBLISHED, GONE].map(short));
  assert.match(r.out, /Renamed In App/);
  assert.match(r.out, /\(gone\)\s+Retired Session/);
  assert.doesNotMatch(r.out, /nowhere|Local Only|untitled, no prompt recorded/);
  assert.match(r.err, /2 more are not Remote Control sessions or have no title or prompt; --all shows them/);
});

test('--list --all adds non-RC sessions and ones with no title or prompt', () => {
  const r = run('--list', '--all');
  assert.deepStrictEqual(ids(r.out), [STAYED, MOVED, BLANK, OLD, UNTITLED, NEW, PUBLISHED, LOCAL, GONE].map(short));
  assert.match(r.out, /untitled, no prompt recorded/);
});

test('a session that entered a worktree resumes from the directory its transcript is keyed under', () => {
  assert.strictEqual(run('--print', short(MOVED)).out.split('\n')[0], `cd ${WT_ENTERED}`);
  const r = run('--print', short(STAYED));
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /bridge-cse_01ENTERED is gone/);
});

test('an untitled session is labelled by its first typed prompt, on one line', () => {
  const r = run('--list');
  assert.match(r.out, /"Fix the flaky backup monitor"/);
  assert.doesNotMatch(r.out, /task-notification|a later prompt/);
});

test('--list WORDS keeps only rows containing every word, prompts included', () => {
  assert.deepStrictEqual(ids(run('--list', 'flaky', 'monitor').out), [short(UNTITLED)]);
  assert.deepStrictEqual(ids(run('--list', 'flaky', 'bespoke').out), []);
});

test('--limit keeps the newest rows and says how many older ones it left out', () => {
  const r = run('--list', '--limit', '2');
  assert.deepStrictEqual(ids(r.out), [PUBLISHED, GONE].map(short));
  assert.match(r.err, /5 older not shown/);
});

test('--show prints the ids, cwd and prompts of one session', () => {
  const r = run('--show', short(PUBLISHED));
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /claude\.ai id: cse_01PUBLISHED/);
  assert.match(r.out, new RegExp(`cwd: +${WT_PLAIN}`));
  assert.match(run('--show', short(UNTITLED)).out, /first prompt:\n {2}Fix the flaky\nbackup monitor/);
});

test('with no key and no terminal it refuses rather than opening a picker', () => {
  const r = run();
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /is needed/);
});
