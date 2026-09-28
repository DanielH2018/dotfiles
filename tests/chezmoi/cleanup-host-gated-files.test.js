// Covers the three run_onchange_after_cleanup-host-gated-files.* scripts (os-linux,
// os-windows, os-darwin). They exist because `.chezmoiremove` cannot do this job: a target
// BOTH ignored (home/.chezmoiignore) and listed in home/.chezmoiremove is a silent no-op,
// verified against a scratch --destination before these scripts were written. So the only
// check that matters here is the one a `.chezmoiremove` entry would have given for free on
// a tool that actually enforced it: does the RIGHT set of paths show up on each host, and
// only there.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { renderTemplate, chezmoiAvailable } = require('../lib/render');
const { srcPath } = require('../lib/paths');
const { scratch } = require('../lib/tmp');

const LINUX_SRC = srcPath('.chezmoiscripts', 'os-linux', 'run_onchange_after_cleanup-host-gated-files.sh.tmpl');
const WINDOWS_SRC = srcPath('.chezmoiscripts', 'os-windows', 'run_onchange_after_cleanup-host-gated-files.ps1.tmpl');
const DARWIN_SRC = srcPath('.chezmoiscripts', 'os-darwin', 'run_onchange_after_cleanup-host-gated-files.sh.tmpl');

const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

// set() fakes .chezmoi.os/.hostname for includeTemplate too (is-desktop-linux reads
// .chezmoi.os itself), which the `data` config override cannot reach.
const withOs = (os, body) => `{{ $_ := set .chezmoi "os" ${JSON.stringify(os)} }}${body}`;

const linuxServer = () => renderTemplate(fs.readFileSync(LINUX_SRC, 'utf8'), { profile: 'server' });
const linuxWorkstation = () => renderTemplate(fs.readFileSync(LINUX_SRC, 'utf8'), { profile: 'workstation' });
const windowsAs = () => renderTemplate(withOs('windows', fs.readFileSync(WINDOWS_SRC, 'utf8')), { profile: 'workstation' });
const darwinAs = () => renderTemplate(withOs('darwin', fs.readFileSync(DARWIN_SRC, 'utf8')), { profile: 'workstation' });

const DESKTOP_ONLY_MARKERS = [
  'audio-sink-toggle', 'streamdeck-usb-reset', 'discord', 'steam', 'flatpak-update',
  '.config/powerdevilrc', '.config/solaar', '.config/wireplumber', '.config/wallpaperengine',
  '.local/share/applications', '.local/share/kwin', '.local/share/sounds',
  '.config/warp-terminal',
];
const SANDBOX_MARKERS = ['claude-sandbox', '.claude/sandbox'];
const DARWIN_HELPER_MARKERS = ['mac-askpass', 'logi-dev-mgr-kick'];
const HOOKS_MARKER = 'test_bash_write_fanout.py';

test('a server removes the desktop utilities, the sandbox, the darwin helpers, and the hooks tests', { skip }, () => {
  const rendered = linuxServer();
  for (const m of [...DESKTOP_ONLY_MARKERS, ...SANDBOX_MARKERS, ...DARWIN_HELPER_MARKERS, HOOKS_MARKER]) {
    assert.ok(rendered.includes(m), `daniel-box/daniel-server must clean up ${m}`);
  }
});

test('a workstation removes only the darwin helpers and the hooks tests', { skip }, () => {
  const rendered = linuxWorkstation();
  for (const m of DESKTOP_ONLY_MARKERS) {
    assert.ok(!rendered.includes(m), `a desktop must keep using ${m}, not clean it up`);
  }
  for (const m of SANDBOX_MARKERS) {
    assert.ok(!rendered.includes(m), `a workstation is not profile=="server", so it must not touch ${m}`);
  }
  for (const m of DARWIN_HELPER_MARKERS) {
    assert.ok(rendered.includes(m), `Linux is never darwin, so ${m} is cleaned up on every Linux host`);
  }
  assert.ok(rendered.includes(HOOKS_MARKER), 'the hooks test suites are cleaned up on every host');
});

test('the Linux script never names a systemd unit file as a removal target', { skip }, () => {
  // #688's dangling-unit rule: wallpaperengine.service is ignore-only in .chezmoiignore, and
  // must stay that way here too. Strip comments first — the script's own header explains
  // this rule BY NAME, which a bare substring match would misread as a violation of it.
  const code = linuxServer().split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /\.service\b/);
});

test('on a server, the cleanup keeps another program\'s files in the shared XDG directories', { skip }, () => {
  // The desktop block covers shared directories such as .local/share/applications, where
  // daniel-box also keeps Claude Code's URL handler. Run the rendered script against a fake
  // HOME holding one of our files and one foreign file per shared directory: ours must go,
  // the foreign one must stay, and so must the directory that still holds it.
  const home = scratch(os.tmpdir(), 'cleanup-gated-');
  const ours = [
    '.local/share/applications/discord.desktop',
    '.local/share/sounds/ocean/stereo/bell.oga',
    '.config/wireplumber/wireplumber.conf.d/51-discord-no-restore-props.conf',
    '.claude/sandbox/Dockerfile.base',
  ];
  const foreign = [
    '.local/share/applications/claude-code-url-handler.desktop',
    '.local/share/sounds/ocean/stereo/other.oga',
    '.config/wireplumber/wireplumber.conf.d/99-local.conf',
  ];
  for (const rel of [...ours, ...foreign]) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), 'x');
  }
  const script = path.join(home, 'cleanup.sh');
  fs.writeFileSync(script, linuxServer());
  execFileSync('sh', [script], { env: { ...process.env, HOME: home } });
  for (const rel of ours) assert.ok(!fs.existsSync(path.join(home, rel)), `${rel} is ours and must be removed`);
  for (const rel of foreign) assert.ok(fs.existsSync(path.join(home, rel)), `${rel} is not ours and must survive`);
});

test('Windows cleans up the darwin helpers and the hooks tests, and nothing else', { skip }, () => {
  const rendered = windowsAs();
  for (const m of DARWIN_HELPER_MARKERS) {
    assert.ok(rendered.includes(m), `Windows is never darwin, so ${m} is cleaned up`);
  }
  assert.ok(rendered.includes(HOOKS_MARKER));
  for (const m of [...DESKTOP_ONLY_MARKERS, ...SANDBOX_MARKERS]) {
    assert.ok(!rendered.includes(m), `${m} was never gated for Windows, so it has nothing to clean up`);
  }
});

test('Windows renders empty off Windows, and the Linux/darwin scripts render empty off their OS', { skip }, () => {
  assert.strictEqual(renderTemplate(fs.readFileSync(WINDOWS_SRC, 'utf8'), { profile: 'workstation' }).trim(), '');
  assert.strictEqual(renderTemplate(withOs('darwin', fs.readFileSync(LINUX_SRC, 'utf8')), { profile: 'workstation' }).trim(), '');
  assert.strictEqual(renderTemplate(withOs('windows', fs.readFileSync(DARWIN_SRC, 'utf8')), { profile: 'workstation' }).trim(), '');
});

test('darwin cleans up only the hooks tests', { skip }, () => {
  const rendered = darwinAs();
  assert.ok(rendered.includes(HOOKS_MARKER));
  for (const m of [...DESKTOP_ONLY_MARKERS, ...SANDBOX_MARKERS, ...DARWIN_HELPER_MARKERS]) {
    assert.ok(!rendered.includes(m), `darwin was never gated out of ${m} (or keeps it on purpose), so it has nothing to clean up`);
  }
});
