'use strict';
// Pure-logic tests for config-soak. No filesystem, network, or clock: `now`, the tracked
// paths and their landed dates are all injected, so these are total and deterministic.
const { test } = require('node:test');
const assert = require('node:assert');
const { repoPath } = require('../lib/paths');

const lib = require(repoPath('bin', 'config-soak-lib.js'));

const NOW = '2026-07-08T00:00:00.000Z';
const daysAgo = (n) => new Date(Date.parse(NOW) - n * lib.DAY_MS).toISOString();

test('classify sorts every path into unlanded, soaking or stable', () => {
  const r = lib.classify({
    paths: ['d.sh', 'c.sh', 'b.sh', 'a.sh'],
    landed: { 'a.sh': daysAgo(30), 'b.sh': daysAgo(2), 'c.sh': daysAgo(30) },
    pending: ['c.sh'],
    now: NOW,
  });
  assert.deepStrictEqual(r.stable.map((x) => x.path), ['a.sh']);
  assert.deepStrictEqual(r.soaking.map((x) => x.path), ['b.sh']);
  assert.ok(Math.abs(r.soaking[0].daysRemaining - 5) < 1e-9);
  // d.sh was never on main; c.sh is on main but this tree changed it since.
  assert.deepStrictEqual(r.unlanded, [{ path: 'c.sh', landed: daysAgo(30) }, { path: 'd.sh', landed: null }]);
  assert.strictEqual(r.windowDays, lib.DEFAULT_WINDOW_DAYS);
});

test('window boundary: exactly windowDays old is stable (>=)', () => {
  const r = lib.classify({ paths: ['a.sh'], landed: { 'a.sh': daysAgo(3) }, now: NOW, windowDays: 3 });
  assert.deepStrictEqual(r.stable.map((x) => x.path), ['a.sh']);
  assert.strictEqual(r.soaking.length, 0);
});

test('parseLandedLog keeps each path\'s newest date from a newest-first log walk', () => {
  const log = '\0' + '2026-07-07T00:00:00Z\n\na.sh\nb.sh\n' + '\0' + '2026-07-01T00:00:00Z\n\na.sh\nc.sh\n';
  assert.deepStrictEqual(lib.parseLandedLog(log), {
    'a.sh': '2026-07-07T00:00:00Z',
    'b.sh': '2026-07-07T00:00:00Z',
    'c.sh': '2026-07-01T00:00:00Z',
  });
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
