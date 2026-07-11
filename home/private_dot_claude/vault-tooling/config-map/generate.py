#!/usr/bin/env python3
"""Entrypoint: scan the Claude Code config surface and (re)write Meta/Claude_Setup_Map.html.

Stdlib only, no network, no LLM. Rewrites the HTML only when the semantic
content hash changes (SPEC.md §10), so a no-op daily run doesn't churn git.
"""

from __future__ import annotations

import hashlib
import json
import sys

from config_map.model import semantic_payload
from config_map.render import render
from config_map.scan import build_setup_map
from config_map.sources import OUTPUT_HASH, OUTPUT_HTML, VAULT_PRESENT, VAULT_ROOT


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
    payload_json = json.dumps(semantic_payload(setup_map), sort_keys=True, ensure_ascii=False)
    new_hash = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
    old_hash = OUTPUT_HASH.read_text().strip() if OUTPUT_HASH.exists() else None

    if new_hash == old_hash and OUTPUT_HTML.exists():
        print(f"config-map: unchanged (hash {new_hash[:12]}), {OUTPUT_HTML} not rewritten")
        return 0

    OUTPUT_HTML.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_HTML.write_text(render(setup_map), encoding="utf-8")
    OUTPUT_HASH.write_text(new_hash + "\n", encoding="utf-8")
    print(f"config-map: wrote {OUTPUT_HTML} (hash {new_hash[:12]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
