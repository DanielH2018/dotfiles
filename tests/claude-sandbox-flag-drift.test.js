// Keeps three descriptions of claude-sandbox's CLI in agreement:
//   1. what the launcher's arg-parse loop actually accepts (the case arms),
//   2. what usage() documents,
//   3. what the zsh completion offers via _arguments.
// These drifted silently before this test existed: seven accepted flags
// (--exec, --fresh/--new, --no-vault, --no-chezmoi, --no-work-config,
// --no-repos, --repos-live) were absent from the completion, and --no-vault
// was accepted but undocumented. Nothing failed, because nothing compared them.
//
// Parses the real files rather than restating the flag list here — a hardcoded
// expected set would itself become a fourth thing to keep in sync.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SANDBOX_DIR = path.join(__dirname, '..', 'home', 'private_dot_claude', 'sandbox');
const LAUNCHER = fs.readFileSync(path.join(SANDBOX_DIR, 'executable_claude-sandbox'), 'utf8').split('\n');
const COMPLETION = fs.readFileSync(path.join(SANDBOX_DIR, '_claude-sandbox'), 'utf8');

// Flags the launcher accepts but that a user never types: the completion script
// calls the --complete-* pair to populate its own candidate lists, and
// --setup-worktree is the re-entry hook the launcher uses on itself. Offering
// them as completions would be noise, so they are exempt from both directions.
const INTERNAL = new Set(['--complete-worktrees', '--complete-branches', '--setup-worktree']);

// Returns the [start, end) line indices of a top-level `name() {` ... `}` block.
function blockRange(openRe, closeRe) {
  const start = LAUNCHER.findIndex((l) => openRe.test(l));
  assert.ok(start !== -1, `found the opening line matching ${openRe}`);
  const end = LAUNCHER.findIndex((l, i) => i > start && closeRe.test(l));
  assert.ok(end !== -1, `found the closing line matching ${closeRe} after line ${start + 1}`);
  return [start, end];
}

// Long flags accepted by the arg-parse loop: every `--foo)` / `--foo|-f)` arm
// between `case "$1" in` and its `esac`, minus the -* and * catch-alls.
function acceptedFlags() {
  const [start, end] = blockRange(/^\s*case "\$1" in$/, /^\s*esac$/);
  const flags = new Set();
  for (const line of LAUNCHER.slice(start + 1, end)) {
    const m = /^\s{4}([^)]+)\)/.exec(line);
    if (!m) continue;
    for (const tok of m[1].split('|')) {
      if (/^--[a-z][a-z-]*$/.test(tok)) flags.add(tok);
    }
  }
  assert.ok(flags.size > 10, `parsed a plausible number of case arms (got ${flags.size})`);
  return flags;
}

// Long flags named in usage()'s help text.
function documentedFlags() {
  const [start, end] = blockRange(/^usage\(\) \{$/, /^\}$/);
  const body = LAUNCHER.slice(start, end).join('\n');
  const flags = new Set(body.match(/--[a-z][a-z-]*/g) || []);
  // Mentioned as a pass-through to `claude` itself, not a launcher flag.
  flags.delete('--continue');
  return flags;
}

// Long flags the completion offers. Matches both bare '--foo[desc]' entries and
// the {-x,--exec} alias-brace form; the leading '(...)' exclusion group is
// skipped so mutually-exclusive listings are not mistaken for offers.
function offeredFlags() {
  const spec = COMPLETION.slice(
    COMPLETION.indexOf('_arguments -C'),
    COMPLETION.indexOf('&& return'),
  );
  assert.ok(spec.length > 100, 'located the _arguments spec block');
  const flags = new Set();
  for (const line of spec.split('\n')) {
    const withoutExclusions = line.replace(/\([^)]*\)/g, '');
    for (const m of withoutExclusions.matchAll(/(--[a-z][a-z-]*)(?=[[,}])/g)) flags.add(m[1]);
  }
  assert.ok(flags.size > 5, `parsed a plausible number of completion entries (got ${flags.size})`);
  return flags;
}

const accepted = acceptedFlags();
const documented = documentedFlags();
const offered = offeredFlags();

const missing = (from, inSet) => [...from].filter((f) => !inSet.has(f) && !INTERNAL.has(f)).sort();

test('every user-facing flag the launcher accepts is offered by the zsh completion', () => {
  assert.deepStrictEqual(missing(accepted, offered), [],
    'accepted but not completable — add an _arguments entry to _claude-sandbox');
});

test('every user-facing flag the launcher accepts is documented in usage()', () => {
  assert.deepStrictEqual(missing(accepted, documented), [],
    'accepted but undocumented — add a line to usage()');
});

test('the zsh completion offers nothing the launcher would reject', () => {
  assert.deepStrictEqual(missing(offered, accepted), [],
    'completed but not accepted — the launcher would exit with "Unknown option"');
});

test('usage() documents nothing the launcher would reject', () => {
  assert.deepStrictEqual(missing(documented, accepted), [],
    'documented but not accepted — usage() promises a flag the parser rejects');
});

test('the alias pairs stay aliases on both sides', () => {
  // --fresh/--new and -x/--exec are accepted in a single arm each; if one half
  // is ever split out or dropped, the pair should fail here rather than leave
  // users with a flag that completes but no longer parses.
  for (const pair of [['--fresh', '--new']]) {
    for (const f of pair) {
      assert.ok(accepted.has(f), `${f} is still accepted`);
      assert.ok(offered.has(f), `${f} is still offered by the completion`);
    }
  }
});
