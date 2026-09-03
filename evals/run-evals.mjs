#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs, effectiveK } from './lib/args.mjs';
import { loadAgentFlagOrError, loadSkillFlagOrError } from './lib/load-agent.mjs';
import { loadRulesFlagOrError } from './lib/load-rules.mjs';
import { loadCases, envCaseDirs } from './lib/load-cases.mjs';
import { invokeAgent } from './lib/invoke-agent.mjs';
import { checkAssertions } from './lib/assertions.mjs';
import { judge } from './lib/judge.mjs';
import { gradeFromParts } from './lib/grade.mjs';
import { aggregateCase, overallExitCode, formatReport } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CASES_DIR = join(HERE, 'cases');
const CONCURRENCY = 3;

async function gradeRun(caseDef, agentsFlagCache) {
  if (!agentsFlagCache[caseDef.agent]) {
    const r = caseDef.rules
      ? loadRulesFlagOrError(caseDef.rules, REPO_ROOT)
      : caseDef.skill
        ? loadSkillFlagOrError(caseDef.skill, REPO_ROOT)
        : loadAgentFlagOrError(caseDef.agent, REPO_ROOT);
    if (r.error) return gradeFromParts({ invocation: { status: 'infra_error', reason: r.error } });
    agentsFlagCache[caseDef.agent] = r.flag;
  }
  const invocation = await invokeAgent({ agentsFlag: agentsFlagCache[caseDef.agent], name: caseDef.agent, input: caseDef.input });
  if (invocation.status !== 'ok') return gradeFromParts({ invocation });
  const assertion = checkAssertions(invocation.text, caseDef.assert);
  if (!assertion.pass) return gradeFromParts({ invocation, assertion });
  // A case with no `rubric` is fully regex-gradable (see grade.mjs's needsJudge) — skip
  // the live judge call entirely rather than spend an API call re-deciding what the
  // assertion already decided.
  if (!caseDef.rubric) return gradeFromParts({ invocation, assertion, needsJudge: false });
  const judgeResult = await judge({ rubric: caseDef.rubric, output: invocation.text });
  return gradeFromParts({ invocation, assertion, judgeResult });
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cases = loadCases(opts, [CASES_DIR, ...envCaseDirs()]);
  if (!cases.length) { console.error('no cases matched'); process.exit(2); }
  const agentsFlagCache = {};
  const reports = [];
  for (const c of cases) {
    const k = effectiveK(c, opts);
    const runs = await pool(Array.from({ length: k }), CONCURRENCY, () => gradeRun(c, agentsFlagCache));
    const report = aggregateCase({ ...c, k }, runs);
    report._runs = runs;
    reports.push(report);
    console.log(`${report.status.padEnd(12)} ${c.id}  (${report.passes}/${report.healthy} pass)`);
    for (const r of runs) {
      if (r.status === 'infra_error') console.log(`    infra: ${r.reason}`);
      else if (r.pass === false) console.log(`    fail:  ${r.failures ? r.failures.join('; ') : r.judgeReason}`);
    }
  }
  console.log('\n' + formatReport(reports));
  if (opts.json) writeFileSync(opts.json, JSON.stringify(reports, null, 2));
  process.exit(overallExitCode(reports));
}

main();
