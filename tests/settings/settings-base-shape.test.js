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
// Both halves are read from THIS tree (template through tests/lib/render.js, merge script
// by explicit path), so a worktree cannot accidentally assert against the primary
// checkout's copies — the skew that made tests/modify_settings.test.js report the wrong
// tree's result.
//
// The render used to be a bare `chezmoi execute-template` on stdin, which was equivalent
// while the template was self-contained. It stopped being equivalent when the permission
// model moved into settings.permissions.json: with no --source, chezmoi resolves
// includeTemplate against its CONFIGURED source dir, so a worktree would have spliced in
// the primary checkout's permission rules and asserted against those — the exact skew the
// paragraph above says cannot happen. renderFile passes --source for this tree.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderFile } = require('../lib/render');

const REPO = path.join(__dirname, '..', '..');
const TMPL = path.join(REPO, 'home', '.chezmoitemplates', 'settings.base.json');
const MERGE = path.join(REPO, 'home', 'dot_local', 'bin', 'executable_claude-settings-merge');

let have = true;
try { execFileSync('bash', ['-c', 'command -v chezmoi'], { stdio: 'ignore' }); } catch { have = false; }
const skip = have ? false : 'chezmoi unavailable';

let rendered = null;
function render() {
  if (rendered) return rendered;
  try {
    rendered = renderFile(TMPL);
  } catch (e) {
    assert.fail(`template did not render: ${e.stderr || e.message}`);
  }
  return rendered;
}

// The permissions key is spliced in by includeTemplate, which carries the fragment's
// leading and trailing newlines with it. Left alone that renders `"permissions":` with its
// brace on the next line and the comma stranded a line below the closing one — still valid
// JSON, so nothing downstream complains, but the generated settings.json stops looking like
// the file everything else in this repo greps. The base template compensates with `trim`
// and by closing its comment on the key's own line; this is what notices if either is lost.
test('the permissions block splices in without stray whitespace', { skip }, () => {
  assert.match(render(), /\n {2}"permissions": \{\n/,
    'the opening brace left the key\'s line — the include lost its `trim`');
  assert.doesNotMatch(render(), /\n\}\n,/,
    'the closing brace and its comma split across lines — the fragment\'s last line should '
    + 'be an indented `  }` so the base template\'s comma lands beside it');
  assert.doesNotMatch(render(), /\n {2}\n {2}"permissions"/,
    'a blank line precedes the permissions key — a template comment closed on its own line');
});

test('the rendered base template is valid JSON', { skip }, () => {
  assert.doesNotThrow(() => JSON.parse(render()));
});

// The load-bearing one. Not "does a fixture pass" — does the file we actually ship pass.
test('the rendered base template survives claude-settings-merge unchanged', { skip }, () => {
  // A temp dir, not REPO: the merge script takes its input by argv and resolves its prior
  // and floor files from the environment, so the location was only ever convenience — and
  // a file that appears in the checkout mid-run is visible to every other session's
  // `git status` and to anything walking this tree in parallel.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-base-shape-'));
  const tmp = path.join(dir, 'settings.base.json');
  fs.writeFileSync(tmp, render());
  try {
    const r = spawnSync('node', [MERGE, tmp], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0,
      `the shipped template is rejected by its own generator — every chezmoi apply would `
      + `fail and block all other dotfiles. stderr: ${r.stderr}`);
    assert.doesNotThrow(() => JSON.parse(r.stdout), 'generator emitted invalid JSON');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fallbackModel is an array, not a string', { skip }, () => {
  const v = JSON.parse(render()).fallbackModel;
  assert.ok(Array.isArray(v) && v.every((m) => typeof m === 'string'),
    `fallbackModel must be an array of strings. Claude Code validates the key as an array `
    + `and discards the ENTIRE settings.json on a type mismatch, so a string here silently `
    + `disables statusLine, hooks, permissions and plugins too. Got: ${JSON.stringify(v)}`);
});

// The artifact-link chain is three files agreeing on one number per host: the box serves
// ~/.claude/artifacts on CLAUDE_ARTIFACTS_PORT, link-artifact.sh writes that port into the
// http:// link, and ~/.ssh/config forwards it so the link resolves on the workstation.
// Every failure mode here is silent rather than loud — a duplicate port means the second
// `ssh -L` cannot bind and the browser renders the FIRST host's artifacts, and 8181 is the
// workstation's own server, so it 404s every remote file while still returning a page.
// Read from the template source, not a render: the gates are per-hostname and the test only
// ever runs on one machine.
// Anchored on `eq`, which is what the artifact gates are — an if/else-if chain of
// `eq .chezmoi.hostname "..."`. Matching a bare `.chezmoi.hostname "..."` instead paired
// the host named by whatever *other* gate happened to sit above the block: the OTEL gate
// became `ne .chezmoi.hostname "daniel-pi"` and this read daniel-pi as serving 8182, then
// failed because the pi's ssh stanza does not forward a port it never served. The old
// spelling only escaped because `has .chezmoi.hostname (list ...)` puts `(list` where the
// quote had to be, so the mispairing was luck rather than design.
const HOST_PORTS = (() => {
  const src = fs.readFileSync(TMPL, 'utf8');
  const re = /\beq\s+\.chezmoi\.hostname\s+"([^"]+)"[\s\S]*?"CLAUDE_ARTIFACTS_PORT":\s*"(\d+)"/g;
  return [...src.matchAll(re)].map(([, host, port]) => ({ host, port }));
})();

test('each host that serves artifacts gets its own port, never the workstation 8181', () => {
  assert.ok(HOST_PORTS.length > 0,
    'no CLAUDE_ARTIFACTS_PORT gates found — either they were removed or the pattern drifted');
  const ports = HOST_PORTS.map((h) => h.port);
  assert.strictEqual(new Set(ports).size, ports.length,
    `two hosts share an artifact port: ${JSON.stringify(HOST_PORTS)}`);
  assert.deepStrictEqual(HOST_PORTS.filter((h) => h.port === '8181'), [],
    'a remote host claims 8181, which is the local default the workstation already serves');
});

test('every artifact port is forwarded by that host\'s ssh stanza', () => {
  const ssh = fs.readFileSync(
    path.join(REPO, 'home', 'private_dot_ssh', 'private_config.tmpl'), 'utf8');
  const stanzas = new Map();
  let current = null;
  for (const line of ssh.split('\n')) {
    const m = line.match(/^Host\s+(.+)$/);
    if (m) { current = m[1].trim().split(/\s+/); current.forEach((h) => stanzas.set(h, [])); }
    else if (current) current.forEach((h) => stanzas.get(h).push(line));
  }
  for (const { host, port } of HOST_PORTS) {
    const body = (stanzas.get(host) || []).join('\n');
    assert.match(body, new RegExp(`LocalForward\\s+127\\.0\\.0\\.1:${port}\\s+127\\.0\\.0\\.1:${port}`),
      `${host} serves artifacts on ${port} but its ssh stanza does not forward it, so every `
      + `artifact link it emits is dead from the workstation`);
  }
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
