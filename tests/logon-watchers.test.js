// Guards the Windows logon watchers under home/Scripts/ (#731): streamdeck-watcher,
// sonar-routing-watcher and wslhost-interop-reaper. They used to carry three copies of one
// installer and one hidden-window VBS, and two defects hid in the copies -- a trigger
// registered as bare `-User $env:USERNAME`, which came back with an empty UserId from a
// bash-hosted prompt, and an installer nothing ever called. Registration now lives once, in
// Scripts/logon-watcher/register.ps1, and every watcher's install.ps1 hands off to it.
//
// The static checks run everywhere. The behavior check drives each real install.ps1 through
// Windows PowerShell with the ScheduledTasks cmdlets shadowed by functions (a function wins
// over a cmdlet in PowerShell's command lookup), so nothing is registered on the host.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { srcPath } = require('./lib/paths');
const { have } = require('./lib/probe');
const { scratch } = require('./lib/tmp');

const SCRIPTS = srcPath('Scripts');
const SHARED = 'logon-watcher';
const WATCHERS = fs.readdirSync(SCRIPTS)
  .filter((d) => d !== SHARED && fs.existsSync(path.join(SCRIPTS, d, 'install.ps1')));
const ELEVATED = srcPath('dot_config', 'windows-provisioning', 'elevated-setup.ps1.tmpl');
const REAPER_SH = srcPath('.chezmoiscripts', 'os-linux', 'wsl', 'run_onchange_after_install-interop-reaper.sh.tmpl');

const read = (p) => fs.readFileSync(p, 'utf8');

test('the three watchers are found', () => {
  assert.deepStrictEqual(WATCHERS.sort(), ['sonar-routing-watcher', 'streamdeck-watcher', 'wslhost-interop-reaper']);
});

test('every watcher registers through the shared helper, not its own copy', () => {
  for (const w of WATCHERS) {
    const src = read(path.join(SCRIPTS, w, 'install.ps1'));
    assert.match(src, /'\.\.\\logon-watcher\\register\.ps1'/, `${w}/install.ps1 does not call the shared helper`);
    assert.doesNotMatch(src, /Register-ScheduledTask\s+-TaskName/, `${w}/install.ps1 registers its own task`);
    assert.ok(fs.existsSync(path.join(SCRIPTS, w, `${w}.ps1`)), `${w}/install.ps1 points at a missing ${w}.ps1`);
  }
});

test('no watcher keeps its own hidden-window launcher', () => {
  for (const w of WATCHERS) {
    const vbs = fs.readdirSync(path.join(SCRIPTS, w)).filter((f) => f.endsWith('.vbs'));
    assert.deepStrictEqual(vbs, [], `${w} still carries ${vbs.join(',')}`);
  }
});

test('no trigger names the account as bare $env:USERNAME', () => {
  for (const d of fs.readdirSync(SCRIPTS)) {
    for (const f of fs.readdirSync(path.join(SCRIPTS, d)).filter((n) => n.endsWith('.ps1'))) {
      const code = read(path.join(SCRIPTS, d, f)).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      assert.doesNotMatch(code, /-User \$env:USERNAME\b/, `${d}/${f}`);
    }
  }
});

test('every watcher has a caller', () => {
  // elevated-setup.ps1 runs the Windows-side installers; the WSL run_onchange script writes
  // and runs the reaper's. A watcher neither one names never gets its task.
  const elevated = read(ELEVATED);
  const reaper = read(REAPER_SH);
  for (const w of WATCHERS) {
    const called = elevated.includes(`'${w}'`) || reaper.includes(`Scripts\\\\${w}\\\\install.ps1`);
    assert.ok(called, `nothing installs ${w}`);
  }
});

test('the WSL reaper script deploys and hashes every file it inlines', () => {
  const src = read(REAPER_SH);
  const inlined = [...src.matchAll(/^\{\{ include "([^"]+)" \| trimSuffix/gm)].map((m) => m[1]);
  const hashed = [...src.matchAll(/\{\{ include "([^"]+)" \| sha256sum \}\}/g)].map((m) => m[1]);
  assert.deepStrictEqual(inlined.sort(), hashed.sort(), 'an inlined file is missing its run_onchange hash (or vice versa)');
  for (const f of ['register.ps1', 'run-hidden.vbs']) {
    assert.ok(inlined.includes(`Scripts/${SHARED}/${f}`), `the reaper script does not deploy ${SHARED}/${f}`);
    assert.match(src, new RegExp(`cat > "\\$shared/${f.replace('.', '\\.')}"`), `${f} is not written into the shared dir`);
  }
});

const skipPs = process.platform !== 'win32' ? 'Windows only'
  : (!have('powershell.exe') ? 'powershell.exe unavailable' : false);

// Shadows the ScheduledTasks cmdlets and logs what each was called with, one line per call.
const STUBS = String.raw`
$ErrorActionPreference = 'Stop'
function New-ScheduledTaskAction { param($Execute, $Argument) Add-Content $env:STUB_LOG "action|$Execute|$Argument"; 'A' }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn, $User) Add-Content $env:STUB_LOG "trigger|$AtLogOn|$User"; 'T' }
function New-ScheduledTaskSettingsSet { 'S' }
function Register-ScheduledTask { param($TaskName, $Action, $Trigger, $Settings, $RunLevel, [switch]$Force, $Description)
  Add-Content $env:STUB_LOG "register|$TaskName|$RunLevel|$Action|$Trigger|$Settings|$Force" }
function Start-ScheduledTask { param($TaskName) Add-Content $env:STUB_LOG "start|$TaskName" }
& $env:INSTALLER
`;

for (const w of WATCHERS) {
  test(`${w}/install.ps1 registers a hidden, DOMAIN\\user-triggered, Limited task`, { skip: skipPs }, (t) => {
    const dir = scratch(os.tmpdir(), 'logon-watchers-', t);
    // The deployed layout: Scripts/<watcher>/ beside Scripts/logon-watcher/.
    fs.cpSync(SCRIPTS, path.join(dir, 'Scripts'), { recursive: true });
    const runner = path.join(dir, 'runner.ps1');
    fs.writeFileSync(runner, STUBS);
    const log = path.join(dir, 'calls.log');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner], {
      encoding: 'utf8',
      env: {
        ...process.env,
        STUB_LOG: log,
        INSTALLER: path.join(dir, 'Scripts', w, 'install.ps1'),
        USERDOMAIN: 'TESTDOM',
        USERNAME: 'tester',
      },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const calls = read(log).trim().split(/\r?\n/).map((l) => l.split('|'));
    const by = (k) => calls.find((c) => c[0] === k);

    const vbs = path.join(dir, 'Scripts', SHARED, 'run-hidden.vbs');
    const script = path.join(dir, 'Scripts', w, `${w}.ps1`);
    assert.deepStrictEqual(by('action').slice(1), ['wscript.exe', `"${vbs}" "${script}"`]);
    assert.deepStrictEqual(by('trigger').slice(1), ['True', 'TESTDOM\\tester']);
    const reg = by('register');
    assert.strictEqual(reg[2], 'Limited');
    assert.deepStrictEqual(reg.slice(3), ['A', 'T', 'S', 'True']);
    assert.strictEqual(by('start')[1], reg[1], 'the task started is not the one registered');
  });
}
