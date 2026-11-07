#!/usr/bin/env python3
"""Entrypoint: scan the Claude Code config surface and (re)write Meta/Claude_Setup_Map.html.

Stdlib only, no network, no LLM. Rewrites the HTML only when the semantic
content hash changes (SPEC.md §10), so a no-op daily run doesn't churn git.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys

from config_map.model import semantic_payload
from config_map.render import render
from config_map.scan import build_setup_map
from config_map.sources import (
    ARTIFACT_HTML,
    OUTPUT_HASH,
    OUTPUT_HTML,
    VAULT_PRESENT,
    VAULT_ROOT,
)


def main() -> int:
    if not VAULT_PRESENT:
        # Vault-optional contract: no vault configured/present is not an error —
        # skip the vault-output section entirely rather than mkdir-ing it into
        # existence at a path nobody asked for.
        print(
            f"config-map: no vault at {VAULT_ROOT} (set $CLAUDE_VAULT_DIR to point "
            "at one) — skipping Claude_Setup_Map.html"
        )
        return 0

    setup_map = build_setup_map()
    payload_json = json.dumps(
        semantic_payload(setup_map), sort_keys=True, ensure_ascii=False
    )
    new_hash = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
    old_hash = OUTPUT_HASH.read_text().strip() if OUTPUT_HASH.exists() else None

    if new_hash == old_hash and OUTPUT_HTML.exists():
        print(
            f"config-map: unchanged (hash {new_hash[:12]}), {OUTPUT_HTML} not rewritten"
        )
    else:
        OUTPUT_HTML.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT_HTML.write_text(render(setup_map), encoding="utf-8")
        OUTPUT_HASH.write_text(new_hash + "\n", encoding="utf-8")
        print(f"config-map: wrote {OUTPUT_HTML} (hash {new_hash[:12]})")
    publish_artifact()
    return 0


def publish_artifact() -> None:
    """Copy the vault HTML into ~/.claude/artifacts, where the artifact server serves it.

    Copies on every run, unchanged hash included, because the artifact prune deletes a
    file left unmodified for 30 days. Skips a host without an artifacts directory
    rather than creating one.
    """
    if not ARTIFACT_HTML.parent.is_dir():
        return
    shutil.copyfile(OUTPUT_HTML, ARTIFACT_HTML)
    print(f"config-map: copied to {ARTIFACT_HTML}")


if __name__ == "__main__":
    sys.exit(main())
