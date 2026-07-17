# Neovim IDE-in-a-pane — Implementation Plan

> **For agentic workers:** implement task-by-task; each task ends with a headless load/verify + a chezmoi apply + a commit. Steps use `- [ ]` tracking.

**Goal:** Extend the yazi edit-opener nvim into a tiered IDE (LSP/completion/format/debug for nvim-friendly languages; jdtls-lite for Java) per `docs/nvim-ide-design.md`.

**Architecture:** Hand-rolled modular `lazy.nvim` config — `init.lua` bootstraps lazy and imports `lua/plugins/*`; cross-cutting settings live in `lua/config/*`. All lua tracked in chezmoi; plugins self-bootstrap; mason handles leaf tools.

**Tech Stack:** lazy.nvim, mason(-org) + mason-lspconfig + mason-tool-installer, nvim-lspconfig (+ native `vim.lsp.config`/`enable`), nvim-jdtls, blink.cmp, conform.nvim, fzf-lua, gitsigns, nvim-dap (+dap-ui, dap-virtual-text, nvim-dap-python), which-key, mini.pairs, Comment, lualine, trouble, catppuccin, nvim-treesitter.

## Global Constraints

- Target nvim **0.12.4** (native LSP API available). Use current repo owners (mason → `mason-org/*`).
- Plugins on **stable branches, no lockfile**.
- `$EDITOR` and the yazi `e` bind stay **vim**; nvim is the yazi edit opener.
- Provenance: node servers (vtsls, bash/yaml/json LS) via fnm Node; jdtls runs on the **sdkman JDK**; mason for leaf tools/formatters/debugpy.
- Format-on-save subset: Python/TS/JSON/Terraform/Lua/Bash via project formatter; JVM excluded from on-save; `<leader>cf` on-demand for anything.
- Every task: `chezmoi apply` the source, verify `nvim --headless +qa` loads clean (exit 0, no error output), commit in `~/.local/share/chezmoi`.

---

## Verification model (config, not unit tests)

There is no unit-test harness for nvim lua config. Each task's "test" is:
1. `nvim --headless +qa` → exit 0, no stderr (config parses/loads).
2. Where feasible, a targeted headless probe (e.g. `:Lazy! sync`, `:MasonToolsInstall`, `vim.fn.exepath(...)`).
Interactive-only behavior (LSP attach, completion menu, format-on-save, DAP breakpoints) is verified by the user; the plan notes these explicitly.

---

### Task 1: Restructure into modules

**Files:**
- Modify: `dot_config/nvim/init.lua` → keep lazy bootstrap; move opts/autocmds out; `require("config.options"|"config.keymaps"|"config.autocmds")`; `require("lazy").setup("plugins", {...})`.
- Create: `dot_config/nvim/lua/config/options.lua` (current QoL opts), `.../keymaps.lua` (leader, base maps), `.../autocmds.lua` (yank highlight).
- Create: `dot_config/nvim/lua/plugins/colorscheme.lua` (catppuccin — moved), `.../treesitter.lua` (moved, highlight+indent).

**Steps:**
- [ ] Move `vim.g.mapleader`, opts into `config/options.lua`; autocmd into `config/autocmds.lua`; create empty `config/keymaps.lua` (leader already set).
- [ ] Move catppuccin + treesitter specs into `lua/plugins/`.
- [ ] Rewrite `init.lua`: leader → require config.* → lazy bootstrap → `require("lazy").setup("plugins", { change_detection = { notify = false } })`.
- [ ] `chezmoi apply ~/.config/nvim`; `nvim --headless +qa` clean; `nvim --headless "+Lazy! sync" +qa` (colorscheme+treesitter reinstall clean).
- [ ] Commit.

### Task 2: LSP core (servers + jdtls)

**Files:** Create `dot_config/nvim/lua/plugins/lsp.lua`.

**Interfaces produced:** global LSP capabilities set for blink (Task 3 wires the source); `LspAttach` autocmd binds `gd`, `[d`/`]d`, etc.

**Steps:**
- [ ] Spec: `neovim/nvim-lspconfig` + deps `mason-org/mason.nvim`, `mason-org/mason-lspconfig.nvim`, `WhoIsSethDaniel/mason-tool-installer.nvim`, `mfussenegger/nvim-jdtls`.
- [ ] `mason.setup()`; `mason-tool-installer.setup({ ensure_installed = { basedpyright, ruff, terraform-ls (as "terraformls"? use mason pkg name), lua-language-server, marksman, stylua, shfmt, prettier, debugpy } })`.
- [ ] node servers (vtsls, bash-language-server, yaml-language-server, vscode-langservers-extracted for json) — installed via fnm Node in Task 8 prereq step or mason; decide at impl (prefer system Node per provenance, fall back to mason).
- [ ] `vim.lsp.config("*", { capabilities = <blink caps, guarded if blink absent> })`; per-server `vim.lsp.config("lua_ls"/"basedpyright"/...)`.
- [ ] `mason-lspconfig.setup({ automatic_enable = true })`; jdtls handled separately (skip in automatic_enable) via `nvim-jdtls` ftplugin, launched with sdkman `java`.
- [ ] `LspAttach` autocmd: buffer-local `gd` → `vim.lsp.buf.definition`, `[d`/`]d` → diagnostic jump, `<leader>e` float. (K/grn/gra/grr/gri are nvim 0.11 defaults.)
- [ ] Verify headless load; `nvim --headless "+MasonToolsInstall" "+sleep 30" +qa` (or interactive note); confirm server binaries resolve.
- [ ] Commit.

### Task 3: Completion (blink.cmp)

**Files:** Create `dot_config/nvim/lua/plugins/completion.lua`.
**Interfaces consumed:** capabilities used by Task 2 (`require("blink.cmp").get_lsp_capabilities()` — confirm current fn name).

**Steps:**
- [ ] Spec `saghen/blink.cmp` with `version = "*"` (release tag, prebuilt fuzzy binary) OR `build` fallback; `opts` = keymap preset "default", sources { lsp, path, snippets, buffer }, fuzzy prebuilt.
- [ ] Ensure lsp.lua pulls caps from blink (guard if not loaded).
- [ ] Verify headless load; commit.

### Task 4: Formatting (conform.nvim)

**Files:** Create `dot_config/nvim/lua/plugins/formatting.lua`.

**Steps:**
- [ ] Spec `stevearc/conform.nvim`; `formatters_by_ft` = { python={"ruff_format"}, javascript/typescript/json={"prettier"}, terraform/hcl={"terraform_fmt"}, lua={"stylua"}, sh={"shfmt"} }.
- [ ] `format_on_save` = function returning opts only for the subset fts (lsp_format="never", timeout 1000); everything else no auto.
- [ ] `<leader>cf` → `require("conform").format({ async=false, lsp_format="fallback" })` (works on any ft, incl. JVM via LSP/available formatter).
- [ ] Verify headless load; commit.

### Task 5: Editor QoL (which-key, mini.pairs, Comment, lualine, trouble)

**Files:** Create `dot_config/nvim/lua/plugins/editor.lua`.

**Steps:**
- [ ] Specs: `folke/which-key.nvim` (opts {}), `echasnovski/mini.pairs` (opts {}), `numToStr/Comment.nvim` (opts {}), `nvim-lualine/lualine.nvim` (theme "catppuccin"), `folke/trouble.nvim` (opts {}) with `<leader>xx`/`<leader>xw`.
- [ ] Verify headless load; commit.

### Task 6: Finder (fzf-lua)

**Files:** Create `dot_config/nvim/lua/plugins/finder.lua`.

**Steps:**
- [ ] Spec `ibhagwan/fzf-lua`; opts {}; keys `<leader>ff` files, `<leader>fg` live_grep, `<leader>fb` buffers, `<leader>fs` lsp_document_symbols, `<leader>fd` diagnostics_document, `<leader>fr` resume.
- [ ] Verify headless load; commit.

### Task 7: Git (gitsigns)

**Files:** Create `dot_config/nvim/lua/plugins/git.lua`.

**Steps:**
- [ ] Spec `lewis6991/gitsigns.nvim`; `on_attach` binds `]h`/`[h` next/prev hunk, `<leader>gs` stage_hunk, `<leader>gp` preview_hunk, `<leader>gb` blame_line.
- [ ] Verify headless load; commit.

### Task 8: Debug (nvim-dap + Python)

**Files:** Create `dot_config/nvim/lua/plugins/dap.lua`.

**Steps:**
- [ ] Specs `mfussenegger/nvim-dap`, `rcarriga/nvim-dap-ui` (dep `nvim-neotest/nvim-nio`), `theHamsta/nvim-dap-virtual-text`, `mfussenegger/nvim-dap-python`.
- [ ] `dap-python.setup(<debugpy path>)` (mason debugpy or system); dap-ui auto open/close via listeners.
- [ ] keys `<leader>db` toggle bp, `<leader>dc` continue, `<leader>ds`/`di`/`do` step, `<leader>du` toggle ui.
- [ ] Verify headless load; commit.

### Task 9: Prereqs + full sync + sanity

**Steps:**
- [ ] Install node servers via fnm Node if not using mason: `npm i -g @vtsls/language-server bash-language-server yaml-language-server vscode-langservers-extracted`.
- [ ] jdtls: install via mason (`jdtls`) or confirm on PATH; ensure it launches with sdkman JDK (`JAVA_HOME`).
- [ ] `nvim --headless "+Lazy! sync" +qa`; `nvim --headless "+MasonToolsInstall" ...` until done.
- [ ] `nvim --headless "+checkhealth" +qa` capture; resolve fatal errors.
- [ ] Confirm server/formatter binaries resolve (`vim.fn.exepath`).
- [ ] Commit final state + update chezmoi package tracking if any.

## Self-review notes

- Spec coverage: Tasks 2–8 cover every design section (LSP, completion, format, finder, git, dap, editor). Task 1 = structure; Task 9 = prereqs/verify.
- Interactive-only (flag to user, do not assert): LSP attach + completion menu + format-on-save behavior + DAP breakpoint stepping + jdtls indexing on a real Processing repo.
- Deviation to note at impl: jdtls server binary likely via mason for reproducibility, but configured to run on the sdkman JDK (honors provenance intent — the JDK executes, mason just ships the launcher).
