// Unit tests for bin/check-tools-inventory — the pre-push step that fails a push whose
// source tree has a command script tools.json does not describe (#635).
//
// An accept/reject pair on one fixture, because a gate that fires on everything and one
// that fires on nothing look the same from the passing side. The reject case also asserts
// the drift line itself: tools-inventory exits 1 on a malformed tools.json too, so an
// exit code alone would pass for the wrong reason.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { have } = require('../lib/probe');
const { repoPath, srcPath } = require('../lib/paths');

const SCRIPT = repoPath('bin', 'check-tools-inventory');
const skip = have('bash') ? false : 'bash unavailable';

// A source tree holding one curated command, and a tools.json describing only it. The
// entry and the page metadata come from the real tools.json, so the fixture exercises the
// renderer the gate runs rather than a schema this file would have to keep in step.
function fixture() {
  const root = fs.realpathSync(scratch(os.tmpdir(), 'toolsinv-'));
  const real = JSON.parse(fs.readFileSync(srcPath('dot_local', 'share', 'tools-inventory', 'tools.json'), 'utf8'));
  const tool = real.tools.find((t) => (t.source || '').startsWith('dot_local/bin/executable_'));
  const source = path.join(root, 'home');
  fs.mkdirSync(path.join(source, 'dot_local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(source, tool.source), '#!/bin/sh\n# curated\n');
  const data = path.join(root, 'tools.json');
  fs.writeFileSync(data, JSON.stringify({ ...real, tools: [tool], excluded: { paths: [] } }));
  const home = path.join(root, 'fake-home');
  fs.mkdirSync(home);
  return { source, data, home };
}

function gate({ source, data, home }) {
  return spawnSync('bash', [SCRIPT, source, data], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
}

test('a tree whose every script is curated passes, and writes nothing under $HOME', { skip }, () => {
  const fx = fixture();
  const r = gate(fx);
  assert.strictEqual(r.status, 0, `expected a pass, got ${r.status}: ${r.stderr}`);
  assert.deepStrictEqual(fs.readdirSync(fx.home), [], 'the gate step must stay read-only');
});

test('a tree with an uncurated ~/.local/bin script fails and names it', { skip }, () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.source, 'dot_local', 'bin', 'executable_stray'), '#!/bin/sh\n# stray\n');
  const r = gate(fx);
  assert.strictEqual(r.status, 1, `expected a failure, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /no tools\.json entry for dot_local\/bin\/executable_stray/);
});
