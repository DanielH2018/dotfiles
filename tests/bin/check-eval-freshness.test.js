// Unit tests for bin/check-eval-freshness — the pre-push gate that rejects a skill
// `description:` edit which leaves that skill's eval results un-re-recorded.
//
// A model-invoked skill's description IS its invocation mechanism, and editing it moves
// the trigger rate silently: pr-authoring shipped at a 70% fire rate on its plainest
// trigger and only the eval saw it. So the gate exists to keep results.md honest about
// the description sitting beside it.
//
// Every rule here is a `_is_clean` / `_is_flagged` pair. A gate that fires on everything
// and one that fires on nothing are indistinguishable from the passing side alone, and
// this file is the proof this one can go RED.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');

const SCRIPT = path.join(__dirname, '..', '..', 'bin', 'check-eval-freshness');
function have(cmd) { try { execFileSync('bash', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } }
const skip = !have('bash') ? 'bash unavailable' : !have('git') ? 'git unavailable' : false;

const SKILLS = 'home/private_dot_claude/skills';

function write(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function skillMd(description, body = 'Body text.') {
  return `---\nname: demo\ndescription: ${description}\n---\n\n# demo\n\n${body}\n`;
}

// A repo holding one skill that HAS an eval, committed as the baseline the gate diffs
// against. `withEval: false` builds a skill with no evals/ dir, which is the opt-out.
function repo({ withEval = true } = {}) {
  const root = fs.realpathSync(scratch(os.tmpdir(), 'evalfresh-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');

  write(root, `${SKILLS}/demo/SKILL.md`, skillMd('Use when demoing.'));
  if (withEval) {
    write(root, `${SKILLS}/demo/evals/cases.json`, '{"skill":"demo","cases":[]}\n');
    write(root, `${SKILLS}/demo/evals/results.md`, '# Results\n\n3/3 on 2026-01-01.\n');
  }
  git('add', '-A');
  git('commit', '-qm', 'baseline');
  git('branch', 'base');
  return { root, git };
}

function run(root) {
  const r = spawnSync('bash', [SCRIPT], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, EVAL_FRESHNESS_BASE: 'base' },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('description edit without re-recorded results is flagged', { skip }, () => {
  const { root, git } = repo();
  write(root, `${SKILLS}/demo/SKILL.md`, skillMd('Use when demoing, however short the ask.'));
  git('commit', '-aqm', 'retune the description');

  const { code, out } = run(root);
  assert.strictEqual(code, 1, 'gate must reject a description edit with stale results');
  assert.match(out, /demo: description changed/);
  assert.match(out, /evals\/run\.sh/, 'must name the command that fixes it');
});

test('description edit with re-recorded results is clean', { skip }, () => {
  const { root, git } = repo();
  write(root, `${SKILLS}/demo/SKILL.md`, skillMd('Use when demoing, however short the ask.'));
  write(root, `${SKILLS}/demo/evals/results.md`, '# Results\n\n10/10 on 2026-02-02.\n');
  git('commit', '-aqm', 'retune the description and re-record');

  const { code } = run(root);
  assert.strictEqual(code, 0, 'recording the results in the same range must satisfy the gate');
});

// The gate gets its narrowness from matching `^[-+]description:` rather than the whole
// file. Without this case, a gate that fired on ANY SKILL.md edit would pass every test
// above while making unrelated skill edits require an eval re-run.
test('skill body edit that leaves the description alone is clean', { skip }, () => {
  const { root, git } = repo();
  write(root, `${SKILLS}/demo/SKILL.md`, skillMd('Use when demoing.', 'Rewritten body, new sections, same description.'));
  git('commit', '-aqm', 'rewrite the body');

  const { code, out } = run(root);
  assert.strictEqual(code, 0, 'only the description line gates');
  assert.match(out, /results current/);
});

test('deleting the description line is flagged', { skip }, () => {
  const { root, git } = repo();
  write(root, `${SKILLS}/demo/SKILL.md`, '---\nname: demo\n---\n\n# demo\n');
  git('commit', '-aqm', 'drop the description');

  const { code } = run(root);
  assert.strictEqual(code, 1, 'a removed description is a changed description');
});

test('a skill with no eval is not gated', { skip }, () => {
  const { root, git } = repo({ withEval: false });
  write(root, `${SKILLS}/demo/SKILL.md`, skillMd('Use when demoing, reworded.'));
  git('commit', '-aqm', 'retune the description');

  const { code, out } = run(root);
  assert.strictEqual(code, 0, 'evals/cases.json is what opts a skill in');
  assert.match(out, /no skills with evals/);
});

test('a missing base ref skips rather than inventing a verdict', { skip }, () => {
  const { root } = repo();
  const r = spawnSync('bash', [SCRIPT], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, EVAL_FRESHNESS_BASE: 'origin/nope' },
  });
  assert.strictEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /no origin\/nope to compare against/);
});

