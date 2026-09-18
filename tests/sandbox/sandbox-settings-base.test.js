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

test('guard-pre-tool-use.sh is registered as the sandbox PreToolUse deny hook', () => {
  // The sandbox port replaced block-dangerous-bash.sh with the claude-guard shim here, which
  // was the last thing that ran the bash hook anywhere (slice 4 unregistered it on the host,
  // slice 6 deleted it).
  // Nothing else in the tree asserts this entry, so without this test an edit dropping it
  // would leave the sandbox with no deny hook and every test green.
  const cmds = JSON.stringify(parsed.hooks?.PreToolUse ?? []);
  assert.ok(cmds.includes('guard-pre-tool-use.sh'),
    'the sandbox PreToolUse block no longer registers guard-pre-tool-use.sh');
});

test('the sandbox env fails the deny hook closed', () => {
  // The shim's unevaluable-rules path prints `ask`, which the container's
  // --dangerously-skip-permissions skips -- so without this key a container missing uv, the
  // managed 3.14 or the package runs with no deny check and says nothing. The launcher passes
  // the same value as a docker env var; this is the second place, and both must agree.
  assert.strictEqual(parsed.env?.CLAUDE_GUARD_FAIL_CLOSED, '1',
    'CLAUDE_GUARD_FAIL_CLOSED=1 is what makes the sandbox deny rather than ask');
  assert.strictEqual(parsed.env?.CLAUDE_GUARD_DENY_SHADOW, undefined,
    'the deny-shadow switch was retired in claude-guard slice 6; a value here would be read by nothing');
});

test('the process-substitution denies survive parsing', () => {
  // Belt and braces with guard-pre-tool-use.sh, which this same file wires as
  // a PreToolUse hook and which is the control that actually stops downloaded
  // content being fed to a shell. These rules are the declarative second layer.
  for (const shell of ['bash', 'sh']) {
    for (const fetcher of ['curl', 'wget']) {
      const rule = `Bash(${shell} <(${fetcher} *)*)`;
      assert.ok(parsed.permissions.deny.includes(rule), `${rule} is present and parseable`);
    }
  }
});
