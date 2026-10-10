// Gate checks for the `agent` data key (home/.chezmoitemplates/is-agent).
//
// The server repo's Ansible applies these dotfiles to a locked-down Claude agent user as well
// as to the operator, and seeds `agent = true` for it. Ansible owns that user's login profile,
// git identity, signers and ssh, and its own ~/.claude/CLAUDE.md; a chezmoi apply that wrote
// any of them would replace the agent's GitHub identity with the operator's. The gate fails
// silently in both directions -- an ignore rule that matches nothing reports no error, and an
// inverted one strips the operator's own files -- so each half is asserted by name.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { renderFile, renderTemplate, chezmoiAvailable, SOURCE, dataConfig } = require('../lib/render');
const { srcPath } = require('../lib/paths');

const skip = chezmoiAvailable ? false : 'chezmoi unavailable';
const IGNORE = srcPath('.chezmoiignore');

// What the agent must never receive from this repo.
const AGENT_IGNORED = [
  '.profile',
  '.bash_profile',
  '.gitconfig',
  '.config/git/allowed_signers',
  '.ssh',
  '.claude/CLAUDE.md',
  '.local/bin/sudo',
  '.local/bin/tmux-askpass',
  '.local/bin/claude-changelog-watch',
  '.local/bin/otel-sweep',
  '.local/bin/otel-sweep-watch',
  '.local/bin/otel-savings-rollup',
  '.local/bin/retention-sweep',
  '.local/bin/claude-rc-resume',
  '.local/bin/pr-dash',
  '.local/bin/ct',
  '.local/bin/cts',
  '.local/bin/ctw',
  '.local/share/pr-dash',
  '.config/systemd/user/claude-changelog-watch.*',
  '.config/systemd/user/otel-sweep-watch.*',
  '.config/systemd/user/otel-savings-rollup.*',
  '.config/systemd/user/retention-sweep.*',
];

// The hostname is not data, so a render that needs daniel-box sets it the way
// cleanup-host-gated-files.test.js does. The agent exists only there, and several rules in
// the file gate on the hostname, so an unpinned render answers for whatever host runs the test.
const BOX = '{{ $_ := set .chezmoi "hostname" "daniel-box" }}{{ $_ := set .chezmoi "os" "linux" }}';

const parse = (text) =>
  new Set(text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
const ignored = (agent) => parse(renderTemplate(BOX + fs.readFileSync(IGNORE, 'utf8'),
  { data: { agent, profile: 'server', work: false } }));
// As `chezmoi managed` sees this host, unpinned.
const ignoredHere = () => parse(renderFile(IGNORE, { data: { agent: false, profile: 'server', work: false } }));

const settings = (agent) => JSON.parse(renderTemplate('{{ includeTemplate "settings.base.json" . }}',
  { data: { agent, profile: 'server', work: false } }));

const onBox = (file, agent) => renderTemplate(
  `${BOX}${fs.readFileSync(file, 'utf8')}`,
  { data: { agent, profile: 'server', work: false } },
);

test('an agent ignores every path its Ansible owns and every operator-only tool', { skip }, () => {
  const got = ignored(true);
  for (const p of AGENT_IGNORED) assert.ok(got.has(p), `${p} reaches the agent`);
  assert.ok(!got.has('.claude/operator'), 'the agent loses the operator CLAUDE.md it imports');
});

test('the operator keeps all of them and gets no operator/ copy', { skip }, () => {
  const got = ignored(false);
  for (const p of AGENT_IGNORED) {
    if (p === '.ssh') continue; // daniel-box ignores .ssh/config for its own reason.
    assert.ok(!got.has(p), `${p} is stripped from the operator`);
  }
  assert.ok(got.has('.claude/operator'));
});

test('a host whose chezmoi.toml predates the key renders as the operator', { skip }, () => {
  assert.strictEqual(renderTemplate('{{ includeTemplate "is-agent" . }}', { data: { work: false } }), '');
  assert.strictEqual(renderTemplate('{{ includeTemplate "is-agent" . }}', { data: { agent: true, work: false, profile: 'server' } }), 'true');
});

test('every agent-ignored path names a target the operator deploys', { skip }, () => {
  // An ignore rule with no target is silent, so a renamed tool would quietly reach the agent.
  const config = dataConfig({ agent: false, profile: 'server', work: false });
  const managed = execFileSync('chezmoi', ['--config', config, '--source', SOURCE, '--destination', '/nonexistent-home',
    'managed', '--include', 'files,dirs'], { encoding: 'utf8' }).split('\n');
  // `managed` cannot pin the hostname, so a path this host already ignores for its own reason
  // (the sudo shim deploys to the homelab hosts only) is checked on those hosts instead.
  const here = ignoredHere();
  for (const p of AGENT_IGNORED) {
    if (p === '.ssh' || here.has(p)) continue;
    const prefix = p.replace(/\*$/, '');
    assert.ok(managed.some((m) => m.startsWith(prefix)), `${p} matches no managed target`);
  }
});

test("the agent's settings drop the askpass helper and name its own artifacts path and owner", { skip }, () => {
  const agent = settings(true).env;
  const operator = settings(false).env;
  assert.strictEqual(agent.SUDO_ASKPASS, undefined);
  assert.strictEqual(agent.OTEL_RESOURCE_ATTRIBUTES, `process.owner=${require('node:os').userInfo().username}`);
  assert.strictEqual(operator.OTEL_RESOURCE_ATTRIBUTES, undefined);
  if (operator.CLAUDE_ARTIFACTS_HOST) {
    assert.strictEqual(agent.CLAUDE_ARTIFACTS_HOST,
      `${operator.CLAUDE_ARTIFACTS_HOST}-${require('node:os').userInfo().username}`);
  }
});

test("the agent runs neither the source re-add hook nor the operator's artifact server", { skip }, () => {
  const commands = (s) => Object.values(s.hooks).flat().flatMap((g) => g.hooks).map((h) => h.command);
  const agent = commands(settings(true));
  const operator = commands(settings(false));
  for (const hook of ['chezmoi-guard.sh', 'serve-artifacts.sh']) {
    assert.ok(!agent.some((c) => c.includes(hook)), `${hook} runs for the agent`);
  }
  assert.ok(operator.some((c) => c.includes('chezmoi-guard.sh')));
  assert.ok(agent.some((c) => c.includes('guard-pre-tool-use.sh')), 'the agent lost its guard hooks');
});

test('the agent skips the scripts that need sudo, a tty or a toolchain Ansible supplies', { skip }, () => {
  for (const rel of [
    ['.chezmoiscripts', 'os-unix', 'run_once_after_set-default-shell.sh.tmpl'],
    ['.chezmoiscripts', 'os-unix', 'run_onchange_after_install-python-tools.sh.tmpl'],
    ['.chezmoiscripts', 'os-linux', 'run_onchange_after_install-cli-tools.sh.tmpl'],
    ['.chezmoiscripts', 'os-linux', 'run_onchange_after_install-tmux.sh.tmpl'],
    ['.chezmoiscripts', 'post-install', 'run_onchange_after_install-js-lint.sh.tmpl'],
    ['.chezmoiscripts', 'post-install', 'run_onchange_after_install-node-lsps.sh.tmpl'],
  ]) {
    const file = srcPath(...rel);
    assert.strictEqual(onBox(file, true).trim(), '', `${rel.at(-1)} runs for the agent`);
    assert.notStrictEqual(onBox(file, false).trim(), '', `${rel.at(-1)} no longer runs for the operator`);
  }
});

test("daniel-box's once-per-host timers stay off under the agent", { skip }, () => {
  for (const name of ['changelog-watch', 'otel-sweep', 'retention-sweep']) {
    const file = srcPath('.chezmoiscripts', 'os-linux', `run_onchange_after_enable-${name}-timer.sh.tmpl`);
    assert.match(onBox(file, true), /disable --now/, `${name} enables under the agent`);
    assert.match(onBox(file, false), /enable --now/, `${name} no longer enables for the operator`);
  }
});

test("the agent's operator/CLAUDE.md is the user CLAUDE.md, rendered", { skip }, () => {
  const copy = renderFile(srcPath('private_dot_claude', 'operator', 'CLAUDE.md.tmpl'), { data: { agent: true, work: false, profile: 'server' } });
  const body = renderFile(srcPath('private_dot_claude', 'CLAUDE.md.tmpl'), { data: { agent: true, work: false, profile: 'server' } });
  assert.ok(body.length > 1000);
  assert.strictEqual(copy, body);
});
