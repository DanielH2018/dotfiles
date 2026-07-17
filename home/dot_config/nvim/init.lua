-- Neovim — yazi's edit opener (in-terminal, blocking; returns to yazi on :q).
-- Minimal setup for preview-matching code display: Catppuccin Mocha + treesitter.
-- $EDITOR and the yazi `e` bind stay vim.

vim.g.mapleader = " "
vim.opt.termguicolors = true
vim.opt.number = true
vim.opt.mouse = "a"

-- Bootstrap lazy.nvim (self-installs on first launch).
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not (vim.uv or vim.loop).fs_stat(lazypath) then
	vim.fn.system({
		"git",
		"clone",
		"--filter=blob:none",
		"https://github.com/folke/lazy.nvim.git",
		"--branch=stable",
		lazypath,
	})
end
vim.opt.rtp:prepend(lazypath)

require("lazy").setup({
	{
		"catppuccin/nvim",
		name = "catppuccin",
		priority = 1000,
		config = function()
			require("catppuccin").setup({ flavour = "mocha" })
			vim.cmd.colorscheme("catppuccin")
		end,
	},
	{
		"nvim-treesitter/nvim-treesitter",
		branch = "master",
		build = ":TSUpdate",
		config = function()
			require("nvim-treesitter.configs").setup({
				auto_install = true,
				highlight = { enable = true },
			})
		end,
	},
})
