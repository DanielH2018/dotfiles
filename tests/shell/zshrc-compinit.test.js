// Slice 1 of M16+M21 (see specs/env-modules/M16-M21-platform-shell.md §6): the
// stale-cache + duplicate-compinit fix in home/dot_zshrc.tmpl.
//
// Two bugs pinned here:
// - A14-07: the "full" compinit branch (dump older than 24h, or absent) never
//   touched $ZCOMPDUMP afterward, so the 24h freshness guard never actually reset
//   and the slow branch kept firing on every start instead of once a day.
// - A14-09: a second, undirected `compinit` lived in the darwin-only Docker
//   completions block near EOF, doubling compinit's cost on macOS; its fpath entry
//   now folds into the single Phase-2 fpath block instead.
//
// The darwin block can't be exercised via `chezmoi execute-template` on this Linux
// box (chezmoi resolves `.chezmoi.os` from the real host), so those assertions read
// the raw template text directly rather than a render.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { renderTemplate } = require('../lib/render');
const { have } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const TMPL = srcPath('dot_zshrc.tmpl');
const raw = fs.readFileSync(TMPL, 'utf8');

const skip = !have('chezmoi') ? 'chezmoi unavailable' : false;

test('exactly one autoload of compinit in the whole file', () => {
  const hits = raw.match(/^autoload -Uz compinit$/gm) || [];
  assert.strictEqual(hits.length, 1, 'a second autoload means a second, undirected compinit call is still reachable (A14-09)');
});

test('no bare unconditional compinit call remains (only the guarded -d/-C pair)', () => {
  const bare = raw.match(/^\s*compinit\s*$/gm) || [];
  assert.deepStrictEqual(bare, [], 'the darwin Docker-completions block used to end with a bare `compinit` call');
});

test('the Docker completions fpath entry folds into the Phase-2 fpath block, not near EOF', () => {
  const fpathBlock = raw.slice(raw.indexOf('fpath=("$HOME/.claude/sandbox"'), raw.indexOf('autoload -Uz compinit'));
  assert.match(fpathBlock, /fpath=\("\$HOME\/\.docker\/completions" \$fpath\)/, 'docker completions fpath must live in the Phase-2 block (A14-09)');

  const sdkmanIdx = raw.indexOf('SDKMAN TO WORK');
  assert.ok(sdkmanIdx !== -1, 'sanity: SDKMAN marker still present');
  assert.doesNotMatch(raw.slice(sdkmanIdx), /\.docker\/completions/, 'docker completions must no longer be duplicated near EOF');
});

test('the full compinit branch touches $ZCOMPDUMP immediately afterward, before the else', () => {
  const m = raw.match(/if \[\[ -n "\$ZCOMPDUMP"\(#qN\.mh\+24\) \]\]; then\n([\s\S]*?)\nelse/);
  assert.ok(m, 'the freshness-guarded if/else must still be present');
  const fullBranch = m[1];
  assert.match(fullBranch, /compinit -d "\$ZCOMPDUMP"/, 'full branch must still call compinit -d');
  assert.match(fullBranch, /touch "\$ZCOMPDUMP"/, 'full branch must touch the dump so the 24h guard resets (A14-07)');
  // Order matters: touching before compinit runs would be overwritten by compinit's own write.
  assert.ok(fullBranch.indexOf('compinit -d') < fullBranch.indexOf('touch "$ZCOMPDUMP"'), 'touch must come after compinit -d, not before');
});

test('the fast (-C) branch is untouched', () => {
  assert.match(raw, /compinit -C -d "\$ZCOMPDUMP"/, 'the cache-reuse branch must remain a plain compinit -C call');
});

test('render on this host is syntactically valid and preserves both fixes', { skip }, () => {
  const rendered = renderTemplate(raw, { source: null });
  assert.match(rendered, /touch "\$ZCOMPDUMP"/);
  const compinitAutoloads = rendered.match(/^autoload -Uz compinit$/gm) || [];
  assert.strictEqual(compinitAutoloads.length, 1, 'this host renders the non-darwin branch, so exactly one autoload either way');
});
