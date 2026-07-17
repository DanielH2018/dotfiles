return {
	{ "folke/which-key.nvim", event = "VeryLazy", opts = {} },
	{ "echasnovski/mini.pairs", event = "InsertEnter", opts = {} },
	{ "numToStr/Comment.nvim", event = "VeryLazy", opts = {} },
	{
		"nvim-lualine/lualine.nvim",
		event = "VeryLazy",
		opts = { options = { theme = "catppuccin", globalstatus = true } },
	},
	{
		"folke/trouble.nvim",
		cmd = "Trouble",
		opts = {},
		keys = {
			{ "<leader>xx", "<cmd>Trouble diagnostics toggle filter.buf=0<cr>", desc = "Buffer diagnostics" },
			{ "<leader>xw", "<cmd>Trouble diagnostics toggle<cr>", desc = "Workspace diagnostics" },
		},
	},
}
