// Slice 5 of M16+M21 (see specs/env-modules/M16-M21-platform-shell.md §6): four
// low-risk shell-init cosmetics bundled together because none is ordering-critical.
//
// - A14-16 (common.sh): __osc7_cwd/__wz_precmd registration used to append
//   unconditionally on every source. Any non-rc caller that sources common.sh more
//   than once (or a re-sourced rc) duplicated the hook. Fixed with a membership
//   check before append, in both the zsh-array and bash-string branches.
// - A14-19 (dot_zshrc.tmpl): the fzf integration probed with `fzf --zsh
//   >/dev/null` and then re-invoked `fzf --zsh` to source it — two process
//   spawns. Fixed by capturing the output once and eval-ing it.
// - A14-20 (dot_zshrc.tmpl): `mkdir -p` for the zcompdump cache dir ran
//   unconditionally on every start even when the dir already existed. Fixed with
//   an `[[ -d ... ]] ||` guard.
// - A14-01 (dot_zshrc.tmpl + dot_bashrc): HISTFILE was `export`ed in zsh, so a
//   bash started from zsh (e.g. `bash -ic`) inherited zsh's history file instead
//   of its own. Fixed by making zsh's HISTFILE a plain var and giving bash an
//   explicit HISTFILE of its own.
//
// Style follows tests/wezterm-shell-integration.test.js: gated blocks are sliced
// out of the real source files and executed directly (fake PATH entries stand in
// for fzf/mkdir where call-counting matters), rather than sourcing the whole rc —
// full interactive sourcing pulls in starship/fnm/zoxide state that isn't
// available or deterministic in a sandbox. `env` is passed explicitly (not
// spread from process.env) so an ambient PROMPT_COMMAND/precmd_functions picked
// up by this session's own shell can't contaminate the fixture.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const COMMON = path.join(REPO, 'home', 'dot_config', 'shell', 'common.sh');
const TMPL = path.join(REPO, 'home', 'dot_zshrc.tmpl');
const BASHRC = path.join(REPO, 'home', 'dot_bashrc');
const rawTmpl = fs.readFileSync(TMPL, 'utf8');
const rawBashrc = fs.readFileSync(BASHRC, 'utf8');

function have(cmd) { try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }
const skipBash = !have('bash') && 'bash unavailable';
const skipZsh = !have('zsh') && 'zsh unavailable';

function minimalEnv(extra = {}) {
  return { HOME: os.tmpdir(), PATH: process.env.PATH, ...extra };
}

// --- A14-16: re-source idempotence -----------------------------------------

test('bash: sourcing common.sh twice registers __osc7_cwd in PROMPT_COMMAND exactly once', { skip: skipBash }, () => {
  const out = execFileSync('bash', ['-c', `source '${COMMON}'; source '${COMMON}'; echo "$PROMPT_COMMAND"`], {
    encoding: 'utf8', env: minimalEnv(),
  });
  const hits = out.match(/__osc7_cwd/g) || [];
  assert.strictEqual(hits.length, 1, `expected __osc7_cwd once in PROMPT_COMMAND, got: ${out}`);
});

test('bash: sourcing common.sh twice with WEZTERM_PANE set registers __wz_precmd exactly once', { skip: skipBash }, () => {
  const out = execFileSync('bash', ['-c', `source '${COMMON}'; source '${COMMON}'; echo "$PROMPT_COMMAND"`], {
    encoding: 'utf8', env: minimalEnv({ WEZTERM_PANE: '1' }),
  });
  const hits = out.match(/__wz_precmd/g) || [];
  assert.strictEqual(hits.length, 1, `expected __wz_precmd once in PROMPT_COMMAND, got: ${out}`);
});

test('zsh: sourcing common.sh twice registers __osc7_cwd in precmd_functions exactly once', { skip: skipZsh }, () => {
  const out = execFileSync('zsh', ['-c', `source '${COMMON}'; source '${COMMON}'; print -r -- \${precmd_functions}`], {
    encoding: 'utf8', env: minimalEnv(),
  });
  const hits = out.match(/__osc7_cwd/g) || [];
  assert.strictEqual(hits.length, 1, `expected __osc7_cwd once in precmd_functions, got: ${out}`);
});

test('zsh: sourcing common.sh twice with WEZTERM_PANE set registers __wz_preexec/__wz_precmd exactly once each', { skip: skipZsh }, () => {
  const out = execFileSync('zsh', ['-c', `source '${COMMON}'; source '${COMMON}'; print -r -- \${preexec_functions}; print -r -- \${precmd_functions}`], {
    encoding: 'utf8', env: minimalEnv({ WEZTERM_PANE: '1' }),
  });
  assert.strictEqual((out.match(/__wz_preexec/g) || []).length, 1, `expected __wz_preexec once, got: ${out}`);
  assert.strictEqual((out.match(/__wz_precmd/g) || []).length, 1, `expected __wz_precmd once, got: ${out}`);
});

// --- A14-19: fzf capture-once ------------------------------------------------

// Slice the `if command -v fzf ...` block out of the template (column-0 if/fi pair).
function fzfBlock() {
  const lines = rawTmpl.split('\n');
  const start = lines.findIndex((l) => l.startsWith('if command -v fzf'));
  assert.notStrictEqual(start, -1, 'fzf block start found');
  const end = lines.findIndex((l, i) => i > start && l === 'fi');
  assert.notStrictEqual(end, -1, 'fzf block end found');
  return lines.slice(start, end + 1).join('\n');
}

test('fzf --zsh is invoked exactly once (capture-once, not probe-then-reinvoke)', { skip: skipZsh }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fzf-fake-'));
  const counter = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'fzf'), '#!/usr/bin/env bash\necho "$*" >> "' + counter + '"\n[ "$1" = "--zsh" ] && echo "true"\n');
  fs.chmodSync(path.join(dir, 'fzf'), 0o755);

  execFileSync('zsh', ['-c', fzfBlock()], {
    encoding: 'utf8', env: minimalEnv({ PATH: `${dir}:${process.env.PATH}` }),
  });

  const calls = fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(calls.length, 1, `expected exactly one fzf invocation, got: ${JSON.stringify(calls)}`);
  assert.match(calls[0], /--zsh/);
});

test('no remaining probe-then-reinvoke pattern (`fzf --zsh` invoked once, ignoring comments)', () => {
  const codeLines = rawTmpl.split('\n').filter((l) => !l.trimStart().startsWith('#'));
  const hits = codeLines.join('\n').match(/fzf --zsh/g) || [];
  assert.strictEqual(hits.length, 1, `expected a single "fzf --zsh" invocation outside comments, got ${hits.length}`);
});

// --- A14-20: mkdir guard ------------------------------------------------------

test('mkdir is not invoked when the zcompdump cache dir already exists', { skip: skipZsh }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdir-fake-'));
  const counter = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'mkdir'), '#!/usr/bin/env bash\necho "$*" >> "' + counter + '"\n/bin/mkdir "$@"\n');
  fs.chmodSync(path.join(dir, 'mkdir'), 0o755);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zcompdump-home-'));
  fs.mkdirSync(path.join(home, '.cache', 'zsh'), { recursive: true });

  execFileSync('zsh', ['-c', 'ZCOMPDUMP="${XDG_CACHE_HOME:-$HOME/.cache}/zsh/zcompdump-test"; [[ -d "${ZCOMPDUMP:h}" ]] || mkdir -p "${ZCOMPDUMP:h}"'], {
    encoding: 'utf8', env: minimalEnv({ HOME: home, PATH: `${dir}:${process.env.PATH}` }),
  });

  assert.ok(!fs.existsSync(counter), 'mkdir must not run when the cache dir already exists (A14-20)');
});

test('mkdir still runs (once) when the zcompdump cache dir is absent', { skip: skipZsh }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdir-fake2-'));
  const counter = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'mkdir'), '#!/usr/bin/env bash\necho "$*" >> "' + counter + '"\n/bin/mkdir "$@"\n');
  fs.chmodSync(path.join(dir, 'mkdir'), 0o755);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zcompdump-home2-'));

  execFileSync('zsh', ['-c', 'ZCOMPDUMP="${XDG_CACHE_HOME:-$HOME/.cache}/zsh/zcompdump-test"; [[ -d "${ZCOMPDUMP:h}" ]] || mkdir -p "${ZCOMPDUMP:h}"'], {
    encoding: 'utf8', env: minimalEnv({ HOME: home, PATH: `${dir}:${process.env.PATH}` }),
  });

  const calls = fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(calls.length, 1, `expected exactly one mkdir call when the dir is absent, got: ${JSON.stringify(calls)}`);
});

test('the mkdir line in dot_zshrc.tmpl itself is guarded, not bare', () => {
  assert.doesNotMatch(rawTmpl, /^mkdir -p "\$\{ZCOMPDUMP:h\}"$/m, 'a bare unconditional mkdir -p must not remain (A14-20)');
  assert.match(rawTmpl, /\[\[ -d "\$\{ZCOMPDUMP:h\}" \]\] \|\| mkdir -p "\$\{ZCOMPDUMP:h\}"/);
});

// --- A14-01: HISTFILE un-export -----------------------------------------------

test('dot_zshrc.tmpl no longer exports HISTFILE', () => {
  assert.doesNotMatch(rawTmpl, /export HISTFILE=/, 'HISTFILE must be a plain var, not exported (A14-01)');
  assert.match(rawTmpl, /^HISTFILE="\$HOME\/\.zsh_history"$/m);
});

test('dot_bashrc sets its own explicit HISTFILE', () => {
  assert.match(rawBashrc, /^HISTFILE="\$HOME\/\.bash_history"$/m, 'bash must not rely on inheriting zsh\'s HISTFILE (A14-01)');
});

test('a plain (non-exported) HISTFILE set in zsh does not leak into a bash child', { skip: skipZsh || skipBash }, () => {
  const out = execFileSync('zsh', ['-c', 'HISTFILE="$HOME/.zsh_history"; bash -c \'echo "${HISTFILE:-UNSET}"\''], {
    encoding: 'utf8', env: minimalEnv(),
  });
  assert.strictEqual(out.trim(), 'UNSET', `expected bash to see no inherited HISTFILE, got: ${out.trim()}`);
});
