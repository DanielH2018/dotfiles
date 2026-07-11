"""HTML emit — inline CSS, zero-JS collapsibles via <details>/<summary> (SPEC.md §6)."""

from __future__ import annotations

from html import escape

from .model import CascadeNode, Category, Item, Layer, SetupMap

PROVENANCE_LABELS = {
    "chezmoi": "chezmoi",
    "generated": "generated",
    "work": "work",
    "project": "project",
    "unmanaged": "unmanaged",
    "inline": "inline",
}

CSS = """
:root{
  --bg:#f6f8fa; --panel:#ffffff; --panel2:#f0f2f5; --border:#d0d7de;
  --fg:#1f2328; --dim:#57606a; --faint:#8c959f;
  --accent:#0969da; --green:#1a7f37; --amber:#9a6700; --purple:#8250df;
  --code:#1f2328; --codebg:#f6f8fa;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0d1117; --panel:#161b22; --panel2:#1c2230; --border:#2b3340;
    --fg:#e6edf3; --dim:#9aa7b4; --faint:#6b7683;
    --accent:#58a6ff; --green:#3fb950; --amber:#d29922; --purple:#bc8cff;
    --code:#c9d1d9; --codebg:#010409;
  }
}
*{box-sizing:border-box}
body{
  margin:0; padding:2.2rem 1.2rem 4rem; background:var(--bg); color:var(--fg);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
.wrap{max-width:980px;margin:0 auto}
h1{font-size:1.55rem;margin:0 0 .2rem;letter-spacing:-.01em}
h2{font-size:1.05rem;margin:0;font-weight:600}
.sub{color:var(--dim);margin:.1rem 0 1.4rem;font-size:.95rem}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em;
  background:var(--codebg);color:var(--code);padding:.08em .38em;border-radius:4px;border:1px solid var(--border)}
.stats{display:flex;flex-wrap:wrap;gap:.55rem;margin:0 0 1.4rem}
.stat{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:.55rem .8rem;min-width:96px}
.stat .n{font-size:1.25rem;font-weight:700;color:var(--accent)}
.stat .l{font-size:.72rem;color:var(--dim);text-transform:uppercase;letter-spacing:.04em}
details{background:var(--panel);border:1px solid var(--border);border-radius:8px;margin:.55rem 0;overflow:hidden}
details[open]{background:var(--panel2)}
summary{cursor:pointer;padding:.7rem 1rem;font-weight:600;list-style:none;display:flex;align-items:center;gap:.5rem}
summary::-webkit-details-marker{display:none}
summary::before{content:"\\25B8";color:var(--faint);font-size:.85em;transition:transform .12s}
details[open]>summary::before{transform:rotate(90deg)}
summary .tag{margin-left:auto;font-weight:500;font-size:.7rem;color:var(--faint)}
.body{padding:.2rem 1.1rem 1rem;border-top:1px solid var(--border)}
.nested{margin:.4rem 0 0}
table{border-collapse:collapse;width:100%;margin:.5rem 0;font-size:.88rem}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--dim);font-weight:600;font-size:.76rem;text-transform:uppercase;letter-spacing:.03em}
td:first-child{white-space:nowrap;color:var(--fg)}
.chip{display:inline-block;font-size:.68rem;font-weight:600;padding:.08em .5em;border-radius:20px;border:1px solid}
.c-chezmoi{color:#1a7f37;border-color:#1a7f37;background:rgba(26,127,55,.12)}
.c-generated{color:#8250df;border-color:#8250df;background:rgba(130,80,223,.12)}
.c-work{color:#0969da;border-color:#0969da;background:rgba(9,105,218,.12)}
.c-project{color:#9a6700;border-color:#9a6700;background:rgba(154,103,0,.12)}
.c-unmanaged{color:var(--faint);border-color:var(--faint);background:transparent}
.c-inline{color:var(--faint);border-color:var(--faint);border-style:dashed;background:transparent}
.toolbar{display:flex;gap:.5rem;margin:0 0 .8rem}
button{background:var(--panel);color:var(--fg);border:1px solid var(--border);border-radius:6px;
  padding:.35rem .7rem;font-size:.8rem;cursor:pointer;font-family:inherit}
button:hover{border-color:var(--accent);color:var(--accent)}
.note{color:var(--dim);font-size:.85rem;margin:.3rem 0}
.toc{margin:.3rem 0 .5rem;padding-left:1rem;font-size:.85rem;color:var(--dim);list-style:none}
.toc li{margin:.12rem 0;padding-left:.4rem;border-left:2px solid var(--border)}
.foot{color:var(--faint);font-size:.8rem;margin-top:2rem;border-top:1px solid var(--border);padding-top:1rem}
"""

JS = """
document.getElementById('expand-all').addEventListener('click', function(){
  document.querySelectorAll('details').forEach(function(d){ d.open = true; });
});
document.getElementById('collapse-all').addEventListener('click', function(){
  document.querySelectorAll('details').forEach(function(d){ d.open = false; });
});
"""


def _chip(provenance: str) -> str:
    if not provenance or provenance not in PROVENANCE_LABELS:
        return ""
    return f'<span class="chip c-{provenance}">{escape(PROVENANCE_LABELS[provenance])}</span>'


def _fields_table(fields: tuple[tuple[str, str], ...]) -> str:
    if not fields:
        return ""
    rows = "".join(f"<tr><td>{escape(k)}</td><td>{escape(v)}</td></tr>" for k, v in fields)
    return f"<table>{rows}</table>"


def _render_item(item: Item) -> str:
    return (
        "<details>"
        f"<summary>{escape(item.name)}{_chip(item.provenance)}</summary>"
        f'<div class="body"><p>{escape(item.purpose)}</p>{_fields_table(item.fields)}</div>'
        "</details>"
    )


def _render_category(category: Category, *, open_by_default: bool = False) -> str:
    open_attr = " open" if open_by_default else ""
    note = f'<p class="note">{escape(category.note)}</p>' if category.note else ""
    items_html = "".join(_render_item(item) for item in category.items) or "<p>None found.</p>"
    return (
        f"<details{open_attr}>"
        f'<summary>{escape(category.title)}<span class="tag">{len(category.items)}</span></summary>'
        f'<div class="body">{note}{items_html}</div>'
        "</details>"
    )


def _render_layer(layer: Layer) -> str:
    if not layer.present:
        return (
            "<details>"
            f'<summary>{escape(layer.name)}<span class="tag">absent</span></summary>'
            f'<div class="body"><p>{escape(layer.path)} — not present.</p></div>'
            "</details>"
        )
    return (
        "<details>"
        f"<summary>{escape(layer.name)}</summary>"
        f'<div class="body"><p><code>{escape(layer.path)}</code></p>{_fields_table(layer.fields)}</div>'
        "</details>"
    )


def _render_cascade_node(node: CascadeNode) -> str:
    children_html = "".join(_render_cascade_node(c) for c in node.children)
    children_block = f'<div class="nested">{children_html}</div>' if children_html else ""
    meta = (
        f'<p class="note">{node.line_count} lines · {len(node.headings)} sections</p>'
        if node.line_count
        else ""
    )
    toc = ""
    if node.headings:
        lis = "".join(
            f'<li style="margin-left:{(level - 1) * 1.1:.1f}rem">{escape(text)}</li>'
            for level, text in node.headings
        )
        toc = f'<ul class="toc">{lis}</ul>'
    includes = children_block or '<p class="note">No @-includes.</p>'
    return (
        "<details open>"
        f"<summary>{escape(node.label)}{_chip(node.provenance)}</summary>"
        f'<div class="body">{meta}{toc}{includes}</div>'
        "</details>"
    )


def _overview_banner(setup_map: SetupMap) -> str:
    stats = "".join(
        f'<div class="stat"><div class="n">{escape(n)}</div><div class="l">{escape(label)}</div></div>'
        for label, n in setup_map.counts
    )
    shas = ", ".join(f"{escape(name)}@{escape(sha)}" for name, sha in setup_map.source_shas)
    return (
        f'<div class="sub">Generated {escape(setup_map.generated_at)} · source SHAs: {shas}</div>'
        f'<div class="stats">{stats}</div>'
    )


PROVENANCE_LEGEND = """
<p>Two source repos deploy into one <code>~/.claude/</code> tree:</p>
<ul>
<li><span class="chip c-chezmoi">chezmoi</span> — real file, deployed verbatim from
<code>~/.local/share/chezmoi/home/private_dot_claude/</code>.</li>
<li><span class="chip c-generated">generated</span> — chezmoi source has a templating prefix
(<code>.tmpl</code> / <code>modify_</code> / <code>create_</code> / <code>run_</code> / <code>symlink_</code>)
so the deployed file is produced, not copied.</li>
<li><span class="chip c-work">work</span> — symlink resolving into
<code>~/work-laptop-config/.claude/</code>.</li>
<li><span class="chip c-project">project</span> — belongs to this vault's own <code>.claude/</code>.</li>
<li><span class="chip c-unmanaged">unmanaged</span> — no chezmoi source and not a work symlink.</li>
<li><span class="chip c-inline">inline</span> — a hook command with no backing script file.</li>
</ul>
"""


def render(setup_map: SetupMap) -> str:
    categories = {c.key: c for c in setup_map.categories}
    settings_section = "".join(_render_layer(layer) for layer in setup_map.layers)
    cascade_section = "".join(_render_cascade_node(node) for node in setup_map.cascade)
    inventory_keys = ("skills", "commands", "agents", "rules", "output-styles")
    inventory_section = "".join(_render_category(categories[k]) for k in inventory_keys if k in categories)

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Setup Map</title>
<style>{CSS}</style>
</head>
<body>
<div class="wrap">
  <h1>Claude Setup Map</h1>
  {_overview_banner(setup_map)}

  <div class="toolbar">
    <button id="expand-all">Expand all</button>
    <button id="collapse-all">Collapse all</button>
  </div>

  <details open>
    <summary>Settings &amp; precedence<span class="tag">managed &gt; project-local &gt; project &gt; user</span></summary>
    <div class="body">
      <p class="note">Order confirmed against code.claude.com/docs/en/settings.md,
      "Settings Priority Order (Highest to Lowest)" (2026-07-10).</p>
      {settings_section}
    </div>
  </details>

  <details open>
    <summary>CLAUDE.md cascade</summary>
    <div class="body">{cascade_section}</div>
  </details>

  {_render_category(categories["hooks"], open_by_default=False)}

  <details>
    <summary>Skills / Commands / Agents / Rules / Output-styles<span class="tag">inventory</span></summary>
    <div class="body">{inventory_section}</div>
  </details>

  {_render_category(categories["plugins"])}
  {_render_category(categories["mcp"])}
  {_render_category(categories["scheduled"])}

  <details>
    <summary>Provenance legend &amp; two-repo model</summary>
    <div class="body">{PROVENANCE_LEGEND}</div>
  </details>

  <div class="foot">
    Generated by <code>config-map/generate.py</code> — deterministic, stdlib-only, no LLM in the update path.
    Do not hand-edit; rerun <code>/config-map</code> instead.
  </div>
</div>
<script>{JS}</script>
</body>
</html>
"""
