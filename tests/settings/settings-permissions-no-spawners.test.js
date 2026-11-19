// Content guard on settings.permissions.json's REAL allow array: no allow rule may
// normalize to a prefix that takes an arbitrary command as its argument (a "spawner").
//
// Moved here from tests/hooks/allow-compound-bash.test.js (claude-guard slice 3 cutover):
// the first test checks the permission MODEL, not allow-compound-bash.sh's own behavior —
// the hook being retired and ported to claude_guard's judge() is no reason to lose a guard
// against a settings.permissions.json allow rule reintroducing a shell-out. The test
// that lived beside it ('every wrapper the hook unwraps...') was genuinely about the
// hook's own unwrap list and was deleted with it -- but the cross-check it kept (the
// unwrapper's wrapper list and SPAWNERS in step) has no replacement, so G6
// (task-8-fix-1-brief.md) restores it below against claude_guard's WRAPPERS, the hook's
// successor.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { srcPath } = require('../lib/paths');

// settings.permissions.json, not settings.base.json: the permission model was split out of
// the base template, which now only splices it in by includeTemplate. The first test below
// asserts it located the allow and deny arrays before parsing anything, so pointing this
// at the wrong template fails it rather than silently checking zero rules — but keep it
// pointed at whichever template actually holds the arrays.
const REAL_SETTINGS = srcPath('.chezmoitemplates', 'settings.permissions.json');
// Commands that take another command as an argument. None may be an allow prefix.
// `make` counts: a target's recipe is arbitrary code living in the repo's own Makefile.
const SPAWNERS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'env', 'python', 'python3',
  'node', 'perl', 'ruby', 'eval', 'exec', 'sudo', 'ssh', 'nohup', 'setsid', 'script',
  'entr', 'timeout', 'nice', 'stdbuf', 'watch', 'make', 'xargs'];
// `fnm env` ends in the word `env` but prints shell init text; it never runs an argument.
const NOT_A_SPAWNER = ['fnm env', 'gh run watch'];
function bashPrefixes(block) {
  // Each rule's command text: drop the Bash(...) wrapper, then a trailing :*, ` *` or *.
  // Coarser than claude_guard.rules (which reads Claude Code's grammar), and that is enough
  // here: the check reads only the last word of what is left.
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
    if (NOT_A_SPAWNER.includes(p)) return false;
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
const JUDGE_PY = srcPath('dot_local', 'share', 'claude-guard', 'claude_guard', 'judge.py');

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
