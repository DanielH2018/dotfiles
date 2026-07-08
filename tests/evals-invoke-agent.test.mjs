import { test } from 'node:test';
import assert from 'node:assert';
import { buildAgentArgs } from '../evals/lib/invoke-agent.mjs';

test('buildAgentArgs uses -p, --agents/--agent, --tools "" and no --model/--permission-mode', () => {
  const args = buildAgentArgs({ agentsFlag: '{"x":{}}', name: 'x', input: 'go', maxBudgetUsd: 0.5 });
  assert.ok(args.includes('-p'));
  assert.strictEqual(args[args.indexOf('-p') + 1], 'go');
  assert.strictEqual(args[args.indexOf('--agent') + 1], 'x');
  assert.strictEqual(args[args.indexOf('--agents') + 1], '{"x":{}}');
  assert.strictEqual(args[args.indexOf('--output-format') + 1], 'json');
  // side-effect guard is empty --tools, not plan mode:
  assert.strictEqual(args[args.indexOf('--tools') + 1], '');
  assert.ok(!args.includes('--model'));
  assert.ok(!args.includes('--permission-mode'));
  assert.strictEqual(args[args.indexOf('--max-budget-usd') + 1], '0.5');
});

test('buildAgentArgs adds --bare only when ANTHROPIC_API_KEY is set', () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.ok(!buildAgentArgs({ agentsFlag: '{}', name: 'x', input: 'g', maxBudgetUsd: 1 }).includes('--bare'));
  process.env.ANTHROPIC_API_KEY = 'test-key';
  assert.ok(buildAgentArgs({ agentsFlag: '{}', name: 'x', input: 'g', maxBudgetUsd: 1 }).includes('--bare'));
  if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
});
