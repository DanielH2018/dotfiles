return {
	{
		"stevearc/conform.nvim",
		event = { "BufWritePre" },
		cmd = { "ConformInfo" },
		keys = {
			{
				"<leader>cf",
				function()
					require("conform").format({ async = false, lsp_format = "fallback" })
				end,
				mode = { "n", "v" },
				desc = "Format buffer/selection",
			},
		},
		opts = {
			formatters_by_ft = {
				python = { "ruff_format" },
				javascript = { "prettier" },
				javascriptreact = { "prettier" },
				typescript = { "prettier" },
				typescriptreact = { "prettier" },
				json = { "prettier" },
				jsonc = { "prettier" },
				yaml = { "prettier" },
				terraform = { "terraform_fmt" },
				hcl = { "terraform_fmt" },
				lua = { "stylua" },
				sh = { "shfmt" },
			},
			-- On-save only for the safe subset (project formatter). JVM and YAML are
			-- on-demand only (via <leader>cf); anything unlisted won't auto-format.
			format_on_save = function(bufnr)
				local on_save = {
					python = true,
					typescript = true,
					typescriptreact = true,
					javascript = true,
					javascriptreact = true,
					json = true,
					jsonc = true,
					terraform = true,
					hcl = true,
					lua = true,
					sh = true,
				}
				if not on_save[vim.bo[bufnr].filetype] then
					return nil
				end
				return { timeout_ms = 1000, lsp_format = "never" }
			end,
		},
	},
}
