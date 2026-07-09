const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BASE = path.join(__dirname, '..', 'home', 'private_dot_claude', 'sandbox', 'settings.base.json');
const raw = fs.readFileSync(BASE, 'utf8');
const parsed = JSON.parse(raw);                                   // must be valid JSON
assert.ok(parsed.permissions && Array.isArray(parsed.permissions.deny), 'has permissions.deny');
assert.ok(!/lithic|grafana|pagerduty/i.test(raw), 'no work-MCP vendor names in base');

// Git-boundary protection: a compromised session must not be able to rewrite
// the sensitive git-config keys that lead to token exfiltration or RCE.
// (The strongest control is the read-only ~/.gitconfig bind mount in the
// launcher; these deny rules cover the `git config` command path.)
const deny = parsed.permissions.deny;
for (const key of ['credential.helper', 'core.hooksPath', 'core.sshCommand', '.insteadOf']) {
  assert.ok(
    deny.includes(`Bash(git config *${key}*)`),
    `denies git config writes to ${key}`
  );
}

console.log('ALL PASS');
