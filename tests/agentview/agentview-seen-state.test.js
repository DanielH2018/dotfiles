// agentview renders a "completed" row whether the work finished an hour ago while you watched
// or thirty seconds ago while you were in another window. herdr splits that one underlying
// state in two -- idle is ready AND seen, done is ready and NOT seen -- and across a dozen rows
// that is the difference between a list you scan and a list you act on.
//
// fold_seen_states is the policy (which completed rows are DONE?) and mark_seen is the way back
// out (focusing stamps the row's ts). The pair is what makes this a reversible state rather
// than a one-way door, so both halves get cases, plus the entry points that reach focus.
//
// Sources the libs directly and never runs the launcher script, which is what exempts this
// suite from the agentview-seams rule -- the same property agentview-title-state.test.js
// relies on. Keep it, or pin the seams through the tests/lib/agentview-env.js helper.
// (That rule matches the launcher's filename as a substring, so naming the file even in a
// comment trips it -- text about a thing read as the thing.)
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', '..', 'home', 'dot_local', 'share', 'agentview');
const US = '\x1f';

const sh = (script, ...args) =>
  execFileSync('bash', ['-c', script, 'bash', ...args], { encoding: 'utf8' });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seen-'));
let n = 0;
const seenFileWith = (lines) => {
  const p = path.join(tmp, `seen-${n++}`);
  if (lines !== null) fs.writeFileSync(p, lines.map((l) => l.join('\t')).join('\n') + '\n');
  return p;
};

// Row = state host cwd pane ts kind locator title git, tab-joined (rows.sh).
const ROW = (state, ts, { host = 'fedora', cwd = '/home/daniel/p', kind = 'host' } = {}) =>
  [state, host, cwd, 'pane1', ts, kind, 'wez:1', 'Task', ''].join('\t');

// Drives fold_seen_states over a rows blob and a seen sidecar, returning the state column.
const fold = (rows, seenfile) => {
  const out = sh(
    `US=$'\\037'
     source "${LIB}/common.sh"
     source "${LIB}/render.sh"
     seenfile="$1"; rows="$2"
     fold_seen_states
     printf '%s' "$rows"`,
    seenfile, rows,
  );
  return out.split('\n').filter(Boolean).map((l) => l.split('\t')[0]);
};

const ID = (host, cwd, kind) => [host, cwd, kind].join(US);

// ---- which completed rows are DONE ---------------------------------------------

test('an armed sidecar with no entry for this row makes it DONE', () => {
  // The case this exists for: a session you never focused finished while you were away. The
  // sidecar exists (some other row was focused once), so the feature is armed.
  const f = seenFileWith([[ID('fedora', '/home/daniel/other', 'host'), '100']]);
  assert.deepStrictEqual(fold(ROW('completed', '100'), f), ['unseen']);
});

test('an absent sidecar leaves every row alone', () => {
  // Dormant, not "nothing seen". Otherwise a fresh setup shows every completed row as DONE and
  // the group is the whole list at the moment you are judging whether it is worth having.
  assert.deepStrictEqual(fold(ROW('completed', '100'), seenFileWith(null)), ['completed']);
});

test('a completed row whose ts matches its marker is seen, and stays COMPLETED', () => {
  const f = seenFileWith([[ID('fedora', '/home/daniel/p', 'host'), '100']]);
  assert.deepStrictEqual(fold(ROW('completed', '100'), f), ['completed']);
});

test('work landing after the last focus makes the row DONE again', () => {
  // The reason the marker stores a ts and not a boolean. A flag would latch on first focus and
  // the row could never be DONE a second time, so the feature would work exactly once per
  // session and then quietly stop.
  const f = seenFileWith([[ID('fedora', '/home/daniel/p', 'host'), '100']]);
  assert.deepStrictEqual(fold(ROW('completed', '200'), f), ['unseen']);
});

test('only completed rows are refined', () => {
  // review keeps its own group: a dirty tree is the more actionable label, and working /
  // needs-input are what the picker exists to surface. An unmarked row of any other state must
  // pass straight through.
  for (const st of ['working', 'needs-input', 'review', 'idle']) {
    assert.deepStrictEqual(fold(ROW(st, '100'), seenFileWith(null)), [st], `state ${st}`);
  }
});

test('the marker is keyed per session, not globally', () => {
  // Two sessions, one marked. Only the unmarked one is DONE.
  const f = seenFileWith([[ID('fedora', '/home/daniel/a', 'host'), '100']]);
  const rows = [ROW('completed', '100', { cwd: '/home/daniel/a' }),
    ROW('completed', '100', { cwd: '/home/daniel/b' })].join('\n');
  assert.deepStrictEqual(fold(rows, f), ['completed', 'unseen']);
});

test('a remote row is folded too', () => {
  // The sidecar is keyed by host, so a session that finished unwatched on another machine
  // reaches DONE as well. This is why the fold runs outside the local-only wezterm branch.
  const f = seenFileWith([[ID('homelab', '/srv/p', 'host'), '100']]);
  assert.deepStrictEqual(fold(ROW('completed', '100', { host: 'homelab', cwd: '/srv/p' }), f), ['completed']);
  assert.deepStrictEqual(fold(ROW('completed', '900', { host: 'homelab', cwd: '/srv/p' }), f), ['unseen']);
});

test('a cwd full of regex metacharacters is matched literally', () => {
  // The id embeds a path, and mark_seen rewrites the sidecar by field comparison rather than a
  // grep pattern for exactly this reason. Pin it from the read side too.
  const cwd = '/home/daniel/p.*[x]+/(a|b)';
  const f = seenFileWith([[ID('fedora', cwd, 'host'), '100']]);
  assert.deepStrictEqual(fold(ROW('completed', '100', { cwd }), f), ['completed']);
});

test('folding preserves every column of the row', () => {
  // fold_seen_states rebuilds each row from parsed pieces, so a mis-split would silently drop
  // or reorder a column and the render would read the wrong field. Only the trailing NEWLINE
  // is stripped here: the row's last column is the git marker, which is legitimately empty, so
  // trimming whitespace would delete the very column most likely to be lost.
  const row = ROW('completed', '100');
  const out = sh(
    `US=$'\\037'
     source "${LIB}/common.sh"
     source "${LIB}/render.sh"
     seenfile="$1"; rows="$2"
     fold_seen_states
     printf '%s' "$rows"`,
    seenFileWith([[ID('fedora', '/elsewhere', 'host'), '1']]), row,
  ).replace(/\n$/, '');
  assert.strictEqual(out, row.replace(/^completed/, 'unseen'));
});

// ---- the way back out -----------------------------------------------------------

// KEY is host US cwd US state US ts US title US pane US kind US locator (render.sh).
const KEY = (host, cwd, ts, kind = 'host') =>
  [host, cwd, 'completed', ts, 'Task', 'pane1', kind, 'wez:1'].join(US);

const markSeen = (key, seenfile) => {
  sh(
    `US=$'\\037'
     source "${LIB}/common.sh"
     source "${LIB}/focus.sh"
     seenfile="$1"
     mark_seen "$2"`,
    seenfile, key,
  );
  return fs.existsSync(seenfile) ? fs.readFileSync(seenfile, 'utf8') : '';
};

test('focusing a DONE row clears it', () => {
  // The reverse state. Without this the DONE group is a one-way door: rows would enter and
  // never leave, and the group would decay into a second COMPLETED.
  const f = path.join(tmp, 'clear');
  markSeen(KEY('fedora', '/home/daniel/p', '100'), f);
  assert.deepStrictEqual(fold(ROW('completed', '100'), f), ['completed']);
});

test('re-focusing replaces the stamp rather than appending', () => {
  // Otherwise the sidecar grows without bound and the first (stale) line wins on read.
  const f = path.join(tmp, 'replace');
  markSeen(KEY('fedora', '/home/daniel/p', '100'), f);
  const body = markSeen(KEY('fedora', '/home/daniel/p', '200'), f);
  assert.strictEqual(body.trim().split('\n').length, 1);
  assert.deepStrictEqual(fold(ROW('completed', '200'), f), ['completed']);
});

test('a header or spacer row stamps nothing', () => {
  // Those rows carry an empty KEY, and writing one would create an entry no session can clear.
  const f = path.join(tmp, 'empty');
  assert.strictEqual(markSeen('', f).trim(), '');
});
