import { buildAgentsFlag } from './load-agent.mjs';
import { classifyRun } from './classify.mjs';
import { runClaudeJson, sleep, buildHermeticAgentArgs } from './claude-cli.mjs';

const JUDGE_PROMPT =
  'You are a strict evaluation judge. You are given a RUBRIC and an agent OUTPUT. ' +
  'Decide whether the OUTPUT satisfies EVERY condition in the RUBRIC. ' +
  'Pass only if all conditions hold. Respond ONLY via the structured output schema.';

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: { pass: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['pass', 'reason'],
  additionalProperties: false,
});

export function buildJudgeArgs({ rubric, output, maxBudgetUsd }) {
  const agentsFlag = buildAgentsFlag({ name: 'judge', description: 'eval judge', systemPrompt: JUDGE_PROMPT, model: 'opus' });
  const input = `RUBRIC:\n${rubric}\n\n---\nAGENT OUTPUT:\n${output}`;
  return buildHermeticAgentArgs({ agentsFlag, name: 'judge', input, maxBudgetUsd, extra: ['--json-schema', SCHEMA] });
}

export function parseVerdict(text) {
  const v = JSON.parse(text);
  if (typeof v.pass !== 'boolean') throw new Error('verdict missing boolean pass');
  return { pass: v.pass, reason: String(v.reason ?? '') };
}

export async function judge({ rubric, output, maxBudgetUsd = 0.5, timeoutMs = 120000, retries = 2 }) {
  const args = buildJudgeArgs({ rubric, output, maxBudgetUsd });
  let last = { status: 'infra_error', verdict: null, reason: 'not run' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await runClaudeJson(args, { timeoutMs });
    const c = classifyRun(raw);
    if (c.status === 'ok') {
      try { return { status: 'ok', verdict: parseVerdict(c.text), reason: null }; }
      catch (e) { last = { status: 'infra_error', verdict: null, reason: `verdict parse failed: ${e.message}` }; }
    } else {
      last = { status: 'infra_error', verdict: null, reason: c.reason };
    }
    if (attempt < retries) await sleep(1000 * (attempt + 1));
  }
  return last;
}
