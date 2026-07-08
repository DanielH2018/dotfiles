import { execFile } from 'node:child_process';
import { classifyRun } from './classify.mjs';

export function buildAgentArgs({ agentsFlag, name, input, maxBudgetUsd }) {
  const args = [
    '-p', input,
    '--agents', agentsFlag,
    '--agent', name,
    '--output-format', 'json',
    '--tools', '',
    '--max-budget-usd', String(maxBudgetUsd),
    '--setting-sources', 'project',
    '--strict-mcp-config',
  ];
  if (process.env.ANTHROPIC_API_KEY) args.push('--bare');
  return args;
}

function runClaude(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('claude', args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err && !stdout) { resolve({ __timeout: true, reason: String(err.message || err) }); return; }
        try { resolve(JSON.parse(stdout)); }
        catch { resolve({ is_error: true, subtype: 'parse_error', result: (stdout || '').slice(0, 500) }); }
      });
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function invokeAgent({ agentsFlag, name, input, maxBudgetUsd = 0.75, timeoutMs = 180000, retries = 2 }) {
  const args = buildAgentArgs({ agentsFlag, name, input, maxBudgetUsd });
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await runClaude(args, timeoutMs);
    if (raw.__timeout) { last = { status: 'infra_error', text: null, reason: `timeout: ${raw.reason}`, raw }; }
    else {
      const c = classifyRun(raw);
      last = { ...c, raw };
      if (c.status === 'ok') return last;
    }
    if (attempt < retries) await sleep(1000 * (attempt + 1));
  }
  return last;
}
