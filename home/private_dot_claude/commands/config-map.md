---
description: "Config map: regenerate the Claude Setup Map (deterministic HTML visualization of the Claude Code config surface)."
---

Regenerate the Claude Setup Map at `$CLAUDE_VAULT_DIR/Meta/Claude_Setup_Map.html`
(falls back to `$HOME/Documents/My_Vault` if `$CLAUDE_VAULT_DIR` is unset). If no
vault is present at that location, the generator itself no-ops with a clear
message — that's expected, not an error; just report its message and stop.

Run the generator as a subprocess exactly like this — never write out the literal
path to `~/.claude.json` in a Bash command string, since the generator reads it
internally (see `config-map/SPEC.md` §8):

```
python3 ~/.claude/vault-tooling/config-map/generate.py
```

Report back the one-line status it prints (whether the HTML was rewritten, left
unchanged because the semantic content hash didn't change, or skipped because no
vault is configured). Do not hand-edit `Meta/Claude_Setup_Map.html` — it is generated.
