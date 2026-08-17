import { join } from 'node:path';
import { buildAgentsFlag, renderChezmoiTemplate } from './load-agent.mjs';

// Rules cases grade a section of the real user-level CLAUDE.md, sliced out at eval time.
// The obvious alternative — paste the rules into an agent .md beside the cases — fails
// silently: the copy keeps passing after the source is edited, so the eval grades text
// the model is never actually given.
//
// The harness is hermetic (`--setting-sources project`), so user-level CLAUDE.md never
// reaches a run on its own. This loader is what puts it there, deliberately and in one
// visible place.

const CLAUDE_MD_TMPL = ['home', 'private_dot_claude', 'CLAUDE.md.tmpl'];

// Slug -> the exact heading line to slice out of the rendered CLAUDE.md.
export const RULES_SECTIONS = {
  'sentence-clarity': '### Sentence-level clarity',
};

// Pinned so results don't drift with whatever the session default happens to be;
// same reasoning as SKILL_EVAL_MODEL in load-agent.mjs.
const RULES_EVAL_MODEL = 'opus';

// Identical across both arms. The ONLY difference between treatment and control is
// whether the rules block is appended — anything else here would confound the A/B.
const TASK_PREAMBLE =
  'You are writing prose that a technical operator will read: design docs, review '
  + 'findings, runbook notes. Reply with the requested prose itself — no preamble, no '
  + 'meta-commentary about how you wrote it, and no restating of the task.\n\n';

const RULES_HEADER = 'The writing rules below govern your reply. Follow them exactly.\n\n';

// Slice `heading` out of a markdown document, ending at the next heading of the same or
// a shallower level. Returns the body, without the heading line itself.
export function extractSection(md, heading) {
  const lines = md.split('\n');
  const start = lines.findIndex(l => l.trim() === heading);
  if (start === -1) throw new Error(`section "${heading}" not found`);
  const level = /^#+/.exec(heading)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i]);
    if (m && m[1].length <= level) { end = i; break; }
  }
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!body) throw new Error(`section "${heading}" is empty`);
  return body;
}

// The control arm carries the task framing and nothing else, so a treatment win is
// attributable to the rules text rather than to the framing around it.
export function buildRulesPrompt(slug, repoRoot, render = renderChezmoiTemplate) {
  if (slug === 'control') return TASK_PREAMBLE.trim();
  const heading = RULES_SECTIONS[slug];
  if (!heading) {
    throw new Error(`unknown rules section "${slug}"; known: ${Object.keys(RULES_SECTIONS).join(', ')}`);
  }
  const rendered = render(join(repoRoot, ...CLAUDE_MD_TMPL));
  return TASK_PREAMBLE + RULES_HEADER + extractSection(rendered, heading);
}

// Non-throwing wrapper, matching loadSkillFlagOrError: an unresolvable section becomes a
// per-case infra error rather than killing the sweep.
export function loadRulesFlagOrError(slug, repoRoot, render = renderChezmoiTemplate) {
  try {
    const name = `rules-${slug}`;
    return {
      flag: buildAgentsFlag(
        { name, description: `writing-rules eval arm: ${slug}`, systemPrompt: '', model: null },
        { name, model: RULES_EVAL_MODEL, prompt: buildRulesPrompt(slug, repoRoot, render) },
      ),
    };
  } catch (e) {
    return { error: `rules load failed: ${e.message}` };
  }
}
