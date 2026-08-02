'use strict';
// tools-inventory / render — model to HTML. Nothing here reads the source tree or asks
// chezmoi anything; it is handed a finished model by build.js and turns it into the page.
//
// The stylesheet and the browser behaviour live beside this file as real .css and .js
// under assets/, not as template literals in it. They are the two blocks that never change
// for the same reason the rest of the generator does, and inlining them cost a doubled
// backslash in every regex the browser block contained.

const fs = require('node:fs');
const path = require('node:path');

const { esc } = require('./core');

const ASSETS = path.join(__dirname, 'assets');
const cache = new Map();

// Read on first use, not at require time. A missing asset must surface as a build failure
// that main() catches — leaving the previous page in place — rather than an uncaught
// throw during `chezmoi apply`.
//
// Trailing newline trimmed because these are files now: the blocks they replaced ended at
// their last brace, and the page has to keep rendering byte-identically or every apply
// rewrites it.
function asset(name) {
  if (!cache.has(name)) {
    cache.set(name, fs.readFileSync(path.join(ASSETS, name), 'utf8').trimEnd());
  }
  return cache.get(name);
}

const PLAT_LABEL = { mac: 'macOS', linux: 'Linux', wsl: 'WSL', win: 'Windows' };

function badge(cls, text) {
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

function renderBadges(t) {
  const out = [];
  out.push(badge('b-plat', t.platLabel || (t.plat || []).map((p) => PLAT_LABEL[p]).join(' · ')));
  if (t.host === 'here') out.push(badge('b-live', 'deployed here'));
  else if (t.host === 'gated') out.push(badge('b-off', `not deployed here${t.gateNote ? ` (${t.gateNote})` : ''}`));
  else if (t.host === 'absent') out.push(badge('b-off', 'not deployed here'));
  for (const b of t.badges || []) out.push(badge(b.cls, b.text));
  if (t.hasTests) out.push(badge('b-test', 'has tests'));
  return `<div class="badges">${out.join('')}</div>`;
}

function renderCard(t) {
  const attrs =
    `data-plat="${(t.plat || []).join(' ')}" data-role="${(t.role || []).join(' ')}"` +
    ` data-lang="${t.lang || 'other'}" data-here="${t.host === 'here' ? '1' : '0'}"`;
  const meta = t.metaLine ? `<span class="meta">${esc(t.metaLine)}</span>` : '';
  const alias = t.alias ? `<span class="alias">${esc(t.alias)}</span>` : '';
  const parts = [
    `<div class="tool" ${attrs}>`,
    `<div class="thead"><span class="name">${esc(t.name)}</span>${alias}${meta}</div>`,
    `<p class="desc">${t.desc}</p>`,
  ];
  if (t.why) parts.push(`<p class="why">${t.why}</p>`);
  parts.push(renderBadges(t));
  if (t.pre) parts.push(`<pre>${t.pre}</pre>`);
  for (const f of t.flags || []) {
    parts.push(`<p class="flags"><b>${esc(f.label)}</b> ${f.html}</p>`);
  }
  parts.push('</div>');
  return parts.join('\n');
}

function renderCompact(t) {
  const attrs =
    `data-plat="${(t.plat || []).join(' ')}" data-role="${(t.role || []).join(' ')}"` +
    ` data-lang="${t.lang || 'other'}" data-here="${t.host === 'here' ? '1' : '0'}"`;
  return [
    `<li class="tool" ${attrs}>`,
    `<b>${esc(t.name)}</b> — ${t.desc}`,
    renderBadges(t),
    '</li>',
  ].join('\n');
}

function renderDrift(drift) {
  if (!drift.uncurated.length && !drift.missing.length && !drift.hostUnknown) return '';
  const bits = [];
  if (drift.hostUnknown) {
    bits.push(
      '<p><b>The per-host column is missing.</b> <code>chezmoi ignored</code> could not be run, so ' +
        'this page cannot say which tools this machine actually got — every "deployed here" badge is ' +
        'absent rather than false. Everything else below is still accurate.</p>'
    );
  }
  if (drift.uncurated.length) {
    bits.push(
      `<p><b>${drift.uncurated.length} script${drift.uncurated.length === 1 ? '' : 's'} in the source tree ` +
        `${drift.uncurated.length === 1 ? 'has' : 'have'} no <code>tools.json</code> entry</b>, so ${
          drift.uncurated.length === 1 ? 'it is' : 'they are'
        } rendered below from ${drift.uncurated.length === 1 ? 'its' : 'their'} own header comment: ` +
        drift.uncurated.map((p) => `<code>${esc(p)}</code>`).join(', ') +
        '.</p>'
    );
  }
  if (drift.missing.length) {
    bits.push(
      `<p><b>${drift.missing.length} curated entr${drift.missing.length === 1 ? 'y has' : 'ies have'} ` +
        'no matching file</b> and ' +
        `${drift.missing.length === 1 ? 'was' : 'were'} dropped: ` +
        drift.missing.map((m) => `<code>${esc(m)}</code>`).join(', ') +
        '.</p>'
    );
  }
  return `<div class="drift"><p class="dhead">Inventory drift</p>${bits.join('')}</div>`;
}

function renderPage(model) {
  const { page, groups, tools, tiles, drift, host } = model;
  const byGroup = new Map(groups.map((g) => [g.id, []]));
  for (const t of tools) {
    if (!byGroup.has(t.group)) byGroup.set(t.group, []);
    byGroup.get(t.group).push(t);
  }

  const sections = groups
    .map((g) => {
      const items = byGroup.get(g.id) || [];
      if (!items.length) return '';
      const note = g.note ? `<p class="snote">${g.note}</p>` : '';
      const body = g.compact
        ? `<ul class="plain">\n${items.map(renderCompact).join('\n')}\n</ul>`
        : items.map(renderCard).join('\n');
      return `<section id="s-${esc(g.id)}">\n<h2>${esc(g.title)}</h2>\n${note}\n${body}\n</section>`;
    })
    .filter(Boolean)
    .join('\n\n');

  const tileHtml = tiles
    .map((t) => `<div class="tile ${t.cls}"><div class="n">${esc(t.n)}</div><div class="l">${esc(t.l)}</div></div>`)
    .join('\n    ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)}</title>
<style>
${asset('page.css')}
</style>
</head>
<body>
<div class="wrap">

<header class="mast">
  <h1>${esc(page.title)}</h1>
  <p class="lede">${page.lede}</p>
  <p class="src">Source: <code>${esc(host.sourceDisplay)}</code> · this host: <code>${esc(host.label)}</code>
  · regenerated by <code>tools-inventory</code> on every <code>chezmoi apply</code></p>

  <div class="tiles">
    ${tileHtml}
  </div>
</header>

${renderDrift(drift)}

<div class="scope">
  <p><b>In scope:</b> ${page.scopeIn}</p>
  <p><b>Out of scope:</b> ${page.scopeOut}</p>
</div>

<div class="filterbar">
  <div class="searchrow">
    <input id="q" type="search" placeholder="Search name, purpose, or flag — e.g. tmux, worktree, --scope" autocomplete="off">
    <button id="reset" type="button" disabled>Clear</button>
  </div>

  <div class="facets">
    <div class="facet" data-facet="plat">
      <span class="flabel">Platform</span>
      <div class="chips">
        <button class="chip" type="button" data-v="mac" aria-pressed="false">macOS</button>
        <button class="chip" type="button" data-v="linux" aria-pressed="false">Linux</button>
        <button class="chip" type="button" data-v="wsl" aria-pressed="false">WSL</button>
        <button class="chip" type="button" data-v="win" aria-pressed="false">Windows</button>
      </div>
    </div>
    <div class="facet" data-facet="here">
      <span class="flabel">Host</span>
      <div class="chips">
        <button class="chip" type="button" data-v="1" aria-pressed="false">On this box</button>
        <button class="chip" type="button" data-v="0" aria-pressed="false">Not deployed here</button>
      </div>
    </div>
    <div class="facet" data-facet="role">
      <span class="flabel">Role</span>
      <div class="chips">
        <button class="chip" type="button" data-v="typed" aria-pressed="false">Typed</button>
        <button class="chip" type="button" data-v="keybind" aria-pressed="false">Keybind</button>
        <button class="chip" type="button" data-v="timer" aria-pressed="false">Scheduled</button>
        <button class="chip" type="button" data-v="hook" aria-pressed="false">Claude hook</button>
        <button class="chip" type="button" data-v="called" aria-pressed="false">Called by another tool</button>
        <button class="chip" type="button" data-v="shim" aria-pressed="false">PATH shim</button>
        <button class="chip" type="button" data-v="library" aria-pressed="false">Library</button>
      </div>
    </div>
    <div class="facet" data-facet="lang">
      <span class="flabel">Language</span>
      <div class="chips">
        <button class="chip" type="button" data-v="bash" aria-pressed="false">bash / sh</button>
        <button class="chip" type="button" data-v="python" aria-pressed="false">Python</button>
        <button class="chip" type="button" data-v="node" aria-pressed="false">Node</button>
        <button class="chip" type="button" data-v="win" aria-pressed="false">PowerShell / C#</button>
        <button class="chip" type="button" data-v="other" aria-pressed="false">Other</button>
      </div>
    </div>
  </div>

  <div id="count"></div>
  <p class="legend"><b>Platform</b> means where the tool is deployed <em>and</em> does its job.
  A few that chezmoi deploys everywhere only function on one platform — <code>audio-sink-toggle</code>
  needs PipeWire, and <code>xclip</code>/<code>xsel</code>/<code>wl-bmp2png</code> need WSLg — so they
  are filed under that platform and their cards say so. Chips within a group are OR'd; groups are
  AND'd together, and with the search box.</p>
</div>

<div id="empty">No entries match those filters.</div>

${sections}

<footer>
  <p>Platform sets are curated in <code>tools.json</code>; line counts, test presence and the
  per-host column are derived at render time — the host column from <code>chezmoi ignored</code>,
  which is chezmoi evaluating its own templates, plus a filesystem check. Where a tool's platform is
  narrower than where chezmoi puts it (a runtime dependency rather than an ignore rule), the card
  says so. "Has tests" is a presence claim about test files in the source tree; no suite is run to
  produce this page.</p>
</footer>

</div>

<script>
${asset('page.js')}
</script>
</body>
</html>
`;
}

module.exports = {
  PLAT_LABEL, asset, badge, renderBadges, renderCard, renderCompact, renderDrift, renderPage,
};
