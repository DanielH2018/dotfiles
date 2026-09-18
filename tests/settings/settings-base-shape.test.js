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
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderFile } = require('../lib/render');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const TMPL = srcPath('.chezmoitemplates', 'settings.base.json');
const MERGE = srcPath('dot_local', 'bin', 'executable_claude-settings-merge');

const skip = skipUnless('bash', 'chezmoi');

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

// outputStyle names a file by its `name:` frontmatter, and every way of getting that wrong
// fails the same silent way: Claude Code falls back to the Default style and the session just
// sounds generic. Nothing errors, `chezmoi apply` still succeeds, and the tone rules that moved
// out of CLAUDE.md are simply gone. keep-coding-instructions is checked here for the same
// reason — its default is false, so a style file that omits it REMOVES the built-in
// software-engineering instructions instead of adding to them, which is a much worse silent
// failure than the wrong voice.
test('outputStyle names a style file that exists and keeps the coding instructions', { skip }, () => {
  const name = JSON.parse(render()).outputStyle;
  if (!name) return;
  // Not `dir`/`tmp`: tests/sandbox/sandbox-escape.test.js tracks bindings by name across the
  // whole file, so reusing a name the merge test above binds to a temp dir makes its
  // fs.writeFileSync/fs.rmSync calls resolve to the checkout and read as escapes.
  const stylesDir = srcPath('private_dot_claude', 'output-styles');
  const match = fs.readdirSync(stylesDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ f, body: fs.readFileSync(path.join(stylesDir, f), 'utf8') }))
    .find(({ f, body }) => (body.match(/^name:\s*(.+?)\s*$/m)?.[1] ?? f.replace(/\.md$/, '')) === name);
  assert.ok(match, `outputStyle "${name}" matches no style in ${stylesDir} — the session silently `
    + `falls back to the Default style. Style names come from the \`name:\` frontmatter, or `
    + `the file name when that is absent.`);
  assert.match(match.body, /^keep-coding-instructions:\s*true\s*$/m,
    `${match.f} does not set keep-coding-instructions: true. The field defaults to FALSE, so `
    + `without it this style drops Claude Code's built-in software-engineering instructions.`);
});

// The artifact-link chain: the box serves ~/.claude/artifacts on CLAUDE_ARTIFACTS_PORT, and
// link-artifact.sh turns that into a link the workstation can open — by the cluster URL where
// CLAUDE_ARTIFACTS_BASE_URL is set, and by the loopback port everywhere else, which then needs
// an ssh forward to resolve. Every failure mode here is silent rather than loud — a duplicate
// port means the second `ssh -L` cannot bind and the browser renders the FIRST host's
// artifacts, and 8181 is the workstation's own server, so it 404s every remote file while
// still returning a page. The ports must stay distinct even unforwarded, because a manual
// `ssh -L` for two hosts on one port fails the same way.
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

// Hosts whose links carry a real hostname instead of the loopback port. link-artifact.sh:112
// takes the CLAUDE_ARTIFACTS_BASE_URL branch whenever that var is set, so for these hosts the
// port is only what serve-artifacts.sh binds locally — no emitted link points at it.
const BASE_URL_HOSTS = (() => {
  const src = fs.readFileSync(TMPL, 'utf8');
  const m = src.match(/has\s+\.chezmoi\.hostname\s+\(list([^)]*)\)[\s\S]*?"CLAUDE_ARTIFACTS_BASE_URL"/);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map(([, h]) => h) : [];
})();

test('every artifact port is reachable, by cluster URL or by an ssh forward', () => {
  const ssh = fs.readFileSync(
    srcPath('private_dot_ssh', 'private_config.tmpl'), 'utf8');
  const stanzas = new Map();
  let current = null;
  for (const line of ssh.split('\n')) {
    const m = line.match(/^Host\s+(.+)$/);
    if (m) { current = m[1].trim().split(/\s+/); current.forEach((h) => stanzas.set(h, [])); }
    else if (current) current.forEach((h) => stanzas.get(h).push(line));
  }
  assert.ok(BASE_URL_HOSTS.length > 0,
    'no CLAUDE_ARTIFACTS_BASE_URL gate found — either it was removed or the pattern drifted, '
    + 'and without it this test would accept a host whose links reach nothing');
  for (const { host, port } of HOST_PORTS) {
    if (BASE_URL_HOSTS.includes(host)) continue;
    const body = (stanzas.get(host) || []).join('\n');
    assert.match(body, new RegExp(`LocalForward\\s+127\\.0\\.0\\.1:${port}\\s+127\\.0\\.0\\.1:${port}`),
      `${host} serves artifacts on ${port}, is not in the CLAUDE_ARTIFACTS_BASE_URL list, and its `
      + `ssh stanza does not forward the port — so every artifact link it emits is dead from the `
      + `workstation. Give it the cluster URL or forward the port.`);
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

// The audible cue's idle_prompt rule lives in notify.sh, not in the matcher.
//
// It was in the matcher, as a flat exclusion: a session that merely went idle is not asking for
// anything, and a cue 60s after every finished turn trains you to ignore the cue that matters.
// That silenced background jobs too, which is the opposite case — a job raising idle_prompt IS
// asking you a question and owns no pane to show it in. notify.sh now tells the two apart by the
// jobs directory, so the matcher may name idle_prompt as long as the script still gates it.
// Asserting on the matcher alone would pass a build where that gate had been deleted.
test('the audible cue gates the idle reminder on the session being a background job', { skip }, () => {
  const cfg = JSON.parse(render());
  const entries = ((cfg.hooks || {}).Notification || []).filter((e) =>
    (e.hooks || []).some((h) => /notify\.sh/.test(h.command || '')));
  assert.ok(entries.length, 'no Notification entry runs the audible cue');
  const script = fs.readFileSync(
    srcPath('private_dot_claude', 'hooks', 'executable_notify.sh'), 'utf8');
  for (const e of entries) {
    assert.match(e.matcher, /permission_prompt/,
      'a genuine permission prompt must still make a sound');
    if (/idle_prompt/.test(e.matcher)) {
      assert.match(script, /idle_prompt/,
        'the matcher admits idle_prompt but notify.sh never mentions it');
      assert.match(script, /\.claude\/jobs\//,
        'notify.sh admits idle_prompt without gating it on the jobs directory');
    }
  }
});

// The Warp row label is a different question from the sound. A foreground session idling for 60s
// has not been blocked on anything, so relabelling its row "needs-input" would be wrong even
// though the same event legitimately makes a sound for a background job.
test('the Warp needs-input label does not fire on the idle reminder', { skip }, () => {
  const cfg = JSON.parse(render());
  for (const e of (cfg.hooks || {}).Notification || []) {
    if (!(e.hooks || []).some((h) => /warp-session-title\.sh needs-input/.test(h.command || ''))) continue;
    assert.doesNotMatch(e.matcher, /idle_prompt/,
      `the row label still fires on idle_prompt: ${e.matcher}`);
  }
});

// A Notification matcher is compared against the payload's notification_type. A matcher that
// names no real type is not a narrow filter, it is a hook that never runs — and it reads in
// review exactly like a working one. We shipped "task_complete" for months believing it wrote
// the agentview completed state; it never fired once, and the two tests above passed the whole
// time because they only ever asserted on the matcher STRING.
//
// The list is the set of notification_type literals present in the Claude Code 2.1.224 binary,
// which is the authority here — the published docs table has been incomplete before. Re-derive
// it after a Claude Code upgrade with:
//   strings -n 8 ~/.local/share/claude/versions/<v> | grep -oE '"(permission_prompt|...)"'
const NOTIFICATION_TYPES = [
  'permission_prompt', 'idle_prompt', 'auth_success', 'agent_needs_input', 'agent_completed',
  'elicitation_active', 'elicitation_complete', 'elicitation_dialog', 'elicitation_response',
  'elicitation_url_dialog',
];

test('every Notification matcher names a real notification type', { skip }, () => {
  const cfg = JSON.parse(render());
  for (const e of (cfg.hooks || {}).Notification || []) {
    if (!e.matcher) continue;   // matcher-less is legitimate: it means "every type"
    for (const token of e.matcher.split('|').map((t) => t.trim()).filter(Boolean)) {
      assert.ok(NOTIFICATION_TYPES.includes(token),
        `"${token}" is not a notification_type, so this hook never fires: ${e.matcher}`);
    }
  }
});

// claude-guard slice 3 cutover: guard-permission-request.sh is now the sole decision for
// Bash PermissionRequest, always live. Slice 6 (2026-09-17) retired the CLAUDE_GUARD_SHADOW
// switch and the shadow apparatus it fed -- every bash hook it compared against was already
// gone from disk in slice 3. This is the red-proof for both cutovers: it must fail if any of
// the six bash hooks is still registered, and it must fail if CLAUDE_GUARD_SHADOW is
// re-added -- a shadow switch with no chain behind it to compare against is the regression
// slice 6 closed (see docs/plans/2026-09-11-claude-guard-slice-3-cutover.md, Task 8, and
// docs/specs/2026-09-06-claude-guard-design.md row 6).
test('claude-guard is the sole Bash PermissionRequest decision, live', { skip }, () => {
  const s = JSON.parse(render());
  const entry = s.hooks.PermissionRequest.find((e) => e.matcher === 'Bash');
  const cmds = entry.hooks.map((h) => h.command);
  assert.ok(cmds.includes('~/.claude/hooks/guard-permission-request.sh'), cmds.join(', '));
  const removed = ['allow-compound-bash.sh', 'allow-readonly-remote.sh', 'allow-safe-curl.sh',
    'allow-safe-rm.sh', 'allow-ansible-readonly.sh', 'allow-daniel-server.sh'];
  for (const gone of removed) {
    assert.ok(!cmds.includes(`~/.claude/hooks/${gone}`), `${gone} is still registered`);
  }
  assert.strictEqual(s.env.CLAUDE_GUARD_SHADOW, undefined);
});

// claude-guard slice 4 cutover: guard-pre-tool-use.sh is the sole decision for Bash
// PreToolUse. This is the red-proof for the cutover: it must fail if block-dangerous-bash.sh
// is registered again (see docs/plans/2026-09-17-claude-guard-slice-4-cutover.md). Slice 6
// deleted the bash hook and the CLAUDE_GUARD_DENY_SHADOW switch that shadowed it, so the
// env key is asserted absent the way CLAUDE_GUARD_SHADOW is above.
test('claude-guard is the sole Bash PreToolUse deny decision, live', { skip }, () => {
  const s = JSON.parse(render());
  const entry = s.hooks.PreToolUse.find((e) => e.matcher === 'Bash');
  const cmds = entry.hooks.map((h) => h.command);
  assert.ok(cmds.includes('~/.claude/hooks/guard-pre-tool-use.sh'), cmds.join(', '));
  assert.ok(!cmds.includes('~/.claude/hooks/block-dangerous-bash.sh'), 'block-dangerous-bash.sh is still registered');
  assert.strictEqual(s.env.CLAUDE_GUARD_DENY_SHADOW, undefined);
  assert.strictEqual(s.env.CMDPARSE_SHADOW_SAMPLE, undefined);
  const shim = entry.hooks.find((h) => h.command.endsWith('guard-pre-tool-use.sh'));
  assert.strictEqual(shim.timeout, 10);
});
