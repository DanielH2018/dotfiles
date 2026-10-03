#!/usr/bin/env python3
"""Standalone tests for memory_survey.py.

Run: python3 test_memory_survey.py

Every rule gets a `..._is_clean` / `..._is_flagged` pair, or another accept/reject
pair. A survey that flagged everything and one that flagged nothing are
indistinguishable from the passing side alone, so each rule needs one input it must
accept and one it must reject.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# Importing the script below would otherwise write a __pycache__ into the chezmoi source
# tree, which chezmoi would then deploy.
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "executable_memory_survey.py"
if not SCRIPT.exists():  # deployed copy drops chezmoi's mode prefix
    SCRIPT = HERE / "memory_survey.py"

spec = importlib.util.spec_from_file_location("memory_survey", SCRIPT)
memory_survey = importlib.util.module_from_spec(spec)
sys.modules["memory_survey"] = memory_survey
spec.loader.exec_module(memory_survey)

# GIT_DIR outranks cwd, and git exports it to every hook that runs this suite
# (pre-push), so a git command in a temp repo would otherwise act on this repository.
for _var in [k for k in os.environ if k.startswith("GIT_")]:
    del os.environ[_var]


@contextlib.contextmanager
def _tmp():
    # .resolve() because git reports a checkout by its real path; on macOS the temp dir
    # sits behind a /var -> /private/var symlink.
    with tempfile.TemporaryDirectory() as d:
        yield Path(d).resolve()


@contextlib.contextmanager
def _home(home: Path):
    """Point Path.home() at `home` for the duration. It patches pathlib.Path itself."""
    original = Path.home
    Path.home = classmethod(lambda cls: home)
    try:
        yield
    finally:
        Path.home = original


@contextlib.contextmanager
def _cwd(path: Path):
    original = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(original)


def _main(argv: list[str]) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        code = memory_survey.main(argv)
    return code, out.getvalue()


def _mem(tmp_path: Path, index: str, files: dict[str, str]) -> Path:
    d = tmp_path / "memory"
    d.mkdir(parents=True)
    (d / "MEMORY.md").write_text(index, encoding="utf-8")
    for name, body in files.items():
        (d / name).write_text(body, encoding="utf-8")
    return d


# The transcript window is measured back from this epoch; a transcript's mtime is set
# against the same one, so "60 days old" is exactly that whatever the wall clock reads.
NOW = 1_780_000_000.0


def _survey(d: Path, transcripts: Path | None = None, days: int = 30):
    return memory_survey.survey(d, transcripts or (d / "__none__"), days, now=NOW)


# --- dead index links: the only condition that fails the run ---------------------


def test_dead_link_is_clean_when_every_pointer_resolves():
    with _tmp() as tmp_path:
        d = _mem(tmp_path, "- [A](a.md) — hook\n", {"a.md": "body one"})
        assert _survey(d)["dead_links"] == []


def test_dead_link_is_flagged_when_a_pointer_names_a_missing_file():
    with _tmp() as tmp_path:
        d = _mem(tmp_path, "- [A](a.md)\n- [Gone](gone.md)\n", {"a.md": "body one"})
        assert _survey(d)["dead_links"] == ["gone.md"]


def test_dead_link_sets_exit_code_and_orphans_do_not():
    # --transcript-dir and --repo-root keep main() off the real transcripts and off git.
    with _tmp() as tmp_path:
        hermetic = [
            "--transcript-dir",
            str(tmp_path / "none"),
            "--repo-root",
            str(tmp_path),
        ]
        d = _mem(tmp_path, "- [Gone](gone.md)\n", {"a.md": "body"})
        assert _main(["--memory-dir", str(d), *hermetic])[0] == 1

        clean = _mem(
            tmp_path / "second", "- [A](a.md)\n", {"a.md": "b", "orphan.md": "c"}
        )
        assert _main(["--memory-dir", str(clean), *hermetic])[0] == 0


# --- orphans -------------------------------------------------------------------


def test_orphan_is_clean_when_the_index_links_every_file():
    with _tmp() as tmp_path:
        d = _mem(tmp_path, "- [A](a.md)\n- [B](b.md)\n", {"a.md": "x", "b.md": "y"})
        assert _survey(d)["orphans"] == []


def test_orphan_is_flagged_when_a_file_has_no_pointer():
    with _tmp() as tmp_path:
        d = _mem(tmp_path, "- [A](a.md)\n", {"a.md": "x", "stray.md": "y"})
        assert _survey(d)["orphans"] == ["stray.md"]


def test_index_itself_is_never_reported_as_an_orphan():
    with _tmp() as tmp_path:
        d = _mem(tmp_path, "- [A](a.md)\n", {"a.md": "x"})
        s = _survey(d)
        assert "MEMORY.md" not in s["orphans"]
        assert s["store"]["files"] == 1


def test_an_absolute_link_to_an_existing_repo_doc_is_clean():
    with _tmp() as tmp_path:
        doc = tmp_path / "owner.md"
        doc.write_text("the claim", encoding="utf-8")
        assert _survey(_mem(tmp_path, f"- [Owned]({doc})\n", {}))["dead_links"] == []


def test_an_absolute_link_to_a_missing_repo_doc_is_flagged():
    with _tmp() as tmp_path:
        gone = tmp_path / "moved.md"
        s = _survey(_mem(tmp_path, f"- [Moved]({gone})\n", {}))
        assert s["dead_links"] == [str(gone)]


def test_a_link_written_with_a_directory_prefix_still_resolves():
    with _tmp() as tmp_path:
        d = _mem(tmp_path, "- [A](./a.md)\n", {"a.md": "x"})
        s = _survey(d)
        assert s["dead_links"] == []
        assert s["orphans"] == []


# --- duplicate candidates ------------------------------------------------------


def test_duplicates_are_clean_when_bodies_share_no_phrasing():
    with _tmp() as tmp_path:
        d = _mem(
            tmp_path,
            "",
            {
                "a.md": "longhorn refuses a volume size that is not a block multiple",
                "b.md": "pihole answers aaaa queries with a null address wedging grpc",
            },
        )
        assert _survey(d)["duplicate_candidates"] == []


def test_duplicates_are_flagged_when_two_entries_restate_one_fact():
    shared = (
        "the gitops tick pulls all of master not just your commit "
        "so another session work lands too"
    )
    with _tmp() as tmp_path:
        d = _mem(
            tmp_path, "", {"a.md": shared, "b.md": shared + " and then deploys it"}
        )
        pairs = _survey(d)["duplicate_candidates"]
        assert pairs and {pairs[0][0], pairs[0][1]} == {"a.md", "b.md"}


def test_frontmatter_is_excluded_from_duplicate_scoring():
    # Identical frontmatter, unrelated bodies. Scoring the frontmatter would match
    # these.
    fm = "---\nname: x\ndescription: a memory about the homelab deploy pipeline\n---\n"
    with _tmp() as tmp_path:
        d = _mem(
            tmp_path,
            "",
            {
                "a.md": fm + "longhorn refuses a size that is not a block multiple",
                "b.md": fm + "cron inherits neither path nor kubeconfig from the shell",
            },
        )
        assert _survey(d)["duplicate_candidates"] == []


# --- last-referenced -----------------------------------------------------------


def _assistant(text: str) -> str:
    return json.dumps(
        {"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}
    )


def _tool_result(text: str) -> str:
    return json.dumps(
        {
            "type": "user",
            "message": {"content": [{"type": "tool_result", "content": text}]},
        }
    )


def _transcripts(tmp_path: Path, lines: list[str]) -> Path:
    t = tmp_path / "transcripts"
    t.mkdir(parents=True)
    (t / "session.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return t


def test_reference_is_found_when_a_transcript_names_the_slug():
    name = "longhorn-retain-is-per-job.md"
    with _tmp() as tmp_path:
        d = _mem(tmp_path, f"- [Slug]({name})\n", {name: "x"})
        t = _transcripts(
            tmp_path,
            [_assistant("per longhorn-retain-is-per-job, retain is per job")],
        )
        assert _survey(d, t)["unreferenced"] == []


def test_a_short_slug_matches_on_any_substring():
    # Pinning a known weakness rather than hiding it: the scan is a substring test, so a
    # one-character slug reads as referenced by almost any transcript. Real memory slugs
    # are long kebab-case phrases, which is what makes the scan sound in practice. A
    # future move to short slugs would silently mark every entry live, and this test is
    # what would fail.
    with _tmp() as tmp_path:
        d = _mem(tmp_path, "- [A](a.md)\n", {"a.md": "x"})
        t = _transcripts(tmp_path, [_assistant("see a for the answer")])
        assert _survey(d, t)["unreferenced"] == []


def test_a_line_carrying_the_whole_index_does_not_count_as_a_reference():
    # MEMORY.md is injected verbatim into every session, so it lands in every
    # transcript. Without the bulk-line skip, every indexed entry reads as referenced
    # today and the signal measures the injection rather than use. This is the
    # rejecting half.
    names = [f"entry-number-{i}-about-something.md" for i in range(8)]
    with _tmp() as tmp_path:
        d = _mem(tmp_path, "", dict.fromkeys(names, "x"))
        injected = " ".join(Path(n).stem for n in names)
        t = _transcripts(tmp_path, [_assistant(injected)])
        assert _survey(d, t)["unreferenced"] == sorted(names)


def test_a_line_citing_two_slugs_still_counts_as_a_reference():
    # The accepting half: a sentence that genuinely cites a couple of related memories
    # is a reference, and must not be swept up by the bulk-line skip.
    a, b = "cron-path-omits-usr-local-bin.md", "grace-periods-must-be-derived.md"
    with _tmp() as tmp_path:
        d = _mem(tmp_path, "", {a: "x", b: "y"})
        t = _transcripts(
            tmp_path,
            [
                _assistant(
                    "see cron-path-omits-usr-local-bin and "
                    "grace-periods-must-be-derived"
                )
            ],
        )
        assert _survey(d, t)["unreferenced"] == []


def test_a_tool_result_naming_the_slug_is_not_a_reference():
    # A directory listing of the memory store names every file, one per line, so it
    # clears the bulk-line skip. Only the assistant's own words count as a citation.
    name = "cron-path-omits-usr-local-bin.md"
    with _tmp() as tmp_path:
        d = _mem(tmp_path, f"- [A]({name})\n", {name: "x"})
        t = _transcripts(tmp_path, [_tool_result(f"{name}\nsome-other-file.md")])
        assert _survey(d, t)["unreferenced"] == [name]


def test_a_citation_in_a_worktree_sessions_transcripts_counts_as_a_reference():
    # A session in <project>/.claude/worktrees/<name> writes its transcripts under
    # <slug>--claude-worktrees-<name>, beside the project's own directory. Most
    # sessions run there, so a scan that skipped those directories read nearly every
    # entry as unreferenced (#744). A directory that only shares the slug as a prefix
    # is another project, and its citations must not count.
    cited, other = "worktree-session-cited-this.md", "another-project-cited-this.md"
    with _tmp() as tmp_path:
        d = _mem(tmp_path, "", {cited: "x", other: "y"})
        projects = tmp_path / "projects"
        primary = projects / "-home-u-repo"
        primary.mkdir(parents=True)
        for name, slug in [
            ("-home-u-repo--claude-worktrees-fix-thing", "worktree-session-cited-this"),
            ("-home-u-repo-other", "another-project-cited-this"),
        ]:
            (projects / name).mkdir()
            (projects / name / "s.jsonl").write_text(
                _assistant(f"per {slug}") + "\n", encoding="utf-8"
            )
        assert _survey(d, primary)["unreferenced"] == [other]


def test_a_citation_in_a_subagents_transcript_counts_as_a_reference():
    # A subagent writes <session>/subagents/<agent>.jsonl beside its parent's
    # transcript, in a worktree directory as well as the primary one. A scan of the
    # top level alone never read them (#759).
    names = ["primary-subagent-cited-this.md", "worktree-subagent-cited-this.md"]
    with _tmp() as tmp_path:
        d = _mem(tmp_path, "", dict.fromkeys(names, "x"))
        projects = tmp_path / "projects"
        primary = projects / "-home-u-repo"
        for project, name in zip(
            [primary, projects / "-home-u-repo--claude-worktrees-fix-thing"], names
        ):
            sub = project / "session-uuid" / "subagents"
            sub.mkdir(parents=True)
            (sub / "agent-a1.jsonl").write_text(
                _assistant(f"per {Path(name).stem}") + "\n", encoding="utf-8"
            )
        assert _survey(d, primary)["unreferenced"] == []


def test_unreferenced_when_no_transcript_mentions_the_slug():
    with _tmp() as tmp_path:
        d = _mem(
            tmp_path,
            "- [A](never-cited-anywhere.md)\n",
            {"never-cited-anywhere.md": "x"},
        )
        t = _transcripts(tmp_path, [_assistant("unrelated chatter")])
        assert _survey(d, t)["unreferenced"] == ["never-cited-anywhere.md"]


def test_a_transcript_outside_the_window_does_not_count_as_a_reference():
    with _tmp() as tmp_path:
        d = _mem(tmp_path, "- [A](aged-out-entry.md)\n", {"aged-out-entry.md": "x"})
        t = _transcripts(tmp_path, [_assistant("aged-out-entry was useful once")])
        old = NOW - 60 * 86400
        os.utime(t / "session.jsonl", (old, old))

        assert _survey(d, t, days=30)["unreferenced"] == ["aged-out-entry.md"]
        assert _survey(d, t, days=90)["unreferenced"] == []


def test_an_unreadable_transcript_leaves_the_slug_unreferenced():
    # Failing closed matters: a transcript we cannot read is missing evidence, and the
    # safe direction is to surface the entry for review rather than call it referenced.
    with _tmp() as tmp_path:
        d = _mem(tmp_path, "- [A](some-entry.md)\n", {"some-entry.md": "x"})
        t = _transcripts(tmp_path, [_assistant("some-entry was cited")])
        (t / "session.jsonl").chmod(0o000)
        try:
            assert _survey(d, t)["unreferenced"] == ["some-entry.md"]
        finally:
            (t / "session.jsonl").chmod(0o644)


# --- reported cost -------------------------------------------------------------


def test_index_cost_counts_the_index_and_the_store_excludes_it():
    # The em-dash is three bytes and one character. The cost this reports is what the
    # model is charged, which tracks bytes, so the assertion encodes rather than len()s.
    index = "- [A](a.md) — hook\n"
    with _tmp() as tmp_path:
        d = _mem(tmp_path, index, {"a.md": "body"})
        s = _survey(d)
        assert s["index"]["bytes"] == len(index.encode("utf-8"))
        assert s["store"]["bytes"] == len(b"body")
        assert s["index"]["pointer_links"] == 1


def test_a_link_repeated_in_the_index_is_counted_once():
    with _tmp() as tmp_path:
        d = _mem(tmp_path, "- [A](a.md)\nsee also [again](a.md)\n", {"a.md": "x"})
        assert _survey(d)["index"]["pointer_links"] == 1


# --- link titles carrying square brackets --------------------------------------
#
# The index really does carry
# `- [A task tagged [config, deploy] is skipped …](file.md)`.
# The pair below is per-direction: the file must read as linked (not an orphan), and a
# bracketed title naming a MISSING file must still trip the dead-link gate. The second
# half is the one that matters: a title the regex cannot parse is a pointer nothing
# polices.


def test_bracketed_title_is_clean_when_its_file_exists():
    with _tmp() as tmp_path:
        d = _mem(
            tmp_path,
            "- [A task tagged [config, deploy] is skipped](dual.md) — hook\n",
            {"dual.md": "body"},
        )
        s = _survey(d)
        assert s["dead_links"] == []
        assert s["orphans"] == []


def test_bracketed_title_is_flagged_when_its_file_is_missing():
    with _tmp() as tmp_path:
        d = _mem(
            tmp_path,
            "- [A task tagged [config, deploy] is skipped](gone.md)\n",
            {"a.md": "body"},
        )
        assert _survey(d)["dead_links"] == ["gone.md"]


# --- enforcement -----------------------------------------------------------------
# Three outcomes, each with the input it must produce and an input it must not: a
# memory whose cited check exists, one that cites nothing, and one whose cited check is
# gone. The third is the interesting case: the memory claims an owner it no longer has.


def _repo(tmp_path: Path, *paths: str) -> Path:
    root = tmp_path / "repo"
    for rel in paths:
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("")
    root.mkdir(exist_ok=True)
    return root


def _memfile(tmp_path: Path, name: str, body: str) -> Path:
    d = tmp_path / "mem"
    d.mkdir(exist_ok=True)
    p = d / name
    p.write_text(body)
    return p


def test_a_memory_citing_a_live_check_is_enforced():
    with _tmp() as tmp_path:
        root = _repo(tmp_path, "ansible/tests/test_thing.py")
        p = _memfile(tmp_path, "a.md", "ENFORCED by ansible/tests/test_thing.py.\n")
        assert memory_survey.enforcement([p], root)["enforced"] == ["a.md"]


def test_a_memory_citing_nothing_is_unenforced():
    with _tmp() as tmp_path:
        root = _repo(tmp_path, "ansible/tests/test_thing.py")
        p = _memfile(tmp_path, "b.md", "A fact nobody checks.\n")
        assert memory_survey.enforcement([p], root)["unenforced"] == ["b.md"]


def test_a_memory_citing_a_missing_check_is_dangling():
    with _tmp() as tmp_path:
        root = _repo(tmp_path, "ansible/tests/test_thing.py")
        p = _memfile(tmp_path, "c.md", "ENFORCED by ansible/tests/test_gone.py.\n")
        result = memory_survey.enforcement([p], root)
        assert result["dangling"] and "test_gone.py" in result["dangling"][0]
        assert result["enforced"] == [] and result["unenforced"] == []


def test_a_hook_path_counts_as_a_check():
    with _tmp() as tmp_path:
        root = _repo(tmp_path, ".claude/hooks/block-footguns.py")
        p = _memfile(tmp_path, "d.md", "Denied by .claude/hooks/block-footguns.py.\n")
        assert memory_survey.enforcement([p], root)["enforced"] == ["d.md"]


def test_a_manifest_path_is_not_mistaken_for_a_check():
    """A memory citing the thing it DESCRIBES has no owner; only a check counts."""
    with _tmp() as tmp_path:
        root = _repo(tmp_path, "ansible/roles/k8s/traefik/templates/deployment.yaml.j2")
        p = _memfile(
            tmp_path,
            "e.md",
            "See ansible/roles/k8s/traefik/templates/deployment.yaml.j2.\n",
        )
        assert memory_survey.enforcement([p], root)["unenforced"] == ["e.md"]


def test_a_hook_that_lives_only_under_home_claude_is_enforced():
    """chezmoi deploys hooks to ~/.claude/hooks; a repo has its own. Both are owners."""
    with _tmp() as tmp_path:
        home = tmp_path / "home"
        (home / ".claude" / "hooks").mkdir(parents=True)
        (home / ".claude" / "hooks" / "prune-worktrees.py").write_text("")
        root = _repo(tmp_path, "ansible/tests/test_thing.py")
        p = _memfile(tmp_path, "f.md", "See ~/.claude/hooks/prune-worktrees.py.\n")
        with _home(home):
            assert memory_survey.enforcement([p], root)["enforced"] == ["f.md"]


def test_a_hook_missing_from_both_roots_is_still_dangling():
    """The home fallback must not turn every hook citation green."""
    with _tmp() as tmp_path:
        home = tmp_path / "home"
        (home / ".claude" / "hooks").mkdir(parents=True)
        root = _repo(tmp_path, "ansible/tests/test_thing.py")
        p = _memfile(tmp_path, "g.md", "See .claude/hooks/never-existed.py.\n")
        with _home(home):
            result = memory_survey.enforcement([p], root)
        assert result["dangling"] and "never-existed.py" in result["dangling"][0]


def test_a_non_hook_path_gets_no_home_fallback():
    """Only `.claude/` is ambiguous between the two roots; a repo test path is not."""
    with _tmp() as tmp_path:
        home = tmp_path / "home"
        (home / "ansible" / "tests").mkdir(parents=True)
        (home / "ansible" / "tests" / "test_elsewhere.py").write_text("")
        root = _repo(tmp_path, "ansible/tests/test_thing.py")
        p = _memfile(tmp_path, "h.md", "ENFORCED by ansible/tests/test_elsewhere.py.\n")
        with _home(home):
            result = memory_survey.enforcement([p], root)
        assert result["dangling"] and "test_elsewhere.py" in result["dangling"][0]


# --- `enforceable: no` --------------------------------------------------------------
# The field exists so the ratio stops implying a backlog that does not exist. Every rule
# below is an accept/reject pair, because a field that can retire any memory is worse
# than no field.


def _declared(
    tmp_path: Path, name: str, meta_line: str, body="A fact nobody checks.\n"
):
    return _memfile(
        tmp_path,
        name,
        f"---\nname: {name[:-3]}\nmetadata:\n  type: project\n  {meta_line}\n---\n\n"
        f"{body}",
    )


def test_a_declared_memory_leaves_the_denominator():
    with _tmp() as tmp_path:
        root = _repo(tmp_path, "ansible/tests/test_thing.py")
        p = _declared(
            tmp_path, "a.md", "enforceable: no — judgment, no mechanism can own it"
        )
        result = memory_survey.enforcement([p], root)
        assert result["not_enforceable"] == ["a.md — judgment, no mechanism can own it"]
        assert result["enforced"] == [] and result["unenforced"] == []


def test_an_undeclared_memory_stays_in_the_denominator():
    """The reject half: absence of the field must not quietly exempt anything."""
    with _tmp() as tmp_path:
        root = _repo(tmp_path, "ansible/tests/test_thing.py")
        p = _memfile(tmp_path, "b.md", "A fact nobody checks.\n")
        result = memory_survey.enforcement([p], root)
        assert result["unenforced"] == ["b.md"] and result["not_enforceable"] == []


def test_a_declaration_with_no_reason_is_not_honoured():
    """Without a reason the field retires anything that looks hard, so it stays."""
    with _tmp() as tmp_path:
        root = _repo(tmp_path, "ansible/tests/test_thing.py")
        p = _declared(tmp_path, "c.md", "enforceable: no")
        result = memory_survey.enforcement([p], root)
        assert result["not_enforceable"] == []
        assert result["unenforced"] == ["c.md"]
        assert result["contradictions"] and "no reason" in result["contradictions"][0]


def test_a_declaration_that_also_cites_a_live_check_is_a_contradiction():
    """The file disagrees with itself. Believe the check, the verifiable half."""
    with _tmp() as tmp_path:
        root = _repo(tmp_path, "ansible/tests/test_thing.py")
        p = _declared(
            tmp_path,
            "d.md",
            "enforceable: no — nothing can check this",
            body="ENFORCED by ansible/tests/test_thing.py.\n",
        )
        result = memory_survey.enforcement([p], root)
        assert result["enforced"] == ["d.md"] and result["not_enforceable"] == []
        assert (
            result["contradictions"] and "test_thing.py" in result["contradictions"][0]
        )


def test_a_review_ledger_citing_a_live_check_is_not_a_contradiction():
    """A ledger cites checks as evidence for its findings, not as its own enforcer."""
    with _tmp() as tmp_path:
        root = _repo(tmp_path, "ansible/tests/test_thing.py")
        p = _declared(
            tmp_path,
            "review-2026-09-01-state.md",
            "enforceable: no — a review ledger for one dated run",
            body="H-1 was confirmed against ansible/tests/test_thing.py.\n",
        )
        result = memory_survey.enforcement([p], root)
        assert result["contradictions"] == []
        assert result["not_enforceable"] == [
            "review-2026-09-01-state.md — a review ledger for one dated run"
        ]


def test_a_non_ledger_named_like_one_is_still_a_contradiction():
    """The reject half: the exemption keys on the ledger naming convention."""
    with _tmp() as tmp_path:
        root = _repo(tmp_path, "ansible/tests/test_thing.py")
        p = _declared(
            tmp_path,
            "review-skeptics-drop-real-findings.md",
            "enforceable: no — judgment about a review loop",
            body="ENFORCED by ansible/tests/test_thing.py.\n",
        )
        result = memory_survey.enforcement([p], root)
        assert (
            result["contradictions"] and "test_thing.py" in result["contradictions"][0]
        )


def test_the_field_is_read_from_frontmatter_only():
    """A memory DESCRIBING this convention in its body must not exempt itself."""
    with _tmp() as tmp_path:
        root = _repo(tmp_path, "ansible/tests/test_thing.py")
        p = _memfile(
            tmp_path,
            "e.md",
            "Write `enforceable: no — <reason>` in the frontmatter "
            "to leave the ratio.\n",
        )
        result = memory_survey.enforcement([p], root)
        assert result["unenforced"] == ["e.md"] and result["not_enforceable"] == []


def test_false_is_accepted_as_well_as_no():
    """YAML users write either; ignoring one spelling would read as a typo."""
    with _tmp() as tmp_path:
        root = _repo(tmp_path, "ansible/tests/test_thing.py")
        p = _declared(tmp_path, "f.md", "enforceable: false — a ledger, not a rule")
        assert memory_survey.enforcement([p], root)["not_enforceable"] == [
            "f.md — a ledger, not a rule"
        ]


def test_enforceable_yes_is_not_a_declaration():
    """Only `no`/`false` declare. An explicit `yes` leaves the memory in the ratio."""
    with _tmp() as tmp_path:
        root = _repo(tmp_path, "ansible/tests/test_thing.py")
        p = _declared(tmp_path, "g.md", "enforceable: yes")
        result = memory_survey.enforcement([p], root)
        assert result["unenforced"] == ["g.md"] and result["not_enforceable"] == []
        assert result["contradictions"] == []


# --- --repo-root -----------------------------------------------------------------
# The flag decides which tree a cited check is looked up in. The pair runs the same
# memory against a tree that holds the check and one that does not; a flag main()
# ignored would give both the same verdict.


def _enforcement_via_main(tmp_path: Path, root: Path) -> dict:
    d = _mem(
        tmp_path / "flag",
        "- [A](a.md)\n",
        {"a.md": "ENFORCED by ansible/tests/test_thing.py.\n"},
    )
    code, out = _main(
        [
            "--memory-dir",
            str(d),
            "--transcript-dir",
            str(tmp_path / "none"),
            "--repo-root",
            str(root),
            "--json",
        ]
    )
    assert code == 0, out
    return json.loads(out)["enforcement"]


def test_repo_root_flag_is_honoured_when_its_tree_holds_the_check():
    with _tmp() as tmp_path:
        root = _repo(tmp_path, "ansible/tests/test_thing.py")
        assert _enforcement_via_main(tmp_path, root)["enforced"] == ["a.md"]


def test_repo_root_flag_is_honoured_when_its_tree_lacks_the_check():
    with _tmp() as tmp_path:
        root = _repo(tmp_path, "ansible/tests/test_other.py")
        result = _enforcement_via_main(tmp_path, root)
        assert result["enforced"] == []
        assert result["dangling"] and "test_thing.py" in result["dangling"][0]


# --- project slug derivation ---------------------------------------------------------
# Claude Code keys memory to the primary checkout's path. A session in a linked worktree
# must find the primary checkout's store, not a directory named after the worktree.


def test_project_slug_replaces_every_non_alphanumeric_character():
    assert memory_survey.project_slug(Path("/home/ubuntu/server")) == (
        "-home-ubuntu-server"
    )
    # A dotted path, as Claude Code names it under ~/.claude/projects.
    assert memory_survey.project_slug(Path("/home/ubuntu/.local/share/chezmoi")) == (
        "-home-ubuntu--local-share-chezmoi"
    )


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        [
            "git",
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
            *args,
        ],
        cwd=cwd,
        check=True,
        capture_output=True,
    )


def _primary_with_worktree(tmp_path: Path) -> tuple[Path, Path]:
    primary = tmp_path / "my.project"
    primary.mkdir()
    _git(primary, "init", "-q")
    _git(primary, "commit", "-q", "--allow-empty", "-m", "x")
    worktree = primary / ".claude" / "worktrees" / "wt"
    _git(primary, "worktree", "add", "-q", "-b", "wt", str(worktree))
    return primary, worktree


def test_a_worktree_maps_to_its_primary_checkouts_slug():
    with _tmp() as tmp_path:
        primary, worktree = _primary_with_worktree(tmp_path)
        home = tmp_path / "home"
        memory, transcripts = memory_survey.default_dirs(worktree, home=home)
        expected = home / ".claude" / "projects" / memory_survey.project_slug(primary)
        assert transcripts == expected
        assert memory == expected / "memory"
        assert memory_survey.project_slug(worktree) not in str(memory)


def test_main_finds_the_primary_store_from_a_worktree_and_not_the_worktrees_own():
    # The accept half: a store under the primary checkout's slug is found from the
    # worktree. The reject half: a store under the worktree's own slug is not, so main()
    # reports the derived (primary) directory missing.
    with _tmp() as tmp_path:
        primary, worktree = _primary_with_worktree(tmp_path)
        home = tmp_path / "home"
        projects = home / ".claude" / "projects"
        argv = ["--repo-root", str(tmp_path), "--json"]

        own = projects / memory_survey.project_slug(worktree) / "memory"
        own.mkdir(parents=True)
        (own / "MEMORY.md").write_text("")
        with _home(home), _cwd(worktree):
            assert _main(argv)[0] == 2

        store = projects / memory_survey.project_slug(primary) / "memory"
        store.mkdir(parents=True)
        (store / "MEMORY.md").write_text("- [A](a.md)\n")
        (store / "a.md").write_text("x")
        with _home(home), _cwd(worktree):
            code, out = _main(argv)
        assert code == 0
        assert json.loads(out)["memory_dir"] == str(store)


def test_outside_a_git_repository_the_slug_is_the_directory_itself():
    with _tmp() as tmp_path:
        plain = tmp_path / "not-a-repo"
        plain.mkdir()
        home = tmp_path / "home"
        memory, _ = memory_survey.default_dirs(plain, home=home)
        slug = memory_survey.project_slug(plain)
        assert memory == home / ".claude" / "projects" / slug / "memory"


if __name__ == "__main__":
    # Discovered, not hand-listed: tests/python-suites.test.js counts the test_* defs
    # itself and fails when that count and the OK line disagree.
    ran = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            ran += 1
    print(f"OK {ran}")
