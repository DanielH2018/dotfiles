# Neovim IDE-in-a-pane — Design

- **Date:** 2026-07-17
- **Author:** Daniel Hunter (with Claude Code)
- **Status:** Approved (design) — pending spec review → implementation plan
- **Context:** Extends the yazi edit-opener nvim built earlier (catppuccin + treesitter + QoL) into a tiered IDE-adjacent editor, used in one Ghostty pane alongside yazi.

## Goal

Give nvim IDE-grade capability **without leaving the terminal pane**, tiered by how well nvim serves each language. Full-IDE features for the nvim-friendly languages; LSP-*lite* for the JVM, with IntelliJ retained for heavy Java/Kotlin work.

## Scope

**In:** LSP (diagnostics, hover, go-to-def/refs, rename, code actions), completion, formatting, diagnostics UI, fuzzy finding, git signs, Python debugging, statusline + editor QoL.

**Languages:**
- *Full* (LSP + completion + format): Python, TypeScript/JS, Terraform/HCL, Bash, Lua, JSON, YAML, Markdown.
- *Lite*: Java via `jdtls` (navigate/hover/complete; no debug).
- *Syntax only*: Kotlin (treesitter highlight; no LSP).

**Out (deliberately):** Kotlin LSP, JVM debugging, Go, DAP beyond Python, test-runner integration (run tests via terminal `./gradlew` / pytest, or IntelliJ). Heavy JVM refactor/debug stays in IntelliJ.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Config approach | **A — hand-rolled modular** (`lazy.nvim` + `lua/plugins/*`) | Full control, transparent, chezmoi-tracked; matches deliberate toolchain ethos. B (kickstart) / C (LazyVim) kept as **reference** only. |
| Tool provenance | **Hybrid** | System-managed `jdtls` (sdkman JDK) + node servers (fnm); mason for leaf tools/formatters/debugpy. |
| Completion | **blink.cmp** | Fast, low-config; Rust matcher has a pure-Lua fallback to avoid the prebuilt binary. |
| Finder | **fzf-lua** | Reuses existing fzf + rg; muscle memory carries over; nothing to compile. |
| Formatting | **conform.nvim** — on-save (safe subset) **and** `<leader>cf` on-demand | On-save for Python/TS/JSON/Terraform/Lua/Bash via project formatter; JVM excluded from on-save; on-demand for anything. |

## File layout

```
~/.config/nvim/
  init.lua                  → require config.*, lazy bootstrap (import = "plugins")
  lua/config/
    options.lua             ← current QoL opts move here
    keymaps.lua
    autocmds.lua            ← yank-highlight etc. move here
  lua/plugins/
    colorscheme.lua         ← catppuccin (existing)
    treesitter.lua          ← existing (highlight + indent)
    lsp.lua                 → lspconfig + mason(leaf) + mason-lspconfig + nvim-jdtls
    completion.lua          → blink.cmp
    formatting.lua          → conform.nvim
    dap.lua                 → nvim-dap + dap-ui + dap-virtual-text + nvim-dap-python
    finder.lua              → fzf-lua
    git.lua                 → gitsigns
    editor.lua              → which-key, mini.pairs, Comment, lualine, trouble
```

All lua tracked in chezmoi (`dot_config/nvim/**`). Plugins self-bootstrap on launch (stable branches, no lockfile, per prior decision).

## Language / server matrix

| Language | Server | Provenance | Format (on-save) | Debug |
|---|---|---|---|---|
| Python | basedpyright + ruff | mason | ruff | debugpy (nvim-dap-python) |
| TypeScript/JS | vtsls | fnm Node | prettier | — |
| Terraform/HCL | terraform-ls | mason | terraform_fmt | — |
| Bash | bash-language-server | fnm Node | shfmt | — |
| Lua | lua_ls | mason | stylua | — |
| JSON | json-lsp | fnm Node | prettier | — |
| YAML | yaml-language-server | fnm Node | (on-demand) | — |
| Markdown | marksman | mason | (on-demand) | — |
| Java | jdtls (nvim-jdtls) | sdkman JDK | (on-demand only) | — |
| Kotlin | — (treesitter syntax) | — | — | — |

## Keymaps (scheme; finalized in the plan)

- **LSP:** lean on nvim 0.11 built-in defaults — `K` hover, `grn` rename, `gra` code action, `grr` references, `gri` implementation, `gO` symbols — plus `gd` definition, `[d`/`]d` diagnostics.
- **Find (`<leader>f`, fzf-lua):** `ff` files, `fg` live-grep, `fb` buffers, `fs` doc symbols, `fd` diagnostics, `fr` resume.
- **Code:** `<leader>cf` format (on-demand), `<leader>ca` code action.
- **Debug (`<leader>d`, dap):** `db` breakpoint, `dc` continue, `ds`/`di`/`do` step over/into/out, `du` toggle UI.
- **Git (`<leader>g` / hunks, gitsigns):** `gb` blame, `gs` stage hunk, `gp` preview hunk, `]h`/`[h` next/prev hunk.
- **Diagnostics list (`<leader>x`, trouble):** `xx` toggle, `xw` workspace.
- Unchanged: yazi `e` bind and `$EDITOR` stay **vim**; nvim is the yazi *edit opener*.

## Reproducibility (chezmoi)

- Lua config tracked in chezmoi; plugins self-bootstrap via lazy on first launch.
- mason leaf tools via a pinned `mason-tool-installer` list (auto-installs on launch).
- System prereqs documented as install steps: JDK via sdkman (for jdtls), node-based servers via fnm/npm.
- `nvim-jdtls` points at sdkman's active JDK (`$JAVA_HOME`).
- No new run_onchange hooks needed — nvim bootstraps itself; mason auto-installs its list.

## Risks / caveats

- **jdtls** first-open indexing is slow on large multi-module Gradle repos and may need per-project config → Java is read/light-edit; IntelliJ for heavy JVM.
- **Kotlin** has no LSP here (syntax only) — expectation set deliberately.
- **blink.cmp** ships a prebuilt Rust binary; mitigated by the pure-Lua fuzzy fallback if provenance matters.
- **Format-on-save** local-vs-CI version skew → mitigated by limiting on-save to a subset, using project config, and on-demand for the rest.
- **Startup** cost grows with the plugin count → mitigated by lazy-loading (events/filetypes/keys).

## Success criteria

1. Opening a Python/TS/Terraform file yields diagnostics, completion, hover, go-to-def, and format-on-save via the project formatter.
2. `<leader>ff` / `<leader>fg` find files / live-grep; `gd`/`grr`/`K` work; gitsigns show in a repo.
3. Python DAP can set a breakpoint and step through a script/DAG in-pane.
4. Java (jdtls): hover/go-to-def/completion work after indexing on a Processing repo.
5. No regressions: yazi edit flow intact, `e` still opens vim, startup stays snappy.

## References (not chosen)

- **B — kickstart.nvim:** community single-file starter; useful as a wiring reference for individual plugins.
- **C — LazyVim:** distro; useful to crib sensible defaults/keymaps from, without adopting the abstraction.
