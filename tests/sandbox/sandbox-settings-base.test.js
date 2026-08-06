const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BASE = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'sandbox', 'settings.base.json');
const raw = fs.readFileSync(BASE, 'utf8');
const parsed = JSON.parse(raw);                                   // must be valid JSON

test('base settings expose permissions.deny and no work-MCP vendor names', () => {
  assert.ok(parsed.permissions && Array.isArray(parsed.permissions.deny), 'has permissions.deny');
  assert.ok(!/lithic|grafana|pagerduty/i.test(raw), 'no work-MCP vendor names in base');
});

// Git-boundary protection: a compromised session must not be able to rewrite
// the sensitive git-config keys that lead to token exfiltration or RCE.
// (The strongest control is the read-only ~/.gitconfig bind mount in the
// launcher; these deny rules cover the `git config` command path.)
test('denies git config writes to sensitive keys', () => {
  const deny = parsed.permissions.deny;
  for (const key of ['credential.helper', 'core.hooksPath', 'core.sshCommand', '.insteadOf']) {
    assert.ok(
      deny.includes(`Bash(git config *${key}*)`),
      `denies git config writes to ${key}`
    );
  }
});

// Agent View Phase 2 (in-container live state): the state hook is wired to the
// UserPromptSubmit/Notification/Stop events with the right state argument, and NEVER to
// a delete — the host launcher owns lifecycle, so the container must not remove rows.
test('agent-view state hook wiring never deletes a row', () => {
  const H = parsed.hooks;
  const has = (evt, state) =>
    Array.isArray(H[evt]) && /agent-view-state-hook\.sh (\w[\w-]*)/.test(JSON.stringify(H[evt])) &&
    JSON.stringify(H[evt]).includes(`agent-view-state-hook.sh ${state}`);
  assert.ok(has('UserPromptSubmit', 'working'), 'UserPromptSubmit -> working');
  assert.ok(has('Notification', 'needs-input'), 'Notification -> needs-input');
  assert.ok(has('Stop', 'completed'), 'Stop -> completed');
  assert.ok(!/agent-view-state-hook\.sh end/.test(raw), 'container hook never deletes a row (no `end`)');
});

// Claude Code parses a permission rule as Bash(<pattern>) by matching parens.
// An unbalanced pattern is not a partial match — the whole rule is DISCARDED
// with a startup warning, so a deny that reads as present in this file enforces
// nothing. Four process-substitution rules shipped that way: the wrapper's
// closing paren was consumed by the one `<(` opens, leaving the rule unparseable.
test('every Bash() permission rule has balanced parentheses', () => {
  const broken = [];
  for (const bucket of ['allow', 'deny', 'ask']) {
    for (const rule of parsed.permissions[bucket] ?? []) {
      if (!rule.startsWith('Bash(') || !rule.endsWith(')')) continue;
      const pattern = rule.slice('Bash('.length, -1);
      let depth = 0;
      for (const ch of pattern) {
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
        if (depth < 0) break;
      }
      if (depth !== 0) broken.push(`${bucket}: ${rule}`);
    }
  }
  assert.deepStrictEqual(broken, [],
    'these rules are silently skipped at startup and enforce nothing');
});

test('the process-substitution denies survive parsing', () => {
  // Belt and braces with block-dangerous-bash.sh, which this same file wires as
  // a PreToolUse hook and which is the control that actually stops downloaded
  // content being fed to a shell. These rules are the declarative second layer.
  for (const shell of ['bash', 'sh']) {
    for (const fetcher of ['curl', 'wget']) {
      const rule = `Bash(${shell} <(${fetcher} *)*)`;
      assert.ok(parsed.permissions.deny.includes(rule), `${rule} is present and parseable`);
    }
  }
});

// Same defect as the host template, same fix: `idle_prompt` is Claude's 60-second "waiting for
// your input" nudge, which fires long after a session has finished. The agentview state hook
// writes unconditionally, so that reminder overwrote a completed/review row with needs-input and
// wiped the dirty-tree marker Stop had just stamped. Fixed in one place only, the container's
// rows would still lie — the host and the sandbox feed the same picker.
test('the agentview needs-input hook does not fire on the idle reminder', () => {
  const entries = ((parsed.hooks || {}).Notification || []).filter((e) =>
    (e.hooks || []).some((h) => (h.command || '').includes('agent-view-state-hook.sh needs-input')));
  assert.ok(entries.length, 'no Notification entry writes the agentview needs-input state');
  for (const e of entries) {
    assert.doesNotMatch(e.matcher, /idle_prompt/,
      `the agentview state hook still fires on idle_prompt: ${e.matcher}`);
    assert.match(e.matcher, /permission_prompt/,
      'a genuine permission prompt must still mark the row needs-input');
  }
});
