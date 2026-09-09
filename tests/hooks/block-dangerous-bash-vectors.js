// The deny / allow corpus for block-dangerous-bash.sh, loaded from
// tests/fixtures/block-dangerous-bash-vectors.json so the pytest port of the hook
// (home/dot_local/share/claude-guard/tests/test_deny.py) and this suite assert one file.
// Each group carries the `why` that used to be the comment above it. `__HOME__` stands for
// the caller's home directory: the rm and write rules anchor on the path written out.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'block-dangerous-bash-vectors.json');
const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const flatten = (groups) => groups.flatMap((g) => g.commands.map((c) => c.split('__HOME__').join(os.homedir())));

const DENY = flatten(data.deny);
const ALLOW = flatten(data.allow);

module.exports = { DENY, ALLOW };
