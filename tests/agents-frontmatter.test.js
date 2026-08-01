const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { renderTemplate } = require('./lib/render');

// The agents under home/private_dot_claude/agents/ are the task-routing layer: each one
// pins a `model` and an `effort` so dispatching it *is* the model/effort selection. Two
// ways that silently breaks, both checked here:
//   1. An agent pins a model absent from settings.base.json's availableModels. With
//      enforceAvailableModels:true the harness snaps to the first entry instead, so the
//      agent runs on the wrong tier with no error.
//   2. A typo'd `effort` value. It isn't rejected loudly; the pin just doesn't apply.

const REPO = path.join(__dirname, '..');
const AGENTS_DIR = path.join(REPO, 'home', 'private_dot_claude', 'agents');

const FM = /^---\n([\s\S]*?)\n---\n/;
const EFFORT_NAMES = ['low', 'medium', 'high', 'xhigh', 'max'];

function parseFrontmatter(md) {
  const m = FM.exec(md);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

const agentFiles = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));

// Render settings.base.json straight from THIS checkout rather than via the configured
// source dir, so the test reads the availableModels it is committed alongside — a
// worktree's template, not the primary checkout's.
function renderedBaseSettings() {
  return JSON.parse(renderTemplate('{{ includeTemplate "settings.base.json" . }}'));
}

let base = null;
let baseSkip = false;
try {
  base = renderedBaseSettings();
} catch {
  baseSkip = 'chezmoi cannot render this repo\'s templates';
}

test('there is at least one agent to check', () => {
  assert.ok(agentFiles.length > 0, `no agent .md files in ${AGENTS_DIR}`);
});

for (const file of agentFiles) {
  const md = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
  const fm = parseFrontmatter(md);

  test(`${file}: has parseable frontmatter with name and description`, () => {
    assert.ok(fm, `${file} has no YAML frontmatter`);
    assert.strictEqual(fm.name, path.basename(file, '.md'),
      `${file}: frontmatter name "${fm.name}" must match the filename — the harness resolves agents by filename`);
    assert.ok(fm.description && fm.description.length > 40,
      `${file}: description is what makes routing automatic; it must say when to use the agent`);
  });

  test(`${file}: effort, if pinned, is a value the harness accepts`, () => {
    if (fm.effort === undefined) return;
    const asInt = /^\d+$/.test(fm.effort) ? Number(fm.effort) : null;
    const ok = EFFORT_NAMES.includes(fm.effort) || (asInt !== null && asInt >= 1 && asInt <= 1000);
    assert.ok(ok, `${file}: effort "${fm.effort}" is not one of ${EFFORT_NAMES.join('|')} or an integer 1-1000`);
  });

  test(`${file}: model, if pinned, is in availableModels`, { skip: baseSkip }, () => {
    if (fm.model === undefined) return;
    assert.ok(base.availableModels.includes(fm.model),
      `${file}: model "${fm.model}" is absent from availableModels [${base.availableModels.join(', ')}]; ` +
      'enforceAvailableModels would snap it to the first entry instead of erroring');
  });
}

test('settings.base.json leaves effortLevel unpinned', { skip: baseSkip }, () => {
  assert.ok(!('effortLevel' in base),
    'effortLevel is pinned in settings.base.json, which overrides per-turn effort selection for every turn. ' +
    'Absent means auto (the model sizes its own reasoning); re-add only to pin every turn deliberately.');
});
