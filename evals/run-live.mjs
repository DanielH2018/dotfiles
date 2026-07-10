#!/usr/bin/env node
// Manual, quarantined live tier. Runs each mode:"live" case from EVAL_CASE_DIRS as
// a REAL `claude -p` invocation (in EVAL_LIVE_CWD, default ~/server) so the skill and
// its parallel subagent dispatch actually run, then grades the final result with the
// same assertion gate + judge as the hermetic runner. Non-deterministic + costly:
// never a CI gate. Usage:
//   EVAL_CASE_DIRS=$HOME/server/evals/cases node evals/run-live.mjs
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { envCaseDirs } from './lib/load-cases.mjs';
import { buildLiveArgs } from './lib/live-args.mjs';
import { classifyRun } from './lib/classify.mjs';
import { checkAssertions } from './lib/assertions.mjs';
import { judge } from './lib/judge.mjs';
import { gradeFromParts } from './lib/grade.mjs';

const CWD = process.env.EVAL_LIVE_CWD || join(process.env.HOME, 'server');

function loadLiveCases() {
  const cases = [];
  for (const root of envCaseDirs()) {
    if (!existsSync(root)) continue;
    for (const agent of readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())) {
      const dir = join(root, agent.name);
      for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
        const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (c.mode === 'live') cases.push(c);
      }
    }
  }
  return cases;
}

function runClaude(args) {
  return new Promise((resolve) => {
    execFile('claude', args, { cwd: CWD, timeout: 600000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err && !stdout) { resolve({ is_error: true, subtype: 'exec_error', result: String(err.message || err) }); return; }
        try { resolve(JSON.parse(stdout)); }
        catch { resolve({ is_error: true, subtype: 'parse_error', result: (stdout || '').slice(0, 500) }); }
      });
  });
}

async function main() {
  const cases = loadLiveCases();
  if (!cases.length) { console.error('no live cases found (set EVAL_CASE_DIRS)'); process.exit(2); }
  let failed = 0;
  for (const c of cases) {
    const raw = await runClaude(buildLiveArgs({ input: c.input }));
    const inv = classifyRun(raw);
    if (inv.status !== 'ok') { console.log(`INFRA  ${c.id}: ${inv.reason}`); failed++; continue; }
    const a = checkAssertions(inv.text, c.assert);
    if (!a.pass) { console.log(`FAIL   ${c.id}: ${a.failures.join('; ')}`); failed++; continue; }
    const j = await judge({ rubric: c.rubric, output: inv.text });
    const g = gradeFromParts({ invocation: inv, assertion: a, judgeResult: j });
    console.log(`${g.pass ? 'PASS ' : 'FAIL '}  ${c.id}: ${g.judgeReason || g.reason || ''}`);
    if (!g.pass) failed++;
  }
  process.exit(failed ? 1 : 0);
}

main();
