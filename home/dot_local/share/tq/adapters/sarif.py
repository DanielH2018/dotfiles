"""SARIF 2.1.0 -> Result, so tq can digest a linter it has never met.

The other end of the same trade rdjson makes. rdjson is flatter and cheaper to
read; SARIF is the OASIS standard the static-analysis tools converge on, and
one adapter buys ESLint, Semgrep, CodeQL, clang-tidy, Trivy and ruff at once —
ruff already emits it under `--output-format=sarif`.

The format is deep and mostly optional. Only the parts every emitter fills in
are read: a rule id, a level, a message, and the first physical location. A
finding tq cannot place is still reported, because a finding without a file is
not the same as no finding.
"""

from __future__ import annotations

import json
import os
import urllib.parse

from result import Failure

# SARIF's levels, in LSP's names. "none" means the rule ran and had nothing to
# say about severity, not that the finding is unimportant.
LEVEL = {
    "error": "error",
    "warning": "warning",
    "note": "info",
    "none": "info",
}


def _rules(driver):
    """Rule metadata by id and by index, since a result may cite either."""
    by_id, by_index = {}, []
    for rule in driver.get("rules") or []:
        if isinstance(rule, dict):
            by_index.append(rule)
            if rule.get("id"):
                by_id[rule["id"]] = rule
    return by_id, by_index


def _path(artifact):
    """A workspace-relative path from a SARIF artifactLocation.

    The uri is a URI: percent-escaped, and often absolute with a file: scheme.
    Left as-is it reaches the digest as file:///home/...%20name, which no
    editor opens and no scope check matches.
    """
    uri = (artifact or {}).get("uri")
    if not uri:
        return None
    parsed = urllib.parse.urlsplit(uri)
    path = urllib.parse.unquote(parsed.path or "")
    if parsed.scheme and parsed.scheme != "file":
        return uri  # not a local file; report it as the tool wrote it
    # A uriBaseId the run never defines cannot be resolved, so a relative uri
    # stays relative and is read against cwd like every other adapter's paths.
    return os.path.normpath(path) if path else None


def _region(location):
    region = (location or {}).get("region") or {}
    return (
        region.get("startLine"),
        region.get("startColumn"),
        region.get("endLine"),
        region.get("endColumn"),
    )


def parse(stdout, result):
    """Fill `result` in place. Returns it for convenience."""
    try:
        payload = json.loads(stdout or "")
    except ValueError:
        return result  # not JSON: leave it to the caller's raw-output fallback
    if not isinstance(payload, dict):
        return result
    runs = payload.get("runs")
    if not isinstance(runs, list):
        return result

    for run in runs:
        if not isinstance(run, dict):
            continue
        driver = ((run.get("tool") or {}).get("driver")) or {}
        source = driver.get("name") or None
        by_id, by_index = _rules(driver)
        for note in run.get("results") or []:
            if not isinstance(note, dict):
                continue
            rule_id = note.get("ruleId")
            rule = by_id.get(rule_id) or {}
            index = note.get("ruleIndex")
            if not rule and isinstance(index, int) and 0 <= index < len(by_index):
                rule = by_index[index]
                rule_id = rule_id or rule.get("id")
            # A result states its own level, or inherits the one the rule was
            # configured with. Neither is required, and SARIF's own default
            # when both are absent is warning.
            default = (rule.get("defaultConfiguration") or {}).get("level")
            level = note.get("level") or default or "warning"

            location = (note.get("locations") or [{}])[0] or {}
            physical = location.get("physicalLocation") or {}
            line, column, end_line, end_column = _region(physical)
            result.failures.append(
                Failure(
                    name=rule_id or source or "sarif",
                    file=_path(physical.get("artifactLocation")),
                    line=line,
                    column=column,
                    end_line=end_line,
                    end_column=end_column,
                    severity=LEVEL.get(level, "warning"),
                    code_url=rule.get("helpUri"),
                    source=source,
                    # SARIF describes an edit but never asserts it preserves
                    # behaviour, so tq must not claim it is safe to apply.
                    fixable="unsafe" if note.get("fixes") else None,
                    message=((note.get("message") or {}).get("text") or "").strip(),
                )
            )
    return result
