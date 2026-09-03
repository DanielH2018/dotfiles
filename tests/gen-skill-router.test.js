const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const lib = require('../bin/gen-skill-router-lib.js');

const REPO_ROOT = path.join(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'gen-skill-router');
const TEMPLATE = path.join(
  REPO_ROOT, 'home', 'private_dot_claude', 'skills', 'skill-router', 'SKILL.md.tmpl',
);

// --- lib.parseFrontmatter ----------------------------------------------------------------

test('parseFrontmatter reads a plain scalar description', () => {
  const fm = lib.parseFrontmatter('---\nname: foo\ndescription: does a thing\n---\nbody\n');
  assert.strictEqual(fm.description, 'does a thing');
});

test('parseFrontmatter unwraps a quoted scalar', () => {
  const fm = lib.parseFrontmatter('---\nname: foo\ndescription: "does a thing"\n---\n');
  assert.strictEqual(fm.description, 'does a thing');
});

test('parseFrontmatter folds a ">" block scalar into one line, matching gh-stack/SKILL.md', () => {
  const text = '---\nname: gh-stack\ndescription: >\n  line one\n  line two.\n---\nbody\n';
  const fm = lib.parseFrontmatter(text);
  assert.strictEqual(fm.description, 'line one line two.');
});

test('parseFrontmatter returns null when there is no frontmatter block', () => {
  assert.strictEqual(lib.parseFrontmatter('# just a heading\n'), null);
});

// --- lib.collectSkills ----------------------------------------------------------------

test('collectSkills sorts by name and falls back to a placeholder for a missing description', () => {
  const skills = lib.collectSkills({
    zeta: '---\nname: zeta\ndescription: last one\n---\n',
    alpha: '---\nname: alpha\n---\n',
  });
  assert.deepStrictEqual(skills.map((s) => s.name), ['alpha', 'zeta']);
  assert.match(skills[0].description, /no description/);
  assert.strictEqual(skills[1].description, 'last one');
});

// --- lib.injectGenerated ----------------------------------------------------------------

test('injectGenerated replaces only the content between the markers', () => {
  const template = `before\n${lib.START_MARKER}\nstale\n${lib.END_MARKER}\nafter\n`;
  const out = lib.injectGenerated(template, [{ name: 'x', description: 'y' }]);
  assert.match(out, /^before\n/);
  assert.match(out, /\nafter\n$/);
  assert.match(out, /- \*\*x\*\* — y/);
  assert.doesNotMatch(out, /stale/);
});

test('injectGenerated throws when the markers are missing', () => {
  assert.throws(() => lib.injectGenerated('no markers here', []), /markers .* not found/);
});

// --- lib.stripWorkBlocks -----------------------------------------------------------------

test('stripWorkBlocks removes an inline and a multi-line {{ if .work }} block', () => {
  const text = 'a {{ if .work }}WORK-ONLY{{ end }} b\n{{ if .work }}\nmulti\nline\n{{ end -}}\nc\n';
  const out = lib.stripWorkBlocks(text);
  assert.doesNotMatch(out, /WORK-ONLY/);
  assert.doesNotMatch(out, /multi/);
  assert.match(out, /a  b/);
  assert.match(out, /\nc\n/);
});

// --- lib.findMissingReferences: the red-proof pair --------------------------------------
//
// One reference that resolves (accept), one that doesn't (reject) — a check that only ever
// passes proves nothing (server repo CLAUDE.md's "red-proof pair" convention).

test('findMissingReferences accepts a reference to a real skill/agent/allowlisted name', () => {
  const text = 'See `real-skill` and `real-agent` and `dataviz`.';
  const missing = lib.findMissingReferences(text, ['real-skill'], ['real-agent']);
  assert.deepStrictEqual(missing, []);
});

test('findMissingReferences flags a reference to a skill that does not exist (the renamed/removed case)', () => {
  const text = 'See `renamed-away-skill` for details.';
  const missing = lib.findMissingReferences(text, ['some-other-skill'], []);
  assert.deepStrictEqual(missing, ['renamed-away-skill']);
});

test('findMissingReferences ignores namespaced plugin skills and slash commands', () => {
  const text = 'Use `superpowers:brainstorming` or `/code-review` or `<pr#>` or `Work/Glossary.md`.';
  const missing = lib.findMissingReferences(text, [], []);
  assert.deepStrictEqual(missing, []);
});

// --- End-to-end: the real committed template ---------------------------------------------

test('gen-skill-router --check passes against the committed template right now', () => {
  const out = execFileSync('node', [BIN, '--check'], { encoding: 'utf8' });
  assert.match(out, /is up to date/);
});

test('the committed template already lists every installed skill, byte for byte', () => {
  const fs = require('node:fs');
  const committed = fs.readFileSync(TEMPLATE, 'utf8');
  const skillsDir = path.join(REPO_ROOT, 'home', 'private_dot_claude', 'skills');
  const skillFiles = {};
  for (const ent of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const md = path.join(skillsDir, ent.name, 'SKILL.md');
    const mdTmpl = path.join(skillsDir, ent.name, 'SKILL.md.tmpl');
    const src = fs.existsSync(md) ? md : mdTmpl;
    skillFiles[ent.name] = fs.readFileSync(src, 'utf8');
  }
  const skills = lib.collectSkills(skillFiles);
  const regenerated = lib.injectGenerated(committed, skills);
  assert.strictEqual(regenerated, committed);
});

// The drift-prevention mechanism itself: rename a skill the real committed lane prose
// references (in a FIXTURE copy, not the real skill directory) and assert the check fails
// for that input. Uses `grilling`, which the real template's step-1 lane prose names.
test('gen-skill-router --check fails when a lane-prose reference is missing from the skill set', () => {
  const fs = require('node:fs');
  const committed = fs.readFileSync(TEMPLATE, 'utf8');
  assert.match(committed, /`grilling`/, 'fixture assumes the real template references `grilling`');

  const skillsDir = path.join(REPO_ROOT, 'home', 'private_dot_claude', 'skills');
  const agentsDir = path.join(REPO_ROOT, 'home', 'private_dot_claude', 'agents');
  const realSkillNames = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  const realAgentNames = fs.readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));

  const stripped = lib.stripWorkBlocks(lib.stripGeneratedBlock(committed));
  const before = lib.findMissingReferences(stripped, realSkillNames, realAgentNames);
  assert.deepStrictEqual(before, [], 'sanity: the real skill+agent set resolves every non-work-gated bare reference');

  // Renamed away: the skill set no longer has `grilling` (e.g. it was renamed to
  // `plan-stress-test` and the prose was never updated) — the real drift scenario.
  const after = lib.findMissingReferences(
    stripped, realSkillNames.filter((n) => n !== 'grilling'), realAgentNames,
  );
  assert.ok(after.includes('grilling'), 'a removed/renamed skill still referenced in prose must be flagged');
});

test('bin/gen-skill-router --check fails end-to-end when the on-disk skill set is missing a referenced skill', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-skill-router-'));
  const skillsDir = path.join(stage, 'home', 'private_dot_claude', 'skills');
  const agentsDir = path.join(stage, 'home', 'private_dot_claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(path.join(skillsDir, 'skill-router'), { recursive: true });
  // No `grilling` directory at all — the fixture's own lane prose references it, so the
  // check must fail rather than silently regenerate around the gap.
  fs.writeFileSync(
    path.join(skillsDir, 'skill-router', 'SKILL.md.tmpl'),
    `---\nname: skill-router\ndescription: test fixture\n---\n\n`
    + `Use \`grilling\` to stress-test a plan.\n\n`
    + `${lib.START_MARKER}\n${lib.END_MARKER}\n`,
  );
  // REPO_ROOT inside the wrapper is __dirname/.. , so the copy must land at stage/bin/ for
  // it to resolve stage/home/... the same way the real bin/gen-skill-router resolves
  // this repo's home/... .
  const stageBin = path.join(stage, 'bin');
  fs.mkdirSync(stageBin, { recursive: true });
  fs.copyFileSync(BIN, path.join(stageBin, 'gen-skill-router'));
  fs.copyFileSync(
    path.join(REPO_ROOT, 'bin', 'gen-skill-router-lib.js'),
    path.join(stageBin, 'gen-skill-router-lib.js'),
  );

  assert.throws(() => {
    execFileSync('node', [path.join(stageBin, 'gen-skill-router'), '--check'], {
      encoding: 'utf8', stdio: 'pipe',
    });
  }, (err) => {
    assert.strictEqual(err.status, 1);
    assert.match(err.stderr.toString(), /grilling/);
    return true;
  });

  fs.rmSync(stage, { recursive: true, force: true });
});
