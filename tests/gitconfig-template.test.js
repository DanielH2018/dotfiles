// Render checks for home/dot_gitconfig.tmpl.
//
// The bug these pin: every signing directive used to live inside
// `{{ if stat ~/.ssh/id_ed25519 }}`, so a machine whose key is named anything else got a
// gitconfig with no gpg.format, no commit.gpgsign and no signingkey — and committed
// unsigned in silence. Windows is exactly that machine: it signs with ~/.ssh/github-signing.
//
// `chezmoi execute-template` resolves `.chezmoi.homeDir` from $HOME, so pointing HOME at a
// scratch directory renders the template against a synthetic machine and exercises each
// key-detection branch for real rather than by grepping the template text.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMPL = path.join(__dirname, '..', 'home', 'dot_gitconfig.tmpl');
function have(cmd) { try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }
const skip = !have('chezmoi') ? 'chezmoi unavailable' : false;

const dirs = [];
function fakeHome(keys = []) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcfg-'));
  dirs.push(d);
  fs.mkdirSync(path.join(d, '.ssh'));
  // stat() only cares that the path exists; contents are irrelevant to the branch.
  for (const k of keys) fs.writeFileSync(path.join(d, '.ssh', k), 'not-a-real-key\n', { mode: 0o600 });
  return d;
}
function render(home) {
  return execFileSync('chezmoi', ['execute-template'], {
    input: fs.readFileSync(TMPL, 'utf8'), encoding: 'utf8', env: { ...process.env, HOME: home },
  });
}

test('signing policy is emitted even when no signing key is present', { skip }, () => {
  const out = render(fakeHome([]));
  assert.match(out, /^\s*format = ssh$/m, 'gpg.format survives a missing key');
  assert.match(out, /^\s*gpgsign = true$/m, 'commit.gpgsign survives a missing key');
  assert.doesNotMatch(out, /signingkey/, 'but no key is claimed');
  // The point of the change: a machine like this now fails the commit instead of
  // quietly producing an unsigned one.
});

test('picks up ~/.ssh/id_ed25519 when it exists', { skip }, () => {
  const out = render(fakeHome(['id_ed25519']));
  assert.match(out, /signingkey = ~\/\.ssh\/id_ed25519\.pub/);
  assert.match(out, /^\s*gpgsign = true$/m);
});

test('falls back to the Windows signing key name', { skip }, () => {
  // Windows has no id_ed25519 — it signs with github-signing, which the old single
  // probe missed entirely.
  const out = render(fakeHome(['github-signing']));
  assert.match(out, /signingkey = ~\/\.ssh\/github-signing\.pub/);
});

test('prefers id_ed25519 when both keys exist', { skip }, () => {
  const out = render(fakeHome(['id_ed25519', 'github-signing']));
  assert.match(out, /signingkey = ~\/\.ssh\/id_ed25519\.pub/);
  assert.doesNotMatch(out, /signingkey = ~\/\.ssh\/github-signing/, 'only one key is claimed');
});

test('never configures the cleartext credential store', { skip }, () => {
  // `helper = store` writes the token to ~/.git-credentials in plaintext; it used to be
  // the fallback for every non-Windows, non-macOS, non-"microsoft"-kernel host.
  // Anchored to a config line: the surrounding comment names `helper = store` on purpose.
  assert.doesNotMatch(fs.readFileSync(TMPL, 'utf8'), /^\s*helper\s*=\s*store\s*$/m, 'no branch of the template sets it');
  assert.doesNotMatch(render(fakeHome([])), /^\s*helper\s*=\s*store\s*$/m, 'nor does a render');
});

test('always points at an allowed_signers file', { skip }, () => {
  const home = fakeHome([]);
  assert.match(render(home), new RegExp(`allowedSignersFile = ${home}/\\.config/git/allowed_signers`));
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
