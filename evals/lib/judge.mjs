import { execFile } from 'node:child_process';
import { buildAgentsFlag } from './load-agent.mjs';
import { classifyRun } from './classify.mjs';

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
  const args = [
    '-p', input,
    '--agents', agentsFlag,
    '--agent', 'judge',
    '--output-format', 'json',
    '--json-schema', SCHEMA,
    '--tools', '',
    '--max-budget-usd', String(maxBudgetUsd),
    '--setting-sources', 'project',
    '--strict-mcp-config',
  ];
  if (process.env.ANTHROPIC_API_KEY) args.push('--bare');
  return args;
}

export function parseVerdict(text) {
  const v = JSON.parse(text);
  if (typeof v.pass !== 'boolean') throw new Error('verdict missing boolean pass');
  return { pass: v.pass, reason: String(v.reason ?? '') };
}

function runClaude(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('claude', args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err && !stdout) { resolve({ is_error: true, subtype: 'timeout', result: String(err.message || err) }); return; }
        try { resolve(JSON.parse(stdout)); }
        catch { resolve({ is_error: true, subtype: 'parse_error', result: (stdout || '').slice(0, 500) }); }
      });
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function judge({ rubric, output, maxBudgetUsd = 0.5, timeoutMs = 120000, retries = 2 }) {
  const args = buildJudgeArgs({ rubric, output, maxBudgetUsd });
  let last = { status: 'infra_error', verdict: null, reason: 'not run' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await runClaude(args, timeoutMs);
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
