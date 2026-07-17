-- Neovim config entry point.
-- $EDITOR and the yazi `e` bind stay vim; nvim is the yazi edit opener + IDE-in-a-pane.

require("config.options")
require("config.keymaps")
require("config.autocmds")

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

-- Plugins live in lua/plugins/*.lua (one file per concern).
require("lazy").setup("plugins", {
	change_detection = { notify = false },
})
