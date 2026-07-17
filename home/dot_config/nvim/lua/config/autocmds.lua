-- Briefly highlight yanked text.
vim.api.nvim_create_autocmd("TextYankPost", {
	callback = function()
		vim.hl.on_yank()
	end,
})
