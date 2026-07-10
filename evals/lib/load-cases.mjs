import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Extra case roots, colon-separated, from EVAL_CASE_DIRS. Empty by default so the
// hermetic/CI path is unchanged; set it to grade cases living outside this repo
// (e.g. ~/server/evals/cases). Mirrors envAgentDirs() in load-agent.mjs.
export function envCaseDirs() {
  const raw = process.env.EVAL_CASE_DIRS;
  return raw ? raw.split(':').filter(Boolean) : [];
}

export function loadCases(opts, caseDirs) {
  const cases = [];
  for (const root of caseDirs) {
    if (!existsSync(root)) continue;
    for (const agent of readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())) {
      if (opts.agent && agent.name !== opts.agent) continue;
      const dir = join(root, agent.name);
      for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
        const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (opts.case && c.id !== opts.case) continue;
        if (c.mode === 'live') continue;   // live cases run via run-live.mjs, not the hermetic runner
        cases.push(c);
      }
    }
  }
  return cases;
}
