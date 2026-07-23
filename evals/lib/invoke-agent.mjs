import { classifyRun } from './classify.mjs';
import { runClaudeJson, sleep, buildHermeticAgentArgs } from './claude-cli.mjs';

export function buildAgentArgs({ agentsFlag, name, input, maxBudgetUsd }) {
  return buildHermeticAgentArgs({ agentsFlag, name, input, maxBudgetUsd });
}

export async function invokeAgent({ agentsFlag, name, input, maxBudgetUsd = 0.75, timeoutMs = 180000, retries = 2 }) {
  const args = buildAgentArgs({ agentsFlag, name, input, maxBudgetUsd });
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await runClaudeJson(args, { timeoutMs });
    const c = classifyRun(raw);
    last = { ...c, raw };
    if (c.status === 'ok') return last;
    if (attempt < retries) await sleep(1000 * (attempt + 1));
  }
  return last;
}
