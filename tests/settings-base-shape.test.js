// The shipped settings.base.json must survive its own generator.
//
// This exists because it did not. M20 slice 3 added post-merge shape validation to
// claude-settings-merge, and the moment it landed every `chezmoi apply` on this machine
// failed with `fallbackModel must be a string` — the template shipped a one-element ARRAY.
//
// The apply was unblocked (A1-36) by changing the template to a string. That was the wrong
// half to change: the array had been right all along. Claude Code 2.1.220 validates
// fallbackModel as an array, and on a type mismatch it rejects the ENTIRE settings.json,
// so for the rest of that day statusLine, every hook, the permissions block and
// enabledPlugins were all silently inert — the missing status line is what surfaced it.
// Evidence: `claude doctor` reports "Expected array, but received string", and in a scratch
// CLAUDE_CONFIG_DIR a SessionStart hook fires with the array but not with the string.
//
// So a green suite here is necessary but not sufficient: these tests prove the template
// survives OUR generator, which is only as correct as our belief about the real harness.
// When the two disagree, `claude doctor` is the authority, not this file.
//
// The suite was green throughout: every existing test fed the merge script hand-written
// fixtures, and none fed it the actual template we ship. That is the gap this closes —
// render the real thing, run the real generator over it, and require exit 0.
//
// Both halves are read from THIS tree (template via stdin, merge script by explicit
// path), so a worktree cannot accidentally assert against the primary checkout's copies
// — the skew that made tests/modify_settings.test.js report the wrong tree's result.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const TMPL = path.join(REPO, 'home', '.chezmoitemplates', 'settings.base.json');
const MERGE = path.join(REPO, 'home', 'dot_local', 'bin', 'executable_claude-settings-merge');

let have = true;
try { execFileSync('bash', ['-c', 'command -v chezmoi'], { stdio: 'ignore' }); } catch { have = false; }
const skip = have ? false : 'chezmoi unavailable';

let rendered = null;
function render() {
  if (rendered) return rendered;
  const r = spawnSync('chezmoi', ['execute-template'], {
    input: fs.readFileSync(TMPL, 'utf8'), encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, `template did not render: ${r.stderr}`);
  rendered = r.stdout;
  return rendered;
}

test('the rendered base template is valid JSON', { skip }, () => {
  assert.doesNotThrow(() => JSON.parse(render()));
});

// The load-bearing one. Not "does a fixture pass" — does the file we actually ship pass.
test('the rendered base template survives claude-settings-merge unchanged', { skip }, () => {
  const tmp = path.join(REPO, '.settings-base-shape.tmp.json');
  fs.writeFileSync(tmp, render());
  try {
    const r = spawnSync('node', [MERGE, tmp], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0,
      `the shipped template is rejected by its own generator — every chezmoi apply would `
      + `fail and block all other dotfiles. stderr: ${r.stderr}`);
    assert.doesNotThrow(() => JSON.parse(r.stdout), 'generator emitted invalid JSON');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('fallbackModel is an array, not a string', { skip }, () => {
  const v = JSON.parse(render()).fallbackModel;
  assert.ok(Array.isArray(v) && v.every((m) => typeof m === 'string'),
    `fallbackModel must be an array of strings. Claude Code validates the key as an array `
    + `and discards the ENTIRE settings.json on a type mismatch, so a string here silently `
    + `disables statusLine, hooks, permissions and plugins too. Got: ${JSON.stringify(v)}`);
});

// A fallback the harness would refuse to switch to is no fallback at all.
test('every fallbackModel entry is one of availableModels', { skip }, () => {
  const s = JSON.parse(render());
  if (!Array.isArray(s.availableModels)) return;   // key is optional
  const missing = [].concat(s.fallbackModel).filter((m) => !s.availableModels.includes(m));
  assert.deepStrictEqual(missing, [],
    `fallbackModel entries ${JSON.stringify(missing)} are absent from availableModels, so `
    + `enforceAvailableModels would reject the very model it falls back to`);
});
