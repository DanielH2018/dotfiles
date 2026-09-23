"""The page inlines the Catppuccin palette from ~/.local/share/html-kit/theme.css (#564),
and falls back to its own copy where html-kit is absent. The copy must not drift from the
file, and every custom property the page's CSS reads must be declared by one of them."""

import re

from config_map import render

DECLARED = re.compile(r"(--[a-z0-9-]+)\s*:")
READ = re.compile(r"var\((--[a-z0-9-]+)\)")


def undeclared(css: str) -> list[str]:
    return sorted(set(READ.findall(css)) - set(DECLARED.findall(css)))


def test_fallback_matches_the_shared_theme():
    shipped = [p for p in render.THEME_CANDIDATES if p.is_file()]
    assert shipped, f"html-kit theme.css not found at any of {render.THEME_CANDIDATES}"
    assert shipped[0].read_text(encoding="utf-8") == render.THEME_FALLBACK


def test_theme_css_reads_the_first_candidate_that_exists(tmp_path):
    theme = tmp_path / "theme.css"
    theme.write_text(":root{--base:#000}", encoding="utf-8")
    assert render.theme_css((tmp_path / "missing.css", theme)) == ":root{--base:#000}"


def test_theme_css_falls_back_when_no_candidate_exists(tmp_path):
    assert render.theme_css((tmp_path / "missing.css",)) == render.THEME_FALLBACK


def test_every_property_the_page_reads_is_declared():
    assert "--bg" in READ.findall(render.CSS), "the census found no page reads"
    assert undeclared(render.THEME_FALLBACK + render.CSS) == []


def test_a_property_nobody_declares_is_flagged():
    assert undeclared(render.THEME_FALLBACK + "a{color:var(--subtext)}") == [
        "--subtext"
    ]
