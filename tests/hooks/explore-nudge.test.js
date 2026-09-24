// The explore nudge fires on the third consecutive Grep/Glob/Read call of a turn, once
// per run, and never inside a subagent. Each case is a transcript tail plus the payload
// of the call about to run.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_explore-nudge.sh');
const DIR = scratch(os.tmpdir(), 'explore-nudge-');

const prompt = (text) => ({ message: { role: 'user', content: text } });
const call = (name, id) => ({
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
});
const result = (id) => ({
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] },
});
// A call and its result, as a finished step.
const step = (name, id) => [call(name, id), result(id)];

let n = 0;
function run(records, payload = {}, env = {}) {
  const transcript = path.join(DIR, `t${n++}.jsonl`);
  // A leading line, because the hook drops the first line of its tail as a cut record.
  const lines = [{ type: 'header' }, ...records].map((r) => JSON.stringify(r));
  fs.writeFileSync(transcript, `${lines.join('\n')}\n`);
  const e = { ...process.env };
  delete e.CLAUDE_EXPLORE_NUDGE;
  Object.assign(e, env);
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ tool_name: 'Grep', tool_use_id: 'now', transcript_path: transcript, ...payload }),
    env: e,
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, `hook exits 0 (stderr: ${r.stderr})`);
  const out = r.stdout.trim();
  return out ? JSON.parse(out).hookSpecificOutput.additionalContext : '';
}

test('the third search in a row is nudged', () => {
  const ctx = run([prompt('where is X?'), ...step('Grep', 'a'), ...step('Read', 'b')]);
  assert.match(ctx, /\[explore-nudge\]/);
});

test('the second search in a row is not', () => {
  assert.strictEqual(run([prompt('where is X?'), ...step('Grep', 'a')]), '');
});

test('the fourth search in the same run stays quiet: one nudge per run', () => {
  assert.strictEqual(run([prompt('q'), ...step('Grep', 'a'), ...step('Glob', 'b'), ...step('Read', 'c')]), '');
});

test('a non-exploratory call resets the run', () => {
  assert.strictEqual(run([prompt('q'), ...step('Grep', 'a'), ...step('Agent', 'b'), ...step('Grep', 'c')]), '');
});

test('the operator prompt resets the run', () => {
  assert.strictEqual(run([...step('Grep', 'a'), ...step('Grep', 'b'), prompt('new question')]), '');
});

test('a call already in the transcript counts by its own position', () => {
  // Three parallel Greps, all written before the hooks fire: only the third is nudged.
  const records = [prompt('q'), call('Grep', 'a'), call('Grep', 'b'), call('Grep', 'now')];
  assert.match(run(records), /\[explore-nudge\]/);
  assert.strictEqual(run(records, { tool_use_id: 'b' }), '');
});

test('a subagent is never nudged', () => {
  assert.strictEqual(run([prompt('q'), ...step('Grep', 'a'), ...step('Grep', 'b')], { agent_id: 'ag1' }), '');
});

test('CLAUDE_EXPLORE_NUDGE=0 silences the hook', () => {
  assert.strictEqual(run([prompt('q'), ...step('Grep', 'a'), ...step('Grep', 'b')], {}, { CLAUDE_EXPLORE_NUDGE: '0' }), '');
});
