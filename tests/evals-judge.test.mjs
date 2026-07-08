import { test } from 'node:test';
import assert from 'node:assert';
import { buildJudgeArgs, parseVerdict } from '../evals/lib/judge.mjs';

test('buildJudgeArgs pins opus inside --agents and sets --json-schema', () => {
  const args = buildJudgeArgs({ rubric: 'R', output: 'O', maxBudgetUsd: 0.5 });
  const agents = JSON.parse(args[args.indexOf('--agents') + 1]);
  assert.strictEqual(agents.judge.model, 'opus');
  assert.ok(!args.includes('--model'));
  const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  assert.deepStrictEqual(schema.required.sort(), ['pass', 'reason']);
  assert.strictEqual(args[args.indexOf('--tools') + 1], '');
});

test('parseVerdict reads strict JSON', () => {
  const v = parseVerdict('{"pass": true, "reason": "meets all conditions"}');
  assert.strictEqual(v.pass, true);
  assert.match(v.reason, /meets all/);
});

test('parseVerdict throws on garbage', () => {
  assert.throws(() => parseVerdict('not json'));
});
