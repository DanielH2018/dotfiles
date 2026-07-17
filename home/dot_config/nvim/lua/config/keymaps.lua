-- Base keymaps. Plugin-specific maps live with their plugin specs; LSP maps are
-- set per-buffer on LspAttach (see lua/plugins/lsp.lua).
local map = vim.keymap.set

map("n", "<Esc>", "<cmd>nohlsearch<cr>", { desc = "Clear search highlight" })
