import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Extra case roots, colon-separated, from EVAL_CASE_DIRS. Empty by default so the
// hermetic/CI path is unchanged; set it to grade cases living outside this repo
// (e.g. ~/server/evals/cases). Mirrors envAgentDirs() in load-agent.mjs.
export function envCaseDirs() {
  const raw = process.env.EVAL_CASE_DIRS;
  return raw ? raw.split(':').filter(Boolean) : [];
}

// Parse every case JSON under each <root>/<agent>/*.json, across all roots, with no
// filtering — callers pick what they want (loadCases skips live + applies the CLI
// filters; the live runner keeps only mode:"live"). Missing roots are skipped.
export function readCaseFiles(caseDirs) {
  const cases = [];
  for (const root of caseDirs) {
    if (!existsSync(root)) continue;
    for (const agent of readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())) {
      const dir = join(root, agent.name);
      for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
        const p = join(dir, f);
        try { cases.push(JSON.parse(readFileSync(p, 'utf8'))); }
        catch (e) { throw new Error(`invalid case JSON in ${p}: ${e.message}`); }
      }
    }
  }
  return cases;
}

export function loadCases(opts, caseDirs) {
  const cases = [];
  for (const c of readCaseFiles(caseDirs)) {
    if (opts.agent && c.agent !== opts.agent) continue;
    if (opts.case && c.id !== opts.case) continue;
    if (c.mode === 'live') continue;   // live cases run via run-live.mjs, not the hermetic runner
    cases.push(c);
  }
  return cases;
}
