import { readFileSync } from 'node:fs';
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

export function loadAgentFromRepo(name, repoRoot) {
  const p = join(repoRoot, 'home', 'private_dot_claude', 'agents', `${name}.md`);
  return parseAgent(readFileSync(p, 'utf8'));
}
