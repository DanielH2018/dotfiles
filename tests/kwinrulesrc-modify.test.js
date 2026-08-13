// Regression guard for home/dot_config/modify_private_kwinrulesrc.sh.
//
// Two behaviours are worth pinning, and neither is the coordinates.
//
// PASS-THROUGH. KWin owns ~/.config/kwinrulesrc and rewrites it: every rule added through
// System Settings -> Window Management -> Window Rules lands here, as does the Bitwarden
// Stream Deck placement rule that predates this script. Replace this modify_ script with a
// plain managed file and those are deleted on the next apply, KDE writes them back, and the
// two fight forever with `chezmoi status` permanently dirty. That is the failure this file
// exists to catch.
//
// THE RULE INDEX. [General] rules= is the list of UUIDs KWin actually loads and count= is its
// length, so a rule section that is not named there is dead config -- present, well-formed and
// doing nothing. Order in that list is rule precedence, so an entry that already exists must
// keep its position; reordering it would silently change which rule wins where two match the
// same window. The fixtures below use the real deployed rules= line rather than a synthetic
// one, because preserving THAT order is the thing that matters.
//
// The third failure mode is non-idempotency. chezmoi re-runs a modify_ script on every apply
// and compares its stdout to the current target, so any output that is not a pure function of
// its input leaves `chezmoi status` permanently dirty and re-prompts on each run -- which
// aborts non-interactive applies. This script drops blank lines on the way in and re-emits one
// between sections, which is a fixed point only if it never also adds a leading or trailing
// one; `is a fixed point` below is what proves that.
//
// Driven through bash rather than sh because that is what chezmoi does: chezmoi.toml sets
// [interpreters.sh] command = "bash", so the deployed behaviour is bash's.
//
// Offline. Skips without bash.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'home', 'dot_config', 'modify_private_kwinrulesrc.sh');

const GHOSTTY = 'd31e37ca-991b-4265-b5a5-770bbdb42c82';
const DISCORD = 'd68fa888-6425-4f4c-bd4a-a106d577356a';
const SPOTIFY = '2e9c7a55-8d13-4f26-b0c4-5a7e91d2f308';
const OBSIDIAN = '923685de-9867-49f5-bed2-8a1da53e8b52';
const OWNED = [SPOTIFY, OBSIDIAN, GHOSTTY, DISCORD];

// Retired: this rule maximized every Firefox toplevel, extension popup windows included,
// and Firefox answered with a 95x123 sliver. Placement moved to login-window-layout. The
// UUID stays here because the script must actively delete it, not merely stop writing it.
const FIREFOX = '7f3a1c20-4b5e-4d61-9a02-1c8e6f0b3d47';
const FIREFOX_SECTION = [
  `[${FIREFOX}]`,
  'Description=Firefox - login placement (main)',
  'maximizehoriz=true',
  'maximizehorizrule=3',
  'maximizevert=true',
  'maximizevertrule=3',
  'position=1576,40',
  'positionrule=3',
  'wmclass=org.mozilla.firefox',
  'wmclasscomplete=false',
  'wmclassmatch=1',
];

// A rule this script does not own, and must never touch. This is the shape of the real
// Bitwarden entry, down to the size keys the owned rules deliberately no longer carry.
const BITWARDEN = '059b0a94-4048-412e-ad38-26e45d40d728';
const BITWARDEN_SECTION = [
  `[${BITWARDEN}]`,
  'Description=Bitwarden - Stream Deck placement',
  'position=1536,0',
  'positionrule=3',
  'size=1200,720',
  'sizerule=3',
  'wmclass=com.bitwarden.desktop',
  'wmclasscomplete=false',
  'wmclassmatch=1',
];

// The rule order as actually deployed -- deliberately not sorted, and not the order the
// sections appear in. Preserving it is the point. Still carries the retired Firefox UUID,
// because that is what an existing deployed file looks like on the way into this script.
const LIVE_RULES = [GHOSTTY, BITWARDEN, OBSIDIAN, DISCORD, FIREFOX, SPOTIFY];
const LIVE_RULES_AFTER = LIVE_RULES.filter((u) => u !== FIREFOX);

let bashOk = true;
try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); } catch { bashOk = false; }
const skip = bashOk ? false : 'bash unavailable';

function run(input) {
  return execFileSync('bash', [SCRIPT], { input, encoding: 'utf8' });
}

const ini = (...blocks) => blocks.flat().join('\n') + '\n';

const general = (rules) => ['[General]', `count=${rules.length}`, `rules=${rules.join(',')}`];

// The body of one section of `out`, header excluded.
function section(out, name) {
  const lines = out.split('\n');
  const start = lines.indexOf(`[${name}]`);
  assert.notStrictEqual(start, -1, `section [${name}] is missing from the output`);
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === '' || lines[i].startsWith('[')) { break; }
    body.push(lines[i]);
  }
  return body;
}

function rulesOf(out) {
  const m = out.match(/^rules=(.*)$/m);
  assert.ok(m, 'output has no rules= line at all, so KWin would load nothing');
  return m[1].split(',').filter(Boolean);
}

function countOf(out) {
  const m = out.match(/^count=(\d+)$/m);
  assert.ok(m, 'output has no count= line');
  return Number(m[1]);
}

test('keeps rules it does not own -- the Bitwarden entry must survive intact', { skip }, () => {
  const out = run(ini(BITWARDEN_SECTION, [''], general([BITWARDEN])));
  assert.deepStrictEqual(section(out, BITWARDEN), BITWARDEN_SECTION.slice(1),
    'a rule this script does not own was altered or dropped');
});

test('an unowned rule keeps its place in the index, and is never de-listed', { skip }, () => {
  const out = run(ini(BITWARDEN_SECTION, [''], general(LIVE_RULES)));
  assert.deepStrictEqual(rulesOf(out), LIVE_RULES_AFTER,
    'rules= order changed; order is rule precedence, so this silently re-ranks the rules');
  assert.strictEqual(countOf(out), LIVE_RULES_AFTER.length);
});

test('deletes the retired Firefox rule, section and index entry alike', { skip }, () => {
  const out = run(ini(BITWARDEN_SECTION, [''], FIREFOX_SECTION, [''], general(LIVE_RULES)));
  assert.ok(!out.includes(`[${FIREFOX}]`),
    'the retired section survived; a passed-through rule keeps maximizing extension popups');
  assert.ok(!out.includes('org.mozilla.firefox'),
    'a Firefox wmclass is still matched somewhere in the file');
  assert.ok(!rulesOf(out).includes(FIREFOX),
    'the retired UUID is still indexed in rules=, so KWin would still load it');
  assert.strictEqual(countOf(out), rulesOf(out).length);
  assert.deepStrictEqual(section(out, BITWARDEN), BITWARDEN_SECTION.slice(1),
    'removing the retired rule disturbed an unowned neighbour');
});

test('asserts an owned section whole -- a key KDE added to it is removed', { skip }, () => {
  const out = run(ini(
    [`[${GHOSTTY}]`, 'Description=Ghostty - login placement (right)', 'position=0,0',
      'positionrule=3', 'size=1200,720', 'sizerule=3', 'wmclass=com.mitchellh.ghostty'],
    [''], general([GHOSTTY]),
  ));
  const body = section(out, GHOSTTY);
  assert.ok(body.includes('position=3283,40'), 'the owned position was not re-asserted');
  assert.ok(!body.some((l) => l.startsWith('size=')),
    'a stale size rule survived; a size rule wins over maximize and the window opens small');
  assert.ok(body.includes('maximizevert=true') && body.includes('maximizehoriz=true'),
    'the maximize keys were not asserted');
});

test('adds a missing owned rule to both the section list and the index', { skip }, () => {
  const out = run(ini(BITWARDEN_SECTION, [''], general([BITWARDEN])));
  for (const uuid of OWNED) {
    assert.ok(out.includes(`[${uuid}]`), `owned section ${uuid} was not added`);
    assert.ok(rulesOf(out).includes(uuid),
      `${uuid} has a section but is absent from rules=, so KWin would never load it`);
  }
  assert.deepStrictEqual(rulesOf(out), [BITWARDEN, ...OWNED],
    'a pre-existing entry must keep its position and new ones append after it');
  assert.strictEqual(countOf(out), 5);
});

test('count always matches the length of rules=', { skip }, () => {
  const out = run(ini(BITWARDEN_SECTION, [''], ['[General]', 'count=99', `rules=${BITWARDEN}`]));
  assert.strictEqual(countOf(out), rulesOf(out).length,
    'count and rules= disagree; KWin reads count to decide how much of the list is real');
});

test('writes every owned rule from empty input (target does not exist yet)', { skip }, () => {
  const out = run('');
  for (const uuid of OWNED) { assert.ok(out.includes(`[${uuid}]`)); }
  assert.deepStrictEqual(rulesOf(out), OWNED);
  assert.strictEqual(countOf(out), OWNED.length);
  assert.ok(!out.startsWith('\n'), 'leading blank line on an empty target breaks idempotency');
  assert.ok(out.endsWith('\n') && !out.endsWith('\n\n'),
    'trailing blank line -- the next run would strip it and the two would never agree');
});

test('keeps other [General] keys it does not own', { skip }, () => {
  const out = run(ini(['[General]', 'count=0', 'rules=', 'somethingElse=kept']));
  assert.match(out, /^somethingElse=kept$/m, 'an unrelated [General] key was dropped');
});

test('sections are separated by exactly one blank line', { skip }, () => {
  const out = run(ini(BITWARDEN_SECTION, [''], general(LIVE_RULES)));
  assert.ok(!/\n\n\n/.test(out), 'blank lines accumulated between sections');
  const sections = (out.match(/^\[/gm) || []).length;
  // Drop the file-final newline before counting, or it reads as a trailing blank line.
  const blanks = out.replace(/\n$/, '').split('\n').filter((l) => l === '').length;
  assert.strictEqual(blanks, sections - 1,
    'expected one blank separator per section boundary and none at either end');
});

test('is idempotent -- output is a fixed point', { skip }, () => {
  const once = run(ini(BITWARDEN_SECTION, [''], general(LIVE_RULES)));
  assert.strictEqual(run(once), once,
    'a second apply would differ from the first, leaving chezmoi status permanently dirty');
  const fromEmpty = run('');
  assert.strictEqual(run(fromEmpty), fromEmpty);
});
