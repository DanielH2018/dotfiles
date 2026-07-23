#!/usr/bin/env node
// Manual, quarantined live tier. Runs each mode:"live" case from EVAL_CASE_DIRS as
// a REAL `claude -p` invocation (in EVAL_LIVE_CWD, default ~/server) so the skill and
// its parallel subagent dispatch actually run, then grades the final result with the
// same assertion gate + judge as the hermetic runner. Non-deterministic + costly:
// never a CI gate. Usage:
//   EVAL_CASE_DIRS=$HOME/server/evals/cases node evals/run-live.mjs
import { join } from 'node:path';
import { envCaseDirs, readCaseFiles } from './lib/load-cases.mjs';
import { buildLiveArgs } from './lib/live-args.mjs';
import { runClaudeJson } from './lib/claude-cli.mjs';
import { classifyRun } from './lib/classify.mjs';
import { checkAssertions } from './lib/assertions.mjs';
import { judge } from './lib/judge.mjs';
import { gradeFromParts } from './lib/grade.mjs';

const CWD = process.env.EVAL_LIVE_CWD || join(process.env.HOME, 'server');

function loadLiveCases() {
  return readCaseFiles(envCaseDirs()).filter(c => c.mode === 'live');
}

async function main() {
  const cases = loadLiveCases();
  if (!cases.length) { console.error('no live cases found (set EVAL_CASE_DIRS)'); process.exit(2); }
  let failed = 0;
  for (const c of cases) {
    const raw = await runClaudeJson(buildLiveArgs({ input: c.input }), { cwd: CWD, timeoutMs: 600000, maxBuffer: 64 * 1024 * 1024 });
    const inv = classifyRun(raw);
    if (inv.status !== 'ok') { console.log(`INFRA  ${c.id}: ${inv.reason}`); failed++; continue; }
    const a = checkAssertions(inv.text, c.assert);
    if (!a.pass) { console.log(`FAIL   ${c.id}: ${a.failures.join('; ')}`); failed++; continue; }
    const j = await judge({ rubric: c.rubric, output: inv.text });
    const g = gradeFromParts({ invocation: inv, assertion: a, judgeResult: j });
    if (g.status !== 'ok') { console.log(`INFRA  ${c.id}: ${g.reason || 'judge infra error'}`); failed++; continue; }
    console.log(`${g.pass ? 'PASS ' : 'FAIL '}  ${c.id}: ${g.judgeReason || ''}`);
    if (!g.pass) failed++;
  }
  process.exit(failed ? 1 : 0);
}

main();
