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
const os = require('node:os');
const path = require('node:path');
const { have } = require('./probe');

const REPO = path.join(__dirname, '..', '..');
const SOURCE = path.join(REPO, 'home');

// False when chezmoi is not installed. Use as `const skip = chezmoiAvailable ? false : '...'`.
const chezmoiAvailable = have('chezmoi');

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
// `data` overrides arbitrary .chezmoi data keys for this render -- `{ work: true }` renders
// .chezmoiignore as a work machine sees it, which is the only way to check a gate's polarity
// without editing the template. `profile` is the same mechanism with one key named, kept as its
// own option because most callers want exactly that.
//
// `profile` overrides .profile for this render. Desktop-only templates open with
// `{{ if includeTemplate "is-desktop-linux" . }}`, which is false unless .profile is
// "workstation" -- so on a server-profile machine (daniel-box sets profile = "server") those
// templates render to zero bytes, and every assertion about their contents fails on a host where
// nothing is actually wrong. Skipping there would be worse than fixing it: this repo already
// treats a silently skipped suite as indistinguishable from a passing one, which is why the
// pre-push file list comes from git rather than from node's discovery. The logic in these
// scripts -- which EDID counts as broken, whether the podman shim is installed -- does not
// depend on the profile; only the decision to deploy them does. Pinning the profile the
// template expects makes that coverage travel to any machine.
//
// A config file rather than an env var because chezmoi reads .data only from its config.
// --config replaces that file wholesale, so the other keys the real one carries (umask,
// interpreters) are deliberately absent: execute-template applies nothing and reads none of them.
const dataConfigs = new Map();
function dataConfig(overrides) {
  const key = JSON.stringify(overrides);
  if (!dataConfigs.has(key)) {
    const base = JSON.parse(execFileSync('chezmoi', ['dump-config', '--format=json'], { encoding: 'utf8' }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chezmoi-data-'));
    const file = path.join(dir, 'chezmoi.json');
    fs.writeFileSync(file, JSON.stringify({ data: { ...base.data, ...overrides } }));
    dataConfigs.set(key, file);
  }
  return dataConfigs.get(key);
}

function renderTemplate(body, { source = SOURCE, cwd, env, profile, data } = {}) {
  const overrides = { ...data };
  if (profile) overrides.profile = profile;
  const hasOverrides = Object.keys(overrides).length > 0;
  const key = [source || '', cwd || '', env ? JSON.stringify(env) : '', JSON.stringify(overrides), body].join(' ');
  if (!cache.has(key)) {
    const config = hasOverrides ? ['--config', dataConfig(overrides)] : [];
    const args = source
      ? [...config, '--source', source, 'execute-template']
      : [...config, 'execute-template'];
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
