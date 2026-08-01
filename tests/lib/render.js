// One way to run `chezmoi execute-template` from a test.
//
// Nineteen test files were each invoking it directly, in three spellings: `['execute-template',
// '--source', <repo>]`, `['--source', <repo>/home, 'execute-template']`, and a bare
// `['execute-template']`. The first two are equivalent -- chezmoi reads .chezmoiroot from the
// repo root and descends to home/ -- and the third is a genuinely different mode, not a typo for
// them: with no --source chezmoi uses its CONFIGURED source dir, which always resolves to the
// primary checkout. modify_settings.test.js depends on exactly that and skips when the configured
// dir is not this tree. So both modes stay available here, and this refactor kept every call site
// on the one it already had.
//
// Twelve of them also open-coded the same availability probe, in two spellings, and six
// re-memoised the render with their own `rendered ??=` plus their own comment explaining why.
// This is that, once.
//
// On the memo: it is for speed, and only speed. Five of the six files that hand-rolled it
// credited it with fixing a flake -- "every `chezmoi execute-template` opens chezmoi's
// bolt-backed state, so this file contended with the rest of the suite". That diagnosis was
// disproven in install-cli-tools.test.js:26-33: thirty-two concurrent renders produce zero
// failures, and the real cause was managed-test-drift.test.js planting a probe file inside the
// shared source tree. Only that one file's comment was corrected; the other five still carry
// the story it retracted, which is most of the reason to have one copy of this. `node --test`
// runs each file in its own process, so the cache spans one file -- eleven subprocesses where
// one will do is just slower. Expect it to prevent nothing.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const SOURCE = path.join(REPO, 'home');

// False when chezmoi is not installed. Use as `const skip = chezmoiAvailable ? false : '...'`.
const chezmoiAvailable = (() => {
  try {
    execFileSync('chezmoi', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const cache = new Map();

// renderTemplate(body, {source, cwd, env}) -> the rendered text.
//
// `source` defaults to this worktree's home/, which is what a test almost always wants: it makes
// `includeTemplate` and .chezmoidata resolve against the tree under test rather than against
// whatever is deployed. Pass `source: null` for the configured-source-dir mode described above.
//
// `env` replaces the child's environment -- gitconfig-template.test.js renders one template under
// several fake HOMEs. Both it and `cwd` are part of the cache key, so renders that differ only in
// environment cannot be served each other's result; a memo that got that wrong would be worse
// than no memo at all.
function renderTemplate(body, { source = SOURCE, cwd, env } = {}) {
  const key = [source || '', cwd || '', env ? JSON.stringify(env) : '', body].join(' ');
  if (!cache.has(key)) {
    const args = source ? ['--source', source, 'execute-template'] : ['execute-template'];
    const opts = { input: body, encoding: 'utf8' };
    if (cwd) opts.cwd = cwd;
    if (env) opts.env = env;
    cache.set(key, execFileSync('chezmoi', args, opts));
  }
  return cache.get(key);
}

// The common case: render a template file from the source tree.
function renderFile(file, opts) {
  return renderTemplate(fs.readFileSync(file, 'utf8'), opts);
}

module.exports = {
  renderTemplate, renderFile, chezmoiAvailable, REPO, SOURCE,
};
