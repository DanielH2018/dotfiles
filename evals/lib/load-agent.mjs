import { readFileSync, existsSync } from 'node:fs';
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
