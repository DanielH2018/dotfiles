// Checks for the homelab Warp launch configuration, which records this PC's tab groups.
//
// Warp fails silently on both mistakes these guard against. A launch configuration with a `~`
// or empty `cwd` is left out of the list with no error. A tab whose `group` index points past
// the end of `tab_groups` loses its group. And the file names homelab hosts, so the `.work` gate
// that keeps it off a work machine has to match the path Windows deploys.
const { test } = require('node:test');
const assert = require('node:assert');
const { renderFile, chezmoiAvailable } = require('../lib/render');
const { srcPath } = require('../lib/paths');

const SOURCE = srcPath('AppData', 'Roaming', 'warp', 'Warp', 'data', 'launch_configurations', 'homelab.yaml.tmpl');
const TARGET = 'AppData/Roaming/warp/Warp/data/launch_configurations/homelab.yaml';
const skip = chezmoiAvailable ? false : 'chezmoi unavailable';
// The ignore file spells this path only in its Windows branch, so other OSes cannot check the gate.
const gateSkip = skip || (process.platform === 'win32' ? false : 'the gate is Windows-only');

const ignored = (work) =>
  new Set(renderFile(srcPath('.chezmoiignore'), { data: { work } }).split('\n').map((l) => l.trim()));

test('a work machine does not get the homelab launch configuration', { skip: gateSkip }, () => {
  assert.ok(ignored(true).has(TARGET), 'the launch configuration names homelab hosts and must be gated');
});

test('a personal machine gets the homelab launch configuration', { skip: gateSkip }, () => {
  assert.ok(!ignored(false).has(TARGET), 'the gate is inverted; the personal PC loses its layout');
});

test('every tab has an absolute cwd', { skip }, () => {
  const cwds = [...renderFile(SOURCE).matchAll(/^\s+cwd: (.*)$/gm)].map((m) => m[1].trim());
  assert.ok(cwds.length > 0, 'no cwd found');
  for (const cwd of cwds) {
    assert.match(cwd, /^([A-Za-z]:)?\//, `Warp hides a launch configuration with cwd "${cwd}"`);
  }
});

test('every group index names an entry in tab_groups', { skip }, () => {
  const body = renderFile(SOURCE);
  const [, groupBlock = ''] = body.split(/^\s+tab_groups:$/m);
  const groups = [...groupBlock.matchAll(/^\s+- name: (.+)$/gm)].map((m) => m[1]);
  const indexes = [...body.matchAll(/^\s+group: (\d+)$/gm)].map((m) => Number(m[1]));
  assert.ok(groups.length > 0, 'no tab_groups found');
  for (const i of indexes) {
    assert.ok(i < groups.length, `group ${i} points past the ${groups.length} defined groups`);
  }
  // A group that no tab points at means an index was mistyped, since every live group has tabs.
  assert.deepStrictEqual([...new Set(indexes)].sort((a, b) => a - b), groups.map((_, i) => i));
});
