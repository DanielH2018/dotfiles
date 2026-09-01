// Behavior tests for the os-linux bootstrap scripts gated on the OS alone (dnf-speedups,
// btrfs-snapshots), driven under the PATH-shim sandbox.
//
// The suite is split by the guard each script renders behind, so a file's skip gate is the
// one its scripts share: chezmoi-scripts.test.js (the render sweep and the os-unix scripts),
// chezmoi-scripts-wsl.test.js (os-linux/wsl), chezmoi-scripts-linux.test.js (os-linux, any
// profile) and chezmoi-scripts-workstation.test.js (os-linux, workstation and desktop only).
// The sandbox helpers, the skip gates and the shared sudo stub are tests/lib/chezmoi-scripts.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { renderFile } = require('../lib/render');
const {
  SCRIPTS_DIR, skipLinux, tmpdir, realBin, readLog, runSh,
} = require('../lib/chezmoi-scripts');

// 2f. os-linux/run_onchange_after_dnf-speedups.sh.tmpl ---------------------------------------
{
  const DS_SRC = path.join(SCRIPTS_DIR, 'os-linux', 'run_onchange_after_dnf-speedups.sh.tmpl');

  // This script's whole job is the resulting file, so unlike the sandboxes above its sudo stub
  // DOES exec what it wraps -- asserting on argv alone would prove nothing about the config that
  // comes out. That is safe only because the stub execs exactly one shape: an `install` whose
  // destination is $DNF_CONF, which the sandbox points at a temp file. Anything else is refused
  // rather than run, so a future edit that adds a second sudo call fails loudly here instead of
  // reaching the real system. Keep that whitelist as narrow as the script's actual writes.
  const DS_SUDO_STUB = [
    '#!/bin/sh',
    'echo "sudo $*" >> "$STUB_LOG"',
    'if [ "$1" = "-v" ] || [ "$1" = "-n" ]; then',
    '  exit "${SUDO_PROBE_EXIT:-0}"',
    'fi',
    'for dest; do :; done',      // POSIX idiom for the last positional arg
    'if [ "$1" = install ] && [ "$dest" = "$DNF_CONF" ]; then',
    '  exec "$@"',
    'fi',
    'echo "stub sudo refused: $*" >&2',
    'exit 99',
    '',
  ].join('\n');

  const BEGIN = '# >>> chezmoi dnf-speedups >>>';
  const END = '# <<< chezmoi dnf-speedups <<<';
  const MANAGED = ['max_parallel_downloads=10', 'defaultyes=True', 'keepcache=True'];

  // pm:'dnf' places dnf+rpm stubs so linux-install.sh resolves PM=dnf; pm:'apt' places
  // apt-get+dpkg instead, which is how every Debian machine running this suite reaches the
  // early exit.
  function dsSandbox({ conf = '# see `man dnf.conf`\n\n[main]\n', pm = 'dnf' } = {}) {
    const dir = tmpdir('dnf-');
    const logFile = path.join(dir, 'log.txt');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(path.join(dir, 'sudo'), DS_SUDO_STUB, { mode: 0o755 });
    const TRUE_STUB = '#!/bin/sh\nexit 0\n';
    for (const bin of pm === 'dnf' ? ['dnf', 'rpm'] : ['apt-get', 'dpkg']) {
      fs.writeFileSync(path.join(dir, bin), TRUE_STUB, { mode: 0o755 });
    }
    for (const bin of ['grep', 'awk', 'mktemp', 'cmp', 'cp', 'install', 'mkdir', 'uname', 'rm']) {
      fs.symlinkSync(realBin(bin), path.join(dir, bin));
    }
    const confFile = path.join(dir, 'dnf.conf');
    fs.writeFileSync(confFile, conf);
    const scriptFile = path.join(dir, 'rendered.sh');
    fs.writeFileSync(scriptFile, renderFile(DS_SRC));
    const env = { PATH: dir, HOME: dir, STUB_LOG: logFile, DNF_CONF: confFile };
    return { scriptFile, env, logFile, confFile };
  }

  const readConf = (f) => fs.readFileSync(f, 'utf8');

  test('dnf-speedups.sh.tmpl: bare [main] -> writes the managed block with all three options', { skip: skipLinux }, () => {
    const { scriptFile, env, logFile, confFile } = dsSandbox();
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0, `expected success, log:\n${readLog(logFile)}`);
    const out = readConf(confFile);
    assert.ok(out.includes(BEGIN) && out.includes(END), `markers missing:\n${out}`);
    for (const kv of MANAGED) assert.ok(out.includes(kv), `${kv} missing:\n${out}`);
    // Options must land under [main], not before it, or dnf reads a file with no section header.
    assert.ok(out.indexOf('[main]') < out.indexOf(BEGIN), `block precedes [main]:\n${out}`);
    assert.ok(readLog(logFile).includes(`sudo install -m 0644`), 'the write should go through sudo');
  });

  test('dnf-speedups.sh.tmpl: second run over a converged file writes nothing and never probes sudo', { skip: skipLinux }, () => {
    const { scriptFile, env, logFile, confFile } = dsSandbox();
    assert.strictEqual(runSh(scriptFile, env).status, 0);
    const afterFirst = readConf(confFile);
    fs.writeFileSync(logFile, '');
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.strictEqual(readConf(confFile), afterFirst, 'a converged file must not be rewritten');
    // `sudo -v` prompts for a password, so a no-op apply that probes it is a regression even
    // though the file is unchanged.
    assert.strictEqual(readLog(logFile), '', 'converged run must not touch sudo at all');
  });

  test('dnf-speedups.sh.tmpl: an edited block is rewritten rather than duplicated', { skip: skipLinux }, () => {
    const conf = `[main]\n${BEGIN}\nmax_parallel_downloads=3\n${END}\n`;
    const { scriptFile, env, confFile } = dsSandbox({ conf });
    assert.strictEqual(runSh(scriptFile, env).status, 0);
    const out = readConf(confFile);
    assert.strictEqual(out.split(BEGIN).length - 1, 1, `exactly one block expected:\n${out}`);
    assert.ok(out.includes('max_parallel_downloads=10'), `stale value not replaced:\n${out}`);
    assert.ok(!out.includes('max_parallel_downloads=3'), `stale value survived:\n${out}`);
  });

  test('dnf-speedups.sh.tmpl: a hand-set option is left alone, not duplicated', { skip: skipLinux }, () => {
    const { scriptFile, env, confFile } = dsSandbox({ conf: '[main]\nkeepcache=False\n' });
    assert.strictEqual(runSh(scriptFile, env).status, 0);
    const out = readConf(confFile);
    assert.ok(out.includes('keepcache=False'), `the user's value must survive:\n${out}`);
    assert.ok(!out.includes('keepcache=True'), `must not write a competing copy:\n${out}`);
    assert.ok(out.includes('defaultyes=True'), `the other options should still apply:\n${out}`);
  });

  test('dnf-speedups.sh.tmpl: a repo stanza in dnf.conf -> refuses to touch the file', { skip: skipLinux }, () => {
    const conf = '[main]\n\n[myrepo]\nbaseurl=http://example.invalid/\n';
    const { scriptFile, env, logFile, confFile } = dsSandbox({ conf });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.strictEqual(readConf(confFile), conf, 'a multi-stanza file must be left untouched');
    assert.strictEqual(readLog(logFile), '');
  });

  test('dnf-speedups.sh.tmpl: an unbalanced managed block -> exit 1 without truncating the file', { skip: skipLinux }, () => {
    const conf = `[main]\n${BEGIN}\ndefaultyes=True\ninstall_weak_deps=False\n`;
    const { scriptFile, env, confFile } = dsSandbox({ conf });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 1, 'a missing end marker must fail loudly, not silently strip');
    assert.strictEqual(readConf(confFile), conf);
  });

  test('dnf-speedups.sh.tmpl: apt machine -> exits without reading or writing dnf.conf', { skip: skipLinux }, () => {
    const { scriptFile, env, logFile, confFile } = dsSandbox({ pm: 'apt' });
    const before = readConf(confFile);
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.strictEqual(readConf(confFile), before);
    assert.strictEqual(readLog(logFile), '');
  });

  test('dnf-speedups.sh.tmpl: sudo unavailable -> exit 1 so the next apply retries', { skip: skipLinux }, () => {
    const { scriptFile, env, confFile } = dsSandbox();
    env.SUDO_PROBE_EXIT = '1';
    const before = readConf(confFile);
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 1);
    assert.strictEqual(readConf(confFile), before);
  });
}

// 2g. os-linux/run_onchange_after_setup-btrfs-snapshots.sh.tmpl ------------------------------
{
  const BS_SRC = path.join(SCRIPTS_DIR, 'os-linux', 'run_onchange_after_setup-btrfs-snapshots.sh.tmpl');

  // This script's effect is spread over four resources (a package, a config file, two snapper
  // configs, three timers), so unlike the sandboxes above its stubs are STATEFUL: the sudo stub
  // records what it was asked to change under $STATE_DIR, and the rpm/systemctl/snapper stubs
  // read that state back. That is what makes the convergence test worth anything -- it proves
  // the script's own writes are what turn the second run into a no-op, rather than asserting
  // against a fixture we hand-converged. The only real exec is the `install` whose destination
  // is $SNAPPER_ACTIONS, which the sandbox points at a temp file; every other sudo shape is
  // enumerated and recorded, and anything unrecognised is refused rather than run.
  const BS_SUDO_STUB = [
    '#!/bin/sh',
    'echo "sudo $*" >> "$STUB_LOG"',
    'if [ "$1" = "-v" ] || [ "$1" = "-n" ]; then exit "${SUDO_PROBE_EXIT:-0}"; fi',
    'case "$1" in',
    '  mkdir) shift; exec mkdir "$@" ;;',
    '  install)',
    '    for dest; do :; done',
    '    if [ "$dest" = "$SNAPPER_ACTIONS" ]; then shift; exec install "$@"; fi',
    '    echo "stub sudo refused: $*" >&2; exit 99 ;;',
    '  dnf)',
    '    [ "$2" = install ] || { echo "stub sudo refused: $*" >&2; exit 99; }',
    '    : > "$STATE_DIR/pkg"; exit 0 ;;',
    '  systemctl)',
    '    [ "$2" = enable ] || { echo "stub sudo refused: $*" >&2; exit 99; }',
    '    : > "$STATE_DIR/timer-$4"; exit 0 ;;',
    '  snapper)',
    // Replays `set-config KEY=VALUE ...` into the CSV the get-config stub will serve back.
    '    cfg=""; prev=""; seen=0',
    '    for a; do',
    '      [ "$prev" = "-c" ] && cfg="$a"',
    '      [ "$seen" = 1 ] && echo "$a" | tr "=" "," >> "$STATE_DIR/cfg-$cfg"',
    '      [ "$a" = set-config ] && seen=1',
    '      prev="$a"',
    '    done',
    '    exit 0 ;;',
    'esac',
    'echo "stub sudo refused: $*" >&2',
    'exit 99',
    '',
  ].join('\n');

  const BS_SNAPPER_STUB = [
    '#!/bin/sh',
    'cfg=""; prev=""',
    'for a; do [ "$prev" = "-c" ] && cfg="$a"; prev="$a"; done',
    'case " $* " in',
    '  *" get-config "*)',
    '    [ -f "$STATE_DIR/cfg-$cfg" ] || exit 1',
    '    cat "$STATE_DIR/cfg-$cfg" ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n');

  // `rpm -q <pkg>` answers from state; every other rpm call is PM detection and just succeeds.
  const BS_RPM_STUB = '#!/bin/sh\n[ "$1" = -q ] || exit 0\n[ -f "$STATE_DIR/pkg" ]\n';
  const BS_SYSTEMCTL_STUB =
    '#!/bin/sh\n[ "$1" = is-enabled ] || exit 0\nfor u; do :; done\n[ -f "$STATE_DIR/timer-$u" ]\n';

  const TIMERS = ['snapper-timeline.timer', 'snapper-cleanup.timer', 'snapper-boot.timer'];

  function bsSandbox({ pm = 'dnf', btrfs = true, configs = ['root', 'home'] } = {}) {
    const dir = tmpdir('btrfs-');
    const state = path.join(dir, 'state');
    const cfgDir = path.join(dir, 'snapper-configs');
    fs.mkdirSync(state);
    fs.mkdirSync(cfgDir);
    for (const c of configs) fs.writeFileSync(path.join(cfgDir, c), '');
    const logFile = path.join(dir, 'log.txt');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(path.join(dir, 'sudo'), BS_SUDO_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'snapper'), BS_SNAPPER_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'rpm'), BS_RPM_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'systemctl'), BS_SYSTEMCTL_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'findmnt'), `#!/bin/sh\nexit ${btrfs ? 0 : 1}\n`, { mode: 0o755 });
    const TRUE_STUB = '#!/bin/sh\nexit 0\n';
    for (const bin of pm === 'dnf' ? ['dnf'] : ['apt-get', 'dpkg']) {
      fs.writeFileSync(path.join(dir, bin), TRUE_STUB, { mode: 0o755 });
    }
    for (const bin of ['grep', 'awk', 'sed', 'mktemp', 'cmp', 'cp', 'install', 'mkdir', 'uname', 'rm', 'cat', 'dirname', 'tr']) {
      fs.symlinkSync(realBin(bin), path.join(dir, bin));
    }
    const actionsFile = path.join(dir, 'snapper.actions');
    const scriptFile = path.join(dir, 'rendered.sh');
    fs.writeFileSync(scriptFile, renderFile(BS_SRC));
    const env = {
      PATH: dir, HOME: dir, STUB_LOG: logFile, STATE_DIR: state,
      SNAPPER_ACTIONS: actionsFile, SNAPPER_CONFIG_DIR: cfgDir,
    };
    return { scriptFile, env, logFile, actionsFile };
  }

  test('btrfs-snapshots.sh.tmpl: fresh box -> installs the plugin, writes the hook, sets both configs, enables all three timers', { skip: skipLinux }, () => {
    const { scriptFile, env, logFile, actionsFile } = bsSandbox();
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0, `expected success, log:\n${readLog(logFile)}`);
    const log = readLog(logFile);
    assert.ok(log.includes('sudo dnf install -y libdnf5-plugin-actions'), `plugin not installed:\n${log}`);
    assert.ok(fs.existsSync(actionsFile), 'the actions hook should have been written');
    const actions = fs.readFileSync(actionsFile, 'utf8');
    assert.ok(actions.includes('pre_transaction'), `no pre_transaction hook:\n${actions}`);
    assert.ok(actions.includes('post_transaction'), `no post_transaction hook:\n${actions}`);
    // `-c number` on both creates is what lets NUMBER_CLEANUP reap the pairs; upstream's example
    // omits it, and without it every dnf transaction leaves a pair behind forever.
    assert.strictEqual(actions.split('-c\\ number').length - 1, 2, `both creates need -c number:\n${actions}`);
    assert.ok(log.includes('sudo snapper -c root set-config'), `root retention unset:\n${log}`);
    assert.ok(log.includes('sudo snapper -c home set-config'), `home retention unset:\n${log}`);
    // root carries the dnf pre/post pairs, so it is the only config given the larger budget.
    assert.ok(/sudo snapper -c root set-config[^\n]*NUMBER_LIMIT=20/.test(log), `root NUMBER_LIMIT:\n${log}`);
    assert.ok(!/sudo snapper -c home set-config[^\n]*NUMBER_LIMIT=/.test(log), `home must keep its own:\n${log}`);
    for (const u of TIMERS) {
      assert.ok(log.includes(`sudo systemctl enable --now ${u}`), `${u} not enabled:\n${log}`);
    }
  });

  test('btrfs-snapshots.sh.tmpl: second run over a converged box writes nothing and never probes sudo', { skip: skipLinux }, () => {
    const { scriptFile, env, logFile, actionsFile } = bsSandbox();
    assert.strictEqual(runSh(scriptFile, env).status, 0, `first run failed:\n${readLog(logFile)}`);
    const afterFirst = fs.readFileSync(actionsFile, 'utf8');
    fs.writeFileSync(logFile, '');
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.strictEqual(fs.readFileSync(actionsFile, 'utf8'), afterFirst, 'a converged hook must not be rewritten');
    // `sudo -v` prompts for a password, so a no-op apply that probes it is a regression even
    // though nothing downstream changed.
    assert.strictEqual(readLog(logFile), '', 'converged run must not touch sudo at all');
  });

  test('btrfs-snapshots.sh.tmpl: / is not btrfs -> exits without writing or probing sudo', { skip: skipLinux }, () => {
    const { scriptFile, env, logFile, actionsFile } = bsSandbox({ btrfs: false });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.ok(!fs.existsSync(actionsFile), 'nothing should be written on a non-btrfs root');
    assert.strictEqual(readLog(logFile), '');
  });

  test('btrfs-snapshots.sh.tmpl: a missing snapper config -> warns and exits rather than creating one', { skip: skipLinux }, () => {
    const { scriptFile, env, logFile, actionsFile } = bsSandbox({ configs: ['root'] });
    const { status } = runSh(scriptFile, env);
    // create-config makes a .snapshots subvolume, which an apply must not do unasked.
    assert.strictEqual(status, 0);
    assert.ok(!fs.existsSync(actionsFile), 'must not configure a box whose configs are absent');
    assert.strictEqual(readLog(logFile), '');
  });

  test('btrfs-snapshots.sh.tmpl: apt machine -> exits without touching anything', { skip: skipLinux }, () => {
    const { scriptFile, env, logFile, actionsFile } = bsSandbox({ pm: 'apt' });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.ok(!fs.existsSync(actionsFile));
    assert.strictEqual(readLog(logFile), '');
  });

  test('btrfs-snapshots.sh.tmpl: sudo unavailable -> exit 1 so the next apply retries', { skip: skipLinux }, () => {
    const { scriptFile, env, actionsFile } = bsSandbox();
    env.SUDO_PROBE_EXIT = '1';
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 1);
    assert.ok(!fs.existsSync(actionsFile), 'nothing should be written without sudo');
  });
}
