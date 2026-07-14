# Architecture Decision Records — dotfiles / Claude config

Consequential, hard-to-reverse decisions about *this repo's* Claude setup (skills,
hooks, invocation modes, homes). One file per decision, `NNNN-kebab-title.md`.

Scope note: these are **config-repo** decisions. Decisions about Lithic work/domain
live in the vault (`~/Documents/My_Vault/Work/Decisions.md`), and Jira-wired-skill
decisions live in `~/work-laptop-config/.agents/adr/`.

The bar (from the `domain-modeling` skill): record an ADR only when the choice is
**hard to reverse**, **surprising without context**, *and* the result of a **real
trade-off**. Miss any one and it's not an ADR.

Not deployed to `$HOME` — chezmoi's source root is `home/`, so files here are plain
repo files.
