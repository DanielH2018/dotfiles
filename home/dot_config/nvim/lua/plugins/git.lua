return {
	{
		"lewis6991/gitsigns.nvim",
		event = { "BufReadPre", "BufNewFile" },
		opts = {
			on_attach = function(bufnr)
				local gs = require("gitsigns")
				local function m(lhs, rhs, desc)
					vim.keymap.set("n", lhs, rhs, { buffer = bufnr, desc = desc })
				end
				m("]h", function()
					gs.nav_hunk("next")
				end, "Next hunk")
				m("[h", function()
					gs.nav_hunk("prev")
				end, "Prev hunk")
				m("<leader>gs", gs.stage_hunk, "Stage hunk")
				m("<leader>gp", gs.preview_hunk, "Preview hunk")
				m("<leader>gb", function()
					gs.blame_line({ full = true })
				end, "Blame line")
			end,
		},
	},
}
