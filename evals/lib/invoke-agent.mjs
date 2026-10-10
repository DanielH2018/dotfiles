import { classifyRun } from './classify.mjs';
import { runClaudeJson, sleep, buildHermeticAgentArgs } from './claude-cli.mjs';

export function buildAgentArgs({ agentsFlag, name, input, maxBudgetUsd }) {
  return buildHermeticAgentArgs({ agentsFlag, name, input, maxBudgetUsd });
}

export async function invokeAgent({ agentsFlag, name, input, maxBudgetUsd = 0.75, timeoutMs = 180000, retries = 2 }) {
  const args = buildAgentArgs({ agentsFlag, name, input, maxBudgetUsd });
  // costUsd sums every attempt: a retried call is billed for each try.
  let last;
  let costUsd = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await runClaudeJson(args, { timeoutMs });
    const c = classifyRun(raw);
    costUsd += c.costUsd;
    last = { ...c, raw, costUsd };
    if (c.status === 'ok') return last;
    if (attempt < retries) await sleep(1000 * (attempt + 1));
  }
  return last;
}
