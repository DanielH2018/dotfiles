import { execFile } from 'node:child_process';

// Shared plumbing for shelling out to the `claude` CLI. Previously the execFile
// wrapper, the arg skeleton, and sleep() were copy-pasted across invoke-agent.mjs,
// judge.mjs, and run-live.mjs — and had drifted (two copies mislabelled every exec
// failure as a 'timeout'). This is the single source of truth.

// Run `claude` with argv and resolve to the parsed JSON result, or a claude-shaped
// error object ({is_error, subtype, result}) that classifyRun() understands. subtype
// distinguishes a kill/timeout (err.killed) from any other exec failure (missing
// binary, non-zero exit) — the old invoke-agent/judge copies hardcoded 'timeout'.
export function runClaudeJson(args, { cwd, timeoutMs, maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile('claude', args, { cwd, timeout: timeoutMs, maxBuffer, encoding: 'utf8' },
      (err, stdout) => {
        if (err && !stdout) {
          resolve({ is_error: true, subtype: err.killed ? 'timeout' : 'exec_error', result: String(err.message || err) });
          return;
        }
        try { resolve(JSON.parse(stdout)); }
        catch { resolve({ is_error: true, subtype: 'parse_error', result: (stdout || '').slice(0, 500) }); }
      });
  });
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Build the hermetic `claude -p` flag skeleton shared by the agent-under-test and the
// judge. `extra` is spliced in after --output-format (the judge passes --json-schema).
// --tools "" is the side-effect guard; --bare is added only with an API key present.
export function buildHermeticAgentArgs({ agentsFlag, name, input, maxBudgetUsd, extra = [] }) {
  const args = [
    '-p', input,
    '--agents', agentsFlag,
    '--agent', name,
    '--output-format', 'json',
    ...extra,
    '--tools', '',
    '--max-budget-usd', String(maxBudgetUsd),
    '--setting-sources', 'project',
    '--strict-mcp-config',
  ];
  if (process.env.ANTHROPIC_API_KEY) args.push('--bare');
  return args;
}
