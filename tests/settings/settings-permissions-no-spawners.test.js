// Content guard on settings.permissions.json's REAL allow/deny arrays: no allow rule may
// normalize to a prefix that takes an arbitrary command as its argument (a "spawner"), and
// every allow-listed spawner that is guarded instead of removed carries the deny globs that
// guard it.
//
// Moved here from tests/hooks/allow-compound-bash.test.js (claude-guard slice 3 cutover):
// these two tests check the permission MODEL, not allow-compound-bash.sh's own behavior —
// the hook being retired and ported to claude_guard's judge() is no reason to lose a guard
// against a settings.permissions.json allow rule reintroducing a shell-out. The third test
// that lived beside these ('every wrapper the hook unwraps...') was genuinely about the
// hook's own unwrap list and was deleted with it -- but the cross-check it kept (the
// unwrapper's wrapper list and SPAWNERS in step) has no replacement, so G6
// (task-8-fix-1-brief.md) restores it below against claude_guard's WRAPPERS, the hook's
// successor.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// settings.permissions.json, not settings.base.json: the permission model was split out of
// the base template, which now only splices it in by includeTemplate. The two tests below
// assert they located the allow and deny arrays before parsing anything, so pointing this
// at the wrong template fails them rather than silently checking zero rules — but keep it
// pointed at whichever template actually holds the arrays.
const REAL_SETTINGS = path.join(__dirname, '..', '..', 'home', '.chezmoitemplates', 'settings.permissions.json');
// Commands that take another command as an argument. None may be an allow prefix.
// `make` counts: a target's recipe is arbitrary code living in the repo's own Makefile.
const SPAWNERS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'env', 'python', 'python3',
  'node', 'perl', 'ruby', 'eval', 'exec', 'sudo', 'ssh', 'nohup', 'setsid', 'script',
  'entr', 'timeout', 'nice', 'stdbuf', 'watch', 'make', 'xargs'];
// `fnm env` ends in the word `env` but prints shell init text; it never runs an argument.
const NOT_A_SPAWNER = ['fnm env', 'gh run watch'];
// Allow-listed spawners that are guarded by deny globs instead of being removed. xargs is
// deliberately absent: its command word floats after any number of options, so no glob can
// pin it down, and it was removed from allow instead. find and awk stay because their
// execution forms are named flags.
// awk's form is `system` rather than `system(`: a deny glob spelled `Bash(awk *system(*)`
// has unbalanced parens, which the rule parser drops outright — leaving `Bash(awk:*)`
// allow-listed with nothing guarding it. The trailing `(` cannot appear here.
const GUARDED = { find: ['-exec', '-execdir', '-ok', '-delete', '-fprintf'], awk: ['system'] };

function bashPrefixes(block) {
  // Mirror extract_bash_prefixes: drop the Bash(...) wrapper, then a trailing :*, ` *` or *.
  return [...block.matchAll(/"Bash\(([^"]*)\)"/g)]
    .map((m) => m[1].replace(/:\*$/, '').replace(/ \*$/, '').replace(/\*$/, ''));
}

test('no allow rule normalizes to a prefix that takes a command as its argument', () => {
  const src = fs.readFileSync(REAL_SETTINGS, 'utf8');
  const allowStart = src.indexOf('"allow": [');
  const denyStart = src.indexOf('"deny": [');
  assert.ok(allowStart > -1 && denyStart > allowStart, 'located the allow array');
  const prefixes = bashPrefixes(src.slice(allowStart, denyStart));
  assert.ok(prefixes.length > 100, `parsed the allow array (got ${prefixes.length} rules)`);
  const offenders = prefixes.filter((p) => {
    if (NOT_A_SPAWNER.includes(p) || Object.keys(GUARDED).includes(p)) return false;
    const last = p.trim().split(/\s+/).pop().split('/').pop();
    return SPAWNERS.includes(last);
  });
  assert.deepStrictEqual(offenders, [], `allow prefixes ending in a spawner: ${offenders.join(', ')}`);
});

// G6 (task-8-fix-1-brief.md): the unwrapper only helps a command judge() otherwise reaches
// for real -- a wrapper word that gained an allow rule would be a bypass no unwrapping
// could close, and the first test above is what refuses that. If a wrapper is ever added
// to judge.py's WRAPPERS without also adding it to SPAWNERS here, that guard goes blind to
// it while reading green throughout. Keep the two lists in step, the same contract the
// deleted 'every wrapper the hook unwraps is one the allow list is checked against' held
// for the bash hook's own case list.
const JUDGE_PY = path.join(
  __dirname, '..', '..', 'home', 'dot_local', 'share', 'claude-guard', 'claude_guard', 'judge.py',
);

test('every wrapper judge.py unwraps is one SPAWNERS lists', () => {
  const src = fs.readFileSync(JUDGE_PY, 'utf8');
  const m = src.match(/^WRAPPERS = frozenset\(\{([^}]*)\}\)/m);
  assert.ok(m, 'located the WRAPPERS frozenset literal in judge.py');
  const wrappers = [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
  assert.ok(wrappers.length >= 5, `parsed WRAPPERS (got ${wrappers.length} entries)`);
  for (const w of wrappers) {
    assert.ok(SPAWNERS.includes(w), `judge.py unwraps "${w}" but SPAWNERS does not list it`);
  }
});

test('each allow-listed spawner that is kept carries its deny globs', () => {
  const src = fs.readFileSync(REAL_SETTINGS, 'utf8');
  const denyStart = src.indexOf('"deny": [');
  const askStart = src.indexOf('"ask": [');
  assert.ok(denyStart > -1 && askStart > denyStart, 'located the deny array');
  const denyBlock = src.slice(denyStart, askStart);
  const allowPrefixes = bashPrefixes(src.slice(src.indexOf('"allow": ['), denyStart));
  for (const [cmd, forms] of Object.entries(GUARDED)) {
    if (!allowPrefixes.includes(cmd)) continue;   // removed from allow entirely: nothing to guard
    for (const form of forms) {
      assert.ok(denyBlock.includes(`"Bash(${cmd} *${form}*)"`),
        `${cmd} is allow-listed, so deny must cover ${form}`);
    }
  }
});
