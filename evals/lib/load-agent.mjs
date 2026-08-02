import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const FM = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseAgent(md) {
  const m = FM.exec(md);
  if (!m) throw new Error('agent file has no YAML frontmatter');
  const [, fmBlock, body] = m;
  const fields = {};
  for (const line of fmBlock.split('\n')) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  if (!fields.name) throw new Error('agent frontmatter missing name');
  return {
    name: fields.name,
    model: fields.model || null,
    tools: fields.tools || null,
    description: fields.description || '',
    systemPrompt: body.trim(),
  };
}

export function buildAgentsFlag(parsed, over = {}) {
  const name = over.name || parsed.name;
  const model = over.model !== undefined ? over.model : parsed.model;
  const entry = {
    description: over.description || parsed.description || name,
    prompt: over.prompt || parsed.systemPrompt,
  };
  if (model) entry.model = model;
  return JSON.stringify({ [name]: entry });
}

// Extra agent source dirs, colon-separated, from EVAL_AGENT_DIRS. Empty by default so
// the hermetic/CI path is unchanged; set it to resolve agents whose definitions live
// outside this repo (e.g. the work-laptop-config overlay's `.claude/agents`).
export function envAgentDirs() {
  const raw = process.env.EVAL_AGENT_DIRS;
  return raw ? raw.split(':').filter(Boolean) : [];
}

// Ordered search path: this repo's agents dir first, then any extra dirs.
export function agentSearchDirs(repoRoot, extraDirs = envAgentDirs()) {
  return [join(repoRoot, 'home', 'private_dot_claude', 'agents'), ...extraDirs];
}

export function loadAgentFromRepo(name, repoRoot, extraDirs = envAgentDirs()) {
  const dirs = agentSearchDirs(repoRoot, extraDirs);
  for (const dir of dirs) {
    const flat = join(dir, `${name}.md`);
    if (existsSync(flat)) return parseAgent(readFileSync(flat, 'utf8'));
    const skill = join(dir, name, 'SKILL.md');   // skill dir: <name>/SKILL.md
    if (existsSync(skill)) return parseAgent(readFileSync(skill, 'utf8'));
  }
  throw new Error(
    `agent "${name}" not found in: ${dirs.join(', ')}. ` +
    `If it lives in the work overlay, set EVAL_AGENT_DIRS (e.g. ~/work-laptop-config/.claude/agents).`
  );
}

// Skill cases run a skill's SKILL.md body as a synthetic agent named `skill-<name>`.
// Skills carry no model frontmatter, so the model is pinned here — otherwise results
// would drift with whatever the session default happens to be. Opus, not sonnet:
// skills execute in the main session on the top-tier model, and measured adherence
// differs (grilling's one-question+recommendation contract held ~40% on sonnet).
const SKILL_EVAL_MODEL = 'opus';

// A bare SKILL.md is a document *about* a workflow; without framing, the model treats
// it as inspiration rather than binding instructions (measured: grilling's one-question
// rule held in ~1/5 unframed runs). Mirrors how skills actually load in a session,
// where the harness tells the model to follow the invoked skill exactly.
const SKILL_PREAMBLE =
  'The skill below has just been invoked in a live session. Its instructions govern ' +
  'your reply: follow them exactly, starting with your next turn.\n\n';

// A skill whose source is chezmoi-templated (SKILL.md.tmpl) has to be rendered before it
// can be graded. skill-router became a template in 1d3ff0a and, because this loader only
// looked for SKILL.md, its three cases returned INCONCLUSIVE for eight days. Rendering
// resolves the template against *this machine's* chezmoi data, so a gated skill is graded
// as the variant this machine actually deploys.
export function renderChezmoiTemplate(path) {
  return execFileSync('chezmoi', ['execute-template'], {
    input: readFileSync(path, 'utf8'),
    encoding: 'utf8',
  });
}

export function loadSkillFromRepo(name, repoRoot, render = renderChezmoiTemplate) {
  const dir = join(repoRoot, 'home', 'private_dot_claude', 'skills', name);
  const plain = join(dir, 'SKILL.md');
  if (existsSync(plain)) return parseAgent(readFileSync(plain, 'utf8'));
  const templated = join(dir, 'SKILL.md.tmpl');
  if (existsSync(templated)) return parseAgent(render(templated));
  throw new Error(`skill "${name}" not found at ${plain} or ${templated}`);
}

export function loadSkillFlagOrError(name, repoRoot, render = renderChezmoiTemplate) {
  try {
    const parsed = loadSkillFromRepo(name, repoRoot, render);
    return { flag: buildAgentsFlag(parsed, {
      name: `skill-${name}`,
      model: parsed.model || SKILL_EVAL_MODEL,
      prompt: SKILL_PREAMBLE + parsed.systemPrompt,
    }) };
  } catch (e) {
    return { error: `skill load failed: ${e.message}` };
  }
}

// Non-throwing wrapper around loadAgentFromRepo + buildAgentsFlag: resolves the
// --agents flag JSON, or reports the failure instead of throwing. Lets callers
// (e.g. the eval sweep's concurrency pool) turn an unresolvable agent into a
// per-case infra error rather than an unhandled rejection that kills the sweep.
export function loadAgentFlagOrError(name, repoRoot, extraDirs = envAgentDirs()) {
  try {
    return { flag: buildAgentsFlag(loadAgentFromRepo(name, repoRoot, extraDirs)) };
  } catch (e) {
    return { error: `agent load failed: ${e.message}` };
  }
}
