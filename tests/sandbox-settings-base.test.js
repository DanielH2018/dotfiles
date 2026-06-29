const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BASE = path.join(__dirname, '..', 'home', 'private_dot_claude', 'sandbox', 'settings.base.json');
const raw = fs.readFileSync(BASE, 'utf8');
const parsed = JSON.parse(raw);                                   // must be valid JSON
assert.ok(parsed.permissions && Array.isArray(parsed.permissions.deny), 'has permissions.deny');
assert.ok(!/lithic|grafana|pagerduty/i.test(raw), 'no work-MCP vendor names in base');
console.log('ALL PASS');
