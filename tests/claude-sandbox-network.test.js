// The create-filter is only a chokepoint if the sandbox has no route around it.
// Before the split, proxy, filter and sandbox shared one bridge network, so DOCKER_HOST
// pointing at the filter was the only thing keeping traffic off the proxy — a direct
// connection to the proxy alias bypassed body inspection entirely (A11-01).
//
// Topology is not reachable without starting containers, so these are structural
// assertions over the launcher: the sandbox and the proxy must never name the same
// network, and the filter is the only container attached to both.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SANDBOX_DIR = path.join(__dirname, '..', 'home', 'private_dot_claude', 'sandbox');
const SANDBOX = path.join(SANDBOX_DIR, 'executable_claude-sandbox');
// The launcher plus the libs it sources, concatenated: start_proxy/start_filter/
// stop_proxy now live in sandbox-proxy.sh while the sandbox's own `docker run` stays
// at top level in the launcher, and the assertions below only mean anything when
// both are in view. Launcher first, so line numbers inside it are unchanged.
const SRC = [SANDBOX, ...fs.readdirSync(SANDBOX_DIR)
  .filter((f) => /^executable_sandbox-.*\.sh$/.test(f))
  .sort()
  .map((f) => path.join(SANDBOX_DIR, f))]
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');

const LINES = SRC.split('\n');

// Inclusive [start, end] line range of <name>() { ... }, by brace depth.
function fnRange(name) {
  const start = LINES.findIndex((l) => l.startsWith(`${name}() {`));
  assert.notStrictEqual(start, -1, `${name}() not found`);
  let depth = 0;
  for (let i = start; i < LINES.length; i++) {
    for (const ch of LINES[i]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (depth === 0) return { start, end: i };
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

const fn = (name) => {
  const { start, end } = fnRange(name);
  return LINES.slice(start, end + 1).join('\n');
};

// Argument of every `--network <x>` in a block, ignoring --network-alias.
const networksIn = (block) =>
  [...block.matchAll(/--network\s+"?\$\{?(\w+)\}?"?/g)].map((m) => m[1]);

test('the two network names are distinct variables', () => {
  assert.match(SRC, /^NETWORK_NAME="claudebot-net-\$RUN_ID"$/m);
  assert.match(SRC, /^PROXY_NETWORK_NAME="claudebot-net-\$RUN_ID-proxy"$/m);
});

test('proxy attaches to the proxy network only', () => {
  assert.deepStrictEqual(networksIn(fn('start_proxy')), ['PROXY_NETWORK_NAME']);
});

test('the proxy network is created --internal', () => {
  assert.match(fn('start_proxy'), /docker network create --internal "\$PROXY_NETWORK_NAME"/);
});

test('filter starts on the proxy network and joins the sandbox network after', () => {
  const body = fn('start_filter');
  assert.deepStrictEqual(networksIn(body), ['PROXY_NETWORK_NAME'],
    'filter must be created on the proxy side so FILTER_UPSTREAM resolves at once');
  assert.match(body, /docker network connect --alias "\$FILTER_ALIAS" "\$NETWORK_NAME" "\$FILTER_NAME"/);
});

test('the sandbox container joins the sandbox network and nothing else', () => {
  // The sandbox `docker run` lives at top level, not in a function; take every
  // --network outside the proxy/filter helpers. Exclude by line RANGE, not by
  // string membership: a line that merely reads the same as one inside a helper
  // (`  fi`, a repeated flag) would otherwise be dropped from the scan too,
  // letting a stray --network PROXY_NETWORK_NAME slip past this assert.
  const ranges = ['start_proxy', 'start_filter'].map(fnRange);
  const outside = LINES
    .filter((_, i) => !ranges.some(({ start, end }) => i >= start && i <= end))
    .join('\n');
  const names = new Set(networksIn(outside));
  assert.ok(names.has('NETWORK_NAME'), 'sandbox joins NETWORK_NAME');
  assert.ok(!names.has('PROXY_NETWORK_NAME'),
    'nothing outside the proxy/filter helpers may join the proxy network');
});

test('both networks are torn down', () => {
  const body = fn('stop_proxy');
  assert.match(body, /docker network rm "\$NETWORK_NAME"/);
  assert.match(body, /docker network rm "\$PROXY_NETWORK_NAME"/);
});

test('stale networks from a previous run are cleared before create', () => {
  const body = fn('start_proxy');
  const rmAt = body.indexOf('docker network rm "$PROXY_NETWORK_NAME"');
  const createAt = body.indexOf('docker network create --internal');
  assert.ok(rmAt !== -1 && rmAt < createAt, 'rm must precede create');
});
