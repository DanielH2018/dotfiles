'use strict';
// tools-inventory / build — where the three sources of truth meet. Curated prose from
// tools.json, structure from the source tree, and this host's answer from chezmoi are
// joined into one model, which render.js turns into the page.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { countLines, langOf, headerComment, coveredPaths, codeFiles, driftOf, hostState, humanCount, esc } = require('./core');
const { scanSources, chezmoiIgnored, hostLabel } = require('./sources');
const { renderPage } = require('./render');

const HOME = os.homedir();

function build(opts) {
  const sourceDir = opts.sourceDir;
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
  const data = JSON.parse(read(opts.dataPath) || '{}');
  if (!data.tools) throw new Error(`tools-inventory: no tool data at ${opts.dataPath}`);

  const inSource = (rel) => fs.existsSync(path.join(sourceDir, rel));
  const found = scanSources(sourceDir);
  const drift = driftOf(found, data.tools, (data.excluded || {}).paths, inSource);

  const ignored = chezmoiIgnored(sourceDir);
  drift.hostUnknown = !ignored;
  const exists = (rel) => fs.existsSync(path.join(HOME, rel));
  const gateNote = ignored ? null : 'ignore list unavailable';

  const tools = data.tools.filter((t) => !t.source || inSource(t.source));
  let lineTotal = 0;

  for (const t of tools) {
    const files = codeFiles(t);
    const lines = files.reduce((n, p) => n + countLines(read(path.join(sourceDir, p))), 0);
    if (!t.noLines && lines) lineTotal += lines;
    t.metaLine = t.langLabel
      ? t.noLines || !lines
        ? t.langLabel
        : `${t.langLabel} · ${lines.toLocaleString('en-US')} lines`
      : '';
    t.host = ignored ? hostState(t.deployed, ignored, exists) : t.deployed && exists(t.deployed) ? 'here' : 'n/a';
    t.gateNote = t.host === 'gated' ? gateNote : null;
    t.hasTests = !!t.tests && fs.existsSync(path.join(sourceDir, t.tests));
  }

  // Uncurated scripts still get a card, built from the file itself.
  const groups = data.groups.slice();
  if (drift.uncurated.length) {
    groups.push({ id: 'uncurated', title: 'Not yet curated', note: 'Present in the source tree with no <code>tools.json</code> entry. Shown from the script\'s own header comment; add an entry to give it a real card.' });
    for (const rel of drift.uncurated) {
      const text = read(path.join(sourceDir, rel));
      const name = path.basename(rel).replace(/^(executable_|symlink_)/, '');
      tools.push({
        id: `uncurated-${name}`,
        name,
        group: 'uncurated',
        source: rel,
        lang: langOf(text.split('\n')[0], name),
        plat: ['mac', 'linux', 'wsl', 'win'],
        platLabel: 'platform not curated',
        role: [],
        host: 'n/a',
        metaLine: `${countLines(text).toLocaleString('en-US')} lines`,
        desc: esc(headerComment(text)) || '<em>No header comment to describe it.</em>',
        badges: [{ cls: 'b-inert', text: `uncurated — ${rel}` }],
      });
    }
  }

  const pathEntries = found.filter((p) => p.startsWith('dot_local/bin/'));
  const pathTools = tools.filter((t) => (t.deployed || '').startsWith('.local/bin/'));
  const deployedHere = pathTools.filter((t) => t.host === 'here');
  const gatedHere = pathTools.filter((t) => t.host === 'gated' || t.host === 'absent');
  const covered = coveredPaths(tools);
  const pathCount = pathEntries.filter((p) => covered.has(p) || drift.uncurated.includes(p)).length;
  const deployedCount = deployedHere.reduce((n, t) => n + 1 + (t.alsoCovers || []).length, 0);
  const gatedCount = gatedHere.reduce((n, t) => n + 1 + (t.alsoCovers || []).length, 0);

  return renderPage({
    page: data.page,
    groups,
    tools,
    drift,
    host: { label: hostLabel(), sourceDisplay: sourceDir.replace(HOME, '~') },
    tiles: [
      { cls: 'b', n: String(pathCount), l: 'commands on PATH' },
      { cls: 'g', n: String(deployedCount), l: 'deployed here' },
      // Not "gated": this counts platform-gated entries AND ones simply not applied yet,
      // and the tile cannot tell you which without lying about one of them.
      { cls: 'y', n: String(gatedCount), l: 'not on this box' },
      { cls: 'm', n: humanCount(lineTotal), l: 'lines of script' },
    ],
  });
}

module.exports = { build };
