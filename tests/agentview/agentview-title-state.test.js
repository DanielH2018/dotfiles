// Claude Code encodes its state in the first rune of the OSC pane title: a braille spinner
// frame while a turn runs, U+2733 once it is ready for input. agentview already pulls that
// title out of the wezterm mux snapshot for the name column, so the state comes free -- but
// only as a fallback, because the hook registry is the authoritative source and the title has
// two writers agentview does not control (a `claude agents` pane titles itself, and a rename
// replaces the name outright).
//
// These tests pin the two halves separately: state_from_title is the parser (what does this
// title say?), fold_title_states is the policy (when may that override a row?). The policy is
// deliberately asymmetric and that asymmetry is the thing most likely to be "simplified" by a
// later change, so each rule gets its own case.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', '..', 'home', 'dot_local', 'share', 'agentview');

const SPIN_FIRST = '⠀';   // first braille frame in the range
const SPIN = '⠐';         // a frame observed live on Claude Code 2.1.223
const SPIN_LAST = '⣿';    // last braille frame in the range
const READY = '✳';        // the idle asterisk

const sh = (script, ...args) =>
  execFileSync('bash', ['-c', script, 'bash', ...args], { encoding: 'utf8' });

// ---- parser -------------------------------------------------------------------

const parse = (title) => {
  const out = sh(`source "${LIB}/common.sh"; state_from_title "$1"; printf '%s|%s' "$_tstate" "$_tname"`, title);
  const [state, name] = out.split('|');
  return { state, name };
};

test('a braille spinner frame anywhere in the range reads as working', () => {
  for (const frame of [SPIN_FIRST, SPIN, SPIN_LAST]) {
    assert.deepStrictEqual(parse(`${frame} Herdr Review`), { state: 'working', name: 'Herdr Review' });
  }
});

test('the asterisk reads as idle', () => {
  assert.deepStrictEqual(parse(`${READY} Herdr Review`), { state: 'idle', name: 'Herdr Review' });
});

test('a title with no glyph carries no state and is passed through whole', () => {
  // The case that matters: `claude agents` titles its own pane, and absence of a glyph must
  // never be read as "not working" -- it means "this title has a different writer".
  for (const t of ['claude agents', 'T3 Code review', 'zsh', '']) {
    assert.deepStrictEqual(parse(t), { state: '', name: t });
  }
});

test('the asterisk only counts as a prefix, not anywhere in the name', () => {
  assert.deepStrictEqual(parse(`${READY}NoSpace`), { state: '', name: `${READY}NoSpace` });
  assert.deepStrictEqual(parse(`Review ${READY} thing`), { state: '', name: `Review ${READY} thing` });
});

test('only the glyph and its one space are stripped, not the rest of the name', () => {
  assert.strictEqual(parse(`${SPIN} a b  c`).name, 'a b  c');
});

test('the parser never reports blocked', () => {
  // A title cannot distinguish idle from blocked, so anything that teaches it to claim
  // blocked is wrong -- needs-input has to keep coming from the hook registry.
  for (const t of [`${SPIN} x`, `${READY} x`, 'x']) {
    assert.notStrictEqual(parse(t).state, 'blocked');
  }
});

test('the reading does not depend on the locale', () => {
  // The glyphs are matched as literal UTF-8 byte prefixes for exactly this reason; a
  // character-range glob would answer differently under a non-UTF-8 locale.
  for (const locale of ['C', 'en_US.UTF-8']) {
    const out = sh(
      `export LC_ALL=${locale}; source "${LIB}/common.sh"; state_from_title "$1"; printf '%s' "$_tstate"`,
      `${SPIN} Herdr Review`,
    );
    assert.strictEqual(out, 'working', `locale ${locale}`);
  }
});

// ---- policy -------------------------------------------------------------------

const ROW = (state, host, cwd, kind = 'host') =>
  [state, host, cwd, 'pane1', '100', kind, 'wez:1', 'Task', ''].join('\t');

// Drives fold_title_states over a fixed rows blob with a hand-built cwd->title map, and
// returns the state column of each row back.
const fold = ({ rows, cwd, title, selfhost = 'fedora' }) => {
  const script = `
    source "${LIB}/common.sh"
    source "${LIB}/render.sh"
    selfhost="$1"; TCWDS=("$2"); TTITLES=("$3"); rows="$4"
    fold_title_states
    printf '%s' "$rows"
  `;
  const out = sh(script, selfhost, cwd, title, rows);
  return out.split('\n').filter(Boolean).map((l) => l.split('\t')[0]);
};

test('a spinner upgrades a stale row to working', () => {
  // The failure this exists for: a daemon-hosted job never fires UserPromptSubmit, so its
  // hook row sits at completed while the agent is genuinely running.
  assert.deepStrictEqual(
    fold({ rows: ROW('completed', 'fedora', '/home/daniel/p'), cwd: '/home/daniel/p', title: `${SPIN} Task` }),
    ['working'],
  );
});

test('a spinner overrides needs-input', () => {
  // This used to assert the opposite, because nobody had established what a blocked session
  // emits. Measured on 2.1.223: a session blocked on a tool permission prompt holds ✳ across
  // 30 stable samples, while a running turn cycles braille. Braille therefore cannot be a
  // blocked session, so a needs-input row whose pane is mid-turn is stale, not waiting.
  assert.deepStrictEqual(
    fold({ rows: ROW('needs-input', 'fedora', '/home/daniel/p'), cwd: '/home/daniel/p', title: `${SPIN} Task` }),
    ['working'],
  );
});

test('the asterisk is what protects a genuinely waiting row', () => {
  // The other half of the asymmetry, and the one that matters for not burying a row that
  // wants Daniel. A blocked session emits ✳, and ✳ never folds — so the row stays put.
  assert.deepStrictEqual(
    fold({ rows: ROW('needs-input', 'fedora', '/home/daniel/p'), cwd: '/home/daniel/p', title: `${READY} Task` }),
    ['needs-input'],
  );
});

test('the asterisk never changes a row', () => {
  // It cannot tell idle from blocked, and every row already carries a state from a better
  // source, so acting on it could only downgrade one.
  for (const state of ['working', 'completed', 'needs-input', 'idle']) {
    assert.deepStrictEqual(
      fold({ rows: ROW(state, 'fedora', '/home/daniel/p'), cwd: '/home/daniel/p', title: `${READY} Task` }),
      [state],
      `state ${state}`,
    );
  }
});

test('a remote host row is never folded from the local mux', () => {
  // The title map is this machine's wezterm; a homelab row at the same path must not take it.
  assert.deepStrictEqual(
    fold({ rows: ROW('completed', 'daniel-box', '/home/daniel/p'), cwd: '/home/daniel/p', title: `${SPIN} Task` }),
    ['completed'],
  );
});

test('a sandbox row is never folded', () => {
  // Sandbox sessions run in a container, so a local pane title at the same cwd is not theirs.
  assert.deepStrictEqual(
    fold({ rows: ROW('completed', 'fedora', '/home/daniel/p', 'sandbox'), cwd: '/home/daniel/p', title: `${SPIN} Task` }),
    ['completed'],
  );
});

test('a row with no matching pane is left alone', () => {
  assert.deepStrictEqual(
    fold({ rows: ROW('completed', 'fedora', '/home/daniel/other'), cwd: '/nowhere/near', title: `${SPIN} Task` }),
    ['completed'],
  );
});

test('folding preserves every column of every row', () => {
  // fold_title_states rebuilds each row from parsed pieces, so a mis-split would silently
  // drop the trailing git marker or shift the locator.
  const rows = [ROW('completed', 'fedora', '/home/daniel/p'), ROW('idle', 'daniel-box', '/home/daniel/q')].join('\n');
  const script = `
    source "${LIB}/common.sh"
    source "${LIB}/render.sh"
    selfhost="fedora"; TCWDS=("/home/daniel/p"); TTITLES=("${SPIN} Task"); rows="$1"
    fold_title_states
    printf '%s' "$rows"
  `;
  const out = sh(script, rows).split('\n').filter(Boolean);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out[0].split('\t'), ['working', 'fedora', '/home/daniel/p', 'pane1', '100', 'host', 'wez:1', 'Task', '']);
  assert.deepStrictEqual(out[1].split('\t'), ['idle', 'daniel-box', '/home/daniel/q', 'pane1', '100', 'host', 'wez:1', 'Task', '']);
});
