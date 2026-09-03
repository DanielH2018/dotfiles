'use strict';
// Pure-logic tests for the config soak gate. No filesystem, network, or clock:
// `now` and the tracked/manifest inputs are all injected, so these are total and
// deterministic (never flaky).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const lib = require(path.join(__dirname, '..', '..', 'bin', 'config-soak-lib.js'));

const NOW = '2026-07-08T00:00:00.000Z';
const daysAgo = (n) => new Date(Date.parse(NOW) - n * lib.DAY_MS).toISOString();

test('fingerprint is deterministic and content-sensitive', () => {
  assert.strictEqual(lib.fingerprint('abc'), lib.fingerprint('abc'));
  assert.notStrictEqual(lib.fingerprint('abc'), lib.fingerprint('abd'));
  // Stable known sha256 of "abc".
  assert.strictEqual(
    lib.fingerprint('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

test('fingerprint is EOL-agnostic (CRLF == LF), so Windows checkouts do not false-flag', () => {
  // A Windows checkout (autocrlf) yields CRLF on disk; it must hash identically to
  // the LF ledger, or the gate reports every unchanged file as `changed`.
  assert.strictEqual(lib.fingerprint('a\r\nb\r\nc'), lib.fingerprint('a\nb\nc'));
  // Works on Buffers too — that's what the CLI feeds from fs.readFileSync.
  assert.strictEqual(lib.fingerprint(Buffer.from('x\r\ny')), lib.fingerprint(Buffer.from('x\ny')));
  // Only CRLF collapses; a lone CR is not a Windows EOL and is left intact.
  assert.notStrictEqual(lib.fingerprint('a\rb'), lib.fingerprint('ab'));
});

test('buildReport classifies every state', () => {
  const tracked = {
    'a.sh': 'h_a',       // recorded, unchanged, old  -> stable
    'b.sh': 'h_b',       // recorded, unchanged, fresh -> soaking
    'c.sh': 'h_c_new',   // recorded but content differs -> changed
    'd.sh': 'h_d',       // never recorded -> unrecorded
  };
  const manifest = {
    windowDays: 7,
    entries: [
      { path: 'a.sh', hash: 'h_a', landed: daysAgo(30) },
      { path: 'b.sh', hash: 'h_b', landed: daysAgo(2) },
      { path: 'c.sh', hash: 'h_c_old', landed: daysAgo(1) },
      { path: 'gone.sh', hash: 'h_gone', landed: daysAgo(10) }, // deleted -> removed
    ],
  };
  const r = lib.buildReport({ tracked, manifest, now: NOW });

  assert.strictEqual(r.windowDays, 7);
  assert.deepStrictEqual(r.stable.map((x) => x.path), ['a.sh']);
  assert.deepStrictEqual(r.soaking.map((x) => x.path), ['b.sh']);
  assert.deepStrictEqual(r.changed.map((x) => x.path), ['c.sh']);
  assert.deepStrictEqual(r.unrecorded.map((x) => x.path), ['d.sh']);
  assert.deepStrictEqual(r.removed.map((x) => x.path), ['gone.sh']);

  // soaking exposes a countdown; 2 days into a 7-day window -> 5 remaining.
  assert.strictEqual(r.soaking[0].daysRemaining, 5);
  // changed carries both hashes so a reviewer can see what moved.
  assert.strictEqual(r.changed[0].recordedHash, 'h_c_old');
});

test('window boundary: exactly windowDays old is stable (>=)', () => {
  const tracked = { 'x.sh': 'h' };
  const mk = (days) => lib.buildReport({
    tracked,
    manifest: { windowDays: 7, entries: [{ path: 'x.sh', hash: 'h', landed: daysAgo(days) }] },
    now: NOW,
  });
  assert.strictEqual(mk(7).stable.length, 1, 'exactly at window -> stable');
  assert.strictEqual(mk(6.999).soaking.length, 1, 'just under window -> soaking');
});

test('windowDays override beats manifest which beats default', () => {
  const tracked = { 'x.sh': 'h' };
  const entries = [{ path: 'x.sh', hash: 'h', landed: daysAgo(5) }];
  // default 7 (no windowDays in manifest) -> still soaking at 5 days
  assert.strictEqual(lib.buildReport({ tracked, manifest: { entries }, now: NOW }).soaking.length, 1);
  // manifest window 3 -> stable at 5 days
  assert.strictEqual(lib.buildReport({ tracked, manifest: { windowDays: 3, entries }, now: NOW }).stable.length, 1);
  // explicit override 10 wins over manifest 3 -> soaking again
  assert.strictEqual(lib.buildReport({ tracked, manifest: { windowDays: 3, entries }, now: NOW, windowDays: 10 }).soaking.length, 1);
});

test('gateFailures counts only unrecorded + changed + removed', () => {
  const report = { unrecorded: [1], changed: [1, 2], removed: [1], soaking: [1, 2, 3], stable: [1] };
  assert.strictEqual(lib.gateFailures(report), 4);
  assert.strictEqual(lib.gateFailures({ unrecorded: [], changed: [], removed: [], soaking: [1], stable: [1] }), 0);
});

test('land stamps new/changed now, preserves unchanged clock, drops deleted', () => {
  const tracked = { 'a.sh': 'h_a', 'b.sh': 'h_b_new', 'c.sh': 'h_c' };
  const manifest = {
    windowDays: 7,
    entries: [
      { path: 'a.sh', hash: 'h_a', landed: daysAgo(30) },     // unchanged
      { path: 'b.sh', hash: 'h_b_old', landed: daysAgo(30) }, // changed
      { path: 'gone.sh', hash: 'h_gone', landed: daysAgo(30) }, // deleted
      // c.sh is new
    ],
  };
  const next = lib.land({ tracked, manifest, now: NOW });
  const byPath = Object.fromEntries(next.entries.map((e) => [e.path, e]));

  assert.strictEqual(next.windowDays, 7, 'window carried forward');
  assert.strictEqual(byPath['a.sh'].landed, daysAgo(30), 'unchanged clock preserved');
  assert.strictEqual(byPath['b.sh'].landed, NOW, 'changed clock reset to now');
  assert.strictEqual(byPath['b.sh'].hash, 'h_b_new', 'changed hash updated');
  assert.strictEqual(byPath['c.sh'].landed, NOW, 'new file stamped now');
  assert.ok(!('gone.sh' in byPath), 'deleted file dropped from ledger');

  // After an unfiltered land the gate must pass.
  assert.strictEqual(lib.gateFailures(lib.buildReport({ tracked, manifest: next, now: NOW })), 0);
});

test('land is pure (does not mutate the input manifest)', () => {
  const manifest = { windowDays: 7, entries: [{ path: 'a.sh', hash: 'old', landed: daysAgo(30) }] };
  const snapshot = JSON.stringify(manifest);
  lib.land({ tracked: { 'a.sh': 'new' }, manifest, now: NOW });
  assert.strictEqual(JSON.stringify(manifest), snapshot, 'input manifest untouched');
});

test('land with a path filter acknowledges only the listed paths', () => {
  const tracked = { 'a.sh': 'h_a_new', 'b.sh': 'h_b_new' };
  const manifest = {
    windowDays: 7,
    entries: [
      { path: 'a.sh', hash: 'h_a_old', landed: daysAgo(30) },
      { path: 'b.sh', hash: 'h_b_old', landed: daysAgo(30) },
    ],
  };
  const next = lib.land({ tracked, manifest, now: NOW, paths: ['a.sh'] });
  const byPath = Object.fromEntries(next.entries.map((e) => [e.path, e]));

  assert.strictEqual(byPath['a.sh'].hash, 'h_a_new', 'listed path refreshed');
  assert.strictEqual(byPath['a.sh'].landed, NOW);
  assert.strictEqual(byPath['b.sh'].hash, 'h_b_old', 'unlisted path keeps old record');

  // b.sh remains a gate failure (still changed) after the scoped land.
  const r = lib.buildReport({ tracked, manifest: next, now: NOW });
  assert.deepStrictEqual(r.changed.map((x) => x.path), ['b.sh']);
});

test('empty tracked set with empty manifest is a clean pass', () => {
  const r = lib.buildReport({ tracked: {}, manifest: { entries: [] }, now: NOW });
  assert.strictEqual(lib.gateFailures(r), 0);
  assert.strictEqual(r.windowDays, lib.DEFAULT_WINDOW_DAYS);
});

// ---------------------------------------------------------------------------
// Outcome attribution — hook/settings path -> Loki query plan.

// A minimal chezmoi-templated hooks section, shaped like the real
// settings.base.json: a Jinja comment before the opening brace, an
// OS-gated hook object, an OS-branched command string, a matcher shared by
// two hooks (unattributable), a matcher owned by exactly one hook
// (attributable), and a lifecycle event with no tool_decision counterpart
// (PostToolUse — always unattributable regardless of sibling count).
const HOOKS_FIXTURE = `{
  "schema": "x",
  "hooks": {{/* comment before the brace, like the real file */}}{
    "PermissionRequest": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/allow-a.sh" },
          { "type": "command", "command": "~/.claude/hooks/allow-b.sh" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Read|Edit|Write",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/protect-secrets.sh" }
        ]
      },
      {{/* OS-gated whole object, kept on every OS this repo targets */}}{{ if ne .chezmoi.os "windows" }}{
        "matcher": "Bash",
        "hooks": [
          {
            "command": "{{ if eq .chezmoi.os "windows" }}py -3 ~/.claude/hooks/wrap.py{{ else }}~/.claude/hooks/wrap.sh{{ end }}"
          }
        ]
      }{{ end }}
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/lint-after-edit.sh" }
        ]
      }
    ]
  },
  "worktree": { "baseRef": "fresh" }
}`;

test('parseHooksConfig strips chezmoi template comments/conditionals and parses the hooks object', () => {
  const cfg = lib.parseHooksConfig(HOOKS_FIXTURE);
  assert.ok(cfg, 'parses successfully');
  assert.deepStrictEqual(Object.keys(cfg), ['PermissionRequest', 'PreToolUse', 'PostToolUse']);
  assert.strictEqual(cfg.PreToolUse[0].matcher, 'Read|Edit|Write');
  // the OS-branched command string keeps both basenames concatenated —
  // findHookRegistrations only needs to find the one it's looking for.
  assert.match(cfg.PreToolUse[1].hooks[0].command, /wrap\.sh/);
});

test('parseHooksConfig returns null when the file has no hooks section or fails to parse', () => {
  assert.strictEqual(lib.parseHooksConfig('{"schema":"x"}'), null);
  assert.strictEqual(lib.parseHooksConfig('{"hooks": {not valid json'), null);
});

test('attributeEntry: a settings.*.json path is always attributable via source="config"', () => {
  const r = lib.attributeEntry('home/.chezmoitemplates/settings.base.json', null);
  assert.strictEqual(r.inScope, true);
  assert.strictEqual(r.attributable, true);
  assert.deepStrictEqual(r.slices, [{ source: 'config', toolNameRegex: null }]);
});

test('attributeEntry: a path outside hooks/ and settings.*.json is out of scope entirely', () => {
  const r = lib.attributeEntry('home/private_dot_claude/agents/chore.md', lib.parseHooksConfig(HOOKS_FIXTURE));
  assert.deepStrictEqual(r, { inScope: false });
});

test('ATTRIBUTABLE — a hook that is the sole registrant of its matcher maps to a Loki query slice', () => {
  const cfg = lib.parseHooksConfig(HOOKS_FIXTURE);
  const r = lib.attributeEntry('home/private_dot_claude/hooks/executable_protect-secrets.sh', cfg);
  assert.strictEqual(r.inScope, true);
  assert.strictEqual(r.attributable, true, 'protect-secrets.sh is the only hook on its matcher');
  assert.deepStrictEqual(r.slices, [{ source: 'hook', toolNameRegex: '^(Read|Edit|Write)$' }]);
});

test('UNATTRIBUTABLE — a hook sharing its matcher with a sibling gets source:none, not a false zero', () => {
  const cfg = lib.parseHooksConfig(HOOKS_FIXTURE);
  const r = lib.attributeEntry('home/private_dot_claude/hooks/executable_allow-a.sh', cfg);
  assert.strictEqual(r.inScope, true);
  assert.strictEqual(r.attributable, false);
  assert.match(r.note, /shares the PermissionRequest\/Bash matcher with allow-b\.sh/);
});

test('UNATTRIBUTABLE — a lifecycle-event hook (PostToolUse) has no tool_decision counterpart at all', () => {
  const cfg = lib.parseHooksConfig(HOOKS_FIXTURE);
  const r = lib.attributeEntry('home/private_dot_claude/hooks/executable_lint-after-edit.sh', cfg);
  assert.strictEqual(r.attributable, false);
  assert.match(r.note, /PostToolUse hooks emit no tool_decision event/);
});

test('UNATTRIBUTABLE — a hook not referenced anywhere in the hooks config (a sourced library, not a hook)', () => {
  const cfg = lib.parseHooksConfig(HOOKS_FIXTURE);
  const r = lib.attributeEntry('home/private_dot_claude/hooks/cmdparse.sh', cfg);
  assert.strictEqual(r.attributable, false);
  assert.match(r.note, /is not referenced in settings\.base\.json's hooks config/);
});

test('attributeHookPath strips the chezmoi executable_ source prefix before matching', () => {
  const cfg = lib.parseHooksConfig(HOOKS_FIXTURE);
  const withPrefix = lib.attributeHookPath('home/private_dot_claude/hooks/executable_protect-secrets.sh', cfg);
  const bare = lib.attributeHookPath('home/private_dot_claude/hooks/protect-secrets.sh', cfg);
  assert.deepStrictEqual(withPrefix, bare);
  assert.strictEqual(withPrefix.attributable, true);
});

test('a missing/unparseable hooks config makes every hook path unattributable, never a false zero', () => {
  const r = lib.attributeHookPath('home/private_dot_claude/hooks/executable_protect-secrets.sh', null);
  assert.strictEqual(r.attributable, false);
  assert.match(r.note, /could not be parsed/);
});

test('buildOutcomeQueries: a single slice builds the expected fired/denied/errors LogQL', () => {
  const q = lib.buildOutcomeQueries([{ source: 'config', toolNameRegex: null }], 3600);
  assert.strictEqual(
    q.fired,
    'sum(count_over_time({service_name="claude-code"} | json | event_name="tool_decision" | source="config" [3600s]))'
  );
  assert.match(q.denied, /decision="reject" \[3600s\]/);
  assert.match(q.errors, /decision!~"accept\|reject" \[3600s\]/);
});

test('buildOutcomeQueries: a tool_name filter is included only when the matcher is not "*"', () => {
  const q = lib.buildOutcomeQueries([{ source: 'hook', toolNameRegex: '^(Bash)$' }], 60);
  assert.match(q.fired, /tool_name=~"\^\(Bash\)\$"/);
});

test('buildOutcomeQueries: multiple slices are summed, one term per slice', () => {
  const slices = [
    { source: 'hook', toolNameRegex: '^(Bash)$' },
    { source: 'hook', toolNameRegex: '^(Read)$' },
  ];
  const q = lib.buildOutcomeQueries(slices, 10);
  const plusCount = (q.fired.match(/count_over_time/g) || []).length;
  assert.strictEqual(plusCount, 2, 'one count_over_time term per slice, summed');
});

test('buildOutcomeQueries: the range rounds up to a whole second and never drops to 0s', () => {
  assert.match(lib.buildOutcomeQueries([{ source: 'config' }], 0.2).fired, /\[1s\]/);
  assert.match(lib.buildOutcomeQueries([{ source: 'config' }], 90.1).fired, /\[91s\]/);
});

test('parseLokiScalar: a fake Loki instant-vector response with one series', () => {
  const fake = { status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: [1788437838, '12'] }] } };
  assert.strictEqual(lib.parseLokiScalar(fake), 12);
});

test('parseLokiScalar: multiple series are summed', () => {
  const fake = { data: { result: [{ value: [1, '3'] }, { value: [1, '4']}] } };
  assert.strictEqual(lib.parseLokiScalar(fake), 7);
});

test('parseLokiScalar: an empty result set is a real zero, not an error', () => {
  assert.strictEqual(lib.parseLokiScalar({ data: { result: [] } }), 0);
  assert.strictEqual(lib.parseLokiScalar({ data: {} }), 0);
  assert.strictEqual(lib.parseLokiScalar({}), 0);
});

test('makeOutcome / unattributedOutcome shape the two outcome variants', () => {
  const ok = lib.makeOutcome({ fired: 5, denied: 1, errors: 0, checkedAt: NOW });
  assert.deepStrictEqual(ok, { checkedAt: NOW, fired: 5, denied: 1, errors: 0, source: 'loki', note: '' });
  const none = lib.unattributedOutcome({ checkedAt: NOW, note: 'reason' });
  assert.deepStrictEqual(none, { checkedAt: NOW, fired: 0, denied: 0, errors: 0, source: 'none', note: 'reason' });
});

// ---------------------------------------------------------------------------
// "landed, never fired" — buildReport / gateFailures, red-proof pair.

test('NEVER FIRED (fires) — stable + source:loki + fired:0 is flagged', () => {
  const tracked = { 'h.sh': 'hash' };
  const manifest = {
    windowDays: 7,
    entries: [{ path: 'h.sh', hash: 'hash', landed: daysAgo(30), outcome: lib.makeOutcome({ fired: 0, denied: 0, errors: 0, checkedAt: NOW }) }],
  };
  const r = lib.buildReport({ tracked, manifest, now: NOW });
  assert.deepStrictEqual(r.neverFired.map((x) => x.path), ['h.sh']);
  // Not a gate failure by default...
  assert.strictEqual(lib.gateFailures(r), 0);
  // ...but IS one under --strict.
  assert.strictEqual(lib.gateFailures(r, { strict: true }), 1);
});

test('NEVER FIRED (does not fire) — three ways the rule must stay quiet', () => {
  const base = (outcome, landedDaysAgo = 30) => ({
    tracked: { 'h.sh': 'hash' },
    manifest: { windowDays: 7, entries: [{ path: 'h.sh', hash: 'hash', landed: daysAgo(landedDaysAgo), outcome }] },
  });

  // 1. it DID fire
  const fired = lib.buildReport({ ...base(lib.makeOutcome({ fired: 3, denied: 0, errors: 0, checkedAt: NOW })), now: NOW });
  assert.strictEqual(fired.neverFired.length, 0);

  // 2. source is "none" (unattributed) — a zero here is not evidence of anything
  const unattr = lib.buildReport({ ...base(lib.unattributedOutcome({ checkedAt: NOW, note: 'x' })), now: NOW });
  assert.strictEqual(unattr.neverFired.length, 0);

  // 3. still soaking (window not elapsed) — too early to call it never-fired
  const soaking = lib.buildReport({ ...base(lib.makeOutcome({ fired: 0, denied: 0, errors: 0, checkedAt: NOW }), 2), now: NOW });
  assert.strictEqual(soaking.neverFired.length, 0);
  assert.strictEqual(soaking.soaking.length, 1);

  // 4. no outcome recorded at all (outcomes never run)
  const noOutcome = lib.buildReport({ tracked: { 'h.sh': 'hash' }, manifest: { windowDays: 7, entries: [{ path: 'h.sh', hash: 'hash', landed: daysAgo(30) }] }, now: NOW });
  assert.strictEqual(noOutcome.neverFired.length, 0);
});

test('land preserves outcome for an unchanged file and drops it when content changes', () => {
  const outcome = lib.makeOutcome({ fired: 2, denied: 0, errors: 0, checkedAt: NOW });
  const manifest = {
    windowDays: 7,
    entries: [
      { path: 'a.sh', hash: 'h_a', landed: daysAgo(30), outcome },
      { path: 'b.sh', hash: 'h_b_old', landed: daysAgo(30), outcome },
    ],
  };
  const tracked = { 'a.sh': 'h_a', 'b.sh': 'h_b_new' }; // a unchanged, b changed
  const next = lib.land({ tracked, manifest, now: NOW });
  const byPath = Object.fromEntries(next.entries.map((e) => [e.path, e]));
  assert.deepStrictEqual(byPath['a.sh'].outcome, outcome, 'unchanged file keeps its outcome');
  assert.strictEqual('outcome' in byPath['b.sh'], false, 'changed file drops its stale outcome');
});
