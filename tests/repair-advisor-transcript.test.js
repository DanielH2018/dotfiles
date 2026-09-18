// Regression guard for executable_repair-advisor-transcript.py. The script
// rewrites session transcripts in place, so the half that matters most is what
// it leaves ALONE: a false positive would reorder a healthy transcript and take
// out a live session. Offline and deterministic; skips without python3.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { skipUnless } = require('./lib/probe');
const { srcPath } = require('./lib/paths');

const SCRIPT = srcPath('private_dot_claude', 'scripts', 'executable_repair-advisor-transcript.py');

const skip = skipUnless('python3');

const MSG = 'msg_advisor';
const SRVTOOL = 'srvtoolu_test01';

function assistant(uuid, parent, blocks, id = MSG) {
  return { type: 'assistant', uuid, parentUuid: parent, message: { id, role: 'assistant', content: blocks } };
}

function reminder(uuid, parent) {
  return {
    type: 'user',
    uuid,
    parentUuid: parent,
    isMeta: true,
    message: { role: 'user', content: '<system-reminder>\nThe user named this session "X".\n</system-reminder>' },
  };
}

// A transcript whose advisor call is split by N title reminders. N=0 is the
// healthy shape: server_tool_use and advisor_tool_result stay contiguous.
function transcript(reminderCount) {
  const rows = [
    { type: 'user', uuid: 'u0', parentUuid: null, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    assistant('a1', 'u0', [{ type: 'thinking', thinking: '...' }]),
    assistant('a2', 'a1', [{ type: 'server_tool_use', id: SRVTOOL, name: 'advisor' }]),
  ];
  let parent = 'a2';
  for (let i = 0; i < reminderCount; i += 1) {
    rows.push(reminder(`m${i}`, parent));
    parent = `m${i}`;
  }
  rows.push(assistant('a3', parent, [{ type: 'advisor_tool_result', tool_use_id: SRVTOOL, content: 'advice' }]));
  rows.push(assistant('a4', 'a3', [{ type: 'text', text: 'done' }]));
  return rows;
}

function write(rows) {
  const dir = scratch(os.tmpdir(), 'advisor-repair-');
  const file = path.join(dir, '11111111-2222-3333-4444-555555555555.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

function run(file, ...args) {
  const r = spawnSync('python3', [SCRIPT, file, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `script exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

function read(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('a split advisor call is reported as poisoned', { skip }, () => {
  const out = run(write(transcript(4)));
  assert.match(out, /POISONED/);
  assert.match(out, new RegExp(SRVTOOL));
  assert.match(out, /1 poisoned transcript\(s\) out of 1 scanned/);
});

test('a contiguous advisor call is left alone', { skip }, () => {
  const file = write(transcript(0));
  const before = fs.readFileSync(file, 'utf8');
  const out = run(file, '--apply');
  assert.doesNotMatch(out, /POISONED/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.strictEqual(fs.existsSync(`${file}.bak`), false);
});

test('a transcript with no advisor call is left alone', { skip }, () => {
  const file = write([
    { type: 'user', uuid: 'u0', parentUuid: null, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    assistant('a1', 'u0', [{ type: 'text', text: 'hello' }], 'msg_plain'),
  ]);
  const before = fs.readFileSync(file, 'utf8');
  run(file, '--apply');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('--apply moves the reminders after the advisor result and re-stitches parents', { skip }, () => {
  const file = write(transcript(4));
  run(file, '--apply');
  const rows = read(file);

  const kinds = rows.map((r) => (r.isMeta ? 'reminder' : r.message.content[0].type));
  assert.deepStrictEqual(kinds, [
    'text', 'thinking', 'server_tool_use', 'advisor_tool_result',
    'reminder', 'reminder', 'reminder', 'reminder', 'text',
  ]);

  // The advisor result must sit in the same assistant message as its
  // server_tool_use, with nothing wedged between them.
  const srv = rows.findIndex((r) => r.message.content[0].type === 'server_tool_use');
  assert.strictEqual(rows[srv + 1].message.content[0].type, 'advisor_tool_result');
  assert.strictEqual(rows[srv + 1].message.id, rows[srv].message.id);

  // Every entry still threads onto the one before it in the new order.
  for (let i = 1; i < rows.length; i += 1) {
    assert.strictEqual(rows[i].parentUuid, rows[i - 1].uuid, `row ${i} lost its parent`);
  }

  assert.strictEqual(fs.existsSync(`${file}.bak`), true);
});

test('a repaired transcript scans clean and repairing again is a no-op', { skip }, () => {
  const file = write(transcript(4));
  run(file, '--apply');
  const repaired = fs.readFileSync(file, 'utf8');

  const out = run(file);
  assert.doesNotMatch(out, /POISONED/);
  assert.match(out, /0 poisoned transcript\(s\)/);

  run(file, '--apply');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), repaired);
});

test('a single wedged reminder is caught, not just a batch of four', { skip }, () => {
  const out = run(write(transcript(1)));
  assert.match(out, /POISONED/);
});
