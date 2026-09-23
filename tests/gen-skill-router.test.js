const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const lib = require('../bin/gen-skill-router-lib.js');
const { srcPath, repoPath } = require('./lib/paths');

const BIN = repoPath('bin', 'gen-skill-router');
const TEMPLATE = srcPath('private_dot_claude', 'skills', 'skill-router', 'SKILL.md.tmpl');

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
  assert.throws(() => lib.injectGenerated('no markers here', []), /expected exactly one .*found 0 and 0/);
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
  const skillsDir = srcPath('private_dot_claude', 'skills');
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

  const skillsDir = srcPath('private_dot_claude', 'skills');
  const agentsDir = srcPath('private_dot_claude', 'agents');
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
  // Named distinctly from the `skillsDir`/`agentsDir` used earlier in this file (those
  // are bound to the checkout through srcPath() for a read-only comparison) — sandbox-escape.js's name
  // tracking is whole-file, not scope-aware, so reusing either name here would read as
  // the same tainted root even though these are freshly mkdtemp'd and root-free.
  const stageSkillsDir = path.join(stage, 'home', 'private_dot_claude', 'skills');
  const stageAgentsDir = path.join(stage, 'home', 'private_dot_claude', 'agents');
  fs.mkdirSync(stageAgentsDir, { recursive: true });
  fs.mkdirSync(path.join(stageSkillsDir, 'skill-router'), { recursive: true });
  // No `grilling` directory at all — the fixture's own lane prose references it, so the
  // check must fail rather than silently regenerate around the gap.
  fs.writeFileSync(
    path.join(stageSkillsDir, 'skill-router', 'SKILL.md.tmpl'),
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
    repoPath('bin', 'gen-skill-router-lib.js'),
    path.join(stageBin, 'gen-skill-router-lib.js'),
  );
  fs.copyFileSync(repoPath('bin', 'gen-lib.js'), path.join(stageBin, 'gen-lib.js'));

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

// --- the untracked-skill annotation (DanielH2018/server#2271) -----------------------------

// A drifting fixture tree in its own git repo. `trackExtra` decides whether the second skill
// directory is in the index: untracked, it is what the generator read and the committed
// template did not follow, which is the case the annotation exists to name.
//
// The env passed to every git call has GIT_* stripped. `git add` exports GIT_DIR and
// GIT_INDEX_FILE, so a fixture inheriting them writes the REAL repo's index whatever its cwd
// says.
function stageDriftingRouter(trackExtra) {
  const fs = require('node:fs');
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-skill-router-untracked-'));
  const routerDir = path.join(stage, 'home', 'private_dot_claude', 'skills', 'skill-router');
  const extraDir = path.join(stage, 'home', 'private_dot_claude', 'skills', 'extra-skill');
  fs.mkdirSync(path.join(stage, 'home', 'private_dot_claude', 'agents'), { recursive: true });
  fs.mkdirSync(routerDir, { recursive: true });
  fs.mkdirSync(extraDir, { recursive: true });

  // An EMPTY generated block against a tree holding two skills: the check must report drift,
  // which is the only path that reaches the annotation.
  fs.writeFileSync(
    path.join(routerDir, 'SKILL.md.tmpl'),
    `---\nname: skill-router\ndescription: test fixture\n---\n\n`
    + `${lib.START_MARKER}\n${lib.END_MARKER}\n`,
  );
  fs.writeFileSync(
    path.join(extraDir, 'SKILL.md'),
    `---\nname: extra-skill\ndescription: test fixture\n---\n`,
  );

  const stageBin = path.join(stage, 'bin');
  fs.mkdirSync(stageBin, { recursive: true });
  fs.copyFileSync(BIN, path.join(stageBin, 'gen-skill-router'));
  fs.copyFileSync(
    repoPath('bin', 'gen-skill-router-lib.js'),
    path.join(stageBin, 'gen-skill-router-lib.js'),
  );
  fs.copyFileSync(repoPath('bin', 'gen-lib.js'), path.join(stageBin, 'gen-lib.js'));

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  const git = (...args) => {
    const res = spawnSync('git', ['-C', stage, ...args], { encoding: 'utf8', env });
    assert.strictEqual(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  };
  git('init', '-q');
  git('add', path.join('home', 'private_dot_claude', 'skills', 'skill-router'));
  if (trackExtra) {
    git('add', path.join('home', 'private_dot_claude', 'skills', 'extra-skill'));
  }

  return { stage, stageBin };
}

function checkStderr(stageBin) {
  try {
    execFileSync('node', [path.join(stageBin, 'gen-skill-router'), '--check'], {
      encoding: 'utf8', stdio: 'pipe',
    });
  } catch (err) {
    assert.strictEqual(err.status, 1, 'the fixture tree must report drift');
    return err.stderr.toString();
  }
  assert.fail('--check passed against a deliberately drifting fixture');
  return '';
}

test('--check names an untracked skill directory as the cause of the drift', () => {
  const fs = require('node:fs');
  const { stage, stageBin } = stageDriftingRouter(false);
  const stderr = checkStderr(stageBin);

  assert.match(stderr, /is out of date/);
  assert.match(
    stderr,
    /home\/private_dot_claude\/skills\/extra-skill/,
    'the failure must name the untracked directory, not just report drift',
  );
  assert.match(stderr, /untracked/);
  // The router's own directory IS tracked, so naming it would send the reader at the wrong file.
  assert.doesNotMatch(stderr, /skills\/skill-router\b(?![/.])/);

  fs.rmSync(stage, { recursive: true, force: true });
});

test('--check adds no untracked line when every skill directory is tracked', () => {
  const fs = require('node:fs');
  const { stage, stageBin } = stageDriftingRouter(true);
  const stderr = checkStderr(stageBin);

  // Same drift, same exit code: only the annotation differs. A message that says "untracked"
  // here would send the reader after a file that is in the index.
  assert.match(stderr, /is out of date/);
  assert.doesNotMatch(stderr, /untracked/);

  fs.rmSync(stage, { recursive: true, force: true });
});

test('--check still reports the drift when git cannot answer (no repo at all)', () => {
  const fs = require('node:fs');
  const { stage, stageBin } = stageDriftingRouter(false);
  fs.rmSync(path.join(stage, '.git'), { recursive: true, force: true });
  const stderr = checkStderr(stageBin);

  // The annotation is diagnostic. Losing it must not change the verdict.
  assert.match(stderr, /is out of date/);
  assert.doesNotMatch(stderr, /untracked/);

  fs.rmSync(stage, { recursive: true, force: true });
});
